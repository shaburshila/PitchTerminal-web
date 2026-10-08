# Smart contracts

PitchTerminal contains two application contracts:

- `PitchTerminalAccess` for paid access, referrals, and owner-managed grants;
- `LimitOrderExecutor` for EIP-712 signed limit buys and take-profit orders.

The Solidity source is under `contracts/src`. This document explains the
contract behavior and limits without replacing the source or an independent
audit.

## PitchTerminalAccess

### Purpose

A one-time PITCH payment gives a wallet permanent paid access. The owner can
also grant or revoke allowlisted access. Revoking an allowlist entry does not
remove access that the wallet purchased.

The contract sends funds directly from the buyer to the treasury and, when
applicable, the referrer. It does not retain the payment.

### Referral settlement

Without a valid referrer, the buyer pays the full price to the immutable
treasury.

With a valid referrer:

```text
buyer payment   = price * (10,000 - buyerDiscountBps) / 10,000
referrer amount = price * referralBps / 10,000
treasury amount = buyer payment - referrer amount
```

Zero address, self-referral, the access contract, and the PITCH token contract
are treated as no referrer. Other addresses are not classified onchain; the
application layer was responsible for deciding which referral links to show.

### Owner controls

The owner can:

- grant one wallet or a batch of up to 100 wallets;
- revoke allowlisted access;
- set a non-zero access price up to 100 PITCH;
- set the buyer discount and referral share.

The combined discount and referral share cannot exceed 5,000 basis points.
The treasury address and PITCH token address are immutable. Ownership transfers
use OpenZeppelin `Ownable2Step`.

### Payment controls

- `buyAccess` applies checks-effects-interactions and `nonReentrant`.
- ERC-20 transfers use `SafeERC20`.
- Purchased access is written before external transfers; a failed transfer
  reverts the whole transaction.
- The contract has no payable receive or fallback function.
- It assumes PITCH behaves as a standard ERC-20 without transfer fees,
  rebasing, or transfer callbacks.

## LimitOrderExecutor

### Order format

The EIP-712 domain is:

| Field | Value |
|---|---|
| Name | `PitchTerminal LimitOrders` |
| Version | `1` |
| Chain ID | Deployment chain ID |
| Verifying contract | Executor address |

The signed type is:

```solidity
Order(
  address owner,
  address token,
  address quoteToken,
  uint8 venue,
  uint8 side,
  uint256 targetPrice,
  uint256 amountIn,
  uint256 slippageBps,
  uint256 expiry,
  uint256 nonce
)
```

`venue` is `0` for player markets and `1` for country markets.
`side` is `0` for a limit buy and `1` for take profit.

The frontend field order must match the Solidity type exactly. The contract
exposes `hashOrder` and `digest` so offchain code can compare its result
against the contract.

### Trigger rules

- A limit buy can execute when the live price is at or below the target.
- A take-profit order can execute when the live price is at or above the
  target.
- A zero live price is rejected.
- A non-zero expiry must not be in the past.
- Slippage is capped at 1,000 basis points.

Anyone can submit a valid order after its trigger is reached. The signer is the
source of funds and the recipient of the output.

### Output floor

Minimum output is derived from the signed target price, the signed slippage,
and the fixed 5% protocol fee. It is not derived from the live price used to
test the trigger.

For a limit buy:

```text
ideal output = amountIn * 1e18 / targetPrice
```

For take profit:

```text
ideal output = amountIn * targetPrice / 1e18
```

The contract then subtracts the 5% protocol fee and signed slippage. After the
router call, it checks the actual output-token balance against that floor and
sends the full balance to the signer.

### Execution checks

`execute` rejects:

- zero amounts, prices, or order addresses;
- unknown venues or sides;
- excessive slippage;
- expired orders;
- a used or cancelled nonce;
- a country-market order whose quote token is not PITCH;
- an invalid EOA or EIP-1271 signature;
- an unmet price condition;
- realized output below the computed minimum.

The nonce is consumed before token interaction. Input-token approval is reset
to zero after the router call. Execution uses `nonReentrant` and can be paused
by the owner.

### Cancellation and custody

An order signer can invalidate a nonce onchain through `cancel`, including
while execution is paused.

The executor is non-custodial during the intended flow: it pulls the signed
input amount, swaps it, and sends the full output balance to the signer in one
transaction. It has no rescue function. Tokens sent directly to the executor
outside `execute` cannot be recovered.

### Fixed dependencies

The PITCH token, player and country hooks, and both routers are immutable.
Changing a dependency or the fixed protocol-fee assumption requires a new
deployment. This also prevents the owner from redirecting a signed order to an
arbitrary router.

## Tooling

The contracts use Solidity 0.8.26, Foundry, and OpenZeppelin. Tests cover
payment splits, owner bounds, access state, signature verification, nonce
lifecycle, trigger conditions, slippage, router interaction, pause behavior,
and post-swap balances.

No claim of a third-party audit is made. See [Security notes](security.md) for
the review scope and remaining trust assumptions.
