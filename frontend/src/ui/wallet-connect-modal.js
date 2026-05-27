/**
 * Wallet-connect modal — mobile bottom-sheet wallet picker.
 *
 * Flow:
 *   1. On open we initialise the WalletConnect provider with `showQrModal:
 *      false` (we own the UI; WC's built-in modal would be wrong for mobile).
 *   2. Subscribe to `display_uri` BEFORE calling `provider.connect()` —
 *      ethereum-provider emits the URI synchronously inside connect's
 *      promise, so a late listener loses it.
 *   3. When the URI arrives, render one row per `MOBILE_WALLETS` entry. Each
 *      row is an `<a target="_blank">` pointing at the wallet's universal
 *      link — taps leave the browser, the user approves in the wallet,
 *      and iOS/Android returns to our tab.
 *   4. On `accountsChanged` with a non-empty list we call `onConnected(addr)`
 *      and close. A 30s wallet-side timeout (after the user taps a row)
 *      surfaces a "Try again" affordance.
 *
 * Why a 30s timeout?
 *   The user might pick the wrong wallet, dismiss the WC prompt, or simply
 *   not have the app installed. Without a deadline the modal would sit in
 *   "Returning from wallet…" forever; 30s is long enough to approve a
 *   normal mobile WC handshake but short enough that the user notices it's
 *   stuck.
 *
 * This module is mobile-only — desktop QR flow is unchanged.
 */

import { MOBILE_WALLETS } from '../wallet-deep-links.js';
import { loadWcProvider, setWcConnected } from '../wallet.js';

const PENDING_TIMEOUT_MS = 30_000;

