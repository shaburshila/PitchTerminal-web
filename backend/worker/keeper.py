"""B2.3 — limit-order keeper.

Polled from :mod:`worker.main` once every :data:`KEEPER_TICK_INTERVAL_SEC`
seconds. The keeper

1. Scans ``limit_orders`` for ``status='open'`` rows whose price condition
   is satisfied against ``market_state`` (same filter as the ``/orders/armed``
   endpoint, but server-side so the worker doesn't HTTP-loop into the API).
2. For each candidate it ``eth_call``-simulates ``executor.execute`` first.
   On a clean simulation it builds, signs and broadcasts the tx; the row
   moves to ``status='executing'`` with ``executed_tx_hash`` set.
3. Separately polls receipts of every ``executing`` row. On a confirmed
   ``OrderExecuted`` log the row flips to ``filled``; on a reverted receipt
   (or a terminal simulation failure) it flips to ``failed`` with a parsed
   :data:`order_fail_reason`.
4. On a "price moved" revert the row stays ``open`` but ``retry_after``
   is set to ``now() + ORDER_COOLDOWN_SEC`` so the next tick skips it.

The keeper is **lazy / fail-soft**:

* When ``KEEPER_PRIVATE_KEY`` is empty the entire tick is a no-op (logged
  once per minute at INFO level). This lets us deploy the worker on a VPS
  before the keeper EOA is provisioned.
* When ``EXECUTOR_CONTRACT`` is the zero address we also no-op.
* RPC errors during a single order never break the batch — every step is
  wrapped, the order falls through to the next tick, and the worker
  process stays up.

Per docs/plans/backend.md B2.3 + docs/contracts.md §2 (Executor) +
docs/eip712.md §3.

This module is intentionally synchronous (no asyncio) — the worker uses
plain `time.sleep` between ticks and the rest of `worker.*` is sync too,
mixing the two would force an event loop only for this one tick.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from eth_account import Account
from hexbytes import HexBytes
from web3 import Web3

from shared.config import config
from shared.db import get_conn
from shared.eth import load_abi
from shared.fee import execution_to_mid_wei
from shared.log import get_logger
from shared.notify import notify
from worker import _w3

log = get_logger("worker.keeper")

# ─── Tunables ───────────────────────────────────────────────────────────────
#: Cadence of :func:`tick` — read by ``worker.main`` via a monotonic gate.
KEEPER_TICK_INTERVAL_SEC = 5
#: Hard cap on orders touched per tick, to keep latency bounded.
MAX_ORDERS_PER_TICK = 25
#: Hard cap on receipt polls per tick.
MAX_RECEIPT_POLLS_PER_TICK = 25
#: After this many on-chain attempts on the same order the keeper gives up
#: and parks the row in ``failed`` so it doesn't burn gas forever.
MAX_ATTEMPTS = 5
#: NOTIFY channel matching ``app/routes/orders.py`` constant.
_NOTIFY_CHANNEL = "pt_orders"

# ─── ABI selectors (computed once) ──────────────────────────────────────────
# The full ABI is loaded lazily because importing this module on a worker
# without the abis/ dir mounted should not crash — the abi load is deferred
# until the first time we actually need to build a transaction.
_executor_abi_cached: list[dict[str, Any]] | None = None


def _executor_abi() -> list[dict[str, Any]]:
    """Return the LimitOrderExecutor ABI (cached on first read)."""

    global _executor_abi_cached
    if _executor_abi_cached is None:
        _executor_abi_cached = load_abi("LimitOrderExecutor")
    return _executor_abi_cached


# Map of 4-byte custom-error selectors → fail_reason / human label. Computed
# from the ABI on first use. Kept narrow — only the errors that map cleanly
# onto our ``order_fail_reason`` enum get a non-"unknown" reason; everything
# else still gets a detail string for debugging.
_REVERT_SELECTOR_MAP: dict[str, tuple[str, str]] | None = None


def _revert_selector_map() -> dict[str, tuple[str, str]]:
    """Return ``{selector_hex: (fail_reason, label)}`` map.

    ``fail_reason`` is one of :data:`order_fail_reason` enum values (or
    ``"unknown"`` for sentinel "we know the name but no enum slot").
    """

    global _REVERT_SELECTOR_MAP
    if _REVERT_SELECTOR_MAP is not None:
        return _REVERT_SELECTOR_MAP

    # Hand-curated mapping ABI-name → (fail_reason enum, retryable). The
    # enum is defined in migrations 0001 / docs/db-schema.sql.
    name_to_reason: dict[str, str] = {
        "PriceConditionNotMet": "router_revert",  # cooldown — retryable
        "InsufficientOutput": "min_out_not_met",  # cooldown — retryable
        "NonceAlreadyUsed": "nonce_used",
        "OrderExpired": "expired_on_chain",
        "InvalidSignature": "unknown",
        "InvalidQuoteToken": "bad_quote_token",
        "InvalidVenue": "unknown",
        "InvalidSide": "unknown",
        "SlippageTooHigh": "unknown",
        "EnforcedPause": "router_revert",
        "ZeroAddress": "unknown",
        "ZeroAmount": "unknown",
        "ZeroTargetPrice": "unknown",
        "ZeroOrderAddress": "unknown",
    }
    out: dict[str, tuple[str, str]] = {}
    for item in _executor_abi():
        if item.get("type") != "error":
            continue
        name = item.get("name")
        if not isinstance(name, str):
            continue
        inputs = item.get("inputs", []) or []
        sig = name + "(" + ",".join(i["type"] for i in inputs) + ")"
        selector = Web3.keccak(text=sig)[:4].hex()
        if name in name_to_reason:
            out[selector] = (name_to_reason[name], name)
    _REVERT_SELECTOR_MAP = out
    return out


#: Failure reasons that mean "price moved — retry after cooldown" instead of
#: terminal failure. The cooldown only kicks in for these.
_RETRYABLE_FAIL_LABELS = frozenset({"PriceConditionNotMet", "InsufficientOutput"})


# ─── Pure helpers (unit-tested) ─────────────────────────────────────────────


@dataclass(frozen=True)
class TriggerDecision:
    """Outcome of evaluating an order against the current market price."""

    triggers: bool
    reason: str  # short label for logging


def should_trigger(side: str, target_price: int, market_price: int) -> TriggerDecision:
    """Return whether ``side`` order with ``target_price`` triggers at ``market_price``.

    Pure function — no DB, no RPC. The same predicate the API ``/armed``
    endpoint uses; centralising it here so the keeper and the endpoint
    cannot drift.

    * ``limit-buy`` triggers when ``market_price <= target_price`` (buy
      cheaper than the user's ceiling).
    * ``take-profit`` triggers when ``market_price >= target_price`` (sell
      above the user's floor).
    * ``market_price == 0`` means the worker has not seen the market yet
      → never trigger.
    """

    if market_price <= 0:
        return TriggerDecision(False, "no_market_price")
    if side == "limit-buy":
        if market_price <= target_price:
            return TriggerDecision(True, "limit_buy_below_target")
        return TriggerDecision(False, "limit_buy_above_target")
    if side == "take-profit":
        if market_price >= target_price:
            return TriggerDecision(True, "take_profit_above_target")
        return TriggerDecision(False, "take_profit_below_target")
    return TriggerDecision(False, f"unknown_side:{side}")


def decode_revert_reason(error_data: Any) -> tuple[str, str | None]:
    """Decode a revert payload into ``(fail_reason, label)``.

    ``error_data`` is whatever the RPC handed us — usually a hex string like
    ``"0x<selector><abi-encoded-args>"`` from ``eth_call``-style errors, or
    a Python str produced by ``ContractCustomError`` / generic web3
    ``ContractLogicError``.

    Returns ``("unknown", None)`` when nothing matches (including the empty
    revert case ``"0x"``); callers should still write the raw detail into
    ``limit_orders.fail_detail`` so we can investigate post-hoc.
    """

    # 1. Try to find a 4-byte selector in the payload.
    text = ""
    if isinstance(error_data, bytes):
        text = "0x" + error_data.hex()
    elif isinstance(error_data, str):
        text = error_data
    else:
        text = str(error_data)

    text_lc = text.lower()
    # Selectors are 4 bytes = 8 hex chars (preceded by 0x).
    selector_map = _revert_selector_map()
    for selector_hex, (reason, label) in selector_map.items():
        # Selectors appear at the start of the raw revert data; we search
        # case-insensitively to absorb hex-case variations from RPCs.
        if "0x" + selector_hex in text_lc:
            return reason, label

    # 2. Fall back to substring matching on the human-readable revert string
    # (web3.py sometimes gives ``"execution reverted: NonceAlreadyUsed"`` etc.).
    for _selector_hex, (reason, label) in selector_map.items():
        if label.lower() in text_lc:
            return reason, label
    return "unknown", None


def is_retryable_label(label: str | None) -> bool:
    """True when ``label`` is a "price moved" / "min-out missed" kind of failure.

    Retryable failures keep the row at ``open`` with ``retry_after`` set;
    everything else (or no label at all from a hard error) is terminal.
    """

    return label is not None and label in _RETRYABLE_FAIL_LABELS


# ─── State (in-process; never persisted) ────────────────────────────────────


@dataclass
class _KeeperState:
    """In-process keeper state.

    ``next_nonce`` is initialised from ``getTransactionCount('pending')`` on
    the first send and incremented locally afterwards. We re-anchor it
    against the latest count every :data:`NONCE_RESYNC_INTERVAL_SEC`
    seconds and on any nonce-too-low error.
    """

    next_nonce: int | None = None
    last_nonce_resync_ts: float = 0.0
    last_skip_log_ts: float = 0.0


_state = _KeeperState()

NONCE_RESYNC_INTERVAL_SEC = 5 * 60


# ─── Config accessors (test seam) ──────────────────────────────────────────
# ``shared.config.Config`` is a frozen dataclass, so tests can't simply
# ``patch.object(config, "keeper_private_key", "0x…")``. We indirect every
# read through tiny accessors so tests patch *these* instead. The accessors
# are intentionally near-trivial — same trick :mod:`worker.operator_alerts`
# uses for ``OPERATOR_TG_BOT_TOKEN`` / ``OPERATOR_TG_CHAT_ID``.


def _get_keeper_private_key() -> str:
    return config.keeper_private_key


def _get_executor_contract() -> str:
    return config.executor_contract


def _get_gas_multiplier() -> float:
    return config.gas_multiplier


def _get_order_cooldown_sec() -> int:
    return config.order_cooldown_sec


def _keeper_account() -> Any | None:
    """Return an ``eth_account.LocalAccount`` for the keeper key (or ``None``)."""

    pk = _get_keeper_private_key().strip()
    if not pk:
        return None
    if not pk.startswith(("0x", "0X")):
        pk = "0x" + pk
    try:
        return Account.from_key(pk)
    except Exception:
        log.exception("keeper.bad_private_key")
        return None


def _enabled() -> tuple[bool, str]:
    """Return ``(enabled, reason)`` for the current tick."""

    exec_addr = _get_executor_contract()
    if not exec_addr or exec_addr == "0x" + "00" * 20:
        return False, "EXECUTOR_CONTRACT not set"
    if not _get_keeper_private_key().strip():
        return False, "KEEPER_PRIVATE_KEY not set"
    return True, ""


def _log_disabled(reason: str) -> None:
    """Log "keeper disabled" at most once a minute to keep logs quiet."""

    now = time.monotonic()
    if now - _state.last_skip_log_ts > 60.0:
        _state.last_skip_log_ts = now
        log.info("keeper.disabled", reason=reason)


# ─── DB queries ─────────────────────────────────────────────────────────────


def _select_armed_orders() -> list[dict[str, Any]]:
    """Same shape as ``/orders/armed`` — server-side, no HTTP round-trip.

    The trigger comparison uses MID-space prices throughout: the cached
    ``market_state.price_country`` / ``price_pitch`` columns come from
    ``Hook.currentPrice`` (fee-free MID), and the per-order target we
    compare against is ``display_target_price`` (the value the user typed
    in chart-space). When ``display_target_price`` is NULL (pre-migration-
    0004 row, e.g. prod order #1) we fall back to deriving the MID from
    the signed execution-space ``target_price`` via the fixed pitchwc fee
    constant — see :mod:`shared.fee`.

    ASK/BID columns on ``market_state`` (added by migration 0002) are
    NEVER read here — they exist solely for the frontend fee-breakdown UI.
    Comparing the user's MID-space intent against ASK/BID would fire the
    order ~5% too early/late.
    """

    sql = (
        "SELECT lo.id, lo.owner_address, lo.token_address, lo.quote_address, "
        " lo.venue, lo.side, lo.target_price, lo.display_target_price, "
        " lo.amount_in, lo.slippage_bps, "
        " EXTRACT(EPOCH FROM lo.expires_at)::bigint AS expires_at_ts, "
        " lo.nonce, lo.signature, lo.attempts, "
        " ms.price_country, ms.price_pitch, "
        " COALESCE(us.orders_armed, true) AS armed "
        "FROM limit_orders lo "
        "LEFT JOIN market_state ms ON ms.token_address = lo.token_address "
        "LEFT JOIN user_settings us ON us.owner_address = lo.owner_address "
        "WHERE lo.status = 'open' "
        "  AND (lo.retry_after IS NULL OR lo.retry_after <= now()) "
        "  AND (lo.expires_at IS NULL OR lo.expires_at > now()) "
        "ORDER BY lo.id ASC LIMIT %s"
    )
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, (MAX_ORDERS_PER_TICK * 4,))  # over-fetch; filter in Python
        rows = cur.fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        if not isinstance(r, dict):
            # Defensive: convert tuple to dict by column index if needed.
            continue
        if not bool(r["armed"]):
            continue
        venue = r["venue"]
        market_mid = int(r["price_country"]) if venue == "player" else int(r["price_pitch"])
        side = r["side"]
        # Prefer the MID-space target the user typed (display_target_price);
        # fall back to deriving MID from the signed execution-space target
        # for pre-0004 rows.
        if r.get("display_target_price") is not None:
            target_mid = int(r["display_target_price"])
        else:
            target_mid = execution_to_mid_wei(int(r["target_price"]), side)
        decision = should_trigger(side, target_mid, market_mid)
        if not decision.triggers:
            continue
        r["market_price"] = market_mid
        r["target_mid"] = target_mid
        out.append(r)
        if len(out) >= MAX_ORDERS_PER_TICK:
            break
    return out


def _select_executing_orders() -> list[dict[str, Any]]:
    """Rows in ``status='executing'`` we should poll for a receipt."""

    sql = (
        "SELECT id, owner_address, executed_tx_hash, attempts, "
        " EXTRACT(EPOCH FROM last_attempt_at)::double precision AS last_attempt_ts "
        "FROM limit_orders "
        "WHERE status = 'executing' AND executed_tx_hash IS NOT NULL "
        "ORDER BY last_attempt_at ASC NULLS FIRST LIMIT %s"
    )
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, (MAX_RECEIPT_POLLS_PER_TICK,))
        rows = cur.fetchall()
    return [dict(r) for r in rows if isinstance(r, dict)]


def _mark_executing(order_id: int, tx_hash: str) -> None:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE limit_orders "
            "SET status='executing', executed_tx_hash=%s, "
            "    last_attempt_at=now(), attempts=attempts+1 "
            "WHERE id=%s AND status='open'",
            (tx_hash.lower(), order_id),
        )


def _mark_filled(order_id: int) -> None:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE limit_orders SET status='filled' WHERE id=%s AND status='executing'",
            (order_id,),
        )


def _mark_failed(order_id: int, reason: str, detail: str | None) -> None:
    """Set status=failed with the parsed reason/detail. Idempotent on already failed."""

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE limit_orders SET status='failed', "
            "    fail_reason=%s, fail_detail=%s "
            "WHERE id=%s AND status IN ('open','executing')",
            (reason, (detail[:500] if detail else None), order_id),
        )


def _mark_cooldown(order_id: int, reason: str, detail: str | None) -> None:
    """Keep status='open' but set ``retry_after`` and ``last_attempt_at``."""

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE limit_orders SET retry_after=now() + make_interval(secs => %s), "
            "    last_attempt_at=now(), attempts=attempts+1, "
            "    fail_reason=%s, fail_detail=%s "
            "WHERE id=%s AND status='open'",
            (
                int(_get_order_cooldown_sec()),
                reason,
                (detail[:500] if detail else None),
                order_id,
            ),
        )


def _emit_notify(order_id: int) -> None:
    """Push a ``pt_orders`` NOTIFY; never raises."""

    try:
        notify(_NOTIFY_CHANNEL, str(order_id))
    except Exception:
        log.exception("keeper.notify_failed", order_id=order_id)


# ─── Tx building / sending ──────────────────────────────────────────────────


def _build_order_struct(row: dict[str, Any]) -> tuple[Any, ...]:
    """Translate a ``limit_orders`` row into the executor's ``Order`` tuple.

    The contract takes a Solidity struct, web3.py expects a plain tuple in
    field order (owner, token, quoteToken, venue, side, targetPrice,
    amountIn, slippageBps, expiry, nonce).
    """

    side_int = 0 if row["side"] == "limit-buy" else 1
    venue_int = 0 if row["venue"] == "player" else 1
    nonce_hex = row["nonce"].strip()
    return (
        Web3.to_checksum_address(row["owner_address"].strip()),
        Web3.to_checksum_address(row["token_address"].strip()),
        Web3.to_checksum_address(row["quote_address"].strip()),
        int(venue_int),
        int(side_int),
        int(row["target_price"]),
        int(row["amount_in"]),
        int(row["slippage_bps"]),
        int(row["expires_at_ts"]) if row.get("expires_at_ts") is not None else 0,
        int(nonce_hex, 16),
    )


def _ensure_nonce(w3: Any, keeper_addr: str) -> int:
    """Lazy-init / periodic-resync the local nonce counter."""

    now = time.monotonic()
    if _state.next_nonce is None or now - _state.last_nonce_resync_ts > NONCE_RESYNC_INTERVAL_SEC:
        chain_nonce = int(w3.eth.get_transaction_count(keeper_addr, "pending"))
        if _state.next_nonce is None or chain_nonce > _state.next_nonce:
            _state.next_nonce = chain_nonce
        _state.last_nonce_resync_ts = now
    assert _state.next_nonce is not None
    return _state.next_nonce


def _gas_price(w3: Any) -> int:
    """Latest gas-price multiplied by :data:`config.gas_multiplier` (e.g. 1.5)."""

    base = int(w3.eth.gas_price)
    return int(base * _get_gas_multiplier())


def _simulate(
    w3: Any, contract: Any, order_struct: tuple[Any, ...], signature: bytes, keeper_addr: str
) -> tuple[bool, str | None, str | None]:
    """``eth_call``-simulate ``executor.execute(order, sig)``.

    Returns ``(ok, fail_reason, label)``. ``fail_reason``/``label`` are
    ``None`` on success; on revert they're the decoded enum value (or
    ``"unknown"``) and the ABI name (or ``None``).
    """

    try:
        contract.functions.execute(order_struct, signature).call({"from": keeper_addr})
        return True, None, None
    except Exception as exc:  # web3 ContractCustomError / ContractLogicError
        # web3.py 7 exposes ``data`` on ``ContractCustomError``; we also look
        # at ``str(exc)`` for older / wrapped variants.
        data = getattr(exc, "data", None) or str(exc)
        reason, label = decode_revert_reason(data)
        return False, reason, label


def _send_execute(
    w3: Any,
    contract: Any,
    order_struct: tuple[Any, ...],
    signature: bytes,
    account: Any,
) -> str:
    """Build/sign/send ``executor.execute(order, sig)``; return ``tx_hash`` hex.

    Bumps the local nonce counter on success. Caller decides what to do on
    exception (typically: log + leave the order open; next tick retries).
    """

    keeper_addr = account.address
    nonce = _ensure_nonce(w3, keeper_addr)

    # Build the tx via the contract function; web3.py fills `to`, `data`.
    tx = contract.functions.execute(order_struct, signature).build_transaction(
        {
            "from": keeper_addr,
            "nonce": nonce,
            "gasPrice": _gas_price(w3),
            "chainId": 8453,  # Base mainnet (matches BASE_CHAIN_ID in shared.orders)
        }
    )
    # Estimate gas with a safety margin; if estimation itself reverts the
    # caller will see the exception and treat it like a simulation failure.
    try:
        gas = int(w3.eth.estimate_gas(tx))
        tx["gas"] = int(gas * 1.25)
    except Exception:
        # Fallback to a generous fixed gas; the on-chain check still gates
        # the tx (will revert if conditions changed).
        tx["gas"] = 600_000

    signed = account.sign_transaction(tx)
    # eth-account 0.13+: ``raw_transaction``; older releases: ``rawTransaction``.
    raw = getattr(signed, "raw_transaction", None)
    if raw is None:
        raw = signed.rawTransaction
    tx_hash = w3.eth.send_raw_transaction(raw)
    _state.next_nonce = nonce + 1
    return tx_hash.hex() if isinstance(tx_hash, bytes | bytearray) else str(tx_hash)


# ─── Receipt polling ────────────────────────────────────────────────────────


def _poll_receipt(w3: Any, contract: Any, row: dict[str, Any]) -> None:
    """Inspect the receipt for one ``executing`` row and update status."""

    tx_hash_hex = row["executed_tx_hash"]
    if not tx_hash_hex:
        return
    tx_hash: HexBytes
    if isinstance(tx_hash_hex, bytes | bytearray):
        tx_hash = HexBytes(bytes(tx_hash_hex))
    else:
        tx_hash = HexBytes(tx_hash_hex)
    try:
        receipt = w3.eth.get_transaction_receipt(tx_hash)
    except Exception:
        # Most likely "receipt not yet available" — let the next tick retry.
        # We don't log noisily because this is the common case.
        log.debug("keeper.receipt_pending", order_id=row["id"])
        return

    if receipt is None:
        return

    status = int(receipt.get("status", 0))
    order_id = int(row["id"])
    if status == 1:
        # Confirm OrderExecuted log presence — sanity.
        try:
            logs = contract.events.OrderExecuted().process_receipt(receipt)
        except Exception:
            logs = []
        if logs:
            log.info("keeper.filled", order_id=order_id, tx=str(tx_hash.hex()))
        else:
            log.warning(
                "keeper.filled_no_event",
                order_id=order_id,
                tx=str(tx_hash.hex()),
            )
        _mark_filled(order_id)
        _emit_notify(order_id)
        return

    # status == 0 — reverted. Replay via eth_call at the receipt's block to
    # extract the revert reason.
    reason = "unknown"
    label: str | None = None
    try:
        # We need the original tx data to replay — fetch the tx itself.
        tx = w3.eth.get_transaction(tx_hash)
        call_obj = {
            "from": tx["from"],
            "to": tx["to"],
            "data": tx["input"],
            "value": tx.get("value", 0),
            "gas": tx.get("gas"),
        }
        try:
            w3.eth.call(call_obj, receipt.get("blockNumber"))
            # If the replay succeeded we still know the on-chain tx
            # reverted — fall through as "unknown".
        except Exception as exc:
            data = getattr(exc, "data", None) or str(exc)
            reason, label = decode_revert_reason(data)
    except Exception:
        log.exception("keeper.receipt_replay_failed", order_id=order_id)

    log.info(
        "keeper.reverted",
        order_id=order_id,
        tx=str(tx_hash.hex()),
        reason=reason,
        label=label,
    )
    # Reverts that came from the contract's own price-condition checks are
    # not terminal — leave the order open with a cooldown. Everything
    # else is terminal failure.
    if is_retryable_label(label):
        # Move it back to open with a cooldown so the next tick can
        # re-evaluate against fresh prices.
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE limit_orders SET status='open', executed_tx_hash=NULL, "
                "    retry_after=now() + make_interval(secs => %s), "
                "    fail_reason=%s, fail_detail=%s "
                "WHERE id=%s AND status='executing'",
                (int(_get_order_cooldown_sec()), reason, label, order_id),
            )
        _emit_notify(order_id)
        return

    _mark_failed(order_id, reason, label or "reverted")
    _emit_notify(order_id)


# ─── Recovery on startup ────────────────────────────────────────────────────


def run_recovery() -> None:
    """One-shot pass: resolve every ``executing`` row left over by a crash.

    For each row:

    * receipt exists, status=1 → ``filled``.
    * receipt exists, status=0 → ``failed`` (or open+cooldown for
      retryable causes).
    * receipt absent / RPC failure → leave the row, the tick loop polls it
      again next iteration.
    """

    enabled, reason = _enabled()
    if not enabled:
        log.info("keeper.recovery_skip", reason=reason)
        return

    try:
        rows = _select_executing_orders()
    except Exception:
        log.exception("keeper.recovery_select_failed")
        return
    if not rows:
        log.info("keeper.recovery_no_rows")
        return

    try:
        w3 = _w3.get_w3()
        contract = w3.eth.contract(
            address=Web3.to_checksum_address(_get_executor_contract()),
            abi=_executor_abi(),
        )
    except Exception:
        log.exception("keeper.recovery_w3_failed")
        return

    log.info("keeper.recovery_begin", rows=len(rows))
    for row in rows:
        try:
            _poll_receipt(w3, contract, row)
        except Exception:
            log.exception("keeper.recovery_row_failed", order_id=row.get("id"))


# ─── Main tick ──────────────────────────────────────────────────────────────


def tick() -> int:
    """Single keeper iteration. Returns the number of orders touched."""

    enabled, reason = _enabled()
    if not enabled:
        _log_disabled(reason)
        return 0

    account = _keeper_account()
    if account is None:
        _log_disabled("KEEPER_PRIVATE_KEY invalid")
        return 0

    # Lazy w3 — avoids touching RPC on a cold "keeper disabled" tick.
    try:
        w3 = _w3.get_w3()
    except Exception:
        log.exception("keeper.w3_failed")
        return 0

    try:
        contract = w3.eth.contract(
            address=Web3.to_checksum_address(_get_executor_contract()),
            abi=_executor_abi(),
        )
    except Exception:
        log.exception("keeper.contract_init_failed")
        return 0

    keeper_addr = account.address
    touched = 0

    # ── 1. Poll receipts for executing orders first ──
    try:
        for row in _select_executing_orders():
            try:
                _poll_receipt(w3, contract, row)
                touched += 1
            except Exception:
                log.exception("keeper.poll_row_failed", order_id=row.get("id"))
    except Exception:
        log.exception("keeper.select_executing_failed")

    # ── 2. Try to fire any armed orders ──
    try:
        armed = _select_armed_orders()
    except Exception:
        log.exception("keeper.select_armed_failed")
        return touched

    for row in armed:
        order_id = int(row["id"])
        attempts = int(row.get("attempts") or 0)
        if attempts >= MAX_ATTEMPTS:
            log.warning("keeper.attempts_exhausted", order_id=order_id, attempts=attempts)
            _mark_failed(order_id, "unknown", "max attempts")
            _emit_notify(order_id)
            continue

        try:
            order_struct = _build_order_struct(row)
        except Exception:
            log.exception("keeper.build_struct_failed", order_id=order_id)
            continue
        signature = bytes(row["signature"])

        log.info(
            "keeper.armed",
            order_id=order_id,
            owner=row["owner_address"].strip(),
            side=row["side"],
            venue=row["venue"],
            target_signed=str(int(row["target_price"])),
            target_mid=str(int(row["target_mid"])),
            market_mid=str(int(row["market_price"])),
        )

        # ── 2a. Pre-flight simulation ──
        ok, sim_reason, sim_label = _simulate(w3, contract, order_struct, signature, keeper_addr)
        if not ok:
            if is_retryable_label(sim_label):
                log.info(
                    "keeper.simulate_cooldown",
                    order_id=order_id,
                    reason=sim_reason,
                    label=sim_label,
                )
                _mark_cooldown(order_id, sim_reason or "unknown", sim_label)
                _emit_notify(order_id)
            else:
                log.warning(
                    "keeper.simulate_failed",
                    order_id=order_id,
                    reason=sim_reason,
                    label=sim_label,
                )
                _mark_failed(order_id, sim_reason or "unknown", sim_label or "simulation reverted")
                _emit_notify(order_id)
            touched += 1
            continue

        # ── 2b. Send ──
        try:
            tx_hash = _send_execute(w3, contract, order_struct, signature, account)
        except Exception as exc:
            # Could be: nonce too low (someone else used the key), RPC
            # disconnect, gas-estimation failure. Resync nonce on next tick
            # by clearing the timestamp gate; otherwise leave the order
            # open so we'll try again.
            log.warning("keeper.send_failed", order_id=order_id, error=type(exc).__name__)
            _state.last_nonce_resync_ts = 0.0
            continue

        # Normalize tx_hash to 0x-prefixed lowercase hex for DB storage.
        tx_hash_norm = tx_hash if tx_hash.startswith(("0x", "0X")) else ("0x" + tx_hash)
        _mark_executing(order_id, tx_hash_norm)
        _emit_notify(order_id)
        log.info("keeper.submitted", order_id=order_id, tx=tx_hash_norm)
        touched += 1

    return touched


__all__ = [
    "KEEPER_TICK_INTERVAL_SEC",
    "MAX_ATTEMPTS",
    "MAX_ORDERS_PER_TICK",
    "MAX_RECEIPT_POLLS_PER_TICK",
    "TriggerDecision",
    "decode_revert_reason",
    "is_retryable_label",
    "run_recovery",
    "should_trigger",
    "tick",
]
