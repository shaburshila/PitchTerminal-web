#!/usr/bin/env bash
# scripts/backup.sh — nightly off-site Postgres backup для PitchTerminal-web.
#
# Запуск: cron на VPS, 03:00 UTC ежедневно. Пример crontab:
#
#   0 3 * * * /home/deploy/pitchterminal/scripts/backup.sh \
#     >> /var/log/pitchterminal-backup.log 2>&1
#
# Что делает:
#   1. pg_dump (custom format) из контейнера pt-postgres в /var/backups/pt/.
#   2. Всегда загружает дамп в `daily/` на Backblaze B2 (S3-совместимый endpoint).
#   3. Дополнительно делает server-side copy в `weekly/` (воскресенье) и
#      `monthly/` (1-е число) — каждый дамп всегда попадает в daily/, а
#      weekly/monthly — это дубликаты с другим retention.
#        daily/   — каждый день (lifecycle rule: delete после 7 дней).
#        weekly/  — копия в воскресенье (lifecycle: delete после 28 дней).
#        monthly/ — копия 1-го числа месяца (lifecycle: delete после 90 дней).
#      Lifecycle policies настраиваются один раз в B2 web-console
#      (см. docs/runbook.md §"Backup setup").
#   4. Локальный дамп удаляется ТОЛЬКО после подтверждённого успешного upload
#      всех применимых тиров. При fail — файл оставляется для ручного retry,
#      путь логируется (см. подсказку в stderr).
#   5. set -e + non-zero exit → cron-mail оператору. (Telegram-алерт — фаза 3.)
#
# Выбор провайдера: Backblaze B2 — самый дешёвый ($0.005/GB/мес), S3-совместимый
# API (используем aws-cli, без специфичных b2 SDK). Альтернативы R2/S3 работают
# тем же скриптом с заменой endpoint URL.
#
# Required env vars (грузятся из ~/.pt-backup.env, perm 600):
#   B2_KEY_ID         — Application Key ID
#   B2_APP_KEY        — Application Key (secret)
#   B2_BUCKET         — bucket name, например "pt-backups"
#   B2_ENDPOINT       — endpoint URL, например https://s3.us-west-004.backblazeb2.com
#                       (берётся в B2 console → bucket → endpoint)
# Optional:
#   PT_POSTGRES_CONTAINER (default: pt-postgres)
#   PT_PG_USER (default: pt)
#   PT_PG_DB   (default: pt)

set -euo pipefail

# ─── Load credentials ────────────────────────────────────────────────────────
# Хранятся отдельно от .env приложения, чтобы:
#   а) backup мог работать даже если .env приложения сломан;
#   б) можно дать backup-юзеру минимальные права (read-only к app .env).
BACKUP_ENV="${BACKUP_ENV:-/home/deploy/.pt-backup.env}"
if [[ -f "${BACKUP_ENV}" ]]; then
  # shellcheck disable=SC1090
  source "${BACKUP_ENV}"
fi

: "${B2_KEY_ID:?B2_KEY_ID is required (set in ${BACKUP_ENV})}"
: "${B2_APP_KEY:?B2_APP_KEY is required}"
: "${B2_BUCKET:?B2_BUCKET is required}"
: "${B2_ENDPOINT:?B2_ENDPOINT is required (e.g. https://s3.us-west-004.backblazeb2.com)}"

POSTGRES_CONTAINER="${PT_POSTGRES_CONTAINER:-pt-postgres}"
PG_USER="${PT_PG_USER:-pt}"
PG_DB="${PT_PG_DB:-pt}"

TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
# Дампы храним в /var/backups/pt/ (стабильное место, не очищается reboot'ом,
# не /tmp). Каталог должен существовать и быть writable для backup-юзера —
# см. docs/runbook.md §14 (sudo install -d -o deploy -g deploy -m 0750 ...).
DUMP_DIR="${PT_DUMP_DIR:-/var/backups/pt}"
DUMP_NAME="pt-${TIMESTAMP}.dump"
DUMP_FILE="${DUMP_DIR}/${DUMP_NAME}"

mkdir -p "${DUMP_DIR}"

log() {
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] [backup] $*"
}

# NB: НЕТ trap cleanup EXIT. При upload-fail дамп ОСТАЁТСЯ на диске —
# это сознательное решение, чтобы можно было сделать ручной retry без
# повторного pg_dump (мог быть дорогой по нагрузке). При success локальный
# файл удаляется явно в самом конце скрипта.

# ─── 1. pg_dump ──────────────────────────────────────────────────────────────
log "Starting pg_dump for ${PG_DB} from container ${POSTGRES_CONTAINER}"
docker exec "${POSTGRES_CONTAINER}" \
  pg_dump -U "${PG_USER}" -d "${PG_DB}" --format=custom --compress=9 \
  > "${DUMP_FILE}"

