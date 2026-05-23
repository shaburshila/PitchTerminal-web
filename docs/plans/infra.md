# Infra Agent — пошаговый план

> **Роль:** инфраструктура, Docker, реверс-прокси, CI/CD, мониторинг.
> **Не пишет:** код приложения (Python, JS, Solidity).
> **Spec-источники:** [../architecture.md](../architecture.md) §14, §19,
> [../conventions.md](../conventions.md) §9 (env vars).
> **Координация:** [README.md](README.md). Любая неоднозначность → эскалировать.

## Границы владения

| Можно править | Только читать |
|---|---|
| `infra/` (docker-compose, Caddyfile, Caddy build) | `backend/Dockerfile` (пишет Backend) |
| `.github/workflows/` | `frontend/vite.config.js` (пишет Frontend) |
| `scripts/` (backup, smoke, monitor) | spec-документы |
| `.env.example` (root, шаблон) | `requirements.txt`, `package.json` |
| `README.md` (root) | |

Не трогать: `backend/`, `frontend/`, `contracts/` (кроме их Dockerfile, если они их не сделают сами).

---

## Фаза 0 — Фундамент

### I0.1 — Репо-скелет
**Что:** создать структуру директорий, корневые файлы, `.gitignore`.

**Действия:**
- `mkdir -p backend frontend contracts infra abis scripts docs/plans .github/workflows`
- Создать корневой `.gitignore`: `venv/`, `__pycache__/`, `node_modules/`,
  `frontend/dist/`, `*.env` (но не `.env.example`), `out/`, `cache/` (Foundry),
  `.idea/`, `.vscode/`, `*.log`.
- Создать корневой `README.md` — однострочное описание, ссылка на `docs/`.
- Создать `.env.example` со всеми env vars из [../conventions.md](../conventions.md) §9
  и заглушками.

**DoD:**
- Директории существуют, `.gitignore` коммитится без лишних артефактов.
- `git status` чистый после `git add -A && git commit`.

**Блокирует:** B0.1, F0.1 (нужны их директории).

---

### I0.2 — Docker Compose: Postgres
**Что:** поднять Postgres в Docker Compose для локалки + base для VPS.

**Действия:**
- `infra/docker-compose.yml` — сервис `postgres` (postgres:16-alpine), volume
  для данных, env из `.env`.
- `infra/docker-compose.override.yml` — local overrides (порт 5432 наружу для
  локальной разработки).
- В `scripts/dev-up.sh` — `docker compose -f infra/docker-compose.yml up -d postgres`.

**DoD:**
- `bash scripts/dev-up.sh` поднимает Postgres.
- `psql $DATABASE_URL -c "SELECT 1"` работает.
- Volume сохраняет данные между рестартами.

**Блокирует:** B0.3 (миграции), все Backend-шаги после.

---

### I0.3 — Backend Dockerfile (заглушка для CI)
**Что:** базовый `backend/Dockerfile` для сборки в CI. Тонкости приложения — Backend-агент дополнит позже.

**Действия:**
- `backend/Dockerfile` — Python 3.12-slim, `pip install -r requirements.txt`,
  `ENTRYPOINT` — гибкий (`run_api.py` или `run_worker.py` по аргументу
  Docker Compose).
- Multi-stage, чтобы не таскать build deps в runtime.

**DoD:**
- `docker build -t pt-backend backend/` проходит на пустом `requirements.txt`.
- Образ < 200 MB.

**Координация:** Backend-агент позже может расширить Dockerfile под свои нужды
(переименовать stages, добавить psycopg-binary build deps). Не блокирует —
файл создаётся минимальный.

---

### I0.4 — Caddy build с rate_limit + Caddyfile
**Что:** кастомный Caddy через `xcaddy` с модулем
`github.com/mholt/caddy-ratelimit`; Caddyfile с маршрутизацией.

**Действия:**
- `infra/caddy/Dockerfile` — два stage'а:
  1. `xcaddy build` с `--with github.com/mholt/caddy-ratelimit`.
  2. финальный `caddy:2-alpine` (но с кастомным бинарником).
