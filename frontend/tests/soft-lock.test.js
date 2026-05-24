// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { mountSoftLock } from '../src/soft-lock.js';
import * as accessStore from '../src/access-store.js';

beforeEach(() => {
  accessStore._resetForTests();
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

function makeTarget() {
  const t = document.createElement('div');
  t.dataset.testId = 'target';
  const content = document.createElement('p');
  content.textContent = 'Premium content';
  content.dataset.testId = 'content';
  t.appendChild(content);
  document.body.appendChild(t);
  return t;
}

describe('mountSoftLock', () => {
  it('throws when target is not an HTMLElement', () => {
    expect(() => mountSoftLock(null)).toThrow(TypeError);
    expect(() => mountSoftLock({})).toThrow(TypeError);
  });

  it('renders overlay + blur class in default "unknown" state', () => {
    const target = makeTarget();
    const handle = mountSoftLock(target);
    expect(target.classList.contains('pt-soft-locked')).toBe(true);
    const overlay = target.querySelector('[data-test-id="soft-lock"]');
    expect(overlay).toBeTruthy();
    expect(overlay.querySelector('[data-test-id="soft-lock-pay"]')).toBeTruthy();
    expect(handle.isLocked()).toBe(true);
  });

  it('renders lock for anon and free states', () => {
    const target = makeTarget();
    mountSoftLock(target);
    accessStore.set('anon');
    expect(target.classList.contains('pt-soft-locked')).toBe(true);
    expect(target.querySelector('[data-test-id="soft-lock"]')).toBeTruthy();

    accessStore.set('free');
    expect(target.classList.contains('pt-soft-locked')).toBe(true);
    expect(target.querySelector('[data-test-id="soft-lock"]')).toBeTruthy();
  });

  it('hides overlay + blur when state flips to premium', () => {
    const target = makeTarget();
    mountSoftLock(target);
    expect(target.classList.contains('pt-soft-locked')).toBe(true);

    accessStore.set('premium');
    expect(target.classList.contains('pt-soft-locked')).toBe(false);
    // Overlay stays mounted (build-once strategy) but is hidden via `hidden`.
    const overlay = target.querySelector('[data-test-id="soft-lock"]');
    expect(overlay).toBeTruthy();
    expect(overlay.hidden).toBe(true);
  });

  it('re-shows overlay when state flips back from premium', () => {
    const target = makeTarget();
    mountSoftLock(target);
    accessStore.set('premium');
    const overlayWhenPremium = target.querySelector('[data-test-id="soft-lock"]');
    expect(overlayWhenPremium.hidden).toBe(true);

    accessStore.set('free');
    expect(target.classList.contains('pt-soft-locked')).toBe(true);
    const overlay = target.querySelector('[data-test-id="soft-lock"]');
    expect(overlay).toBeTruthy();
    expect(overlay.hidden).toBe(false);
  });

  it('overlay stays in DOM across lock/unlock toggles (build-once)', () => {
    const target = makeTarget();
    mountSoftLock(target);
    const overlayInitial = target.querySelector('[data-test-id="soft-lock"]');
    accessStore.set('premium');
    accessStore.set('free');
    accessStore.set('premium');
    const overlayAfter = target.querySelector('[data-test-id="soft-lock"]');
    // Same node identity — toggled via `hidden`, never detached.
    expect(overlayAfter).toBe(overlayInitial);
  });

  it('invokes injected openPayModal on Pay click', () => {
    const target = makeTarget();
    const openPayModal = vi.fn();
    mountSoftLock(target, { openPayModal, payOpts: { foo: 'bar' } });
    const payBtn = target.querySelector('[data-test-id="soft-lock-pay"]');
    expect(payBtn).toBeTruthy();
    payBtn.click();
    expect(openPayModal).toHaveBeenCalledTimes(1);
    expect(openPayModal).toHaveBeenCalledWith({ foo: 'bar' });
  });

  it('swallows openPayModal errors so the click handler does not bubble', () => {
    const target = makeTarget();
    const openPayModal = vi.fn(() => { throw new Error('boom'); });
    mountSoftLock(target, { openPayModal });
    const payBtn = target.querySelector('[data-test-id="soft-lock-pay"]');
    expect(() => payBtn.click()).not.toThrow();
  });

  it('uses custom label + buttonText when provided', () => {
    const target = makeTarget();
    mountSoftLock(target, { label: 'Custom label', buttonText: 'Pay now' });
    const label = target.querySelector('[data-test-id="soft-lock-label"]');
    const btn = target.querySelector('[data-test-id="soft-lock-pay"]');
    expect(label.textContent).toBe('Custom label');
    expect(btn.textContent).toBe('Pay now');
  });

  it('sets data-zone on overlay when zone option is passed', () => {
    const target = makeTarget();
    mountSoftLock(target, { zone: 'right' });
    const overlay = target.querySelector('[data-test-id="soft-lock"]');
    expect(overlay.dataset.zone).toBe('right');
  });

  it('destroy() removes overlay, blur, and stops reacting to state changes', () => {
    const target = makeTarget();
    const handle = mountSoftLock(target);
    handle.destroy();
    expect(target.classList.contains('pt-soft-locked')).toBe(false);
    expect(target.querySelector('[data-test-id="soft-lock"]')).toBeFalsy();

    // After destroy, state changes must not re-apply the overlay.
    accessStore.set('free');
    expect(target.classList.contains('pt-soft-locked')).toBe(false);
    expect(target.querySelector('[data-test-id="soft-lock"]')).toBeFalsy();
  });

  it('replaces a stale overlay on the same target', () => {
    const target = makeTarget();
    const first = mountSoftLock(target);
    expect(target.querySelectorAll('[data-test-id="soft-lock"]').length).toBe(1);
    // Don't destroy — simulate a re-mount on the same target.
    mountSoftLock(target);
    // Still exactly one overlay (the new one).
    expect(target.querySelectorAll('[data-test-id="soft-lock"]').length).toBe(1);
    // Old handle's destroy should be safe to call after re-mount.
    expect(() => first.destroy()).not.toThrow();
  });

  it('honours custom isLocked predicate', () => {
    const target = makeTarget();
    const isLocked = vi.fn((s) => s === 'free'); // lock ONLY in free, not anon/unknown
    mountSoftLock(target, { isLocked });
    // unknown → not locked per custom predicate
    expect(target.classList.contains('pt-soft-locked')).toBe(false);
    accessStore.set('free');
    expect(target.classList.contains('pt-soft-locked')).toBe(true);
    accessStore.set('premium');
    expect(target.classList.contains('pt-soft-locked')).toBe(false);
  });

  it('fires onStateChange on every render', () => {
    const target = makeTarget();
    const onStateChange = vi.fn();
    mountSoftLock(target, { onStateChange });
    // Initial apply fires.
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenLastCalledWith('unknown');
    accessStore.set('premium');
    expect(onStateChange).toHaveBeenLastCalledWith('premium');
  });
});

describe('accessStore', () => {
  it('starts in "unknown"', () => {
    expect(accessStore.get()).toBe('unknown');
    expect(accessStore.isPremium()).toBe(false);
  });

  it('isPremium() is true only for "premium"', () => {
    accessStore.set('anon');
    expect(accessStore.isPremium()).toBe(false);
    accessStore.set('free');
    expect(accessStore.isPremium()).toBe(false);
    accessStore.set('premium');
    expect(accessStore.isPremium()).toBe(true);
  });

  it('ignores invalid states', () => {
    accessStore.set('garbage');
    expect(accessStore.get()).toBe('unknown');
  });

  it('does not notify on no-op set', () => {
    const listener = vi.fn();
    accessStore.subscribe(listener);
    accessStore.set('unknown'); // same as initial
    expect(listener).not.toHaveBeenCalled();
    accessStore.set('free');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('subscribe returns unsubscribe', () => {
    const listener = vi.fn();
    const off = accessStore.subscribe(listener);
    accessStore.set('free');
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    accessStore.set('premium');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
