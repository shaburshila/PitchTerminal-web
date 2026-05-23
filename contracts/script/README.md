# `contracts/script/` — Foundry deploy scripts

Currently only one script lives here:

- `DeployAccess.s.sol` — deploys `PitchTerminalAccess` with parameters supplied
  via env vars (see [`docs/conventions.md`](../../docs/conventions.md) §9 and
  [`docs/contracts.md`](../../docs/contracts.md) §1).

All commands below assume the working directory is `contracts/` and that
`forge` is on `$PATH` (e.g. via `export PATH="$HOME/.foundry/bin:$PATH"`).

## Required env vars

| Var | Type | Notes |
| --- | --- | --- |
| `PITCH_TOKEN` | address | PITCH ERC20 (mainnet: `0xeae13ea73bec936664a51734c8c01ec7c3b0699c`). |
| `TREASURY` | address | Immutable recipient of access payments. |
| `OWNER` | address | Initial `Ownable2Step` owner (manages price, split, whitelist). |
| `ACCESS_PRICE` | uint256 | Initial access price in PITCH wei. `0 < price ≤ 100e18`. |
| `ACCESS_BUYER_DISCOUNT_BPS` | uint16 (optional, default `2500`) | Buyer discount, bps of full price. |
| `ACCESS_REFERRAL_BPS` | uint16 (optional, default `2500`) | Referrer cashback, bps of full price. |

Invariant (enforced both in-script and on-chain):
`ACCESS_BUYER_DISCOUNT_BPS + ACCESS_REFERRAL_BPS ≤ 5000`.

## Dry-run (no broadcast)

Simulates the deploy against a live RPC without spending gas — the script logs
the parameters and the simulated deployment address, but no transaction is
sent.

```bash
PITCH_TOKEN=0xeae13ea73bec936664a51734c8c01ec7c3b0699c \
TREASURY=0xYourTreasury... \
OWNER=0xYourOwner... \
ACCESS_PRICE=1000000000000000000 \
forge script script/DeployAccess.s.sol \
    --rpc-url $RPC_URL_BASE_MAINNET
```

Add `--sender 0x<OWNER>` if the script ever queries `msg.sender`-dependent
state (it does not today, but it is a habit worth keeping for parity with the
real broadcast invocation).

## Anvil fork smoke (recommended before mainnet)

Spin up an Anvil mainnet fork in one terminal:

```bash
anvil --fork-url $RPC_URL_BASE_MAINNET --fork-block-number <recent>
```

Then in another terminal, deploy through one of Anvil's pre-funded unlocked
accounts:

```bash
PITCH_TOKEN=0xeae13ea73bec936664a51734c8c01ec7c3b0699c \
TREASURY=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
OWNER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
ACCESS_PRICE=1000000000000000000 \
forge script script/DeployAccess.s.sol \
    --rpc-url http://127.0.0.1:8545 \
    --broadcast --unlocked \
    --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
```

After deploy, verify the wiring with `cast`:

```bash
cast call $ACCESS "owner()(address)"
cast call $ACCESS "price()(uint256)"
cast call $ACCESS "buyerDiscountBps()(uint16)"  # → 2500
cast call $ACCESS "referralBps()(uint16)"       # → 2500
cast call $ACCESS "PITCH()(address)"
cast call $ACCESS "TREASURY()(address)"
```

## Base Sepolia (wiring smoke only)

Sepolia has **no** pitchwc contracts deployed (Router/Hook/PITCH live only on
Base mainnet), so an end-to-end buy-flow is impossible there. Sepolia can
still be used as a wiring smoke for the deploy script itself — deploy a
throwaway mock ERC20 first and pass its address as `PITCH_TOKEN`. Do NOT
treat a successful Sepolia deploy as proof that mainnet buy-flow works; for
that, use the Anvil fork.

## Mainnet (Ledger + Basescan verify)

```bash
PITCH_TOKEN=0xeae13ea73bec936664a51734c8c01ec7c3b0699c \
TREASURY=0xYourTreasury... \
OWNER=0xYourOwner... \
ACCESS_PRICE=1000000000000000000 \
forge script script/DeployAccess.s.sol \
    --rpc-url $RPC_URL_BASE_MAINNET \
    --account ledger --sender 0x<deployer> \
    --broadcast \
    --verify
```

`BASESCAN_KEY` is picked up automatically via the `[etherscan]` block in
`contracts/foundry.toml` (chain `base`). If you prefer explicit flags:
`--verify --etherscan-api-key $BASESCAN_KEY --verifier etherscan --verifier-url https://api.basescan.org/api`.

### Roles — three distinct addresses

On mainnet `deployer`, `OWNER`, and `TREASURY` should be **three separate
addresses**:

- **Deployer** — the address that signs the deploy tx and pays gas. The
  `--account ledger --sender 0x<deployer>` pair makes this a hardware
  wallet. Disposable: never used again after deploy.
- **`OWNER`** — manages the contract long-term (`setPrice`,
  `setReferralSplit`, `grantAccess`). May be **a Gnosis Safe multisig** —
  the contract accepts either an EOA or a smart-account here; `Ownable2Step`
  treats them identically. Strongly recommended to use Safe for any
  non-throwaway deployment.
- **`TREASURY`** — receives payments. **Immutable after deploy** — even an
  owner-key compromise can't redirect funds. Typically a multisig or cold
  wallet separate from `OWNER`.

The Anvil-fork smoke above intentionally collapses all three into one address
for convenience — that's fine for local testing, never for mainnet.

The mainnet path is gated by the C0.5 pre-conditions in
[`docs/plans/contracts.md`](../../docs/plans/contracts.md) — do **not** run
this command outside the C0.5 checklist.

## Optional: Anvil-fork integration test

`contracts/test/integration/AnvilFork.t.sol` exercises the full purchase flow
against a mainnet fork (real PITCH token, real-world holder balances simulated
via `deal`). It is **skipped by default** so CI does not need RPC access; opt
in by setting `FORK_RPC_URL`:

```bash
FORK_RPC_URL=$RPC_URL_BASE_MAINNET \
forge test --match-path test/integration/AnvilFork.t.sol -vv
```
