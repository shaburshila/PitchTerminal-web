"""Unit tests for :mod:`shared.access` — cached ``hasAccess`` resolution.

Covers all four code paths of :func:`is_premium`:

* mock mode (``config.access_contract`` empty)  → never calls RPC.
* cache miss → call RPC, store, return.
* cache hit within TTL → return without RPC.
* cache expiry → re-call RPC.
* fail-open: prior True cache + RPC failure → still True.
* fresh=1 bypasses cache.
"""

from __future__ import annotations

import time
from typing import Any
from unittest.mock import patch

import pytest

from shared import access as access_mod

_ADDR = "0x" + "ab" * 20
_CONTRACT = "0x" + "11" * 20


@pytest.fixture(autouse=True)
def _reset_cache_each_test() -> Any:
    """Each test starts with an empty cache (no leakage across cases)."""

    access_mod.reset_cache()
    yield
    access_mod.reset_cache()


# ─── Mock mode ───────────────────────────────────────────────────────────────


class TestMockMode:
    """When ACCESS_CONTRACT is empty, never touch the network."""

    def test_no_contract_returns_false_without_rpc(self) -> None:
        # config.access_contract is "" in test env (no ACCESS_CONTRACT set).
        with (
            patch.object(access_mod, "_get_contract_address", return_value=""),
            patch.object(access_mod, "_rpc_has_access") as rpc,
        ):
            status = access_mod.is_premium(_ADDR)
        assert status.has_access is False
        assert status.source == "none"
        rpc.assert_not_called()

    def test_no_contract_with_fresh_still_skips_rpc(self) -> None:
        with (
            patch.object(access_mod, "_get_contract_address", return_value=""),
            patch.object(access_mod, "_rpc_has_access") as rpc,
        ):
            status = access_mod.is_premium(_ADDR, fresh=True)
        assert status.has_access is False
        rpc.assert_not_called()


# ─── Cache mechanics ─────────────────────────────────────────────────────────


class TestCache:
    """Verify cache hit / miss / expiry per TTL policy."""

    def test_miss_then_hit(self) -> None:
        with (
            patch.object(access_mod, "_get_contract_address", return_value=_CONTRACT),
            patch.object(access_mod, "_rpc_has_access", return_value=True) as rpc,
        ):
            s1 = access_mod.is_premium(_ADDR)
            s2 = access_mod.is_premium(_ADDR)
        assert s1.has_access is True
        assert s2.has_access is True
        # Second call must NOT re-hit RPC (cache hit).
        assert rpc.call_count == 1

    def test_false_ttl_30s(self) -> None:
        """``hasAccess=false`` cache should expire after 30s."""

        t0 = time.time()
        with (
            patch.object(access_mod, "_get_contract_address", return_value=_CONTRACT),
            patch.object(access_mod, "_rpc_has_access", return_value=False) as rpc,
        ):
            with patch.object(access_mod, "_now", return_value=t0):
                access_mod.is_premium(_ADDR)
            # Move the wall clock 31s forward — cache entry now stale.
            with patch.object(access_mod, "_now", return_value=t0 + 31):
                access_mod.is_premium(_ADDR)
        assert rpc.call_count == 2

    def test_true_ttl_3600s(self) -> None:
        """``hasAccess=true`` cache should survive 30s but expire after 1h."""

        t0 = time.time()
        with (
            patch.object(access_mod, "_get_contract_address", return_value=_CONTRACT),
            patch.object(access_mod, "_rpc_has_access", return_value=True) as rpc,
        ):
            with patch.object(access_mod, "_now", return_value=t0):
                access_mod.is_premium(_ADDR)
            # 31s in: still cached (because TTL=3600).
            with patch.object(access_mod, "_now", return_value=t0 + 31):
                access_mod.is_premium(_ADDR)
            assert rpc.call_count == 1
            # 1h+1s in: expired.
            with patch.object(access_mod, "_now", return_value=t0 + 3601):
                access_mod.is_premium(_ADDR)
        assert rpc.call_count == 2

    def test_fresh_bypasses_cache(self) -> None:
        with (
            patch.object(access_mod, "_get_contract_address", return_value=_CONTRACT),
            patch.object(access_mod, "_rpc_has_access", return_value=True) as rpc,
        ):
            access_mod.is_premium(_ADDR)
            access_mod.is_premium(_ADDR, fresh=True)
        assert rpc.call_count == 2

    def test_address_lowercased(self) -> None:
        """Mixed-case address must hit the same cache slot as lowercase."""

        with (
            patch.object(access_mod, "_get_contract_address", return_value=_CONTRACT),
            patch.object(access_mod, "_rpc_has_access", return_value=True) as rpc,
        ):
            access_mod.is_premium(_ADDR.upper())
            access_mod.is_premium(_ADDR)
        assert rpc.call_count == 1


