# Backend Agent — пошаговый план

> **Роль:** Python — API (Flask), worker (event/price/keeper/alerts), shared-логика,
> миграции БД, seed.
> **Не пишет:** Solidity, JS, Docker Compose, Caddyfile.
> **Spec-источники:** [../api-spec.md](../api-spec.md), [../db-schema.sql](../db-schema.sql),
> [../port-from-portable.md](../port-from-portable.md), [../conventions.md](../conventions.md)
> §5, §9, §10, §12, [../architecture.md](../architecture.md) §6, §7.
> **Координация:** [README.md](README.md). Любая неоднозначность → эскалировать.

## Границы владения

| Можно править | Только читать |
|---|---|
| `backend/` (полностью, включая Dockerfile) | spec-документы |
| `backend/migrations/*` | `abis/*.json` (от Contracts) |
| `db-schema.sql` (через PR-предложение координатору) | `frontend/`, `contracts/`, `infra/` |

Не трогать: Solidity, JS, Caddyfile, GitHub Actions (кроме случаев согласованных
с Infra-агентом).

---

## Фаза 0 — Фундамент + монетизация

### B0.1 — Python скелет
**Что:** Python-проект, конфиги линтеров, точки входа.

**Действия:**
- `backend/pyproject.toml` — ruff/black/mypy/pytest конфиги по
  [../conventions.md](../conventions.md) §2.1.
- `backend/requirements.txt`:
  ```
  flask==3.0.*
  gunicorn==22.*
  gevent==24.*
  psycogreen==1.0.*
  psycopg[binary]==3.2.*
  web3==7.*
  eth-account==0.13.*
  pyjwt==2.*
  flask-limiter==3.*
  structlog==24.*
  python-dotenv==1.*
  alembic==1.13.*
  siwe==4.*           # для парсинга/проверки EIP-4361 сообщений
  ```
- `backend/requirements-dev.txt`: pytest, pytest-asyncio, testcontainers,
  ruff, black, mypy.
- `backend/run_api.py`:
  ```python
  from app import create_app
  app = create_app()
  ```
- `backend/run_worker.py`:
  ```python
  from worker.main import run
  if __name__ == "__main__":
      run()
  ```
- Создать пустые пакеты: `backend/shared/__init__.py`, `backend/app/__init__.py`,
  `backend/worker/__init__.py`, `backend/tests/__init__.py`.

**DoD:**
- `cd backend && ruff check .` чисто.
- `python -c "import flask, web3, jwt, structlog"` без ошибок.

**Зависит от:** I0.1.

---

### B0.2 — `shared/config.py`, `shared/eth.py`, `shared/db.py`, `shared/log.py`
**Что:** базовые модули.

**Действия:**
- `shared/config.py`:
  - `Config` (dataclass-like): читает env vars из [../conventions.md](../conventions.md) §9.
  - Hardcoded constants: `HOOK_DEPLOY_BLOCK = 46_167_000`,
    `MULTICALL3 = "0xca11bde05977b3631167028862bE2a173976CA11"`,
    `WEI = 10**18`, `FEE_BPS = 500`.
  - Address normalization: всё хранится lowercase.
- `shared/eth.py`:
  - `get_w3()` → Web3 с primary RPC + fallback (см. §12 architecture).
  - `multicall3_aggregate(calls)` — батч-вызов.
  - `lc(addr)`, `chk(addr)` — нормализация.
  - Загрузка ABI из `../abis/*.json` (один helper).
- `shared/db.py`:
  - `get_conn()` — psycopg connection pool.
  - `psycogreen.gevent.patch_psycopg()` при импорте в gevent-режиме.
  - Helper'ы `fetch_one`, `fetch_all`, `execute`.
- `shared/log.py` — structlog настройка по [../conventions.md](../conventions.md) §8.

**DoD:**
- Unit-тесты для `lc`/`chk` (граничные случаи: zero address, валидный, кейс).
- Подключение к Postgres работает на локалке.

**Зависит от:** B0.1, I0.2 (Postgres).

---

### B0.3 — Alembic init + миграция 0001_initial
**Что:** воспроизвести [../db-schema.sql](../db-schema.sql) через Alembic.

**Действия:**
- `cd backend && alembic init migrations`.
- `alembic.ini` — `sqlalchemy.url = ${DATABASE_URL}`.
- `migrations/env.py` — читать env vars, configure Alembic. Нормализация
  `postgresql://` → `postgresql+psycopg://` (проект использует psycopg v3).
