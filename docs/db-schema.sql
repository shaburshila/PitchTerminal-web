-- PitchTerminal-web — Postgres schema (canonical DDL)
--
-- Этот файл — источник истины для структуры БД. Первая миграция (Alembic или
-- голый sql-runner) воспроизводит его дословно. Любое изменение схемы — через
-- новую миграцию + апдейт этого файла.
--
-- Соглашения:
--   * wei/uint256 → NUMERIC(78, 0). Никаких bigint/float для денег.
--   * адреса → CHAR(42) lowercase (с префиксом 0x); проверка CHECK.
--   * время → TIMESTAMPTZ (UTC хранение).
--   * ENUM в Postgres — явный CREATE TYPE.
--   * имена в snake_case.
--
-- Связанные документы: docs/api-spec.md, docs/architecture.md §7.

BEGIN;

-- =============================================================================
-- ENUM types
-- =============================================================================

CREATE TYPE token_kind AS ENUM ('player', 'country');
CREATE TYPE player_role AS ENUM ('best', 'captain', 'rookie');
CREATE TYPE event_side AS ENUM ('buy', 'sell');
CREATE TYPE order_side AS ENUM ('limit-buy', 'take-profit');
CREATE TYPE order_venue AS ENUM ('player', 'country');
CREATE TYPE order_status AS ENUM (
    'open', 'executing', 'filled', 'failed', 'cancelled', 'expired'
);
-- 'open' was historically named 'pending'; renamed in migration 0003 because
-- the UX label misled users into thinking the order was already being
-- processed. Semantically it means "armed, waiting for trigger condition".

CREATE TYPE order_fail_reason AS ENUM (
    'no_allowance',          -- approve отозван / недостаточен
    'insufficient_balance',  -- у пользователя не хватает amountIn
    'bad_quote_token',       -- venue=country и quoteToken≠PITCH (контрактная проверка)
    'router_revert',         -- pitchwc router отверг своп (несовместимая пара, slippage, итд)
    'min_out_not_met',       -- получилось меньше minOut после фактического свопа
    'expired_on_chain',      -- expiry прошёл к моменту майнинга
    'nonce_used',            -- ордер с этим nonce уже использован (on-chain cancel или предыдущий execute)
    'unknown'                -- revert без расшифровки причины
);

-- =============================================================================
-- tokens — статичные метаданные (seed из data/tokens.json)
-- =============================================================================

