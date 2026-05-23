/**
 * In-memory store for the access-config snapshot — F0.12c.
 *
 * Tracks the three fields that the on-chain `PitchTerminalAccess` contract
 * exposes (price + buyer discount + referral split) plus the `txHash` of the
 * snapshot for SSE-side deduplication.
 *
 * Sources of writes:
 *   - On bootstrap, the `/api/v1/config` REST response (baseline).
 *   - After SSE `event: config` arrives — the SSE client merges the new snap.
 *   - After SSE reconnect — caller re-fetches `/api/v1/config` and merges,
 *     in case `event: config` was missed while disconnected.
 *
 * Subscribers receive a snapshot copy every time the store mutates.
 *
 * The store is intentionally tiny and dependency-free — no EventTarget /
 * framework, just a Set of listener fns. Keeps it test-friendly and
 * compatible with the rest of the codebase (see `watchlist.js`).
 */

/** @typedef {{ accessPriceWei?: string|null, buyerDiscountBps?: number|null, referralBps?: number|null, txHash?: string|null }} ConfigSnap */

/** @type {ConfigSnap} */
let snapshot = {
  accessPriceWei: null,
  buyerDiscountBps: null,
  referralBps: null,
  txHash: null,
};

/** @type {Set<(s: ConfigSnap) => void>} */
const listeners = new Set();

function notify() {
  const snap = { ...snapshot };
  for (const fn of listeners) {
    try {
      fn(snap);
    } catch (err) {
      // Don't let one bad listener break the rest.
      console.error('configStore listener threw:', err);
    }
  }
}

/**
 * Merge a partial snapshot into the store. Only `undefined` is treated as
 * "don't touch"; `null` is a legitimate value (e.g. baseline before SSE).
 * Notifies subscribers exactly once if anything actually changed.
 *
 * @param {ConfigSnap} partial
 * @returns {ConfigSnap} the new snapshot
 */
export function merge(partial) {
  if (!partial || typeof partial !== 'object') return { ...snapshot };
  let changed = false;
  const next = { ...snapshot };
  for (const key of ['accessPriceWei', 'buyerDiscountBps', 'referralBps', 'txHash']) {
    if (partial[key] === undefined) continue;
    if (next[key] !== partial[key]) {
      next[key] = partial[key];
      changed = true;
    }
  }
  snapshot = next;
  if (changed) notify();
  return { ...snapshot };
}

/** @returns {ConfigSnap} a snapshot copy. */
export function get() {
  return { ...snapshot };
}

/**
 * Subscribe to changes. Returns unsubscribe.
 * @param {(s: ConfigSnap) => void} listener
 */
export function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test-only: reset both snapshot and subscribers. */
export function _resetForTests() {
  snapshot = {
    accessPriceWei: null,
    buyerDiscountBps: null,
    referralBps: null,
    txHash: null,
  };
  listeners.clear();
}
