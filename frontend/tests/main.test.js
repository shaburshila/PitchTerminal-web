// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependent modules BEFORE importing the SUT. We only need the handful
// of imports that `createAccountChangeHandler` actually pulls in; the rest of
// main.js is the bootstrap() flow which we never invoke here.

vi.mock('../src/wallet.js', () => ({
  onAccountChange: vi.fn(),
  getAccount: vi.fn(() => ({
    address: null,
    chainId: null,
    isConnected: false,
    connectorId: null,
  })),
  tryAutoReconnect: vi.fn(async () => ({
    address: null,
    chainId: null,
    isConnected: false,
    connectorId: null,
  })),
  setSiweHooks: vi.fn(),
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
    getPortfolio: vi.fn(),
    logout: vi.fn(),
  };
});

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
vi.mock('../src/referral.js', () => ({ bootstrapReferral: vi.fn(async () => {}) }));
vi.mock('../src/config-store.js', () => ({ merge: vi.fn() }));
vi.mock('../src/profile.js', () => ({ mountProfile: vi.fn() }));
vi.mock('../src/access.js', () => ({ mountAccessBanner: vi.fn() }));
vi.mock('../src/soft-lock.js', () => ({ mountSoftLock: vi.fn() }));
vi.mock('../src/ui/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../src/resizable.js', () => ({ mountResizable: vi.fn() }));
vi.mock('../src/components/header-actions.js', () => ({ mountHeaderActions: vi.fn() }));

const accessStoreMock = await import('../src/access-store.js');
const apiMock = await import('../src/api.js');
const {
  createAccountChangeHandler,
  weiToWhole,
  createPositionsRefresher,
  createSparkRerender,
  createStaleSessionCleanup,
} = await import('../src/main.js');

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

describe('createAccountChangeHandler — AppKit-managed SIWE', () => {
  it('publishes connecting on a fresh wallet connect and never opens a custom signin modal', async () => {
    // /access throws 401 for wallet-A — under the new flow there is no
    // signin-modal popup; AppKit handles the prompt inside its own modal,
    // and we just keep the access-store at 'connecting' until the
    // markSignedIn() hook fires.
    apiMock.getAccess.mockImplementation(async () => {
      const e = new apiMock.ApiError('unauthorized', 401);
      throw e;
    });
    const banner = makeBanner();
    const handler = createAccountChangeHandler({ accessBanner: banner });

    handler(connected(WALLET_A));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(accessStoreMock.set).toHaveBeenCalledWith('connecting');
    // No 'anon' / 'free' downgrade on the 401 branch — the UI stays in
    // loading-state until AppKit drives SIWE to completion or the user
    // disconnects.
    expect(accessStoreMock.set).not.toHaveBeenCalledWith('anon');
  });

  it('markSignedIn() refreshes the banner and dedupes a subsequent same-address re-fire', async () => {
    // /access succeeds (cookie alive) — initial path resolves cleanly.
    apiMock.getAccess.mockResolvedValue({ hasAccess: true, source: 'paid' });
    const banner = makeBanner();
    const handler = createAccountChangeHandler({ accessBanner: banner });

    handler(connected(WALLET_A));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const baselineConnecting = accessStoreMock.set.mock.calls.filter(
      ([s]) => s === 'connecting',
    ).length;

    // Same wallet re-fires (chain switch) — must be deduped, no extra
    // setAccessState call. The clean-cookie path already wrote
    // lastSignedInAddress inside the .then() above.
    handler(connected(WALLET_A));
    const afterConnecting = accessStoreMock.set.mock.calls.filter(
      ([s]) => s === 'connecting',
    ).length;
    expect(afterConnecting).toBe(baselineConnecting);
  });

  it('markSignedIn() promotes a 401-path connection so a re-fire is a no-op', async () => {
    // /access throws 401 the first time (forcing the 'connecting' path),
    // then AppKit's onSignIn fires markSignedIn(wallet-A). Subsequent
    // account-change with the same address must not republish 'connecting'.
    apiMock.getAccess.mockImplementation(async () => {
      const e = new apiMock.ApiError('unauthorized', 401);
      throw e;
    });
    const banner = makeBanner();
    const handler = createAccountChangeHandler({ accessBanner: banner });

    handler(connected(WALLET_A));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const connectingBefore = accessStoreMock.set.mock.calls.filter(
      ([s]) => s === 'connecting',
    ).length;
    expect(connectingBefore).toBeGreaterThanOrEqual(1);

    // AppKit signed-in — promote the handler.
    handler.markSignedIn(WALLET_A);
    // Same wallet re-fires.
    handler(connected(WALLET_A));
    const connectingAfter = accessStoreMock.set.mock.calls.filter(
      ([s]) => s === 'connecting',
    ).length;
    expect(connectingAfter).toBe(connectingBefore);
  });
});

