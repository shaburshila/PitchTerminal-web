# Contracts Agent — пошаговый план

> **Роль:** Solidity-разработка, Foundry-тесты, деплой и верификация.
> **Не пишет:** Python, JS, Docker.
> **Spec-источники:** [../contracts.md](../contracts.md), [../eip712.md](../eip712.md),
> [../conventions.md](../conventions.md) §2.3, §7, §10, §12.
> **Координация:** [README.md](README.md). Любая неоднозначность → эскалировать.

## Границы владения

| Можно править | Только читать |
|---|---|
| `contracts/` (Foundry-проект) | spec-документы |
| `abis/*.json` (выводит `forge build`) | `.env.example` |
| Описание контрактов в `contracts.md` (через PR-предложение координатору) | `conventions.md` |

Не трогать: `backend/`, `frontend/`, `infra/`.

**Важно:** ABI генерируются `forge build` в `contracts/out/`. Контракт-агент
**копирует/коммитит** релевантные ABI-файлы в корневой `abis/` (после каждого
изменения интерфейса). Backend и Frontend импортируют только из `abis/`.

---

## Фаза 0 — Фундамент (PitchTerminalAccess)

### C0.1 — Foundry scaffold
**Что:** инициализировать Foundry-проект.

**Действия:**
- `cd contracts && forge init --empty --force .` (forge 1.7.1; флаг `--no-commit`
  устарел).
- Удалить артефакты init: `.github/` (родительский CI у нас), нестед `.git/` если
  есть, `README.md` (у нас в корне), `foundry.lock`.
- Установить deps **без submodule** (чтобы не лезть в root `.gitmodules`):
  `forge install OpenZeppelin/openzeppelin-contracts@v5.0.2 --no-git`.
  Также автоматически приходит `forge-std`.
- `foundry.toml`: `solc = "0.8.26"`, `optimizer = true`, `optimizer_runs = 200`,
  `via_ir = false`, `[fmt] line_length = 100`, `tab_width = 4`,
  `bracket_spacing = true`.
- `remappings.txt`: `@openzeppelin/=lib/openzeppelin-contracts/`.
- `contracts/.gitignore` (создаётся forge init): `out/`, `cache/`, `broadcast/`,
  `.env*`, `docs/`.

**Воспроизводимость deps:**
- `contracts/lib/` зашит в **root `.gitignore`** (deps не коммитятся).
- CI/dev перед сборкой делает `forge install` с пинами версий. Точные команды —
  в `contracts/README.md` (создаётся в этом шаге).

**DoD:**
- `forge build` проходит на пустом проекте без ошибок и warnings.
- `forge fmt --check` чисто.
- В git tracked: `contracts/foundry.toml`, `contracts/remappings.txt`,
  `contracts/.gitignore`, `contracts/README.md` (с инструкциями по `forge install`).
- В git untracked (ignored): `contracts/lib/`, `contracts/out/`, `contracts/cache/`.
- Никаких изменений root `.gitmodules`.

**Блокирует:** C0.2.

---

### C0.2 — `PitchTerminalAccess.sol`
**Что:** реализовать контракт доступа согласно [../contracts.md](../contracts.md) §1.
**Двухсторонняя реферальная программа** (Model C): скидка покупателю + кешбэк реферреру.

