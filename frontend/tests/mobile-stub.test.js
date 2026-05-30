// @vitest-environment happy-dom

import { describe, it, expect, beforeEach } from 'vitest';
import { isMobileViewport, MOBILE_BREAKPOINT_PX } from '../src/mobile-stub.js';

function setViewportWidth(px) {
  // happy-dom respects assignment to window.innerWidth.
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: px,
  });
}

describe('isMobileViewport', () => {
  it('returns true at common mobile widths (390 / 414 / 768)', () => {
    expect(isMobileViewport({ innerWidth: 390 })).toBe(true);
    expect(isMobileViewport({ innerWidth: 414 })).toBe(true);
    // iPad portrait — still below 1024 breakpoint, mobile layout owns it.
    expect(isMobileViewport({ innerWidth: 768 })).toBe(true);
  });

  it('returns false at the breakpoint and above (1024 / 1280 / 1920)', () => {
    // isMobileViewport is a pure viewport-width check. There is no longer a
    // desktop-without-provider guard: the old needsDesktopStub was removed, so
    // a wide viewport loads the full app regardless of window.ethereum
    // (wallet init is lazy via AppKit).
    expect(isMobileViewport({ innerWidth: MOBILE_BREAKPOINT_PX })).toBe(false);
    expect(isMobileViewport({ innerWidth: 1280 })).toBe(false);
    expect(isMobileViewport({ innerWidth: 1920 })).toBe(false);
    // Also false on a wide viewport even WITHOUT an injected provider.
    expect(isMobileViewport({ innerWidth: 1024 })).toBe(false);
    expect(isMobileViewport({ innerWidth: 1280 })).toBe(false);
  });

  it('reads from window when no override is supplied', () => {
    setViewportWidth(400);
    expect(isMobileViewport()).toBe(true);
    setViewportWidth(1440);
    expect(isMobileViewport()).toBe(false);
  });

  it('returns false in non-DOM environments (no window)', () => {
    expect(isMobileViewport({})).toBe(false);
  });
});

describe('bootstrap integration — mobile viewport mounts mobile layout', () => {
  // We import main.js dynamically per-test so the bootstrap() flow runs
  // against whatever viewport width we set first. main.js auto-runs bootstrap
  // when imported into a document whose readyState is not 'loading' (happy-dom
  // reports 'complete'), so the import itself is the trigger.
  beforeEach(() => {
    document.body.replaceChildren();
    const root = document.createElement('div');
    root.id = 'app';
    document.body.appendChild(root);
  });

  it('mounts ONLY the mobile shell when viewport is narrow (no wallet / layout init)', async () => {
    setViewportWidth(390);
    const { vi } = await import('vitest');
    vi.resetModules();
    const layoutMock = vi.fn();
    const walletInit = vi.fn();
    vi.doMock('../src/layout.js', () => ({ mountLayout: layoutMock }));
    vi.doMock('../src/sidebar.js', () => ({ mountSidebar: vi.fn() }));
    vi.doMock('../src/chart.js', () => ({ mountChart: vi.fn() }));
    vi.doMock('../src/components/bottom/index.js', () => ({ mountBottomTabs: vi.fn() }));
    vi.doMock('../src/trade-panel.js', () => ({ mountTradePanel: vi.fn() }));
    vi.doMock('../src/sse.js', () => ({ openStream: walletInit }));
    vi.doMock('../src/ui/wallet-chip.js', () => ({ mountWalletChip: vi.fn() }));
    vi.doMock('../src/wallet.js', () => ({
      onAccountChange: vi.fn(),
      getAccount: vi.fn(() => ({ address: null, isConnected: false })),
      tryAutoReconnect: vi.fn(async () => undefined),
      setSiweHooks: vi.fn(),
    }));
    vi.doMock('../src/api.js', () => ({
      ApiError: class extends Error {},
      getConfig: vi.fn(),
      getTokens: vi.fn(),
      getAccess: vi.fn(),
      getPortfolio: vi.fn(),
      logout: vi.fn(),
    }));
    vi.doMock('../src/referral.js', () => ({ bootstrapReferral: vi.fn(async () => {}) }));
    vi.doMock('../src/config-store.js', () => ({ merge: vi.fn() }));
    vi.doMock('../src/access-store.js', () => ({
      set: vi.fn(),
      get: vi.fn(() => 'unknown'),
      subscribe: vi.fn(() => () => {}),
      isPremium: vi.fn(() => false),
      isConnecting: vi.fn(() => false),
    }));
    vi.doMock('../src/profile.js', () => ({ mountProfile: vi.fn() }));
    vi.doMock('../src/access.js', () => ({ mountAccessBanner: vi.fn() }));
    vi.doMock('../src/soft-lock.js', () => ({ mountSoftLock: vi.fn() }));
    vi.doMock('../src/ui/toast.js', () => ({ showToast: vi.fn() }));
    vi.doMock('../src/resizable.js', () => ({ mountResizable: vi.fn() }));
    vi.doMock('../src/components/header-actions.js', () => ({ mountHeaderActions: vi.fn() }));
    vi.doMock('../src/styles.css', () => ({}), { virtual: true });
    vi.doMock('../src/styles/tokens.css', () => ({}), { virtual: true });
    vi.doMock('../src/styles/sidebar-batch3.css', () => ({}), { virtual: true });
    vi.doMock('../src/styles/sidebar-role.css', () => ({}), { virtual: true });
    vi.doMock('../src/styles/resizable.css', () => ({}), { virtual: true });
    vi.doMock('../src/styles/modals-batch7.css', () => ({}), { virtual: true });
    vi.doMock('../src/styles/trade-panel-batch5.css', () => ({}), { virtual: true });
    vi.doMock('../src/styles/mobile.css', () => ({}), { virtual: true });

    await import('../src/main.js');
    // bootstrap() is now async — let microtasks settle so the dynamic
    // import of mobile-layout.js resolves before we assert the DOM. We
    // poll on the DOM rather than guessing a fixed timeout so the test
    // is robust to slow module resolution under happy-dom.
    const deadline = Date.now() + 2000;
    while (!document.querySelector('[data-test-id="mobile-shell"]') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Mobile shell painted, no desktop wallet/sse/layout init.
    expect(document.querySelector('[data-test-id="mobile-shell"]')).not.toBeNull();
    expect(document.querySelector('[data-test-id="mobile-nav"]')).not.toBeNull();
    expect(document.querySelector('[data-test-id="mobile-stub"]')).toBeNull();
    expect(layoutMock).not.toHaveBeenCalled();
    expect(walletInit).not.toHaveBeenCalled();
    vi.resetModules();
  });
});
