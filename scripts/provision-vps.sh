#!/usr/bin/env bash
#
# PitchTerminal-web — one-shot VPS provisioning.
#
# Цель: за один заход на свежем Debian/Ubuntu VPS (Hetzner CX22 или аналог)
# получить hardened-машину, готовую к `git clone` + `docker compose up -d`.
#
# Что делает:
#   1) apt-update + базовые утилиты.
#   2) Установка Docker Engine + docker-compose-plugin (официальный apt-repo).
#   3) Создание non-root пользователя 'deploy', добавление в docker-группу.
#   4) Раскладка SSH-ключа в /home/deploy/.ssh/authorized_keys + ограниченный
#      passwordless sudo (fail2ban-client, reboot, ufw) для диагностики.
#   5) ufw: deny incoming, allow 2222/tcp, 80/tcp, 443/tcp, 443/udp.
#      Открываем порт ПЕРЕД переключением sshd — иначе fresh enable ufw
#      на уже работающем :2222 не успеет добавить правило и порвёт сессию.
#   6) fail2ban + sshd jail (port 2222 уже разрешён в ufw — jail сразу защищает).
#   7) SSH-hardening: port 2222, password-auth off, root-login off, MaxAuthTries 3.
#      ВАЖНО: НЕ перезапускаем sshd, пока не проверили, что deploy-ключ
#      работает на новом порту. По умолчанию скрипт ВКЛЮЧАЕТ hardening
#      (cм. SSHD_APPLY=1 ниже). При SSHD_APPLY=0 hardening пишется в
#      /etc/ssh/sshd_config.d/99-pitchterminal.conf, но не активируется —
#      runbook предлагает сначала зайти на 2222 параллельной сессией.
#
# Запуск (на VPS, под root или через sudo):
#
#   SSH_PUBKEY="ssh-ed25519 AAAA... user@host" \
#   bash provision-vps.sh
#
# Опциональные env:
#   SSH_PORT          (default: 2222)
#   DEPLOY_USER       (default: deploy)
#   SSHD_APPLY        (default: 1 — применить hardening сразу; 0 — только подготовить)
#   SKIP_DOCKER       (default: 0)
#   SKIP_UFW          (default: 0)
#   SKIP_FAIL2BAN     (default: 0)
#
# Идемпотентность: повторный запуск безопасен — каждый шаг проверяет, не
# выполнен ли он уже (getent passwd, docker --version, ufw status и т.п.).

set -euo pipefail

# ── Параметры (env с дефолтами) ─────────────────────────────────────────────
SSH_PORT="${SSH_PORT:-2222}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
SSHD_APPLY="${SSHD_APPLY:-1}"
SKIP_DOCKER="${SKIP_DOCKER:-0}"
SKIP_UFW="${SKIP_UFW:-0}"
SKIP_FAIL2BAN="${SKIP_FAIL2BAN:-0}"
SSH_PUBKEY="${SSH_PUBKEY:-}"

