"""``GET /api/v1/config`` — bootstrap config for the SPA.

Per docs/api-spec.md §3.2:

* All contract addresses lowercase.
* ``accessPriceWei``, ``buyerDiscountBps``, ``referralBps`` come from the
  ``app_state.access_config`` snapshot (worker B0.6 keeps it fresh). If the
  worker has not initialized the snapshot yet (no Access deploy), defaults
  are returned: ``1e18``, ``2500``, ``2500``.
* ``?fresh=1`` bypasses the in-process cache and re-reads the snapshot.
* In-process cache TTL: 60 seconds. Cache key is process-global because the
  payload is identical for all clients.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Any

from flask import Blueprint, jsonify, request

from app.limits import limiter
from shared.config import config
from shared.db import fetch_one

bp = Blueprint("config", __name__)

_CACHE_TTL_SEC = 60

# Process-global cache: ``(payload_dict, fetched_at_unix)`` tuple.
# Protected by a lock so concurrent requests don't pile on the DB at expiry.
_cache_lock = threading.Lock()
_cached: tuple[dict[str, Any], float] | None = None

# Per-spec defaults when no access_config snapshot is present yet.
_DEFAULT_ACCESS_PRICE_WEI = "1000000000000000000"
_DEFAULT_BUYER_DISCOUNT_BPS = 2500
_DEFAULT_REFERRAL_BPS = 2500


def _read_access_snapshot() -> dict[str, Any]:
    """Read ``app_state.access_config`` JSONB; return defaults if missing."""

    row = fetch_one("SELECT value FROM app_state WHERE key = 'access_config'")
    if row is None:
        return {
            "accessPriceWei": _DEFAULT_ACCESS_PRICE_WEI,
            "buyerDiscountBps": _DEFAULT_BUYER_DISCOUNT_BPS,
            "referralBps": _DEFAULT_REFERRAL_BPS,
        }
    value = row["value"]
    # JSONB → dict; pull only the public fields, never blockNumber/txHash.
    return {
        "accessPriceWei": str(value.get("accessPriceWei", _DEFAULT_ACCESS_PRICE_WEI)),
        "buyerDiscountBps": int(value.get("buyerDiscountBps", _DEFAULT_BUYER_DISCOUNT_BPS)),
        "referralBps": int(value.get("referralBps", _DEFAULT_REFERRAL_BPS)),
    }


def _build_payload() -> dict[str, Any]:
    """Compose the full /config payload — static + dynamic-from-snapshot."""

    access = _read_access_snapshot()
    return {
        "version": os.environ.get("APP_VERSION", "dev"),
        "chainId": 8453,
        "chainName": "Base",
        "contracts": {
            "pitch": config.pitch_token,
            "playerRouter": config.player_router,
            "countryRouter": config.country_router,
            "playerHook": config.player_hook,
            "countryHook": config.country_hook,
            "multicall3": "0xca11bde05977b3631167028862be2a173976ca11",
            "access": config.access_contract,
            "limitOrderExecutor": config.executor_contract,
        },
        "accessPriceWei": access["accessPriceWei"],
        "buyerDiscountBps": access["buyerDiscountBps"],
        "referralBps": access["referralBps"],
        "walletConnect": {"projectId": config.walletconnect_project_id},
        "limits": {
            "maxSlippageBps": config.max_slippage_bps,
            "limitOrderTtlPresets": [
                0,
                900,
                1800,
                3600,
                10800,
                21600,
                43200,
                86400,
                259200,
                604800,
            ],
        },
        "siwe": {"domain": config.siwe_domain, "uri": config.siwe_uri},
        "freshnessThresholdSec": config.freshness_threshold_sec,
    }


def _get_cached_or_fresh() -> dict[str, Any]:
    """Return cached payload if still fresh; otherwise rebuild under lock."""

    global _cached
    now = time.time()
    snapshot = _cached  # local copy — avoids racing with another thread's reset
    if snapshot is not None and now - snapshot[1] < _CACHE_TTL_SEC:
        return snapshot[0]
    with _cache_lock:
        if _cached is not None and time.time() - _cached[1] < _CACHE_TTL_SEC:
            return _cached[0]
        payload = _build_payload()
        _cached = (payload, time.time())
        return payload


def invalidate_cache() -> None:
    """Drop the cached payload — invoked by SSE NOTIFY handler in B0.9.

    Safe to call from any thread; idempotent.
    """

    global _cached
    with _cache_lock:
        _cached = None


@bp.get("/api/v1/config")
@limiter.limit("10 per minute", exempt_when=lambda: request.args.get("fresh") != "1")
@limiter.limit("60 per minute", exempt_when=lambda: request.args.get("fresh") == "1")
def get_config() -> Any:
    """Return the bootstrap config; ``?fresh=1`` bypasses the in-process cache.

    Per api-spec §11 rate limits: cached path = 60/min/IP, fresh path =
    10/min/IP. Both limits are declared on the route; ``exempt_when`` toggles
    which one applies based on the query param.
    """

    payload = _build_payload() if request.args.get("fresh") == "1" else _get_cached_or_fresh()
    return jsonify(payload)


__all__ = ["bp", "invalidate_cache"]
