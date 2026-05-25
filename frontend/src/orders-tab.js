/**
 * Orders bottom tab — F0.14.
 *
 * Premium-only list of the user's limit orders for the currently-selected
 * token. Backed by:
 *   - `GET /api/v1/orders?token=…`  — list + `armed` flag (api-spec §7.1)
 *   - `DELETE /api/v1/orders/:id`   — cancel pending (§7.3)
 *   - `PUT /api/v1/orders/armed`    — personal kill-switch (§7.4)
 *   - SSE channel `orders`          — live status transitions (§8.3)
 *
 * IMPORTANT (phase-0 status, 2026-05-24):
 *   The orders endpoint family + SSE `orders` channel are scheduled for
 *   **phase 2** of the backend (limit-order keeper is not yet implemented;
 *   see `backend/app/routes/stream.py:319` — "orders is premium-only, phase 2").
 *   The frontend ships in phase 0 with the full UI wired up; in production
 *   the first `getOrders()` call will fail with 404 / 501 and the tab will
 *   render a friendly "Limit orders — coming soon" placeholder via the
 *   `phase2_not_available` detection in `_handleListError`. When the
 *   backend lands the route, the tab activates automatically (no FE redeploy
 *   needed for the happy path).
 *
 * UI states:
 *   - LOCKED:      not premium → compact "Premium feature" placeholder. The
 *     lock-badge + pay-modal CTA live on the bottom-tab BUTTON; this pane
 *     intentionally avoids the gold pro-cover.
 *   - NO-TOKEN:    premium but no selected token → placeholder.
 *   - PHASE-2-STUB: backend returns 404/501 (route not implemented yet) →
 *     "Coming soon" notice.
 *   - LOADING / ERROR / EMPTY / DATA — straightforward.
 *
 * Live updates:
 *   The host (main.js) owns the SSE `orders` channel handler (premium-only).
 *   It calls `pushOrderUpdate(payload)` on this tab when an event arrives.
 *   The tab merges the order by id and re-renders the affected row.
 *
 * TTL countdown is recomputed via a single `setInterval(…, 1000)`. We never
 * re-render the whole table from the ticker — only the TTL cells get patched
 * to avoid wasted DOM work.
 *
 * Spec: docs/plans/frontend.md §F0.14, docs/api-spec.md §7 + §8.3.
 */

import * as defaultApi from './api.js';
import { get as getAccessState, subscribe as subscribeAccess } from './access-store.js';
import { flagSrc, hasFlag } from './flags.js';

const STATUS_LABEL = {
  pending: 'Pending',
  executing: 'Executing',
  filled: 'Filled',
  failed: 'Failed',
  cancelled: 'Cancelled',
  expired: 'Expired',
};
const SIDE_LABEL = {
  'limit-buy': 'Limit buy',
  'take-profit': 'Take-profit',
};

// Phase 1.5 batch 6: short uppercase side badge ("BUY" / "SELL") for the
// redesigned row. limit-buy → BUY, take-profit → SELL (it's a sell trigger).
const SIDE_SHORT = {
  'limit-buy': 'BUY',
  'take-profit': 'SELL',
};

