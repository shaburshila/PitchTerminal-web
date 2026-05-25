"""market_state ask/bid quotes (directional, fee-inclusive)

Adds two columns to ``market_state`` for directional, fee-inclusive quotes
used by the keeper's trigger evaluation:

* ``ask_quote_per_base`` — quote-wei needed to buy 1 whole base (= 10^18 base
  units), fee-INCLUDED. Computed from ``Hook.quoteBuy(token, 10^18)``: spend
  1 whole quote, receive ``baseOut`` base-wei → ``ask = 10^18 * 10^18 //
  baseOut``.
* ``bid_quote_per_base`` — quote-wei received when selling 1 whole base
  (= 10^18 base units), fee-INCLUDED. Equal to ``Hook.quoteSell(token,
  10^18)``'s ``quoteOut`` directly.

Both columns are nullable (no default) — a NULL means the price-loop has not
yet populated them, in which case the keeper must SKIP the order rather than
fall back to the fee-excluded mid (``price_country`` / ``price_pitch``) — see
docs/api-spec.md §4.5 + the keeper rationale.

Denomination matches ``price_country`` / ``price_pitch``:

* Player tokens — quotes are in **country wei** (same as ``price_country``).
* Country tokens — quotes are in **PITCH wei** (same as ``price_pitch``).

Down-migration drops both columns.

Revision ID: 0002_market_quotes
Revises: 0001_initial
Create Date: 2026-05-25 20:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0002_market_quotes"
down_revision: str | None = "0001_initial"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE market_state "
        "ADD COLUMN ask_quote_per_base NUMERIC(78, 0) NULL "
        "    CHECK (ask_quote_per_base IS NULL OR ask_quote_per_base > 0), "
        "ADD COLUMN bid_quote_per_base NUMERIC(78, 0) NULL "
        "    CHECK (bid_quote_per_base IS NULL OR bid_quote_per_base > 0)"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE market_state "
        "DROP COLUMN IF EXISTS ask_quote_per_base, "
        "DROP COLUMN IF EXISTS bid_quote_per_base"
    )
