"""order_status: rename 'pending' value to 'open'

UX rename — "pending" misled users into thinking the order was being
processed; the actual state is "armed, waiting for the trigger condition".
The new value ``'open'`` reflects that.

Postgres 10+ supports ``ALTER TYPE ... RENAME VALUE`` natively — no data
migration is needed because the enum's on-disk representation is its
position, not its label. All existing rows transparently report the new
name after the ALTER. The two partial indexes whose predicates literally
spell ``status='pending'`` are dropped + recreated against the new label so
the planner keeps using them after the rename (Postgres does NOT rewrite
WHERE clauses on ``RENAME VALUE``).

Revision ID: 0003_order_status_open
Revises: 0002_market_quotes
Create Date: 2026-05-25 21:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0003_order_status_open"
down_revision: str | None = "0002_market_quotes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The two partial indexes from 0001_initial that reference the old label:
    #   limit_orders_pending_idx  — ON (token_address, side) WHERE status='pending'
    #   limit_orders_expiring_idx — ON (expires_at)         WHERE status='pending'
    #                                                         AND expires_at IS NOT NULL
    op.execute("DROP INDEX IF EXISTS limit_orders_pending_idx")
    op.execute("DROP INDEX IF EXISTS limit_orders_expiring_idx")

    op.execute("ALTER TYPE order_status RENAME VALUE 'pending' TO 'open'")

    op.execute(
        "CREATE INDEX limit_orders_pending_idx "
        "ON limit_orders(token_address, side) WHERE status = 'open'"
    )
    op.execute(
        "CREATE INDEX limit_orders_expiring_idx "
        "ON limit_orders(expires_at) "
        "WHERE status = 'open' AND expires_at IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS limit_orders_pending_idx")
    op.execute("DROP INDEX IF EXISTS limit_orders_expiring_idx")

    op.execute("ALTER TYPE order_status RENAME VALUE 'open' TO 'pending'")

    op.execute(
        "CREATE INDEX limit_orders_pending_idx "
        "ON limit_orders(token_address, side) WHERE status = 'pending'"
    )
    op.execute(
        "CREATE INDEX limit_orders_expiring_idx "
        "ON limit_orders(expires_at) "
        "WHERE status = 'pending' AND expires_at IS NOT NULL"
    )
