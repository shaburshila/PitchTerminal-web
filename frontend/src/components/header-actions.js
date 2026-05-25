/**
 * Header actions — Profile + Referral buttons (Phase 1.5 batch 2 + UX-fix).
 *
 * Wires the two buttons inserted into `pt-header__right` by `layout.js`:
 *
 *   - Profile  → calls `opts.onProfile()`; the caller switches the layout
 *                mode to 'profile' (see main.js#activateProfile).
 *   - Referral → opens a dropdown popover anchored to the button containing
 *                the user's referral link (handle if claimed, wallet address
 *                otherwise) and a Copy button. UX-update: previously the
 *                click copied directly to clipboard; now copy happens from
 *                inside the popover so the user can see the link first.
 *
 *   On 401 (no session) the dropdown still opens but with a hint asking the
 *   user to connect a wallet. On 404 we fall back to the wallet-address
 *   link. The popover dismisses on outside click / Escape.
 *
 * Closes known-issues #4 (Profile button separate from Connect Wallet)
 * and #5 (Referral button in header — share link).
 *
 * Public API:
 *   mountHeaderActions({ profileBtn, referralBtn, onProfile, ...deps })
 *     → { destroy }
 *
 * `deps` exists for tests — production code passes none and the helper
 * falls back to the live api / wallet / toast modules.
 */

import * as defaultApi from '../api.js';
import { getAccount as defaultGetAccount } from '../wallet.js';
import { showToast as defaultShowToast } from '../ui/toast.js';
import {
  get as defaultGetAccessState,
  subscribe as defaultSubscribeAccess,
} from '../access-store.js';

const LOCKED_CLASS = 'is-locked';

/**
 * Lazily import `access.js`'s `openPayModal` — viem/wagmi are heavy, so
 * non-locked sessions never pay the import cost. Tests inject `opts.openPayModal`
 * and never hit this path.
 */
async function defaultOpenPayModal(opts) {
  const mod = await import('../access.js');
  return mod.openPayModal(opts);
}

// Canonical production host. Hard-coded so a developer running the app on
// `http://localhost:5173` still copies a link that works for the recipient.
// (Local testing of the resolution endpoint also still works because the
// recipient hits prod, not localhost.)
const PROD_HOST = 'https://pitchwc-terminal.xyz';

async function copyToClipboard(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  // Fallback for older browsers / non-secure contexts where the async
  // clipboard API is unavailable (matches profile-referral.js pattern).
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    document.body.removeChild(ta);
    return Boolean(ok);
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   profileBtn: HTMLButtonElement,
 *   referralBtn: HTMLButtonElement,
 *   onProfile: () => void,
 *   api?: { getRefMe: () => Promise<unknown> },
 *   getAccount?: () => { isConnected: boolean, address: string | null },
 *   showToast?: (msg: string, opts?: object) => void,
 *   copy?: (text: string) => Promise<boolean>,
 *   prodHost?: string,
 *   getAccessState?: () => 'unknown'|'anon'|'free'|'premium',
 *   subscribeAccess?: (fn: (s: 'unknown'|'anon'|'free'|'premium') => void) => () => void,
 *   openPayModal?: (opts?: object) => unknown,
 * }} opts
 * @returns {{ destroy: () => void }}
 */
