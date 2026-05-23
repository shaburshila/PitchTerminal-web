# PitchTerminal-web — бэклог пост-MVP

Фичи, согласованные, но осознанно отложенные на после MVP. Не входят в фазы 0–3
(см. `architecture.md` §17) — это отдельный бэклог, чтобы про них не забыть.

## Quick-buy «zap» — однокликовая покупка токена игрока

Сейчас покупка токена игрока двухшаговая: PITCH → токен страны → токен игрока (игрок
торгуется за токен своей страны). «Zap» — это один поток в UI, который проводит обе
сделки за пользователя.

- **Статус:** отложено на после MVP (решено 2026-05-22).
- **Зачем:** убирает трение для новичка, у которого на руках только PITCH.
- **Сложность:** две транзакции через два роутера (Country Router + Player Router) —
  нужна аккуратная последовательность и обработка отказа на середине пути.

## Реферальные ссылки через ENS / Basenames

В MVP резолв читаемого handle (`?ref=alex42`) делает наш backend через таблицу
`referral_codes`. ENS-имена на Base (`alex.base.eth`) — альтернатива «нулевого
backend'а»: фронт через `viem.getEnsAddress` резолвит имя в адрес локально.

- **Статус:** отложено на после MVP (решено 2026-05-23).
- **Зачем:** декомпозиция (zero-backend для этого пути), composability с
  остальной Base-экосистемой; не каждый пользователь захочет регистрироваться
  у нас, многие уже имеют Basename.
- **Как:** frontend пробует определить тип `?ref=` в порядке: `0x…` → используем
  напрямую → `*.eth` / `*.base.eth` → ENS-резолюция → иначе → backend
  `GET /api/v1/ref/{code}`. Никаких изменений в контракте и в БД.
- **Почему не в MVP:** добавляет RPC-call на каждый landing с ref-ссылкой
  (приемлемо, но требует тестирования freshness/fail-open сценариев); базовый
  путь через handle закрывает основной use case без зависимости от ENS.

## Индексация `AccessPurchased.referrer` для аналитики реферал-выручки

В MVP backend не пишет историю реферал-выплат в БД — on-chain события +
Basescan / Dune закрывают аналитику. Если объём вырастет и потребуется
встроенный дашборд по реферрерам — индексировать `AccessPurchased` worker'ом
в новую таблицу.

- **Статус:** отложено на после MVP (решено 2026-05-23).
- **Зачем:** in-app дашборд для пользователя «сколько ты заработал на
  рефералах» без похода в Basescan.
- **Как:** новая таблица `referral_payouts (tx_hash, log_index, buyer,
  referrer, amount, ts)` + worker-задача в индексаторе событий
  `PitchTerminalAccess` (рядом с тем, что индексирует Buy/Sell хуков).
- **Почему не в MVP:** все данные уже on-chain. Pre-mature optimization.

## Infra hardening для prod-деплоя

Findings от infra-ревью 2026-05-23, отложенные до деплоя на VPS (фаза I0.6/I0.7).
Сейчас (MVP local-dev) не блокируют, но к публичному запуску **обязательны**.

- **HTTPS / auto-https в проде.** Сейчас `Caddyfile` хардкодит `auto_https off`.
  Нужно либо переключаться по env-conditional (`{$SITE_ADDRESS:::80}`), либо иметь
  отдельные `Caddyfile.dev` / `Caddyfile.prod`. Прод **обязан** ходить по 443 с
  Let's Encrypt.
- **Security headers в Caddy для prod.** Добавить `Strict-Transport-Security`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  базовый CSP. Один `header { ... }` блок в production-Caddyfile.
- **Worker healthcheck.** Сейчас worker без healthcheck — если поллер завис,
  `restart: unless-stopped` не сработает. Добавить liveness-файл (worker
  периодически пишет timestamp) или мини-HTTP-эндпоинт.
- **Postgres password must-set в проде.** `docker-compose.yml` сейчас имеет
  fallback `pt:pt`. На production-compose-файле этот fallback убрать, чтобы
  отсутствие `POSTGRES_PASSWORD` блокировало старт.
- **Secrets вместо env_file.** `KEEPER_PRIVATE_KEY`, `JWT_SECRET`,
  `TELEGRAM_WEBHOOK_SECRET` сейчас живут в `.env` и видны через `docker inspect`
  (Docker socket = root-equivalent). Перейти на Docker secrets или внешний
  secret manager (Hetzner Vault, sops-nix, age-encrypted .env).
- **Pin образов через digest (`@sha256:...`).** `python:3.12-slim`,
  `postgres:16-alpine`, `caddy:2-alpine`, `caddy:2-builder-alpine` — теги
  мутабельны, supply-chain риск. Фиксировать SHA после следующей сборки.
- **Версия модуля `caddy-ratelimit`.** Сейчас xcaddy ставит `latest`.
  Зафиксировать конкретный тег после первого успешного билда.
- **Requirements.lock для backend.** `requirements.txt` пинует только major'ы
  (`flask==3.0.*`). Сгенерить полный pip-lock через `pip-compile` для
  воспроизводимых сборок.
- **Frontend build в Caddy-Dockerfile.** Сейчас `caddy` маунтит
  `../frontend/dist:/srv/frontend:ro` — требует ручной `pnpm build` на хосте.
  Перенести сборку в multi-stage `node:22-alpine` → копировать `dist/` в
  caddy-image. Атомарный деплой без зависимости от хост-FS.
- **Off-site backups для Postgres.** Nightly `pg_dump` → Backblaze B2 / S3 / R2.
  Уже упомянуто в `plans/infra.md` §I0.7 — этот пункт здесь как кросс-линк.

## Защитный статус `review` для лимит-ордеров

Предохранитель из портативной версии: если после простоя кипера лимит-ордер сработал бы
сильно мимо цели (например, limit-buy, а цена обвалилась на 20%+ ниже цели), ордер не
исполняется автоматически, а ставится в статус `review` — на ручное решение пользователя.

- **Статус:** отложено на после MVP (решено 2026-05-22).
- **Зачем:** защита от авто-покупки в обвал/«раг» после даунтайма кипера.
- **Почему не в MVP:** это патерналистская подстраховка, а не базовый функционал; TTL и
  кипер на мониторимом VPS (а не на ноутбуке, как в портативной) уже снижают риск.
  Добавляет отдельный статус, UI ручного решения и логику в кипер — непропорционально
  много для краевого случая.
