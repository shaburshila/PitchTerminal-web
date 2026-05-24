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
 *   render a friendly "Лимитные ордера — coming soon" placeholder via the
 *   `phase2_not_available` detection in `_handleListError`. When the
 *   backend lands the route, the tab activates automatically (no FE redeploy
 *   needed for the happy path).
 *
 * UI states:
 *   - SOFT-LOCKED: not premium → soft-lock overlay.
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
import { mountSoftLock } from './soft-lock.js';
import { get as getAccessState, subscribe as subscribeAccess } from './access-store.js';

const STATUS_LABEL = {
  pending: 'Ожидает',
  executing: 'Исполняется',
  filled: 'Исполнен',
  failed: 'Ошибка',
  cancelled: 'Отменён',
  expired: 'Истёк',
};
const SIDE_LABEL = {
  'limit-buy': 'Лимит-покупка',
  'take-profit': 'Take-profit',
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
  const frac = padded.slice(padded.length - decimals).slice(0, digits).replace(/0+$/, '');
  const out = frac ? `${whole}.${frac}` : whole;
  return neg ? `-${out}` : out;
}

function formatTtl(expiresAt, nowSec) {
  if (!Number.isFinite(expiresAt) || expiresAt === 0 || expiresAt == null) {
    return '∞';
  }
  const remain = expiresAt - nowSec;
  if (remain <= 0) return 'истёк';
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
 * @property {() => number} [now]   ms epoch — injected for deterministic TTL tests.
 * @property {(action:string, info?:object) => void} [onActionDone]
 *   Test hook fired after cancel / armed-toggle resolves (success or error).
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
  const softLockOpts = opts.softLock ?? {};
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const fireAction = (action, info) => {
    if (typeof opts.onActionDone === 'function') {
      try { opts.onActionDone(action, info); } catch { /* ignore */ }
    }
  };

  container.replaceChildren();

  const state = {
    token: typeof opts.token === 'string' && opts.token ? opts.token.toLowerCase() : null,
    accessState: getAccessState(),
    orders: /** @type {object[]} */ ([]),
    armed: true,
    loading: false,
    error: null,
    /** Set when the backend route is not yet implemented (phase 2). */
    phase2: false,
    busyOrderId: null,
    busyArmed: false,
    gen: 0,
  };

  const root = el('div', { className: 'pt-orders', dataset: { testId: 'orders' } });
  container.appendChild(root);

  let lockHandle = null;
  let tickerId = null;

  function tearDownLock() {
    if (lockHandle) {
      try { lockHandle.destroy(); } catch { /* ignore */ }
      lockHandle = null;
    }
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
    tearDownLock();
    const skeleton = el('div', {
      className: 'pt-orders__skeleton',
      dataset: { testId: 'orders-skeleton' },
    });
    skeleton.appendChild(el('div', { className: 'pt-orders__skel-row' }));
    skeleton.appendChild(el('div', { className: 'pt-orders__skel-row' }));
    skeleton.appendChild(el('div', { className: 'pt-orders__skel-row' }));
    root.appendChild(skeleton);
    lockHandle = mountSoftLock(root, {
      zone: 'orders',
      label: 'Premium — лимитные ордера',
      openPayModal: softLockOpts.openPayModal,
      payOpts: softLockOpts.payOpts,
    });
  }

  function renderNoToken() {
    stopTicker();
    root.replaceChildren();
    tearDownLock();
    root.appendChild(el('div', {
      className: 'pt-orders__placeholder',
      dataset: { testId: 'orders-no-token' },
      text: 'Выберите токен, чтобы увидеть свои ордера',
    }));
  }

  function renderPhase2() {
    stopTicker();
    root.replaceChildren();
    tearDownLock();
    const wrap = el('div', {
      className: 'pt-orders__phase2',
      dataset: { testId: 'orders-phase2' },
    });
    wrap.appendChild(el('div', {
      className: 'pt-orders__phase2-title',
      text: 'Лимитные ордера — скоро',
    }));
    wrap.appendChild(el('div', {
      className: 'pt-orders__phase2-body',
      text:
        'Кипер лимит-ордеров (off-chain executor + EIP-712 подпись) поедет ' +
        'отдельным релизом в фазе 2. Premium-доступ покрывает эту функцию — ' +
        'докупать ничего не придётся, как только модуль появится.',
    }));
    root.appendChild(wrap);
  }

  function renderLoading() {
    stopTicker();
    root.replaceChildren();
    tearDownLock();
    root.appendChild(el('div', {
      className: 'pt-orders__loading',
      dataset: { testId: 'orders-loading' },
      text: 'Загрузка ордеров…',
    }));
  }

  function renderError() {
    stopTicker();
    root.replaceChildren();
    tearDownLock();
    root.appendChild(el('div', {
      className: 'pt-orders__error',
      dataset: { testId: 'orders-error' },
      text: state.error || 'Не удалось загрузить ордера',
    }));
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
      onToggleArmed(desired).catch(() => { /* surfaced via error state */ });
    });
    wrap.appendChild(input);
    wrap.appendChild(el('span', {
      className: 'pt-orders__armed-label',
      text: state.armed ? 'Kill-switch: armed' : 'Kill-switch: paused',
    }));
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

  function buildRow(order) {
    const now = Math.floor(nowFn() / 1000);
    const tr = el('tr', {
      className: `pt-orders__row pt-orders__row--${order.status ?? 'unknown'}`,
      dataset: { testId: 'order-row', orderId: String(order.id ?? ''), status: order.status ?? '' },
    });

    tr.appendChild(el('td', {
      className: 'side',
      text: SIDE_LABEL[order.side] ?? order.side ?? '—',
    }));
    tr.appendChild(el('td', {
      className: 'num',
      text: formatWeiNumber(order.targetPrice),
    }));
    tr.appendChild(el('td', {
      className: 'num',
      text: formatWeiNumber(order.amountIn),
    }));
    tr.appendChild(el('td', {
      className: 'num',
      text: typeof order.slippageBps === 'number' ? `${(order.slippageBps / 100).toFixed(2)}%` : '—',
    }));

    const ttlCell = el('td', {
      className: 'ttl',
      dataset: {
        testId: 'orders-ttl',
        expiresAt: String(order.expiresAt ?? 0),
      },
      text: formatTtl(order.expiresAt, now),
    });
    tr.appendChild(ttlCell);

    tr.appendChild(el('td', {
      className: `status status--${order.status ?? 'unknown'}`,
      text: STATUS_LABEL[order.status] ?? order.status ?? '—',
    }));

    const actionCell = el('td', { className: 'actions' });
    if (order.status === 'pending') {
      const btn = el('button', {
        className: 'pt-btn pt-orders__cancel',
        dataset: { testId: 'orders-cancel', orderId: String(order.id ?? '') },
        attrs: { type: 'button' },
        text: 'Отмена',
      });
      btn.disabled = state.busyOrderId === String(order.id);
      btn.addEventListener('click', () => {
        onCancelOrder(String(order.id)).catch(() => { /* surfaced via error */ });
      });
      actionCell.appendChild(btn);
    }
    tr.appendChild(actionCell);

    return tr;
  }

  function renderData() {
    root.replaceChildren();
    tearDownLock();

    root.appendChild(buildToolbar());

    const table = el('table', {
      className: 'pt-orders__table',
      dataset: { testId: 'orders-table' },
    });
    const thead = el('thead');
    const headRow = el('tr');
    for (const label of ['Тип', 'Цель', 'Объём', 'Slippage', 'TTL', 'Статус', '']) {
      headRow.appendChild(el('th', { text: label }));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    if (state.orders.length === 0) {
      const tr = el('tr', { dataset: { testId: 'orders-empty' } });
      const td = el('td', { text: 'Ордеров нет', attrs: { colspan: '7' } });
      td.className = 'pt-orders__empty';
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      for (const order of state.orders) {
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
      return;
    }
    if (!state.token) {
      renderNoToken();
      return;
    }
    if (state.phase2) {
      renderPhase2();
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
    renderData();
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
    const detail = err?.detail || err?.title || err?.message || 'Ошибка загрузки';
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
        state.error = _mutationErrorMessage(err, 'Не удалось отменить ордер');
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
      state.error = _mutationErrorMessage(err, 'Не удалось обновить kill-switch');
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
      fetchOrders().catch(() => { /* surfaced via state */ });
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
  async function setToken(token) {
    const normalized = typeof token === 'string' && token ? token.toLowerCase() : null;
    if (normalized === state.token) return;
    state.token = normalized;
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
    if (state.token && typeof order.token === 'string'
        && order.token.toLowerCase() !== state.token) {
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
    try { unsubscribe(); } catch { /* ignore */ }
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
    fetchOrders().catch(() => { /* surfaced via state */ });
  }

  return { setToken, refresh, destroy, pushOrderUpdate, getState };
}
