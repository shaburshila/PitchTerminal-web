# Frontend Agent — пошаговый план

> **Роль:** SPA — vanilla JS + Vite, wagmi/core + viem, WalletConnect,
> lightweight-charts.
> **Не пишет:** Python, Solidity, Docker.
> **Spec-источники:** [../api-spec.md](../api-spec.md), [../eip712.md](../eip712.md),
> [../functional-spec.md](../functional-spec.md), [../conventions.md](../conventions.md)
> §3, §6.
> **Координация:** [README.md](README.md). Любая неоднозначность → эскалировать.

## Границы владения

| Можно править | Только читать |
|---|---|
| `frontend/` (включая Vite-конфиг) | spec-документы |
| Импорты из `../abis/*.json` (read-only) | `backend/`, `contracts/`, `infra/` |

Не трогать: Python, Solidity, Docker.

**Главный принцип:** фронт — это **клиент API**, описанного в
[../api-spec.md](../api-spec.md). Любое расхождение с этим документом — баг
фронта (или баг бэка через эскалацию). Фронт **не изобретает** структуру
данных.

---

## Фаза 0 — Базовый UI + монетизация

### F0.1 — Vite scaffold
**Что:** инициализировать Vite-проект.

**Действия:**
- `cd frontend && pnpm init` (или npm — выбрать один и придерживаться).
- Установить: `vite`, `@wagmi/core`, `viem`, `@walletconnect/ethereum-provider`,
  `lightweight-charts@4.1.3`.
- Dev: `prettier`, `eslint@^9`, `eslint-plugin-import` (v9-совместимая версия —
  `^2.31`), `vitest`, `happy-dom`.
- Node 22+ (требование current pnpm/vite); зафиксировать в `.nvmrc` и `engines.node`.
- Pin `"packageManager": "pnpm@<X.Y.Z>"` в package.json для воспроизводимости.
- `vite.config.js`:
  - Прокси `/api` на `http://localhost:5000` (Flask) для локальной разработки.
  - `build.outDir = 'dist'`.
- `eslint.config.js` (flat config!), `.prettierrc` по
  [../conventions.md](../conventions.md) §2.2.
- `index.html` (минимальный SPA-shell).
- `src/main.js` — `console.log("PT-web loaded")` пока.

**DoD:**
- `pnpm dev` запускает Vite, открывается на `localhost:5173`.
- `pnpm build` создаёт `dist/`.
- `pnpm lint`, `pnpm format --check`, `pnpm test` — все зелёные на пустом проекте.

**Зависит от:** I0.1.

---

### F0.2 — API client (`api.js`)
**Что:** fetch-обёртки для всех REST-эндпоинтов.

**Действия:**
- `src/api.js`:
  - `const API_BASE = '/api/v1'`.
  - Функция `apiFetch(path, opts)`:
    - Кладёт `credentials: 'include'` (для cookie).
    - JSON-парсинг.
    - При не-200 — кидает ошибку с `code`, `status`, `detail` из RFC 7807.
  - Конкретные функции для каждого эндпоинта из api-spec.md:
    - `getConfig()`, `getHealth()`.
    - `getTokens()`, `getChart(addr, tf)`, `getTrades(addr, opts)`.
    - `getAuthNonce()`, `verifySiwe(message, signature)`, `logout()`.
    - `getAccess(fresh)`.
    - `getProfile(opts)`, `getPosition(addr)`.
    - `getOrders(opts)`, `createOrder(order, sig)`, `cancelOrder(id)`, `setArmed(armed)`.
  - Cursor-pagination helper `paginate(fetcher, opts)`.

**DoD:**
- Unit-тесты (vitest + msw для мокания) на каждую функцию.
- Ошибки RFC 7807 правильно парсятся в Error с полями `code`/`status`/`detail`.
- `getConfig()` возвращает форму из §3.2 api-spec.

**Зависит от:** B0.8 (хотя бы `/config`, `/health` от Backend).

**Integration checkpoint:** IC-0.1 (с Backend B0.7).

---

