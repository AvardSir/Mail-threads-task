// src/worker.test.ts
import nock from 'nock';
import { prisma } from './prisma';
import * as db from './db';
import * as processor from './processor';
import * as exporter from './exporter';
import { runWorker } from './worker';

jest.mock('pino', () => {
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  };
  const pinoMock: any = jest.fn(() => mockLogger);
  pinoMock.stdTimeFunctions = {
    isoTime: jest.fn(() => ',"time":"2024-01-01T00:00:00.000Z"'),
    epochTime: jest.fn(() => ',"time":0'),
    unixTime: jest.fn(() => ',"time":0'),
    nullTime: jest.fn(() => ''),
  };
  return pinoMock;
});

jest.mock('./processor');
jest.mock('./exporter');

const BASE = 'http://test-provider';
const DEFAULT_LIMIT = 200;

type ClientItemShape = {
  message_id: string;
  in_reply_to?: string;
  references: string[];
  subject: string;
  from: string;
  to: string[];
  sent_at: string;
};

const clientItem = (overrides: Partial<ClientItemShape> = {}): ClientItemShape => ({
  message_id: 'm-default',
  references: [],
  subject: 'subject',
  from: 'from@example.com',
  to: ['to@example.com'],
  sent_at: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

const dbItem = (externalId: string) => ({
  externalId,
  subject: 'subject',
  fromAddr: 'from@example.com',
  toAddrs: ['to@example.com'],
  sentAt: '2024-01-01T00:00:00.000Z',
  references: [] as string[],
  inReplyTo: null as string | null,
});

describe('runWorker', () => {
  beforeEach(async () => {
    nock.abortPendingRequests();   // ← первая строка: убить чужие висячие сокеты
  nock.cleanAll();
  nock.disableNetConnect();       // ← только после того, как всё подчищено
  jest.clearAllMocks();


    (processor.buildUpdates as jest.Mock).mockReset().mockReturnValue([]);
    (exporter.exportAll as jest.Mock).mockReset().mockResolvedValue(undefined);

    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "messages", "app_state" RESTART IDENTITY',
    );
  });

  afterEach(() => {
    nock.abortPendingRequests();   // ← гасим висячие .delay()-ответы сразу
  });


  afterAll(() => {
    nock.abortPendingRequests();
    nock.cleanAll();
    nock.enableNetConnect();

});



  // ---- A. Happy path ----
  describe('happy path', () => {
    it('idle → done: single page', async () => {
      nock(BASE)
        .get('/v1/messages')
        .query({ limit: DEFAULT_LIMIT })
        .reply(200, {
          items: [
            clientItem({ message_id: 'm1', from: 'a@b.com' }),
            clientItem({ message_id: 'm2', from: 'c@d.com' }),
          ],
          next_cursor: null,
        });

      const result = await runWorker();

      expect(result).toBe('done');
      expect(await db.getState('stage')).toBe('done');

      const rows = await db.getAllMessages();
      expect(rows).toHaveLength(2);
      expect(rows[0].externalId).toBe('m1');
      expect(rows[0].fromAddr).toBe('a@b.com');
      expect(rows[1].externalId).toBe('m2');
      expect(rows[1].fromAddr).toBe('c@d.com');

      expect(processor.buildUpdates).toHaveBeenCalledTimes(1);
      expect(exporter.exportAll).toHaveBeenCalledTimes(1);
    });

    it('idle → done: two pages', async () => {
      nock(BASE)
        .get('/v1/messages')
        .query({ limit: DEFAULT_LIMIT })
        .reply(200, {
          items: [clientItem({ message_id: 'm1' })],
          next_cursor: 'c1',
        });

      nock(BASE)
        .get('/v1/messages')
        .query({ cursor: 'c1', limit: DEFAULT_LIMIT })
        .reply(200, {
          items: [clientItem({ message_id: 'm2' })],
          next_cursor: null,
        });

      const result = await runWorker();

      expect(result).toBe('done');
      expect(await db.getState('stage')).toBe('done');
      expect(await db.getState('cursor')).toBe('');

      const rows = await db.getAllMessages();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.externalId).sort()).toEqual(['m1', 'm2']);
      expect(processor.buildUpdates).toHaveBeenCalledTimes(1);
    });

    it('passes custom limit to fetchMessages', async () => {
      nock(BASE)
        .get('/v1/messages')
        .query({ limit: 7 })
        .reply(200, { items: [], next_cursor: null });

      const result = await runWorker({ limit: 7 });
      expect(result).toBe('done');
    });

    it('empty page → done with no rows', async () => {
      nock(BASE)
        .get('/v1/messages')
        .query({ limit: DEFAULT_LIMIT })
        .reply(200, { items: [], next_cursor: null });

      const result = await runWorker();

      expect(result).toBe('done');
      expect(await db.getAllMessages()).toHaveLength(0);
      expect(processor.buildUpdates).toHaveBeenCalledWith([], expect.any(Set));
      expect(exporter.exportAll).toHaveBeenCalledTimes(1);
    });
  });

  // ---- B. Restart ----
  describe('restart behavior', () => {
    it('resumes loading from saved cursor', async () => {
      await db.setState('stage', 'loading');
      await db.setState('cursor', 'c1');

      nock(BASE)
        .get('/v1/messages')
        .query({ cursor: 'c1', limit: DEFAULT_LIMIT })
        .reply(200, {
          items: [clientItem({ message_id: 'm2' })],
          next_cursor: null,
        });

      const result = await runWorker();

      expect(result).toBe('done');
      expect(await db.getState('stage')).toBe('done');
      expect(await db.getAllMessages()).toHaveLength(1);
    });

    it('handles empty cursor string as no cursor', async () => {
      await db.setState('stage', 'loading');
      await db.setState('cursor', '');

      nock(BASE)
        .get('/v1/messages')
        .query({ limit: DEFAULT_LIMIT })
        .reply(200, { items: [], next_cursor: null });

      const result = await runWorker();
      expect(result).toBe('done');
      expect(await db.getState('stage')).toBe('done');
    });

    it('stage=processing skips loading, goes straight to processing', async () => {
      await db.saveMessages([dbItem('m1'), dbItem('m2')]);
      await db.setState('stage', 'processing');
      // no nock interceptors on purpose — any HTTP call would throw.

      const result = await runWorker();

      expect(result).toBe('done');
      expect(await db.getState('stage')).toBe('done');
      expect(processor.buildUpdates).toHaveBeenCalledTimes(1);
      expect(exporter.exportAll).toHaveBeenCalledTimes(1);
      expect(await db.getAllMessages()).toHaveLength(2);
    });

    it('stage=done is terminal: no side effects', async () => {
      await db.setState('stage', 'done');

      const result = await runWorker();

      expect(result).toBe('done');
      expect(await db.getState('stage')).toBe('done');
      expect(processor.buildUpdates).not.toHaveBeenCalled();
      expect(exporter.exportAll).not.toHaveBeenCalled();
    });

    it('treats unknown stage value as idle', async () => {
      await db.setState('stage', 'banana');

      nock(BASE)
        .get('/v1/messages')
        .query({ limit: DEFAULT_LIMIT })
        .reply(200, { items: [], next_cursor: null });

      const result = await runWorker();
      expect(result).toBe('done');
      expect(await db.getState('stage')).toBe('done');
    });
  });

  // ---- C. Idempotency ----
  describe('idempotency', () => {
    it('skips duplicate messages on re-fetch', async () => {
      await db.saveMessages([dbItem('m1')]);
      await db.setState('stage', 'loading');
      await db.setState('cursor', '');

      nock(BASE)
        .get('/v1/messages')
        .query({ limit: DEFAULT_LIMIT })
        .reply(200, {
          items: [clientItem({ message_id: 'm1' })],
          next_cursor: null,
        });

      const result = await runWorker();

      expect(result).toBe('done');
      expect(await db.getAllMessages()).toHaveLength(1);
    });

    it('re-fetch of last page after crash is safe', async () => {
      // Simulate: previous run inserted m1 and cleared cursor, but crashed
      // before flipping stage to 'processing'.
      await db.saveMessages([dbItem('m1')]);
      await db.setState('stage', 'loading');
      await db.setState('cursor', '');

      nock(BASE)
        .get('/v1/messages')
        .query({ limit: DEFAULT_LIMIT })
        .reply(200, {
          items: [
            clientItem({ message_id: 'm1' }),
            clientItem({ message_id: 'm2' }),
          ],
          next_cursor: null,
        });

      const result = await runWorker();

      expect(result).toBe('done');
      expect(await db.getAllMessages()).toHaveLength(2);
    });
  });

  // ---- D. Error propagation ----
  describe('error propagation', () => {
    it('HTTP 500 exhaustion rejects and leaves stage=loading', async () => {
      await db.setState('stage', 'loading');
      await db.setState('cursor', 'c1');

      const maxRetries = Number(process.env.MAX_RETRIES);
      nock(BASE)
        .get('/v1/messages')
        .query({ cursor: 'c1', limit: DEFAULT_LIMIT })
        .times(maxRetries + 1)
        .reply(500, 'server error');

      await expect(runWorker()).rejects.toThrow();

      expect(await db.getState('stage')).toBe('loading');
      expect(await db.getState('cursor')).toBe('c1');
      expect(processor.buildUpdates).not.toHaveBeenCalled();
      expect(exporter.exportAll).not.toHaveBeenCalled();
    });

    it('buildUpdates failure leaves stage=processing', async () => {
      await db.setState('stage', 'processing');
      (processor.buildUpdates as jest.Mock).mockImplementationOnce(() => {
        throw new Error('boom');
      });

      await expect(runWorker()).rejects.toThrow('boom');

      expect(await db.getState('stage')).toBe('processing');
      expect(exporter.exportAll).not.toHaveBeenCalled();
    });

    it('exportAll failure leaves stage=processing', async () => {
      await db.setState('stage', 'processing');
      (exporter.exportAll as jest.Mock).mockRejectedValueOnce(new Error('io'));

      await expect(runWorker()).rejects.toThrow('io');

      expect(await db.getState('stage')).toBe('processing');
    });
  });

  // ---- E. Contract specifics ----
  describe('contract specifics', () => {
    it('treats empty string next_cursor as end of pagination', async () => {
      nock(BASE)
        .get('/v1/messages')
        .query({ limit: DEFAULT_LIMIT })
        .reply(200, {
          items: [clientItem({ message_id: 'm1' })],
          next_cursor: '',
        });

      const result = await runWorker();

      expect(result).toBe('done');
      expect(await db.getState('stage')).toBe('done');
      expect(await db.getAllMessages()).toHaveLength(1);
    });

    it('passes MessageRow[] and Set<externalId> to buildUpdates', async () => {
      await db.saveMessages([dbItem('m1'), dbItem('m2')]);
      await db.setState('stage', 'processing');

      await runWorker();

      expect(processor.buildUpdates).toHaveBeenCalledTimes(1);
      const call = (processor.buildUpdates as jest.Mock).mock.calls[0];
      const rows = call[0] as Array<{ externalId: string }>;
      const ids = call[1] as Set<string>;

      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.externalId).sort()).toEqual(['m1', 'm2']);
      expect(ids).toBeInstanceOf(Set);
      expect(ids.has('m1')).toBe(true);
      expect(ids.has('m2')).toBe(true);
    });
  });
});