// Filter chips order matches the orders-tab mockup. 'all' is the default.
const FILTERS = Object.freeze(['all', 'pending', 'filled', 'cancelled', 'expired']);
const FILTER_LABEL = {
  all: 'All',
  pending: 'Pending',
  filled: 'Filled',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

function el(tag, { className, dataset, attrs, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (dataset) for (const [k, v] of Object.entries(dataset)) node.dataset[k] = v;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

/** Convert wei-string to a human PITCH-units number (best-effort). */
function formatWeiNumber(weiStr, decimals = 18, digits = 6) {
  if (typeof weiStr !== 'string' || !/^-?\d+$/.test(weiStr)) {
    if (typeof weiStr === 'number' && Number.isFinite(weiStr)) {
      return weiStr.toLocaleString('en-US', { maximumFractionDigits: digits });
    }
    return '—';
  }
  const neg = weiStr.startsWith('-');
  const abs = neg ? weiStr.slice(1) : weiStr;
  const padded = abs.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded
    .slice(padded.length - decimals)
    .slice(0, digits)
    .replace(/0+$/, '');
  const out = frac ? `${whole}.${frac}` : whole;
  return neg ? `-${out}` : out;
}

function shortOrderToken(addr) {
  if (typeof addr !== 'string' || addr.length < 10) return addr ?? '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatTtl(expiresAt, nowSec) {
  if (!Number.isFinite(expiresAt) || expiresAt === 0 || expiresAt == null) {
    return '∞';
  }
  const remain = expiresAt - nowSec;
  if (remain <= 0) return 'expired';
  // Pretty-print: <1m → ss, <1h → mm:ss, <1d → hh:mm, else Nd hh:mm.
  const s = Math.floor(remain % 60);
  const m = Math.floor((remain / 60) % 60);
  const h = Math.floor((remain / 3600) % 24);
  const d = Math.floor(remain / 86400);
  const pad = (n) => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${pad(h)}:${pad(m)}`;
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  if (m > 0) return `${pad(m)}:${pad(s)}`;
  return `0:${pad(s)}`;
}

/**
 * Detect whether an error is "this endpoint isn't on the backend yet". 404 on
 * the orders route means the blueprint isn't registered (phase 2 hasn't
 * shipped). 501 would be a deliberate Not-Implemented placeholder.
 */
function isPhase2Unavailable(err) {
  if (!err || typeof err !== 'object') return false;
  const status = typeof err.status === 'number' ? err.status : null;
  if (status === 404 || status === 501) return true;
  // Some backends return 405 from a non-route path on the same prefix.
  if (status === 405) return true;
  return false;
}

/**
 * @typedef {object} OrdersOpts
 * @property {{
 *   getOrders: typeof defaultApi.getOrders,
 *   cancelOrder: typeof defaultApi.cancelOrder,
 *   setArmed: typeof defaultApi.setArmed
 * }} [apiClient]
 * @property {string|null} [token]
 * @property {{ openPayModal?: Function, payOpts?: object }} [softLock]
 *   Legacy option — accepted for backward compat with callers/tests but no
 *   longer used here. The locked-state lock badge + pay-modal click handler
 *   live on the bottom-tab BUTTON now (see `components/bottom/index.js`).
 * @property {() => number} [now]   ms epoch — injected for deterministic TTL tests.
 * @property {(action:string, info?:object) => void} [onActionDone]
 *   Test hook fired after cancel / armed-toggle resolves (success or error).
 * @property {{ symbol?: string, name?: string, kind?: string }|null} [tokenMeta]
 *   Phase 1.5 batch 6 — optional token meta for flag + name rendering in rows.
 * @property {(count: number|null) => void} [onTabCount]
 *   Phase 1.5 batch 6 — host callback fired with the current orders count.
 */

/**
 * @param {HTMLElement} container
 * @param {OrdersOpts} [opts]
 */
export function mountOrdersTab(container, opts = {}) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('mountOrdersTab: container must be an HTMLElement');
  }

  const apiClient = opts.apiClient ?? defaultApi;
  // `softLock` option kept in the signature for backward compat (callers
  // still pass `{ openPayModal, payOpts }`), but the locked-state UI is now
  // owned by the tab BUTTON (lock badge in bottom/index.js). This pane just
  // renders a compact placeholder when not premium — no full gold cover.
  const onTabCount = typeof opts.onTabCount === 'function' ? opts.onTabCount : null;
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const fireAction = (action, info) => {
    if (typeof opts.onActionDone === 'function') {
      try {
        opts.onActionDone(action, info);
      } catch {
        /* ignore */
      }
    }
  };

  container.replaceChildren();

  const state = {
    token: typeof opts.token === 'string' && opts.token ? opts.token.toLowerCase() : null,
    /** Phase 1.5 batch 6: optional token meta for flag + name rendering. */
    tokenMeta: opts.tokenMeta && typeof opts.tokenMeta === 'object' ? opts.tokenMeta : null,
    accessState: getAccessState(),
    orders: /** @type {object[]} */ ([]),
    armed: true,
    loading: false,
    error: null,
    /** Set when the backend route is not yet implemented (phase 2). */
    phase2: false,
    busyOrderId: null,
    busyArmed: false,
    /** Phase 1.5 batch 6: active filter chip — 'all' | status string. */
    filter: 'all',
    gen: 0,
  };

  function emitTabCount() {
    if (!onTabCount) return;
    if (state.accessState !== 'premium') {
      onTabCount(null);
      return;
    }
    if (state.phase2) {
      onTabCount(null);
      return;
    }
    onTabCount(state.orders.length);
  }

  const root = el('div', { className: 'pt-orders', dataset: { testId: 'orders' } });
  container.appendChild(root);

  let tickerId = null;

  // No-op kept so existing call sites stay valid. The full gold pro-cover
  // overlay was removed — the lock affordance lives on the bottom-tab BUTTON.
  function tearDownLock() {
    /* no-op (kept for clarity at call sites) */
  }

  function stopTicker() {
    if (tickerId !== null) {
      clearInterval(tickerId);
      tickerId = null;
    }
  }

  function startTicker() {
    stopTicker();
    if (typeof setInterval !== 'function') return;
    tickerId = setInterval(() => {
      if (state.accessState !== 'premium' || state.phase2) return;
      patchTtlCells();
    }, 1000);
  }

  function patchTtlCells() {
    const now = Math.floor(nowFn() / 1000);
    const cells = root.querySelectorAll('[data-test-id="orders-ttl"]');
    cells.forEach((cell) => {
      const expiry = Number(cell.dataset.expiresAt);
      if (!Number.isFinite(expiry)) return;
      cell.textContent = formatTtl(expiry, now);
    });
  }

  // ── Rendering ──────────────────────────────────────────────────────────
  function renderLock() {
    stopTicker();
    root.replaceChildren();
    // Compact placeholder for non-premium users. The "upgrade" CTA lives on
    // the tab button (lock badge → opens pay modal) and on the trade-panel
    // pro-cover; we deliberately don't repeat it here.
    const wrap = el('div', {
      className: 'pt-orders__locked',
      dataset: { testId: 'orders-locked' },
    });
    wrap.appendChild(
      el('p', {
        className: 'pt-orders__locked-body',
        text: 'Premium feature — your limit orders appear here once you upgrade.',
      }),
    );
    root.appendChild(wrap);
  }

  function renderNoToken() {
    stopTicker();
    root.replaceChildren();
    tearDownLock();
    root.appendChild(
      el('div', {
        className: 'pt-orders__placeholder',
        dataset: { testId: 'orders-no-token' },
        text: 'Select a token to see your orders',
      }),
    );
  }

  function renderPhase2() {
    stopTicker();
    root.replaceChildren();
    tearDownLock();
    // Phase 1.5 batch 6 — illustrated "coming soon" empty state. Uses the
    // same icon block as the orders-tab mockup empty state.
    const wrap = el('div', {
      className: 'pt-orders__phase2',
      dataset: { testId: 'orders-phase2' },
    });
    const icon = el('div', { className: 'pt-orders__empty-icon' });
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">' +
      '<path d="M4 6h16M4 12h10M4 18h7"/><circle cx="18" cy="17" r="3"/></svg>';
    wrap.appendChild(icon);
    wrap.appendChild(
      el('h4', {
        className: 'pt-orders__phase2-title',
        text: 'Limit orders — coming soon',
      }),
    );
    wrap.appendChild(
      el('p', {
        className: 'pt-orders__phase2-body',
        text:
          'The limit-order keeper (off-chain executor + EIP-712 signing) ships ' +
          'in a separate phase 2 release. Premium access already covers this ' +
          'feature — no extra purchase needed once the module is live.',
      }),
    );
    root.appendChild(wrap);
  }

  function renderLoading() {
    stopTicker();
    root.replaceChildren();
    tearDownLock();
    root.appendChild(
      el('div', {
        className: 'pt-orders__loading',
        dataset: { testId: 'orders-loading' },
        text: 'Loading orders…',
      }),
    );
  }

  function renderError() {
    stopTicker();
    root.replaceChildren();
    tearDownLock();
    root.appendChild(
      el('div', {
        className: 'pt-orders__error',
        dataset: { testId: 'orders-error' },
        text: state.error || 'Failed to load orders',
      }),
    );
  }

  function buildArmedToggle() {
    const wrap = el('label', {
      className: 'pt-orders__armed',
      dataset: { testId: 'orders-armed-wrap' },
    });
    const input = el('input', {
      className: 'pt-orders__armed-input',
      dataset: { testId: 'orders-armed' },
      attrs: { type: 'checkbox' },
    });
    input.checked = state.armed;
    input.disabled = state.busyArmed;
    input.addEventListener('change', () => {
      const desired = input.checked;
      // Revert visually until the server confirms; busy flag prevents reentry.
      input.disabled = true;
      onToggleArmed(desired).catch(() => {
        /* surfaced via error state */
      });
    });
    wrap.appendChild(input);
    wrap.appendChild(
      el('span', {
        className: 'pt-orders__armed-label',
        text: state.armed ? 'Kill-switch: armed' : 'Kill-switch: paused',
      }),
    );
    // Kept "armed"/"paused" — these are conventional EN terms.
    return wrap;
  }

  function buildToolbar() {
    const bar = el('div', {
      className: 'pt-orders__toolbar',
      dataset: { testId: 'orders-toolbar' },
    });
    bar.appendChild(buildArmedToggle());
    return bar;
  }

  /**
   * Phase 1.5 batch 6 — build the who-cell (flag + name + ticker line) for an
   * order row, using the same fallback path as my-wallet-tab (no meta → short
   * address).
   */
  function buildOrderWho(order) {
    const who = el('div', { className: 'pt-orders__who' });
    const meta =
      state.tokenMeta ||
      (order && (order.tokenSymbol || order.tokenKind)
        ? { symbol: order.tokenSymbol, kind: order.tokenKind, name: order.tokenSymbol }
        : null) ||
      {};
    const symbol = typeof meta.symbol === 'string' ? meta.symbol : null;
    const kind = meta.kind === 'country' ? 'country' : meta.kind === 'player' ? 'player' : null;
    const name =
      typeof meta.name === 'string' && meta.name
        ? meta.name
        : symbol || shortOrderToken(order.token);

    if (symbol && kind === 'country' && hasFlag(symbol)) {
      who.appendChild(
        el('img', {
          className: 'pt-orders__flag',
          dataset: { testId: 'orders-flag' },
          attrs: { src: flagSrc(symbol), alt: '', 'aria-hidden': 'true' },
        }),
      );
    } else {
      who.appendChild(el('span', { className: 'pt-orders__flag pt-orders__flag--placeholder' }));
    }

    const ident = el('div', { className: 'pt-orders__ident' });
    ident.appendChild(el('div', { className: 'pt-orders__name', text: name }));
    const tick = symbol ? `${symbol} · ${kind || 'token'}` : shortOrderToken(order.token);
    ident.appendChild(el('span', { className: 'pt-orders__tick', text: tick }));
    who.appendChild(ident);
    return who;
  }

  function buildRow(order) {
    const now = Math.floor(nowFn() / 1000);
    const tr = el('tr', {
      className: `pt-orders__row pt-orders__row--${order.status ?? 'unknown'}`,
      dataset: { testId: 'order-row', orderId: String(order.id ?? ''), status: order.status ?? '' },
    });

    // Side badge — BUY (green) / SELL (red).
    const sideShort =
      SIDE_SHORT[order.side] || (order.side === 'sell' ? 'SELL' : SIDE_LABEL[order.side] || '—');
    tr.appendChild(
      el('td', {
        className: `side side--${sideShort.toLowerCase()}`,
        text: sideShort,
      }),
    );

    // Who cell — flag + name + ticker line.
    const whoCell = el('td', { className: 'who' });
    whoCell.appendChild(buildOrderWho(order));
    tr.appendChild(whoCell);

    tr.appendChild(
      el('td', {
        className: 'num',
        text: formatWeiNumber(order.targetPrice),
      }),
    );
    tr.appendChild(
      el('td', {
        className: 'num',
        text: formatWeiNumber(order.amountIn),
      }),
    );
    tr.appendChild(
      el('td', {
        className: 'num',
        text:
          typeof order.slippageBps === 'number' ? `${(order.slippageBps / 100).toFixed(2)}%` : '—',
      }),
    );

    const ttlCell = el('td', {
      className: 'ttl',
      dataset: {
        testId: 'orders-ttl',
        expiresAt: String(order.expiresAt ?? 0),
      },
      text: formatTtl(order.expiresAt, now),
    });
    tr.appendChild(ttlCell);

    // Status pill with colored dot.
    const statusCell = el('td', { className: 'status-cell' });
    const pill = el('span', {
      className: `status status--${order.status ?? 'unknown'}`,
      dataset: { testId: 'orders-status', status: order.status ?? '' },
    });
    pill.appendChild(el('span', { className: 'status-dot' }));
    pill.appendChild(el('span', { text: STATUS_LABEL[order.status] ?? order.status ?? '—' }));
    statusCell.appendChild(pill);
    tr.appendChild(statusCell);

    const actionCell = el('td', { className: 'actions' });
    if (order.status === 'pending') {
      const btn = el('button', {
        className: 'pt-btn pt-orders__cancel',
        dataset: { testId: 'orders-cancel', orderId: String(order.id ?? '') },
        attrs: { type: 'button' },
        text: 'Cancel',
      });
      btn.disabled = state.busyOrderId === String(order.id);
      btn.addEventListener('click', () => {
        onCancelOrder(String(order.id)).catch(() => {
          /* surfaced via error */
        });
      });
      actionCell.appendChild(btn);
    }
    tr.appendChild(actionCell);

    return tr;
  }

  /**
   * Phase 1.5 batch 6 — filter chip strip (All / Pending / Filled / Cancelled /
   * Expired) with live count next to each label. Counts are derived from the
   * full `state.orders` list (NOT from the currently-filtered view), so the
   * chips always reflect the underlying dataset.
   */
  function buildFilters() {
    const counts = { all: state.orders.length };
    for (const o of state.orders) {
      const k = String(o?.status ?? '');
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const bar = el('div', {
      className: 'pt-orders__filters',
      dataset: { testId: 'orders-filters' },
    });
    for (const f of FILTERS) {
      const c = counts[f] ?? 0;
      const chip = el('button', {
        className: `pt-orders__chip${state.filter === f ? ' is-active' : ''}`,
        dataset: { testId: `orders-filter-${f}`, filter: f },
        attrs: { type: 'button' },
      });
      chip.appendChild(el('span', { text: FILTER_LABEL[f] }));
      chip.appendChild(el('span', { className: 'pt-orders__chip-count', text: String(c) }));
      chip.addEventListener('click', () => {
        if (state.filter === f) return;
        state.filter = f;
        render();
      });
      bar.appendChild(chip);
    }
    return bar;
  }

  /** Empty state used when the active filter has zero matches but orders exist. */
  function buildFilteredEmptyRow() {
    const tr = el('tr', { dataset: { testId: 'orders-empty-filtered' } });
    const td = el('td', {
      text: `No ${state.filter === 'all' ? '' : state.filter + ' '}orders`,
      attrs: { colspan: '8' },
    });
    td.className = 'pt-orders__empty';
    tr.appendChild(td);
    return tr;
  }

  /** Illustrated empty state when there are NO orders at all. */
  function buildEmptyPanel() {
    const wrap = el('div', {
      className: 'pt-orders__empty-panel',
      dataset: { testId: 'orders-empty-panel' },
    });
    const icon = el('div', { className: 'pt-orders__empty-icon' });
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">' +
      '<path d="M4 6h16M4 12h10M4 18h7"/><circle cx="18" cy="17" r="3"/></svg>';
    wrap.appendChild(icon);
    wrap.appendChild(el('h4', { className: 'pt-orders__empty-title', text: 'No orders yet' }));
    wrap.appendChild(
      el('p', {
        className: 'pt-orders__empty-body',
        text: "You haven't placed any limit orders. Place your first limit order from the trade panel.",
      }),
    );
    return wrap;
  }

  function renderData() {
    root.replaceChildren();
    tearDownLock();

    root.appendChild(buildToolbar());
    root.appendChild(buildFilters());

    // When there are no orders at all, show the illustrated empty panel
    // INSTEAD of the table — matches the mockup. We still preserve the
    // `orders-empty` test id by attaching it to the panel.
    if (state.orders.length === 0) {
      const panel = buildEmptyPanel();
      panel.dataset.testId = 'orders-empty';
      root.appendChild(panel);
      startTicker();
      return;
    }

    const table = el('table', {
      className: 'pt-orders__table',
      dataset: { testId: 'orders-table' },
    });
    const thead = el('thead');
    const headRow = el('tr');
    for (const label of ['Side', 'Token', 'Target', 'Amount', 'Slippage', 'TTL', 'Status', '']) {
      headRow.appendChild(el('th', { text: label }));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    const visible =
      state.filter === 'all'
        ? state.orders
        : state.orders.filter((o) => String(o?.status) === state.filter);

    if (visible.length === 0) {
      tbody.appendChild(buildFilteredEmptyRow());
    } else {
      for (const order of visible) {
        tbody.appendChild(buildRow(order));
      }
    }
    table.appendChild(tbody);
    root.appendChild(table);

    startTicker();
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
    if (state.phase2) {
      renderPhase2();
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
    renderData();
    emitTabCount();
  }

  // ── Data layer ─────────────────────────────────────────────────────────
  /**
   * Handles errors from `GET /orders`. 404/501/405 on the LIST endpoint means
   * the backend route family isn't shipped yet (phase 2) → flip into the
   * "coming soon" stub UI. All other errors surface inline.
   *
   * IMPORTANT: only use this for the list-fetch path. Per-order mutations
   * (cancel / armed) MUST NOT call this — a 404 from `DELETE /orders/:id`
   * is the idempotent "already gone" semantic (api-spec §7.3), not a sign
   * that the whole route family is unavailable.
   */
  function _handleListError(err) {
    if (isPhase2Unavailable(err)) {
      state.phase2 = true;
      state.error = null;
      return;
    }
    const detail = err?.detail || err?.title || err?.message || 'Failed to load';
    const status = err && typeof err.status === 'number' ? err.status : null;
    state.error = status ? `${detail} (${status})` : detail;
  }

  /** Format a per-mutation error message without touching `phase2`. */
  function _mutationErrorMessage(err, fallback) {
    const detail = err?.detail || err?.title || err?.message || fallback;
    const status = err && typeof err.status === 'number' ? err.status : null;
    return status ? `${detail} (${status})` : detail;
  }

  async function fetchOrders() {
    if (!state.token || state.accessState !== 'premium') return;
    const myGen = ++state.gen;
    state.loading = true;
    state.error = null;
    state.phase2 = false;
    render();
    try {
      const resp = await apiClient.getOrders({ token: state.token });
      if (myGen !== state.gen) return;
      state.orders = Array.isArray(resp?.items) ? resp.items : [];
      if (typeof resp?.armed === 'boolean') state.armed = resp.armed;
    } catch (err) {
      if (myGen !== state.gen) return;
      _handleListError(err);
      state.orders = [];
    } finally {
      if (myGen === state.gen) {
        state.loading = false;
        render();
      }
    }
  }

  async function onCancelOrder(id) {
    if (!id || state.busyOrderId === id) return;
    state.busyOrderId = id;
    render();
    try {
      await apiClient.cancelOrder(id);
      // Optimistic local update — server returns 204 (no body). Mark cancelled
      // immediately; SSE channel will reconfirm.
      const idx = state.orders.findIndex((o) => String(o.id) === id);
      if (idx >= 0) {
        state.orders[idx] = { ...state.orders[idx], status: 'cancelled' };
      }
      fireAction('cancel', { id, ok: true });
    } catch (err) {
      // Idempotent cancel (api-spec §7.3): a 404 means the order is already
      // gone (executed / cancelled by the keeper / TTL-expired). Treat as
      // success — flip the local row to cancelled and clear any stale error.
      // CRITICAL: do NOT call `_handleListError` here — that path interprets
      // 404 as "list endpoint missing → phase 2 stub", which would wipe the
      // visible orders table on a perfectly normal idempotent-cancel.
      const status = err && typeof err.status === 'number' ? err.status : null;
      if (status === 404) {
        const idx = state.orders.findIndex((o) => String(o.id) === id);
        if (idx >= 0) {
          state.orders[idx] = { ...state.orders[idx], status: 'cancelled' };
        }
        state.error = null;
        fireAction('cancel', { id, ok: true, idempotent: true });
      } else {
        state.error = _mutationErrorMessage(err, 'Failed to cancel order');
        fireAction('cancel', { id, ok: false, err });
      }
    } finally {
      state.busyOrderId = null;
      render();
    }
  }

  async function onToggleArmed(desired) {
    if (state.busyArmed) return;
    state.busyArmed = true;
    render();
    try {
      const resp = await apiClient.setArmed(Boolean(desired));
      // Server is authoritative — use the value it returns when present.
      if (resp && typeof resp.armed === 'boolean') {
        state.armed = resp.armed;
      } else {
        state.armed = Boolean(desired);
      }
      fireAction('armed', { armed: state.armed, ok: true });
    } catch (err) {
      // Same reasoning as `onCancelOrder` — never let a per-mutation failure
      // collapse the list into the phase-2 stub.
      state.error = _mutationErrorMessage(err, 'Failed to update kill-switch');
      fireAction('armed', { ok: false, err });
    } finally {
      state.busyArmed = false;
      render();
    }
  }

  // Subscribe to access transitions.
  const unsubscribe = subscribeAccess((next) => {
    const prev = state.accessState;
    state.accessState = next;
    if (prev !== 'premium' && next === 'premium' && state.token) {
      fetchOrders().catch(() => {
        /* surfaced via state */
      });
    } else if (prev === 'premium' && next !== 'premium') {
      state.orders = [];
      state.error = null;
      state.phase2 = false;
      state.gen += 1;
      render();
    } else {
      render();
    }
  });

  // ── Public API ─────────────────────────────────────────────────────────
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
    state.token = normalized;
    state.tokenMeta = newMeta;
    state.orders = [];
    state.error = null;
    state.phase2 = false;
    state.gen += 1;
    render();
    if (state.token && state.accessState === 'premium') {
      await fetchOrders();
    }
  }

  async function refresh() {
    if (state.accessState !== 'premium' || !state.token) {
      render();
      return;
    }
    await fetchOrders();
  }

  /**
   * Apply an SSE `event: orders` payload — `{ order: { id, status, ... } }`.
   * Merges into the local list (existing row updated in-place, or prepends
   * a brand-new order). No-op if the order belongs to a different token.
   */
  function pushOrderUpdate(payload) {
    const order = payload?.order;
    if (!order || order.id == null) return;
    if (state.accessState !== 'premium' || state.phase2) return;
    if (
      state.token &&
      typeof order.token === 'string' &&
      order.token.toLowerCase() !== state.token
    ) {
      return;
    }
    const id = String(order.id);
    const idx = state.orders.findIndex((o) => String(o.id) === id);
    if (idx >= 0) {
      state.orders[idx] = { ...state.orders[idx], ...order };
    } else {
      state.orders = [order, ...state.orders];
    }
    render();
  }

  function destroy() {
    try {
      unsubscribe();
    } catch {
      /* ignore */
    }
    stopTicker();
    tearDownLock();
    container.replaceChildren();
  }

  function getState() {
    return {
      token: state.token,
      accessState: state.accessState,
      armed: state.armed,
      ordersCount: state.orders.length,
      loading: state.loading,
      error: state.error,
      phase2: state.phase2,
    };
  }

  render();
  if (state.token && state.accessState === 'premium') {
    fetchOrders().catch(() => {
      /* surfaced via state */
    });
  }

  return { setToken, refresh, destroy, pushOrderUpdate, getState };
}
