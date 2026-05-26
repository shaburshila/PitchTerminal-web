"""``/api/v1/orders`` — limit-order CRUD + keeper-only ``/armed`` query.

Per docs/api-spec.md §7 + docs/plans/backend.md B2.1. Endpoints:

* ``GET    /api/v1/orders``                — list caller's orders (PREMIUM).
* ``POST   /api/v1/orders``                — create + persist signed order (PREMIUM).
* ``DELETE /api/v1/orders/{id}``           — cancel own pending order (PREMIUM).
* ``GET    /api/v1/orders/armed``          — keeper-only: list orders armed for
  execution at the current market price (auth via ``X-Keeper-Token`` header).

Out-of-scope for B2.1 (handled by sibling tasks):

* SSE channel ``pt_orders`` consumption → B2.2.
* Keeper tick / on-chain execution → B2.3.
* Expiry cycle (``status='open' AND expires_at <= now()``) → B2.4.

We still emit the ``pt_orders`` NOTIFY on insert so the channel is ready to be
plugged in by B2.2 without round-tripping through B2.1.

Authentication for ``/armed``: a constant-time match of the header against the
``KEEPER_AUTH_TOKEN`` env var (a placeholder shared secret). The keeper runs in
the same trust boundary as the API; a stronger story (mTLS / signed requests)
arrives with the production keeper rollout in B2.3.
"""

from __future__ import annotations

import contextlib
import hmac
import os
import time
from typing import Any

from flask import Blueprint, current_app, g, jsonify, request
from psycopg import errors as pg_errors

from app.deps import require_premium
from app.errors import abort_with_problem
from app.limits import limiter
from shared.config import config
from shared.db import fetch_all, fetch_one, get_conn
from shared.fee import execution_to_mid_wei
from shared.notify import notify
from shared.orders import (
    OrderIn,
    OrderStatus,
    OrderVenue,
    QuoteTokenError,
    validate_quote_token,
    venue_from_int,
    verify_order_signature,
)

bp = Blueprint("orders", __name__)

_MIN_EXPIRY_MARGIN_SEC = 60
_TARGET_PRICE_TOLERANCE_BPS = 10  # 0.1% — api-spec §7.2 check #7
_NOTIFY_CHANNEL = "pt_orders"


# ─── Helpers ────────────────────────────────────────────────────────────────


def _addr_key() -> str:
    return getattr(g, "address", None) or request.remote_addr or "anonymous"


def _problem_quote_token() -> None:
    abort_with_problem(
        code="orders.bad_quote_token",
        title="quoteToken does not match expected pair",
        status=422,
    )


def _parse_order_payload(payload: dict[str, Any]) -> tuple[OrderIn, bytes]:
    """Validate request body into ``(OrderIn, signature_bytes)``.

    Raises HTTP problems on shape errors (422 ``validation.bad_request``).
    """

    order_raw = payload.get("order")
    sig_raw = payload.get("signature")
    if not isinstance(order_raw, dict):
        abort_with_problem(
            code="validation.bad_request",
            title="Bad Request",
            status=400,
            detail="Body must contain `order` object",
        )
    if not isinstance(sig_raw, str) or not sig_raw.startswith(("0x", "0X")):
        abort_with_problem(
            code="validation.bad_request",
            title="Bad Request",
            status=400,
            detail="Body must contain `signature` as 0x-hex string",
        )
    assert isinstance(sig_raw, str)
    assert isinstance(order_raw, dict)
    try:
        order = OrderIn(**order_raw)
    except Exception as exc:
        abort_with_problem(
            code="validation.bad_request",
            title="Bad Request",
            status=400,
            detail=f"order schema: {exc}",
        )
        raise AssertionError("unreachable") from exc  # for type-checker

    try:
        sig_hex = sig_raw[2:] if sig_raw.startswith(("0x", "0X")) else sig_raw
        signature = bytes.fromhex(sig_hex)
    except ValueError:
        abort_with_problem(
            code="validation.bad_request",
            title="Bad Request",
            status=400,
            detail="signature is not valid hex",
        )
        raise AssertionError("unreachable") from None

    if len(signature) not in (64, 65):
        abort_with_problem(
            code="validation.bad_request",
            title="Bad Request",
            status=400,
            detail="signature length must be 64 or 65 bytes",
        )

    return order, signature


