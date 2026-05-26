/**
 * mobile-wallet-panel.js — Phase 3b-1 Track C (Wallet panel for mobile).
 *
 * Hosts the chip-row sub-router inside the Wallet bottom-nav panel:
 *   [Profile] [Orders] [Referral] [My Wallet]
 *
 * Per locked decision D3 — horizontal chip row, scrollable on overflow. Per
 * Q2 — the Orders sub-page mounted here is a SECOND instance (the Trade tab
 * has its own); both consume the same SSE pushes. Both are token-scoped.
 *
 * Sub-pages are mounted lazily on chip switch (destroyed + remounted) — this
 * matches the desktop pattern (`activateProfile()` rebuilds the profile view
 * on each activation, my-wallet/orders bottom-tabs lazy-mount on first show).
 * Only Orders is kept mounted across switches IF a future iteration wants
 * live SSE updates while hidden; today's spec accepts the second instance
 * being torn down on chip-switch.
 *
 * URL-hash sync: chip taps update `#/wallet/<subpage>` via
 * `mobile-router.navigateTo(TABS.WALLET, subpage)`. The reverse direction
 * (hashchange / `onTabChange` callback) is also wired so deep-links land on
 * the right chip.
 *
 * Returns `{ destroy, setActiveSub, pushOrderUpdate, setToken }`.
 *
 * Active-token sync (Phase 3b-2): the Wallet/Orders sub-page needs to track
 * the token the user picked in Markets. `setToken(token)` stores the latest
 * selection in a closure and forwards it to the active Orders handle when
 * present; when the user later switches to the Orders chip, the freshly
 * mounted instance immediately receives `setToken(activeToken)` so its order
 * list filters correctly. Without this, the Wallet/Orders instance only saw
 * "no token" on first mount and never caught up.
 */

import { TABS, navigateTo, onTabChange, getActiveTab } from './mobile-router.js';
import { mountProfile } from './profile.js';
import { mountOrdersTab } from './orders-tab.js';
import { mountProfileReferral } from './profile-referral.js';
import { mountMyWalletTab } from './my-wallet-tab.js';
import { get as getAccessState, subscribe as subscribeAccessState } from './access-store.js';

const VALID_SUBS = Object.freeze(['profile', 'orders', 'referral', 'mywallet']);
const DEFAULT_SUB = 'profile';
/**
 * Sub-pages that require a premium session to view (matches the desktop
 * gating in `components/bottom/index.js applyTabLockState`). `mywallet`
 * gates itself internally; `orders` is auth-only but surfaces a 401 state
 * gracefully — neither needs an external intercept here.
 */
const PREMIUM_REQUIRED_SUBS = Object.freeze(['profile', 'referral']);

/**
 * Lazy import of `openPayModal` — mirrors desktop's bottom-tabs pattern so
 * free users don't pay viem/wagmi import cost until they actually tap a
 * locked chip. Tests can override via opts.openPayModal.
 */
