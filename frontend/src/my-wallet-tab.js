/**
 * My Wallet bottom tab — F0.14 + Wave 2B (multi-token portfolio).
 *
 * Premium-only view of the session wallet's positions across ALL owned tokens
 * (country + player), backed by `GET /api/v1/portfolio` (api-spec §6.2).
 *
 * Replaces the original per-token `/position` view: the mockup (and product
 * expectation) is a multi-row table so users see their entire portfolio in
 * one place instead of having to switch tokens one at a time.
 *
 * UI states (mutually exclusive — only one renders at a time):
 *   - LOCKED:      not premium → compact "Premium feature" placeholder. The
 *     lock-badge + pay-modal CTA live on the bottom-tab BUTTON
 *     (`components/bottom/index.js`); this pane intentionally avoids the gold
 *     pro-cover so the upgrade pitch isn't repeated everywhere.
 *     We never request `/portfolio` while locked (it'd 401/402 anyway).
 *   - LOADING:     premium, request in flight → spinner text.
 *   - EMPTY:       request OK, `items.length === 0` → friendly empty state.
 *   - DATA:        request OK, items present → portfolio table.
 *   - ERROR:       request failed → message (with status code if available).
 *
 * Re-fetch triggers:
 *   - mount + access flips to `'premium'` — load immediately.
 *   - `refresh()` — caller invokes after a known portfolio-affecting event
 *     (own SSE trade arrived, etc.).
 *   - `setToken(addr)` — kept for backward-compat with the bottom-tabs host
 *     contract; the active token only affects row-highlight + Net pos hookup,
 *     it does NOT trigger a network round-trip (multi-token data is the same
 *     regardless of which row is "active").
 *
 * Public API:
 *   mountMyWalletTab(container, opts?) -> {
 *     setToken, refresh, destroy, getState
 *   }
 *
 * Spec: docs/plans/frontend.md §F0.14, docs/api-spec.md §6.2.
 */

import * as defaultApi from './api.js';
import { get as getAccessState, subscribe as subscribeAccess } from './access-store.js';
import {
  getAccount as defaultGetAccount,
  onAccountChange as defaultOnAccountChange,
} from './wallet.js';
import { flagSrc, hasFlag } from './flags.js';
import { shortenAddress } from './utils/address.js';

function el(tag, { className, dataset, attrs, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (dataset) for (const [k, v] of Object.entries(dataset)) node.dataset[k] = v;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function formatNumber(value, digits = 4) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

function formatPct(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function formatSigned(value, digits = 4) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatNumber(value, digits)}`;
}

const BASESCAN_TX = 'https://basescan.org/tx/';

/** Format a unix-seconds timestamp as `MM-DD HH:MM` (UTC). */
function formatTradeTime(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '—';
  const d = new Date(ts * 1000);
  const MM = String(d.getUTCMonth() + 1).padStart(2, '0');
  const DD = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${MM}-${DD} ${hh}:${mm}`;
}

/**
 * Normalise a `/portfolio/trades` item. Numeric fields are coerced; non-finite
 * values become NaN so the formatters render an em-dash. `type` is constrained
 * to buy/sell, `tx` kept verbatim for the BaseScan link.
 *
 * @param {object} raw
 * @returns {{ type: 'buy'|'sell'|null, price: number, amount: number,
 *   feePitch: number, valuePitch: number, timestamp: number, tx: string }|null}
 */
function normaliseTrade(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type === 'buy' || raw.type === 'sell' ? raw.type : null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  return {
    type,
    price: num(raw.price),
    amount: num(raw.amount),
    feePitch: num(raw.feePitch),
    valuePitch: num(raw.valuePitch),
    timestamp: num(raw.timestamp),
    tx: typeof raw.tx === 'string' ? raw.tx : '',
  };
}

/**
 * Normalise a portfolio item from the `/portfolio` response. Wei strings are
 * preserved verbatim (BigInt available via `*Wei` accessors); the *Display
 * floats are used directly when the backend ships them (they were rounded
 * server-side for safe rendering) and fall back to JS-side BigInt → number
 * conversion when missing.
 *
 * @param {object} raw
 * @returns {{
 *   token: string,
 *   symbol: string,
 *   kind: 'country'|'player'|null,
 *   balance: number,
 *   avgEntry: number,
 *   currentPrice: number,
 *   value: number,
 *   pnl: number,
 *   pnlPct: number|null,
 *   breakEven: number,
 *   breakEvenBase: number,
 *   realized: number,
 *   balanceWei: string,
 * }|null}
 */
function normaliseItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const token = typeof raw.token === 'string' ? raw.token.toLowerCase() : null;
  if (!token) return null;
  const symbol = typeof raw.symbol === 'string' ? raw.symbol : '';
  const kind = raw.kind === 'country' || raw.kind === 'player' ? raw.kind : null;
  const balance = pickDisplay(raw, 'balanceDisplay', 'balance');
  const avgEntry = pickDisplay(raw, 'avgEntryPitchDisplay', 'avgEntryPitch');
  const currentPrice = pickDisplay(raw, 'currentPricePitchDisplay', 'currentPricePitch');
  const value = pickDisplay(raw, 'valuePitchDisplay', 'valuePitch');
  const pnl = pickDisplay(raw, 'pnlPitchDisplay', 'pnlPitch');
  const breakEven = pickDisplay(raw, 'breakEvenPitchDisplay', 'breakEvenPitch');
  const breakEvenBase = pickDisplay(raw, 'breakEvenBaseDisplay', 'breakEvenBaseWei');
  const realized = pickDisplay(raw, 'realizedPitchDisplay', 'realizedPitch');
  // PnL % = pnl / cost-basis where cost-basis = balance * avgEntry. Skip when
  // we can't compute meaningfully (avoid divide-by-zero, infinity, etc.).
  let pnlPct = null;
  if (Number.isFinite(balance) && Number.isFinite(avgEntry) && Number.isFinite(pnl)) {
    const cost = balance * avgEntry;
    if (cost > 0) pnlPct = (pnl / cost) * 100;
  }
  const balanceWei = typeof raw.balance === 'string' ? raw.balance : '';
  return {
    token,
    symbol,
    kind,
    balance: Number.isFinite(balance) ? balance : 0,
    avgEntry: Number.isFinite(avgEntry) ? avgEntry : 0,
    currentPrice: Number.isFinite(currentPrice) ? currentPrice : 0,
    value: Number.isFinite(value) ? value : 0,
    pnl: Number.isFinite(pnl) ? pnl : 0,
    pnlPct,
    breakEven: Number.isFinite(breakEven) ? breakEven : 0,
    breakEvenBase: Number.isFinite(breakEvenBase) ? breakEvenBase : 0,
    realized: Number.isFinite(realized) ? realized : 0,
    balanceWei,
  };
}

