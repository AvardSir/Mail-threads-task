// ---- 1. Imports ----
import { mkdtemp, readFile, rm, access, stat, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import pino from 'pino';

// ---- 2. Mocks ----
// §9.3 — обязательный мок pino (используется транзитивно через ./logger)
jest.mock('pino', () => {
  const mockLogger: any = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  mockLogger.child = jest.fn(() => mockLogger);
  const pinoMock: any = jest.fn(() => mockLogger);
  pinoMock.stdTimeFunctions = {
    isoTime:   jest.fn(() => ',"time":"2024-01-01T00:00:00.000Z"'),
    epochTime: jest.fn(() => ',"time":0'),
    unixTime:  jest.fn(() => ',"time":0'),
    nullTime:  jest.fn(() => ''),
  };
  return pinoMock;
});

// Реальная БД — внешняя граница, мокаем (§13.2)
jest.mock('./db', () => ({
  getAllMessages: jest.fn(),
}));

// ФС: real impls по умолчанию, но с возможностью подменить (D1/D2)
jest.mock('fs/promises', () => {
  const actual = jest.requireActual('fs/promises');
  return {
    ...actual,
    writeFile: jest.fn(actual.writeFile),
    mkdir: jest.fn(actual.mkdir),
  };
});

// ---- 3. SUT imports (после моков) ----
import { exportAll, runCli } from './exporter';
import { getAllMessages, MessageRow } from './db';

// ---- 4. Typed handles ----
const mockGetAllMessages = getAllMessages as jest.MockedFunction<typeof getAllMessages>;
const mockWriteFile = writeFile as jest.MockedFunction<typeof writeFile>;
const mockMkdir = mkdir as jest.MockedFunction<typeof mkdir>;
const mockLogger = (pino as unknown as () => any)();

// ---- 5. Helpers ----
const makeRow = (overrides: Partial<MessageRow> = {}): MessageRow => ({
  id: 1,
  externalId: 'ext-1',
  parentId: null,
  threadKey: null,
  subject: null,
  fromAddr: null,
  toAddrs: [],
  sentAt: null,
  references: [],
  inReplyTo: null,
  ...overrides,
});

const fileExists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

// ---- 6. exportAll ----
describe('exportAll', () => {
  let tmpDir: string;
  let outputPath: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockGetAllMessages.mockReset();
    tmpDir = await mkdtemp(join(tmpdir(), 'exporter-test-'));
    outputPath = join(tmpDir, 'result.jsonl');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ---- A. successful write ----
  describe('A. successful write', () => {
    it('A1: writes exactly one line for one message', async () => {
      mockGetAllMessages.mockResolvedValue([makeRow({ externalId: 'e1' })]);
      await exportAll(outputPath);
      const content = await readFile(outputPath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
    });

    it('A2: preserves order returned by getAllMessages', async () => {
      mockGetAllMessages.mockResolvedValue([
        makeRow({ id: 1, externalId: 'first' }),
        makeRow({ id: 2, externalId: 'second' }),
        makeRow({ id: 3, externalId: 'third' }),
      ]);
      await exportAll(outputPath);
      const content = await readFile(outputPath, 'utf-8');
      const lines = content.trimEnd().split('\n');
      expect(lines.map((l) => JSON.parse(l).externalId)).toEqual(['first', 'second', 'third']);
    });

    it('A3: each line contains all 7 fields', async () => {
      mockGetAllMessages.mockResolvedValue([makeRow({ externalId: 'e1' })]);
      await exportAll(outputPath);
      const content = await readFile(outputPath, 'utf-8');
      const obj = JSON.parse(content.trim());
      expect(Object.keys(obj).sort()).toEqual(
        ['externalId', 'fromAddr', 'parentId', 'sentAt', 'subject', 'threadKey', 'toAddrs'].sort(),
      );
    });

    it('A4: sentAt Date serialized as ISO string', async () => {
      const date = new Date('2024-01-01T12:34:56.789Z');
      mockGetAllMessages.mockResolvedValue([makeRow({ sentAt: date })]);
      await exportAll(outputPath);
      const content = await readFile(outputPath, 'utf-8');
      expect(JSON.parse(content.trim()).sentAt).toBe('2024-01-01T12:34:56.789Z');
    });

    it('A5: sentAt null stays null', async () => {
      mockGetAllMessages.mockResolvedValue([makeRow({ sentAt: null })]);
      await exportAll(outputPath);
      const content = await readFile(outputPath, 'utf-8');
      expect(JSON.parse(content.trim()).sentAt).toBeNull();
    });

    it('A6a: empty toAddrs → []', async () => {
      mockGetAllMessages.mockResolvedValue([makeRow({ toAddrs: [] })]);
      await exportAll(outputPath);
      const content = await readFile(outputPath, 'utf-8');
      expect(JSON.parse(content.trim()).toAddrs).toEqual([]);
    });

    it('A6b: multiple toAddrs preserved in order', async () => {
      mockGetAllMessages.mockResolvedValue([makeRow({ toAddrs: ['a@x', 'b@y', 'c@z'] })]);
      await exportAll(outputPath);
      const content = await readFile(outputPath, 'utf-8');
      expect(JSON.parse(content.trim()).toAddrs).toEqual(['a@x', 'b@y', 'c@z']);
    });

    it('A7: nullable fields present and null (not "null"/undefined/missing)', async () => {
      mockGetAllMessages.mockResolvedValue([
        makeRow({ parentId: null, threadKey: null, subject: null, fromAddr: null }),
      ]);
      await exportAll(outputPath);
      const content = await readFile(outputPath, 'utf-8');
      const obj = JSON.parse(content.trim());
      for (const k of ['parentId', 'threadKey', 'subject', 'fromAddr']) {
        expect(k in obj).toBe(true);
        expect(obj[k]).toBeNull();
      }
    });

    it('A8: file ends with newline', async () => {
      mockGetAllMessages.mockResolvedValue([makeRow({ externalId: 'e1' })]);
      await exportAll(outputPath);
      const content = await readFile(outputPath, 'utf-8');
      expect(content.endsWith('\n')).toBe(true);
    });
  });

  // ---- B. empty result ----
  describe('B. empty result', () => {
    it('B1: creates empty file (0 bytes)', async () => {
      mockGetAllMessages.mockResolvedValue([]);
      await exportAll(outputPath);
      const stats = await stat(outputPath);
      expect(stats.size).toBe(0);
    });
  });

  // ---- C. directory creation ----
  describe('C. directory creation', () => {
    it('C1: creates nested output directory', async () => {
      const nestedPath = join(tmpDir, 'nested', 'deep', 'result.jsonl');
      mockGetAllMessages.mockResolvedValue([makeRow()]);
      await exportAll(nestedPath);
      expect(await fileExists(nestedPath)).toBe(true);
    });

    it('C2: existing directory → no error on repeated call', async () => {
      mockGetAllMessages.mockResolvedValue([makeRow()]);
      await exportAll(outputPath);
      await expect(exportAll(outputPath)).resolves.toBeUndefined();
    });
  });

  // ---- D. write errors ----
  describe('D. write errors', () => {
    it('D1: fs.writeFile error → exportAll rejects', async () => {
      mockGetAllMessages.mockResolvedValue([makeRow()]);
      mockWriteFile.mockRejectedValueOnce(new Error('disk full'));
      await expect(exportAll(outputPath)).rejects.toThrow('disk full');
    });

    it('D2: fs.mkdir error → exportAll rejects', async () => {
      mockGetAllMessages.mockResolvedValue([makeRow()]);
      mockMkdir.mockRejectedValueOnce(new Error('permission denied'));
      await expect(exportAll(outputPath)).rejects.toThrow('permission denied');
    });
  });

  // ---- E. db interaction ----
  describe('E. db interaction', () => {
    it('E1: getAllMessages called exactly once', async () => {
      mockGetAllMessages.mockResolvedValue([]);
      await exportAll(outputPath);
      expect(mockGetAllMessages).toHaveBeenCalledTimes(1);
    });

    it('E2: getAllMessages error → rejects, file not created', async () => {
      mockGetAllMessages.mockRejectedValueOnce(new Error('db down'));
      await expect(exportAll(outputPath)).rejects.toThrow('db down');
      expect(await fileExists(outputPath)).toBe(false);
    });
  });
});

// ---- 7. runCli ----
describe('runCli', () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllMessages.mockReset();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('F1: success → exit(0) and info logged', async () => {
    mockGetAllMessages.mockResolvedValue([]);
    await runCli();
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(mockLogger.info).toHaveBeenCalled();
  });

  it('F2: failure → exit(1) and error logged with the underlying error', async () => {
    const err = new Error('boom');
    mockGetAllMessages.mockRejectedValueOnce(err);
    await runCli();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err }),
      expect.any(String),
    );
  });
});