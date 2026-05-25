#!/bin/sh
set -e

# Both api and worker share this image. Each runs `alembic upgrade head` on
# start — it is idempotent (no-op when DB is at head). When both containers
# start in parallel, Postgres serializes via the alembic_version row lock:
# the second arrival sees head and exits clean. No race, no double-apply.
#
# Lives in backend/scripts/ so it is copied into the image at /app/scripts/.

alembic upgrade head

exec "$@"
