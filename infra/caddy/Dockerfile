# syntax=docker/dockerfile:1.7

# ---------- builder ----------
# Кастомный Caddy с модулем caddy-ratelimit (нужно для глобальных лимитов
# на /api/*). xcaddy резолвит зависимости и собирает статический бинарь.
FROM caddy:2-builder-alpine AS builder

RUN xcaddy build \
    --with github.com/mholt/caddy-ratelimit

# ---------- runtime ----------
FROM caddy:2-alpine

# Подменяем штатный бинарь на кастомный с rate_limit.
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
