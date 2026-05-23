# PitchTerminal-web — соглашения разработки

> Правила, которые держат код одинаковым между агентами и сессиями. Если что-то
> не описано здесь — оно описано в [architecture.md](architecture.md) или
> [api-spec.md](api-spec.md). Если нигде — пишем сюда первым делом, потом код.

## Содержание
1. [Языки и стек по слоям](#1-языки-и-стек-по-слоям)
2. [Линтеры и форматтеры](#2-линтеры-и-форматтеры)
3. [Именование и стиль](#3-именование-и-стиль)
4. [Нормализация адресов и денег](#4-нормализация-адресов-и-денег)
5. [Файловая раскладка backend/](#5-файловая-раскладка-backend)
6. [Файловая раскладка frontend/](#6-файловая-раскладка-frontend)
7. [Файловая раскладка contracts/](#7-файловая-раскладка-contracts)
8. [Логирование](#8-логирование)
9. [Конфигурация и env vars](#9-конфигурация-и-env-vars)
10. [Тестирование](#10-тестирование)
11. [Git и PR-процесс](#11-git-и-pr-процесс)
12. [Definition of Done по фазам](#12-definition-of-done-по-фазам)

---

## 1. Языки и стек по слоям

| Слой | Язык | Главные зависимости |
|---|---|---|
| Backend (API + worker) | Python 3.12 | Flask, gunicorn+gevent, psycopg[binary]+psycogreen, web3.py, PyJWT, eth-account, flask-limiter |
| Frontend | Vanilla JS (ES modules) + Vite | `@wagmi/core`, viem, `@walletconnect/ethereum-provider`, `lightweight-charts@4.1.3` |
| Contracts | Solidity 0.8.26 | OpenZeppelin Contracts 5.x, Foundry |
| Infra | YAML/Caddyfile | Docker Compose, Caddy 2 |

Решение vanilla-JS принято в [architecture.md](architecture.md) §13. **Не переходим
на React/TypeScript в MVP** — это явное продуктовое решение, не недосмотр.

## 2. Линтеры и форматтеры

### 2.1 Python (backend)

- **ruff** — линт + автофикс. Конфиг в `backend/pyproject.toml`:
  ```toml
  [tool.ruff]
  line-length = 100
  target-version = "py312"
  [tool.ruff.lint]
  select = ["E", "F", "I", "B", "UP", "SIM", "RUF"]
  ignore = ["E501"]  # длинные строки — на усмотрение
  ```
- **black** — форматирование, `line-length = 100`, целевой Python 3.12.
- **mypy** — `strict_optional = True`, `disallow_untyped_defs = True` для
  `backend/shared/`. В `backend/app/` и `backend/worker/` — мягче, type hints
  обязательны только для публичных функций.

Запуск: `ruff check . && ruff format --check . && mypy backend/shared`.

### 2.2 Frontend

- **Prettier** — конфиг по умолчанию + `singleQuote: true`, `printWidth: 100`.
- **ESLint v9** — **flat config** (`eslint.config.js`), `eslint:recommended` +
  `eslint-plugin-import`. Никаких React-плагинов — не используем React.
- **Node 22+** требуется для запуска современного pnpm и vite-tooling. Версия
  пиннится через `.nvmrc` + `"engines.node"` в package.json.

### 2.3 Solidity

- **forge fmt** — встроенный формат Foundry; конфиг `foundry.toml` —
  `line_length = 100`, `tab_width = 4`.
- **forge build** в CI должен проходить **без warning'ов**.
- **slither** в CI на read-only режиме (advisory). Findings level `high` блокируют.

### 2.4 CI

Все три линтера запускаются параллельно в одном GitHub Actions job, до тестов.
Падение линта = падение CI = не мёрджим.

## 3. Именование и стиль

### 3.1 Кейсы

- Python: `snake_case` для функций/переменных, `PascalCase` для классов,
  `UPPER_SNAKE` для констант.
- JS: `camelCase` для функций/переменных, `PascalCase` для классов,
  `SCREAMING_SNAKE` для констант.
- Solidity: `camelCase` для функций/переменных, `PascalCase` для контрактов и
  структур, `UPPER_SNAKE` для констант и `immutable`.
- JSON / API: всегда `camelCase`.
- Postgres: `snake_case` для таблиц и колонок.

### 3.2 Конверсия `snake_case` ↔ `camelCase`

Происходит **на границе API**: модели БД и внутренние объекты — snake; ответы API
и тела запросов — camel. Хелпер живёт в `backend/shared/serial.py`
(`to_camel(dict) / from_camel(dict)`). Не используем библиотеки, выполняющие магию
рефлексией — конверсия явная по дикт-ключам.

### 3.3 Имена эндпоинтов

См. [api-spec.md](api-spec.md). Глагол через метод (`GET`/`POST`/...). Множественное
число для коллекций (`/orders`, `/tokens`). ID/адрес в пути — для конкретного
ресурса.

### 3.4 Имена SSE-каналов и NOTIFY

| SSE event | NOTIFY channel |
|---|---|
| `prices` | `pt_prices` |
| `events` | `pt_events` |
| `orders` | `pt_orders` |

Префикс `pt_` отделяет наши каналы от системных Postgres-каналов.

## 4. Нормализация адресов и денег

### 4.1 Адреса

- **Хранение в БД:** `CHAR(42)`, lowercase, с префиксом `0x`. CHECK-constraint
  фиксирует формат (см. `db-schema.sql`).
- **API (запросы и ответы):** lowercase.
- **JWT `sub`:** lowercase.
- **Фронт-отображение пользователю:** checksum-form через `viem.getAddress`. Внутри
  React/JS state — тоже lowercase, чтобы сравнения работали через `===`.
- **Web3-вызовы:** `Web3.to_checksum_address(addr)` непосредственно перед вызовом
  чейна (web3.py требует checksum для transactionrequest, но возвращает варианты).

Хелперы — `backend/shared/eth.py`:
```python
def lc(addr: str) -> str: return addr.lower()
def chk(addr: str) -> str: return Web3.to_checksum_address(addr)
def is_address(s: str) -> bool: ...  # regex + checksum-safe
```

### 4.2 Wei / uint256

- В Python — `int` (произвольная точность).
- На границе API — десятичная строка (см. [api-spec.md](api-spec.md) §1.2).
- В БД — `NUMERIC(78, 0)` (см. `db-schema.sql`).
- В JS — `bigint` (никогда `Number` для wei-сумм).

Хелпер `from_wei(value, decimals=18) -> Decimal` — только для отображения;
**арифметика** делается в `int` wei до самого последнего момента.

## 5. Файловая раскладка backend/

```
backend/
├── pyproject.toml              # ruff / black / mypy / pytest конфиги
├── requirements.txt
├── requirements-dev.txt
├── Dockerfile
├── run_api.py                  # точка входа: gunicorn вызывает create_app()
├── run_worker.py               # точка входа: while True: tick()
├── alembic.ini                 # миграции
│
├── shared/                     # ВСЁ, что используется и API, и worker'ом
│   ├── __init__.py
│   ├── config.py               # singleton + env-loading
│   ├── db.py                   # connection pool, get_conn(), retry
│   ├── models/                 # дата-классы (не ORM) с типизацией
│   │   ├── token.py
│   │   ├── event.py
│   │   ├── market_state.py
│   │   ├── limit_order.py
│   │   └── ...
│   ├── repo/                   # CRUD-функции; чистый SQL, без ORM
│   │   ├── tokens.py
│   │   ├── events.py
│   │   ├── market_state.py
│   │   └── limit_orders.py
│   ├── eth.py                  # web3 client, address хелперы, multicall3
│   ├── price.py                # _market_price, _price_chain, current_price_of
│   ├── chart.py                # build_candles, build_points
│   ├── pnl.py                  # avg-cost арифметика (см. architecture.md §7.1)
│   ├── events.py               # decode_log, scan_hook_logs
│   ├── siwe.py                 # SIWE message format + verify
│   ├── jwt.py                  # encode/decode HS256
│   ├── access.py               # hasAccess() cache + контракт-чтение
│   ├── orders.py               # EIP-712 hashing, verify, status-машина
│   ├── notify.py               # LISTEN/NOTIFY обёртки
│   ├── serial.py               # to_camel / from_camel
│   └── log.py                  # настройка structlog
│
├── app/                        # Flask API
│   ├── __init__.py             # create_app(); регистрирует blueprint'ы
│   ├── deps.py                 # @require_premium, @require_auth декораторы
│   ├── errors.py               # RFC 7807 problem+json
│   ├── limits.py               # flask-limiter конфиг
│   ├── sse.py                  # /api/v1/stream
│   └── routes/
│       ├── auth.py             # /auth/nonce, /auth/verify, /auth/logout
│       ├── config.py           # /config
│       ├── tokens.py           # /tokens, /tokens/{addr}/chart, /trades, /position
│       ├── access.py           # /access
│       ├── profile.py          # /profile
│       ├── orders.py           # /orders, /orders/{id}, /orders/armed
│       ├── health.py           # /health
│       └── telegram.py         # /telegram/webhook (фаза 3)
│
├── worker/                     # фоновые циклы
│   ├── __init__.py
│   ├── main.py                 # run_worker.py → here
│   ├── price_loop.py           # 5s tick: prices, change_pct, holders_count
│   ├── event_loop.py           # 5s tick: scan новые блоки, write events
│   ├── backfill.py             # одноразовый исторический скан
│   ├── keeper.py               # лимит-ордера: trigger check + execute()
│   ├── alerts.py               # фаза 3 (Telegram outbound)
│   ├── operator_alerts.py      # MVP: алерты оператору в личный TG
│   └── nonces.py               # чистка протухших auth_nonces
│
├── migrations/                 # Alembic, генерируется руками
│   ├── env.py
│   └── versions/
│       └── 0001_initial.py     # CREATE TABLE из db-schema.sql
│
├── data/
│   └── tokens.json             # seed
│
└── tests/
    ├── unit/
    │   ├── test_price.py
    │   ├── test_pnl.py
    │   ├── test_orders.py      # EIP-712 hashing
    │   └── test_siwe.py
    └── integration/
        ├── test_auth_flow.py
        ├── test_orders_api.py
        └── conftest.py         # фикстуры: tmp Postgres (testcontainers), фейк-RPC
```

**Принципы:**
- `shared/` — чистая логика, импортируется и `app/`, и `worker/`. **Не наоборот.**
- `app/routes/*` — тонкие; вся бизнес-логика в `shared/`.
- Никаких глобальных мутабельных объектов (старый `cache = {}` из портативки не
  переносим — состояние в Postgres).

## 6. Файловая раскладка frontend/

```
frontend/
├── package.json
├── vite.config.js
├── .eslintrc.cjs
├── .prettierrc
├── index.html                  # SPA entry
├── public/                     # статические ассеты
├── src/
│   ├── main.js                 # bootstrap
│   ├── api.js                  # fetch-обёртки, cursor pagination
│   ├── sse.js                  # EventSource client
│   ├── wallet.js               # wagmi/core + WalletConnect setup
│   ├── eth.js                  # viem clients, контракты, ABI
│   ├── siwe.js                 # SIWE flow
│   ├── access.js               # premium gating
│   ├── chart.js                # lightweight-charts wrapper
│   ├── trades.js               # таблица сделок
│   ├── holders.js
│   ├── wallet-panel.js         # My Wallet вкладка
│   ├── orders.js               # лимит-ордера UI + EIP-712 sign
│   ├── profile.js              # портфолио-вид
│   ├── trade-panel.js          # маркет-торговля
│   ├── watchlist.js            # localStorage
│   └── ui/                     # переиспользуемые UI-блоки
│       ├── modal.js
│       ├── toast.js
│       └── ...
└── tests/                      # vitest + happy-dom
```

**ABI — единая корневая директория.** Все ABI-файлы лежат в `abis/` в корне репо
(см. architecture.md §16). Backend импортирует их относительным путём из
`backend/shared/eth.py` (`Path(__file__).parents[2] / "abis" / "Hook.json"`),
frontend — через Vite (`import HookAbi from '../../abis/Hook.json'`).
**Никаких копий внутри `backend/shared/` или `frontend/src/`** — расхождение
между копиями превращается в трудно ловимый баг.

Watchlist localStorage:
```
key:   "pt:watchlist"
value: JSON.stringify({ tokens: ["0xabc...", "0xdef..."] })
```
Лимит — **50 токенов** (фронт обрезает при добавлении сверх лимита, показывает
toast «watchlist full»). С 48+144=192 токенов реалистичный сценарий ≤30.

**SIWE address.** Перед формированием SIWE-сообщения фронт обязан пропустить
адрес кошелька через `viem.getAddress(account)` — это даёт EIP-55 checksum-вариант,
которого требует шаблон сообщения в [api-spec.md](api-spec.md) §2.2. Сравнение
с серверным JWT-адресом (lowercase) делается через нормализацию обеих сторон —
никогда строкой как есть.

## 7. Файловая раскладка contracts/

```
contracts/
├── foundry.toml
├── remappings.txt
├── lib/                        # forge install: OZ contracts
├── src/
│   ├── PitchTerminalAccess.sol
│   └── LimitOrderExecutor.sol
├── interfaces/
│   ├── IHook.sol
│   ├── IRouter.sol
│   └── IPitch.sol
├── test/
│   ├── PitchTerminalAccess.t.sol
│   ├── LimitOrderExecutor.t.sol
│   ├── LimitOrderExecutor.fork.t.sol  # Base mainnet fork — реальный своп
│   └── mocks/
│       ├── MockPitch.sol
│       ├── MockHook.sol
│       └── MockRouter.sol
└── script/
    ├── DeployAccess.s.sol
    ├── DeployExecutor.s.sol
    ├── Whitelist.s.sol         # grantAccess / grantBatch / revokeAccess
    ├── SetPrice.s.sol          # setPrice(uint256)
    └── TransferOwnership.s.sol # transferOwnership / acceptOwnership
```

## 8. Логирование

- **structlog** в backend; формат JSON (один объект на строку).
- Поля: `time`, `level`, `event`, `component` (`api`|`worker`|`keeper`|`backfill`),
  плюс контекст (`addr`, `orderId`, `block`, `txHash`).
- Никаких `print()` в коде — только в `dev/scripts/`.
- **Логи в stdout** → Docker подбирает; Docker `log-driver: local`, `max-size: 50m`,
  `max-file: 5`.

Уровни:
- `ERROR` — необработанные исключения, реверты `execute()` терминальные.
- `WARN` — транзиентный сбой RPC, переход в fallback.
- `INFO` — старт цикла, успешный execute, сделка отправлена.
- `DEBUG` — детали; в проде отключено через env `LOG_LEVEL=INFO`.

**Redaction policy (обязательно).** В логах НИКОГДА не должны появляться:
- `JWT_SECRET`, `KEEPER_PRIVATE_KEY`, любые `*_TOKEN` env vars целиком.
- Сырое тело `pt_session` cookie / JWT-токен — только хеш (`sha256[:8]`) для
  корреляции.
- Подписи (`signature` поля ордеров и SIWE) — только префикс 10 символов.
- Тело SIWE-сообщения целиком — только `address` + `nonce` (для отладки).
- Тело `Set-Cookie` и `Authorization` заголовков.

Имплементация: хелпер `shared/log.py:redact(value, kind)` + structlog
processor, обходящий event-dict и применяющий redaction по конвенции имён
полей (всё с `secret`, `token`, `signature`, `sig`, `cookie`, `password`,
`private` в имени — автозамена на `<redacted>`).

Тест: специальный `tests/unit/test_log_redaction.py` логирует фиксированные
структуры → проверяет, что чувствительные значения не появились в выводе.

## 9. Конфигурация и env vars

Полный список `.env` (на VPS, никогда в git):

| Переменная | Где | Назначение |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | docker compose (postgres-init) | Init credentials для контейнера БД. На проде ОБЯЗАТЕЛЬНО непустые (см. plans/infra.md §I0.6). |
| `DATABASE_URL` | api, worker | `postgresql://user:pass@host:5432/db` |
| `JWT_SECRET` | api | HS256 секрет, ≥32 случайных байта |
| `RPC_URL` | worker, api | Primary RPC (Alchemy) |
| `RPC_URL_FALLBACK` | worker, api | Public Base RPC |
| `KEEPER_PRIVATE_KEY` | worker | Газ-кошелёк кипера |
| `KEEPER_GAS_THRESHOLD_WEI` | worker | Порог алерта о низком балансе (default 10000000000000000 = 0.01 ETH) |
| `OPERATOR_TG_BOT_TOKEN` | worker | Bot token для алертов оператору (MVP) |
| `OPERATOR_TG_CHAT_ID` | worker | Личный chat_id оператора |
| `USER_TG_BOT_TOKEN` | worker, api | Bot token для алертов пользователям (фаза 3) |
| `TELEGRAM_WEBHOOK_SECRET` | api | Секрет URL-пути webhook (фаза 3) |
| `ACCESS_CONTRACT` | api, worker | Адрес `PitchTerminalAccess` |
| `EXECUTOR_CONTRACT` | api, worker | Адрес `LimitOrderExecutor` |
| `PLAYER_ROUTER` / `COUNTRY_ROUTER` | api, worker | pitchwc роутеры |
| `PLAYER_HOOK` / `COUNTRY_HOOK` | api, worker | pitchwc хуки |
| `PITCH_TOKEN` | api, worker | PITCH ERC20 |
| `WALLETCONNECT_PROJECT_ID` | api (отдаётся в `/config`) | WC Cloud project ID |
| `SIWE_DOMAIN` | api | `pitchterminal.app` (или поддомен) |
| `SIWE_URI` | api | `https://pitchterminal.app` |
| `FRESHNESS_THRESHOLD_SEC` | api, worker | default 30 |
| `MAX_SLIPPAGE_BPS` | api, frontend (via /config) | default 1000 (10%) |
| `LOG_LEVEL` | api, worker | `INFO` / `DEBUG` |
| `GAS_MULTIPLIER` | worker | default 1.5 |
| `CHUNK_BLOCKS_DEFAULT` | worker | default 5000 (Alchemy) |
| `CHUNK_BLOCKS_FALLBACK` | worker | default 2000 (public) |
| `REORG_LAG_BLOCKS` | worker | default 5 (Base finality быстрая) |

**Hardcoded константы** (не env — меняются только при ре-деплое pitchwc):
- `HOOK_DEPLOY_BLOCK = 46167000` в `backend/shared/config.py` — стартовый блок
  бэкфилла.
- `FEE_BPS = 500` в Solidity (`LimitOrderExecutor.sol`) — 5% комиссия pitchwc.
- `MULTICALL3 = 0xca11bde05977b3631167028862bE2a173976CA11` — канонический
  адрес Multicall3 на всех EVM-сетях; константа в `shared/eth.py`.
| `ORDER_COOLDOWN_SEC` | worker | default 60 — пауза между попытками execute одного ордера после revert (см. api-spec.md §7.1) |
| `RECEIPT_TIMEOUT_SEC` | worker | default 120 — после этого подвисшая executing-tx переподаётся с тем же nonce и повышенным газом (replacement-tx) |
| `ACCESS_DEPLOY_BLOCK` | worker | Стартовый блок для access_event_loop (индексатор PriceChanged + ReferralSplitUpdated). Default 0 = «использовать head при первом запуске» (access_bootstrap зафиксирует ID). Заполняется после деплоя PitchTerminalAccess (см. plans/contracts.md C0.5). |

**Deploy-only** (читаются только forge-скриптами на машине разработчика, **НЕ** runtime — backend их не загружает):

| Переменная | Где | Назначение |
|---|---|---|
| `TREASURY` | forge script DeployAccess | Адрес-получатель выручки (immutable после деплоя). |
| `OWNER` | forge script DeployAccess | Адрес owner (Ownable2Step). Управляет ценой, реферал-split'ом, whitelist'ом. |
| `ACCESS_PRICE` | forge script DeployAccess | Начальная цена доступа в wei. Default `1000000000000000000` (1 PITCH). |
| `ACCESS_BUYER_DISCOUNT_BPS` | forge script DeployAccess | Начальная скидка покупателю в bps. Default 2500 (25%). Сумма с `ACCESS_REFERRAL_BPS` не превышает 5000. |
| `ACCESS_REFERRAL_BPS` | forge script DeployAccess | Начальный кешбэк реферреру в bps. Default 2500 (25%). |
| `BASESCAN_KEY` | forge verify | API-key для verify на Basescan. |
| `RPC_URL_BASE_MAINNET` | forge script / forge verify | RPC для деплоя (может отличаться от runtime `RPC_URL`). |

`.env.example` отражает структуру со значениями-заглушками; ни одного реального
секрета.

Загрузка: `python-dotenv` для локалки; на VPS — Docker Compose `env_file:`.

**Ротация секретов.**
- `JWT_SECRET` — при смене **все существующие сессии инвалидируются**, пользователи
  делают повторный SIWE-вход. Для solo-проекта это приемлемо; ротация — по
  инциденту/раз в полгода, не по расписанию. Без двойного-секрета grace-period
  (over-engineering).
- `TELEGRAM_WEBHOOK_SECRET` — ротация требует переустановки webhook через
  Telegram `setWebhook` с новым `secret_token`.
- `KEEPER_PRIVATE_KEY` — ротация = создать новый кошелёк, пополнить ETH, обновить
  env, рестарт worker. Старый кошелёк продолжит держать остаток (вывод
  отдельной tx-ой).
- `OPERATOR_TG_BOT_TOKEN` / `USER_TG_BOT_TOKEN` — перевыпуск через BotFather
  `/revoke`.

## 10. Тестирование

### 10.1 Pyramidic

- **Unit** (быстро, в памяти) — `backend/tests/unit/`. Цены, PnL, EIP-712 hashing,
  SIWE-парсер, переходы статусов. Цель — 100% по чистой логике в `shared/price.py`,
  `shared/pnl.py`, `shared/orders.py`, `shared/siwe.py`.
- **Integration** — `backend/tests/integration/`. Реальный Postgres
  (`testcontainers-python`), фейк-RPC (`web3.eth.contract` с записанными
  response'ами). Покрывают auth-флоу, создание ордера end-to-end, premium-гейт.
- **Contract tests** (Foundry) — `contracts/test/`. Близко к 100% веток.
  Fork-тесты против Base mainnet для финального e2e свопа.
- **Frontend** — `vitest` + `happy-dom` для функций (`api.js`, `siwe.js`,
  `orders.js`). UI-смок — ручной.

### 10.2 Фикстуры

- `MockPitch`, `MockHook`, `MockRouter` — для unit-тестов контрактов.
- Один **Foundry fork** на `BASE_RPC_URL` — для финального теста executor'а.
- `pytest` фикстура `clean_db` — пересоздаёт схему перед каждым integration-тестом.

### 10.3 Команды

```bash
# Backend
cd backend && pytest -x

# Contracts
cd contracts && forge test -vvv
cd contracts && forge test --match-contract Fork --fork-url $BASE_RPC_URL

# Frontend
cd frontend && pnpm test
```

## 11. Git и PR-процесс

- Один монорепозиторий, без подмодулей.
- Ветки фич — `feat/<short-desc>`, фиксы — `fix/<short-desc>`.
- PR — обязательная ревью одним собой (через GitHub review tooling) **и**
  прогон `ultrareview` перед мёрджем фаз 0–2.
- Коммиты — conventional commits (`feat:`, `fix:`, `chore:`, `docs:`) — облегчает
  changelog.
- Тег = `v0.X` после каждой завершённой фазы.

## 12. Definition of Done по фазам

Фаза считается завершённой, когда **все пункты** ниже выполнены — частично «готовое»
не мёрджится в `main`.

### Фаза 0 — Фундамент + монетизация

- [ ] Postgres-схема развёрнута; миграция 0001 проходит на пустой БД.
- [ ] `tokens.json` отсеяден; 48 стран + 144 игрока в `tokens`.
- [ ] Worker крутит `price_loop` и `event_loop`; `market_state` обновляется ≤5с.
- [ ] Бэкфилл с `HOOK_DEPLOY_BLOCK` завершён; все исторические события в БД.
      **API не открывается публично** до `app_state.backfill_status.complete = true`
      — это инвариант, на который опираются `holders_count`, `change_pct`,
      пагинация trades и индикатор «my position». До завершения бэкфилла Caddy
      отдаёт страницу-заглушку «warming up».
- [ ] API отвечает `200 OK` на `/health`, `/config`, `/tokens`, `/tokens/{a}/chart`,
      `/tokens/{a}/trades`, `/stream` (FREE-каналы).
- [ ] SIWE-флоу: подключение → подпись → JWT-cookie → `/access` отдаёт `false`.
- [ ] `PitchTerminalAccess` задеплоен на Base mainnet, верифицирован на Basescan.
- [ ] Платёж 1 PITCH с тестового кошелька переключает `hasAccess` → `true`.
- [ ] `/access?fresh=1` мгновенно отражает новый статус.
- [ ] `/profile` гейчен (`@require_premium`); проверено и 401, и 402, и 200.
- [ ] VPS поднят, Caddy раздаёт фронт + проксирует `/api`, HTTPS работает.
- [ ] CI: push в `main` → тесты → сборка → деплой на VPS → `/health` пингуется.
- [ ] Smoke-проверка работает (скрипт в `scripts/`).
- [ ] Бэкап БД настроен (cron + `pg_dump`).
- [ ] Operator-Telegram алерт работает (тестовое сообщение получено).

### Фаза 1 — Некастодиальная торговля

- [ ] WalletConnect-подключение и MetaMask/injected — оба пути работают.
- [ ] Переключение сети на Base из UI — работает.
- [ ] Маркет-сделка end-to-end: quote → approve (если нужен) → swap → receipt → UI
      показывает результат.
- [ ] Своя сделка появляется на графике в ≤5с после receipt'а.
- [ ] Удалены роуты `/api/trade`, `/api/quote`, `/api/wallet` из портативки
      (тесты ловят возврат 404).
- [ ] Кнопки 25/50/75/Max работают.
- [ ] Разбивка комиссии в UI явная (5% pitchwc).
- [ ] Покупка игрока требует и проверяет наличие токена страны.
- [ ] Soft-lock UI для не-premium (размытие + замок-оверлей).

### Фаза 2 — Авто-исполняемые лимит-ордера

- [ ] `LimitOrderExecutor` задеплоен и верифицирован.
- [ ] **Аудит/ревью** контракта выполнен (внешний или паритетный); все findings
      ≥ medium закрыты.
- [ ] Foundry fork-test: реальный своп через executor на Base mainnet прошёл
      ≥ 1 раз на каждом venue (player и country, обе стороны).
- [ ] EIP-712 cross-check (см. [eip712.md](eip712.md) §7) выполнен и закоммичен
      как тест.
- [ ] Подпись viem ↔ Solidity digest совпадает (с учётом `quoteToken` в Order).
- [ ] Проверено: для venue=country контракт реверитнет, если quoteToken ≠ PITCH.
- [ ] Проверено: для venue=player с неверным quoteToken router pitchwc реверитнет
      и tx откатывается без потери средств пользователя.
- [ ] Создание ордера в UI → строка появляется в `/orders`.
- [ ] Keeper срабатывает при достижении цели → статус `executing` → `filled` (в
      успешном кейсе).
- [ ] Реверт по «цена ушла» оставляет `pending` (см. [api-spec.md](api-spec.md) §7.1).
- [ ] TTL-экспирация переводит в `expired`.
- [ ] Per-user kill-switch блокирует исполнение, не отменяя ордера.
- [ ] On-chain `cancel(nonce)` помечает nonce использованным.
- [ ] Server-side cancel → `cancelled`.

### Фаза 3 — Telegram-алерты

- [ ] Бот зарегистрирован в BotFather, webhook настроен.
- [ ] Deep-link `/start <token>` создаёт `telegram_links` запись.
- [ ] Алерт на `filled` доходит до пользовательского чата.
- [ ] Алерт на `failed` доходит.
- [ ] Алерт на `expired` доходит.
- [ ] Пользователь может «отвязать» в профиле — записи удаляются.