- `migrations/versions/0001_initial.py` — портирует SQL из `db-schema.sql`:
  - CREATE TYPE для всех ENUM'ов.
  - CREATE TABLE для всех таблиц (включая `referral_codes`).
  - Все индексы (включая частичные).
  - Все CONSTRAINT'ы (включая `referral_codes.code` regex + leading/trailing).
- Сравнить с `db-schema.sql` — расхождений быть не должно.

**DoD:**
- `alembic upgrade head` на пустой БД проходит без ошибок.
- `alembic downgrade base` корректно откатывается.
- Все таблицы из `db-schema.sql` существуют (`\dt` в psql), включая
  `referral_codes`.
- ENUM значения совпадают (`\dT+ token_kind` etc.).
- Идемпотентность: `upgrade → downgrade → upgrade` снова работает чисто.

**Зависит от:** B0.2.

---

### B0.4 — Seed `tokens.json`
**Что:** скрипт первоначальной загрузки 48 стран + 144 игроков.

**Действия:**
- `backend/data/tokens.json` — копия из портативки.
- `backend/scripts/seed_tokens.py`:
  - Парсит JSON.
  - Сначала вставляет страны (kind='country'), потом игроки (kind='player')
    с FK на country_address.
  - Используется в DEFERRABLE-режиме (одна транзакция).
  - Идемпотентен: `INSERT ... ON CONFLICT (address) DO NOTHING`.
- Добавить вызов в init-скрипт worker'а (только при пустой таблице tokens).

**DoD:**
- После `python backend/scripts/seed_tokens.py`:
  - `SELECT COUNT(*) FROM tokens WHERE kind='country'` = 48.
  - `SELECT COUNT(*) FROM tokens WHERE kind='player'` = 144.
  - Все player'ы имеют валидный country_address.

**Зависит от:** B0.3.

---

### B0.5 — `shared/events.py`, `shared/price.py`, `shared/chart.py`, `shared/pnl.py`
**Что:** портирование чистой логики из портативки.

**Действия:**
- Согласно [../port-from-portable.md](../port-from-portable.md) §1:
  - `shared/events.py:decode_log`, `scan_logs`.
  - `shared/price.py:market_price` (бывший `_market_price`), `current_price_of`.
  - `shared/chart.py:build_candles`, `build_points` — принимают список Event'ов
    как аргумент, не читают глобал.
  - `shared/pnl.py:wallet_position` — pure-функция `(events, wallet) -> WalletPosition`.
- Unit-тесты для каждой функции (`backend/tests/unit/`):
  - `test_price.py` — фикстуры с известными ev → точные `market_price`.
  - `test_chart.py` — построение candles из массива events.
  - `test_pnl.py` — несколько сценариев (buy/sell/buy → realized + unrealized
    корректны).
  - `test_events.py` — `decode_log` для buy и sell, разный порядок полей в data.

**DoD:**
- Unit-тесты зелёные, ≥ 90% покрытие модулей.
- Никаких глобальных мутаций, никаких импортов из `app/` или `worker/`.

**Зависит от:** B0.2.

---

### B0.6 — Worker: event_loop + price_loop + access_event_loop (без NOTIFY ещё)
**Что:** циклы worker'а, пишут в БД, без SSE-пуша пока.

**Действия:**
- `worker/main.py`:
  ```python
  def run():
      backfill.run_if_needed()
      access_bootstrap.run_if_needed()  # инициализация app_state.access_config
      while True:
          price_loop.tick()
          event_loop.tick()
          access_event_loop.tick()  # PriceChanged + ReferralSplitUpdated
          nonces.cleanup()
          time.sleep(5)
  ```
- `worker/price_loop.py:tick`:
  - Multicall: prices, supplies, country_prices, country_supplies для всех
    токенов.
  - UPSERT в `market_state` для каждого изменившегося токена.
  - Считает `change_pct_*`, `holders_count`, `trades_count` по формулам из
    [../port-from-portable.md](../port-from-portable.md) §5.1.
- `worker/event_loop.py:tick`:
  - Читает `app_state.last_scanned_block`.
  - `scan_logs(w3, [player_hook, country_hook], last+1, head - REORG_LAG_BLOCKS)`.
  - INSERT events с `ON CONFLICT (tx_hash, log_index) DO NOTHING`.
  - Обновляет `last_scanned_block`.