**Действия:**
- `contracts/src/PitchTerminalAccess.sol`:
  - Constructor: `(IERC20 pitch, address treasury, uint256 price, uint16 buyerDiscountBps, uint16 referralBps, address owner)`
    — все non-zero, `price > 0`,
    `buyerDiscountBps + referralBps ≤ MAX_TOTAL_REFERRAL_BPS`. `pitch` и `treasury`
    — `immutable`. Дефолтные значения при деплое: `buyerDiscountBps = 2500`,
    `referralBps = 2500` (25%/25%).
  - State: `uint16 public buyerDiscountBps`, `uint16 public referralBps`,
    `mapping(address => bool) public paid`, `mapping(address => bool) public whitelisted`.
  - `function buyAccess(address referrer) external nonReentrant`:
    - Require `!hasAccess(msg.sender)`.
    - `paid[msg.sender] = true` (CEI — set state до transfer).
    - Валидный реферрер (≠ `address(0)`, ≠ `msg.sender`, ≠ `address(this)`):
      `buyerPaid = price * (10000 - buyerDiscountBps) / 10000`;
      `referralAmount = price * referralBps / 10000`;
      `treasuryAmount = buyerPaid - referralAmount`;
      если `referralAmount > 0` — два `safeTransferFrom` (buyer → referrer, buyer → treasury);
      если `referralAmount == 0` (kill-switch кешбэка, скидка сохраняется) — один трансфер
      `buyerPaid` в treasury, в событии `referrer = address(0)`.
    - Невалидный реферрер (silent skip): `safeTransferFrom(msg.sender, treasury, price)` —
      полная цена, скидки нет.
    - emit `AccessPurchased(msg.sender, refForEvent, buyerPaid, referralAmount)`.
  - `function hasAccess(address u) public view returns (bool) => paid[u] || whitelisted[u]`.
  - onlyOwner:
    - `grantAccess(address)`, `grantBatch(address[] calldata)` —
      `require(addrs.length <= MAX_BATCH = 100)`, `revokeAccess(address)`.
    - `setPrice(uint256 newPrice)` — `require(newPrice > 0 && newPrice <= MAX_PRICE)`.
    - `setReferralSplit(uint16 newBuyerDiscountBps, uint16 newReferralBps)` —
      `require(sum <= MAX_TOTAL_REFERRAL_BPS)`. **Атомарный** rebalance обеих долей.
      Kill-switch — `setReferralSplit(0, 0)`.
  - `Ownable2Step` (OZ) — двухшаговая передача прав.
  - Контракт **не payable**, нет `receive()`/`fallback()`.
- Константы: `MAX_PRICE = 100e18` (100 PITCH), `MAX_BATCH = 100`,
  `MAX_TOTAL_REFERRAL_BPS = 5000` (50%). Гарантирует treasury ≥ 50% даже при
  компрометации owner-ключа.
- Использовать только `SafeERC20`.
- События: `AccessPurchased(address indexed user, address indexed referrer, uint256 buyerPaid, uint256 referralAmount)`,
  `AccessGranted(address)`, `AccessRevoked(address)`, `PriceChanged(uint256)`,
  `ReferralSplitUpdated(uint16, uint16)`, `OwnershipTransferred(...)`.
- Ошибки: `ZeroAddress`, `InvalidPrice`, `InvalidReferralSplit`, `AlreadyHasAccess`,
  `BatchTooLarge`.

**DoD:**
- `forge build` без warnings.
- Контракт компилируется под 0.8.26.
- Проходит ручную проверку CEI / Ownable2Step / SafeERC20.

---

### C0.3 — Тесты PitchTerminalAccess
**Что:** Foundry-тесты, **100% line + branch + function** для контракта Access.

**Действия:**
- `contracts/test/PitchTerminalAccess.t.sol` + моки в `contracts/test/mocks/`.
  - Setup: deploy `MockPitch` (простой ERC20 с premint), затем `PitchTerminalAccess`
    с дефолтным split `(2500, 2500)`.
  - Тест-кейсы (минимум):
    - **Конструктор**: zero-address для каждого аргумента, price 0/выше MAX,
      `buyerDiscountBps + referralBps` 0/равен MAX/выше MAX, обе доли 0.
    - **`buyAccess` no-ref**: happy path с `address(0)` → buyer платит полную `price`,
      treasury получает полную, событие `(user, address(0), price, 0)`.
    - **`buyAccess` valid referrer**: split 25/25 → buyer тратит 0.75e18, ref получает
      0.25e18, treasury 0.5e18, событие `(user, ref, 0.75e18, 0.25e18)`.
    - **`buyAccess` only discount** (split 5000/0): buyer тратит 0.5e18, ref 0,
      treasury 0.5e18, событие с `referrer = address(0)`.
    - **`buyAccess` only kickback** (split 0/5000): buyer тратит 1e18, ref 0.5e18,
      treasury 0.5e18.
    - **Silent-skip ветки**: `referrer = msg.sender` → full price, no discount.
      `referrer = address(this)` → full price, no discount. Событие с `address(0)`.
    - **Атомарность реферал-сплита**: buyer имеет balance = 0.6e18, approve 1e18,
      split (2500, 2500) — первый transfer (ref) проходит «концептуально», второй
      (treasury) revert → вся tx откатывается, paid не выставлен, ref-баланс не изменён.
    - **`buyAccess` без `approve` / двойной buy / whitelisted user** → revert.
    - **Whitelist**: `grantAccess`/`grantBatch` (≤MAX, >MAX revert)/`revokeAccess`,
      onlyOwner.
    - **`setPrice`**: onlyOwner, 0 / > MAX_PRICE → revert, ровно MAX ок, влияет на
      последующие покупки.
    - **`setReferralSplit`**: onlyOwner, sum 0+0 ок, ровно MAX_TOTAL ок, sum >
      MAX_TOTAL revert, влияет на последующие покупки. Атомарный rebalance:
      переключение (1000, 4000) → (4000, 1000) одним вызовом.
    - **`Ownable2Step`** двухшаговая.
    - **Reentrancy**: тест с `MockReentrantERC20` → `nonReentrant` ловит.
    - **Fuzz**: `testFuzz_RoundingInvariant(uint256 price, uint16 discountBps, uint16 refBps)`
      с `bound`'ами на диапазоны → `referralAmount + treasuryAmount == buyerPaid`
      для валидного реферрера; `treasuryAmount == price` для невалидного.
  - Coverage: **100% line + 100% branch + 100% function** для
    `src/PitchTerminalAccess.sol` (контракт маленький, реально достижимо).
