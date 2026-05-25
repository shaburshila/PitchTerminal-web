/**
 * My Wallet bottom tab — F0.14.
 *
 * Premium-only view of the session wallet's PnL for the currently-selected
 * token. Backed by `GET /api/v1/tokens/:token/position` (api-spec §4.4), which
 * mirrors the `myWallet` block from `/tokens/:t/trades` without re-shipping
 * the trades+holders payload.
 *
 * UI states (mutually exclusive — only one renders at a time):
 *   - LOCKED:      not premium → compact "Premium feature" placeholder. The
 *     lock-badge + pay-modal CTA live on the bottom-tab BUTTON
 *     (`components/bottom/index.js`); this pane intentionally avoids the gold
 *     pro-cover so the upgrade pitch isn't repeated everywhere.
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
import { get as getAccessState, subscribe as subscribeAccess } from './access-store.js';
import { flagSrc, hasFlag } from './flags.js';

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

function shortAddr(addr) {
  if (typeof addr !== 'string' || addr.length < 10) return addr ?? '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function pnlClass(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return '';
  return value > 0 ? ' positive' : ' negative';
}

/**
 * @typedef {object} MyWalletOpts
 * @property {{ getPosition: typeof defaultApi.getPosition }} [apiClient]
 * @property {string|null} [token]    Initial selected token (lowercase address).
 * @property {{ symbol?: string, name?: string, kind?: 'player'|'country' }|null} [tokenMeta]
 *   Phase 1.5 batch 6 — optional token meta for flag + name rendering.
 * @property {{ openPayModal?: Function, payOpts?: object }} [softLock]
 *   Legacy option — accepted for backward compat with callers/tests but no
 *   longer used here. The locked-state lock badge + pay-modal click handler
 *   live on the bottom-tab BUTTON now (see `components/bottom/index.js`).
 * @property {(count: number|null) => void} [onTabCount]
 *   Phase 1.5 batch 6 — host callback fired with the current position count
 *   (0 / 1 / null). Used by the bottom-tabs shell to render the tab badge.
 * @property {(addr: string|null, balance: number) => void} [onBalance]
 *   Phase 1.5 batch 4 wiring — host callback fired with the freshly-fetched
 *   token balance in display units (NOT wei). `chart.setOwnBalance` consumes
 *   this to render the Net pos overlay line. Fired with 0 when the token
 *   has no activity, and with the previous addr + 0 when the token changes
 *   so the chart can clear the stale line before the new balance arrives.
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
  // `softLock` option kept in the signature for backward compat (callers
  // still pass `{ openPayModal, payOpts }`), but the locked-state UI is now
  // owned by the tab BUTTON (lock badge in bottom/index.js). This pane just
  // renders a compact placeholder when not premium — no full gold cover.
  const onTabCount = typeof opts.onTabCount === 'function' ? opts.onTabCount : null;
  const onBalance = typeof opts.onBalance === 'function' ? opts.onBalance : null;

  function emitBalance() {
    if (!onBalance) return;
    const pos = Number(state.data?.position);
    onBalance(state.token, Number.isFinite(pos) ? pos : 0);
  }

  container.replaceChildren();

  const state = {
    token: typeof opts.token === 'string' && opts.token ? opts.token.toLowerCase() : null,
    /** Phase 1.5 batch 6: optional token meta for flag + name rendering. */
    tokenMeta: opts.tokenMeta && typeof opts.tokenMeta === 'object' ? opts.tokenMeta : null,
    accessState: getAccessState(),
    loading: false,
    error: null,
    data: null,
    /** Generation counter — discards stale in-flight responses. */
    gen: 0,
  };

  function emitTabCount() {
    if (!onTabCount) return;
    // Count = 1 if we have an active position on this token, else 0. The
    // mockup shows a numeric count next to the tab label so users see "how
    // many tokens you hold". Single-token API limits us to 0/1 — multi-token
    // portfolio is deferred (see header note).
    if (state.accessState !== 'premium') {
      onTabCount(null);
      return;
    }
    if (!state.token || !state.data) {
      onTabCount(null);
      return;
    }
    onTabCount(state.data.hasActivity === false ? 0 : 1);
  }

  // Two siblings: the content host (rendered for premium) and the lock host
  // (used when not premium). Always exactly one is in the DOM via render().
  const root = el('div', {
    className: 'pt-mywallet',
    dataset: { testId: 'mywallet' },
  });
  container.appendChild(root);

  // No-op kept so callers using the pre-refactor return shape (`destroy`)
  // stay valid. The gold pro-cover overlay was removed — the lock affordance
  // lives on the bottom-tab BUTTON now.
  function tearDownLock() {
    /* no-op (kept for clarity at call sites) */
  }

  function renderLock() {
    // Compact placeholder for non-premium users. The "upgrade" CTA lives on
    // the tab button (lock badge → opens pay modal) and on the trade-panel
    // pro-cover; we deliberately don't repeat it here to avoid the gold-cover
    // overload the user flagged.
    root.replaceChildren();
    const wrap = el('div', {
      className: 'pt-mywallet__locked',
      dataset: { testId: 'mywallet-locked' },
    });
    wrap.appendChild(
      el('p', {
        className: 'pt-mywallet__locked-body',
        text: 'Premium feature — your per-token PnL appears here once you upgrade.',
      }),
    );
    root.appendChild(wrap);
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
    // Phase 1.5 batch 6 — illustrated empty state matches the "No tokens yet"
    // panel in the my-wallet-tab mockup (icon + heading + body copy).
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
    wrap.appendChild(el('h4', { className: 'pt-mywallet__empty-title', text: 'No position yet' }));
    wrap.appendChild(
      el('p', {
        className: 'pt-mywallet__empty-body',
        text: 'You have no trades on this token. Browse the markets to buy your first position.',
      }),
    );
    root.appendChild(wrap);
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

  /**
   * Phase 1.5 batch 6 — build the redesigned header strip with the total
   * position value + a PnL pill on the right. Mirrors the `mw-head` block
   * from `~/Downloads/pt-mockups/pt-my-wallet-tab.html`.
   */
  function buildMwHead(d) {
    const head = el('div', {
      className: 'pt-mywallet__head',
      dataset: { testId: 'mywallet-head' },
    });
    const totals = el('div', { className: 'pt-mywallet__totals' });
    totals.appendChild(
      el('span', { className: 'pt-mywallet__head-label', text: 'Total holdings' }),
    );
    const valueWrap = el('span', { className: 'pt-mywallet__head-value' });
    valueWrap.appendChild(
      el('span', {
        text: formatNumber(d.positionValue, 4),
        dataset: { testId: 'mywallet-head-value' },
      }),
    );
    valueWrap.appendChild(el('span', { className: 'pt-mywallet__head-cur', text: 'PITCH' }));
    totals.appendChild(valueWrap);
    head.appendChild(totals);

    const meta = el('div', { className: 'pt-mywallet__meta' });
    const totalPnl = typeof d.totalPnl === 'number' ? d.totalPnl : null;
    const totalPnlPct = typeof d.totalPnlPct === 'number' ? d.totalPnlPct : null;
    if (totalPnl != null) {
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

  /**
   * Phase 1.5 batch 6 — render a single redesigned "wt-row" for the currently-
   * selected token. The PnL detail grid lives below this row (preserves the
   * existing detailed-stat test IDs).
   */
  function buildTokenRow(d) {
    const row = el('div', {
      className: 'pt-mywallet__row',
      dataset: { testId: 'mywallet-row' },
    });
    // Identity cell: flag + name + symbol/kind line. We have meta only if the
    // host (main.js) passed it via setToken(addr, meta). Fall back to short-
    // address rendering when no meta is available.
    const who = el('div', { className: 'pt-mywallet__who' });
    const meta = state.tokenMeta || {};
    const symbol = typeof meta.symbol === 'string' ? meta.symbol : null;
    const kind = meta.kind === 'country' ? 'country' : meta.kind === 'player' ? 'player' : null;
    const name =
      typeof meta.name === 'string' && meta.name ? meta.name : symbol || shortAddr(state.token);

    if (symbol && kind === 'country' && hasFlag(symbol)) {
      const img = el('img', {
        className: 'pt-mywallet__flag',
        dataset: { testId: 'mywallet-flag' },
        attrs: { src: flagSrc(symbol), alt: '', 'aria-hidden': 'true' },
      });
      who.appendChild(img);
    } else {
      // Placeholder dot to keep layout consistent for player tokens.
      who.appendChild(
        el('span', { className: 'pt-mywallet__flag pt-mywallet__flag--placeholder' }),
      );
    }

    const ident = el('div', { className: 'pt-mywallet__ident' });
    ident.appendChild(el('div', { className: 'pt-mywallet__name', text: name }));
    const tick = symbol ? `${symbol} · ${kind || 'token'}` : shortAddr(state.token);
    ident.appendChild(el('span', { className: 'pt-mywallet__tick', text: tick }));
    who.appendChild(ident);
    row.appendChild(who);

    // Numeric cells — Balance / Avg buy / Current / PnL.
    row.appendChild(
      el('span', { className: 'pt-mywallet__num', text: formatNumber(d.position, 4) }),
    );
    row.appendChild(el('span', { className: 'pt-mywallet__num', text: formatNumber(d.avgBuy, 6) }));
    row.appendChild(
      el('span', { className: 'pt-mywallet__num', text: formatNumber(d.currentPrice, 6) }),
    );

    // PnL cell — absolute + percent stacked.
    const pnlCell = el('span', { className: 'pt-mywallet__pnl-cell' });
    const pnlAbs = typeof d.totalPnl === 'number' ? d.totalPnl : null;
    const pnlPct = typeof d.totalPnlPct === 'number' ? d.totalPnlPct : null;
    if (pnlAbs != null) {
      const sign = pnlAbs >= 0 ? ' is-positive' : ' is-negative';
      pnlCell.appendChild(
        el('span', {
          className: `pt-mywallet__pnl-abs${sign}`,
          text: `${formatSigned(pnlAbs, 4)} PITCH`,
        }),
      );
      if (pnlPct != null) {
        pnlCell.appendChild(
          el('span', {
            className: `pt-mywallet__pnl-pct${sign}`,
            text: formatPct(pnlPct),
          }),
        );
      }
    } else {
      pnlCell.appendChild(el('span', { className: 'pt-mywallet__pnl-abs', text: '—' }));
    }
    row.appendChild(pnlCell);

    return row;
  }

  function renderData() {
    root.replaceChildren();
    tearDownLock();
    const d = state.data || {};
    // New layout: header strip + token row, then the legacy stat grid as
    // a "Details" sub-section (preserves existing tests + UX completeness).
    root.appendChild(buildMwHead(d));

    const tableHead = el('div', {
      className: 'pt-mywallet__thead',
      dataset: { testId: 'mywallet-thead' },
    });
    for (const label of ['Token', 'Balance', 'Avg buy', 'Current', 'PnL']) {
      tableHead.appendChild(el('span', { className: 'pt-mywallet__th', text: label }));
    }
    root.appendChild(tableHead);
    root.appendChild(buildTokenRow(d));

    const detailsLabel = el('div', {
      className: 'pt-mywallet__details-label',
      text: 'Details',
    });
    root.appendChild(detailsLabel);

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
      emitTabCount();
      return;
    }
    if (!state.token) {
      renderNoToken();
      emitTabCount();
      return;
    }
    if (state.loading) {
      renderLoading();
      emitTabCount();
      return;
    }
    if (state.error) {
      renderError();
      emitTabCount();
      return;
    }
    if (!state.data) {
      // Premium + token but neither loading nor data nor error — happens
      // briefly between setToken and fetchPosition kicking off. Show loading
      // rather than a blank pane.
      renderLoading();
      emitTabCount();
      return;
    }
    if (state.data.hasActivity === false) {
      renderEmpty();
      emitTabCount();
      return;
    }
    renderData();
    emitTabCount();
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
        emitBalance();
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
  /**
   * @param {string|null} token
   * @param {{ symbol?: string, name?: string, kind?: string }|null} [meta]
   *   Phase 1.5 batch 6 — optional token meta for flag + name rendering.
   */
  async function setToken(token, meta) {
    const normalized = typeof token === 'string' && token ? token.toLowerCase() : null;
    const newMeta = meta && typeof meta === 'object' ? meta : null;
    if (normalized === state.token) {
      // Token unchanged — update meta without re-fetching data (display-only).
      // Avoids a spurious fetch when callers rebuild the meta object literal.
      if (newMeta !== state.tokenMeta) {
        state.tokenMeta = newMeta;
        render();
      }
      return;
    }
    // Clear stale balance on the previous token before swapping — otherwise
    // the chart's Net pos line keeps the old number until the new fetch lands.
    if (onBalance && state.token && state.token !== normalized) {
      onBalance(state.token, 0);
    }
    state.token = normalized;
    state.tokenMeta = newMeta;
    state.data = null;
    state.error = null;
    state.gen += 1;
    render();
    if (state.token && state.accessState === 'premium') {
      await fetchPosition();
    } else {
      emitBalance();
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
