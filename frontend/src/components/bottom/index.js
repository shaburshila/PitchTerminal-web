/**
 * Bottom tabs: Trades + Holders + My Wallet + Orders.
 *
 * Lives in the center column below the chart. Driven by `GET /api/v1/tokens/:t/trades`
 * (see docs/api-spec.md §4.3) which returns both `trades.items` and `wallets[]`
 * in one response — Holders is just a projection of `wallets[]`.
 *
 * Live updates:
 *   The SSE `events` channel is owned by the page (see docs/api-spec.md §8.3).
 *   The page wires `onEvents` payloads to this component via `pushTrades(items)`,
 *   which filters by current token and prepends new rows. The Holders tab is
 *   recomputed on next user-triggered refresh or token switch — full re-derive
 *   from streaming events would require server-side support not in scope.
 *
 * My Wallet (F0.14) — per-token PnL block, premium-only. Backed by
 * `GET /api/v1/tokens/:t/position`; soft-locked behind paywall.
 *
 * Orders (F0.14) — premium-only limit-orders list + kill-switch. Backend
 * support is phase 2 — the tab renders a "coming soon" placeholder until the
 * route lands; UI is fully wired so no FE-redeploy is needed for activation.
 *
 * The premium tabs are constructed lazily on the first switch to that tab to
 * avoid paying their network cost / SSE-channel attach for users who never
 * open them.
 */

import * as defaultApi from '../../api.js';
import { mountMyWalletTab } from '../../my-wallet-tab.js';
import { mountOrdersTab } from '../../orders-tab.js';
import {
  get as defaultGetAccessState,
  subscribe as defaultSubscribeAccess,
} from '../../access-store.js';

const TABS = Object.freeze(['trades', 'holders', 'my-wallet', 'orders']);
const TAB_LABEL = {
  trades: 'Trades',
  holders: 'Holders',
  'my-wallet': 'My Wallet',
  orders: 'Orders',
};
// Phase 1.5: My Wallet + Orders are premium-only. When the user is not premium
// we mark the tab buttons `.is-locked` (lock-badge + dimmed label, same pattern
// as the header Profile/Referral buttons) and intercept clicks to open the
// pay modal instead of switching tabs.
const PREMIUM_TABS = Object.freeze(['my-wallet', 'orders']);

/**
 * Lazily import access.js's openPayModal — viem/wagmi are heavy, so non-locked
 * sessions never pay the import cost. Tests inject softLock.openPayModal.
 */
async function defaultOpenPayModal(opts) {
  const mod = await import('../../access.js');
  return mod.openPayModal(opts);
}
const DEFAULT_PAGE_SIZE = 100;
const MAX_TRADES_IN_MEMORY = 500;
const BASESCAN_TX = 'https://basescan.org/tx/';
const BASESCAN_ADDR = 'https://basescan.org/address/';

