"""``/api/v1/profile`` — premium portfolio-wide view.

Per docs/api-spec.md §6.1. Ports the aggregation from ``server.py:1373`` in the
portable repo, with the structural changes required by the web version:

* Reads events from Postgres (not the in-memory cache).
* Reads per-token current prices from ``market_state`` (worker keeps them
  fresh) — no RPC call in the hot path *except* for the wallet's balances
  block, which still requires a live ``eth_getBalance`` + Multicall3 batch
  (see :func:`shared.eth.wallet_balances`).
* PITCH-denominated PnL conversion uses ``market_state.price_pitch`` of each
  country token as the country→PITCH rate (the portable code carried a
  ``countryPricePitch`` field on the player dict — same data, different
  location).
* ``valueSeries`` samples each held token's PITCH price *at the timestamp of
  every wallet trade* (so the curve reflects historical valuation, not current
  prices applied to old holdings). The sampling is done with
  :class:`shared.price.HistoricalPrices`, which preloads all needed timelines
  in one query and binary-searches them in memory — same semantics as the
  per-call :func:`shared.price.price_at_pitch`, without the N*M round-trips.
"""

from __future__ import annotations

import time
from typing import Any, cast

from flask import Blueprint, g, jsonify, request

from app.deps import require_premium
from app.errors import abort_with_problem
from app.pagination import clamp_limit, decode_cursor, encode_cursor
from shared.db import fetch_all
from shared.eth import lc
from shared.log import get_logger
from shared.price import HistoricalPrices, load_price_timelines, to_display_units
from shared.types import Event

log = get_logger("app.routes.profile")

bp = Blueprint("profile", __name__)


# ─── Config indirection (tests patch these — ``Config`` is frozen) ─────────


def _get_pitch_token() -> str:
    """Thin accessor over :attr:`shared.config.config.pitch_token` so tests
    can monkey-patch the configured address (the dataclass is frozen — see
    :func:`shared.access._get_contract_address` for the same pattern)."""

    from shared.config import config as _cfg

    return _cfg.pitch_token


def _get_w3() -> Any:
    """Thin accessor over :func:`shared.eth.get_w3` so tests can stub the
    web3 client without touching the network."""

    from shared.eth import get_w3 as _gw3

    return _gw3()


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


def _load_all_country_addresses() -> list[str]:
    """All ``kind='country'`` token addresses, ascending — used as the
    Multicall target list for the ``balances.countries`` block."""

    rows = fetch_all("SELECT address FROM tokens WHERE kind = 'country' ORDER BY address")
    return [r["address"].strip() for r in rows]


def _load_country_symbols(addrs: list[str]) -> dict[str, str]:
    """Address → symbol lookup for the country tokens, for the response shape."""

    if not addrs:
        return {}
    placeholders = ",".join(["%s"] * len(addrs))
    rows = fetch_all(
        f"SELECT address, symbol FROM tokens WHERE address IN ({placeholders})",
        tuple(addrs),
    )
    return {r["address"].strip(): r["symbol"] for r in rows}


def _fetch_balances(wallet: str) -> dict[str, Any]:
    """Read on-chain balances for the response's ``balances`` block.

    Returns the spec-shape with empty/zero fields on any RPC failure — we
    log the error but never break the profile response (the portable code
    behaved the same way; see ``server.py:1368``).
    """

    pitch_token = _get_pitch_token()
    country_addrs = _load_all_country_addresses()
    try:
        from shared.eth import wallet_balances as _wallet_balances

        w3 = _get_w3()
        bals = _wallet_balances(w3, wallet, pitch_token, country_addrs)
    except Exception as exc:
        log.warning("profile.balances_failed", wallet=wallet, error=repr(exc))
        return {"ethWei": "0", "pitchWei": "0", "countries": []}

    symbols = _load_country_symbols([addr for addr, _ in bals.countries])
    return {
        "ethWei": str(bals.eth_wei),
        "pitchWei": str(bals.pitch_wei),
        "countries": [
            {"address": addr, "symbol": symbols.get(addr, ""), "wei": str(wei)}
            for addr, wei in bals.countries
        ],
    }


