"""limit_orders: add display_target_price (MID-space) column

The on-chain contract verifies the actual swap rate against
``target_price * (1 ± slippageBps/10000)`` — i.e. ``target_price`` is in
**execution space** (fee-included ASK for buys, fee-included BID for sells).
The user's mental model, however, is the fee-free **MID** the chart shows:
"fire when chart hits N".

To bridge the two we store both:

* ``target_price`` — execution-space value the user signed (unchanged; what
  EIP-712 + the executor verify on chain).
* ``display_target_price`` — MID-space value the user actually typed. The
  keeper compares this against the cached ``market_state.price_*`` (which
  comes from ``Hook.currentPrice``, i.e. MID) to decide whether the order
  has triggered.

Nullable for backwards-compatibility with order #1 (created before this
migration). When NULL the keeper falls back to deriving the MID target
from the signed execution-space target via the fixed 5% pitchwc fee
constant — see ``backend/worker/keeper.py``.

Revision ID: 0004_display_target_price
Revises: 0003_order_status_open
Create Date: 2026-05-25 22:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0004_display_target_price"
down_revision: str | None = "0003_order_status_open"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE limit_orders "
        "ADD COLUMN display_target_price NUMERIC(78, 0) NULL "
        "    CHECK (display_target_price IS NULL OR display_target_price > 0)"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE limit_orders DROP COLUMN IF EXISTS display_target_price")
