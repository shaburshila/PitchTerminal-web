# PitchTerminal-web — API Specification

> Полный контракт REST + SSE между фронтом и бэкендом. Этот документ — источник
> истины для разработки клиента и сервера; расхождение с ним — баг.
>
> Связанные документы: [architecture.md](architecture.md) §6.4 (обзорная таблица),
> [db-schema.sql](db-schema.sql) (источник данных), [eip712.md](eip712.md) (формат
> ордеров для `POST /api/v1/orders`).

## Содержание
1. [Общие соглашения](#1-общие-соглашения)
2. [Аутентификация](#2-аутентификация)
3. [Конфиг и публичные эндпоинты](#3-конфиг-и-публичные-эндпоинты)
4. [Токены и рыночные данные](#4-токены-и-рыночные-данные)
5. [Доступ и платежи](#5-доступ-и-платежи) (включая §5.2 реферальные коды)
6. [Профиль и позиции](#6-профиль-и-позиции)
7. [Лимит-ордера](#7-лимит-ордера)
8. [SSE-поток](#8-sse-поток)
9. [Health](#9-health)
10. [Telegram webhook](#10-telegram-webhook)
11. [Сводная таблица rate-limits](#11-сводная-таблица-rate-limits)

---

## 1. Общие соглашения

### 1.1 Версионирование и базовый URL

Все эндпоинты — под префиксом `/api/v1/`. Версия меняется только при breaking change
формата; до публичного запуска версия `v1` фиксирована.

Same-origin: фронт и API живут на одном домене (Caddy); никаких CORS-заголовков
сервер не выдаёт — кросс-оригин запросы пресекаются на уровне браузера.

### 1.2 Формат данных

- **JSON-кодировка:** UTF-8. Ключи — `camelCase` (на сервере конвертация из
  `snake_case` БД-моделей).
- **Адреса:** в запросах и ответах — `0x`-префикс, **lowercase**. Checksum — только для
  отображения, на стороне фронта (`viem.getAddress`).
- **Wei-значения** (баланс, supply, amounts): десятичная строка (`"1000000000000000000"`),
  никогда `number` (JS теряет точность за 2^53). Цены, выраженные как **float**
  (точнее: преобразованные из wei в `decimal` с округлением для отображения), — `number`,
  но с явной precision: 6 знаков для цены, 4 для объёма.
- **Время:** unix-секунды (целое, UTC) в полях `timestamp`, `ts`, `time`, `createdAt`,
  `expiresAt`. ISO-8601 не используется.
- **Идентификаторы ордеров:** `bigint`-строка для совместимости (`"1234"`), хотя текущие
  значения помещаются в `number`.

### 1.3 Коды ответа

| Код | Когда |
|---|---|
| 200 | Успех (с телом) |
| 204 | Успех без тела (`DELETE`, некоторые `PUT`) |
| 400 | Невалидные параметры (формат, диапазон) |
| 401 | Не залогинен (JWT отсутствует или невалиден) |
| 402 | Залогинен, но не оплатил доступ (premium-эндпоинты) |
| 403 | Зарезервирован — для будущих owner-only операций |
| 404 | Ресурс не найден (неизвестный токен, чужой ордер, итд) |
| 409 | Конфликт (дубликат nonce ордера) |
| 422 | Бизнес-валидация не прошла (нельзя поставить уже сработанный ордер) |
| 429 | Rate-limit; в ответе заголовок `Retry-After` (секунды) |
| 500 | Внутренняя ошибка |
| 503 | Backing-сервисы недоступны (Postgres лёг) — health отдаст детали |

### 1.4 Формат ошибок (RFC 7807)

`Content-Type: application/problem+json`. Тело:

```json
{
  "type": "https://pitchterminal.app/problems/invalid-signature",
  "title": "Invalid SIWE signature",
  "status": 401,
  "detail": "Signature does not match address.",
  "code": "auth.siwe.invalid_signature"
}
```

Поле `code` — стабильный machine-readable идентификатор; именно по нему фронт ветвится.
`type` URL необязательно резолвится в страницу; это просто стабильный идентификатор.
Не закладываем дополнительные поля в ошибки без явного описания здесь.

**Каталог `code`** (полный, исчерпывающий):

| `code` | HTTP | Семантика |
|---|---|---|
| `auth.unauthenticated` | 401 | Нет валидного JWT |
| `auth.siwe.invalid_signature` | 401 | SIWE-подпись не сошлась |
| `auth.siwe.invalid_nonce` | 401 | Nonce не выдан / уже использован / истёк |
| `auth.siwe.invalid_domain` | 401 | Домен/chain в SIWE не совпали с серверным |
| `auth.siwe.expired_message` | 401 | `expirationTime` в SIWE прошёл |
| `access.payment_required` | 402 | `hasAccess(addr)` = false |
| `tokens.unknown` | 404 | Токен не из реестра |
| `orders.not_found` | 404 | Ордер не существует или принадлежит другому |
| `orders.duplicate_nonce` | 409 | Owner+nonce уже есть в БД |
| `orders.invalid_signature` | 422 | EIP-712 подпись не проверилась |
| `orders.bad_target_price` | 422 | Целевая цена уже выполнима (мгновенное срабатывание блокируется на стадии создания) |
| `orders.bad_quote_token` | 422 | `quoteToken` не соответствует ожидаемой quote-валюте пары |
| `orders.slippage_too_high` | 422 | `slippageBps` > `MAX_SLIPPAGE_BPS` |
| `orders.expired` | 422 | `expiry` уже прошёл при создании |
| `referral.not_found` | 404 | Code не зарегистрирован |
| `referral.invalid_format` | 422 | Code не соответствует `^[a-z0-9_-]{4,32}$` или начинается/кончается на `-`/`_` |
| `referral.reserved` | 422 | Code в reserved-списке (`api`, `admin`, …) |
| `referral.taken` | 409 | Code уже claim'нут другим кошельком |
| `validation.bad_request` | 400 | Generic — формат поля не пройден |
| `rate_limit.exceeded` | 429 | См. `Retry-After` |
| `server.internal` | 500 | Непредвиденная ошибка |
| `server.degraded` | 503 | Postgres/worker недоступны |

### 1.5 Пагинация

Cursor-based, opaque-курсор для клиента. **Сортировка зависит от ресурса.**

**Запрос:**
- `?limit=` — целое, 1..500, default 100.
- `?cursor=` — opaque-строка из предыдущего ответа.

**Ответ:**
```json
{
  "items": [...],
  "nextCursor": "eyJiIjoxMjM0NTY3OCwibCI6MH0",  // null если страница последняя
  "limit": 100
}
```

**Внутреннее устройство курсора** (base64url-encoded JSON):

| Ресурс | Сортировка | Курсор | Почему |
|---|---|---|---|
| `tokens/{token}/trades` | `(block_number DESC, log_index DESC)` | `{"b": 12345678, "l": 3}` | События могут получить более высокий `events.id` чем у новых сделок, если бэкфилл идёт позже инкремента → сортировка по id нестабильна во времени |
| `profile.trades` | `(block_number DESC, log_index DESC)` | то же | Та же причина |
| `orders` | `id DESC` | `{"id": 1234}` | Ордера никогда не бэкфиллятся — `limit_orders.id` монотонен во времени |

При курсоре `{"b": B, "l": L}` следующая страница берёт записи, где
`block_number < B OR (block_number = B AND log_index < L)`.

**Гарантия монотонности (важно):** API открывается только после завершения
бэкфилла (см. Definition of Done фазы 0 в [conventions.md](conventions.md) §12).
После этого любые новые события приходят с `block_number ≥` максимального в БД —
сортировка по блоку остаётся монотонной во времени. До завершения бэкфилла
эндпоинты trades/profile могут возвращать неполные данные с заголовком
`X-Backfill-Status: in-progress` (для разработки/тестов).

### 1.6 Идемпотентность и retry

- `GET` — идемпотентны по определению.
- `POST /api/v1/orders` — идемпотентен по `(owner, nonce)` подписанного ордера.
  При повторной отправке того же тела возвращает 200 с тем же ордером (а не 409).
- `DELETE /api/v1/orders/{id}` — идемпотентен; повтор на уже отменённом → 204.
- `PUT /api/v1/orders/armed` — идемпотентен (set, не toggle).
- **Исключение:** `POST /api/v1/auth/verify` — **не идемпотентен**. SIWE-nonce
  одноразовый: первый запрос помечает nonce использованным; повторный с тем же
  телом получит 401 `auth.siwe.invalid_nonce`. Фронт делает запрос ровно один раз;
  при сетевом сбое — запрашивает новый nonce через `/auth/nonce` и подписывает
  заново.

### 1.7 Аутентификация транспорта

JWT передаётся в **httpOnly cookie** `pt_session` (`SameSite=Lax`, `Secure`, `Path=/`).
Заголовок `Authorization` НЕ поддерживается — единственный путь cookie.

`EventSource` (SSE) автоматически прикладывает cookie — отдельной авторизации SSE нет.

---

## 2. Аутентификация

### 2.1 `GET /api/v1/auth/nonce`

Выдаёт одноразовый SIWE-nonce.

**Запрос:** без параметров.

**Ответ 200:**
```json
{
  "nonce": "8aB2cdef9G",
  "issuedAt": 1709000000,
  "expiresAt": 1709000300
}
```

- `nonce` — 16+ символов, alphanumeric (требование EIP-4361).
- TTL — 5 минут от `issuedAt`. После этого верификация вернёт `auth.siwe.invalid_nonce`.

**Rate-limit:** 30 / минута / IP.

### 2.2 `POST /api/v1/auth/verify`

Принимает подписанное SIWE-сообщение, проверяет, выдаёт JWT-cookie.

**Запрос:**
```json
{
  "message": "pitchterminal.app wants you to sign in...\n\nURI: https://pitchterminal.app\nVersion: 1\nChain ID: 8453\nNonce: 8aB2cdef9G\nIssued At: 2026-05-23T12:00:00Z\nExpiration Time: 2026-05-23T12:05:00Z",
  "signature": "0x..."
}
```

**Шаблон SIWE-сообщения** (фиксированный, сервер проверяет посимвольно по этому шаблону):
```
{DOMAIN} wants you to sign in with your Ethereum account:
{ADDRESS_CHECKSUM}

Sign in to PitchTerminal.

URI: https://{DOMAIN}
Version: 1
Chain ID: 8453
Nonce: {NONCE}
Issued At: {ISO8601_UTC}
Expiration Time: {ISO8601_UTC_PLUS_5MIN}
```

Поля `Statement`, `Domain`, `URI`, `Chain ID` сервер проверяет на точное совпадение.
`Expiration Time` ≤ `issuedAt + 5min`.

**Ответ 200:**
```json
{
  "address": "0x71ecd1a09380ca46cca741bc48d04c556674756f"
}
```

Cookie `pt_session` ставится `Set-Cookie`:
```
Set-Cookie: pt_session=<jwt>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=259200
```

**JWT (HS256):**
```json
{
  "iss": "pitchterminal-api",
  "aud": "pitchterminal-web",
  "sub": "0x71ecd1a09380ca46cca741bc48d04c556674756f",
  "iat": 1709000000,
  "exp": 1709259200
}
```

- Алгоритм: HS256 (один секрет на всех API-процессах через env `JWT_SECRET`).
- TTL: 72 часа. По истечении — повторный SIWE.
- `sub` — lowercase-адрес с `0x`-префиксом.

**Ошибки:** 401 `auth.siwe.*` (см. каталог §1.4).

**Rate-limit:** 10 / минута / IP.

### 2.3 `POST /api/v1/auth/logout`

Сбрасывает cookie.

**Ответ 204.** `Set-Cookie: pt_session=; Max-Age=0`.

Любой пользователь, даже без валидной сессии, получает 204 — выход не требует
аутентификации (это сброс клиентского cookie).

---

## 3. Конфиг и публичные эндпоинты

### 3.1 `GET /`

SPA — сервер отдаёт `frontend/dist/index.html`. Всё остальное под `/api/`.

### 3.2 `GET /api/v1/config`

Bootstrap-конфиг фронта. Доступ FREE.

**Ответ 200:**
```json
{
  "chainId": 8453,
  "chainName": "Base",
  "contracts": {
    "pitch": "0xeae13ea73bec936664a51734c8c01ec7c3b0699c",
    "playerRouter": "0x5f231aea5abd403af0e8a32c1fef85a9a3ec5622",
    "countryRouter": "0x61cad011db02d9924257f536bfd1ea615e42bb9d",
    "playerHook": "0xd5252a67935fc6b913c4441ac0e5ebf3219faaa8",
    "countryHook": "0x...",
    "multicall3": "0xca11bde05977b3631167028862be2a173976ca11",
    "access": "0x...",
    "limitOrderExecutor": "0x..."
  },
  "accessPriceWei": "1000000000000000000",
  "buyerDiscountBps": 2500,
  "referralBps": 2500,
  "walletConnect": {
    "projectId": "abc123..."
  },
  "limits": {
    "maxSlippageBps": 1000,
    "limitOrderTtlPresets": [0, 900, 1800, 3600, 10800, 21600, 43200, 86400, 259200, 604800]
  },
  "siwe": {
    "domain": "pitchterminal.app",
    "uri": "https://pitchterminal.app"
  },
  "freshnessThresholdSec": 30
}
```

Адреса — lowercase. `limitOrderTtlPresets` — секунды; 0 = «без срока».
`buyerDiscountBps` — текущая скидка покупателю в bps от полной цены при покупке
через валидного реферрера; `referralBps` — текущая доля реферрера в bps от
полной цены. Сумма `buyerDiscountBps + referralBps ≤ 5000`. Оба значения
вместе с `accessPriceWei` читаются из снимка `app_state.access_config` (worker
индексирует события `PriceChanged` / `ReferralSplitUpdated` от
`PitchTerminalAccess` и обновляет снимок + NOTIFY `pt_config`, см. §8.3).

**Кэш и invalidation:** эндпоинт кэшируется на 60 секунд на стороне API.
**Когда worker детектит on-chain изменение** (`setPrice` или
`setReferralSplit`) — кэш инвалидируется немедленно через LISTEN `pt_config`,
и одновременно изменение пушится в SSE-канал `config`.

**Query-param `?fresh=1`** — обходит кэш и читает свежее значение из
`app_state.access_config`. Используется фронтом непосредственно перед
`buyAccess` для защиты от гонки с только что прилетевшим `setPrice`.
Rate-limit: 10 / минута / IP.

---

## 4. Токены и рыночные данные

### 4.1 `GET /api/v1/tokens`

Списки всех токенов + текущие цены/метрики. Доступ FREE.

**Запрос:** без параметров.

**Ответ 200:**
```json
{
  "players": [
    {
      "address": "0x...",
      "name": "Player Name",
      "symbol": "PLR",
      "country": "Brazil",
      "countryAddress": "0x...",
      "role": "captain",
      "pricePitch": 12.345678,
      "priceCountry": 0.001234,
      "supply": "960000000000000000000000",
      "tradesCount": 1234,
      "holdersCount": 56,
      "changePct": {
        "all": 12.3, "1d": -2.1, "12h": 1.0, "6h": 0.5, "1h": 0.1, "15m": 0.0
      }
    }
  ],
  "countries": [
    {
      "address": "0x...",
      "name": "Brazil",
      "symbol": "BRA",
      "pricePitch": 0.001234,
      "supply": "960000000000000000000000",
      "tradesCount": 567,
      "holdersCount": 89,
      "changePct": { "all": 5.0, "1d": 0.0, "12h": 0.0, "6h": 0.0, "1h": 0.0, "15m": 0.0 }
    }
  ],
  "lastUpdate": 1709000000,
  "stale": false
}
```

- `role` ∈ `"best"|"captain"|"rookie"`. У стран поля `role`, `country`,
  `countryAddress` отсутствуют (не null — отсутствуют ключи).
- `stale=true` если `now - lastUpdate > config.freshnessThresholdSec`.
- Списки несортированные — фронт сортирует.
- Формулы `changePct`, `holdersCount`, `tradesCount` — см.
  [port-from-portable.md](port-from-portable.md) §5.1. Корректны только после
  завершения бэкфилла; API не открывается до этого момента (DoD фазы 0).

### 4.2 `GET /api/v1/tokens/{token}/chart`

Свечи и точки сделок для графика. Доступ FREE.

**Параметры пути:**
- `{token}` — lowercase-адрес.

**Query:**
- `tf` — `1m|5m|15m|1h|4h|1d` (default `5m`).
- `unit` — `pitch|country` (default `pitch`). Денонимация OHLC + `spot`-точки. Для
  country-токенов оба варианта эквивалентны (страны торгуются непосредственно в
  PITCH). Для player-токенов `unit=country` возвращает нативные значения кривой (в
  родительском country-токене); `unit=pitch` домножает каждую свечу/точку на
  историческую цену `country → PITCH` на момент свечи. Если у player'а нет
  `country_address` (не должно случаться для seed-данных) → 400.

**Ответ 200:**
```json
{
  "kind": "player",
  "name": "Player Name",
  "symbol": "PLR",
  "country": "Brazil",
  "unit": "pitch",
  "candles": [
    { "time": 1709000000, "open": 12.345678, "high": 12.5, "low": 12.3, "close": 12.4, "volume": 100.5 }
  ],
  "points": [
    { "time": 1709000005, "price": 12.34, "volume": 5.0, "type": "buy", "trader": "0x..." },
    { "time": 1709000010, "price": 12.35, "volume": 0, "type": "spot", "trader": "" }
  ]
}
```

- `type` ∈ `"buy"|"sell"|"spot"`. `spot` — синтетическая точка с текущей ценой (последняя
  в массиве).
- Цены — fee-excluded (рыночные). Эффективная цена — только в `trades`.
- `candles` идут возрастанием времени, без дыр (отсутствующие интервалы заполняются
  предыдущим close).
- `unit` в ответе эхом возвращает выбранную денонимацию (помогает фронту убедиться,
  что сервер обработал query, прежде чем перерисовывать график).
- Свечи / точки player-токена при `unit=pitch`, время которых предшествует первой
  сделке его country-токена, отсутствуют в ответе (ratio неизвестен) — graceful skip,
  ошибки не будет.

**Ошибки:** 404 `tokens.unknown`, 400 `validation.bad_request` (некорректные `tf` /
`unit` / отсутствующий `country_address` у player при `unit=pitch`).

### 4.3 `GET /api/v1/tokens/{token}/trades`

История сделок + холдеры + (для premium) PnL подключённого кошелька по этому токену.

**Доступ:** базовые данные (`trades`, `wallets`, `totalTrades`) — FREE. Поле `myWallet`
— HARD-lock (premium): хотя PnL вычисляется из публичных on-chain событий, его
формирование на сервере стоит CPU/RPC, поэтому это серверная функция за paywall'ом.
Для не-premium запрос успешен (200), но `myWallet = { "configured": false }`.

**Query:**
- `limit`, `cursor` — пагинация (§1.5). По умолчанию `limit=100`.

**Ответ 200:**
```json
{
  "trades": {
    "items": [
      {
        "type": "buy",
        "trader": "0x...",
        "baseValue": 12.5,
        "tokenValue": 1.0,
        "price": 12.5,
        "marketPrice": 11.875,
        "fee": 0.625,
        "tx": "0x...",
        "timestamp": 1709000000,
        "walletPosition": 1.0,
        "walletBuys": 1,
        "walletSells": 0
      }
    ],
    "nextCursor": null,
    "limit": 100
  },
  "wallets": [
    {
      "address": "0x...",
      "buys": 3,
      "sells": 1,
      "position": 2.5,
      "spent": 30.0,
      "received": 12.5,
      "avgBuy": 11.875,
      "avgNet": 7.0
    }
  ],
  "totalTrades": 1234,
  "myWallet": {
    "configured": true,
    "address": "0x...",
    "hasActivity": true,
    "buys": 1,
    "sells": 0,
    "position": 1.0,
    "positionValue": 12.35,
    "spent": 12.5,
    "received": 0,
    "tokensSold": 0,
    "avgBuy": 12.5,
    "breakEven": 12.5,
    "currentPrice": 12.35,
    "realizedPnl": 0,
    "unrealizedPnl": -0.15,
    "totalPnl": -0.15,
    "totalPnlPct": -1.2,
    "breakEvenDistPct": -1.2,
    "feesPaid": 0.625,
    "ownershipPct": 0.001,
    "rank": 7,
    "holdersCount": 12,
    "firstTradeTs": 1708900000,
    "holdingDays": 1.2
  }
}
```

Если запрашивающий — не premium: поле `myWallet` = `{ "configured": false }`
(401 не отдаём — публичные данные `trades`/`wallets` всё равно показываются).

Поля `trades.items[*]`, `wallets[*]` — выходят на UI без дополнительной обработки.
Логика расчёта — портируется из `server.py:710` (см. `port-from-portable.md`).

**Ошибки:** 404 `tokens.unknown`.

### 4.4 `GET /api/v1/tokens/{token}/position`

PnL подключённого кошелька по конкретному токену.

**Доступ:** PREMIUM. Возвращает 401/402 при отсутствии сессии/доступа.

**Ответ 200:** идентично `trades.myWallet` из §4.3, но без `wallets`/`trades`.

Дублирует данные `trades.myWallet`; нужен фронту для вкладки **My Wallet** в нижнем
блоке, чтобы не тянуть весь список сделок.

---

## 5. Доступ и платежи

### 5.1 `GET /api/v1/access`

Текущий статус premium для пользователя сессии.

**Доступ:** AUTH (без оплаты — для определения, нужна ли оплата).

**Query:**
- `fresh=1` — обходит кэш, читает `hasAccess` напрямую из контракта. Rate-limited.

**Ответ 200:**
```json
{
  "address": "0x...",
  "hasAccess": true,
  "source": "paid",
  "cachedAt": 1709000000,
  "checkedAt": 1709000005
}
```

- `source` ∈ `"paid"|"whitelisted"|"none"`. При `hasAccess=false` → `"none"`.
- `cachedAt`/`checkedAt`: первое — когда значение было получено из чейна;
  второе — когда последний раз отдано. Совпадают, если `fresh=1`.

**Кэш на сервере** (§8.3 architecture.md):
- `hasAccess=true` → TTL ~1 час.
- `hasAccess=false` → TTL ~30 с (~60 с верхняя граница).
- Fail-open при недоступном RPC: возвращаем `cached` значение `true` несмотря на
  истёкший TTL; в ответе `checkedAt` — старый.

**Rate-limit с `fresh=1`:** 5 / минута / address.

### 5.2 Реферальные коды

Opt-in читаемый handle, который при подстановке в `?ref=` резолвится в адрес
владельца и передаётся в `buyAccess(referrer)`. Доступен любому залогиненному
(не требует premium — наоборот, новые пользователи должны мочь шарить ссылку
до оплаты).

#### 5.2.1 `GET /api/v1/ref/{code}`

Резолв `code → wallet`. Доступ FREE.

**Path:**
- `code` — строка, до 32 символов. Если формат невалиден — 404 (не 422), чтобы
  фронт не должен был дублировать regex.

**Ответ 200:**
```json
{
  "code": "alex42",
  "wallet": "0x71ecd1a09380ca46cca741bc48d04c556674756f"
}
```

**Ошибки:**
- 404 `referral.not_found` — code не зарегистрирован или формат невалидный.

**Cache-Control:** `public, max-age=60` для 200, `no-store` для 404.

#### 5.2.2 `GET /api/v1/ref/me`

Текущий handle подключённого кошелька. Доступ AUTH.

**Ответ 200:**
```json
{
  "code": "alex42",
  "wallet": "0x71ecd1a09380ca46cca741bc48d04c556674756f",
  "claimedAt": 1709000000
}
```

**Ошибки:**
- 404 `referral.not_found` — пользователь ничего не claim'ал.

#### 5.2.3 `PUT /api/v1/ref/me`

Атомарно создать/сменить/освободить свой handle. Доступ AUTH.

**Body (создание/смена):**
```json
{ "code": "alex42" }
```

**Body (освобождение):**
```json
{ "code": null }
```
или пустое тело (`Content-Length: 0`).

**Семантика:** один кошелёк = один handle. Сервер выполняет
`DELETE WHERE owner=… ; INSERT (code, owner)` в одной транзакции под уникальным
индексом — race с одновременным claim'ом другого пользователя резолвится
postgres'ом как 409.

**Ответ 200** (после создания/смены):
```json
{
  "code": "alex42",
  "wallet": "0x71ecd1a09380ca46cca741bc48d04c556674756f",
  "claimedAt": 1709000000
}
```

**Ответ 204** — после освобождения (`code: null`).

**Ошибки:**
- 422 `referral.invalid_format` — не подходит под `^[a-z0-9_-]{4,32}$` или
  начинается/кончается на `-`/`_`.
- 422 `referral.reserved` — code в reserved-списке.
- 409 `referral.taken` — code уже claim'нут другим кошельком.

#### 5.2.4 `DELETE /api/v1/ref/me`

UX-шорткат, эквивалентный `PUT /api/v1/ref/me` с пустым телом. Доступ AUTH.
**Идемпотентно:** 204 в любом случае (нет handle → тоже 204).

---

## 6. Профиль и позиции

### 6.1 `GET /api/v1/profile`

Портфолио-вид подключённого кошелька. Доступ PREMIUM.

**Query:**
- `tradesLimit`, `tradesCursor` — пагинация только для блока `trades` (остальное —
  целиком; объём небольшой). Default `tradesLimit=100`.

**Ответ 200:**
```json
{
  "address": "0x...",
  "summary": {
    "totalValuePitch": 1234.56,
    "realizedPnlPitch": 100.0,
    "unrealizedPnlPitch": -50.0,
    "totalPnlPitch": 50.0,
    "roiPct": 5.0,
    "openPositions": 4,
    "feesPaidPitch": 12.34
  },
  "positions": [
    {
      "token": "0x...",
      "symbol": "PLR",
      "kind": "player",
      "country": "Brazil",
      "role": "captain",
      "qty": 1.0,
      "avgBuy": 12.5,
      "currentPrice": 12.35,
      "valuePitch": 12.35,
      "unrealizedPnlPitch": -0.15,
      "unrealizedPct": -1.2,
      "sharePct": 1.0
    }
  ],
  "closed": [
    {
      "token": "0x...",
      "symbol": "PLR",
      "kind": "player",
      "country": "Brazil",
      "realizedPnlPitch": 10.5,
      "buys": 3,
      "sells": 3,
      "lastTs": 1709000000
    }
  ],
  "trades": {
    "items": [
      {
        "symbol": "PLR", "kind": "player", "type": "buy",
        "price": 12.5, "marketPrice": 11.875,
        "amount": 1.0, "valuePitch": 12.35,
        "feePitch": 0.625,
        "timestamp": 1709000000, "tx": "0x..."
      }
    ],
    "nextCursor": "eyJpZCI6NDJ9",
    "limit": 100
  },
  "stats": {
    "totalTrades": 100, "buys": 60, "sells": 40,
    "volumePitch": 5000.0, "avgTradePitch": 50.0,
    "feesPaidPitch": 12.34,
    "closedPositions": 5, "winRatePct": 60.0,
    "best": { "symbol": "PLR", "pnlPitch": 20.0 },
    "worst": { "symbol": "PLR2", "pnlPitch": -5.0 }
  },
  "allocation": {
    "byCountry": { "Brazil": 800.0, "Germany": 434.56 },
    "byRole": { "captain": 600.0, "best": 400.0, "rookie": 234.56 },
    "players": 1000.0,
    "countries": 234.56
  },
  "balances": {
    "ethWei": "12345...",
    "pitchWei": "98765...",
    "countries": [
      { "address": "0x...", "symbol": "BRA", "wei": "1000..." }
    ]
  },
  "valueSeries": [
    { "time": 1708000000, "value": 1000.0 },
    { "time": 1709000000, "value": 1234.56 }
  ]
}
```

Логика расчёта — портируется из `server.py:1373`. Семантика полей идентична
портативной версии.

**Семантика `balances`:** только торгуемые quote-токены — ETH (для газа),
PITCH, country-токены. Player-токены **не показываются** в `balances` — они
отражены как открытые позиции в `positions[]` (так короче и совпадает с тем,
что нужно для UI: «сколько у меня PITCH чтобы купить ещё»). Если у
пользователя есть токены, не прошедшие через наш индекс сделок (переведены
извне), PnL и `positions[]` их не увидят — это известное ограничение,
вытекающее из принципа «source of truth = наши events».

**Ошибки:** 401 / 402.

### 6.2 `GET /api/v1/portfolio`

Лёгкий мульти-токен срез позиций подключённого кошелька — все токены (country
и player), у которых **net wei-position > 0**. Используется фронтом для
вкладки **My Wallet** в нижнем блоке и для player-dots в сайдбаре. В отличие
от `/api/v1/profile` (§6.1) не возвращает trades-список, on-chain balances и
valueSeries — только массив позиций.

**Доступ:** PREMIUM. Возвращает 401/402 при отсутствии сессии/доступа.

**Запрос:** без параметров. Пагинация не нужна (юзер обычно держит <50
токенов; на лимиты упремся только в синтетических нагрузочных тестах).

**Ответ 200:**
```json
{
  "items": [
    {
      "token": "0x...",
      "symbol": "PLR",
      "kind": "player",
      "balance": "2000000000000000000",
      "balanceDisplay": 2.0,
      "avgEntryPitch": "2000000000000000000",
      "currentPricePitch": "2000000000000000000",
      "valuePitch": "4000000000000000000",
      "pnlPitch": "0",
      "avgEntryPitchDisplay": 2.0,
      "currentPricePitchDisplay": 2.0,
      "valuePitchDisplay": 4.0,
      "pnlPitchDisplay": 0.0,
      "feesPaidWei": "0",
      "spentBaseWei": "4000000000000000000",
      "receivedBaseWei": "0"
    }
  ]
}
```

**Семантика полей:**

- `balance`, `avgEntryPitch`, `currentPricePitch`, `valuePitch`, `pnlPitch` —
  все wei-строки (NUMERIC(78,0), без потери точности). `pnlPitch` может быть
  отрицательной строкой (например `"-4000000000000000000"`).
- `balanceDisplay`, `*Display` — float-эквиваленты (округление до
  4 знаков для объёма / 6 для цены) для удобства рендеринга в HTML без
  BigInt-математики на фронте.
- `avgEntryPitch` — fee-inclusive cost basis (`Σspent / Σbought`), для
  player-токенов конвертирован в PITCH через текущую `market_state.price_pitch`
  страны игрока. **Историческая цена страны на момент покупки** при этом
  не учитывается — то же ограничение, что и `profile.positions[*].currentPrice`
  для портативной версии; точный исторический breakeven доступен в
  `/api/v1/profile` через сегмент `valueSeries`.
- `valuePitch = balance * currentPricePitch / 1e18`.
- `pnlPitch = valuePitch - balance * avgEntryPitch / 1e18`. Реалайзованную
  часть P&L здесь НЕ показываем — открытая позиция, точка.
- `feesPaidWei`, `spentBaseWei`, `receivedBaseWei` — diagnostics, помогают
  фронту/тестам сверять (`spent - received - fees` агрегаты per token).

**Сортировка ответа:** `valuePitch` desc — крупнейшие холдинги первыми.

**Источник данных:** один SQL JOIN по `events × tokens × market_state`,
без отдельного `wallets`/`positions` индекса (см.
[db-schema.sql](db-schema.sql) — таких таблиц нет; events — source of truth).
Стоимость запроса — O(events_of_wallet). Тяжёлые трейдеры (>10k событий)
получают ~50ms на ответ; индекс `events(trader_address)` обязателен.

**Ошибки:** 401 / 402.

---

## 7. Лимит-ордера

### 7.1 `GET /api/v1/orders`

Список ордеров пользователя. Доступ PREMIUM.

**Query:**
- `status` — фильтр; `pending`, `executing`, `filled`, `failed`, `cancelled`,
  `expired`, или CSV (`pending,executing`). Default — все.
- `token` — фильтр по токену (lowercase-адрес).
- `limit`, `cursor` — пагинация.

**Ответ 200:**
```json
{
  "items": [
    {
      "id": "1234",
      "owner": "0x...",
      "token": "0x...",
      "quoteToken": "0x...",
      "tokenSymbol": "PLR",
      "tokenKind": "player",
      "venue": "player",
      "side": "limit-buy",
      "targetPrice": "1234500000000000000",
      "amountIn": "1000000000000000000",
      "slippageBps": 100,
      "expiresAt": 1709500000,
      "nonce": "0xabcdef...",
      "status": "pending",
      "createdAt": 1709000000,
      "executedTxHash": null,
      "failReason": null,
      "failDetail": null
    }
  ],
  "nextCursor": null,
  "limit": 100,
  "armed": true
}
```

- `venue` ∈ `"player"|"country"` (выбирает Router/Hook).
- `side` ∈ `"limit-buy"|"take-profit"`.
- `targetPrice`, `amountIn` — wei-строки (uint256).
- `expiresAt: null` означает «без срока».
- `status` — текущее значение; переходы см. §7 functional-spec.md и
  таблицу ниже.
- `failReason` (только при `status=failed`) — enum:
  `no_allowance | insufficient_balance | bad_quote_token | router_revert |
  min_out_not_met | expired_on_chain | nonce_used | unknown`. `failDetail` —
  опциональный сырой текст revert'а (для UI/расследования).

**Переходы статусов:**

| Из | В | Кто | Условие |
|---|---|---|---|
| `pending` | `executing` | keeper | Цель достигнута, tx подана; пишет `executed_tx_hash` |
| `executing` | `filled` | keeper | Receipt получен, статус `1`, `OrderExecuted` присутствует |
| `executing` | `failed` | keeper | Receipt со статусом `0` и причина терминальная (нет approve, нет средств, bad quote token) |
| `executing` | `pending` | keeper | Revert по «цена ушла» — ордер живёт дальше; `retry_after = now + COOLDOWN_SEC` |
| `pending` | `cancelled` | API | `DELETE /orders/{id}` |
| `pending` | `expired` | worker | Отдельный цикл — `expires_at ≤ now` |

`armed` дублируется в каждом ответе, чтобы фронт не делал отдельный запрос.

**Защита от tight loop (cooldown).** После каждой попытки `execute()` keeper
ставит `retry_after = now + COOLDOWN_SEC` (default 60 с). Ордер пропускается
на цикле проверки, пока `now < retry_after`. Это закрывает сценарий:
цель сработала → revert по «цена ушла» → следующий тик keeper'а через 5 с
снова видит ту же цель → попытка → снова revert. С cooldown'ом — не чаще раза
в минуту. Поле `attempts` инкрементируется на каждой попытке (для метрик и
ручного расследования; жёсткого лимита попыток нет — пользователь сам
отменяет, если ордер не идёт).

**Recovery подвисших executing-ордеров.** При старте worker'а keeper'а сначала
обходит все ордера в статусе `executing` (индекс `limit_orders_executing_idx`):
для каждого делает `eth_getTransactionReceipt(executed_tx_hash)` и применяет
обычные переходы (`filled` / `failed` / `pending` по причине revert'а). Если
receipt ещё не доступен (tx в mempool) — оставляет в `executing`, дождётся на
следующем тике. Это закрывает дыру «worker упал между подачей tx и приёмом
receipt — ордер навсегда в executing».

### 7.2 `POST /api/v1/orders`

Создаёт новый ордер. Доступ PREMIUM.

**Запрос:**
```json
{
  "order": {
    "owner": "0x71ecd1a09380ca46cca741bc48d04c556674756f",
    "token": "0x...",
    "quoteToken": "0x...",
    "venue": 0,
    "side": 0,
    "targetPrice": "1234500000000000000",
    "amountIn": "1000000000000000000",
    "slippageBps": 100,
    "expiry": 1709500000,
    "nonce": "0xabcdef..."
  },
  "signature": "0x..."
}
```

- Поля точно соответствуют EIP-712 `Order` (см. [eip712.md](eip712.md)).
- `venue`: 0=player, 1=country.
- `side`: 0=limit-buy, 1=take-profit.
- `quoteToken`: для player-venue — адрес country-токена этого игрока (фронт берёт из
  `/api/v1/tokens`); для country-venue — адрес PITCH.
- `expiry`: 0 = без срока; иначе unix-секунды.
- `nonce`: 32-байтовый hex-string (256-битный, рекомендуется случайный).
- Сервер не доверяет полю `owner` запроса — берёт его из JWT и сравнивает; при
  несовпадении 401. Также сервер проверяет `quoteToken` против seed
  (`tokens.country_address` для players, `PITCH_TOKEN` для countries) — несовпадение
  → 422 `orders.bad_quote_token` (защита от опечатки фронта **до** подписи; in-flight
  замена подписи не страшна — контракт всё равно реверитнет).

**Серверные проверки** (до записи в БД):
1. `order.owner` == JWT-адрес.
2. EIP-712 подпись проверяется (ECDSA + EIP-1271) → иначе 422 `orders.invalid_signature`.
3. `slippageBps` ≤ `MAX_SLIPPAGE_BPS` (1000 = 10%) → иначе 422 `orders.slippage_too_high`.
4. `amountIn > 0`.
5. `(owner, nonce)` уникален → иначе 200 (идемпотентность) или 409 при разных полях с
   тем же nonce.
6. `expiry == 0 || expiry > now + 60s` → иначе 422 `orders.expired` (минимальный TTL
   запрещает ордера, истекающие до ближайшего тика кипера).
7. Целевая цена **уже не выполнима** на текущей цене с поправкой 0.1% — иначе 422
   `orders.bad_target_price` (защита от случайной мгновенной сделки; если пользователь
   осознанно делает «маркет под видом лимита», пусть берёт market-режим).
8. Token — из реестра, иначе 404 `tokens.unknown`.

**Ответ 200:** объект-ордер из §7.1.

### 7.3 `DELETE /api/v1/orders/{id}`

Отмена ордера (server-side, бесплатно). Доступ PREMIUM.

- Только pending → cancelled.
- Не свой ордер → 404 (не 403 — не раскрываем существование чужих).
- Уже cancelled/filled/expired → 204 (идемпотентно).

**Ответ 204.**

### 7.4 `PUT /api/v1/orders/armed`

Персональный kill-switch. Доступ PREMIUM.

**Запрос:**
```json
{ "armed": false }
```

**Ответ 200:**
```json
{ "armed": false }
```

Поведение: при `armed=false` keeper пропускает ордера этого пользователя (статус
остаётся `pending`). Этим переключателем пользователь временно ставит все свои
ордера на паузу без отмены.

---

## 8. SSE-поток

### 8.1 `GET /api/v1/stream`

Единый поток `text/event-stream`. Доступ FREE; канал `orders` отдаётся только premium.

**Заголовки ответа:**
```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
```

**Heartbeat:** каждые 25 секунд сервер шлёт comment-line `: keepalive\n\n` —
предотвращает обрыв idle-соединения прокси.

### 8.2 Формат событий

Каждое событие — стандартный SSE:
```
event: prices
id: 12345
data: {"updatedAt": 1709000000, "stale": false, "tokens": [...]}

```

(пустая строка обязательна).

`id` — монотонно растущий serial внутри сессии (не глобальный); фронт может
использовать его для `Last-Event-ID` при реконнекте, но **сервер игнорирует
Last-Event-ID** — фронт сам дотягивает свежее состояние через `GET`.

### 8.3 Каналы и схемы `data`

**`event: prices`** — раз в ~5 с, **дельта** изменившихся токенов:
```json
{
  "updatedAt": 1709000000,
  "stale": false,
  "tokens": [
    {
      "address": "0x...",
      "pricePitch": 12.345678,
      "priceCountry": 0.001234
    }
  ]
}
```
Если ни одна цена не изменилась — событие не шлётся (heartbeat достаточно).
Поле `stale=true` шлётся отдельным событием (с пустым `tokens: []`) ровно один раз
при пересечении freshness threshold — фронт зажигает индикатор и держит до
следующего нормального `prices`-события.

**Механизм формирования дельты** (важно для multi-process API): worker сравнивает
текущий снимок цен с предыдущим in-memory и **публикует NOTIFY `pt_prices` с
payload = JSON-массив изменившихся token-адресов** (lowercase). Каждый API-процесс,
получив NOTIFY, читает `market_state` для именно этих адресов и рассылает SSE
своим подключённым клиентам. См. [db-schema.sql](db-schema.sql) NOTIFY-секция.

**`event: events`** — новые сделки. Worker NOTIFY `pt_events` с
payload = JSON-массив новых `event_id`'ов; API-процесс читает их из `events` и
рассылает.
```json
{
  "newTrades": [
    {
      "token": "0x...",
      "type": "buy",
      "trader": "0x...",
      "baseValue": 12.5,
      "tokenValue": 1.0,
      "price": 12.5,
      "marketPrice": 11.875,
      "fee": 0.625,
      "tx": "0x...",
      "timestamp": 1709000000
    }
  ],
  "balances": [
    { "address": "0x...", "token": "0x...", "wei": "1234500000000000000" }
  ]
}
```
Шлётся только при наличии новых сделок (массив `newTrades` всегда непустой). Фронт
фильтрует по текущему выбранному токену.

**`balances`** (additive поле, добавлено после Phase 2) — post-trade net token
holdings для каждой уникальной пары `(token, trader)`, затронутой в этом батче.
Bonding-curve хуки не имеют контрагента (кривая mint/burn'ит supply), поэтому
у каждого события ровно один `trader` — соответственно `balances[]` содержит
по одной записи на пару. Если одна и та же пара появляется в нескольких трейдах
батча — entry один, с финальным (post-batch) балансом. Источник: re-aggregation
`Σ(buys.token_value) - Σ(sells.token_value)` по `events` (точное wei, NUMERIC
без потери точности). Фронт использует это поле для реактивного обновления
вкладки **Holders** в нижнем блоке без round-trip на `/api/v1/tokens/{token}/trades`.
Отрицательные значения (sell больше предыдущего баланса — возможно только при
out-of-order indexing) clamp'ятся к `"0"` перед отправкой.

**`event: config`** — реактивное обновление полей `/api/v1/config`, изменяющихся
on-chain. Шлётся всем подключённым клиентам (auth-нейтрально, как и сам `/config`).
Триггер: worker детектит событие `PriceChanged` или `ReferralSplitUpdated` от
`PitchTerminalAccess` → обновляет `app_state.access_config` → NOTIFY `pt_config`
с payload-снимком новых значений → каждый API-процесс LISTEN'ит и рассылает SSE.

```json
{
  "accessPriceWei": "2000000000000000000",
  "buyerDiscountBps": 2500,
  "referralBps": 2500,
  "updatedAt": 1709000100,
  "blockNumber": 12345678,
  "txHash": "0x..."
}
```

Поля совпадают с подмножеством `/api/v1/config` — фронт мёрджит в свой
in-memory конфиг и перерисовывает баннер с ценой / скидкой / реферал-долей.
`blockNumber` + `txHash` — для дедупликации (если воркер пере-сканирует диапазон
блоков, одно и то же изменение приходит дважды, фронт игнорирует по `txHash`).

**Defensive re-fetch на pay-click:** даже с SSE push фронт **обязан** делать
`GET /api/v1/config?fresh=1` непосредственно перед формированием tx `buyAccess`
— на случай разрыва SSE / реконнекта без догона / гонки с только что прилетевшим
`setPrice`. См. §3.2 — поддержать query-param `?fresh=1` (обход кэша, чтение из
свежей on-chain выборки worker'а через `app_state.access_config`).

**`event: orders`** (premium) — изменения статусов ордеров пользователя:
```json
{
  "order": {
    "id": "1234",
    "status": "filled",
    "executedTxHash": "0x...",
    "failReason": null
  }
}
```
Поля совпадают с §7.1, но в дельте достаточно `id`+`status`(+`executedTxHash`/`failReason`).
Фронт мёрджит в свой in-memory список.

### 8.4 Жизненный цикл соединения

- Подключение: набор каналов фиксируется в момент `GET`. Если пользователь
  оплатил premium в течение сессии, фронт **переподключается** к `/stream`
  (закрывает старый `EventSource`, открывает новый) — иначе канал `orders` не
  включится.
- Реконнект: нативный `EventSource` сам ретраит (3 секунды по умолчанию). При
  возврате фронт дёргает соответствующие `GET`, чтобы дотянуть пропущенное.
- Лимит соединений: 5 / IP (для всех, включая анонимных); 2 / адрес (для любой
  аутентифицированной сессии — Connected или Premium, не только Premium). 429 при
  превышении. Per-address лимит ловит ситуацию «один пользователь открыл 10 вкладок» —
  на одно устройство достаточно одного соединения; вторая вкладка переиспользует
  через Service Worker (post-MVP) или просто получает 429 (MVP).

---

## 9. Health

### 9.1 `GET /api/v1/health`

Доступ — публичный. Без авторизации.

**Ответ 200:**
```json
{
  "status": "ok",
  "components": {
    "api": "ok",
    "db": "ok",
    "worker": "ok",
    "rpc": "ok"
  },
  "data": {
    "lastPriceUpdate": 1709000000,
    "lastEventBlock": 12345678,
    "freshSec": 4,
    "stale": false
  },
  "version": "0.1.0",
  "checkedAt": 1709000010
}
```

**Ответ 503** (если db недоступна):
```json
{
  "status": "degraded",
  "components": { "api": "ok", "db": "down", "worker": "unknown", "rpc": "unknown" },
  "checkedAt": 1709000010
}
```

**Семантика `components`:**
- `api`: всегда `"ok"` если этот код выполнился (запрос дошёл до handler'а).
- `db`: `"ok"` если `SELECT 1` отвечает < 100 мс; `"slow"` если 100–1000 мс;
  `"down"` если ошибка или таймаут > 1 с. `"down"` → status 503.
- `worker`: `"ok"` если `now - last_price_update < freshnessThresholdSec` (30с);
  `"stale"` иначе. **Никогда не 503 из-за этого**.
- `rpc`: `"ok"` если последний успешный `eth.block_number()` < 30 с назад;
  `"stale"` иначе. Не влияет на status.

Аптайм-монитор смотрит только на корневой `status`.

**Исключение из RFC 7807.** Health-эндпоинт возвращает обычный
`application/json` (а не `application/problem+json`) даже при 503 — это
сделано осознанно: внешние аптайм-мониторы (UptimeRobot, BetterStack) ожидают
плоский JSON со стабильной структурой и не парсят `problem+json`. Это
единственный эндпоинт-исключение; все остальные ошибки следуют §1.4.

---

## 10. Telegram webhook

### 10.1 `POST /api/v1/telegram/webhook`

**Добавляется в фазе 3.** Webhook от Telegram для user-бота алертов.

Принимает payload Telegram (`Update` объект). Логика:
- `/start <token>` — резолвит deep-link токен (TTL 5 минут, single-use) → создаёт
  запись `telegram_links` (chat_id ↔ wallet).
- Прочие сообщения — игнорируются (бот односторонний; пользовательских команд
  больше нет в MVP).

**Безопасность.** Telegram при вызове webhook'а присылает заголовок
`X-Telegram-Bot-Api-Secret-Token: <secret>` (этот secret задаётся при
`setWebhook` через `secret_token`-параметр). Сервер сравнивает значение
константно-временно с `TELEGRAM_WEBHOOK_SECRET`; несовпадение → 404.

Секрет НЕ в URL (`/api/v1/telegram/webhook` — фиксированный путь): URL-pathы
утекают в логах Caddy и могут попадать в reverse-proxy кэши. Заголовок — это
стандартный механизм Telegram, **не** изобретённый велосипед.

Этот эндпоинт **не** проходит через rate-limit (Telegram сам ретраит, нагрузка
предсказуема).

**Ответ 200:** `{ "ok": true }`. Тело Telegram не читает — главное код.

---

## 11. Сводная таблица rate-limits

| Эндпоинт | Лимит | Ключ | Заголовок |
|---|---|---|---|
| `GET /api/v1/auth/nonce` | 30 / мин | IP | — |
| `POST /api/v1/auth/verify` | 10 / мин | IP | — |
| `POST /api/v1/auth/logout` | — | — | — |
| `GET /api/v1/access?fresh=1` | 5 / мин | address | `Retry-After` |
| `GET /api/v1/access` (cached) | 60 / мин | address | — |
| `GET /api/v1/config?fresh=1` | 10 / мин | IP | `Retry-After` |
| `GET /api/v1/config` (cached) | 60 / мин | IP | — |
| `GET /api/v1/ref/{code}` | 120 / мин | IP | — |
| `GET /api/v1/ref/me` | 30 / мин | address | — |
| `PUT /api/v1/ref/me` | 5 / час | address | `Retry-After` |
| `DELETE /api/v1/ref/me` | 5 / час | address | `Retry-After` |
| `POST /api/v1/orders` | 30 / час | address | `Retry-After` |
| `DELETE /api/v1/orders/{id}` | 30 / мин | address | — |
| `PUT /api/v1/orders/armed` | 10 / мин | address | — |
| `GET /api/v1/stream` | 5 conn / IP, 2 / address (любая auth) | (см.) | — |
| Прочие GET | 600 / мин | IP | — |

При превышении — 429, тело `{"code": "rate_limit.exceeded"}`, заголовок
`Retry-After` в секундах.

Сервер: `flask-limiter` для эндпоинтов; Caddy `rate_limit` для глобальной защиты от
ботов. Не закладываем глобальный quota — это про DOS-защиту, а не про монетизацию.
