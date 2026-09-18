// src/client.test.ts
import { fetchMessages, MessageItem, FetchResponse } from './client';
import nock from 'nock';
import pino from 'pino';

// Мокаем pino, чтобы логи не выводились в консоль
jest.mock('pino', () => {
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  };

  const pinoMock: any = jest.fn(() => mockLogger);

  // Важно: client.ts обращается к pino.stdTimeFunctions.isoTime
  pinoMock.stdTimeFunctions = {
    isoTime: jest.fn(() => ',"time":"2024-01-01T00:00:00.000Z"'),
    epochTime: jest.fn(() => ',"time":0'),
    unixTime: jest.fn(() => ',"time":0'),
    nullTime: jest.fn(() => ''),
  };

  return pinoMock;
});



// Утилита для создания валидного ответа
function createValidResponse(items: Partial<MessageItem>[] = [], nextCursor: string | null = null): any {
  return {
    items: items.map(item => ({
      message_id: item.message_id || `msg-${Math.random()}`,
      in_reply_to: item.in_reply_to || undefined,
      references: item.references || [],
      subject: item.subject || 'Test subject',
      from: item.from || 'test@example.com',
      to: item.to || ['to@example.com'],
      sent_at: item.sent_at || new Date().toISOString(),
    })),
    next_cursor: nextCursor,
  };
};

const TOTAL_OP_TIMEOUT_MS = Number(process.env.TOTAL_OPERATION_TIMEOUT);

