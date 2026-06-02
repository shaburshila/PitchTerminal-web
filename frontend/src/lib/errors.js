/**
 * Central error classification for PitchTerminal-web.
 *
 * This module is intentionally PURE — it imports no UI (`toast`, DOM) and does
 * NOT import `../api.js`. The latter is a deliberate decoupling: `api.js` is a
 * low-level transport that several modules import, and pulling `lib/errors.js`
 * back into it (or vice-versa) risks a circular import. We therefore detect the
 * RFC-7807 `ApiError` thrown by `apiFetch` via duck-typing (`err.name ===
 * 'ApiError'` + a numeric `status`) instead of an `instanceof` check. The shape
 * is stable — see `ApiError` in `../api.js`.
 *
 * Three exported primitives, used everywhere a wallet / network / backend call
 * can fail (trade swap/approve/limit, pay-flow, SIWE, config-load):
 *
 *   isUserRejected(err)        — true when the user declined a wallet prompt.
 *   describeError(err, fb)     — best human-readable string (viem shortMessage).
 *   categorizeError(err)       — { category, message, silent } classification.
 *
 * The UI-facing wrapper (`notifyError`) lives in `../ui/toast.js` so this file
 * stays testable without a DOM and free of UI coupling.
 */

/**
 * MetaMask uses `code: 4001` for user rejection; viem wraps wallet errors as
 * `UserRejectedRequestError` (which carries `code: 4001` and a name matching
 * `/UserRejected/`) too. Some providers nest the rejection one level down on
 * `err.cause`. Finally, WalletConnect / odd providers surface only a textual
 * "user rejected" / "user denied" message, so we sniff that as a last resort.
 *
 * This is the single copy — `trade-panel.js`, `access.js` and `sentry.js` all
 * route through it (previously each had its own inline duplicate).
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isUserRejected(err) {
  if (!err || typeof err !== 'object') return false;
  // EIP-1193 standard rejection code.
  if (typeof err.code === 'number' && err.code === 4001) return true;
  // viem/providers sometimes wrap the original under `cause`.
  const cause = err.cause;
  if (cause && typeof cause.code === 'number' && cause.code === 4001) return true;
  // viem's UserRejectedRequestError class name (no need to import the class).
  if (typeof err.name === 'string' && /UserRejected/i.test(err.name)) return true;
  // Textual fallback for providers that only give a message.
  const msg = (err.shortMessage || err.message || '').toLowerCase();
  if (msg.includes('user rejected') || msg.includes('user denied')) return true;
  return false;
}

/**
 * Best human-readable message for an error, preferring viem's curated
 * `shortMessage` (e.g. "Insufficient funds for gas") over the raw `message`
 * (which is often a multi-line stack-ish blob), falling back to `fallback`.
 *
 * @param {unknown} err
 * @param {string} [fallback='Something went wrong']
 * @returns {string}
 */
export function describeError(err, fallback = 'Something went wrong') {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    if ('shortMessage' in err && err.shortMessage) return String(err.shortMessage);
    if ('message' in err && err.message) return String(err.message);
  }
  return fallback;
}

/**
 * Duck-typed `ApiError` detection. We avoid importing `ApiError` from
 * `../api.js` to keep this module free of the transport layer (see the file
 * header). The shape is stable: `name === 'ApiError'` and a numeric `status`.
 *
 * @param {unknown} err
 * @returns {err is { name: string, status: number, code?: string, title?: string, detail?: string }}
 */
function isApiError(err) {
  return (
    !!err && typeof err === 'object' && err.name === 'ApiError' && typeof err.status === 'number'
  );
}

/**
 * Heuristic detection of network / RPC transport failures. These are the
 * "couldn't reach anyone" class — distinct from a backend that answered with a
 * 5xx (that's `backend`). Signals, in order of reliability:
 *   - viem transport error class names (`HttpRequestError`, `TimeoutError`,
 *     `RpcRequestError`, `WebSocketRequestError`).
 *   - `TypeError` from `fetch()` (browsers throw a TypeError on network failure
 *     — "Failed to fetch" / "NetworkError when attempting to fetch resource").
 *   - Textual signatures: "network", "failed to fetch", "connection", "timeout",
 *     "offline".
 *
 * @param {object} err
 * @returns {boolean}
 */
