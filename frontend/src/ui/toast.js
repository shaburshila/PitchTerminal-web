/**
 * Minimal toast helper — single host node appended to `document.body`,
 * messages stack vertically and auto-dismiss after `duration` ms.
 *
 * Public API:
 *   showToast(message, { kind?, duration?, link? }) -> dismiss fn
 *
 * Kind defaults to 'info'; `kind = 'warn' | 'error'` adjust colour via CSS
 * classes (`pt-toast--warn`, `pt-toast--error`). Duration defaults to 3000ms.
 *
 * F1.4 — optional `link: { url, label }` appends an anchor next to the
 * message (target=_blank, rel=noopener noreferrer). Used by the swap-success
 * toast to surface a Basescan tx link without coupling toast.js to viem or
 * url helpers. The link is rendered as a real DOM `<a>` so it inherits user
 * styles + keyboard activation; the toast still auto-dismisses on duration
 * but the click survives because the browser opens the URL synchronously.
 *
 * Idempotent: re-importing or repeatedly calling `showToast` reuses the
 * single host. Safe in non-DOM contexts (no-op + logs to console) so unit
 * tests of dependent modules don't need to mock DOM unless they assert UI.
 */

import { categorizeError } from '../lib/errors.js';

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
 * @param {{ kind?: 'info' | 'warn' | 'error', duration?: number, link?: { url: string, label?: string } | null }} [opts]
 * @returns {() => void} dismiss — call to remove the toast early.
 */
export function showToast(message, opts = {}) {
  const text = String(message ?? '');
  const kind = opts.kind ?? 'info';
  const duration = Number.isFinite(opts.duration) ? opts.duration : DEFAULT_DURATION_MS;
  // F1.4 — optional inline link (e.g. Basescan tx). Validated minimally:
  // requires a string `url`; defaults the label so callers can pass
  // `{ url }` for the common case.
  //
  // Hardening (F1.4 fix): allowlist only http(s) protocols. `showToast` is a
  // public API and we never want a caller-supplied `javascript:` /
  // `data:` / `file:` URL to land in an anchor `href` — that becomes an XSS
  // sink on click. The protocol check is intentionally strict (anchored
  // `https?://`) rather than `URL` parsing because happy-dom + jsdom
  // disagree on edge cases like protocol-relative URLs, and the only
  // legitimate caller passes absolute https URLs.
  const link =
    opts.link &&
    typeof opts.link === 'object' &&
    typeof opts.link.url === 'string' &&
    opts.link.url &&
    /^https?:\/\//i.test(opts.link.url)
      ? {
          url: opts.link.url,
          label:
            typeof opts.link.label === 'string' && opts.link.label
              ? opts.link.label
              : opts.link.url,
        }
      : null;

  const host = ensureHost();
  if (!host) {
    // Non-DOM environment: log so devs notice in unit tests.
    if (typeof console !== 'undefined') {
      const tail = link ? ` (${link.label}: ${link.url})` : '';
      console.log(`[toast:${kind}] ${text}${tail}`);
    }
    return () => {};
  }

  const node = document.createElement('div');
  node.className = `pt-toast pt-toast--${kind}`;
  node.dataset.testId = 'toast';
  node.dataset.kind = kind;
  if (link) {
    // Mixed content: text node + anchor. Avoid innerHTML — keep the text safe
    // from caller-provided HTML, and the anchor's textContent set explicitly.
    const textNode = document.createTextNode(text ? `${text} ` : '');
    const anchor = document.createElement('a');
    anchor.className = 'pt-toast__link';
    anchor.dataset.testId = 'toast-link';
    anchor.href = link.url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = link.label;
    node.appendChild(textNode);
    node.appendChild(anchor);
  } else {
    node.textContent = text;
  }
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

/**
 * Classify `err` via `categorizeError` and surface it as a toast — UNLESS the
 * classification is `silent` (user-rejected wallet prompts), in which case
 * nothing is shown. This is the single UI entry-point for error reporting so
 * every call site gets the same wording + the same "don't shout when the user
 * deliberately cancelled" behaviour.
 *
 * Lives here (not in `lib/errors.js`) so the classifier stays UI-free and
 * unit-testable without a DOM. Backend "soft" failures (402 premium / 429 rate
 * limit) render as `warn` (less alarming amber) rather than `error` (red).
 *
 * @param {unknown} err
 * @param {string} [fallback]  Message when the error can't be classified.
 * @returns {(() => void) | null} The toast dismiss fn, or null when silent.
 */
export function notifyError(err, fallback) {
  const { category, message, silent } = categorizeError(err, fallback);
  if (silent) return null;
  // 402/429 are expected, recoverable states — warn (amber), not error (red).
  const soft =
    category === 'backend' &&
    (String(message).includes('premium') || /wait a moment/.test(message));
  return showToast(message, { kind: soft ? 'warn' : 'error' });
}
