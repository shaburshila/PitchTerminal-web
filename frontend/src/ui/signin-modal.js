/**
 * Sign-in modal (F0.11).
 *
 * Tiny inline overlay shown after a successful wallet connect when the server
 * cookie is missing/expired. Single CTA — "Подписать сообщение" — calls
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
  const title = el('h2', {
    className: 'pt-modal__title',
    attrs: { id: 'pt-signin-title' },
    text: 'Войти в PitchTerminal',
  });
  const body = el('p', {
    className: 'pt-modal__body',
    text:
      'Подпишите сообщение, чтобы подтвердить владение кошельком. ' +
      'Это не транзакция и не списывает газ.',
  });
  const actions = el('div', { className: 'pt-modal__actions' });
  const signBtn = el('button', {
    className: 'pt-btn pt-btn--primary',
    dataset: { testId: 'signin-submit' },
    attrs: { type: 'button' },
    text: 'Подписать сообщение',
  });
  const cancelBtn = el('button', {
    className: 'pt-btn',
    dataset: { testId: 'signin-cancel' },
    attrs: { type: 'button' },
    text: 'Позже',
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(signBtn);
  card.appendChild(title);
  card.appendChild(body);
  card.appendChild(actions);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  _activeOverlay = overlay;
  signBtn.focus();

  let busy = false;
  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (_activeOverlay === overlay) _activeOverlay = null;
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
    signBtn.textContent = 'Подписываем…';
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
      signBtn.textContent = origText || 'Подписать сообщение';
    }
  }

  function onKey(ev) {
    if (ev.key === 'Escape') onCancel();
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
  if (!e) return 'Не удалось подписать';
  if (typeof e === 'string') return e;
  if (typeof e === 'object') {
    if ('shortMessage' in e && e.shortMessage) return String(e.shortMessage);
    if ('message' in e && e.message) return String(e.message);
  }
  return 'Не удалось подписать';
}
