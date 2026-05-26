/**
 * mobile-modals.js — bottom-sheet drag-to-dismiss helper.
 *
 * Companion to the CSS bottom-sheet styling in `styles/mobile.css`. The CSS
 * turns every overlay-mounted `.pt-modal` (except the WC picker, which has its
 * own layout) into a bottom-anchored sheet with a slide-up animation and a
 * visual drag handle (the `::before` grab-bar). This module adds the *actual*
 * touch behaviour that the drag handle promises: pull-down from the top edge
 * dismisses the sheet.
 *
 * Public API:
 *   enableBottomSheetDismiss(overlay, card, closeFn) -> cleanup()
 *
 * Behaviour:
 *   - No-op when `document.body` does NOT carry `is-mobile` (desktop bootstrap
 *     stays untouched — same modals render centered with no touch handlers).
 *   - Touch listeners are attached to the card itself, NOT a separate drag
 *     handle element, so we don't need to modify the modal builders. We only
 *     react to `touchstart` events whose Y coordinate falls in the top 48px
 *     of the card — below that, taps and scrolls pass through unmodified
 *     (the modal content is often itself scrollable; intercepting all touches
 *     would break that).
 *   - On `touchmove` we apply `card.style.transform = translateY(dy)` for
 *     `dy > 0` only (downward drags). Upward drags are ignored so the user
 *     can't push the sheet up past its anchor.
 *   - On `touchend` we either call `closeFn()` (if `dy > 80`) or reset the
 *     transform (otherwise). 80px is roughly the bottom-third of a 320px-wide
 *     thumb arc — high enough to avoid accidental dismissals while scrolling
 *     into the content area, low enough that a deliberate pull-down lands it.
 *
 * Cleanup: the returned function detaches the three touch listeners and is
 * idempotent (extra calls are no-ops). Callers should invoke it when the
 * modal closes so the listeners don't leak past the card's DOM lifetime.
 */

const DRAG_ZONE_PX = 48;
const DISMISS_THRESHOLD_PX = 80;

/**
 * Attach touch handlers to `card` so the user can pull it down to dismiss.
 *
 * @param {HTMLElement} overlay The overlay wrapper (kept for API symmetry with
 *   future enhancements like fading the backdrop during the drag; today the
 *   helper only reads it to find a viable host but does not mutate it).
 * @param {HTMLElement} card    The modal card element.
 * @param {() => void} closeFn  Invoked when the drag exceeds the threshold.
 * @returns {() => void} cleanup function — idempotent.
 */
export function enableBottomSheetDismiss(overlay, card, closeFn) {
  if (typeof document === 'undefined' || !document.body) {
    return () => {};
  }
  if (!document.body.classList.contains('is-mobile')) {
    // Desktop: helper is intentionally inert so the desktop bootstrap stays
    // identical to before the mobile launch. Callers don't need to branch.
    return () => {};
  }
  if (!(card instanceof HTMLElement) || typeof closeFn !== 'function') {
    return () => {};
  }

  let startY = null;
  let activeDy = 0;
  let cleaned = false;

  function onTouchStart(ev) {
    if (!ev.touches || ev.touches.length === 0) return;
    // Multi-finger gestures (pinch-to-zoom, two-finger pan) are NOT a drag
    // intent. Don't start tracking — the user is doing something else with
    // the card and we'd otherwise apply a transform off `touches[0]` that
    // wanders during the pinch.
    if (ev.touches.length > 1) {
      startY = null;
      return;
    }
    const touch = ev.touches[0];
    const rect = card.getBoundingClientRect();
    const relY = touch.clientY - rect.top;
    // Only initiate a drag if the touch lands inside the top drag-zone band.
    // Touches in the body of the modal must remain available for the modal's
    // own scroll / input handlers (otherwise long-press on a button or scroll
    // inside the order list would trigger dismissal — terrible UX).
    if (relY < 0 || relY > DRAG_ZONE_PX) {
      startY = null;
      return;
    }
    startY = touch.clientY;
    activeDy = 0;
  }

  function onTouchMove(ev) {
    if (startY === null) return;
    if (!ev.touches || ev.touches.length === 0) return;
    // Second finger lands mid-drag (pinch / two-finger pan started). Abort
    // the drag and snap the card back so the gesture doesn't accidentally
    // dismiss the modal.
    if (ev.touches.length > 1) {
      startY = null;
      activeDy = 0;
      card.style.transform = '';
      return;
    }
    const dy = ev.touches[0].clientY - startY;
    if (dy <= 0) {
      // Upward drags: keep the sheet anchored. (Resetting any prior downward
      // transform here matters if the user oscillates direction during a
      // single gesture — visually the sheet stays put rather than over-shooting
      // upward.)
      activeDy = 0;
      card.style.transform = '';
      return;
    }
    activeDy = dy;
    card.style.transform = `translateY(${dy}px)`;
  }

  function onTouchEnd() {
    if (startY === null) return;
    const dy = activeDy;
    startY = null;
    activeDy = 0;
    if (dy > DISMISS_THRESHOLD_PX) {
      // Caller is responsible for unmounting the overlay (calling close()
      // typically does that synchronously). We don't reset the transform —
      // leaving it in place avoids a visual snap-back if `closeFn` is async.
      try {
        closeFn();
      } catch {
        /* swallow — the close handler can't be allowed to leak through the
           touchend event into the browser's default handling. */
      }
      return;
    }
    // Below threshold — let the sheet spring back to its anchored position.
    card.style.transform = '';
  }

  card.addEventListener('touchstart', onTouchStart, { passive: true });
  card.addEventListener('touchmove', onTouchMove, { passive: true });
  card.addEventListener('touchend', onTouchEnd);
  card.addEventListener('touchcancel', onTouchEnd);

  return function cleanup() {
    if (cleaned) return;
    cleaned = true;
    card.removeEventListener('touchstart', onTouchStart);
    card.removeEventListener('touchmove', onTouchMove);
    card.removeEventListener('touchend', onTouchEnd);
    card.removeEventListener('touchcancel', onTouchEnd);
  };
}

// Internal constants exposed for tests.
export const __test = { DRAG_ZONE_PX, DISMISS_THRESHOLD_PX };
