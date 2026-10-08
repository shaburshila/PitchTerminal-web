# Security notes

PitchTerminal handled wallet signatures and submitted transactions to Base, so
the main risks were signature misuse, incorrect order execution, stale indexed
data, owner-key abuse, and compromised infrastructure.

The application is no longer online and the repository is not maintained. This
document records controls present in the final code. It is not a security
certification or a third-party audit.

## Assets and trust boundaries

### User-controlled

- wallet private keys;
- approval and transaction signatures;
- EIP-712 order signatures;
- the decision to grant token allowance.

Private keys stayed in the wallet. The browser and API did not request or store
them.

### Application-controlled

- SIWE session signing;
- indexed market and portfolio data;
- stored signed orders;
- keeper credentials and transaction funding;
- deployment and monitoring configuration.

### External dependencies

- Base RPC availability and correctness;
- pitchwc.app hooks and routers;
- the PITCH and market token contracts;
- wallet, SIWE, viem, wagmi, and OpenZeppelin behavior.

The executor pins hook and router addresses at deployment, but it still trusts
those contracts to implement the expected market behavior.

## Wallet authentication

- The API issues short-lived SIWE nonces.
- Verification checks the signed message before creating a session.
- Wallet-specific handlers resolve the owner from the session.
- Premium handlers check paid or allowlisted access.
- Logout is idempotent and clears the session cookie.

Session compromise could expose account views or signed-order management. It
would not reveal the wallet private key, but any stored or newly requested
signature still required separate consideration.

## Market transactions

Market buys and sells were signed and broadcast by the user's wallet. The
server supplied indexed data and public configuration but did not hold a
custodial trading key for the user.

The displayed market state could lag the chain. Wallet confirmation remained
the final point where the user could inspect the actual transaction.

## Signed limit orders

The executor checks:

- EIP-712 domain and field order;
- EOA or EIP-1271 signature validity;
- owner, token, quote token, venue, side, amount, and target bounds;
- deadline and nonce state;
- the venue-specific price condition;
- the country-market PITCH quote requirement;
- maximum slippage;
- actual post-swap output against a signed-derived minimum.

The nonce is consumed before external token calls. Router approval is reset to
zero after execution. The full output-token balance is returned to the signer.
Users can cancel a nonce even while execution is paused.

Known limits:

- player-market quote-token compatibility is left to the fixed router;
- the 5% protocol-fee assumption is compiled into the executor;
- sub-dust arithmetic can round an output floor to zero, so the UI and API must
  reject impractically small orders;
- tokens sent directly to the executor cannot be rescued;
- execution depends on keeper availability and gas funding.

## Access payments

`PitchTerminalAccess` uses `SafeERC20`, `ReentrancyGuard`, and
checks-effects-interactions. The treasury and payment token are immutable.
Price and referral settings have hard bounds, and ownership transfer takes two
steps.

The contract assumes a standard ERC-20. Fee-on-transfer, rebasing, or callback
tokens are outside its model.

## Infrastructure controls used by the active service

The project included:

- separate CI checks for backend, frontend, and contracts;
- deployment only after successful checks;
- restricted keeper access to the armed-order feed;
- bounded health checks for database, RPC, and worker state;
- Caddy TLS termination;
- backup, rollback, smoke-check, and monitoring scripts;
- Sentry error reporting.

The production server has been shut down and CI/CD is disabled. Historical
deployment files may contain assumptions that no longer match a live
environment.

## Verification performed during development

The repository contains unit and integration tests for the API, SIWE flow,
portfolio calculations, realtime updates, order lifecycle, access payments,
and contract execution.

The contract review also used Foundry tests, coverage, Slither, Mythril, and
manual checks against common contract failure classes. Findings were addressed
in code or documented as assumptions. This was an internal review, not an
external audit.

## Reuse warning

Do not use this repository with real funds without revalidating dependencies,
deployment parameters, environment secrets, chain addresses, protocol fees,
and the full test suite. The code has not been maintained since the original
product window ended.
