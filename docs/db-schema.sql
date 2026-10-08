-- Historical PostgreSQL schema for the final PitchTerminal data model.
-- Alembic migrations under backend/migrations/versions are authoritative.


BEGIN;


CREATE TYPE token_kind AS ENUM ('player', 'country');
CREATE TYPE player_role AS ENUM ('best', 'captain', 'rookie');
CREATE TYPE event_side AS ENUM ('buy', 'sell');
CREATE TYPE order_side AS ENUM ('limit-buy', 'take-profit');
CREATE TYPE order_venue AS ENUM ('player', 'country');
CREATE TYPE order_status AS ENUM (
    'open', 'executing', 'filled', 'failed', 'cancelled', 'expired'
);

CREATE TYPE order_fail_reason AS ENUM (
    'no_allowance',
    'insufficient_balance',
    'bad_quote_token',
    'router_revert',
    'min_out_not_met',
    'expired_on_chain',
    'nonce_used',
    'unknown'
);


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


CREATE INDEX events_token_block_idx ON events(token_address, block_number DESC);
CREATE INDEX events_trader_idx ON events(trader_address);
CREATE INDEX events_block_idx ON events(block_number DESC);
CREATE INDEX events_trader_token_block_idx
    ON events(trader_address, token_address, block_number DESC, log_index DESC);


CREATE TABLE dex_pitch_trades (
    id             BIGSERIAL      PRIMARY KEY,
    block_number   BIGINT         NOT NULL,
    tx_hash        CHAR(66)       NOT NULL
                                  CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
    log_index      INTEGER        NOT NULL,
    trader_address CHAR(42)       NOT NULL
                                  CHECK (trader_address ~ '^0x[0-9a-f]{40}$'),
    direction      event_side     NOT NULL,
    pitch_amount   NUMERIC(78, 0) NOT NULL CHECK (pitch_amount > 0),
    quote_token    CHAR(42)       NOT NULL
                                  CHECK (quote_token ~ '^0x[0-9a-f]{40}$'),
    quote_amount   NUMERIC(78, 0) NOT NULL CHECK (quote_amount >= 0),
    ts             TIMESTAMPTZ    NOT NULL,
    UNIQUE (tx_hash, log_index)
);
CREATE INDEX dex_pitch_trades_trader_idx ON dex_pitch_trades(trader_address);


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




CREATE TABLE app_state (
    key   TEXT PRIMARY KEY,
    value JSONB NOT NULL
);



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
    display_target_price NUMERIC(78, 0) NULL
                                     CHECK (display_target_price IS NULL OR display_target_price > 0),
    amount_in         NUMERIC(78, 0) NOT NULL CHECK (amount_in > 0),
    slippage_bps      INTEGER        NOT NULL CHECK (slippage_bps BETWEEN 0 AND 10000),
    expires_at        TIMESTAMPTZ    NULL,
    nonce             CHAR(66)       NOT NULL
                                     CHECK (nonce ~ '^0x[0-9a-f]{64}$'),
    signature         BYTEA          NOT NULL,
    status            order_status   NOT NULL DEFAULT 'open',
    created_at        TIMESTAMPTZ    NOT NULL DEFAULT now(),
    executed_tx_hash  CHAR(66)       NULL
                                     CHECK (executed_tx_hash IS NULL
                                            OR executed_tx_hash ~ '^0x[0-9a-f]{64}$'),
    fail_reason       order_fail_reason NULL,
    fail_detail       TEXT           NULL,
    retry_after       TIMESTAMPTZ    NULL,
    last_attempt_at   TIMESTAMPTZ    NULL,
    attempts          INTEGER        NOT NULL DEFAULT 0,
    CONSTRAINT limit_orders_unique_nonce UNIQUE (owner_address, nonce)
);

CREATE INDEX limit_orders_pending_idx
    ON limit_orders(token_address, side)
    WHERE status = 'open';

CREATE INDEX limit_orders_executing_idx
    ON limit_orders(executed_tx_hash)
    WHERE status = 'executing';

CREATE INDEX limit_orders_owner_idx
    ON limit_orders(owner_address, created_at DESC);

CREATE INDEX limit_orders_expiring_idx
    ON limit_orders(expires_at)
    WHERE status = 'open' AND expires_at IS NOT NULL;



CREATE TABLE auth_nonces (
    nonce       TEXT        PRIMARY KEY,
    address     CHAR(42)    NULL
                            CHECK (address IS NULL OR address ~ '^0x[0-9a-f]{40}$'),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX auth_nonces_created_idx ON auth_nonces(created_at);
CREATE INDEX auth_nonces_address_idx ON auth_nonces(address);



CREATE TABLE user_settings (
    owner_address  CHAR(42)    PRIMARY KEY
                               CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
    orders_armed   BOOLEAN     NOT NULL DEFAULT true,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);


CREATE TABLE referral_codes (
    code           TEXT        PRIMARY KEY
                               CHECK (code ~ '^[a-z0-9_-]{4,32}$'
                                      AND code !~ '^[-_]'
                                      AND code !~ '[-_]$'),
    owner_address  CHAR(42)    NOT NULL UNIQUE
                               CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
    claimed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);



CREATE TABLE telegram_links (
    owner_address  CHAR(42)    PRIMARY KEY
                               CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
    chat_id        BIGINT      NOT NULL,
    linked_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX telegram_links_chat_idx ON telegram_links(chat_id);


CREATE TABLE telegram_link_tokens (
    token          CHAR(43)    PRIMARY KEY,
    owner_address  CHAR(42)    NOT NULL
                               CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);




COMMIT;