def _venue_from_int(v: int) -> OrderVenue:
    return venue_from_int(v)


def _token_meta_or_404(addr: str) -> dict[str, Any]:
    row = fetch_one(
        "SELECT address, kind, country_address, symbol FROM tokens WHERE address = %s",
        (addr.lower(),),
    )
    if row is None:
        abort_with_problem(code="tokens.unknown", title="Unknown token", status=404)
        raise AssertionError("unreachable")
    return row


def _current_market_price(token_address: str, venue: OrderVenue) -> int | None:
    """Read ``currentPrice`` for the (token, venue) pair from ``market_state``.

    Returns ``None`` if the market_state row is missing (worker has not seen
    the token yet). For player venue the quote is country-wei; for country
    venue it's PITCH-wei — both are tracked in ``market_state``.
    """

    row = fetch_one(
        "SELECT price_country, price_pitch FROM market_state WHERE token_address = %s",
        (token_address.lower(),),
    )
    if row is None:
        return None
    if venue == OrderVenue.PLAYER:
        return int(row["price_country"])
    return int(row["price_pitch"])


def _serialize_row(row: dict[str, Any]) -> dict[str, Any]:
    """Shape a ``limit_orders`` row for the API response (api-spec §7.1)."""

    expires_ts: int | None = None
    if row.get("expires_at_ts") is not None:
        expires_ts = int(row["expires_at_ts"])

    # display_target_price is NULL for pre-migration-0004 rows; return it
    # as None and let the frontend derive a display value if it cares.
    display_target = row.get("display_target_price")
    display_target_str = str(int(display_target)) if display_target is not None else None

    return {
        "id": str(row["id"]),
        "owner": row["owner_address"].strip(),
        "token": row["token_address"].strip(),
        "quoteToken": row["quote_address"].strip(),
        "tokenSymbol": row.get("token_symbol"),
        "tokenKind": row.get("token_kind"),
        "venue": row["venue"],
        "side": row["side"],
        "targetPrice": str(int(row["target_price"])),
        "displayTargetPrice": display_target_str,
        "amountIn": str(int(row["amount_in"])),
        "slippageBps": int(row["slippage_bps"]),
        "expiresAt": expires_ts,
        "nonce": row["nonce"].strip(),
        "status": row["status"],
        "createdAt": int(row["created_at_ts"]),
        "executedTxHash": (
            row["executed_tx_hash"].strip() if row.get("executed_tx_hash") else None
        ),
        "failReason": row.get("fail_reason"),
        "failDetail": row.get("fail_detail"),
    }


def _is_armed(owner: str) -> bool:
    row = fetch_one(
        "SELECT orders_armed FROM user_settings WHERE owner_address = %s",
        (owner.lower(),),
    )
    if row is None:
        return True
    return bool(row["orders_armed"])


# ─── GET /api/v1/orders ─────────────────────────────────────────────────────


@bp.get("/api/v1/orders")
@limiter.limit("300 per minute", key_func=_addr_key)
@require_premium
def list_orders() -> Any:
    """List caller's limit orders, filtered by ``?status=`` and ``?token=``."""

    status_param = request.args.get("status")
    token_param = request.args.get("token")

    sql_parts = [
        "SELECT lo.id, lo.owner_address, lo.token_address, lo.quote_address, "
        "lo.venue, lo.side, lo.target_price, lo.display_target_price, "
        "lo.amount_in, lo.slippage_bps, "
        "EXTRACT(EPOCH FROM lo.expires_at)::bigint AS expires_at_ts, "
        "lo.nonce, lo.status, "
        "EXTRACT(EPOCH FROM lo.created_at)::bigint AS created_at_ts, "
        "lo.executed_tx_hash, lo.fail_reason, lo.fail_detail, "
        "t.symbol AS token_symbol, t.kind AS token_kind "
        "FROM limit_orders lo LEFT JOIN tokens t ON t.address = lo.token_address "
        "WHERE lo.owner_address = %s"
    ]
    params: list[Any] = [g.address.lower()]

    if status_param:
        statuses = [s.strip() for s in status_param.split(",") if s.strip()]
        valid = {s.value for s in OrderStatus}
        bad = [s for s in statuses if s not in valid]
        if bad:
            abort_with_problem(
                code="validation.bad_request",
                title="Bad Request",
                status=400,
                detail=f"unknown status value(s): {bad}",
            )
        sql_parts.append("AND lo.status = ANY(%s)")
        params.append(statuses)

    if token_param:
        sql_parts.append("AND lo.token_address = %s")
        params.append(token_param.lower())

    sql_parts.append("ORDER BY lo.id DESC LIMIT 200")

    rows = fetch_all(" ".join(sql_parts), tuple(params))
    items = [_serialize_row(r) for r in rows]
    return jsonify(
        {
            "items": items,
            "nextCursor": None,
            "limit": 200,
            "armed": _is_armed(g.address),
        }
    )


