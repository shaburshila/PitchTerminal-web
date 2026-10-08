# Data model

PitchTerminal used PostgreSQL for indexed chain data, derived market state,
signed order records, and application settings. The chain remained the source
of truth for balances and completed transactions.

The schema was managed through Alembic migrations under
`backend/migrations/versions`. Those migrations are authoritative. A cleaned
[SQL snapshot](db-schema.sql) is kept for reference; this document gives the
table-level model.

## Market data

### tokens

Static metadata for player and country tokens:

- contract address;
- name and symbol;
- player or country kind;
- player role;
- country relationship for player tokens.

Country relationships are stored explicitly because a player market is quoted
in its country token.

### events

Indexed buy and sell events used by charts, holder views, positions, and PnL:

- block number, transaction hash, and log index;
- token and trader addresses;
- side, base value, token value, and fee;
- block timestamp.

Transaction hash plus log index forms the event identity. The worker can replay
a block range without creating duplicate events.

### dex_pitch_trades

External PITCH trade activity needed to reconstruct wallet cash flow outside
the player and country events indexed in `events`.

### market_state

Recalculable snapshots used by read-heavy API routes:

- current prices;
- supply and market capitalization;
- holder counts;
- percentage changes across supported periods;
- latest processed state.

This table is a cache. Losing it does not change chain state, but the worker
must rebuild it before the UI is current again.

### app_state

Indexer cursors and other singleton worker state, including the last processed
block.

## Orders

### limit_orders

The offchain record for an EIP-712 signed order:

- owner, traded token, and quote token;
- venue and side;
- target price, input amount, slippage, expiry, and nonce;
- signature;
- lifecycle status and failure reason;
- creation and update timestamps;
- execution transaction data when available.

Indexes support owner history, pending-order scans, eligible-order scans, and
expiry handling.

The database status is operational state. The executor's nonce mapping and the
chain transaction determine whether an order was consumed onchain.

## Authentication and preferences

### auth_nonces

Short-lived SIWE nonces, keyed so a message cannot be replayed after successful
verification or expiry.

### user_settings

Wallet-scoped application preferences used by authenticated views.

The session cookie itself was signed by the application. No wallet private key
was stored in PostgreSQL.

## Referrals and alerts

### referral_codes

A unique public referral code mapped to its owner wallet.

### telegram_links

The persistent relationship between a wallet and a Telegram chat used for
alerts.

### telegram_link_tokens

Short-lived, one-time tokens used during the Telegram linking flow.

## Numeric representation

Onchain token values and prices are stored as integers or high-precision
numerics. The API serializes large values as decimal strings where a JavaScript
number would lose precision.

Derived floating-point display values are not used as transaction inputs.

## Failure model

- An RPC or worker outage can delay indexed events and market snapshots.
- A delayed index can affect charts and PnL until the missing range is replayed.
- Database loss does not move user funds, but it removes application history
  until data is restored or re-indexed.
- Order execution must be reconciled against the executor contract after an
  interrupted worker run.
