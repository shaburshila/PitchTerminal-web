// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  showOnboardingModal,
  maybeShowOnboarding,
  hasOnboarded,
  markOnboarded,
  __test,
} from '../src/onboarding.js';

const STORAGE_KEY = __test.STORAGE_KEY;

beforeEach(() => {
  document.body.replaceChildren();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
});

function getOverlay() {
  return document.querySelector('[data-test-id="onboarding-overlay"]');
}

describe('onboarding modal', () => {
  it('storage key is versioned as v1', () => {
    expect(STORAGE_KEY).toBe('pt:onboarded:v1');
  });

  it('renders the overlay, hero, both columns, disclaimer and CTA', () => {
    showOnboardingModal();
    expect(getOverlay()).not.toBeNull();
    expect(document.querySelector('[data-test-id="onboarding-modal"]')).not.toBeNull();
    expect(document.querySelector('[data-test-id="onboarding-free"]')).not.toBeNull();
    expect(document.querySelector('[data-test-id="onboarding-pro"]')).not.toBeNull();
    expect(document.querySelector('[data-test-id="onboarding-disclaimer"]')).not.toBeNull();
    expect(document.querySelector('[data-test-id="onboarding-cta"]')).not.toBeNull();
    expect(document.querySelector('[data-test-id="onboarding-close"]')).not.toBeNull();
    // Hero title carries the aria-labelledby target.
    const title = document.getElementById('pt-onb-title');
    expect(title?.textContent).toBe('Welcome to PitchTerminal');
  });

  it('sets dialog role + aria-modal + aria-labelledby for a11y', () => {
    showOnboardingModal();
    const card = document.querySelector('[data-test-id="onboarding-modal"]');
    expect(card.getAttribute('role')).toBe('dialog');
    expect(card.getAttribute('aria-modal')).toBe('true');
    expect(card.getAttribute('aria-labelledby')).toBe('pt-onb-title');
  });

  it('maybeShowOnboarding shows modal on first visit (no flag)', () => {
    expect(hasOnboarded()).toBe(false);
    maybeShowOnboarding();
    expect(getOverlay()).not.toBeNull();
  });

  it('maybeShowOnboarding is a no-op when flag is already set', () => {
    markOnboarded();
    expect(hasOnboarded()).toBe(true);
    const handle = maybeShowOnboarding();
    expect(handle).toBeNull();
    expect(getOverlay()).toBeNull();
  });

  it('clicking the CTA sets the flag and closes the modal', () => {
    showOnboardingModal();
    expect(getOverlay()).not.toBeNull();
    expect(hasOnboarded()).toBe(false);
    document.querySelector('[data-test-id="onboarding-cta"]').click();
    expect(getOverlay()).toBeNull();
    expect(hasOnboarded()).toBe(true);
  });

  it('clicking the close (✕) button sets the flag and closes the modal', () => {
    showOnboardingModal();
    document.querySelector('[data-test-id="onboarding-close"]').click();
    expect(getOverlay()).toBeNull();
    expect(hasOnboarded()).toBe(true);
  });

  it('Escape closes the modal and sets the flag', () => {
    showOnboardingModal();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(getOverlay()).toBeNull();
    expect(hasOnboarded()).toBe(true);
  });

  it('clicking outside the card (overlay backdrop) closes the modal', () => {
    showOnboardingModal();
    const overlay = getOverlay();
    // Simulate mousedown on the overlay itself (not on the inner card).
    const ev = new MouseEvent('mousedown', { bubbles: true });
    Object.defineProperty(ev, 'target', { value: overlay, configurable: true });
    overlay.dispatchEvent(ev);
    expect(getOverlay()).toBeNull();
    expect(hasOnboarded()).toBe(true);
  });

  it('forced re-open works after flag is set (Help button path)', () => {
    markOnboarded();
    // maybeShowOnboarding should NOT show…
    maybeShowOnboarding();
    expect(getOverlay()).toBeNull();
    // …but showOnboardingModal direct call (used by Help) SHOULD show.
    showOnboardingModal();
    expect(getOverlay()).not.toBeNull();
    // Flag stays set after open (only close re-asserts it).
    expect(hasOnboarded()).toBe(true);
  });

  it('Tab key cycles focus within the modal (forward wrap)', () => {
    showOnboardingModal();
    const close = document.querySelector('[data-test-id="onboarding-close"]');
    const cta = document.querySelector('[data-test-id="onboarding-cta"]');
    // Move focus to the last focusable element (CTA), then Tab → should wrap
    // to the first focusable (close button).
    cta.focus();
    expect(document.activeElement).toBe(cta);
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    expect(document.activeElement).toBe(close);
  });

  it('Shift+Tab cycles focus backwards within the modal', () => {
    showOnboardingModal();
    const close = document.querySelector('[data-test-id="onboarding-close"]');
    const cta = document.querySelector('[data-test-id="onboarding-cta"]');
    close.focus();
    expect(document.activeElement).toBe(close);
    const ev = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(ev);
    expect(document.activeElement).toBe(cta);
  });

  it('opening a second time replaces (does not stack) the existing overlay', () => {
    showOnboardingModal();
    showOnboardingModal();
    const overlays = document.querySelectorAll('[data-test-id="onboarding-overlay"]');
    expect(overlays.length).toBe(1);
  });

  it('returns a handle with close() that also sets the flag', () => {
    const handle = showOnboardingModal();
    expect(getOverlay()).not.toBeNull();
    handle.close();
    expect(getOverlay()).toBeNull();
    expect(hasOnboarded()).toBe(true);
  });
});