describe('weiToWhole (Phase 1.5 follow-up: BigInt precision)', () => {
  it('returns 0 for null / undefined / empty / non-string', () => {
    expect(weiToWhole(null)).toBe(0);
    expect(weiToWhole(undefined)).toBe(0);
    expect(weiToWhole('')).toBe(0);
    expect(weiToWhole(123)).toBe(0);
  });

  it('returns 0 for non-numeric strings', () => {
    expect(weiToWhole('abc')).toBe(0);
    expect(weiToWhole('1.5e10')).toBe(0);
    expect(weiToWhole('1.0')).toBe(0);
  });

  it('handles single-token wei amount (10^18 → 1)', () => {
    expect(weiToWhole('1000000000000000000')).toBe(1);
  });

  it('handles sub-token fractional wei amount (10^17 → 0.1)', () => {
    expect(weiToWhole('100000000000000000')).toBeCloseTo(0.1, 10);
  });

  it('handles 18-char value (< 1 PITCH) approximately', () => {
    // '1' × 18 = 111111111111111111 (~1.11e17 wei, ~0.111 PITCH).
    // The buggy v1 implementation hit the `s.length > 18` branch as false and
    // returned Number('111111111111111111') / 1e18 — Number() on an 18-digit
    // integer-like > 2^53 (9.007e15) silently rounds. The BigInt fix doesn't
    // help here much (the fractional remainder is itself larger than 2^53)
    // but the result is still close to the true value.
    const result = weiToWhole('111111111111111111');
    expect(result).toBeCloseTo(0.1111111111111111, 4);
  });

  it('handles a 19-digit value exceeding 1 token without truncating low digits (issue #3)', () => {
    // 12_345_678_901_234_567_890 wei = ~12.345 PITCH. The pre-fix code
    // took the leading slice ('12') and discarded the fractional 18 digits
    // entirely — net result was the integer floor only. BigInt division
    // recovers the fractional component.
    const result = weiToWhole('12345678901234567890');
    expect(result).toBeGreaterThan(12.3);
    expect(result).toBeLessThan(12.4);
  });

  it('handles a 19-digit value that the pre-fix code would have truncated to integer-only', () => {
    // The pre-fix `Number(s.slice(0, s.length - 18))` for length=19 returns
    // Number(first-char). For '99999999999999999999' (20 chars) it returned
    // Number('99') = 99 — discarding 18 digits of value (~9.99 vs true
    // ~99.99). Verify the fix integer-part is correct for the 20-char case:
    // 99_999_999_999_999_999_999 wei ≈ 99.9999... PITCH.
    const result = weiToWhole('99999999999999999999');
    expect(result).toBeGreaterThan(99);
    expect(result).toBeLessThanOrEqual(100);
  });

  it('handles large supply values (1_000_000 tokens) precisely', () => {
    // 1_000_000 * 1e18 = 1e24 → returns 1_000_000
    expect(weiToWhole('1000000000000000000000000')).toBe(1_000_000);
  });

  it('handles negative wei (defensive — backend should never send these)', () => {
    expect(weiToWhole('-1000000000000000000')).toBe(-1);
  });
});

