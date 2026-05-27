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

/**
 * Local mobile-UA heuristic. Inlined (not imported from wallet-deep-links.js)
 * so this module survives a future refactor that drops the deep-link helpers
 * in favour of Reown AppKit. iPad on iPadOS Safari reports as Mac — we treat
 * it as desktop here (the SIWE modal is also shown on desktop with the same
 * shape; the only mobile-specific bit is the "Open wallet app" CTA below).
 */
function isMobileUA(ua) {
  const source =
    typeof ua === 'string'
      ? ua
      : typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
        ? navigator.userAgent
        : '';
  if (!source) return false;
  if (/iPhone|iPad|iPod/i.test(source)) return true;
  if (/Android/i.test(source)) return true;
  return false;
}

/**
 * If the WC connect flow saved a wallet id under `pt:lastWalletId` (the
 * mobile picker may do this in a follow-up batch), read it back here. The
 * map is intentionally tiny — known universal links for the wallets the
 * picker currently lists. If the id isn't recognised (or no id was stored)
 * we return null and the CTA falls back to a generic instruction.
 *
 * @returns {string|null}
 */
function readLastWalletDeepLink() {
  let id = null;
  try {
    if (typeof localStorage !== 'undefined') {
      id = localStorage.getItem('pt:lastWalletId');
    }
  } catch {
    /* private mode / disabled — fall through to null */
  }
  if (!id) return null;
  // Universal-link hub for each wallet — opening this re-foregrounds the
  // app even WITHOUT a fresh `wc:` pairing URI (which is what we want for
  // re-triggering the in-flight personal_sign).
  switch (id) {
    case 'metamask':
      return 'https://metamask.app.link/';
    case 'rainbow':
      return 'https://rnbwapp.com/';
    case 'coinbase':
      return 'https://go.cb-wallet.com/';
    case 'trust':
      return 'https://link.trustwallet.com/';
    case 'okx':
      return 'okx://wallet';
    case 'imtoken':
      return 'imtokenv2://';
    default:
      return null;
  }
}

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

  // Mobile-only "Open wallet app" CTA (2026-05-27 fix).
  //
  // On iOS Safari the second WalletConnect RPC request after the initial
  // pair (here: personal_sign) does NOT automatically re-foreground the
  // wallet app — the user taps "Sign with wallet" and nothing visible
  // happens. We render a secondary CTA below the primary button that
  // explicitly opens the wallet's universal link (if we have one cached
  // under `pt:lastWalletId`) or shows a plain text hint to switch apps.
  //
  // The button is hidden initially; we only reveal it after the user taps
  // Sign (so the modal isn't visually noisy for desktop users who don't
  // need it). On desktop the hint stays hidden because `isMobileUA()` is
  // false — desktop wallets re-popup their own UI for personal_sign.
  const mobileHint = el('div', {
    className: 'pt-modal__mobile-hint',
    dataset: { testId: 'signin-mobile-hint' },
  });
  mobileHint.hidden = true;
  const mobileHintText = el('span', {
    className: 'pt-modal__mobile-hint-text',
    text: 'Switch to your wallet app to approve the signature.',
  });
  const openWalletBtn = el('button', {
    className: 'pt-btn pt-btn--ghost pt-modal__mobile-open',
    dataset: { testId: 'signin-open-wallet' },
    attrs: { type: 'button' },
    text: 'Open wallet app',
  });
  mobileHint.appendChild(mobileHintText);
  mobileHint.appendChild(openWalletBtn);

  card.appendChild(head);
  card.appendChild(body);
  card.appendChild(sectionLabel);
  card.appendChild(preview);
  card.appendChild(netRow);
  card.appendChild(actions);
  card.appendChild(mobileHint);
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
      // Skip the node itself if hidden, AND any node whose ancestor (within
      // the overlay) is hidden — needed for the mobile "Open wallet app"
      // CTA which lives inside a `hidden` wrapper until the user taps Sign.
      // Without this, Shift+Tab focus-trap would land on a visually-hidden
      // control and existing focus-trap tests would fail.
      for (let cur = node; cur && cur !== overlay; cur = cur.parentNode) {
        if (cur.hasAttribute && cur.hasAttribute('hidden')) return false;
      }
      return true;
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

  /**
   * Try to re-foreground the wallet app via its universal/deep-link. On iOS
   * Safari the second RPC request after the initial WC pair (personal_sign
   * here) doesn't auto-trigger the wallet, so the user has to manually
   * switch — this CTA does the switch for them. Falls back to a generic
   * focus hint when we don't have a cached wallet id.
   */
  function openWalletApp() {
    const link = readLastWalletDeepLink();
    if (link && typeof window !== 'undefined') {
      try {
        // Prefer `window.open` so a non-intercepted universal link doesn't
        // navigate the top frame away from the in-flight signature. On a
        // user-gesture click iOS Safari won't popup-block, so the returned
        // window is reliably non-null here; the `location.href` fallback
        // matches the prior best-effort behaviour for the rare blocker case.
        const opened = window.open(link, '_blank');
        if (!opened) {
          window.location.href = link;
        }
        return;
      } catch {
        /* fall through to hint */
      }
    }
    // No cached wallet — toast the generic switch instruction so the user
    // still gets actionable feedback.
    try {
      showToast('Open your wallet app to approve the signature.', { kind: 'info' });
    } catch {
      /* toast may not be ready in tests */
    }
  }

  async function onSign() {
    if (busy) return;
    busy = true;
    signBtn.disabled = true;
    cancelBtn.disabled = true;
    const origText = signBtn.textContent;
    signBtn.textContent = 'Signing…';
    // Mobile race fix (2026-05-27): on iOS Safari, the WalletConnect
    // personal_sign request often does NOT auto-foreground the wallet app
    // after the initial pair. We surface an "Open wallet app" CTA the user
    // can tap if their wallet doesn't pop up. We also attempt the deep-link
    // proactively — best-effort, ignored if the user is on desktop.
    if (isMobileUA()) {
      mobileHint.hidden = false;
      // Pro-active deep-link nudge: if we have a saved wallet id, push the
      // browser to that universal link in parallel with the sign request.
      // The wallet app receives focus, sees the in-flight RPC request, and
      // surfaces the signature prompt. If the link isn't recognised this is
      // a no-op (no toast — the visible CTA is enough).
      const link = readLastWalletDeepLink();
      if (link && typeof window !== 'undefined') {
        try {
          // Use `window.open(_, '_blank')` instead of `location.href` so an
          // unintercepted universal link doesn't navigate the top frame away
          // (which would zombify the in-flight `runSignIn()` promise on iOS
          // Safari). If the OS routes the universal link to the wallet app
          // the new tab/window is irrelevant; if it doesn't, we just opened a
          // blank tab — strictly better than losing the page. Fallback to the
          // old top-frame nav only when popup-blocker returns null (we're
          // still inside the user gesture from the Sign tap, so this is rare).
          const opened = window.open(link, '_blank');
          if (!opened) {
            window.location.href = link;
          }
        } catch {
          /* swallow — CTA still gives the user a way out */
        }
      }
    }
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
      // Keep the hint visible across retries — the user may need to
      // re-foreground the wallet again on the second tap.
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
  openWalletBtn.addEventListener('click', openWalletApp);
  // Backdrop tap dismisses (matches access-modal + drag-to-dismiss UX). The
  // `busy` guard inside `onCancel` keeps the modal open mid-sign — same
  // semantics as ESC / drag, so a misclick during signing can't strand the
  // 'connecting' access state.
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) onCancel();
  });
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
