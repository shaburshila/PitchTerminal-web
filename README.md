# PitchTerminal-web

Веб-версия PitchTerminal — браузерный просмотрщик и торговая панель для рынков
токенов игроков и стран [pitchwc.app](https://pitchwc.app) на Base L2.
**Некастодиальная**: пользователи подключают свой кошелёк, сервер не хранит приватных
ключей.

> Портативная single-user версия живёт в публичном репозитории `PitchTerminal`.
> Здесь — приватный fork с веб-архитектурой.

## Документация

Источники истины для архитектуры и разработки:

| | Документ | Что внутри |
|---|---|---|
| 📐 | [docs/architecture.md](docs/architecture.md) | Архитектура (HOW): топология, решения, фазы |
| 🎯 | [docs/functional-spec.md](docs/functional-spec.md) | Функциональная спецификация (WHAT): экраны, UX |
| 🔌 | [docs/api-spec.md](docs/api-spec.md) | REST + SSE контракты |
| 🗄️ | [docs/db-schema.sql](docs/db-schema.sql) | Канонический Postgres DDL |
| 🔐 | [docs/contracts.md](docs/contracts.md) | Спецификация смарт-контрактов |
| ✍️ | [docs/eip712.md](docs/eip712.md) | EIP-712 формат ордеров, формулы |
| 🎨 | [docs/conventions.md](docs/conventions.md) | Стиль кода, env vars, Definition of Done |
| 📋 | [docs/plans/](docs/plans/) | Пошаговые планы для 4 агентов разработки |

## Структура репозитория

```
backend/      Python — API (Flask) + worker (event/price/keeper/alerts)
frontend/    Vanilla JS + Vite + wagmi/viem + WalletConnect + lightweight-charts
contracts/   Solidity — PitchTerminalAccess + LimitOrderExecutor (Foundry)
abis/        ABI смарт-контрактов (общие для backend и frontend)
infra/       Docker Compose, Caddyfile, CI/CD
scripts/     Backup, smoke-проверка, мониторинг keeper'а
docs/        Документация (источник истины)
```

## Локальная разработка

(Будет дополнено по мере прогресса фазы 0 — см.
[docs/plans/README.md](docs/plans/README.md).)

## Лицензия

Приватный проект. Все права защищены.
