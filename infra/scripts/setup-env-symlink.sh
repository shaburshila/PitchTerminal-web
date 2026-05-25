#!/usr/bin/env bash
# infra/scripts/setup-env-symlink.sh — idempotent setup of `infra/.env`
# symlink pointing to `../.env` (host-level secrets file in repo root).
#
# Why this exists:
#   Compose-file использует `${VAR:-default}` substitution в `infra/docker-compose.yml`.
#   Substitution резолвится из shell env ИЛИ из `.env` файла рядом с compose-file
#   (т.е. в `infra/.env`). Реальный production-`.env` живёт уровнем выше (репо-root,
#   `~/pitchterminal/.env` на VPS). Без симлинка substitution получает default
#   (`pt:pt`), что не совпадает с фактическим Postgres-паролем → worker/api валятся
#   с `password authentication failed for user "pt"`.
#
#   `env_file: ../.env` в YAML-блоке сервиса в substitution НЕ участвует — он
#   только пробрасывает переменные внутрь контейнера.
#
# Usage:
#   bash infra/scripts/setup-env-symlink.sh
#
# Run from repo root on a fresh VPS после первого `git clone` и создания
# `~/pitchterminal/.env` с production-секретами (см. docs/runbook.md §7).
#
# Idempotent: повторный запуск при уже существующем правильном симлинке = no-op.

set -euo pipefail

INFRA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$INFRA_DIR/.." && pwd)"

TARGET="$REPO_ROOT/.env"
LINK="$INFRA_DIR/.env"

# Case 1: симлинк уже корректный → no-op
if [ -L "$LINK" ] && [ "$(readlink "$LINK")" = "../.env" ]; then
  echo "[ok] infra/.env already symlinked to ../.env"
  exit 0
fi

# Case 2: симлинк существует но указывает не туда → не клоберим
if [ -L "$LINK" ]; then
  current="$(readlink "$LINK")"
  echo "[error] infra/.env exists but points to '$current' (expected '../.env')" >&2
  echo "        Inspect manually and remove if safe: rm $LINK" >&2
  exit 1
fi

# Case 3: на месте симлинка лежит реальный файл → не клоберим (может содержать секреты)
if [ -e "$LINK" ]; then
  echo "[error] infra/.env exists as a regular file. Backup/move it before running this script." >&2
  echo "        Example: mv $LINK $LINK.bak" >&2
  exit 1
fi

# Case 4: target должен существовать (иначе симлинк битый)
if [ ! -f "$TARGET" ]; then
  echo "[error] target $TARGET does not exist." >&2
  echo "        Create it first with production env vars (see docs/runbook.md §7)." >&2
  exit 1
fi

# All checks passed — создаём симлинк
ln -s ../.env "$LINK"
echo "[ok] created infra/.env -> ../.env"
