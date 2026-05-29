"""tokens.is_icon flag (icon-pack venue marker)

Adds a boolean ``is_icon`` to ``tokens``. Icon-pack tokens are stored as
``kind='player'`` (they trade against their country like players) but live on
a separate pitchwc ``IconCurveHook`` / router. The flag flips only the venue
addresses (hook / router / limit-order executor) downstream — it does NOT
introduce a new ``token_kind``, so every existing ``kind='player'`` branch
keeps working unchanged.

DDL only — no data inserts. On a fresh DB the api container runs
``alembic upgrade head`` BEFORE the worker seeds ``tokens``; inserting icon
rows here would violate the deferred country FK (country rows don't exist
yet). The 11 icon rows are inserted idempotently by the seeder
(``scripts/seed_tokens.py`` via ``worker/seed_tokens.ensure_seeded``).

Revision ID: 0006_tokens_is_icon
Revises: 0005_auth_nonces_address
Create Date: 2026-05-29 12:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0006_tokens_is_icon"
down_revision: str | None = "0005_auth_nonces_address"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE tokens ADD COLUMN is_icon BOOLEAN NOT NULL DEFAULT FALSE")


def downgrade() -> None:
    op.execute("ALTER TABLE tokens DROP COLUMN IF EXISTS is_icon")