### F0.3 — SSE client (`sse.js`)
**Что:** EventSource-обёртка с реконнектом и фильтрацией.

**Действия:**
- `src/sse.js`:
  - Класс `SSEClient`:
    - `connect()` — открывает `new EventSource('/api/v1/stream', { withCredentials: true })`.
    - Обработчики `prices`, `events`, `orders` — диспатчит в подписчиков.
    - `on(channel, handler)` / `off(channel, handler)`.
    - `reconnect()` — при ошибке (через нативный реконнект EventSource +
      manual после паузы).
    - `refresh()` — после реконнекта или manual вызов: дёргает GET'ы для
      догона состояния (см. §8.4 api-spec).
- Singleton-инстанс — один SSE на всю SPA.

**DoD:**
- Unit-тесты с моком EventSource.
- Live-проверка: бэкенд отправляет `prices` → handler вызывается.

**Зависит от:** B0.9, F0.2.

**Integration checkpoint:** IC-0.2.

---

### F0.4 — Layout: sidebar / center / right panel + header
**Что:** трёхколоночный layout по [../functional-spec.md](../functional-spec.md) §2.

**Действия:**
- `index.html` — CSS Grid с тремя колонками + header + footer.
- `src/layout.js`:
  - Состояние: `selectedToken`, `mode` ('dashboard' | 'profile').
  - Header: логотип + поиск + chip кошелька (или кнопка «Connect»).
  - Sidebar: пустой контейнер (наполняет F0.5).
  - Center: пустой контейнер (наполняет F0.6).
  - Right panel: пустой (наполняет F0.13/F0.14).
  - Footer: ссылки (disclaimer, портативная версия).
- Адаптив: для MVP — минимальная (desktop-first).
- Тема: тёмная (как в портативке).

**DoD:**
- `pnpm dev` показывает layout с заголовком и пустыми блоками.
- Окно меньше 1024px — корректный degrade (хотя бы не сломанный).

---

### F0.5 — Token lists (sidebar)
**Что:** Players/Countries вкладки, поиск, фильтры, change% selector, watchlist.

**Действия:**
- `src/token-list.js`:
  - Подписка на SSE `prices` + initial `getTokens()`.
  - Вкладки Players / Countries.
  - Поиск (input → filter).
  - Фильтр ролей (на Players) — best/captain/rookie.
  - Сортировка (price / changePct / volume + asc/desc).
  - change% период selector — all/1d/12h/6h/1h/15m.
  - При клике на токен — `selectedToken` обновляется.
- `src/watchlist.js`:
  - localStorage key `pt:watchlist` (см. [../conventions.md](../conventions.md) §6).
  - Лимит 50 токенов.
  - Звёздочка на строке + фильтр «only favorites».

**DoD:**
- Список из 192 токенов рендерится.
- Поиск, фильтры, сортировка работают.
- Watchlist сохраняется между рестартами вкладки.
- При лимите > 50 → toast «watchlist full».

**Зависит от:** F0.2, F0.4.

---

### F0.6 — Chart (lightweight-charts) + timeframes + stats bar
**Что:** график со свечами/линиями, taймфреймами, stats.

**Действия:**
- `src/chart.js`:
  - `init(token)` — `getChart(token, tf)` → создать `lightweight-charts` series.
  - Toggle линия/свечи; timeframe selector (1m/5m/15m/1h/4h/1d).
  - Unit-переключатель Country/PITCH (у стран скрыт).
  - SSE `prices` → `mainSeries.update(latest)` (никакой пересоздавки).
  - SSE `events` → добавить маркер (фильтр по selectedToken).
  - Stats bar над графиком: цена, change%, supply, market cap, holders.
- Без технических индикаторов.

**DoD:**
- Свечи и линия рендерятся.
- Переключение TF перезагружает данные.
- Реалтайм: новая сделка отражается в течение 5 с.

**Зависит от:** F0.3, F0.5.

---

### F0.7 — Bottom tabs: Trades + Holders
**Что:** нижние FREE вкладки.