- `contracts/test/mocks/MockPitch.sol` — стандартный OZ-based ERC20 с premint.
- `contracts/test/mocks/MockReentrantERC20.sol` — стенд для reentrancy-теста.

**DoD:**
- `forge test -vv` все зелёные.
- `forge coverage --report summary` → 100% line/branch/function для
  `src/PitchTerminalAccess.sol`.
- `forge fmt --check` чисто.

---

### C0.4 — Deploy script Access
**Что:** Foundry-скрипт для деплоя.

**Действия:**
- `contracts/script/DeployAccess.s.sol`:
  - Читает `PITCH_TOKEN`, `TREASURY`, `OWNER`, `ACCESS_PRICE`,
    `ACCESS_BUYER_DISCOUNT_BPS` (default 2500), `ACCESS_REFERRAL_BPS` (default 2500)
    из env.
  - Деплоит конструктор с 6 аргументами:
    `(PITCH_TOKEN, TREASURY, ACCESS_PRICE, ACCESS_BUYER_DISCOUNT_BPS, ACCESS_REFERRAL_BPS, OWNER)`.
  - Sanity: `require(ACCESS_BUYER_DISCOUNT_BPS + ACCESS_REFERRAL_BPS <= 5000)` до деплоя
    (иначе сам конструктор ревертится, но дешевле упасть до broadcast'а).
  - Эмитит адрес в лог.
  - Опционально: post-deploy assertion (`address(access).code.length > 0`,
    `owner == OWNER`, `buyerDiscountBps == ACCESS_BUYER_DISCOUNT_BPS`,
    `referralBps == ACCESS_REFERRAL_BPS`).

**DoD:**
- `forge script script/DeployAccess.s.sol --rpc-url $RPC_URL --account ledger --sender 0x<owner>`
  с dry-run работает.
- `--broadcast` на **Anvil fork mainnet** деплоит контракт (см. ниже).
  Sepolia-деплой допустим **только** для smoke-проверки wiring/constructor —
  e2e торговый flow на Sepolia невозможен (см. ниже).
- Post-deploy: `cast call $ACCESS "buyerDiscountBps()(uint16)"` возвращает 2500,
  `cast call $ACCESS "referralBps()(uint16)"` возвращает 2500.

**ВАЖНО — отсутствие testnet'а для pitchwc.** Контракты pitchwc (Player/Country
Router/Hook, PITCH ERC20) развёрнуты **только в Base Mainnet**. На Base Sepolia
их нет. Это означает:
- Sepolia годится для smoke нашего Access (с mock-PITCH ERC20).
- E2e тестирование buy/sell/limit-orders, worker price/event loops, backfill
  **на Sepolia невозможно**.
- Pre-mainnet smoke полного flow делать через **Anvil fork**:
  `anvil --fork-url $RPC_URL_BASE_MAINNET --fork-block-number <recent>`. Все
  pitchwc-контракты доступны со снимком состояния, газ бесплатный, повтор
  безграничный.

