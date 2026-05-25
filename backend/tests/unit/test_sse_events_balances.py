"""Unit tests for SSE ``event: events`` post-trade balances extension.

Verifies the additive ``balances`` field on the ``newTrades`` payload:

* dedup of (token, trader) pairs across multiple events in one batch;
* clamping of negative net (defensive guard);
* empty-input passthrough.

We patch :func:`app.routes.stream.fetch_all` to control DB row shape without
a live Postgres. Integration coverage of the full producer→stream loop sits
in ``tests/integration/test_sse_stream.py`` (mostly skipped; see file).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from unittest.mock import patch

from app.routes import stream as stream_mod


class TestFetchPostTradeBalances:
    _TOKEN_A = "0x" + "aa" * 20
    _TOKEN_B = "0x" + "bb" * 20
    _TRADER_X = "0x" + "11" * 20
    _TRADER_Y = "0x" + "22" * 20

    def test_empty_input_returns_empty(self) -> None:
        assert stream_mod._fetch_post_trade_balances([]) == []

    def test_dedup_same_pair(self) -> None:
        # Two trades by the same wallet on the same token — single balance row.
        agg_row = {
            "token_address": self._TOKEN_A,
            "trader_address": self._TRADER_X,
            "net_wei": 5 * 10**18,
        }
        with patch.object(stream_mod, "fetch_all", return_value=[agg_row]) as mocked:
            out = stream_mod._fetch_post_trade_balances(
                [
                    (self._TOKEN_A, self._TRADER_X),
                    (self._TOKEN_A, self._TRADER_X),
                ]
            )
        assert out == [{"address": self._TRADER_X, "token": self._TOKEN_A, "wei": str(5 * 10**18)}]
        # Only one DB call regardless of duplicate pairs in the input.
        assert mocked.call_count == 1

    def test_multiple_pairs_round_trip(self) -> None:
        # Two distinct (token, trader) pairs → two output entries.
        rows = [
            {
                "token_address": self._TOKEN_A,
                "trader_address": self._TRADER_X,
                "net_wei": 1 * 10**18,
            },
            {
                "token_address": self._TOKEN_B,
                "trader_address": self._TRADER_Y,
                "net_wei": 2 * 10**18,
            },
        ]
        with patch.object(stream_mod, "fetch_all", return_value=rows):
            out = stream_mod._fetch_post_trade_balances(
                [
                    (self._TOKEN_A, self._TRADER_X),
                    (self._TOKEN_B, self._TRADER_Y),
                ]
            )
        by_pair = {(r["token"], r["address"]): r["wei"] for r in out}
        assert by_pair[(self._TOKEN_A, self._TRADER_X)] == str(10**18)
        assert by_pair[(self._TOKEN_B, self._TRADER_Y)] == str(2 * 10**18)

    def test_negative_clamped_to_zero(self) -> None:
        # Defensive: if events were indexed out-of-order and produce a
        # negative net, we ship "0" — UI never sees a negative balance.
        rows = [
            {
                "token_address": self._TOKEN_A,
                "trader_address": self._TRADER_X,
                "net_wei": -5 * 10**18,
            }
        ]
        with patch.object(stream_mod, "fetch_all", return_value=rows):
            out = stream_mod._fetch_post_trade_balances([(self._TOKEN_A, self._TRADER_X)])
        assert out == [{"address": self._TRADER_X, "token": self._TOKEN_A, "wei": "0"}]

    def test_missing_pair_returns_zero(self) -> None:
        # Caller passes a pair the SQL didn't produce — happens if events
        # vanished between NOTIFY and SELECT (would be a race in practice but
        # we still want a non-null wei field for every requested pair).
        with patch.object(stream_mod, "fetch_all", return_value=[]):
            out = stream_mod._fetch_post_trade_balances([(self._TOKEN_A, self._TRADER_X)])
        assert out == [{"address": self._TRADER_X, "token": self._TOKEN_A, "wei": "0"}]


class TestFetchEventsPayloadShape:
    """Verify that :func:`stream._fetch_events` injects the ``balances`` field."""

    _TOKEN = "0x" + "aa" * 20
    _TRADER = "0x" + "11" * 20

    def _event_row(self) -> dict[str, Any]:
        return {
            "id": 1,
            "token_address": self._TOKEN,
            "side": "buy",
            "trader_address": self._TRADER,
            "base_value": 10**18,
            "token_value": 10**18,
            "fee": 0,
            "tx_hash": "0x" + "ab" * 32,
            "ts": datetime.fromtimestamp(1_700_000_000, tz=UTC),
        }

    def test_empty_ids_returns_empty_balances(self) -> None:
        out = stream_mod._fetch_events([])
        assert out == {"newTrades": [], "balances": []}

    def test_payload_includes_balances_field(self) -> None:
        # First fetch_all call returns events; second returns balance aggregation.
        events_rows = [self._event_row()]
        bal_rows = [
            {
                "token_address": self._TOKEN,
                "trader_address": self._TRADER,
                "net_wei": 10**18,
            }
        ]
        with patch.object(stream_mod, "fetch_all", side_effect=[events_rows, bal_rows]):
            out = stream_mod._fetch_events([1])
        assert "balances" in out
        assert len(out["newTrades"]) == 1
        assert out["balances"] == [
            {"address": self._TRADER, "token": self._TOKEN, "wei": str(10**18)}
        ]

    def test_balances_never_null(self) -> None:
        """Even when the balance aggregation returns nothing (race / dropped row),
        every (token, trader) from the trades carries a non-null wei field."""

        events_rows = [self._event_row()]
        with patch.object(stream_mod, "fetch_all", side_effect=[events_rows, []]):
            out = stream_mod._fetch_events([1])
        assert len(out["balances"]) == 1
        assert out["balances"][0]["wei"] == "0"
        assert out["balances"][0]["address"] == self._TRADER
