// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mock wallet.js — we mock the surface the modal touches:
//   - `loadWcProvider` returns a fake EventEmitter-shaped provider.
//   - `setWcConnected` is a spy so tests can assert the modal pushes state
//     into wallet.js (the bug that the chip stayed disconnected on a
//     successful mobile connect).
//
// The fake provider stores handlers as `Map<event, Set<handler>>` so the
// test can verify that `off(event, handler)` is called with the EXACT
// handler reference the modal registered. Real `@walletconnect/ethereum-
// provider` requires the same reference on removal; a mock that ignores
// the second argument would silently let regressions through.
const providerState = {
  handlers: new Map(),
  connectImpl: vi.fn(async () => null),
  provider: null,
  // Helpers for tests:
  emit(event, payload) {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(payload);
      } catch {
        // swallow — tests can still inspect side-effects
      }
    }
  },
  countHandlers(event) {
    return this.handlers.get(event)?.size ?? 0;
  },
};

function makeProvider() {
  providerState.handlers = new Map();
  // Default WC-shaped fields so setWcConnected has something to read.
  const provider = {
    accounts: [],
    chainId: 8453,
    on(event, cb) {
      let set = providerState.handlers.get(event);
      if (!set) {
        set = new Set();
        providerState.handlers.set(event, set);
      }
      set.add(cb);
    },
    off(event, cb) {
      const set = providerState.handlers.get(event);
      if (!set) return;
      // If no handler given, drop all (matches WC v2 fallback behavior).
      if (typeof cb !== 'function') set.clear();
      else set.delete(cb);
      if (set.size === 0) providerState.handlers.delete(event);
    },
    removeListener(event, cb) {
      provider.off(event, cb);
    },
    connect: providerState.connectImpl,
  };
  providerState.provider = provider;
  return provider;
}

const loadWcProvider = vi.fn(async () => makeProvider());
const setWcConnected = vi.fn();

vi.mock('../src/wallet.js', () => ({
  loadWcProvider,
  setWcConnected,
}));

const { openWcMobileModal } = await import('../src/ui/wallet-connect-modal.js');
const { MOBILE_WALLETS } = await import('../src/wallet-deep-links.js');

beforeEach(() => {
  document.body.replaceChildren();
  providerState.handlers = new Map();
  providerState.connectImpl = vi.fn(async () => null);
  providerState.provider = null;
  loadWcProvider.mockClear();
  loadWcProvider.mockImplementation(async () => makeProvider());
  setWcConnected.mockClear();
});