function looksLikeNetwork(err) {
  const name = typeof err.name === 'string' ? err.name : '';
  if (/HttpRequestError|TimeoutError|RpcRequestError|WebSocketRequestError/i.test(name)) {
    return true;
  }
  // Native fetch network failure surfaces as a bare TypeError.
  const text = `${err.shortMessage || ''} ${err.message || ''}`.toLowerCase();
  if (name === 'TypeError' && text.includes('fetch')) return true;
  if (
    text.includes('failed to fetch') ||
    text.includes('network') ||
    text.includes('connection') ||
    text.includes('timed out') ||
    text.includes('timeout') ||
    text.includes('offline')
  ) {
    return true;
  }
  return false;
}

/**
 * Map a backend `ApiError` status to a short, user-facing message. Wording is
 * deliberately plain (no codes / jargon) and matches the project's premium /
 * sign-in framing. Unmapped statuses fall back to the server-supplied title or
 * `describeError`.
 *
 * @param {{ status: number, title?: string }} err
 * @returns {string}
 */
function backendMessage(err) {
  switch (err.status) {
    case 401:
      // Session missing / expired — the user must (re-)sign in via SIWE.
      return 'Please sign in to continue.';
    case 402:
      // Premium-gated endpoint. The project gates Profile/Referral/Trading etc.
      return 'This is a premium feature. Unlock access to continue.';
    case 403:
      return "You don't have access to this.";
    case 404:
      return 'Not found.';
    case 429:
      // Rate limited (Caddy / app limiter).
      return 'Too many requests. Please wait a moment and try again.';
    case 503:
      // Health / degraded — server reachable but a component is down.
      return 'Service temporarily unavailable. Please try again shortly.';
    default:
      if (err.status >= 500) {
        return 'Service temporarily unavailable. Please try again shortly.';
      }
      // 4xx with a server-provided title (e.g. referral.taken) — show it.
      return err.title ? String(err.title) : describeError(err, 'Request failed.');
  }
}

/**
 * @typedef {object} CategorizedError
 * @property {'user-rejected'|'wallet'|'rpc'|'backend'|'unknown'} category
 * @property {string} message  Human-readable, English, user-safe.
 * @property {boolean} silent  When true, callers should NOT show a toast
 *   (user-rejected = intentional action, not a failure to report).
 */

/**
 * Classify any thrown error into a small, stable taxonomy plus a user-facing
 * message and a `silent` flag. Ordering of the branches matters — we check from
 * most-specific to least:
 *
 *   1. user-rejected — intentional wallet decline. `silent: true` so the UI
 *      shows nothing (a toast here would be noise / blame the user).
 *   2. backend — an `ApiError` from `apiFetch`. Status-mapped wording.
 *   3. rpc — network/RPC transport failure (no reachable peer / timeout).
 *      Checked AFTER backend so a real HTTP 5xx (which `apiFetch` turns into an
 *      ApiError) isn't mis-bucketed as "network".
 *   4. wallet — anything else carrying a viem `shortMessage` (contract revert,
 *      insufficient funds, allowance, etc.) — surface the curated message.
 *   5. unknown — nothing matched; use the fallback.
 *
 * @param {unknown} err
 * @param {string} [fallback='Something went wrong. Please try again.']
 * @returns {CategorizedError}
 */
export function categorizeError(err, fallback = 'Something went wrong. Please try again.') {
  // 1. User declined a wallet prompt — intentional, never a toast.
  if (isUserRejected(err)) {
    return {
      category: 'user-rejected',
      message: describeError(err, 'Request cancelled.'),
      silent: true,
    };
  }

  // 2. Backend answered with a non-2xx (ApiError). Status-mapped wording.
  if (isApiError(err)) {
    return {
      category: 'backend',
      message: backendMessage(/** @type {{ status: number, title?: string }} */ (err)),
      silent: false,
    };
  }

  // 3. Transport / RPC failure — couldn't reach the server or chain RPC.
  if (err && typeof err === 'object' && looksLikeNetwork(err)) {
    return {
      category: 'rpc',
      message: 'Network/RPC unavailable. Check your connection and try again.',
      silent: false,
    };
  }

  // 4. Wallet / contract error with a curated viem `shortMessage`.
  if (err && typeof err === 'object' && 'shortMessage' in err && err.shortMessage) {
    return {
      category: 'wallet',
      message: String(err.shortMessage),
      silent: false,
    };
  }

  // 5. Unknown — best-effort message, else the caller's fallback.
  return {
    category: 'unknown',
    message: describeError(err, fallback),
    silent: false,
  };
}