# ─── POST /api/v1/orders ────────────────────────────────────────────────────


def _ensure_target_price_not_yet_met(
    order: OrderIn, venue: OrderVenue, market_price: int | None
) -> None:
    """422 ``orders.bad_target_price`` if the price condition already triggers.

    Per api-spec §7.2 #7: blocks accidental market-as-limit. Tolerance 0.1%.
    Skipped when ``market_price is None`` (worker hasn't seen the token yet —
    keeper will catch it on the first tick).

    Both sides of the comparison live in MID-space:

    * ``market_price`` — fee-free MID from ``market_state.price_*``
      (= ``Hook.currentPrice``).
    * Target — the user-typed MID. We prefer ``displayTargetPrice`` from
      the request body; for legacy clients that don't send it we derive
      MID from the signed execution-space ``targetPrice`` via the fixed
      pitchwc fee constant (see :mod:`shared.fee`).
    """

    if market_price is None or market_price == 0:
        return

    side_int = int(order.side)
    # Resolve MID-space target. ``side_int`` 0=limit-buy, 1=take-profit;
    # ``execution_to_mid_wei`` understands both naming conventions.
    side_label = "limit-buy" if side_int == 0 else "take-profit"
    if order.displayTargetPrice is not None:
        target_mid = int(order.displayTargetPrice)
    else:
        target_mid = execution_to_mid_wei(int(order.targetPrice), side_label)

    tol = (target_mid * _TARGET_PRICE_TOLERANCE_BPS) // 10_000
    if side_int == 0:  # limit-buy: triggers when market_mid <= target_mid
        if market_price <= target_mid + tol:
            abort_with_problem(
                code="orders.bad_target_price",
                title="Target price already met",
                status=422,
                detail="current market price already satisfies the condition",
            )
    else:  # take-profit: triggers when market_mid >= target_mid
        if market_price + tol >= target_mid:
            abort_with_problem(
                code="orders.bad_target_price",
                title="Target price already met",
                status=422,
                detail="current market price already satisfies the condition",
            )


def _existing_order_for_nonce(owner: str, nonce: str) -> dict[str, Any] | None:
    row = fetch_one(
        "SELECT lo.id, lo.owner_address, lo.token_address, lo.quote_address, "
        "lo.venue, lo.side, lo.target_price, lo.display_target_price, "
        "lo.amount_in, lo.slippage_bps, "
        "EXTRACT(EPOCH FROM lo.expires_at)::bigint AS expires_at_ts, "
        "lo.nonce, lo.status, lo.signature, "
        "EXTRACT(EPOCH FROM lo.created_at)::bigint AS created_at_ts, "
        "lo.executed_tx_hash, lo.fail_reason, lo.fail_detail, "
        "t.symbol AS token_symbol, t.kind AS token_kind "
        "FROM limit_orders lo LEFT JOIN tokens t ON t.address = lo.token_address "
        "WHERE lo.owner_address = %s AND lo.nonce = %s",
        (owner.lower(), nonce.lower()),
    )
    return row


