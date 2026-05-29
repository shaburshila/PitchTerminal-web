"""Run the idempotent ``scripts.seed_tokens`` on every worker start.

The Docker entrypoint runs the worker (``run_worker.py``) on every container
start. We want seeding to be automatic — operators shouldn't have to remember
a separate ``python -m scripts.seed_tokens`` step.

The seed is **idempotent** (``ON CONFLICT (address) DO NOTHING``), so we run it
unconditionally rather than gating on an empty table. This matters for adding
new tokens (e.g. icon-pack rows) to an *existing* deployment: a populated
``tokens`` table must still pick up newly-added JSON entries. Already-present
rows are skipped, new ones inserted.
"""

from __future__ import annotations

from shared.log import get_logger

log = get_logger("worker.seed_tokens")


def ensure_seeded() -> None:
    """Idempotently seed tokens.json into the DB (insert missing rows)."""

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
            inserted_icons=counts.inserted_icons,
            skipped_countries=counts.skipped_countries,
            skipped_players=counts.skipped_players,
            skipped_icons=counts.skipped_icons,
        )
    except Exception:
        log.exception("seed_tokens.failed")


__all__ = ["ensure_seeded"]
