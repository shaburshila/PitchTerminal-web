"""Integration test for :mod:`worker.nonces`.

Inserts a fresh nonce and a stale (15-minute-old) nonce, runs ``cleanup()``,
and asserts only the stale one is gone.
"""

from __future__ import annotations

import os

import psycopg

from worker import nonces


def _insert_nonce(value: str, *, age_minutes: int) -> None:
    sql = (
        "INSERT INTO auth_nonces (nonce, created_at) "
        "VALUES (%s, now() - make_interval(mins => %s))"
    )
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute(sql, (value, age_minutes))
        conn.commit()


def _count_nonce(value: str) -> int:
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM auth_nonces WHERE nonce = %s", (value,))
        row = cur.fetchone()
        return int(row[0]) if row else 0


def test_cleanup_removes_stale_keeps_fresh() -> None:
    fresh = "test_fresh_nonce_12345"
    stale = "test_stale_nonce_67890"

    _insert_nonce(fresh, age_minutes=2)
    _insert_nonce(stale, age_minutes=15)

    nonces.cleanup()

    assert _count_nonce(fresh) == 1
    assert _count_nonce(stale) == 0

    # Cleanup behind us — leave the DB clean.
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM auth_nonces WHERE nonce IN (%s, %s)", (fresh, stale))
        conn.commit()


def test_cleanup_is_safe_on_empty_table() -> None:
    """No nonces present → cleanup must not raise."""

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM auth_nonces")
        conn.commit()

    # Should not raise.
    nonces.cleanup()
