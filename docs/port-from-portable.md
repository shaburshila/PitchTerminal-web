# Портирование из портативной версии PitchTerminal

> Архитектура говорит «жёсткий форк, общего кода нет». Это значит **нет shared-
> зависимости**, но **не значит «писать заново с нуля»**. Часть логики портативки
> уже корректна и проверена — её копируем в `backend/shared/` с минимальной
> адаптацией. Этот файл — точный map: что портируется, что переписывается, что
> отбрасывается.
>
> Источник — `../PitchTerminal/server.py` (портативка) или текущий `server.py` в
> этом репо до реструктуризации.

## 1. Портируется как есть (с косметической чисткой)

Эти функции — чистая логика, без зависимостей от `cache = {...}` или Flask:

| Портативка (`server.py`) | Веб (`backend/shared/`) | Заметки |
|---|---|---|
| `_decode_log(log, buy_topic)` (стр. 230) | `events.decode_log` | Возвращать датакласс `Event`, не dict |
| `scan_hook_logs(w3, addresses, from_block, to_block)` (стр. 262) | `events.scan_logs` | Размер чанка из `CHUNK_BLOCKS_*` env; sleep между чанками — оставить как есть |
| `_market_price(ev)` (стр. 355) | `price.market_price` | 1-в-1; `Decimal` арифметика обязательна |
| `build_candles(token, tf)` (стр. 368) | `chart.build_candles` | Сейчас читает из глобального `cache["events"]`; в вебе принимает список Event'ов как аргумент. Логика fill-gap копируется |
| `build_points(token)` (стр. 445) | `chart.build_points` | То же что candles |
| PnL-арифметика из `api_trades` (стр. 765–795) | `pnl.wallet_position` | Извлечь как чистую функцию `(events, wallet) -> WalletPosition` |
| Семантика `avgBuy`, `avgNet`, `breakEven` | `pnl.py` | Сохраняем точные формулы (см. комментарии в портативке) |
| `_token_meta` (стр. 1327) | `repo.tokens.meta` | Адаптировать к БД-источнику вместо in-memory |
| Аггрегации `api_profile` (стр. 1373–1572) | `shared/profile.py` | Извлечь как pure-функцию `(events_by_token, balances) -> Profile`. Это самый большой кусок переписывания, но логика та же |

**Принцип:** портируемая функция должна стать **чистой** (без побочных эффектов,
без чтения глобального `cache`). Вход — данные, выход — данные.

## 2. Адаптируется (логика та же, источник другой)

| Портативка | Веб | Что меняется |
|---|---|---|
| `fetch_prices_and_supplies(w3)` (стр. 160) | `shared/eth.py:fetch_market_snapshot` | Один Multicall3 батч, как сейчас; результат пишется в `market_state`, а не в `cache["prices"]` |
| `update_prices()` (стр. 483) | `worker/price_loop.py:tick` | После записи в БД → `NOTIFY pt_prices` (вместо `broadcast_sse` из памяти) |
| `update_events()` (стр. 501) | `worker/event_loop.py:tick` | То же: писать в `events`, `NOTIFY pt_events` |
| `rebuild_player_list()` (стр. 517) | `worker/price_loop.py:rebuild_market_state` | Вычисляет `change_pct`, `trades_count`, `holders_count` из БД — UPSERT в `market_state` |
| `check_limit_orders()` (стр. 1158) | `worker/keeper.py:check_and_execute` | Радикальное переписывание: вместо вызова `execute_trade()` (which signs locally) — вызов `executor.execute(order, sig)` на контракте |
| SSE: `broadcast_sse` (стр. 638) + `api_stream` (стр. 1575) | `app/sse.py` | Замена in-memory `sse_clients[]` на `LISTEN/NOTIFY`-driven рассылку. Каждый API-процесс держит свой пул клиентов и `LISTEN`-loop |

## 3. Переписывается полностью

Эти места портативки **нельзя переносить** — несовместимы с некастодиальной
моделью:

| Портативка | Почему не портируем | Что вместо этого |
|---|---|---|
| `get_wallet()` (стр. 864) — подписывает локальным ключом | Wеб не хранит ключи пользователей | Удаляется. Подпись делается в браузере (viem) |
| `api_wallet()` (стр. 873) | Тот же | Удаляется (в фазе 1 явно убирается) |
| `api_quote()` (стр. 949) | Котировку получает фронт напрямую через `hook.quoteBuy/quoteSell` | Удаляется |
| `execute_trade(...)` (стр. 995) | Кастодиальная отправка | Заменяется на: **(а)** browser-side viem-вызов router для маркет-сделок; **(б)** `LimitOrderExecutor.execute(order, sig)` от имени keeper'а |
| `api_trade()` (стр. 1109) | Те же | Удаляется |
| `api_orders_execute()` (стр. 1298) — ручной execute | Лимит-ордера теперь авто-исполняются контрактом; ручного pull-execute нет | Удаляется |
| `api_orders_arm()` (стр. 1314) | Был глобальный kill-switch на сервере | Заменяется на per-user `PUT /orders/armed` (`user_settings.orders_armed`) |
| `limit_orders.json` хранение (стр. 126, 148) | Файл-based, single-user | Заменяется на таблицу `limit_orders` в Postgres |
| `events_cache.json` (стр. 94, 110) | Файл-based кэш событий | Заменяется на таблицу `events` |
| `cache = {...}` глобальный + `cache_lock`, `events_scan_lock` (по всему файлу) | In-memory state неприменим к многопроцессному API | Удаляется. Источник истины — Postgres |
| `country_backfilled` флаг (стр. 332) | Артефакт ретрофита портативки | Не нужен; первый бэкфилл вебом одноразовый, флаг в `app_state.backfill_status` |
| `LIMIT_REVIEW_THRESHOLD_PCT` + статус `review` (config.py:81) | Отложен на пост-MVP | См. `todo-post-mvp.md` |
| `DISPLAY_WALLET` (env-кошелёк) | Веб мульти-пользовательский — нет «отображаемого» кошелька | Заменяется на JWT-адрес из сессии |

