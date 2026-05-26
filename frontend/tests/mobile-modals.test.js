// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { enableBottomSheetDismiss } from '../src/mobile-modals.js';

/**
 * Build an overlay + card pair that mirrors the structure access.js / siwe
 * modals produce. The card's bounding rect is mocked so the test can place
 * touch points anywhere relative to it without depending on the (non-)layout
 * happy-dom performs.
 */
function buildOverlayCard({ cardTop = 0, cardHeight = 400 } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'pt-modal-overlay';
  const card = document.createElement('div');
  card.className = 'pt-modal';
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  // happy-dom returns zeros for getBoundingClientRect; stub it.
  card.getBoundingClientRect = () => ({
    top: cardTop,
    bottom: cardTop + cardHeight,
    left: 0,
    right: 360,
    width: 360,
    height: cardHeight,
    x: 0,
    y: cardTop,
    toJSON() {},
  });
  return { overlay, card };
}

function fireTouch(card, type, clientY) {
  const ev = new Event(type, { bubbles: true });
  // happy-dom Event doesn't expose `touches` by default; assign manually.
  ev.touches = [{ clientX: 100, clientY }];
  card.dispatchEvent(ev);
}

function fireMultiTouch(card, type, clientYs) {
  const ev = new Event(type, { bubbles: true });
  ev.touches = clientYs.map((y) => ({ clientX: 100, clientY: y }));
  card.dispatchEvent(ev);
}

describe('enableBottomSheetDismiss', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.body.className = '';
  });

  it('is a no-op when body.is-mobile is absent (desktop unaffected)', () => {
    const { overlay, card } = buildOverlayCard();
    const close = vi.fn();
    const cleanup = enableBottomSheetDismiss(overlay, card, close);
    fireTouch(card, 'touchstart', 10);
    fireTouch(card, 'touchmove', 200);
    fireTouch(card, 'touchend', 300);
    expect(close).not.toHaveBeenCalled();
    expect(card.style.transform).toBe('');
    expect(typeof cleanup).toBe('function');
  });

  it('drag down > 80px calls closeFn when body.is-mobile is present', () => {
    document.body.classList.add('is-mobile');
    const { overlay, card } = buildOverlayCard();
    const close = vi.fn();
    enableBottomSheetDismiss(overlay, card, close);
    // Touch starts inside the drag zone (y=10), then moves 120px down.
    fireTouch(card, 'touchstart', 10);
    fireTouch(card, 'touchmove', 130);
    fireTouch(card, 'touchend', 130);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('drag down < 80px resets transform and does not close', () => {
    document.body.classList.add('is-mobile');
    const { overlay, card } = buildOverlayCard();
    const close = vi.fn();
    enableBottomSheetDismiss(overlay, card, close);
    fireTouch(card, 'touchstart', 10);
    fireTouch(card, 'touchmove', 50); // dy = 40
    fireTouch(card, 'touchend', 50);
    expect(close).not.toHaveBeenCalled();
    expect(card.style.transform).toBe('');
  });

  it('touch outside the top 48px drag zone applies no transform and does not close', () => {
    document.body.classList.add('is-mobile');
    const { overlay, card } = buildOverlayCard();
    const close = vi.fn();
    enableBottomSheetDismiss(overlay, card, close);
    // Touch starts at y=100, which is below the 48px drag-zone band.
    fireTouch(card, 'touchstart', 100);
    fireTouch(card, 'touchmove', 250); // would be 150px drag if armed
    fireTouch(card, 'touchend', 250);
    expect(close).not.toHaveBeenCalled();
    expect(card.style.transform).toBe('');
  });

  it('upward drag does not push the sheet up (transform stays empty)', () => {
    document.body.classList.add('is-mobile');
    const { overlay, card } = buildOverlayCard();
    const close = vi.fn();
    enableBottomSheetDismiss(overlay, card, close);
    fireTouch(card, 'touchstart', 30);
    fireTouch(card, 'touchmove', 10); // dy = -20
    fireTouch(card, 'touchend', 10);
    expect(close).not.toHaveBeenCalled();
    expect(card.style.transform).toBe('');
  });


  it('multi-finger touchstart does NOT arm the drag (pinch-to-zoom intent)', () => {
    document.body.classList.add('is-mobile');
    const { overlay, card } = buildOverlayCard();
    const close = vi.fn();
    enableBottomSheetDismiss(overlay, card, close);
    // Two fingers land at once — the user is pinching, not dragging.
    fireMultiTouch(card, 'touchstart', [20, 40]);
    fireTouch(card, 'touchmove', 200);
    fireTouch(card, 'touchend', 250);
    expect(close).not.toHaveBeenCalled();
    expect(card.style.transform).toBe('');
  });

  it('a second finger landing mid-drag aborts the drag and snaps the card back', () => {
    document.body.classList.add('is-mobile');
    const { overlay, card } = buildOverlayCard();
    const close = vi.fn();
    enableBottomSheetDismiss(overlay, card, close);
    // Single-finger drag begins inside the drag zone…
    fireTouch(card, 'touchstart', 20);
    fireTouch(card, 'touchmove', 60); // dy = 40 — sheet has translated
    expect(card.style.transform).toBe('translateY(40px)');
    // …a second finger lands. Pinch in progress — abort.
    fireMultiTouch(card, 'touchmove', [60, 100]);
    expect(card.style.transform).toBe('');
    // Continued movement should not advance the (aborted) drag, and touchend
    // must not trigger dismiss — startY was cleared.
    fireTouch(card, 'touchmove', 200);
    fireTouch(card, 'touchend', 250);
    expect(close).not.toHaveBeenCalled();
    expect(card.style.transform).toBe('');
  });

  it('multiple cleanup calls are idempotent', () => {
    document.body.classList.add('is-mobile');
    const { overlay, card } = buildOverlayCard();
    const close = vi.fn();
    const cleanup = enableBottomSheetDismiss(overlay, card, close);
    cleanup();
    cleanup();
    // After cleanup, drag-to-dismiss should be inert.
    fireTouch(card, 'touchstart', 10);
    fireTouch(card, 'touchmove', 200);
    fireTouch(card, 'touchend', 200);
    expect(close).not.toHaveBeenCalled();
  });
});
