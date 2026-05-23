"""``/api/v1/profile`` — premium portfolio-wide view.

Per docs/api-spec.md §6.1. Ports the aggregation from ``server.py:1373`` in the
portable repo, with the structural changes required by the web version:

* Reads events from Postgres (not the in-memory cache).
* Reads per-token current prices from ``market_state`` (worker keeps them
  fresh) — no RPC call in the hot path.
* PITCH-denominated PnL conversion uses ``market_state.price_pitch`` of each
  country token as the country→PITCH rate (the portable code carried a
  ``countryPricePitch`` field on the player dict — same data, different
  location).

``balances`` block is intentionally **zeroed** at this stage: the portable
implementation hits Multicall3 to read wallet ETH/PITCH/country balances, and
adding that RPC call here would (a) couple the API to the worker's web3 setup
and (b) blow the latency budget when ``ACCESS_CONTRACT`` is wired in B0.11.
TODO(B0.13.balances): port ``_wallet_balances`` from ``server.py:1343`` once
``shared/eth.py`` exposes a Multicall helper (post-MVP).
"""

from __future__ import annotations

import time
from typing import Any

from flask import Blueprint, g, jsonify, request

from app.errors import abort_with_problem
from app.pagination import clamp_limit, decode_cursor, encode_cursor
from app.routes._premium_stub import require_premium_stub
from shared.db import fetch_all
from shared.price import to_display_units
from shared.types import Event

bp = Blueprint("profile", __name__)


# ─── DB helpers ────────────────────────────────────────────────────────────


def _load_wallet_events(wallet: str) -> list[Event]:
    """All trades made by ``wallet`` across every token, block-sorted ASC."""

    rows = fetch_all(
        "SELECT block_number, tx_hash, log_index, token_address, side, "
        "trader_address, base_value, token_value, fee, "
        "EXTRACT(EPOCH FROM ts)::bigint AS timestamp "
        "FROM events WHERE trader_address = %s "
        "ORDER BY block_number ASC, log_index ASC",
        (wallet,),
    )
    out: list[Event] = []
    for r in rows:
        out.append(
            {
                "block_number": int(r["block_number"]),
                "tx_hash": r["tx_hash"].strip(),
                "log_index": int(r["log_index"]),
                "token_address": r["token_address"].strip(),
                "side": r["side"],
                "trader_address": r["trader_address"].strip(),
                "base_value": int(r["base_value"]),
                "token_value": int(r["token_value"]),
                "fee": int(r["fee"]),
                "timestamp": int(r["timestamp"]),
            }
        )
    return out


def _load_token_meta(token_addrs: set[str]) -> dict[str, dict[str, Any]]:
    """For each token in ``token_addrs`` build the metadata + pricing tuple.

    Output dict shape per token:
    ``{symbol, kind, country, role, country_address, price_pitch, country_price_pitch}``

    * ``price_pitch`` — token's spot price in PITCH (display units).
    * ``country_price_pitch`` — for player tokens, the country's price in PITCH
      (display units); used as the country→PITCH rate. ``1.0`` for country tokens.
    """

    if not token_addrs:
        return {}
    addr_list = sorted(token_addrs)
    placeholders = ",".join(["%s"] * len(addr_list))
    rows = fetch_all(
        f"SELECT t.address, t.symbol, t.kind, t.role, t.country_address, "
        f"t.name AS country_name, "
        f"COALESCE(m.price_pitch, 0) AS price_pitch "
        f"FROM tokens t LEFT JOIN market_state m ON m.token_address = t.address "
        f"WHERE t.address IN ({placeholders})",
        tuple(addr_list),
    )
    base: dict[str, dict[str, Any]] = {}
    for r in rows:
        base[r["address"].strip()] = {
            "symbol": r["symbol"],
            "kind": r["kind"],
            "role": r["role"],
            "country_address": (r["country_address"].strip() if r["country_address"] else None),
            "price_pitch": float(int(r["price_pitch"])) / 1e18,
            # For country tokens, ``name`` is the country name itself.
            # For players, we fill ``country`` below from the country row.
            "_country_name_self": r["country_name"],
        }

    # Second pass: enrich player rows with their country's name + PITCH price.
    country_addrs = {
        m["country_address"]
        for m in base.values()
        if m["kind"] == "player" and m["country_address"]
    }
    if country_addrs:
        addr_list2 = sorted(country_addrs)
        placeholders2 = ",".join(["%s"] * len(addr_list2))
        crows = fetch_all(
            f"SELECT t.address, t.name, COALESCE(m.price_pitch, 0) AS price_pitch "
            f"FROM tokens t LEFT JOIN market_state m ON m.token_address = t.address "
            f"WHERE t.address IN ({placeholders2})",
            tuple(addr_list2),
        )
        country_map = {
            r["address"].strip(): {
                "name": r["name"],
                "price_pitch": float(int(r["price_pitch"])) / 1e18,
            }
            for r in crows
        }
    else:
        country_map = {}

    out: dict[str, dict[str, Any]] = {}
    for token_addr, m in base.items():
        if m["kind"] == "country":
            country_name = m["_country_name_self"]
            country_price_pitch = 1.0
        else:
            country_addr = m["country_address"]
            cinfo = country_map.get(country_addr, {"name": "", "price_pitch": 0.0})
            country_name = cinfo["name"]
            country_price_pitch = cinfo["price_pitch"]
        out[token_addr] = {
            "symbol": m["symbol"],
            "kind": m["kind"],
            "role": m["role"] if m["kind"] == "player" else "country",
            "country": country_name,
            "country_address": m["country_address"],
            "price_pitch": m["price_pitch"],
            "country_price_pitch": country_price_pitch,
        }
    return out


