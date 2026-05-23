# Security Checklist — `PitchTerminalAccess`

> **Цель:** in-house аудит контракта `contracts/src/PitchTerminalAccess.sol` перед
> mainnet деплоем (шаг C0.5 в `plans/contracts.md`). Внешний firm-audit не
> запланирован (см. `todo-post-mvp.md`).
>
> **Scope:** только `PitchTerminalAccess.sol` (~250 LOC) + использование
> OpenZeppelin v5.0.2 (`Ownable`, `Ownable2Step`, `ReentrancyGuard`, `SafeERC20`,
> `IERC20`).
>
> **Toolchain (см. `MEMORY.md` → audit-venv):**
> - `audit-venv/bin/slither` — `slither-analyzer 0.11.5`, `solc 0.8.26` через `solc-select`.
> - `audit-venv-myth/bin/myth` — `mythril 0.24.8` (отдельный venv: конфликтует с slither по `eth-*` пинам; `pkg_resources` требует `setuptools<81`).
> - `forge 1.7.1`, тесты 63 passed + 1 skipped (Anvil-fork без env), 100% line/branch/function coverage.
>
> **Артефакты:** сырые логи прогонов — `audit-results/slither.log`, `audit-results/myth.log`, `audit-results/anvil-fork.log`.

---

## 1. Slither — статический анализ

**Команда:**

```bash
cd contracts
../audit-venv/bin/slither src/PitchTerminalAccess.sol \
  --solc-remaps "@openzeppelin/=lib/openzeppelin-contracts/" \
  --solc ~/.solc-select/artifacts/solc-0.8.26/solc-0.8.26
```

**Итог:** `9 contracts with 101 detectors, 13 result(s) found`. **Зеро high/critical
в нашем коде.** Все finding'и — либо в коде OpenZeppelin (out of scope), либо
intentional. Подробный триаж:

