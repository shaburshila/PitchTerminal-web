// @vitest-environment happy-dom

import { describe, it, expect, beforeEach } from 'vitest';
import { isMobileViewport, mountMobileStub, MOBILE_BREAKPOINT_PX } from '../src/mobile-stub.js';

function setViewportWidth(px) {
  // happy-dom respects assignment to window.innerWidth.
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: px,
  });
}

// Desktop-shaped mock: wide viewport + an injected provider present.
const DESKTOP = (innerWidth) => ({ innerWidth, ethereum: {} });

describe('isMobileViewport', () => {
  it('returns true at common mobile widths (390 / 414 / 768)', () => {
    expect(isMobileViewport({ innerWidth: 390, ethereum: {} })).toBe(true);
    expect(isMobileViewport({ innerWidth: 414, ethereum: {} })).toBe(true);
    // iPad portrait — intentionally falls into the stub bucket.
    expect(isMobileViewport({ innerWidth: 768, ethereum: {} })).toBe(true);
  });

  it('returns false at the breakpoint and above (1024 / 1280 / 1920) when a provider is injected', () => {
    expect(isMobileViewport(DESKTOP(MOBILE_BREAKPOINT_PX))).toBe(false);
    expect(isMobileViewport(DESKTOP(1280))).toBe(false);
    expect(isMobileViewport(DESKTOP(1920))).toBe(false);
  });

  it('returns true on wide viewports without an injected provider (tablet / Chromebook)', () => {
    // iPad landscape / Android tablet / desktop Chromebook with no extension
    // wallet — falls into the stub bucket so the wagmi "Provider not found"
    // banner doesn't surface.
    expect(isMobileViewport({ innerWidth: 1024 })).toBe(true);
    expect(isMobileViewport({ innerWidth: 1280 })).toBe(true);
  });

  it('reads from window when no override is supplied', () => {
    setViewportWidth(400);
    expect(isMobileViewport()).toBe(true);
    setViewportWidth(1440);
    // happy-dom has no `window.ethereum`, so a wide viewport alone still
    // routes to the stub. Inject one to assert the desktop path.
    window.ethereum = {};
    try {
      expect(isMobileViewport()).toBe(false);
    } finally {
      delete window.ethereum;
    }
  });

  it('returns false in non-DOM environments (no window)', () => {
    expect(isMobileViewport({})).toBe(false);
  });
});

describe('mountMobileStub', () => {
  let root;
  beforeEach(() => {
    document.body.replaceChildren();
    root = document.createElement('div');
    root.id = 'app';
    document.body.appendChild(root);
  });

  it('renders the stub overlay with brand + lead + "coming soon" pill', () => {
    mountMobileStub(root);
    const overlay = root.querySelector('[data-test-id="mobile-stub"]');
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toContain('PitchTerminal');
    expect(overlay.textContent).toContain('Desktop-only');
    expect(overlay.textContent).toContain('MetaMask');
    const soon = root.querySelector('[data-test-id="mobile-stub-soon"]');
    expect(soon).not.toBeNull();
    expect(soon.textContent).toMatch(/coming soon/i);
  });

  it('replaces any existing children of root (no broken UI underneath)', () => {
    const stale = document.createElement('div');
    stale.dataset.testId = 'stale-content';
    root.appendChild(stale);
    mountMobileStub(root);
    expect(root.querySelector('[data-test-id="stale-content"]')).toBeNull();
    expect(root.querySelector('[data-test-id="mobile-stub"]')).not.toBeNull();
  });

  it('exposes a copy-link button (best-effort clipboard, no error on missing API)', () => {
    mountMobileStub(root);
    const copy = root.querySelector('[data-test-id="mobile-stub-copy"]');
    expect(copy).not.toBeNull();
    expect(copy.tagName).toBe('BUTTON');
    expect(() => copy.click()).not.toThrow();
  });

  it('destroy() removes the overlay', () => {
    const handle = mountMobileStub(root);
    expect(root.querySelector('[data-test-id="mobile-stub"]')).not.toBeNull();
    handle.destroy();
    expect(root.querySelector('[data-test-id="mobile-stub"]')).toBeNull();
  });

  it('throws TypeError when root is not an HTMLElement', () => {
    expect(() => mountMobileStub(null)).toThrow(TypeError);
    expect(() => mountMobileStub('not-an-element')).toThrow(TypeError);
  });
});

describe('bootstrap integration — wagmi suppression on mobile', () => {
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

  it('mounts ONLY the mobile stub when viewport is narrow (no wallet / layout init)', async () => {
    setViewportWidth(390);
    // Stub every heavy import so a stray bootstrap branch can't accidentally
    // touch the real wagmi / SSE code. If the mobile-guard works, none of
    // these should be called.
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
    vi.doMock('../src/siwe.js', () => ({ ensureSignedIn: vi.fn() }));
    vi.doMock('../src/wallet.js', () => ({
      onAccountChange: vi.fn(),
      getAccount: vi.fn(() => ({ address: null, isConnected: false })),
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
    vi.doMock('../src/access-store.js', () => ({ set: vi.fn() }));
    vi.doMock('../src/profile.js', () => ({ mountProfile: vi.fn() }));
    vi.doMock('../src/access.js', () => ({ mountAccessBanner: vi.fn() }));
    vi.doMock('../src/soft-lock.js', () => ({ mountSoftLock: vi.fn() }));
    vi.doMock('../src/ui/toast.js', () => ({ showToast: vi.fn() }));
    vi.doMock('../src/ui/signin-modal.js', () => ({ showSignInModal: vi.fn() }));
    vi.doMock('../src/resizable.js', () => ({ mountResizable: vi.fn() }));
    vi.doMock('../src/components/header-actions.js', () => ({ mountHeaderActions: vi.fn() }));
    vi.doMock('../src/styles.css', () => ({}), { virtual: true });
    vi.doMock('../src/styles/tokens.css', () => ({}), { virtual: true });
    vi.doMock('../src/styles/sidebar-batch3.css', () => ({}), { virtual: true });
    vi.doMock('../src/styles/sidebar-role.css', () => ({}), { virtual: true });
    vi.doMock('../src/styles/resizable.css', () => ({}), { virtual: true });
    vi.doMock('../src/styles/modals-batch7.css', () => ({}), { virtual: true });
    vi.doMock('../src/styles/trade-panel-batch5.css', () => ({}), { virtual: true });
    vi.doMock('../src/styles/mobile-stub.css', () => ({}), { virtual: true });

    await import('../src/main.js');

    // Stub painted, no wallet/sse/layout init.
    expect(document.querySelector('[data-test-id="mobile-stub"]')).not.toBeNull();
    expect(layoutMock).not.toHaveBeenCalled();
    expect(walletInit).not.toHaveBeenCalled();
    vi.resetModules();
  });
});
