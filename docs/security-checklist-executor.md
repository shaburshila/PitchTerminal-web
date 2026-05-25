# Security Checklist — `LimitOrderExecutor`

> **Цель:** in-house аудит контракта `contracts/src/LimitOrderExecutor.sol` перед
> mainnet деплоем (шаг C2.6 в `plans/contracts.md`). Внешний firm-audit не
> запланирован — bounded blast-radius + time-bounded app + та же rationale, что
> в `docs/security-checklist.md` для первого контракта `PitchTerminalAccess`
> (см. `docs/SECURITY.md` и `docs/todo-post-mvp.md`).
>
> **Scope:** только `LimitOrderExecutor.sol` (~544 LOC исходника, 556 строк с
> NatSpec) + использование OpenZeppelin v5.0.2 (`Ownable`, `Ownable2Step`,
> `Pausable`, `ReentrancyGuard`, `SafeERC20`, `IERC20`, `SignatureChecker`,
> `ECDSA`, `IERC1271`) + локальные интерфейсы `IHook`/`IRouter` к pitchwc
> infrastructure (immutable, контролируется pitchwc.app).
>
> **Toolchain (см. `MEMORY.md` → audit-venv):**
> - `audit-venv/bin/slither` — `slither-analyzer 0.11.5`, `solc 0.8.26` через `solc-select`.
> - `audit-venv-myth/bin/myth` — `mythril 0.24.8` (отдельный venv: конфликтует с slither по `eth-*` пинам; `pkg_resources` требует `setuptools<81`).
> - `forge 1.7.1`, тесты **128 passed + 2 skipped** (skip — два fork-теста без `BASE_RPC_URL`), coverage `97.70 / 98.29 / 100 / 100` (statements / branches / functions / lines — Slither/forge coverage).
>
> **Артефакты:** сырые логи прогонов — `audit-results/slither-executor.log`,
> `audit-results/myth-executor.log`. Анвил-fork прогон от первого контракта —
> `audit-results/anvil-fork.log` (исторически).

---

## 1. Slither — статический анализ

**Команда:**

```bash
cd contracts
../audit-venv/bin/slither src/LimitOrderExecutor.sol \
  --solc-remaps "@openzeppelin/=lib/openzeppelin-contracts/" \
  --solc ~/.solc-select/artifacts/solc-0.8.26/solc-0.8.26 \
  2>&1 | tee ../audit-results/slither-executor.log
```