- `worker/access_event_loop.py:tick` — **индексатор PitchTerminalAccess**:
  - Читает `app_state.access_last_scanned_block` (отдельный курсор; первый старт
    = `ACCESS_DEPLOY_BLOCK` из env).
  - `scan_logs(w3, [access_contract], last+1, head - REORG_LAG_BLOCKS)`.
  - Декодирует события `PriceChanged(uint256)` и
    `ReferralSplitUpdated(uint16, uint16)`. Игнорирует прочие
    (`AccessPurchased`, `Granted/Revoked`) — они не нужны для `/config`-снимка.
  - На каждое событие: читает текущие `price()`, `buyerDiscountBps()`,
    `referralBps()` контракта через **один Multicall** и UPSERT'ит снимок в
    `app_state.access_config` (см. db-schema.sql) — формат
    `{accessPriceWei, buyerDiscountBps, referralBps, blockNumber, txHash}`.
  - Идемпотентно: повторное событие с тем же `txHash` → no-op.
- `worker/access_bootstrap.py:run_if_needed` — если `app_state.access_config`
  отсутствует, читает все три значения с контракта (один Multicall) и пишет
  снимок с `blockNumber = head`, `txHash = null`. Запускается один раз на старте.
- `worker/nonces.py:cleanup` — `DELETE FROM auth_nonces WHERE created_at < now() - interval '10 minutes'`.
- Errors → log + продолжить (не падать).

**DoD:**
- При первом запуске worker заполняет `market_state` за < 30 с.
- На пустой `events`-таблице запускается одноразовый бэкфилл (B0.7).
- `app_state.access_config` существует после `access_bootstrap`, содержит
  валидные `price/buyerDiscountBps/referralBps`.
- `psql ... -c "SELECT * FROM market_state LIMIT 5"` показывает живые цены.
- Симуляция `setPrice(2e18)` через owner-ключ на тестнете → в течение 5 с
  `app_state.access_config.accessPriceWei` обновляется до `2000000000000000000`.

**Зависит от:** B0.4, B0.5.

---

### B0.7 — Backfill historical events
**Что:** одноразовый исторический скан с `HOOK_DEPLOY_BLOCK`.

**Действия:**
- `worker/backfill.py`:
  - Проверяет `app_state.backfill_status.complete`. Если true → пропустить.
  - Сканирует чанками `CHUNK_BLOCKS_DEFAULT` (default 5000).
  - При rate-limit от RPC → exponential backoff.
  - Пишет события батчами в `events` (idempotent через UNIQUE constraint).
  - Обновляет `last_scanned_block` и `backfill_status.progressBlock`.
  - По завершении — `backfill_status.complete = true`.
- Бэкфилл синхронный (блокирует worker.main → ничего не сканится новое до
  завершения). После — обычные циклы.

**DoD:**
- Бэкфилл с HOOK_DEPLOY_BLOCK до head на Alchemy RPC. **Реалистичная оценка
  длительности первого прогона — 2–6 часов**, при медленном RPC возможно до
  суток. Запускается в фоне; **публичный запуск API только после `backfill_status.complete = true`**
  (см. DoD фазы 0 в [../conventions.md](../conventions.md) §12).
- `backfill_status.complete = true` после завершения.
- `events.count > 0` для каждого токена с активностью.
- Прогресс публикуется в operator-Telegram каждые 30 минут.

**Зависит от:** B0.6.

---

### B0.8 — API: FREE endpoints + health
**Что:** Flask-приложение, FREE-эндпоинты согласно [../api-spec.md](../api-spec.md) §3, §4, §9.

**Действия:**
- `app/__init__.py:create_app()`:
  - Регистрирует blueprint'ы.
  - Подключает `flask-limiter`.
  - Подключает структурные логи.
  - Регистрирует error-handler → RFC 7807 (`app/errors.py`).
- `app/routes/health.py` — `GET /api/v1/health` (§9).
- `app/routes/config.py` — `GET /api/v1/config` (§3.2):
  - Базово отдаёт значения из `app_state.access_config` (источник истины,
    обновляется worker'ом по событиям `PriceChanged` / `ReferralSplitUpdated`,
    см. B0.6). При отсутствии записи — fallback на честный RPC-вызов с записью
    в `app_state`.
  - Поддерживает query-param `?fresh=1` (rate-limit 10/мин/IP, см. §11
    api-spec) — обход кэша, читает свежее значение из `app_state.access_config`.
  - Поля: `accessPriceWei`, `buyerDiscountBps`, `referralBps` (+ остальные
    статические из §3.2).
- `app/routes/tokens.py`:
  - `GET /api/v1/tokens` (§4.1).
  - `GET /api/v1/tokens/{token}/chart?tf=` (§4.2).
  - `GET /api/v1/tokens/{token}/trades?limit=&cursor=` (§4.3) — `myWallet` пока
    `{ configured: false }` (premium ещё не подключён).
- `app/errors.py` — `problem+json` handler для всех ошибок.
- `app/limits.py` — `flask-limiter` setup (см. §11 api-spec).
- `shared/serial.py:to_camel/from_camel` — конверсия dict-ключей.

