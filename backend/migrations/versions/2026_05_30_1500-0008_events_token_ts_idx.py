"""events: (token_address, ts DESC) index for historical ts-range lookups

Perf fix (events audit P4 — enabler for P1/P2). Several hot queries filter
``WHERE token_address = %s AND ts <= ...`` and order by ``ts``:

* ``shared.price._nearest_event_base_per_token`` / ``_earliest_event_base_per_token``
  back the ``/api/v1/profile`` ``valueSeries`` historical sampling.
* ``worker.price_loop`` change-percent period queries select the latest event
  at-or-before each cutoff timestamp.

The existing indexes only cover ``(token_address, block_number DESC)`` and
``(block_number DESC)`` — neither serves a ``ts`` predicate, so Postgres scans
the whole per-token range and sorts. A ``(token_address, ts DESC)`` index lets
the planner serve those as index range scans.

Revision ID: 0008_events_token_ts_idx
Revises: 0007_events_trader_token_idx
Create Date: 2026-05-30 15:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0008_events_token_ts_idx"
down_revision: str | None = "0007_events_trader_token_idx"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ``IF NOT EXISTS`` keeps the migration a no-op when the index was already
    # built out-of-band. On a hot ``events`` table (keeper writes every ~5s),
    # the plain ``CREATE INDEX`` below holds a SHARE lock for the build's
    # duration; at MVP volume that is sub-second and acceptable. If ``events``
    # grows large, build it first with
    # ``CREATE INDEX CONCURRENTLY events_token_ts_idx ON events
    #  (token_address, ts DESC);``
    # (outside any transaction) before deploying — this migration then no-ops.
    op.execute("CREATE INDEX IF NOT EXISTS events_token_ts_idx ON events (token_address, ts DESC);")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS events_token_ts_idx;")
