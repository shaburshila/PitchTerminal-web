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
    expect(submit.textContent).toBe('Подписываем…');
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
});
