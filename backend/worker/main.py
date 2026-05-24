"""Worker entry point.

Order on boot:
1. ``seed_tokens.run_if_empty()`` — populate ``tokens`` on first Docker boot.
2. ``backfill.run_if_needed()`` — stub in B0.6; real implementation in B0.7.
3. ``access_bootstrap.run_if_needed()`` — pin ``app_state.access_config``
   when ``ACCESS_CONTRACT`` is set.

Then loop forever every 5 seconds:
* ``price_loop.tick()``
* ``event_loop.tick()``
* ``access_event_loop.tick()``
* ``nonces.cleanup()``
* ``expiry.tick()`` — sub-tick, runs at most once every
  :data:`worker.expiry.EXPIRY_TICK_INTERVAL_SEC` (30 s) via a timestamp gate.

Each tick is wrapped in its own try/except (inside the respective module),
so a single failing tick never crashes the whole worker.
"""

from __future__ import annotations

import signal
import sys
import time
from types import FrameType

from shared.log import get_logger
from worker import (
    access_bootstrap,
    access_event_loop,
    backfill,
    event_loop,
    expiry,
    nonces,
    operator_alerts,
    price_loop,
    seed_tokens,
)

log = get_logger("worker.main")

TICK_INTERVAL_SEC = 5

# Cooperative shutdown flag — set by SIGTERM/SIGINT handler, checked between
# ticks so we never get SIGKILL'd in the middle of a Multicall / DB write.
_shutdown_requested = False


def _request_shutdown(signum: int, _frame: FrameType | None) -> None:
    """Signal handler: flip the flag and log; the loop checks between ticks."""

    global _shutdown_requested
    if _shutdown_requested:
        # Second signal while shutting down — bail immediately.
        log.warning("worker.shutdown_force", signal=signum)
        sys.exit(1)
    _shutdown_requested = True
    log.info("worker.shutdown_requested", signal=signum)


def _install_signal_handlers() -> None:
    """Trap SIGTERM (Docker stop) and SIGINT (Ctrl-C) for graceful shutdown."""

    signal.signal(signal.SIGTERM, _request_shutdown)
    signal.signal(signal.SIGINT, _request_shutdown)


def run() -> None:
    """Main worker entry point — returns on SIGTERM/SIGINT, else loops forever."""

    log.info("worker.start")
    _install_signal_handlers()

    try:
        seed_tokens.run_if_empty()
    except Exception:
        log.exception("worker.seed_tokens_failed")

    backfill_complete = False
    try:
        backfill.run_if_needed()
        backfill_complete = True
    except Exception:
        log.exception("worker.backfill_failed")

    try:
        access_bootstrap.run_if_needed()
    except Exception:
        log.exception("worker.access_bootstrap_failed")

    try:
        operator_alerts.announce_worker_start(backfill_complete=backfill_complete)
    except Exception:
        log.exception("worker.boot_alert_failed")

    log.info("worker.loop_begin", tick_interval_sec=TICK_INTERVAL_SEC)
    # Per-loop timestamp gate for sub-ticks that run on a slower cadence than
    # ``TICK_INTERVAL_SEC``. Initialised so the first iteration runs them
    # immediately (we want expiry to flush any orders that aged-out while the
    # worker was down).
    next_expiry_at = 0.0
    while not _shutdown_requested:
        price_loop.tick()
        event_loop.tick()
        access_event_loop.tick()
        nonces.cleanup()

        # Expiry tick: 30s cadence (per docs/plans/backend.md B2.4).
        now_mono = time.monotonic()
        if now_mono >= next_expiry_at:
            try:
                count = expiry.tick()
                if count > 0:
                    log.info("worker.expiry.expired", count=count)
            except Exception:
                log.exception("worker.expiry_failed")
            next_expiry_at = now_mono + expiry.EXPIRY_TICK_INTERVAL_SEC

        # Sleep in 0.5s slices so SIGTERM is honored within ~500ms instead of
        # ~5s. Docker default grace-period is 10s — we want to exit well inside.
        for _ in range(TICK_INTERVAL_SEC * 2):
            if _shutdown_requested:
                break
            time.sleep(0.5)
    log.info("worker.exit_clean")


__all__ = ["run"]