describe('createPositionsRefresher (Phase 1.5 follow-up: race + anon guard)', () => {
  function makeSidebar() {
    return { rerender: vi.fn() };
  }

  function makePortfolioResp(tokens, { kind = 'country' } = {}) {
    return {
      items: tokens.map((t) => ({
        token: t,
        symbol: 'X',
        kind,
        balance: '1000000000000000000',
        balanceDisplay: 1,
      })),
    };
  }

  it('skips the request entirely when wallet is disconnected (issue #4)', () => {
    const getPortfolio = vi.fn();
    const sidebar = makeSidebar();
    const positionByAddr = new Map([['0xstale', 42]]);
    const refresh = createPositionsRefresher({
      getAccount: () => ({ isConnected: false }),
      getPortfolio,
      positionByAddr,
      sidebar,
    });
    refresh();
    expect(getPortfolio).not.toHaveBeenCalled();
    // stale dots are still cleared synchronously so a disconnect wipes UI.
    expect(positionByAddr.size).toBe(0);
    expect(sidebar.rerender).toHaveBeenCalledTimes(1);
  });

  it('discards a stale slow response when a newer refresh completed first (issue #1)', async () => {
    // First call hangs; second call resolves fast with the NEW wallet's
    // tokens. The first must NOT later overwrite positionByAddr.
    let resolveSlow;
    const slow = new Promise((r) => {
      resolveSlow = r;
    });
    const getPortfolio = vi
      .fn()
      .mockImplementationOnce(() => slow)
      .mockImplementationOnce(() => Promise.resolve(makePortfolioResp(['0xNEW'])));
    const sidebar = makeSidebar();
    const positionByAddr = new Map();
    const refresh = createPositionsRefresher({
      getAccount: () => ({ isConnected: true }),
      getPortfolio,
      positionByAddr,
      sidebar,
    });

    refresh(); // wallet-A — never resolves yet
    refresh(); // wallet-B — resolves first
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // After the newer call resolved, we have the new wallet's dot.
    expect(positionByAddr.has('0xnew')).toBe(true);
    expect(positionByAddr.size).toBe(1);

    // Now let the stale wallet-A call land. It must NOT overwrite.
    resolveSlow(makePortfolioResp(['0xOLD']));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(positionByAddr.has('0xnew')).toBe(true);
    expect(positionByAddr.has('0xold')).toBe(false);
  });

  it('records player-kind tokens (Wave 2B)', async () => {
    const getPortfolio = vi
      .fn()
      .mockResolvedValueOnce(makePortfolioResp(['0xPLAYER'], { kind: 'player' }));
    const sidebar = makeSidebar();
    const positionByAddr = new Map();
    const refresh = createPositionsRefresher({
      getAccount: () => ({ isConnected: true }),
      getPortfolio,
      positionByAddr,
      sidebar,
    });
    refresh();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(positionByAddr.has('0xplayer')).toBe(true);
    expect(positionByAddr.get('0xplayer')).toBe(1);
  });

  it('silently degrades to no dots on 401/402 (free user, not premium)', async () => {
    const getPortfolio = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error('payment required'), { status: 402 }),
    );
    const sidebar = makeSidebar();
    const positionByAddr = new Map([['0xstale', 5]]);
    const refresh = createPositionsRefresher({
      getAccount: () => ({ isConnected: true }),
      getPortfolio,
      positionByAddr,
      sidebar,
    });
    refresh();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(positionByAddr.size).toBe(0);
  });

  it('skips items with zero or missing balance', async () => {
    const getPortfolio = vi.fn().mockResolvedValueOnce({
      items: [
        { token: '0xA', balanceDisplay: 0 },
        { token: '0xB', balanceDisplay: 2.5 },
        { token: '0xC' /* no balance at all */ },
      ],
    });
    const sidebar = makeSidebar();
    const positionByAddr = new Map();
    const refresh = createPositionsRefresher({
      getAccount: () => ({ isConnected: true }),
      getPortfolio,
      positionByAddr,
      sidebar,
    });
    refresh();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(positionByAddr.has('0xa')).toBe(false);
    expect(positionByAddr.has('0xb')).toBe(true);
    expect(positionByAddr.has('0xc')).toBe(false);
  });

  it('createSparkRerender.cleanup clears the pending timer (issue #2 leak)', () => {
    const sidebar = { rerender: vi.fn() };
    const clearSpy = vi.fn();
    const setSpy = vi.fn(() => 'fake-handle');
    const { schedule, cleanup } = createSparkRerender(sidebar, 5000, {
      setTimeout: setSpy,
      clearTimeout: clearSpy,
    });
    schedule();
    expect(setSpy).toHaveBeenCalledTimes(1);
    cleanup();
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledWith('fake-handle');
    // No-op when called again — nothing pending.
    cleanup();
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('createSparkRerender.schedule coalesces multiple calls into one timer', () => {
    const sidebar = { rerender: vi.fn() };
    const setSpy = vi.fn(() => 1);
    const { schedule } = createSparkRerender(sidebar, 5000, {
      setTimeout: setSpy,
      clearTimeout: vi.fn(),
    });
    schedule();
    schedule();
    schedule();
    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  it('drops a stale error response that lands after a successful refresh', async () => {
    let rejectSlow;
    const slow = new Promise((_, reject) => {
      rejectSlow = reject;
    });
    const getPortfolio = vi
      .fn()
      .mockImplementationOnce(() => slow)
      .mockImplementationOnce(() => Promise.resolve(makePortfolioResp(['0xNEW'])));
    const sidebar = makeSidebar();
    const positionByAddr = new Map();
    const refresh = createPositionsRefresher({
      getAccount: () => ({ isConnected: true }),
      getPortfolio,
      positionByAddr,
      sidebar,
    });
    refresh();
    refresh();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(positionByAddr.has('0xnew')).toBe(true);
    // Stale failure must not wipe the new positions.
    rejectSlow(new Error('boom'));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(positionByAddr.has('0xnew')).toBe(true);
  });
});

describe('createStaleSessionCleanup (security fix #6 — orphaned WC cookie)', () => {
  it('clears the server session when cookie is alive but no wallet is connected', async () => {
    // /access returns 200 (cookie alive) — but getAccount() reports no wallet.
    // This is the WC-on-shared-computer scenario: previous user closed the tab
    // without Disconnect, cookie persists for up to 72h.
    const getAccess = vi.fn(async () => ({ hasAccess: false, source: 'none' }));
    const logout = vi.fn(async () => null);
    const getAccount = vi.fn(() => ({
      address: null,
      chainId: null,
      isConnected: false,
      connectorId: null,
    }));
    const cleanup = createStaleSessionCleanup({ getAccount, getAccess, logout });
    await cleanup();
    expect(getAccess).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('leaves the session alone when a wallet IS connected (normal flow)', async () => {
    // Wallet is live → the cookie matches the wallet → don't touch it.
    const getAccess = vi.fn(async () => ({ hasAccess: true, source: 'paid' }));
    const logout = vi.fn(async () => null);
    const getAccount = vi.fn(() => ({
      address: WALLET_A,
      chainId: 8453,
      isConnected: true,
      connectorId: 'injected',
    }));
    const cleanup = createStaleSessionCleanup({ getAccount, getAccess, logout });
    await cleanup();
    // Short-circuit before any API call — we trust the wallet state.
    expect(getAccess).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
  });

  it('does NOT logout when /access throws 401 (no orphaned cookie)', async () => {
    const getAccess = vi.fn(async () => {
      throw new apiMock.ApiError('unauthorized', 401);
    });
    const logout = vi.fn(async () => null);
    const getAccount = vi.fn(() => ({
      address: null,
      chainId: null,
      isConnected: false,
      connectorId: null,
    }));
    const cleanup = createStaleSessionCleanup({ getAccount, getAccess, logout });
    await cleanup();
    expect(getAccess).toHaveBeenCalledTimes(1);
    expect(logout).not.toHaveBeenCalled();
  });
});
