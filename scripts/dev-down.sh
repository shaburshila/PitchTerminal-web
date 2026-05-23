#!/usr/bin/env bash
# Останавливает локальный dev-стэк.
#
# По умолчанию данные Postgres сохраняются (volume не трогаем).
# Флаг --purge (или -v / --volumes) удаляет volume `pt_pgdata` — нужно
# полностью пересоздать схему с нуля.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_DIR="${ROOT_DIR}/infra"

COMPOSE_FILES=(-f "${INFRA_DIR}/docker-compose.yml" -f "${INFRA_DIR}/docker-compose.override.yml")

ENV_FILE_ARGS=()
if [[ -f "${ROOT_DIR}/.env" ]]; then
  ENV_FILE_ARGS=(--env-file "${ROOT_DIR}/.env")
fi

PURGE=0
for arg in "$@"; do
  case "${arg}" in
    --purge|-v|--volumes)
      PURGE=1
      ;;
    -h|--help)
      cat <<EOF
Usage: $(basename "$0") [--purge|-v|--volumes]

  (no args)            stop containers, keep volume (pt_pgdata)
  --purge / -v         stop containers AND remove pt_pgdata volume (DATA LOSS)
EOF
      exit 0
      ;;
    *)
      echo "!!! unknown arg: ${arg}" >&2
      exit 2
      ;;
  esac
done

if [[ "${PURGE}" -eq 1 ]]; then
  echo ">>> docker compose down -v  (WIPING pt_pgdata)"
  docker compose "${ENV_FILE_ARGS[@]}" "${COMPOSE_FILES[@]}" down -v
else
  echo ">>> docker compose down  (preserving pt_pgdata)"
  docker compose "${ENV_FILE_ARGS[@]}" "${COMPOSE_FILES[@]}" down
fi