describe('fetchMessages', () => {
  beforeEach(() => {
    nock.cleanAll();
    nock.disableNetConnect();
    jest.clearAllMocks();
  });

  afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});



  const baseUrl = 'http://test-provider';

  // --- 1. Успешные запросы ---
  describe('successful requests', () => {
    it('should fetch messages without cursor', async () => {
      const responseData = createValidResponse([{ message_id: '1' }, { message_id: '2' }], 'next123');
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .reply(200, responseData);

      const result = await fetchMessages();
      expect(result.items).toHaveLength(2);
      expect(result.next_cursor).toBe('next123');
      expect(result.items[0].message_id).toBe('1');
    });

    it('should fetch messages with cursor', async () => {
      const responseData = createValidResponse([{ message_id: '3' }], null);
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200', cursor: 'abc' })
        .reply(200, responseData);

      const result = await fetchMessages('abc');
      expect(result.items).toHaveLength(1);
      expect(result.next_cursor).toBeNull();
    });

    it('should handle limit parameter', async () => {
      const responseData = createValidResponse([], null);
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '50' })
        .reply(200, responseData);

      await fetchMessages(undefined, 50);
      expect(nock.isDone()).toBe(true);
    });
  });

  // --- 2. Ошибка 429 ---
  describe('rate limiting (429)', () => {
    it('should retry after Retry-After in seconds', async () => {
      // Первый запрос: 429 с Retry-After: 2 (секунды)
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .reply(429, {}, { 'Retry-After': '0' });
      // Второй запрос: успех
      const successData = createValidResponse([{ message_id: 'retried' }], null);
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .reply(200, successData);

      const promise = fetchMessages();


      const result = await promise;
      expect(result.items[0].message_id).toBe('retried');
      expect(nock.isDone()).toBe(true);
    });

    it('should retry after Retry-After as HTTP date', async () => {
      const futureDate = new Date(Date.now() + 50).toUTCString();
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .reply(429, {}, { 'Retry-After': futureDate });
      const successData = createValidResponse([{ message_id: 'date-retried' }], null);
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .reply(200, successData);

      const promise = fetchMessages();

      const result = await promise;
      expect(result.items[0].message_id).toBe('date-retried');
    });

    it('should use exponential backoff if Retry-After is missing', async () => {
      // Первый 429 без заголовка
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .reply(429);
      // Второй тоже 429
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .reply(429);
      // Третий успех (при MAX_RETRIES=3, попытки 0,1,2; после двух неудач третья успешная)
      const successData = createValidResponse([{ message_id: 'backoff' }], null);
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .reply(200, successData);

      const promise = fetchMessages();
      // Ожидаем задержку: первая попытка (attempt=0) -> baseDelay * 2 = 200ms, вторая (attempt=1) -> baseDelay * 2^2 = 400ms (с джиттером, но мы форсируем)
      // Чтобы тест был детерминированным, мы можем замокать getDelay, но проще продвинуть время на достаточную сумму.
      const result = await promise;
      expect(result.items[0].message_id).toBe('backoff');
    });
  });

  // --- 3. Ошибки 5xx ---
  describe('server errors (5xx)', () => {
    it('should retry on 500 with exponential backoff', async () => {
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .reply(500);
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .reply(200, createValidResponse([{ message_id: 'after-500' }], null));

      const promise = fetchMessages();
      const result = await promise;
      expect(result.items[0].message_id).toBe('after-500');
    });

    it('should retry on 503', async () => {
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .reply(503);
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .reply(200, createValidResponse([{ message_id: 'after-503' }], null));

      const promise = fetchMessages();
      const result = await promise;
      expect(result.items[0].message_id).toBe('after-503');
    });
  });

  // --- 4. Сетевые ошибки и таймауты ---
  describe('network errors and timeouts', () => {
    it('should retry on ECONNREFUSED', async () => {
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .replyWithError({ code: 'ECONNREFUSED' });
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .reply(200, createValidResponse([{ message_id: 'conn-refused' }], null));

      const promise = fetchMessages();
      const result = await promise;
      expect(result.items[0].message_id).toBe('conn-refused');
    });

    it('should retry on ETIMEDOUT', async () => {
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .replyWithError({ code: 'ETIMEDOUT' });
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .reply(200, createValidResponse([{ message_id: 'timeout' }], null));

      const promise = fetchMessages();

      const result = await promise;
      expect(result.items[0].message_id).toBe('timeout');
    });

    it('should retry on ENOTFOUND', async () => {
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .replyWithError({ code: 'ENOTFOUND' });
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .reply(200, createValidResponse([{ message_id: 'notfound' }], null));

      const promise = fetchMessages();

      const result = await promise;
      expect(result.items[0].message_id).toBe('notfound');
    });

    it('should handle axios timeout (ECONNABORTED)', async () => {
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .replyWithError({ code: 'ECONNABORTED' });
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .reply(200, createValidResponse([{ message_id: 'aborted' }], null));

      const promise = fetchMessages();

      const result = await promise;
      expect(result.items[0].message_id).toBe('aborted');
    });
  });

  // --- 5. Валидация ответа ---
  describe('response validation', () => {
    it('should throw if response is not an object', async () => {
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .reply(200, 'not an object');

      await expect(fetchMessages()).rejects.toThrow('Response body is not an object');
    });

    it('should throw if missing items array', async () => {
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .reply(200, { next_cursor: null });

      await expect(fetchMessages()).rejects.toThrow('Response missing "items" array');
    });

    it('should throw if missing next_cursor field', async () => {
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .reply(200, { items: [] });

      await expect(fetchMessages()).rejects.toThrow('Response missing "next_cursor" field');
    });

    it('should throw if status is not 200', async () => {
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .reply(302, {});

      await expect(fetchMessages()).rejects.toThrow('status code 302');
    });
  });

  // --- 6. Общий таймаут операции ---
  describe('operation timeout', () => {
    it('should throw if total operation time exceeds TOTAL_OPERATION_TIMEOUT', async () => {
      const originalTimeout = process.env.TOTAL_OPERATION_TIMEOUT;
      jest.resetModules();
      process.env.TOTAL_OPERATION_TIMEOUT = '100';

      try {
        jest.doMock('axios', () => {
          const actual = jest.requireActual('axios');
          return {
            ...actual,
            default: {
              ...actual.default,
              create: () => ({
                get: () => new Promise(() => { /* висит вечно */ }),
              }),
              isAxiosError: actual.default.isAxiosError,
            },
            create: () => ({
              get: () => new Promise(() => { }),
            }),
            isAxiosError: actual.default.isAxiosError,
          };
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { fetchMessages: fetch2 } = require('./client');
        await expect(fetch2()).rejects.toThrow(/Operation timed out/);
      } finally {
        process.env.TOTAL_OPERATION_TIMEOUT = originalTimeout;
        jest.dontMock('axios');
        jest.resetModules();
      }
    });

  });

  // --- 7. Исчерпание попыток ---
  describe('max retries exhausted', () => {
    it('should throw the last error after all retries', async () => {
      const maxRetries = Number(process.env.MAX_RETRIES); // из jest.setup.ts
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .times(maxRetries + 1)   // попытки 0..maxRetries
        .reply(500);

      await expect(fetchMessages()).rejects.toThrow('Request failed with status code 500');
      expect(nock.isDone()).toBe(true);
    });

  });



  // ============================================================
  // T1 — timeout cleanup (мини-веха T1: §11.7 / §14.1 techdebt)
  // ============================================================
  describe('T1 — timeout cleanup', () => {
    const origSetTimeout = global.setTimeout;
    const origClearTimeout = global.clearTimeout;

    let capturing: boolean;
    let timerCalls: Array<{ ms: number | undefined; id: unknown }>;
    let clearedIds: unknown[];

    beforeEach(() => {
      capturing = false;
      timerCalls = [];
      clearedIds = [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global as any).setTimeout = function (
        fn: (...args: any[]) => void,
        ms?: number,
        ...args: any[]
      ) {
        const id = origSetTimeout(fn as any, ms as any, ...args);
        if (capturing) timerCalls.push({ ms, id });
        return id;
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global as any).clearTimeout = function (id?: unknown) {
        if (capturing) clearedIds.push(id);
        return origClearTimeout(id as any);
      };
    });

    afterEach(() => {
  nock.abortPendingRequests();   // ← гасим хвосты сразу после каждого теста
});


    const opIdsWithMs = (ms: number): unknown[] =>
      timerCalls.filter((c) => c.ms === ms).map((c) => c.id);

    it('T1.1 clears the total-operation timeout after a successful response', async () => {
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .reply(200, createValidResponse([], null));

      capturing = true;
      try {
        await fetchMessages();
      } finally {
        capturing = false;
      }

      const opIds = opIdsWithMs(TOTAL_OP_TIMEOUT_MS);
      expect(opIds.length).toBe(1);
      expect(clearedIds.includes(opIds[0])).toBe(true);
    });

    it('T1.2 clears the timeout after a non-retryable 400', async () => {
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .reply(400, { error: 'bad request' });

      capturing = true;
      try {
        await expect(fetchMessages()).rejects.toThrow();
      } finally {
        capturing = false;
      }

      const opIds = opIdsWithMs(TOTAL_OP_TIMEOUT_MS);
      expect(opIds.length).toBe(1);
      expect(clearedIds.includes(opIds[0])).toBe(true);
    });

    it('T1.3 clears the timeout after retries are exhausted', async () => {
      const maxRetries = Number(process.env.MAX_RETRIES);
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .times(maxRetries + 1)
        .reply(500);

      capturing = true;
      try {
        await expect(fetchMessages()).rejects.toThrow();
      } finally {
        capturing = false;
      }

      const opIds = opIdsWithMs(TOTAL_OP_TIMEOUT_MS);
      expect(opIds.length).toBe(1);
      expect(clearedIds.includes(opIds[0])).toBe(true);
    });

    it('T1.4 clears the timeout id when the total-operation timeout fires', async () => {
      const originalTimeout = process.env.TOTAL_OPERATION_TIMEOUT;
      const localMs = 100;

      jest.resetModules();
      process.env.TOTAL_OPERATION_TIMEOUT = String(localMs);

      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { fetchMessages: fetchMessagesFast } = require('./client');

        nock(baseUrl)
          .get('/v1/messages')
          .query({ limit: '200' })
          .delay(500)
          .reply(200, createValidResponse([], null));

        capturing = true;
        try {
          await expect(fetchMessagesFast()).rejects.toThrow();
        } finally {
          capturing = false;
        }

        const opIds = opIdsWithMs(localMs);
        expect(opIds.length).toBe(1);
        expect(clearedIds.includes(opIds[0])).toBe(true);
      } finally {
        process.env.TOTAL_OPERATION_TIMEOUT = originalTimeout;
        jest.resetModules();
      }
    });

    it('T1.5 uses exactly one total-operation timer per call and clears it', async () => {
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .reply(200, createValidResponse([], null));

      capturing = true;
      try {
        await fetchMessages();
      } finally {
        capturing = false;
      }

      const opIds = opIdsWithMs(TOTAL_OP_TIMEOUT_MS);
      expect(opIds.length).toBe(1);
      const clearsForOp = clearedIds.filter((id) => id === opIds[0]).length;
      expect(clearsForOp).toBe(1);
    });
  });

});
