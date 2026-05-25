# syntax=docker/dockerfile:1.7

# ---------- builder stage ----------
FROM python:3.12-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Build deps for wheels that may need compilation. psycopg[binary] ships wheels,
# but keep gcc available just in case for transient dependency builds.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential libffi-dev libpq-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY requirements.txt ./
RUN pip wheel --wheel-dir=/wheels -r requirements.txt

# ---------- runtime stage ----------
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PATH="/usr/local/bin:${PATH}"

# Runtime libs only (libpq for psycopg). curl is tiny and handy for healthchecks.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq5 curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r app --gid 1000 \
    && useradd -r -g app --uid 1000 -d /app -s /sbin/nologin app

WORKDIR /app

# Install pre-built wheels from the builder stage and immediately discard them
# so they don't bloat the final image layer.
COPY --from=builder /wheels /wheels
RUN pip install --no-index --find-links=/wheels /wheels/*.whl \
    && rm -rf /wheels

# Copy backend source. .dockerignore filters out venv, caches, tests, .env, etc.
COPY --chown=app:app shared/    /app/shared/
COPY --chown=app:app app/       /app/app/
COPY --chown=app:app worker/    /app/worker/
COPY --chown=app:app scripts/   /app/scripts/
COPY --chown=app:app data/      /app/data/
COPY --chown=app:app abis/      /app/abis/
COPY --chown=app:app migrations/ /app/migrations/
COPY --chown=app:app alembic.ini run_api.py run_worker.py /app/

USER app

ENV PYTHONPATH=/app

EXPOSE 8000

# ENTRYPOINT runs `alembic upgrade head` then execs CMD. Both api and worker
# go through this — migrations are idempotent and Postgres serializes parallel
# attempts via the alembic_version row lock. See scripts/entrypoint.sh.
#
# Default CMD is API via gunicorn (gevent worker — psycogreen.gevent
# monkey-patches psycopg in shared/db.py so DB calls are cooperatively
# scheduled). Override via compose `command:` for the worker container:
#   command: ["python", "run_worker.py"]
ENTRYPOINT ["/app/scripts/entrypoint.sh"]
CMD ["python", "-m", "gunicorn", \
     "--worker-class", "gevent", \
     "--workers", "2", \
     "--bind", "0.0.0.0:8000", \
     "--access-logfile", "-", \
     "--error-logfile", "-", \
     "run_api:app"]
