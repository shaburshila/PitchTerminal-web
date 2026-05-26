#!/bin/sh
set -e

# Both api and worker share this image. Earlier the entrypoint ran
# `alembic upgrade head` in BOTH containers, relying on Postgres'
# alembic_version row lock to serialise. That assumption was wrong: the
# version check happens BEFORE the lock is taken, so on a fresh migration
# both processes saw the old version, both attempted the migration, and the
# loser failed with `DuplicateColumn` (see incident on 54b1744 deploy).
#
# New contract: api owns migrations, worker waits.
#   ROLE=api    → run `alembic upgrade head`, then exec.
#   ROLE=worker → poll until current == head (or fail-fast after timeout),
#                 then exec. Never runs the migration itself.
#   ROLE unset  → legacy behaviour (run migrations). Kept for local dev where
#                 only one container exists or compose isn't used.
#
# The wait timeout (`MIGRATION_WAIT_TIMEOUT_SEC`, default 120s) protects the
# worker from spinning forever if api wedges. After timeout the worker exits
# non-zero; Docker's restart-policy picks it up for a fresh attempt.

ROLE="${ROLE:-}"
MIGRATION_WAIT_TIMEOUT_SEC="${MIGRATION_WAIT_TIMEOUT_SEC:-120}"
MIGRATION_WAIT_INTERVAL_SEC=2

wait_for_migration() {
    # Poll `alembic current` until it matches `alembic heads`. Alembic prints
    # the revision id as the first whitespace-separated token; head row is
    # tagged with " (head)" but we only need the id.
    #
    # Fail-fast on multi-head: an un-merged migration branch would otherwise
    # silently pick the first head and the worker would spin forever waiting
    # for the wrong revision (or, worse, mark itself ready against a half-
    # applied schema).
    head_count="$(alembic heads 2>/dev/null | grep -c .)"
    if [ "$head_count" -gt 1 ]; then
        echo "entrypoint: multiple alembic heads detected — resolve the merge before deploying" >&2
        alembic heads >&2
        exit 1
    fi
    head="$(alembic heads 2>/dev/null | head -n1 | awk '{print $1}')"
    if [ -z "$head" ]; then
        echo "entrypoint: alembic heads returned empty — config broken?" >&2
        exit 1
    fi
    echo "entrypoint: worker waiting for migration to reach ${head}"
    elapsed=0
    while [ "$elapsed" -lt "$MIGRATION_WAIT_TIMEOUT_SEC" ]; do
        # Do NOT silence stderr here — if postgres is unreachable we want the
        # connection error visible in `docker logs pt-worker` instead of
        # spinning blindly until timeout.
        current="$(alembic current | head -n1 | awk '{print $1}')"
        if [ "$current" = "$head" ]; then
            echo "entrypoint: migration at head (${head}), starting worker"
            return 0
        fi
        sleep "$MIGRATION_WAIT_INTERVAL_SEC"
        elapsed=$((elapsed + MIGRATION_WAIT_INTERVAL_SEC))
    done
    echo "entrypoint: migration wait timed out after ${MIGRATION_WAIT_TIMEOUT_SEC}s (current='${current}', head='${head}')" >&2
    exit 1
}

case "$ROLE" in
    api)
        alembic upgrade head
        ;;
    worker)
        wait_for_migration
        ;;
    *)
        # Local dev / unspecified role — behave as before.
        alembic upgrade head
        ;;
esac

exec "$@"
