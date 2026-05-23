"""Web3 client + address helpers + Multicall3 batching.

Public surface:
* :func:`get_w3` — primary RPC w/ fallback (per architecture §12).
* :func:`lc`, :func:`chk`, :func:`is_address` — address normalization.
* :func:`load_abi` — loads ``abis/<name>.json`` from repo root, ``lru_cache``-d.
* :func:`multicall3_aggregate` — batches eth_calls via Multicall3 ``aggregate3``.
"""

from __future__ import annotations

import json
import re
from functools import cache
from pathlib import Path
from typing import Any, cast

from web3 import HTTPProvider, Web3

from shared.config import MULTICALL3, config

# Minimal Multicall3 ABI — only ``aggregate3`` (allowFailure per-call).
MULTICALL3_ABI: list[dict[str, Any]] = [
    {
        "inputs": [
            {
                "components": [
                    {"name": "target", "type": "address"},
                    {"name": "allowFailure", "type": "bool"},
                    {"name": "callData", "type": "bytes"},
                ],
                "name": "calls",
                "type": "tuple[]",
            }
        ],
        "name": "aggregate3",
        "outputs": [
            {
                "components": [
                    {"name": "success", "type": "bool"},
                    {"name": "returnData", "type": "bytes"},
                ],
                "name": "returnData",
                "type": "tuple[]",
            }
        ],
        "stateMutability": "payable",
        "type": "function",
    },
]


_ADDR_RE = re.compile(r"^0x[0-9a-f]{40}$")
_RPC_TIMEOUT_SEC = 10


def lc(addr: str) -> str:
    """Return a lowercase 0x-prefixed address; raise ``ValueError`` on bad input.

    Mixed-case input is accepted (and lowercased); checksum validity is **not**
    enforced — see :func:`chk` for that.
    """

    if not isinstance(addr, str):
        raise ValueError(f"address must be str, got {type(addr).__name__}")
    lowered = addr.lower()
    if not _ADDR_RE.match(lowered):
        raise ValueError(f"invalid address: {addr!r}")
    return lowered


def chk(addr: str) -> str:
    """Return the EIP-55 checksum form via :meth:`Web3.to_checksum_address`."""

    return cast(str, Web3.to_checksum_address(addr))


def is_address(s: str) -> bool:
    """Lightweight format check — 0x + 40 lowercase hex chars.

    Accepts only the *normalized* form (lowercase). Use :func:`lc` to normalize
    first if input may be mixed-case.
    """

    return isinstance(s, str) and bool(_ADDR_RE.match(s))


@cache
def load_abi(name: str) -> list[dict[str, Any]]:
    """Load ``abis/<name>.json`` from repo root.

    The path is resolved relative to this file: ``parents[2]`` walks
    backend/shared → backend → repo-root.
    """

    abi_path = Path(__file__).resolve().parents[2] / "abis" / f"{name}.json"
    with abi_path.open(encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, list):
        raise ValueError(
            f"ABI file {abi_path} must contain a JSON array, got {type(data).__name__}"
        )
    return cast(list[dict[str, Any]], data)


def _make_w3(url: str) -> Web3:
    return Web3(HTTPProvider(url, request_kwargs={"timeout": _RPC_TIMEOUT_SEC}))


def get_w3() -> Web3:
    """Return a connected Web3 client.

    Tries ``RPC_URL`` first; on failure falls back to ``RPC_URL_FALLBACK``.
    "Failure" means either an exception while probing or ``is_connected()``
    returns False. Raises ``RuntimeError`` if both fail.
    """

    primary_err: Exception | None = None
    try:
        w3 = _make_w3(config.rpc_url)
        if w3.is_connected():
            return w3
    except Exception as exc:  # pragma: no cover - network path
        primary_err = exc

    try:
        w3 = _make_w3(config.rpc_url_fallback)
        if w3.is_connected():
            return w3
    except Exception as exc:  # pragma: no cover - network path
        raise RuntimeError(
            f"both primary and fallback RPC unreachable (primary={primary_err!r}, fallback={exc!r})"
        ) from exc

    raise RuntimeError(f"both primary and fallback RPC unreachable (primary_err={primary_err!r})")


def multicall3_aggregate(
    w3: Web3,
    calls: list[tuple[str, bytes]],
    *,
    allow_failure: bool = True,
) -> list[bytes]:
    """Batch eth_calls via Multicall3 ``aggregate3``.

    Args:
        w3: Connected Web3 client.
        calls: List of ``(target_address, calldata_bytes)`` tuples.
        allow_failure: If True (default), individual calls may revert without
            failing the whole batch; the returned ``returnData`` for a failed
            call will be ``b""``. If False, the whole batch reverts on any
            failure.

    Returns:
        A list of ``returnData`` bytes, one per input call, in the same order.
    """

    contract = w3.eth.contract(
        address=Web3.to_checksum_address(MULTICALL3),
        abi=MULTICALL3_ABI,
    )
    payload = [
        (Web3.to_checksum_address(target), allow_failure, calldata) for target, calldata in calls
    ]
    raw_results = contract.functions.aggregate3(payload).call()
    # Each tuple is (success: bool, returnData: bytes). We return only returnData.
    return [bytes(item[1]) for item in raw_results]


__all__ = [
    "MULTICALL3_ABI",
    "chk",
    "get_w3",
    "is_address",
    "lc",
    "load_abi",
    "multicall3_aggregate",
]