---

### C0.5 — Mainnet deploy + Basescan verify
**Что:** задеплоить на Base mainnet, верифицировать на Basescan, экспортировать
ABI в `abis/`.

**Предусловия (ОБЯЗАТЕЛЬНО):**

1. **Security audit** пройден (in-house, без внешнего аудитора). Минимальный
   чек-лист:
   - `slither contracts/src/PitchTerminalAccess.sol` — статический анализ,
     no high-severity findings. False-positives (e.g. `reentrancy-events`)
     обосновываются в `docs/security-checklist.md`.
   - `myth analyze contracts/src/PitchTerminalAccess.sol --solv 0.8.26` —
     символьный анализ, no unhandled findings.
   - Walk по **SWC Registry** (swcregistry.io) — таблица в
     `docs/security-checklist.md` с пометкой «не применимо / закрыто тестом
     X» для каждой релевантной уязвимости (минимум: SWC-101, SWC-104,
     SWC-105, SWC-107, SWC-114, SWC-127, SWC-128, SWC-132).
   - **Anvil-fork e2e smoke**: `anvil --fork-url $RPC_URL_BASE_MAINNET
     --fork-block-number <recent>` → deploy + полный flow
     (`buyAccess(0)` / `buyAccess(valid_ref)` / `buyAccess(self)` /
     `buyAccess(address(pitch))` / `setReferralSplit(...)` / `setPrice(...)` /
     `grantAccess` + free `buyAccess` / `Ownable2Step` transfer) — все
     корректны.
   - Публикация `docs/SECURITY.md` с email / Telegram contact + bug bounty
     tier'ами (например 10-25% от treasury balance за critical, post-launch).
2. `ACCESS_CONTRACT` env планируется зафиксировать в `.env` после деплоя.
3. **Soft launch plan готов**: первые 1-2 дня после деплоя — self-test с
   нескольких своих кошельков, затем 3-5 доверенных людей. Никакого
   публичного анонса до этого.

**Действия:**
- Запуск (координатор):
  ```
  forge script script/DeployAccess.s.sol \
    --rpc-url $RPC_URL_BASE_MAINNET \
    --ledger --sender 0x<OWNER> \
    --broadcast \
    --verify --etherscan-api-key $BASESCAN_KEY
  ```
- После успеха: записать адрес в координаторский лог + обновить `.env.example`
  как комментарий (`# ACCESS_CONTRACT=0x... (deployed YYYY-MM-DD)`).
- `forge build` → скопировать `out/PitchTerminalAccess.sol/PitchTerminalAccess.json`
  → `abis/PitchTerminalAccess.json` (только `abi`-секция, не вся метадата).

**DoD:**
- Контракт на Base mainnet, видим на Basescan, исходник верифицирован
  (зелёная галочка).
- `abis/PitchTerminalAccess.json` коммитится.
- Координатор обновляет env vars Backend-агента.

**Integration checkpoint:** IC-0.4 (после интеграции с Backend и Frontend).

---

## Фаза 2 — LimitOrderExecutor

### C2.1 — Интерфейсы и mocks
**Что:** определить интерфейсы pitchwc + моки для тестов.

**Действия:**
- `contracts/interfaces/IHook.sol` — `currentPrice`, `quoteBuy`, `quoteSell`
  (см. [../eip712.md](../eip712.md) §4).
- `contracts/interfaces/IRouter.sol` — `buy(address, uint256, uint256)`,
  `sell(address, uint256, uint256)`.
- `contracts/test/mocks/MockHook.sol`, `MockRouter.sol`, `MockPitch.sol`
  (если ещё не существует).

**DoD:** компилируется, моки имеют setter'ы для управляемых ответов.

---

### C2.2 — `LimitOrderExecutor.sol`
**Что:** реализовать executor согласно [../contracts.md](../contracts.md) §2 +
[../eip712.md](../eip712.md) §3, §5, §6.

**Действия:**
- Constructor: `(IERC20 pitch, IHook playerHook, IHook countryHook, IRouter
  playerRouter, IRouter countryRouter, address owner)` — все non-zero, все
  `immutable`.
- Domain separator: name `"PitchTerminal LimitOrders"`, version `"1"`, chainId,
  verifyingContract = `address(this)`.
