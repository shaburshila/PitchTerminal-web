"""Run the one-shot ``scripts.seed_tokens`` if the ``tokens`` table is empty.

The Docker entrypoint runs the worker (``run_worker.py``) on every container
start. We want first-boot seeding to be automatic — operators shouldn't have
to remember a separate ``python -m scripts.seed_tokens`` step. If the table
already has rows, skip silently.
"""

from __future__ import annotations

from shared.db import get_conn
from shared.log import get_logger

log = get_logger("worker.seed_tokens")


def _tokens_table_is_empty() -> bool:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM tokens LIMIT 1")
        return cur.fetchone() is None


def run_if_empty() -> None:
    """Seed tokens.json into the DB if the ``tokens`` table is empty."""

    try:
        if not _tokens_table_is_empty():
            log.info("seed_tokens.skip", reason="tokens_table_not_empty")
            return
    except Exception:
        log.exception("seed_tokens.precheck_failed")
        return

    log.info("seed_tokens.start")
    try:
        # Lazy import: seed_tokens has its own dotenv() / sys.path mucking and we
        # don't want it eagerly evaluated when the worker starts in environments
        # where the seed JSON isn't present (e.g. tests).
        from scripts import seed_tokens as seeder

        counts = seeder.seed()
        log.info(
            "seed_tokens.done",
            inserted_countries=counts.inserted_countries,
            inserted_players=counts.inserted_players,
            skipped_countries=counts.skipped_countries,
            skipped_players=counts.skipped_players,
        )
    except Exception:
        log.exception("seed_tokens.failed")


__all__ = ["run_if_empty"]
