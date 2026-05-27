/**
 * In-memory store for the premium-access state — F0.13.
 *
 * Tracks the four possible UI states for premium gating so any number of
 * subscribers (soft-lock overlays on the right panel, the bottom My Wallet /
 * Orders tabs, the Profile view, the pay-banner itself) can react to changes
 * without each one wiring its own `/access` poll.
 *
 * State values:
 *   - `'unknown'`    — bootstrap; haven't checked yet. Treated as "locked" by UI.
 *   - `'anon'`       — wallet not connected (or no SIWE session). Treated as locked.
 *   - `'connecting'` — wallet just connected, but `/access` and/or SIWE has not
 *     resolved yet. Treated as locked for premium-gate decisions (same as
 *     'unknown'/'anon'), but UI components MAY render a spinner / progress
 *     hint instead of the full "Upgrade to Pro" upsell, so a user who
 *     actually OWNS premium does not see a misleading "no premium" screen
 *     during the 5-15 second mobile WalletConnect SIWE round-trip.
 *   - `'free'`       — connected, signed in, but `hasAccess === false`.
 *   - `'premium'`    — `hasAccess === true`. Unlocks everything.
 *
 * Sources of writes:
 *   - `mountAccessBanner.refresh()` (access.js) — writes whenever it polls
 *     `/access` or the connected wallet changes (main.js wires this).
 *   - `createAccountChangeHandler` (main.js) — writes `'connecting'`
 *     synchronously on any new wallet connect so soft-locks render the
 *     loading-state instead of the "Upgrade to Pro" upsell during the SIWE
 *     gap (race fix: mobile WalletConnect personal_sign can take 10-15s).
 *   - The pay-flow `onPaid` hook — optimistically writes `'premium'` so the
 *     overlay flips off without waiting for the next refresh cycle.
 *
 * Same dependency-free pub-sub pattern as `config-store.js`.
 */

/** @typedef {'unknown'|'anon'|'connecting'|'free'|'premium'} AccessState */

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
  if (
    next !== 'unknown' &&
    next !== 'anon' &&
    next !== 'connecting' &&
    next !== 'free' &&
    next !== 'premium'
  ) {
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
 * `true` iff a wallet just connected and we have NOT yet resolved `/access`.
 * UI components use this to render a "checking…" placeholder instead of the
 * full premium upsell, avoiding the misleading "no premium" flash on the
 * 5-15s mobile WalletConnect SIWE round-trip.
 *
 * @returns {boolean}
 */
export function isConnecting() {
  return state === 'connecting';
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