/**
 * Pick a display float from either the server-provided `*Display` field
 * (preferred — already safely rounded) or the raw wei string. Wei → float
 * conversion uses BigInt for the integer part to avoid Number-cast errors
 * on long strings (`>2^53`); we accept some sub-1e18 fractional loss for
 * display purposes only.
 */
function pickDisplay(raw, displayKey, weiKey) {
  const display = raw[displayKey];
  if (typeof display === 'number' && Number.isFinite(display)) return display;
  const wei = raw[weiKey];
  if (typeof wei !== 'string' || !wei) return NaN;
  if (!/^-?\d+$/.test(wei)) return NaN;
  try {
    const big = BigInt(wei);
    const WEI = 1000000000000000000n;
    const negative = big < 0n;
    const abs = negative ? -big : big;
    const whole = abs / WEI;
    const rem = abs % WEI;
    const result = Number(whole) + Number(rem) / 1e18;
    return negative ? -result : result;
  } catch {
    return NaN;
  }
}

/**
 * @typedef {object} MyWalletOpts
 * @property {{ getPortfolio?: typeof defaultApi.getPortfolio, getPortfolioTrades?: typeof defaultApi.getPortfolioTrades }} [apiClient]
 * @property {string|null} [token]    Initial active token (lowercase address).
 *   Used only for row highlight + Net pos hookup — does NOT trigger a fetch.
 * @property {{ symbol?: string, name?: string, kind?: 'player'|'country' }|null} [tokenMeta]
 *   Optional active-token meta (currently unused — multi-token table renders
 *   per-row meta from portfolio items). Kept for backward-compat with the
 *   bottom-tabs host signature.
 * @property {{ openPayModal?: Function, payOpts?: object }} [softLock]
 *   Legacy option — accepted for backward compat with callers/tests but no
 *   longer used here. The locked-state lock badge + pay-modal click handler
 *   live on the bottom-tab BUTTON now (see `components/bottom/index.js`).
 * @property {(count: number|null) => void} [onTabCount]
 *   Host callback fired with the current position count (0 / N / null when
 *   locked). Used by the bottom-tabs shell to render the tab badge.
 * @property {(addr: string|null, balance: number, breakEven?: number, breakEvenBase?: number) => void} [onBalance]
 *   Host callback fired with the freshly-fetched balance for the ACTIVE
 *   token in display units (NOT wei), plus its net-position break-even
 *   price in BOTH denominations: PITCH (`breakEven`) and base/country
 *   (`breakEvenBase`); 0 = de-risked/not held. `chart.setOwnBalance`
 *   consumes them to render the Net pos overlay line at the break-even,
 *   picking the denomination by the chart's unit toggle.
 *   Fired with 0/0/0 when the active token isn't in the portfolio (held
 *   nothing), and with the previous addr + 0/0/0 when the active token
 *   changes so the chart can clear stale lines.
 * @property {(item: { token: string, symbol: string, kind: string|null }) => void} [onTokenSelect]
 *   Host callback invoked when the user clicks a row — host resolves the
 *   full token-registry row and calls `setActiveToken` plumbing.
 * @property {() => { isConnected: boolean, address: string|null }} [getAccount]
 *   Test override for the wallet module.
 * @property {(handler: (acc: { isConnected: boolean, address: string|null }) => void) => void} [onAccountChange]
 *   Test override; subscribes to wallet account changes.
 */