async function defaultOpenPayModal(opts) {
  const mod = await import('./access.js');
  return mod.openPayModal(opts);
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
 * @typedef {object} MobileWalletPanelOpts
 * @property {object} [profileOpts]   forwarded to mountProfile
 * @property {object} [ordersTabOpts] forwarded to mountOrdersTab
 * @property {object} [referralOpts]  forwarded to mountProfileReferral
 * @property {object} [myWalletOpts]  forwarded to mountMyWalletTab
 * @property {() => string|null} [getInitialSub]
 *   Override for tests; defaults to reading `getActiveTab().subroute`.
 * @property {(opts?: object) => unknown} [openPayModal]
 *   Override for tests; defaults to lazy-importing `./access.js`. Called
 *   when a free user taps a premium-only chip (Profile / Referral).
 * @property {object} [payOpts]
 *   Forwarded to openPayModal (e.g. referral wallet).
 * @property {() => string} [getAccessState]
 *   Override for tests; defaults to access-store `get()`.
 * @property {(fn: () => void) => () => void} [subscribeAccess]
 *   Override for tests; defaults to access-store `subscribe()`.
 */

/**
 * @param {HTMLElement} container
 * @param {MobileWalletPanelOpts} [opts]
 * @returns {{
 *   destroy: () => void,
 *   setActiveSub: (sub: string) => void,
 *   pushOrderUpdate: (payload: object) => void,
 *   getActiveSub: () => string,
 * }}
 */
export function mountMobileWalletPanel(container, opts = {}) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('mountMobileWalletPanel: container must be an HTMLElement');
  }

  const profileOpts = opts.profileOpts ?? {};
  const ordersTabOpts = opts.ordersTabOpts ?? {};
  const referralOpts = opts.referralOpts ?? {};
  const myWalletOpts = opts.myWalletOpts ?? {};
  const openPayModal =
    typeof opts.openPayModal === 'function' ? opts.openPayModal : defaultOpenPayModal;
  const payOpts = opts.payOpts ?? {};
  const readAccess =
    typeof opts.getAccessState === 'function' ? opts.getAccessState : getAccessState;
  const subscribeAccess =
    typeof opts.subscribeAccess === 'function' ? opts.subscribeAccess : subscribeAccessState;
  const getInitialSub =
    typeof opts.getInitialSub === 'function'
      ? opts.getInitialSub
      : () => {
          const active = getActiveTab();
          return active && active.tab === 'wallet' ? active.subroute : null;
        };

  container.replaceChildren();

  const root = el('div', {
    className: 'pt-mobile-wallet',
    dataset: { testId: 'mobile-wallet' },
  });

  // ── Chips row ────────────────────────────────────────────────────────────
  const chips = el('div', {
    className: 'pt-mobile-wallet__chips',
    attrs: { role: 'tablist', 'aria-label': 'Wallet sections' },
  });

  /** @type {Record<string, HTMLButtonElement>} */
  const chipButtons = {};
  const chipSpec = [
    { id: 'profile', label: 'Profile' },
    { id: 'orders', label: 'Orders' },
    { id: 'referral', label: 'Referral' },
    { id: 'mywallet', label: 'My Wallet' },
  ];
  for (const spec of chipSpec) {
    const btn = el('button', {
      className: 'pt-mobile-wallet__chip',
      dataset: { subpage: spec.id, testId: `mobile-wallet-chip-${spec.id}` },
      attrs: { type: 'button', role: 'tab', 'aria-selected': 'false' },
      text: spec.label,
    });
    btn.addEventListener('click', () => {
      // Guard against re-entrancy: the same handler is invoked synchronously
      // by `navigateTo`'s commit -> onTabChange callback. We mark internal
      // navigation so the callback knows to skip re-mounting.
      requestActiveSub(spec.id, /* fromChip */ true);
    });
    chipButtons[spec.id] = btn;
    chips.appendChild(btn);
  }
  root.appendChild(chips);

  // ── Content host ─────────────────────────────────────────────────────────
  const content = el('div', {
    className: 'pt-mobile-wallet__content',
    dataset: { testId: 'wallet-subpage' },
  });
  root.appendChild(content);
  container.appendChild(root);

  // ── State + sub-page lifecycle ───────────────────────────────────────────
  let activeSub = null;
  let activeHandle = null;
  /**
   * Latest token picked in Markets. Forwarded to a freshly mounted Orders
   * sub-page so it filters correctly on first paint. Null until the user
   * makes a selection — Orders mounts with its built-in "Select a token"
   * placeholder in that case. */
  let activeToken = null;
  /** Re-entrancy guard for hash<->chip sync. */
  let isInternalNav = false;

  function destroyActiveHandle() {
    if (activeHandle && typeof activeHandle.destroy === 'function') {
      try {
        activeHandle.destroy();
      } catch {
        /* idempotent */
      }
    }
    activeHandle = null;
  }

  function mountSubpage(sub) {
    content.replaceChildren();
    switch (sub) {
      case 'profile':
        return mountProfile(content, profileOpts);
      case 'orders':
        return mountOrdersTab(content, ordersTabOpts);
      case 'referral':
        return mountProfileReferral(content, referralOpts);
      case 'mywallet':
        return mountMyWalletTab(content, myWalletOpts);
      default:
        return null;
    }
  }

  function applyChipActive(sub) {
    for (const id of Object.keys(chipButtons)) {
      const isActive = id === sub;
      chipButtons[id].classList.toggle('is-active', isActive);
      chipButtons[id].setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
  }

  function applyChipLockState() {
    const isPremium = readAccess() === 'premium';
    for (const id of PREMIUM_REQUIRED_SUBS) {
      const btn = chipButtons[id];
      if (!btn) continue;
      btn.classList.toggle('is-locked', !isPremium);
      btn.setAttribute('aria-disabled', String(!isPremium));
    }
  }

  function requestActiveSub(sub, fromChip) {
    const next = VALID_SUBS.includes(sub) ? sub : DEFAULT_SUB;
    if (next === activeSub) return;

    // Premium-gating intercept (D8 parity with desktop bottom-tabs). Profile
    // and Referral are premium-only on desktop; mywallet self-gates; orders
    // surfaces 401 naturally. For locked chips we open the pay modal and
    // bail WITHOUT remounting — visually the chip flashes via :active state
    // but stays on whatever sub-page the user was viewing.
    if (PREMIUM_REQUIRED_SUBS.includes(next) && readAccess() !== 'premium') {
      try {
        const result = openPayModal(payOpts);
        if (result && typeof result.catch === 'function') {
          result.catch((err) => {
            console.error('mountMobileWalletPanel: openPayModal threw:', err);
          });
        }
      } catch (err) {
        console.error('mountMobileWalletPanel: openPayModal threw:', err);
      }
      return;
    }

    // Mount FIRST so the visible content swap is atomic; then update chip
    // styling + URL hash.
    destroyActiveHandle();
    let handle = null;
    try {
      handle = mountSubpage(next);
    } catch (err) {
      console.error('mountMobileWalletPanel: mountSubpage failed', err);
    }
    activeHandle = handle;
    // Replay the latest active token when mounting the Orders sub-page so
    // the list filters by the user's current Markets pick instead of showing
    // the empty-state placeholder. Other sub-pages don't have a setToken
    // surface (Profile/Referral/MyWallet are wallet-scoped, not token-scoped).
    if (next === 'orders' && handle && activeToken && typeof handle.setToken === 'function') {
      try {
        handle.setToken(activeToken);
      } catch (err) {
        console.error('mountMobileWalletPanel: orders setToken on mount threw', err);
      }
    }
    // Only advance activeSub when the mount succeeded; otherwise leave it
    // null so a retry tap on the same chip re-attempts instead of becoming
    // a silent no-op (the `next === activeSub` guard would short-circuit).
    if (handle !== null) {
      activeSub = next;
      applyChipActive(next);
    } else {
      activeSub = null;
      applyChipActive(null);
    }
    if (fromChip) {
      // Update URL hash. The resulting onTabChange callback below will see
      // `isInternalNav` and bail.
      isInternalNav = true;
      try {
        navigateTo(TABS.WALLET, next === DEFAULT_SUB ? undefined : next);
      } finally {
        // Reset on next microtask so external hashchange events (back/forward
        // button) still drive the panel.
        Promise.resolve().then(() => {
          isInternalNav = false;
        });
      }
    }
  }

  // ── Hash listener — back button / deep link → drive the chip ─────────────
  const unsubRouter = onTabChange(({ tab, subroute }) => {
    if (tab !== 'wallet') return;
    if (isInternalNav) return;
    requestActiveSub(subroute || DEFAULT_SUB, /* fromChip */ false);
  });

  // ── Access-state lock indicator (visual only; pay-modal intercept lives
  //    inside requestActiveSub) ────────────────────────────────────────────
  applyChipLockState();
  const unsubAccess = subscribeAccess(() => applyChipLockState());

  // ── Initial mount ────────────────────────────────────────────────────────
  // If the initial deep-link points to a premium-only sub and the user isn't
  // premium yet, fall back to DEFAULT_SUB (Profile is in the gated set too;
  // but it falls back to itself which then trips the pay modal — undesirable
  // on first load). Resolve to 'orders' (the only ungated landable sub) if
  // the user is unauthed/free; once they pay they can navigate freely.
  const initial = getInitialSub();
  const resolvedInitial = (() => {
    const candidate = initial && VALID_SUBS.includes(initial) ? initial : DEFAULT_SUB;
    if (PREMIUM_REQUIRED_SUBS.includes(candidate) && readAccess() !== 'premium') {
      return 'orders';
    }
    return candidate;
  })();
  requestActiveSub(resolvedInitial, /* fromChip */ false);

  // ── Public API ───────────────────────────────────────────────────────────
  function setActiveSub(sub) {
    requestActiveSub(sub, /* fromChip */ true);
  }

  function pushOrderUpdate(payload) {
    // Only the Orders sub-page consumes order events. Forward when it's the
    // active instance; otherwise the event is dropped here (the trade-tab
    // Orders instance still receives it via the main.js forwarder).
    if (activeSub !== 'orders' || !activeHandle) return;
    if (typeof activeHandle.pushOrderUpdate !== 'function') return;
    try {
      activeHandle.pushOrderUpdate(payload);
    } catch (err) {
      console.error('mountMobileWalletPanel: pushOrderUpdate threw', err);
    }
  }

  function getActiveSub() {
    return activeSub;
  }

  /**
   * Store the latest token selection and, if the Orders sub-page is currently
   * mounted, forward it immediately. Null clears the cached selection (so a
   * later Orders mount does not replay a stale token).
   *
   * @param {object|null} token
   */
  function setToken(token) {
    activeToken = token ?? null;
    if (activeSub !== 'orders' || !activeHandle) return;
    if (typeof activeHandle.setToken !== 'function') return;
    try {
      activeHandle.setToken(activeToken);
    } catch (err) {
      console.error('mountMobileWalletPanel: setToken threw', err);
    }
  }

  function destroy() {
    try {
      unsubRouter();
    } catch {
      /* idempotent */
    }
    try {
      unsubAccess();
    } catch {
      /* idempotent */
    }
    destroyActiveHandle();
    if (root.parentNode === container) container.removeChild(root);
  }

  return { destroy, setActiveSub, pushOrderUpdate, getActiveSub, setToken };
}
