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

**Действия:**
- `contracts/src/PitchTerminalAccess.sol`:
  - Constructor: `(IERC20 pitch, address treasury, uint256 price, address owner)` —
    все non-zero, `price > 0`. `pitch` и `treasury` — `immutable`.
  - `mapping(address => bool) public paid`, `mapping(address => bool) public whitelisted`.
  - `function buyAccess() external nonReentrant`:
    - Require `!hasAccess(msg.sender)`.
    - `paid[msg.sender] = true` (CEI — set state до transfer).
    - `pitch.safeTransferFrom(msg.sender, treasury, price)`.
    - emit `AccessPurchased(msg.sender)`.
  - `function hasAccess(address u) public view returns (bool) => paid[u] || whitelisted[u]`.
  - onlyOwner: `grantAccess(address)`, `grantBatch(address[] calldata)` —
    `require(addrs.length <= 100, "batch too large")`, `revokeAccess(address)`,
    `setPrice(uint256 newPrice)` — `require(newPrice > 0)`.
  - `Ownable2Step` (OZ) — двухшаговая передача прав.
  - Контракт **не payable**, нет `receive()`/`fallback()`.
- `MAX_PRICE = 100e18` (100 PITCH) `immutable` — `setPrice(newPrice)` обязан
  `require(newPrice > 0 && newPrice <= MAX_PRICE)`. Защита от компрометации
  owner-ключа.
- Использовать только `SafeERC20`.
- События — все из [../contracts.md](../contracts.md) §1.

**DoD:**
- `forge build` без warnings.
- Контракт компилируется под 0.8.26.
- Проходит ручную проверку CEI / Ownable2Step / SafeERC20.

---

### C0.3 — Тесты PitchTerminalAccess
**Что:** Foundry-тесты, близко к 100% веток.

**Действия:**
- `contracts/test/PitchTerminalAccess.t.sol`:
  - Setup: deploy `MockPitch` (простой ERC20 с premint), затем `PitchTerminalAccess`.
  - Тест-кейсы:
    - `buyAccess` happy path → `hasAccess` = true, событие.
    - `buyAccess` без `approve` → revert.
    - `buyAccess` дважды → revert на втором.
    - `buyAccess` whitelisted → revert (уже доступ).
    - `grantAccess` onlyOwner: чужой → revert.
    - `grantBatch` ≤ 100 — работает; 101 → revert.
    - `revokeAccess` — `hasAccess` снова false (если не оплачено).
    - `setPrice` — onlyOwner, цена 0 → revert, цена > MAX_PRICE → revert.
    - `Ownable2Step` — `transferOwnership` ставит pending; новый овнер делает
      `acceptOwnership`; до acceptance старый остаётся.
    - Reentrancy: тест с reentrant ERC20 (mock) → `nonReentrant` ловит.
    - Конструктор zero-address — revert.
  - Coverage: `forge coverage` показывает ≥ 95% строк, 100% веток
    (Access — маленький, реально 100%).
- `contracts/test/mocks/MockPitch.sol` — обычный ERC20 + reentrant-vector method.

**DoD:**
- `forge test -vv` все зелёные.
- `forge coverage` ≥ 95% line, 100% branch для `PitchTerminalAccess`.

---

### C0.4 — Deploy script Access
**Что:** Foundry-скрипт для деплоя.

**Действия:**
- `contracts/script/DeployAccess.s.sol`:
  - Читает `PITCH_TOKEN`, `TREASURY`, `OWNER`, `ACCESS_PRICE` из env.
  - Деплоит, эмитит адрес в лог.
  - Опционально: post-deploy assertion (`address(access).code.length > 0`, owner == OWNER).

**DoD:**
- `forge script script/DeployAccess.s.sol --rpc-url $RPC_URL --account ledger --sender 0x<owner>`
  с dry-run работает.
- `--broadcast` на тестнете деплоит контракт (Sepolia OK для проверки).

---

### C0.5 — Mainnet deploy + Basescan verify
**Что:** задеплоить на Base mainnet, верифицировать на Basescan, экспортировать
ABI в `abis/`.

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

### C2.6 — Mainnet deploy LimitOrderExecutor + verify
**Что:** аналогично C0.5, но для executor'а.

**Действия:**
- `contracts/script/DeployExecutor.s.sol` — параметры из env.
- Запуск с `--ledger --broadcast --verify`.
- Экспорт `abis/LimitOrderExecutor.json`.
- Обновить env vars (координатор передаёт Backend и Frontend).

**DoD:**
- Контракт на Base mainnet, верифицирован на Basescan.
- ABI коммитится в `abis/`.

**Integration checkpoint:** IC-2.2 — реальный execute() с маленькой суммой
(пользователь + координатор делают платный тестовый ордер).

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
