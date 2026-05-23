# Security Policy — PitchTerminal-web

## Scope

This policy covers:

- **Smart contract:** `contracts/src/PitchTerminalAccess.sol` — `PitchTerminalAccess`
  deployed on Base mainnet (chainId 8453). Address: published in `.env.example`
  comment after deploy + release notes.
- **Backend / Frontend:** server-side code in `backend/` and browser code in
  `frontend/` of this repository.

Out of scope: the upstream `pitchwc.app` contracts (hook, router, PITCH token) —
report those to pitchwc's own channels.

## Reporting a vulnerability

**Please do NOT open a public GitHub issue for security-sensitive reports.**

Send vulnerability reports privately to:

- **Email:** `shaburshil@gmail.com`

Include:

1. A description of the vulnerability and its impact.
2. Steps to reproduce (PoC code, transactions, curl commands — whatever applies).
3. The commit hash or deployed contract address you tested against.
4. Optional: a suggested remediation.

We will acknowledge receipt within **72 hours** and aim to provide a status
update within **7 days**.

## Disclosure process

1. **Report received** — acknowledged within 72 h.
2. **Triage** — reproduce and assess severity.
3. **Fix** — patch developed and tested. For on-chain issues this may require
   redeploying the contract and migrating paid users via `grantBatch(...)` (the
   contract has no upgradability — see `docs/contracts.md`).
4. **Coordinated release** — fix shipped, then the issue is described publicly
   in the next release notes / git log with credit to the reporter (if they
   consent to being named).

We ask that you do not publicly disclose the vulnerability until the fix is
shipped. There is no fixed embargo period — we aim for the shortest reasonable
window between fix availability and public disclosure.

## No formal bug bounty programme

PitchTerminal-web is a **time-bounded application** tied to a single sporting
event (FIFA World Cup 2026) and to the upstream `pitchwc.app` markets. Treasury
balance is small (1 PITCH per access purchase, hard-capped at 100 PITCH by
contract design — see `docs/contracts.md` §1 req G/H), and the operational
lifetime of the project is measured in weeks-to-months, not years.

For these reasons we do **not** operate a formal bug bounty programme. We will
not commit in advance to monetary payouts for valid reports.

What we *will* do:

- Acknowledge your report and fix the issue.
- Credit you by name (or handle, your choice) in the public release notes /
  commit message announcing the fix, unless you prefer to remain anonymous.

If you find something genuinely critical (e.g. funds-at-risk on the deployed
contract) and would like to discuss a discretionary reward, mention it in your
report and we will respond — but please understand that this is **not a
guaranteed payout** and is bounded by the treasury balance at the time of the
report.

## Hard security guarantees of `PitchTerminalAccess`

Even in the worst case (full compromise of the owner key), the contract enforces:

- **Treasury immutability:** the `TREASURY` address is set in the constructor
  and cannot be changed by the owner. A compromised owner cannot redirect
  proceeds (req D / contract NatSpec line 60).
- **Price cap:** `setPrice` is bounded by `MAX_PRICE = 100e18` (100 PITCH).
  Attacker cannot make access unreachable through extreme prices (req G).
- **Treasury share floor:** `setReferralSplit` requires
  `buyerDiscountBps + referralBps ≤ 5000` (50%). Treasury is guaranteed to
  receive at least 50% of every purchase (req H).
- **Permanent paid access:** `revokeAccess` only flips `whitelisted[user]`,
  never `paid[user]`. The owner cannot banhammer users who paid for access
  (contract NatSpec line 146-147).
- **Two-step ownership transfer:** `Ownable2Step` requires both
  `transferOwnership(newOwner)` (by current owner) and `acceptOwnership()` (by
  the proposed new owner). A leaked-key transfer can be reverted by the legit
  owner before the new owner accepts (req C).
- **Contract not payable:** no `receive()` / `fallback()` / `payable` functions.
  Contract never holds ETH or PITCH balances — funds flow buyer →
  (referrer + treasury) atomically in the same transaction (req E).

See `docs/security-checklist.md` for the full pre-deploy audit checklist
(Slither + Mythril + SWC walk + Anvil-fork e2e smoke) and
`docs/contracts.md` §1 for the contract specification.
