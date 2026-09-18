CANDIDATE=asasiincrit@bk.ru

# Mail Threads

Забирает ленту писем из внешнего HTTP-API, складывает в PostgreSQL, собирает разговоры по ссылкам (`in_reply_to` + `references`) и выгружает JSONL.

## Запуск

```bash
cp .env.example .env       # указать CANDIDATE
docker compose down -v     # чистое состояние
docker compose up worker   # забрать все письма, exit 0
docker compose run --rm exporter    # → ./out/result.jsonl
node selfcheck.js out/result.jsonl
```

Worker резюмируемый: если остановить его посреди работы и запустить снова — продолжит с сохранённого курсора (`app_state`), без повторных записей.

## 1. Хранение и почему

Две таблицы:
- `messages` — письма. Уникальный `externalId` даёт идемпотентность (`skipDuplicates`). `references` и `toAddrs` — native-массивы Postgres: читаются редко, пишутся всегда целиком, join-таблицы были бы лишними.
- `app_state` — key/value для `stage` и `cursor`. Возобновление с любой точки.

Postgres выбран из-за массивов и `ON CONFLICT DO NOTHING` из коробки. Prisma — ORM + `$executeRaw` для батчевого `UPDATE ... FROM (VALUES ...)` (без N+1).

## 2. Второй почтовый сервис

**Не изменится:** `db.ts`, `processor.ts`, `exporter.ts`, схема БД, retry-логика.

**Изменится:** `worker.ts` — вместо polling-цикла появится push-загрузчик (сервис присылает сам). Если у второго источника нет message-id, понадобится суррогатный ключ — hash содержимого или его собственный thread-id, плюс миграция: составной `externalId` или новая колонка `sourceId`.

## 3. Два сервиса над одной базой

**Сломается** `app_state.cursor`: оба прочтут один курсор, оба запросят одну страницу, оба запишут свой `next_cursor` — лишний трафик и «откат» курсора.

**Устоит:** `saveMessages` (`skipDuplicates`) и `updateThreadAndParent` (`UPDATE` по key) идемпотентны — данные не портятся.

Правильный фикс — `SELECT ... FOR UPDATE` на строку `stage`. Не делаем: ТЗ предполагает один worker.

## 4. Шаг, который нельзя выполнить дважды подряд

**Такого шага нет.** Идемпотентны:
- `saveMessages` — `skipDuplicates`;
- `updateThreadAndParent` — `UPDATE`, не `INSERT`;
- `exportAll` — `writeFile`, перезапись;
- `setState` — `upsert`;
- `prisma migrate deploy` — no-op при повторе.

## 5. Что решили не усложнять

- **Repository-слой над Prisma.** Один источник, одна БД — интерфейс + фабрика были бы оверинжинирингом. Понадобится при втором источнике писем.
- **Класс `DisjointSet` в processor.** Обошлись двумя `Map` в замыкании. Имело бы смысл при нескольких алгоритмах на графе.

## 6. Десятикратный объём (1.3M писем)

Первым упрётся **`getAllMessages()`** — все строки в память одной `findMany` → OOM. Следом — **`buildUpdates`** (DSU на 1.3M узлов в памяти). Затем провайдер: 6500 страниц с 429-паузами = часы фетча.

Что менять: стриминг через `$queryRaw` + курсор, потоковый DSU, чаще чекпоинты прогресса. `updateThreadAndParent` уже чанкуется (5000 обновлений за вызов) — масштабируется.