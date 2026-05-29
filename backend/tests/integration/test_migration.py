"""Alembic migration round-trip and schema-level constraint tests.

These tests exercise the live Postgres schema:

* ``0001_initial`` survives a downgrade-then-upgrade cycle without leaving
  orphan tables, types, or indexes.
* The ``referral_codes`` CHECK constraints (regex + leading/trailing dash
  rejection + length bounds + UNIQUE owner_address) actually reject the inputs
  they're supposed to reject.

We run ``alembic`` as a subprocess so we don't have to import its private
module-level state — that would conflict with the integration ``conftest``'s
environment overrides.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import psycopg
import pytest

_BACKEND_ROOT = Path(__file__).resolve().parents[2]


def _alembic(*args: str) -> None:
    """Run ``alembic <args>`` from the backend root with DATABASE_URL exported."""

    env = os.environ.copy()
    subprocess.run(
        ["alembic", *args],
        cwd=_BACKEND_ROOT,
        env=env,
        check=True,
        capture_output=True,
    )


def _table_count() -> int:
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'")
        row = cur.fetchone()
        assert row is not None
        return int(row[0])


def _enum_count() -> int:
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT COUNT(DISTINCT t.typname) "
            "FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid "
            "JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace "
            "WHERE n.nspname = 'public'"
        )
        row = cur.fetchone()
        assert row is not None
        return int(row[0])


class TestMigrationRoundTrip:
    """``upgrade head`` → ``downgrade base`` → ``upgrade head`` must be clean."""

    def test_round_trip_leaves_full_schema(self) -> None:
        # Baseline: head should be applied (autouse conftest doesn't touch
        # alembic, so the schema is live from previous runs).
        baseline_tables = _table_count()
        baseline_enums = _enum_count()

        _alembic("downgrade", "base")

        # After downgrade only the alembic_version table should remain.
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'public' ORDER BY table_name"
            )
            tables_after_down = [r[0] for r in cur.fetchall()]
        assert tables_after_down == ["alembic_version"]
        assert _enum_count() == 0

        _alembic("upgrade", "head")

        assert _table_count() == baseline_tables
        assert _enum_count() == baseline_enums

    def test_order_status_open_value_present(self) -> None:
        """Migration 0003 renamed enum value 'pending' → 'open'."""

        with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT enumlabel FROM pg_enum e "
                "JOIN pg_type t ON t.oid = e.enumtypid "
                "WHERE t.typname = 'order_status' "
                "ORDER BY e.enumsortorder"
            )
            labels = [r[0] for r in cur.fetchall()]
        assert "open" in labels
        assert "pending" not in labels
        # Default should also reflect the new label.
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT column_default FROM information_schema.columns "
                "WHERE table_name = 'limit_orders' AND column_name = 'status'"
            )
            row = cur.fetchone()
            assert row is not None
            assert "'open'" in str(row[0])

    def test_display_target_price_column_present(self) -> None:
        """Migration 0004 adds nullable limit_orders.display_target_price."""

        with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT data_type, is_nullable FROM information_schema.columns "
                "WHERE table_name = 'limit_orders' "
                "  AND column_name = 'display_target_price'"
            )
            row = cur.fetchone()
        assert row is not None
        assert row[0] == "numeric"
        assert row[1] == "YES"  # nullable for pre-0004 backwards-compat

    def test_tokens_is_icon_column_present(self) -> None:
        """Migration 0006 adds tokens.is_icon BOOLEAN NOT NULL DEFAULT FALSE."""

        with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT data_type, is_nullable, column_default "
                "FROM information_schema.columns "
                "WHERE table_name = 'tokens' AND column_name = 'is_icon'"
            )
            row = cur.fetchone()
        assert row is not None
        assert row[0] == "boolean"
        assert row[1] == "NO"  # NOT NULL
        assert "false" in str(row[2]).lower()

    def test_referral_codes_table_present_after_upgrade(self) -> None:
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'referral_codes' ORDER BY column_name"
            )
            columns = sorted(r[0] for r in cur.fetchall())
        assert columns == ["claimed_at", "code", "owner_address"]


class TestReferralCodesConstraints:
    """The CHECK constraints on ``referral_codes`` must reject bad input."""

    OWNER = "0x" + "ab" * 20  # 0xababab… valid lowercase address

    def _insert(self, code: str, owner: str | None = None) -> None:
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO referral_codes (code, owner_address) VALUES (%s, %s)",
                (code, owner or self.OWNER),
            )
            conn.commit()

    def _cleanup(self) -> None:
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
            cur.execute("TRUNCATE referral_codes")
            conn.commit()

    def setup_method(self) -> None:
        self._cleanup()

    def teardown_method(self) -> None:
        self._cleanup()

    def test_valid_code_accepted(self) -> None:
        self._insert("alex42")  # baseline — no error

    def test_too_short_rejected(self) -> None:
        with pytest.raises(psycopg.errors.CheckViolation):
            self._insert("abc")  # 3 chars, minimum is 4

    def test_too_long_rejected(self) -> None:
        with pytest.raises(psycopg.errors.CheckViolation):
            self._insert("a" * 33)  # max is 32

    def test_uppercase_rejected(self) -> None:
        with pytest.raises(psycopg.errors.CheckViolation):
            self._insert("Alex42")

    def test_leading_dash_rejected(self) -> None:
        with pytest.raises(psycopg.errors.CheckViolation):
            self._insert("-alex")

    def test_trailing_dash_rejected(self) -> None:
        with pytest.raises(psycopg.errors.CheckViolation):
            self._insert("alex-")

    def test_leading_underscore_rejected(self) -> None:
        with pytest.raises(psycopg.errors.CheckViolation):
            self._insert("_alex")

    def test_trailing_underscore_rejected(self) -> None:
        with pytest.raises(psycopg.errors.CheckViolation):
            self._insert("alex_")

    def test_special_chars_rejected(self) -> None:
        for bad in ("alex 42", "alex.42", "alex/42", "alex@42", "alex+42"):
            with pytest.raises(psycopg.errors.CheckViolation):
                self._insert(bad)
            # Reset autocommit-aborted txn for the next attempt.
            self._cleanup()

    def test_dashes_and_underscores_in_middle_accepted(self) -> None:
        self._insert("al_ex-42")  # allowed

    def test_one_handle_per_owner(self) -> None:
        self._insert("alex42")
        with pytest.raises(psycopg.errors.UniqueViolation):
            self._insert("bob99")  # same owner → UNIQUE(owner_address) violation

    def test_one_owner_per_handle(self) -> None:
        self._insert("alex42", owner="0x" + "11" * 20)
        with pytest.raises(psycopg.errors.UniqueViolation):
            self._insert("alex42", owner="0x" + "22" * 20)  # same code PK
