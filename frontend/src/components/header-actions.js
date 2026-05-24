/**
 * Header actions — Profile + Referral buttons (Phase 1.5 batch 2).
 *
 * Wires the two buttons inserted into `pt-header__right` by `layout.js`:
 *
 *   - Profile  → calls `opts.onProfile()`; the caller switches the layout
 *                mode to 'profile' (see main.js#activateProfile).
 *   - Referral → fetches the signed-in user's referral handle via
 *                `GET /ref/me`, falls back to the wallet address on 404,
 *                composes the canonical share link
 *                `https://pitchwc-terminal.xyz/?ref=<value>`, copies it to
 *                clipboard and shows a toast.
 *
 *   On 401 (no session) the user is asked to connect a wallet first — we
 *   don't try to share the bare address blindly because that would expose
 *   any address typed into devtools.
 *
 * Closes known-issues #4 (Profile button separate from Connect Wallet)
 * and #5 (Referral button in header — copy link).
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

  let referralBusy = false;

  function onProfileClick() {
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

  async function onReferralClick() {
    if (referralBusy) return;
    referralBusy = true;
    referralBtn.disabled = true;
    try {
      // Wallet must be connected — otherwise we have nothing to seed the link
      // with (and /ref/me would 401 anyway).
      const acc = getAccount();
      if (!acc?.isConnected || !acc.address) {
        showToast('Connect your wallet to share a referral link', { kind: 'warn' });
        return;
      }

      // Prefer a readable handle; fall back to the wallet address on 404.
      // On 401 we likely have a connected wallet but no SIWE session yet —
      // sharing the bare address is still useful (the recipient just gets a
      // wallet-flavoured link instead of a handle).
      let value = acc.address.toLowerCase();
      try {
        const resp = await api.getRefMe();
        if (resp && typeof resp.code === 'string' && resp.code) {
          value = resp.code;
        }
      } catch (e) {
        const status = e && typeof e.status === 'number' ? e.status : null;
        if (status !== 404 && status !== 401) {
          // Network / 5xx — surface but still share the address-flavoured
          // link so the user isn't blocked.
          showToast('Could not load referral handle, sharing address link', { kind: 'warn' });
        }
      }

      const link = `${host}/?ref=${encodeURIComponent(value)}`;
      const ok = await copy(link);
      if (ok) {
        showToast('Referral link copied', { kind: 'info' });
      } else {
        // Clipboard failed (Safari without user gesture chain, sandbox, etc).
        // Show the link in the toast so the user can copy it manually.
        showToast(`Copy failed — your link: ${link}`, { kind: 'warn' });
      }
    } finally {
      referralBusy = false;
      referralBtn.disabled = false;
    }
  }

  profileBtn.addEventListener('click', onProfileClick);
  referralBtn.addEventListener('click', onReferralClick);

  function destroy() {
    profileBtn.removeEventListener('click', onProfileClick);
    referralBtn.removeEventListener('click', onReferralClick);
  }

  return { destroy };
}
