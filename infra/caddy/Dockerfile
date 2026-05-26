# syntax=docker/dockerfile:1.7

# ---------- frontend build ----------
# Собираем SPA-бандл в воспроизводимой среде (Node 24 + pnpm@9.15.4 — пин
# из frontend/package.json `packageManager`). Раньше /srv/frontend подавался
# на caddy через volume `../frontend/dist`, который никем не пересобирался в
# pipeline — git pull менял исходники, а dist оставался от первого ручного
# setup'а. Теперь dist вшит в caddy-образ, и docker compose build физически
# не может его «забыть».
FROM node:24-alpine AS frontend-builder
WORKDIR /build
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
# Сначала только манифесты — кеш слоя установки переживёт изменения в src/.
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
# Остальной фронт.
COPY frontend/ ./
# Sentry DSN — build-time, читается Vite при `pnpm build` и инлайнится в
# bundle. .env из проекта в build-контекст не попадает (.dockerignore),
# поэтому пробрасываем через ARG. Пустое значение → Sentry init становится
# no-op (см. frontend/src/sentry.js).
ARG VITE_SENTRY_DSN=
ARG VITE_SENTRY_ENVIRONMENT=production
ARG VITE_APP_VERSION=
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
ENV VITE_SENTRY_ENVIRONMENT=$VITE_SENTRY_ENVIRONMENT
ENV VITE_APP_VERSION=$VITE_APP_VERSION
RUN pnpm build

# ---------- caddy builder ----------
# Кастомный Caddy с модулем caddy-ratelimit (нужно для глобальных лимитов
# на /api/*). xcaddy резолвит зависимости и собирает статический бинарь.
FROM caddy:2-builder-alpine AS caddy-builder

RUN xcaddy build \
    --with github.com/mholt/caddy-ratelimit

# ---------- runtime ----------
FROM caddy:2-alpine

# Подменяем штатный бинарь на кастомный с rate_limit.
COPY --from=caddy-builder /usr/bin/caddy /usr/bin/caddy

# Вшиваем собранный SPA. Caddyfile ожидает статику в /srv/frontend.
COPY --from=frontend-builder /build/dist /srv/frontend
