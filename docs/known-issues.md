# Known issues — live testing log

Список UX/behavioral недочётов найденных во время и после soft launch
(production: <https://pitchwc-terminal.xyz>). Сюда попадают вещи которые
работают «не как ожидалось», но не блокируют core flow. Каждый item
получает фикс в одном из батчей фазы 1.4-refinement или фазы 2.

Формат:
- **#N** [area] — описание.
  - **Severity:** P1 (broken UX) / P2 (annoyance) / P3 (polish).
  - **Repro:** как воспроизвести.
  - **Fix:** предположение/направление.
  - **Found:** YYYY-MM-DD.
  - **Status:** open / in-progress / done (commit).

---

## Open

### #1 [chart] Default chart type — candlesticks
- **Severity:** P1.
- **Repro:** открыть любой токен, посмотреть chart.
- **Issue:** график рендерится свечами (candlesticks) по умолчанию. При редких
  трейдах (1-2 в день) свечи выглядят пусто/ужасно — большие гэпы между
  свечами, нет визуального ощущения тренда.
- **Fix:** дефолт сменить на line chart. Свечи оставить как опцию toggle для
  пользователей с активным графиком (player с большим volume).
- **Found:** 2026-05-24.
- **Status:** open.

### #2 [access] Premium-gating не применяется при смене кошелька
- **Severity:** P1 (security/billing bypass).
- **Repro:** 1) подключить wallet-A с paid access → premium-зона разблокирована.
  2) сменить wallet на wallet-B (без оплаты). 3) bottom-tabs «My wallet» /
  «Orders» и Trade panel (market) **остаются доступны** под wallet-B.
- **Issue:** soft-lock / премиум-проверка не reactive на смену address. Премиум
  state остаётся «зависшим» от wallet-A. По сути не-premium юзер может
  торговать через UI, заплативший — оплачивает за всех в той же сессии браузера.
- **Fix:** access-store должен подписываться на `onAccountChange` (или
  эквивалент) и пересчитывать `hasAccess` при каждом switch wallet'а.
  Возможно проблема в том что bootstrap делает access-check один раз и кеширует.
- **Found:** 2026-05-24.
- **Status:** open.

### #3 [chart] Нет filter-кнопок над графиком (other/own trades, avg, buys/sells)
- **Severity:** P2.
- **Repro:** premium-режим, открыт токен с trades.
- **Issue:** spec предполагает overlay-кнопки над графиком: показать
  чужие сделки / свои сделки / avg price / только buys / только sells. Сейчас
  кнопок нет вообще — ни в premium, ни в не-premium.
- **Fix:** добавить overlay-tools панель. Дизайн взять из portable
  PitchTerminal (там это было). Гейтить по premium.
- **Found:** 2026-05-24.
- **Status:** open.

### #4 [header] Profile кнопка должна быть отдельно от Connect Wallet
- **Severity:** P2.
- **Repro:** подключить кошелёк → найти как попасть в Profile.
- **Issue:** сейчас Profile-переход совмещён с Connect Wallet'ом (видимо
  через dropdown). Должен быть **отдельная кнопка** в header'е, не там же
  где Connect Wallet. И доступна только в premium-подписке (для не-premium
  скрыта или disabled с tooltip'ом «требуется доступ»).
- **Fix:** разнести в header'е: `[Connect Wallet] [Profile (premium only)] [Referral]`.
- **Found:** 2026-05-24.
- **Status:** open.

### #5 [header] Кнопка Referral в header'е (copy ref-link)
- **Severity:** P2.
- **Repro:** premium-режим, найти как поделиться ref-ссылкой.
- **Issue:** нет видимой кнопки для referral в header'е. Сейчас ref-флоу
  спрятан где-то (в Profile?). Юзер не понимает как поделиться своей ссылкой.
- **Fix:** добавить кнопку «Referral» в header рядом с Profile. По клику —
  copy ref-link в clipboard + toast «Referral link copied». Истории
  рефералов в MVP **не делаем** — отложено на post-MVP (см. #5a ниже).
- **Found:** 2026-05-24.
- **Status:** open.

### #6 [design] Общий visual redesign frontend'а
- **Severity:** P1 (отталкивает юзеров).
- **Issue:** текущий UI выглядит сырым/ugly — может отталкивать пользователей.
  Нужен полноценный visual overhaul (layout, typography, colors, spacing, hover-states).
- **Source:** user сделал наброски в Claude Design, поделится скринами (лимиты
  Claude Design кончились — будут только статические скрины, не HTML).
- **Fix:** отдельная design-iteration после получения скринов. Скорее всего
  большой батч полу-механической вёрстки по reference-скринам.
- **Found:** 2026-05-24.
- **Status:** open (ждёт скрины от user).

### #7 [sidebar] Токены не отсортированы по цене (most expensive first)
- **Severity:** P2.
- **Repro:** left sidebar, list токенов player/country.
- **Issue:** токены в случайном порядке. Должны быть отсортированы по цене
  убывающе (most expensive → cheapest).
- **Caveat:** сейчас у всех `pricePitch=0` (worker ещё backfill'ит события
  с `HOOK_DEPLOY_BLOCK`). После backfill сортировка может оказаться правильной
  если backend уже sort'ит по price. **Проверить:** есть ли `ORDER BY` в
  `/api/v1/tokens` или сортировка делается на фронте.
- **Found:** 2026-05-24.
- **Status:** open (зависит от worker backfill для верификации).

### #5a [referral] История рефералов (post-MVP)
- **Severity:** P3.
- **Issue:** UI чтобы посмотреть кто пришёл по твоему ref-коду и сколько
  начислено treasury split'ов.
- **Fix:** отдельная вкладка/секция в Profile со списком ref-purchases.
  Backend уже индексирует `AccessPurchased.referrer` — данных хватит.
- **Found:** 2026-05-24.
- **Status:** **deferred** (post-MVP, не входит в фазу 1).

---

## Done

(пусто пока)
