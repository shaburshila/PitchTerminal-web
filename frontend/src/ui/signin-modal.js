/**
 * Sign-in modal (F0.11).
 *
 * Tiny inline overlay shown after a successful wallet connect when the server
 * cookie is missing/expired. Single CTA — "Sign message" — calls
 * `signIn()` from `../siwe.js`. While the signature is in-flight the button
 * is disabled and shows a spinner-text. On success the modal closes itself;
 * on failure (user rejection, invalid nonce, etc.) a toast is shown and the
 * modal stays open so the user can retry.
 *
 * Public API:
 *   showSignInModal({ onSuccess?, onCancel?, signIn? }) -> { close }
 *
 * `signIn` is injectable for testing; production callers omit it and get the
 * real `../siwe.js#signIn`.
 */

import { showToast } from './toast.js';
import { signIn as defaultSignIn } from '../siwe.js';
import { enableBottomSheetDismiss } from '../mobile-modals.js';

let _activeOverlay = null;

function el(tag, { className, dataset, attrs, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (dataset) for (const [k, v] of Object.entries(dataset)) node.dataset[k] = v;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Show the sign-in modal. Returns a handle with `close()`; the modal also
 * closes itself on success or on user-initiated cancel.
 *
 * @param {{
 *   onSuccess?: (info: { address: string }) => void,
 *   onCancel?: () => void,
 *   signIn?: () => Promise<{ address: string }>,
 * }} [opts]
 */
export function showSignInModal(opts = {}) {
  if (typeof document === 'undefined') return { close: () => {} };
  // Only ever one modal at a time — second call replaces the first silently.
  if (_activeOverlay) {
    try {
      _activeOverlay.remove();
    } catch {
      // ignore
    }
    _activeOverlay = null;
  }

  const runSignIn = typeof opts.signIn === 'function' ? opts.signIn : defaultSignIn;

  const overlay = el('div', {
    className: 'pt-modal-overlay',
    dataset: { testId: 'signin-overlay' },
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pt-signin-title' },
  });
  const card = el('div', { className: 'pt-modal pt-modal--signin' });

  // Phase 1.5 batch 7: brand-mark + title in the head row.
  const head = el('div', { className: 'pt-modal__brand' });
  head.appendChild(
    el('div', {
      className: 'pt-modal__brand-mark',
      attrs: { 'aria-hidden': 'true' },
      text: 'P',
    }),
  );
  const title = el('h2', {
    className: 'pt-modal__title',
    attrs: { id: 'pt-signin-title' },
    text: 'Sign in to PitchTerminal',
  });
  head.appendChild(title);

  const body = el('p', {
    className: 'pt-modal__body',
    dataset: { testId: 'signin-body' },
    text: 'Sign a message to prove you own this wallet. No transaction, no gas.',
  });

  // Optional SIWE preview — only rendered when document.location is present
  // (i.e. real browser). The preview is visual-only — the signed message is
  // still produced by `signIn()` in siwe.js.
  const sectionLabel = el('div', {
    className: 'pt-modal__section-label',
    text: 'SIWE message',
  });
  const preview = el('div', {
    className: 'pt-modal__siwe-preview',
    dataset: { testId: 'signin-preview' },
  });
  try {
    const host =
      typeof location !== 'undefined' && location.hostname ? location.hostname : 'pitchterminal';
    const previewHost = el('span', { className: 'pt-modal__siwe-host', text: host });
    preview.appendChild(previewHost);
    preview.appendChild(
      document.createTextNode(' wants you to sign in with your Ethereum account\n'),
    );
    preview.appendChild(document.createTextNode('\n'));
    const keyURI = el('span', { className: 'pt-modal__siwe-key', text: 'URI: ' });
    preview.appendChild(keyURI);
    const uri =
      typeof location !== 'undefined' && location.origin
        ? location.origin
        : 'https://pitchterminal';
    preview.appendChild(document.createTextNode(`${uri}\n`));
    const keyVer = el('span', { className: 'pt-modal__siwe-key', text: 'Version: ' });
    preview.appendChild(keyVer);
    preview.appendChild(document.createTextNode('1\n'));
    const keyChain = el('span', { className: 'pt-modal__siwe-key', text: 'Chain ID: ' });
    preview.appendChild(keyChain);
    preview.appendChild(document.createTextNode('8453'));
  } catch {
    // happy-dom / SSR — leave preview blank; CSS will still render the box.
  }

  // Network row — purely informational. Wallet must already be on Base for
  // the signed message to be accepted by /siwe/verify; we surface that here.
  const netRow = el('div', {
    className: 'pt-modal__net-row',
    dataset: { testId: 'signin-net' },
  });
  const netLeft = el('div', { className: 'pt-modal__net-row-left' });
  netLeft.appendChild(el('span', { className: 'pt-modal__net-dot' }));
  const netText = el('span');
  netText.appendChild(document.createTextNode('Network: '));
  const netB = document.createElement('b');
  netB.textContent = 'Base';
  netText.appendChild(netB);
  netLeft.appendChild(netText);
  const netRight = el('span', { className: 'pt-modal__net-row-right', text: 'Chain ID 8453' });
  netRow.appendChild(netLeft);
  netRow.appendChild(netRight);

  const actions = el('div', { className: 'pt-modal__actions' });
  const cancelBtn = el('button', {
    className: 'pt-btn',
    dataset: { testId: 'signin-cancel' },
    attrs: { type: 'button' },
    text: 'Cancel',
  });
  const signBtn = el('button', {
    className: 'pt-btn pt-btn--primary',
    dataset: { testId: 'signin-submit' },
    attrs: { type: 'button' },
    text: 'Sign with wallet',
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(signBtn);

  card.appendChild(head);
  card.appendChild(body);
  card.appendChild(sectionLabel);
  card.appendChild(preview);
  card.appendChild(netRow);
  card.appendChild(actions);
  overlay.appendChild(card);
  // B5 — capture the element that opened the modal so we can restore focus on
  // close (WCAG 2.4.3). Fall back to body if the active element is unusable
  // (e.g. `document.body` itself, or an element already detached from DOM).
  const previouslyFocused =
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  document.body.appendChild(overlay);
  _activeOverlay = overlay;
  // Phase 3b-2: drag-to-dismiss on mobile. Routed through `onCancel` so it
  // respects the in-flight `busy` guard (can't dismiss mid-sign).
  const dismissCleanup = enableBottomSheetDismiss(overlay, card, () => onCancel());
  signBtn.focus();

  let busy = false;
  let closed = false;

  /**
   * B5 — focus trap (WCAG 2.4.3 / 2.1.2). The signin modal is shown over the
   * full app; Tab must cycle within the overlay so keyboard users can't get
   * lost behind the dim background. Queried at each Tab keydown so dynamic
   * disable/enable of the buttons (in-flight signing → cancel becomes
   * disabled and drops out of the focus chain) is honoured.
   */
  function focusableNodes() {
    const sel =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
      ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(overlay.querySelectorAll(sel)).filter((node) => {
      // `disabled` covers <button disabled>; also skip nodes that are hidden
      // via `hidden` attr or CSS display:none (offsetParent === null in
      // browsers, but happy-dom doesn't always populate that, so checking
      // disabled is enough for current modal contents).
      return !node.hasAttribute('hidden');
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    try {
      dismissCleanup();
    } catch {
      /* idempotent */
    }
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (_activeOverlay === overlay) _activeOverlay = null;
    // B5 — restore focus to the trigger element. Guarded against the trigger
    // having been removed from DOM since open (rare, but defensive).
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      try {
        if (previouslyFocused.isConnected !== false) {
          previouslyFocused.focus();
        }
      } catch {
        /* element disappeared — accept; next user keypress lands on body */
      }
    }
  }

  function onCancel() {
    if (busy) return; // can't cancel mid-sign
    if (typeof opts.onCancel === 'function') opts.onCancel();
    close();
  }

  async function onSign() {
    if (busy) return;
    busy = true;
    signBtn.disabled = true;
    cancelBtn.disabled = true;
    const origText = signBtn.textContent;
    signBtn.textContent = 'Signing…';
    try {
      const info = await runSignIn();
      if (typeof opts.onSuccess === 'function') opts.onSuccess(info);
      close();
    } catch (e) {
      const msg = errorMessage(e);
      showToast(msg, { kind: 'error' });
      busy = false;
      signBtn.disabled = false;
      cancelBtn.disabled = false;
      signBtn.textContent = origText || 'Sign with wallet';
    }
  }

  function onKey(ev) {
    if (ev.key === 'Escape') {
      onCancel();
      return;
    }
    // B5 — focus trap. Tab → wrap from last to first; Shift+Tab → wrap from
    // first to last. Out-of-overlay focus (clicks on background app) snaps
    // back to the first focusable on next Tab.
    if (ev.key !== 'Tab') return;
    const nodes = focusableNodes();
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    const inOverlay = overlay.contains(active);
    if (ev.shiftKey) {
      if (!inOverlay || active === first) {
        ev.preventDefault();
        last.focus();
      }
    } else if (!inOverlay || active === last) {
      ev.preventDefault();
      first.focus();
    }
  }

  signBtn.addEventListener('click', onSign);
  cancelBtn.addEventListener('click', onCancel);
  document.addEventListener('keydown', onKey);

  return { close };
}

/**
 * Translate a thrown error to a user-facing string. Wallet rejections come
 * back with a variety of shapes — MetaMask uses `{code: 4001, message}`,
 * WalletConnect uses different codes — so we just surface the message and
 * trust the user to recognise their wallet's wording.
 */
function errorMessage(e) {
  if (!e) return 'Failed to sign';
  if (typeof e === 'string') return e;
  if (typeof e === 'object') {
    if ('shortMessage' in e && e.shortMessage) return String(e.shortMessage);
    if ('message' in e && e.message) return String(e.message);
  }
  return 'Failed to sign';
}
