#!/usr/bin/env bash
# Поднимает локальный dev-стэк.
#
# Без аргументов — поднимает только Postgres (минимальная конфигурация).
# С --full — поднимает Postgres + api + worker + caddy (полный стэк).
#
# Запускать можно из любой директории — пути резолвятся от расположения скрипта.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_DIR="${ROOT_DIR}/infra"

COMPOSE_FILES=(-f "${INFRA_DIR}/docker-compose.yml" -f "${INFRA_DIR}/docker-compose.override.yml")

# .env в корне репо — единственный источник env-vars (компоуз сам подхватит
# через --env-file). Если .env нет, compose использует только дефолты из yml.
ENV_FILE_ARGS=()
if [[ -f "${ROOT_DIR}/.env" ]]; then
  ENV_FILE_ARGS=(--env-file "${ROOT_DIR}/.env")
fi

FULL=0
for arg in "$@"; do
  case "${arg}" in
    --full)
      FULL=1
      ;;
    -h|--help)
      cat <<EOF
Usage: $(basename "$0") [--full]

  (no args)   Поднять только postgres (минимум для backend-тестов)
  --full      Поднять весь стэк: postgres + api + worker + caddy
EOF
      exit 0
      ;;
    *)
      echo "!!! unknown arg: ${arg}" >&2
      exit 2
      ;;
  esac
done

if [[ "${FULL}" -eq 1 ]]; then
  SERVICES=(postgres api worker caddy)
else
  SERVICES=(postgres)
fi

echo ">>> docker compose up -d ${SERVICES[*]}"
docker compose "${ENV_FILE_ARGS[@]}" "${COMPOSE_FILES[@]}" up -d "${SERVICES[@]}"

CONTAINER="pt-postgres"

echo ">>> waiting for ${CONTAINER} to become healthy..."
DEADLINE=$(( $(date +%s) + 60 ))
while true; do
  STATUS="$(docker inspect -f '{{.State.Health.Status}}' "${CONTAINER}" 2>/dev/null || echo "missing")"
  case "${STATUS}" in
    healthy)
      echo ">>> ${CONTAINER} is healthy"
      break
      ;;
    starting)
      ;;
    unhealthy|missing|"")
      if [[ $(date +%s) -ge ${DEADLINE} ]]; then
        echo "!!! ${CONTAINER} did not become healthy in time (status=${STATUS})" >&2
        docker logs --tail=50 "${CONTAINER}" >&2 || true
        exit 1
      fi
      ;;
    *)
      ;;
  esac
  if [[ $(date +%s) -ge ${DEADLINE} ]]; then
    echo "!!! timeout waiting for healthy (last status=${STATUS})" >&2
    docker logs --tail=50 "${CONTAINER}" >&2 || true
    exit 1
  fi
  sleep 2
done

echo ">>> postgres is up. Connect with:"
echo "    psql postgresql://pt:pt@localhost:${PT_PG_HOST_PORT:-5432}/pt"
echo "    # или: docker exec -it ${CONTAINER} psql -U pt -d pt"

if [[ "${FULL}" -eq 1 ]]; then
  echo ">>> full stack is up. URLs:"
  echo "    Caddy:   http://localhost:${PT_CADDY_HTTP_PORT:-80}/"
  echo "    API:     http://localhost:${PT_API_HOST_PORT:-8000}/api/v1/health"
  echo "    API via Caddy: http://localhost:${PT_CADDY_HTTP_PORT:-80}/api/v1/health"
fi