- `ORDER_TYPEHASH` константа — точная строка из [../eip712.md](../eip712.md) §3.1
  (с `quoteToken`).
- `_hashOrder(Order)` — точное соответствие §3.2.
- `_digest(Order)` — `\x19\x01 + domainSeparator + structHash`.
- `_minOut(Order)` — реализация §5.2.
- `mapping(address => mapping(uint256 => bool)) public usedNonces`.
- `execute(Order, bytes signature) external nonReentrant whenNotPaused`:
  1. Bounds checks (см. псевдо-Solidity в §6).
  2. Если venue=1 (country) → `require(quoteToken == PITCH)`.
  3. SignatureChecker.isValidSignatureNow(owner, digest, sig).
  4. Цена через hook → проверка условия.
  5. `usedNonces[owner][nonce] = true` (до внешних вызовов).
  6. `safeTransferFrom(inToken, owner, this, amountIn)` → `forceApprove(router, amountIn)`.
  7. `router.buy/sell(token, amountIn, minOut)`.
  8. `safeTransfer(outToken, owner, balanceOf(this, outToken))` — весь баланс.
  9. emit `OrderExecuted`.
- `cancel(uint256 nonce)` — `usedNonces[msg.sender][nonce] = true`; emit
  `OrderCancelled`. **БЕЗ `whenNotPaused`** — пользователь должен мочь
  отменять даже при паузе.
- `isNonceUsed(address, uint256) external view returns (bool)`.
- onlyOwner: `pause()`, `unpause()`, `Ownable2Step`.

**После router.buy/sell ОБЯЗАТЕЛЬНО `IERC20(inToken).forceApprove(router, 0)`**
— сброс residual allowance. См. [../eip712.md](../eip712.md) §6.

**DoD:**
- `forge build` без warnings.
- Все требования безопасности (G-P) из [../contracts.md](../contracts.md) §2
  выполнены.
- Slither (advisory) без findings level high.

---

### C2.3 — Тесты LimitOrderExecutor (unit + EIP-712 cross-check)
**Что:** полное покрытие.

**Действия:**
- `contracts/test/LimitOrderExecutor.t.sol`:
  - Setup: deploy executor с моками.
  - Happy paths:
    - limit-buy player → currentPrice ≤ target → execute проходит → `OrderExecuted`,
      tokens перешли пользователю.
    - take-profit player → currentPrice ≥ target → execute проходит.
    - limit-buy country → quoteToken = PITCH → проходит.
    - take-profit country → проходит.
  - Negative:
    - Подпись неверная → revert.
    - Nonce использован → revert.
    - venue=1 + quoteToken≠PITCH → revert "bad quote".
    - slippage > MAX_SLIPPAGE_BPS → revert.
    - expiry прошёл → revert.
    - amountIn = 0 → revert.
    - Цена не достигла target → revert (limit-buy: price > target).
    - Реентрантный токен → nonReentrant ловит.
    - Pause → execute → revert.
  - On-chain `cancel`:
    - msg.sender помечает свой nonce → следующий execute → revert "nonce used".
    - **`cancel` работает даже при pause** (тест: pause → cancel → unpause → execute revert "nonce used").
  - **Residual allowance**:
    - После execute → `IERC20(inToken).allowance(executor, router) == 0`.
    - Этот invariant закрепляется тестом.
  - EIP-712 cross-check тест:
    - Хардкод Order, ожидаемый digest (вычислен оффчейн).
    - `executor._digest(order)` (через тестовый wrapper) == hardcoded digest.
    - Это значит typeHash, encoding, domain separator — корректны.
- `contracts/test/utils/SigUtils.sol` — helper для подписи тест-ключом.

**DoD:**
- Все тесты зелёные.
- `forge coverage` ≥ 95% строк, 100% веток для `LimitOrderExecutor`.
- Cross-check тест присутствует и проходит.

**Integration checkpoint:** IC-2.1 — координатор + Backend подтверждают, что
viem на фронте даёт **тот же digest**, что hardcoded в тесте.

---

### C2.4 — Fork-тест против Base mainnet
**Что:** реальный своп через executor, против реальных pitchwc-контрактов.

