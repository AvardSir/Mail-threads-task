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
project/
├── .env                    ← боевой конфиг (в .gitignore)
├── .env.example            ← шаблон (в git)
├── .dockerignore           ← ✅ Веха 8
├── Dockerfile              ← ✅ Веха 8
├── docker-compose.yml      ← ✅ Веха 8 (provider + db + worker + exporter)
├── docker-compose.dev.yml  ← локальная разработка (Веха 2)
├── jest.config.js
├── jest.setup.ts
├── tsconfig.json
├── tsconfig.build.json     ← ⚠️ см. §13.6 (если применимо)
├── scripts/
│   └── entrypoint.sh       ← ✅ Веха 8 (prisma migrate deploy + exec "$@")
└── src/
    ├── client.ts           ← HTTP-клиент + AbortController (T3)
    ├── client.test.ts      ← ✅
    ├── prisma.ts
    ├── db.ts
    ├── db.test.ts
    ├── worker.ts
    ├── worker.test.ts
    ├── processor.ts
    ├── processor.test.ts
    ├── exporter.ts
    ├── exporter.test.ts
    └── docker.test.ts      ← ✅ Веха 8 (структурные тесты инфры)

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

4.3 tsconfig.json и сборка
jsonc
// tsconfig.json (для IDE/ts-jest)
"exclude": ["node_modules", "dist"]           // тесты НЕ исключаем
Сборка dist/ через npm run build — БЕЗ тестов. Тестовые файлы не должны попадать в образ. Решение: отдельный tsconfig.build.json (если exclude: ["**/*.test.ts"] в основном tsconfig ломает ts-jest — см. §13.6), либо npm run build с --excludeFiles.

Текущее состояние: tsconfig.json c "exclude": ["node_modules", "dist"], tsc собирает src/**/* → dist/, .dockerignore спасает от заноса dist/ в образ. Если тесты попадут в dist/ — пересмотреть.

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

code === 'ERR_CANCELED' (axios abort по AbortController) — см. §8.1.

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

8.1. Отмена in-flight axios (мини-веха T3)
ts
const controller = new AbortController();
let timeoutId: NodeJS.Timeout | undefined;

const timeoutPromise = new Promise<never>((_, reject) => {
  timeoutId = setTimeout(() => {
    controller.abort();                     // ← обязательно: рвём in-flight axios
    reject(new Error(`Operation timed out after ${operationTimeout}ms`));
  }, operationTimeout);
});

const fetchPromise = doFetch(controller.signal);   // signal → axios.get + sleep

try {
  return await Promise.race([fetchPromise, timeoutPromise]);
} finally {
  if (timeoutId) clearTimeout(timeoutId);
  fetchPromise.catch(() => {});              // глушим «проигравший» промис
}
sleep(ms, signal) — abort-aware: reject'ит сразу, если пришёл abort.

В начале каждой retry-итерации: if (controller.signal.aborted) throw new Error('Operation timed out...').

ERR_CANCELED от axios — не retryable, пробрасывается наружу (не входит в §6-список).

