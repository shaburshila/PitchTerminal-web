"""Application configuration.

Reads env vars per docs/conventions.md §9 into a frozen ``Config`` dataclass at
import time. Exposes a single module-level ``config`` singleton.

Hardcoded constants (NOT env, per conventions §9 «Hardcoded константы») live at
the top of the module: ``HOOK_DEPLOY_BLOCK``, ``MULTICALL3``, ``WEI``, ``FEE_BPS``.

Addresses are normalized to lowercase on load. Required env vars raise
``ConfigError`` with a clear message when missing.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Final

from dotenv import load_dotenv

# ─── Hardcoded constants ────────────────────────────────────────────────────
HOOK_DEPLOY_BLOCK: Final[int] = 46_167_000
MULTICALL3: Final[str] = "0xca11bde05977b3631167028862be2a173976ca11"
WEI: Final[int] = 10**18
FEE_BPS: Final[int] = 500

# Load .env once at module import (idempotent; production injects env directly).
load_dotenv()


class ConfigError(RuntimeError):
    """Raised when a required env var is missing or malformed."""


def _required(name: str) -> str:
    value = os.environ.get(name)
    if value is None or value == "":
        raise ConfigError(f"Required env var {name!r} is missing or empty")
    return value


def _optional(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def _required_addr(name: str) -> str:
    raw = _required(name)
    return raw.lower()


def _optional_addr(name: str) -> str:
    raw = os.environ.get(name, "")
    return raw.lower()


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"env var {name!r} must be an integer, got {raw!r}") from exc


def _float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ConfigError(f"env var {name!r} must be a float, got {raw!r}") from exc


def _bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Config:
    """Frozen application config loaded from env at import time."""

    # ─── Postgres ────────────────────────────────────────────────────────
    database_url: str

    # ─── JWT ─────────────────────────────────────────────────────────────
    jwt_secret: str

    # ─── RPC ─────────────────────────────────────────────────────────────
    rpc_url: str
    rpc_url_fallback: str

    # ─── Keeper ──────────────────────────────────────────────────────────
    keeper_private_key: str
    keeper_gas_threshold_wei: int

    # ─── Telegram (operator) ─────────────────────────────────────────────
    operator_tg_bot_token: str
    operator_tg_chat_id: str

    # ─── Telegram (user, phase 3) ────────────────────────────────────────
    user_tg_bot_token: str
    telegram_webhook_secret: str

    # ─── Our contracts ───────────────────────────────────────────────────
    access_contract: str
    executor_contract: str
    # Second LimitOrderExecutor instance configured for the icon venue
    # (icon hook/router in the "player" slot). Empty until deployed — when
    # empty, icon limit orders are simply unavailable (market trading is
    # unaffected, it does not route through the executor).
    icon_executor: str

    # ─── pitchwc contracts ───────────────────────────────────────────────
    player_router: str
    country_router: str
    player_hook: str
    country_hook: str
    pitch_token: str
    # Icon-pack venue (pitchwc IconCurveHook + its router). Icon tokens trade
    # against their country like players, but on this separate hook/router.
    icon_hook: str
    icon_router: str

    # ─── Frontend bootstrap ──────────────────────────────────────────────
    walletconnect_project_id: str

    # ─── SIWE ────────────────────────────────────────────────────────────
    siwe_domain: str
    siwe_uri: str

    # ─── Worker params ───────────────────────────────────────────────────
    freshness_threshold_sec: int
    max_slippage_bps: int
    gas_multiplier: float
    chunk_blocks_default: int
    chunk_blocks_fallback: int
    reorg_lag_blocks: int
    order_cooldown_sec: int
    receipt_timeout_sec: int
    access_deploy_block: int  # start block for access_event_loop (0 = current head)

    # ─── Logging ─────────────────────────────────────────────────────────
    log_level: str

    # ─── Misc ────────────────────────────────────────────────────────────
    use_gevent: bool = field(default=False)


def _load() -> Config:
    """Build the Config from current environment.

    Required: ``DATABASE_URL``, ``JWT_SECRET``, ``RPC_URL``.
    Everything else has sensible defaults from ``.env.example`` or is optional
    (filled later — e.g. contract addresses, after deploy).
    """

    return Config(
        # Postgres
        database_url=_required("DATABASE_URL"),
        # JWT
        jwt_secret=_required("JWT_SECRET"),
        # RPC
        rpc_url=_required("RPC_URL"),
        rpc_url_fallback=_optional("RPC_URL_FALLBACK", "https://base.publicnode.com"),
        # Keeper
        keeper_private_key=_optional("KEEPER_PRIVATE_KEY"),
        keeper_gas_threshold_wei=_int("KEEPER_GAS_THRESHOLD_WEI", 10_000_000_000_000_000),
        # Telegram operator
        operator_tg_bot_token=_optional("OPERATOR_TG_BOT_TOKEN"),
        operator_tg_chat_id=_optional("OPERATOR_TG_CHAT_ID"),
        # Telegram user
        user_tg_bot_token=_optional("USER_TG_BOT_TOKEN"),
        telegram_webhook_secret=_optional("TELEGRAM_WEBHOOK_SECRET"),
        # Our contracts (filled post-deploy)
        access_contract=_optional_addr("ACCESS_CONTRACT"),
        executor_contract=_optional_addr("EXECUTOR_CONTRACT"),
        icon_executor=_optional_addr("ICON_EXECUTOR"),
        # pitchwc contracts
        player_router=_optional_addr("PLAYER_ROUTER"),
        country_router=_optional_addr("COUNTRY_ROUTER"),
        player_hook=_optional_addr("PLAYER_HOOK"),
        country_hook=_optional_addr("COUNTRY_HOOK"),
        pitch_token=_optional_addr("PITCH_TOKEN"),
        icon_hook=_optional_addr("ICON_HOOK"),
        icon_router=_optional_addr("ICON_ROUTER"),
        # Frontend
        walletconnect_project_id=_optional("WALLETCONNECT_PROJECT_ID"),
        # SIWE
        siwe_domain=_optional("SIWE_DOMAIN", "pitchterminal.app"),
        siwe_uri=_optional("SIWE_URI", "https://pitchterminal.app"),
        # Worker params
        freshness_threshold_sec=_int("FRESHNESS_THRESHOLD_SEC", 30),
        max_slippage_bps=_int("MAX_SLIPPAGE_BPS", 1000),
        gas_multiplier=_float("GAS_MULTIPLIER", 1.5),
        chunk_blocks_default=_int("CHUNK_BLOCKS_DEFAULT", 5000),
        chunk_blocks_fallback=_int("CHUNK_BLOCKS_FALLBACK", 2000),
        reorg_lag_blocks=_int("REORG_LAG_BLOCKS", 5),
        order_cooldown_sec=_int("ORDER_COOLDOWN_SEC", 60),
        receipt_timeout_sec=_int("RECEIPT_TIMEOUT_SEC", 120),
        # Block from which the access_event_loop starts scanning PriceChanged /
        # ReferralSplitUpdated. Default 0 means "use head at first start"
        # (access_bootstrap will pin it then).
        access_deploy_block=_int("ACCESS_DEPLOY_BLOCK", 0),
        # Logging
        log_level=_optional("LOG_LEVEL", "INFO").upper(),
        # gevent detection (worker uses sync-flask; api uses gunicorn-gevent)
        use_gevent=_bool("_USE_GEVENT", False),
    )


# Singleton, populated at import.
config: Config = _load()


__all__ = [
    "FEE_BPS",
    "HOOK_DEPLOY_BLOCK",
    "MULTICALL3",
    "WEI",
    "Config",
    "ConfigError",
    "config",
]
