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
├── jest.config.js          ← setupFiles: ['<rootDir>/jest.setup.ts']
├── jest.setup.ts           ← env-переменные для тестов (в git)
└── src/
    ├── client.ts           ← HTTP-клиент (Веха 3) ✅
    ├── client.test.ts      ← ✅
    ├── prisma.ts           ← shared PrismaClient (Веха 4) ✅
    ├── db.ts               ← слой БД (Веха 4) ✅
    ├── db.test.ts          ← ✅
    ├── worker.ts           ← основной цикл (Веха 5) ✅
    ├── worker.test.ts      ← ✅
    ├── processor.ts        ← постобработка (Веха 6) ✅
    ├── processor.test.ts   ← ✅ 27 тестов
    ├── exporter.ts         ← экспорт JSONL (Веха 7) ✅
    └── exporter.test.ts    ← ✅ 18 тестов

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
| 12 | Два MessageItem — в client.ts и db.ts | Разные shape'ы под одним именем: ClientMessageItem (message_id/from/to/sent_at/in_reply_to) vs DbMessageItem (externalId/fromAddr/toAddrs/sentAt/inReplyTo). Импортировать через алиасы; маппинг — только в worker.ts → mapClientToDb |
| 13 | MessageRow.references: string[] — НЕ nullable, inReplyTo: string \| null | в processor.ts фильтр пустых/null всё равно нужен для inReplyTo; не писать `m.references ?? []` |
| 14 | DSU: корень = target в union(child, target) | обходить links в обратном порядке `[inReplyTo, references[last], …, references[0]]` — тогда корнем становится `references[0]`; мёртвые id из links тоже становятся узлами DSU |
| 15 | processor.ts — чистая функция без БД, HTTP, логгера | `buildUpdates(messages, existingIds) → UpdateThreadInput[]`; self-reference (`m.externalId`) исключается и из parentId, и из union |

12. 🎓 TL;DR
Клиент — это один модуль с одной функцией.
Конфиг — читается один раз, меняется только через reset modules.
Retry — только для транзиентных ошибок, всё остальное — сразу наружу.
Тесты — nock + реальные таймеры + маленькие задержки через setup-файл.
Стиль — строгий TypeScript, явные типы, точные сообщения об ошибках.
Processor — DSU + скан parentId с конца; никакой БД и логов.

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
| 8   | Production Docker               | Dockerfile, docker-compose.yml (db + worker + exporter)           | ⏳      |
| 9   | E2E-прогон                      | Полный цикл: load → process → export                              | ⏳      |
| 10  | Документация                    | README, инструкция запуска, переменные окружения                  | ⏳      |

14.1. Текущий статус

- Веха 3 завершена: client.ts реализован, тесты зелёные.
- Веха 4 завершена: src/prisma.ts, src/db.ts, src/db.test.ts реализованы,
  все тесты зелёные.
- Веха 5 завершена: src/worker.ts реализован (16/16 тестов зелёных).
  Стабы src/processor.ts (buildUpdates) и src/exporter.ts (exportAll)
  созданы в финальных контрактах §14.4/§14.5 — тела заглушки, наполняются
  в Вехах 6/7 без переписывания тестов worker.ts.
  Все 50 тестов (client + db + worker) зелёные.
  Предсказание подтвердилось на Вехе 6: наполнение processor.ts не потребовало
  ни одной правки в worker.test.ts (16/16 остались зелёными).
- Веха 6 завершена: src/processor.ts реализован (27/27 тестов зелёных).
  Полный прогон — 4 сьюта, 77/77 зелёных (client + db + worker + processor).
  Реализация: DSU для thread_key (union(child, target) → target становится
  корнем, links обходятся в обратном порядке), parent_id — скан с конца
  [references..., inReplyTo], self-reference исключён. Чистая функция без БД,
  HTTP и логгера. client.ts / db.ts / worker.ts не тронуты.
- Все ограничения и грабли Вехи 3 зафиксированы в §4–§11 — источник истины
  для клиента, менять их без причины нельзя.

