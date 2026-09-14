import { prisma } from './prisma';
import {
  getState,
  setState,
  saveMessages,
  getAllMessages,
  updateThreadAndParent,
  type MessageItem,
} from './db';

describe('db', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "app_state", "messages" RESTART IDENTITY CASCADE;'
      ,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ---- getState / setState ----

  describe('state', () => {
    it('returns null for missing key', async () => {
      expect(await getState('missing')).toBeNull();
    });

    it('sets and gets a value', async () => {
      await setState('cursor', 'abc');
      expect(await getState('cursor')).toBe('abc');
    });

    it('overwrites existing value', async () => {
      await setState('cursor', 'abc');
      await setState('cursor', 'def');
      expect(await getState('cursor')).toBe('def');
    });
  });

  // ---- saveMessages ----

  describe('saveMessages', () => {
    const mk = (id: string, extra: Partial<MessageItem> = {}): MessageItem => ({
      externalId: id,
      subject: `s-${id}`,
      fromAddr: 'a@b.c',
      toAddrs: ['x@y.z'],
      sentAt: new Date('2024-01-01T00:00:00.000Z'),
      references: [],
      inReplyTo: null,
      ...extra,
    });

    it('returns 0 on empty input', async () => {
      expect(await saveMessages([])).toBe(0);
    });

    it('inserts a single message', async () => {
      expect(await saveMessages([mk('m1')])).toBe(1);
      const all = await getAllMessages();
      expect(all).toHaveLength(1);
      expect(all[0].externalId).toBe('m1');
    });

    it('inserts multiple messages', async () => {
      expect(await saveMessages([mk('m1'), mk('m2'), mk('m3')])).toBe(3);
    });

    it('is idempotent by externalId', async () => {
      await saveMessages([mk('m1')]);
      expect(await saveMessages([mk('m1')])).toBe(0);
      expect(await getAllMessages()).toHaveLength(1);
    });

    it('deduplicates within one batch', async () => {
      expect(await saveMessages([mk('m1'), mk('m1')])).toBe(1);
    });

    it('tolerates null optional fields', async () => {
      const item: MessageItem = {
        externalId: 'm-null',
        subject: null,
        fromAddr: null,
        sentAt: null,
        references: [],
        inReplyTo: null,
      };
      expect(await saveMessages([item])).toBe(1);
    });
  });

  // ---- getAllMessages ----

  describe('getAllMessages', () => {
    it('returns [] on empty DB', async () => {
      expect(await getAllMessages()).toEqual([]);
    });

    it('returns rows ordered by externalId', async () => {
      await saveMessages([
        { externalId: 'b' },
        { externalId: 'a' },
        { externalId: 'c' },
      ]);
      const ids = (await getAllMessages()).map((r) => r.externalId);
      expect(ids).toEqual(['a', 'b', 'c']);
    });
  });

  // ---- updateThreadAndParent ----

  describe('updateThreadAndParent', () => {
    it('is a no-op on empty input', async () => {
      await expect(updateThreadAndParent([])).resolves.toBeUndefined();
    });

    it('updates a single row', async () => {
      await saveMessages([{ externalId: 'm1' }]);
      await updateThreadAndParent([
        { externalId: 'm1', parentId: 'p1', threadKey: 't-root' },
      ]);
      const [row] = await getAllMessages();
      expect(row.parentId).toBe('p1');
      expect(row.threadKey).toBe('t-root');
    });

    it('updates many rows in one call', async () => {
      await saveMessages([
        { externalId: 'm1' },
        { externalId: 'm2' },
        { externalId: 'm3' },
      ]);
      await updateThreadAndParent([
        { externalId: 'm1', parentId: null, threadKey: 't-a' },
        { externalId: 'm2', parentId: 'm1', threadKey: 't-a' },
        { externalId: 'm3', parentId: 'm1', threadKey: 't-a' },
      ]);
      const rows = await getAllMessages();
      expect(rows.find((r) => r.externalId === 'm2')?.parentId).toBe('m1');
      expect(rows.find((r) => r.externalId === 'm3')?.threadKey).toBe('t-a');
    });

    it('ignores unknown externalId', async () => {
      await expect(
        updateThreadAndParent([
          { externalId: 'nope', parentId: 'x', threadKey: 'y' },
        ]),
      ).resolves.toBeUndefined();
    });

    it('can set null values', async () => {
      await saveMessages([{ externalId: 'm1' }]);
      await updateThreadAndParent([
        { externalId: 'm1', parentId: 'p1', threadKey: 't' },
      ]);
      await updateThreadAndParent([
        { externalId: 'm1', parentId: null, threadKey: null },
      ]);
      const [row] = await getAllMessages();
      expect(row.parentId).toBeNull();
      expect(row.threadKey).toBeNull();
    });
  });
});