def _same_order(existing: dict[str, Any], new: OrderIn, new_sig: bytes) -> bool:
    """Idempotency check: same nonce + same canonical fields + same signature.

    ``display_target_price`` is part of the canonical comparison even
    though it's not in the signature — replaying the same request with a
    different MID-space label would change keeper behaviour, so we treat
    a mismatch as "different order, 409". Two NULL values compare equal.
    """

    if existing["token_address"].strip().lower() != new.token.lower():
        return False
    if existing["quote_address"].strip().lower() != new.quoteToken.lower():
        return False
    if existing["venue"] != ("player" if int(new.venue) == 0 else "country"):
        return False
    if existing["side"] != ("limit-buy" if int(new.side) == 0 else "take-profit"):
        return False
    if int(existing["target_price"]) != int(new.targetPrice):
        return False
    existing_display = existing.get("display_target_price")
    new_display = new.displayTargetPrice
    if existing_display is None and new_display is not None:
        return False
    if existing_display is not None and new_display is None:
        return False
    if (
        existing_display is not None
        and new_display is not None
        and int(existing_display) != int(new_display)
    ):
        return False
    if int(existing["amount_in"]) != int(new.amountIn):
        return False
    if int(existing["slippage_bps"]) != int(new.slippageBps):
        return False
    # expires_at: NULL <=> expiry==0
    exp_ts = existing.get("expires_at_ts")
    if new.expiry == 0 and exp_ts is not None:
        return False
    if new.expiry != 0 and (exp_ts is None or int(exp_ts) != int(new.expiry)):
        return False
    return bytes(existing["signature"]) == new_sig


@bp.post("/api/v1/orders")
@limiter.limit("30 per hour", key_func=_addr_key)
@require_premium
def create_order() -> Any:
    """Validate + persist a signed limit order (api-spec §7.2)."""

    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        abort_with_problem(
            code="validation.bad_request",
            title="Bad Request",
            status=400,
            detail="body must be a JSON object",
        )

    order, signature = _parse_order_payload(payload)

    # 1. owner == JWT address
    if order.owner.lower() != g.address.lower():
        abort_with_problem(
            code="auth.unauthenticated",
            title="Order owner does not match session",
            status=401,
        )

    # 2. slippage / amountIn / expiry sanity
    if order.slippageBps > config.max_slippage_bps:
        abort_with_problem(
            code="orders.slippage_too_high",
            title="slippageBps exceeds MAX_SLIPPAGE_BPS",
            status=422,
        )

    now = int(time.time())
    if order.expiry != 0 and order.expiry <= now + _MIN_EXPIRY_MARGIN_SEC:
        abort_with_problem(
            code="orders.expired",
            title="Order expiry already passed (or too close to now)",
            status=422,
        )

    # 3. Token must be in registry. quoteToken must match seed.
    token_meta = _token_meta_or_404(order.token)
    venue = _venue_from_int(int(order.venue))

    try:
        validate_quote_token(
            order=order,
            venue=venue,
            token_kind=token_meta["kind"],
            country_address=(
                token_meta["country_address"].strip() if token_meta["country_address"] else None
            ),
        )
    except QuoteTokenError:
        _problem_quote_token()

    # 4. EIP-712 signature
    if not verify_order_signature(order, signature):
        abort_with_problem(
            code="orders.invalid_signature",
            title="EIP-712 signature does not match owner",
            status=422,
        )

    # 5. displayTargetPrice (non-signed) must agree with the signed
    #    execution-space targetPrice within tolerance. Without this check the
    #    keeper could be tricked into firing at the wrong MID-space threshold
    #    via a tampered displayTargetPrice on an otherwise legitimately-signed
    #    order. ``displayTargetPrice is None`` is allowed (pre-0004 clients).
    if order.displayTargetPrice is not None and int(order.targetPrice) > 0:
        side_label = "limit-buy" if int(order.side) == 0 else "take-profit"
        expected_mid = execution_to_mid_wei(int(order.targetPrice), side_label)
        provided_mid = int(order.displayTargetPrice)
        tol = (expected_mid * _TARGET_PRICE_TOLERANCE_BPS) // 10_000
        if abs(provided_mid - expected_mid) > tol:
            abort_with_problem(
                code="orders.display_price_mismatch",
                title="displayTargetPrice does not match signed targetPrice",
                status=400,
                detail=(
                    "displayTargetPrice must equal MID(targetPrice, side) within " "0.1% tolerance"
                ),
            )

    # 6. Target price not yet met (best-effort; relies on market_state cache)
    market_price = _current_market_price(order.token, venue)
    _ensure_target_price_not_yet_met(order, venue, market_price)

    # 7. Idempotency + race protection on (owner, nonce)
    existing = _existing_order_for_nonce(order.owner, order.nonce)
    if existing is not None:
        if _same_order(existing, order, signature):
            return jsonify(_serialize_row(existing)), 200
        abort_with_problem(
            code="orders.duplicate_nonce",
            title="Order with this (owner, nonce) already exists with different payload",
            status=409,
        )

    # 8. Insert
    expires_at_sql = "to_timestamp(%s)" if order.expiry != 0 else "NULL"
    display_target_param: int | None = (
        int(order.displayTargetPrice) if order.displayTargetPrice is not None else None
    )
    insert_params: list[Any] = [
        order.owner.lower(),
        order.token.lower(),
        order.quoteToken.lower(),
        ("player" if int(order.venue) == 0 else "country"),
        ("limit-buy" if int(order.side) == 0 else "take-profit"),
        int(order.targetPrice),
        display_target_param,
        int(order.amountIn),
        int(order.slippageBps),
    ]
    if order.expiry != 0:
        insert_params.append(int(order.expiry))
    insert_params.extend([order.nonce.lower(), signature])

    sql = (
        "INSERT INTO limit_orders ("
        "owner_address, token_address, quote_address, venue, side, "
        "target_price, display_target_price, amount_in, slippage_bps, "
        "expires_at, nonce, signature"
        f") VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,{expires_at_sql},%s,%s) "
        "RETURNING id, owner_address, token_address, quote_address, venue, side, "
        "target_price, display_target_price, amount_in, slippage_bps, "
        "EXTRACT(EPOCH FROM expires_at)::bigint AS expires_at_ts, "
        "nonce, status, EXTRACT(EPOCH FROM created_at)::bigint AS created_at_ts, "
        "executed_tx_hash, fail_reason, fail_detail"
    )

    try:
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(sql, tuple(insert_params))
            row = cur.fetchone()
    except pg_errors.UniqueViolation:
        # Lost race: another request inserted the same (owner, nonce) between
        # our SELECT and INSERT. Re-fetch + compare for idempotency.
        existing = _existing_order_for_nonce(order.owner, order.nonce)
        if existing is not None and _same_order(existing, order, signature):
            return jsonify(_serialize_row(existing)), 200
        abort_with_problem(
            code="orders.duplicate_nonce",
            title="Order with this (owner, nonce) already exists with different payload",
            status=409,
        )

    assert row is not None
    row = dict(row)
    # Enrich with token meta so the response carries `tokenSymbol`/`tokenKind`.
    row["token_symbol"] = token_meta["symbol"]
    row["token_kind"] = token_meta["kind"]

    # Best-effort NOTIFY so the (future) SSE channel and the keeper can react.
    try:
        notify(_NOTIFY_CHANNEL, str(row["id"]))
    except Exception:
        # notify() already logs + swallows; defensive double-guard here.
        current_app.logger.warning("orders.notify_failed", exc_info=True)

    return jsonify(_serialize_row(row)), 200