- `infra/Caddyfile`:
  - 80 → 443 redirect.
  - `pitchterminal.app` (или env-var домен):
    - Backend: `reverse_proxy api:8000` под `/api/*`.
    - SPA: `file_server` из `/srv/frontend` с fallback на `index.html`.
    - SSE: longer timeouts на `/api/v1/stream`.
    - `rate_limit` — глобальные лимиты на `/api/*`.
    - HTTPS — auto через Let's Encrypt.
- Добавить в `docker-compose.yml` сервис `caddy` с volume на статику фронта.

**DoD:**
- `docker compose up caddy` поднимается без ошибок.
- Локально (с самоподписанным сертом или `localhost`) `/api/v1/health` через
  Caddy возвращает то же, что прямой backend.
- Rate-limit срабатывает при > 600 RPS на `/api/v1/`.

**Зависит от:** I0.2 (compose уже существует).

---

### I0.5 — GitHub Actions CI (lint + test)
**Что:** CI на каждый push в `main` и в PR.

**Действия:**
- `.github/workflows/ci.yml`:
  - `jobs.lint`:
    - Backend: ruff check + ruff format --check + mypy backend/shared.
    - Frontend: eslint + prettier --check.
    - Contracts: forge fmt --check, forge build (warnings fail).
  - `jobs.test`:
    - Backend: pytest (в контейнере с Postgres-service).
    - Frontend: vitest.
    - Contracts: forge test (без fork-тестов).
  - `jobs.build` (только на push в main):
    - Backend Docker build → push в ghcr.io.
    - Frontend Vite build → артефакт.
- Кэширование pip, pnpm, foundry-deps.

**DoD:**
- PR с заведомо плохим кодом блокируется (lint fails).
- Time-to-green CI < 5 минут на пустом проекте.

**Координация:** позже Backend/Frontend/Contracts добавят свои тесты — CI их
автоматически подхватит. Координатор может предложить добавить slither для
Solidity (advisory) — opt-in.

---

### I0.6 — VPS provisioning (одноразовое)
**Что:** runbook + один-shot скрипт для нового VPS с **hardened SSH**.

**Действия:**
- `scripts/provision-vps.sh`:
  - Install Docker, docker-compose-plugin.
  - **SSH hardening** в `/etc/ssh/sshd_config`:
    - `Port 2222` (не дефолтный 22 — снижает шум от ботов).
    - `PasswordAuthentication no`.
    - `PermitRootLogin no` (или `prohibit-password`).
    - `PubkeyAuthentication yes`.
    - `MaxAuthTries 3`.
    - Создать non-root пользователя `deploy`, добавить в `docker` группу,
      положить SSH-ключ.
  - Install `fail2ban` с дефолтными правилами для SSH.
  - `ufw`:
    - default deny incoming.
    - allow 2222/tcp (SSH).
    - allow 80,443/tcp (HTTP/HTTPS).
    - `ufw enable`.
  - `chmod 600 /home/deploy/pitchterminal/.env` после клонирования репо.
- `docs/runbook.md` — пошагово: создать DNS-запись, склонировать репо как
  `deploy`-пользователем, заполнить `.env`, `docker compose up -d`.
- `restart: unless-stopped` в compose для всех сервисов.

**DoD:**
- Свежий VPS (Hetzner CX22) от нуля до запущенного `docker compose ps` за < 15 мин.
- SSH: вход root по паролю — `Permission denied`. Вход `deploy@host -p 2222`
  по ключу — работает.