def _fetch_onchain_qty(wallet: str, token_addrs: list[str]) -> dict[str, float] | None:
    """On-chain ``balanceOf(wallet)`` for ``token_addrs``, in display units.

    The authoritative source for a position's *current quantity* (bug #11):
    buying a player token burns the parent country token but emits no Sell on
    the country hook, and wallet-to-wallet transfers emit no events at all, so
    the event-derived net position over-counts holdings. ``balanceOf`` is ground
    truth.

    One Multicall3 batch for every held token (no N round-trips). Returns
    ``{lowercase_address → qty_display}`` on success, or ``None`` on any RPC
    failure — callers then fall back to the event-derived position rather than
    zeroing the whole portfolio on a transient RPC blip.
    """

    if not token_addrs:
        return {}
    try:
        from shared.eth import balances_of as _balances_of

        w3 = _get_w3()
        wei_map = _balances_of(w3, wallet, token_addrs)
    except Exception as exc:
        log.warning("profile.onchain_qty_failed", wallet=wallet, error=repr(exc))
        return None
    return {addr: to_display_units(wei) for addr, wei in wei_map.items()}


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
                "first_ts": ev["timestamp"],
                "last_ts": ev["timestamp"],
            }
            agg[token] = a
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


def _resolve_target_wallet(raw: str | None) -> str:
    """Resolve which wallet the portfolio view is for.

    Empty/missing ``address`` query param → the authenticated viewer
    (``g.address``). A supplied address is normalized to lowercase and
    validated; malformed input aborts 400. Premium gating stays on the *viewer*
    (``@require_premium`` checks ``g.address``), so any premium user may view any
    address — only the *data target* changes here.
    """

    if not raw or not raw.strip():
        return cast(str, g.address)  # already lowercased by require_auth
    try:
        return lc(raw.strip())
    except ValueError as err:
        abort_with_problem(
            code="validation.bad_request",
            title="Bad address",
            status=400,
            detail="address must be a 0x-prefixed 20-byte hex address",
        )
        raise AssertionError("unreachable") from err


def _build_trade_item(ev: Event, meta: dict[str, Any], fee_pitch: float) -> dict[str, Any]:
    """Serialize a single wallet trade per spec §6.1 ``trades.items[*]``.

    ``fee_pitch`` is the PITCH-denominated commission for this trade, converted
    at the trade's *historical* country→PITCH rate by the caller (see
    ``_fee_pitch``). ``valuePitch`` still uses the current rate — that's the
    volume layer, migrated to historical separately.
    """

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
        "feePitch": round(fee_pitch, 4),
        "timestamp": ev["timestamp"] if ev["timestamp"] > 0 else None,
        "tx": ev["tx_hash"],
    }


def _build_hist(token_meta: dict[str, dict[str, Any]]) -> HistoricalPrices:
    """Build the historical-price index for a set of tokens.

    Preloads every timeline needed for historical conversion in ONE query (held
    tokens + the country tokens player positions are priced against), resolving
    in memory — avoids the naive per-call ``price_at_pitch`` O(N*M) round-trips
    on the hot ``events`` table (events audit P1). Shared by ``/profile`` (fees
    + valueSeries) and ``/portfolio/trades`` (per-trade fee).
    """

    timeline_tokens: set[str] = set(token_meta.keys())
    fallback_pitch: dict[str, float] = {}
    for tok, m in token_meta.items():
        fallback_pitch[tok] = float(m["price_pitch"])
        if m["kind"] == "player" and m.get("country_address"):
            timeline_tokens.add(m["country_address"])
            fallback_pitch[m["country_address"]] = float(m["country_price_pitch"])
    return HistoricalPrices(load_price_timelines(timeline_tokens), fallback_pitch)