function el(tag, { className, dataset, attrs, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (dataset) {
    for (const [k, v] of Object.entries(dataset)) node.dataset[k] = v;
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  }
  if (text != null) node.textContent = text;
  return node;
}

function shortAddress(addr) {
  if (typeof addr !== 'string' || addr.length < 10) return addr ?? '';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function sameAddress(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.toLowerCase() === b.toLowerCase();
}

function formatTime(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '—';
  const d = new Date(ts * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatNumber(value, opts = {}) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toFixed(opts.bigDecimals ?? 0);
  if (abs >= 1) return value.toFixed(opts.decimals ?? 2);
  if (abs >= 0.01) return value.toFixed(4);
  return value.toPrecision(3);
}

/**
 * Convert a wei decimal-string into a whole-token Number for display.
 * BigInt-based for the integer part so 18+ digit values don't lose precision
 * via Number-cast; sub-1e18 remainder is approximated for display only.
 *
 * Used by `pushBalances` (Wave 2B Task 3) to render the new holder amount
 * after an SSE balance update. Returns NaN on bad input so callers can skip.
 */
function weiStrToWhole(weiStr) {
  if (typeof weiStr !== 'string' || !/^-?\d+$/.test(weiStr)) return NaN;
  try {
    const big = BigInt(weiStr);
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

function formatPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  if (value < 0.01 && value > 0) return '<0.01%';
  return `${value.toFixed(2)}%`;
}

/**
 * Mount the bottom tabs panel.
 *
 * @param {HTMLElement} container
 * @param {{
 *   apiClient?: { getTrades: typeof defaultApi.getTrades },
 *   token?: string|null,
 *   myAddress?: string|null,
 *   pageSize?: number,
 *   softLock?: object,
 *   onBalance?: (addr: string|null, balance: number) => void,
 * }} [options]
 * @returns {{
 *   setToken: (token: string|null) => Promise<void>,
 *   setMyAddress: (address: string|null) => void,
 *   pushTrades: (trades: object[]) => void,
 *   refresh: () => Promise<void>,
 *   destroy: () => void,
 * }}
 */
export function mountBottomTabs(container, options = {}) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('mountBottomTabs: container must be an HTMLElement');
  }

  const apiClient = options.apiClient ?? defaultApi;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  // Phase 1.5: premium-gating wiring for tab buttons. Tests can inject mocked
  // access-store helpers + openPayModal via `options.access` / `options.softLock`.
  const getAccessState =
    typeof options.getAccessState === 'function' ? options.getAccessState : defaultGetAccessState;
  const subscribeAccess =
    typeof options.subscribeAccess === 'function'
      ? options.subscribeAccess
      : defaultSubscribeAccess;
  const softLockOpts = options.softLock ?? {};
  const openPayModal =
    typeof softLockOpts.openPayModal === 'function'
      ? softLockOpts.openPayModal
      : defaultOpenPayModal;

  container.replaceChildren();

  const state = {
    tab: 'trades',
    token: options.token ?? null,
    // Phase 1.5 batch 6: optional token meta forwarded to premium sub-tabs
    // (My Wallet / Orders) so they can render the country flag + symbol.
    // The host (main.js) may upgrade `setToken(addr)` to `setToken(addr, meta)`
    // when calling selectToken. Backward-compatible: undefined = no meta.
    tokenMeta: null,
    myAddress: options.myAddress ?? null,
    trades: [],
    wallets: [],
    totalTrades: 0,
    nextCursor: null,
    loading: false,
    error: null,
    // Generation counter — incremented on every setToken to discard
    // in-flight responses from a stale token.
    gen: 0,
  };

  // ── Skeleton ────────────────────────────────────────────────────────────
  const root = el('div', {
    className: 'pt-bottom',
    dataset: { testId: 'bottom', zone: 'bottom' },
  });

  const tabs = el('div', {
    className: 'pt-bottom__tabs',
    dataset: { testId: 'bottom-tabs' },
    attrs: { role: 'tablist', 'aria-label': 'Trades and holders' },
  });
  const tabButtons = {};
  const tabCounters = {};
  for (const tab of TABS) {
    const btn = el('button', {
      className: 'pt-bottom__tab',
      dataset: { tab, testId: `bottom-tab-${tab}` },
      attrs: {
        type: 'button',
        role: 'tab',
        'aria-selected': tab === state.tab ? 'true' : 'false',
      },
    });
    // Phase 1.5 batch 6: label + count badge (e.g. "Trades 249"). Counter is
    // hidden until populated to avoid the "0" flash on initial mount.
    btn.appendChild(el('span', { className: 'pt-bottom__tab-label', text: TAB_LABEL[tab] }));
    const counter = el('span', {
      className: 'pt-bottom__tab-count',
      dataset: { testId: `bottom-tab-count-${tab}` },
    });
    counter.hidden = true;
    btn.appendChild(counter);
    // Phase 1.5: lock badge for premium-only tabs (My Wallet + Orders). The
    // badge is hidden by default; CSS reveals it when the parent button is
    // `.is-locked`. Mirrors the header Profile/Referral button pattern so the
    // visual language is consistent across the app — instead of a full gold
    // pro-cover inside the pane, free users see just the 🔒 chip on the tab.
    if (PREMIUM_TABS.includes(tab)) {
      btn.appendChild(
        el('span', {
          className: 'pt-bottom__tab-lock',
          dataset: { testId: `bottom-tab-lock-${tab}` },
          attrs: { 'aria-hidden': 'true' },
          text: '🔒',
        }),
      );
    }
    tabCounters[tab] = counter;
    tabButtons[tab] = btn;
    tabs.appendChild(btn);
  }

  const body = el('div', { className: 'pt-bottom__body' });

  const tradesPane = el('div', {
    className: 'pt-bottom__pane',
    dataset: { testId: 'bottom-pane-trades', pane: 'trades' },
    attrs: { role: 'tabpanel' },
  });
  const holdersPane = el('div', {
    className: 'pt-bottom__pane',
    dataset: { testId: 'bottom-pane-holders', pane: 'holders' },
    attrs: { role: 'tabpanel' },
  });
  const myWalletPane = el('div', {
    className: 'pt-bottom__pane',
    dataset: { testId: 'bottom-pane-my-wallet', pane: 'my-wallet' },
    attrs: { role: 'tabpanel' },
  });
  const ordersPane = el('div', {
    className: 'pt-bottom__pane',
    dataset: { testId: 'bottom-pane-orders', pane: 'orders' },
    attrs: { role: 'tabpanel' },
  });

  body.appendChild(tradesPane);
  body.appendChild(holdersPane);
  body.appendChild(myWalletPane);
  body.appendChild(ordersPane);

  // Premium sub-tabs are mounted lazily on first activation so non-premium
  // (or never-opened-this-tab) users don't pay the import / mount cost.
  /** @type {ReturnType<typeof mountMyWalletTab> | null} */
  let myWalletHandle = null;
  /** @type {ReturnType<typeof mountOrdersTab> | null} */
  let ordersHandle = null;

  function ensureMyWalletMounted() {
    if (myWalletHandle) return myWalletHandle;
    myWalletHandle = mountMyWalletTab(myWalletPane, {
      apiClient,
      token: state.token,
      tokenMeta: state.tokenMeta,
      softLock: options.softLock,
      onTabCount: (n) => setTabCount('my-wallet', n),
      onBalance: options.onBalance ?? null,
      // Wave 2B: multi-token portfolio table → clicking a row selects that
      // token in the main app. Host (main.js) wires this to `selectToken`.
      onTokenSelect: options.onTokenSelect ?? null,
    });
    return myWalletHandle;
  }

  function ensureOrdersMounted() {
    if (ordersHandle) return ordersHandle;
    ordersHandle = mountOrdersTab(ordersPane, {
      apiClient,
      token: state.token,
      tokenMeta: state.tokenMeta,
      softLock: options.softLock,
      onTabCount: (n) => setTabCount('orders', n),
    });
    return ordersHandle;
  }

  const status = el('div', {
    className: 'pt-bottom__status',
    dataset: { testId: 'bottom-status' },
  });

  root.appendChild(tabs);
  root.appendChild(body);
  root.appendChild(status);
  container.appendChild(root);

  // ── Renderers ───────────────────────────────────────────────────────────
  function renderTabsAria() {
    for (const tab of TABS) {
      tabButtons[tab].setAttribute('aria-selected', tab === state.tab ? 'true' : 'false');
    }
    tradesPane.hidden = state.tab !== 'trades';
    holdersPane.hidden = state.tab !== 'holders';
    myWalletPane.hidden = state.tab !== 'my-wallet';
    ordersPane.hidden = state.tab !== 'orders';
  }

  /**
   * Update the small count badge next to a tab label (Phase 1.5 batch 6).
   * @param {string} tab        One of 'trades' | 'holders' | 'my-wallet' | 'orders'.
   * @param {number|null} count Numeric count, or null to hide the badge.
   */
  function setTabCount(tab, count) {
    const counter = tabCounters[tab];
    if (!counter) return;
    if (count == null || !Number.isFinite(count) || count < 0) {
      counter.hidden = true;
      counter.textContent = '';
      return;
    }
    counter.hidden = false;
    counter.textContent = String(count);
  }

  function renderTradeCounts() {
    // Trades count = total known (server-reported when present, otherwise
    // local rows). Holders count = number of positive-position wallets.
    if (state.token) {
      const tradesCount = state.totalTrades > 0 ? state.totalTrades : state.trades.length;
      setTabCount('trades', tradesCount);
      const holdersCount = state.wallets.filter((w) => (w?.position ?? 0) > 0).length;
      setTabCount('holders', holdersCount);
    } else {
      setTabCount('trades', null);
      setTabCount('holders', null);
    }
  }

  function renderStatus() {
    status.replaceChildren();
    if (state.error) {
      status.appendChild(el('span', { className: 'pt-bottom__error', text: state.error }));
      return;
    }
    if (state.loading) {
      status.appendChild(el('span', { className: 'pt-bottom__loading', text: 'Loading…' }));
      return;
    }
    if (!state.token) {
      status.appendChild(el('span', { text: 'Select a token' }));
      return;
    }
    if (state.tab === 'trades' && state.nextCursor) {
      const more = el('button', {
        className: 'pt-btn pt-bottom__more',
        dataset: { testId: 'bottom-load-more' },
        attrs: { type: 'button' },
        text: 'Load more',
      });
      more.addEventListener('click', loadMore);
      status.appendChild(more);
    }
  }

  function renderTrades() {
    tradesPane.replaceChildren();
    if (!state.token) return;

    const table = el('table', {
      className: 'pt-bottom__table pt-bottom__table--trades',
      dataset: { testId: 'trades-table' },
    });

    const thead = el('thead');
    const headRow = el('tr');
    for (const label of ['Time', 'Side', 'Amount', 'Price', 'Market', 'Address', 'Tx']) {
      headRow.appendChild(el('th', { text: label }));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    if (state.trades.length === 0) {
      const empty = el('tr', { dataset: { testId: 'trades-empty' } });
      const td = el('td', { text: 'No trades', attrs: { colspan: '7' } });
      td.className = 'pt-bottom__empty';
      empty.appendChild(td);
      tbody.appendChild(empty);
    } else {
      for (const trade of state.trades) {
        const mine = state.myAddress && sameAddress(trade.trader, state.myAddress);
        const tr = el('tr', {
          className: `pt-bottom__row${mine ? ' pt-bottom__row--mine' : ''}`,
          dataset: {
            testId: 'trade-row',
            type: trade.type ?? '',
            mine: mine ? '1' : '0',
          },
        });

        tr.appendChild(el('td', { className: 'time', text: formatTime(trade.timestamp) }));
        tr.appendChild(
          el('td', {
            className: `side side--${trade.type}`,
            text:
              trade.type === 'buy' ? 'Buy' : trade.type === 'sell' ? 'Sell' : (trade.type ?? ''),
          }),
        );
        tr.appendChild(el('td', { className: 'num', text: formatNumber(trade.tokenValue) }));
        tr.appendChild(el('td', { className: 'num', text: formatNumber(trade.price) }));
        tr.appendChild(el('td', { className: 'num', text: formatNumber(trade.marketPrice) }));

        const traderCell = el('td', { className: 'addr' });
        if (trade.trader) {
          const a = el('a', {
            attrs: {
              href: BASESCAN_ADDR + trade.trader,
              target: '_blank',
              rel: 'noopener noreferrer',
            },
            text: shortAddress(trade.trader),
          });
          traderCell.appendChild(a);
        } else {
          traderCell.textContent = '—';
        }
        tr.appendChild(traderCell);

        const txCell = el('td', { className: 'tx' });
        if (trade.tx) {
          const a = el('a', {
            attrs: {
              href: BASESCAN_TX + trade.tx,
              target: '_blank',
              rel: 'noopener noreferrer',
              'aria-label': 'Transaction on BaseScan',
            },
            text: '↗',
          });
          txCell.appendChild(a);
        }
        tr.appendChild(txCell);

        tbody.appendChild(tr);
      }
    }
    table.appendChild(tbody);
    tradesPane.appendChild(table);
  }

  function renderHolders() {
    holdersPane.replaceChildren();
    if (!state.token) return;

    const table = el('table', {
      className: 'pt-bottom__table pt-bottom__table--holders',
      dataset: { testId: 'holders-table' },
    });

    const thead = el('thead');
    const headRow = el('tr');
    for (const label of ['#', 'Address', 'Balance', 'Share', 'Buys', 'Sells']) {
      headRow.appendChild(el('th', { text: label }));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    const sorted = state.wallets.slice().sort((a, b) => (b.position ?? 0) - (a.position ?? 0));
    const positiveHolders = sorted.filter((w) => (w.position ?? 0) > 0);
    const totalPosition = positiveHolders.reduce((acc, w) => acc + (w.position ?? 0), 0);

    if (positiveHolders.length === 0) {
      const empty = el('tr', { dataset: { testId: 'holders-empty' } });
      const td = el('td', { text: 'No holders', attrs: { colspan: '6' } });
      td.className = 'pt-bottom__empty';
      empty.appendChild(td);
      tbody.appendChild(empty);
    } else {
      positiveHolders.forEach((wallet, idx) => {
        const mine = state.myAddress && sameAddress(wallet.address, state.myAddress);
        const tr = el('tr', {
          className: `pt-bottom__row${mine ? ' pt-bottom__row--mine' : ''}`,
          dataset: {
            testId: 'holder-row',
            rank: String(idx + 1),
            mine: mine ? '1' : '0',
          },
        });

        tr.appendChild(el('td', { className: 'rank', text: String(idx + 1) }));

        const addrCell = el('td', { className: 'addr' });
        if (wallet.address) {
          const a = el('a', {
            attrs: {
              href: BASESCAN_ADDR + wallet.address,
              target: '_blank',
              rel: 'noopener noreferrer',
            },
            text: shortAddress(wallet.address),
          });
          addrCell.appendChild(a);
        } else {
          addrCell.textContent = '—';
        }
        tr.appendChild(addrCell);

        tr.appendChild(el('td', { className: 'num', text: formatNumber(wallet.position) }));

        const sharePct = totalPosition > 0 ? ((wallet.position ?? 0) / totalPosition) * 100 : 0;
        tr.appendChild(el('td', { className: 'num', text: formatPercent(sharePct) }));

        tr.appendChild(el('td', { className: 'num', text: String(wallet.buys ?? 0) }));
        tr.appendChild(el('td', { className: 'num', text: String(wallet.sells ?? 0) }));

        tbody.appendChild(tr);
      });
    }

    table.appendChild(tbody);
    holdersPane.appendChild(table);
  }

  function renderAll() {
    renderTabsAria();
    renderTrades();
    renderHolders();
    renderTradeCounts();
    renderStatus();
  }

  // ── Data ────────────────────────────────────────────────────────────────
  async function fetchPage({ cursor = null, append = false } = {}) {
    if (!state.token) return;
    const myGen = state.gen;
    state.loading = true;
    state.error = null;
    renderStatus();
    try {
      const resp = await apiClient.getTrades(state.token, { limit: pageSize, cursor });
      if (myGen !== state.gen) return; // discard stale response
      const tradeItems = Array.isArray(resp?.trades?.items) ? resp.trades.items : [];
      if (append) {
        state.trades = state.trades.concat(tradeItems);
      } else {
        // Preserve SSE-pushed trades that arrived during the in-flight fetch.
        // Dedup by tx — items from the server win over local SSE copies.
        const known = new Set(tradeItems.map((t) => t?.tx).filter(Boolean));
        const pending = state.trades.filter((t) => t?.tx && !known.has(t.tx));
        state.trades = pending.concat(tradeItems);
      }
      if (state.trades.length > MAX_TRADES_IN_MEMORY) {
        state.trades = state.trades.slice(0, MAX_TRADES_IN_MEMORY);
      }
      state.wallets = Array.isArray(resp?.wallets) ? resp.wallets : [];
      state.totalTrades = typeof resp?.totalTrades === 'number' ? resp.totalTrades : 0;
      state.nextCursor = resp?.trades?.nextCursor ?? null;
    } catch (err) {
      if (myGen !== state.gen) return;
      state.error = err?.detail || err?.title || err?.message || 'Failed to load';
    } finally {
      if (myGen === state.gen) {
        state.loading = false;
        renderAll();
      }
    }
  }

  async function loadMore() {
    if (!state.nextCursor || state.loading) return;
    await fetchPage({ cursor: state.nextCursor, append: true });
  }

  // ── Premium gating for tab buttons ─────────────────────────────────────
  // Phase 1.5: keep My Wallet + Orders tab buttons visible but mark them
  // `.is-locked` for non-premium users (lock badge + aria-disabled). Click on
  // a locked tab opens the pay modal instead of switching panes.
  function applyTabLockState() {
    const isPremium = getAccessState() === 'premium';
    for (const tab of PREMIUM_TABS) {
      const btn = tabButtons[tab];
      if (!btn) continue;
      btn.classList.toggle('is-locked', !isPremium);
      btn.setAttribute('aria-disabled', String(!isPremium));
    }
  }
  applyTabLockState();
  const unsubscribeAccess = subscribeAccess(() => applyTabLockState());

  function tryOpenPay() {
    try {
      openPayModal(softLockOpts.payOpts);
    } catch (err) {
      // openPayModal is async-import wrapped — error surfaces to console here.
      console.error('mountBottomTabs: openPayModal threw:', err);
    }
  }

  // ── Event handlers ──────────────────────────────────────────────────────
  function onTabClick(ev) {
    const target = ev.target instanceof Element ? ev.target.closest('[data-tab]') : null;
    if (!(target instanceof HTMLElement)) return;
    const tab = target.dataset.tab;
    if (!tab || !TABS.includes(tab)) return;
    // Locked premium tab → open pay modal, do NOT switch.
    if (PREMIUM_TABS.includes(tab) && getAccessState() !== 'premium') {
      tryOpenPay();
      return;
    }
    if (state.tab === tab) return;
    state.tab = tab;
    // Lazy-mount premium tabs on first activation. The sub-tabs render a
    // compact placeholder for non-premium (no full gold cover) — the gating
    // UX is owned by the tab button itself (lock badge above).
    if (tab === 'my-wallet') ensureMyWalletMounted();
    if (tab === 'orders') ensureOrdersMounted();
    renderTabsAria();
    renderStatus();
  }

  tabs.addEventListener('click', onTabClick);

  // ── Public API ──────────────────────────────────────────────────────────
  /**
   * @param {string|null} token Lowercase token address (or null to clear).
   * @param {{ symbol?: string, name?: string, kind?: 'player'|'country' }} [meta]
   *   Optional. Phase 1.5 batch 6 — when provided, premium sub-tabs render the
   *   country flag + symbol/name in row identification. Existing callers that
   *   pass only the address keep working (sub-tabs gracefully fall back to a
   *   short-address rendering).
   */
  async function setToken(token, meta) {
    const normalized = typeof token === 'string' && token ? token.toLowerCase() : null;
    const newMeta = meta && typeof meta === 'object' ? meta : null;
    if (normalized === state.token) {
      // Token unchanged — update meta without re-fetching data (display-only).
      // Reference-equality on tokenMeta is brittle: callers often build a fresh
      // object literal per invocation, so we always forward the new meta to
      // child handles but skip the network round-trip.
      if (newMeta !== state.tokenMeta) {
        state.tokenMeta = newMeta;
        if (myWalletHandle)
          myWalletHandle.setToken(normalized, newMeta).catch(() => {
            /* surfaced */
          });
        if (ordersHandle)
          ordersHandle.setToken(normalized, newMeta).catch(() => {
            /* surfaced */
          });
      }
      return;
    }
    state.gen += 1;
    state.token = normalized;
    state.tokenMeta = newMeta;
    state.trades = [];
    state.wallets = [];
    state.totalTrades = 0;
    state.nextCursor = null;
    state.error = null;
    renderAll();
    // Propagate to premium tabs if they're already mounted. We don't await —
    // their internal data fetch is independent and shouldn't block trades.
    if (myWalletHandle)
      myWalletHandle.setToken(normalized, newMeta).catch(() => {
        /* surfaced */
      });
    if (ordersHandle)
      ordersHandle.setToken(normalized, newMeta).catch(() => {
        /* surfaced */
      });
    if (state.token) await fetchPage();
  }

  function setMyAddress(address) {
    state.myAddress = typeof address === 'string' && address ? address.toLowerCase() : null;
    renderTrades();
    renderHolders();
  }

  function pushTrades(items) {
    if (!Array.isArray(items) || items.length === 0 || !state.token) return;
    const matching = items.filter(
      (t) => t && typeof t.token === 'string' && t.token.toLowerCase() === state.token,
    );
    if (matching.length === 0) return;
    // Prepend (newest first), de-dupe by tx if present.
    const known = new Set(state.trades.map((t) => t.tx).filter(Boolean));
    const fresh = matching.filter((t) => !t.tx || !known.has(t.tx));
    if (fresh.length === 0) return;
    state.trades = fresh.concat(state.trades).slice(0, MAX_TRADES_IN_MEMORY);
    state.totalTrades += fresh.length;
    renderTrades();
    renderTradeCounts();
  }

  /**
   * Wave 2B Task 3 — apply SSE `balances` field from the `event: events`
   * payload to the local Holders state, so the Holders count + per-holder
   * amounts update live without waiting for a full /trades refresh on
   * token-switch.
   *
   * Input shape (api-spec §8.3, additive after Phase 2):
   *   balances: [{ address: '0x...', token: '0x...', wei: '1234500000000000000' }]
   *
   * Behaviour:
   *   - Filter by current active token (case-insensitive). Entries for other
   *     tokens are ignored (transfers / cross-market trades — out of scope).
   *   - Update `state.wallets[].position` for matching trader addresses.
   *   - Add a new wallet entry when the trader wasn't in the list before
   *     (with zeros for buys/sells/spent/received — they'll be backfilled
   *     on the next /trades round-trip).
   *   - When the new balance is 0 the entry stays in `state.wallets` but is
   *     filtered out of the rendered table (renderHolders already filters
   *     `position > 0`); count decreases naturally.
   *   - Re-render only the Holders pane + tab counts.
   *
   * Race protection: no generation counter needed here because we mutate
   * the same `state.wallets` array the next /trades fetch will replace;
   * if a fetch lands AFTER this update it overwrites with the server's
   * authoritative view (which is what we want).
   *
   * Precision: input is a wei decimal-string (NUMERIC(78,0) on backend).
   * We use BigInt arithmetic for the integer part and a float remainder
   * for display. See main.js#weiToWhole for the same pattern.
   *
   * @param {Array<{address: string, token: string, wei: string}>} balances
   */
  function pushBalances(balances) {
    if (!Array.isArray(balances) || balances.length === 0 || !state.token) return;
    const token = state.token;
    let touched = false;
    for (const entry of balances) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.token !== 'string' || entry.token.toLowerCase() !== token) continue;
      if (typeof entry.address !== 'string' || !entry.address) continue;
      if (typeof entry.wei !== 'string' || !/^-?\d+$/.test(entry.wei)) continue;
      const balance = weiStrToWhole(entry.wei);
      if (!Number.isFinite(balance)) continue;
      // Negative wei would only appear from out-of-order indexing; the
      // backend clamps to 0 before NOTIFY, but we defensively clamp again.
      const safeBalance = balance < 0 ? 0 : balance;
      const addrLc = entry.address.toLowerCase();
      const existing = state.wallets.find(
        (w) => typeof w?.address === 'string' && w.address.toLowerCase() === addrLc,
      );
      if (existing) {
        if (existing.position !== safeBalance) {
          existing.position = safeBalance;
          touched = true;
        }
      } else if (safeBalance > 0) {
        // New holder — add a stub row. Buys/sells/spent/received remain at
        // zero until the next /trades fetch backfills them.
        state.wallets.push({
          address: entry.address,
          buys: 0,
          sells: 0,
          position: safeBalance,
          spent: 0,
          received: 0,
          avgBuy: 0,
          avgNet: 0,
        });
        touched = true;
      }
    }
    if (touched) {
      renderHolders();
      renderTradeCounts();
    }
  }

  async function refresh() {
    if (!state.token) return;
    state.gen += 1;
    await fetchPage();
  }

  /**
   * Forward an SSE `event: orders` payload to the Orders tab (if mounted).
   * The host owns the SSE channel — when a payload arrives, the host calls
   * this; we no-op if Orders hasn't been opened yet (re-fetch on activation
   * will pick up the latest state).
   *
   * @param {object} payload  `{ order: { id, status, ... } }`
   */
  function pushOrderUpdate(payload) {
    if (ordersHandle) ordersHandle.pushOrderUpdate(payload);
  }

  /**
   * Trigger a refresh on the My Wallet tab — call after a known PnL-affecting
   * event (e.g. a trade by this wallet on this token came in via SSE). No-op
   * if My Wallet hasn't been opened yet.
   */
  function refreshMyWallet() {
    if (myWalletHandle)
      myWalletHandle.refresh().catch(() => {
        /* surfaced */
      });
  }

  function destroy() {
    tabs.removeEventListener('click', onTabClick);
    try {
      unsubscribeAccess();
    } catch {
      /* ignore */
    }
    if (myWalletHandle) {
      try {
        myWalletHandle.destroy();
      } catch {
        /* ignore */
      }
    }
    if (ordersHandle) {
      try {
        ordersHandle.destroy();
      } catch {
        /* ignore */
      }
    }
    myWalletHandle = null;
    ordersHandle = null;
    container.replaceChildren();
  }

  renderAll();
  if (state.token) {
    fetchPage().catch(() => {
      // Errors are stored in state.error and surface via renderStatus().
    });
  }

  return {
    setToken,
    setMyAddress,
    pushTrades,
    pushBalances,
    refresh,
    pushOrderUpdate,
    refreshMyWallet,
    destroy,
  };
}