export function mountHeaderActions(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('mountHeaderActions: opts required');
  }
  const { profileBtn, referralBtn, onProfile } = opts;
  if (!(profileBtn instanceof HTMLElement) || !(referralBtn instanceof HTMLElement)) {
    throw new TypeError('mountHeaderActions: profileBtn + referralBtn must be HTMLElements');
  }
  if (typeof onProfile !== 'function') {
    throw new TypeError('mountHeaderActions: onProfile must be a function');
  }

  const api = opts.api ?? defaultApi;
  const getAccount = opts.getAccount ?? defaultGetAccount;
  const showToast = opts.showToast ?? defaultShowToast;
  const copy = opts.copy ?? copyToClipboard;
  const host = opts.prodHost ?? PROD_HOST;
  const getAccessState = opts.getAccessState ?? defaultGetAccessState;
  const subscribeAccess = opts.subscribeAccess ?? defaultSubscribeAccess;
  const openPayModal = opts.openPayModal ?? defaultOpenPayModal;

  // Phase 1.5 batch 10: Profile + Referral are premium-only. When the user is
  // not premium we mark both buttons `is-locked` (CSS surfaces the lock badge
  // + dims the label) and intercept clicks to open the pay modal instead of
  // routing into the gated surface.
  let locked = getAccessState() !== 'premium';
  function applyLockedState() {
    const state = getAccessState();
    const isLocked = state !== 'premium';
    locked = isLocked;
    profileBtn.classList.toggle(LOCKED_CLASS, isLocked);
    referralBtn.classList.toggle(LOCKED_CLASS, isLocked);
    profileBtn.setAttribute('aria-disabled', String(isLocked));
    referralBtn.setAttribute('aria-disabled', String(isLocked));
  }
  applyLockedState();
  const unsubscribeAccess = subscribeAccess(() => applyLockedState());

  function tryOpenPay() {
    try {
      openPayModal();
    } catch (err) {
      console.error('mountHeaderActions: openPayModal threw:', err);
    }
  }

  // ── Referral dropdown ────────────────────────────────────────────────────
  // Anchored to referralBtn — we mark the button's parent as
  // `position: relative` so the absolutely-positioned popover lines up
  // beneath it (mirrors the wallet-chip dropdown pattern).
  const refBtnParent = referralBtn.parentElement;
  if (refBtnParent instanceof HTMLElement) {
    refBtnParent.style.position = refBtnParent.style.position || 'relative';
  }

  const refDropdown = document.createElement('div');
  refDropdown.className = 'pt-wallet-dropdown pt-ref-dropdown';
  refDropdown.dataset.testId = 'header-referral-dropdown';
  refDropdown.setAttribute('role', 'menu');
  refDropdown.hidden = true;

  const refHeader = document.createElement('div');
  refHeader.className = 'pt-wallet-dropdown__header pt-ref-dropdown__header';
  const refLabel = document.createElement('span');
  refLabel.className = 'pt-ref-dropdown__label';
  refLabel.textContent = 'Your referral link';
  refHeader.appendChild(refLabel);
  refDropdown.appendChild(refHeader);

  const refLinkRow = document.createElement('div');
  refLinkRow.className = 'pt-ref-dropdown__link-row';
  const refLinkEl = document.createElement('code');
  refLinkEl.className = 'pt-ref-dropdown__url';
  refLinkEl.dataset.testId = 'header-referral-url';
  refLinkEl.textContent = '';
  refLinkRow.appendChild(refLinkEl);
  refDropdown.appendChild(refLinkRow);

  const refActions = document.createElement('div');
  refActions.className = 'pt-ref-dropdown__actions';
  const refCopyBtn = document.createElement('button');
  refCopyBtn.type = 'button';
  refCopyBtn.className = 'pt-btn pt-btn--primary pt-ref-dropdown__copy';
  refCopyBtn.dataset.testId = 'header-referral-copy';
  refCopyBtn.textContent = 'Copy link';
  refActions.appendChild(refCopyBtn);
  refDropdown.appendChild(refActions);

  const refStatus = document.createElement('div');
  refStatus.className = 'pt-ref-dropdown__status';
  refStatus.dataset.testId = 'header-referral-status';
  refStatus.hidden = true;
  refDropdown.appendChild(refStatus);

  if (refBtnParent instanceof HTMLElement) {
    refBtnParent.appendChild(refDropdown);
  }

  // Local state — last link computed by openReferralDropdown().
  let refLoading = false;
  let refLoadedFor = null; // address used to build the link
  let refSeq = 0;

  function setRefStatus(msg) {
    if (!msg) {
      refStatus.hidden = true;
      refStatus.textContent = '';
      return;
    }
    refStatus.textContent = msg;
    refStatus.hidden = false;
  }

  function closeReferralDropdown() {
    if (!refDropdown.hidden) {
      refDropdown.hidden = true;
      referralBtn.setAttribute('aria-expanded', 'false');
    }
  }

  async function openReferralDropdown() {
    refDropdown.hidden = false;
    referralBtn.setAttribute('aria-expanded', 'true');

    const acc = getAccount();
    if (!acc?.isConnected || !acc.address) {
      refLinkEl.textContent = '';
      refCopyBtn.disabled = true;
      setRefStatus('Connect your wallet to share a referral link.');
      return;
    }

    refCopyBtn.disabled = false;
    const addr = acc.address.toLowerCase();

    // Already loaded for this address — keep the link.
    if (refLoadedFor === addr && refLinkEl.textContent) {
      return;
    }

    // Show address-fallback link immediately, refine with handle when
    // /ref/me resolves.
    refLinkEl.textContent = `${host}/?ref=${encodeURIComponent(addr)}`;
    setRefStatus('');

    if (refLoading) return;
    refLoading = true;
    const seq = ++refSeq;
    try {
      let value = addr;
      try {
        const resp = await api.getRefMe();
        if (resp && typeof resp.code === 'string' && resp.code) {
          value = resp.code;
        }
      } catch (e) {
        const status = e && typeof e.status === 'number' ? e.status : null;
        if (status !== 404 && status !== 401) {
          // Network / 5xx — keep the address-link visible but surface a hint.
          if (seq === refSeq) setRefStatus('Could not load handle, using address link.');
        }
      }
      if (seq !== refSeq) return; // a newer open() superseded us
      refLinkEl.textContent = `${host}/?ref=${encodeURIComponent(value)}`;
      refLoadedFor = addr;
    } finally {
      refLoading = false;
    }
  }

  function onProfileClick() {
    if (locked) {
      tryOpenPay();
      return;
    }
    try {
      onProfile();
    } catch (e) {
      // Profile activation shouldn't normally throw; if a future refactor
      // breaks this surface the click gracefully instead of leaving the user
      // wondering why nothing happened.
      const msg = e && typeof e.message === 'string' ? e.message : 'Failed to open profile';
      showToast(msg, { kind: 'error' });
    }
  }

  function onReferralClick() {
    if (locked) {
      tryOpenPay();
      return;
    }
    if (!refDropdown.hidden) {
      closeReferralDropdown();
      return;
    }
    void openReferralDropdown();
  }

  async function onCopyClick(ev) {
    if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
    const link = refLinkEl.textContent || '';
    if (!link) return;
    const ok = await copy(link);
    if (ok) {
      showToast('Referral link copied', { kind: 'info' });
      const orig = refCopyBtn.textContent;
      refCopyBtn.textContent = 'Copied';
      refCopyBtn.disabled = true;
      setTimeout(() => {
        refCopyBtn.textContent = orig || 'Copy link';
        refCopyBtn.disabled = false;
      }, 1200);
    } else {
      showToast(`Copy failed — your link: ${link}`, { kind: 'warn' });
    }
  }

  function onDocClick(ev) {
    if (refDropdown.hidden) return;
    if (!(ev.target instanceof Node)) return;
    if (refDropdown.contains(ev.target) || referralBtn.contains(ev.target)) return;
    closeReferralDropdown();
  }

  function onDocKey(ev) {
    if (ev.key === 'Escape' && !refDropdown.hidden) {
      closeReferralDropdown();
    }
  }

  profileBtn.addEventListener('click', onProfileClick);
  referralBtn.addEventListener('click', onReferralClick);
  refCopyBtn.addEventListener('click', onCopyClick);
  // `document.addEventListener` is fine here — the outside-click handler is
  // a noop while the dropdown is hidden, and destroy() unregisters it.
  if (typeof document !== 'undefined') {
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onDocKey);
  }
  referralBtn.setAttribute('aria-haspopup', 'menu');
  referralBtn.setAttribute('aria-expanded', 'false');

  function destroy() {
    profileBtn.removeEventListener('click', onProfileClick);
    referralBtn.removeEventListener('click', onReferralClick);
    refCopyBtn.removeEventListener('click', onCopyClick);
    if (typeof document !== 'undefined') {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onDocKey);
    }
    if (refDropdown.parentNode) {
      refDropdown.parentNode.removeChild(refDropdown);
    }
    try {
      unsubscribeAccess();
    } catch {
      /* ignore */
    }
  }

  return { destroy };
}