def _fee_pitch(ev: Event, meta: dict[str, Any], hist: HistoricalPrices) -> float:
    """Commission of one trade in PITCH, at the trade's *historical* rate.

    Country tokens: ``fee`` is already PITCH (rate is identically 1). Player
    tokens: the fee was paid in country tokens, so convert at the country→PITCH
    price as of the trade timestamp. Falls back to the current rate only when
    the event has no usable timestamp.
    """

    fee_d = to_display_units(ev["fee"])
    if fee_d == 0.0:
        return 0.0
    if meta.get("kind") == "country":
        return fee_d
    country_addr = meta.get("country_address")
    ts = int(ev["timestamp"])
    if not country_addr or ts <= 0:
        return fee_d * float(meta.get("country_price_pitch", 0.0))
    return fee_d * hist.price_at_pitch(country_addr, "country", None, ts)


@bp.get("/api/v1/profile")
@require_premium
def get_profile() -> Any:
    """Portfolio-wide view for the authenticated wallet (spec §6.1)."""

    wallet = _resolve_target_wallet(request.args.get("address"))

    limit = clamp_limit(request.args.get("tradesLimit"))
    cursor = _decode_trades_cursor(request.args.get("tradesCursor"))

    events = _load_wallet_events(wallet)
    agg = _aggregate_per_token(events)

    token_meta = _load_token_meta(set(agg.keys()))

    # On-chain quantity is the source of truth for CURRENT positions (bug #11).
    # ``None`` ⇒ RPC unavailable; fall back to event-derived position per token.
    onchain_qty = _fetch_onchain_qty(wallet, sorted(agg.keys()))

    # Historical PITCH price lookup, shared by the fee layer + valueSeries.
    hist = _build_hist(token_meta)

    # Memo: (token, ts) → price_pitch. Many trades share a ts (one tx, many
    # tokens) and consecutive ticks often resolve to the same prior event.
    price_memo: dict[tuple[str, int], float] = {}

    def _memo_price(tok: str, ts: int) -> float:
        key = (tok, ts)
        cached = price_memo.get(key)
        if cached is not None:
            return cached
        meta_ = token_meta.get(tok)
        if not meta_:
            price_memo[key] = 0.0
            return 0.0
        p = hist.price_at_pitch(tok, meta_["kind"], meta_.get("country_address"), ts)
        price_memo[key] = p
        return p

    # Per-trade commission in PITCH, converted at each trade's historical
    # country→PITCH rate (country-token fees are already PITCH). Computed once
    # per event and keyed by (block, log_index) so the trades-page slice reuses
    # it instead of re-converting. This is the fee layer of the profile migrated
    # off the current-rate approximation.
    fee_pitch_by_ev: dict[tuple[int, int], float] = {
        (int(ev["block_number"]), int(ev["log_index"])): _fee_pitch(
            ev, token_meta.get(ev["token_address"], {}), hist
        )
        for ev in events
    }
    fees_pitch = sum(fee_pitch_by_ev.values())

    positions: list[dict[str, Any]] = []
    closed: list[dict[str, Any]] = []
    realized_pitch = 0.0
    unrealized_pitch = 0.0
    value_pitch = 0.0
    spent_pitch = 0.0
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
        # Event-derived net position: still drives realized/sold (cost-basis
        # layer, correct as-is).
        event_position = max(float(a["position"]), 0.0)
        sold = max(bought - event_position, 0.0)
        avg_buy = (spent / bought) if bought > 0 else 0.0

        realized = received - avg_buy * sold

        # CURRENT quantity = on-chain balanceOf (bug #11). When the RPC read
        # failed (``onchain_qty is None``) fall back to the event net position so
        # a transient RPC blip doesn't wipe the portfolio. A token with no
        # on-chain entry maps to 0 (exited / transferred away).
        if onchain_qty is None:
            position = event_position
        else:
            position = onchain_qty.get(token, 0.0)
            if position <= 1e-9:
                position = 0.0

        # Cost basis applies only to the event-bought portion still held: if the
        # wallet transferred tokens *in* (on-chain qty > event net), that excess
        # has zero cost basis (we never paid for it via a tracked Buy).
        cost_qty = min(position, event_position)

        # Unrealized is denominated in the token's *base* (country for players,
        # PITCH for countries). Multiply by ``rate`` to convert to PITCH.
        unreal_base = (
            position * meta["price_pitch"] / rate - avg_buy * cost_qty if rate > 0 else 0.0
        )
        realized_pitch += realized * rate
        spent_pitch += spent * rate
        pnl_by_symbol[meta["symbol"]] = pnl_by_symbol.get(meta["symbol"], 0.0) + (
            (realized + unreal_base) * rate
        )

        is_open = position > 1e-9
        if is_open:
            pv = position * meta["price_pitch"]
            value_pitch += pv
            unrealized_pitch += unreal_base * rate
            cost = avg_buy * cost_qty
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
                    "currentPrice": round((meta["price_pitch"] / rate) if rate > 0 else 0.0, 6),
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

    desc_events = sorted(events, key=lambda e: (e["block_number"], e["log_index"]), reverse=True)
    if cursor is not None:
        b, li = cursor
        desc_events = [
            e
            for e in desc_events
            if (e["block_number"] < b) or (e["block_number"] == b and e["log_index"] < li)
        ]
    page = desc_events[: limit + 1]
    next_cursor: str | None = None
    if len(page) > limit:
        page = page[:limit]
        last = page[-1]
        next_cursor = encode_cursor({"b": int(last["block_number"]), "l": int(last["log_index"])})

    trade_items = [
        _build_trade_item(
            ev,
            token_meta.get(ev["token_address"], {}),
            fee_pitch_by_ev[(int(ev["block_number"]), int(ev["log_index"]))],
        )
        for ev in page
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
    # Per-trade portfolio-value series: at each wallet trade, sum
    # ``position * price_at_pitch(token, ts)`` across all tokens held at that
    # moment. The price-at-ts lookup goes to the ``events`` table for the
    # nearest event with ``ts <= trade_ts`` (step function), so the curve
    # reflects what the portfolio was *historically* worth — not what it
    # would be worth at today's prices applied to old holdings. Mirrors the
    # portable binary-search semantics in ``server.py:1507``.
    holdings: dict[str, float] = {}
    series_map: dict[int, float] = {}

    for ev in events:  # block-sorted ASC
        tv = to_display_units(ev["token_value"])
        delta = tv if ev["side"] == "buy" else -tv
        holdings[ev["token_address"]] = holdings.get(ev["token_address"], 0.0) + delta
        ts = ev["timestamp"]
        if ts <= 0:
            continue
        val = 0.0
        for tok, qty in holdings.items():
            if qty <= 1e-9:
                continue
            val += qty * _memo_price(tok, ts)
        series_map[ts] = round(val, 2)
    # The tail point uses current ``value_pitch`` (already computed from
    # market_state above) — this anchors the series to "now".
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
            "best": ({"symbol": best[0], "pnlPitch": round(best[1], 2)} if best else None),
            "worst": ({"symbol": worst[0], "pnlPitch": round(worst[1], 2)} if worst else None),
        },
        "allocation": {
            "byCountry": {
                k: round(v, 2) for k, v in sorted(alloc_country.items(), key=lambda kv: -kv[1])
            },
            "byRole": {k: round(v, 2) for k, v in alloc_role.items()},
            "players": round(alloc_players, 2),
            "countries": round(alloc_countries, 2),
        },
        "balances": _fetch_balances(wallet),
        "valueSeries": value_series,
    }
    return jsonify(body)


__all__ = ["bp"]
