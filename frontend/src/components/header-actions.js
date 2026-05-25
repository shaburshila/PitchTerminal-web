/**
 * Header actions — Profile + Referral buttons.
 *
 * Wires the two buttons inserted into `pt-header__right` by `layout.js`:
 *
 *   - Profile  → calls `opts.onProfile()`; the caller switches the layout
 *                mode to 'profile' (see main.js#activateProfile).
 *   - Referral → opens a centered modal dialog with the referral program
 *                marketing pitch ("You get 25%, they get 25%"), the user's
 *                referral link with a Copy button, and Twitter/Telegram
 *                share shortcuts. Previously this opened an inline dropdown
 *                popover; the modal gives the program more presence and
 *                room to explain the two-sided rebate.
 *
 *   On 401 (no session) the modal still opens but with a hint asking the
 *   user to connect a wallet. The modal NEVER exposes the wallet address
 *   in the referral link: on first open we auto-generate an 8-char code
 *   (`[a-z0-9]`, crypto-entropy) and PUT /ref/me to claim it. Subsequent
 *   opens reuse the claimed handle via GET /ref/me. The modal dismisses
 *   on close-button click, outside click, or Escape.
 *
 * Phase 1.5 batch 10 (premium-gating): when the user isn't premium, both
 * buttons get the `is-locked` class (visual lock-badge + dimmed label) and
 * clicks open the pay modal instead of the gated surface.
 *
 * Referral header button also receives `.pt-header__action--gold` —
 * cosmetic-only modifier that paints the chip in the `--warn` premium
 * accent so the eye lands on it before the other header chips.
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
const GOLD_CLASS = 'pt-header__action--gold';

/**
 * Length / alphabet for auto-generated referral codes.
 *
 * - 8 chars of `[a-z0-9]` → 36^8 ≈ 2.82e12 keyspace. With even a million
 *   active handles the chance of any one PUT colliding stays well under
 *   1e-6, and we still retry up to MAX_CLAIM_ATTEMPTS on 409 just in case.
 * - Lowercase alphanumeric only — sidesteps the server's
 *   "no leading/trailing dash/underscore" rule (no separators at all).
 * - 8 chars > 4-char reserved-list max, so the auto-generated code can
 *   never accidentally hit `api`, `admin`, `ref`, etc.
 */
const REFERRAL_CODE_LENGTH = 8;
const REFERRAL_CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const MAX_CLAIM_ATTEMPTS = 5;

/**
 * Generate a fresh 8-char lowercase-alphanumeric referral code using
 * `crypto.getRandomValues` (NEVER `Math.random` — predictable seeds would
 * make the per-user code guessable by attackers crafting collision storms).
 *
 * Uses 8 bytes mod 36; the modulo skew (256 % 36 ≠ 0) gives the first
 * `256 % 36 = 4` symbols of the alphabet a ~0.4% relative bias, which is
 * irrelevant for collision risk at this keyspace.
 */
function defaultGenerateReferralCode() {
  const bytes = new Uint8Array(REFERRAL_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    out += REFERRAL_CODE_ALPHABET[bytes[i] % REFERRAL_CODE_ALPHABET.length];
  }
  return out;
}

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