# ─── Fail-open ───────────────────────────────────────────────────────────────


class TestFailOpen:
    """RPC failures must not strip premium from a paid user."""

    def test_failure_keeps_cached_true(self) -> None:
        """Prior True cache + RPC failure on next refresh → keep True."""

        t0 = time.time()
        with patch.object(access_mod, "_get_contract_address", return_value=_CONTRACT):
            # First call: RPC succeeds, returns True. Cache → True (TTL 1h).
            with (
                patch.object(access_mod, "_now", return_value=t0),
                patch.object(access_mod, "_rpc_has_access", return_value=True),
            ):
                first = access_mod.is_premium(_ADDR)
            assert first.has_access is True

            # Move 1h+1s forward → cache entry expires.
            # RPC raises. Should retain True (fail-open).
            def _boom(_addr: str) -> bool:
                raise RuntimeError("rpc down")

            with (
                patch.object(access_mod, "_now", return_value=t0 + 3601),
                patch.object(access_mod, "_rpc_has_access", side_effect=_boom),
            ):
                second = access_mod.is_premium(_ADDR)
            assert second.has_access is True
            assert second.source == "paid"

    def test_failure_without_cache_returns_false(self) -> None:
        """Cold cache + RPC down → answer False, do NOT cache (so retry next call)."""

        def _boom(_addr: str) -> bool:
            raise RuntimeError("rpc down")

        with (
            patch.object(access_mod, "_get_contract_address", return_value=_CONTRACT),
            patch.object(access_mod, "_rpc_has_access", side_effect=_boom),
        ):
            status = access_mod.is_premium(_ADDR)
        assert status.has_access is False
        assert status.source == "none"
        # No cache entry persisted.
        assert _ADDR not in access_mod._cache

    def test_failure_with_cached_false_returns_false(self) -> None:
        """Prior False cache + RPC failure → still False (no fake-premium)."""

        t0 = time.time()
        with patch.object(access_mod, "_get_contract_address", return_value=_CONTRACT):
            with (
                patch.object(access_mod, "_now", return_value=t0),
                patch.object(access_mod, "_rpc_has_access", return_value=False),
            ):
                access_mod.is_premium(_ADDR)

            def _boom(_addr: str) -> bool:
                raise RuntimeError("rpc down")

            # 31s later — false-TTL expired.
            with (
                patch.object(access_mod, "_now", return_value=t0 + 31),
                patch.object(access_mod, "_rpc_has_access", side_effect=_boom),
            ):
                status = access_mod.is_premium(_ADDR)
        assert status.has_access is False


# ─── Source semantics ───────────────────────────────────────────────────────


class TestSource:
    def test_source_paid_when_true(self) -> None:
        with (
            patch.object(access_mod, "_get_contract_address", return_value=_CONTRACT),
            patch.object(access_mod, "_rpc_has_access", return_value=True),
        ):
            status = access_mod.is_premium(_ADDR)
        assert status.source == "paid"

    def test_source_none_when_false(self) -> None:
        with (
            patch.object(access_mod, "_get_contract_address", return_value=_CONTRACT),
            patch.object(access_mod, "_rpc_has_access", return_value=False),
        ):
            status = access_mod.is_premium(_ADDR)
        assert status.source == "none"
