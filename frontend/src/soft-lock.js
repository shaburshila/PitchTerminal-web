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
 * @typedef {object} SoftLockOpts
 * @property {string} [zone]
 *   Optional zone label propagated to overlay dataset (`data-zone`) for
 *   easier debugging / per-zone styling overrides.
 * @property {string} [label]
 *   Overlay headline. Defaults to "Premium access required".
 * @property {string} [buttonText]
 *   Pay button label. Defaults to "Pay".
 * @property {(s:'unknown'|'anon'|'free'|'premium') => boolean} [isLocked]
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
  const label = opts.label ?? 'Premium access required';
  const buttonText = opts.buttonText ?? 'Pay';
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
      text: '🔒',
    }),
  );
  card.appendChild(
    el('div', {
      className: 'pt-soft-lock__label',
      dataset: { testId: 'soft-lock-label' },
      text: label,
    }),
  );
  const payBtn = el('button', {
    className: 'pt-btn pt-btn--primary pt-soft-lock__btn',
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
    } else {
      target.classList.remove(TARGET_CLASS);
      overlay.hidden = true;
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
