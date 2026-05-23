# contracts/

## Что это

Foundry-проект для двух контрактов PitchTerminal-web:

- **`PitchTerminalAccess`** (фаза 0) — non-custodial gating: оплата доступа в
  PITCH + whitelist под `Ownable2Step`.
- **`LimitOrderExecutor`** (фаза 2) — исполнитель off-chain EIP-712 ордеров
  (limit-buy / take-profit) для player и country venues pitchwc.

Спецификации: [`../docs/contracts.md`](../docs/contracts.md) (интерфейсы +
security requirements), [`../docs/eip712.md`](../docs/eip712.md) (domain,
typehash, digest).

## Setup (one-time after clone)

`contracts/lib/` находится в **root `.gitignore`** — зависимости не
коммитятся и должны быть восстановлены локально:

```bash
cd contracts
forge install OpenZeppelin/openzeppelin-contracts@v5.0.2 --no-git
forge build
```

`forge-std` подтягивается автоматически как dev-зависимость (используется
только в тестах, версия не пинится).

## Common commands

| Команда | Назначение |
|---|---|
| `forge build` | Компиляция (solc 0.8.26, optimizer=200). |
| `forge test -vvv` | Unit + integration тесты. |
| `forge test --match-contract Fork --fork-url $BASE_RPC_URL` | Fork-тесты против Base mainnet (фаза 2, opt-in). |
| `forge coverage` | Покрытие тестов. |
| `forge fmt` | Автоформат. |
| `forge fmt --check` | Проверка форматирования (для CI). |

## Структура

```
contracts/
  src/         — production Solidity
  test/        — unit + integration tests
  test/mocks/  — MockPitch, MockHook, MockRouter
  test/utils/  — SigUtils etc.
  script/      — deploy + admin scripts
  interfaces/  — IHook, IRouter, IPitch
  lib/         — deps (gitignored, восстанавливается forge install)
  foundry.toml — конфиг компилятора и fmt
  remappings.txt
```

## Deps — пины

| Пакет | Версия | Используется для |
|---|---|---|
| `OpenZeppelin/openzeppelin-contracts` | `v5.0.2` | `Ownable2Step`, `SafeERC20`, `ReentrancyGuard`, `SignatureChecker`, `ECDSA`, `Pausable` |
| `foundry-rs/forge-std` | not pinned (dev) | test helpers (`Test`, `Vm`, `console`) |

При обновлении пина OZ — синхронно править этот README + проверить, что все
импорты (`@openzeppelin/contracts/...`) сохранили пути.

## Deploy

| Контракт | Script | Когда | Runbook |
|---|---|---|---|
| `PitchTerminalAccess` | `script/DeployAccess.s.sol` | фаза 0, mainnet | TBD — см. `../docs/plans/contracts.md` §C0.5 |
| `LimitOrderExecutor` | `script/DeployExecutor.s.sol` | фаза 2, после аудита | TBD — см. `../docs/plans/contracts.md` §C2.6 |

Admin/owner-скрипты (whitelist, setPrice, transferOwnership) — см.
`../docs/plans/contracts.md` §C∞.1. Реальные команды запуска появятся вместе
со скриптами.