**Действия:**
- `src/trades.js`:
  - При смене токена — `getTrades(addr)`, пагинация cursor.
  - Колонки: time / side / amount / price (effective) / market price / address / link to BaseScan.
  - Своих подсветить (если есть JWT и адрес == trader).
- `src/holders.js`:
  - Из ответа `getTrades` — поле `wallets`.
  - Колонки: rank / address / balance / share% / first trade.
  - SSE `events` — частичный refetch.

**DoD:**
- Обе вкладки рендерятся.
- Пагинация работает (нажать «load more» → следующая страница).

**Зависит от:** F0.4.

---

### F0.8 — Watchlist UI (уже частично в F0.5)
*(см. F0.5).*

---

### F0.9 — Wallet connect (wagmi/core + WalletConnect)
**Что:** подключение кошелька, переключение сетей.

**Действия:**
- `src/wallet.js`:
  - Конфиг `@wagmi/core`:
    - Коннекторы: `injected` (MetaMask, Coinbase) + `walletConnect` (с
      `projectId` из `/config`).
    - Chain: Base (8453) + fallback на Base Sepolia (только для dev).
  - Функции: `connect()`, `disconnect()`, `switchChain(8453)`, `getAccount()`.
  - State: текущий address (lowercase), chainId, connected.
- Header chip: показывает адрес (checksum через `viem.getAddress`) или
  «Connect Wallet».
- При не-Base сети → красный индикатор + предложение switch.

**DoD:**
- MetaMask: connect → видно адрес.
- WalletConnect QR: сканировать с телефона → connect.
- Switch на Polygon → красный индикатор + кнопка «Switch to Base».

**Зависит от:** F0.2 (нужен `/config` для projectId).

---

### F0.10 — Wallet UI (chip, dropdown)
*(Частично в F0.9 — здесь дополнить.)*

**Действия:**
- В header chip кошелька — клик открывает dropdown: «View Profile», «Disconnect».
- При клике «View Profile» → `mode = 'profile'` (см. F0.15).

**DoD:** dropdown работает.

---

### F0.11 — SIWE flow
**Что:** SIWE-подпись после connect.

**Действия:**
- `src/siwe.js`:
  - `signIn(account)`:
    1. `getAuthNonce()` → nonce.
    2. Сформировать SIWE-сообщение по шаблону §2.2 api-spec. **Адрес —
       обязательно через `viem.getAddress(account)` (EIP-55 checksum)**;
       lowercase в SIWE-сообщении не примет сервер.
    3. `walletClient.signMessage({ message })` → подпись.
    4. `verifySiwe(message, signature)` → cookie ставится автоматически.
  - Хранение состояния: ничего на клиенте — JWT в cookie, статус premium через `getAccess()`.
- После connect — автоматически предлагает signIn (модалка «Sign in to PitchTerminal»).
- Если cookie уже есть и валидна (`getAccess()` отвечает 200) — пропустить signIn.

**DoD:**
- Полный flow: connect MetaMask → подпись → cookie → `getAccess` отвечает.
- Smart-contract wallet (Coinbase Smart Wallet) — тоже работает (через EIP-1271).
- Истёкший JWT (через 72 часа) — корректно показывает «sign in again».

**Зависит от:** F0.9, B0.10.

**Integration checkpoint:** IC-0.3.

---

### F0.12 — Pay flow (approve + buyAccess(referrer))
**Что:** оплата с учётом двухсторонней реферальной программы; покупатель платит
`price * (1 - buyerDiscountBps/10000)` при наличии валидного реферрера.