## 4. Отбрасывается полностью

- Всё, что связано с `PRIVATE_KEY` env-переменной.
- `BotFather`-токен для одного пользователя (в портативке его нет, но в случае,
  если был — не переносим).
- Любые «локальные» бэкапы JSON-файлов (`backup_*.json` если такие есть).

## 5. Совершенно новый код (нет аналога в портативке)

Это пишется с нуля; список — чтобы агент понимал, где «нет шаблона»:

- **Контракты** `PitchTerminalAccess`, `LimitOrderExecutor` (Solidity, Foundry).
- **SIWE-flow** — `shared/siwe.py`, `app/routes/auth.py`.
- **JWT** — `shared/jwt.py`.
- **`hasAccess` cache + `@require_premium`** — `shared/access.py`, `app/deps.py`.
- **EIP-712 хеширование и подпись-верификация** — `shared/orders.py` (см.
  [eip712.md](eip712.md)).
- **Status machine лимит-ордеров** — переходы pending → executing → filled/failed
  (см. [api-spec.md](api-spec.md) §7.1).
- **`LISTEN/NOTIFY`-driven SSE** — `app/sse.py`, `worker/*` (через
  `shared/notify.py`).
- **Operator-Telegram алерты** — `worker/operator_alerts.py`.
- **`backend/migrations/0001_initial.py`** — миграция Alembic.
- **Frontend wallet/SIWE/EIP-712** — `frontend/src/wallet.js`, `siwe.js`,
  `orders.js`.
- **Premium-soft-lock UI** — баннер, blur-оверлеи.
- **WalletConnect-настройка** — `frontend/src/wallet.js`.
- **Rate-limiting** — `app/limits.py` (flask-limiter).

## 5.1 Канонические формулы для worker'а

Эти формулы — источник истины для `worker/price_loop.py:rebuild_market_state`.
Любая реализация должна совпадать с ними побитово (на тестах с фиксированными
фикстурами).

### `change_pct_X` — за период X

Для каждого периода `X ∈ {all, 1d, 12h, 6h, 1h, 15m}`:

```
T_horizon = now - X        (для all: T_horizon = -∞)

p_now   = market_state.price_pitch[token]                       -- текущая spot-цена
p_then  = последняя _market_price(event) где event.token = token
          и event.ts <= T_horizon
          (если такой event не существует: change_pct_X = 0)

change_pct_X = (p_now - p_then) / p_then * 100
```

- `_market_price` определена в портативке (server.py:355) — fee-excluded цена сделки;
  портируется в `shared/price.py` без изменений.
- Когда `p_then = 0` (что не должно случаться, но fail-safe): `change_pct_X = 0`.
- `all` означает «с первой сделки этого токена когда-либо»; `p_then` = первая
  сделка.

### `holders_count`

Уникальные владельцы с положительной позицией. SQL-определение:

```sql
SELECT COUNT(DISTINCT trader_address) FROM (
  SELECT trader_address,
         SUM(CASE side WHEN 'buy' THEN token_value ELSE -token_value END) AS net
  FROM events
  WHERE token_address = $1
  GROUP BY trader_address
  HAVING SUM(CASE side WHEN 'buy' THEN token_value ELSE -token_value END) > 0
) sub;
```

Pure: считается из events. Корректен **только после завершения бэкфилла**
(до этого недосчёт). API не открывается до завершения бэкфилла —
см. DoD фазы 0 ([conventions.md](conventions.md) §12).

### `trades_count`

Простой счётчик сделок для токена:

```sql
SELECT COUNT(*) FROM events WHERE token_address = $1;
```

### Периодичность пересчёта

Worker пересчитывает `market_state` (цены + change_pct + holders_count +
trades_count) на каждом тике `price_loop` (~5 с). При большом числе токенов
(192) и небольшом количестве сделок per token это укладывается в один батч
SQL-запросов под 100 мс. Если станет узким местом — добавить инкрементальный
пересчёт (только для токенов с новыми событиями), но это пост-MVP оптимизация.

## 6. Стратегия переноса

Рекомендуемый порядок для фазы 0:

1. Скопировать `server.py` портативки в `backend/_legacy.py` как референс (в
   `.gitignore`-исключение, но **не в commit**). Это рабочий черновик для
   агентов — копируют функции по списку §1, чистят, кладут в `shared/`.
2. Написать `shared/eth.py`, `shared/price.py`, `shared/chart.py`, `shared/pnl.py`
   с тестами **до** того, как API/worker их использует.
3. Подключить `worker/event_loop.py` и `worker/price_loop.py` — пишут в Postgres.
4. Поднять `app/routes/tokens.py` поверх Postgres — без премиум-гейта пока.
5. Добавить SIWE/JWT/Access/Gate — поверх работающего FREE-API.
6. Удалить `backend/_legacy.py`.

Этот порядок гарантирует, что **каждый шаг отдельно проверяем** в браузере
(можно открыть FREE-роуты ещё до того, как готов SIWE).