# ─── DELETE /api/v1/orders/{id} ─────────────────────────────────────────────


@bp.delete("/api/v1/orders/<order_id>")
@limiter.limit("30 per minute", key_func=_addr_key)
@require_premium
def cancel_order(order_id: str) -> Any:
    """Cancel a pending order (api-spec §7.3). Idempotent on already-cancelled."""

    try:
        oid = int(order_id)
    except ValueError:
        abort_with_problem(code="orders.not_found", title="Order not found", status=404)
        raise AssertionError("unreachable") from None

    row = fetch_one(
        "SELECT id, owner_address, status FROM limit_orders WHERE id = %s",
        (oid,),
    )
    if row is None or row["owner_address"].strip().lower() != g.address.lower():
        # Per spec: do not leak existence of other users' orders.
        abort_with_problem(code="orders.not_found", title="Order not found", status=404)
        raise AssertionError("unreachable")

    status = row["status"]
    if status == OrderStatus.CANCELLED.value:
        return current_app.response_class(status=204)
    if status in {
        OrderStatus.FILLED.value,
        OrderStatus.EXPIRED.value,
        OrderStatus.FAILED.value,
        OrderStatus.EXECUTING.value,
    }:
        # Cannot cancel a terminal/in-flight order.
        abort_with_problem(
            code="orders.bad_state",
            title="Order cannot be cancelled in current status",
            status=422,
            detail=f"status={status}",
        )

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE limit_orders SET status='cancelled' WHERE id = %s AND status='open'",
            (oid,),
        )

    # Notify SSE consumers + keeper.
    with contextlib.suppress(Exception):
        notify(_NOTIFY_CHANNEL, str(oid))

    return current_app.response_class(status=204)


