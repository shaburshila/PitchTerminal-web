"""Integration test setup — talks to a real Postgres instance.

Sets ``DATABASE_URL`` to the local Postgres (see ``infra/docker-compose.yml``)
unless ``TEST_DATABASE_URL`` is set. Tests are skipped if the DB is unreachable
so CI without DB doesn't hard-fail.

The seed script is intentionally independent of ``shared.config``/``shared.db``,
so no pool reset is needed here.
"""

from __future__ import annotations

import os
from collections.abc import Iterator

# Override the stub URL from the top-level conftest before any test runs.
os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL", "postgresql://pt:pt@localhost:5432/pt"
)

import psycopg
import pytest


def _db_is_up() -> bool:
    try:
        with (
            psycopg.connect(os.environ["DATABASE_URL"], connect_timeout=2) as conn,
            conn.cursor() as cur,
        ):
            cur.execute("SELECT 1")
        return True
    except Exception:
        return False


_DB_AVAILABLE = _db_is_up()


@pytest.fixture(autouse=True)
def _require_db() -> None:
    if not _DB_AVAILABLE:
        pytest.skip("Postgres not reachable at DATABASE_URL — skipping integration test")


@pytest.fixture(autouse=True)
def _clean_tokens_table() -> Iterator[None]:
    """Truncate `tokens` (and dependent rows via CASCADE) before each test."""

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        with conn.cursor() as cur:
            cur.execute("TRUNCATE TABLE tokens CASCADE")
            # dex_pitch_trades has no FK to tokens (PITCH/WETH/USDC are not
            # token rows), so CASCADE does not reach it — truncate explicitly
            # or external-flow rows would leak across tests.
            cur.execute("TRUNCATE TABLE dex_pitch_trades")
        conn.commit()
    # The chart endpoint keeps a short-lived in-process event cache keyed by
    # token address (see app.routes.tokens._chart_events_cache). It survives the
    # DB truncate, so clear it between tests or one test's events would leak
    # into another reusing the same address within the TTL window.
    from app.routes import tokens as _tokens_routes

    _tokens_routes._chart_events_cache.clear()
    yield
