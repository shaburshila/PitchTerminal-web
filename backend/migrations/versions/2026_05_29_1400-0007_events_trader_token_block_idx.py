"""events: composite (trader, token, block, log) index for wallet trade feed

Perf fix (review HIGH): ``GET /api/v1/portfolio/trades`` runs
``WHERE trader_address = %s AND token_address = %s
 ORDER BY block_number DESC, log_index DESC`` (see
``app/routes/portfolio.py::_load_wallet_token_trades``). The existing indexes
``events_trader_idx`` (trader_address) and ``events_token_block_idx``
((token_address, block_number DESC)) each cover only one of the two filter
columns, so Postgres falls back to a bitmap-and + heap scan that degrades on
active wallets.

This adds a single composite index whose leading columns match the equality
predicates and whose trailing columns match the ORDER BY, letting the planner
serve the query as an index-only ordered range scan.

Revision ID: 0007_events_trader_token_idx
Revises: 0006_tokens_is_icon
Create Date: 2026-05-29 14:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0007_events_trader_token_idx"
down_revision: str | None = "0006_tokens_is_icon"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ``IF NOT EXISTS`` keeps the migration a no-op when the index was already
    # built out-of-band. On a hot ``events`` table (keeper writes every ~5s),
    # the plain ``CREATE INDEX`` below holds a SHARE lock for the build's
    # duration; at MVP volume that is sub-second and acceptable. If ``events``
    # grows large, build it first with
    # ``CREATE INDEX CONCURRENTLY events_trader_token_block_idx ON events
    #  (trader_address, token_address, block_number DESC, log_index DESC);``
    # (outside any transaction) before deploying — this migration then no-ops.
    op.execute(
        "CREATE INDEX IF NOT EXISTS events_trader_token_block_idx "
        "ON events (trader_address, token_address, block_number DESC, log_index DESC);"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS events_trader_token_block_idx;")