**Действия:**
- `src/access.js`:
  - При `hasAccess=false` показывать pay-баннер + кнопку.
  - Pay flow:
    1. **Defensive re-fetch**: `GET /api/v1/config?fresh=1` (см. api-spec §3.2) —
       получить свежие `accessPriceWei`, `buyerDiscountBps`, `referralBps` на
       случай только что прилетевшего `setPrice` / `setReferralSplit`. **Без
       этого** — риск гонки с устаревшими данными в кэше.
    2. Определить `referrer`:
       - Прочитать `localStorage.referralWallet` (см. F0.X ref-link handling).
       - Если адрес == текущий wallet или == адрес Access-контракта (из `/config`)
         → silent skip, `referrer = address(0)`.
       - Иначе → используем сохранённый адрес.
    3. Подсчёт сумм для UI:
       - `hasValidRef = referrer != 0x0…` (после silent-skip)
       - `buyerPayWei = hasValidRef ? price * (10000 - buyerDiscountBps) / 10000 : price`
       - Показать в окне оплаты разбивку: «Цена: X PITCH · Реферал-скидка:
         −Y PITCH (если есть) · К оплате: Z PITCH».
    4. Прочитать `allowance(pitch, owner, accessContract)` через viem.
    5. Если `allowance < buyerPayWei`:
       - **Если allowance > 0 и != buyerPayWei**: сначала `pitch.approve(accessContract, 0)`,
         потом `pitch.approve(accessContract, buyerPayWei)` (две попапа).
         Это защищает от USDT-like токенов; PITCH сейчас — стандартный ERC20,
         но не закладываемся на это.
       - **Если allowance == 0**: один `pitch.approve(accessContract, buyerPayWei)`.
    6. `accessContract.buyAccess(referrer)` (попап) — передаём адрес или
       `0x0000…0000` если реферрера нет.
    7. Дождаться receipt.
    8. `getAccess(fresh=true)` — обходит кэш, моментальная разблокировка.
    9. Reconnect SSE (теперь с каналом orders) — см. F0.13.
- Окно оплаты:
  - Полная цена, скидка (если есть), итог к оплате.
  - Краткое инфо о реферрере: «Поделился с тобой: 0xabc…7f9 (alex42)» (если
    был ref-handle — показать его рядом с адресом).
  - Дисклеймер (см. functional-spec §9).
  - Ссылка на Uniswap (если нет PITCH).
  - Ссылка «Скачать портативную версию».

**DoD:**
- E2E без реферрера: connect → signIn → видит баннер → click «Pay» → MetaMask
  approve на полную `price` → buy(`address(0)`) → через 5с premium разблокирован.
- E2E с валидным реферрером: открыть страницу с `?ref=0xVALID` → localStorage
  записан → Pay → окно показывает скидку → approve на `price * 0.75` → buy(ref) →
  on-chain: ref получает `price * 0.25`, treasury получает `price * 0.5`.
- E2E с self-ref: `?ref=<own_wallet>` → localStorage записан → Pay → silent skip
  на фронте, окно показывает полную цену → tx с `address(0)`.
- E2E с контракт-ref: `?ref=<access_contract_addr>` → silent skip → полная цена.
- Если PITCH < `buyerPayWei` → показывает «Get PITCH on Uniswap» с
  предзаполненным Uniswap URL.

**Зависит от:** F0.11, F0.Xa (ref-link handling), B0.8 (`/config?fresh=1`),
B0.11, C0.5.

**Integration checkpoint:** IC-0.4.

---

### F0.12a — Реферальные ссылки: парсинг URL + резолв + localStorage
**Что:** обработка `?ref=` параметра при первом визите.

**Действия:**
- `src/referral.js`:
  - `parseRefFromUrl() -> string | null` — `new URLSearchParams(location.search).get('ref')?.trim().toLowerCase()`.
  - `resolveRef(raw) -> string | null`:
    - Если `raw` matches `^0x[a-f0-9]{40}$` → возвращает `raw` (адрес в lowercase).
    - Если `raw` matches `^[a-z0-9_-]{4,32}$` → `GET /api/v1/ref/{raw}`:
      - 200 → возвращает `wallet`.
      - 404 → возвращает `null`, пишет в `localStorage.referralUnresolved`
        (для отладки/UX «эта ссылка невалидна»).
    - Иначе → `null` (не пытаемся ходить в API на странных строках).
  - На бутстрапе приложения (до отрисовки):
    1. `raw = parseRefFromUrl()`.
    2. Если `raw == null` — выход (используем то, что уже в localStorage).
    3. Иначе — асинхронно: `wallet = await resolveRef(raw)`. Если резолвилось —
       `localStorage.setItem('referralWallet', wallet)` и `localStorage.setItem('referralRaw', raw)`.
    4. **НЕ удалять `?ref=` из URL** — пользователь может скопировать и
       поделиться дальше.
  - `getEffectiveRef(currentWallet, accessContractAddr) -> string` — возвращает
    `referralWallet` из localStorage с применением silent-skip правил (== own
    wallet или == access contract → `0x0…0`).
