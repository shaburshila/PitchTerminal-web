/**
 * In-memory store for the premium-access state — F0.13.
 *
 * Tracks the four possible UI states for premium gating so any number of
 * subscribers (soft-lock overlays on the right panel, the bottom My Wallet /
 * Orders tabs, the Profile view, the pay-banner itself) can react to changes
 * without each one wiring its own `/access` poll.
 *
 * State values:
 *   - `'unknown'` — bootstrap; haven't checked yet. Treated as "locked" by UI.
 *   - `'anon'`    — wallet not connected (or no SIWE session). Treated as locked.
 *   - `'free'`    — connected, signed in, but `hasAccess === false`.
 *   - `'premium'` — `hasAccess === true`. Unlocks everything.
 *
 * Sources of writes:
 *   - `mountAccessBanner.refresh()` (access.js) — writes whenever it polls
 *     `/access` or the connected wallet changes (main.js wires this).
 *   - The pay-flow `onPaid` hook — optimistically writes `'premium'` so the
 *     overlay flips off without waiting for the next refresh cycle.
 *
 * Same dependency-free pub-sub pattern as `config-store.js`.
 */

/** @typedef {'unknown'|'anon'|'free'|'premium'} AccessState */

/** @type {AccessState} */
let state = 'unknown';

/** @type {Set<(s: AccessState) => void>} */
const listeners = new Set();

function notify() {
  for (const fn of listeners) {
    try {
      fn(state);
    } catch (err) {
      console.error('accessStore listener threw:', err);
    }
  }
}

/**
 * Replace the current state. No-op if value is unchanged.
 * Notifies subscribers exactly once on change.
 *
 * @param {AccessState} next
 */
export function set(next) {
  if (next !== 'unknown' && next !== 'anon' && next !== 'free' && next !== 'premium') {
    return;
  }
  if (next === state) return;
  state = next;
  notify();
}

/** @returns {AccessState} */
export function get() {
  return state;
}

/**
 * `true` iff the current state grants premium content.
 * @returns {boolean}
 */
export function isPremium() {
  return state === 'premium';
}

/**
 * Subscribe to state changes. Returns unsubscribe.
 *
 * The listener is NOT invoked on subscription with the current value — callers
 * read `get()` for the initial render and rely on the subscription for deltas.
 *
 * @param {(s: AccessState) => void} listener
 */
export function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test-only: reset state + clear subscribers. */
export function _resetForTests() {
  state = 'unknown';
  listeners.clear();
}
