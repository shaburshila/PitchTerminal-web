"""Integration tests for :func:`shared.price.price_at_pitch`.

Hits the real Postgres (depends on the ``_clean_tokens_table`` autouse fixture
in ``tests/integration/conftest.py``). The function is DB-backed by design —
unit testing with a mocked ``fetch_one`` would just reproduce the SQL string
and miss the actual behaviour we care about (ts-ordering across the events
table with mixed players + countries).
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from typing import ClassVar

import psycopg
import pytest

from shared.config import WEI
from shared.price import HistoricalPrices, load_price_timelines, price_at_pitch

_COUNTRY = "0x" + "11" * 20
_PLAYER = "0x" + "22" * 20

# Three reference timestamps spaced 100s apart so we can pick "between" points.
_T1 = 1_700_000_000
_T2 = _T1 + 100
_T3 = _T2 + 100


@pytest.fixture(autouse=True)
def _seed() -> Iterator[None]:
    """Seed: 1 country + 1 player, plus a market_state row used as the
    last-ditch fallback in :func:`price_at_pitch`.
    """

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO tokens (address, name, symbol, kind, country_address, role) "
                "VALUES (%s, 'Brazil', 'BRA', 'country', NULL, NULL)",
                (_COUNTRY,),
            )
            cur.execute(
                "INSERT INTO tokens (address, name, symbol, kind, country_address, role) "
                "VALUES (%s, 'Pele', 'PEL', 'player', %s, 'captain')",
                (_PLAYER, _COUNTRY),
            )
            # market_state rows used only as the fallback when no events exist.
            # Schema: (token_address, price_country, price_pitch, supply).
            cur.execute(
                "INSERT INTO market_state (token_address, price_country, price_pitch, supply) "
                "VALUES (%s, 0, %s, %s)",
                (_COUNTRY, 100 * WEI, 50 * WEI),  # price_pitch=100, supply=50
            )
            cur.execute(
                "INSERT INTO market_state (token_address, price_country, price_pitch, supply) "
                "VALUES (%s, %s, %s, %s)",
                (_PLAYER, 88 * WEI, 999 * WEI, 50 * WEI),
            )
        conn.commit()
    yield


def _insert_event(
    block: int,
    token: str,
    side: str,
    base_value: int,
    token_value: int,
    fee: int,
    ts: int,
) -> None:
    tx_hash = "0x" + f"{block:064x}"
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO events "
                "(block_number, tx_hash, log_index, token_address, side, trader_address, "
                " base_value, token_value, fee, ts) "
                "VALUES (%s, %s, 0, %s, %s, %s, %s, %s, %s, to_timestamp(%s))",
                (block, tx_hash, token, side, "0x" + "aa" * 20, base_value, token_value, fee, ts),
            )
        conn.commit()


class TestCountryHistorical:
    def test_returns_nearest_prior_event_price(self) -> None:
        # T1: country priced 2 PITCH (10 PITCH / 5 tokens).
        # T2: country priced 4 PITCH (20 PITCH / 5 tokens).
        # T3: country priced 6 PITCH.
        _insert_event(100, _COUNTRY, "buy", 10 * WEI, 5 * WEI, 0, _T1)
        _insert_event(101, _COUNTRY, "buy", 20 * WEI, 5 * WEI, 0, _T2)
        _insert_event(102, _COUNTRY, "buy", 30 * WEI, 5 * WEI, 0, _T3)

        # Exactly at T2 → uses T2 event price (4 PITCH).
        assert price_at_pitch(_COUNTRY, "country", None, _T2) == pytest.approx(4.0)
        # Between T1 and T2 (T1+50) → still T1's price (step function).
        assert price_at_pitch(_COUNTRY, "country", None, _T1 + 50) == pytest.approx(2.0)
        # After T3 → uses T3 event price.
        assert price_at_pitch(_COUNTRY, "country", None, _T3 + 1000) == pytest.approx(6.0)

    def test_before_earliest_event_falls_back_to_earliest(self) -> None:
        _insert_event(100, _COUNTRY, "buy", 10 * WEI, 5 * WEI, 0, _T2)
        # Query at T1 (before the only event) → returns earliest event price.
        assert price_at_pitch(_COUNTRY, "country", None, _T1) == pytest.approx(2.0)

    def test_no_history_falls_back_to_market_state(self) -> None:
        # Seed has no events for _COUNTRY, market_state.price_pitch = 100.
        assert price_at_pitch(_COUNTRY, "country", None, _T1) == pytest.approx(100.0)

    def test_fee_excluded_in_buy(self) -> None:
        # Buy: 10 PITCH gross, 1 PITCH fee, 5 tokens → curve price = 9/5 = 1.8.
        _insert_event(100, _COUNTRY, "buy", 10 * WEI, 5 * WEI, 1 * WEI, _T1)
        assert price_at_pitch(_COUNTRY, "country", None, _T1) == pytest.approx(1.8)


class TestPlayerHistorical:
    def test_price_chain_uses_country_price_at_ts(self) -> None:
        # T1: country at 2 PITCH, player at 3 country-units (= 6 PITCH).
        # T2: country at 4 PITCH, player at 2 country-units (= 8 PITCH).
        _insert_event(100, _COUNTRY, "buy", 10 * WEI, 5 * WEI, 0, _T1)
        _insert_event(101, _PLAYER, "buy", 15 * WEI, 5 * WEI, 0, _T1)  # 3 country/token
        _insert_event(200, _COUNTRY, "buy", 20 * WEI, 5 * WEI, 0, _T2)
        _insert_event(201, _PLAYER, "buy", 10 * WEI, 5 * WEI, 0, _T2)  # 2 country/token

        assert price_at_pitch(_PLAYER, "player", _COUNTRY, _T1) == pytest.approx(6.0)
        assert price_at_pitch(_PLAYER, "player", _COUNTRY, _T2) == pytest.approx(8.0)
        # Halfway between T1 and T2 → uses T1 prices (step).
        assert price_at_pitch(_PLAYER, "player", _COUNTRY, _T1 + 50) == pytest.approx(6.0)

    def test_player_with_no_country_address_returns_zero(self) -> None:
        # Defensive: player passed without country address can't be valued.
        _insert_event(100, _PLAYER, "buy", 10 * WEI, 5 * WEI, 0, _T1)
        assert price_at_pitch(_PLAYER, "player", None, _T1) == 0.0


class TestHistoricalPricesResolver:
    """:class:`HistoricalPrices` must return *exactly* the same value as the
    per-call :func:`price_at_pitch` for every (token, ts) — it's the batched
    in-memory equivalent that backs the ``valueSeries`` hot path (audit P1).
    The seed's ``market_state`` rows give the fallback map (country=100,
    player=999 PITCH)."""

    _FALLBACK: ClassVar[dict[str, float]] = {_COUNTRY: 100.0, _PLAYER: 999.0}

    def _resolver(self) -> HistoricalPrices:
        return HistoricalPrices(
            load_price_timelines([_COUNTRY, _PLAYER]),
            dict(self._FALLBACK),
        )

    def test_matches_country_step_function(self) -> None:
        _insert_event(100, _COUNTRY, "buy", 10 * WEI, 5 * WEI, 0, _T1)
        _insert_event(101, _COUNTRY, "buy", 20 * WEI, 5 * WEI, 0, _T2)
        _insert_event(102, _COUNTRY, "buy", 30 * WEI, 5 * WEI, 0, _T3)
        hist = self._resolver()
        for ts in (_T1 - 50, _T1, _T1 + 50, _T2, _T2 + 50, _T3, _T3 + 1000):
            assert hist.price_at_pitch(_COUNTRY, "country", None, ts) == pytest.approx(
                price_at_pitch(_COUNTRY, "country", None, ts)
            )

    def test_matches_before_earliest(self) -> None:
        _insert_event(100, _COUNTRY, "buy", 10 * WEI, 5 * WEI, 0, _T2)
        hist = self._resolver()
        assert hist.price_at_pitch(_COUNTRY, "country", None, _T1) == pytest.approx(2.0)
        assert hist.price_at_pitch(_COUNTRY, "country", None, _T1) == pytest.approx(
            price_at_pitch(_COUNTRY, "country", None, _T1)
        )

    def test_matches_no_history_fallback(self) -> None:
        # No events seeded → both paths degrade to market_state.price_pitch=100.
        hist = self._resolver()
        assert hist.price_at_pitch(_COUNTRY, "country", None, _T1) == pytest.approx(100.0)

    def test_matches_player_price_chain(self) -> None:
        _insert_event(100, _COUNTRY, "buy", 10 * WEI, 5 * WEI, 0, _T1)
        _insert_event(101, _PLAYER, "buy", 15 * WEI, 5 * WEI, 0, _T1)
        _insert_event(200, _COUNTRY, "buy", 20 * WEI, 5 * WEI, 0, _T2)
        _insert_event(201, _PLAYER, "buy", 10 * WEI, 5 * WEI, 0, _T2)
        hist = self._resolver()
        for ts in (_T1, _T1 + 50, _T2, _T2 + 100):
            assert hist.price_at_pitch(_PLAYER, "player", _COUNTRY, ts) == pytest.approx(
                price_at_pitch(_PLAYER, "player", _COUNTRY, ts)
            )

    def test_player_with_no_country_address_returns_zero(self) -> None:
        _insert_event(100, _PLAYER, "buy", 10 * WEI, 5 * WEI, 0, _T1)
        hist = self._resolver()
        assert hist.price_at_pitch(_PLAYER, "player", None, _T1) == 0.0

    def test_empty_token_set_returns_empty(self) -> None:
        assert load_price_timelines([]) == {}