# ─── GET /api/v1/orders/armed (keeper-only) ─────────────────────────────────


def _keeper_authorized() -> bool:
    """Constant-time compare of ``X-Keeper-Token`` against ``KEEPER_AUTH_TOKEN``."""

    expected = os.environ.get("KEEPER_AUTH_TOKEN", "")
    if not expected:
        return False  # not configured → never authorise
    provided = request.headers.get("X-Keeper-Token", "")
    if not provided:
        return False
    return hmac.compare_digest(expected, provided)


@bp.get("/api/v1/orders/armed")
@limiter.exempt
def list_armed_orders() -> Any:
    """List orders whose price condition is currently satisfied (keeper-only).

    Filters:

    * ``status = 'open'``.
    * ``retry_after IS NULL OR now() >= retry_after``.
    * ``user_settings.orders_armed`` is true (or row missing — default true).
    * Order's price condition is met against the cached ``market_state`` row
      (limit-buy: ``market <= target``; take-profit: ``market >= target``).

    The keeper polls this endpoint at its own cadence; on-chain pre-flight
    simulation + execution lives in worker (B2.3).
    """

    if not _keeper_authorized():
        abort_with_problem(
            code="auth.unauthenticated",
            title="Keeper authentication required",
            status=401,
            detail="provide X-Keeper-Token header",
        )

    rows = fetch_all(
        "SELECT lo.id, lo.owner_address, lo.token_address, lo.quote_address, "
        "lo.venue, lo.side, lo.target_price, lo.display_target_price, "
        "lo.amount_in, lo.slippage_bps, "
        "EXTRACT(EPOCH FROM lo.expires_at)::bigint AS expires_at_ts, "
        "lo.nonce, lo.status, lo.signature, "
        "EXTRACT(EPOCH FROM lo.created_at)::bigint AS created_at_ts, "
        "lo.executed_tx_hash, lo.fail_reason, lo.fail_detail, "
        "ms.price_country, ms.price_pitch, "
        "COALESCE(us.orders_armed, true) AS armed, "
        "t.symbol AS token_symbol, t.kind AS token_kind "
        "FROM limit_orders lo "
        "LEFT JOIN tokens t        ON t.address = lo.token_address "
        "LEFT JOIN market_state ms ON ms.token_address = lo.token_address "
        "LEFT JOIN user_settings us ON us.owner_address = lo.owner_address "
        "WHERE lo.status = 'open' "
        "  AND (lo.retry_after IS NULL OR lo.retry_after <= now()) "
        "  AND (lo.expires_at IS NULL OR lo.expires_at > now()) "
        "ORDER BY lo.id ASC LIMIT 500"
    )

    # Trigger evaluation uses MID-space: market_state.price_* is fee-free
    # from Hook.currentPrice; the per-order target we compare is the MID-
    # space value the user typed (display_target_price), falling back to
    # deriving MID from the signed execution-space target_price when NULL.
    out = []
    for r in rows:
        if not bool(r["armed"]):
            continue
        venue = r["venue"]
        market_mid = int(r["price_country"]) if venue == "player" else int(r["price_pitch"])
        if market_mid == 0:
            continue  # worker has not seen the market yet
        side = r["side"]
        if r.get("display_target_price") is not None:
            target_mid = int(r["display_target_price"])
        else:
            target_mid = execution_to_mid_wei(int(r["target_price"]), side)
        triggers = (side == "limit-buy" and market_mid <= target_mid) or (
            side == "take-profit" and market_mid >= target_mid
        )
        if not triggers:
            continue
        payload = _serialize_row(r)
        payload["signature"] = "0x" + bytes(r["signature"]).hex()
        payload["currentPrice"] = str(market_mid)
        out.append(payload)

    return jsonify({"items": out, "count": len(out)})


__all__ = ["bp"]