# ── Утилиты логирования ─────────────────────────────────────────────────────
log()  { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '\033[1;33m[%s] WARN:\033[0m %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die()  { printf '\033[1;31m[%s] ERROR:\033[0m %s\n' "$(date +%H:%M:%S)" "$*" >&2; exit 1; }

# ── Pre-flight ──────────────────────────────────────────────────────────────
if [[ "$(id -u)" -ne 0 ]]; then
  die "Запускать под root (или 'sudo bash provision-vps.sh')."
fi

if [[ -z "${SSH_PUBKEY}" ]]; then
  die "SSH_PUBKEY не задан. Пример: SSH_PUBKEY=\"\$(cat ~/.ssh/id_ed25519.pub)\" bash provision-vps.sh"
fi

# Грубая валидация формата ключа (ssh-ed25519 / ssh-rsa / ecdsa-* / sk-*).
if ! [[ "${SSH_PUBKEY}" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\ [A-Za-z0-9+/=]+ ]]; then
  die "SSH_PUBKEY не похож на валидный публичный ключ (ожидается 'ssh-ed25519 AAAA...' и т.п.)."
fi

if ! command -v apt-get >/dev/null 2>&1; then
  die "Скрипт рассчитан на Debian/Ubuntu (apt-based). Текущая ОС не поддерживается."
fi

# Определяем дистрибутив для docker apt-repo.
. /etc/os-release
case "${ID:-}" in
  debian|ubuntu) ;;
  *) die "Неподдерживаемая ОС: ID=${ID:-unknown}. Ожидается debian|ubuntu." ;;
esac
DISTRO_ID="${ID}"
DISTRO_CODENAME="${VERSION_CODENAME:-}"
if [[ -z "${DISTRO_CODENAME}" ]]; then
  die "Не удалось определить VERSION_CODENAME из /etc/os-release."
fi

log "Старт provisioning: ${DISTRO_ID}/${DISTRO_CODENAME}, user=${DEPLOY_USER}, ssh_port=${SSH_PORT}"

# ── Шаг 1: apt update + базовые пакеты ──────────────────────────────────────
log "[1/7] apt-get update + базовые утилиты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl gnupg lsb-release \
  ufw fail2ban \
  vim less git jq htop \
  unattended-upgrades

# Авто-обновления безопасности (минимум — Debian/Ubuntu unattended-upgrades).
# Включаем дефолтный конфиг (security-only). Достаточно для solo-VPS.
log "    включаем unattended-upgrades (security-only)"
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

# Фиксируем Automatic-Reboot=false независимо от base-образа (на некоторых
# образах Hetzner дефолт включён, что приведёт к неожиданным ребутам при
# kernel update). Этот drop-in переопределяет любые пакетные дефолты.
cat > /etc/apt/apt.conf.d/99-pitchterminal-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
Unattended-Upgrade::Automatic-Reboot "false";
EOF
chmod 0644 /etc/apt/apt.conf.d/99-pitchterminal-upgrades

# ── Шаг 2: Docker Engine + compose-plugin ───────────────────────────────────
if [[ "${SKIP_DOCKER}" == "1" ]]; then
  warn "SKIP_DOCKER=1 — пропускаем установку Docker"
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  log "[2/7] Docker уже установлен: $(docker --version), $(docker compose version --short)"
else
  log "[2/7] устанавливаем Docker Engine + docker-compose-plugin (apt-repo docker.com)"
  install -m 0755 -d /etc/apt/keyrings
  if [[ ! -s /etc/apt/keyrings/docker.gpg ]]; then
    curl -fsSL "https://download.docker.com/linux/${DISTRO_ID}/gpg" | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
  fi
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${DISTRO_ID} ${DISTRO_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  log "    docker: $(docker --version)"
  log "    compose: $(docker compose version --short)"
fi

# ── Шаг 3: пользователь deploy ──────────────────────────────────────────────
log "[3/7] non-root пользователь '${DEPLOY_USER}'"
if getent passwd "${DEPLOY_USER}" >/dev/null; then
  log "    пользователь ${DEPLOY_USER} уже существует"
else
  useradd --create-home --shell /bin/bash "${DEPLOY_USER}"
  log "    создан пользователь ${DEPLOY_USER}"
fi

# Гарантируем членство в docker (даже если пользователь уже был, но без группы).
if getent group docker >/dev/null; then
  if ! id -nG "${DEPLOY_USER}" | tr ' ' '\n' | grep -qx docker; then
    usermod -aG docker "${DEPLOY_USER}"
    log "    добавлен в группу docker"
  fi
else
  warn "    группы docker нет — Docker, видимо, не установлен (SKIP_DOCKER?)"
fi

# ── Шаг 4: SSH-ключ ─────────────────────────────────────────────────────────
log "[4/7] раскладка SSH-ключа в /home/${DEPLOY_USER}/.ssh/authorized_keys"
DEPLOY_HOME="/home/${DEPLOY_USER}"
SSH_DIR="${DEPLOY_HOME}/.ssh"
AUTH_KEYS="${SSH_DIR}/authorized_keys"
install -d -m 0700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "${SSH_DIR}"
# Идемпотентно: добавляем ключ только если ещё нет в файле.
touch "${AUTH_KEYS}"
chown "${DEPLOY_USER}:${DEPLOY_USER}" "${AUTH_KEYS}"
chmod 0600 "${AUTH_KEYS}"
if ! grep -qxF "${SSH_PUBKEY}" "${AUTH_KEYS}"; then
  printf '%s\n' "${SSH_PUBKEY}" >> "${AUTH_KEYS}"
  log "    ключ добавлен"
else
  log "    ключ уже в authorized_keys — пропускаем"
fi

# Ограниченный passwordless sudo для deploy: нужен для runbook-диагностики
# (sudo fail2ban-client status sshd, sudo ufw status, sudo reboot). Полный
# sudo НЕ даём — приватный ключ + один из этих бинарей и так покрывают
# реальные сценарии оператора.
log "    sudoers drop-in: ${DEPLOY_USER} → fail2ban-client, reboot, ufw (NOPASSWD)"
SUDOERS_FILE="/etc/sudoers.d/deploy-pitchterminal"
cat > "${SUDOERS_FILE}" <<EOF
# Managed by scripts/provision-vps.sh — не редактировать вручную.
${DEPLOY_USER} ALL=(ALL) NOPASSWD: /usr/bin/fail2ban-client, /sbin/reboot, /usr/sbin/ufw
EOF
chmod 0440 "${SUDOERS_FILE}"
# visudo -c проверяет валидность всех файлов в /etc/sudoers.d/.
if ! visudo -c -q; then
  rm -f "${SUDOERS_FILE}"
  die "visudo -c упал — sudoers drop-in невалиден, откатили ${SUDOERS_FILE}."
fi

# ── Шаг 5: ufw ──────────────────────────────────────────────────────────────
# ВАЖНО: ufw ДОЛЖЕН быть настроен ДО fail2ban и ДО reload sshd на :2222.
# Иначе при reload sshd начинает слушать :2222, а ufw enable на следующем
# шаге временно не имеет правила для :2222 (если повторный запуск).
# Порядок: открыть порт → защитить fail2ban'ом → переключить sshd.
if [[ "${SKIP_UFW}" == "1" ]]; then
  warn "SKIP_UFW=1 — пропускаем"
else
  log "[5/7] ufw: deny incoming, allow ${SSH_PORT}/tcp + 80/tcp + 443/tcp + 443/udp"
  # НЕ делаем `ufw --force reset` — он сбрасывает существующие правила и
  # fail2ban-цепочки, создавая окно без файервола на live-машине.
  # `ufw allow` идемпотентен — повторное добавление того же правила не
  # дублирует его, поэтому скрипт можно безопасно перезапускать.
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow "${SSH_PORT}"/tcp comment 'ssh (hardened)' >/dev/null 2>&1 || true
  ufw allow 80/tcp  comment 'http (Caddy / Let'\''s Encrypt http-01)' >/dev/null 2>&1 || true
  ufw allow 443/tcp comment 'https (Caddy)' >/dev/null 2>&1 || true
  ufw allow 443/udp comment 'https (HTTP/3 QUIC)' >/dev/null 2>&1 || true
  ufw --force enable
  ufw status verbose
fi

# ── Шаг 6: fail2ban ─────────────────────────────────────────────────────────
if [[ "${SKIP_FAIL2BAN}" == "1" ]]; then
  warn "SKIP_FAIL2BAN=1 — пропускаем"
else
  log "[6/7] fail2ban: enable sshd jail (port=${SSH_PORT})"
  # jail.local переопределяет дефолтный jail.conf — стандартная практика.
  # backend=auto: fail2ban сам выбирает доступный (systemd → polling fallback).
  # systemd-backend требует journald парсера sshd-логов, что на minimal
  # Debian/Ubuntu может отсутствовать; auto страхует от пустого jail.
  # filter=sshd явно указан, т.к. mode=aggressive ссылается на
  # sshd-aggressive.conf, который наследуется от sshd-фильтра.
  cat > /etc/fail2ban/jail.local <<EOF
# Managed by scripts/provision-vps.sh
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = auto

[sshd]
enabled = true
port    = ${SSH_PORT}
filter  = sshd
mode    = aggressive
EOF
  systemctl enable --now fail2ban
  systemctl restart fail2ban
  sleep 1
  if fail2ban-client status sshd >/dev/null 2>&1; then
    log "    fail2ban sshd jail активен"
  else
    warn "    fail2ban-client status sshd не отвечает; проверь 'journalctl -u fail2ban'"
  fi
fi

# ── Шаг 7: SSH-hardening ────────────────────────────────────────────────────
# Делаем последним: ufw уже разрешил :2222, fail2ban уже его защищает.
log "[7/7] SSH-hardening (port=${SSH_PORT}, password-auth=off, root-login=no)"
SSHD_DROPIN="/etc/ssh/sshd_config.d/99-pitchterminal.conf"
cat > "${SSHD_DROPIN}" <<EOF
# Managed by scripts/provision-vps.sh — не редактировать вручную.
Port ${SSH_PORT}
PasswordAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no
UsePAM yes
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
PermitEmptyPasswords no
ClientAliveInterval 300
ClientAliveCountMax 2
EOF
chmod 0644 "${SSHD_DROPIN}"

# Валидация конфига до перезапуска.
if ! sshd -t; then
  die "sshd -t упал на новом конфиге ${SSHD_DROPIN}. Останавливаемся, чтобы не потерять доступ."
fi

if [[ "${SSHD_APPLY}" == "1" ]]; then
  log "    sshd -t OK, reload sshd"
  # systemctl reload — мягко, существующие сессии не рвутся.
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
  log "    SSH теперь слушает порт ${SSH_PORT}. ВАЖНО: проверь параллельной сессией ДО выхода из root!"
else
  warn "    SSHD_APPLY=0 — конфиг написан в ${SSHD_DROPIN}, но sshd НЕ перезагружен."
  warn "    Чтобы применить позже:  sshd -t && systemctl reload ssh"
fi

# ── Финальная сводка ────────────────────────────────────────────────────────
cat <<EOF

============================================================
 provision-vps.sh — DONE
============================================================
 user        : ${DEPLOY_USER}
 ssh port    : ${SSH_PORT}   (sshd_applied=${SSHD_APPLY})
 docker      : $(command -v docker >/dev/null && docker --version || echo 'not installed')
 fail2ban    : $(systemctl is-active fail2ban 2>/dev/null || echo 'inactive')
 ufw         : $(ufw status | head -1)

 Следующие шаги (см. docs/runbook.md §4 и далее):
   1) Откой ПАРАЛЛЕЛЬНУЮ сессию: ssh -p ${SSH_PORT} ${DEPLOY_USER}@<host>
      (проверь ДО того, как выйдешь из текущей root-сессии — это страховка).
   2) git clone … /home/${DEPLOY_USER}/pitchterminal
   3) Заполни .env (см. .env.example + docs/conventions.md §9), chmod 600.
   4) cd infra && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
============================================================
EOF
