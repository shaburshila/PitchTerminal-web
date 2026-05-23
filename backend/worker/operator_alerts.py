"""Outbound-only Telegram alerts for the operator.

Public surface:

* :func:`send(text)` — fire-and-forget Telegram message to ``OPERATOR_TG_CHAT_ID``
  via the ``OPERATOR_TG_BOT_TOKEN`` bot. Silent no-op when either env var is
  empty (dev / test default). Never raises — HTTP failures are logged and
  swallowed so alerts can't bring down the worker.

* :func:`record_tick_failure(loop_name)` / :func:`record_tick_success(loop_name)` —
  de-duplicated alerting for repeated consecutive failures in a worker loop.
  After :data:`CONSECUTIVE_FAILURE_THRESHOLD` failures in a row a single alert
  is emitted; further failures are silent until the next success.

* :func:`record_price_stale(now_ts, last_update_ts)` /
  :func:`record_price_fresh()` — alert once when prices haven't updated for
  more than :data:`PRICE_STALE_THRESHOLD_SEC`, reset on the next fresh tick.

* :func:`announce_worker_start(backfill_complete)` — single boot-time alert.

All env reads go through tiny accessor functions (:func:`_get_bot_token`,
:func:`_get_chat_id`) so tests can ``patch.object`` them — ``Config`` is a
frozen dataclass and can't be mutated directly.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Final

import httpx

from shared.config import config
from shared.log import get_logger

log = get_logger("worker.operator_alerts")

# ─── Tunables ───────────────────────────────────────────────────────────────
CONSECUTIVE_FAILURE_THRESHOLD: Final[int] = 5
PRICE_STALE_THRESHOLD_SEC: Final[int] = 5 * 60
_HTTP_TIMEOUT_SEC: Final[float] = 5.0

# ─── Internal de-dup state ──────────────────────────────────────────────────
# Per-loop consecutive failure counter. ``loop_name`` (e.g. ``event_loop``)
# → count of failures since the last success.
_consecutive_failures: dict[str, int] = {}
# Per-loop "we've already alerted about this run of failures" flag. Reset
# on the next success.
_failure_alerted: dict[str, bool] = {}
# Single boolean for price-loop staleness — only one price loop exists.
_price_stale_alerted: bool = False


# ─── Config accessors (test seam) ───────────────────────────────────────────
def _get_bot_token() -> str:
    """Indirection so tests can patch the configured token.

    ``Config`` is frozen, so ``patch.object(config, "operator_tg_bot_token", ...)``
    would raise ``FrozenInstanceError``. Patch this helper instead.
    """

    return config.operator_tg_bot_token


def _get_chat_id() -> str:
    """Indirection so tests can patch the configured chat id (see above)."""

    return config.operator_tg_chat_id


# ─── Public API ─────────────────────────────────────────────────────────────
def send(text: str) -> None:
    """Send ``text`` to the operator chat. Noop if credentials unset.

    Never raises — HTTP errors are logged and swallowed. This is intentional:
    an alert path that can itself break the worker is worse than no alerts.
    """

    token = _get_bot_token()
    chat_id = _get_chat_id()
    if not token or not chat_id:
        log.debug("operator_alerts.skip", reason="creds_unset")
        return

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    try:
        resp = httpx.post(
            url,
            json={"chat_id": chat_id, "text": text},
            timeout=_HTTP_TIMEOUT_SEC,
        )
        if resp.status_code >= 400:
            log.warning(
                "operator_alerts.http_error",
                status=resp.status_code,
                body=resp.text[:200],
            )
        else:
            log.debug("operator_alerts.sent", chars=len(text))
    except Exception as exc:
        # httpx.TimeoutException, ConnectError, etc — never let alert path
        # propagate. We log the class name (no full traceback, this is noisy).
        log.warning("operator_alerts.send_failed", error=type(exc).__name__)


def _ts() -> str:
    """ISO-8601 UTC timestamp for alert bodies."""

    return datetime.now(tz=UTC).strftime("%Y-%m-%d %H:%M:%S UTC")


def record_tick_failure(loop_name: str, *, error_code: str | None = None) -> None:
    """Increment failure counter for ``loop_name`` and alert if past threshold.

    Sends exactly one alert per run of consecutive failures. Further failures
    in the same streak are silent. Reset on :func:`record_tick_success`.
    """

    count = _consecutive_failures.get(loop_name, 0) + 1
    _consecutive_failures[loop_name] = count
    if count >= CONSECUTIVE_FAILURE_THRESHOLD and not _failure_alerted.get(loop_name):
        _failure_alerted[loop_name] = True
        suffix = f" code={error_code}" if error_code else ""
        send(
            f"[{_ts()}] worker.{loop_name}: {count} consecutive tick failures{suffix}"
        )


def record_tick_success(loop_name: str) -> None:
    """Reset failure state for ``loop_name``. Emits recovery alert if we had alerted."""

    had_alerted = _failure_alerted.get(loop_name, False)
    _consecutive_failures[loop_name] = 0
    _failure_alerted[loop_name] = False
    if had_alerted:
        send(f"[{_ts()}] worker.{loop_name}: recovered")


def record_price_stale(now_ts: float, last_update_ts: float) -> None:
    """Emit a single alert when price freshness exceeds the threshold.

    ``last_update_ts`` of 0 / negative means «never updated yet» — we don't
    alert on a cold worker; this fires only after at least one update.
    """

    global _price_stale_alerted
    if last_update_ts <= 0:
        return
    age = now_ts - last_update_ts
    if age > PRICE_STALE_THRESHOLD_SEC and not _price_stale_alerted:
        _price_stale_alerted = True
        send(
            f"[{_ts()}] worker.price_loop: prices stale "
            f"(age={int(age)}s > {PRICE_STALE_THRESHOLD_SEC}s)"
        )


def record_price_fresh() -> None:
    """Reset price-stale flag; called on a successful price update."""

    global _price_stale_alerted
    if _price_stale_alerted:
        send(f"[{_ts()}] worker.price_loop: recovered")
    _price_stale_alerted = False


def announce_worker_start(*, backfill_complete: bool) -> None:
    """One-shot boot-time alert."""

    send(f"[{_ts()}] worker started, backfill_complete={backfill_complete}")


def _reset_state_for_tests() -> None:
    """Test helper: clear all in-memory de-dup state."""

    global _price_stale_alerted
    _consecutive_failures.clear()
    _failure_alerted.clear()
    _price_stale_alerted = False


__all__ = [
    "CONSECUTIVE_FAILURE_THRESHOLD",
    "PRICE_STALE_THRESHOLD_SEC",
    "announce_worker_start",
    "record_price_fresh",
    "record_price_stale",
    "record_tick_failure",
    "record_tick_success",
    "send",
]
