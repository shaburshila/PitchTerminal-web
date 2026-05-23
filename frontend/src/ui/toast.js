/**
 * Minimal toast helper — single host node appended to `document.body`,
 * messages stack vertically and auto-dismiss after `duration` ms.
 *
 * Public API:
 *   showToast(message, { kind?, duration? }) -> dismiss fn
 *
 * Kind defaults to 'info'; `kind = 'warn' | 'error'` adjust colour via CSS
 * classes (`pt-toast--warn`, `pt-toast--error`). Duration defaults to 3000ms.
 *
 * Idempotent: re-importing or repeatedly calling `showToast` reuses the
 * single host. Safe in non-DOM contexts (no-op + logs to console) so unit
 * tests of dependent modules don't need to mock DOM unless they assert UI.
 */

const HOST_ID = 'pt-toast-host';
const DEFAULT_DURATION_MS = 3000;

function ensureHost() {
  if (typeof document === 'undefined' || !document.body) return null;
  let host = document.getElementById(HOST_ID);
  if (host) return host;
  host = document.createElement('div');
  host.id = HOST_ID;
  host.className = 'pt-toast-host';
  // `aria-live=polite` so SRs announce messages without interrupting current
  // narration. `role=status` — region landmark for at-rest announcements.
  host.setAttribute('aria-live', 'polite');
  host.setAttribute('role', 'status');
  document.body.appendChild(host);
  return host;
}

/**
 * @param {string} message
 * @param {{ kind?: 'info' | 'warn' | 'error', duration?: number }} [opts]
 * @returns {() => void} dismiss — call to remove the toast early.
 */
export function showToast(message, opts = {}) {
  const text = String(message ?? '');
  const kind = opts.kind ?? 'info';
  const duration = Number.isFinite(opts.duration) ? opts.duration : DEFAULT_DURATION_MS;

  const host = ensureHost();
  if (!host) {
    // Non-DOM environment: log so devs notice in unit tests.
    if (typeof console !== 'undefined') console.log(`[toast:${kind}] ${text}`);
    return () => {};
  }

  const node = document.createElement('div');
  node.className = `pt-toast pt-toast--${kind}`;
  node.dataset.testId = 'toast';
  node.dataset.kind = kind;
  node.textContent = text;
  host.appendChild(node);

  let dismissed = false;
  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    if (node.parentNode === host) host.removeChild(node);
  }

  if (duration > 0) {
    setTimeout(dismiss, duration);
  }
  return dismiss;
}
