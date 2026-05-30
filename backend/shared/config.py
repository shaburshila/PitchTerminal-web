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

# ─── External-PITCH DEX trade indexer (dex_pitch_loop) ──────────────────────
# Base mainnet addresses involved in external PITCH<->ETH/WETH/USDC swaps.
# These route through Uniswap V3 + V4 (we classify by token flow, NOT pool).
PITCH_TOKEN_ADDR: Final[str] = "0xeae13ea73bec936664a51734c8c01ec7c3b0699c"
WETH_ADDR: Final[str] = "0x4200000000000000000000000000000000000006"
USDC_ADDR: Final[str] = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
# ERC20 Transfer(address,address,uint256) topic0.
ERC20_TRANSFER_TOPIC: Final[str] = (
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
)

# ─── External DEX venues to scan for candidate trade txs ────────────────────
# Candidate-tx discovery scans Swap events in the EXTERNAL PITCH pools ONLY,
# NOT all PITCH ERC20 Transfers (PITCH had an 89k-transfer airdrop at deploy —
# scanning transfers cold-starts into tens of thousands of receipt fetches and
# starves the worker, incident 2026-05-31). The receipt-based classifier then
# accurately classifies each discovered tx (handles multi-hop deliveries).
#
# 1. Uniswap V3 PITCH/WETH 0.3% pool. getLogs(address=pool, topics=[V3_SWAP])
#    → every log's tx is an external candidate.
DEX_V3_POOL: Final[str] = "0xec44849198fbf8b6dc239df418ea7be017240368"
# 2. Uniswap V4 PoolManager (SHARED between in-app + external swaps). We filter
#    by the indexed poolId (topic1) so getLogs returns ONLY ETH/PITCH external
#    swaps — this excludes the in-app country/PITCH pool and airdrop noise.
DEX_V4_POOL_MANAGER: Final[str] = "0x498581ff718922c3f8e6a244956af099b2652b2b"
# Uniswap V3 Swap(address,address,int256,int256,uint160,uint128,int24) topic0.
V3_SWAP_TOPIC: Final[str] = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
# Uniswap V4 PoolManager.Swap(bytes32 id, address sender, ...) topic0.
V4_SWAP_TOPIC: Final[str] = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
# The EXTERNAL ETH/PITCH V4 poolId (indexed topic1). Filtering on this returns
# ONLY ETH/PITCH swaps and EXCLUDES the in-app country/PITCH poolId
# (0x1660e4dafc17907854cc0f46362b720d3b6090bb60585a5e7a4c040dd4caec1e).
V4_EXTERNAL_POOL_ID: Final[str] = (
    "0xacd168b06cfb4ed3a7701d64752e7667f1e6063e05144cec1883b5b5fd91633a"
)
# Per-tick wall-clock budget (seconds). A tick processes the range in chunks,
# checkpointing the cursor AFTER EACH CHUNK, and stops starting new chunks once
# this budget is exceeded — so a slow cold-start can never starve the worker
# (keeper / price loops run after this loop). A tick yields within ~budget +
# one chunk.
DEX_TICK_BUDGET_SEC: Final[float] = 15.0
# Default start block for the external-PITCH scanner cursor = the PITCH token's
# deployment block (verified on-chain via eth_getCode binary search). PITCH and
# its Uniswap pools PREDATE the in-app hook deploy block, so external DEX trading
# (and the very first known external buy, at block 46157923 — the block the V3
# PITCH/WETH pool was created) happens BEFORE HOOK_DEPLOY_BLOCK. Starting at the
# token deploy block guarantees no external trade is missed, for any wallet.
# Override with DEX_SCAN_FROM_BLOCK env. NOTE: a full backfill is expensive (the
# scanner reads a receipt per PITCH-touching tx); the worker caps each tick at
# _MAX_BLOCKS_PER_TICK so it catches up gradually — lower this only with intent.
DEX_SCAN_FROM_BLOCK_DEFAULT: Final[int] = 46_126_828

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
    dex_scan_from_block: int  # start block for dex_pitch_loop external-PITCH scan

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
        dex_scan_from_block=_int("DEX_SCAN_FROM_BLOCK", DEX_SCAN_FROM_BLOCK_DEFAULT),
        # Logging
        log_level=_optional("LOG_LEVEL", "INFO").upper(),
        # gevent detection (worker uses sync-flask; api uses gunicorn-gevent)
        use_gevent=_bool("_USE_GEVENT", False),
    )


# Singleton, populated at import.
config: Config = _load()


__all__ = [
    "DEX_SCAN_FROM_BLOCK_DEFAULT",
    "DEX_TICK_BUDGET_SEC",
    "DEX_V3_POOL",
    "DEX_V4_POOL_MANAGER",
    "ERC20_TRANSFER_TOPIC",
    "FEE_BPS",
    "HOOK_DEPLOY_BLOCK",
    "MULTICALL3",
    "PITCH_TOKEN_ADDR",
    "USDC_ADDR",
    "V3_SWAP_TOPIC",
    "V4_EXTERNAL_POOL_ID",
    "V4_SWAP_TOPIC",
    "WEI",
    "WETH_ADDR",
    "Config",
    "ConfigError",
    "config",
]
