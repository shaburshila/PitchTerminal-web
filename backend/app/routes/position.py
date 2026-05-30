"""``/api/v1/tokens/{token}/position`` — premium per-token PnL block.

Per docs/api-spec.md §4.4. Returns the same ``myWallet`` shape as embedded in
``/api/v1/tokens/{token}/trades`` (§4.3), but standalone — so the frontend's
"My Wallet" tab doesn't have to pull the whole trade list.

PnL maths lives in :func:`shared.pnl.wallet_position`; this module only
wires the DB reads + the per-token-specific fields (``rank``, ``holdersCount``,
``ownershipPct``) the shared function doesn't know about.
"""

from __future__ import annotations

import re
import time
from typing import Any

from flask import Blueprint, g, jsonify

from app.deps import require_premium
from app.errors import abort_with_problem
from shared.db import fetch_all, fetch_one
from shared.pnl import wallet_position
from shared.price import to_display_units
from shared.types import Event

bp = Blueprint("position", __name__)

_ADDR_RE = re.compile(r"^0x[0-9a-f]{40}$")


def _normalize_token_or_404(raw: str) -> str:
    """Lowercase + validate the ``{token}`` path; 404 ``tokens.unknown`` on miss."""

    if not isinstance(raw, str):
        abort_with_problem(code="tokens.unknown", title="Unknown token", status=404)
    addr = raw.lower()
    if not _ADDR_RE.match(addr):
        abort_with_problem(
            code="tokens.unknown",
            title="Unknown token",
            status=404,
            detail="not a valid 0x-address",
        )
    row = fetch_one("SELECT address FROM tokens WHERE address = %s", (addr,))
    if row is None:
        abort_with_problem(code="tokens.unknown", title="Unknown token", status=404)
        raise AssertionError("unreachable")
    return addr


