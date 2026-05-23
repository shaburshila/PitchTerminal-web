"""Web3 client + address helpers + Multicall3 batching.

Public surface:
* :func:`get_w3` — primary RPC w/ fallback (per architecture §12).
* :func:`lc`, :func:`chk`, :func:`is_address` — address normalization.
* :func:`load_abi` — loads ``abis/<name>.json`` from repo root, ``lru_cache``-d.
* :func:`multicall3_aggregate` — batches eth_calls via Multicall3 ``aggregate3``.
* :func:`wallet_balances` — batched ETH + ERC20 ``balanceOf`` reads for one wallet.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
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


# 4-byte selector for ERC20 ``balanceOf(address)``. keccak256 prefix.
_BALANCE_OF_SELECTOR = bytes.fromhex("70a08231")


def _encode_balance_of_calldata(holder: str) -> bytes:
    """Build calldata for ``balanceOf(holder)``: selector + 32-byte holder.

    Caller must pass a lowercase 0x-prefixed address (validated by :func:`lc`).
    """

    raw = bytes.fromhex(holder.removeprefix("0x"))
    if len(raw) != 20:
        raise ValueError(f"address must be 20 bytes, got {len(raw)}")
    return _BALANCE_OF_SELECTOR + b"\x00" * 12 + raw


@dataclass(frozen=True)
class WalletBalances:
    """ETH + PITCH + per-country ERC20 balances for one wallet, in wei.

    ``countries`` lists only tokens with a non-zero balance, sorted descending
    by ``wei``. Empty list when the wallet holds none of the queried tokens
    (or when the RPC call failed; see :func:`wallet_balances` for the
    fail-soft contract).
    """

    eth_wei: int
    pitch_wei: int
    countries: list[tuple[str, int]]  # (lowercase_address, wei)


def wallet_balances(
    w3: Web3,
    wallet: str,
    pitch_token: str,
    country_addresses: list[str],
) -> WalletBalances:
    """Read ETH + PITCH + per-country ERC20 balances for ``wallet``.

    Single Multicall3 batch for the ERC20 ``balanceOf`` calls; ETH balance
    is a separate ``eth_getBalance`` (Multicall3 has ``getEthBalance`` but
    we keep the call surface minimal and match the portable version's split).

    Args:
        w3: Connected Web3 client.
        wallet: 0x-prefixed wallet address (lowercase or mixed-case).
        pitch_token: 0x-prefixed PITCH ERC20 address. May be empty when
            ``PITCH_TOKEN`` env is not yet set — in that case the PITCH read
            is skipped (returns 0) but ETH + country reads still proceed.
        country_addresses: Lowercase 0x addresses of country ERC20 tokens.

    Returns:
        :class:`WalletBalances` with raw wei integers. Per-call failures are
        absorbed (``allow_failure=True``) and yield 0 for that slot; the
        envelope itself only fails on a hard RPC error.

    Raises:
        Any web3 error propagated from ``eth_getBalance`` or ``aggregate3``.
        Callers in user-facing routes should wrap this with a try/except to
        degrade gracefully (the portable code returned a zero-stub on error).
    """

    holder = lc(wallet)
    holder_cs = Web3.to_checksum_address(holder)
    eth_wei = int(w3.eth.get_balance(holder_cs))

    # Build calldata once; reuse for every ERC20 target.
    calldata = _encode_balance_of_calldata(holder)

    # PITCH first (when configured), then country tokens — order matters for
    # de-multiplexing the results below.
    targets: list[str] = []
    if pitch_token:
        targets.append(pitch_token)
    targets.extend(country_addresses)

    if not targets:
        return WalletBalances(eth_wei=eth_wei, pitch_wei=0, countries=[])

    calls: list[tuple[str, bytes]] = [(t, calldata) for t in targets]
    results = multicall3_aggregate(w3, calls, allow_failure=True)

    def _parse(r: bytes) -> int:
        return int.from_bytes(r[:32], "big") if len(r) >= 32 else 0

    idx = 0
    pitch_wei = 0
    if pitch_token:
        pitch_wei = _parse(results[idx])
        idx += 1

    country_bals: list[tuple[str, int]] = []
    for addr, raw in zip(country_addresses, results[idx:], strict=True):
        wei = _parse(raw)
        if wei > 0:
            country_bals.append((addr, wei))
    country_bals.sort(key=lambda kv: -kv[1])

    return WalletBalances(eth_wei=eth_wei, pitch_wei=pitch_wei, countries=country_bals)


__all__ = [
    "MULTICALL3_ABI",
    "WalletBalances",
    "chk",
    "get_w3",
    "is_address",
    "lc",
    "load_abi",
    "multicall3_aggregate",
    "wallet_balances",
]
