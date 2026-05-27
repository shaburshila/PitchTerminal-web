/**
 * Premium soft-lock UI — F0.13.
 *
 * Applies a CSS blur to a `target` element and overlays it with a lock icon +
 * "Requires payment" message + "Pay" button that opens the F0.12 pay-modal.
 * The overlay/blur are removed reactively when the user becomes premium and
 * re-applied on downgrade (e.g. disconnect, switch wallet).
 *
 * Usage (per zone):
 *   const lock = mountSoftLock(rightPanelEl, { zone: 'right' });
 *   // later, on tear-down (e.g. token deselect / view switch):
 *   lock.destroy();
 *
 * Internals:
 *   - Reads premium status from `access-store.js`.
 *   - Subscribes to that store; updates on every change.
 *   - When NOT premium: adds class `pt-soft-locked` to `target` (CSS applies
 *     blur + disables pointer events on its descendants) and appends an
 *     overlay element. When premium: removes both.
 *
 * The "Pay" button delegates to `openPayModal` from `access.js`. Tests can
 * inject a mock through `opts.openPayModal` so the heavy access module isn't
 * pulled into a soft-lock test's import graph.
 *
 * Anon (not signed-in) users get the same lock — premium is unattainable
 * without a session, and the pay-modal will surface that via its own flow
 * (or the user can connect first via the header).
 *
 * Spec: docs/plans/frontend.md §F0.13.
 */

import { get as getAccessState, subscribe as subscribeAccess } from './access-store.js';

const OVERLAY_CLASS = 'pt-soft-lock';
const TARGET_CLASS = 'pt-soft-locked';

