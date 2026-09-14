📋 Project Context: Mail Threads Task
Справочник по проекту. Держи под рукой при добавлении новых фич и тестов.

1. 🎯 Что это
Клиент для получения сообщений (тредов) от внешнего провайдера через HTTP API.
Один ключевой модуль — client.ts с единственной публичной функцией fetchMessages.
Всё остальное — инфраструктура вокруг неё (конфиг, логгер, ретраи, валидация).

2. 🛠 Стек
Слой	Технология
Язык	TypeScript
HTTP	axios
Retry	ручной (while + sleep)
Логи	pino
Env	dotenv
Тесты	jest + nock
Тест-таймеры	реальные (НЕ jest.useFakeTimers)
3. 📁 Структура
text
project/
├── .env                    ← боевой конфиг (в .gitignore)
├── jest.config.js          ← setupFiles: ['<rootDir>/jest.setup.ts']
├── jest.setup.ts           ← env-переменные для тестов (в git)
└── src/
    ├── client.ts           ← вся логика клиента
    ├── client.test.ts      ← тесты
    ├── prisma.ts           ← shared PrismaClient (один на процесс)
    ├── db.ts               ← слой БД (Веха 4)
    └── db.test.ts          ← тесты слоя БД
    
4. ⚙️ Конфиг: правила игры
4.1 Env-переменные читаются один раз при импорте модуля
ts
const config = {
  baseURL:              process.env.PROVIDER_URL,
  requestTimeout:       Number(process.env.REQUEST_TIMEOUT),
  maxRetries:           Number(process.env.MAX_RETRIES),
  baseDelay:            Number(process.env.BASE_DELAY),
  maxDelay:             Number(process.env.MAX_DELAY),
  totalOperationTimeout: Number(process.env.TOTAL_OPERATION_TIMEOUT),
};
⚠️ Следствие: поменять env в рантайме — невозможно без jest.resetModules().
⚠️ В тестах env задаются только через jest.setup.ts + setupFiles. Никогда — присваиванием в самом тест-файле (ES-import хойстится и модуль прочитает дефолты).

4.2 Значения для тестов
ts
// jest.setup.ts
PROVIDER_URL            = 'http://test-provider'
REQUEST_TIMEOUT         = '1000'
MAX_RETRIES             = '3'
BASE_DELAY              = '10'      // маленькие! иначе тесты тормозят
MAX_DELAY               = '500'
TOTAL_OPERATION_TIMEOUT = '5000'
LOG_LEVEL               = 'silent'
5. 🌐 Axios: жёсткие правила
ts
axios.create({
  baseURL: config.baseURL,
  timeout: config.requestTimeout,
  headers: { 'Accept': 'application/json' },
  maxRedirects: 0,              // ← ОБЯЗАТЕЛЬНО: нам нужен реальный статус, а не следование за 3xx
});
maxRedirects: 0 — иначе axios сам делает повторный запрос, который ломает nock и маскирует 302.

Инстанс создаётся один раз при импорте модуля.

6. 🔁 Retry: что ретраить, что нет
✅ Retryable (транзиентные)
Условие	Задержка
status === 429	Retry-After заголовок → либо getDelay(attempt, baseDelay*2, maxDelay)
status 5xx	getDelay(attempt, baseDelay, maxDelay)
code ∈ ECONNABORTED, ETIMEDOUT, ENOTFOUND, ECONNREFUSED	getDelay(attempt, baseDelay, maxDelay)
❌ НЕ retryable (бросаем сразу)
Любая не-AxiosError → это валидационная ошибка, которую мы сами бросили.

status 3xx (кроме редиректов — их вообще не будет с maxRedirects: 0).

status 4xx, кроме 429.

Формула задержки
ts
getDelay(attempt, base, max) =
  min( min(base * 2^attempt, max) * jitter(0.8..1.2), max )
Счётчик попыток
attempt идёт от 0 до config.maxRetries включительно.

Итого запросов: maxRetries + 1 (первая попытка + ретраи).