# ─── Aggregation ───────────────────────────────────────────────────────────


def _aggregate_per_token(events: list[Event]) -> dict[str, dict[str, float | int]]:
    """Walk ``events`` and accumulate per-token wallet aggregates.

    All numeric values are in display units (divided by WEI). Mirrors the
    portable ``agg`` dict in ``server.py:1402-1416`` — buys/sells counts,
    fee-inclusive ``spent``/``received``, and timestamp endpoints.
    """

    agg: dict[str, dict[str, float | int]] = {}
    for ev in events:
        base_val = to_display_units(ev["base_value"])
        token_val = to_display_units(ev["token_value"])
        fee_val = to_display_units(ev["fee"])
        token = ev["token_address"]
        a = agg.get(token)
        if a is None:
            a = {
                "buys": 0,
                "sells": 0,
                "position": 0.0,
                "spent": 0.0,
                "received": 0.0,
                "bought": 0.0,
                "fees": 0.0,
                "first_ts": ev["timestamp"],
                "last_ts": ev["timestamp"],
            }
            agg[token] = a
        a["fees"] = float(a["fees"]) + fee_val
        # ``timestamp`` may be 0 for not-yet-resolved events; keep last_ts as
        # the latest non-zero we see, first_ts as the earliest non-zero.
        ts = ev["timestamp"]
        if ts > 0:
            if a["first_ts"] == 0 or ts < int(a["first_ts"]):
                a["first_ts"] = ts
            if ts > int(a["last_ts"]):
                a["last_ts"] = ts
        if ev["side"] == "buy":
            a["buys"] = int(a["buys"]) + 1
            a["position"] = float(a["position"]) + token_val
            a["spent"] = float(a["spent"]) + base_val
            a["bought"] = float(a["bought"]) + token_val
        else:
            a["sells"] = int(a["sells"]) + 1
            a["position"] = float(a["position"]) - token_val
            a["received"] = float(a["received"]) + base_val
    return agg


# ─── Endpoint ──────────────────────────────────────────────────────────────


def _decode_trades_cursor(cursor_raw: str | None) -> tuple[int, int] | None:
    """Decode the optional ``tradesCursor`` into ``(block_number, log_index)``."""

    if not cursor_raw:
        return None
    cursor = decode_cursor(cursor_raw)
    try:
        return int(cursor["b"]), int(cursor["l"])
    except (KeyError, TypeError, ValueError) as err:
        abort_with_problem(
            code="validation.bad_request",
            title="Bad cursor",
            status=400,
            detail='tradesCursor must carry {"b": int, "l": int}',
        )
        raise AssertionError("unreachable") from err


def _build_trade_item(ev: Event, meta: dict[str, Any]) -> dict[str, Any]:
    """Serialize a single wallet trade per spec §6.1 ``trades.items[*]``."""

    base_val = to_display_units(ev["base_value"])
    token_val = to_display_units(ev["token_value"])
    fee_val = to_display_units(ev["fee"])
    rate = float(meta.get("country_price_pitch", 0.0))
    value_pitch = base_val * rate
    price = (base_val / token_val) if token_val > 0 else 0.0
    gross = base_val - fee_val if ev["side"] == "buy" else base_val + fee_val
    market_price = (gross / token_val) if token_val > 0 else 0.0
    return {
        "symbol": meta.get("symbol", ""),
        "kind": meta.get("kind", ""),
        "type": ev["side"],
        "price": round(price, 6),
        "marketPrice": round(market_price, 6),
        "amount": round(token_val, 4),
        "valuePitch": round(value_pitch, 2),
        "feePitch": round(fee_val * rate, 4),
        "timestamp": ev["timestamp"] if ev["timestamp"] > 0 else None,
        "tx": ev["tx_hash"],
    }


