"""Unit tests for :mod:`shared.chart`."""

from __future__ import annotations

from typing import Any

import pytest

from shared.chart import TF_SECONDS, build_candles, build_points
from shared.config import WEI
from shared.types import Event


def _ev(
    *,
    block: int,
    ts: int,
    side: str = "buy",
    base: int = 110 * WEI,
    token: int = 10 * WEI,
    fee: int = 10 * WEI,  # ⇒ market price = (110-10)/10 = 10  or  (110+10)/10 = 12
    log_index: int = 0,
    trader: str = "0xaaaa000000000000000000000000000000000001",
    token_address: str = "0xbbbb000000000000000000000000000000000002",
) -> Event:
    return {
        "block_number": block,
        "tx_hash": "0x" + "00" * 32,
        "log_index": log_index,
        "token_address": token_address,
        "side": side,  # type: ignore[typeddict-item]
        "trader_address": trader,
        "base_value": base,
        "token_value": token,
        "fee": fee,
        "timestamp": ts,
    }


class TestBuildCandles:
    def test_empty_events_returns_empty(self) -> None:
        assert build_candles([], 300) == []

    def test_single_event_makes_one_candle(self) -> None:
        # base=110, fee=10 buy → market price (110-10)/10 = 10.0
        events = [_ev(block=1, ts=1000)]
        candles = build_candles(events, 300)
        assert len(candles) == 1
        c = candles[0]
        # ts=1000 bucketed at 300s → 900.
        assert c["time"] == 900
        assert c["open"] == 10.0
        assert c["high"] == 10.0
        assert c["low"] == 10.0
        assert c["close"] == 10.0
        # volume = base_value / WEI = 110.0
        assert c["volume"] == 110.0

    def test_multiple_events_same_bucket_aggregate(self) -> None:
        # Two buys at different prices within the same 5m bucket.
        events = [
            _ev(block=1, ts=1000, base=110 * WEI, token=10 * WEI, fee=10 * WEI),  # price 10
            _ev(
                block=2,
                ts=1100,
                base=130 * WEI,  # (130-10)/10 = 12 → high
                token=10 * WEI,
                fee=10 * WEI,
            ),
        ]
        candles = build_candles(events, 300)
        assert len(candles) == 1
        c = candles[0]
        assert c["open"] == 10.0
        assert c["high"] == 12.0
        assert c["low"] == 10.0
        assert c["close"] == 12.0
        assert c["volume"] == 240.0  # 110 + 130

    def test_forward_fill_between_trades(self) -> None:
        # Trades at bucket 0 and bucket 900 (1m timeframe → 15-bucket gap).
        events = [
            _ev(block=1, ts=0, base=110 * WEI, token=10 * WEI, fee=10 * WEI),  # price 10
            _ev(block=2, ts=900, base=130 * WEI, token=10 * WEI, fee=10 * WEI),  # price 12
        ]
        candles = build_candles(events, 60)
        # 0, 60, 120, ..., 900 → 16 candles.
        assert len(candles) == 16
        # Middle buckets are flat-filled at prev_close = 10.
        assert candles[5]["open"] == candles[5]["close"] == 10.0
        assert candles[5]["volume"] == 0.0
        # Final bucket holds the second trade.
        assert candles[-1]["time"] == 900
        assert candles[-1]["close"] == 12.0

    def test_unsorted_input_is_sorted(self) -> None:
        # Lightweight-charts crashes on unsorted setData → must be sorted ASC.
        events = [
            _ev(block=2, ts=1100, base=130 * WEI, token=10 * WEI, fee=10 * WEI),
            _ev(block=1, ts=1000, base=110 * WEI, token=10 * WEI, fee=10 * WEI),
        ]
        candles = build_candles(events, 60)
        times = [c["time"] for c in candles]
        assert times == sorted(times)

    def test_skips_zero_token_events(self) -> None:
        events = [_ev(block=1, ts=1000, token=0)]
        assert build_candles(events, 300) == []

    def test_current_price_extends_to_now_bucket(self) -> None:
        events = [_ev(block=1, ts=1000)]
        candles = build_candles(events, 60, current_price=15.0, now_ts=2000)
        # Last bucket aligns to now_ts.
        assert candles[-1]["time"] == 1980
        assert candles[-1]["close"] == 15.0

    def test_invalid_timeframe_raises(self) -> None:
        with pytest.raises(ValueError):
            build_candles([], 0)
        with pytest.raises(ValueError):
            build_candles([], -1)

    def test_all_known_timeframes(self) -> None:
        """Sanity-check the TF_SECONDS table doesn't change unintentionally."""

        assert TF_SECONDS["5m"] == 300
        assert TF_SECONDS["1d"] == 86400


class TestBuildPoints:
    def test_empty_returns_empty(self) -> None:
        assert build_points([]) == []

    def test_one_point_per_event(self) -> None:
        events = [
            _ev(block=1, ts=1000, base=110 * WEI, token=10 * WEI, fee=10 * WEI),
            _ev(block=2, ts=1100, side="sell", base=110 * WEI, token=10 * WEI, fee=10 * WEI),
        ]
        points = build_points(events)
        assert len(points) == 2
        assert points[0]["time"] == 1000
        assert points[0]["value"] == 10.0  # buy: (110-10)/10
        assert points[1]["value"] == 12.0  # sell: (110+10)/10

    def test_sorts_unsorted_input(self) -> None:
        events = [
            _ev(block=5, ts=5000),
            _ev(block=1, ts=1000),
            _ev(block=3, ts=3000),
        ]
        points = build_points(events)
        assert [p["time"] for p in points] == [1000, 3000, 5000]

    def test_skips_zero_token(self) -> None:
        events = [_ev(block=1, ts=1000, token=0), _ev(block=2, ts=2000)]
        points = build_points(events)
        assert len(points) == 1
        assert points[0]["time"] == 2000

    def test_stable_order_on_tied_block(self) -> None:
        events = [
            _ev(block=1, ts=1000, log_index=2),
            _ev(block=1, ts=1000, log_index=0),
            _ev(block=1, ts=1000, log_index=1),
        ]
        points = build_points(events)
        assert len(points) == 3
        # lightweight-charts requires strictly-increasing time. Each event in
        # the same block must get a unique sub-second offset derived from
        # log_index — never identical times.
        times = [p["time"] for p in points]
        assert times == sorted(times)
        assert len(set(times)) == 3
        # Concrete offsets: ts + log_index * 0.001.
        assert times[0] == 1000.0  # log_index=0
        assert times[1] == 1000.001  # log_index=1
        assert times[2] == 1000.002  # log_index=2

    def test_time_is_float_with_subsecond_offset(self) -> None:
        # Single event with non-zero log_index produces a float time
        # (avoids lightweight-charts crash on duplicate Y-axis values).
        events = [_ev(block=1, ts=2000, log_index=7)]
        points = build_points(events)
        assert isinstance(points[0]["time"], float)
        assert points[0]["time"] == 2000.007


# Coverage hook: exercise the typeddict (no real assertions needed).
def test_event_typeddict_constructs() -> None:
    ev: dict[str, Any] = _ev(block=1, ts=1)
    assert ev["block_number"] == 1
