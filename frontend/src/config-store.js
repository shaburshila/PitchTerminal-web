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

/** @typedef {{ accessPriceWei?: string|null, buyerDiscountBps?: number|null, referralBps?: number|null, feeBps?: number|null, txHash?: string|null }} ConfigSnap */

/**
 * pitchwc Hook swap fee in basis points (5% = 500). Static protocol constant
 * served by `/api/v1/config`; seeded once on bootstrap and never updated via
 * SSE. Defaults to 500 so callers (lib/fee.js) have a sane value before the
 * REST config has loaded — see `DEFAULT_FEE_BPS`.
 */
export const DEFAULT_FEE_BPS = 500;

/** @type {ConfigSnap} */
let snapshot = {
  accessPriceWei: null,
  buyerDiscountBps: null,
  referralBps: null,
  // Pre-bootstrap fallback — `merge()` overwrites once /config arrives.
  feeBps: DEFAULT_FEE_BPS,
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
  for (const key of ['accessPriceWei', 'buyerDiscountBps', 'referralBps', 'feeBps', 'txHash']) {
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
 * The effective pitchwc Hook fee in basis points. Reads the live config-store
 * value, falling back to `DEFAULT_FEE_BPS` (500) if it's null/missing — e.g.
 * before /config has loaded, or if a future SSE payload omits the field.
 *
 * The accepted range is `[0, 10000)`: a fee of 10000 bps (100%) or more would
 * make the fee-factor numerator `(10000 - feeBps)` zero/negative and blow up
 * the BigInt converters in lib/fee.js (divide-by-zero). The backend hardcodes
 * 500, so this only guards against a malformed/hostile /config payload.
 *
 * @returns {number}
 */
export function getFeeBps() {
  const v = snapshot.feeBps;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 10000 ? v : DEFAULT_FEE_BPS;
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
    feeBps: DEFAULT_FEE_BPS,
    txHash: null,
  };
  listeners.clear();
}