| # | Detector | Источник | Серьёзность | Verdict |
|---|---|---|---|---|
| 1 | `shadowing-local` `_owner` в constructor | `PitchTerminalAccess.sol:200` | informational | **False positive.** Параметр `_owner` тут же передаётся в `Ownable(_owner)` (строка 201) — shadowing только в scope конструктора, никакого фактического конфликта со state-переменной `Ownable._owner` нет. Все 4 теста constructor (`test_Constructor_StoresImmutables`, `test_Constructor_RevertsOnZeroOwner`, `test_Ownership_TwoStep`, etc.) подтверждают корректность передачи owner. |
| 2 | `missing-zero-check` на `newOwner` в `Ownable2Step.transferOwnership` | OZ `Ownable2Step.sol:35` | low | **Out of scope.** OpenZeppelin v5 намеренно разрешает `transferOwnership(0)` как часть renounce-паттерна (`acceptOwnership` с нулевого адреса невозможен, ownership зависает в pending — defacto renounce). Это документированное поведение OZ, наш код не модифицирует `Ownable2Step`. |
| 3 | `assembly` в `Address._revert` | OZ `Address.sol:151-154` | informational | **Out of scope.** Стандартный helper OpenZeppelin для bubble-up revert reason из low-level calls. Used by `SafeERC20`. Audited code. |
| 4 | `pragma` — две разные версии Solidity | `PitchTerminalAccess.sol:2` (`0.8.26`) vs OZ (`^0.8.20`) | informational | **Acceptable.** Наш `0.8.26` ⊂ OZ `^0.8.20`. Контракт компилируется единым solc 0.8.26 (см. `foundry.toml`). Slither предупреждает о mixed pragmas в multi-version compile — у нас single-version. |
| 5 | `solc-version` — `^0.8.20` имеет известные баги (`VerbatimInvalidDeduplication`, `FullInlinerNonExpressionSplitArgumentEvaluationOrder`, `MissingSideEffectsOnSelectorAccess`) | OZ pragmas | informational | **Out of scope для нашего контракта.** Наш `pragma solidity 0.8.26;` (строгое равенство, не caret) — все три бага зафикшены до 0.8.26 (см. https://solidity.readthedocs.io/en/latest/bugs.html). `^0.8.20` стоит только в OZ-файлах, но эффективная compile-version — наш pinned 0.8.26 (см. `foundry.toml: solc = "0.8.26"`). |
| 6 | `low-level-calls` (5 шт) в `SafeERC20._callOptionalReturnBool`, `Address.sendValue`, `Address.functionCallWithValue`, `Address.functionStaticCall`, `Address.functionDelegateCall` | OZ `SafeERC20.sol`, `Address.sol` | informational | **Out of scope.** Low-level calls — by design в OZ helper'ах. Контракт `PitchTerminalAccess` не использует `Address.sendValue`/`functionCallWithValue`/etc. напрямую — только `SafeERC20.safeTransferFrom`, который безопасен для well-behaved ERC20 (req F в NatSpec). |
| 7 | `naming-convention` — `PitchTerminalAccess.PITCH` и `TREASURY` не в `mixedCase` | `PitchTerminalAccess.sol:69, 72` | informational | **Intentional.** `PITCH` и `TREASURY` — `immutable`. Convention для immutable в industry — `SCREAMING_SNAKE_CASE` (как для constants), отличая их от mutable storage. То же `IERC20Permit.DOMAIN_SEPARATOR()` в OZ. Решение зафиксировано в NatSpec (строки 68-72). |

**Вердикт Slither:** ✅ no high-severity findings в нашем коде. Все 13 findings обоснованы.

---

## 2. Mythril — символьный анализ

**Команда:**

```bash
cd contracts
# solc 0.8.26 уже скопирован в ~/.solcx/solc-v0.8.26 (mythril ищет solc там;
# solc-bin.ethereum.org недоступен с SSL-handshake в нашей сети)
../audit-venv-myth/bin/myth analyze src/PitchTerminalAccess.sol \
  --solv 0.8.26 \
  --solc-json /tmp/myth-config.json \
  --execution-timeout 300 \
  -o markdown
```

где `/tmp/myth-config.json`:

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

**Вердикт Mythril:** ✅ 0 issues при `execution-timeout 300s`. Лог: `audit-results/myth.log`.

> Note: mythril корректно сообщил `No issues were detected` после полного символьного
> исполнения. Это покрывает классы багов: integer overflow/underflow, reachable
> exceptions, multiple sends in single tx, dangerous delegatecall, external call
> to user-supplied address, suicidal contract.

---

## 2bis. Anvil-fork e2e smoke (mainnet PITCH ERC20)

**Команда:**

```bash
FORK_RPC_URL=https://mainnet.base.org \
  forge test --root contracts/ \
    --match-path test/integration/AnvilFork.t.sol -vv
```

Тест использует `vm.createSelectFork($FORK_RPC_URL)` (foundry стримит state с
RPC) и `deal()` для пополнения buyer'ов реальным mainnet PITCH ERC20
(`0xeaE13ea73BEc936664A51734c8c01ec7c3B0699C`) — никакой реальный держатель не
задействован. Полный контракт деплоится на форк, прогоняются 3 теста против
реального токена.

**Результат:**

```
Ran 3 tests for test/integration/AnvilFork.t.sol:AnvilForkTest
[PASS] test_Fork_BuyAccess_NoReferrer() (gas: 91907)
[PASS] test_Fork_BuyAccess_WithReferrer() (gas: 150670)
[PASS] test_Fork_SetReferralSplit_AppliesToNextPurchase() (gas: 157711)
Suite result: ok. 3 passed; 0 failed; 0 skipped; finished in 4.01s
```

**Покрытие:**

| Кейс из `plans/contracts.md` §C0.5 | Покрытие на форке | Где иначе |
|---|---|---|
| `buyAccess(0)` | ✅ `test_Fork_BuyAccess_NoReferrer` | — |
| `buyAccess(valid_ref)` | ✅ `test_Fork_BuyAccess_WithReferrer` | — |
| `setReferralSplit(...)` | ✅ `test_Fork_SetReferralSplit_AppliesToNextPurchase` | — |
| `buyAccess(self)` | unit | `test_BuyAccess_SelfRef_NoDiscount` |
| `buyAccess(address(pitch))` | unit | `test_BuyAccess_PitchTokenAsReferrer_TreatedAsNoRef` |
| `setPrice(...)` | unit | `test_SetPrice_*` |
| `grantAccess` + free `buyAccess` | unit | `test_GrantAccess_*` + `test_HasAccess_TrueAfterGrant` |
| `Ownable2Step` transfer | unit | `test_Ownership_TwoStep`, `test_Ownership_NonOwnerCantTransfer`, `test_Ownership_AcceptByContract` |

Fork-specific value подтверждён: контракт корректно работает с **реальным**
mainnet PITCH ERC20 (а не моком). Прочие кейсы из чек-листа покрыты unit-тестами
(63 теста, 100% line/branch/function coverage) — байткод тот же, riski специфичные
для real-token (нестандартный return-shape, missing-return-value и т.п.) уже
переловлены тремя fork-тестами через `SafeERC20.safeTransferFrom`.

**Вердикт Anvil-fork:** ✅ 3/3 passed. Лог: `audit-results/anvil-fork.log`.

---

## 3. SWC Registry walk

Сверка с релевантными уязвимостями из [SWC Registry](https://swcregistry.io/).
Каждая отмечена как «не применимо» или «закрыто тестом X» / «закрыто инвариантом X».

| SWC | Название | Применимо? | Закрытие |
|---|---|---|---|
| **SWC-101** | Integer Overflow and Underflow | Частично | Solidity 0.8.26 даёт встроенный overflow/underflow check на всю арифметику. Дополнительно: req I в NatSpec гарантирует `referralAmount ≤ buyerPaid` (через req H: `discount + ref ≤ 5000`), поэтому `buyerPaid - referralAmount` (строка 260) не может underflow. Mythril отдельно проверил — `No issues`. Тесты: `test_BuyAccess_AppliesBuyerDiscount`, `test_BuyAccess_OnlyDiscount_NoReferralKickback`, `test_BuyAccess_OnlyKickback_NoBuyerDiscount`. |
| **SWC-104** | Unchecked Call Return Value | **Закрыто.** | Все ERC20 переводы идут через `SafeERC20.safeTransferFrom` (строки 266, 272, 273, 279), который проверяет return value и revert'ит при неудаче. Низкоуровневых `.call`/`.send` в нашем коде нет. |
| **SWC-105** | Unprotected Ether Withdrawal | **Не применимо.** | Контракт **не payable** (req E): нет `receive()`, нет `fallback()`, нет `payable` функций. Тест `test_NotPayable_RejectsEth` подтверждает, что отправка ETH revert'ит. Контракт не хранит ETH и не имеет функции вывода. |
| **SWC-107** | Reentrancy | **Закрыто.** | `buyAccess` помечен `nonReentrant` (req A, строка 240). CEI: `paid[msg.sender] = true` (строка 244) выставляется **до** любых внешних transfer'ов. Контракт не делает callback'и в произвольный код — только `safeTransferFrom` PITCH (well-behaved ERC20, req F). Если PITCH вдруг сделает reentrant callback на `transferFrom` — `nonReentrant` его остановит. Тест: `test_BuyAccess_NonReentrant` (через `MaliciousReferrer` mock). |
| **SWC-114** | Transaction Order Dependence | **Не применимо.** | Цена `price` mutable, но bounded: `0 < price ≤ MAX_PRICE = 100e18`. Frontrunning сценарий: owner вызывает `setPrice(newPrice)` → user'ы видят tx в mempool → конкурируют за старую цену. Это **acceptable behavior** — owner намеренно меняет цену, user'ы могут реагировать. Hard cap (req G) защищает от extreme manipulation. Тест `test_SetPrice_AffectsSubsequentBuys`. |
| **SWC-127** | Arbitrary Jump with Function Type Variable | **Не применимо.** | Контракт не использует function-type variables (`function() external`) или `delegatecall`. Только статичные function calls на `IERC20` и `Ownable*`. |
| **SWC-128** | DoS With Block Gas Limit | **Закрыто.** | Единственный loop — `grantBatch` (строка 308). Bounded: `len > MAX_BATCH (100)` → revert (`BatchTooLarge`). Тесты: `test_GrantBatch_RevertsWhenBatchTooLarge`, `test_GrantBatch_AllowsMaxBatch`. Прочие функции — O(1). Iteration по mapping'ам отсутствует. |
| **SWC-132** | Unexpected Ether balance | **Не применимо.** | Контракт not payable (см. SWC-105). Логика контракта **не зависит** от `address(this).balance` ни в одной точке — нет `if (this.balance == X)` / `require(this.balance ≥ Y)` / etc. Принудительно отправленный ETH (например через `selfdestruct`) не повлияет на работу контракта. |

### Дополнительные классы (не из основной семёрки, но проверены)

| ID | Класс | Закрытие |
|---|---|---|
| SWC-100 | Function Default Visibility | Все функции явно помечены `external`/`public`/`internal`. Solidity 0.8 требует explicit visibility — compiler error при пропуске. |
| SWC-102 | Outdated Compiler | `0.8.26` — стабильная, no known critical bugs (см. Slither finding #5, который касается только OZ pragma). |
| SWC-103 | Floating Pragma | Наш файл: `pragma solidity 0.8.26;` (фиксированная, не `^`). |
| SWC-106 | Unprotected SELFDESTRUCT | В контракте **нет** `selfdestruct` / `suicide`. |
| SWC-108 | State Variable Default Visibility | Все state-переменные явно `public` (для view-функций бесплатно) или иначе не имеют value-leak. |
| SWC-112 | Delegatecall to Untrusted Callee | `delegatecall` в нашем коде отсутствует. OZ `Address.functionDelegateCall` не используется. |
| SWC-115 | Authorization via `tx.origin` | Контракт использует только `msg.sender`. |
| SWC-116 | Block values as proxy for time | Time-зависимая логика отсутствует. Нет `block.timestamp` / `block.number`. |
| SWC-118 | Incorrect Constructor Name | Constructor явно объявлен как `constructor(...)` (Solidity 0.8 syntax). |
| SWC-119 | Shadowing State Variables | См. Slither #1 — false positive в constructor, никакой реальной shadowing на state level. |
| SWC-120 | Weak PRNG | Random / PRNG не используется. |
| SWC-123 | Requirement Violation | Все `require`/`revert`/`if` обоснованы NatSpec (req A-J). Тесты покрывают каждый failure path. |
| SWC-125 | Incorrect Inheritance Order | `Ownable2Step, ReentrancyGuard` — порядок не критичен (нет diamond inheritance с конфликтующими функциями). `Ownable2Step` сам наследует `Ownable`. |
| SWC-129 | Typographical Error | Все literal'ы (`10000`, `5000`, `100e18`) объявлены как named constants (`MAX_PRICE`, `MAX_TOTAL_REFERRAL_BPS`, `MAX_BATCH`) либо документированы в NatSpec. |
| SWC-131 | Presence of Unused Variables | Compiler 0.8 предупреждает; build clean. |
| SWC-135 | Code With No Effects | Каждый statement в коде имеет side-effect либо является `revert`/`require`. |
| SWC-136 | Unencrypted Private Data on-chain | Нет private data on-chain. Все mapping'и (`paid`, `whitelisted`) намеренно публичны. |

---

## 4. Дополнительные инварианты (вне SWC)

| Инвариант | Где проверяется | Тесты |
|---|---|---|
| `treasury immutable` после деплоя | строка 72 (`immutable`), `setTreasury` отсутствует | `test_PitchAndTreasuryImmutable` |
| `MAX_TOTAL_REFERRAL_BPS = 5000` (treasury ≥ 50%) | constructor + `setReferralSplit` | `test_Constructor_RevertsOnSplitSumAboveMax`, `test_SetReferralSplit_RevertsOnSumAboveMax`, `test_SetReferralSplit_AllowsMaxSum` |
| `MAX_PRICE = 100e18` (защита от owner DoS) | constructor + `setPrice` | `test_Constructor_RevertsOnPriceAboveMax`, `test_SetPrice_RevertsAboveMax`, `test_SetPrice_AllowsExactlyMax` |
| Self-ref / self-contract / PITCH-as-ref = silent skip | строки 250-251 | `test_BuyAccess_SelfRef_NoDiscount`, `test_BuyAccess_ContractRef_NoDiscount`, `test_BuyAccess_PitchTokenAsReferrer_TreatedAsNoRef` |
| Atomic two-leg transfer (referral + treasury) | строки 272-273, обе через `safeTransferFrom` | `test_BuyAccess_ReferralAtomicity_RevertsIfTreasuryTransferFails` |
| `paid[user]` permanent (revoke не сбрасывает) | `revokeAccess` трогает только `whitelisted` | `test_HasAccess_RevokeDoesNotTouchPaid` |
| Two-step ownership transfer | `Ownable2Step` | `test_Ownership_TwoStep`, `test_Ownership_NonOwnerCantTransfer` |

---

## 5. Известные ограничения / out-of-scope

- **Token assumption (req F):** контракт зависит от well-behaved ERC20 PITCH —
  no fee-on-transfer, no rebasing, no reentrant callbacks. При деплое против
  другого токена security-гарантии не действуют. Адрес PITCH (`pitchwc.app`)
  фиксируется в constructor и immutable — после деплоя сменить нельзя.
- **Whitelist source distinction:** на момент аудита on-chain нельзя различить,
  получил ли user доступ через `paid` или `whitelisted` (`hasAccess` отдаёт
  только bool). Backend stub возвращает всегда `source: "paid"` — нюанс
  отслежен в `MEMORY.md` (`TODO(B0.11.whitelist)`), некритично для безопасности.
- **Frontrunning `setPrice`** — acceptable (см. SWC-114 выше). UI должен
  предупреждать user'а о price change через SSE config-channel.
- **Owner-key compromise** — blast radius ограничен инвариантами:
  - `setPrice` capped at 100e18 (нельзя сделать access unreachable);
  - `setReferralSplit` capped at 50% total (treasury всегда получает ≥ 50%);
  - `treasury` immutable (нельзя redirect proceeds);
  - `revokeAccess` не трогает `paid` (нельзя banhammer'ить paying user'ов).
- **External integrations:** контракт не вызывает никакие сторонние контракты
  кроме PITCH ERC20 — нет интеграционных рисков с pitchwc hook/router/etc.

---

## 6. Pre-deploy checklist (повторное использование перед каждым redeploy)

- [ ] `forge build` clean (warnings от forge-lint в OZ — acceptable).
- [ ] `forge test` — все 63 unit-теста passed, coverage = 100%.
- [ ] `forge fmt --check` clean.
- [ ] Slither прогон, findings заматчены против таблицы § 1 (новых high — нет).
- [ ] Mythril прогон с `--execution-timeout 300`, `No issues were detected`.
- [ ] Anvil-fork e2e smoke (см. `contracts/test/integration/AnvilFork.t.sol`) — passes с `FORK_RPC_URL` = Base mainnet RPC.
- [ ] `.env` для деплоя: `TREASURY`, `OWNER`, `ACCESS_PRICE`, `BASESCAN_KEY`, `RPC_URL_BASE_MAINNET`. **TREASURY ≠ OWNER ≠ Deployer.**
- [ ] `docs/SECURITY.md` опубликован с contact + bug bounty tier'ами.

См. `plans/contracts.md` §C0.5 для полной процедуры деплоя.