**DoD:**
- `curl /api/v1/health` → 200 со схемой §9.
- `curl /api/v1/config` → 200 со схемой §3.2 (включая `buyerDiscountBps` +
  `referralBps`).
- `curl /api/v1/config?fresh=1` → 200; вызов читает из `app_state.access_config`
  без RPC.
- `curl /api/v1/tokens` → 200, лист из 192 токенов.
- `curl /api/v1/tokens/0xINVALID/chart` → 404 `tokens.unknown` в формате
  problem+json.
- Rate-limit включён — при превышении 429 с `Retry-After`.

**Зависит от:** B0.6, B0.7 (backfill).

**Integration checkpoint:** IC-0.1 (с Frontend F0.2).

---

### B0.9 — SSE `/api/v1/stream` (FREE channels prices+events+config) + NOTIFY pub/sub
**Что:** SSE-поток с pub/sub через Postgres LISTEN/NOTIFY.

**Действия:**
- `shared/notify.py`:
  - `notify(channel, payload)` — `pg_notify(...)`.
  - `Listener` класс — открывает LISTEN-соединение, async-yield'ит сообщения.
- В `worker/price_loop.py`, `event_loop.py`, `access_event_loop.py`:
  - После UPSERT в market_state — `notify("pt_prices", json.dumps([addresses]))`
    (см. db-schema.sql NOTIFY section).
  - После INSERT events — `notify("pt_events", json.dumps([ids]))`.
  - После UPSERT `app_state.access_config` — `notify("pt_config",
    json.dumps(snapshot))` с тем же payload, что хранится в `app_state` плюс
    `updatedAt` (unix sec) — это **полный snapshot**, читать `app_state` API
    после NOTIFY не нужно.
- `app/sse.py:stream()`:
  - `GET /api/v1/stream`:
    - Подписывается на `pt_prices`, `pt_events`, `pt_config` (orders позже —
      premium, в фазе 2).
    - На каждое NOTIFY:
      - `pt_prices` / `pt_events` — читает соответствующие записи из БД,
        формирует SSE-event.
      - `pt_config` — payload уже содержит всё нужное; ретранслирует как
        `event: config` без дополнительного чтения БД.
    - Heartbeat каждые 25 сек.
  - Авторизация: куки приходят автоматически с EventSource; если не premium —
    канал orders не отправляется (фильтр на сервере). Канал `config`
    auth-нейтрален и отправляется всем подключённым.
- Инвалидация `/config`-кэша на стороне API: каждый API-процесс при
  получении NOTIFY `pt_config` сбрасывает свой in-memory кэш `/config` (см.
  B0.8) — следующий не-`fresh=1` запрос увидит свежие значения сразу.

**DoD:**
- Открыть `curl -N http://localhost:5000/api/v1/stream` → видеть keepalive
  каждые 25с.
- Совершить on-chain сделку (тестовую) → в течение 5 с прилетает
  `event: events`.
- При изменении цен — `event: prices` с массивом адресов.
- Симуляция `setPrice(2e18)` или `setReferralSplit(1000, 4000)` → в течение
  5–10 с прилетает `event: config` со свежим snapshot'ом. После этого
  `curl /api/v1/config` (без `fresh=1`) сразу возвращает новые значения
  (кэш инвалидирован).

**Зависит от:** B0.8.

**Integration checkpoint:** IC-0.2 (с Frontend F0.3).

---

### B0.10 — SIWE + JWT
**Что:** auth-эндпоинты согласно [../api-spec.md](../api-spec.md) §2.

**Действия:**
- `shared/siwe.py`:
  - `make_nonce()` → 16 alphanumeric chars, вставка в `auth_nonces`.
  - `verify(message, signature)` — парсит EIP-4361, проверяет поля
    (domain/uri/chainId), проверяет nonce (есть, не протух, не использован),
    проверяет подпись через `siwe` библиотеку или `eth-account` +
    SignatureChecker (для EIP-1271 — через RPC).
  - При успехе → `auth_nonces.DELETE WHERE nonce = $1`.
- `shared/jwt.py`:
  - `encode(address)` → HS256-JWT с claim'ами по §2.2.
  - `decode(token)` → address или raise.
- `app/routes/auth.py`:
  - `GET /api/v1/auth/nonce` (§2.1).
  - `POST /api/v1/auth/verify` (§2.2) → ставит cookie `pt_session`.
  - `POST /api/v1/auth/logout` (§2.3) → сбрасывает cookie.
- `app/deps.py:require_auth` — декоратор, читает cookie, кладёт `g.address` или
  401 `auth.unauthenticated`.