DUMP_SIZE="$(stat -c%s "${DUMP_FILE}")"
log "Dump created: ${DUMP_FILE} (${DUMP_SIZE} bytes)"

if [[ "${DUMP_SIZE}" -lt 1024 ]]; then
  log "ERROR: dump suspiciously small (${DUMP_SIZE} bytes), aborting upload"
  log "Dump preserved at ${DUMP_FILE} for manual inspection"
  exit 1
fi

# ─── 2. Определяем доп. тиры (weekly/monthly) ────────────────────────────────
# Day-of-week: 0=Sunday, day-of-month: 01..31.
# КАЖДЫЙ запуск пишет в daily/. Воскресенье ДОПОЛНИТЕЛЬНО копирует в weekly/,
# 1-е число ДОПОЛНИТЕЛЬНО — в monthly/. Это даёт ровно ту retention-структуру,
# что описана в plans/infra.md §I0.7 (7 daily + 4 weekly + 3 monthly при
# соответствующих lifecycle rules на bucket).
DOW="$(date -u +%w)"
DOM="$(date -u +%d)"

DAILY_KEY="daily/${DUMP_NAME}"
WEEKLY_KEY="weekly/${DUMP_NAME}"
MONTHLY_KEY="monthly/${DUMP_NAME}"

# ─── 3. Upload via aws-cli (S3-compatible) ───────────────────────────────────
# aws-cli должен быть установлен на VPS (`apt install awscli` или pipx).
# Креды передаём через env vars — не пишем их в ~/.aws/credentials, чтобы
# backup-cred'ы жили только в одном файле (${BACKUP_ENV}).
#
# Helper: server-side copy (одинаковые креды/endpoint).
aws_s3() {
  AWS_ACCESS_KEY_ID="${B2_KEY_ID}" \
  AWS_SECRET_ACCESS_KEY="${B2_APP_KEY}" \
  AWS_DEFAULT_REGION="us-east-1" \
  aws --endpoint-url "${B2_ENDPOINT}" "$@"
}

log "Uploading to s3://${B2_BUCKET}/${DAILY_KEY}"
if ! aws_s3 s3 cp "${DUMP_FILE}" "s3://${B2_BUCKET}/${DAILY_KEY}"; then
  log "ERROR: upload to daily/ failed"
  log "Dump preserved at ${DUMP_FILE} — retry: AWS_ACCESS_KEY_ID=\$B2_KEY_ID AWS_SECRET_ACCESS_KEY=\$B2_APP_KEY aws --endpoint-url \$B2_ENDPOINT s3 cp ${DUMP_FILE} s3://${B2_BUCKET}/${DAILY_KEY}"
  exit 1
fi
log "Upload successful: s3://${B2_BUCKET}/${DAILY_KEY}"

# Server-side copy (без повторного upload) для weekly/monthly.
if [[ "${DOM}" == "01" ]]; then
  log "1st of month — copying to s3://${B2_BUCKET}/${MONTHLY_KEY}"
  if ! aws_s3 s3 cp "s3://${B2_BUCKET}/${DAILY_KEY}" "s3://${B2_BUCKET}/${MONTHLY_KEY}"; then
    log "ERROR: server-side copy to monthly/ failed"
    log "Dump preserved at ${DUMP_FILE}. Retry just the monthly copy: AWS_ACCESS_KEY_ID=\$B2_KEY_ID AWS_SECRET_ACCESS_KEY=\$B2_APP_KEY aws --endpoint-url \$B2_ENDPOINT s3 cp s3://${B2_BUCKET}/${DAILY_KEY} s3://${B2_BUCKET}/${MONTHLY_KEY}"
    exit 1
  fi
  log "Copy successful: s3://${B2_BUCKET}/${MONTHLY_KEY}"
fi

if [[ "${DOW}" == "0" ]]; then
  log "Sunday — copying to s3://${B2_BUCKET}/${WEEKLY_KEY}"
  if ! aws_s3 s3 cp "s3://${B2_BUCKET}/${DAILY_KEY}" "s3://${B2_BUCKET}/${WEEKLY_KEY}"; then
    log "ERROR: server-side copy to weekly/ failed"
    log "Dump preserved at ${DUMP_FILE}. Retry just the weekly copy: AWS_ACCESS_KEY_ID=\$B2_KEY_ID AWS_SECRET_ACCESS_KEY=\$B2_APP_KEY aws --endpoint-url \$B2_ENDPOINT s3 cp s3://${B2_BUCKET}/${DAILY_KEY} s3://${B2_BUCKET}/${WEEKLY_KEY}"
    exit 1
  fi
  log "Copy successful: s3://${B2_BUCKET}/${WEEKLY_KEY}"
fi

# ─── 4. Cleanup ──────────────────────────────────────────────────────────────
# Всё подтверждено — можно убрать локальный дамп.
rm -f "${DUMP_FILE}"
log "Cleaned up local dump ${DUMP_FILE}"
log "Backup complete."
