#!/usr/bin/env bash
# scripts/rollback.sh — manual rollback of PitchTerminal-web на VPS.
#
# Usage:
#   bash scripts/rollback.sh <git-tag-or-sha>
#
# Например:
#   bash scripts/rollback.sh v0.1.2
#   bash scripts/rollback.sh 8a3f1c2
#
# Также вызывается автоматически из .github/workflows/deploy.yml при
# fail'е post-deploy health check'а (передаётся предыдущий SHA).
#
# Что делает:
#   1. cd в /home/deploy/pitchterminal (либо $PT_REPO_DIR — для тестов).
#   2. git fetch + git checkout <target>.
#   3. docker compose up -d --build (пересобрать с предыдущего кода).
#   4. Health check; exit 0 при success, exit 1 при fail.
#
# Безопасность:
#   - НЕ удаляет volumes (data preserved).
#   - НЕ откатывает alembic-миграции (forward-only assumption).
#     Если миграция несовместима с откатываемым кодом — restore из бэкапа.
#     См. docs/runbook.md §"Backup setup".

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <git-tag-or-sha>" >&2
  exit 2
fi

TARGET="$1"
REPO_DIR="${PT_REPO_DIR:-/home/deploy/pitchterminal}"

if [[ ! -d "${REPO_DIR}/.git" ]]; then
  echo "FATAL: ${REPO_DIR} is not a git repo" >&2
  exit 2
fi

cd "${REPO_DIR}"

echo "[rollback] Fetching origin..."
git fetch origin --tags --prune

echo "[rollback] Checking out ${TARGET}..."
# detached HEAD ok — мы откатываемся, не разрабатываем.
git checkout --force "${TARGET}"

cd infra

echo "[rollback] Rebuilding and restarting stack..."
# Используем те же 2 compose-файла, что и при штатном деплое.
# --env-file ../.env — относительно infra/.
# --remove-orphans: критично для rollback — старый compose может не знать про
# сервисы, добавленные в более новой ревизии (которая сейчас откатывается).
# Без флага orphan-контейнеры продолжат работать и состояние стека разъедется.
docker compose --env-file ../.env \
  -f docker-compose.yml -f docker-compose.prod.yml up -d --build --remove-orphans

echo "[rollback] Waiting 30s for services to settle..."
sleep 30

echo "[rollback] Running health check..."
if docker exec pt-api curl -fsS --max-time 5 http://localhost:8000/api/v1/health > /dev/null; then
  echo "[rollback] Health check passed. Rollback to ${TARGET} successful."
  exit 0
else
  echo "[rollback] Health check FAILED after rollback to ${TARGET}." >&2
  echo "[rollback] Manual intervention required. Check: docker compose logs api" >&2
  exit 1
fi
