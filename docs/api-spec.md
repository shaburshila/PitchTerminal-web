# API reference

The Flask API serves the browser and the limit-order keeper. All application
routes use the `/api/v1` prefix.

This is a compact reference to the routes present in `backend/app/routes`.
The Python handlers remain authoritative for validation and response fields.

## Conventions

- JSON is used for request and response bodies.
- Ethereum addresses are normalized before comparison or storage.
- Integer token amounts and prices that cannot be represented safely as JSON
  numbers are serialized as decimal strings.
- Expected API failures use problem-detail responses.
- Collection routes use bounded limits and cursors where the underlying data
  can grow.
- The frontend and API were served from the same origin.

## Authentication

PitchTerminal used Sign-In with Ethereum.

1. `POST /api/v1/auth/nonce` issued a short-lived nonce.
2. The wallet signed a SIWE message containing the nonce.
3. `POST /api/v1/auth/verify` checked the message and signature, then set the
   `pt_session` cookie.
4. `POST /api/v1/auth/logout` cleared that cookie.

Authenticated handlers derived the wallet address from the verified session.
Premium handlers also checked paid or allowlisted access. The armed-order route
used a separate keeper credential.

## Implemented routes

### Session and configuration

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/auth/nonce` | Create a SIWE nonce |
| `POST` | `/api/v1/auth/verify` | Verify a SIWE signature and start a session |
| `POST` | `/api/v1/auth/logout` | Clear the current session |
| `GET` | `/api/v1/config` | Return public chain, token, router, and UI configuration |
| `GET` | `/api/v1/health` | Report API, database, RPC, and worker health |

### Markets

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/tokens` | List player and country tokens with market data |
| `GET` | `/api/v1/tokens/{token}/chart` | Return chart points for one token |
| `GET` | `/api/v1/tokens/{token}/trades` | Return trades and aggregated holder data |
| `GET` | `/api/v1/tokens/{token}/position` | Return the premium session's position for one token |

The token list accepts the filters and sorting used by the desktop and mobile
market views. Chart and trade handlers read indexed events rather than querying
the full chain history on each request.

### Access, referrals, and profile

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/access` | Return paid or allowlisted access for the session |
| `GET` | `/api/v1/ref/{code}` | Resolve a public referral code |
| `GET` | `/api/v1/ref/me` | Return the signed-in wallet's referral code |
| `PUT` | `/api/v1/ref/me` | Create or replace that referral code |
| `DELETE` | `/api/v1/ref/me` | Remove that referral code |
| `GET` | `/api/v1/profile` | Return premium profile and wallet analytics |

### Portfolio

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/portfolio` | Return balances, values, cost basis, PnL, and ROI |
| `GET` | `/api/v1/portfolio/trades` | Return cursor-paginated wallet trades |

Portfolio calculations combine indexed events, current market data, and
onchain balances. A delayed index can affect historical calculations without
changing the user's actual balance.

### Limit orders

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/orders` | List the premium session's orders |
| `POST` | `/api/v1/orders` | Validate and store a signed order |
| `DELETE` | `/api/v1/orders/{order_id}` | Cancel an order owned by the session |
| `GET` | `/api/v1/orders/armed` | Return eligible orders to the authorized keeper |

Order creation checks the session owner, token metadata, venue, signature
payload, price condition, expiry, and idempotency before storing an order. The
contract performs its own checks again at execution time.

### Realtime stream

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/stream` | Open the server-sent event stream |

The stream emits:

- `prices` for market snapshots;
- `events` for newly indexed trades and related balance changes;
- `config` for runtime configuration changes;
- `orders` for premium order updates.

Free sessions receive public channels. A valid premium session also receives
wallet-scoped order events. The client reconnects and uses REST to recover the
latest state after a disconnect.

## Trust boundary

API responses are application views, not chain proofs. Balances, contract
ownership, access payments, and completed transactions remain verifiable on
Base. The API never accepts a raw wallet private key.
