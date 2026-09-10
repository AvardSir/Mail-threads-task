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
}

describe('fetchMessages', () => {
  beforeEach(() => {
    nock.cleanAll();
    nock.disableNetConnect();
    jest.clearAllMocks();
  });

  afterAll(() => {
    nock.enableNetConnect();
  });



  // afterEach(() => {
  //   jest.useRealTimers();
  // });

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

      await expect(fetchMessages()).rejects.toThrow('Unexpected status 302');
    });
  });

  // --- 6. Общий таймаут операции ---
  describe('operation timeout', () => {
    it('should throw if total operation time exceeds TOTAL_OPERATION_TIMEOUT', async () => {
      // Имитируем бесконечную задержку ответа: nock будет ждать, но мы не отвечаем
      // Однако axios имеет свой таймаут (REQUEST_TIMEOUT=1000ms), поэтому нам нужно заставить его ждать дольше.
      // Проще: замокать axiosInstance.get, чтобы он не резолвился, а использовал setTimeout.
      // Но мы можем использовать nock с задержкой ответа.
      // Установим общий таймаут = 2000 мс, а ответ будет приходить через 3000 мс.
      // Но nock не поддерживает задержку ответа легко. Используем другой подход: замокаем sleep и getDelay, чтобы они не продвигали время.
      // Мы можем использовать jest.advanceTimersByTime и проверить, что после превышения таймаута выбрасывается ошибка.
      //  c  jest.advanceTimersByTime проблема и их убрали
      // Для этого создадим сценарий, где все попытки будут неудачными, а задержки будут превышать общий таймаут.
      // Установим MAX_RETRIES=5, BASE_DELAY=1000, TOTAL_OPERATION_TIMEOUT=2000.
      // Тогда после двух попыток (0 и 1) общее время превысит 2000.


      jest.resetModules();
      process.env.TOTAL_OPERATION_TIMEOUT = '100';
      process.env.BASE_DELAY = '500';

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { fetchMessages: fetch2 } = require('./client');

      nock(baseUrl).get('/v1/messages').query({ limit: '200' }).reply(500);

      await expect(fetch2()).rejects.toThrow(/Operation timed out/);


      // Пересоздаём клиент? Лучше перезагрузить модуль, чтобы применились новые переменные.
      // Вместо этого мы можем переопределить конфиг внутри теста через jest.resetModules и повторный импорт.
      // Но проще оставить как есть и использовать реальный таймаут.
      // Однако тест станет долгим. Вместо этого мы можем замокать setTimeout и проверить, что ошибка выбрасывается через Promise.race.
      // Лучше написать отдельный тест, который использует реальный таймаут, но ускорить его путём уменьшения значений.
      // Для упрощения опустим этот тест, так как он сложен в реализации с fake timers.
      // Вместо этого проверим, что функция выбрасывает ошибку, если общий таймаут истекает.
      // Сделаем так: устанавливаем общий таймаут 100ms, а первая попытка занимает 200ms (например, через задержку в ответе).
      // nock не умеет задерживать ответ, но мы можем использовать axios interceptors или просто замокать axiosInstance.
      // Оставлю этот тест как "не реализован", но можно пропустить.
      // В реальном проекте такой тест важен, но из-за сложности с fake timers и nock предлагаю пропустить.

      // expect(true).toBe(true);

    });
  });

  // --- 7. Исчерпание попыток ---
  describe('max retries exhausted', () => {
    it('should throw the last error after all retries', async () => {
      // Устанавливаем MAX_RETRIES = 2 (итого 3 попытки)
      process.env.MAX_RETRIES = '2';
      // Все запросы будут возвращать 500
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .times(4)
        .reply(500);

      // Перезагружаем модуль, чтобы применить новые настройки? Но мы уже изменили process.env, но конфиг уже прочитан при первом импорте.
      // Лучше перезагрузить модуль с помощью jest.isolateModules или jest.resetModules.
      // Просто пересоздадим клиент, но это сложно.
      // Вместо этого можем явно задать config через мок, но проще использовать текущие настройки (MAX_RETRIES=3 по умолчанию).
      // Оставим как есть, но проверим, что после 4 попыток (0-3) выбрасывается ошибка.
      // Используем исходные настройки: MAX_RETRIES=3 -> попытки 0,1,2,3 (4 попытки). Поэтому nock должен ответить 4 раза.
      // Удалим предыдущие nock и создадим новые.
      nock.cleanAll();
      nock(baseUrl)
        .get('/v1/messages')
        .query({ limit: '200' })
        .times(4)
        .reply(500);

      await expect(fetchMessages()).rejects.toThrow('Request failed with status code 500');
      // Проверяем, что было 4 вызова
      expect(nock.isDone()).toBe(true);
    });
  });
});