/**
 * @param {HTMLElement} container
 * @param {MyWalletOpts} [opts]
 */
export function mountMyWalletTab(container, opts = {}) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('mountMyWalletTab: container must be an HTMLElement');
  }

  const apiClient = opts.apiClient ?? defaultApi;
  const onTabCount = typeof opts.onTabCount === 'function' ? opts.onTabCount : null;
  const onBalance = typeof opts.onBalance === 'function' ? opts.onBalance : null;
  const onTokenSelect = typeof opts.onTokenSelect === 'function' ? opts.onTokenSelect : null;
  const getAccount = typeof opts.getAccount === 'function' ? opts.getAccount : defaultGetAccount;
  const onAccountChange =
    typeof opts.onAccountChange === 'function' ? opts.onAccountChange : defaultOnAccountChange;

  container.replaceChildren();

  const state = {
    /** Active token (display-only — controls row highlight + Net pos). */
    token: typeof opts.token === 'string' && opts.token ? opts.token.toLowerCase() : null,
    tokenMeta: opts.tokenMeta && typeof opts.tokenMeta === 'object' ? opts.tokenMeta : null,
    accessState: getAccessState(),
    connected: !!getAccount()?.isConnected,
    loading: false,
    error: null,
    /** @type {ReturnType<typeof normaliseItem>[]} */
    items: [],
    /** Have we received at least one successful response? */
    hasLoaded: false,
    /** Generation counter — discards stale in-flight responses. */
    gen: 0,
    // ── My Trades (own trade history for the active token) ──────────────────
    // Loaded independently of the position card: the user wants to see their
    // history even after fully closing the position (qty=0), so it is keyed on
    // `state.token` rather than the existence of a portfolio item.
    /** @type {Array<object>} */
    tradeItems: [],
    tradeCursor: null,
    tradeLoading: false,
    tradeError: null,
    /** Have we received at least one successful trades response for `token`? */
    tradeLoaded: false,
    /** Generation counter for trade fetches — discards stale responses. */
    tradeGen: 0,
  };

  function emitTabCount() {
    if (!onTabCount) return;
    if (state.accessState !== 'premium') {
      onTabCount(null);
      return;
    }
    if (!state.hasLoaded) {
      onTabCount(null);
      return;
    }
    onTabCount(state.items.length);
  }

  function findActiveItem() {
    if (!state.token) return null;
    return state.items.find((it) => it.token === state.token) ?? null;
  }

  /**
   * Items to display + aggregate over. When an active token is selected the
   * view is scoped to that single token's position (header totals + list +
   * empty state all follow this subset). With no active token we fall back to
   * the full multi-token portfolio.
   *
   * @returns {ReturnType<typeof normaliseItem>[]}
   */
  function visibleItems() {
    if (!state.token) return state.items;
    return state.items.filter((it) => it.token === state.token);
  }

  function emitBalance() {
    if (!onBalance) return;
    const item = findActiveItem();
    onBalance(
      state.token,
      item ? item.balance : 0,
      item ? item.breakEven : 0,
      item ? item.breakEvenBase : 0,
    );
  }

  const root = el('div', {
    className: 'pt-mywallet',
    dataset: { testId: 'mywallet' },
  });
  container.appendChild(root);

  function renderLock() {
    root.replaceChildren();
    const wrap = el('div', {
      className: 'pt-mywallet__locked',
      dataset: { testId: 'mywallet-locked' },
    });
    wrap.appendChild(
      el('p', {
        className: 'pt-mywallet__locked-body',
        text: 'Premium feature — your multi-token portfolio appears here once you upgrade.',
      }),
    );
    root.appendChild(wrap);
  }

  function renderDisconnected() {
    root.replaceChildren();
    const wrap = el('div', {
      className: 'pt-mywallet__placeholder',
      dataset: { testId: 'mywallet-disconnected' },
      text: 'Connect wallet to view portfolio',
    });
    root.appendChild(wrap);
  }

  function renderLoading() {
    root.replaceChildren();
    root.appendChild(
      el('div', {
        className: 'pt-mywallet__loading',
        dataset: { testId: 'mywallet-loading' },
        text: 'Loading portfolio…',
      }),
    );
  }

  function renderError() {
    root.replaceChildren();
    root.appendChild(
      el('div', {
        className: 'pt-mywallet__error',
        dataset: { testId: 'mywallet-error' },
        text: state.error || 'Failed to load portfolio',
      }),
    );
  }

  function renderEmpty() {
    root.replaceChildren();
    // Two flavours: a token is selected but the user holds none of it
    // (scoped-empty) vs. the user holds nothing at all (portfolio-empty).
    const scopedEmpty = state.token != null;
    const wrap = el('div', {
      className: 'pt-mywallet__empty',
      dataset: { testId: 'mywallet-empty' },
    });
    const icon = el('div', { className: 'pt-mywallet__empty-icon' });
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">' +
      '<path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>' +
      '<path d="M17 12h2"/><path d="M3 9h18"/></svg>';
    wrap.appendChild(icon);
    wrap.appendChild(
      el('h4', {
        className: 'pt-mywallet__empty-title',
        text: scopedEmpty ? 'No position in this token' : 'No positions yet',
      }),
    );
    wrap.appendChild(
      el('p', {
        className: 'pt-mywallet__empty-body',
        text: scopedEmpty
          ? "You don't hold this token yet. Buy a position to see it here."
          : 'You have no holdings. Browse the markets and buy your first position.',
      }),
    );
    root.appendChild(wrap);
  }

  function buildHead() {
    const head = el('div', {
      className: 'pt-mywallet__head',
      dataset: { testId: 'mywallet-head' },
    });
    const totals = el('div', { className: 'pt-mywallet__totals' });
    totals.appendChild(
      el('span', {
        className: 'pt-mywallet__head-label',
        text: state.token ? 'Position value' : 'Total holdings',
      }),
    );
    // Scope the header aggregates to the visible subset — when a token is
    // selected this is just that one position; otherwise the full portfolio.
    const scoped = visibleItems();
    const totalValue = scoped.reduce((acc, it) => acc + (it.value || 0), 0);
    const totalPnl = scoped.reduce((acc, it) => acc + (it.pnl || 0), 0);
    const totalCost = scoped.reduce((acc, it) => acc + (it.balance || 0) * (it.avgEntry || 0), 0);
    const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : null;

    const valueWrap = el('span', { className: 'pt-mywallet__head-value' });
    valueWrap.appendChild(
      el('span', {
        text: formatNumber(totalValue, 4),
        dataset: { testId: 'mywallet-head-value' },
      }),
    );
    valueWrap.appendChild(el('span', { className: 'pt-mywallet__head-cur', text: 'PITCH' }));
    totals.appendChild(valueWrap);
    head.appendChild(totals);

    const meta = el('div', { className: 'pt-mywallet__meta' });
    if (Number.isFinite(totalPnl)) {
      const isPositive = totalPnl >= 0;
      const pill = el('span', {
        className: `pt-mywallet__pnl${isPositive ? ' is-positive' : ' is-negative'}`,
        dataset: { testId: 'mywallet-head-pnl' },
      });
      pill.appendChild(
        el('span', {
          className: 'pt-mywallet__pnl-abs',
          text: `${formatSigned(totalPnl, 4)} PITCH`,
        }),
      );
      if (totalPnlPct != null) {
        pill.appendChild(
          el('span', { className: 'pt-mywallet__pnl-pct', text: formatPct(totalPnlPct) }),
        );
      }
      meta.appendChild(pill);
    }
    head.appendChild(meta);
    return head;
  }

  function buildRow(item) {
    const isActive = state.token != null && state.token === item.token;
    const row = el('div', {
      className: `pt-mywallet__row${isActive ? ' is-active' : ''}`,
      dataset: {
        testId: 'mywallet-row',
        token: item.token,
        active: isActive ? '1' : '0',
      },
      attrs: { role: 'button', tabindex: '0' },
    });

    // Identity cell — flag + symbol/kind.
    const who = el('div', { className: 'pt-mywallet__who' });
    if (item.symbol && item.kind === 'country' && hasFlag(item.symbol)) {
      who.appendChild(
        el('img', {
          className: 'pt-mywallet__flag',
          dataset: { testId: 'mywallet-flag' },
          attrs: { src: flagSrc(item.symbol), alt: '', 'aria-hidden': 'true' },
        }),
      );
    } else {
      who.appendChild(
        el('span', { className: 'pt-mywallet__flag pt-mywallet__flag--placeholder' }),
      );
    }
    const ident = el('div', { className: 'pt-mywallet__ident' });
    const name = item.symbol || shortenAddress(item.token) || '—';
    ident.appendChild(el('div', { className: 'pt-mywallet__name', text: name }));
    const tickLabel = item.kind || 'token';
    ident.appendChild(
      el('span', {
        className: `pt-mywallet__tick pt-mywallet__tick--${tickLabel}`,
        text: tickLabel,
      }),
    );
    who.appendChild(ident);
    row.appendChild(who);

    row.appendChild(
      el('span', { className: 'pt-mywallet__num', text: formatNumber(item.balance, 4) }),
    );
    row.appendChild(
      el('span', { className: 'pt-mywallet__num', text: formatNumber(item.avgEntry, 6) }),
    );
    row.appendChild(
      el('span', { className: 'pt-mywallet__num', text: formatNumber(item.currentPrice, 6) }),
    );
    row.appendChild(
      el('span', { className: 'pt-mywallet__num', text: formatNumber(item.value, 4) }),
    );

    const pnlCell = el('span', { className: 'pt-mywallet__pnl-cell' });
    const sign = item.pnl >= 0 ? ' is-positive' : ' is-negative';
    pnlCell.appendChild(
      el('span', {
        className: `pt-mywallet__pnl-abs${sign}`,
        text: `${formatSigned(item.pnl, 4)} PITCH`,
      }),
    );
    if (item.pnlPct != null) {
      pnlCell.appendChild(
        el('span', {
          className: `pt-mywallet__pnl-pct${sign}`,
          text: formatPct(item.pnlPct),
        }),
      );
    }
    row.appendChild(pnlCell);

    function activate() {
      if (!onTokenSelect) return;
      try {
        onTokenSelect({ token: item.token, symbol: item.symbol, kind: item.kind });
      } catch (err) {
        console.error('mountMyWalletTab: onTokenSelect threw:', err);
      }
    }
    row.addEventListener('click', activate);
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        activate();
      }
    });

    return row;
  }

  /**
   * Single-token focused position card. Rendered instead of the multi-row
   * table when an active token is selected and the user holds it. The card
   * surfaces the same metrics as a table row plus break-even + realized PnL,
   * so the separate header-totals block is intentionally NOT rendered in this
   * mode (it would duplicate Position value / Unrealized PnL).
   */
  function buildCard(item) {
    const card = el('div', {
      className: 'pt-mywallet__card',
      dataset: { testId: 'mywallet-card', token: item.token },
    });

    // Header: symbol + kind badge + PnL% pill.
    const header = el('div', { className: 'pt-mywallet__card-head' });
    const ident = el('div', { className: 'pt-mywallet__card-ident' });
    ident.appendChild(
      el('span', {
        className: 'pt-mywallet__card-sym',
        text: item.symbol || shortenAddress(item.token) || '—',
      }),
    );
    const kindLabel = item.kind || 'token';
    ident.appendChild(
      el('span', {
        className: `pt-mywallet__tick pt-mywallet__tick--${kindLabel}`,
        text: `· ${kindLabel}`,
      }),
    );
    header.appendChild(ident);
    if (item.pnlPct != null) {
      const isPositive = item.pnlPct >= 0;
      header.appendChild(
        el('span', {
          className: `pt-mywallet__pnl${isPositive ? ' is-positive' : ' is-negative'}`,
          dataset: { testId: 'mywallet-card-pnlpct' },
          text: formatPct(item.pnlPct),
        }),
      );
    }
    card.appendChild(header);

    const rows = el('div', { className: 'pt-mywallet__card-rows' });

    function metric(label, valueNode, testId) {
      const r = el('div', { className: 'pt-mywallet__card-row' });
      r.appendChild(el('span', { className: 'pt-mywallet__card-label', text: label }));
      if (testId) valueNode.dataset.testId = testId;
      rows.appendChild(r);
      r.appendChild(valueNode);
    }

    metric(
      'Quantity',
      el('span', { className: 'pt-mywallet__card-value', text: formatNumber(item.balance, 4) }),
      'mywallet-card-qty',
    );
    metric(
      'Position value',
      el('span', {
        className: 'pt-mywallet__card-value',
        text: `${formatNumber(item.value, 4)} PITCH`,
      }),
      'mywallet-card-value',
    );
    metric(
      'Avg buy',
      el('span', { className: 'pt-mywallet__card-value', text: formatNumber(item.avgEntry, 6) }),
      'mywallet-card-avg',
    );
    // Break-even floored at 0 server-side is meaningless (fully de-risked) —
    // show an em-dash rather than "0.000000".
    metric(
      'Break-even',
      el('span', {
        className: 'pt-mywallet__card-value',
        text: item.breakEven > 0 ? formatNumber(item.breakEven, 6) : '—',
      }),
      'mywallet-card-breakeven',
    );

    const pnlSign = item.pnl >= 0 ? ' is-positive' : ' is-negative';
    const pnlNode = el('span', {
      className: `pt-mywallet__card-value${pnlSign}`,
      dataset: { testId: 'mywallet-card-pnl' },
    });
    pnlNode.appendChild(el('span', { text: `${formatSigned(item.pnl, 4)} PITCH` }));
    if (item.pnlPct != null) {
      pnlNode.appendChild(
        el('span', {
          className: 'pt-mywallet__card-pnlpct',
          text: ` (${formatPct(item.pnlPct)})`,
        }),
      );
    }
    metric('Unrealized PnL', pnlNode);

    const realizedSign = item.realized >= 0 ? ' is-positive' : ' is-negative';
    metric(
      'Realized PnL',
      el('span', {
        className: `pt-mywallet__card-value${realizedSign}`,
        text: `${formatSigned(item.realized, 4)} PITCH`,
      }),
      'mywallet-card-realized',
    );

    card.appendChild(rows);
    return card;
  }

  function renderData() {
    root.replaceChildren();

    // Single-token focused mode: render a position card instead of the table.
    // The card carries its own metrics, so we skip the header-totals block to
    // avoid showing Position value / Unrealized PnL twice.
    if (state.token != null) {
      const scoped = visibleItems();
      if (scoped.length === 1) {
        root.appendChild(buildCard(scoped[0]));
        return;
      }
    }

    root.appendChild(buildHead());

    const tableHead = el('div', {
      className: 'pt-mywallet__thead',
      dataset: { testId: 'mywallet-thead' },
    });
    for (const label of ['Token', 'Balance', 'Avg entry', 'Current', 'Value', 'Unrealized PnL']) {
      tableHead.appendChild(el('span', { className: 'pt-mywallet__th', text: label }));
    }
    root.appendChild(tableHead);

    const list = el('div', {
      className: 'pt-mywallet__list',
      dataset: { testId: 'mywallet-list' },
    });
    // Sort by value desc (server already sorts but we re-sort defensively
    // in case future SSE-driven mutation reorders the list locally). When an
    // active token is selected this is scoped to that single position.
    const sorted = visibleItems()
      .slice()
      .sort((a, b) => (b.value || 0) - (a.value || 0));
    for (const item of sorted) {
      list.appendChild(buildRow(item));
    }
    root.appendChild(list);
  }

  /**
   * Append the "My Trades" section to the position body when a token is active.
   * Rendered after the position card/empty-state so it shows even when the
   * user holds nothing of the selected token (history persists post-close).
   */
  function appendTradesSection() {
    const section = buildTradesSection();
    if (section) root.appendChild(section);
  }

  function render() {
    if (state.accessState !== 'premium') {
      renderLock();
      emitTabCount();
      return;
    }
    if (!state.connected) {
      renderDisconnected();
      emitTabCount();
      return;
    }
    if (state.loading && !state.hasLoaded) {
      renderLoading();
      // The My Trades history is keyed off the active token, not the portfolio
      // load — keep it visible (with its own loader) while /portfolio is still
      // in flight. See review FIX 2.
      if (state.token != null) appendTradesSection();
      emitTabCount();
      return;
    }
    if (state.error) {
      renderError();
      // Trade history depends only on the active token, not on whether the
      // /portfolio fetch failed — keep it visible alongside the error. See
      // review FIX 2 (error-branch follow-up).
      if (state.token != null) appendTradesSection();
      emitTabCount();
      return;
    }
    if (!state.hasLoaded) {
      renderLoading();
      if (state.token != null) appendTradesSection();
      emitTabCount();
      return;
    }
    // Empty when there's nothing to show in the current scope: either the
    // whole portfolio is empty (no token selected) or the selected token has
    // no matching position.
    if (visibleItems().length === 0) {
      renderEmpty();
      appendTradesSection();
      emitTabCount();
      return;
    }
    renderData();
    appendTradesSection();
    emitTabCount();
  }

  async function fetchPortfolio() {
    if (state.accessState !== 'premium' || !state.connected) return;
    const fn = apiClient.getPortfolio;
    if (typeof fn !== 'function') return;
    const myGen = ++state.gen;
    state.loading = true;
    state.error = null;
    render();
    try {
      const resp = await fn.call(apiClient);
      if (myGen !== state.gen) return; // stale
      const rawItems = Array.isArray(resp?.items) ? resp.items : [];
      state.items = rawItems.map(normaliseItem).filter((it) => it != null);
      state.hasLoaded = true;
    } catch (err) {
      if (myGen !== state.gen) return;
      const status = err && typeof err.status === 'number' ? err.status : null;
      // 401/402 → render as locked instead of error (premium gating is the
      // host's responsibility; we just degrade gracefully).
      if (status === 401 || status === 402) {
        state.items = [];
        state.hasLoaded = true;
        state.error = null;
      } else {
        const detail = err?.detail || err?.title || err?.message || 'Failed to load';
        state.error = status ? `${detail} (${status})` : detail;
        state.items = [];
      }
    } finally {
      if (myGen === state.gen) {
        state.loading = false;
        render();
        emitBalance();
      }
    }
  }

  // ── My Trades (own history for the active token) ──────────────────────────
  /**
   * Render the "My Trades" section. Shown whenever a token is active and the
   * user is premium + connected — independently of whether they currently hold
   * a position (per product decision: history persists after qty hits 0).
   *
   * @returns {HTMLElement|null}
   */
  function buildTradesSection() {
    if (state.token == null) return null;

    const section = el('div', {
      className: 'pt-mywallet__trades',
      dataset: { testId: 'mywallet-trades' },
    });
    section.appendChild(el('h4', { className: 'pt-mywallet__trades-title', text: 'My Trades' }));

    if (state.tradeError) {
      section.appendChild(
        el('div', {
          className: 'pt-mywallet__trades-msg pt-mywallet__error',
          dataset: { testId: 'mywallet-trades-error' },
          text: state.tradeError,
        }),
      );
      return section;
    }

    if (!state.tradeLoaded && state.tradeLoading) {
      section.appendChild(
        el('div', {
          className: 'pt-mywallet__trades-msg',
          dataset: { testId: 'mywallet-trades-loading' },
          text: 'Loading trades…',
        }),
      );
      return section;
    }

    if (state.tradeLoaded && state.tradeItems.length === 0) {
      section.appendChild(
        el('div', {
          className: 'pt-mywallet__trades-msg',
          dataset: { testId: 'mywallet-trades-empty' },
          text: 'No trades in this token yet.',
        }),
      );
      return section;
    }

    const table = el('table', {
      className: 'pt-bottom__table pt-mywallet__trades-table',
      dataset: { testId: 'mywallet-trades-table' },
    });
    const thead = el('thead');
    const headRow = el('tr');
    for (const label of ['Time', 'Side', 'Amount', 'Price', 'Fee', 'Tx']) {
      headRow.appendChild(el('th', { text: label }));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (const t of state.tradeItems) {
      const tr = el('tr', {
        className: 'pt-bottom__row',
        dataset: { testId: 'mywallet-trade-row', type: t.type ?? '' },
      });
      tr.appendChild(el('td', { className: 'time', text: formatTradeTime(t.timestamp) }));
      tr.appendChild(
        el('td', {
          className: `side side--${t.type}`,
          text: t.type === 'buy' ? 'Buy' : t.type === 'sell' ? 'Sell' : (t.type ?? '—'),
        }),
      );
      tr.appendChild(el('td', { className: 'num', text: formatNumber(t.amount, 4) }));
      tr.appendChild(el('td', { className: 'num', text: formatNumber(t.price, 6) }));
      tr.appendChild(el('td', { className: 'num', text: formatNumber(t.feePitch, 4) }));
      const txCell = el('td', { className: 'tx' });
      if (t.tx) {
        txCell.appendChild(
          el('a', {
            attrs: {
              href: BASESCAN_TX + t.tx,
              target: '_blank',
              rel: 'noopener noreferrer',
              'aria-label': 'Transaction on BaseScan',
            },
            text: '↗',
          }),
        );
      } else {
        txCell.textContent = '—';
      }
      tr.appendChild(txCell);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    section.appendChild(table);

    if (state.tradeCursor) {
      const more = el('button', {
        className: 'pt-btn pt-mywallet__trades-more',
        dataset: { testId: 'mywallet-trades-more' },
        attrs: { type: 'button' },
        text: state.tradeLoading ? 'Loading…' : 'Load more',
      });
      if (state.tradeLoading) more.setAttribute('disabled', 'true');
      more.addEventListener('click', () => {
        loadMoreTrades().catch(() => {
          /* surfaced via state.tradeError */
        });
      });
      section.appendChild(more);
    }

    return section;
  }

  /**
   * Fetch the active token's own trade history. `append` keeps the existing
   * rows and walks the cursor; otherwise it replaces the list (token switch /
   * SSE refresh). Premium + connected + token required; deduped by gen counter.
   *
   * @param {{ append?: boolean }} [opts]
   */
  async function fetchTrades({ append = false } = {}) {
    if (state.accessState !== 'premium' || !state.connected || state.token == null) return;
    const fn = apiClient.getPortfolioTrades;
    if (typeof fn !== 'function') return;
    const token = state.token;
    const cursor = append ? state.tradeCursor : null;
    const myGen = ++state.tradeGen;
    state.tradeLoading = true;
    if (!append) state.tradeError = null;
    render();
    try {
      const resp = await fn.call(apiClient, token, { limit: 50, cursor });
      if (myGen !== state.tradeGen) return; // stale (token switched mid-flight)
      const rawItems = Array.isArray(resp?.items) ? resp.items : [];
      const items = rawItems.map(normaliseTrade).filter((it) => it != null);
      state.tradeItems = append ? state.tradeItems.concat(items) : items;
      state.tradeCursor = resp?.nextCursor ?? null;
      state.tradeLoaded = true;
    } catch (err) {
      if (myGen !== state.tradeGen) return;
      const status = err && typeof err.status === 'number' ? err.status : null;
      // 401/402 degrade silently — the host owns premium gating; an empty
      // history is the graceful fallback (mirrors fetchPortfolio).
      if (status === 401 || status === 402) {
        if (!append) state.tradeItems = [];
        state.tradeCursor = null;
        state.tradeLoaded = true;
        state.tradeError = null;
      } else {
        const detail = err?.detail || err?.title || err?.message || 'Failed to load trades';
        state.tradeError = status ? `${detail} (${status})` : detail;
      }
    } finally {
      if (myGen === state.tradeGen) {
        state.tradeLoading = false;
        render();
      }
    }
  }

  async function loadMoreTrades() {
    if (!state.tradeCursor || state.tradeLoading) return;
    await fetchTrades({ append: true });
  }

  /** Reset trades state when the active token changes (or clears). */
  function resetTrades() {
    state.tradeGen += 1; // invalidate any in-flight fetch
    state.tradeItems = [];
    state.tradeCursor = null;
    state.tradeLoading = false;
    state.tradeError = null;
    state.tradeLoaded = false;
  }

  // Subscribe to access state changes — important for the "just paid" flow
  // where the user becomes premium without re-mounting the tab.
  const unsubscribeAccess = subscribeAccess((next) => {
    const prev = state.accessState;
    state.accessState = next;
    if (prev !== 'premium' && next === 'premium' && state.connected) {
      fetchPortfolio().catch(() => {
        /* surfaced via state.error */
      });
      if (state.token != null) {
        fetchTrades().catch(() => {
          /* surfaced via state.tradeError */
        });
      }
    } else if (prev === 'premium' && next !== 'premium') {
      state.items = [];
      state.hasLoaded = false;
      state.error = null;
      state.gen += 1;
      resetTrades();
      render();
    } else {
      render();
    }
  });

  // Subscribe to wallet account changes — connect/disconnect should refresh.
  let unsubscribeAccount = null;
  if (typeof onAccountChange === 'function') {
    const handler = (acc) => {
      const wasConnected = state.connected;
      state.connected = !!acc?.isConnected;
      if (!state.connected) {
        // Disconnect — clear and re-render placeholder.
        state.items = [];
        state.hasLoaded = false;
        state.error = null;
        state.gen += 1;
        resetTrades();
        render();
        if (onBalance && state.token) onBalance(state.token, 0, 0, 0);
        return;
      }
      if (!wasConnected && state.accessState === 'premium') {
        fetchPortfolio().catch(() => {
          /* surfaced via state.error */
        });
        if (state.token != null) {
          fetchTrades().catch(() => {
            /* surfaced via state.tradeError */
          });
        }
      } else {
        render();
      }
    };
    const ret = onAccountChange(handler);
    if (typeof ret === 'function') unsubscribeAccount = ret;
  }

  // Public API ──────────────────────────────────────────────────────────────
  /**
   * Set the active token (display-only — controls row highlight + Net pos).
   * No network round-trip; portfolio data is multi-token regardless.
   *
   * @param {string|null} token
   * @param {{ symbol?: string, name?: string, kind?: string }|null} [meta]
   */
  async function setToken(token, meta) {
    const normalized = typeof token === 'string' && token ? token.toLowerCase() : null;
    const newMeta = meta && typeof meta === 'object' ? meta : null;
    const prevToken = state.token;
    if (normalized === prevToken && newMeta === state.tokenMeta) return;
    // Clear stale balance on the previous token before swapping — otherwise
    // the chart's Net pos line keeps the old number.
    if (onBalance && prevToken && prevToken !== normalized) {
      onBalance(prevToken, 0, 0, 0);
    }
    const tokenChanged = normalized !== prevToken;
    state.token = normalized;
    state.tokenMeta = newMeta;
    if (tokenChanged) {
      // New active token → drop the old history and (re)load it. The trades
      // section is keyed on the token, independent of the position card.
      resetTrades();
    }
    render();
    emitBalance();
    if (tokenChanged && normalized != null) {
      fetchTrades().catch(() => {
        /* surfaced via state.tradeError */
      });
    }
  }

  async function refresh() {
    if (state.accessState !== 'premium' || !state.connected) {
      render();
      return;
    }
    // Portfolio + own-trade history are independent round-trips — fetch them in
    // parallel. A refresh() typically follows a known PnL-affecting event (own
    // SSE trade), which also adds a history row. See review FIX 5.
    await Promise.all([fetchPortfolio(), state.token != null ? fetchTrades() : Promise.resolve()]);
  }

  function destroy() {
    try {
      unsubscribeAccess();
    } catch {
      /* ignore */
    }
    if (typeof unsubscribeAccount === 'function') {
      try {
        unsubscribeAccount();
      } catch {
        /* ignore */
      }
    }
    container.replaceChildren();
  }

  function getState() {
    return {
      token: state.token,
      accessState: state.accessState,
      connected: state.connected,
      loading: state.loading,
      error: state.error,
      hasLoaded: state.hasLoaded,
      itemCount: state.items.length,
    };
  }

  render();
  if (state.accessState === 'premium' && state.connected) {
    fetchPortfolio().catch(() => {
      /* surfaced via state.error */
    });
    if (state.token != null) {
      fetchTrades().catch(() => {
        /* surfaced via state.tradeError */
      });
    }
  }

  return { setToken, refresh, destroy, getState };
}