**DoD:**
- `curl /api/v1/auth/nonce` → 200, nonce 16+ символов.
- E2E: nonce → подписать тестовым ключом → POST verify → cookie ставится.
- Cookie httpOnly + Secure (для prod) + SameSite=Lax.
- `pt_session` декодируется обратно в правильный address.
- Smart-contract wallet (тест через mock EIP-1271 responder) — проходит.

**Зависит от:** B0.8.

**Integration checkpoint:** IC-0.3 (с Frontend F0.11).

---

### B0.11 — `/api/v1/access` + кэш `hasAccess`
**Что:** статус premium с кэшем согласно [../api-spec.md](../api-spec.md) §5.

**Действия:**
- `shared/access.py`:
  - `is_premium(address) → bool`:
    - In-memory кэш per-process (dict).
    - Асимметричный TTL: true=1 час, false=30 сек.
    - При промахе — `access_contract.hasAccess(addr)` через RPC.
    - Fail-open: при ошибке RPC, если был кэш true — оставить true.
  - Метаданные: source (`paid`|`whitelisted`|`none`).
- `app/routes/access.py:get_access`:
  - `GET /api/v1/access[?fresh=1]` (§5.1).
  - `fresh=1` — обход кэша, rate-limit 5/мин/address.
- `accessPriceWei`, `buyerDiscountBps`, `referralBps` в `/config` уже читаются
  из `app_state.access_config` (см. B0.8), здесь добавлять не нужно.

**DoD:**
- `curl --cookie ...` для свежего адреса → `hasAccess: false, source: "none"`.
- После grantAccess от owner → через ≤30 сек `false` → `true`.
- `fresh=1` обходит кэш, виден сразу.
- Rate-limit на fresh работает.

**Зависит от:** B0.10, C0.5 (контракт задеплоен — нужен `ACCESS_CONTRACT` env).

---

### B0.11b — Реферальные коды (handle-резолв)
**Что:** 4 эндпоинта для opt-in читаемых handle согласно
[../api-spec.md](../api-spec.md) §5.2 + таблица `referral_codes`
(см. db-schema.sql, уже создана в B0.3 миграцией 0001).

**Действия:**
- `shared/referral.py`:
  - `RESERVED_CODES: frozenset[str]` — литерал в коде:
    `{"api", "admin", "app", "www", "static", "ref", "auth", "me", "mine",
    "null", "undefined", "config", "stream", "health", ...}` + базовый
    profanity-список на en/ru. Регулярно лучше не пересматривать (изменения
    через PR + redeploy).
  - `validate_code(code) -> None | ProblemDetail`:
    - Проверка regex `^[a-z0-9_-]{4,32}$`, leading/trailing не `-`/`_`,
      не в `RESERVED_CODES`.
    - Возвращает структуру ошибки или None.
  - `resolve(code) -> str | None` — `SELECT owner_address FROM referral_codes
    WHERE code = $1` (case-sensitive после нормализации). Lowercase'ит вход
    перед запросом.
- `app/routes/referral.py`:
  - `GET /api/v1/ref/{code}` (FREE, §5.2.1): валидация формата → 404
    `referral.not_found` если не сошёлся (без 422 — упрощает фронт);
    `SELECT` → 200 `{code, wallet}` или 404. Cache-Control `public, max-age=60`
    для 200, `no-store` для 404. Rate-limit 120/мин/IP.
  - `GET /api/v1/ref/me` (AUTH, §5.2.2): `SELECT * FROM referral_codes WHERE
    owner_address = g.address` → 200 со `{code, wallet, claimedAt}` или 404
    `referral.not_found`. Rate-limit 30/мин/address.
  - `PUT /api/v1/ref/me` (AUTH, §5.2.3): body `{code: str | null}`.
    - `code: null` или пустое тело → как DELETE (см. ниже).
    - Иначе: `validate_code(code)`:
      - regex/leading/trailing fail → 422 `referral.invalid_format`.
      - reserved → 422 `referral.reserved`.
    - Если ок — атомарно в одной транзакции:
      `DELETE FROM referral_codes WHERE owner_address = g.address;
      INSERT INTO referral_codes (code, owner_address) VALUES ($1, $2);`
    - Конфликт `unique violation` на `code` PK (другой кошелёк уже занял) →
      409 `referral.taken`. Race-free благодаря postgres-уровневому индексу.
    - Успех → 200 `{code, wallet, claimedAt}`. Rate-limit 5/час/address.
  - `DELETE /api/v1/ref/me` (AUTH, §5.2.4): идемпотентно. `DELETE FROM
    referral_codes WHERE owner_address = g.address`. Всегда 204 (даже если
    ничего не удалилось). Rate-limit 5/час/address.
