# Smart contracts

Foundry project for the two PitchTerminal contracts:

- `PitchTerminalAccess.sol` — one-time PITCH payment, referrals, and
  allowlisted access;
- `LimitOrderExecutor.sol` — EIP-712 signed limit buys and take-profit
  orders.

The product is no longer hosted or maintained. These instructions cover local
verification of the repository, not a current production deployment.

## Requirements

- Foundry with `forge`;
- the dependencies already present under `lib/`.

## Local checks

```bash
forge fmt --check
forge build
forge test
forge coverage
```

Run the contract commands from this directory.

## Layout

```text
src/
  PitchTerminalAccess.sol
  LimitOrderExecutor.sol
  interfaces/
    IHook.sol
    IRouter.sol

test/
  application contract tests

script/
  historical deployment scripts
```

## Dependencies

The project uses pinned Foundry and OpenZeppelin sources already committed
under `lib/`. Remappings are defined in `remappings.txt`.

## Deployment status

Deployment scripts and artifacts remain for review, but the original server
and automated deployment are no longer active. Do not reuse old addresses or
environment values without checking them against the target chain.

The contracts have not received an external audit. Review
[the contract model](../docs/contracts.md) and
[security notes](../docs/security.md) before evaluating or reusing the code.