7. 🛡 Валидация ответа
Проверяем по порядку, бросаем сразу, без ретраев:

response.status !== 200 → Unexpected status ${status}

typeof data !== 'object' || !data → Response body is not an object

!Array.isArray(data.items) → Response missing "items" array

!('next_cursor' in data) → Response missing "next_cursor" field

Все эти ошибки — обычные Error, не AxiosError. Именно по этому признаку catch отличает «валидацию» от «транзиентной ошибки».

8. ⏱ Общий таймаут операции
ts
Promise.race([fetchPromise, timeoutPromise])
timeoutPromise реджектится через config.totalOperationTimeout мс.

Ограничивает всё: все попытки + все sleep-ы вместе.

Внутренний fetchPromise после этого продолжает жить (это известная особенность Promise.race), но наружу уже ничего не отдаёт.

9. 🧪 Тесты: каноны
9.1 Настройка describe
ts
describe('fetchMessages', () => {
  beforeEach(() => {
    nock.cleanAll();           // ✅ обязательно
    nock.disableNetConnect();  // ✅ страховка от реальных запросов
    jest.clearAllMocks();
  });

  afterAll(() => {
    nock.enableNetConnect();
  });
});
9.2 Никогда не использовать
❌ jest.useFakeTimers() + jest.advanceTimersByTime() — конфликтуют с axios/nock.

❌ process.env.X = ... внутри теста — не работает после импорта.

❌ Ожидание, что клиент ретраит валидационную ошибку.

9.3 Мок pino — обязательный
ts
jest.mock('pino', () => {
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(),
                       debug: jest.fn(), child: jest.fn().mockReturnThis() };
  const pinoMock: any = jest.fn(() => mockLogger);
  pinoMock.stdTimeFunctions = {
    isoTime:   jest.fn(() => ',"time":"2024-01-01T00:00:00.000Z"'),
    epochTime: jest.fn(() => ',"time":0'),
    unixTime:  jest.fn(() => ',"time":0'),
    nullTime:  jest.fn(() => ''),
  };
  return pinoMock;
});
Без stdTimeFunctions.isoTime модуль падает ещё на импорте.

9.4 Смена конфига в конкретном тесте
Только через модульный ресет:

ts
jest.resetModules();
process.env.TOTAL_OPERATION_TIMEOUT = '100';
const { fetchMessages } = require('./client');
// ... тест ...
jest.dontMock('axios');   // если мокали
jest.resetModules();
9.5 Покрытие — группы
Группа	Что проверяет
successful requests	без курсора / с курсором / кастомный limit
rate limiting (429)	Retry-After в секундах / в HTTP-дате / отсутствует
server errors (5xx)	500 / 503
network errors	ECONNREFUSED / ETIMEDOUT / ENOTFOUND / ECONNABORTED
response validation	4 кейса из §7
operation timeout	мок axios с вечно висящим get()
max retries exhausted	.times(maxRetries + 1) × 500
10. 📝 Стиль кода
Только стрелки и async/await, никаких .then().

Функции-хелперы — вне экспорта, приватные (getDelay, sleep, parseRetryAfter, generateRequestId).

Логгер — через rootLogger.child({...}), не глобальный.

Все магические числа и строки — в config или в env.

Сообщения об ошибках — по-английски, точные, с указанием сущности: "Response missing \"items\" array", а не "bad response".

Типы ответа — интерфейсы, экспортируются рядом с функцией.

Никаких any, кроме мока pino в тестах.

Комментарии-разделители // ---- N. Название ---- для секций в модуле.