CREATE TABLE tokens (
    address           CHAR(42)    PRIMARY KEY
                                  CHECK (address ~ '^0x[0-9a-f]{40}$'),
    name              TEXT        NOT NULL,
    symbol            TEXT        NOT NULL,
    kind              token_kind  NOT NULL,
    country_address   CHAR(42)    NULL
                                  CHECK (country_address IS NULL
                                         OR country_address ~ '^0x[0-9a-f]{40}$'),
    role              player_role NULL,
    -- icon-pack token: kind='player' but trades on the separate pitchwc
    -- IconCurveHook / router (added by migration 0006_tokens_is_icon).
    is_icon           BOOLEAN     NOT NULL DEFAULT FALSE,
    CONSTRAINT tokens_player_must_have_country
        CHECK ((kind = 'country' AND country_address IS NULL AND role IS NULL)
            OR (kind = 'player'  AND country_address IS NOT NULL AND role IS NOT NULL)),
    CONSTRAINT tokens_country_fk
        FOREIGN KEY (country_address) REFERENCES tokens(address)
        DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX tokens_kind_idx ON tokens(kind);
CREATE INDEX tokens_country_idx ON tokens(country_address) WHERE kind = 'player';

-- =============================================================================
-- events — все Buy/Sell сделки обоих хуков
-- =============================================================================

CREATE TABLE events (
    id               BIGSERIAL      PRIMARY KEY,
    block_number     BIGINT         NOT NULL,
    tx_hash          CHAR(66)       NOT NULL
                                    CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
    log_index        INTEGER        NOT NULL,
    token_address    CHAR(42)       NOT NULL REFERENCES tokens(address),
    side             event_side     NOT NULL,
    trader_address   CHAR(42)       NOT NULL
                                    CHECK (trader_address ~ '^0x[0-9a-f]{40}$'),
    base_value       NUMERIC(78, 0) NOT NULL CHECK (base_value > 0),
    token_value      NUMERIC(78, 0) NOT NULL CHECK (token_value >= 0),
    fee              NUMERIC(78, 0) NOT NULL CHECK (fee >= 0),
    ts               TIMESTAMPTZ    NOT NULL,
    CONSTRAINT events_unique_log UNIQUE (tx_hash, log_index)
);

-- Время выводится из block_number, но хранится явно — экономит реверс при чтении.
-- Источник времени: либо block.timestamp (предпочтительно — точно), либо
-- now() при пере-сканах (тогда recover через RPC отдельным проходом).

CREATE INDEX events_token_block_idx ON events(token_address, block_number DESC);
CREATE INDEX events_trader_idx ON events(trader_address);
CREATE INDEX events_block_idx ON events(block_number DESC);
-- Покрывает GET /api/v1/portfolio/trades: фильтр (trader, token) + ORDER BY (block, log) DESC.
CREATE INDEX events_trader_token_block_idx
    ON events(trader_address, token_address, block_number DESC, log_index DESC);

-- =============================================================================
-- market_state — derived/cache: динамика по токену
-- Пишет worker (UPSERT), читает API.
-- =============================================================================

CREATE TABLE market_state (
    token_address     CHAR(42)       PRIMARY KEY REFERENCES tokens(address),
    price_country     NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (price_country >= 0),
    price_pitch       NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (price_pitch   >= 0),
    supply            NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (supply        >= 0),
    change_pct_all    DOUBLE PRECISION NOT NULL DEFAULT 0,
    change_pct_1d     DOUBLE PRECISION NOT NULL DEFAULT 0,
    change_pct_12h    DOUBLE PRECISION NOT NULL DEFAULT 0,
    change_pct_6h     DOUBLE PRECISION NOT NULL DEFAULT 0,
    change_pct_1h     DOUBLE PRECISION NOT NULL DEFAULT 0,
    change_pct_15m    DOUBLE PRECISION NOT NULL DEFAULT 0,
    trades_count      INTEGER        NOT NULL DEFAULT 0 CHECK (trades_count  >= 0),
    holders_count     INTEGER        NOT NULL DEFAULT 0 CHECK (holders_count >= 0),
    ask_quote_per_base NUMERIC(78, 0) NULL
                                      CHECK (ask_quote_per_base IS NULL OR ask_quote_per_base > 0),
    bid_quote_per_base NUMERIC(78, 0) NULL
                                      CHECK (bid_quote_per_base IS NULL OR bid_quote_per_base > 0),
    updated_at        TIMESTAMPTZ    NOT NULL DEFAULT now()
);
-- change_pct без CHECK: может быть положительным или отрицательным (правда,
-- ограничен ~±10000% разумно — но не enforce'им, чтобы не блокировать
-- легитимный рост 100×).

-- price_country = 0 у токенов стран (страны торгуются в PITCH).
-- Изменения change_pct и holders_count — пересчитываются worker'ом из events.

-- ask_quote_per_base / bid_quote_per_base — fee-INCLUSIVE directional quotes
-- in quote-wei per 1 whole base (10^18 base units), used by the limit-order
-- keeper to evaluate triggers against the actual execution rate (not the
-- fee-free mid-price). Denomination matches price_country/price_pitch:
-- player tokens → country wei; country tokens → PITCH wei. NULL when the
-- worker has not yet populated them; keeper SKIPS such orders rather than
-- falling back to mid. Sourced from Hook.quoteBuy / Hook.quoteSell.

-- =============================================================================
-- app_state — key-value служебное состояние
-- =============================================================================

CREATE TABLE app_state (
    key   TEXT PRIMARY KEY,
    value JSONB NOT NULL
);

-- Ожидаемые ключи (worker инициализирует при первом старте):
--   'last_scanned_block' → { "block": 12345678 }
--   'backfill_status'    → { "complete": true } | { "complete": false, "progressBlock": ... }
--   'access_config'      → {
--                            "accessPriceWei": "1000000000000000000",
--                            "buyerDiscountBps": 2500,
--                            "referralBps": 2500,
--                            "blockNumber": 46167000,
--                            "txHash": "0x..."
--                          }
--      Снимок текущих on-chain полей /api/v1/config. Обновляется worker'ом
--      на каждом PriceChanged / ReferralSplitUpdated от PitchTerminalAccess.
--      Источник истины для /api/v1/config?fresh=1 (без RPC-вызова в горячем пути).
--
-- Версия схемы канонически живёт в Alembic'е (таблица alembic_version), здесь
-- не дублируется.

-- =============================================================================
-- limit_orders — подписанные ордера + статус
-- =============================================================================

CREATE TABLE limit_orders (
    id                BIGSERIAL      PRIMARY KEY,
    owner_address     CHAR(42)       NOT NULL
                                     CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
    token_address     CHAR(42)       NOT NULL REFERENCES tokens(address),
    quote_address     CHAR(42)       NOT NULL
                                     CHECK (quote_address ~ '^0x[0-9a-f]{40}$'),
    venue             order_venue    NOT NULL,
    side              order_side     NOT NULL,
    target_price      NUMERIC(78, 0) NOT NULL CHECK (target_price > 0),
    -- display_target_price — MID-space target the user typed (chart-space).
    -- Compared by keeper against market_state.price_* (which is Hook.currentPrice).
    -- target_price (above) stays in execution-space (fee-included ASK/BID) — that's
    -- what's in the EIP-712 signature and what the on-chain executor verifies.
    -- Nullable for backwards-compat with pre-migration-0004 rows; keeper falls
    -- back to deriving the MID target via the fixed 5% fee constant when NULL.
    display_target_price NUMERIC(78, 0) NULL
                                     CHECK (display_target_price IS NULL OR display_target_price > 0),
    amount_in         NUMERIC(78, 0) NOT NULL CHECK (amount_in > 0),
    slippage_bps      INTEGER        NOT NULL CHECK (slippage_bps BETWEEN 0 AND 10000),
    expires_at        TIMESTAMPTZ    NULL,   -- NULL = без срока (соответствует expiry=0 в EIP-712)
    nonce             CHAR(66)       NOT NULL
                                     CHECK (nonce ~ '^0x[0-9a-f]{64}$'),
    signature         BYTEA          NOT NULL,
    status            order_status   NOT NULL DEFAULT 'open',
    created_at        TIMESTAMPTZ    NOT NULL DEFAULT now(),
    executed_tx_hash  CHAR(66)       NULL
                                     CHECK (executed_tx_hash IS NULL
                                            OR executed_tx_hash ~ '^0x[0-9a-f]{64}$'),
    fail_reason       order_fail_reason NULL,
    fail_detail       TEXT           NULL,   -- сырое сообщение revert'а (для расследования)
    -- Keeper-метаданные для recovery после рестарта и защиты от tight loop:
    retry_after       TIMESTAMPTZ    NULL,   -- если задано — keeper пропускает ордер до этого момента
    last_attempt_at   TIMESTAMPTZ    NULL,   -- время последней попытки execute (любого результата)
    attempts          INTEGER        NOT NULL DEFAULT 0,  -- счётчик попыток за всё время жизни ордера
    CONSTRAINT limit_orders_unique_nonce UNIQUE (owner_address, nonce)
);

CREATE INDEX limit_orders_pending_idx
    ON limit_orders(token_address, side)
    WHERE status = 'open';

CREATE INDEX limit_orders_executing_idx
    ON limit_orders(executed_tx_hash)
    WHERE status = 'executing';
-- Используется при старте worker'а для recovery подвисших executing-ордеров.

CREATE INDEX limit_orders_owner_idx
    ON limit_orders(owner_address, created_at DESC);

CREATE INDEX limit_orders_expiring_idx
    ON limit_orders(expires_at)
    WHERE status = 'open' AND expires_at IS NOT NULL;

-- venue → определяет какую пару Router/Hook использовать (см. eip712.md).
-- Подпись сохраняется в БД, чтобы keeper мог пере-исполнить (например, после
-- падения worker'а или транзиентного сбоя RPC) без участия пользователя.

-- =============================================================================
-- auth_nonces — одноразовые SIWE-nonce (TTL ~5 мин)
-- =============================================================================

CREATE TABLE auth_nonces (
    nonce       TEXT        PRIMARY KEY,
    address     CHAR(42)    NULL
                            CHECK (address IS NULL OR address ~ '^0x[0-9a-f]{40}$'),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX auth_nonces_created_idx ON auth_nonces(created_at);
CREATE INDEX auth_nonces_address_idx ON auth_nonces(address);

-- Используется как delete-on-use (worker периодически чистит протухшие записи
-- старше 10 минут — двойной запас).
--
-- `address` — wallet address для которого выдан nonce (security #5: anti
-- pre-harvesting). `_consume_nonce_atomic` матчит и nonce, и address, поэтому
-- украденный nonce невозможно redeem'ить под чужим адресом через phishing.
-- Колонка nullable только ради backward-compat одной overlap-минуты при
-- deploy миграции 0005; application-код всегда populate'ит её при INSERT'е.

-- =============================================================================
-- user_settings — персональные настройки кошелька
-- =============================================================================

CREATE TABLE user_settings (
    owner_address  CHAR(42)    PRIMARY KEY
                               CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
    orders_armed   BOOLEAN     NOT NULL DEFAULT true,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- referral_codes — opt-in читаемые handle для реферальных ссылок
-- =============================================================================
--
-- Любой пользователь может claim'нуть один уникальный code и шарить
-- https://pitchterminal.app/?ref=<code>. Frontend резолвит code → wallet через
-- GET /api/v1/ref/{code} и передаёт wallet в buyAccess(address referrer).
-- Code независим от факта оплаты — claim доступен любому connected'у.
-- Reserved-список (api, admin, www, me, …) — на API-уровне, не в БД.

CREATE TABLE referral_codes (
    code           TEXT        PRIMARY KEY
                               CHECK (code ~ '^[a-z0-9_-]{4,32}$'
                                      AND code !~ '^[-_]'
                                      AND code !~ '[-_]$'),
    owner_address  CHAR(42)    NOT NULL UNIQUE
                               CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
    claimed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- UNIQUE (owner_address) — один кошелёк = один code. Смена code = атомарный
-- DELETE+INSERT в одной транзакции под PUT /api/v1/ref/me (race-safe).

-- =============================================================================
-- telegram_links — chat_id ↔ wallet (добавляется в фазе 3)
-- =============================================================================

CREATE TABLE telegram_links (
    owner_address  CHAR(42)    PRIMARY KEY
                               CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
    chat_id        BIGINT      NOT NULL,
    linked_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX telegram_links_chat_idx ON telegram_links(chat_id);

-- =============================================================================
-- telegram_link_tokens — одноразовые deep-link токены для /start (фаза 3)
-- =============================================================================

CREATE TABLE telegram_link_tokens (
    token          CHAR(43)    PRIMARY KEY,   -- base64url 32 bytes
    owner_address  CHAR(42)    NOT NULL
                               CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- TTL 5 минут; delete-on-use.

-- =============================================================================
-- NOTIFY channels (для SSE pub/sub)
-- =============================================================================

-- Каналы NOTIFY — worker → API. Payload всегда непустой и содержит ровно то,
-- что нужно для рассылки — API не делает «слепых» дёрганий снимка.
--
--   'pt_prices'  — payload = JSON-массив lowercase-адресов изменившихся токенов.
--                  Пример: ["0xabc...","0xdef..."].
--                  API читает market_state WHERE address IN (...) и шлёт SSE.
--                  Worker считает дельту, сравнивая текущий снимок с предыдущим
--                  in-memory tick'ом; пустую дельту НЕ нотифицирует.
--                  Stale-индикатор: при пересечении freshness threshold worker
--                  один раз шлёт NOTIFY с пустым массивом [] — это сигнал
--                  «данные устарели, но новых цен нет».
--
--   'pt_events'  — payload = JSON-массив events.id (BIGINT).
--                  Пример: [12345,12346].
--                  API читает events WHERE id IN (...) и шлёт SSE.
--
--   'pt_orders'  — payload = limit_orders.id (одно число как text).
--                  Пример: "1234".
--                  API читает ордер, определяет владельца и шлёт SSE только
--                  его активным соединениям.
--
--   'pt_config'  — payload = JSON-снимок изменившихся on-chain полей
--                  /api/v1/config (см. api-spec.md §8.3 'event: config').
--                  Пример: {"accessPriceWei":"2000000000000000000",
--                           "buyerDiscountBps":2500,"referralBps":2500,
--                           "blockNumber":12345678,"txHash":"0x..."}.
--                  Триггер: worker детектит PriceChanged или
--                  ReferralSplitUpdated от PitchTerminalAccess → пишет
--                  свежий снимок в app_state.access_config → NOTIFY.
--                  API инвалидирует /config-кэш и рассылает SSE всем
--                  подключённым (auth-нейтрально).
--
-- Postgres NOTIFY payload имеет лимит ~8000 байт; если массив рискует превысить
-- — worker дробит на несколько NOTIFY (приоритет: каждое сообщение само по себе
-- валидно, фронт мёрджит).
--
-- Каждый API-процесс открывает по одному LISTEN на каждый канал.

COMMIT;

-- =============================================================================
-- Seed — выполняется отдельным скриптом на первом деплое:
--   1. INSERT INTO tokens из data/tokens.json (страны первыми, потом игроки —
--      FK страны должен резолвиться; FK помечен DEFERRABLE, так что порядок
--      внутри транзакции не критичен).
--   2. INSERT INTO app_state VALUES ('last_scanned_block', '{"block": 46167000}'),
--                                   ('backfill_status', '{"complete": false}').
-- =============================================================================
