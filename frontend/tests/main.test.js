// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependent modules BEFORE importing the SUT. We only need the handful
// of imports that `createAccountChangeHandler` actually pulls in; the rest of
// main.js is the bootstrap() flow which we never invoke here.

vi.mock('../src/wallet.js', () => ({
  onAccountChange: vi.fn(),
}));

vi.mock('../src/api.js', () => {
  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiError,
    getConfig: vi.fn(),
    getTokens: vi.fn(),
    getAccess: vi.fn(),
    logout: vi.fn(),
  };
});

vi.mock('../src/ui/signin-modal.js', () => ({
  showSignInModal: vi.fn(),
}));

vi.mock('../src/access-store.js', () => ({
  set: vi.fn(),
}));

// Stub out the side-effect-heavy modules main.js imports at module-load time.
vi.mock('../src/styles.css', () => ({}), { virtual: true });
vi.mock('../src/layout.js', () => ({ mountLayout: vi.fn() }));
vi.mock('../src/sidebar.js', () => ({ mountSidebar: vi.fn() }));
vi.mock('../src/chart.js', () => ({ mountChart: vi.fn() }));
vi.mock('../src/components/bottom/index.js', () => ({ mountBottomTabs: vi.fn() }));
vi.mock('../src/trade-panel.js', () => ({ mountTradePanel: vi.fn() }));
vi.mock('../src/sse.js', () => ({ openStream: vi.fn() }));
vi.mock('../src/ui/wallet-chip.js', () => ({ mountWalletChip: vi.fn() }));
vi.mock('../src/siwe.js', () => ({ ensureSignedIn: vi.fn() }));
vi.mock('../src/referral.js', () => ({ bootstrapReferral: vi.fn(async () => {}) }));
vi.mock('../src/config-store.js', () => ({ merge: vi.fn() }));
vi.mock('../src/profile.js', () => ({ mountProfile: vi.fn() }));
vi.mock('../src/access.js', () => ({ mountAccessBanner: vi.fn() }));
vi.mock('../src/soft-lock.js', () => ({ mountSoftLock: vi.fn() }));
vi.mock('../src/ui/toast.js', () => ({ showToast: vi.fn() }));

const accessStoreMock = await import('../src/access-store.js');
const apiMock = await import('../src/api.js');
const signinMock = await import('../src/ui/signin-modal.js');
const { createAccountChangeHandler } = await import('../src/main.js');

const WALLET_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WALLET_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function connected(addr) {
  return { address: addr, isConnected: true, chainId: 8453, connectorId: 'injected' };
}

beforeEach(() => {
  vi.clearAllMocks();
});

function makeBanner() {
  return { refresh: vi.fn(async () => {}) };
}

describe('createAccountChangeHandler — rapid double-switch (H-1)', () => {
  it('synchronously force-locks the access store when wallet switches while the SIWE modal is open', async () => {
    // /access throws 401 for wallet-A so the SIWE modal opens and modalOpen
    // stays true (we never resolve onSuccess/onCancel).
    apiMock.getAccess.mockImplementation(async () => {
      const e = new apiMock.ApiError('unauthorized', 401);
      throw e;
    });
    const banner = makeBanner();
    const handler = createAccountChangeHandler({ accessBanner: banner });

    // Wallet-A connects.
    handler(connected(WALLET_A));
    // Drain microtasks so getAccess() → catch → showSignInModal runs.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(signinMock.showSignInModal).toHaveBeenCalledTimes(1);
    // setAccessState('unknown') was called once on the initial connect
    // (wallet-switch branch).
    expect(accessStoreMock.set).toHaveBeenCalledWith('unknown');
    const initialUnknownCalls = accessStoreMock.set.mock.calls.filter(
      ([s]) => s === 'unknown',
    ).length;

    // SIWE modal stays open (we never invoke onSuccess/onCancel). Now wallet-B
    // arrives mid-flight. The handler MUST synchronously publish 'unknown' so
    // any premium UI bound to access-store flips to lock before any await.
    handler(connected(WALLET_B));
    const afterSwitchUnknownCalls = accessStoreMock.set.mock.calls.filter(
      ([s]) => s === 'unknown',
    ).length;
    expect(afterSwitchUnknownCalls).toBe(initialUnknownCalls + 1);
    // And we must NOT start a second SIWE modal — modalOpen guard still wins.
    expect(signinMock.showSignInModal).toHaveBeenCalledTimes(1);
  });

  it('does NOT republish unknown when the same address re-fires after a clean sign-in (no flicker)', async () => {
    // /access succeeds → handler sets lastSignedInAddress and modalOpen=false.
    apiMock.getAccess.mockResolvedValue({ hasAccess: true, source: 'paid' });
    const banner = makeBanner();
    const handler = createAccountChangeHandler({ accessBanner: banner });

    handler(connected(WALLET_A));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const baselineUnknowns = accessStoreMock.set.mock.calls.filter(
      ([s]) => s === 'unknown',
    ).length;

    // Same wallet-A re-fires (e.g. chain switch). address === lastSignedInAddress
    // — must NOT call setAccessState again (no premium → unknown flicker).
    handler(connected(WALLET_A));
    const afterUnknowns = accessStoreMock.set.mock.calls.filter(
      ([s]) => s === 'unknown',
    ).length;
    expect(afterUnknowns).toBe(baselineUnknowns);
  });
});
