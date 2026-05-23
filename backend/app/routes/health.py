"""``GET /api/v1/health`` — liveness probe per docs/api-spec.md §9.1.

Intentionally an exception to RFC 7807: even on 503 the body stays
``application/json`` with a flat ``components`` map, so external uptime
monitors (UptimeRobot, BetterStack) can parse the response without a
content-type switch.

Component semantics (spec §9.1):

* ``api``: always ``"ok"`` — if this handler ran, the API process is alive.
* ``db``: SELECT 1 latency ``<100ms``  → ``ok``,
                              ``100..1000ms`` → ``slow``,
                              ``>1000ms`` or error → ``down``. ``down`` → 503.
* ``worker``: ``now - app_state.last_price_update < freshnessThresholdSec``
              → ``ok``; otherwise ``stale``. Never causes 503.
* ``rpc``: last successful ``eth.block_number`` <30s ago → ``ok``; otherwise
          ``stale``. Never causes 503.

``data`` carries auxiliary numbers (last price update, last event block,
freshSec, stale flag). Useful for dashboards.
"""

from __future__ import annotations

import time
from typing import Any

from flask import Blueprint, current_app, jsonify

from shared.config import config
from shared.db import get_conn

bp = Blueprint("health", __name__)

_DB_OK_THRESHOLD_MS = 100
_DB_SLOW_THRESHOLD_MS = 1000
_RPC_STALE_THRESHOLD_SEC = 30
_WORKER_STALE_THRESHOLD_SEC = 30  # falls back to config.freshness_threshold_sec


def _check_db() -> tuple[str, int | None]:
    """Return ``(status, latency_ms)`` for the DB SELECT 1 probe.

    ``statement_timeout`` is set per-session to bound the wait — without it a
    hung Postgres would keep the /health request open until its own client
    timeout. 1100ms gives us ~10% headroom over the ``down`` threshold.
    """

    start = time.perf_counter()
    try:
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute("SET LOCAL statement_timeout = 1100")
            cur.execute("SELECT 1")
            cur.fetchone()
        elapsed_ms = int((time.perf_counter() - start) * 1000)
    except Exception:
        return "down", None

    if elapsed_ms > _DB_SLOW_THRESHOLD_MS:
        return "down", elapsed_ms
    if elapsed_ms > _DB_OK_THRESHOLD_MS:
        return "slow", elapsed_ms
    return "ok", elapsed_ms


def _check_rpc() -> tuple[str, int | None]:
    """Return ``(status, block_number)``.

    Spec §9.1 says rpc is ``ok`` if the last successful ``eth.block_number``
    is <30s old. Right now we sample synchronously per /health call; later we
    can switch to the worker writing ``app_state.last_rpc_check`` and reading
    it here without the round-trip.
    """

    factory = current_app.config.get("W3_FACTORY")
    try:
        from shared.eth import get_w3

        w3 = factory() if factory else get_w3()
        block = int(w3.eth.block_number)
        return "ok", block
    except Exception:
        return "stale", None


def _read_app_state() -> dict[str, Any]:
    """Pull the values the ``data`` block needs in one round-trip."""

    out: dict[str, Any] = {
        "last_price_update": None,
        "last_event_block": None,
    }
    try:
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT key, value FROM app_state "
                "WHERE key IN ('last_price_update', 'last_scanned_block')"
            )
            for row in cur.fetchall():
                key, value = row[0], row[1]
                if key == "last_price_update":
                    # Stored as JSONB {"ts": 1709000000} (worker convention) or
                    # falls back to a raw int — handle both.
                    if isinstance(value, dict):
                        out["last_price_update"] = value.get("ts")
                    elif isinstance(value, int):
                        out["last_price_update"] = value
                elif key == "last_scanned_block":
                    if isinstance(value, dict):
                        out["last_event_block"] = value.get("block")
                    elif isinstance(value, int):
                        out["last_event_block"] = value
    except Exception:
        # If app_state can't be read, ``worker`` falls back to ``unknown``.
        pass
    return out


def _worker_status(last_price_update: int | None, now_ts: int) -> tuple[str, int | None]:
    """Compute worker status + ``freshSec`` (seconds since last price tick)."""

    if last_price_update is None:
        return "unknown", None
    fresh_sec = max(0, now_ts - int(last_price_update))
    threshold = int(getattr(config, "freshness_threshold_sec", _WORKER_STALE_THRESHOLD_SEC))
    return ("ok" if fresh_sec < threshold else "stale"), fresh_sec


@bp.get("/api/v1/health")
def health() -> Any:
    now_ts = int(time.time())

    db_status, _db_latency = _check_db()
    rpc_status, _rpc_block = _check_rpc()

    state = _read_app_state()
    last_price_update = state["last_price_update"]
    worker_status, fresh_sec = _worker_status(last_price_update, now_ts)

    threshold = int(getattr(config, "freshness_threshold_sec", _WORKER_STALE_THRESHOLD_SEC))
    stale = fresh_sec is not None and fresh_sec >= threshold

    components = {
        "api": "ok",
        "db": db_status,
        "worker": worker_status,
        "rpc": rpc_status,
    }

    # Per spec: only db=down triggers 503. worker/rpc stale/unknown don't.
    root_status = "ok" if db_status != "down" else "degraded"
    http_code = 503 if root_status == "degraded" else 200

    body: dict[str, Any] = {
        "status": root_status,
        "components": components,
        "version": current_app.config.get("VERSION", "dev"),
        "checkedAt": now_ts,
    }

    if root_status == "ok":
        # Only attach the data block on the happy path — the 503 example in
        # the spec doesn't include ``data``.
        body["data"] = {
            "lastPriceUpdate": last_price_update,
            "lastEventBlock": state["last_event_block"],
            "freshSec": fresh_sec,
            "stale": stale,
        }

    response = jsonify(body)
    response.status_code = http_code
    return response


__all__ = ["bp"]
