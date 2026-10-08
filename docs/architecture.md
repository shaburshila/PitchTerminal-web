# Architecture

PitchTerminal was a non-custodial web terminal for player and country token
markets on Base. The application is no longer online. This document describes
the final repository state, not an active service.

## System boundary

```text
Browser
  |-- REST and SSE --> Flask API --> PostgreSQL
  `-- wallet/viem --> Base L2

Background worker
  |-- reads contracts and indexed events from Base
  |-- updates market and portfolio data
  `-- submits eligible signed limit orders
```

The browser owns wallet interaction. Users sign transactions and EIP-712
orders in their wallets. The backend never receives or stores a user's private
key.

The API serves indexed market data, session state, portfolio calculations, and
order records. A separate worker handles chain indexing and order execution so
long-running RPC work does not block HTTP requests.

## Components

### Frontend

The Vite application has separate desktop and mobile layouts. It uses wagmi,
viem, and Reown AppKit for wallet access and Lightweight Charts for market
history.

The frontend is responsible for:

- token discovery, filters, sorting, and the local watchlist;
- line and candlestick charts;
- wallet connection and SIWE authentication;
- market transaction preparation and submission;
- EIP-712 limit-order signing;
- portfolio, order, referral, and access views;
- reconnecting to the SSE stream after interruptions.

Market transactions are sent from the user's wallet to Base. The API supplies
configuration and indexed data but does not proxy wallet signatures.

### API

The Flask API exposes versioned routes under `/api/v1`. It uses PostgreSQL for
indexed events, derived market state, sessions, referrals, and limit orders.

Public routes return configuration and market data. Wallet-specific routes use
a SIWE-backed session. Keeper-only access protects the armed-order feed used by
the background executor.

See [API reference](api-spec.md) for the routes present in the codebase.

### Background worker

The worker has three jobs:

1. Read market events from Base and store them idempotently by transaction hash
   and log index.
2. Recompute cached market data used by the API and SSE stream.
3. Find armed limit orders, check their conditions, submit eligible orders, and
   record the result.

The chain remains the source of truth for balances and contract state.
PostgreSQL stores indexed and derived data so the interface does not need to
rebuild a user's history on every request.

### Smart contracts

`PitchTerminalAccess` handles paid access, referrals, owner grants, and
revocations. `LimitOrderExecutor` verifies EIP-712 signatures and executes an
order against an immutable market router when its price condition is met.

Both contracts use fixed external addresses supplied at deployment. The
executor does not keep a configurable token-to-router registry.

See [Smart contracts](contracts.md) for the execution and trust model.

## Main data flows

### Wallet session

1. The browser requests a nonce.
2. The wallet signs a SIWE message containing that nonce.
3. The API verifies the message and creates the session.
4. Authenticated routes resolve the wallet from the session rather than from a
   client-supplied owner field.

### Market trade

1. The browser reads token and router configuration from the API.
2. The user reviews and signs the transaction in the wallet.
3. The wallet broadcasts the transaction to Base.
4. The worker indexes the resulting event.
5. Updated market and portfolio data reaches the browser through REST or SSE.

### Limit order

1. The frontend builds the canonical EIP-712 order.
2. The user signs it in the wallet.
3. The API validates the payload and stores the signature and order fields.
4. The keeper reads armed orders and checks the current price.
5. `LimitOrderExecutor` verifies the signature, nonce, deadline, venue, price
   condition, and minimum output before calling the fixed router.
6. The worker records success, cancellation, expiry, or failure.

## Access model

The interface distinguishes anonymous, connected, and paid users.

- Anonymous users can browse public market data.
- Connected users have a wallet-backed session.
- Paid or allowlisted users can access premium account and order features.

The access contract is authoritative for paid status. The backend may cache a
recent result for response time, but the cache does not replace contract state.

## Realtime updates

The API exposes one SSE endpoint. Events carry price, trade, balance, and order
changes. The stream sends keepalives and the client reconnects after a dropped
connection. REST remains available for the initial page load and recovery.

## Storage

PostgreSQL separates raw indexed events from derived views:

- `events` and `dex_pitch_trades` hold chain activity;
- `market_state` holds recalculable market snapshots;
- `limit_orders` holds signed order state;
- nonce and settings tables support authentication and user preferences;
- referral and Telegram tables support product features.

The table-level model is documented in [Data model](database.md).

## Deployment history

The active service ran behind Caddy in Docker Compose. GitHub Actions checked
the backend, frontend, and contracts before deployment. Sentry was used for
runtime error reporting.

The server has since been shut down and both GitHub Actions workflows are
disabled. Deployment files remain as implementation history, not as a promise
that the current repository can be launched against the former environment.

## Design constraints

- Base mainnet was the only production chain.
- Users retained custody of their wallets and funds.
- External pitchwc.app hooks and routers were trusted dependencies.
- Indexed data could lag the chain during RPC or worker failures.
- Limit-order execution depended on a funded and available keeper.
- The product was built for a limited operating window around the 2026 World
  Cup and is no longer maintained.
