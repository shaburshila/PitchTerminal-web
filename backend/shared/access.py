"""Cached ``hasAccess(address)`` resolution for the access contract.

Per docs/api-spec.md §5.1 + docs/plans/backend.md B0.11:

* In-memory per-process cache, keyed by lowercase address. **Asymmetric TTL:**
  ``hasAccess=true`` caches for **1 hour** (state rarely changes once paid),
  ``hasAccess=false`` caches for **30 seconds** (so a freshly-paid user sees
  premium activate quickly without spamming RPC).
* **Fail-open**: if the RPC call raises, we keep a cached *positive* result
  alive (extending its TTL by the false-window). Negative-or-missing cache
  on RPC failure returns ``false`` — we never invent premium access, but we
  also never strip it from a legitimate paid user during a transient RPC
  outage.
* **Mock mode**: when ``config.access_contract`` is empty (the contract is
  not yet deployed in dev/test), :func:`is_premium` short-circuits to
  ``hasAccess=false, source="none"`` without any RPC call.

Tests monkey-patch :func:`_rpc_has_access` to control behaviour without a
real chain. :func:`reset_cache` is exported for the same reason.

Threading: a single ``threading.Lock`` guards the cache dict. The RPC call
runs outside the lock to keep contention low (the dict ops are O(1)).
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Literal

from eth_typing import HexStr

from shared.config import config
from shared.eth import get_w3
from shared.log import get_logger

log = get_logger("shared.access")

# TTL knobs (seconds). Source: api-spec §5.1 — "true=1 hour, false=~30s".
_TTL_TRUE_SEC = 3600
_TTL_FALSE_SEC = 30

# 4-byte selector for ``hasAccess(address)`` on PitchTerminalAccess.
# We hardcode it (and avoid loading an ABI from disk) for the same reason
# ``worker/access_bootstrap.py`` does: the ABI file isn't generated until
# after C0.4 and these signatures are part of the contract API.
# keccak256("hasAccess(address)")[:4] = 0x95a078e8
_HAS_ACCESS_SELECTOR = bytes.fromhex("95a078e8")

Source = Literal["paid", "whitelisted", "none"]


@dataclass(frozen=True)
class AccessStatus:
    """Resolved access for an address (the value side of the cache entry)."""

    has_access: bool
    source: Source
    cached_at: int  # unix seconds — when the *underlying* RPC call resolved
    checked_at: int  # unix seconds — when this value was last returned


@dataclass(frozen=True)
class _CacheEntry:
    status: AccessStatus
    expires_at: float  # unix seconds — entry stale when ``time.time() > expires_at``


_cache: dict[str, _CacheEntry] = {}
_cache_lock = threading.Lock()


def _now() -> float:
    """Wall-clock seconds; indirection so tests can patch the clock locally."""

    return time.time()


def _get_contract_address() -> str:
    """Indirection so tests can patch the configured contract address.

    ``Config`` is a frozen dataclass — patching ``config.access_contract``
    directly raises ``FrozenInstanceError``. This helper provides a stable
    monkey-patch target.
    """

    return config.access_contract


def _build_status(has_access: bool, now: int) -> AccessStatus:
    """Wrap a boolean into the full :class:`AccessStatus` payload."""

    # Source policy: on-chain ``hasAccess()`` doesn't distinguish "paid" from
    # "whitelisted" (the contract just grants access either way). Default to
    # "paid" when access is granted, "none" when not. The "whitelisted" branch
    # is reserved for a future endpoint that reads owner-side state.
    # TODO(B0.11.whitelist): differentiate paid vs whitelisted once the
    # contract exposes a query for it.
    source: Source = "paid" if has_access else "none"
    return AccessStatus(
        has_access=has_access,
        source=source,
        cached_at=now,
        checked_at=now,
    )


def _ttl_for(has_access: bool) -> int:
    return _TTL_TRUE_SEC if has_access else _TTL_FALSE_SEC


def _rpc_has_access(address: str) -> bool:
    """Low-level RPC: ``eth_call`` to ``hasAccess(address)``.

    Pure function — no caching, no fail-open. Raises on any RPC failure so
    the caller can apply policy. Tests monkey-patch this to avoid live RPC.
    """

    addr = address.lower()
    contract = _get_contract_address()
    if not contract:
        # Defensive — :func:`is_premium` short-circuits earlier; if this is
        # reached, treat as a programming error (no contract → no answer).
        raise RuntimeError("access_contract is not configured")

    # Right-pad the 20-byte address to a 32-byte argument slot.
    raw_addr = bytes.fromhex(addr.removeprefix("0x"))
    if len(raw_addr) != 20:
        raise ValueError(f"address must be 20 bytes, got {len(raw_addr)}")
    calldata = _HAS_ACCESS_SELECTOR + b"\x00" * 12 + raw_addr

    w3 = get_w3()
    # web3 v7: ``eth.call({...})`` returns the raw bytes for view functions.
    result = w3.eth.call(
        {
            "to": w3.to_checksum_address(contract),
            "data": HexStr("0x" + calldata.hex()),
        }
    )
    # ``bool`` ABI encoding: 32 bytes, last byte 0/1.
    return bool(result) and bytes(result)[-1] == 1


def _fetch_and_store(address: str, *, now: int) -> AccessStatus:
    """Call ``_rpc_has_access`` with fail-open semantics, cache + return."""

    try:
        granted = _rpc_has_access(address)
    except Exception as exc:
        # Fail-open: if we already cached True, keep returning True (extend
        # the entry by a short window so we re-attempt soon). If no cache or
        # cached False, return False — never invent access.
        log.warning("access.rpc_failed", address=address, error=repr(exc))
        with _cache_lock:
            prev = _cache.get(address)
        if prev is not None and prev.status.has_access:
            refreshed = AccessStatus(
                has_access=True,
                source=prev.status.source,
                cached_at=prev.status.cached_at,
                checked_at=now,
            )
            entry = _CacheEntry(
                status=refreshed,
                expires_at=_now() + _TTL_FALSE_SEC,
            )
            with _cache_lock:
                _cache[address] = entry
            return refreshed
        # No positive cache to fall back on → answer "no access" without
        # caching (so the next call retries immediately).
        return AccessStatus(
            has_access=False,
            source="none",
            cached_at=now,
            checked_at=now,
        )

    status = _build_status(granted, now)
    entry = _CacheEntry(status=status, expires_at=_now() + _ttl_for(granted))
    with _cache_lock:
        _cache[address] = entry
    return status


def is_premium(address: str, *, fresh: bool = False) -> AccessStatus:
    """Resolve premium status for ``address``.

    Args:
        address: 0x-prefixed wallet address. Case-insensitive — normalized
            to lowercase internally (cache + RPC both use lowercase).
        fresh: When True, bypass the cache and force a new RPC call.

    Returns:
        :class:`AccessStatus` describing the current access state. When
        ``config.access_contract`` is empty (no deploy yet), always returns
        ``has_access=False, source="none"`` without touching the network.
    """

    addr = address.lower()
    now_float = _now()
    now = int(now_float)

    # Mock mode: no contract configured → always negative, no caching.
    if not _get_contract_address():
        return AccessStatus(
            has_access=False,
            source="none",
            cached_at=now,
            checked_at=now,
        )

    if not fresh:
        with _cache_lock:
            entry = _cache.get(addr)
        if entry is not None and now_float < entry.expires_at:
            # Refresh checked_at on every read so the response reflects "when
            # we last verified for this caller", not the original cache fill.
            return AccessStatus(
                has_access=entry.status.has_access,
                source=entry.status.source,
                cached_at=entry.status.cached_at,
                checked_at=now,
            )

    return _fetch_and_store(addr, now=now)


def reset_cache() -> None:
    """Drop the in-process cache. Tests + admin tooling only."""

    with _cache_lock:
        _cache.clear()


__all__ = [
    "AccessStatus",
    "Source",
    "is_premium",
    "reset_cache",
]
