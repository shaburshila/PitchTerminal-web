# syntax=docker/dockerfile:1.7

# Frontend больше не собирается внутри этого образа — `pnpm build` уходит
# на CI runner (см. .github/workflows/deploy.yml). Готовый `frontend/dist/`
# монтируется в /srv/frontend через docker-compose.prod.yml (volume на VPS)
# или docker-compose.override.yml в dev. Причина: vite build с AppKit
# (~4600 modules) выжирал RAM на 2GB VPS → OOM → deploy timeout
# (см. memory project-appkit-oom-incident).

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

# Placeholder для /srv/frontend — реальный контент монтируется volume'ом
# (см. compose-файлы). Без директории Caddy file_server падает с
# "no such file or directory" если volume не примонтирован.
RUN mkdir -p /srv/frontend
