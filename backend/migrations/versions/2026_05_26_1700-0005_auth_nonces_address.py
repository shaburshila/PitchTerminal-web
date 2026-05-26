"""auth_nonces: bind nonce to a wallet address (anti pre-harvesting)

Security fix (medium #5): previously ``POST /api/v1/auth/nonce`` was
unauthenticated and the resulting nonce was not tied to any address. An
attacker could pre-harvest a bag of valid nonces, build a phishing page that
re-uses our exact ``domain`` / ``uri`` / ``chainId`` / ``statement``, and trick
a victim into signing a SIWE message that includes one of the harvested
nonces. The attacker would then POST the captured signature to
``/auth/verify`` and obtain a JWT for the victim's wallet.

Fix: the client must declare the address it intends to sign with at
nonce-issue time. The address is persisted next to the nonce and the
``_consume_nonce_atomic`` step in ``shared/siwe.py`` does a single
``DELETE ... WHERE nonce = %s AND address = %s`` so a captured nonce is
only redeemable by the originally-declared signer.

We add the column as ``NULL``-able for backward compatibility with the (at
most 5-minute) window of in-flight nonces that were issued before this
migration ran. Once those expire (5 min TTL, cleanup worker sweeps stale
rows every minute) every live row will have the column populated by the new
application code. The application logic itself treats a missing address as
"reject this nonce" — see ``_consume_nonce_atomic``.

Revision ID: 0005_auth_nonces_address
Revises: 0004_display_target_price
Create Date: 2026-05-26 17:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0005_auth_nonces_address"
down_revision: str | None = "0004_display_target_price"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Column is nullable for the brief overlap window. New rows inserted by
    # `shared.siwe.make_nonce` (post-deploy) are always populated. The check
    # constraint enforces the lowercase 0x-prefixed shape used across the
    # project whenever the value IS populated.
    op.execute(
        "ALTER TABLE auth_nonces "
        "ADD COLUMN address CHAR(42) NULL "
        "    CHECK (address IS NULL OR address ~ '^0x[0-9a-f]{40}$')"
    )
    # Composite lookups by (nonce, address) are PK-driven on `nonce` already,
    # but we add an index on `address` alone so the worker's stale-row cleanup
    # can attribute orphans by wallet if needed in the future. Keeping it
    # cheap — auth_nonces is a tiny table (TTL 5 min).
    op.execute("CREATE INDEX auth_nonces_address_idx ON auth_nonces(address)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS auth_nonces_address_idx")
    op.execute("ALTER TABLE auth_nonces DROP COLUMN IF EXISTS address")
