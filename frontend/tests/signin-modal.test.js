// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// signin-modal imports `signIn` from `../siwe.js` at module load — mock it.
vi.mock('../src/siwe.js', () => ({
  signIn: vi.fn(async () => ({ address: '0xfeed' })),
}));

const { showSignInModal } = await import('../src/ui/signin-modal.js');

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  vi.clearAllMocks();
});

function getOverlay() {
  return document.querySelector('[data-test-id="signin-overlay"]');
}

describe('signin-modal', () => {
  it('renders the overlay and CTAs', () => {
    const handle = showSignInModal({});
    expect(getOverlay()).not.toBeNull();
    expect(document.querySelector('[data-test-id="signin-submit"]')).not.toBeNull();
    expect(document.querySelector('[data-test-id="signin-cancel"]')).not.toBeNull();
    handle.close();
    expect(getOverlay()).toBeNull();
  });

  it('renders batch-7 redesign chrome (brand-mark, preview, net-row)', () => {
    showSignInModal({});
    // Brand-mark + redesigned title.
    expect(document.querySelector('.pt-modal__brand-mark')).not.toBeNull();
    expect(document.querySelector('[data-test-id="signin-preview"]')).not.toBeNull();
    expect(document.querySelector('[data-test-id="signin-net"]')).not.toBeNull();
    // Default CTA copy updated to "Sign with wallet".
    const submit = document.querySelector('[data-test-id="signin-submit"]');
    expect(submit.textContent).toBe('Sign with wallet');
    const cancel = document.querySelector('[data-test-id="signin-cancel"]');
    expect(cancel.textContent).toBe('Cancel');
  });

  it('calls injected signIn and invokes onSuccess on success', async () => {
    const fakeSignIn = vi.fn(async () => ({ address: '0xfeed' }));
    const onSuccess = vi.fn();
    showSignInModal({ signIn: fakeSignIn, onSuccess });
    const submit = document.querySelector('[data-test-id="signin-submit"]');
    submit.click();
    // Let the microtask queue drain.
    await Promise.resolve();
    await Promise.resolve();
    expect(fakeSignIn).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith({ address: '0xfeed' });
    expect(getOverlay()).toBeNull();
  });

  it('keeps the modal open and disables submit while signing', async () => {
    let resolveSignIn;
    const fakeSignIn = vi.fn(
      () => new Promise((res) => { resolveSignIn = res; })
    );
    showSignInModal({ signIn: fakeSignIn });
    const submit = document.querySelector('[data-test-id="signin-submit"]');
    submit.click();
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toBe('Signing…');
    resolveSignIn({ address: '0x1' });
    await Promise.resolve();
    await Promise.resolve();
    expect(getOverlay()).toBeNull();
  });

  it('shows a toast and stays open on signIn failure', async () => {
    const fakeSignIn = vi.fn(async () => {
      throw Object.assign(new Error('User rejected'), { code: 4001 });
    });
    showSignInModal({ signIn: fakeSignIn });
    document.querySelector('[data-test-id="signin-submit"]').click();
    await Promise.resolve();
    await Promise.resolve();
    // Modal still here, re-enabled for retry.
    expect(getOverlay()).not.toBeNull();
    const submit = document.querySelector('[data-test-id="signin-submit"]');
    expect(submit.disabled).toBe(false);
    // Toast appeared with the wallet's message.
    const toast = document.querySelector('[data-test-id="toast"]');
    expect(toast).not.toBeNull();
    expect(toast.textContent).toBe('User rejected');
  });

  it('cancel button closes the modal and fires onCancel', () => {
    const onCancel = vi.fn();
    showSignInModal({ onCancel });
    document.querySelector('[data-test-id="signin-cancel"]').click();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(getOverlay()).toBeNull();
  });

  it('Escape key closes the modal', () => {
    showSignInModal({});
    const ev = new KeyboardEvent('keydown', { key: 'Escape' });
    document.dispatchEvent(ev);
    expect(getOverlay()).toBeNull();
  });

  it('second showSignInModal replaces the first', () => {
    showSignInModal({});
    const first = getOverlay();
    showSignInModal({});
    const second = getOverlay();
    expect(first).not.toBe(second);
    // Only one overlay alive.
    expect(document.querySelectorAll('[data-test-id="signin-overlay"]').length).toBe(1);
  });

  // Mobile race fix (2026-05-27): on iOS Safari the second WC RPC
  // (personal_sign) doesn't auto-foreground the wallet app. The modal
  // surfaces an "Open wallet app" CTA so the user can manually re-trigger.
  describe('mobile "Open wallet app" CTA', () => {
    it('renders the CTA but keeps it hidden by default', () => {
      showSignInModal({});
      const hint = document.querySelector('[data-test-id="signin-mobile-hint"]');
      const openBtn = document.querySelector('[data-test-id="signin-open-wallet"]');
      expect(hint).not.toBeNull();
      expect(openBtn).not.toBeNull();
      // Hidden initially — only revealed after Sign tap on mobile UA.
      expect(hint.hidden).toBe(true);
    });

    it('open-wallet click toasts a generic instruction when no wallet id is cached', () => {
      try {
        localStorage.removeItem('pt:lastWalletId');
      } catch {
        /* ignore */
      }
      showSignInModal({});
      document.querySelector('[data-test-id="signin-open-wallet"]').click();
      // Toast surfaces the manual switch instruction.
      const toast = document.querySelector('[data-test-id="toast"]');
      expect(toast).not.toBeNull();
      expect(toast.textContent).toMatch(/wallet app/i);
    });
  });

  // B5 — Focus trap (WCAG 2.4.3 + 2.1.2). Tab must cycle within the overlay
  // so keyboard users can't reach the dim background app while the modal is
  // open. Focus also restores to the element that opened the modal on close.
  describe('focus trap (B5)', () => {
    function dispatchTab(shift = false) {
      const ev = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: shift,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(ev);
      return ev;
    }

    it('Tab from the last focusable wraps to the first', () => {
      showSignInModal({});
      const submit = document.querySelector('[data-test-id="signin-submit"]');
      const cancel = document.querySelector('[data-test-id="signin-cancel"]');
      // Modal opens with submit focused. Move focus to last (submit comes
      // AFTER cancel in DOM order — submit is `last`).
      submit.focus();
      expect(document.activeElement).toBe(submit);
      const ev = dispatchTab(false);
      expect(ev.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(cancel);
    });

    it('Shift+Tab from the first focusable wraps to the last', () => {
      showSignInModal({});
      const submit = document.querySelector('[data-test-id="signin-submit"]');
      const cancel = document.querySelector('[data-test-id="signin-cancel"]');
      cancel.focus();
      expect(document.activeElement).toBe(cancel);
      const ev = dispatchTab(true);
      expect(ev.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(submit);
    });

    it('Tab from outside the overlay snaps back to the first focusable', () => {
      // External trigger button — simulate focus leaking out (e.g. click on
      // the dimmed background app).
      const extern = document.createElement('button');
      document.body.appendChild(extern);
      showSignInModal({});
      extern.focus();
      expect(document.activeElement).toBe(extern);
      const ev = dispatchTab(false);
      expect(ev.defaultPrevented).toBe(true);
      const cancel = document.querySelector('[data-test-id="signin-cancel"]');
      // First focusable in DOM order is cancel.
      expect(document.activeElement).toBe(cancel);
    });

    it('restores focus to the opener element when closed', () => {
      const trigger = document.createElement('button');
      document.body.appendChild(trigger);
      trigger.focus();
      expect(document.activeElement).toBe(trigger);
      const handle = showSignInModal({});
      handle.close();
      expect(document.activeElement).toBe(trigger);
    });
  });
});