- Тесты (`tests/api/test_referral.py`):
  - Resolve 0x-формат (frontend не ходит в API — но если кто-то всё же пошёл,
    проверь behaviour: вероятно 404, потому что 0x-адрес не подходит под
    `[a-z0-9_-]{4,32}`).
  - Resolve unknown code → 404.
  - Resolve claimed code → 200.
  - Claim happy path + claim под уже занятый code (другим кошельком) → 409.
  - Claim код, который занят САМИМ собой → no-op атомарно (DELETE+INSERT) → 200.
  - Reserved code → 422.
  - Invalid format (короткий, leading `-`, кириллица, > 32) → 422.
  - DELETE без claim → 204. DELETE c claim → 204 + GET /me → 404.
  - Rate-limits через `flask-limiter`.

**DoD:**
- Все 4 эндпоинта возвращают коды и форматы по §5.2.
- Race condition test: два одновременных PUT /me с одинаковым code от разных
  адресов → один 200, второй 409 (постгрес уникальный индекс).
- Reserved + profanity отвергаются 422.

**Зависит от:** B0.10 (AUTH), B0.3 (миграция с таблицей `referral_codes`).

**Integration checkpoint:** IC-0.X с Frontend F0.X (claim-UI).

---

### B0.12 — `@require_premium` декоратор
**Что:** гейт для premium-эндпоинтов.

**Действия:**
- `app/deps.py:require_premium` — обёртка над `require_auth`:
  - Проверяет `is_premium(g.address)`.
  - Если нет — 402 `access.payment_required`.

**DoD:**
- Применить к тестовому endpoint'у → curl без сессии → 401.
- Curl с сессией без оплаты → 402.
- Curl с сессией оплатившего → endpoint работает.

**Зависит от:** B0.11.

---

### B0.13 — `/profile` и `/position` (premium)
**Что:** портфолио-эндпоинты согласно [../api-spec.md](../api-spec.md) §6.

**Действия:**
- `shared/profile.py:build_profile(address)` — pure-функция, реализует логику
  `api_profile` из портативки (server.py:1373), см.
  [../port-from-portable.md](../port-from-portable.md) §1.
  - Только торгуемые quote-токены в `balances` — см. §6.1 api-spec.
- `app/routes/profile.py:get_profile`:
  - `GET /api/v1/profile?tradesLimit=&tradesCursor=` — `@require_premium`.
  - Пагинация trades по `(block_number DESC, log_index DESC)` — §1.5 api-spec.
- `app/routes/tokens.py:get_position`:
  - `GET /api/v1/tokens/{token}/position` — `@require_premium`.
  - Возвращает только `myWallet`-блок (как в §4.3, но без trades/wallets).
- Обновить `/tokens/{token}/trades` — теперь возвращает реальный `myWallet`
  для premium-сессии.

**DoD:**
- `/profile` для тестового кошелька с активностью → корректные суммы.
- `/position` совпадает с `myWallet` из `/trades`.
- Не-premium → 402.

**Зависит от:** B0.12.

**Integration checkpoint:** IC-0.5 (с Frontend F0.15).

---

### B0.14 — Operator-Telegram alerts
**Что:** outbound-only бот для оператора.

**Действия:**
- `worker/operator_alerts.py:send(text)` — `httpx.post(...sendMessage)` с
  `OPERATOR_TG_BOT_TOKEN` в `OPERATOR_TG_CHAT_ID`.
- Точки вызова:
  - В `worker/event_loop.py` — если несколько подряд тиков фейлятся.
  - В `worker/price_loop.py` — если `now - last_price_update > 5 min`.
  - В keeper'е (фаза 2) — на терминальные revert'ы.
  - При старте worker'а — «worker started, backfill complete=...».

**DoD:**
- Установка `OPERATOR_TG_BOT_TOKEN` + `OPERATOR_TG_CHAT_ID` в env → тестовое
  сообщение приходит в личный чат.
- Симуляция «worker stuck» → алерт пришёл.

**Зависит от:** B0.6.

---

*(Auth_nonces cleanup включён в B0.6 как `worker/nonces.py:cleanup`. DoD-проверка
nonces-чистки покрывается в IC-0.3 — отдельного шага не требуется.)*

---

## Фаза 1 — Удаление кастодиальных эндпоинтов

### B1.1 — Удалить `/api/trade`, `/api/quote`, `/api/wallet`
**Что:** торговля переехала в браузер.

**Действия:**
- Удалить или **не реализовывать** эти эндпоинты (если уже есть, удалить).
- Удалить связанный код: `get_wallet`, `execute_trade` из shared (если был).
- В тесте: GET/POST на эти URL → 404.