11. 🚨 Грабли (запомнить наизусть)
#	Грабли	Правило
1	import './client' до process.env.X = ...	env читается при импорте; используй setupFiles
2	jest.useFakeTimers() с axios/nock	не использовать; задержки в тестах — маленькие через env
3	Retry на валидационных ошибках	всё, что не AxiosError — бросать сразу
4	Retry на 3xx/4xx	retry только 429 / 5xx / network-коды
5	axios следует редиректам	maxRedirects: 0
6	nock без cleanAll() в beforeEach	иначе интерсепторы утекают между тестами
7	Promise.race не убивает проигравший промис	учитывай висящие sleep-ы после таймаута
8	pino.stdTimeFunctions в моке	без него падение на этапе импорта
9	.times(N) в nock без учёта maxRetries	N = maxRetries + 1
10	Env в боевом .env ≠ env для тестов	для тестов — jest.setup.ts
11	@@map в Prisma	в raw SQL и TRUNCATE — имена таблиц ("messages", "app_state"), не моделей


12. 🎓 TL;DR
Клиент — это один модуль с одной функцией.
Конфиг — читается один раз, меняется только через reset modules.
Retry — только для транзиентных ошибок, всё остальное — сразу наружу.
Тесты — nock + реальные таймеры + маленькие задержки через setup-файл.
Стиль — строгий TypeScript, явные типы, точные сообщения об ошибках.



13. 🧪 TDD-практика

Сначала реализовываем тесты. Затем отедльным тестом реализовываем основую фичу.

13.1. Цикл
- Red: сначала пишем падающий тест на новое поведение.
- Green: минимальная реализация, чтобы тест прошёл.
- Refactor: улучшаем код, тесты остаются зелёными.

13.2. Правила
- Окружение: Docker Desktop запущен локально, контейнеры (PostgreSQL) поднимаются
  автоматически при старте Docker Desktop. Команду `docker compose up` в плане
  не использовать — считаем, что БД уже доступна по DATABASE_URL.
- Тест — это спецификация. Не подгоняем тест под багованный код;
  если код ведёт себя не так — сначала правим ожидание или код, но осознанно.
- HTTP-взаимодействие тестируем через nock; реальные запросы к провайдеру запрещены.
- Retry-логику проверяем на реальных таймерах с маленькими задержками
  через jest.setup.ts (см. §9). Fake timers не используем.
- Для БД (Веха 4+) — изоляция состояния: TRUNCATE таблиц перед каждым тестом
  (или транзакция с откатом). Один тест = одно предсказуемое состояние.
- Unit-тесты быстрые (< 1 сек на файл). Интеграционные (БД, worker) — отдельной
  группой, помечаем `describe.skip` / отдельный jest-конфиг при необходимости.
- Новый модуль без теста не считается готовым.
- Мокаем только внешние границы (HTTP, pino, БД). Внутренние функции — не мокаем.

13.3. Порядок работы над модулем
1. Зафиксировать публичный контракт (экспортируемые функции + типы).
2. Написать тесты на happy path и на все ветки ошибок (§6 и §7 — источник истины).
3. Реализовать минимально.
4. Прогнать coverage, добрать пропущенные ветки.
5. Только после зелёных тестов — коммит.

---

14. 🗺 Дорожная карта (вехи)

Статусы: ✅ выполнено · 🔄 в работе · ⏳ запланировано

| # | Веха | Артефакты | Статус |
|---|------|-----------|--------|
| 0 | Подготовка окружения | VPN, клон репо, .env, доступ к provider | ✅ |
| 1 | Инициализация TS-проекта | package.json, tsconfig, структура src/, скрипты | ✅ |
| 2 | Модель БД и миграции | prisma/schema.prisma, миграция init, docker-compose.dev.yml | ✅ |
| 3 | HTTP-клиент с обработкой ошибок | src/client.ts, src/client.test.ts, jest.config.js, jest.setup.ts | ✅ |
| 4 | Слой БД | src/db.ts, src/db.test.ts, src/prisma.ts | ✅ |
| 5 | Основной цикл (worker) | src/worker.ts, обработка stage/cursor | 🔄 следующая |
| 6 | Постобработка | src/processor.ts (parent_id, thread_key через DSU) | ⏳ |
| 7 | Экспорт | src/exporter.ts → ./out/result.jsonl | ⏳ |
| 8 | Production Docker | Dockerfile, docker-compose.yml (db + worker + exporter) | ⏳ |
| 9 | E2E-прогон | Полный цикл: load → process → export | ⏳ |
| 10 | Документация | README, инструкция запуска, переменные окружения | ⏳ |

