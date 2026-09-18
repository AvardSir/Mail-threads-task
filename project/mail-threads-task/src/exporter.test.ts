/**
 * T2: exporter.test.ts — переработан под формат ТЗ.
 *
 * Контракт result.jsonl (5 полей, snake_case, фиксированный порядок):
 *   {"external_id":"...","thread_key":"...","parent_id":"...","sent_at":"...","subject":"..."}
 *   - parent_id: null → "" (пустая строка)
 *   - thread_key / sent_at / subject: null → null
 *
 * Expected Red против старого exporter.ts (camelCase, 7 полей, parentId null → null):
 *   A2, A3, A5, B2.
 */

// ---------- pino mock (канон §9.3) ----------
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
    isoTime:   jest.fn(() => ',"time":"2024-01-01T00:00:00.000Z"'),
    epochTime: jest.fn(() => ',"time":0'),
    unixTime:  jest.fn(() => ',"time":0'),
    nullTime:  jest.fn(() => ''),
  };
  return pinoMock;
});

// ---------- db mock ----------
jest.mock('./db', () => ({
  getAllMessages: jest.fn(),
}));

// ---------- fs/promises: частичный мок (spy mkdir / writeFile, остальное — реальное) ----------
jest.mock('fs/promises', () => {
  const actual = jest.requireActual('fs/promises');
  return {
    ...actual,
    mkdir: jest.fn(actual.mkdir),
    writeFile: jest.fn(actual.writeFile),
  };
});

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import pino from 'pino';

import { getAllMessages, type MessageRow } from './db';
import { exportAll } from './exporter';

const mockLogger = (pino as unknown as jest.Mock)() as {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
};

// ---------- helpers ----------
const makeRow = (overrides: Partial<MessageRow> = {}): MessageRow => ({
  id: 1,
  externalId: '<m1@example.com>',
  parentId: null,
  threadKey: 't-1',
  subject: 'Subject',
  fromAddr: 'a@example.com',
  toAddrs: ['b@example.com'],
  sentAt: new Date('2025-04-11T09:23:15.000Z'),
  references: [],
  inReplyTo: null,
  ...overrides,
});

const readLines = async (file: string): Promise<string[]> => {
  const content = await fs.readFile(file, 'utf8');
  if (content.length === 0) return [];
  return content.replace(/\n$/, '').split('\n');
};

const readFirst = async (file: string): Promise<any> => {
  const lines = await readLines(file);
  return JSON.parse(lines[0]);
};

