// src/client.ts
import axios, { AxiosInstance, AxiosError } from 'axios';
import pino from 'pino';
import dotenv from 'dotenv';

dotenv.config();

// ---- 1. Типы данных (экспортируются) ----
export interface MessageItem {
  message_id: string;
  in_reply_to?: string;
  references: string[];
  subject: string;
  from: string;
  to: string[];
  sent_at: string;
}

export interface FetchResponse {
  items: MessageItem[];
  next_cursor: string | null;
}

// ---- 2. Внутренняя конфигурация ----
interface ClientConfig {
  baseURL: string;
  requestTimeout: number;
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  totalOperationTimeout: number;
}

const config: ClientConfig = {
  baseURL: process.env.PROVIDER_URL || 'http://localhost:8080',
  requestTimeout: Number(process.env.REQUEST_TIMEOUT) || 30000,
  maxRetries: Number(process.env.MAX_RETRIES) || 5,
  baseDelay: Number(process.env.BASE_DELAY) || 1000,
  maxDelay: Number(process.env.MAX_DELAY) || 30000,
  totalOperationTimeout: Number(process.env.TOTAL_OPERATION_TIMEOUT) || 120000,
};

// ---- 3. Логгер (корневой) ----
export const rootLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: { level: (label) => ({ level: label }) },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// ---- 4. Вспомогательные функции (внутренние) ----
function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDelay(attempt: number, baseDelay: number, maxDelay: number): number {
  const exponential = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  const jitter = exponential * (0.8 + 0.4 * Math.random()); // ±20%
  return Math.min(jitter, maxDelay);
}

function parseRetryAfter(header: string | undefined): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  // Если число секунд
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000;
  }
  // Если HTTP-дата
  const date = new Date(trimmed);
  if (!isNaN(date.getTime())) {
    const delta = date.getTime() - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

// ---- 5. Axios-инстанс ----
const axiosInstance: AxiosInstance = axios.create({
  baseURL: config.baseURL,
  timeout: config.requestTimeout,
  headers: { 'Accept': 'application/json' },
  maxRedirects: 0,   // ← добавить: нам нужен именно ответ провайдера

});

// (Опционально) интерцепторы для отладки – можно добавить позже

// ---- 6. Основная функция fetchMessages (экспортируемая) ----
export async function fetchMessages(
  cursor?: string,
  limit: number = 200
): Promise<FetchResponse> {
  const requestId = generateRequestId();
  const logger = rootLogger.child({ requestId, cursor, limit });

  logger.info('Starting fetchMessages');

  const operationTimeout = config.totalOperationTimeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Operation timed out after ${operationTimeout}ms`));
    }, operationTimeout);
  });

  const fetchPromise = (async () => {
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt <= config.maxRetries) {
      try {
        logger.debug({ attempt }, `Attempt ${attempt + 1}/${config.maxRetries + 1}`);

        const params: Record<string, string | number> = { limit };
        if (cursor) {
          params.cursor = cursor;
        }

        const response = await axiosInstance.get('/v1/messages', { params });

        if (response.status !== 200) {
          throw new Error(`Unexpected status ${response.status}`);
        }

        const data = response.data;
        if (!data || typeof data !== 'object') {
          throw new Error('Response body is not an object');
        }
        if (!Array.isArray(data.items)) {
          throw new Error('Response missing "items" array');
        }
        if (!('next_cursor' in data)) {
          throw new Error('Response missing "next_cursor" field');
        }

        const items = data.items as MessageItem[];
        const nextCursor = data.next_cursor as string | null;

        logger.info({ itemsCount: items.length, nextCursor }, 'Fetch succeeded');
        return { items, next_cursor: nextCursor };
      } catch (error) {
        // 1) Ошибки валидации (мы их бросаем сами) — сразу наружу, без retry
        if (!axios.isAxiosError(error)) {
          logger.error({ error: (error as Error).message }, 'Non-retryable error');
          throw error;
        }

        const axiosError = error as AxiosError;
        const status = axiosError.response?.status;
        const headers = axiosError.response?.headers;

        // 2) Классифицируем ошибку
        const isRateLimit = status === 429;
        const isServerError = status !== undefined && status >= 500 && status < 600;
        const isNetworkError =
          axiosError.code === 'ECONNABORTED' ||
          axiosError.code === 'ETIMEDOUT' ||
          axiosError.code === 'ENOTFOUND' ||
          axiosError.code === 'ECONNREFUSED';

        const isRetryable = isRateLimit || isServerError || isNetworkError;

        // 3) Всё остальное (3xx, 4xx кроме 429, прочее) — не ретраить
        if (!isRetryable) {
          logger.error(
            { status, code: axiosError.code, error: axiosError.message },
            'Non-retryable axios error'
          );
          throw error;
        }

        lastError = error as Error;

        // 4) Если попытки кончились — бросаем последнюю ошибку
        if (attempt >= config.maxRetries) {
          logger.error({ attempt, error: lastError.message }, 'Max retries exceeded, throwing');
          throw lastError;
        }

        // 5) Считаем задержку и спим
        let delayMs: number;
        if (isRateLimit) {
          const retryAfterHeader = headers?.['retry-after'] || headers?.['Retry-After'];
          const parsed = parseRetryAfter(retryAfterHeader as string | undefined);
          if (parsed !== null) {
            delayMs = parsed;
            logger.warn({ attempt, retryAfter: parsed }, 'Received 429, waiting Retry-After');
          } else {
            delayMs = getDelay(attempt, config.baseDelay * 2, config.maxDelay);
            logger.warn({ attempt, delayMs }, '429 without Retry-After, using backoff');
          }
        } else if (isServerError) {
          delayMs = getDelay(attempt, config.baseDelay, config.maxDelay);
          logger.warn({ attempt, status, delayMs }, `Server error ${status}, retrying`);
        } else {
          delayMs = getDelay(attempt, config.baseDelay, config.maxDelay);
          logger.warn({ attempt, code: axiosError.code, delayMs }, 'Network error, retrying');
        }

        if (delayMs > 0) {
          await sleep(delayMs);
        }
        attempt++;
      }


    }

    throw lastError || new Error('Fetch failed after all retries');
  })();

  return Promise.race([fetchPromise, timeoutPromise]);
}