**Действия:**
- `contracts/test/LimitOrderExecutor.fork.t.sol`:
  - Использует `vm.createFork($BASE_RPC_URL)`.
  - Берёт уже задеплоенный pitchwc Player Router/Country Router/Hook
    (адреса из env).
  - Использует `deal(token, testUser, amount)` (Foundry-helper) — выдаёт
    свежему тестовому адресу баланс нужного токена. **Не** prank с реального
    on-chain холдера (хрупко, адрес может измениться).
  - Деплоит executor с реальными адресами.
  - Создаёт ордер с `quoteToken` = реальная страна.
  - Выполняет execute → проверяет баланс изменился.
- Запускается локально только при наличии `BASE_RPC_URL`:
  `forge test --match-contract Fork --fork-url $BASE_RPC_URL`.
- В CI — opt-in (не блокирует обычный CI).

**DoD:**
- Один полный успешный execute на каждом venue (player, country) обеих сторон
  (limit-buy, take-profit) на форке.
- Если pitchwc revert'ит — расследовать с координатором: либо в нашем
  executor'е ошибка, либо изменился интерфейс pitchwc.

---

### C2.5 — Аудит / ревью
**Что:** внешний или паритетный аудит.

**Действия:**
- Подготовить контракты к ревью: чистая ветка, README с обзором, ссылка на
  [../contracts.md](../contracts.md) §2.
- Запустить **ultrareview** (см. главную сессию):
  - `/ultrareview` против ветки с контрактами фазы 2.
- Внешний аудитор (опционально) — формат TBD; координатор решает.
- Все findings ≥ medium закрыть.

**DoD:**
- Все findings ≥ medium закрыты или явно accepted с обоснованием в комментарии
  Solidity.
- Slither advisory: 0 high findings.

---

### C2.6 — Mainnet deploy LimitOrderExecutor + verify ✅ (2026-05-25)
**Что:** аналогично C0.5, но для executor'а.

**Сделано:**
- Pre-deploy audit batch: slither (31 findings, 0 true positives) + mythril (clean) + manual SWC walk → F-1 (livePrice==0 guard, M) + F-2/F-3 (NatSpec, L/I) closed (`aff6a72`).
- Remix + MetaMask deploy (deployer `0x71EC…756F`); runbook — `contracts/deploy-artifacts/LimitOrderExecutor_REMIX.md` (`91e4ddd`).
- Verify через `forge verify-contract --chain base` → `Pass - Verified` (full match).
- ABI экспортирован в `abis/LimitOrderExecutor.json`.
- VPS env rotation: `EXECUTOR_CONTRACT=0xb22f…` пробрашен в `pt-api` + `pt-worker` через `docker compose up -d --force-recreate`. `/api/v1/orders` больше не fail-closed.

**Canonical address:** [`0xb22f38a0c133A32aB9582ACe9E2Da41d1738b9d5`](https://basescan.org/address/0xb22f38a0c133a32ab9582ace9e2da41d1738b9d5#code) на Base mainnet (chainId 8453).

**Integration checkpoint:** IC-2.2 — реальный execute() с маленькой суммой
(пользователь + координатор делают платный тестовый ордер). Заблокирован до B2.3 keeper + F2.x UI.

---

## Owner-операции (постоянно, по необходимости)

### C∞.1 — Whitelist скрипты
**Что:** скрипты для админ-операций.

**Действия:**
- `contracts/script/Whitelist.s.sol` — `grantAccess(addr)`, `grantBatch([addrs])`,
  `revokeAccess(addr)`. Adresses из env или CLI args.
- `contracts/script/SetPrice.s.sol` — `setPrice(uint256)`.
- `contracts/script/TransferOwnership.s.sol` — `transferOwnership` + acceptance flow.

**DoD:** все скрипты протестированы на тестнете; задокументированы примеры
запуска в `contracts/README.md`.

---

## Сводный чек-лист DoD Contracts по фазам

См. [../conventions.md](../conventions.md) §12:

- **Фаза 0:** Access задеплоен и верифицирован на Basescan; ABI в `abis/`.
- **Фаза 2:** Executor задеплоен и верифицирован; аудит закрыт; fork-тест
  пройден на 4 комбинациях (player+country × limit-buy+take-profit);
  cross-check viem ↔ Solidity digest зелёный; quoteToken sanity-проверки
  работают.
