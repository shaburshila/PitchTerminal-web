/**
 * My Wallet bottom tab — F0.14.
 *
 * Premium-only view of the session wallet's PnL for the currently-selected
 * token. Backed by `GET /api/v1/tokens/:token/position` (api-spec §4.4), which
 * mirrors the `myWallet` block from `/tokens/:t/trades` without re-shipping
 * the trades+holders payload.
 *
 * UI states (mutually exclusive — only one renders at a time):
 *   - SOFT-LOCKED: not premium → render the soft-lock overlay from F0.13.
 *     We never request `/position` while locked (it'd 401/402 anyway).
 *   - NO-TOKEN:    premium but no selected token → placeholder.
 *   - LOADING:     premium + token, request in flight → spinner text.
 *   - EMPTY:       request OK, `hasActivity === false` → friendly empty state.
 *   - DATA:        request OK, `hasActivity === true` → PnL grid + breakdown.
 *   - ERROR:       request failed → message (with status code if available).
 *
 * Re-fetch triggers:
 *   - `setToken(addr)` — load fresh data for the new token (debounced via gen).
 *   - `refresh()` — caller invokes after a known PnL-affecting event (premium
 *     unlock, a successful trade SSE event for this token, etc.).
 *   - access-store flips to `'premium'` — auto-refresh so the user sees their
 *     numbers immediately after paying.
 *
 * Public API:
 *   mountMyWalletTab(container, opts?) -> {
 *     setToken, refresh, destroy, getState
 *   }
 *
 * Spec: docs/plans/frontend.md §F0.14, docs/api-spec.md §4.4.
 */

import * as defaultApi from './api.js';
import { mountSoftLock } from './soft-lock.js';
import { get as getAccessState, subscribe as subscribeAccess } from './access-store.js';

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

function pnlClass(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return '';
  return value > 0 ? ' positive' : ' negative';
}

