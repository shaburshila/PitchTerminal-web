"""Alembic environment.

Loads DATABASE_URL from the repo-root ``.env`` (or ``backend/.env`` as a
fallback) and feeds it to Alembic. We use raw SQL migrations (see
``versions/0001_initial.py``), so ``target_metadata`` stays ``None`` — no
autogenerate, no SQLAlchemy models.
"""

from __future__ import annotations

import os
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from dotenv import load_dotenv
from sqlalchemy import engine_from_config, pool

# Load .env from repo root first (shared with worker/api), then backend/.env as
# a fallback for local-only overrides. `override=False` keeps existing env vars.
_BACKEND_DIR = Path(__file__).resolve().parents[1]
_REPO_ROOT = _BACKEND_DIR.parent
load_dotenv(_REPO_ROOT / ".env", override=False)
load_dotenv(_BACKEND_DIR / ".env", override=False)

# Alembic Config object — gives access to alembic.ini values.
config = context.config

# Resolve DATABASE_URL from env vars; required.
_database_url = os.environ.get("DATABASE_URL")
if not _database_url:
    raise RuntimeError(
        "DATABASE_URL is not set. Put it in repo-root .env or backend/.env, "
        "e.g. DATABASE_URL=postgresql://pt:pt@localhost:5432/pt"
    )
# Project ships psycopg v3, not psycopg2 — pin SQLAlchemy to the right driver.
# Accept either bare ``postgresql://`` or already-qualified
# ``postgresql+psycopg://`` URLs from .env.
if _database_url.startswith("postgresql://"):
    _database_url = "postgresql+psycopg://" + _database_url[len("postgresql://") :]
config.set_main_option("sqlalchemy.url", _database_url)

# Logging configuration from alembic.ini.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# We use raw SQL migrations, not autogenerate.
target_metadata = None


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode (emit SQL)."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode (against a live DB)."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
