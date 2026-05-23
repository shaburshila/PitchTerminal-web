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

from app.errors import abort_with_problem
from app.routes._premium_stub import require_premium_stub
from shared.db import fetch_all, fetch_one
from shared.pnl import wallet_position
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


def _load_events(token: str) -> list[Event]:
    """All events for ``token``, block-sorted ASC. wei amounts cast back to int."""

    rows = fetch_all(
        "SELECT block_number, tx_hash, log_index, token_address, side, "
        "trader_address, base_value, token_value, fee, "
        "EXTRACT(EPOCH FROM ts)::bigint AS timestamp "
        "FROM events WHERE token_address = %s "
        "ORDER BY block_number ASC, log_index ASC",
        (token,),
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


def _build_my_wallet(token: str, wallet: str) -> dict[str, Any]:
    """Compose the ``myWallet`` block (camelCase) for ``wallet`` on ``token``."""

    events = _load_events(token)
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
    position = pos["position"]
    sold = max(pos["bought"] - position, 0.0)
    position_value = position * current_price
    spent = pos["spent"]
    avg_net = pos["avg_net"]
    total_pnl = pos["total_pnl"]
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
        "unrealizedPnl": round(pos["unrealized_pnl"], 4),
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
@require_premium_stub
def get_position(token: str) -> Any:
    """Per-token ``myWallet`` block for the authenticated session (spec §4.4)."""

    addr = _normalize_token_or_404(token)
    wallet = g.address  # set by require_auth via require_premium_stub
    body = _build_my_wallet(addr, wallet)
    return jsonify(body)


def build_my_wallet(token: str, wallet: str) -> dict[str, Any]:
    """Public façade exposed for cross-module reuse (e.g. by ``/trades`` in B0.12)."""

    return _build_my_wallet(token, wallet)


__all__ = ["bp", "build_my_wallet"]
