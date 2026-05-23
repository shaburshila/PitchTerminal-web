"""OHLCV candles + line-chart points from a list of events.

Pure adaptation of portable ``build_candles`` / ``build_points`` (server.py
§368-478) — same formula, no global state. The portable version derived a
synthetic timestamp from ``current_block - ev["block"]`` because the cache
didn't store per-event timestamps; in the web version :class:`Event` carries
a real ``timestamp`` so the chart code only does bucketing.

**Sort guarantee:** ``lightweight-charts`` ``setData`` crashes on unsorted
inputs (``"Value is null"``). Both functions sort their inputs by
``block_number ASC`` before bucketing — see MEMORY.md "Key Design Decisions".
"""

from __future__ import annotations

from typing import Any

from shared.price import market_price, to_display_units
from shared.types import Candle, Event, Point

# Timeframe label → seconds. Matches portable server.py §388.
TF_SECONDS: dict[str, int] = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "1h": 3600,
    "4h": 14400,
    "1d": 86400,
}


def _sort_events(events: list[Event]) -> list[Event]:
    """Return a copy of ``events`` sorted by ``block_number`` then ``log_index``.

    Two events in the same block must have a stable order — ``log_index``
    breaks the tie deterministically. Without it the line chart can show two
    points with identical ``time`` in arbitrary order, which lightweight-charts
    rejects.
    """

    return sorted(events, key=lambda e: (e["block_number"], e["log_index"]))


def build_candles(
    events: list[Event],
    timeframe_sec: int,
    *,
    current_price: float | None = None,
    now_ts: int | None = None,
) -> list[Candle]:
    """Build OHLCV candles bucketed at ``timeframe_sec``.

    Args:
        events: Events for **a single token** (the caller filters by address).
            Pre-sorting not required — this function sorts internally.
        timeframe_sec: Bucket width in seconds (e.g. 300 for 5m). Must be > 0.
        current_price: If provided and > 0, the «live» candle for the current
            bucket is updated (high/low/close) just like the portable version
            did via ``current_price_of``. Pass ``None`` to skip — useful in
            tests and historical exports.
        now_ts: Override for «current time» (unix seconds). Defaults to the
            timestamp of the last event so that pure-function tests are
            deterministic. The worker passes ``time.time()`` for live charts.

    Returns:
        List of :class:`Candle` dicts ordered by ``time`` ASC. Gaps between
        buckets are forward-filled with flat ``open=high=low=close=prev_close``
        candles (volume 0) — matches portable §403-417.
    """

    if timeframe_sec <= 0:
        raise ValueError(f"timeframe_sec must be positive, got {timeframe_sec}")

    sorted_events = _sort_events(events)
    trades: list[dict[str, Any]] = []
    for ev in sorted_events:
        if ev["token_value"] <= 0:
            # Skip degenerate events (would divide-by-zero in market_price; the
            # function itself returns 0.0 but the candle would be meaningless).
            continue
        price = market_price(ev["side"], ev["base_value"], ev["fee"], ev["token_value"])
        if price <= 0:
            continue
        volume = to_display_units(ev["base_value"])
        trades.append({"ts": ev["timestamp"], "price": price, "volume": volume})

    if not trades:
        return []

    # Bucket by integer-divided time.
    buckets: dict[int, dict[str, float]] = {}
    for t in trades:
        bucket = (int(t["ts"]) // timeframe_sec) * timeframe_sec
        if bucket not in buckets:
            buckets[bucket] = {
                "open": t["price"],
                "high": t["price"],
                "low": t["price"],
                "close": t["price"],
                "volume": 0.0,
            }
        c = buckets[bucket]
        c["high"] = max(c["high"], t["price"])
        c["low"] = min(c["low"], t["price"])
        c["close"] = t["price"]
        c["volume"] += t["volume"]

    sorted_buckets = sorted(buckets.keys())
    # Forward-fill gaps between first trade and (current bucket | last trade).
    if len(sorted_buckets) > 1 or (current_price is not None and current_price > 0):
        effective_now = now_ts if now_ts is not None else int(trades[-1]["ts"])
        end_bucket_raw = (effective_now // timeframe_sec) * timeframe_sec
        # Never shrink the range below the last actual trade bucket.
        end_bucket = max(end_bucket_raw, sorted_buckets[-1])
        start_bucket = sorted_buckets[0]
        prev_close = buckets[start_bucket]["close"]

        filled: dict[int, dict[str, float]] = {}
        bucket = start_bucket
        while bucket <= end_bucket:
            if bucket in buckets:
                filled[bucket] = buckets[bucket]
                prev_close = buckets[bucket]["close"]
            else:
                filled[bucket] = {
                    "open": prev_close,
                    "high": prev_close,
                    "low": prev_close,
                    "close": prev_close,
                    "volume": 0.0,
                }
            bucket += timeframe_sec
        buckets = filled

    # Splice in the live candle if a current spot price was provided.
    if current_price is not None and current_price > 0:
        effective_now = now_ts if now_ts is not None else int(trades[-1]["ts"])
        cur_bucket = (effective_now // timeframe_sec) * timeframe_sec
        if cur_bucket in buckets:
            c = buckets[cur_bucket]
            c["high"] = max(c["high"], current_price)
            c["low"] = min(c["low"], current_price)
            c["close"] = current_price
        else:
            buckets[cur_bucket] = {
                "open": current_price,
                "high": current_price,
                "low": current_price,
                "close": current_price,
                "volume": 0.0,
            }

    result: list[Candle] = []
    for ts in sorted(buckets.keys()):
        c = buckets[ts]
        result.append(
            {
                "time": ts,
                "open": round(c["open"], 6),
                "high": round(c["high"], 6),
                "low": round(c["low"], 6),
                "close": round(c["close"], 6),
                "volume": round(c["volume"], 4),
            }
        )
    return result


def build_points(events: list[Event]) -> list[Point]:
    """Build one line-chart point per trade.

    Sorts events by block then log_index (lightweight-charts requirement).
    Returns the fee-excluded market price for each event. Events with
    ``token_value <= 0`` are skipped.
    """

    sorted_events = _sort_events(events)
    points: list[Point] = []
    for ev in sorted_events:
        if ev["token_value"] <= 0:
            continue
        price = market_price(ev["side"], ev["base_value"], ev["fee"], ev["token_value"])
        if price <= 0:
            continue
        points.append({"time": ev["timestamp"], "value": round(price, 6)})
    return points


__all__ = ["TF_SECONDS", "build_candles", "build_points"]
