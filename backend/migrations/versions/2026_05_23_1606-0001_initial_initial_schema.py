"""initial schema

Reproduces ``docs/db-schema.sql`` verbatim — every CREATE TYPE, CREATE TABLE,
CHECK, UNIQUE, FK and INDEX (including partials). The canonical source of
truth for the schema lives in ``docs/db-schema.sql``; this migration is the
mechanical port for Alembic. Any change here MUST be mirrored there.

Revision ID: 0001_initial
Revises:
Create Date: 2026-05-23 16:06:57.249526
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0001_initial"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ENUM types ------------------------------------------------------------
    op.execute("CREATE TYPE token_kind AS ENUM ('player', 'country');")
    op.execute("CREATE TYPE player_role AS ENUM ('best', 'captain', 'rookie');")
    op.execute("CREATE TYPE event_side AS ENUM ('buy', 'sell');")
    op.execute("CREATE TYPE order_side AS ENUM ('limit-buy', 'take-profit');")
    op.execute("CREATE TYPE order_venue AS ENUM ('player', 'country');")
    op.execute(
        """
        CREATE TYPE order_status AS ENUM (
            'pending', 'executing', 'filled', 'failed', 'cancelled', 'expired'
        );
        """
    )
    op.execute(
        """
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
        """
    )

    # tokens ----------------------------------------------------------------
    op.execute(
        """
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
            CONSTRAINT tokens_player_must_have_country
                CHECK ((kind = 'country' AND country_address IS NULL AND role IS NULL)
                    OR (kind = 'player'  AND country_address IS NOT NULL AND role IS NOT NULL)),
            CONSTRAINT tokens_country_fk
                FOREIGN KEY (country_address) REFERENCES tokens(address)
                DEFERRABLE INITIALLY DEFERRED
        );
        """
    )
    op.execute("CREATE INDEX tokens_kind_idx ON tokens(kind);")
    op.execute(
        "CREATE INDEX tokens_country_idx ON tokens(country_address) WHERE kind = 'player';"
    )

    # events ----------------------------------------------------------------
    op.execute(
        """
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
        """
    )
    op.execute(
        "CREATE INDEX events_token_block_idx ON events(token_address, block_number DESC);"
    )
    op.execute("CREATE INDEX events_trader_idx ON events(trader_address);")
    op.execute("CREATE INDEX events_block_idx ON events(block_number DESC);")

    # market_state ----------------------------------------------------------
    op.execute(
        """
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
            updated_at        TIMESTAMPTZ    NOT NULL DEFAULT now()
        );
        """
    )

    # app_state -------------------------------------------------------------
    op.execute(
        """
        CREATE TABLE app_state (
            key   TEXT PRIMARY KEY,
            value JSONB NOT NULL
        );
        """
    )

    # limit_orders ----------------------------------------------------------
    op.execute(
        """
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
            amount_in         NUMERIC(78, 0) NOT NULL CHECK (amount_in > 0),
            slippage_bps      INTEGER        NOT NULL CHECK (slippage_bps BETWEEN 0 AND 10000),
            expires_at        TIMESTAMPTZ    NULL,
            nonce             CHAR(66)       NOT NULL
                                             CHECK (nonce ~ '^0x[0-9a-f]{64}$'),
            signature         BYTEA          NOT NULL,
            status            order_status   NOT NULL DEFAULT 'pending',
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
        """
    )
    op.execute(
        """
        CREATE INDEX limit_orders_pending_idx
            ON limit_orders(token_address, side)
            WHERE status = 'pending';
        """
    )
    op.execute(
        """
        CREATE INDEX limit_orders_executing_idx
            ON limit_orders(executed_tx_hash)
            WHERE status = 'executing';
        """
    )
    op.execute(
        """
        CREATE INDEX limit_orders_owner_idx
            ON limit_orders(owner_address, created_at DESC);
        """
    )
    op.execute(
        """
        CREATE INDEX limit_orders_expiring_idx
            ON limit_orders(expires_at)
            WHERE status = 'pending' AND expires_at IS NOT NULL;
        """
    )

    # auth_nonces -----------------------------------------------------------
    op.execute(
        """
        CREATE TABLE auth_nonces (
            nonce       TEXT        PRIMARY KEY,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        """
    )
    op.execute("CREATE INDEX auth_nonces_created_idx ON auth_nonces(created_at);")

    # user_settings ---------------------------------------------------------
    op.execute(
        """
        CREATE TABLE user_settings (
            owner_address  CHAR(42)    PRIMARY KEY
                                       CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
            orders_armed   BOOLEAN     NOT NULL DEFAULT true,
            updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        """
    )

    # referral_codes --------------------------------------------------------
    # Opt-in human-readable handle for referral links (see docs/api-spec.md §5.2,
    # docs/db-schema.sql `referral_codes`). One handle per wallet (UNIQUE
    # owner_address). Atomic PUT semantics via the unique index — concurrent
    # claims of the same code by different wallets resolve as one 201 + one 409
    # at the Postgres level.
    op.execute(
        """
        CREATE TABLE referral_codes (
            code           TEXT        PRIMARY KEY
                                       CHECK (code ~ '^[a-z0-9_-]{4,32}$'
                                              AND code !~ '^[-_]'
                                              AND code !~ '[-_]$'),
            owner_address  CHAR(42)    NOT NULL UNIQUE
                                       CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
            claimed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        """
    )

    # telegram_links --------------------------------------------------------
    op.execute(
        """
        CREATE TABLE telegram_links (
            owner_address  CHAR(42)    PRIMARY KEY
                                       CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
            chat_id        BIGINT      NOT NULL,
            linked_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        """
    )
    op.execute("CREATE INDEX telegram_links_chat_idx ON telegram_links(chat_id);")

    # telegram_link_tokens --------------------------------------------------
    op.execute(
        """
        CREATE TABLE telegram_link_tokens (
            token          CHAR(43)    PRIMARY KEY,
            owner_address  CHAR(42)    NOT NULL
                                       CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
            created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        """
    )


def downgrade() -> None:
    # Drop tables in reverse-dependency order. `events`, `market_state`,
    # `limit_orders` reference `tokens` — drop them before `tokens`. `tokens`
    # self-refs via DEFERRABLE FK, so a straight DROP works.
    op.execute("DROP TABLE IF EXISTS telegram_link_tokens;")
    op.execute("DROP TABLE IF EXISTS telegram_links;")
    op.execute("DROP TABLE IF EXISTS referral_codes;")
    op.execute("DROP TABLE IF EXISTS user_settings;")
    op.execute("DROP TABLE IF EXISTS auth_nonces;")
    op.execute("DROP TABLE IF EXISTS limit_orders;")
    op.execute("DROP TABLE IF EXISTS app_state;")
    op.execute("DROP TABLE IF EXISTS market_state;")
    op.execute("DROP TABLE IF EXISTS events;")
    op.execute("DROP TABLE IF EXISTS tokens;")

    # Drop ENUM types (reverse of CREATE order).
    op.execute("DROP TYPE IF EXISTS order_fail_reason;")
    op.execute("DROP TYPE IF EXISTS order_status;")
    op.execute("DROP TYPE IF EXISTS order_venue;")
    op.execute("DROP TYPE IF EXISTS order_side;")
    op.execute("DROP TYPE IF EXISTS event_side;")
    op.execute("DROP TYPE IF EXISTS player_role;")
    op.execute("DROP TYPE IF EXISTS token_kind;")
