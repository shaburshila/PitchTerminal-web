/**
 * mobile-trade-tabs.js — Phase 3b-1 Track C (Trade panel for mobile).
 *
 * Hosts the `[Trade][Orders]` sub-tab row inside the Trade bottom-nav panel
 * (per locked decision D2 — Orders is a sub-tab of Trade, NOT a fifth
 * bottom-nav tab) plus the D6 "no token selected" empty state.
 *
 * Both sub-panes (Trade + Orders) mount immediately so SSE pushes work
 * regardless of which sub-tab is currently visible. Switching is purely a
 * CSS `is-active` toggle — no destroy/remount on tap (Q2 accepts the two
 * concurrent Orders-tab instances; this one is token-scoped).
 *
 * Returns `{ destroy, setToken, pushOrderUpdate }`. The host (bootstrapMobile
 * in main.js) calls `setToken(token)` whenever a sidebar tap selects a token,
 * and forwards SSE `event: orders` payloads via `pushOrderUpdate`.
 */

import { mountTradePanel } from './trade-panel.js';
import { mountOrdersTab } from './orders-tab.js';

function el(tag, { className, dataset, attrs, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (dataset) for (const [k, v] of Object.entries(dataset)) node.dataset[k] = v;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

/**
 * @typedef {object} MobileTradeTabsOpts
 * @property {() => void} [navigateToMarkets]
 *   Called when the D6 empty-state "Browse Markets" CTA is tapped.
 * @property {object} [tradePanelOpts]
 *   Forwarded to mountTradePanel — see TradePanelOptions (apiClient,
 *   onCountrySwitch, payment, etc.). Tests stub via vi.mock.
 * @property {object} [ordersTabOpts]
 *   Forwarded to mountOrdersTab — see OrdersOpts (apiClient, onTabCount, etc.).
 */

/**
 * @param {HTMLElement} container
 * @param {MobileTradeTabsOpts} [opts]
 * @returns {{
 *   destroy: () => void,
 *   setToken: (token: object|null) => void,
 *   pushOrderUpdate: (payload: object) => void,
 * }}
 */
export function mountMobileTradeTabs(container, opts = {}) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('mountMobileTradeTabs: container must be an HTMLElement');
  }

  const navigateToMarkets =
    typeof opts.navigateToMarkets === 'function' ? opts.navigateToMarkets : null;
  const tradePanelOpts = opts.tradePanelOpts ?? {};
  const ordersTabOpts = opts.ordersTabOpts ?? {};

  container.replaceChildren();

  const root = el('div', {
    className: 'pt-mobile-trade',
    dataset: { testId: 'mobile-trade' },
  });

  // ── Empty state (D6) ─────────────────────────────────────────────────────
  const emptyState = el('div', {
    className: 'pt-mobile-trade__empty',
    dataset: { testId: 'mobile-trade-empty' },
  });
  emptyState.appendChild(
    el('p', {
      className: 'pt-mobile-trade__empty-msg',
      text: 'Select a token from Markets first.',
    }),
  );
  const browseBtn = el('button', {
    className: 'pt-btn pt-btn--accent',
    dataset: { testId: 'trade-browse-markets' },
    attrs: { type: 'button' },
    text: 'Browse Markets',
  });
  browseBtn.addEventListener('click', () => {
    if (navigateToMarkets) {
      try {
        navigateToMarkets();
      } catch (err) {
        console.error('mountMobileTradeTabs: navigateToMarkets threw', err);
      }
    }
  });
  emptyState.appendChild(browseBtn);
  // Empty state is shown initially (no token yet).
  root.appendChild(emptyState);

  // ── Inner wrapper (sub-tabs + sub-panels) ────────────────────────────────
  const inner = el('div', {
    className: 'pt-mobile-trade__inner',
    dataset: { testId: 'mobile-trade-inner' },
  });
  inner.hidden = true;

  const subtabs = el('div', {
    className: 'pt-mobile-trade__subtabs',
    attrs: { role: 'tablist', 'aria-label': 'Trade sub-tabs' },
  });
  const tradeBtn = el('button', {
    className: 'pt-mobile-trade__subtab is-active',
    dataset: { subtab: 'trade', testId: 'mobile-subtab-trade' },
    attrs: { type: 'button', role: 'tab', 'aria-selected': 'true' },
    text: 'Trade',
  });
  const ordersBtn = el('button', {
    className: 'pt-mobile-trade__subtab',
    dataset: { subtab: 'orders', testId: 'mobile-subtab-orders' },
    attrs: { type: 'button', role: 'tab', 'aria-selected': 'false' },
    text: 'Orders',
  });
  subtabs.appendChild(tradeBtn);
  subtabs.appendChild(ordersBtn);
  inner.appendChild(subtabs);

  const tradePane = el('div', {
    className: 'pt-mobile-trade__panel pt-mobile-trade__panel--trade is-active',
    dataset: { testId: 'mobile-trade-pane-trade' },
  });
  const ordersPane = el('div', {
    className: 'pt-mobile-trade__panel pt-mobile-trade__panel--orders',
    dataset: { testId: 'mobile-trade-pane-orders' },
  });
  inner.appendChild(tradePane);
  inner.appendChild(ordersPane);

  root.appendChild(inner);
  container.appendChild(root);

  // ── Mount sub-components immediately so SSE pushes work regardless of
  // which sub-tab is active (Q2). The Orders tab is no-op when no token is
  // set; the Trade panel renders its own "no token" hint inside.
  let tradeHandle = null;
  try {
    tradeHandle = mountTradePanel(tradePane, tradePanelOpts);
  } catch (err) {
    console.error('mountMobileTradeTabs: mountTradePanel failed', err);
  }
  let ordersHandle = null;
  try {
    ordersHandle = mountOrdersTab(ordersPane, ordersTabOpts);
  } catch (err) {
    console.error('mountMobileTradeTabs: mountOrdersTab failed', err);
  }

  // ── Sub-tab switching ────────────────────────────────────────────────────
  // Explicit equality (not negated boolean) so adding a 3rd sub-tab in the
  // future doesn't silently flip Orders active whenever Trade is not.
  function setActiveSub(sub) {
    const isTrade = sub === 'trade';
    const isOrders = sub === 'orders';
    tradeBtn.classList.toggle('is-active', isTrade);
    ordersBtn.classList.toggle('is-active', isOrders);
    tradeBtn.setAttribute('aria-selected', isTrade ? 'true' : 'false');
    ordersBtn.setAttribute('aria-selected', isOrders ? 'true' : 'false');
    tradePane.classList.toggle('is-active', isTrade);
    ordersPane.classList.toggle('is-active', isOrders);
  }
  tradeBtn.addEventListener('click', () => setActiveSub('trade'));
  ordersBtn.addEventListener('click', () => setActiveSub('orders'));

  // ── Public API ───────────────────────────────────────────────────────────
  function setToken(token) {
    const hasToken = !!(token && typeof token === 'object' && typeof token.address === 'string');
    emptyState.hidden = hasToken;
    inner.hidden = !hasToken;
    if (tradeHandle && typeof tradeHandle.setToken === 'function') {
      try {
        tradeHandle.setToken(hasToken ? token : null);
      } catch (err) {
        console.error('mountMobileTradeTabs: tradeHandle.setToken threw', err);
      }
    }
    if (ordersHandle && typeof ordersHandle.setToken === 'function') {
      // orders-tab.setToken expects address-string (lowercased internally) +
      // optional meta. Pass null to clear when no token is selected.
      try {
        if (hasToken) {
          ordersHandle.setToken(token.address, {
            symbol: token.symbol,
            name: token.name,
            kind: token.kind,
          });
        } else {
          ordersHandle.setToken(null);
        }
      } catch (err) {
        console.error('mountMobileTradeTabs: ordersHandle.setToken threw', err);
      }
    }
  }

  function pushOrderUpdate(payload) {
    if (ordersHandle && typeof ordersHandle.pushOrderUpdate === 'function') {
      try {
        ordersHandle.pushOrderUpdate(payload);
      } catch (err) {
        console.error('mountMobileTradeTabs: pushOrderUpdate threw', err);
      }
    }
  }

  function destroy() {
    if (tradeHandle && typeof tradeHandle.destroy === 'function') {
      try {
        tradeHandle.destroy();
      } catch {
        /* idempotent */
      }
    }
    if (ordersHandle && typeof ordersHandle.destroy === 'function') {
      try {
        ordersHandle.destroy();
      } catch {
        /* idempotent */
      }
    }
    if (root.parentNode === container) container.removeChild(root);
  }

  return { destroy, setToken, pushOrderUpdate };
}