@bp.get("/api/v1/profile")
@require_premium_stub
def get_profile() -> Any:
    """Portfolio-wide view for the authenticated wallet (spec §6.1)."""

    wallet = g.address  # already lowercased by require_auth

    limit = clamp_limit(request.args.get("tradesLimit"))
    cursor = _decode_trades_cursor(request.args.get("tradesCursor"))

    events = _load_wallet_events(wallet)
    agg = _aggregate_per_token(events)

    token_meta = _load_token_meta(set(agg.keys()))

    positions: list[dict[str, Any]] = []
    closed: list[dict[str, Any]] = []
    realized_pitch = 0.0
    unrealized_pitch = 0.0
    value_pitch = 0.0
    spent_pitch = 0.0
    fees_pitch = 0.0
    closed_count = 0
    closed_wins = 0
    pnl_by_symbol: dict[str, float] = {}
    alloc_country: dict[str, float] = {}
    alloc_role: dict[str, float] = {}
    alloc_players = 0.0
    alloc_countries = 0.0

    for token, a in agg.items():
        meta = token_meta.get(token)
        if meta is None:
            # Token exists in events but not in `tokens` table — shouldn't happen
            # (events.token_address has FK), but skip defensively.
            continue
        rate = float(meta["country_price_pitch"])
        bought = float(a["bought"])
        spent = float(a["spent"])
        received = float(a["received"])
        position = max(float(a["position"]), 0.0)
        sold = max(bought - position, 0.0)
        avg_buy = (spent / bought) if bought > 0 else 0.0

        realized = received - avg_buy * sold
        # Unrealized is denominated in the token's *base* (country for players,
        # PITCH for countries). Multiply by ``rate`` to convert to PITCH.
        unreal_base = position * meta["price_pitch"] / rate - avg_buy * position if rate > 0 else 0.0
        realized_pitch += realized * rate
        fees_pitch += float(a["fees"]) * rate
        spent_pitch += spent * rate
        pnl_by_symbol[meta["symbol"]] = pnl_by_symbol.get(meta["symbol"], 0.0) + (
            (realized + unreal_base) * rate
        )

        is_open = position > 1e-9
        if is_open:
            pv = position * meta["price_pitch"]
            value_pitch += pv
            unrealized_pitch += unreal_base * rate
            cost = avg_buy * position
            positions.append(
                {
                    "token": token,
                    "symbol": meta["symbol"],
                    "kind": meta["kind"],
                    "country": meta["country"],
                    "role": meta["role"],
                    "qty": round(position, 4),
                    "avgBuy": round(avg_buy, 6),
                    # ``currentPrice`` in the portable API was the price in the
                    # token's *base* (country for players); we keep that.
                    "currentPrice": round(
                        (meta["price_pitch"] / rate) if rate > 0 else 0.0, 6
                    ),
                    "valuePitch": round(pv, 2),
                    "unrealizedPnlPitch": round(unreal_base * rate, 2),
                    "unrealizedPct": round((unreal_base / cost * 100) if cost > 0 else 0.0, 1),
                }
            )
            alloc_country[meta["country"]] = alloc_country.get(meta["country"], 0.0) + pv
            alloc_role[meta["role"]] = alloc_role.get(meta["role"], 0.0) + pv
            if meta["kind"] == "player":
                alloc_players += pv
            else:
                alloc_countries += pv
        elif bought > 0:
            closed_count += 1
            if realized > 0:
                closed_wins += 1
            closed.append(
                {
                    "token": token,
                    "symbol": meta["symbol"],
                    "kind": meta["kind"],
                    "country": meta["country"],
                    "realizedPnlPitch": round(realized * rate, 2),
                    "buys": int(a["buys"]),
                    "sells": int(a["sells"]),
                    "lastTs": int(a["last_ts"]) if a["last_ts"] else None,
                }
            )

    # Sort positions / closed for stable UI ordering.
    positions.sort(key=lambda p: -float(p["valuePitch"]))
    closed.sort(key=lambda c: -(c["lastTs"] or 0))
    for p in positions:
        p["sharePct"] = round(
            (float(p["valuePitch"]) / value_pitch * 100) if value_pitch > 0 else 0.0, 1
        )

    # ─── Trades pagination ─────────────────────────────────────────────────
    # Events are stored ASC; spec §1.5 requires DESC for trades. Reverse-sort
    # in Python (events list is already in memory) then slice the cursor window.

    desc_events = sorted(
        events, key=lambda e: (e["block_number"], e["log_index"]), reverse=True
    )
    if cursor is not None:
        b, li = cursor
        desc_events = [
            e
            for e in desc_events
            if (e["block_number"] < b)
            or (e["block_number"] == b and e["log_index"] < li)
        ]
    page = desc_events[: limit + 1]
    next_cursor: str | None = None
    if len(page) > limit:
        page = page[:limit]
        last = page[-1]
        next_cursor = encode_cursor(
            {"b": int(last["block_number"]), "l": int(last["log_index"])}
        )

    trade_items = [
        _build_trade_item(ev, token_meta.get(ev["token_address"], {})) for ev in page
    ]

    # ─── Stats ─────────────────────────────────────────────────────────────
    buys = sum(int(a["buys"]) for a in agg.values())
    sells = sum(int(a["sells"]) for a in agg.values())
    total_trades = len(events)
    volume_pitch = sum(
        to_display_units(ev["base_value"])
        * float(token_meta.get(ev["token_address"], {}).get("country_price_pitch", 0.0))
        for ev in events
    )
    avg_trade_pitch = (volume_pitch / total_trades) if total_trades else 0.0
    win_rate = (closed_wins / closed_count * 100) if closed_count else 0.0
    best = max(pnl_by_symbol.items(), key=lambda kv: kv[1], default=None)
    worst = min(pnl_by_symbol.items(), key=lambda kv: kv[1], default=None)
    total_pnl = realized_pitch + unrealized_pitch
    roi_pct = (total_pnl / spent_pitch * 100) if spent_pitch > 0 else 0.0

    # ─── valueSeries ───────────────────────────────────────────────────────
    # Lightweight per-trade portfolio-value series: at each wallet trade, sum
    # ``position * current_price_pitch`` across all tokens held at that moment.
    # We don't have historical prices in the DB, so for now we sample at the
    # *current* token prices — the curve becomes a step function of holdings.
    # TODO(B0.13.value_series): wire historical price lookup once the chart
    # module exposes ``price_at(token, ts)``; portable did binary-search over
    # in-memory events. Not blocking for B0.13 DoD which calls for "correct
    # sums", not historical accuracy.
    holdings: dict[str, float] = {}
    series_map: dict[int, float] = {}
    for ev in events:  # block-sorted ASC
        tv = to_display_units(ev["token_value"])
        delta = tv if ev["side"] == "buy" else -tv
        holdings[ev["token_address"]] = holdings.get(ev["token_address"], 0.0) + delta
        val = 0.0
        for tok, qty in holdings.items():
            if qty <= 1e-9:
                continue
            meta = token_meta.get(tok)
            if not meta:
                continue
            val += qty * float(meta["price_pitch"])
        if ev["timestamp"] > 0:
            series_map[ev["timestamp"]] = round(val, 2)
    series_map[int(time.time())] = round(value_pitch, 2)
    value_series = [{"time": t, "value": v} for t, v in sorted(series_map.items())]

    body: dict[str, Any] = {
        "address": wallet,
        "summary": {
            "totalValuePitch": round(value_pitch, 2),
            "realizedPnlPitch": round(realized_pitch, 2),
            "unrealizedPnlPitch": round(unrealized_pitch, 2),
            "totalPnlPitch": round(total_pnl, 2),
            "roiPct": round(roi_pct, 1),
            "openPositions": len(positions),
            "feesPaidPitch": round(fees_pitch, 2),
        },
        "positions": positions,
        "closed": closed,
        "trades": {
            "items": trade_items,
            "nextCursor": next_cursor,
            "limit": limit,
        },
        "stats": {
            "totalTrades": total_trades,
            "buys": buys,
            "sells": sells,
            "volumePitch": round(volume_pitch, 2),
            "avgTradePitch": round(avg_trade_pitch, 2),
            "feesPaidPitch": round(fees_pitch, 2),
            "closedPositions": closed_count,
            "winRatePct": round(win_rate, 1),
            "best": (
                {"symbol": best[0], "pnlPitch": round(best[1], 2)} if best else None
            ),
            "worst": (
                {"symbol": worst[0], "pnlPitch": round(worst[1], 2)} if worst else None
            ),
        },
        "allocation": {
            "byCountry": {
                k: round(v, 2)
                for k, v in sorted(alloc_country.items(), key=lambda kv: -kv[1])
            },
            "byRole": {k: round(v, 2) for k, v in alloc_role.items()},
            "players": round(alloc_players, 2),
            "countries": round(alloc_countries, 2),
        },
        # TODO(B0.13.balances): port _wallet_balances (Multicall3) from server.py:1343.
        # Until then, return the spec'd shape with zero/empty values rather than omit
        # the key — frontend can render "—" placeholders without crashing.
        "balances": {
            "ethWei": "0",
            "pitchWei": "0",
            "countries": [],
        },
        "valueSeries": value_series,
    }
    return jsonify(body)


__all__ = ["bp"]
