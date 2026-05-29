"""Integration tests for the batched ``events`` reads in ``worker.price_loop``.

These cover the events-audit-P2 rewrite: the per-token ``COUNT(*)`` /
holders / change-pct-reference queries were replaced by table-wide batched
queries (``GROUP BY`` and ``DISTINCT ON``). The tick loop itself early-returns
without hook config, so the batch helpers are not otherwise exercised — these
tests lock their semantics directly against a seeded ``events`` table.
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import psycopg
import pytest

from shared.config import WEI
from worker.price_loop import (
    _change_pct,
    _holders_counts_all,
    _load_period_then_prices,
    _trades_counts_all,
)

_COUNTRY = "0x" + "33" * 20
_PLAYER = "0x" + "44" * 20

_T1 = 1_700_000_000
_T2 = _T1 + 100


@pytest.fixture(autouse=True)
def _seed() -> Iterator[None]:
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO tokens (address, name, symbol, kind, country_address, role) "
            "VALUES (%s, 'Spain', 'ESP', 'country', NULL, NULL)",
            (_COUNTRY,),
        )
        cur.execute(
            "INSERT INTO tokens (address, name, symbol, kind, country_address, role) "
            "VALUES (%s, 'Nadal', 'NAD', 'player', %s, 'captain')",
            (_PLAYER, _COUNTRY),
        )
        conn.commit()
    yield


def _insert(
    block: int,
    token: str,
    trader: str,
    side: str,
    base_value: int,
    token_value: int,
    ts: int,
    log_index: int = 0,
) -> None:
    tx_hash = "0x" + f"{block * 100 + log_index:064x}"
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO events "
            "(block_number, tx_hash, log_index, token_address, side, trader_address, "
            " base_value, token_value, fee, ts) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 0, to_timestamp(%s))",
            (block, tx_hash, log_index, token, side, trader, base_value, token_value, ts),
        )
        conn.commit()


_ALICE = "0x" + "a1" * 20
_BOB = "0x" + "b2" * 20


def test_trades_counts_all_groups_per_token() -> None:
    _insert(1, _COUNTRY, _ALICE, "buy", 10 * WEI, 5 * WEI, _T1)
    _insert(2, _COUNTRY, _BOB, "buy", 10 * WEI, 5 * WEI, _T2)
    _insert(3, _PLAYER, _ALICE, "buy", 4 * WEI, 2 * WEI, _T2)

    counts = _trades_counts_all()
    assert counts[_COUNTRY] == 2
    assert counts[_PLAYER] == 1
    # A token with no events is simply absent (caller defaults to 0).
    assert "0x" + "99" * 20 not in counts


def test_holders_counts_all_only_net_positive() -> None:
    # Alice ends net-positive on the country (buy 5, sell 2 → +3).
    _insert(1, _COUNTRY, _ALICE, "buy", 10 * WEI, 5 * WEI, _T1)
    _insert(2, _COUNTRY, _ALICE, "sell", 4 * WEI, 2 * WEI, _T2, log_index=1)
    # Bob fully exits (buy 5, sell 5 → 0) → not a holder.
    _insert(3, _COUNTRY, _BOB, "buy", 10 * WEI, 5 * WEI, _T1, log_index=2)
    _insert(4, _COUNTRY, _BOB, "sell", 10 * WEI, 5 * WEI, _T2, log_index=3)

    holders = _holders_counts_all()
    assert holders[_COUNTRY] == 1  # only Alice


def test_load_period_then_prices_all_is_earliest() -> None:
    # Two country events: earliest at 2 PITCH, latest at 4 PITCH.
    _insert(1, _COUNTRY, _ALICE, "buy", 10 * WEI, 5 * WEI, _T1)  # 2.0
    _insert(2, _COUNTRY, _ALICE, "buy", 20 * WEI, 5 * WEI, _T2, log_index=1)  # 4.0

    then = _load_period_then_prices()
    # 'all' references the very first event ever → 2.0.
    assert then[_COUNTRY]["all"] == pytest.approx(2.0)


def test_load_period_then_prices_time_window_picks_latest_before_cutoff() -> None:
    # One event well in the past (within every window), one "now-ish".
    import time

    now = int(time.time())
    old = now - 2 * 3600  # 2h ago: inside the 1d window, outside the 1h window
    _insert(1, _COUNTRY, _ALICE, "buy", 10 * WEI, 5 * WEI, old)  # 2.0

    then = _load_period_then_prices().get(_COUNTRY, {})
    # 1d cutoff = now-24h; the 2h-old event satisfies ts <= cutoff? No — cutoff
    # is 24h ago, event is 2h ago, so event is NEWER than cutoff → not counted.
    # The 'all' reference is always present though.
    assert then["all"] == pytest.approx(2.0)
    # No event older than 1h ago besides this 2h-old one → 1h window references it.
    assert then["1h"] == pytest.approx(2.0)
    # 15m window cutoff = 15m ago; the 2h-old event is older → referenced.
    assert then["15m"] == pytest.approx(2.0)
    # 1d window cutoff = 24h ago; no event that old → absent.
    assert "1d" not in then


def test_change_pct_is_pure() -> None:
    # p_now = 6, p_then(all) = 2 → +200%. Country multiplier 1.0.
    out = _change_pct(6.0, {"all": 2.0, "1h": 3.0}, 1.0)
    assert out["all"] == pytest.approx(200.0)
    assert out["1h"] == pytest.approx(100.0)
    # Missing period → 0.0.
    assert out["1d"] == 0.0
    # p_now <= 0 → all zeros.
    assert all(v == 0.0 for v in _change_pct(0.0, {"all": 2.0}, 1.0).values())


def test_change_pct_player_country_multiplier() -> None:
    # Player native p_then = 3 country-units, country now = 2 PITCH → p_then=6.
    # p_now_pitch = 12 → +100%.
    out = _change_pct(12.0, {"all": 3.0}, 2.0)
    assert out["all"] == pytest.approx(100.0)