def _load_events(token: str, wallet: str) -> list[Event]:
    """``wallet``'s events on ``token``, block-sorted ASC. wei amounts cast to int.

    Scoped to the single trader: :func:`shared.pnl.wallet_position` discards
    every event whose ``trader_address`` differs anyway, so loading the whole
    token's trade history just to throw most of it away wastes a round-trip on
    active tokens. The full-token aggregation needed for ``holdersCount`` /
    ``rank`` is loaded separately in :func:`_holders_and_rank`.
    """

    rows = fetch_all(
        "SELECT block_number, tx_hash, log_index, token_address, side, "
        "trader_address, base_value, token_value, fee, "
        "EXTRACT(EPOCH FROM ts)::bigint AS timestamp "
        "FROM events WHERE token_address = %s AND trader_address = %s "
        "ORDER BY block_number ASC, log_index ASC",
        (token, wallet),
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


def _market_row(token: str) -> dict[str, Any]:
    """Read ``market_state`` for ``token``; defaults for missing rows."""

    row = fetch_one(
        "SELECT price_pitch, supply FROM market_state WHERE token_address = %s",
        (token,),
    )
    if row is None:
        return {"price_pitch": 0, "supply": 0}
    return dict(row)


def _holders_and_rank(token: str, wallet: str) -> tuple[int, int]:
    """Return ``(holders_count, rank)`` — distinct net-positive holders + 1-based rank.

    Same aggregation logic as ``tokens.py:_aggregate_wallets`` but trimmed to
    the two scalars we need; running the full per-trader summary just to count
    rows would be wasteful for premium hot-paths.

    NOTE (bug #11): holders/rank stay **event-derived** (net buys minus sells),
    unlike the position card's held ``qty`` which now uses on-chain ``balanceOf``.
    A wallet that consumed its country tokens buying player tokens (no Sell on
    the country hook) can therefore rank as a holder here while its on-chain
    balance — and the card's ``position`` — is 0. Reconciling rank against chain
    would need a per-wallet ``balanceOf`` (no multicall over all holders), so
    this is an accepted divergence, not a bug.
    """

    rows = fetch_all(
        "SELECT trader_address, "
        "SUM(CASE WHEN side='buy' THEN token_value::numeric "
        "         ELSE -token_value::numeric END) AS net_tokens "
        "FROM events WHERE token_address = %s "
        "GROUP BY trader_address "
        "HAVING SUM(CASE WHEN side='buy' THEN token_value::numeric "
        "                ELSE -token_value::numeric END) > 0 "
        "ORDER BY net_tokens DESC",
        (token,),
    )
    holders = len(rows)
    rank = 0
    for i, r in enumerate(rows, start=1):
        if r["trader_address"].strip().lower() == wallet:
            rank = i
            break
    return holders, rank


def _onchain_qty(token: str, wallet: str) -> float | None:
    """On-chain ``balanceOf(wallet)`` for ``token`` in display units (bug #11).

    The truth for CURRENT held quantity — the event net over-counts (player
    buys burn the parent country with no Sell; transfers emit no events).
    Returns ``None`` on RPC failure so the caller falls back to the event net
    rather than zeroing the card on a transient blip.
    """

    try:
        from shared.eth import balances_of as _balances_of
        from shared.eth import get_w3 as _get_w3

        wei = _balances_of(_get_w3(), wallet, [token]).get(token, 0)
    except Exception:  # pragma: no cover - network path
        return None
    return to_display_units(wei)


def _build_my_wallet(token: str, wallet: str) -> dict[str, Any]:
    """Compose the ``myWallet`` block (camelCase) for ``wallet`` on ``token``."""

    events = _load_events(token, wallet)
    market = _market_row(token)
    supply = float(int(market["supply"])) / 1e18
    current_price = float(int(market["price_pitch"])) / 1e18

    pos = wallet_position(events, wallet, current_price=current_price)

    if pos["buys"] + pos["sells"] == 0:
        return {
            "configured": True,
            "address": wallet,
            "hasActivity": False,
        }

    holders, rank = _holders_and_rank(token, wallet)
    event_position = pos["position"]
    # CURRENT held quantity from on-chain balanceOf; fall back to event net on
    # RPC failure. Cost-basis fields (avgBuy, breakEven, realized, sold) stay
    # event-derived — only the held-quantity / value / unrealized layer changes.
    onchain = _onchain_qty(token, wallet)
    position = event_position if onchain is None else onchain
    avg_buy = pos["avg_buy"]
    # Sold is event-derived (cost-basis layer): bought - event net position.
    sold = max(pos["bought"] - event_position, 0.0)
    position_value = position * current_price
    # Unrealized re-derived against the on-chain held qty (cost basis applies
    # only to the event-bought portion still held; on-chain excess has none).
    cost_qty = min(position, event_position)
    if current_price > 0 and position > 1e-9:
        unrealized = position * current_price - avg_buy * cost_qty
    else:
        unrealized = 0.0
    spent = pos["spent"]
    avg_net = pos["avg_net"]
    total_pnl = pos["realized_pnl"] + unrealized
    first_ts = pos["first_trade_ts"]
    now = int(time.time())

    total_pnl_pct = (total_pnl / spent * 100) if spent > 0 else 0.0
    break_even_dist_pct = ((current_price - avg_net) / avg_net * 100) if avg_net > 1e-9 else 0.0
    ownership_pct = (position / supply * 100) if supply > 0 else 0.0
    holding_days = ((now - first_ts) / 86400) if first_ts > 0 else 0.0

    return {
        "configured": True,
        "address": wallet,
        "hasActivity": True,
        "buys": pos["buys"],
        "sells": pos["sells"],
        "position": round(position, 4),
        "positionValue": round(position_value, 4),
        "spent": round(spent, 4),
        "received": round(pos["received"], 4),
        "tokensSold": round(sold, 4),
        "avgBuy": round(pos["avg_buy"], 6),
        "breakEven": round(max(avg_net, 0.0), 6),
        "currentPrice": round(current_price, 6),
        "realizedPnl": round(pos["realized_pnl"], 4),
        "unrealizedPnl": round(unrealized, 4),
        "totalPnl": round(total_pnl, 4),
        "totalPnlPct": round(total_pnl_pct, 2),
        "breakEvenDistPct": round(break_even_dist_pct, 2),
        "feesPaid": round(pos["fees_paid"], 4),
        "ownershipPct": round(ownership_pct, 4),
        "rank": rank,
        "holdersCount": holders,
        "firstTradeTs": first_ts if first_ts > 0 else None,
        "holdingDays": round(holding_days, 1),
    }


@bp.get("/api/v1/tokens/<token>/position")
@require_premium
def get_position(token: str) -> Any:
    """Per-token ``myWallet`` block for the authenticated session (spec §4.4)."""

    addr = _normalize_token_or_404(token)
    wallet = g.address  # set by require_auth via require_premium
    body = _build_my_wallet(addr, wallet)
    return jsonify(body)


def build_my_wallet(token: str, wallet: str) -> dict[str, Any]:
    """Public façade exposed for cross-module reuse (e.g. by ``/trades`` in B0.12)."""

    return _build_my_wallet(token, wallet)


__all__ = ["bp", "build_my_wallet"]
