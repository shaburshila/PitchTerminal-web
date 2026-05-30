"""dex_pitch_trades: external PITCH<->ETH/WETH/USDC DEX swaps

Stage 1 of the external-PITCH-trade indexer. Stores PITCH bought / sold for
ETH / WETH / USDC on DEXes (Uniswap V3 + V4), so ``/profile`` can later
compute per-wallet ``external_in`` / ``external_out`` for a money-weighted
ROI (stage 2).

This is **separate** from ``events`` (which holds in-app PITCH<->country /
player bonding-curve trades). The two never overlap: in-app trades carry no
WETH/USDC leg, external swaps do.

Conventions (docs/db-schema.sql):
* addresses → ``CHAR(42)`` lowercase, ``CHECK`` regex.
* tx_hash   → ``CHAR(66)`` lowercase, ``CHECK`` regex.
* wei/uint256 → ``NUMERIC(78, 0)``.
* ``direction`` reuses the existing ``event_side`` enum ('buy' / 'sell').
* ``UNIQUE(tx_hash, log_index)`` makes re-scans idempotent (mirrors
  ``events``). We aggregate multi-leg PITCH deliveries into ONE row per
  (tx, trader, direction) keyed by the MIN PITCH-transfer log_index.

No FK to ``tokens``: PITCH / WETH / USDC are not necessarily rows in
``tokens`` (that table holds player / country tokens only).

Revision ID: 0009_dex_pitch_trades
Revises: 0008_events_token_ts_idx
Create Date: 2026-05-31 12:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0009_dex_pitch_trades"
down_revision: str | None = "0008_events_token_ts_idx"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS dex_pitch_trades (
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
        """
    )
    # Per-wallet read path (stage 2: external_in / external_out by trader).
    op.execute(
        "CREATE INDEX IF NOT EXISTS dex_pitch_trades_trader_idx "
        "ON dex_pitch_trades (trader_address);"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS dex_pitch_trades;")