**DoD:**
- `curl /api/v1/trade` → 404.
- Никаких приватных ключей не хранится на сервере (кроме keeper в фазе 2).

(Фаза 1 в основном фронтенд.)

---

## Фаза 2 — Backend для лимит-ордеров + keeper

### B2.1 — `/api/v1/orders` POST/GET/DELETE + `/armed`
**Что:** orders endpoints согласно [../api-spec.md](../api-spec.md) §7.

**Действия:**
- `shared/orders.py`:
  - `hash_order(order)` — точное соответствие [../eip712.md](../eip712.md) §3.2.
    Используется для **верификации** подписи (не для подписи — это фронт).
  - `verify_signature(order, signature)` — через `eth-account` SignatureChecker
    (EIP-1271 через RPC для smart-wallet'ов).
  - `validate_order(order)` — все проверки из §7.2 api-spec (включая
    `quoteToken` против seed).
  - `transition(order_id, new_status, **kwargs)` — с инвариантами переходов.
- `app/routes/orders.py`:
  - `GET /api/v1/orders` (§7.1).
  - `POST /api/v1/orders` (§7.2) — `@require_premium`.
  - `DELETE /api/v1/orders/{id}` (§7.3).
  - `PUT /api/v1/orders/armed` (§7.4).
- При создании — `notify("pt_orders", str(order_id))` (для SSE подключения, но
  пока канал orders может быть не подключён к фронту).

**DoD:**
- Создание ордера с валидной подписью → 200, запись в `limit_orders`.
- Подпись неверная → 422 `orders.invalid_signature`.
- quoteToken неверный → 422 `orders.bad_quote_token`.
- Дубликат `(owner, nonce)` → 200 (idempotent) или 409 при разных полях.
- DELETE своего pending → 204; чужого → 404.

---

### B2.2 — SSE канал `orders` (premium)
**Что:** добавить канал в `/stream`.

**Действия:**
- В `app/sse.py:stream`:
  - При подключении — если `is_premium(g.address)`, подписать на `pt_orders`.
  - На NOTIFY с order_id — прочитать ордер, отдать только если он принадлежит
    `g.address`.
- При смене статуса keeper'ом → NOTIFY → SSE event.

**DoD:**
- Premium-cессия → создать ордер → keeper фейк-меняет статус → клиент видит
  событие `orders`.

---

### B2.3 — Keeper в worker'е
**Что:** мониторит pending-ордера и вызывает execute().

**Действия:**
- `worker/keeper.py`:
  - **Recovery при старте**: SELECT WHERE status='executing' → для каждого
    `eth_getTransactionReceipt(executed_tx_hash)`:
    - receipt status=1 + `OrderExecuted` event → `filled`.
    - receipt status=0 → расшифровать revert reason → `failed` или `open`
      (если «цена ушла»).
    - receipt None → оставить executing (дождётся следующего тика).
    - **На старте** keeper читает `eth.getTransactionCount(keeper_addr, 'pending')`
      → выставляет локальный `next_nonce` = это значение. Дальше — локальный
      counter, не дёргаем RPC на каждый send.
  - **Tick**: для каждого open-ордера (с `retry_after IS NULL OR now() >= retry_after`):
    - Прочитать `currentPrice` у хука (из market_state — кэш).
    - Если условие выполнено + `user_settings.orders_armed = true`:
      - **Pre-flight simulation**: `executor.execute(order, signature).call()`
        с `from = keeper_addr` (read-only `eth_call`). Если симуляция падает —
        декодировать reason: «цена ушла» → выставить cooldown без отправки tx;
        терминальная причина → `failed` без отправки tx. Симуляция бесплатна
        и предотвращает большинство потерь газа.
      - Если симуляция прошла — подать реальную tx с
        `nonce = next_nonce`, `next_nonce += 1`.
      - Записать `executed_tx_hash`, статус → `executing`, `last_attempt_at = now()`,
        `attempts += 1`.
      - Async ждать receipt; на успехе обновить статус, на таймауте — replacement.
  - **Cooldown**: после revert «цена ушла» (включая отказ симуляции) →
    `retry_after = now() + ORDER_COOLDOWN_SEC` (60с).
  - **Газ**: `gas_price = eth.gas_price() * GAS_MULTIPLIER` (1.5).
  - **Stuck tx**: если receipt не пришёл за `RECEIPT_TIMEOUT_SEC` → re-send
    с тем же nonce и более высоким газом (×1.5 от предыдущего). Локальный
    counter не меняется при replacement.
  - **Nonce gap recovery**: каждые ~5 минут — sanity check
    `next_nonce >= eth.getTransactionCount(keeper, 'latest')`. Если меньше
    (произошло что-то нештатное, кто-то ещё подавал tx от этого ключа) —
    подгоняем counter и шлём алерт оператору.
- `shared/revert_decode.py` — распарсить revert reason из receipt/eth_call error
  → enum `fail_reason`. Поддерживает: custom errors (по 4-byte selector от ABI
  contracts), require strings, OutOfGas, низкоуровневые reverts (→ `unknown`).
  Сырой текст пишется в `fail_detail` для отладки.
- **Логирование** keeper'а — обязательно через redaction-processor из
  [../conventions.md](../conventions.md) §8: подпись ордера, приватный ключ,
  cookie, tx-payload sig — никогда в открытом виде в логах.

**DoD:**
- Тестовый open-ордер с выполнимой ценой → keeper его подбирает → execute
  на форк-тесте → status `filled`.
- Симуляция revert «цена ушла» → status остаётся open → `retry_after`
  установлен → следующий tick через 60с.
- Рестарт worker'а во время `executing` → recovery подбирает по receipt.

**Зависит от:** C2.6 (executor задеплоен), B2.1.

---

### B2.4 — Expiry-цикл
**Что:** перевод истёкших ордеров в `expired`.

**Действия:**
- `worker/expiry.py:tick`:
  - `UPDATE limit_orders SET status='expired' WHERE status='open' AND expires_at <= now() RETURNING id`.
  - Для каждого — NOTIFY `pt_orders`.
- Запускается в основном цикле worker'а раз в 30 сек.

**DoD:**
- Ордер с `expires_at = now() - 1` → через ≤30 сек → status `expired`,
  SSE-событие пришло.

---

### B2.5 — Алерты пользователю (опционально, основное в фазе 3)
*(В фазе 2 — нет; здесь pass.)*

---

## Фаза 3 — Telegram-алерты

### B3.1 — `POST /api/v1/telegram/webhook`
**Что:** webhook handler согласно [../api-spec.md](../api-spec.md) §10.

**Действия:**
- `app/routes/telegram.py:webhook`:
  - Проверка `X-Telegram-Bot-Api-Secret-Token` константно-временно.
  - Парсит `Update`-объект.
  - Если `message.text` начинается с `/start <token>`:
    - Резолвит token в `telegram_link_tokens` (single-use, TTL 5 мин).
    - Если валиден → создаёт `telegram_links` запись.
    - Удаляет token из `telegram_link_tokens`.
  - Иначе — игнор.
- Не покрывается rate-limit.

**DoD:**
- Невалидный secret → 404.
- `/start <valid_token>` → запись в `telegram_links`, бот отправил confirmation.
- `/start <expired_token>` → бот отправил «токен истёк».

---

### B3.2 — User-Telegram outbound + deep-link генерация
**Что:** генерация deep-link для привязки + рассылка алертов.

**Действия:**
- `app/routes/telegram.py:request_link`:
  - `POST /api/v1/telegram/link-token` — `@require_premium`.
  - Генерирует token (32 случайных байта, base64url), пишет в
    `telegram_link_tokens`.
  - Возвращает `{ deepLink: "t.me/<bot>?start=<token>" }`.
- `worker/alerts.py:notify_user(address, text)`:
  - Ищет `chat_id` в `telegram_links`.
  - Отправляет через `USER_TG_BOT_TOKEN`.
- Интеграция в keeper: при `filled`/`failed`/`expired` → `notify_user`.

**DoD:**
- Premium-юзер дёргает endpoint → получает deep-link.
- Открытие deep-link → бот связывает аккаунт.
- Тестовый `filled` ордер → пользователю прилетает сообщение.

---

### B3.3 — Отвязка Telegram
**Что:** ручка для удаления связки.

**Действия:**
- `DELETE /api/v1/telegram/link` — `@require_premium` → удалить
  `telegram_links` запись.

**DoD:** запись пропала, последующие notify_user — no-op.

---

## Сводный чек-лист DoD Backend по фазам

См. [../conventions.md](../conventions.md) §12 — пункты, помеченные как
backend-ответственные:

- **Фаза 0:** миграция 0001, seed, worker крутит price+event циклы, бэкфилл,
  все FREE-эндпоинты, SIWE+JWT, `/access`, `/profile` за гейтом, operator-TG.
- **Фаза 1:** `/trade`, `/quote`, `/wallet` удалены.
- **Фаза 2:** `/orders`, keeper с recovery+cooldown+expiry, SSE канал orders.
- **Фаза 3:** webhook, deep-link, outbound user-alerts.