function el(tag, { className, dataset, attrs, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (dataset) {
    for (const [k, v] of Object.entries(dataset)) node.dataset[k] = v;
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  }
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Open the mobile wallet picker.
 *
 * @param {object} [opts]
 * @param {(address: string) => void} [opts.onConnected]
 *   Called once with the connected lowercase address. The wallet module's
 *   own `accountsChanged` listener has already pushed state by then.
 * @param {() => void} [opts.onCancel]
 *   Called on Cancel button OR backdrop click (NOT on a successful connect).
 * @returns {{ close: () => void }}
 */
export function openWcMobileModal({ onConnected, onCancel } = {}) {
  // Idempotency guards.
  let closed = false;
  let pendingTimer = null;
  let provider = null;
  let onUriHandler = null;
  let onAccountsHandler = null;

  // ── DOM ────────────────────────────────────────────────────────────────
  const overlay = el('div', {
    className: 'pt-modal-overlay pt-modal-overlay--wc-mobile',
    dataset: { testId: 'wc-mobile-modal' },
  });

  const card = el('div', {
    className: 'pt-modal pt-modal--wc-mobile',
    attrs: { role: 'dialog', 'aria-label': 'Choose wallet' },
  });

  card.appendChild(el('div', { className: 'pt-modal__drag-handle' }));
  card.appendChild(el('h2', { className: 'pt-modal__title', text: 'Connect wallet' }));

  const status = el('p', {
    className: 'pt-modal__status',
    dataset: { testId: 'wc-mobile-status' },
    text: 'Preparing connection…',
  });
  card.appendChild(status);

  const list = el('ul', {
    className: 'pt-wc-mobile__list',
    dataset: { testId: 'wc-mobile-list' },
  });
  list.hidden = true;
  card.appendChild(list);

  const cancelBtn = el('button', {
    className: 'pt-modal__cancel',
    dataset: { testId: 'wc-mobile-cancel' },
    attrs: { type: 'button' },
    text: 'Cancel',
  });
  card.appendChild(cancelBtn);

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // ── Behaviour ──────────────────────────────────────────────────────────

  function setStatus(text) {
    status.textContent = text;
  }

  function clearPendingTimer() {
    if (pendingTimer != null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  }

  function onVisibilityChange() {
    // No-op heuristic: when the user returns from the wallet app the browser
    // tab becomes visible again. We don't act on this directly (the
    // `accountsChanged` event is the authoritative signal), but we keep the
    // listener so future debug / Sentry breadcrumbs can hook in here.
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      // intentionally empty
    }
  }

  function onVVResize() {
    if (typeof window === 'undefined' || !window.visualViewport) return;
    // Compensate for both the iOS soft keyboard AND any page scroll: the
    // visual viewport may be offset from the top by `offsetTop` when scrolled,
    // so the keyboard intrusion is `innerHeight - (offsetTop + height)`.
    const vv = window.visualViewport;
    const offset = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
    card.style.marginBottom = `${offset}px`;
  }

  function onPendingTimeout() {
    pendingTimer = null;
    list.classList.remove('is-pending');
    setStatus('Wallet did not respond. Try another wallet or tap a row again.');
    // Re-enable taps so the user can retry.
    for (const link of list.querySelectorAll('a')) {
      link.removeAttribute('aria-disabled');
    }
  }

  function onWalletTap() {
    // First tap starts the wallet-side timer. Repeated taps reset it so a
    // user retrying a different wallet still gets a fresh window. The
    // visibilitychange listener is registered ONCE during modal init (below)
    // — re-registering on every tap risked multiple-registration semantics
    // we'd rather not depend on browser quirks for.
    clearPendingTimer();
    setStatus('Returning from wallet…');
    list.classList.add('is-pending');
    pendingTimer = setTimeout(onPendingTimeout, PENDING_TIMEOUT_MS);
  }

  function renderList(uri) {
    list.replaceChildren();
    for (const wallet of MOBILE_WALLETS) {
      const li = el('li', { className: 'pt-wc-mobile__item' });
      const link = el('a', {
        className: 'pt-wc-mobile__link',
        dataset: { testId: `wc-mobile-wallet-${wallet.id}` },
        attrs: {
          href: wallet.deepLink(uri),
          target: '_blank',
          rel: 'noopener noreferrer',
        },
      });
      // Icon placeholder — initials. Track C / Design polishes this.
      link.appendChild(
        el('span', {
          className: 'pt-wc-mobile__icon',
          attrs: { 'aria-hidden': 'true' },
          text: wallet.name.slice(0, 1),
        }),
      );
      link.appendChild(el('span', { className: 'pt-wc-mobile__name', text: wallet.name }));
      link.addEventListener('click', onWalletTap);
      li.appendChild(link);
      list.appendChild(li);
    }
    list.hidden = false;
    setStatus('Choose your wallet');
  }

  function handleAccountsChanged(accounts) {
    if (closed) return;
    if (!Array.isArray(accounts) || !accounts[0]) return;
    const addr = String(accounts[0]).toLowerCase();
    // Push state into wallet.js BEFORE notifying caller so that any
    // synchronous onAccountChange listeners (wallet chip, SIWE bootstrap,
    // access banner) see `isConnected: true` and the WC connector id when
    // they re-read. Bypassing this caused the chip to stay in the
    // "Connect" state on a successful mobile connect.
    if (provider) {
      try {
        setWcConnected(provider);
      } catch {
        // ignore — state update should never block UI close
      }
    }
    if (typeof onConnected === 'function') {
      try {
        onConnected(addr);
      } catch {
        // best-effort — listener errors shouldn't block teardown
      }
    }
    close();
  }

  function detachProviderListeners() {
    if (!provider) return;
    try {
      if (onUriHandler && typeof provider.off === 'function') {
        provider.off('display_uri', onUriHandler);
      } else if (onUriHandler && typeof provider.removeListener === 'function') {
        provider.removeListener('display_uri', onUriHandler);
      }
    } catch {
      // ignore — provider may already be torn down
    }
    try {
      if (onAccountsHandler && typeof provider.off === 'function') {
        provider.off('accountsChanged', onAccountsHandler);
      } else if (onAccountsHandler && typeof provider.removeListener === 'function') {
        provider.removeListener('accountsChanged', onAccountsHandler);
      }
    } catch {
      // ignore
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    clearPendingTimer();
    detachProviderListeners();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    if (typeof window !== 'undefined' && window.visualViewport) {
      try {
        window.visualViewport.removeEventListener('resize', onVVResize);
      } catch {
        // ignore
      }
    }
    cancelBtn.removeEventListener('click', onCancelClick);
    overlay.removeEventListener('click', onBackdropClick);
    if (overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
  }

  function onCancelClick() {
    if (typeof onCancel === 'function') {
      try {
        onCancel();
      } catch {
        // ignore listener errors
      }
    }
    close();
  }

  function onBackdropClick(ev) {
    if (ev.target !== overlay) return;
    onCancelClick();
  }

  cancelBtn.addEventListener('click', onCancelClick);
  overlay.addEventListener('click', onBackdropClick);

  if (typeof window !== 'undefined' && window.visualViewport) {
    window.visualViewport.addEventListener('resize', onVVResize);
  }
  // Single visibilitychange registration for the modal's lifetime. The
  // listener is currently a no-op breadcrumb hook — see onVisibilityChange.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  // ── Provider wiring ────────────────────────────────────────────────────
  (async () => {
    try {
      provider = await loadWcProvider({ showQrModal: false });
      if (closed) return;

      onUriHandler = (uri) => {
        if (closed) return;
        if (typeof uri === 'string' && uri) {
          renderList(uri);
        }
      };
      onAccountsHandler = (accounts) => {
        handleAccountsChanged(accounts);
      };

      if (typeof provider.on === 'function') {
        provider.on('display_uri', onUriHandler);
        provider.on('accountsChanged', onAccountsHandler);
      }

      // Fire-and-forget — the user-driven leg is the wallet tap, not this
      // promise. We still catch so a rejection (network, project mis-config)
      // surfaces in the status line instead of an uncaught rejection.
      try {
        await provider.connect({ chains: [8453] });
      } catch (err) {
        if (closed) return;
        const msg = err && typeof err.message === 'string' ? err.message : 'Connection failed';
        setStatus(msg);
      }
    } catch (err) {
      if (closed) return;
      const msg = err && typeof err.message === 'string' ? err.message : 'Connection failed';
      setStatus(msg);
    }
  })();

  return { close };
}
