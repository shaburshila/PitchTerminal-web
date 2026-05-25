# PitchTerminal-web — Runbook (VPS deploy)

Пошаговый сценарий: от пустого Hetzner VPS до запущенного `docker compose ps`.

**Целевое время:** < 15 минут (плюс 5–10 на DNS-propagation и Let's Encrypt).

> **Соглашения**
> - `${DOMAIN}` — твой домен (например `pitchterminal.app`). Заменяй везде по тексту.
> - `${VPS_IP}` — публичный IPv4 свежего VPS.
> - `${SSH_PORT}` — `2222` по умолчанию (см. `scripts/provision-vps.sh`).
> - `${DEPLOY_USER}` — `deploy` по умолчанию.
> - Все команды, начинающиеся с `#`, выполняются под root; с `$` — под `deploy`.

---

## 1. Заказ VPS (Hetzner CX22 или аналог)

1. <https://console.hetzner.cloud> → New Server.
2. **Location:** Nuremberg / Falkenstein / Helsinki (любая EU — задержки до Base RPC незначительны).
3. **Image:** Ubuntu 24.04 LTS (или Debian 12 — оба поддерживаются скриптом).
4. **Type:** CX22 (2 vCPU, 4 GB RAM, 40 GB SSD) — minimum для Postgres + Backend + Caddy.
5. **SSH key:** добавь твой публичный ключ (`~/.ssh/id_ed25519.pub`) в раздел «SSH keys» и выбери его. Это даст root-доступ без пароля на дефолтном 22-порту.
6. **Networking:** IPv4 включён (обязательно), IPv6 — опционально.
7. Создаём. Получаем `${VPS_IP}`.

> Альтернативы: Vultr / DigitalOcean / Scaleway — провизион-скрипт работает на любом Debian/Ubuntu LTS.

---

## 2. DNS A-record

В DNS-панели регистратора (или Cloudflare):

```
${DOMAIN}      A   ${VPS_IP}    TTL 300
www.${DOMAIN}  A   ${VPS_IP}    TTL 300   # опционально
```

> Cloudflare proxy (orange cloud) — **выключить**. Caddy сам делает Let's Encrypt по http-01 — proxy с MITM-сертификатом сломает выдачу.

Проверка с локальной машины:

```bash
dig +short ${DOMAIN}    # должен вернуть ${VPS_IP}
```

---

## 3. Первое подключение (root, порт 22)

```bash
ssh root@${VPS_IP}
```

Если пускает без пароля — SSH-ключ прокинут корректно. На root-сессии ничего не правим вручную — следующий шаг всё сделает.

---

## 4. Provisioning одной командой

Скопируй на VPS либо весь репо (быстрее всего `git clone` от root в `/tmp`), либо только скрипт:

```bash
# Вариант A: scp одного файла со своей машины
scp scripts/provision-vps.sh root@${VPS_IP}:/root/

# Вариант B: clone репо во временный каталог (нужен публичный доступ к репо)
ssh root@${VPS_IP} 'git clone https://github.com/<you>/PitchTerminal-web /tmp/pt && cp /tmp/pt/scripts/provision-vps.sh /root/'
```

Запусти **на VPS** (под root, ещё в сессии на порту 22):

```bash
# Подставь свой публичный SSH-ключ (тот же, что в Hetzner — или другой)
export SSH_PUBKEY="$(cat ~/.ssh/id_ed25519.pub)"

# Если хочешь сначала подготовить hardening, но НЕ применять (страховка):
#   SSHD_APPLY=0 bash /root/provision-vps.sh
# По умолчанию SSHD_APPLY=1 — sshd сразу переезжает на :2222.

SSH_PUBKEY="${SSH_PUBKEY}" bash /root/provision-vps.sh
```

Скрипт делает (~3–5 минут):
1. `apt update` + базовые утилиты + `unattended-upgrades` (с явно выключенным
   `Automatic-Reboot` через drop-in `/etc/apt/apt.conf.d/99-pitchterminal-upgrades`).
2. Docker Engine + `docker-compose-plugin` (apt-repo `download.docker.com`).
3. Создаёт пользователя `deploy`, кладёт ключ в `~deploy/.ssh/authorized_keys`,
   sudoers drop-in `/etc/sudoers.d/deploy-pitchterminal` (passwordless sudo
   только на `fail2ban-client`, `reboot`, `ufw`).
4. `ufw`: deny incoming, allow `2222/tcp`, `80/tcp`, `443/tcp`, `443/udp`
   (идемпотентно, без `--force reset` — не сбрасываем существующие правила
   при повторном запуске).
5. `fail2ban` + sshd jail (`backend=auto`, mode aggressive, ban 1h после 5
   неудач за 10 мин).
6. Hardening sshd в `/etc/ssh/sshd_config.d/99-pitchterminal.conf`:
   `Port 2222`, `PasswordAuthentication no`, `PermitRootLogin no`,
   `PubkeyAuthentication yes`, `MaxAuthTries 3`. Делается **последним** —
   ufw уже открыл порт, fail2ban уже его защищает.

В конце выводит сводку.

---

## 5. Проверка нового SSH (страховка — НЕ закрывай root-сессию!)

В **новом терминале** локально:

```bash
ssh -p 2222 deploy@${VPS_IP} 'whoami && docker --version'
# Ожидаем: "deploy" + docker version.
```

Если работает — root-сессия больше не нужна, можешь её закрыть.

**Если НЕ работает** (Permission denied / connection refused):
- Проверь, что в `~/.ssh/authorized_keys` на VPS реально лежит твой ключ:
  `ssh root@${VPS_IP} 'cat /home/deploy/.ssh/authorized_keys'` (если root-сессия ещё жива).
- Проверь, что sshd слушает 2222: `ssh root@${VPS_IP} 'ss -ltnp | grep ssh'`.
- В крайнем случае — откатить hardening из root-сессии: удалить `/etc/ssh/sshd_config.d/99-pitchterminal.conf` + `systemctl reload ssh`.

---

## 6. Клонирование репо как `deploy`

```bash
$ ssh -p 2222 deploy@${VPS_IP}
$ git clone https://github.com/<you>/PitchTerminal-web ~/pitchterminal
$ cd ~/pitchterminal
```

Если репо приватный — настроить deploy key:

```bash
$ ssh-keygen -t ed25519 -C "deploy@${DOMAIN}" -f ~/.ssh/id_ed25519 -N ""
$ cat ~/.ssh/id_ed25519.pub
# Скопируй в GitHub: Repo → Settings → Deploy keys → Add deploy key (read-only).
$ git clone git@github.com:<you>/PitchTerminal-web ~/pitchterminal
```

Или временно — PAT через HTTPS. Для MVP можно использовать публичный mirror.

---

## 7. Заполнение `.env`

```bash
$ cp .env.example .env
$ chmod 600 .env
$ ls -la .env
# -rw------- 1 deploy deploy ... .env
$ vim .env
```

**Минимум для прода** (см. `docs/conventions.md` §9 — полный список):

| Переменная | Заполнить чем |
|---|---|
| `POSTGRES_PASSWORD` | `openssl rand -hex 16` |
| `DATABASE_URL` | `postgresql://pt:<password>@postgres:5432/pt` (host=`postgres`!) |
| `JWT_SECRET` | `openssl rand -hex 32` |
| `RPC_URL` | твой Alchemy / public Base RPC |
| `KEEPER_PRIVATE_KEY` | газ-кошелёк (отдельный, не main!) — заполнится в фазе 2 |
| `ACCESS_CONTRACT` | `0xA4c416986a1eE95c0c6ECD66aB77DfDA61803527` (mainnet, см. MEMORY) |
| `OPERATOR_TG_BOT_TOKEN`, `OPERATOR_TG_CHAT_ID` | для алертов (опционально на старте) |
| `WALLETCONNECT_PROJECT_ID` | <https://cloud.walletconnect.com> |
| `SIWE_DOMAIN`, `SIWE_URI` | `${DOMAIN}` и `https://${DOMAIN}` |
| `DOMAIN` | твой домен (нужен compose.prod для Caddy) |
| `ACME_EMAIL` | твой email (Let's Encrypt expiry-нотификации) |

> Никогда не коммить `.env`. Он в `.gitignore`, но привычка важнее.

После заполнения `.env` создай симлинк `infra/.env -> ../.env` (требуется для compose substitution — см. §9.5 для подробностей):

```bash
$ cd ~/pitchterminal
$ bash infra/scripts/setup-env-symlink.sh
```

---

## 8. Старт стека

```bash
$ cd ~/pitchterminal/infra
$ docker compose --env-file ../.env -f docker-compose.yml -f docker-compose.prod.yml pull
$ docker compose --env-file ../.env -f docker-compose.yml -f docker-compose.prod.yml up -d
```

> **Важно:** на проде НЕ передавай `-f docker-compose.override.yml` — он публикует postgres/api на 127.0.0.1, что в проде бесполезно. `prod.yml` сам публикует только 80/443 на Caddy.

Подожди 30–60 секунд (миграции БД, Let's Encrypt cert):

```bash
$ docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
# все сервисы: STATE=running, postgres/api: HEALTH=healthy
$ docker compose -f docker-compose.yml -f docker-compose.prod.yml logs caddy | grep -i "certificate"
# должна быть строка про успешную обтайку cert от letsencrypt
```

---

## 9. Sanity checks

С локальной машины:

```bash
# HTTP → должен редиректить на HTTPS
curl -I http://${DOMAIN}/api/v1/health

# HTTPS → 200 OK
curl -i https://${DOMAIN}/api/v1/health
# Ожидаем: HTTP/2 200 + JSON со status: ok

# SSL labs / testssl.sh опционально (после первого успешного запуска)
```

Проверка nmap (с локальной машины):

```bash
nmap -Pn -p 22,80,443,2222,5432,8000 ${VPS_IP}
# Ожидаем:
#   22/tcp    closed (или filtered)
#   80/tcp    open
#   443/tcp   open
#   2222/tcp  open
#   5432/tcp  closed (Postgres только внутри docker net)
#   8000/tcp  closed (API только внутри docker net)
```

Проверка fail2ban:

```bash
$ ssh -p 2222 deploy@${VPS_IP} 'sudo fail2ban-client status sshd'
# Должен показать активный jail: Currently failed: 0, Total failed: 0, ...
```

> `provision-vps.sh` раскладывает sudoers drop-in `/etc/sudoers.d/deploy-pitchterminal`,
> разрешающий passwordless `sudo` для `deploy` только на трёх бинарях:
> `fail2ban-client`, `reboot`, `ufw` — именно столько, сколько нужно для
> диагностики из runbook'а. Полный `sudo` пользователю **не дан**.

Проверка `.env` permissions:

```bash
$ ssh -p 2222 deploy@${VPS_IP} 'ls -la ~/pitchterminal/.env'
# -rw------- 1 deploy deploy ...
```

Проверка reboot-survival (опционально, но важно перед launch'ом):

`ssh root@…` к этому моменту уже **запрещён** hardening'ом — root-логин выключен.
Поэтому ребут делаем одним из двух способов:

**Способ A (рекомендуемый):** через Hetzner Cloud Console.

1. <https://console.hetzner.cloud> → сервер → кнопка **Power → Reset** (или
   **Restart** — мягкий ребут через ACPI).
2. Ждём ~60 секунд, повторно подключаемся с локальной машины:

```bash
$ ssh -p 2222 deploy@${VPS_IP} 'cd ~/pitchterminal/infra && docker compose -f docker-compose.yml -f docker-compose.prod.yml ps'
# Все сервисы должны автоматически подняться (restart: unless-stopped + systemctl enable docker).
```

**Способ B (без консоли):** через `sudo reboot` от `deploy` (sudoers drop-in
из `provision-vps.sh` разрешает passwordless `sudo reboot`).

```bash
# С локальной машины:
$ ssh -p 2222 deploy@${VPS_IP} 'sudo reboot' || true   # связь упадёт — это норма
# Ждём ~60s, повторно подключаемся:
$ ssh -p 2222 deploy@${VPS_IP} 'cd ~/pitchterminal/infra && docker compose -f docker-compose.yml -f docker-compose.prod.yml ps'
```

---

## 9.5 Включение keeper'а (Phase 2 — limit orders)

После того как `LimitOrderExecutor` задеплоен на mainnet и адрес положен в `EXECUTOR_CONTRACT`, нужно поднять keeper-EOA. Он подписывает `executeOrder(...)` от своего имени. Контракт permissionless, поэтому никаких ролей на executor выдавать ему не надо — компрометация = потеря только остатка ETH на этом адресе.

```bash
# 1. Сгенерить новый EOA (локально, не на VPS — pk должен попасть в password manager, не в bash_history VPS)
$ cast wallet new
# 2. Зафандить адрес ~0.01 ETH на Base (operational float)
# 3. На VPS положить pk в .env
$ ssh -p 2222 deploy@${VPS_IP}
$ cd ~/pitchterminal
$ nano .env       # KEEPER_PRIVATE_KEY=0x...
$ chmod 600 .env  # уже должно быть 600, на всякий
# 4. Пересоздать worker (НЕ restart — restart не перечитывает env)
$ cd infra
$ docker compose up -d --force-recreate --no-deps worker
# 5. Verify
$ docker compose logs --since 30s worker | grep keeper
# OK: keeper.recovery_no_rows / keeper.recovery_begin / keeper.tick_no_orders
# BAD: keeper.disabled (pk не подхватился — typo в строке или забыл префикс 0x)
```

> **`docker compose restart` ≠ `docker compose up -d --force-recreate`.** Restart перезапускает существующий контейнер с уже зафиксированным env-набором — изменения в `.env` ИГНОРИРУЮТСЯ. `up -d --force-recreate` создаёт новый контейнер с актуальным env. `--no-deps` не цепляет postgres (важно — см. troubleshooting ниже).

### Симлинк `infra/.env → ../.env` (требуется для compose variable substitution)

**Проблема.** Compose-файл `infra/docker-compose.yml` использует `${DATABASE_URL:-postgresql://pt:pt@postgres:5432/pt}` (и аналогичные `${...:-default}`) для подстановки. Substitution резолвится **из shell env или из `.env` файла рядом с compose-file** — то есть из `infra/.env`. Реальный production-`.env` живёт уровнем выше (`~/pitchterminal/.env`), потому что секреты не должны лежать внутри clonable-репо. Эти две директории compose воспринимает как разные scope'ы.

`env_file: ../.env` в YAML-блоке сервиса в substitution **НЕ участвует** — он только пробрасывает переменные внутрь контейнера на runtime.

**Что ломается без симлинка.** Substitution получает дефолт `pt:pt` (или другой плейсхолдер), который не совпадает с фактическим длинным паролем Postgres (тот, что в `~/pitchterminal/.env` + `POSTGRES_PASSWORD` уже захэширован в `pg_authid` volume). Worker/api контейнеры стартуют с `DATABASE_URL=postgresql://pt:pt@postgres:5432/pt` и валятся в restart-loop с `password authentication failed for user "pt"`.

**Setup (один раз на fresh VPS, после первого `git clone` и заполнения `~/pitchterminal/.env`):**

```bash
$ cd ~/pitchterminal
$ bash infra/scripts/setup-env-symlink.sh
# [ok] created infra/.env -> ../.env
```

Скрипт идемпотентен — повторный запуск при уже существующем правильном симлинке = no-op (`[ok] already symlinked`). При collision (на месте симлинка лежит реальный файл, либо симлинк указывает не туда) — exit 1 без перезаписи.

**Verify (substitution резолвится к реальному паролю):**

```bash
$ cd ~/pitchterminal/infra
$ docker compose config | grep -E 'DATABASE_URL|POSTGRES_PASSWORD' | head -4
# Должны увидеть ваш длинный production-пароль (НЕ default `pt:pt`).
# Если в выводе `pt:pt` — симлинк не подхватился, перезапусти setup-env-symlink.sh.
```

**Альтернатива** — всегда вызывать `docker compose --env-file ../.env ...` (что и делает §8 этого runbook'а). Но CD-скрипт деплоя (`.github/workflows/deploy.yml`) делает `docker compose up -d --build` без `--env-file` — поэтому симлинк надёжнее для unattended-redeploy.

---

## 10. Troubleshooting

### `password authentication failed for user "pt"` в логах worker'а или api

Compose substitution `${DATABASE_URL:-...}` не нашёл переменную и подставил дефолт `pt:pt`, который не соответствует фактическому паролю postgres. Симптом: после `docker compose up -d --force-recreate` (или CD-redeploy) worker/api валятся с auth-fail, хотя `.env` правильный.

**Это первое, что надо проверить** при failed auth после deploy на fresh VPS либо после `rm infra/.env` инцидента.

Фикс — запустить idempotent setup-скрипт:

```bash
$ cd ~/pitchterminal
$ bash infra/scripts/setup-env-symlink.sh
$ docker compose -f infra/docker-compose.yml up -d --force-recreate api worker
```

Существующий postgres data volume **не** надо трогать (`docker volume rm pt_pgdata` — DATA LOSS). Детали — см. §9.5.

### `FileNotFoundError: '/app/abis/LimitOrderExecutor.json'` в логах keeper'а

Старая backend image (до коммита `f419794`) не копировала `abis/` внутрь. Quick-fix без redeploy:

```bash
$ docker exec --user root pt-worker mkdir -p /app/abis
$ docker cp ~/pitchterminal/backend/abis/. pt-worker:/app/abis/
$ docker exec --user root pt-worker chmod -R a+r /app/abis
$ docker compose restart worker
```

Live-патч переживёт только до следующего recreate. Правильное решение — pull обновлённого образа (после `f419794` `abis/` уже встроены).

### Caddy не получил Let's Encrypt cert

Симптом: `docker compose logs caddy` показывает `obtain: ... timeout` или `... 403 from acme-v02.api.letsencrypt.org`.

Возможные причины:
- **DNS ещё не пропагирован.** Проверь `dig +short ${DOMAIN}` (должен вернуть `${VPS_IP}`). Можно подождать 5–10 мин и сделать `docker compose restart caddy`.
- **80/tcp закрыт.** Проверь `ufw status` и `nmap -Pn -p 80 ${DOMAIN}` — Let's Encrypt http-01 ходит на 80 порт.
- **Cloudflare proxy включён (оранжевая тучка).** Выключи (DNS-only / серая тучка).
- **Rate-limit Let's Encrypt** (5 fails / hour / domain). Подожди час либо переключись на staging: добавь `acme_ca https://acme-staging-v02.api.letsencrypt.org/directory` в `Caddyfile.prod` global block — staging cert невалидный, но проверит, что путь работает.

### fail2ban забанил тебя по ошибке

Симптом: твой ssh-клиент не подключается (`connection refused` / `timeout`) после нескольких неудачных попыток.

```bash
# Через консоль Hetzner Cloud (rescue / VNC):
fail2ban-client status sshd                # посмотреть список banned IP
fail2ban-client set sshd unbanip <твой IP>
# Альтернативно — добавь свой IP в ignoreip:
echo -e "[DEFAULT]\nignoreip = 127.0.0.1/8 <твой IP>" >> /etc/fail2ban/jail.local
systemctl restart fail2ban
```

### Потерял SSH-доступ после hardening

Симптом: `ssh -p 2222 deploy@vps` падает с `Permission denied`, а порт 22 уже закрыт.

Решение: Hetzner Cloud Console → Rescue → загрузить в rescue-режиме → смонтировать диск → откатить `/etc/ssh/sshd_config.d/99-pitchterminal.conf` (удалить или закомментировать).

**Профилактика:** всегда запускай `provision-vps.sh` с `SSHD_APPLY=0` на первом проходе, потом руками `systemctl reload ssh` — *после* того, как параллельная сессия на :2222 уже работает.

### Postgres не стартует

Симптом: `docker compose ps` показывает `postgres` как `unhealthy` или `restarting`.

```bash
$ docker compose logs postgres
```

Самые частые причины:
- `POSTGRES_PASSWORD` поменялся после первого старта → volume хранит старый pwd. Решение (DESTRUCTIVE — потеряются данные): `docker compose down && docker volume rm pt_pgdata && docker compose up -d`.
- Диск кончился: `df -h /`.

### Backend в restart-loop'е

```bash
$ docker compose logs api --tail=100
```

Самое частое — `JWT_SECRET=""`. Заполни в `.env`, `docker compose up -d api`.

### Поменялась конфигурация (.env / Caddyfile.prod)

```bash
$ docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate
```

Для одного сервиса — добавь его имя в конце команды.

---

## 11. Что дальше

- **Monitoring:** на старте достаточно alert'ов через `OPERATOR_TG_BOT_TOKEN` (worker сам шлёт). Дальше — Uptime Kuma / Healthchecks.io.
- **Ротация секретов:** см. `docs/conventions.md §9` (раздел «Ротация секретов»).

---

## 12. Деплой (CD via GitHub Actions)

Auto-deploy реализован через `.github/workflows/deploy.yml`. Триггер:
`workflow_run` от `ci.yml` — деплой стартует только если CI на `main`
завершился успешно (см. `if:` job'а).

### Поток

1. Push в `main` → запускается `ci.yml`.
2. По завершении CI (success) → `deploy.yml` стартует автоматически.
3. SSH на VPS (`appleboy/ssh-action@v1.0.3`) под `deploy@${VPS_HOST}:${VPS_PORT}`.
4. На VPS: `git fetch && git reset --hard <SHA>` → `docker compose pull postgres`
   → `docker compose build` (Backend/worker/Caddy образы локальные) →
   `docker compose up -d`.
5. **Sleep 30s** (cold-start окно: миграции alembic, healthcheck `start_period`,
   ACME renewal).
6. **Health check:** `docker exec pt-api curl -fsS http://localhost:8000/api/v1/health`.
   - 200 → success.
   - не 200 → автоматически вызывается `scripts/rollback.sh ${PREVIOUS_SHA}`,
     workflow падает с exit 1, оператор видит failed run в Actions UI.

### Required GitHub Secrets

В `Settings → Secrets and variables → Actions` репозитория:

| Secret | Значение |
|---|---|
| `VPS_HOST` | публичный IPv4/hostname VPS (`${VPS_IP}` из §1) |
| `VPS_PORT` | `2222` |
| `VPS_SSH_KEY` | приватный ключ `deploy`-юзера (см. ниже) |

**Как сгенерировать `VPS_SSH_KEY`:**

```bash
# На локальной машине:
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/pt_deploy -N ""
# Положить публичный ключ на VPS:
ssh -p 2222 deploy@${VPS_IP} 'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys' < ~/.ssh/pt_deploy.pub
# Скопировать приватный ключ в GitHub Secret целиком (включая -----BEGIN ... -----END):
cat ~/.ssh/pt_deploy
```

> Этот ключ — отдельный от твоего admin-ключа. У `deploy`-юзера и так нет
> прав на `sudo` (см. `provision-vps.sh`), но изоляция всё равно полезна:
> compromise CI → можно отозвать один ключ, не трогая твой основной.

### Ручной запуск без push

Если нужно передеплоить ту же ревизию (например, после ротации `.env` на VPS):
GitHub UI → `Actions` → `Deploy` → `Run workflow` → выбрать ветку `main` →
поставить галочку `confirm_no_ci_check`.

> **ВНИМАНИЕ:** `workflow_dispatch` НЕ проверяет CI-статус выбранной ревизии —
> он деплоит HEAD ветки as-is. Перед запуском **обязательно** убедись, что
> последний CI run на `main` зелёный (Actions → CI → последний run на этой
> ветке). Галочка `confirm_no_ci_check` — защита от случайного запуска без
> проверки; если не отмечена, job скипнется через `if:`-guard в workflow.
>
> Автоматическая проверка статуса CI через `gh api` отложена — оператор
> делает sanity check визуально.

### Просмотр runs

`https://github.com/<you>/PitchTerminal-web/actions/workflows/deploy.yml`

---

## 13. Ручной rollback

### Из локальной машины (одной командой)

```bash
ssh -p 2222 deploy@${VPS_IP} 'cd ~/pitchterminal && bash scripts/rollback.sh v0.1.2'
```

Аргумент — git tag или commit SHA (full или short).

### Что делает `scripts/rollback.sh`

1. `git fetch origin --tags && git checkout --force <target>`
2. `docker compose ... up -d --build` (пересборка с предыдущего кода).
3. Sleep 30s + health check.
4. Exit 0 при success, exit 1 при fail (оператор видит сообщение, дальше — руками).

### Важно: data preservation

- Volumes (Postgres data) НЕ трогаются — данные сохраняются.
- Alembic-миграции **forward-only**: если откатываемая ревизия несовместима
  со схемой, применённой свежим деплоем — нужен restore из бэкапа (см. §15).
  На практике: при изменении схемы в новом коде сначала пиши миграцию,
  совместимую со старым кодом (expand-contract pattern).

---

## 14. Off-site backups

Local-only бэкап = single point of failure (VPS погиб → данные потеряны).
Используем **Backblaze B2** — самый дешёвый ($0.005/GB/мес), S3-совместимый
API (можем использовать `aws-cli` без специфичных SDK). Альтернативы:
Cloudflare R2 / AWS S3 / rsync.net — тот же `scripts/backup.sh` с заменой
`B2_ENDPOINT`.

### Setup (один раз)

**1. Создать B2 bucket:**

- <https://www.backblaze.com> → Account → My Account.
- Buckets → Create Bucket: name `pt-backups-<уникальный-суффикс>`, Private,
  Default Encryption: SSE-B2 (включить).
- Запиши Bucket name и Endpoint URL (показывается на странице bucket'а:
  `https://s3.us-west-004.backblazeb2.com` — регион может отличаться).

**2. Lifecycle policies (для retention):**

В bucket settings → Lifecycle Settings → Custom Rules:

| File Name Prefix | Keep prior versions for | Hide files older than |
|---|---|---|
| `daily/` | 0 days | 7 days |
| `weekly/` | 0 days | 28 days |
| `monthly/` | 0 days | 90 days |

(«Hide» в B2 = soft delete; через 1 день hidden files реально удаляются.
Если нужно жёсткое удаление сразу — использовать «Delete files older than».)

**3. Application Key:**

- Account → Application Keys → Add a New Application Key.
- Name: `pt-backup-write`. Bucket: только что созданный `pt-backups-*`.
- Capabilities: `listBuckets`, `listFiles`, `readFiles`, `writeFiles`.
  (НЕ давай `deleteFiles` — lifecycle сам удалит, write-only credential
  безопаснее при компрометации.)
- Запиши `keyID` и `applicationKey` — `applicationKey` показывается **один раз**.

**4. Создать `~/.pt-backup.env` на VPS:**

```bash
ssh -p 2222 deploy@${VPS_IP}
cat > ~/.pt-backup.env <<EOF
B2_KEY_ID=<keyID из шага 3>
B2_APP_KEY=<applicationKey из шага 3>
B2_BUCKET=pt-backups-<суффикс>
B2_ENDPOINT=https://s3.us-west-004.backblazeb2.com
EOF
chmod 600 ~/.pt-backup.env
```

> Креды живут отдельно от `.env` приложения: бэкап работает даже если
> `.env` сломан, а ротировать credential'ы можно независимо.

**5. Установить aws-cli (если ещё не стоит):**

```bash
sudo apt-get install -y awscli
aws --version  # ожидаем: aws-cli/2.x или 1.x — оба работают
```

**6. Подготовить локальный каталог для дампов:**

```bash
ssh -p 2222 deploy@${VPS_IP} 'sudo install -d -o deploy -g deploy -m 0750 /var/backups/pt'
```

Скрипт пишет дамп в `/var/backups/pt/` (стабильное место, не чистится reboot'ом).
При upload-fail файл **остаётся** на диске — это сознательно: можно ретраить
upload без повторного `pg_dump` (он может быть дорогим под нагрузкой). При
success локальный дамп удаляется в конце скрипта.

**7. Зарегистрировать cron:**

```bash
crontab -e
# Добавить (важно: MAILTO + БЕЗ `2>&1` — см. ниже):
MAILTO=shaburshil@gmail.com
0 3 * * * /home/deploy/pitchterminal/scripts/backup.sh >> /var/log/pitchterminal-backup.log
```

> Время `03:00 UTC` — низкий трафик. Запускаем как `deploy`-юзер
> (имеет доступ к docker socket через группу `docker`, см. provision).
>
> **Почему НЕТ `2>&1`:** cron шлёт mail на `MAILTO` ровно когда у задачи
> есть output (stdout/stderr). `2>&1` перенаправит stderr в лог-файл и
> почта НЕ придёт даже при failure → молчаливая поломка бэкапа.
> Текущая конфигурация: stdout → log-файл (для просмотра истории),
> stderr → cron-mail (для алертов). На VPS должен быть рабочий MTA
> (`postfix` или `msmtp` с relay) — иначе `MAILTO` no-op'нется.

**Выбор cron vs systemd-timer vs Actions:**

- **Cron на VPS** — выбрано. Простой, не требует доступа к docker socket
  снаружи, креды никогда не покидают VPS. Не зависит от GitHub uptime.
- systemd-timer — эквивалентен по надёжности, но добавляет 2 файла
  (`.service` + `.timer`) ради zero benefit для нашего use case.
- GitHub Actions cron — требует прокидывания B2 credentials в GitHub
  Secrets + SSH-ключа для подключения к VPS. Лишний attack surface.

### Что записывает `scripts/backup.sh`

- `pg_dump` через `docker exec pt-postgres` → `/var/backups/pt/pt-${TIMESTAMP}.dump`
  (custom format, compress=9).
- **Каждый запуск** грузит дамп в `daily/`.
- Дополнительно делает server-side copy:
  - воскресенье → `weekly/` (через `aws s3 cp s3://… s3://…`, без повторного upload)
  - 1-е число месяца → `monthly/`
- Lifecycle policies на bucket держат retention: daily — 7 дней, weekly — 28,
  monthly — 90.
- Локальный дамп удаляется ТОЛЬКО при success всех upload'ов. При fail —
  файл остаётся, путь и retry-команда логируются (ручной retry без повторного
  pg_dump).
- Логи → stdout/stderr, cron направляет stdout в `/var/log/pitchterminal-backup.log`,
  stderr — в cron-mail оператору.

### Проверка работы

```bash
# Запустить вручную с локальной машины:
ssh -p 2222 deploy@${VPS_IP} 'bash /home/deploy/pitchterminal/scripts/backup.sh'

# Посмотреть логи:
ssh -p 2222 deploy@${VPS_IP} 'tail -20 /var/log/pitchterminal-backup.log'

# Список бэкапов в B2:
ssh -p 2222 deploy@${VPS_IP} 'source ~/.pt-backup.env && \
  AWS_ACCESS_KEY_ID=$B2_KEY_ID AWS_SECRET_ACCESS_KEY=$B2_APP_KEY \
  aws --endpoint-url $B2_ENDPOINT s3 ls s3://$B2_BUCKET/daily/'
```

---

## 15. Test restore (один раз перед public launch, затем раз в квартал)

**Цель:** убедиться, что бэкап реально восстановим и данные совпадают.
Backup, который не проверен — это не backup, а wishful thinking.

### Процедура (на тестовой машине / dev-окружении, НЕ на проде)

```bash
# 1. Скачать самый свежий дамп
source ~/.pt-backup.env
AWS_ACCESS_KEY_ID=$B2_KEY_ID AWS_SECRET_ACCESS_KEY=$B2_APP_KEY \
  aws --endpoint-url $B2_ENDPOINT s3 ls s3://$B2_BUCKET/daily/ | sort | tail -1
# Допустим, последний — daily/pt-20260524-030001.dump
AWS_ACCESS_KEY_ID=$B2_KEY_ID AWS_SECRET_ACCESS_KEY=$B2_APP_KEY \
  aws --endpoint-url $B2_ENDPOINT s3 cp \
  s3://$B2_BUCKET/daily/pt-20260524-030001.dump /tmp/restore.dump

# 2. Поднять свежий Postgres в стороне
docker run -d --rm --name pt-restore-test \
  -e POSTGRES_USER=pt -e POSTGRES_PASSWORD=pt -e POSTGRES_DB=pt \
  -p 15432:5432 postgres:16-alpine
sleep 5

# 3. Залить дамп
docker cp /tmp/restore.dump pt-restore-test:/tmp/restore.dump
docker exec pt-restore-test \
  pg_restore -U pt -d pt --clean --if-exists /tmp/restore.dump

# 4. Sanity-query (примеры)
docker exec pt-restore-test psql -U pt -d pt -c \
  "SELECT COUNT(*) FROM auth_nonces;"
docker exec pt-restore-test psql -U pt -d pt -c \
  "SELECT COUNT(*) FROM limit_orders;"
docker exec pt-restore-test psql -U pt -d pt -c \
  "SELECT COUNT(*) FROM user_settings;"
# Сравнить с прод-значениями:
ssh -p 2222 deploy@${VPS_IP} \
  'docker exec pt-postgres psql -U pt -d pt -c "SELECT COUNT(*) FROM auth_nonces;"'

# 5. Cleanup
docker stop pt-restore-test
rm /tmp/restore.dump
```

Ожидается: counts совпадают (или отличаются на свежие записи между моментом
dump'а и сейчас — нормально). Если хоть один SELECT упал с ошибкой схемы —
бэкап повреждён, разбираться немедленно.

**Кадrence:** один раз перед public launch + квартально. Записывать дату
прохождения в `docs/runbook.md` или ops-журнал.
