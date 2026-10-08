# Product and user flows

PitchTerminal combined market discovery, trading, limit orders, and portfolio
tracking for the player and country token markets of pitchwc.app. The product
had dedicated desktop and mobile layouts.

This document records the implemented product surface. It does not describe a
service that is still available.

## Access states

The interface supported three states:

| State | Available behavior |
|---|---|
| Anonymous | Browse tokens, charts, trades, and public market data |
| Wallet connected | Sign in with Ethereum and view wallet-linked state |
| Paid or allowlisted | Use premium portfolio and order features |

Connecting a wallet and signing in were separate actions. Wallet connection
made transactions possible; SIWE established the server session used by
account-specific API routes.

## Market discovery

The main screen listed player and country tokens. Users could:

- switch between player and country markets;
- search by token name or symbol;
- filter players by role;
- sort and inspect price changes;
- maintain a browser-local watchlist;
- open a token without leaving the terminal layout.

The selected token controlled the chart, trade history, holder view, wallet
position, order list, and trade panel.

## Charts and market data

Each market exposed line and candlestick views across multiple timeframes. The
chart included the latest indexed price and could display the connected
wallet's trades and average entry data.

Market data came from indexed chain events. A temporary worker or RPC outage
could make the interface stale without changing the underlying onchain state.

## Market trading

The trade panel supported buy and sell flows.

1. The user selected a market and side.
2. The interface validated the amount and displayed the available balance.
3. The wallet requested transaction approval where needed.
4. The user reviewed and signed the market transaction.
5. The browser submitted it directly to Base.
6. Indexed trade and balance updates returned through SSE or a later REST
   refresh.

The backend did not hold a user key or submit market trades on the user's
behalf.

## Limit orders

The interface supported limit buys and take-profit orders.

1. The user selected the trigger price, input amount, slippage, and expiry.
2. The frontend created the canonical EIP-712 payload.
3. The wallet signed the order.
4. The API stored the signed order.
5. The keeper monitored armed orders.
6. The executor submitted an eligible order to the fixed market router.

Users could list and cancel their own orders. The contract also allowed an
owner to invalidate a nonce directly.

Execution was not guaranteed. It depended on the trigger price, expiry,
allowance, balance, keeper availability, current router behavior, and the
transaction succeeding on Base.

## Portfolio

The portfolio combined indexed trades with current token balances and market
prices. It displayed:

- token balances and current values;
- realized and unrealized profit and loss;
- ROI and cost basis;
- per-token positions;
- paginated wallet trade history;
- portfolio history derived from indexed activity.

Because calculations used indexed events, an incomplete index could affect the
displayed history while onchain balances remained authoritative.

## Paid access and referrals

Paid access was purchased through PitchTerminalAccess using the configured
PITCH token. The contract supported:

- a configurable access price with a hard maximum;
- an optional buyer discount and referral reward;
- owner-managed grants and revocations;
- protection against self-referral and invalid referral targets.

The profile flow allowed users to view or manage a referral code tied to their
wallet.

## Realtime behavior

The SSE connection delivered price, trade, balance, and order changes. The UI
could recover by reconnecting and fetching current state over REST. A lost SSE
connection affected freshness, not transaction custody.

## Desktop and mobile

Desktop used a multi-column terminal layout with the market list, chart,
tables, and trade panel visible together. Mobile used dedicated navigation and
modal flows rather than shrinking the desktop layout.

Both layouts shared the same API, wallet session, market state, and order
model.

## Product status

The development cycle is complete. The server was shut down after the product's
limited operating window, and the application is not maintained. The
repository remains available as a record of the product and engineering work.
