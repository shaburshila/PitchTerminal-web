"""Integration tests for ``scripts.seed_tokens``.

Talks to the real Postgres instance defined by ``DATABASE_URL`` (see
``backend/tests/integration/conftest.py``). The ``tokens`` table is
truncated before each test.
"""

from __future__ import annotations

import os
from pathlib import Path

import psycopg
import pytest

from scripts import seed_tokens

_TOKENS_JSON = Path(__file__).resolve().parents[2] / "data" / "tokens.json"


def _connect() -> psycopg.Connection:
    return psycopg.connect(os.environ["DATABASE_URL"])


def test_tokens_json_present() -> None:
    """Sanity: the seed JSON exists where the script expects it."""

    assert _TOKENS_JSON.is_file(), f"missing seed file: {_TOKENS_JSON}"


def test_seed_inserts_countries_and_players() -> None:
    counts = seed_tokens.seed(_TOKENS_JSON)

    assert counts.inserted_countries == 48
    assert counts.inserted_players == 144
    assert counts.skipped_countries == 0
    assert counts.skipped_players == 0

    with _connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM tokens WHERE kind='country'")
        row = cur.fetchone()
        assert row is not None
        assert row[0] == 48

        cur.execute("SELECT COUNT(*) FROM tokens WHERE kind='player'")
        row = cur.fetchone()
        assert row is not None
        assert row[0] == 144

        # Country rows must have NULL country_address & NULL role.
        cur.execute(
            "SELECT COUNT(*) FROM tokens "
            "WHERE kind='country' AND country_address IS NULL AND role IS NULL"
        )
        row = cur.fetchone()
        assert row is not None
        assert row[0] == 48

        # Every player must point to one of the 48 countries; 48 distinct.
        cur.execute(
            "SELECT COUNT(DISTINCT country_address) FROM tokens WHERE kind='player'"
        )
        row = cur.fetchone()
        assert row is not None
        assert row[0] == 48


def test_seed_is_idempotent() -> None:
    first = seed_tokens.seed(_TOKENS_JSON)
    second = seed_tokens.seed(_TOKENS_JSON)

    assert first.inserted_countries == 48
    assert first.inserted_players == 144

    # Second run: nothing new, everything skipped.
    assert second.inserted_countries == 0
    assert second.inserted_players == 0
    assert second.skipped_countries == 48
    assert second.skipped_players == 144

    with _connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM tokens")
        row = cur.fetchone()
        assert row is not None
        assert row[0] == 48 + 144


def test_all_player_country_addresses_are_valid() -> None:
    seed_tokens.seed(_TOKENS_JSON)
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT COUNT(*) FROM tokens WHERE kind='player' "
            "AND country_address NOT IN (SELECT address FROM tokens WHERE kind='country')"
        )
        row = cur.fetchone()
        assert row is not None
        assert row[0] == 0


def test_all_addresses_lowercase() -> None:
    seed_tokens.seed(_TOKENS_JSON)
    with _connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM tokens WHERE address ~ '[A-F]'")
        row = cur.fetchone()
        assert row is not None
        assert row[0] == 0

        cur.execute(
            "SELECT COUNT(*) FROM tokens WHERE country_address IS NOT NULL "
            "AND country_address ~ '[A-F]'"
        )
        row = cur.fetchone()
        assert row is not None
        assert row[0] == 0


def test_dry_run_does_not_write() -> None:
    counts = seed_tokens.seed(_TOKENS_JSON, dry_run=True)
    assert counts.inserted_countries == 0
    assert counts.inserted_players == 0

    with _connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM tokens")
        row = cur.fetchone()
        assert row is not None
        assert row[0] == 0


def test_seed_rejects_unknown_country_symbol() -> None:
    bad = {
        "countries": [
            {"id": 0, "symbol": "USA", "name": "USA",
             "address": "0x" + "1" * 40},
        ],
        "players": [
            {"symbol": "X", "name": "X", "address": "0x" + "2" * 40,
             "country": "ZZZ", "role": "best"},
        ],
    }
    with pytest.raises(ValueError, match="unknown country symbol"):
        seed_tokens.seed_from_data(bad)


def test_seed_rejects_invalid_role() -> None:
    bad = {
        "countries": [
            {"id": 0, "symbol": "USA", "name": "USA",
             "address": "0x" + "1" * 40},
        ],
        "players": [
            {"symbol": "X", "name": "X", "address": "0x" + "2" * 40,
             "country": "USA", "role": "legend"},
        ],
    }
    with pytest.raises(ValueError, match="invalid role"):
        seed_tokens.seed_from_data(bad)