function el(tag, { className, dataset, attrs, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (dataset) for (const [k, v] of Object.entries(dataset)) node.dataset[k] = v;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

/**
 * @param {{
 *   profileBtn: HTMLButtonElement,
 *   referralBtn: HTMLButtonElement,
 *   onProfile: () => void,
 *   api?: { getRefMe: () => Promise<unknown>, putRefMe: (code: string) => Promise<unknown> },
 *   generateCode?: () => string,
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
  const generateCode = opts.generateCode ?? defaultGenerateReferralCode;

  // Gold-accent paint to make Referral stand out from sibling header chips.
  // Premium-locked dimming (Batch 10) still applies on top of this — the
  // `is-locked` class wins on opacity.
  referralBtn.classList.add(GOLD_CLASS);

  // Phase 1.5 batch 10: Profile + Referral are premium-only.
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

  // ── Referral modal state ────────────────────────────────────────────────
  // Only one modal can be open at a time. `modalCleanup` closes it; null
  // when nothing is open. Link state is cached per-address so re-opening
  // the modal doesn't re-issue /ref/me unless the wallet changed.
  let modalCleanup = null;
  let refLinkText = '';
  let refLoadedFor = null;
  let refSeq = 0;

  function buildLink(value) {
    return `${host}/?ref=${encodeURIComponent(value)}`;
  }

  function closeReferralModal() {
    if (modalCleanup) {
      try {
        modalCleanup();
      } catch {
        /* ignore */
      }
      modalCleanup = null;
      referralBtn.setAttribute('aria-expanded', 'false');
    }
  }

  function openReferralModal() {
    // Re-open semantics: clicking the button while modal is open closes it.
    if (modalCleanup) {
      closeReferralModal();
      return;
    }

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : referralBtn;

    const overlay = el('div', {
      className: 'pt-modal-overlay',
      dataset: { testId: 'referral-modal-overlay' },
      attrs: { role: 'presentation' },
    });
    const card = el('div', {
      className: 'pt-modal pt-modal--referral-header',
      dataset: { testId: 'referral-modal' },
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pt-ref-header-title' },
    });

    const closeBtn = el('button', {
      className: 'pt-modal__close',
      dataset: { testId: 'referral-modal-close' },
      attrs: { type: 'button', 'aria-label': 'Close' },
      text: '✕',
    });
    card.appendChild(closeBtn);

    // Hero — gold star to mirror the pay-flow upgrade visual language.
    const hero = el('div', { className: 'pt-pay__hero pt-ref-modal__hero' });
    hero.appendChild(
      el('div', {
        className: 'pt-pay__hero-icon',
        attrs: { 'aria-hidden': 'true' },
        text: '★',
      }),
    );
    const heroText = el('div', { className: 'pt-pay__hero-text' });
    heroText.appendChild(
      el('h2', {
        className: 'pt-modal__title',
        attrs: { id: 'pt-ref-header-title' },
        text: 'Invite friends, earn together',
      }),
    );
    heroText.appendChild(
      el('p', {
        text: 'Two-sided rebate: you both pocket 25% of every trade fee.',
      }),
    );
    hero.appendChild(heroText);
    card.appendChild(hero);

    // Two-column benefits block — "You get" / "They get".
    const benefits = el('div', { className: 'pt-ref-modal__benefits' });
    const youCard = el('div', {
      className: 'pt-ref-modal__benefit pt-ref-modal__benefit--you',
      dataset: { testId: 'referral-modal-you' },
    });
    youCard.appendChild(
      el('div', { className: 'pt-ref-modal__benefit-label', text: 'You get' }),
    );
    youCard.appendChild(
      el('div', { className: 'pt-ref-modal__benefit-headline', text: '25% rebate' }),
    );
    youCard.appendChild(
      el('div', {
        className: 'pt-ref-modal__benefit-sub',
        text: 'Earn 25% of every trading fee paid by people who joined via your link. Forever.',
      }),
    );
    benefits.appendChild(youCard);

    const themCard = el('div', {
      className: 'pt-ref-modal__benefit pt-ref-modal__benefit--them',
      dataset: { testId: 'referral-modal-them' },
    });
    themCard.appendChild(
      el('div', { className: 'pt-ref-modal__benefit-label', text: 'They get' }),
    );
    themCard.appendChild(
      el('div', { className: 'pt-ref-modal__benefit-headline', text: '25% discount' }),
    );
    themCard.appendChild(
      el('div', {
        className: 'pt-ref-modal__benefit-sub',
        text: 'Friends who click your link pay 25% less in trading fees on every trade.',
      }),
    );
    benefits.appendChild(themCard);
    card.appendChild(benefits);

    // Link block — label + url + copy + share row.
    const linkBlock = el('div', { className: 'pt-ref-modal__link-block' });
    linkBlock.appendChild(
      el('div', {
        className: 'pt-modal__section-label',
        text: 'Your referral link',
      }),
    );

    const linkRow = el('div', { className: 'pt-ref-modal__link-row' });
    const linkEl = el('code', {
      className: 'pt-ref-modal__url',
      dataset: { testId: 'referral-modal-url' },
      text: '',
    });
    linkRow.appendChild(linkEl);
    const copyBtn = el('button', {
      className: 'pt-btn pt-btn--primary pt-ref-modal__copy',
      dataset: { testId: 'referral-modal-copy' },
      attrs: { type: 'button' },
      text: 'Copy',
    });
    linkRow.appendChild(copyBtn);
    linkBlock.appendChild(linkRow);

    const status = el('div', {
      className: 'pt-ref-modal__status',
      dataset: { testId: 'referral-modal-status' },
    });
    status.hidden = true;
    linkBlock.appendChild(status);

    // Share row — pre-filled Twitter/X + Telegram. Anchors open in new tab.
    const shareRow = el('div', { className: 'pt-ref-modal__share' });
    shareRow.appendChild(
      el('div', {
        className: 'pt-ref-modal__share-label',
        text: 'Share via',
      }),
    );
    const shareBtns = el('div', { className: 'pt-ref-modal__share-btns' });
    const shareXAnchor = el('a', {
      className: 'pt-btn pt-ref-modal__share-btn',
      dataset: { testId: 'referral-modal-share-x' },
      attrs: { href: '#', target: '_blank', rel: 'noopener noreferrer' },
      text: 'X / Twitter',
    });
    const shareTgAnchor = el('a', {
      className: 'pt-btn pt-ref-modal__share-btn',
      dataset: { testId: 'referral-modal-share-tg' },
      attrs: { href: '#', target: '_blank', rel: 'noopener noreferrer' },
      text: 'Telegram',
    });
    shareBtns.appendChild(shareXAnchor);
    shareBtns.appendChild(shareTgAnchor);
    shareRow.appendChild(shareBtns);
    linkBlock.appendChild(shareRow);
    card.appendChild(linkBlock);

    const footnote = el('div', {
      className: 'pt-ref-modal__footnote',
      dataset: { testId: 'referral-modal-footnote' },
      text:
        'The 25/25 rebate applies to trading fees on every trade your referrals make — ' +
        'as long as their account exists.',
    });
    card.appendChild(footnote);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    referralBtn.setAttribute('aria-expanded', 'true');

    function setStatus(msg) {
      if (!msg) {
        status.hidden = true;
        status.textContent = '';
        return;
      }
      status.textContent = msg;
      status.hidden = false;
    }

    function applyLink(value) {
      const url = buildLink(value);
      refLinkText = url;
      linkEl.textContent = url;
      copyBtn.disabled = false;
      const tweet =
        `I trade pitchwc.app player + country tokens on PitchTerminal. ` +
        `Join with my link to get 25% off trading fees.`;
      shareXAnchor.href =
        'https://twitter.com/intent/tweet?text=' +
        encodeURIComponent(tweet) +
        '&url=' +
        encodeURIComponent(url);
      shareTgAnchor.href =
        'https://t.me/share/url?url=' +
        encodeURIComponent(url) +
        '&text=' +
        encodeURIComponent(tweet);
    }

    function disableLink(msg) {
      refLinkText = '';
      linkEl.textContent = '';
      copyBtn.disabled = true;
      shareXAnchor.removeAttribute('href');
      shareTgAnchor.removeAttribute('href');
      shareXAnchor.setAttribute('aria-disabled', 'true');
      shareTgAnchor.setAttribute('aria-disabled', 'true');
      setStatus(msg);
    }

    // Initial link — connect-wallet hint when anonymous, otherwise we resolve
    // (or auto-claim) the handle before showing any URL. We NEVER leak the
    // wallet address in the referral link — see ensureReferralHandle below.
    const acc = getAccount();
    if (!acc?.isConnected || !acc.address) {
      disableLink('Connect your wallet to get a referral link.');
    } else {
      const addr = acc.address.toLowerCase();
      // Use cached handle-link if we resolved it for this address before.
      if (refLoadedFor === addr && refLinkText) {
        applyLink(refLinkText.replace(`${host}/?ref=`, ''));
        setStatus('');
      } else {
        // Loading state — keep the URL slot empty until we have a code.
        // Disable copy/share so the user can't act on an unresolved link.
        disableLink('Generating your referral code…');
        const seq = ++refSeq;
        (async () => {
          try {
            const code = await ensureReferralHandle();
            if (seq !== refSeq || !modalCleanup) return; // superseded / closed
            applyLink(code);
            setStatus('');
            refLoadedFor = addr;
          } catch (e) {
            if (seq !== refSeq || !modalCleanup) return;
            const status = e && typeof e.status === 'number' ? e.status : null;
            if (status === 401) {
              disableLink('Sign in to your wallet to get a referral link.');
              return;
            }
            // 5/5 collisions, 5xx, network, or any other unexpected shape.
            // We deliberately do NOT fall back to the wallet address — the
            // whole point of this flow is that the link must never expose it.
            disableLink('Could not generate a referral code. Please try again later.');
          }
        })();
      }
    }

    /**
     * Resolve the user's referral code, auto-claiming a fresh one on first
     * open. Never returns a wallet address — callers can rely on the result
     * being a server-validated handle from /ref/me.
     *
     * Flow:
     *   1. GET /ref/me — if 200, return existing code.
     *   2. On 404, generate an 8-char code and PUT /ref/me.
     *   3. On 409 (someone claimed that exact 8-char string between our
     *      generate and PUT — astronomically unlikely but possible), retry
     *      with a fresh code up to MAX_CLAIM_ATTEMPTS times.
     *   4. Any other error bubbles up so the caller can show a status line.
     */
    async function ensureReferralHandle() {
      try {
        const me = await api.getRefMe();
        if (me && typeof me.code === 'string' && me.code) return me.code;
      } catch (e) {
        const status = e && typeof e.status === 'number' ? e.status : null;
        if (status !== 404) throw e; // 401/5xx/etc — surface as-is
        // 404 → fall through to claim.
      }
      for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
        const candidate = generateCode();
        try {
          const claimed = await api.putRefMe(candidate);
          if (claimed && typeof claimed.code === 'string' && claimed.code) {
            return claimed.code;
          }
          // Defensive: server returned 2xx without a code — treat as success
          // using the candidate we just sent.
          return candidate;
        } catch (e) {
          const status = e && typeof e.status === 'number' ? e.status : null;
          if (status === 409) continue; // collision, regenerate and retry
          throw e;
        }
      }
      throw new Error(
        `Could not generate a unique referral code after ${MAX_CLAIM_ATTEMPTS} attempts`,
      );
    }

    // ── Event wiring ─────────────────────────────────────────────────────
    async function onCopy() {
      if (!refLinkText) return;
      const ok = await copy(refLinkText);
      if (ok) {
        showToast('Referral link copied', { kind: 'info' });
        const orig = copyBtn.textContent;
        copyBtn.textContent = 'Copied';
        copyBtn.disabled = true;
        setTimeout(() => {
          if (!modalCleanup) return; // modal closed in the meantime
          copyBtn.textContent = orig || 'Copy';
          copyBtn.disabled = false;
        }, 1200);
      } else {
        showToast(`Copy failed — your link: ${refLinkText}`, { kind: 'warn' });
      }
    }

    function focusableNodes() {
      const sel =
        'a[href], button:not([disabled]), input:not([disabled]),' +
        ' [tabindex]:not([tabindex="-1"])';
      return Array.from(overlay.querySelectorAll(sel)).filter(
        (node) => !node.hasAttribute('hidden'),
      );
    }

    function onKey(ev) {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        closeReferralModal();
        return;
      }
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

    function onOverlayMousedown(ev) {
      // Click outside the card (on the dim backdrop) → close. Anything
      // inside the card bubbles past.
      if (ev.target === overlay) {
        closeReferralModal();
      }
    }

    closeBtn.addEventListener('click', () => closeReferralModal());
    copyBtn.addEventListener('click', onCopy);
    overlay.addEventListener('mousedown', onOverlayMousedown);
    document.addEventListener('keydown', onKey);

    modalCleanup = () => {
      document.removeEventListener('keydown', onKey);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        try {
          if (previouslyFocused.isConnected !== false) {
            previouslyFocused.focus();
          }
        } catch {
          /* ignore */
        }
      }
    };

    // Initial focus — landing on the close button keeps the destructive
    // action one Tab away from the primary "Copy" CTA but doesn't surprise
    // screen-reader users with an unexpected announcement target.
    try {
      closeBtn.focus();
    } catch {
      /* ignore */
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
      const msg = e && typeof e.message === 'string' ? e.message : 'Failed to open profile';
      showToast(msg, { kind: 'error' });
    }
  }

  function onReferralClick() {
    if (locked) {
      tryOpenPay();
      return;
    }
    openReferralModal();
  }

  profileBtn.addEventListener('click', onProfileClick);
  referralBtn.addEventListener('click', onReferralClick);
  referralBtn.setAttribute('aria-haspopup', 'dialog');
  referralBtn.setAttribute('aria-expanded', 'false');

  function destroy() {
    profileBtn.removeEventListener('click', onProfileClick);
    referralBtn.removeEventListener('click', onReferralClick);
    closeReferralModal();
    try {
      unsubscribeAccess();
    } catch {
      /* ignore */
    }
  }

  return { destroy };
}