/**
 * @typedef {object} MyWalletOpts
 * @property {{ getPosition: typeof defaultApi.getPosition }} [apiClient]
 * @property {string|null} [token]    Initial selected token (lowercase address).
 * @property {{ openPayModal?: Function, payOpts?: object }} [softLock]
 *   Pass-through options forwarded to mountSoftLock (lets tests inject mocks).
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
  const softLockOpts = opts.softLock ?? {};

  container.replaceChildren();

  const state = {
    token: typeof opts.token === 'string' && opts.token ? opts.token.toLowerCase() : null,
    accessState: getAccessState(),
    loading: false,
    error: null,
    data: null,
    /** Generation counter — discards stale in-flight responses. */
    gen: 0,
  };

  // Two siblings: the content host (rendered for premium) and the lock host
  // (used when not premium). Always exactly one is in the DOM via render().
  const root = el('div', {
    className: 'pt-mywallet',
    dataset: { testId: 'mywallet' },
  });
  container.appendChild(root);

  /** @type {{ destroy: () => void }|null} */
  let lockHandle = null;

  function tearDownLock() {
    if (lockHandle) {
      try {
        lockHandle.destroy();
      } catch {
        /* ignore */
      }
      lockHandle = null;
    }
  }

  function renderLock() {
    root.replaceChildren();
    tearDownLock();
    // mountSoftLock both blurs and overlays — but blur requires content beneath
    // to actually be visible. Render a faux skeleton card so the user sees
    // "something is here, premium will unlock it" rather than an empty pane.
    const skeleton = el('div', {
      className: 'pt-mywallet__skeleton',
      dataset: { testId: 'mywallet-skeleton' },
    });
    skeleton.appendChild(el('div', { className: 'pt-mywallet__skel-row' }));
    skeleton.appendChild(el('div', { className: 'pt-mywallet__skel-row' }));
    skeleton.appendChild(el('div', { className: 'pt-mywallet__skel-row' }));
    root.appendChild(skeleton);
    lockHandle = mountSoftLock(root, {
      zone: 'my-wallet',
      label: 'Premium — PnL for the selected token',
      openPayModal: softLockOpts.openPayModal,
      payOpts: softLockOpts.payOpts,
    });
  }

  function renderNoToken() {
    root.replaceChildren();
    tearDownLock();
    const wrap = el('div', {
      className: 'pt-mywallet__placeholder',
      dataset: { testId: 'mywallet-no-token' },
      text: 'Select a token to see your position',
    });
    root.appendChild(wrap);
  }

  function renderLoading() {
    root.replaceChildren();
    tearDownLock();
    root.appendChild(
      el('div', {
        className: 'pt-mywallet__loading',
        dataset: { testId: 'mywallet-loading' },
        text: 'Loading position…',
      }),
    );
  }

  function renderError() {
    root.replaceChildren();
    tearDownLock();
    root.appendChild(
      el('div', {
        className: 'pt-mywallet__error',
        dataset: { testId: 'mywallet-error' },
        text: state.error || 'Failed to load position',
      }),
    );
  }

  function renderEmpty() {
    root.replaceChildren();
    tearDownLock();
    root.appendChild(
      el('div', {
        className: 'pt-mywallet__empty',
        dataset: { testId: 'mywallet-empty' },
        text: 'No trades for this token — position is empty.',
      }),
    );
  }

  function buildStat(label, value, { testId, className = '' } = {}) {
    const cell = el('div', {
      className: 'pt-mywallet__stat',
      dataset: testId ? { testId } : undefined,
    });
    cell.appendChild(el('div', { className: 'pt-mywallet__stat-label', text: label }));
    cell.appendChild(
      el('div', {
        className: `pt-mywallet__stat-value${className}`,
        text: value,
      }),
    );
    return cell;
  }

  function renderData() {
    root.replaceChildren();
    tearDownLock();
    const d = state.data || {};
    const grid = el('div', {
      className: 'pt-mywallet__grid',
      dataset: { testId: 'mywallet-grid' },
    });
    grid.appendChild(
      buildStat('Position', formatNumber(d.position, 4), {
        testId: 'mywallet-position',
      }),
    );
    grid.appendChild(
      buildStat('Avg buy', formatNumber(d.avgBuy, 6), {
        testId: 'mywallet-avgbuy',
      }),
    );
    grid.appendChild(
      buildStat('Current price', formatNumber(d.currentPrice, 6), {
        testId: 'mywallet-current',
      }),
    );
    grid.appendChild(
      buildStat('Position value', `${formatNumber(d.positionValue, 4)} PITCH`, {
        testId: 'mywallet-value',
      }),
    );
    grid.appendChild(
      buildStat('Unrealized PnL', `${formatSigned(d.unrealizedPnl, 4)} PITCH`, {
        testId: 'mywallet-unrealized',
        className: pnlClass(d.unrealizedPnl),
      }),
    );
    grid.appendChild(
      buildStat('Realized PnL', `${formatSigned(d.realizedPnl, 4)} PITCH`, {
        testId: 'mywallet-realized',
        className: pnlClass(d.realizedPnl),
      }),
    );
    grid.appendChild(
      buildStat('Total PnL', `${formatSigned(d.totalPnl, 4)} PITCH`, {
        testId: 'mywallet-total',
        className: pnlClass(d.totalPnl),
      }),
    );
    grid.appendChild(
      buildStat('ROI', formatPct(d.totalPnlPct), {
        testId: 'mywallet-roi',
        className: pnlClass(d.totalPnlPct),
      }),
    );
    grid.appendChild(
      buildStat('Break-even', formatNumber(d.breakEven, 6), { testId: 'mywallet-breakeven' }),
    );
    grid.appendChild(
      buildStat('Buys', String(d.buys ?? 0), {
        testId: 'mywallet-buys',
      }),
    );
    grid.appendChild(
      buildStat('Sells', String(d.sells ?? 0), {
        testId: 'mywallet-sells',
      }),
    );
    grid.appendChild(
      buildStat('Fees', `${formatNumber(d.feesPaid, 4)} PITCH`, {
        testId: 'mywallet-fees',
      }),
    );
    root.appendChild(grid);
  }

  function render() {
    if (state.accessState !== 'premium') {
      renderLock();
      return;
    }
    if (!state.token) {
      renderNoToken();
      return;
    }
    if (state.loading) {
      renderLoading();
      return;
    }
    if (state.error) {
      renderError();
      return;
    }
    if (!state.data) {
      // Premium + token but neither loading nor data nor error — happens
      // briefly between setToken and fetchPosition kicking off. Show loading
      // rather than a blank pane.
      renderLoading();
      return;
    }
    if (state.data.hasActivity === false) {
      renderEmpty();
      return;
    }
    renderData();
  }

  async function fetchPosition() {
    if (!state.token || state.accessState !== 'premium') return;
    const myGen = ++state.gen;
    state.loading = true;
    state.error = null;
    render();
    try {
      const resp = await apiClient.getPosition(state.token);
      if (myGen !== state.gen) return; // stale
      state.data = resp ?? null;
    } catch (err) {
      if (myGen !== state.gen) return;
      const detail = err?.detail || err?.title || err?.message || 'Failed to load';
      const status = err && typeof err.status === 'number' ? err.status : null;
      state.error = status ? `${detail} (${status})` : detail;
      state.data = null;
    } finally {
      if (myGen === state.gen) {
        state.loading = false;
        render();
      }
    }
  }

  // Subscribe to access state changes — important for the "just paid" flow
  // where the user becomes premium without re-mounting the tab.
  const unsubscribe = subscribeAccess((next) => {
    const prev = state.accessState;
    state.accessState = next;
    if (prev !== 'premium' && next === 'premium' && state.token) {
      // Just unlocked — load data now.
      fetchPosition().catch(() => {
        /* surfaced via state.error */
      });
    } else if (prev === 'premium' && next !== 'premium') {
      // Just locked — clear data so a future re-unlock starts fresh.
      state.data = null;
      state.error = null;
      state.gen += 1;
      render();
    } else {
      render();
    }
  });

  // Public API ──────────────────────────────────────────────────────────────
  async function setToken(token) {
    const normalized = typeof token === 'string' && token ? token.toLowerCase() : null;
    if (normalized === state.token) return;
    state.token = normalized;
    state.data = null;
    state.error = null;
    state.gen += 1;
    render();
    if (state.token && state.accessState === 'premium') {
      await fetchPosition();
    }
  }

  async function refresh() {
    if (!state.token || state.accessState !== 'premium') {
      render();
      return;
    }
    await fetchPosition();
  }

  function destroy() {
    try {
      unsubscribe();
    } catch {
      /* ignore */
    }
    tearDownLock();
    container.replaceChildren();
  }

  function getState() {
    // Shallow snapshot for tests / debug.
    return {
      token: state.token,
      accessState: state.accessState,
      loading: state.loading,
      error: state.error,
      hasData: state.data != null,
      hasActivity: state.data?.hasActivity ?? null,
    };
  }

  render();
  if (state.token && state.accessState === 'premium') {
    fetchPosition().catch(() => {
      /* surfaced via state.error */
    });
  }

  return { setToken, refresh, destroy, getState };
}