- Веха 7 завершена: src/exporter.ts реализован (18/18 тестов зелёных в
  src/exporter.test.ts), стаб заменён на рабочее тело.
  Полный прогон — 5 сьютов, 95/95 зелёных
  (client + db + worker + processor + exporter).
  Контракт: exportAll(outputPath?: string) → Promise<void>, дефолт
  './out/result.jsonl'; exportAll — чистая библиотечная функция, process.exit
  только в runCli под require.main === module.
  Порядок строк = порядок getAllMessages() (id ASC). Пустой результат →
  файл 0 байт. sentAt: Date → toISOString(), null → null.
  mkdir(dirname(outputPath), { recursive: true }) перед записью.
  Экспортируется тип ExportedMessage (7 полей). Логгер —
  rootLogger.child({ module: 'exporter' }), info на старте/финише, error
  при падении.
  Побочная правка: в src/client.ts rootLogger получил export
  (const → export const), чтобы exporter мог его импортировать.
  Поведение client.ts не изменилось, client.test.ts зелёный.
  Coverage по exporter.ts: 96.42% stmts / 85.71% branch / 100% funcs /
  95.83% lines. Единственная непокрытая ветка — CLI-entrypoint
  (require.main === module), не покрывается unit-тестами по природе;
  кандидат на /* istanbul ignore next */ или E2E-покрытие в Вехе 9.
  Решение по этому пункту отложено.

- Следующий шаг — Веха 8 (production Docker: Dockerfile,
  docker-compose.yml с db + worker + exporter). Перед ней — решить судьбу
  техдолга из §14.1 (см. ниже): чинить ли timeoutPromise/clearTimeout
  в client.ts отдельной мини-вехой TDD (План → Red → Green), или
  отложить до Вехи 9/E2E.


Открытый техдолг (не блокирует вехи, но помнить):
- ✅ client.ts: timeoutPromise очищается через clearTimeout в finally
  вокруг Promise.race (мини-веха T1, отдельный коммит).
  Симптом "did not exit one second after test run" закрыт.
  Побочно: §6 operation timeout в client.test.ts восстановлен
  через try/finally (process.env.TOTAL_OPERATION_TIMEOUT), а
  afterAll файла получил nock.abortPendingRequests() +
  nock.cleanAll() перед enableNetConnect() — иначе --runInBand
  ловил NetConnectNotAllowedError от висячего nock-ответа T1.4.

- Следующий шаг — Веха 8 (production Docker: Dockerfile,
  docker-compose.yml с db + worker + exporter).
- Параллельный запуск runWorker в двух процессах не защищён
  (нет распределённой блокировки по stage). Отметить в README (Веха 10).

- Локально рекомендуется `npm test -- --runInBand`, пока db.test.ts
  и worker.test.ts делят одну БД — иначе гонка на TRUNCATE.

- exporter.ts: ветка require.main === module не покрыта unit-тестами
  (CLI-entrypoint). Не блокирует, но перед Вехой 9 (E2E) стоит либо
  пометить /* istanbul ignore next */, либо покрыть E2E. Аналогичная
  ситуация, вероятно, в worker.ts — проверить при касании.

- Правка client.ts (export const rootLogger) — минимальна и не нарушает
  «заморозку»: тело client.ts, поведение fetchMessages, axios-конфиг,
  retry-логика — не тронуты. Если перед Вехой 8 будет чиниться
  timeoutPromise (§11.7), правка rootLogger уже в дереве и должна быть
  учтена при полном перепрогоне client.test.ts.



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
- Пишет ./out/result.jsonl: одна строка = один JSON-объект с полями
  externalId, parentId, threadKey, subject, fromAddr, toAddrs, sentAt.
- Порядок строк детерминирован (по externalId или по id).
- Ошибки записи — фатальны (exit code ≠ 0).
Статус: ✅ реализовано в src/exporter.ts, покрыто тестами в src/exporter.test.ts
(18/18 зелёных).
Контракт финальный: exportAll(outputPath?: string) → Promise<void>.
Дополнительно экспортируются: ExportedMessage (7 полей), runCli.

Уточнения, зафиксированные при реализации:
- Порядок строк — как отдал getAllMessages() (id ASC). Сортировка —
  ответственность db-слоя, не exporter.
- Пустой результат → файл создаётся, 0 байт.
- sentAt: Date → Date.toISOString(), null → null. Тип ExportedMessage.sentAt
  = string | null.
- mkdir(dirname(outputPath), { recursive: true }) перед writeFile.
- Файл терминирован \n (включая последнюю строку).
- Поля JSON — фиксированный порядок: externalId, parentId, threadKey,
  subject, fromAddr, toAddrs, sentAt.
- id (internal PK) в JSONL не попадает.
- Тесты: реальная ФС в os.tmpdir() + уникальная подпапка на тест,
  getAllMessages мокается, fs/promises частично мокается для D1/D2.
  pino мокается стандартным моком §9.3.

14.6. Границы вех (что НЕ делать раньше времени)
- В client.ts не добавлять логику БД или состояния — только HTTP.
- В db.ts не добавлять retry или HTTP — только Prisma.
- В worker.ts не добавлять DSU или парсинг — это processor.ts.
- В processor.ts не ходить в БД напрямую — принимать данные аргументами.