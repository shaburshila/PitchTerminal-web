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

/** Matches a checksum-agnostic 0x-prefixed 20-byte address. */
const PORTFOLIO_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Pure parser for the `/portfolio[/0x…]` deep-link path (shareable URL —
 * mirrors the desktop path shape so the same link works on both layouts).
 * Lives here (the routing module) so both the mobile bootstrap and tests
 * share one source of truth. Does NOT touch `window.location`.
 *
 * Returns:
 *   isPortfolio  — true when the path is `/portfolio` or `/portfolio/<addr>`,
 *                  including the garbage-address case (so the caller can route
 *                  it away from dashboard intentionally rather than treating an
 *                  unparseable address as "not a portfolio path").
 *   address      — lowercased target wallet, or null for the own-portfolio
 *                  (`/portfolio`) and garbage-address cases.
 *   valid        — false when the path is `/portfolio/<garbage>` (a portfolio
 *                  path with an address segment that isn't a 20-byte hex addr).
 *
 * Examples:
 *   '/'                  → { isPortfolio: false, address: null, valid: true }
 *   '/portfolio'         → { isPortfolio: true,  address: null, valid: true }
 *   '/portfolio/0xAbC…'  → { isPortfolio: true,  address: '0xabc…', valid: true }
 *   '/portfolio/nope'    → { isPortfolio: true,  address: null, valid: false }
 *
 * @param {string} pathname
 * @returns {{ isPortfolio: boolean, address: string|null, valid: boolean }}
 */
export function parsePortfolioPath(pathname) {
  if (typeof pathname !== 'string' || pathname.length === 0) {
    return { isPortfolio: false, address: null, valid: true };
  }
  const m = pathname.match(/^\/portfolio(?:\/(.+?))?\/?$/);
  if (!m) return { isPortfolio: false, address: null, valid: true };
  const rawSeg = m[1];
  if (rawSeg == null || rawSeg === '') {
    return { isPortfolio: true, address: null, valid: true };
  }
  let raw;
  try {
    raw = decodeURIComponent(rawSeg);
  } catch {
    raw = rawSeg;
  }
  if (PORTFOLIO_ADDR_RE.test(raw)) {
    return { isPortfolio: true, address: raw.toLowerCase(), valid: true };
  }
  // `/portfolio/<garbage>` — a portfolio path with an unparseable address.
  return { isPortfolio: true, address: null, valid: false };
}

/**
 * Build the canonical `/portfolio[/0x…]` path for a target address. Returns
 * `/portfolio` for null / non-address input (own portfolio). Exported so the
 * bootstrap and tests share one URL-shape source of truth.
 *
 * @param {string|null} [address]
 * @returns {string}
 */
export function portfolioPath(address = null) {
  return typeof address === 'string' && PORTFOLIO_ADDR_RE.test(address)
    ? `/portfolio/${address.toLowerCase()}`
    : '/portfolio';
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