14.1. Текущий статус
- Веха 3 завершена: client.ts реализован, тесты зелёные.
- Веха 4 завершена: src/prisma.ts, src/db.ts, src/db.test.ts реализованы,
  все тесты зелёные.
- Все ограничения и грабли Вехи 3 зафиксированы в §4–§11 — это источник истины
  для клиента, менять их без причины нельзя.
- Следующий шаг — Веха 5 (src/worker.ts). Работаем по TDD (§13): тесты → реализация.
14.2. Что должно быть в Вехе 4 (db.ts)
Публичный контракт (обязателен, из §3.1 исходного ТЗ):

- getState(key): Promise<string | null>
- setState(key, value): Promise<void>
- saveMessages(messages: MessageItem[]): Promise<number>  // возвращает кол-во вставленных
- getAllMessages(): Promise<MessageRow[]>
- updateThreadAndParent(updates: Array<{ externalId, parentId, threadKey }>): Promise<void>

Статус: ✅ реализовано в src/db.ts, покрыто тестами в src/db.test.ts.
Дополнительно экспортируются типы: MessageItem, MessageRow, UpdateThreadInput.


Правила:
- saveMessages — идемпотентна: дубликаты по externalId пропускаем (skipDuplicates).
- updateThreadAndParent — батчевое обновление, без N+1.
- Все функции — на Prisma-клиенте из shared-инстанса (один PrismaClient на процесс).
- Тесты — против реального PostgreSQL (Docker Desktop уже запущен, см. §13.2),
  с TRUNCATE в beforeEach. Мокать Prisma нельзя — иначе теряется смысл слоя.
- Таблицы в БД называются по @@map: "messages" и "app_state". В raw SQL и в
  TRUNCATE использовать именно эти имена, а не имена моделей Prisma
  (Message/AppState) — иначе relation does not exist.- Никакой бизнес-логики в db.ts: только доступ к данным.

14.3. Что должно быть в Вехе 5 (worker.ts)
- Читает stage через getState('stage').
- idle → loading: цикл fetchMessages + saveMessages + setState('cursor', ...).
- loading → processing: когда next_cursor === null.
- processing → done: вызов processor (§6) + exporter (§7).
- При рестарте: если stage === 'processing' — сразу к постобработке (не перезагружать).
- Если stage === 'done' — выход.
- Все переходы stage — через setState, атомарно относительно падений.
Порядок: зафиксировать контракт worker.ts → тесты (nock + реальная БД) →
реализация. Переходы stage — источник истины, не менять на ходу.

14.4. Что должно быть в Вехе 6 (processor.ts)
- parent_id: идём по [references..., in_reply_to] с конца, берём первый externalId,
  который есть в БД. Если нет — null.
- thread_key: DSU по всем ссылкам (references + in_reply_to). Корень → "t-<root>".
- Результат — массив updates для updateThreadAndParent.
- Чистая функция: (messages, existingIds) → updates. Легко тестируется без БД.

14.5. Что должно быть в Вехе 7 (exporter.ts)
- Читает getAllMessages().
- Пишет ./out/result.jsonl: одна строка = один JSON-объект с полями
  externalId, parentId, threadKey, subject, fromAddr, toAddrs, sentAt.
- Порядок строк детерминирован (по externalId или по id).
- Ошибки записи — фатальны (exit code ≠ 0).

14.6. Границы вех (что НЕ делать раньше времени)
- В client.ts не добавлять логику БД или состояния — только HTTP.
- В db.ts не добавлять retry или HTTP — только Prisma.
- В worker.ts не добавлять DSU или парсинг — это processor.ts.
- В processor.ts не ходить в БД напрямую — принимать данные аргументами.
