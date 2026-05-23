"""Unit tests for ``shared.config`` env-loading."""

from __future__ import annotations

import importlib
import sys

import pytest


def _reload_with_env(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> object:
    """Reload ``shared.config`` with a custom env, returning the module."""

    # Clear all our env vars that affect Config, then set the requested ones.
    for k in [
        "DATABASE_URL",
        "JWT_SECRET",
        "RPC_URL",
        "RPC_URL_FALLBACK",
        "KEEPER_PRIVATE_KEY",
        "KEEPER_GAS_THRESHOLD_WEI",
        "ACCESS_CONTRACT",
        "EXECUTOR_CONTRACT",
        "PLAYER_HOOK",
        "GAS_MULTIPLIER",
        "REORG_LAG_BLOCKS",
        "LOG_LEVEL",
        "ACCESS_DEPLOY_BLOCK",
    ]:
        monkeypatch.delenv(k, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)

    # `shared.config` calls `load_dotenv()` at import time. If a local backend/.env
    # exists (developer machine convenience), the reload would re-populate vars we
    # just cleared. Stub `load_dotenv` to a no-op for the duration of the test so the
    # env injected via monkeypatch is the only source of truth.
    import dotenv as _dotenv

    monkeypatch.setattr(_dotenv, "load_dotenv", lambda *a, **kw: False)

    # Force reimport.
    if "shared.config" in sys.modules:
        del sys.modules["shared.config"]
    return importlib.import_module("shared.config")


class TestConfigLoading:
    def test_minimal_required_set_loads(self, monkeypatch: pytest.MonkeyPatch) -> None:
        mod = _reload_with_env(
            monkeypatch,
            {
                "DATABASE_URL": "postgresql://u:p@h:5432/d",
                "JWT_SECRET": "x" * 32,
                "RPC_URL": "https://example.invalid/rpc",
            },
        )
        cfg = mod.config  # type: ignore[attr-defined]
        assert cfg.database_url == "postgresql://u:p@h:5432/d"
        assert cfg.jwt_secret == "x" * 32
        assert cfg.rpc_url == "https://example.invalid/rpc"
        # default for fallback applies
        assert cfg.rpc_url_fallback == "https://base.publicnode.com"

    def test_missing_jwt_secret_raises_clear_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        with pytest.raises(Exception) as excinfo:
            _reload_with_env(
                monkeypatch,
                {
                    "DATABASE_URL": "postgresql://u:p@h:5432/d",
                    "RPC_URL": "https://example.invalid/rpc",
                    # JWT_SECRET deliberately absent
                },
            )
        assert "JWT_SECRET" in str(excinfo.value)

    def test_missing_database_url_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        with pytest.raises(Exception) as excinfo:
            _reload_with_env(
                monkeypatch,
                {
                    "JWT_SECRET": "x" * 32,
                    "RPC_URL": "https://example.invalid/rpc",
                },
            )
        assert "DATABASE_URL" in str(excinfo.value)

    def test_addresses_lowercased(self, monkeypatch: pytest.MonkeyPatch) -> None:
        mod = _reload_with_env(
            monkeypatch,
            {
                "DATABASE_URL": "postgresql://u:p@h:5432/d",
                "JWT_SECRET": "x" * 32,
                "RPC_URL": "https://example.invalid/rpc",
                "PLAYER_HOOK": "0xD5252A67935Fc6B913C4441Ac0E5EBF3219FAaa8",
                "ACCESS_CONTRACT": "0xCa11Bde05977b3631167028862Be2A173976Ca11",
            },
        )
        cfg = mod.config  # type: ignore[attr-defined]
        assert cfg.player_hook == "0xd5252a67935fc6b913c4441ac0e5ebf3219faaa8"
        assert cfg.access_contract == "0xca11bde05977b3631167028862be2a173976ca11"

    def test_int_parsing(self, monkeypatch: pytest.MonkeyPatch) -> None:
        mod = _reload_with_env(
            monkeypatch,
            {
                "DATABASE_URL": "postgresql://u:p@h:5432/d",
                "JWT_SECRET": "x" * 32,
                "RPC_URL": "https://example.invalid/rpc",
                "REORG_LAG_BLOCKS": "10",
                "KEEPER_GAS_THRESHOLD_WEI": "12345",
            },
        )
        cfg = mod.config  # type: ignore[attr-defined]
        assert cfg.reorg_lag_blocks == 10
        assert cfg.keeper_gas_threshold_wei == 12345

    def test_float_parsing(self, monkeypatch: pytest.MonkeyPatch) -> None:
        mod = _reload_with_env(
            monkeypatch,
            {
                "DATABASE_URL": "postgresql://u:p@h:5432/d",
                "JWT_SECRET": "x" * 32,
                "RPC_URL": "https://example.invalid/rpc",
                "GAS_MULTIPLIER": "2.5",
            },
        )
        cfg = mod.config  # type: ignore[attr-defined]
        assert cfg.gas_multiplier == 2.5

    def test_log_level_uppercased(self, monkeypatch: pytest.MonkeyPatch) -> None:
        mod = _reload_with_env(
            monkeypatch,
            {
                "DATABASE_URL": "postgresql://u:p@h:5432/d",
                "JWT_SECRET": "x" * 32,
                "RPC_URL": "https://example.invalid/rpc",
                "LOG_LEVEL": "debug",
            },
        )
        cfg = mod.config  # type: ignore[attr-defined]
        assert cfg.log_level == "DEBUG"


class TestHardcodedConstants:
    def test_constants_present(self) -> None:
        from shared import config as cfg_mod

        assert cfg_mod.HOOK_DEPLOY_BLOCK == 46_167_000
        assert cfg_mod.MULTICALL3 == "0xca11bde05977b3631167028862be2a173976ca11"
        assert cfg_mod.WEI == 10**18
        assert cfg_mod.FEE_BPS == 500