Правило: Promise.race не убивает проигравший промис. Без AbortController в nock-тестах копятся висячие MockHttpSocket (грабли #18).

9. 🧪 Тесты: каноны
9.1 Настройка describe
ts
describe('fetchMessages', () => {
  beforeEach(() => {
    nock.abortPendingRequests();   // ← первая строка: чужие висячие сокеты
    nock.cleanAll();
    nock.disableNetConnect();
    jest.clearAllMocks();
  });

  afterEach(() => {
    nock.abortPendingRequests();   // ← обязательно: гасит хвосты сразу
    nock.cleanAll();
  });

  afterAll(() => {
    nock.abortPendingRequests();
    nock.cleanAll();
    nock.enableNetConnect();
  });
});
9.2 Никогда не использовать
❌ jest.useFakeTimers() + jest.advanceTimersByTime() — конфликтуют с axios/nock.

❌ process.env.X = ... внутри теста — не работает после импорта.

❌ Ожидание, что клиент ретраит валидационную ошибку.

❌ Оставлять process.env.X переопределённым после теста — в --runInBand
   утечёт в следующий тест-файл (и в client.ts, который закешировал
   config при импорте). Всегда оборачивать в try/finally:

   const orig = process.env.X;
   process.env.X = '...';
   try { ... } finally { process.env.X = orig; jest.resetModules(); }

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
9.5. Покрытие — группы (client.ts)

| Группа                | Что проверяет                                       |
| --------------------- | --------------------------------------------------- |
| successful requests   | без курсора / с курсором / кастомный limit          |
| rate limiting (429)   | Retry-After в секундах / в HTTP-дате / отсутствует  |
| server errors (5xx)   | 500 / 503                                           |
| network errors        | ECONNREFUSED / ETIMEDOUT / ENOTFOUND / ECONNABORTED |
| response validation   | 4 кейса из §7                                       |
| operation timeout     | мок axios с вечно висящим get()                     |
| max retries exhausted | .times(maxRetries + 1) × 500                        |
| T1 — timeout cleanup  | clearTimeout в finally, 5 кейсов                    |

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
7 | Promise.race не убивает проигравший промис | (a) timeoutId хранить и чистить clearTimeout в finally вокруг Promise.race — иначе Jest «did not exit one second after test run»; (b) висячий nock.delay()-ответ переживает тест и убивает следующий файл в --runInBand — nock.abortPendingRequests() в afterAll
8	pino.stdTimeFunctions в моке	без него падение на этапе импорта
9	.times(N) в nock без учёта maxRetries	N = maxRetries + 1
10	Env в боевом .env ≠ env для тестов	для тестов — jest.setup.ts
11	@@map в Prisma	в raw SQL и TRUNCATE — имена таблиц ("messages", "app_state"), не моделей
| 12 | Два MessageItem — в client.ts и db.ts | Разные shape'ы под одним именем: ClientMessageItem (message_id/from/to/sent_at/in_reply_to) vs DbMessageItem (externalId/fromAddr/toAddrs/sentAt/inReplyTo). Импортировать через алиасы; маппинг — только в worker.ts → mapClientToDb |
| 13 | MessageRow.references: string[] — НЕ nullable, inReplyTo: string \| null | в processor.ts фильтр пустых/null всё равно нужен для inReplyTo; не писать `m.references ?? []` |
| 14 | DSU: корень = target в union(child, target) | обходить links в обратном порядке `[inReplyTo, references[last], …, references[0]]` — тогда корнем становится `references[0]`; мёртвые id из links тоже становятся узлами DSU |
| 15 | processor.ts — чистая функция без БД, HTTP, логгера | `buildUpdates(messages, existingIds) → UpdateThreadInput[]`; self-reference (`m.externalId`) исключается и из parentId, и из union |
| 16 | Env, переопределённый в тесте через process.env.X = ..., не восстанавливается | оборачивать в try/finally с restore; иначе в --runInBand утекает в следующий файл (client.ts кеширует config при импорте) |
| 17 | nock .delay(ms) с ms > operation timeout | тест падает по таймауту раньше, чем nock отдаёт ответ → висячий Immediate.cb → NetConnectNotAllowedError в следующем файле; лечится nock.abortPendingRequests() в afterAll |
| 18 | Promise.race не отменяет in-flight axios | AbortController + controller.abort() в timeout + signal в axios и в sleep + fetchPromise.catch(()=>{}) в finally. Без этого nock оставляет висячие сокеты → Jest did not exit + ENOTFOUND test-provider в следующем файле |
| 19 | nock.abortPendingRequests() не всегда помогает | Абортит только то, что в очереди nock. Если сокет уже «принят» интерсептором (MockHttpSocket) и axios не закрыл — нужен AbortController на стороне клиента |
| 20 | nock.disableNetConnect() в beforeEach ловит чужие висячие сокеты | Порядок в beforeEach: abortPendingRequests() → cleanAll() → disableNetConnect(). Иначе чужой сокет из предыдущего файла поймает барьер и уронит suite |
| 21 | afterEach + abortPendingRequests обязателен в каждом nock-файле | afterAll срабатывает слишком поздно — между ним и следующим файлом есть окно для утечки |
| 22 | pino.stdTimeFunctions.isoTime в моке | без него модуль падает на импорте |
| 23 | prisma CLI в dependencies, не devDependencies | entrypoint делает prisma migrate deploy в runtime-стадии, где npm ci --omit=dev |
| 24 | package.json — чистый JSON, без комментариев | // ← сюда ломает парсинг (EJSONPARSE) |
| 25 | docker compose run --rm <svc> игнорирует depends_on: service_completed_successfully | Порядок «worker → exporter» обеспечивает README/человек, не compose |
| 26 | exporter не должен зависеть от provider | Он ходит только в db; PROVIDER_URL в его env — рудимент для общих конфигураций |
| 27 | worker.runProcessing вызывает exportAll() | by design §14.3. В проде файл наружу отдаёт только служба exporter (bind-mount ./out); worker пишет в свой контейнер. Отражено в README (Веха 10) |

12. 🎓 TL;DR
Клиент — это один модуль с одной функцией.
Конфиг — читается один раз, меняется только через reset modules.
Retry — только для транзиентных ошибок, всё остальное — сразу наружу.
Тесты — nock + реальные таймеры + маленькие задержки через setup-файл.
Стиль — строгий TypeScript, явные типы, точные сообщения об ошибках.
Processor — DSU + скан parentId с конца; никакой БД и логов.
Operation timeout — AbortController, не только Promise.race (T3).

13. 🧪 TDD-практика (жёсткий протокол)

13.0. Главное правило
─────────────────────
TDD идёт ТРЕМЯ ОТДЕЛЬНЫМИ ЗАПРОСАМИ. Никогда не смешивать.

  Запрос 1: ПЛАН       → детальный план реализации фичи.
                         Включает: контракт, тест-план, порядок шагов.
                         Никакого кода. Только план. Ждём подтверждения.

  Запрос 2: ТЕСТЫ      → пишем ТОЛЬКО тесты. Никакой реализации.
                         Тесты обязаны падать (Red).
                         Пользователь запускает `npm test` и смотрит:
                         - тесты падают именно там, где ожидалось;
                         - окружение (nock, БД, моки) настроено корректно;
                         - нет ложных проходов.

  Запрос 3: РЕАЛИЗАЦИЯ → пишем реализацию, чтобы тесты стали зелёными (Green).
                         Затем Refactor: улучшаем код, тесты остаются зелёными.

Почему так:
- Тесты — спецификация. Если писать их вместе с реализацией, реализация
  невольно подгоняет тесты под себя, а не наоборот.
- Пользователь должен увидеть Red-фазу своими глазами. Это единственный
  момент, когда проверяется, что тест реально что-то проверяет.
- Тест, который сразу зелёный — бесполезен. Не доказывает ничего.

13.1. Цикл (внутри Запроса 3)
─────────────────────────────
- Red:    тесты уже написаны (Запрос 2), они падают.
- Green:  минимальная реализация, чтобы тесты прошли.
- Refactor: улучшаем код, тесты остаются зелёными.

13.2. Правила
─────────────
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
───────────────────────────────
1. Зафиксировать публичный контракт (экспортируемые функции + типы).
2. Перед написанием тестов убедиться, что целевой модуль находится в состоянии,
   гарантирующем Red. Если модуль уже существует со стабом, возвращающим
   безопасный дефолт (§13.5, случай b), — сначала заменить его тело на
   `throw new Error('Not implemented')`. Только после этого писать тесты.
   Иначе часть тестов (граничные случаи, совпадающие с дефолтом стаба)
   пройдёт без реализации, и Red-фаза будет неполной.
   
3. Пользователь подтверждает, что тесты падают по делу (Red-фаза).
4. Реализовать минимально (Green).
5. Прогнать coverage, добрать пропущенные ветки.
6. Только после зелёных тестов — коммит.

13.4. Что считается нарушением протокола
───────────────────────────────────────
❌ Тесты и реализация в одном ответе.
❌ Тесты, написанные после реализации.
❌ Тесты, которые не падали ни разу (значит, не проверяют ничего нового).
❌ «Сначала покажу пример реализации, потом тесты» — наоборот, не бывает.
✅ План → Red-тесты → подтверждение пользователя → Green-реализация.

13.5. Шаблон ответов по вехам

Пользователь просит: «Сделай фичу X».

Ответ ассистента ДОЛЖЕН быть разбит на три независимых запроса-ответа:

  ┌─ Запрос 1: ПЛАН ──────────────────────────────────────────┐
  │ - Цель вехи                                               │
  │ - Публичный контракт (функции + типы)                     │
  │ - Тест-план (список кейсов, группы)                       │
  │ - Порядок шагов                                           │
  │ - Открытые вопросы                                        │
  │ - Критерии готовности                                     │
  │ БЕЗ КОДА. Ждём «да».                                       │
  └───────────────────────────────────────────────────────────┘
                              ↓
  ┌─ Запрос 2: ТЕСТЫ ─────────────────────────────────────────┐
  │ - Только test-файлы + минимальные стабы, если нужны       │
  │   для компиляции импортов (тела — throw new Error('NI')).  │
  │ - Никакой реализации фичи.                                │
  │ - Ответ обязан заканчиваться фразой:                       │
  │   «Запусти `npm test -- <path>`, ожидаю Red по кейсам      │
  │    A1–A4, B1–B3, ... Пришли вывод — перейдём к Green.»     │
  │ - Ждём вывод пользователя.                                │
  └───────────────────────────────────────────────────────────┘
                              ↓
  ┌─ Запрос 3: РЕАЛИЗАЦИЯ ────────────────────────────────────┐
  │ - Теперь пишем тела функций, чтобы тесты стали зелёными.  │
  │ - Рефактор только после зелёного прогона.                 │
  │ - Ответ заканчивается: «Прогони полный `npm test`,         │
  │   пришли вывод — зафиксируем веху и пойдём дальше.»        │
  └───────────────────────────────────────────────────────────┘

  Стабы: два случая.
  (a) Стаб для модуля, чьи тесты пишутся в ЭТОМ Запросе 2 (например,
      processor.ts для Вехи 6) → тело `throw new Error('Not implemented')`.
      Гарантирует чистый Red, если тесты не мокают модуль.
  (b) Стаб для модуля-потребителя, который уже используется живым кодом
      других вех (например, processor.ts/exporter.ts для worker.ts в Вехе 5)
      → тело возвращает безопасный дефолт ([], Promise<void>).
      Иначе Green-фаза соседних тестов невозможна.

При переходе к следующей вехе стаб (b) превращается в стаб (a):
перед Запросом 2 тело заменяется на throw, чтобы получить чистый Red.

Только Запрос 3 может содержать реализацию фичи.
Нарушение последовательности = нарушение §13.0.

Практика подтвердила §13.5: exporter.ts на Вехе 7 прошёл стаб(b) → throw
('Not implemented') → Red (18/18) → Green (18/18) без единой правки тестов
на фазе реализации. Ни одного ложного зелёного.

13.6. tsconfig и ts-jest
────────────────────────
Если tsconfig.json содержит `"exclude": ["**/*.test.ts"]`, ts-jest может
компилировать тесты с дефолтными опциями (не проектовыми) — теоретически
ломает esModuleInterop. На практике у нас это НЕ подтвердилось (тесты
зелёные и с exclude, и без).

Если в будущем ts-jest начнёт капризничать — паттерн:
- tsconfig.json — для IDE/ts-jest, exclude: ["node_modules", "dist"]
  (без **/*.test.ts).
- tsconfig.build.json — extends первый + "exclude": ["node_modules", "dist",
  "**/*.test.ts"].
- package.json: "build": "tsc --project tsconfig.build.json".

---

14. 🗺 Дорожная карта (вехи)

Статусы: ✅ выполнено · 🔄 в работе · ⏳ запланировано

| #   | Веха                            | Артефакты                                                         | Статус |
| --- | ------------------------------- | ----------------------------------------------------------------- | ------ |
| 0   | Подготовка окружения            | VPN, клон репо, .env, доступ к provider                           | ✅      |
| 1   | Инициализация TS-проекта        | package.json, tsconfig, структура src/, скрипты                   | ✅      |
| 2   | Модель БД и миграции            | prisma/schema.prisma, миграция init, docker-compose.dev.yml       | ✅      |
| 3   | HTTP-клиент с обработкой ошибок | src/client.ts, src/client.test.ts, jest.config.js, jest.setup.ts  | ✅      |
| 4   | Слой БД                         | src/db.ts, src/db.test.ts, src/prisma.ts                          | ✅      |
| 5   | Основной цикл (worker)          | src/worker.ts, src/worker.test.ts, стабы processor.ts/exporter.ts | ✅      |
| 6   | Постобработка                   | src/processor.ts, src/processor.test.ts (parent_id, thread_key)   | ✅      |
| 7   | Экспорт                         | src/exporter.ts → ./out/result.jsonl, src/exporter.test.ts        | ✅      |
| T1  | Timeout cleanup (techdebt)      | clearTimeout в finally вокруг Promise.race                        | ✅      |
| T2  | Формат result.jsonl под ТЗ      | snake_case, 5 полей, parent_id null → ""                          | ✅      |
| T3  | Abort in-flight axios           | AbortController + abort-aware sleep, 0 handles                    | ✅      |
| 8   | Production Docker               | Dockerfile, .dockerignore, compose (db/worker/exporter), entrypoint | ✅    |
| 9   | E2E-прогон                      | docker compose up worker → run exporter → selfcheck.js            | ⏳      |
| 10  | Документация                    | README (CANDIDATE + 7 ответов), .env.example обновить             | ⏳      |

14.1. Текущий статус

- Вехи 3–7 завершены. Все модули реализованы, покрыты тестами.
  Полный прогон: 5 сьютов, 104/104 зелёных (client + db + worker + processor + exporter).

- Мини-веха T1 (timeout cleanup) — закрыта: clearTimeout в finally вокруг Promise.race.
  Побочно: client.test.ts получил try/finally на TOTAL_OPERATION_TIMEOUT +
  nock.abortPendingRequests() в afterAll.

- Мини-веха T2 (формат result.jsonl под ТЗ) — закрыта:
  ExportedMessage = 5 полей snake_case в фиксированном порядке:
  external_id, thread_key, parent_id, sent_at, subject.
  parentId null → "" (по ТЗ "Пустая строка, если это первое письмо разговора").
  thread_key / sent_at / subject остаются nullable (null → null).
  fromAddr / toAddrs / internal id из вывода убраны.
  exporter.test.ts переписан под новый контракт (22/22).
  runCli error-logging coverage восстановлена в блоке F7/F8.

- Мини-веха T3 (AbortController) — закрыта:
  Проблема: Promise.race не убивает in-flight axios → 8 висячих handle
  (HTTPINCOMINGMESSAGE / HTTPCLIENTREQUEST / Timeout), из-за чего:
    - Jest "did not exit one second after test run";
    - при --runInBand следующий файл (worker.test.ts) ловил
      NetConnectNotAllowedError → getaddrinfo ENOTFOUND test-provider
      (грабли #18–#21).
  Решение: AbortController в fetchMessages; controller.abort() при срабатывании
  operation timeout; signal прокинут в axios.get и в abort-aware sleep();
  fetchPromise.catch(()=>{}) в finally (rejection уже доставлен через race).
  ERR_CANCELED — не retryable (§6).
  Дополнительно в тестах: nock.abortPendingRequests() первым в beforeEach
  worker.test.ts и в afterEach client.test.ts + worker.test.ts.
  Итог: 0 open handles, exit code 0, без forceExit.

- Веха 8 (production Docker) — закрыта:
  Dockerfile (multi-stage: builder → runtime на node:20-bookworm-slim,
  non-root USER node, tini, без CMD в образе).
  .dockerignore (node_modules, dist, coverage, .git, .env, out, tests, *.test.ts;
  prisma/ НЕ исключён).
  scripts/entrypoint.sh (prisma migrate deploy && exec "$@").
  docker-compose.yml — provider + db + worker + exporter:
    db: postgres:15, healthcheck pg_isready, named volume postgres_data,
        порт наружу не проброшен;
    worker: build: ., image: mail-threads-app:latest,
            command: node dist/worker.js,
            depends_on: db + provider (оба service_healthy), restart: "no",
            env_file: .env + override PROVIDER_URL/DATABASE_URL/таймауты;
    exporter: тот же image, command: node dist/exporter.js,
              depends_on: db (service_healthy), restart: "no",
              bind-mount ./out:/app/out.
  src/docker.test.ts — 25 структурных тестов (A/B/C/D/E) + F1 smoke (skip).
  Побочные правки: prisma перенесён в dependencies (нужен в runtime);
  package.json devDeps: js-yaml + @types/js-yaml.

- Полный прогон: 6 сьютов, 130 тестов (129 passed, 1 skipped, 0 open handles,
  без forceExit).

- Следующий шаг — Веха 9 (E2E):
    docker compose down -v
    docker compose up worker       # должен завершиться exit 0
    docker compose run --rm exporter
    node selfcheck.js out/result.jsonl
    закоммитить out/result.jsonl в репо.

14.2. Что должно быть в Вехе 4 (db.ts)
Публичный контракт (обязателен, из §3.1 исходного ТЗ):

- getState(key): Promise<string | null>
- setState(key, value): Promise<void>
- saveMessages(messages: MessageItem[]): Promise<number>  // возвращает кол-во вставленных
- getAllMessages(): Promise<MessageRow[]>
- updateThreadAndParent(updates: Array<{ externalId, parentId, threadKey }>): Promise<void>

Статус: ✅ реализовано в src/db.ts, покрыто тестами в src/db.test.ts.

Дополнительно экспортируются типы: MessageItem, MessageRow, UpdateThreadInput.

MessageRow (источник истины для processor):
  id: number;
  externalId: string;
  parentId: string | null;
  threadKey: string | null;
  subject: string | null;
  fromAddr: string | null;
  toAddrs: string[];
  sentAt: Date | null;
  references: string[];        // не nullable
  inReplyTo: string | null;

Правила:
- saveMessages — идемпотентна: дубликаты по externalId пропускаем (skipDuplicates).
- updateThreadAndParent — батчевое обновление, без N+1.
- Все функции — на Prisma-клиенте из shared-инстанса (один PrismaClient на процесс).
- Тесты — против реального PostgreSQL (Docker Desktop уже запущен, см. §13.2),
  с TRUNCATE в beforeEach. Мокать Prisma нельзя — иначе теряется смысл слоя.
- Таблицы в БД называются по @@map: "messages" и "app_state". В raw SQL и в
  TRUNCATE использовать именно эти имена, а не имена моделей Prisma
  (Message/AppState) — иначе relation does not exist.
- Никакой бизнес-логики в db.ts: только доступ к данным.

14.3. Что должно быть в Вехе 5 (worker.ts)

Статус: ✅ реализовано в src/worker.ts, покрыто тестами в src/worker.test.ts.

Публичный контракт:
- Stage = 'idle' | 'loading' | 'processing' | 'done'
- WorkerOptions { limit?: number }
- runWorker(options?: WorkerOptions): Promise<Stage>

Правила:
- stage=null/невалидный → трактуем как 'idle'.
- stage='loading' → продолжаем loading loop с сохранённого cursor.
- stage='processing' → пропускаем loading, сразу постобработка.
- stage='done' → терминал, никаких side effects.
- next_cursor проверяем как `!next_cursor` (ловит null и '').
- Порядок на последней странице: saveMessages → setState('stage','processing')
  → setState('cursor',''). Атомарность относительно падений.
- runWorker только resolve/throw. process.exit — только в CLI-обёртке
  под `require.main === module`.
- Маппинг ClientMessageItem → DbMessageItem — приватный хелпер mapClientToDb.
  client.ts и db.ts не трогаем.
- buildUpdates и exportAll вызываются из runProcessing;
  их тела — заглушки до Вех 6/7.

Оркестрация (порядок):
  getAllMessages() → buildUpdates(messages, existingIds)
  → updateThreadAndParent(updates) → exportAll() → setState('stage','done')

14.4. Что должно быть в Вехе 6 (processor.ts)
- parent_id: идём по [references..., in_reply_to] с конца, берём первый externalId,
  который есть в БД. Если нет — null.
- thread_key: DSU по всем ссылкам (references + in_reply_to). Корень → "t-<root>".
- Результат — массив updates для updateThreadAndParent.
- Чистая функция: (messages, existingIds) → updates. Легко тестируется без БД.

Статус: ✅ реализовано в src/processor.ts, покрыто тестами в src/processor.test.ts
(27/27 зелёных).

Уточнения, зафиксированные при реализации:
- Контракт: buildUpdates(messages: MessageRow[], existingIds: Set<string>)
  → UpdateThreadInput[].
- existingIds = new Set(messages.map(m => m.externalId)) — передаёт worker.
- DSU: union(child, target) → корнем становится target. Links обходятся
  в обратном порядке [inReplyTo, references[last], …, references[0]],
  чтобы корнем оказался references[0].
- Мёртвые id из links создают узлы DSU (склейка тредов между запусками).
- Self-reference (m.externalId в links) исключается и из union, и из parentId.
- Пустые строки/null в references/inReplyTo отфильтровываются.
- Логгера нет — модуль чистый.

14.5. Что должно быть в Вехе 7 (exporter.ts)
- Читает getAllMessages().
- Пишет ./out/result.jsonl: одна строка = один JSON-объект.
- Порядок строк = порядок getAllMessages() (id ASC).

Статус: ✅ реализовано в src/exporter.ts, покрыто тестами в src/exporter.test.ts
(T2: 22/22 зелёных, после переработки формата под ТЗ).

Контракт финальный (после T2): exportAll(outputPath?: string) → Promise<void>.
Дополнительно экспортируются: ExportedMessage, runCli.

Формат строки JSONL (5 полей, snake_case, фиксированный порядок):
{"external_id":"...","thread_key":"...","parent_id":"...","sent_at":"...","subject":"..."}

Тип ExportedMessage:
  external_id: string;
  thread_key: string | null;
  parent_id: string;           // "" если нет родителя
  sent_at: string | null;
  subject: string | null;

Уточнения, зафиксированные при реализации:
- parentId null → "" (по ТЗ: "Пустая строка, если это первое письмо разговора").
- sentAt: Date → Date.toISOString(), null → null.
- subject / threadKey: null → null (nullable по ТЗ "в том виде, в котором пришли").
- Порядок полей в JSON фиксирован, задаётся порядком ключей в литерале.
- fromAddr / toAddrs / internal id из вывода убраны.
- mkdir(dirname(outputPath), { recursive: true }) перед writeFile.
- Файл терминирован \n (включая последнюю строку).
- Пустой результат → файл 0 байт.
- Тесты: реальная ФС в os.tmpdir() + уникальная подпапка на тест,
  getAllMessages мокается, fs/promises частично мокается для D1/D2.
  pino мокается стандартным моком §9.3.

14.6. Границы вех (что НЕ делать раньше времени)
- В client.ts не добавлять логику БД или состояния — только HTTP.
- В db.ts не добавлять retry или HTTP — только Prisma.
- В worker.ts не добавлять DSU или парсинг — это processor.ts.
- В processor.ts не ходить в БД напрямую — принимать данные аргументами.

14.7. Контракт Вехи 8 (артефакты)

docker-compose.yml (финальные фиксированные имена):
- provider — образ gitea.teamlead.one/armanteam_public/mail-provider:1,
  healthcheck через fetch /v1/metrics, порт 8080.
- db — postgres:15, user/pass/db = postgres/postgres/mailthreads,
  named volume postgres_data, порт наружу не пробрасывать.
- worker — docker compose up worker, exit 0.
- exporter — docker compose run --rm exporter, пишет ./out/result.jsonl.

Общие правила:
- worker и exporter делят один build: . + image: mail-threads-app:latest.
- env_file: .env — источник CANDIDATE и прочих.
- environment: — override для compose-специфичных значений:
  PROVIDER_URL: http://provider:8080, DATABASE_URL: ...@db:5432/...,
  таймауты и LOG_LEVEL.
- exporter не зависит от provider — только от db.
- out/ — bind mount ./out:/app/out у exporter'а. Worker — без mount
  (пишет в свой контейнер, не наружу).

Dockerfile:
- Multi-stage builder → runtime.
- Финальная стадия — USER node.
- ENTRYPOINT ["tini", "--", "/app/scripts/entrypoint.sh"].
- Без CMD — команды задаются в compose.
- npm ci в builder, npm ci --omit=dev в runtime + prisma generate.
- npx prisma generate в обеих стадиях (или копирование из builder).

scripts/entrypoint.sh:
  #!/bin/sh
  set -e
  npx prisma migrate deploy
  exec "$@"

14.8. Открытый техдолг

- ✅ Закрыт: T1 (clearTimeout), T2 (формат), T3 (AbortController + handles).
- ⏳ Веха 9: E2E-прогон (docker compose up worker → run exporter → selfcheck.js)
  — не выполнен.
- ⏳ Веха 10: README (первая строка CANDIDATE; 7 вопросов ТЗ); обновление
  .env.example (DATABASE_URL, POSTGRES_*, таймауты).
- ⚠️ worker.runProcessing вызывает exportAll(). Решено оставить (ТЗ не запрещает,
  тесты worker 16/16 зелёные). В README (Веха 10) отразить в ответе на вопрос
  «Что решили не усложнять».
- ⚠️ Параллельный запуск worker в двух процессах не защищён распределённой
  блокировкой по stage. Отметить в README (Веха 10).
- ⚠️ tsconfig.json без exclude: ["**/*.test.ts"] — сборка tsc затянет *.test.ts
  в dist/. Сейчас спасает .dockerignore. Если понадобится чистый dist/ —
  завести tsconfig.build.json.
- ⚠️ Ветка require.main === module в exporter.ts не покрыта unit-тестами
  (/* istanbul ignore next */). Норм, E2E покроет.
- ⚠️ out/ в .gitignore? Проверить, что out/result.jsonl не игнорируется —
  ТЗ требует файл в репо.

14.9. Тесты, финальный прогон

  Test Suites: 6 passed, 6 total
  Tests:       1 skipped, 129 passed, 130 total
  Time:        ~8 s
  Exit:        0 (без forceExit, без open handles)

- 1 skipped: F1: docker compose config — describe.skip, smoke, требует Docker CLI.
- Полезные флаги локально: npm test -- --runInBand (db.test.ts и worker.test.ts
  делят БД).
- --detectOpenHandles — 0 handles (проверено после T3).