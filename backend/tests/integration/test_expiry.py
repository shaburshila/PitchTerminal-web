"""Integration tests for :mod:`worker.expiry` (B2.4 expiry cycle).

Exercises the real UPDATE … RETURNING against a live Postgres so we verify
the partial index ``limit_orders_expiring_idx`` predicate matches our WHERE
clause and the row state transitions correctly. The ``notify`` call is
mocked so the test doesn't require a parallel LISTEN-er.

Layout follows ``test_orders.py``: clean ``limit_orders`` between tests,
seed one country token to satisfy the FK on ``token_address``.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import psycopg
import pytest
from psycopg.rows import dict_row

from worker import expiry

# Fixed deterministic addresses for the test rows.
_OWNER_ADDR = "0x" + "11" * 20
_COUNTRY_ADDR = "0x" + "aa" * 20
# A valid 64-hex nonce template — tests fill the last 2 chars with their index.
# Base = "0x" + 62 hex chars; we append 2 hex chars per row → 64 total. The DB
# constraint is ``nonce ~ '^0x[0-9a-f]{64}$'``.
_NONCE_BASE = "0x" + "cd" * 31  # 62 hex chars after the 0x


def _nonce(idx: int) -> str:
    """Generate a unique nonce per test row (avoids unique-constraint clash)."""

    # Two hex digits at the tail — supports up to 256 rows per test, plenty.
    return _NONCE_BASE + f"{idx % 256:02x}"


@pytest.fixture(autouse=True)
def _seed_country(_clean_tokens_table) -> Iterator[None]:
    """Insert a single country token so limit_orders FK is satisfied."""

    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO tokens (address, name, symbol, kind, country_address, role) "
                "VALUES (%s, 'Brazil', 'BRA', 'country', NULL, NULL)",
                (_COUNTRY_ADDR,),
            )
        conn.commit()
    yield


@pytest.fixture(autouse=True)
def _clean_orders() -> Iterator[None]:
    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM limit_orders")
        conn.commit()
    yield


def _insert_order(
    *,
    status: str = "pending",
    expires_in_sec: int | None = None,
    nonce_idx: int = 0,
) -> int:
    """Insert one limit_order; return its id.

    Args:
        status: starting ``status`` enum value.
        expires_in_sec: offset from ``now()`` for ``expires_at`` (signed; can
            be negative). ``None`` means ``expires_at IS NULL`` (no expiry).
        nonce_idx: distinct per row to satisfy ``unique (owner, nonce)``.
    """

    if expires_in_sec is None:
        expires_clause = "NULL"
        params: tuple[Any, ...] = (
            _OWNER_ADDR,
            _COUNTRY_ADDR,
            _COUNTRY_ADDR,
            "country",
            "limit-buy",
            1,
            1,
            100,
            _nonce(nonce_idx),
            b"\x00" * 65,
            status,
        )
    else:
        expires_clause = "now() + make_interval(secs => %s)"
        params = (
            _OWNER_ADDR,
            _COUNTRY_ADDR,
            _COUNTRY_ADDR,
            "country",
            "limit-buy",
            1,
            1,
            100,
            expires_in_sec,
            _nonce(nonce_idx),
            b"\x00" * 65,
            status,
        )

    sql = (
        "INSERT INTO limit_orders ("
        " owner_address, token_address, quote_address, venue, side, "
        " target_price, amount_in, slippage_bps, expires_at, nonce, signature, status"
        f") VALUES (%s,%s,%s,%s,%s,%s,%s,%s,{expires_clause},%s,%s,%s) RETURNING id"
    )

    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            row = cur.fetchone()
            assert row is not None
            order_id = int(row["id"])
        conn.commit()
    return order_id


def _status_of(order_id: int) -> str | None:
    with (
        psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn,
        conn.cursor() as cur,
    ):
        cur.execute("SELECT status FROM limit_orders WHERE id = %s", (order_id,))
        row = cur.fetchone()
        return row["status"] if row else None


class TestExpiryTick:
    def test_pending_past_expiry_is_marked_expired_and_notified(self) -> None:
        oid = _insert_order(expires_in_sec=-5, nonce_idx=1)

        notify_calls: list[tuple[str, str]] = []
        with patch.object(
            expiry,
            "notify",
            side_effect=lambda ch, payload: notify_calls.append((ch, payload)),
        ):
            count = expiry.tick()

        assert count == 1
        assert _status_of(oid) == "expired"
        assert notify_calls == [("pt_orders", str(oid))]

    def test_pending_future_expiry_untouched(self) -> None:
        oid = _insert_order(expires_in_sec=3600, nonce_idx=2)

        notify_calls: list[tuple[str, str]] = []
        with patch.object(
            expiry,
            "notify",
            side_effect=lambda ch, payload: notify_calls.append((ch, payload)),
        ):
            count = expiry.tick()

        assert count == 0
        assert _status_of(oid) == "pending"
        assert notify_calls == []

    def test_pending_no_expiry_untouched(self) -> None:
        """``expires_at IS NULL`` means "never expire" — must be skipped."""

        oid = _insert_order(expires_in_sec=None, nonce_idx=3)
        with patch.object(expiry, "notify", side_effect=lambda *_a, **_kw: None):
            count = expiry.tick()
        assert count == 0
        assert _status_of(oid) == "pending"

    def test_non_pending_with_past_expiry_untouched(self) -> None:
        """Filled / cancelled / failed / expired must NOT be re-touched."""

        ids: dict[str, int] = {}
        for i, status in enumerate(["cancelled", "expired"], start=10):
            ids[status] = _insert_order(
                status=status,
                expires_in_sec=-30,
                nonce_idx=i,
            )

        notify_calls: list[tuple[str, str]] = []
        with patch.object(
            expiry,
            "notify",
            side_effect=lambda ch, payload: notify_calls.append((ch, payload)),
        ):
            count = expiry.tick()

        assert count == 0
        for status, oid in ids.items():
            assert _status_of(oid) == status, f"{status} order was unexpectedly touched"
        assert notify_calls == []

    def test_batch_expires_multiple_orders(self) -> None:
        oid_a = _insert_order(expires_in_sec=-10, nonce_idx=20)
        oid_b = _insert_order(expires_in_sec=-20, nonce_idx=21)
        oid_c = _insert_order(expires_in_sec=3600, nonce_idx=22)  # control — fresh

        notify_calls: list[tuple[str, str]] = []
        with patch.object(
            expiry,
            "notify",
            side_effect=lambda ch, payload: notify_calls.append((ch, payload)),
        ):
            count = expiry.tick()

        assert count == 2
        assert _status_of(oid_a) == "expired"
        assert _status_of(oid_b) == "expired"
        assert _status_of(oid_c) == "pending"
        # NOTIFY emitted once per id (order not guaranteed).
        payloads = sorted(p for _ch, p in notify_calls)
        assert payloads == sorted([str(oid_a), str(oid_b)])