- Использование в F0.12 pay-flow (см. выше).
- Тесты:
  - Smoke: `?ref=0xABC123…` → localStorage.referralWallet = lowercase address.
  - `?ref=alex42` → mock API → localStorage = wallet.
  - `?ref=unknown` → 404 → no write, but `referralUnresolved` set.
  - `?ref=Невалидное` → silent ignore (regex не сошёлся).

**DoD:**
- Открыть `https://localhost/?ref=0xVALID` → localStorage.referralWallet записан.
- Открыть `?ref=alex42` (claim'нут в БД) → запрос к `/api/v1/ref/alex42` → wallet
  в localStorage.
- Visit `?ref=alex42` → потом visit `?ref=bob99` → второй переписывает (last wins).
- Без `?ref` — localStorage не трогается.

**Зависит от:** F0.1, F0.2 (API client), B0.11b.

---

### F0.12b — UI claim/release реферального handle (в профиле)
**Что:** UI для регистрации читаемого handle в профиле пользователя.

**Действия:**
- `src/profile-referral.js` — секция в Profile view (`F0.15`):
  - Показывает текущий handle (если есть): «Твоя реферальная ссылка:
    `https://pitchterminal.app/?ref=alex42`» + кнопка copy.
  - Если нет handle — показывает `https://pitchterminal.app/?ref=0xUSER` +
    кнопка «Получить читаемое имя» (открывает модалку).
  - Модалка claim:
    - Инпут с валидацией live (regex `^[a-z0-9_-]{4,32}$`, no leading/trailing,
      not in reserved-список — клиент-side подсказка, сервер всё равно
      перепроверит).
    - Кнопка «Зарезервировать» → `PUT /api/v1/ref/me` body `{code}`:
      - 200 → закрыть модалку, обновить UI секции.
      - 409 `referral.taken` → показать «Это имя уже занято».
      - 422 `referral.reserved` / `referral.invalid_format` → подсветить инпут.
  - Кнопка «Освободить handle» (если есть) → `DELETE /api/v1/ref/me` → 204 → UI
    переключается на показ адреса.
  - Кнопка «Сменить handle» — открывает ту же модалку, при подтверждении
    делает `PUT` (атомарная замена на стороне API).
- На старте профиля — `GET /api/v1/ref/me` → 200 показать handle, 404 →
  показать «нет handle».

**DoD:**
- Connected user → открыть профиль → секция «Реферальная ссылка» видна.
- Claim alex42 → ссылка переключилась.
- Попробовать занять `api` (reserved) → ошибка в UI.
- Сменить на bob99 → атомарная замена, ссылка обновилась.
- Освободить → ссылка вернулась к адресу.

**Зависит от:** F0.11 (SIWE), F0.15 (Profile), B0.11b.

---

### F0.12c — SSE-канал config (реактивное обновление цены / скидок)
**Что:** живое обновление UI при изменении on-chain параметров.

**Действия:**
- В `src/sse.js` (см. F0.3) добавить handler канала `event: config`:
  ```js
  source.addEventListener('config', e => {
      const snap = JSON.parse(e.data);
      configStore.merge({
          accessPriceWei: snap.accessPriceWei,
          buyerDiscountBps: snap.buyerDiscountBps,
          referralBps: snap.referralBps,
      });
      // re-render баннера / окна оплаты, если оно открыто
  });
  ```
- Дедупликация: хранить `lastConfigTxHash` в configStore; игнорировать
  событие, если `snap.txHash === lastConfigTxHash` (защита от повторных
  scan'ов worker'а).
- При первой загрузке `/config` (не SSE) — записать в store как baseline.
- При обрыве/реконнекте SSE — фронт делает `GET /api/v1/config` для catch-up
  (на случай пропущенного `event: config`).

**DoD:**
- Открыть приложение в браузере с DevTools.
- Симуляция: owner-кошелёк делает `setPrice(2e18)` на тестнете.
- В течение ~10 с в DevTools видно `event: config` с новым `accessPriceWei`,
  баннер цены меняется без перезагрузки.
- Аналогично для `setReferralSplit`.

**Зависит от:** F0.3 (SSE client), B0.9.

---

### F0.13 — Premium soft-lock UI
**Что:** blur-оверлеи и баннер для не-premium зон.

**Действия:**
- `src/access.js`:
  - При `hasAccess=false`:
    - Верхняя полоса баннера: «Unlock premium: 1 PITCH, forever — [Pay]».
    - Размытие (blur CSS-filter) на: правая панель (торговля), вкладки My Wallet и Orders, профиль.
    - Поверх blur — overlay с иконкой замка + «Requires payment» + кнопка Pay.
  - При `hasAccess=true` — всё чисто, баннера нет.

**DoD:**
- Скриншот для не-premium: видно ALL зоны, но трейдинг/орlders blur'нуто.
- После оплаты blur пропадает.

**Зависит от:** F0.12.

---

### F0.14 — Bottom tabs: My Wallet + Orders (premium)
**Что:** PnL по токену + локальный orders list.

**Действия:**
- `src/my-wallet-tab.js`:
  - При premium + выбранном токене — `getPosition(addr)`.
  - Не-premium — overlay (см. F0.13).
- `src/orders-tab.js`:
  - `getOrders({ token: selectedToken })` + SSE канал `orders`.
  - Колонки: type / target / amount / slippage / TTL countdown / status.
  - Cancel-кнопка на pending.
  - Kill-switch toggle (set `armed`).

**DoD:**
- My Wallet показывает корректный PnL по токену.
- Orders живые: создание/отмена/исполнение через SSE.

**Зависит от:** F0.13, B0.13.

---

### F0.15 — Profile view
**Что:** портфолио-вид, открывается из header.

**Действия:**
- `src/profile.js`:
  - При `mode = 'profile'` — подменяет центр+правую панель.
  - `getProfile()` → summary, positions, closed, trades (с пагинацией),
    stats, allocation, balances, valueSeries.
  - Подграфик value-over-time (lightweight-charts с line series).
  - Список cross-token orders.
- Возврат в дашборд при клике на токен.

**DoD:**
- Все блоки рендерятся.
- Pagination trades работает (cursor через `{block, logIndex}`).
- Возврат на дашборд по клику на токен.

**Зависит от:** F0.13, B0.13.

**Integration checkpoint:** IC-0.5.

---

## Фаза 1 — Маркет-торговля

### F1.1 — Trade panel (Market)
**Что:** правая панель в режиме Market.

**Действия:**
- `src/trade-panel.js`:
  - Toggle Market/Limit (limit в фазе 2).
  - Buy/Sell tabs.
  - Поля: amount (с кнопками 25/50/75/Max), slippage (default 1%).
  - Live quote: `hook.quoteBuy/quoteSell` через viem (Multicall).
  - Разбивка комиссии (5% pitchwc + slippage).
  - Кнопка disabled, если не на Base.

**DoD:**
- Quote обновляется при изменении amount.
- 25/50/75/Max берут проценты от balance.

**Зависит от:** F0.9.

---

### F1.2 — Approve + swap flow
**Что:** end-to-end market-сделка.

**Действия:**
- В trade-panel:
  - Проверка allowance перед swap.
  - Если < amountIn → approve max (попап).
  - Router.buy/sell с minOut = quote * (1 - slippage).
  - Спиннер «Awaiting receipt…».
  - Toast на успех/ошибку.

**DoD:**
- E2E swap на Base mainnet (маленькой суммой) — успешно.
- График обновляется в течение 5 с (через SSE events).

**Зависит от:** F1.1.

**Integration checkpoint:** IC-1.1.

---

### F1.3 — Player → требует country проверка
**Что:** при покупке player'а — проверить, есть ли country balance.

**Действия:**
- Если выбран player и Buy → показать «Required: <amount> BRA. Your balance: ...».
- Если balance < required → disabled + ссылка купить country на Country panel.

**DoD:** UX подсказывает явно.

---

### F1.4 — refinement
*(Шлифовка: edge-кейсы, ошибочные состояния, retry. Конкретика — по факту
после ручного тестирования.)*

---

## Фаза 2 — Limit orders

### F2.1 — Limit panel
**Что:** в режиме Limit правой панели.

**Действия:**
- Поля: side (buy/sell), target price (с live подсказкой текущей), amount,
  slippage, TTL (preset: none/15m/30m/1h/3h/6h/12h/24h/3d/7d).
- При вводе target — предупреждение если уже выполнимая.

**DoD:** UI рендерится, валидация работает.

---

### F2.2 — Approve UX для executor
**Что:** approve соответствующего токена (см. functional-spec §7 таблица).

**Действия:**
- Перед подписью ордера — проверить allowance input-токена к executor'у.
- Если 0 — попап approve max с явным текстом «Approve <SYMBOL> to enable limit orders».
- См. таблицу в [../functional-spec.md](../functional-spec.md) §7.

**DoD:**
- Для каждой из 4 комбинаций side×venue приходит корректный токен в approve.

---

### F2.3 — EIP-712 sign + createOrder
**Что:** подписать и отправить ордер.

**Действия:**
- `src/orders.js`:
  - `buildOrder(...)` — собирает поля Order (включая `quoteToken` из seed).
  - `signOrder(order)` — viem `signTypedData` с типами из
    [../eip712.md](../eip712.md) §3.4.
  - `createOrder(order, signature)` — POST /orders.
- nonce — случайные 32 байта (`crypto.getRandomValues`).

**DoD:**
- Подпись виден на ledger/MetaMask с человекочитаемыми полями (EIP-712 нативно).
- Backend принимает ордер → 200.
- **Cross-check**: digest, посчитанный фронтом, == digest из forge-теста
  ([../eip712.md](../eip712.md) §7).
- **Wallet test matrix** — ручная проверка минимум на:
  1. MetaMask (browser extension).
  2. Coinbase Smart Wallet (smart-contract wallet, проверяет EIP-1271-путь).
  3. Ledger через MetaMask (hardware).
  Все три дают валидный signature; смарт-кошелёк успешно проверяется
  SignatureChecker на on-chain.

**Зависит от:** B2.1, C2.6.

**Integration checkpoint:** IC-2.1, IC-2.2.

---

### F2.4 — Orders tab live + cancel
*(Уже частично в F0.14 — теперь полноценно с фазой 2.)*

**Действия:**
- Live статусы через SSE.
- Cancel-кнопка на pending → DELETE.
- Visual countdown TTL.
- При filled — toast + ссылка на BaseScan tx.

**DoD:** все статусы корректно отображаются.

---

## Фаза 3 — Telegram

### F3.1 — Привязка Telegram в профиле
**Что:** «Connect Telegram» в профиле.

**Действия:**
- Кнопка «Connect Telegram» → `POST /telegram/link-token` → открывает
  `deepLink` в новой вкладке (`t.me/<bot>?start=<token>`).
- После — polling или SSE-обновление «привязан» (опционально через профиль).
- Кнопка «Disconnect» → `DELETE /telegram/link`.

**DoD:**
- E2E: click → откроется бот → `/start` → backend связал → UI обновился.

---

## Сводный чек-лист DoD Frontend по фазам

См. [../conventions.md](../conventions.md) §12 — пункты, помеченные как
frontend-ответственные:

- **Фаза 0:** layout, sidebar, чарт, нижние вкладки (FREE), wallet connect,
  SIWE, оплата 1 PITCH, soft-lock, profile.
- **Фаза 1:** market-swap UI, approve flow, разбивка комиссии, country requirement.
- **Фаза 2:** limit-panel, EIP-712 подпись, approve UX по 4 комбинациям, live
  orders.
- **Фаза 3:** Telegram-привязка в профиле.
