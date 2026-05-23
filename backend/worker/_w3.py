"""Lazy Web3 singleton for the worker.

We want **one** Web3 connection per worker process, not a new one per
tick. ``shared.eth.get_w3()`` probes the primary RPC and may fall back to
the public RPC; running that probe every 5 seconds wastes time and
floods logs. This module memoizes the first successful client and
returns it on subsequent calls.

``reset()`` is exposed for tests — call it to force the next
:func:`get_w3` to rebuild the client (e.g. after monkey-patching the
underlying ``shared.eth.get_w3``).
"""

from __future__ import annotations

from typing import Any

from shared import eth as shared_eth

_w3: Any | None = None


def get_w3() -> Any:
    """Return the cached Web3 client, building it on first access."""

    global _w3
    if _w3 is None:
        _w3 = shared_eth.get_w3()
    return _w3


def reset() -> None:
    """Drop the cached client (tests only)."""

    global _w3
    _w3 = None


__all__ = ["get_w3", "reset"]