- `nmap` снаружи показывает только 80, 443, 2222 открытыми.
- `fail2ban-client status sshd` показывает активный jail.
- HTTPS работает (Let's Encrypt выдал сертификат).
- `.env` имеет permission 600, владелец `deploy`.

**Запускается:** один раз перед IC-0.6. Координатор делает это вручную с
помощью агента.

---

### I0.7 — Deploy workflow (CD)
**Что:** автоматический деплой на VPS при push в main.

**Действия:**
- `.github/workflows/deploy.yml`:
  - После CI на main → SSH на VPS (`appleboy/ssh-action` или `ssh-action`).
  - На VPS: `git pull`, `docker compose pull`, `docker compose up -d`.
  - Post-deploy: дождаться 30с → `curl /api/v1/health` → если не 200,
    откатиться (`docker compose pull <предыдущий_тэг>`).
- Backup workflow: nightly `pg_dump` → **загрузка на off-site хранилище**
  (Backblaze B2 / Cloudflare R2 / AWS S3 / rsync.net — выбрать одно).
  Local-only бэкап = single point of failure (VPS погиб → данные потеряны).
  Стоимость off-site ≈ $0.05–1/мес для нашего объёма.
  Retention: 7 ежедневных + 4 еженедельных + 3 ежемесячных.
  События восстановимы из чейна, но `limit_orders` / `auth_nonces` /
  `user_settings` / `telegram_links` — нет.

**DoD:**
- Деплой не требует ручных действий после merge.
- Откат одной командой (`scripts/rollback.sh <tag>`).
- Nightly `pg_dump` загружается на off-site хранилище.
- Тестовый restore: скачать самый свежий бэкап → восстановить в свежую
  базу → запустить тестовый запрос → данные совпадают. Делается один раз
  перед публичным запуском, потом раз в квартал.

**Зависит от:** I0.6 (VPS должен быть готов).

---

## Фаза 1 — Некастодиальная торговля

### I1.1 — Обновить деплой, если изменились env vars
**Что:** при добавлении/удалении env vars в фазе 1 — обновить `.env.example`
и `docs/runbook.md`.

**Действия:**
- Сверить env vars в `conventions.md §9` с `.env.example`.
- Обновить документацию деплоя, если что-то изменилось.

**DoD:** `.env.example` синхронизирован.

(Фаза 1 в основном бэкенд+фронт; инфра пассивна.)

---

## Фаза 2 — Лимит-ордера

### I2.1 — Worker отдельный сервис в compose
**Что:** убедиться, что `worker` запускается рядом с `api` отдельным сервисом.

**Действия:**
- В `docker-compose.yml` — сервис `worker` с тем же образом backend, но
  command `python run_worker.py`.
- `restart: unless-stopped`, healthcheck по последнему `last_price_update`.
- Logs идут в stdout → Docker подбирает.

**DoD:**
- `docker compose up` запускает 4 сервиса: postgres, api, worker, caddy.
- `docker compose logs worker` показывает живой цикл.

**Уже должно быть** к фазе 2 (workers планируется с фазы 0). Этот шаг —
санити-чек/при необходимости донастройка.

---

### I2.2 — Keeper-кошелёк баланс монитор
**Что:** скрипт `scripts/monitor-keeper.sh` + cron.

**Действия:**
- Скрипт читает баланс ETH кошелька кипера через RPC.
- Если ниже `KEEPER_GAS_THRESHOLD_WEI` — шлёт алерт в operator-Telegram.
- Cron: каждый час.

**DoD:**
- Тестовый запуск с искусственно низким балансом → алерт пришёл.

(Альтернатива: уже делается из worker'а — тогда этот шаг не нужен, координатор
решает с Backend-агентом.)

---

## Фаза 3 — Telegram-алерты

### I3.1 — `setWebhook` для user-бота
**Что:** при первом старте — зарегистрировать webhook у Telegram.

**Действия:**
- `scripts/telegram-setup.sh` — однократно вызывает `setWebhook` с URL
  `https://домен/api/v1/telegram/webhook` и `secret_token` из env.
- Документировано в runbook.

**DoD:**
- `getWebhookInfo` показывает корректный URL и pending_update_count.
- Тестовый `/start` от пользователя доходит до API (есть лог).

---

## Сводный чек-лист DoD Infra по фазам

См. [../conventions.md](../conventions.md) §12 — пункты, помеченные как
инфра-ответственные:

- Фаза 0: VPS, Caddy, Docker Compose, CI/CD, smoke-проверка, бэкап.
- Фаза 1: deploy без изменений env.
- Фаза 2: worker в compose, keeper balance monitor.
- Фаза 3: setWebhook, runbook обновлён.
