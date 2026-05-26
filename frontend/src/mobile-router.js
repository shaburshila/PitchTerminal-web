/**
 * mobile-router.js — hash-based router for the mobile layout.
 *
 * Scope: drives the bottom-nav (4 tabs: markets / chart / trade / wallet).
 * Uses `location.hash` so the back button works without a backend route
 * table and so deep links (`/#/chart`) survive page reloads. Listens to
 * `hashchange` (NOT `popstate` — hash changes don't fire popstate in
 * modern browsers, only hashchange).
 *
 * Internal state is observable: subscribers fire on every committed state
 * change, never on a no-op. `navigateTo(currentTab)` is a true no-op
 * (subscribers do not fire).
 */

/** Tab identifiers — frozen so callers can't mutate the enum. */
export const TABS = Object.freeze({
  MARKETS: 'markets',
  CHART: 'chart',
  TRADE: 'trade',
  WALLET: 'wallet',
});

const VALID_TABS = new Set(Object.values(TABS));
const DEFAULT_TAB = TABS.MARKETS;

let state = { tab: DEFAULT_TAB, subroute: null };
/** @type {Set<(s: {tab: string, subroute: string|null}) => void>} */
const subscribers = new Set();
let hashListenerAttached = false;
let suppressHashChange = false;

/**
 * Pure parser for a hash string. Returns the default tab on empty / unknown.
 * Exported so tests can assert it without touching `window.location`.
 *
 * Accepted shapes:
 *   ''           → { tab: 'markets', subroute: null }
 *   '#/chart'    → { tab: 'chart',   subroute: null }
 *   '#/wallet/orders' → { tab: 'wallet', subroute: 'orders' }
 *   '#/foo'      → { tab: 'markets', subroute: null }  (unknown tab → default)
 *
 * @param {string} hashStr
 * @returns {{ tab: string, subroute: string|null }}
 */
export function parseHash(hashStr) {
  if (typeof hashStr !== 'string' || hashStr.length === 0) {
    return { tab: DEFAULT_TAB, subroute: null };
  }
  // Strip leading '#' and optional leading '/'.
  let s = hashStr;
  if (s.startsWith('#')) s = s.slice(1);
  if (s.startsWith('/')) s = s.slice(1);
  if (s.length === 0) return { tab: DEFAULT_TAB, subroute: null };
  const parts = s.split('/').filter((p) => p.length > 0);
  const tab = parts[0];
  if (!VALID_TABS.has(tab)) return { tab: DEFAULT_TAB, subroute: null };
  const subroute = parts.length > 1 ? parts.slice(1).join('/') : null;
  return { tab, subroute };
}

function statesEqual(a, b) {
  return a.tab === b.tab && a.subroute === b.subroute;
}

function commit(next) {
  if (statesEqual(state, next)) return false;
  state = next;
  // Snapshot subscribers — handler may unsubscribe mid-iteration.
  for (const fn of Array.from(subscribers)) {
    try {
      fn({ tab: state.tab, subroute: state.subroute });
    } catch (err) {
      // Subscriber error must not break siblings or future commits.
      console.error('mobile-router subscriber threw:', err);
    }
  }
  return true;
}

function onHashChange() {
  if (suppressHashChange) return;
  const next = parseHash(typeof window !== 'undefined' ? window.location.hash : '');
  commit(next);
}

function ensureHashListener() {
  if (hashListenerAttached) return;
  if (typeof window === 'undefined') return;
  window.addEventListener('hashchange', onHashChange);
  hashListenerAttached = true;
}

/**
 * Subscribe to tab changes. Fires every time the committed state changes
 * (never on no-op). Returns an unsubscribe function.
 *
 * @param {(s: {tab: string, subroute: string|null}) => void} fn
 * @returns {() => void}
 */
export function onTabChange(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('onTabChange: handler must be a function');
  }
  subscribers.add(fn);
  ensureHashListener();
  return function unsubscribe() {
    subscribers.delete(fn);
  };
}

/**
 * Returns the current state. The returned object is a fresh shallow copy —
 * callers can't mutate the internal state.
 *
 * @returns {{ tab: string, subroute: string|null }}
 */
export function getActiveTab() {
  return { tab: state.tab, subroute: state.subroute };
}

/**
 * Navigate to a tab. If `tab` is already active and `subroute` matches the
 * current subroute, this is a no-op (subscribers do not fire). Otherwise
 * updates `location.hash` and notifies subscribers synchronously.
 *
 * @param {string} tab     One of TABS.*
 * @param {string} [subroute]
 */
export function navigateTo(tab, subroute) {
  if (!VALID_TABS.has(tab)) return;
  const nextSub = subroute == null || subroute === '' ? null : String(subroute);
  if (state.tab === tab && state.subroute === nextSub) return;
  const newHash = nextSub == null ? `#/${tab}` : `#/${tab}/${nextSub}`;
  ensureHashListener();
  // Set the hash but suppress the resulting `hashchange` event — we commit
  // synchronously here so subscribers see the change immediately, before
  // the browser fires the async event.
  if (typeof window !== 'undefined') {
    suppressHashChange = true;
    try {
      window.location.hash = newHash;
    } finally {
      // Re-enable AFTER the current task tick so the pending hashchange
      // (queued synchronously by setting .hash) is also swallowed.
      Promise.resolve().then(() => {
        suppressHashChange = false;
      });
    }
  }
  commit({ tab, subroute: nextSub });
}

/**
 * Parse the current `location.hash` and seed initial state. Safe to call
 * multiple times — only fires subscribers when state actually changes.
 *
 * @returns {{ tab: string, subroute: string|null }}
 */
export function initFromHash() {
  ensureHashListener();
  const next = parseHash(typeof window !== 'undefined' ? window.location.hash : '');
  commit(next);
  return getActiveTab();
}

/**
 * Test-only reset. Clears state to defaults and removes all subscribers.
 * NOT part of the public API contract — tests that import this should be
 * the only callers.
 */
export function __resetForTests() {
  state = { tab: DEFAULT_TAB, subroute: null };
  subscribers.clear();
  if (hashListenerAttached && typeof window !== 'undefined') {
    window.removeEventListener('hashchange', onHashChange);
    hashListenerAttached = false;
  }
  suppressHashChange = false;
}