// ---------- suite ----------
describe('exporter (T2: task-spec result.jsonl format)', () => {
  let tmpDir: string;
  let outPath: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exporter-t2-'));
    outPath = path.join(tmpDir, 'result.jsonl');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // =========================================================
  // A. Line format
  // =========================================================
  describe('A. line format', () => {
    it('A1: each line is valid JSON with exactly 5 fields', async () => {
      (getAllMessages as jest.Mock).mockResolvedValue([
        makeRow({ id: 1, externalId: '<a@x>' }),
        makeRow({ id: 2, externalId: '<b@x>' }),
      ]);
      await exportAll(outPath);

      const lines = await readLines(outPath);
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        const obj = JSON.parse(line);
        expect(Object.keys(obj)).toHaveLength(5);
      }
    });

    it('A2: keys are snake_case: external_id, thread_key, parent_id, sent_at, subject', async () => {
      (getAllMessages as jest.Mock).mockResolvedValue([makeRow()]);
      await exportAll(outPath);

      const obj = await readFirst(outPath);
      expect(Object.keys(obj).sort()).toEqual(
        ['external_id', 'parent_id', 'sent_at', 'subject', 'thread_key'].sort(),
      );
      expect(obj).not.toHaveProperty('externalId');
      expect(obj).not.toHaveProperty('threadKey');
      expect(obj).not.toHaveProperty('parentId');
      expect(obj).not.toHaveProperty('sentAt');
    });

    it('A3: field order is fixed: external_id → thread_key → parent_id → sent_at → subject', async () => {
      (getAllMessages as jest.Mock).mockResolvedValue([makeRow()]);
      await exportAll(outPath);

      const obj = await readFirst(outPath);
      expect(Object.keys(obj)).toEqual([
        'external_id',
        'thread_key',
        'parent_id',
        'sent_at',
        'subject',
      ]);
    });

    it('A4: internal id is not present in output', async () => {
      (getAllMessages as jest.Mock).mockResolvedValue([makeRow({ id: 42 })]);
      await exportAll(outPath);

      const obj = await readFirst(outPath);
      expect(obj).not.toHaveProperty('id');
    });

    it('A5: fromAddr and toAddrs are not present in output', async () => {
      (getAllMessages as jest.Mock).mockResolvedValue([makeRow()]);
      await exportAll(outPath);

      const obj = await readFirst(outPath);
      expect(obj).not.toHaveProperty('fromAddr');
      expect(obj).not.toHaveProperty('toAddrs');
    });
  });

  // =========================================================
  // B. parent_id
  // =========================================================
  describe('B. parent_id', () => {
    it('B1: parentId string → parent_id string', async () => {
      (getAllMessages as jest.Mock).mockResolvedValue([
        makeRow({ parentId: '<parent@x>' }),
      ]);
      await exportAll(outPath);

      const obj = await readFirst(outPath);
      expect(obj.parent_id).toBe('<parent@x>');
    });

    it('B2: parentId null → parent_id "" (task spec: empty string, not null)', async () => {
      (getAllMessages as jest.Mock).mockResolvedValue([makeRow({ parentId: null })]);
      await exportAll(outPath);

      const obj = await readFirst(outPath);
      expect(obj.parent_id).toBe('');
      expect(obj.parent_id).not.toBeNull();
    });

    it('B3: parentId "" → parent_id "" (idempotent)', async () => {
      (getAllMessages as jest.Mock).mockResolvedValue([makeRow({ parentId: '' })]);
      await exportAll(outPath);

      const obj = await readFirst(outPath);
      expect(obj.parent_id).toBe('');
    });
  });

  // =========================================================
  // C. sent_at
  // =========================================================
  describe('C. sent_at', () => {
    it('C1: sentAt Date → ISO string', async () => {
      (getAllMessages as jest.Mock).mockResolvedValue([
        makeRow({ sentAt: new Date('2025-04-11T09:23:15.000Z') }),
      ]);
      await exportAll(outPath);

      const obj = await readFirst(outPath);
      expect(obj.sent_at).toBe('2025-04-11T09:23:15.000Z');
    });

    it('C2: sentAt null → null', async () => {
      (getAllMessages as jest.Mock).mockResolvedValue([makeRow({ sentAt: null })]);
      await exportAll(outPath);

      const obj = await readFirst(outPath);
      expect(obj.sent_at).toBeNull();
    });
  });

  // =========================================================
  // D. subject
  // =========================================================
  describe('D. subject', () => {
    it('D1: subject string → as is', async () => {
      (getAllMessages as jest.Mock).mockResolvedValue([
        makeRow({ subject: 'Re: Test' }),
      ]);
      await exportAll(outPath);

      const obj = await readFirst(outPath);
      expect(obj.subject).toBe('Re: Test');
    });

    it('D2: subject null → null', async () => {
      (getAllMessages as jest.Mock).mockResolvedValue([makeRow({ subject: null })]);
      await exportAll(outPath);

      const obj = await readFirst(outPath);
      expect(obj.subject).toBeNull();
    });
  });

  // =========================================================
  // E. thread_key
  // =========================================================
  describe('E. thread_key', () => {
    it('E1: threadKey string → as is', async () => {
      (getAllMessages as jest.Mock).mockResolvedValue([
        makeRow({ threadKey: 't-42' }),
      ]);
      await exportAll(outPath);

      const obj = await readFirst(outPath);
      expect(obj.thread_key).toBe('t-42');
    });

    it('E2: threadKey null → null', async () => {
      (getAllMessages as jest.Mock).mockResolvedValue([makeRow({ threadKey: null })]);
      await exportAll(outPath);

      const obj = await readFirst(outPath);
      expect(obj.thread_key).toBeNull();
    });
  });

  // =========================================================
  // F. File invariants (unchanged from prior contract)
  // =========================================================
  describe('F. file invariants', () => {
    it('F1: line order matches getAllMessages() order', async () => {
      (getAllMessages as jest.Mock).mockResolvedValue([
        makeRow({ id: 1, externalId: '<a@x>' }),
        makeRow({ id: 2, externalId: '<b@x>' }),
        makeRow({ id: 3, externalId: '<c@x>' }),
      ]);
      await exportAll(outPath);

      const lines = await readLines(outPath);
      const ids = lines.map((l) => JSON.parse(l).external_id);
      expect(ids).toEqual(['<a@x>', '<b@x>', '<c@x>']);
    });

    it('F2: empty result → 0-byte file', async () => {
      (getAllMessages as jest.Mock).mockResolvedValue([]);
      await exportAll(outPath);

      const stat = await fs.stat(outPath);
      expect(stat.size).toBe(0);
    });

    it('F3: file is terminated with \\n (including last line)', async () => {
      (getAllMessages as jest.Mock).mockResolvedValue([makeRow()]);
      await exportAll(outPath);

      const content = await fs.readFile(outPath, 'utf8');
      expect(content.endsWith('\n')).toBe(true);
    });

    it('F4: mkdir called with recursive: true', async () => {
      (getAllMessages as jest.Mock).mockResolvedValue([]);
      const deep = path.join(tmpDir, 'a', 'b', 'result.jsonl');
      await exportAll(deep);

      expect(fs.mkdir).toHaveBeenCalledWith(
        path.dirname(deep),
        expect.objectContaining({ recursive: true }),
      );
    });

    it('F5: default outputPath is ./out/result.jsonl', async () => {
      // Полностью глушим ФС на один вызов, чтобы не писать в реальный ./out.
      (fs.mkdir as jest.Mock).mockResolvedValueOnce(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValueOnce(undefined);
      (getAllMessages as jest.Mock).mockResolvedValue([]);

      await exportAll();

      expect(fs.writeFile).toHaveBeenCalled();
      const firstArg = (fs.writeFile as jest.Mock).mock.calls[0][0];
      expect(firstArg).toBe('./out/result.jsonl');
    });

    it('F6a: logger.info called on start and finish', async () => {
      (getAllMessages as jest.Mock).mockResolvedValue([]);
      await exportAll(outPath);

      expect(mockLogger.info.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    
  });
});

// ---------- runCli (error logging lives here, not in exportAll) ----------
describe('runCli (T2)', () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    (getAllMessages as jest.Mock).mockReset();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('F7: success → exit(0), info logged', async () => {
    (getAllMessages as jest.Mock).mockResolvedValue([]);
    const { runCli } = require('./exporter');
    await runCli();
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(mockLogger.info).toHaveBeenCalled();
  });

  it('F8: failure → exit(1), error logged with the underlying error', async () => {
    const boom = new Error('boom');
    (getAllMessages as jest.Mock).mockRejectedValueOnce(boom);
    const { runCli } = require('./exporter');
    await runCli();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom }),
      expect.any(String),
    );
  });
});