async function flush() {
  // Multiple microtask flushes to let the async IIFE inside the modal
  // resolve all the way through `await provider.connect()`.
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe('openWcMobileModal — mount', () => {
  it('mounts the overlay with the wc-mobile-modal test-id', () => {
    openWcMobileModal({});
    expect(document.querySelector('[data-test-id="wc-mobile-modal"]')).not.toBeNull();
    const status = document.querySelector('[data-test-id="wc-mobile-status"]');
    expect(status).not.toBeNull();
    expect(status.textContent).toMatch(/Preparing/i);
    // List is hidden until display_uri arrives.
    const list = document.querySelector('[data-test-id="wc-mobile-list"]');
    expect(list.hidden).toBe(true);
  });

  it('calls loadWcProvider with showQrModal: false', async () => {
    openWcMobileModal({});
    await flush();
    expect(loadWcProvider).toHaveBeenCalledWith({ showQrModal: false });
  });

  it('renders one wallet row per MOBILE_WALLETS entry on display_uri', async () => {
    openWcMobileModal({});
    await flush();
    providerState.emit('display_uri', 'wc:test123@2?relay-protocol=irn&symKey=abc');
    const list = document.querySelector('[data-test-id="wc-mobile-list"]');
    expect(list.hidden).toBe(false);
    const links = list.querySelectorAll('a');
    expect(links.length).toBe(MOBILE_WALLETS.length);
    // Each link must have an encoded `wc:` URI in its href.
    for (const link of links) {
      expect(link.getAttribute('href')).toMatch(/wc%3A|okx%3A%2F%2F/);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });
});

describe('openWcMobileModal — accountsChanged', () => {
  it('invokes onConnected with the lowercase address and removes the overlay', async () => {
    const onConnected = vi.fn();
    openWcMobileModal({ onConnected });
    await flush();
    providerState.emit('display_uri', 'wc:abc');
    providerState.emit('accountsChanged', ['0xDEADBEEF00000000000000000000000000000001']);
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onConnected).toHaveBeenCalledWith('0xdeadbeef00000000000000000000000000000001');
    expect(document.querySelector('[data-test-id="wc-mobile-modal"]')).toBeNull();
  });

  it('ignores empty accountsChanged payloads', async () => {
    const onConnected = vi.fn();
    openWcMobileModal({ onConnected });
    await flush();
    providerState.emit('display_uri', 'wc:abc');
    providerState.emit('accountsChanged', []);
    expect(onConnected).not.toHaveBeenCalled();
    // Modal stays open.
    expect(document.querySelector('[data-test-id="wc-mobile-modal"]')).not.toBeNull();
  });
});

describe('openWcMobileModal — cancel paths', () => {
  it('Cancel button calls onCancel and removes the overlay', async () => {
    const onCancel = vi.fn();
    openWcMobileModal({ onCancel });
    await flush();
    const cancel = document.querySelector('[data-test-id="wc-mobile-cancel"]');
    cancel.click();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-test-id="wc-mobile-modal"]')).toBeNull();
  });

  it('Backdrop click closes the modal and calls onCancel', async () => {
    const onCancel = vi.fn();
    openWcMobileModal({ onCancel });
    await flush();
    const overlay = document.querySelector('[data-test-id="wc-mobile-modal"]');
    // Simulate a click whose target is the overlay itself (not the card).
    overlay.dispatchEvent(new Event('click', { bubbles: false }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-test-id="wc-mobile-modal"]')).toBeNull();
  });

  it('Click inside the card does NOT close the modal', async () => {
    const onCancel = vi.fn();
    openWcMobileModal({ onCancel });
    await flush();
    const status = document.querySelector('[data-test-id="wc-mobile-status"]');
    status.click(); // bubbles to overlay but ev.target !== overlay
    expect(onCancel).not.toHaveBeenCalled();
    expect(document.querySelector('[data-test-id="wc-mobile-modal"]')).not.toBeNull();
  });
});

describe('openWcMobileModal — idempotency', () => {
  it('multiple close() calls are no-ops', async () => {
    const handle = openWcMobileModal({});
    await flush();
    handle.close();
    expect(document.querySelector('[data-test-id="wc-mobile-modal"]')).toBeNull();
    // Second close — should not throw.
    expect(() => handle.close()).not.toThrow();
  });

  it('close() removes the overlay even before display_uri arrives', () => {
    const handle = openWcMobileModal({});
    handle.close();
    expect(document.querySelector('[data-test-id="wc-mobile-modal"]')).toBeNull();
  });
});

describe('openWcMobileModal — wallet tap (pending state)', () => {
  it('tapping a wallet row flips the list to is-pending', async () => {
    openWcMobileModal({});
    await flush();
    providerState.emit('display_uri', 'wc:abc');
    const list = document.querySelector('[data-test-id="wc-mobile-list"]');
    const firstLink = list.querySelector('a');
    expect(firstLink).not.toBeNull();
    // Suppress real navigation in happy-dom.
    firstLink.addEventListener('click', (ev) => ev.preventDefault());
    firstLink.click();
    expect(list.classList.contains('is-pending')).toBe(true);
  });

  it('clears is-pending and surfaces a "Try again" status after the 30s timeout', async () => {
    vi.useFakeTimers();
    try {
      openWcMobileModal({});
      // Resolve the async loadWcProvider/connect chain under fake timers.
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      providerState.emit('display_uri', 'wc:abc');
      const list = document.querySelector('[data-test-id="wc-mobile-list"]');
      const firstLink = list.querySelector('a');
      firstLink.addEventListener('click', (ev) => ev.preventDefault());
      firstLink.click();
      expect(list.classList.contains('is-pending')).toBe(true);
      // Just before the deadline — still pending.
      await vi.advanceTimersByTimeAsync(29_999);
      expect(list.classList.contains('is-pending')).toBe(true);
      // Crossing the 30s threshold flips to the recovery state.
      await vi.advanceTimersByTimeAsync(2);
      expect(list.classList.contains('is-pending')).toBe(false);
      const status = document.querySelector('[data-test-id="wc-mobile-status"]');
      expect(status.textContent).toMatch(/try again|did not respond/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('openWcMobileModal — state pushed into wallet.js', () => {
  it('calls setWcConnected(provider) before onConnected fires', async () => {
    const onConnected = vi.fn(() => {
      // setWcConnected must have run by the time onConnected sees the addr,
      // because downstream listeners on wallet.js's account-store rely on it.
      expect(setWcConnected).toHaveBeenCalledTimes(1);
      expect(setWcConnected).toHaveBeenCalledWith(providerState.provider);
    });
    openWcMobileModal({ onConnected });
    await flush();
    providerState.provider.accounts = ['0xDEADBEEF00000000000000000000000000000001'];
    providerState.emit('accountsChanged', providerState.provider.accounts);
    expect(onConnected).toHaveBeenCalledTimes(1);
  });
});

describe('openWcMobileModal — listener cleanup', () => {
  it('removes provider listeners on close — by exact handler reference', async () => {
    const handle = openWcMobileModal({});
    await flush();
    // Modal registered display_uri + accountsChanged.
    expect(providerState.countHandlers('display_uri')).toBe(1);
    expect(providerState.countHandlers('accountsChanged')).toBe(1);
    handle.close();
    // Both must be gone. If the modal passed null/wrong-ref to off(), the
    // mock's Set-based store would still have the entry — this test would
    // catch that regression.
    expect(providerState.countHandlers('display_uri')).toBe(0);
    expect(providerState.countHandlers('accountsChanged')).toBe(0);
  });
});
