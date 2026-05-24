"""``GET /api/v1/stream`` — Server-Sent Events (SSE) for prices/events/config.

Per ``docs/api-spec.md`` §8:

* Streams ``text/event-stream`` with no-cache / no-transform / X-Accel-Buffering.
* Heartbeat ``: keepalive\\n\\n`` every 25 seconds prevents idle-proxy drops.
* Subscribes to Postgres LISTEN channels ``pt_prices``, ``pt_events``,
  ``pt_config``. Premium sessions additionally subscribe to ``pt_orders``
  (filtered to the caller's own orders) per B2.2.

Architecture:

1. Each client request opens a dedicated psycopg ``Listener`` (one connection
   per SSE subscriber). The handler returns a Flask streaming response built
   from a generator.

2. The generator loops over ``listener.listen(timeout=25.0)``. The
   ``timeout`` argument doubles as the heartbeat cadence — when no NOTIFY
   arrives within 25 s the generator exits the inner loop, yields a
   ``: keepalive`` comment, and re-enters the listen loop.

3. On each NOTIFY:
   * ``pt_prices`` — payload is ``["0xabc", ...]`` (lowercase addresses) or
     ``[]`` (stale-indicator). Reads ``market_state`` rows for those
     addresses, formats them per api-spec §8.3 ``event: prices``.
   * ``pt_events`` — payload is ``[id, id, ...]``. Reads ``events`` rows by id
     and formats them per api-spec §8.3 ``event: events``.
   * ``pt_config`` — payload is already a full snapshot; re-translated as-is
     under ``event: config``. Also invalidates the in-process /config cache.

4. The ``id:`` field is a monotonic counter per connection (spec §8.2 — not
   global; server ignores Last-Event-ID on reconnect — front does ``GET``
   catch-up).

5. On client disconnect (broken pipe / ``GeneratorExit``) the ``with
   Listener(...)`` exit cleans up the dedicated connection.

gevent compatibility:

* :mod:`shared.db` is psycogreen-patched when running under gevent — all
  blocking ``select`` / socket reads cooperate with the event loop.
* Flask's streaming response yields bytes one chunk at a time; Werkzeug's
  dev-server flushes per-yield, gunicorn-gevent flushes per-yield too.

Rate limits (api-spec §11):

* 5 connections / IP. Per-address (2) requires SIWE — added in B0.10.
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Iterator
from typing import Any

from flask import Blueprint, Response, stream_with_context

from app.deps import SESSION_COOKIE
from app.errors import abort_with_problem
from app.routes import config as config_routes
from shared.access import is_premium
from shared.db import fetch_all, fetch_one
from shared.jwt import JwtError
from shared.jwt import decode as jwt_decode
from shared.log import get_logger
from shared.notify import Listener

bp = Blueprint("stream", __name__)
log = get_logger("app.stream")

# Heartbeat cadence per api-spec §8.1 — also doubles as the listen() timeout
# so the generator wakes up to send keepalives even if NOTIFY traffic is idle.
KEEPALIVE_INTERVAL_SEC = 25.0


def _fmt_event(event: str, event_id: int, data: dict[str, Any] | list[Any]) -> str:
    """Build one SSE event frame (with the mandatory blank-line terminator).

    Per the WHATWG EventSource spec each field ends with ``\\n`` and the frame
    is terminated by a blank line. ``json.dumps`` uses compact separators to
    match the rest of the API (smaller payloads).
    """

    payload = json.dumps(data, separators=(",", ":"))
    return f"event: {event}\nid: {event_id}\ndata: {payload}\n\n"


def _keepalive() -> str:
    """SSE comment line — ignored by EventSource clients, keeps proxies alive."""

    return ": keepalive\n\n"


def _fetch_prices(addresses: list[str]) -> dict[str, Any]:
    """Fetch market_state rows for ``addresses`` and build the prices payload.

    Empty ``addresses`` is the "stale" signal (api-spec §8.3) — we forward it
    as ``{tokens: [], stale: True}`` exactly once and let the front render the
    indicator. The ``updatedAt`` field uses now() as a coarse upper bound.

    Token prices are converted from wei → float via int / 1e18; that matches
    the JSON-number convention in api-spec §1.2 (prices are <100, no precision
    loss for the chart). Wei values stay as strings in REST endpoints, but the
    SSE delta is informational only — the front re-fetches /tokens for the
    canonical wei value if needed.
    """

    now_ts = int(time.time())
    if not addresses:
        return {"updatedAt": now_ts, "stale": True, "tokens": []}

    # ``IN %s`` with psycopg-3 ``execute_values``-style would need a tuple;
    # for a small array (<=192) building the IN-list with the array literal is
    # safer (positional arg, no concat).
    rows = fetch_all(
        """
        SELECT token_address, price_pitch, price_country, updated_at
        FROM market_state
        WHERE token_address = ANY(%s)
        """,
        (addresses,),
    )
    tokens = []
    for row in rows:
        price_pitch_wei = int(row["price_pitch"])
        price_country_wei = int(row["price_country"])
        tokens.append(
            {
                "address": row["token_address"],
                "pricePitch": price_pitch_wei / 1e18,
                "priceCountry": price_country_wei / 1e18,
            }
        )
    return {"updatedAt": now_ts, "stale": False, "tokens": tokens}


def _fetch_events(ids: list[int]) -> dict[str, Any]:
    """Fetch ``events`` rows by id; build the ``event: events`` payload."""

    if not ids:
        return {"newTrades": []}
    rows = fetch_all(
        """
        SELECT id, token_address, side, trader_address,
               base_value, token_value, fee, tx_hash, ts
        FROM events
        WHERE id = ANY(%s)
        ORDER BY id ASC
        """,
        (ids,),
    )
    trades = []
    for row in rows:
        base = int(row["base_value"]) / 1e18
        tok = int(row["token_value"]) / 1e18
        fee = int(row["fee"]) / 1e18
        # Effective price (incl. fee).
        eff_price = base / tok if tok > 0 else 0.0
        # Market price (fee-excluded) per shared.price.market_price formula:
        # buy: (base - fee) / tok; sell: (base + fee) / tok.
        if row["side"] == "buy":
            market_price = (base - fee) / tok if tok > 0 else 0.0
        else:
            market_price = (base + fee) / tok if tok > 0 else 0.0
        trades.append(
            {
                "token": row["token_address"],
                "type": row["side"],
                "trader": row["trader_address"],
                "baseValue": base,
                "tokenValue": tok,
                "price": eff_price,
                "marketPrice": market_price,
                "fee": fee,
                "tx": row["tx_hash"],
                "timestamp": int(row["ts"].timestamp()) if row["ts"] is not None else 0,
            }
        )
    return {"newTrades": trades}


def _fetch_order_for_owner(order_id: int, owner_address: str) -> dict[str, Any] | None:
    """Return order delta payload for ``order_id`` iff it belongs to ``owner_address``.

    Returns ``None`` when:
      * the row is missing (race with delete — should not happen, but defensive);
      * the row belongs to a different owner (do NOT leak existence).

    Payload shape matches docs/api-spec.md §8.3 ``event: orders`` — a dict
    ``{"order": {id, status, executedTxHash, failReason, updatedAt}}``.
    The signature is deliberately NOT included (premium-leaky in transit + at
    rest in browser memory dumps).
    """

    row = fetch_one(
        "SELECT id, owner_address, status, executed_tx_hash, fail_reason, "
        "EXTRACT(EPOCH FROM COALESCE(last_attempt_at, created_at))::bigint "
        "  AS updated_at_ts "
        "FROM limit_orders WHERE id = %s",
        (order_id,),
    )
    if row is None:
        return None
    row_owner = row["owner_address"].strip().lower()
    if row_owner != owner_address.lower():
        return None
    return {
        "order": {
            "id": str(row["id"]),
            "status": row["status"],
            "executedTxHash": (
                row["executed_tx_hash"].strip() if row.get("executed_tx_hash") else None
            ),
            "failReason": row.get("fail_reason"),
            "updatedAt": int(row["updated_at_ts"]) if row.get("updated_at_ts") else 0,
        }
    }


def _parse_order_id(payload: str) -> int | None:
    """Decode a ``pt_orders`` payload — single ``limit_orders.id`` as text."""

    try:
        return int(payload.strip())
    except (ValueError, TypeError):
        log.warning("stream.pt_orders.bad_payload", payload=payload[:200])
        return None


def _parse_addresses(payload: str) -> list[str]:
    """Decode a ``pt_prices`` payload — JSON-array of lowercase addresses.

    Returns ``[]`` if the payload is malformed (logged); the empty list is
    also the stale-indicator from the worker so the downstream formatter
    handles both uniformly.
    """

    try:
        parsed = json.loads(payload)
        if not isinstance(parsed, list):
            return []
        return [str(a).lower() for a in parsed]
    except (ValueError, TypeError):
        log.warning("stream.pt_prices.bad_payload", payload=payload[:200])
        return []


def _parse_event_ids(payload: str) -> list[int]:
    """Decode a ``pt_events`` payload — JSON-array of ``events.id`` BIGINTs."""

    try:
        parsed = json.loads(payload)
        if not isinstance(parsed, list):
            return []
        return [int(x) for x in parsed]
    except (ValueError, TypeError):
        log.warning("stream.pt_events.bad_payload", payload=payload[:200])
        return []


def _stream_generator(premium_owner: str | None = None) -> Iterator[str]:
    """The SSE generator. Yields strings; Flask encodes to bytes.

    Args:
        premium_owner: lowercase address of an authenticated **premium** caller.
            When set, the listener also subscribes to ``pt_orders`` and emits
            ``event: orders`` frames filtered to rows where
            ``owner_address == premium_owner``. ``None`` means anonymous /
            free-tier — no orders channel.
    """

    next_id = 1
    last_keepalive = time.monotonic()
    # Initial prelude: an immediate comment so the client sees bytes right
    # away (some proxies wait for headers + first chunk before opening the
    # response to the browser).
    yield _keepalive()

    channels = ["pt_prices", "pt_events", "pt_config"]
    if premium_owner is not None:
        channels.append("pt_orders")

    try:
        with Listener(channels) as listener:
            while True:
                got_any = False
                # listen() blocks up to KEEPALIVE_INTERVAL_SEC; under gevent
                # the greenlet sleeps. Each iteration yields all pending
                # notifications, then exits so we can send a keepalive.
                for notif in listener.listen(timeout=KEEPALIVE_INTERVAL_SEC):
                    got_any = True
                    channel = notif.channel
                    payload = notif.payload
                    try:
                        if channel == "pt_prices":
                            addrs = _parse_addresses(payload)
                            data = _fetch_prices(addrs)
                            yield _fmt_event("prices", next_id, data)
                            next_id += 1
                        elif channel == "pt_events":
                            ids = _parse_event_ids(payload)
                            data = _fetch_events(ids)
                            # Skip empty deltas — spec §8.3 says events frames
                            # are only sent when there's at least one trade.
                            if data["newTrades"]:
                                yield _fmt_event("events", next_id, data)
                                next_id += 1
                        elif channel == "pt_config":
                            # Payload IS the snapshot — pass-through, no DB read.
                            try:
                                snapshot = json.loads(payload)
                            except (ValueError, TypeError):
                                log.warning(
                                    "stream.pt_config.bad_payload",
                                    payload=payload[:200],
                                )
                                continue
                            # Invalidate the /config cache — next /config (no
                            # ?fresh=1) sees the fresh values immediately.
                            config_routes.invalidate_cache()
                            yield _fmt_event("config", next_id, snapshot)
                            next_id += 1
                        elif channel == "pt_orders":
                            # premium-only — channel is only listened when
                            # ``premium_owner`` was set in the request handler.
                            # Double-guard here in case Postgres delivers a
                            # stale notification from a previous subscription.
                            if premium_owner is None:
                                continue
                            oid = _parse_order_id(payload)
                            if oid is None:
                                continue
                            order_data = _fetch_order_for_owner(oid, premium_owner)
                            if order_data is None:
                                # Not our order (or vanished) → skip silently
                                # to avoid leaking existence of other users'
                                # orders.
                                continue
                            yield _fmt_event("orders", next_id, order_data)
                            next_id += 1
                    except Exception:
                        log.exception("stream.notify_handler_failed", channel=channel)

                # Keepalive cadence — only emit if the elapsed wall-clock
                # exceeds the interval (avoids double-emit when traffic was
                # heavy enough to keep the loop short).
                now_mono = time.monotonic()
                if not got_any or (now_mono - last_keepalive) >= KEEPALIVE_INTERVAL_SEC:
                    yield _keepalive()
                    last_keepalive = now_mono
    except GeneratorExit:
        # Normal client disconnect — clean shutdown handled by Listener
        # context manager exit.
        log.debug("stream.client_disconnect")
        raise
    except Exception:
        log.exception("stream.generator_failed")
        return


# H-1 fix (review I): the spec says "5 conn / IP" (concurrent), not "5
# requests per minute". A fixed-window rate-limit triggers 429 after a few
# flaps and locks the client out for the rest of the window. We track live
# connections in a process-local counter under a lock. The counter is best-
# effort across multi-worker setups (each gunicorn worker has its own); the
# real per-deployment cap is enforced by Caddy in front (see infra/Caddyfile).
_MAX_CONNECTIONS_PER_IP = 5
_live_connections: dict[str, int] = {}
_live_lock = threading.Lock()


def _acquire_slot(ip: str) -> bool:
    """Try to reserve a connection slot for ``ip``. Returns False if at cap."""

    with _live_lock:
        cur = _live_connections.get(ip, 0)
        if cur >= _MAX_CONNECTIONS_PER_IP:
            return False
        _live_connections[ip] = cur + 1
    return True


def _release_slot(ip: str) -> None:
    with _live_lock:
        cur = _live_connections.get(ip, 0)
        if cur <= 1:
            _live_connections.pop(ip, None)
        else:
            _live_connections[ip] = cur - 1


@bp.get("/api/v1/stream")
def stream() -> Response:
    """Open an SSE stream. Returns headers immediately and streams events.

    Anonymous clients receive ``prices``, ``events``, ``config`` (FREE);
    the ``orders`` channel requires premium and ships in phase 2.

    Connection-limit (review I, H-1): max 5 concurrent connections per IP
    enforced in this process. EventSource auto-reconnects every 3s on
    transient failures, so a fixed-window rate-limit would lock clients out
    after a few flaps — concurrent-gauge fits the workload.

    Premium-gating (B2.2): if the request carries a valid ``pt_session``
    cookie AND :func:`shared.access.is_premium` returns ``has_access=True``,
    the generator additionally subscribes to ``pt_orders`` and emits
    ``event: orders`` frames filtered to the caller's own orders. Anonymous /
    expired / free-tier sessions silently fall through to the free channel
    set — no error is raised (api-spec §8.1 says ``orders`` is opt-in by
    premium, not by a separate endpoint).

    TODO (post-MVP): enforce 2/address for any authenticated session
    (api-spec §8.4) once SIWE per-session telemetry lands.
    """

    from flask import request

    client_ip = request.remote_addr or "unknown"
    if not _acquire_slot(client_ip):
        abort_with_problem(
            code="rate_limit.exceeded",
            title="Too many concurrent connections",
            status=429,
            detail=f"Maximum {_MAX_CONNECTIONS_PER_IP} SSE connections per IP",
        )

    # Resolve premium-owner BEFORE entering the streaming generator. Any
    # auth / RPC failure is silently swallowed — anonymous clients still get
    # the public channels. We never raise 401/402 from /stream itself; the
    # ``orders`` channel is opt-in by capability, not by error.
    premium_owner: str | None = None
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        try:
            address = jwt_decode(token)
            status = is_premium(address)
            if status.has_access:
                premium_owner = address.lower()
        except JwtError:
            premium_owner = None
        except Exception:
            log.exception("stream.premium_check_failed")
            premium_owner = None

    def generator_with_release():
        try:
            yield from _stream_generator(premium_owner=premium_owner)
        finally:
            _release_slot(client_ip)

    response = Response(
        stream_with_context(generator_with_release()),
        mimetype="text/event-stream",
    )
    response.headers["Cache-Control"] = "no-cache, no-transform"
    response.headers["X-Accel-Buffering"] = "no"
    # H-2 fix (review I): `Connection: keep-alive` is a hop-by-hop header
    # which PEP 3333 forbids WSGI apps from setting. gunicorn strips it
    # silently; werkzeug's dev server may warn. Buffering is already disabled
    # by `X-Accel-Buffering: no` for nginx-class proxies.
    return response


__all__ = ["bp"]