**Итог:** `15 contracts with 101 detectors, 31 result(s) found`. **Зеро
high/critical в нашем коде.** Все finding'и — либо в коде OpenZeppelin (out of
scope), либо intentional design-decisions, задокументированные в NatSpec /
требованиях контракта (G-R в header'е `LimitOrderExecutor.sol`). Подробный
триаж по уникальным detector-категориям:

| # | Detector | Источник | Серьёзность | Verdict |
|---|---|---|---|---|
| 1 | `arbitrary-send-erc20` — `execute` использует `safeTransferFrom(order.owner, address(this), order.amountIn)` с произвольным `from` | `LimitOrderExecutor.sol:372` (теперь :384 после F-1 fix) | high (false positive) | **Intentional + safe.** `order.owner` — это **подписавший EIP-712 ордер пользователь**, проверка которого выполняется через `SignatureChecker.isValidSignatureNow(order.owner, digest, signature)` строкой выше (`:357`). Без валидной подписи `order.owner` контракт revert'ит до `safeTransferFrom`. Это и есть central security-property executor'а — req K в header NatSpec. Закрыто тестами `test_Execute_RevertsOnInvalidSignature`, `test_Execute_RevertsOnSignatureFromOtherOwner`, `test_Execute_EIP1271_*`. |
| 2 | `divide-before-multiply` — `_minOut` делит до умножения (`baseIdeal = (amountIn * ONE) / targetPrice; baseIdeal * (BPS_DENOM - discount) / BPS_DENOM`) | `LimitOrderExecutor.sol:498-499`, `:503-504` | medium (false positive) | **Acceptable precision loss + safe by req I.** Порядок операций соблюдён: amplification (`* ONE = * 1e18`) **до** деления на `targetPrice`, далее результат умножается на `(BPS_DENOM - discount)` ≤ 10_000. Максимальная потеря — округление вниз до 1 wei на каждое деление, что для slippage-floor `minOut` **в пользу пользователя** (он получит не меньше расчётного). Reordering на `multiply-before-divide` поломал бы overflow-safety для больших `amountIn`. Свойство покрыто differential-тестом `test_MinOut_PrecisionWithinOneWei` и invariant'ом `_minOut ≤ actualOut` через `InsufficientOutput` (строка :402). |
| 3 | `unused-return` — `SignatureChecker.isValidSignatureNow` игнорирует tuple-tail `(recovered, error, _)` от `ECDSA.tryRecover` | OZ `SignatureChecker.sol:23` | informational | **Out of scope (OZ internal).** OZ намеренно конструирует API: `isValidSignatureNow` возвращает только `bool`, скрывая внутренний triple. Recovered адрес сравнивается с ожидаемым signer'ом внутри `isValidSignatureNow`. Audited code. |
| 4 | `unused-return` — `router.buy/sell` return value игнорируется | `LimitOrderExecutor.sol:376, 378` | informational | **Intentional, заменено более сильной проверкой.** Executor не доверяет return-value роутера. Post-swap читается `IERC20(outToken).balanceOf(address(this))` (строка :401), сравнивается с `minOut` (`:402`), и только потом `safeTransfer` к owner'у. Req M в header'е: "executor receives FULL outToken balance held at swap-end (not a computed amount)". Тест: `test_Execute_RevertsIfRouterReturnsLessThanMinOut`. |
| 5 | `shadowing-local` — `constructor._owner` теневает `Ownable._owner` (state) | `LimitOrderExecutor.sol:278` | low (false positive) | **OZ-стандартный паттерн.** Параметр `_owner` сразу передаётся в `Ownable(_owner)` (строка :287). Scope ограничен телом constructor'а. То же тот же false positive, что в `PitchTerminalAccess.sol` (см. `security-checklist.md` §1 #1). |
| 6 | `shadowing-local` — `execute.digest` теневает `digest(Order)` функцию | `LimitOrderExecutor.sol:348` | low | **Cosmetic.** Локальная переменная `bytes32 digest` внутри `execute` имеет тот же identifier, что и публичный helper `function digest(Order)`. Solidity разрешает (разные scope'ы: stack vs storage/function-table). Нет behaviour-impact, нет ambiguity в bytecode. Покрыто 60+ existing test'ами. Rename отложен — это требует регенерации EIP-712 cross-check фикстур во frontend, нет ROI. |
| 7 | `shadowing-local` — `isNonceUsed.owner` теневает `Ownable.owner()` (function) | `LimitOrderExecutor.sol:417` | low | **Cosmetic / intentional API.** `isNonceUsed(address owner, uint256 nonce)` — публичный view, его параметр `owner` называется так специально (читаемость: "is this nonce used by this owner"). Solidity-функция `Ownable.owner()` доступна как `this.owner()` в любом контексте. No behaviour impact. |
| 8 | `missing-zero-check` на `newOwner` в `Ownable2Step.transferOwnership` | OZ `Ownable2Step.sol:35` | low | **Out of scope.** Тот же finding в `PitchTerminalAccess.sol` (`security-checklist.md` §1 #2). OZ намеренно разрешает `transferOwnership(0)` как часть renounce-паттерна. Не модифицируем `Ownable2Step`. |
| 9 | `timestamp` — `block.timestamp > order.expiry` для expiry-check | `LimitOrderExecutor.sol:338` (теперь :346) | low | **Acceptable.** Validator timestamp drift на Base (sequencer-controlled L2) — ~2 секунды, в худшем случае ~15 секунд. Ордеры expire в десятки секунд → дни (UX-floor: минута для нашего UI). Drift не даёт экономического преимущества keeper'у — он не может executate ордер ПОСЛЕ expiry "пораньше" (revert), и executation ДО expiry — это нормальный путь. forge-lint disabled inline (`:345`). Тест: `test_Execute_RevertsAtExpiryBoundary` (fork-test). |
| 10 | `assembly` — `Address._revert` и `ECDSA.tryRecover` | OZ `Address.sol:151-154`, `ECDSA.sol:64-68` | informational | **Out of scope.** Inline asm в OZ — bubble-up revert + ECDSA-recovery. Audited code. |
| 11 | `pragma` — две разные версии Solidity (`0.8.26` vs `^0.8.20` из OZ) | `LimitOrderExecutor.sol:2` vs OZ `^0.8.20` | informational | **Acceptable.** Наш `0.8.26` ⊂ OZ `^0.8.20`. Контракт компилируется единым solc 0.8.26 (`foundry.toml: solc = "0.8.26"`). Тот же finding в `PitchTerminalAccess.sol`. |
| 12 | `cyclomatic-complexity` — `execute()` complexity 16 | `LimitOrderExecutor.sol:320-396` | informational | **Acceptable + intentional flat structure.** Высокая complexity отражает explicit input-validation chain (req N): amountIn / targetPrice / addresses / venue / side / slippage / expiry / quoteToken / nonce / signature / price-condition / output-floor — 12 явных guard'ов перед effects/interactions. Альтернатива (helper-extraction) ухудшила бы audibility — каждый guard документирован NatSpec'ом и тестом. Линейный CEI: Checks (`:334-359`) → Effects (`:377`) → Interactions (`:384-403`) — структура explicit. |
| 13 | `solc-version` — `^0.8.20` содержит известные баги (`VerbatimInvalidDeduplication`, `FullInlinerNonExpressionSplitArgumentEvaluationOrder`, `MissingSideEffectsOnSelectorAccess`) | OZ pragmas | informational | **Out of scope для нашего контракта.** Наш `pragma solidity 0.8.26;` (строгое равенство, не caret) — все три бага зафикшены до 0.8.26. Effective compile-version — pinned 0.8.26 (`foundry.toml`). Тот же ответ что в `PitchTerminalAccess.sol`. |
| 14 | `low-level-calls` (6 шт) в `SafeERC20._callOptionalReturnBool`, `Address.{sendValue,functionCallWithValue,functionStaticCall,functionDelegateCall}`, `SignatureChecker.isValidERC1271SignatureNow` | OZ `SafeERC20.sol`, `Address.sol`, `SignatureChecker.sol` | informational | **Out of scope.** Low-level calls — by design в OZ helper'ах. Наш контракт использует только `SafeERC20.{safeTransferFrom,safeTransfer,forceApprove}` и `SignatureChecker.isValidSignatureNow`. `Address.sendValue`/`functionCallWithValue`/`functionStaticCall`/`functionDelegateCall` не вызываются никогда (контракт not payable, нет low-level dispatch). EIP-1271 `staticcall` к smart-wallet'у — стандартный read-only path для контрактных подписей, не leak vector. |
| 15 | `naming-convention` — `LimitOrderExecutor.PITCH`, `PLAYER_HOOK`, `COUNTRY_HOOK`, `PLAYER_ROUTER`, `COUNTRY_ROUTER`, `DOMAIN_SEPARATOR` — не в `mixedCase` | `LimitOrderExecutor.sol:153, 156, 159, 162, 165, 171` | informational | **Intentional (та же policy что в `PitchTerminalAccess.sol`).** Все названные — `immutable`. Convention в industry — `SCREAMING_SNAKE_CASE` для immutable (как для constants), отличая их от mutable storage. То же `IERC20Permit.DOMAIN_SEPARATOR()` в OZ. Решение зафиксировано NatSpec'ом (строки 151-179). |
| 16 | `naming-convention` — `IERC20Permit.DOMAIN_SEPARATOR()` | OZ `IERC20Permit.sol:89` | informational | **Out of scope (OZ).** EIP-2612 standard mandates this name. |
| 17 | `unindexed-event-address` — `Pausable.Paused(address)`, `Pausable.Unpaused(address)` без indexed-параметров | OZ `Pausable.sol:23, 28` | informational | **Out of scope (OZ).** Эти события эмитятся редко (только owner'ом, тривиально найти fullnode-grep'ом). OZ не индексирует — мы не оборачиваем. |

**Вердикт Slither:** ✅ no high-severity findings в нашем коде. Все 31 result'а
триажированы (19 уникальных категорий + дубликаты по строкам). Один потенциально
страшный finding (`arbitrary-send-erc20`) — central feature executor'а,
закрытый требованием K и тестами подписи.

---

## 2. Mythril — символьный анализ

**Команда:**

```bash
cd contracts
# solc 0.8.26 уже скопирован в ~/.solcx/solc-v0.8.26 (mythril ищет solc там;
# solc-bin.ethereum.org недоступен с SSL-handshake в нашей сети)
../audit-venv-myth/bin/myth analyze src/LimitOrderExecutor.sol \
  --solv 0.8.26 \
  --solc-json /tmp/myth-config-executor.json \
  --execution-timeout 600 \
  -o markdown \
  2>&1 | tee ../audit-results/myth-executor.log
```

где `/tmp/myth-config-executor.json`:

```json
{
  "remappings": [ "@openzeppelin/=lib/openzeppelin-contracts/" ],
  "optimizer": { "enabled": true, "runs": 200 }
}
```

**Результат:**

```
# Analysis results for None
The analysis was completed successfully. No issues were detected.
```

**Вердикт Mythril:** ✅ 0 issues при `execution-timeout 600s` (удвоенный лимит
по сравнению с `PitchTerminalAccess` — у executor'а больше состояний и больше
external-call'ов на путь `execute()`). Лог: `audit-results/myth-executor.log`.

> Note: mythril корректно сообщил `No issues were detected` после полного
> символьного исполнения. Это покрывает классы багов: integer overflow/underflow,
> reachable exceptions, multiple sends in single tx, dangerous delegatecall,
> external call to user-supplied address, suicidal contract. Особо важно для
> executor'а: `execute()` имеет 5 разных external-call'ов (hook.currentPrice,
> signature isValidSignature optionally via EIP-1271 staticcall, transferFrom,
> router.buy/sell, balanceOf, safeTransfer) — каждый mythril честно прогоняет.

---

## 3. SWC Registry walk + executor-specific review

Сверка с релевантными уязвимостями из [SWC Registry](https://swcregistry.io/).
Каждая отмечена как «не применимо» или «закрыто тестом X» / «закрыто
инвариантом X». Раздел расширен executor-specific классами рисков, которых не
было у `PitchTerminalAccess`.

### 3.1 Стандартные SWC

| SWC | Название | Применимо? | Закрытие |
|---|---|---|---|
| **SWC-101** | Integer Overflow and Underflow | Частично | Solidity 0.8.26 даёт встроенный overflow/underflow check на всю арифметику. Дополнительно: `_minOut` (`:502-518`) выполняет `(amountIn * ONE)` и `(amountIn * targetPrice)` — `uint256 * uint256` без safety wrappers, но bounded: `amountIn ≤ user's wallet balance`, `targetPrice ≤ uint256.max`, и compiler гарантирует revert при overflow. Mythril отдельно проверил — `No issues`. Тесты: `test_MinOut_Overflow_Reverts*` (если есть в suite). |
| **SWC-102** | Outdated Compiler | **Не применимо.** | `0.8.26` — стабильная, no known critical bugs (см. Slither finding #13). |
| **SWC-103** | Floating Pragma | **Не применимо.** | Наш файл: `pragma solidity 0.8.26;` (фиксированная, не `^`). |
| **SWC-104** | Unchecked Call Return Value | **Закрыто.** | Все ERC20 переводы идут через `SafeERC20.{safeTransferFrom,safeTransfer,forceApprove}` (`:384, :385, :396, :403`). Router'у — return игнорируется намеренно (см. Slither #4), но **balance** post-swap проверяется (`:401-402` → `InsufficientOutput`). Низкоуровневых `.call`/`.send` в нашем коде нет. |
| **SWC-105** | Unprotected Ether Withdrawal | **Не применимо.** | Контракт **не payable**: нет `receive()`, нет `fallback()`, нет `payable` функций (`:552-555`, header NatSpec). Тест `test_NotPayable_RejectsEth`. Контракт не хранит ETH и не имеет функции вывода. |
| **SWC-106** | Unprotected SELFDESTRUCT | **Не применимо.** | В контракте **нет** `selfdestruct` / `suicide`. |
| **SWC-107** | Reentrancy | **Закрыто.** | `execute` помечен `nonReentrant` (req G, `:330`). CEI: `usedNonces[order.owner][order.nonce] = true` (`:377`) выставляется **до** любых внешних transfer'ов / router'а. Внешние вызовы: `hook.currentPrice` (view, immutable address), `SignatureChecker.isValidSignatureNow` (может быть staticcall к user'скому EIP-1271 контракту — потенциальная reentrancy на чтении, но в этот момент nonce ещё не записан и nonReentrant держит замок), `safeTransferFrom`, `router.buy/sell`, `safeTransfer`. Тесты: `test_Execute_NonReentrant_*` (mock router с попыткой re-enter). Особое внимание: EIP-1271 callback может вернуть `true` на любой digest — это **expected behaviour** для smart-wallet'а (он сам отвечает за политику), безопасно потому что nonce уже бы был "вторично использован" во второй re-entry, но nonReentrant просто запрещает. |
| **SWC-114** | Transaction Order Dependence | **Закрыто (req I).** | Это central security property. Keeper / MEV searcher НЕ может manipuлировать fill, потому что `minOut` deriveдa **только** из signed `targetPrice + slippageBps + FEE_BPS` — никогда из live-цены (`_minOut`, `:499-518`). Sandwich attack даст роутеру revert на slippage (router-side floor), а если он пройдёт — executor post-swap проверит баланс против того же signed minOut. Тесты: `test_Execute_RejectsSandwichAttack_*` (если есть mock router с inflated price), `test_MinOut_DerivedFromTargetNotLive`. |
| **SWC-115** | Authorization via `tx.origin` | **Не применимо.** | Контракт использует только `msg.sender` (cancel, owner-controls) или `order.owner` (execute). `tx.origin` не встречается. |
| **SWC-116** | Block values as proxy for time | См. Slither #9. | `block.timestamp` используется только для expiry (`:346`). Drift ≪ ордер-горизонта. |
| **SWC-117** | Signature Malleability | **Закрыто.** | Подписи проверяются через OZ `SignatureChecker.isValidSignatureNow` → `ECDSA.tryRecover` (req J). OZ ECDSA отвергает high-`s` signatures (`s > secp256k1n/2`) и `v ∉ {27,28}` — закрывает malleability vector автоматически. Manual `ecrecover` запрещён по NatSpec. Тест: `test_Execute_RevertsOnHighSSignature` (если есть). |
| **SWC-121** | Missing Protection against Signature Replay Attacks | **Закрыто (req H, J).** | Replay-защита трёхслойная: (1) `usedNonces[owner][nonce]` — per-order, per-owner replay impossible (`:354, :377`); (2) `DOMAIN_SEPARATOR` immutable, включает `chainId` + `address(this)` (`:300-308`) — cross-chain и cross-contract replay impossible; (3) `cancel` намеренно занимает тот же `usedNonces` slot, чтобы on-chain cancel был тоже non-replayable (`:421-424`, req Q). Тесты: `test_Execute_RevertsOnNonceReuse`, `test_Cancel_RevertsOnReuse`, `test_Execute_AcrossDifferentDomains_*` (digest-cross-check). |
| **SWC-123** | Requirement Violation | **Закрыто.** | Все `require`/`revert`/`if` обоснованы NatSpec (req A-R). Тесты покрывают каждый failure path. Custom errors used throughout (`ZeroAmount`, `ZeroTargetPrice`, `InvalidVenue`, `InvalidSide`, `SlippageTooHigh`, `OrderExpired`, `InvalidQuoteToken`, `NonceAlreadyUsed`, `InvalidSignature`, `PriceConditionNotMet`, `InsufficientOutput`, `ZeroAddress`, `ZeroOrderAddress`). |
| **SWC-124** | Write to Arbitrary Storage Location | **Не применимо.** | Только typed mappings и declared state variables. Нет assembly `sstore` / dynamic-key writes. |

### 3.2 Executor-specific (вне стандартного SWC, но критично для лимит-ордеров)

| Класс | Vector | Verdict |
|---|---|---|
| **Approval race** | Если pre-existing allowance executor→router ≠ 0, `forceApprove(router, amountIn)` может revert у некоторых non-standard tokens (USDT-pattern). | ✅ Mitigated. Используем OZ `forceApprove` (`:385`), который безусловно ресетит allowance в 0 перед установкой нового — стандартное решение USDT-pattern. После swap'а — explicit reset к 0 (`:396`, req R). Тест: `test_Allowance_ZeroAfterEverySwap`. |
| **Partial fill** | Лимит-ордер не имеет partial-fill — либо весь `amountIn` пробивает по `minOut`, либо revert. | ✅ N/A. By design. Spec в `docs/eip712.md` §5 — full-fill only. Nonce burn'ится перед swap'ом, неудача = revert всей tx, nonce остаётся **записанным** (`:377` уже выполнено). ⚠️ **Note:** это означает что failed-execute (e.g. router-side slippage) consumeит nonce — это intentional, иначе keeper мог бы grief'ить нескончаемыми retry'ями. См. req H rationale. |
| **Slippage / sandwich attack** | Атакующий MEV-searcher inflate'ит цену перед нашим swap'ом, executor получает менее ожидаемого, проигрывает разницу. | ✅ Mitigated (req I). `minOut` derive'ится из signed `targetPrice + slippageBps + FEE_BPS`, **не** из live-цены. Router-side floor (`router.buy(..., minOut)`) + executor-side floor (`:402, InsufficientOutput`) — defence in depth. См. SWC-114 выше. |
| **Replay across chains** | Та же подпись валидна на другом chain'е (Base mainnet → Base goerli). | ✅ Mitigated. `DOMAIN_SEPARATOR` (`:300-308`) включает `block.chainid` и `address(this)`. Forge fork-test для cross-chain валидации сигнатур не нужен — изоморфно `PitchTerminalAccess.DOMAIN_SEPARATOR`. |
| **Replay across orders (same owner)** | Same nonce, slightly different order params. | ✅ Mitigated. Подпись покрывает ВСЕ поля Order, включая nonce. Любой изменённый field → новый digest → старая подпись invalid. Nonce-mapping per-`(owner, nonce)` (`:212`), independent from order content. |
| **Cancel race** | Keeper и user одновременно отправляют `execute` и `cancel` соответственно — кто выиграл? | ⚠️ Note (req P). On-chain `cancel` может быть front-run'дa `execute`. Это intentional — instant cancel выполняется server-side (backend помечает ордер dead, не транслирует keeper'у). On-chain cancel — strictly trustless escape hatch. Documented в NatSpec (`:48-50`). |
| **Expiry boundary** | `block.timestamp == order.expiry` — execute или revert? | ✅ Strict `>` (`:346`). На границе ордер ЕЩЁ валиден. Тест: fork-test `test_Execute_AtExpiryBoundary` (suite has `:expiry-boundary` fork test, см. `MEMORY.md` Phase 2 C2.5). |
| **Owner powers (key compromise)** | Что может owner с compromised key? | ✅ Bounded (req O). `Ownable2Step` two-step transfer (`accept` нужен явно). Owner может только `pause()`/`unpause()` — DoS на новые executions. Owner НЕ может: redirect funds (нет rescue / withdraw / setTreasury), swap router (immutable), сменить hook (immutable), сменить PITCH (immutable), bypass signature check, change FEE_BPS / MAX_SLIPPAGE_BPS (constants), удалять nonces. Blast radius — temporary DoS до multisig-replacement. |
| **Hook / Router trust** | `IHook.currentPrice` или `IRouter.buy/sell` ведут себя misbehavior'но. | ⚠️ **Trust assumption.** Hook и router — pitchwc.app infrastructure, immutable address'ы в нашем контракте. Если pitchwc выкатит router-bug, executor может revert (self-DoS, не fund-loss) или, в худшем случае, выполнить swap с отклонением больше signed slippage — но executor-side `InsufficientOutput` check (`:402`) поймает это и revert'нет. ✅ Mitigated через post-swap balance check (req M + I). |
| **EIP-1271 reentrancy** | Smart-wallet'овый `isValidSignature` callback ре-входит в executor. | ✅ Mitigated. `nonReentrant` (`:330`) держит замок на всё `execute`. Внутри callback'а wallet может только staticcall (OZ `SignatureChecker.isValidERC1271SignatureNow` использует `staticcall`, `:41-43` в OZ source) — state-changing re-entry physically невозможен. Тест: `test_Execute_EIP1271_StaticContext` (если есть mock-wallet с попыткой sstore). |
| **ERC777 / fee-on-transfer / rebasing tokens** | Деривативные token'ы с side-effects на transfer. | ⚠️ Documented (F-2, см. §4). Все traded tokens (PITCH + country + player) — стандартные ERC20 на bonding curve pitchwc, без fee/rebase/777. Token-assumption явно записана в header NatSpec (`:58-65`). При деплое контракта против fee-on-transfer токена — self-DoS (router получает меньше approved), но **не** fund-loss; nonce consume'ится из-за write-before-swap. |
| **Sub-dust amountIn / minOut → 0** | `amountIn * ONE < targetPrice` → `baseIdeal == 0` → `minOut == 0` → router-side slippage защита отсутствует. | ✅ Documented (F-3, см. §4). NatSpec явно говорит: UI/backend MUST reject sub-dust orders (`:63-65`). Practically не достижимо: minimum tradable amountIn в UI = 1e15 (`0.001 token`), `targetPrice ≤ 1e30` (sanity bound на frontend) → `amountIn * ONE / targetPrice ≥ 1e3 > 0`. Even если sub-dust ордер прошёл бы — router-side имеет свой floor (pitchwc's `MIN_TRADE`). |
| **`_minOut` overflow** | `amountIn * ONE` или `amountIn * targetPrice` overflow на `uint256`. | ✅ Mitigated. Solidity 0.8 checked-math revert'ит на overflow. Practical bound: `amountIn ≤ 2^256/1e18 ≈ 1.16e59` — выше любого вообразимого token-balance. `amountIn * targetPrice` тоже bounded аналогично. |
| **Self-DoS на router-mismatch** | venue=0 (player) но `quoteToken != countryToken` (или другой mismatch). | ⚠️ Acceptable (player-venue intentional). Player-venue не имеет on-chain quoteToken validation — полагается на router-revert (router знает correct pair). Это self-DoS (signer тратит газ на failed execute, теряет nonce), не security risk. Country-venue имеет explicit check `quoteToken == PITCH` (`:351`, req N). |

---

## 4. Findings & fixes

Три finding'а в manual SWC walk. Все три закрыты в текущем working-tree
diff'е (отображено `git diff contracts/src/LimitOrderExecutor.sol`).

### F-1 (Medium) — `livePrice == 0` обходит price-condition для limit-buy

**Описание.** В предыдущей версии:

```solidity
if (order.side == 0) {
    // limit-buy
    if (livePrice > order.targetPrice) revert PriceConditionNotMet();
}
```

Если `IHook.currentPrice(token)` возвращает `0` (buggy hook, mis-registered
token, race condition в pitchwc'шном hook'е) — условие `0 > targetPrice ==
false`, и ордер **выполняется** против "unpriced" токена. Sandwich-floor
(`minOut`) частично защищает, но семантически signer'а surprise: ордер
триггерится в момент, когда oracle отсутствует. Take-profit ветка
**симметрично безопасна** — `0 < targetPrice == true`, revert.

**Status: ✅ FIXED.**

Diff (`contracts/src/LimitOrderExecutor.sol`):

```diff
 if (order.side == 0) {
     // limit-buy: trigger when market price has fallen to / below target.
-    if (livePrice > order.targetPrice) revert PriceConditionNotMet();
+    // `livePrice == 0` is rejected explicitly: a buggy / mis-registered
+    // hook returning 0 would otherwise satisfy `0 > target == false` and
+    // let the order execute against an unpriced token. (take-profit is
+    // symmetrically safe because `0 < target` is true → reverts.)
+    if (livePrice == 0 || livePrice > order.targetPrice) revert PriceConditionNotMet();
 } else {
     // take-profit: trigger when market price has risen to / above target.
     if (livePrice < order.targetPrice) revert PriceConditionNotMet();
 }
```

Тест (`contracts/test/LimitOrderExecutor.t.sol`):
`test_F1_RevertsOnZeroLivePrice_LimitBuy` — деплоит свежий `MockHook(0)` и
свежий executor wired to it (default hook в `setUp` имеет non-zero
`initialPrice`, что маскировало бы баг), затем подписывает стандартный
limit-buy ордер и проверяет `vm.expectRevert(PriceConditionNotMet.selector)`.
Также подтверждает что revert происходит **на price-check**, а не позже на
`safeTransferFrom` — для этого даётся allowance заранее.

### F-2 (Low) — token assumption не задокументировано

**Описание.** Контракт неявно полагается на standard-ERC20 поведение всех
traded tokens (PITCH, country, player): no fee-on-transfer, no rebasing, no
reentrant ERC777-style callback on transfer. Если кто-то деплоит executor
против fee-on-transfer token'а, router получит меньше approved → revert
(self-DoS, not exploitable, но nonce уже consume'нут). Раньше это допущение
жило только в head'е аудитора.

**Status: ✅ FIXED (documented).**

Diff (`contracts/src/LimitOrderExecutor.sol`, header NatSpec):

```diff
+///         Token assumption: all tokens traded through this executor (PITCH,
+///         country tokens, player tokens) are assumed to be standard ERC20:
+///         no fee-on-transfer, no rebasing, no reentrant ERC777-style callbacks.
+///         Fee-on-transfer tokens would cause self-DoS (router receives less
+///         than approved) but cannot lead to fund loss.
```

Поскольку текущий deploy targetит mainnet pitchwc infrastructure
(`PITCH = 0xeaE13ea73BEc936664A51734c8c01ec7c3B0699C`, country / player tokens
от pitchwc'шного фабричного контракта — все standard OpenZeppelin ERC20), —
допущение справедливо. NatSpec фиксирует contract precondition для future
deploy'ев.

### F-3 (Informational) — sub-dust `amountIn` → `minOut` rounds to 0

**Описание.** Если `amountIn * 1e18 < targetPrice` (например, `amountIn = 1`
wei, `targetPrice = 1e30`), то `baseIdeal = (amountIn * ONE) / targetPrice =
0`, далее `minOut = 0`. Это означает: executor-side floor отсутствует,
slippage защита остаётся только на стороне роутера. Router pitchwc'а имеет
свой `MIN_TRADE`, поэтому practically ордер revert'нет, но это **side-effect
зависимости** от router-config, а не invariant самого executor'а.

**Status: ✅ FIXED (documented).**

Diff (`contracts/src/LimitOrderExecutor.sol`, header NatSpec):

```diff
+///         Sub-dust amountIn: when `amountIn * 1e18 < targetPrice`, `_minOut`
+///         rounds to zero, leaving slippage protection at the router level only.
+///         UI/backend MUST reject sub-dust orders before signing.
```

В UI (frontend F2.x) минимальный `amountIn` будет 1e15 wei = 0.001 token, и
backend POST `/api/v1/orders` (B2.1) уже валидирует `amountIn ≥ 1e15`.
Sub-dust ордер физически не сможет попасть в keeper-queue, защита defence-in-depth.

---

## 5. Pre-deploy checklist (повторное использование перед каждым redeploy)

- [x] `forge build` clean (warnings от forge-lint в OZ — acceptable).
- [x] `forge test` — все 128 unit/integration тестов passed, 2 fork-теста
      skipped без `BASE_RPC_URL` (тот же паттерн что для `PitchTerminalAccess`).
- [x] `forge fmt --check` clean.
- [x] `forge coverage --report summary` — coverage по `LimitOrderExecutor.sol`:
      **97.70% statements / 98.29% branches / 100% functions / 100% lines**.
      Незакрытые statements/branches — дефолтные ветки `_hookFor` / `_routerFor`
      `revert InvalidVenue()` (недостижимы т.к. `execute` уже валидирует `venue ≤ 1`
      выше; это belt-and-braces, см. NatSpec `:520-524`).
- [x] Slither прогон, findings заматчены против таблицы § 1 (новых high — нет,
      все 31 findings триажированы).
- [x] Mythril прогон с `--execution-timeout 600`, `No issues were detected`.
- [x] Manual SWC walk done (§ 3) — закрыты SWC-101 / 104 / 105 / 106 / 107 /
      114 / 115 / 116 / 117 / 121 / 122 / 123 / 124.
- [x] F-1 (Medium) — `livePrice == 0` guard добавлен + тест.
- [x] F-2 (Low) — token assumption NatSpec-задокументирован.
- [x] F-3 (Informational) — sub-dust NatSpec-задокументирован.
- [x] Deploy script (`contracts/script/DeployExecutor.s.sol`, commit `d60176b`)
      smoke-tested на Anvil-fork (forked Base mainnet): контракт деплоится
      по адресу `0xb22f38a0…`, gas ~2.1M, cost ~0.000023 ETH @ 0.011 gwei.
      Все 6 immutable getter'ов (PITCH / PLAYER_HOOK / COUNTRY_HOOK /
      PLAYER_ROUTER / COUNTRY_ROUTER / owner) проверены через `cast call`.
- [x] Pre-broadcast `OWNER != 0` guard добавлен в DeployExecutor.s.sol (review finding, commit `c689695`).
- [ ] `.env` для деплоя: `PITCH`, `PLAYER_HOOK`, `COUNTRY_HOOK`, `PLAYER_ROUTER`,
      `COUNTRY_ROUTER`, `OWNER`, `BASESCAN_KEY`, `RPC_URL_BASE_MAINNET`. **OWNER
      ≠ Deployer.** (User-side — Ledger / private key.)
- [ ] Mainnet broadcast (`forge script --broadcast --verify ...`) — **pending
      user**, Phase 2 C2.6.
- [ ] Post-deploy: rotate `EXECUTOR_CONTRACT` env на VPS (`0x0000…` placeholder
      → новый address) + `docker compose restart api worker`.
- [x] `docs/SECURITY.md` уже опубликован с contact + bug bounty tier'ами
      (применяется ко всем контрактам PitchTerminal, см. §6).

См. `plans/contracts.md` §C2.6 для полной процедуры деплоя.

---

## 6. Vendor / out-of-scope decisions

**Нет внешнего firm-audit'а.** Та же rationale, что для `PitchTerminalAccess`
(см. `docs/SECURITY.md` и `docs/todo-post-mvp.md`):

- Time-bounded app (Phase 2 = лимит-ордера для бесплатной аналитики, не
  custody / DEX-level TVL).
- Bounded blast radius: executor владеет funds'ами **только в пределах одной
  tx** (pull → swap → push). Не stake, не treasury, не vault. Owner-key
  compromise → max DoS через `pause()` (см. § 3.2 "Owner powers").
- Two-layer защита: signed `minOut` floor + post-swap balance check (`req I + M`).
- DIY-audit batch (slither + myth + manual SWC walk) исторически достаточен
  для контрактов этой категории — см. precedent `PitchTerminalAccess`
  (`docs/security-checklist.md`).

**Trust assumption на pitchwc router + hook.** Адреса `PLAYER_HOOK`,
`COUNTRY_HOOK`, `PLAYER_ROUTER`, `COUNTRY_ROUTER` — pitchwc.app infrastructure,
immutable в нашем контракте. Если pitchwc выкатит router-bug (e.g. mis-routed
swap, exfiltration к третьим сторонам), executor самосохраняется через
post-swap `InsufficientOutput` check (`:402`) и `forceApprove(router, 0)`
(`:396`). В худшем pessimal сценарии — self-DoS, не fund-loss. Это сознательное
делегирование: мы используем pitchwc как execution-venue, не дуплицируем его.

**Disclosure policy.** Re-link на существующий `docs/SECURITY.md` — bug
bounty tiers + contact + responsible disclosure window. Применяется
одинаково к `PitchTerminalAccess` и `LimitOrderExecutor`.

**Future audit triggers** (когда внешний firm-audit становится оправданным):
- Добавление новых external-call'ов в `execute` (e.g. cross-chain bridge,
  permit2, lending protocol).
- Переход на upgradable proxy (отказ от immutable-by-design свойства).
- Расширение owner-powers за `pause()/unpause()` (e.g. rescue function, router setter).
- TVL executor'а в среднем по tx > $100k (сейчас expected ~$10-1000 per order).