function el(tag, { className, dataset, attrs, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (dataset) for (const [k, v] of Object.entries(dataset)) node.dataset[k] = v;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Lazily import `access.js`'s `openPayModal`. The pay flow drags in viem/wagmi
 * for the default payment client, so we don't want soft-lock-only consumers to
 * eagerly pull it. Tests inject `opts.openPayModal` and never reach this.
 */
async function defaultOpenPayModal(opts) {
  const mod = await import('./access.js');
  return mod.openPayModal(opts);
}

/**
 * Phase 1.5 batch 10: per-zone copy for the rich Pro-upsell card. Each zone
 * gets a tailored title + subtitle + feature list. The shape mirrors the
 * Batch 5 trade-panel cover so the soft-lock and the in-panel cover read as
 * one design system.
 */
const ZONE_CONFIGS = {
  orders: {
    title: 'Limit orders',
    subtitle:
      'Set price triggers, take-profit and stop-loss. Our keeper executes the moment the market hits your level.',
    features: ['Limit orders', 'Take-profit', 'Stop-loss', 'Price alerts'],
  },
  'my-wallet': {
    title: 'Portfolio tracking',
    subtitle: 'See your live positions and per-token PnL across every market you trade.',
    features: ['Live positions', 'PnL tracking', 'Trade history', 'Multi-token wallet'],
  },
  profile: {
    title: 'Trader profile',
    subtitle: 'Your full trading history, volume and referral earnings — all in one place.',
    features: ['Trade history', 'Volume tracking', 'Referral earnings', 'Performance stats'],
  },
  right: {
    title: 'Trading requires Pro',
    subtitle:
      'Trade 192 markets, place limit orders, sleep through fills. Our 24/7 server fires your orders the moment they trigger.',
    features: ['Market swaps', 'Limit orders', 'Take-profit', 'Price alerts'],
  },
};

const DEFAULT_CONFIG = {
  title: 'Premium required',
  subtitle: 'Upgrade to Pro to unlock this feature.',
  features: [],
};

/**
 * @typedef {object} SoftLockOpts
 * @property {string} [zone]
 *   Optional zone label propagated to overlay dataset (`data-zone`). Also
 *   selects a default copy preset (orders / my-wallet / profile / right) for
 *   the rich Pro-upsell card.
 * @property {string} [label]
 *   Card headline. Overrides the zone-default title. Defaults to "Premium
 *   required" if no zone preset matches.
 * @property {string} [subtitle]
 *   Card subtitle. Overrides the zone-default subtitle.
 * @property {string[]} [features]
 *   Bullet list of Pro features. Overrides the zone-default list. Pass `[]`
 *   to hide the feature list entirely.
 * @property {string} [priceLabel]
 *   Label above the price quote. Defaults to "One-time payment".
 * @property {string} [priceValue]
 *   Price string. Defaults to "1 PITCH".
 * @property {string} [buttonText]
 *   CTA button label. Defaults to "★ Upgrade to Pro".
 * @property {(s:'unknown'|'anon'|'connecting'|'free'|'premium') => boolean} [isLocked]
 *   Override the lock predicate. By default, anything other than `'premium'`
 *   locks. Tests can pass an explicit function to assert specific transitions.
 * @property {(opts?:object) => unknown} [openPayModal]
 *   Pay-modal factory; defaults to dynamic-import of `./access.js`.
 * @property {object} [payOpts]
 *   Passed to `openPayModal` (lets the host inject `apiClient` / `payment`
 *   stubs for tests, or hook into `onPaid`).
 * @property {(state:'unknown'|'anon'|'free'|'premium') => void} [onStateChange]
 *   Test hook fired whenever the lock re-renders. NOT invoked on initial mount;
 *   call `get()` for that.
 */

/**
 * Mount a soft-lock overlay onto `target`. Idempotent — calling twice on the
 * same target replaces the previous handle (the old one is destroyed).
 *
 * @param {HTMLElement} target
 * @param {SoftLockOpts} [opts]
 * @returns {{
 *   destroy: () => void,
 *   getState: () => 'unknown'|'anon'|'free'|'premium',
 *   isLocked: () => boolean,
 *   refresh: () => void,
 * }}
 */
export function mountSoftLock(target, opts = {}) {
  if (!(target instanceof HTMLElement)) {
    throw new TypeError('mountSoftLock: target must be an HTMLElement');
  }

  const isLockedFn = typeof opts.isLocked === 'function' ? opts.isLocked : (s) => s !== 'premium';
  const openPayFn =
    typeof opts.openPayModal === 'function' ? opts.openPayModal : defaultOpenPayModal;
  const zoneConfig = (opts.zone && ZONE_CONFIGS[opts.zone]) || DEFAULT_CONFIG;
  const label = opts.label ?? zoneConfig.title;
  const subtitle = opts.subtitle ?? zoneConfig.subtitle;
  const features = Array.isArray(opts.features) ? opts.features : zoneConfig.features;
  const priceLabel = opts.priceLabel ?? 'One-time payment';
  const priceValue = opts.priceValue ?? '1 PITCH';
  const buttonText = opts.buttonText ?? '★ Upgrade to Pro';
  const payOpts = opts.payOpts ?? undefined;

  // Tear down any previous mount on the same target so callers don't have to
  // manually `destroy()` before re-mounting (common when tab content changes).
  const stale = target.querySelector(`:scope > .${OVERLAY_CLASS}`);
  if (stale && stale.parentNode === target) {
    target.removeChild(stale);
  }

  let destroyed = false;

  // Build the overlay once and append it to `target` immediately. State
  // transitions toggle `overlay.hidden` rather than detaching/re-attaching
  // the node — CSS rule `.pt-soft-lock[hidden] { display: none; }` hides it
  // when unlocked. This keeps the DOM stable across rapid state toggles
  // (no pointer-event flicker, no race between an in-flight `removeChild`
  // and the next `appendChild`).
  const overlay = el('div', {
    className: OVERLAY_CLASS,
    dataset: {
      testId: 'soft-lock',
      ...(opts.zone ? { zone: opts.zone } : {}),
    },
    attrs: { role: 'group', 'aria-label': label },
  });

  const card = el('div', { className: 'pt-soft-lock__card' });
  card.appendChild(
    el('div', {
      className: 'pt-soft-lock__icon',
      attrs: { 'aria-hidden': 'true' },
      text: '★',
    }),
  );
  card.appendChild(
    el('div', {
      className: 'pt-soft-lock__label',
      dataset: { testId: 'soft-lock-label' },
      text: label,
    }),
  );
  if (subtitle) {
    card.appendChild(
      el('div', {
        className: 'pt-soft-lock__sub',
        dataset: { testId: 'soft-lock-sub' },
        text: subtitle,
      }),
    );
  }
  if (features.length > 0) {
    const list = el('ul', {
      className: 'pt-soft-lock__feats',
      dataset: { testId: 'soft-lock-feats' },
    });
    for (const feat of features) {
      list.appendChild(el('li', { text: String(feat) }));
    }
    card.appendChild(list);
  }
  if (priceValue) {
    const quote = el('div', { className: 'pt-soft-lock__quote' });
    quote.appendChild(el('span', { className: 'pt-soft-lock__quote-l', text: priceLabel }));
    quote.appendChild(el('span', { className: 'pt-soft-lock__quote-sep', text: '·' }));
    quote.appendChild(
      el('span', {
        className: 'pt-soft-lock__quote-r',
        dataset: { testId: 'soft-lock-price' },
        text: priceValue,
      }),
    );
    card.appendChild(quote);
  }
  const payBtn = el('button', {
    className: 'pt-soft-lock__cta',
    dataset: { testId: 'soft-lock-pay' },
    attrs: { type: 'button' },
    text: buttonText,
  });
  payBtn.addEventListener('click', () => {
    if (destroyed) return;
    try {
      openPayFn(payOpts);
    } catch (err) {
      // Open-modal failures are surfaced via the pay-modal itself; we just
      // don't want this click handler to bubble an unhandled exception.
      console.error('mountSoftLock: openPayModal threw:', err);
    }
  });
  card.appendChild(payBtn);
  overlay.appendChild(card);

  // Append once, then toggle `hidden` from `apply()`. Start hidden so the
  // first `apply(getAccessState())` is the sole source of visibility truth.
  overlay.hidden = true;
  target.appendChild(overlay);

  function apply(stateValue) {
    if (destroyed) return;
    const locked = isLockedFn(stateValue);
    if (locked) {
      target.classList.add(TARGET_CLASS);
      overlay.hidden = false;
      // Mobile race fix (2026-05-27): while the user's wallet is still
      // resolving access (post-connect, pre-SIWE / pre-/access response),
      // keep the lock VISUAL (blur + click-block) but suppress the
      // "Upgrade to Pro" upsell card content — flashing the upsell at a
      // user who actually owns premium during the 5-15s mobile WC SIWE
      // round-trip is the bug we're fixing. A small `.is-checking` class
      // on the overlay lets CSS swap the card contents for a skeleton /
      // spinner (style is in modals-batch7.css; minimal default is just
      // hiding the upsell card body — still better than the misleading
      // "no premium" pitch).
      overlay.classList.toggle('is-checking', stateValue === 'connecting');
    } else {
      target.classList.remove(TARGET_CLASS);
      overlay.hidden = true;
      overlay.classList.remove('is-checking');
    }
    if (typeof opts.onStateChange === 'function') {
      try {
        opts.onStateChange(stateValue);
      } catch {
        /* ignore */
      }
    }
  }

  // Subscribe before initial apply so a race-condition state change between
  // the read and the subscribe is impossible.
  const unsubscribe = subscribeAccess((next) => apply(next));
  apply(getAccessState());

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
      target.classList.remove(TARGET_CLASS);
      if (overlay.parentNode === target) {
        try {
          target.removeChild(overlay);
        } catch {
          /* ignore */
        }
      }
    },
    getState: () => getAccessState(),
    isLocked: () => isLockedFn(getAccessState()),
    refresh: () => apply(getAccessState()),
  };
}
