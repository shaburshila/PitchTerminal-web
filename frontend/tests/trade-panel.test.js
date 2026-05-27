// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock viem / @wagmi/core BEFORE importing the SUT — same pattern as wallet.test.js.
// We need wallet.js to be importable; its module-level imports go through these mocks.

const wagmiState = { connections: [], watchers: new Set() };
function emitWagmi() {
  for (const fn of wagmiState.watchers) fn();
}

vi.mock('@wagmi/core', () => ({
  connect: vi.fn(async () => {
    wagmiState.connections = [
      {
        accounts: ['0xABCdef0000000000000000000000000000000001'],
        chainId: 8453,
        connector: { id: 'injected' },
      },
    ];
    emitWagmi();
    return wagmiState.connections[0];
  }),
  disconnect: vi.fn(async () => {
    wagmiState.connections = [];
    emitWagmi();
  }),
  switchChain: vi.fn(async (_cfg, { chainId }) => {
    if (wagmiState.connections[0]) wagmiState.connections[0].chainId = chainId;
    emitWagmi();
    return { id: chainId };
  }),
  getConnections: vi.fn(() => wagmiState.connections),
  watchConnections: vi.fn((_cfg, { onChange }) => {
    wagmiState.watchers.add(onChange);
    return () => wagmiState.watchers.delete(onChange);
  }),
  reconnect: vi.fn(async () => []),
  signMessage: vi.fn(async () => '0xfeedface'),
}));

vi.mock('viem/chains', () => ({
  base: { id: 8453, name: 'Base' },
  baseSepolia: { id: 84532, name: 'Base Sepolia' },
}));

// We let the SUT import `createPublicClient` from viem but stub the heavy
// machinery — the panel only ever calls `readContract`, and tests inject
// `readBalance` / `readQuote` overrides so the real client never runs.
vi.mock('viem', () => ({
  createPublicClient: vi.fn(() => ({
    readContract: vi.fn(async () => 0n),
  })),
  http: vi.fn(() => ({})),
}));

// AppKit + WagmiAdapter test doubles. The wagmi Config returned by the
// adapter exposes a `connectors` array so `connectWallet('injected')` (the
// legacy back-compat path) can match against it.
vi.mock('@reown/appkit', () => ({
  createAppKit: vi.fn(() => ({ open: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) })),
}));
vi.mock('@reown/appkit-adapter-wagmi', () => ({
  WagmiAdapter: vi.fn(function WagmiAdapter() {
    return { wagmiConfig: { connectors: [{ id: 'injected' }] } };
  }),
}));

const wallet = await import('../src/wallet.js');
const {
  mountTradePanel,
  parseAmountToWei,
  formatWei,
  percentOfBalance,
  applySlippage,
  resolveVenue,
  resolveLimitSpenderAndToken,
  disabledReason,
  disabledReasonLimit,
  MAX_UINT256,
  _resetClientForTests,
} = await import('../src/trade-panel.js');

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CONFIG = {
  chainId: 8453,
  contracts: {
    pitch: '0xeae13ea73bec936664a51734c8c01ec7c3b0699c',
    playerRouter: '0x5f231aea5abd403af0e8a32c1fef85a9a3ec5622',
    countryRouter: '0x61cad011db02d9924257f536bfd1ea615e42bb9d',
    playerHook: '0xd5252a67935fc6b913c4441ac0e5ebf3219faaa8',
    countryHook: '0x1111111111111111111111111111111111111111',
    multicall3: '0xca11bde05977b3631167028862be2a173976ca11',
    access: '0x2222222222222222222222222222222222222222',
    limitOrderExecutor: '0xb22f38a0c133a32ab9582ace9e2da41d1738b9d5',
  },
};

const PLAYER_TOKEN = {
  address: '0xpppp000000000000000000000000000000000001',
  symbol: 'PLR',
  countryAddress: '0xcccc000000000000000000000000000000000001',
};

const COUNTRY_TOKEN = {
  address: '0xcccc000000000000000000000000000000000002',
  symbol: 'BRA',
  // no countryAddress → country venue
};

function makeApi(overrides = {}) {
  return {
    getConfig: vi.fn().mockResolvedValue(CONFIG),
    ...overrides,
  };
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

let container;
beforeEach(() => {
  document.body.replaceChildren();
  container = document.createElement('div');
  document.body.appendChild(container);
  wallet._resetForTests();
  _resetClientForTests();
  wagmiState.connections = [];
  wagmiState.watchers.clear();
  // Prime AppKit/WagmiAdapter so legacy `connectWallet('injected')` calls
  // resolve through the mocked wagmi config. Must run AFTER clearing
  // wagmiState.watchers — otherwise the subscription registered inside
  // setWalletConnectProjectId would be wiped.
  wallet.setWalletConnectProjectId('test-project-id');
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Pure helpers ──────────────────────────────────────────────────────────

describe('parseAmountToWei', () => {
  it('parses simple integers', () => {
    expect(parseAmountToWei('1')).toBe(10n ** 18n);
    expect(parseAmountToWei('10')).toBe(10n * 10n ** 18n);
  });

  it('parses decimals', () => {
    expect(parseAmountToWei('1.5')).toBe(15n * 10n ** 17n);
    expect(parseAmountToWei('0.000001')).toBe(10n ** 12n);
  });

  it('parses leading-dot decimals', () => {
    expect(parseAmountToWei('.5')).toBe(5n * 10n ** 17n);
  });

  it('returns null on empty/invalid input', () => {
    expect(parseAmountToWei('')).toBeNull();
    expect(parseAmountToWei(null)).toBeNull();
    expect(parseAmountToWei(undefined)).toBeNull();
    expect(parseAmountToWei('abc')).toBeNull();
    expect(parseAmountToWei('-1')).toBeNull();
    expect(parseAmountToWei('1.2.3')).toBeNull();
    expect(parseAmountToWei('.')).toBeNull();
  });

  it('truncates beyond 18 decimals (no rounding)', () => {
    // 0.<19 digits> → fractional truncated to 18
    expect(parseAmountToWei('0.1234567890123456789')).toBe(123456789012345678n);
  });
});

describe('formatWei', () => {
  it('formats 0', () => {
    expect(formatWei(0n)).toBe('0');
  });

  it('strips trailing zeros', () => {
    expect(formatWei(10n ** 18n)).toBe('1');
    expect(formatWei(15n * 10n ** 17n)).toBe('1.5');
  });

  it('truncates to maxFractionalDigits', () => {
    // 0.123456789012345678 with max=6 → "0.123456"
    expect(formatWei(123456789012345678n, 6)).toBe('0.123456');
  });

  it('handles values < 1', () => {
    expect(formatWei(10n ** 12n, 6)).toBe('0.000001');
  });

  it('returns empty string for null/undefined/non-bigint', () => {
    expect(formatWei(null)).toBe('');
    expect(formatWei(undefined)).toBe('');
    expect(formatWei(1.5)).toBe('');
  });
});

describe('percentOfBalance', () => {
  const bal = 100n * 10n ** 18n;

  it('computes 25/50/75/100 correctly', () => {
    expect(percentOfBalance(bal, 25)).toBe(25n * 10n ** 18n);
    expect(percentOfBalance(bal, 50)).toBe(50n * 10n ** 18n);
    expect(percentOfBalance(bal, 75)).toBe(75n * 10n ** 18n);
    expect(percentOfBalance(bal, 100)).toBe(100n * 10n ** 18n);
  });

  it('returns 0 for zero/negative balance or bad percent', () => {
    expect(percentOfBalance(0n, 50)).toBe(0n);
    expect(percentOfBalance(-5n, 50)).toBe(0n);
    expect(percentOfBalance(bal, 0)).toBe(0n);
    expect(percentOfBalance(bal, NaN)).toBe(0n);
  });

  it('clamps percent > 100 to 100', () => {
    expect(percentOfBalance(bal, 200)).toBe(100n * 10n ** 18n);
  });
});

describe('applySlippage', () => {
  it('1% slippage off 100e18 → 99e18', () => {
    expect(applySlippage(100n * 10n ** 18n, 1)).toBe(99n * 10n ** 18n);
  });

  it('0% slippage is a no-op', () => {
    expect(applySlippage(100n * 10n ** 18n, 0)).toBe(100n * 10n ** 18n);
  });

  it('10% slippage off 100e18 → 90e18', () => {
    expect(applySlippage(100n * 10n ** 18n, 10)).toBe(90n * 10n ** 18n);
  });

  it('clamps slippage > MAX (10%) to 10%', () => {
    expect(applySlippage(100n * 10n ** 18n, 50)).toBe(90n * 10n ** 18n);
  });

  it('returns 0 for non-positive quote', () => {
    expect(applySlippage(0n, 1)).toBe(0n);
  });

  it('returns input unchanged for negative slippage', () => {
    expect(applySlippage(100n, -1)).toBe(100n);
  });
});

describe('resolveVenue', () => {
  it('resolves player venue when countryAddress is present', () => {
    expect(resolveVenue(PLAYER_TOKEN, CONFIG.contracts.pitch)).toEqual({
      venue: 'player',
      baseToken: PLAYER_TOKEN.address.toLowerCase(),
      quoteToken: PLAYER_TOKEN.countryAddress.toLowerCase(),
    });
  });

  it('resolves country venue when countryAddress is absent', () => {
    expect(resolveVenue(COUNTRY_TOKEN, CONFIG.contracts.pitch)).toEqual({
      venue: 'country',
      baseToken: COUNTRY_TOKEN.address.toLowerCase(),
      quoteToken: CONFIG.contracts.pitch,
    });
  });

  it('returns null for missing token', () => {
    expect(resolveVenue(null, CONFIG.contracts.pitch)).toBeNull();
  });

  it('country venue needs PITCH address', () => {
    expect(resolveVenue(COUNTRY_TOKEN, null)).toBeNull();
  });
});

describe('disabledReason', () => {
  const baseCtx = {
    walletConnected: true,
    chainId: 8453,
    token: PLAYER_TOKEN,
    contractsReady: true,
    amountWei: 10n ** 18n,
    balanceWei: 10n ** 19n,
    limitMode: false,
  };

  it('returns null when everything is ready', () => {
    expect(disabledReason(baseCtx)).toBeNull();
  });

  it('flags limit mode (legacy market-mode helper)', () => {
    // F2.x — the market `disabledReason` helper retains its legacy short-circuit
    // for `limitMode: true` so any caller still passing the old flag falls back
    // to a disabled CTA. The new limit-mode flow uses `disabledReasonLimit`.
    expect(disabledReason({ ...baseCtx, limitMode: true })).toMatch(/phase 2/i);
  });

  it('flags wallet disconnected', () => {
    expect(disabledReason({ ...baseCtx, walletConnected: false })).toMatch(/wallet/i);
  });

  it('flags wrong chain', () => {
    expect(disabledReason({ ...baseCtx, chainId: 1 })).toMatch(/Base/);
  });

  it('flags missing token', () => {
    expect(disabledReason({ ...baseCtx, token: null })).toMatch(/token/i);
  });

  it('flags missing contracts', () => {
    expect(disabledReason({ ...baseCtx, contractsReady: false })).toMatch(/config/i);
  });

  it('flags zero amount', () => {
    expect(disabledReason({ ...baseCtx, amountWei: 0n })).toMatch(/amount/i);
    expect(disabledReason({ ...baseCtx, amountWei: null })).toMatch(/amount/i);
  });

  it('flags insufficient balance', () => {
    expect(disabledReason({ ...baseCtx, amountWei: 100n * 10n ** 18n, balanceWei: 10n ** 18n })).toMatch(/Insufficient/);
  });
});

// ─── Mount behaviour ───────────────────────────────────────────────────────

describe('mountTradePanel — DOM', () => {
  it('builds skeleton with mode toggle, side tabs, amount, slippage, quote, cta', async () => {
    const api = makeApi();
    const handle = mountTradePanel(container, { apiClient: api });
    await flush();
    expect(container.querySelector('[data-test-id="trade-panel"]')).toBeTruthy();
    expect(container.querySelector('[data-test-id="mode-market"]')).toBeTruthy();
    const limit = container.querySelector('[data-test-id="mode-limit"]');
    expect(limit).toBeTruthy();
    // F2.x — Limit toggle is now enabled (phase 2 shipped).
    expect(limit.disabled).toBe(false);
    expect(container.querySelector('[data-test-id="side-buy"]')).toBeTruthy();
    expect(container.querySelector('[data-test-id="side-sell"]')).toBeTruthy();
    expect(container.querySelector('[data-test-id="trade-amount"]')).toBeTruthy();
    expect(container.querySelector('[data-test-id="trade-slippage"]')).toBeTruthy();
    expect(container.querySelector('[data-test-id="trade-cta"]')).toBeTruthy();
    expect(container.querySelector('[data-test-id="pct-25"]')).toBeTruthy();
    expect(container.querySelector('[data-test-id="pct-100"]').textContent).toBe('Max');
    handle.destroy();
  });

  it('cta is disabled when wallet not connected', async () => {
    const handle = mountTradePanel(container, { apiClient: makeApi() });
    await flush();
    const cta = container.querySelector('[data-test-id="trade-cta"]');
    expect(cta.disabled).toBe(true);
    expect(container.querySelector('[data-test-id="trade-status"]').textContent).toMatch(/wallet/i);
    handle.destroy();
  });

  it('clicking sell tab swaps aria-selected and cta label', async () => {
    const handle = mountTradePanel(container, { apiClient: makeApi() });
    await flush();
    const sellBtn = container.querySelector('[data-test-id="side-sell"]');
    sellBtn.click();
    expect(sellBtn.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-test-id="side-buy"]').getAttribute('aria-selected')).toBe('false');
    expect(container.querySelector('[data-test-id="trade-cta"]').textContent).toBe('Sell');
    handle.destroy();
  });

  it('clicking the Limit toggle switches mode + reveals the limit form', async () => {
    const handle = mountTradePanel(container, { apiClient: makeApi() });
    await flush();
    const limitBtn = container.querySelector('[data-test-id="mode-limit"]');
    limitBtn.click();
    expect(limitBtn.getAttribute('aria-pressed')).toBe('true');
    expect(
      container.querySelector('[data-test-id="mode-market"]').getAttribute('aria-pressed'),
    ).toBe('false');
    expect(container.querySelector('[data-test-id="trade-limit"]')).toBeTruthy();
    expect(container.querySelector('[data-test-id="trade-limit-price"]')).toBeTruthy();
    expect(container.querySelector('[data-test-id="trade-limit-ttl"]')).toBeTruthy();
    handle.destroy();
  });

  it('destroy() clears DOM and removes listeners', async () => {
    const handle = mountTradePanel(container, { apiClient: makeApi() });
    await flush();
    handle.destroy();
    expect(container.querySelector('[data-test-id="trade-panel"]')).toBeNull();
  });
});

describe('mountTradePanel — quote flow', () => {
  it('debounces quote fetch on amount input', async () => {
    vi.useFakeTimers();
    const readQuote = vi.fn().mockResolvedValue(2n * 10n ** 18n);
    const readBalance = vi.fn().mockResolvedValue(100n * 10n ** 18n);
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readQuote,
      readBalance,
      debounceMs: 200,
    });
    await wallet.connectWallet('injected');
    // Advance microtasks so config + balance resolve.
    await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '1';
    input.dispatchEvent(new Event('input'));
    input.value = '1.5';
    input.dispatchEvent(new Event('input'));
    // Not yet — still in debounce window.
    expect(readQuote).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    // Only one call after the window collapses.
    expect(readQuote).toHaveBeenCalledTimes(1);
    expect(readQuote.mock.calls[0][0]).toMatchObject({
      hook: CONFIG.contracts.playerHook,
      fn: 'quoteBuy',
      token: PLAYER_TOKEN.address,
      amountIn: 15n * 10n ** 17n, // 1.5e18
    });
    handle.destroy();
  });

  it('switching side from buy → sell calls quoteSell', async () => {
    vi.useFakeTimers();
    const readQuote = vi.fn().mockResolvedValue(2n * 10n ** 18n);
    const readBalance = vi.fn().mockResolvedValue(100n * 10n ** 18n);
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readQuote,
      readBalance,
      debounceMs: 100,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="trade-amount"]').value = '1';
    container.querySelector('[data-test-id="trade-amount"]').dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(100);
    expect(readQuote).toHaveBeenCalledTimes(1);
    expect(readQuote.mock.calls[0][0].fn).toBe('quoteBuy');

    container.querySelector('[data-test-id="side-sell"]').click();
    await vi.advanceTimersByTimeAsync(100);
    // After side flip, quoteSell should be called.
    const lastCall = readQuote.mock.calls[readQuote.mock.calls.length - 1];
    expect(lastCall[0].fn).toBe('quoteSell');
    handle.destroy();
  });

  it('25% button fills amount with 25% of balance', async () => {
    vi.useFakeTimers();
    const readBalance = vi.fn().mockResolvedValue(100n * 10n ** 18n);
    const readQuote = vi.fn().mockResolvedValue(50n * 10n ** 18n);
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance,
      readQuote,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="pct-25"]').click();
    const input = container.querySelector('[data-test-id="trade-amount"]');
    expect(input.value).toBe('25');
    handle.destroy();
  });

  it('Max button fills amount with 100% of balance', async () => {
    vi.useFakeTimers();
    const readBalance = vi.fn().mockResolvedValue(42n * 10n ** 18n);
    const readQuote = vi.fn().mockResolvedValue(0n);
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance,
      readQuote,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="pct-100"]').click();
    expect(container.querySelector('[data-test-id="trade-amount"]').value).toBe('42');
    handle.destroy();
  });

  it('renders quote output + minOut with slippage', async () => {
    vi.useFakeTimers();
    const readBalance = vi.fn().mockResolvedValue(100n * 10n ** 18n);
    const readQuote = vi.fn().mockResolvedValue(100n * 10n ** 18n);
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance,
      readQuote,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="trade-amount"]').value = '1';
    container.querySelector('[data-test-id="trade-amount"]').dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    // Flush any microtasks waiting on the resolved readQuote promise.
    await vi.advanceTimersByTimeAsync(0);
    const out = container.querySelector('[data-test-id="quote-out"]').textContent;
    const min = container.querySelector('[data-test-id="quote-min"]').textContent;
    expect(out).toMatch(/100/);
    // Default 1% slippage → minOut = 99
    expect(min).toMatch(/99/);
    handle.destroy();
  });

  it('changing slippage recomputes minOut without re-fetching quote', async () => {
    vi.useFakeTimers();
    const readBalance = vi.fn().mockResolvedValue(100n * 10n ** 18n);
    const readQuote = vi.fn().mockResolvedValue(100n * 10n ** 18n);
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance,
      readQuote,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="trade-amount"]').value = '1';
    container.querySelector('[data-test-id="trade-amount"]').dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);
    expect(readQuote).toHaveBeenCalledTimes(1);

    const slip = container.querySelector('[data-test-id="trade-slippage"]');
    slip.value = '5';
    slip.dispatchEvent(new Event('input'));
    // No additional chain calls.
    expect(readQuote).toHaveBeenCalledTimes(1);
    // 5% off 100 → 95
    expect(container.querySelector('[data-test-id="quote-min"]').textContent).toMatch(/95/);
    handle.destroy();
  });

  it('quote error is surfaced in the error line', async () => {
    vi.useFakeTimers();
    const readBalance = vi.fn().mockResolvedValue(100n * 10n ** 18n);
    const readQuote = vi.fn().mockRejectedValue(new Error('hook reverted'));
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance,
      readQuote,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="trade-amount"]').value = '1';
    container.querySelector('[data-test-id="trade-amount"]').dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);
    const errLine = container.querySelector('[data-test-id="quote-error"]');
    expect(errLine.hidden).toBe(false);
    expect(errLine.textContent).toMatch(/reverted/);
    handle.destroy();
  });

  it('country venue resolves to countryHook + PITCH as quote', async () => {
    vi.useFakeTimers();
    const readBalance = vi.fn().mockResolvedValue(50n * 10n ** 18n);
    const readQuote = vi.fn().mockResolvedValue(10n * 10n ** 18n);
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: COUNTRY_TOKEN,
      readBalance,
      readQuote,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="trade-amount"]').value = '1';
    container.querySelector('[data-test-id="trade-amount"]').dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    expect(readQuote).toHaveBeenCalled();
    expect(readQuote.mock.calls[0][0].hook).toBe(CONFIG.contracts.countryHook);
    expect(readQuote.mock.calls[0][0].token).toBe(COUNTRY_TOKEN.address);
    // For Buy on country: input = PITCH, balance read against PITCH address.
    expect(readBalance.mock.calls[0][0].token).toBe(CONFIG.contracts.pitch);
    handle.destroy();
  });

  it('setToken() resets stale balance + re-fetches', async () => {
    vi.useFakeTimers();
    const readBalance = vi
      .fn()
      .mockResolvedValueOnce(10n * 10n ** 18n) // player → country balance
      .mockResolvedValueOnce(50n * 10n ** 18n); // after switch → PITCH balance
    const readQuote = vi.fn().mockResolvedValue(0n);
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance,
      readQuote,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    expect(readBalance).toHaveBeenCalledTimes(1);
    expect(readBalance.mock.calls[0][0].token).toBe(PLAYER_TOKEN.countryAddress);
    handle.setToken(COUNTRY_TOKEN);
    await vi.advanceTimersByTimeAsync(0);
    expect(readBalance).toHaveBeenCalledTimes(2);
    expect(readBalance.mock.calls[1][0].token).toBe(CONFIG.contracts.pitch);
    handle.destroy();
  });

  it('cta disabled when not on Base chain', async () => {
    vi.useFakeTimers();
    const readBalance = vi.fn().mockResolvedValue(10n ** 18n);
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance,
      readQuote: vi.fn().mockResolvedValue(10n ** 18n),
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    // Force wrong chain via wagmi mock state, then trigger a watcher.
    wagmiState.connections[0].chainId = 1;
    for (const w of wagmiState.watchers) w();
    container.querySelector('[data-test-id="trade-amount"]').value = '0.5';
    container.querySelector('[data-test-id="trade-amount"]').dispatchEvent(new Event('input'));
    expect(container.querySelector('[data-test-id="trade-cta"]').disabled).toBe(true);
    expect(container.querySelector('[data-test-id="trade-status"]').textContent).toMatch(/Base/);
    handle.destroy();
  });

  it('discards quote result from a superseded request', async () => {
    vi.useFakeTimers();
    const readBalance = vi.fn().mockResolvedValue(100n * 10n ** 18n);
    // First call: never resolves until we tell it to → simulates slow in-flight quote.
    let resolveFirst;
    const firstPromise = new Promise((r) => {
      resolveFirst = r;
    });
    const readQuote = vi
      .fn()
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce(99n * 10n ** 18n);
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance,
      readQuote,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);

    const input = container.querySelector('[data-test-id="trade-amount"]');
    // Type '1' → schedule + flush debounce → quote#1 in-flight (stuck on firstPromise)
    input.value = '1';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    expect(readQuote).toHaveBeenCalledTimes(1);
    // quote#1 still pending — state.quote is null and loading flag is set.
    expect(handle.getState().quote).toBeNull();
    expect(handle.getState().quoteLoading).toBe(true);

    // Type '2' → schedule + flush debounce → quote#2 fires, bumps quoteGen.
    input.value = '2';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    expect(readQuote).toHaveBeenCalledTimes(2);

    // Now resolve the OLD (stale) request with a sentinel value that must NOT win.
    resolveFirst(42n * 10n ** 18n);
    // Flush microtasks so both promises settle.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // The new (99) result wins; stale (42) is discarded by the gen-check.
    expect(handle.getState().quote?.amountOutWei).toBe(99n * 10n ** 18n);
    handle.destroy();
  });

  it('Buy→Sell side switch reads balance for the OTHER token', async () => {
    vi.useFakeTimers();
    const readBalance = vi.fn().mockResolvedValue(10n * 10n ** 18n);
    const readQuote = vi.fn().mockResolvedValue(1n * 10n ** 18n);
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance,
      readQuote,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    // Initial mount in Buy mode for a player token:
    //   inputToken = quoteToken = countryAddress → balance read on countryAddress.
    expect(readBalance).toHaveBeenCalledTimes(1);
    expect(readBalance.mock.calls[0][0].token).toBe(PLAYER_TOKEN.countryAddress);

    // Click Sell → inputToken flips to baseToken = token.address (player token).
    container.querySelector('[data-test-id="side-sell"]').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(readBalance).toHaveBeenCalledTimes(2);
    expect(readBalance.mock.calls[1][0].token).toBe(PLAYER_TOKEN.address);
    handle.destroy();
  });

  it('cta disabled when amount > balance', async () => {
    vi.useFakeTimers();
    const readBalance = vi.fn().mockResolvedValue(1n * 10n ** 18n);
    const readQuote = vi.fn().mockResolvedValue(1n * 10n ** 18n);
    // Use COUNTRY_TOKEN here to keep the generic "Insufficient" message —
    // F1.3 rewrites the message for player+Buy specifically, exercised by
    // the dedicated F1.3 suite below.
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: COUNTRY_TOKEN,
      readBalance,
      readQuote,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="trade-amount"]').value = '100';
    container.querySelector('[data-test-id="trade-amount"]').dispatchEvent(new Event('input'));
    expect(container.querySelector('[data-test-id="trade-cta"]').disabled).toBe(true);
    expect(container.querySelector('[data-test-id="trade-status"]').textContent).toMatch(/Insufficient/);
    handle.destroy();
  });
});

// ─── F1.2: approve + swap flow ─────────────────────────────────────────────

describe('disabledReason — F1.2 pending states', () => {
  it('approvePending wins over balance/wallet checks', () => {
    expect(
      disabledReason({
        walletConnected: false,
        chainId: null,
        token: null,
        contractsReady: false,
        amountWei: null,
        balanceWei: null,
        limitMode: false,
        approvePending: true,
      }),
    ).toMatch(/approve/i);
  });

  it('swapPending wins over balance/wallet checks', () => {
    expect(
      disabledReason({
        walletConnected: false,
        chainId: null,
        token: null,
        contractsReady: false,
        amountWei: null,
        balanceWei: null,
        limitMode: false,
        swapPending: true,
      }),
    ).toMatch(/swap|await/i);
  });

  it('limitMode still takes top priority over pending flags', () => {
    expect(
      disabledReason({
        walletConnected: true,
        chainId: 8453,
        token: { address: '0x1' },
        contractsReady: true,
        amountWei: 1n,
        balanceWei: 10n,
        limitMode: true,
        swapPending: true,
      }),
    ).toMatch(/phase 2/i);
  });
});

/**
 * Helper — build a payment stub with the F1.2 interface; tracks calls.
 */
function makePayment(overrides = {}) {
  return {
    readAllowance: vi.fn().mockResolvedValue(0n),
    approve: vi.fn().mockResolvedValue('0xapprovehash'),
    swap: vi.fn().mockResolvedValue('0xswaphash'),
    ...overrides,
  };
}

describe('mountTradePanel — F1.2 allowance read', () => {
  it('reads allowance against the player router for player venue (buy = input is country)', async () => {
    vi.useFakeTimers();
    const payment = makePayment({
      readAllowance: vi.fn().mockResolvedValue(0n),
    });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(payment.readAllowance).toHaveBeenCalled();
    const args = payment.readAllowance.mock.calls[0][0];
    expect(args.token).toBe(PLAYER_TOKEN.countryAddress);
    expect(args.spender).toBe(CONFIG.contracts.playerRouter);
    handle.destroy();
  });

  it('reads allowance against the country router for country venue', async () => {
    vi.useFakeTimers();
    const payment = makePayment();
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: COUNTRY_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const args = payment.readAllowance.mock.calls[0][0];
    expect(args.spender).toBe(CONFIG.contracts.countryRouter);
    expect(args.token).toBe(CONFIG.contracts.pitch);
    handle.destroy();
  });

  it('switching Buy→Sell re-reads allowance for the new input token', async () => {
    vi.useFakeTimers();
    const payment = makePayment();
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(10n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(1n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const initialCalls = payment.readAllowance.mock.calls.length;
    container.querySelector('[data-test-id="side-sell"]').click();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(payment.readAllowance.mock.calls.length).toBeGreaterThan(initialCalls);
    const last = payment.readAllowance.mock.calls.at(-1)[0];
    expect(last.token).toBe(PLAYER_TOKEN.address);
    handle.destroy();
  });
});

describe('mountTradePanel — F1.2 CTA mode (approve vs swap)', () => {
  it('CTA label switches to "Approve" when allowance < amount', async () => {
    vi.useFakeTimers();
    const payment = makePayment({
      readAllowance: vi.fn().mockResolvedValue(0n),
    });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);
    const cta = container.querySelector('[data-test-id="trade-cta"]');
    expect(cta.textContent).toBe('Approve');
    expect(cta.dataset.action).toBe('approve');
    expect(cta.disabled).toBe(false);
    handle.destroy();
  });

  it('CTA stays "Buy" when allowance ≥ amount', async () => {
    vi.useFakeTimers();
    const payment = makePayment({
      readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n),
    });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);
    const cta = container.querySelector('[data-test-id="trade-cta"]');
    expect(cta.textContent).toBe('Buy');
    expect(cta.dataset.action).toBe('swap');
    expect(cta.disabled).toBe(false);
    handle.destroy();
  });

  it('CTA disabled when swap selected but no quote yet', async () => {
    vi.useFakeTimers();
    const payment = makePayment({
      readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n),
    });
    // Slow quote — never resolves before assertion.
    const readQuote = vi.fn().mockReturnValue(new Promise(() => {}));
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote,
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    const cta = container.querySelector('[data-test-id="trade-cta"]');
    expect(cta.disabled).toBe(true);
    handle.destroy();
  });
});

describe('mountTradePanel — F1.2 allowance loading race', () => {
  it('disables swap CTA while allowance is loading (regression: null-allowance race)', async () => {
    vi.useFakeTimers();
    let resolveAllowance;
    const allowanceProm = new Promise((r) => {
      resolveAllowance = r;
    });
    // First call hangs; subsequent calls (post-resolve) just return 1000e18
    // — large enough that no approve is needed.
    const readAllowance = vi
      .fn()
      .mockReturnValueOnce(allowanceProm)
      .mockResolvedValue(1000n * 10n ** 18n);
    const payment = makePayment({ readAllowance });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // Type a valid amount and let the quote land — but allowance is still in flight.
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);

    const cta = container.querySelector('[data-test-id="trade-cta"]');
    const status = container.querySelector('[data-test-id="trade-status"]');
    // Quote is ready; allowance is null (still loading) → CTA must be disabled.
    expect(cta.disabled).toBe(true);
    expect(status.textContent).toMatch(/allowance|Checking/i);

    // Resolve allowance with sufficient value → CTA becomes enabled.
    resolveAllowance(1000n * 10n ** 18n);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    expect(cta.disabled).toBe(false);
    expect(cta.textContent).toBe('Buy');
    handle.destroy();
  });
});

describe('mountTradePanel — F1.2 approve trigger', () => {
  it('clicking Approve calls payment.approve with MAX_UINT256 and the right router', async () => {
    vi.useFakeTimers();
    const payment = makePayment({
      readAllowance: vi.fn().mockResolvedValue(0n),
    });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="trade-cta"]').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(payment.approve).toHaveBeenCalledTimes(1);
    const arg = payment.approve.mock.calls[0][0];
    expect(arg.spender).toBe(CONFIG.contracts.playerRouter);
    expect(arg.token).toBe(PLAYER_TOKEN.countryAddress);
    expect(arg.amount).toBe(MAX_UINT256);
    expect(typeof arg.owner).toBe('string');
    handle.destroy();
  });

  it('approve in-flight → CTA shows "Approve…" + disabled + status hint', async () => {
    vi.useFakeTimers();
    let resolveApprove;
    const approveProm = new Promise((r) => {
      resolveApprove = r;
    });
    const payment = makePayment({
      readAllowance: vi.fn().mockResolvedValue(0n),
      approve: vi.fn().mockReturnValue(approveProm),
    });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="trade-cta"]').click();
    await vi.advanceTimersByTimeAsync(0);
    const cta = container.querySelector('[data-test-id="trade-cta"]');
    expect(cta.textContent).toMatch(/Approve…/);
    expect(cta.disabled).toBe(true);
    expect(handle.getState().approvePending).toBe(true);
    // Resolve to clean up.
    resolveApprove('0xhash');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    handle.destroy();
  });

  it('approve success: re-reads allowance and CTA flips back to Buy', async () => {
    vi.useFakeTimers();
    const readAllowance = vi
      .fn()
      .mockResolvedValueOnce(0n) // initial
      .mockResolvedValue(MAX_UINT256); // after approve
    const payment = makePayment({
      readAllowance,
    });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="trade-cta"]').click();
    // flush approve + post-allowance read
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
    expect(readAllowance.mock.calls.length).toBeGreaterThanOrEqual(2);
    const cta = container.querySelector('[data-test-id="trade-cta"]');
    expect(cta.textContent).toBe('Buy');
    expect(cta.dataset.action).toBe('swap');
    expect(handle.getState().approvePending).toBe(false);
    handle.destroy();
  });

  it('approve failure (non-rejection) surfaces error toast and clears pending', async () => {
    vi.useFakeTimers();
    const payment = makePayment({
      readAllowance: vi.fn().mockResolvedValue(0n),
      approve: vi.fn().mockRejectedValue(new Error('out of gas')),
    });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="trade-cta"]').click();
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    const toast = document.querySelector('[data-test-id="toast"]');
    expect(toast).not.toBeNull();
    expect(toast.dataset.kind).toBe('error');
    expect(toast.textContent).toMatch(/gas/);
    expect(handle.getState().approvePending).toBe(false);
    handle.destroy();
  });

  it('approve user-rejection (code 4001) does NOT show error toast', async () => {
    vi.useFakeTimers();
    const rejection = Object.assign(new Error('User rejected'), { code: 4001 });
    const payment = makePayment({
      readAllowance: vi.fn().mockResolvedValue(0n),
      approve: vi.fn().mockRejectedValue(rejection),
    });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="trade-cta"]').click();
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('[data-test-id="toast"]')).toBeNull();
    expect(handle.getState().approvePending).toBe(false);
    handle.destroy();
  });

  it('double-click on Approve only triggers one approve call', async () => {
    vi.useFakeTimers();
    let resolveApprove;
    const approveProm = new Promise((r) => {
      resolveApprove = r;
    });
    const payment = makePayment({
      readAllowance: vi.fn().mockResolvedValue(0n),
      approve: vi.fn().mockReturnValue(approveProm),
    });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);
    const cta = container.querySelector('[data-test-id="trade-cta"]');
    cta.click();
    cta.click();
    cta.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(payment.approve).toHaveBeenCalledTimes(1);
    resolveApprove('0xhash');
    await vi.advanceTimersByTimeAsync(0);
    handle.destroy();
  });
});

describe('mountTradePanel — F1.2 swap trigger', () => {
  it('clicking Buy → swap(buy) with quote.minOut and traded-token address', async () => {
    vi.useFakeTimers();
    const payment = makePayment({
      readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n),
    });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="trade-cta"]').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(payment.swap).toHaveBeenCalledTimes(1);
    const arg = payment.swap.mock.calls[0][0];
    expect(arg.router).toBe(CONFIG.contracts.playerRouter);
    expect(arg.side).toBe('buy');
    expect(arg.token).toBe(PLAYER_TOKEN.address);
    expect(arg.amountIn).toBe(5n * 10n ** 18n);
    // 1% default slippage on 50e18 → 49.5e18
    expect(arg.minOut).toBe(495n * 10n ** 17n);
    handle.destroy();
  });

  it('clicking Sell calls swap with side="sell"', async () => {
    vi.useFakeTimers();
    const payment = makePayment({
      readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n),
    });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="side-sell"]').click();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="trade-cta"]').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(payment.swap).toHaveBeenCalledTimes(1);
    expect(payment.swap.mock.calls[0][0].side).toBe('sell');
    handle.destroy();
  });

  it('swap in-flight → CTA shows "Buy…" + disabled', async () => {
    vi.useFakeTimers();
    let resolveSwap;
    const swapProm = new Promise((r) => {
      resolveSwap = r;
    });
    const payment = makePayment({
      readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n),
      swap: vi.fn().mockReturnValue(swapProm),
    });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="trade-cta"]').click();
    await vi.advanceTimersByTimeAsync(0);
    const cta = container.querySelector('[data-test-id="trade-cta"]');
    expect(cta.textContent).toMatch(/Buy…/);
    expect(cta.disabled).toBe(true);
    expect(handle.getState().swapPending).toBe(true);
    resolveSwap('0xhash');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    handle.destroy();
  });

  it('swap success: shows success toast, clears amount, refreshes balance', async () => {
    vi.useFakeTimers();
    const readBalance = vi
      .fn()
      .mockResolvedValueOnce(100n * 10n ** 18n) // initial
      .mockResolvedValue(95n * 10n ** 18n); // post-swap
    const payment = makePayment({
      readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n),
    });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance,
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);
    const initialBalCount = readBalance.mock.calls.length;
    container.querySelector('[data-test-id="trade-cta"]').click();
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
    const toast = document.querySelector('[data-test-id="toast"]');
    expect(toast).not.toBeNull();
    expect(toast.dataset.kind).toBe('info');
    expect(toast.textContent).toMatch(/Swap/);
    // amount cleared
    expect(input.value).toBe('');
    expect(handle.getState().amountStr).toBe('');
    // balance refreshed at least once more
    expect(readBalance.mock.calls.length).toBeGreaterThan(initialBalCount);
    handle.destroy();
  });

  it('swap revert surfaces error toast and clears pending', async () => {
    vi.useFakeTimers();
    const payment = makePayment({
      readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n),
      swap: vi.fn().mockRejectedValue(new Error('execution reverted: minOut not met')),
    });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="trade-cta"]').click();
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    const toast = document.querySelector('[data-test-id="toast"]');
    expect(toast).not.toBeNull();
    expect(toast.dataset.kind).toBe('error');
    expect(toast.textContent).toMatch(/reverted|minOut/);
    expect(handle.getState().swapPending).toBe(false);
    handle.destroy();
  });

  it('swap user-rejection (code 4001) does NOT show error toast', async () => {
    vi.useFakeTimers();
    const rejection = Object.assign(new Error('User denied transaction'), { code: 4001 });
    const payment = makePayment({
      readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n),
      swap: vi.fn().mockRejectedValue(rejection),
    });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="trade-cta"]').click();
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('[data-test-id="toast"]')).toBeNull();
    expect(handle.getState().swapPending).toBe(false);
    // amount NOT cleared on failure
    expect(handle.getState().amountStr).toBe('5');
    handle.destroy();
  });

  it('double-click on Buy only triggers one swap call', async () => {
    vi.useFakeTimers();
    let resolveSwap;
    const swapProm = new Promise((r) => {
      resolveSwap = r;
    });
    const payment = makePayment({
      readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n),
      swap: vi.fn().mockReturnValue(swapProm),
    });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);
    const cta = container.querySelector('[data-test-id="trade-cta"]');
    cta.click();
    cta.click();
    cta.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(payment.swap).toHaveBeenCalledTimes(1);
    resolveSwap('0xhash');
    await vi.advanceTimersByTimeAsync(0);
    handle.destroy();
  });
});

describe('mountTradePanel — F1.2 success toast labels', () => {
  it('sell on player venue: success toast shows country address short-form (not "country")', async () => {
    vi.useFakeTimers();
    const payment = makePayment({
      readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n),
    });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="side-sell"]').click();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="trade-cta"]').click();
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
    const toast = document.querySelector('[data-test-id="toast"]');
    expect(toast).not.toBeNull();
    expect(toast.dataset.kind).toBe('info');
    // Must NOT contain the bare literal "country"; must contain the
    // shortened countryAddress (0xcccc…0001 for PLAYER_TOKEN).
    expect(toast.textContent).not.toMatch(/\bcountry\b/);
    const short = `${PLAYER_TOKEN.countryAddress.slice(0, 6)}…${PLAYER_TOKEN.countryAddress.slice(-4)}`;
    expect(toast.textContent).toContain(short);
    handle.destroy();
  });

  it('sell on country venue: success toast shows PITCH', async () => {
    vi.useFakeTimers();
    const payment = makePayment({
      readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n),
    });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: COUNTRY_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="side-sell"]').click();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="trade-cta"]').click();
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
    const toast = document.querySelector('[data-test-id="toast"]');
    expect(toast).not.toBeNull();
    expect(toast.textContent).toContain('PITCH');
    handle.destroy();
  });
});

describe('MAX_UINT256 constant', () => {
  it('equals 2**256 - 1', () => {
    expect(MAX_UINT256).toBe((1n << 256n) - 1n);
    expect(MAX_UINT256.toString(16).length).toBe(64);
  });
});

// ─── F1.3: player+Buy country-balance hint + Buy country CTA ────────────

describe('disabledReason — F1.3 playerBuy message', () => {
  it('rewrites insufficient-balance message when playerBuy=true', () => {
    const msg = disabledReason({
      walletConnected: true,
      chainId: 8453,
      token: PLAYER_TOKEN,
      contractsReady: true,
      amountWei: 100n * 10n ** 18n,
      balanceWei: 10n ** 18n,
      limitMode: false,
      playerBuy: true,
      countrySymbol: 'BRA',
    });
    expect(msg).toContain('BRA');
    expect(msg).toMatch(/Country panel/i);
    expect(msg).toContain('100');
  });

  it('falls back to "country" word when symbol absent', () => {
    const msg = disabledReason({
      walletConnected: true,
      chainId: 8453,
      token: PLAYER_TOKEN,
      contractsReady: true,
      amountWei: 5n * 10n ** 18n,
      balanceWei: 0n,
      limitMode: false,
      playerBuy: true,
      countrySymbol: null,
    });
    expect(msg).toMatch(/country/i);
  });

  it('keeps generic message when playerBuy=false', () => {
    expect(
      disabledReason({
        walletConnected: true,
        chainId: 8453,
        token: COUNTRY_TOKEN,
        contractsReady: true,
        amountWei: 100n * 10n ** 18n,
        balanceWei: 10n ** 18n,
        limitMode: false,
        playerBuy: false,
      }),
    ).toMatch(/Insufficient/);
  });
});

function makeApiWithTokens(countries = [{ address: PLAYER_TOKEN.countryAddress, symbol: 'BRA' }]) {
  return {
    getConfig: vi.fn().mockResolvedValue(CONFIG),
    getTokens: vi.fn().mockResolvedValue({ players: [], countries }),
  };
}

describe('mountTradePanel — F1.3 country hint block', () => {
  it('renders required/balance hint on player+Buy once quote+balance land', async () => {
    vi.useFakeTimers();
    const payment = makePayment({ readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n) });
    const handle = mountTradePanel(container, {
      apiClient: makeApiWithTokens(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    const hint = container.querySelector('[data-test-id="trade-country-hint"]');
    expect(hint.hidden).toBe(false);
    const required = container.querySelector('[data-test-id="trade-country-required"]').textContent;
    const balance = container.querySelector('[data-test-id="trade-country-balance"]').textContent;
    // amountIn for buy = 5 (the wei we typed); balance = 100; symbol = "BRA"
    expect(required).toContain('5');
    expect(required).toContain('BRA');
    expect(balance).toContain('100');
    expect(balance).toContain('BRA');
    handle.destroy();
  });

  it('hint hidden on country venue', async () => {
    vi.useFakeTimers();
    const payment = makePayment({ readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n) });
    const handle = mountTradePanel(container, {
      apiClient: makeApiWithTokens(),
      token: COUNTRY_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector('[data-test-id="trade-country-hint"]').hidden).toBe(true);
    handle.destroy();
  });

  it('hint hidden on player+Sell (input = player token, not country)', async () => {
    vi.useFakeTimers();
    const payment = makePayment({ readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n) });
    const handle = mountTradePanel(container, {
      apiClient: makeApiWithTokens(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="side-sell"]').click();
    for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector('[data-test-id="trade-country-hint"]').hidden).toBe(true);
    handle.destroy();
  });

  it('hides hint while quote is stale (debounce window)', async () => {
    vi.useFakeTimers();
    const payment = makePayment({ readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n) });
    const handle = mountTradePanel(container, {
      apiClient: makeApiWithTokens(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    // First quote for amount '5' resolves → hint visible.
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    const hint = container.querySelector('[data-test-id="trade-country-hint"]');
    expect(hint.hidden).toBe(false);
    // User types '10' but debounce hasn't flushed → state.quote still holds
    // amountInWei for '5'. Hint must hide because the quote is stale.
    input.value = '10';
    input.dispatchEvent(new Event('input'));
    // Do NOT advance past debounceMs; only flush microtasks so renderHint runs.
    await vi.advanceTimersByTimeAsync(0);
    expect(hint.hidden).toBe(true);
    handle.destroy();
  });
});

describe('mountTradePanel — F1.3 insufficient-country CTA', () => {
  it('shows explicit message + "Buy BRA" CTA when player+Buy insufficient', async () => {
    vi.useFakeTimers();
    const onCountrySwitch = vi.fn();
    const payment = makePayment({ readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n) });
    const handle = mountTradePanel(container, {
      apiClient: makeApiWithTokens(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(1n * 10n ** 18n), // only 1 country
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
      onCountrySwitch,
    });
    await wallet.connectWallet('injected');
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '100'; // > 1 balance
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);

    const cta = container.querySelector('[data-test-id="trade-cta"]');
    const status = container.querySelector('[data-test-id="trade-status"]');
    expect(cta.disabled).toBe(true);
    expect(status.textContent).toContain('100');
    expect(status.textContent).toContain('BRA');
    expect(status.textContent).toMatch(/Country panel/i);

    const countryCta = container.querySelector('[data-test-id="trade-country-cta"]');
    expect(countryCta.hidden).toBe(false);
    expect(countryCta.textContent).toContain('BRA');
    handle.destroy();
  });

  it('clicking Buy country CTA fires onCountrySwitch with the country address', async () => {
    vi.useFakeTimers();
    const onCountrySwitch = vi.fn();
    const payment = makePayment({ readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n) });
    const handle = mountTradePanel(container, {
      apiClient: makeApiWithTokens(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(1n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
      onCountrySwitch,
    });
    await wallet.connectWallet('injected');
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '100';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);

    const countryCta = container.querySelector('[data-test-id="trade-country-cta"]');
    expect(countryCta.hidden).toBe(false);
    countryCta.click();
    expect(onCountrySwitch).toHaveBeenCalledTimes(1);
    expect(onCountrySwitch.mock.calls[0][0]).toBe(PLAYER_TOKEN.countryAddress.toLowerCase());
    handle.destroy();
  });

  it('Buy country CTA hidden when balance is sufficient', async () => {
    vi.useFakeTimers();
    const onCountrySwitch = vi.fn();
    const payment = makePayment({ readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n) });
    const handle = mountTradePanel(container, {
      apiClient: makeApiWithTokens(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(1000n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
      onCountrySwitch,
    });
    await wallet.connectWallet('injected');
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector('[data-test-id="trade-country-cta"]').hidden).toBe(true);
    handle.destroy();
  });

  it('Buy country CTA hidden when onCountrySwitch is not wired', async () => {
    vi.useFakeTimers();
    const payment = makePayment({ readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n) });
    const handle = mountTradePanel(container, {
      apiClient: makeApiWithTokens(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(1n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
      // onCountrySwitch intentionally omitted
    });
    await wallet.connectWallet('injected');
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '100';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector('[data-test-id="trade-country-cta"]').hidden).toBe(true);
    handle.destroy();
  });

  it('Buy country CTA hidden on country venue (insufficient PITCH)', async () => {
    vi.useFakeTimers();
    const onCountrySwitch = vi.fn();
    const payment = makePayment({ readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n) });
    const handle = mountTradePanel(container, {
      apiClient: makeApiWithTokens(),
      token: COUNTRY_TOKEN,
      readBalance: vi.fn().mockResolvedValue(1n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
      onCountrySwitch,
    });
    await wallet.connectWallet('injected');
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '100';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector('[data-test-id="trade-country-cta"]').hidden).toBe(true);
    handle.destroy();
  });
});

describe('mountTradePanel — F1.3 balance line symbol', () => {
  it('player+Buy balance line shows the country symbol', async () => {
    vi.useFakeTimers();
    const payment = makePayment();
    const handle = mountTradePanel(container, {
      apiClient: makeApiWithTokens(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(7n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    const txt = container.querySelector('[data-test-id="trade-balance"]').textContent;
    expect(txt).toContain('7');
    expect(txt).toContain('BRA');
    handle.destroy();
  });

  it('country venue Buy balance line shows PITCH', async () => {
    vi.useFakeTimers();
    const payment = makePayment();
    const handle = mountTradePanel(container, {
      apiClient: makeApiWithTokens(),
      token: COUNTRY_TOKEN,
      readBalance: vi.fn().mockResolvedValue(42n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    const txt = container.querySelector('[data-test-id="trade-balance"]').textContent;
    expect(txt).toContain('42');
    expect(txt).toContain('PITCH');
    handle.destroy();
  });
});

// ─── F1.4: Basescan link in swap-success toast ─────────────────────────────

describe('mountTradePanel — F1.4 swap-success Basescan link', () => {
  it('renders a Basescan anchor with the tx hash returned by payment.swap', async () => {
    vi.useFakeTimers();
    const txHash = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    const payment = makePayment({
      readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n),
      swap: vi.fn().mockResolvedValue(txHash),
    });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="trade-cta"]').click();
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
    const anchor = document.querySelector('[data-test-id="toast-link"]');
    expect(anchor).not.toBeNull();
    expect(anchor.getAttribute('href')).toBe(`https://basescan.org/tx/${txHash}`);
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
    expect(anchor.textContent).toMatch(/Basescan/i);
    handle.destroy();
  });

  it('omits link when swap returns a non-hash value', async () => {
    vi.useFakeTimers();
    const payment = makePayment({
      readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n),
      swap: vi.fn().mockResolvedValue(undefined), // legacy stub
    });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="trade-cta"]').click();
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
    const toast = document.querySelector('[data-test-id="toast"]');
    expect(toast).not.toBeNull();
    expect(toast.textContent).toMatch(/Swap/);
    expect(document.querySelector('[data-test-id="toast-link"]')).toBeNull();
    handle.destroy();
  });
});

// ─── F1.4: countrySymbol threaded via setToken ─────────────────────────────

describe('mountTradePanel — F1.4 countrySymbol threading', () => {
  it('uses token.countrySymbol when threaded (no getTokens fetch needed)', async () => {
    vi.useFakeTimers();
    const payment = makePayment();
    const tokenWithSymbol = { ...PLAYER_TOKEN, countrySymbol: 'BRA' };
    // Deliberately omit getTokens from the API client — threading should
    // make the panel work without it.
    const handle = mountTradePanel(container, {
      apiClient: makeApi(), // no getTokens stub
      token: tokenWithSymbol,
      readBalance: vi.fn().mockResolvedValue(7n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    const txt = container.querySelector('[data-test-id="trade-balance"]').textContent;
    expect(txt).toContain('BRA');
    handle.destroy();
  });

  it('threaded symbol wins over countrySymbolMap', async () => {
    vi.useFakeTimers();
    const payment = makePayment();
    // Map says "OLD", threaded says "NEW" — threaded wins.
    const apiWithStaleMap = {
      getConfig: vi.fn().mockResolvedValue(CONFIG),
      getTokens: vi.fn().mockResolvedValue({
        players: [],
        countries: [{ address: PLAYER_TOKEN.countryAddress, symbol: 'OLD' }],
      }),
    };
    const tokenWithSymbol = { ...PLAYER_TOKEN, countrySymbol: 'NEW' };
    const handle = mountTradePanel(container, {
      apiClient: apiWithStaleMap,
      token: tokenWithSymbol,
      readBalance: vi.fn().mockResolvedValue(7n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
    const txt = container.querySelector('[data-test-id="trade-balance"]').textContent;
    expect(txt).toContain('NEW');
    expect(txt).not.toContain('OLD');
    handle.destroy();
  });

  it('falls back to countrySymbolMap when threaded symbol is absent', async () => {
    vi.useFakeTimers();
    const payment = makePayment();
    const handle = mountTradePanel(container, {
      apiClient: makeApiWithTokens(),
      token: PLAYER_TOKEN, // no countrySymbol on the token
      readBalance: vi.fn().mockResolvedValue(7n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
    const txt = container.querySelector('[data-test-id="trade-balance"]').textContent;
    // makeApiWithTokens defaults to "BRA" for the player's country address.
    expect(txt).toContain('BRA');
    handle.destroy();
  });

  it('player+Sell success toast uses threaded country symbol (not shortened address)', async () => {
    vi.useFakeTimers();
    const txHash = '0xfeed0000000000000000000000000000000000000000000000000000000000ed';
    const payment = makePayment({
      readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n),
      swap: vi.fn().mockResolvedValue(txHash),
    });
    const tokenWithSymbol = { ...PLAYER_TOKEN, countrySymbol: 'BRA' };
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: tokenWithSymbol,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="side-sell"]').click();
    for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="trade-cta"]').click();
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
    const toast = document.querySelector('[data-test-id="toast"]');
    expect(toast).not.toBeNull();
    expect(toast.textContent).toContain('BRA');
    expect(toast.textContent).not.toContain('0xcccc');
    handle.destroy();
  });
});

// ─── F1.4: config retry with exponential backoff ───────────────────────────

describe('mountTradePanel — F1.4 config retry', () => {
  it('retries getConfig with backoff and recovers on later attempt', async () => {
    vi.useFakeTimers();
    const getConfig = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(CONFIG);
    const handle = mountTradePanel(container, {
      apiClient: { getConfig },
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment: makePayment(),
      debounceMs: 50,
    });
    // First attempt synchronously.
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(handle.getState().contracts).toBeNull();
    // First retry @ 1000ms.
    await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    expect(getConfig).toHaveBeenCalledTimes(2);
    // Second retry @ +2000ms — this one resolves.
    await vi.advanceTimersByTimeAsync(2000);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    expect(getConfig).toHaveBeenCalledTimes(3);
    expect(handle.getState().contracts).not.toBeNull();
    handle.destroy();
  });

  it('after 5 failed retries shows a reload toast', async () => {
    vi.useFakeTimers();
    const getConfig = vi.fn().mockRejectedValue(new Error('persistent'));
    const handle = mountTradePanel(container, {
      apiClient: { getConfig },
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment: makePayment(),
      debounceMs: 50,
    });
    // Walk through all 5 retries: 1s, 2s, 4s, 8s, 16s — total 31s + initial.
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4000);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(8000);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(16000);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    // 1 initial + 5 retries = 6 total.
    expect(getConfig).toHaveBeenCalledTimes(6);
    const toast = document.querySelector('[data-test-id="toast"]');
    expect(toast).not.toBeNull();
    expect(toast.dataset.kind).toBe('error');
    expect(toast.textContent).toMatch(/Reload/i);
    handle.destroy();
  });

  it('does not retry after destroy() — pending timers cleared', async () => {
    vi.useFakeTimers();
    const getConfig = vi.fn().mockRejectedValue(new Error('boom'));
    const handle = mountTradePanel(container, {
      apiClient: { getConfig },
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(0n),
      readQuote: vi.fn().mockResolvedValue(0n),
      payment: makePayment(),
      debounceMs: 50,
    });
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    expect(getConfig).toHaveBeenCalledTimes(1);
    handle.destroy();
    // Advance far past every backoff — no further calls should fire.
    await vi.advanceTimersByTimeAsync(60000);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    expect(getConfig).toHaveBeenCalledTimes(1);
  });

  it('does not apply config after destroy() if fetch resolves post-teardown', async () => {
    vi.useFakeTimers();
    let resolveCfg;
    const getConfig = vi.fn(
      () =>
        new Promise((r) => {
          resolveCfg = r;
        }),
    );
    const handle = mountTradePanel(container, {
      apiClient: { getConfig },
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(0n),
      readQuote: vi.fn().mockResolvedValue(0n),
      payment: makePayment(),
      debounceMs: 50,
    });
    // Let mount fire getConfig (which is pending).
    for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(0);
    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(handle.getState().contracts).toBeNull();
    // Tear down BEFORE the promise resolves.
    handle.destroy();
    // Now resolve the in-flight fetch — destroyed guard must short-circuit
    // applyContracts so state.contracts stays null and the container stays
    // empty (no DOM mutation post-destroy).
    resolveCfg(CONFIG);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    expect(handle.getState().contracts).toBeNull();
    expect(container.querySelector('[data-test-id="trade-panel"]')).toBeNull();
  });

  it('does not schedule a retry after destroy() if fetch rejects post-teardown', async () => {
    vi.useFakeTimers();
    let rejectCfg;
    const getConfig = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectCfg = reject;
        }),
    );
    const handle = mountTradePanel(container, {
      apiClient: { getConfig },
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(0n),
      readQuote: vi.fn().mockResolvedValue(0n),
      payment: makePayment(),
      debounceMs: 50,
    });
    for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(0);
    expect(getConfig).toHaveBeenCalledTimes(1);
    handle.destroy();
    // Reject AFTER destroy — destroyed guard must skip the retry-schedule.
    rejectCfg(new Error('late fail'));
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    // No retry scheduled → no additional call after advancing past 1s.
    await vi.advanceTimersByTimeAsync(2000);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    expect(getConfig).toHaveBeenCalledTimes(1);
    // No reload-toast either (retry exhaustion guarded as well).
    expect(document.querySelector('[data-test-id="toast"]')).toBeNull();
  });
});

// ─── F1.4: stale-quote invalidation on chain switch ────────────────────────

describe('mountTradePanel — F1.4 chain switch invalidates quote', () => {
  it('clears state.quote when chainId changes', async () => {
    vi.useFakeTimers();
    const payment = makePayment({ readAllowance: vi.fn().mockResolvedValue(1000n * 10n ** 18n) });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    const input = container.querySelector('[data-test-id="trade-amount"]');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    expect(handle.getState().quote).not.toBeNull();
    // Simulate chain switch via wagmi mock.
    const { switchChain } = await import('@wagmi/core');
    await switchChain({}, { chainId: 1 }); // Off Base → onAccountChange fires
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
    expect(handle.getState().quote).toBeNull();
    handle.destroy();
  });
});

// ─── Phase 1.5 batch 5: Pro upsell cover ───────────────────────────────────

describe('mountTradePanel — batch 5 pro-cover', () => {
  it('renders cover overlay DOM (icon, title, feature list, price, CTA)', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      // Force-locked state via a deterministic getter — independent of the
      // module-level access-store singleton (which the suite doesn't reset).
      getAccessState: () => 'free',
      subscribeAccess: () => () => {},
    });
    await flush();
    const cover = container.querySelector('[data-test-id="trade-cover"]');
    expect(cover).toBeTruthy();
    expect(cover.hidden).toBe(false);
    expect(container.querySelector('[data-test-id="trade-cover-title"]').textContent).toMatch(
      /Pro/i,
    );
    expect(container.querySelector('[data-test-id="trade-cover-price"]').textContent).toMatch(
      /1 PITCH/,
    );
    // Feature list — 4 bullets per mockup.
    const feats = cover.querySelectorAll('.pt-trade__cover-feats li');
    expect(feats.length).toBe(4);
    // CTA button is wired.
    expect(container.querySelector('[data-test-id="trade-cover-cta"]')).toBeTruthy();
    handle.destroy();
  });

  it('hides cover when access state is premium', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await flush();
    const cover = container.querySelector('[data-test-id="trade-cover"]');
    expect(cover.hidden).toBe(true);
    expect(container.querySelector('[data-test-id="trade-panel"]').classList.contains('is-locked')).toBe(
      false,
    );
    handle.destroy();
  });

  it('shows the head lock icon and adds is-locked when not premium', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      getAccessState: () => 'free',
      subscribeAccess: () => () => {},
    });
    await flush();
    const lock = container.querySelector('[data-test-id="trade-head-lock"]');
    expect(lock.hidden).toBe(false);
    expect(
      container.querySelector('[data-test-id="trade-panel"]').classList.contains('is-locked'),
    ).toBe(true);
    handle.destroy();
  });

  it('clicking the upsell CTA invokes the openPayModal factory', async () => {
    const openPayModal = vi.fn();
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      getAccessState: () => 'free',
      subscribeAccess: () => () => {},
      openPayModal,
    });
    await flush();
    container.querySelector('[data-test-id="trade-cover-cta"]').click();
    expect(openPayModal).toHaveBeenCalledTimes(1);
    handle.destroy();
  });

  it('subscribes to access-store transitions and flips cover on state change', async () => {
    // Drive renders via a manual subscriber so we can assert the cover flips
    // without mutating the real access-store singleton.
    let listener = null;
    let currentState = 'free';
    const subscribeAccess = vi.fn((fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      getAccessState: () => currentState,
      subscribeAccess,
    });
    await flush();
    const cover = container.querySelector('[data-test-id="trade-cover"]');
    expect(cover.hidden).toBe(false);
    // Transition to premium and fire the listener — cover must hide.
    currentState = 'premium';
    listener('premium');
    expect(cover.hidden).toBe(true);
    // Back to free → cover comes back.
    currentState = 'free';
    listener('free');
    expect(cover.hidden).toBe(false);
    handle.destroy();
    // destroy() must unsubscribe.
    expect(listener).toBeNull();
  });

  it('proCoverEnabled:false hides the cover regardless of state', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      proCoverEnabled: false,
      getAccessState: () => 'free',
    });
    await flush();
    expect(container.querySelector('[data-test-id="trade-cover"]').hidden).toBe(true);
    expect(
      container.querySelector('[data-test-id="trade-panel"]').classList.contains('is-locked'),
    ).toBe(false);
    handle.destroy();
  });

  it('head label updates with the selected token symbol', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      proCoverEnabled: false,
    });
    await flush();
    const label = container.querySelector('[data-test-id="trade-head-label"]');
    expect(label.textContent).toBe('Trade');
    handle.setToken(PLAYER_TOKEN);
    expect(label.textContent).toBe('Trade · PLR');
    handle.destroy();
  });

  it('isLocked() handle returns false when premium, true when locked', async () => {
    const lockedHandle = mountTradePanel(container, {
      apiClient: makeApi(),
      getAccessState: () => 'free',
      subscribeAccess: () => () => {},
    });
    await flush();
    expect(lockedHandle.isLocked()).toBe(true);
    lockedHandle.destroy();
    document.body.replaceChildren();
    container = document.createElement('div');
    document.body.appendChild(container);
    const premiumHandle = mountTradePanel(container, {
      apiClient: makeApi(),
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await flush();
    expect(premiumHandle.isLocked()).toBe(false);
    premiumHandle.destroy();
  });
});

// ─── F2.x — Limit-order mode + EIP-712 sign + POST /orders ─────────────────

// Use a valid hex token for limit-mode tests so `validateOrderShape` accepts
// the address. The shared `PLAYER_TOKEN` fixture uses an unrelated placeholder
// (`0xpppp…`) — fine for market-mode tests that never validate address shape,
// but rejected by the limit-mode pre-sign guard.
const VALID_PLAYER_TOKEN = {
  address: '0x3333333333333333333333333333333333333333',
  symbol: 'PLR',
  countryAddress: '0x4444444444444444444444444444444444444444',
};

describe('disabledReasonLimit', () => {
  const base = {
    walletConnected: true,
    chainId: 8453,
    token: VALID_PLAYER_TOKEN,
    contractsReady: true,
    executorReady: true,
    amountWei: 10n ** 18n,
    triggerPriceWei: 10n ** 18n,
    slippageBps: 100,
    premium: true,
  };

  it('returns null when everything is ready', () => {
    expect(disabledReasonLimit(base)).toBeNull();
  });

  it('submitting beats all other reasons', () => {
    expect(disabledReasonLimit({ ...base, submitting: true, walletConnected: false })).toMatch(
      /sign/i,
    );
  });

  it('flags non-premium', () => {
    expect(disabledReasonLimit({ ...base, premium: false })).toMatch(/Premium/i);
  });

  it('flags missing executor address', () => {
    expect(disabledReasonLimit({ ...base, executorReady: false })).toMatch(/contract/i);
  });

  it('flags missing trigger price', () => {
    expect(disabledReasonLimit({ ...base, triggerPriceWei: null })).toMatch(/trigger/i);
    expect(disabledReasonLimit({ ...base, triggerPriceWei: 0n })).toMatch(/trigger/i);
  });

  it('flags missing amount', () => {
    expect(disabledReasonLimit({ ...base, amountWei: null })).toMatch(/amount/i);
  });

  it('flags out-of-range slippage', () => {
    expect(disabledReasonLimit({ ...base, slippageBps: 1500 })).toMatch(/Slippage/);
  });

  it('flags wrong chain', () => {
    expect(disabledReasonLimit({ ...base, chainId: 1 })).toMatch(/Base/);
  });
});

describe('mountTradePanel — F2.x limit mode', () => {
  it('toggling limit mode hides the market quote block', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: VALID_PLAYER_TOKEN,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    expect(container.querySelector('[data-test-id="trade-limit"]').hidden).toBe(false);
    expect(container.querySelector('[data-test-id="trade-quote"]').hidden).toBe(true);
    expect(container.querySelector('[data-test-id="trade-cta"]').textContent).toMatch(/limit-buy/i);
    handle.destroy();
  });

  it('limit CTA stays disabled until amount + trigger price are entered', async () => {
    const createOrder = vi.fn().mockResolvedValue({ id: '1' });
    const handle = mountTradePanel(container, {
      apiClient: { ...makeApi(), createOrder },
      token: VALID_PLAYER_TOKEN,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await wallet.connectWallet('injected');
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    await flush();
    const cta = container.querySelector('[data-test-id="trade-cta"]');
    expect(cta.disabled).toBe(true);

    // Enter amount only — still disabled (no trigger price).
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '1';
    amount.dispatchEvent(new Event('input'));
    expect(cta.disabled).toBe(true);

    // Enter trigger price — now enabled.
    const trigger = container.querySelector('[data-test-id="trade-limit-price"]');
    trigger.value = '12.5';
    trigger.dispatchEvent(new Event('input'));
    expect(cta.disabled).toBe(false);
    handle.destroy();
  });

  it('non-premium user sees Premium reason on limit CTA', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: VALID_PLAYER_TOKEN,
      proCoverEnabled: false, // skip cover so DOM is queryable
      getAccessState: () => 'free',
      subscribeAccess: () => () => {},
    });
    await wallet.connectWallet('injected');
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '1';
    amount.dispatchEvent(new Event('input'));
    const trigger = container.querySelector('[data-test-id="trade-limit-price"]');
    trigger.value = '12.5';
    trigger.dispatchEvent(new Event('input'));
    const status = container.querySelector('[data-test-id="trade-status"]');
    expect(status.textContent).toMatch(/Premium/i);
    handle.destroy();
  });

  it('submitting signs typedData then POSTs /orders', async () => {
    const signTypedData = vi.fn().mockResolvedValue('0x' + 'ab'.repeat(65));
    const createOrder = vi.fn().mockResolvedValue({ id: '1', status: 'pending' });
    const handle = mountTradePanel(container, {
      apiClient: { ...makeApi(), createOrder },
      token: VALID_PLAYER_TOKEN,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
      signTypedData,
      // Wave 3 — pre-approved executor allowance so CTA goes straight to sign.
      readAllowance: vi.fn().mockResolvedValue(MAX_UINT256),
    });
    await wallet.connectWallet('injected');
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    await flush(); // Wave 3 — let the executor-allowance read settle.
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '1';
    amount.dispatchEvent(new Event('input'));
    const trigger = container.querySelector('[data-test-id="trade-limit-price"]');
    trigger.value = '12.5';
    trigger.dispatchEvent(new Event('input'));

    container.querySelector('[data-test-id="trade-cta"]').click();
    // Let the async chain resolve (sign → post).
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(signTypedData).toHaveBeenCalledTimes(1);
    const signArg = signTypedData.mock.calls[0][0];
    expect(signArg.account).toBeDefined();
    expect(signArg.typedData.primaryType).toBe('Order');
    expect(signArg.typedData.domain.name).toBe('PitchTerminal LimitOrders');
    expect(signArg.typedData.domain.verifyingContract).toBe(
      '0xb22f38a0c133a32ab9582ace9e2da41d1738b9d5',
    );
    // Wave 2A — user types DISPLAY-space (12.5 = MID). The signed targetPrice
    // is the execution-space ASK = display × 10000 / 9500 (limit-buy).
    const expectedSignedBuy = (12500000000000000000n * 10000n) / 9500n;
    expect(signArg.typedData.message.targetPrice).toBe(expectedSignedBuy);
    expect(signArg.typedData.message.amountIn).toBe(1000000000000000000n);
    // Player venue + Buy side → venue 0, side 0.
    expect(signArg.typedData.message.venue).toBe(0);
    expect(signArg.typedData.message.side).toBe(0);

    expect(createOrder).toHaveBeenCalledTimes(1);
    const [orderPayload, signature] = createOrder.mock.calls[0];
    expect(signature).toMatch(/^0xab/);
    // Wire payload carries BOTH: signed (execution) and display (MID).
    expect(orderPayload.targetPrice).toBe(expectedSignedBuy.toString());
    expect(orderPayload.displayTargetPrice).toBe('12500000000000000000');
    expect(orderPayload.amountIn).toBe('1000000000000000000');
    expect(orderPayload.token).toBe(VALID_PLAYER_TOKEN.address.toLowerCase());
    expect(orderPayload.quoteToken).toBe(VALID_PLAYER_TOKEN.countryAddress.toLowerCase());

    // Trigger price input cleared on success.
    expect(handle.getState().limitTriggerPriceStr).toBe('');
    handle.destroy();
  });

  it('user-rejected signature does NOT surface an error', async () => {
    const rejection = Object.assign(new Error('User rejected'), { code: 4001 });
    const signTypedData = vi.fn().mockRejectedValue(rejection);
    const createOrder = vi.fn();
    const handle = mountTradePanel(container, {
      apiClient: { ...makeApi(), createOrder },
      token: VALID_PLAYER_TOKEN,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
      signTypedData,
      readAllowance: vi.fn().mockResolvedValue(MAX_UINT256),
    });
    await wallet.connectWallet('injected');
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    await flush();
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '1';
    amount.dispatchEvent(new Event('input'));
    const trigger = container.querySelector('[data-test-id="trade-limit-price"]');
    trigger.value = '12.5';
    trigger.dispatchEvent(new Event('input'));
    container.querySelector('[data-test-id="trade-cta"]').click();
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(createOrder).not.toHaveBeenCalled();
    expect(handle.getState().limitError).toBeNull();
    handle.destroy();
  });

  it('server error sets limitError and keeps form intact', async () => {
    const signTypedData = vi.fn().mockResolvedValue('0x' + 'ab'.repeat(65));
    const apiErr = Object.assign(new Error('bad target'), {
      status: 422,
      detail: 'target already in range',
    });
    const createOrder = vi.fn().mockRejectedValue(apiErr);
    const handle = mountTradePanel(container, {
      apiClient: { ...makeApi(), createOrder },
      token: VALID_PLAYER_TOKEN,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
      signTypedData,
      readAllowance: vi.fn().mockResolvedValue(MAX_UINT256),
    });
    await wallet.connectWallet('injected');
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    await flush();
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '1';
    amount.dispatchEvent(new Event('input'));
    const trigger = container.querySelector('[data-test-id="trade-limit-price"]');
    trigger.value = '12.5';
    trigger.dispatchEvent(new Event('input'));
    container.querySelector('[data-test-id="trade-cta"]').click();
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(handle.getState().limitError).toBeTruthy();
    // Trigger price NOT cleared — user can fix and resubmit.
    expect(handle.getState().limitTriggerPriceStr).toBe('12.5');
    handle.destroy();
  });
});

// B3 — F2.x #9: trigger-price label spells out the quote currency so users
// don't enter PITCH-denominated values into a country-unit field (player
// venue) or vice-versa. Denomination depends on venue, NOT on side.
describe('mountTradePanel — B3 venue-aware trigger-price label', () => {
  const VALID_COUNTRY_TOKEN = {
    address: '0x5555555555555555555555555555555555555555',
    symbol: 'BRA',
    // no countryAddress → country venue (quote = PITCH)
  };
  const VALID_PLAYER_TOKEN_BRA = {
    address: '0x6666666666666666666666666666666666666666',
    symbol: 'PLR',
    countryAddress: '0x7777777777777777777777777777777777777777',
    countrySymbol: 'BRA',
  };

  it('country venue: label reads "Trigger price (PITCH per 1 BRA)"', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: VALID_COUNTRY_TOKEN,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    await flush();
    const label = container.querySelector('[data-test-id="trade-limit-price-label"]');
    expect(label.textContent).toBe('Trigger price (PITCH per 1 BRA)');
    handle.destroy();
  });

  it('player venue: label reads "Trigger price ({country} per 1 {player})"', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: VALID_PLAYER_TOKEN_BRA,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    await flush();
    const label = container.querySelector('[data-test-id="trade-limit-price-label"]');
    expect(label.textContent).toBe('Trigger price (BRA per 1 PLR)');
    handle.destroy();
  });

  it('label does NOT change with side toggle — denomination is venue-only', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: VALID_PLAYER_TOKEN_BRA,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    await flush();
    const label = container.querySelector('[data-test-id="trade-limit-price-label"]');
    const buyText = label.textContent;
    container.querySelector('[data-test-id="side-sell"]').click();
    await flush();
    expect(label.textContent).toBe(buyText);
    handle.destroy();
  });

  it('label updates after a token swap (player → country)', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: VALID_PLAYER_TOKEN_BRA,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    await flush();
    const label = container.querySelector('[data-test-id="trade-limit-price-label"]');
    expect(label.textContent).toBe('Trigger price (BRA per 1 PLR)');
    handle.setToken(VALID_COUNTRY_TOKEN);
    await flush();
    expect(label.textContent).toBe('Trigger price (PITCH per 1 BRA)');
    handle.destroy();
  });

  it('falls back to plain "Trigger price" when no token is set', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      // No token at all → resolveVenue returns null.
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    await flush();
    const label = container.querySelector('[data-test-id="trade-limit-price-label"]');
    expect(label.textContent).toBe('Trigger price');
    handle.destroy();
  });
});

// Wave 2A — fee-breakdown UI under the amount input. Visible in BOTH market
// and limit modes once amount > 0 + token meta (pricePitch / priceCountry) is
// available.
describe('mountTradePanel — Wave 2A fee breakdown', () => {
  const COUNTRY_TOKEN_WITH_PRICE = {
    address: '0xaaaa000000000000000000000000000000000001',
    symbol: 'BRA',
    pricePitch: 0.5, // MID = 0.5 PITCH per 1 BRA
  };
  const PLAYER_TOKEN_WITH_PRICE = {
    address: '0xbbbb000000000000000000000000000000000001',
    symbol: 'PLR',
    countryAddress: '0xcccc000000000000000000000000000000000001',
    countrySymbol: 'BRA',
    priceCountry: 2, // MID = 2 BRA per 1 PLR
  };

  it('Buy on country venue: shows "Spending X PITCH → ≈ net BRA" with naive + fee', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: COUNTRY_TOKEN_WITH_PRICE,
      proCoverEnabled: false,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await flush();
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '1';
    amount.dispatchEvent(new Event('input'));
    const block = container.querySelector('[data-test-id="fee-breakdown"]');
    expect(block.hidden).toBe(false);
    const headline = container.querySelector('[data-test-id="fee-breakdown-headline"]');
    const math = container.querySelector('[data-test-id="fee-breakdown-math"]');
    // amount = 1 PITCH, MID = 0.5 → naive base = 2 BRA, fee 5% = 0.1, net 1.9
    expect(headline.textContent).toContain('Spending');
    expect(headline.textContent).toContain('1 PITCH');
    expect(headline.textContent).toContain('1.9 BRA');
    expect(math.textContent).toContain('naive 2 BRA');
    expect(math.textContent).toContain('5.0% fee');
    expect(math.textContent).toContain('0.1 BRA');
    handle.destroy();
  });

  it('Sell on country venue: "Selling X BRA → ≈ net PITCH"', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: COUNTRY_TOKEN_WITH_PRICE,
      proCoverEnabled: false,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await flush();
    container.querySelector('[data-test-id="side-sell"]').click();
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '2';
    amount.dispatchEvent(new Event('input'));
    const headline = container.querySelector('[data-test-id="fee-breakdown-headline"]');
    // amount = 2 BRA, MID = 0.5 → naive quote = 1 PITCH, fee 5% = 0.05, net 0.95
    expect(headline.textContent).toContain('Selling');
    expect(headline.textContent).toContain('2 BRA');
    expect(headline.textContent).toContain('0.95 PITCH');
    handle.destroy();
  });

  it('hides when no amount entered', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: COUNTRY_TOKEN_WITH_PRICE,
      proCoverEnabled: false,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await flush();
    const block = container.querySelector('[data-test-id="fee-breakdown"]');
    expect(block.hidden).toBe(true);
    handle.destroy();
  });

  it('hides when token has no price meta', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: { ...COUNTRY_TOKEN_WITH_PRICE, pricePitch: null },
      proCoverEnabled: false,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await flush();
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '1';
    amount.dispatchEvent(new Event('input'));
    const block = container.querySelector('[data-test-id="fee-breakdown"]');
    expect(block.hidden).toBe(true);
    handle.destroy();
  });

  it('player venue uses priceCountry MID + country symbol in breakdown', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN_WITH_PRICE,
      proCoverEnabled: false,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await flush();
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '4'; // Buy: spending 4 BRA, MID = 2 → naive 2 PLR, net 1.9 PLR
    amount.dispatchEvent(new Event('input'));
    const headline = container.querySelector('[data-test-id="fee-breakdown-headline"]');
    expect(headline.textContent).toContain('4 BRA');
    expect(headline.textContent).toContain('1.9 PLR');
    handle.destroy();
  });
});

// Wave 3 — limit-mode fee breakdown must reflect the user's target price,
// not current MID. Market mode keeps its existing behaviour (uses MID).
describe('mountTradePanel — Wave 3 fee breakdown in limit mode', () => {
  const COUNTRY_TOKEN = {
    address: '0xeeee000000000000000000000000000000000001',
    symbol: 'BRA',
    pricePitch: 0.5, // current MID = 0.5 PITCH per BRA
  };

  it('market-mode breakdown is based on current MID (baseline)', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: COUNTRY_TOKEN,
      proCoverEnabled: false,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await flush();
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '1';
    amount.dispatchEvent(new Event('input'));
    const headline = container.querySelector('[data-test-id="fee-breakdown-headline"]');
    // MID = 0.5 → 1 PITCH buys naive 2 BRA, net 1.9 BRA after 5% fee.
    expect(headline.textContent).toContain('1 PITCH');
    expect(headline.textContent).toContain('1.9 BRA');
    handle.destroy();
  });

  it('limit-mode with empty target shows placeholder, no MID numbers', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: COUNTRY_TOKEN,
      proCoverEnabled: false,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '1';
    amount.dispatchEvent(new Event('input'));
    const block = container.querySelector('[data-test-id="fee-breakdown"]');
    const headline = container.querySelector('[data-test-id="fee-breakdown-headline"]');
    const math = container.querySelector('[data-test-id="fee-breakdown-math"]');
    // Placeholder visible, but no MID-based numbers shown.
    expect(block.hidden).toBe(false);
    expect(headline.textContent.toLowerCase()).toContain('trigger price');
    expect(headline.textContent).not.toContain('1.9');
    expect(headline.textContent).not.toContain('2 BRA');
    expect(math.textContent).toBe('');
    handle.destroy();
  });

  it('limit-mode with target=10 computes breakdown against 10, not MID', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: COUNTRY_TOKEN, // current MID = 0.5
      proCoverEnabled: false,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '1';
    amount.dispatchEvent(new Event('input'));
    const trigger = container.querySelector('[data-test-id="trade-limit-price"]');
    trigger.value = '10'; // limit-buy at 10 PITCH per BRA
    trigger.dispatchEvent(new Event('input'));
    const headline = container.querySelector('[data-test-id="fee-breakdown-headline"]');
    const math = container.querySelector('[data-test-id="fee-breakdown-math"]');
    // At target=10: naive base = 1 / 10 = 0.1 BRA, fee 5% = 0.005, net 0.095 BRA.
    // Specifically NOT the MID-based 1.9 BRA (which would imply MID=0.5).
    expect(headline.textContent).toContain('1 PITCH');
    expect(headline.textContent).toContain('0.095 BRA');
    expect(headline.textContent).not.toContain('1.9 BRA');
    expect(math.textContent).toContain('naive 0.1 BRA');
    expect(math.textContent).toContain('0.005 BRA');
    handle.destroy();
  });

  it('limit-buy at target=10 with MID=4.05 yields smaller out than market would', async () => {
    const TOKEN_HIGH_MID = { ...COUNTRY_TOKEN, pricePitch: 4.05 };
    // Market: 1 PITCH / 4.05 ≈ 0.2469 BRA naive, net ≈ 0.2346
    // Limit @ 10: 1 PITCH / 10 = 0.1 BRA naive, net = 0.095 — clearly smaller.
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: TOKEN_HIGH_MID,
      proCoverEnabled: false,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '1';
    amount.dispatchEvent(new Event('input'));
    const trigger = container.querySelector('[data-test-id="trade-limit-price"]');
    trigger.value = '10';
    trigger.dispatchEvent(new Event('input'));
    const headline = container.querySelector('[data-test-id="fee-breakdown-headline"]');
    // Breakdown reflects the limit target (0.095 BRA), not market (~0.2346 BRA).
    expect(headline.textContent).toContain('0.095 BRA');
    expect(headline.textContent).not.toContain('0.234');
    handle.destroy();
  });

  it('limit-mode trigger cleared after entry → returns to placeholder', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: COUNTRY_TOKEN,
      proCoverEnabled: false,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '1';
    amount.dispatchEvent(new Event('input'));
    const trigger = container.querySelector('[data-test-id="trade-limit-price"]');
    trigger.value = '10';
    trigger.dispatchEvent(new Event('input'));
    let headline = container.querySelector('[data-test-id="fee-breakdown-headline"]');
    expect(headline.textContent).toContain('0.095 BRA');
    // Now clear the trigger.
    trigger.value = '';
    trigger.dispatchEvent(new Event('input'));
    headline = container.querySelector('[data-test-id="fee-breakdown-headline"]');
    expect(headline.textContent.toLowerCase()).toContain('trigger price');
    expect(headline.textContent).not.toContain('BRA');
    handle.destroy();
  });
});

// Wave 2A — limit-mode "target already met" pre-check warning. Compares
// current MID (chart price) against the user-typed display target.
describe('mountTradePanel — Wave 2A target-already-met warning', () => {
  const COUNTRY_TOKEN = {
    address: '0xdddd000000000000000000000000000000000001',
    symbol: 'BRA',
    pricePitch: 1, // MID = 1 PITCH per BRA
  };

  it('limit-buy warns when target ≥ MID', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: COUNTRY_TOKEN,
      proCoverEnabled: false,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await wallet.connectWallet('injected');
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '1';
    amount.dispatchEvent(new Event('input'));
    const trigger = container.querySelector('[data-test-id="trade-limit-price"]');
    // target = 2 PITCH ≥ current MID (1) → warning
    trigger.value = '2';
    trigger.dispatchEvent(new Event('input'));
    const hint = container.querySelector('[data-test-id="trade-limit-hint"]');
    expect(hint.textContent.toLowerCase()).toContain('immediately');
    handle.destroy();
  });

  it('limit-buy does NOT warn when target < MID', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: COUNTRY_TOKEN,
      proCoverEnabled: false,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await wallet.connectWallet('injected');
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    const trigger = container.querySelector('[data-test-id="trade-limit-price"]');
    trigger.value = '0.5'; // < MID 1 → no warning
    trigger.dispatchEvent(new Event('input'));
    const hint = container.querySelector('[data-test-id="trade-limit-hint"]');
    expect(hint.textContent.toLowerCase()).not.toContain('immediately');
    handle.destroy();
  });

  it('take-profit warns when target ≤ MID', async () => {
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: COUNTRY_TOKEN,
      proCoverEnabled: false,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await wallet.connectWallet('injected');
    await flush();
    container.querySelector('[data-test-id="side-sell"]').click();
    container.querySelector('[data-test-id="mode-limit"]').click();
    const trigger = container.querySelector('[data-test-id="trade-limit-price"]');
    trigger.value = '0.5'; // ≤ MID 1 → warning for sell
    trigger.dispatchEvent(new Event('input'));
    const hint = container.querySelector('[data-test-id="trade-limit-hint"]');
    expect(hint.textContent.toLowerCase()).toContain('immediately');
    handle.destroy();
  });
});

// ─── Wave 3 — limit-mode executor allowance + approve flow ─────────────────
//
// Bug fixed: keeper pre-flight `eth_call` reverted with ERC20 insufficient
// allowance because users never approved the executor. Mirrors the F1.2
// market-mode pattern but against the LimitOrderExecutor address rather than
// the venue router. See `resolveLimitSpenderAndToken` in src/trade-panel.js.

describe('resolveLimitSpenderAndToken', () => {
  const executor = '0xb22f38a0c133a32ab9582ace9e2da41d1738b9d5';
  const playerVenue = {
    venue: 'player',
    baseToken: '0x3333333333333333333333333333333333333333',
    quoteToken: '0x4444444444444444444444444444444444444444',
  };
  const countryVenue = {
    venue: 'country',
    baseToken: '0x5555555555555555555555555555555555555555',
    quoteToken: '0xeae13ea73bec936664a51734c8c01ec7c3b0699c',
  };

  it('limit-buy on player venue spends the country (quote) token', () => {
    const out = resolveLimitSpenderAndToken({ side: 'buy', venue: playerVenue, executor });
    expect(out).toEqual({ spendingToken: playerVenue.quoteToken, spender: executor });
  });

  it('take-profit on player venue spends the player (base) token', () => {
    const out = resolveLimitSpenderAndToken({ side: 'sell', venue: playerVenue, executor });
    expect(out).toEqual({ spendingToken: playerVenue.baseToken, spender: executor });
  });

  it('limit-buy on country venue spends PITCH (quote)', () => {
    const out = resolveLimitSpenderAndToken({ side: 'buy', venue: countryVenue, executor });
    expect(out).toEqual({ spendingToken: countryVenue.quoteToken, spender: executor });
  });

  it('take-profit on country venue spends the country (base) token', () => {
    const out = resolveLimitSpenderAndToken({ side: 'sell', venue: countryVenue, executor });
    expect(out).toEqual({ spendingToken: countryVenue.baseToken, spender: executor });
  });

  it('returns null without an executor address', () => {
    expect(
      resolveLimitSpenderAndToken({ side: 'buy', venue: playerVenue, executor: null }),
    ).toBeNull();
    expect(
      resolveLimitSpenderAndToken({ side: 'buy', venue: playerVenue, executor: '' }),
    ).toBeNull();
  });

  it('returns null without a venue', () => {
    expect(resolveLimitSpenderAndToken({ side: 'buy', venue: null, executor })).toBeNull();
  });

  it('lowercases the spender + spending token', () => {
    const upper = '0xB22F38A0C133A32AB9582ACE9E2DA41D1738B9D5';
    const out = resolveLimitSpenderAndToken({
      side: 'buy',
      venue: {
        venue: 'player',
        baseToken: '0xAA' + 'A'.repeat(38),
        quoteToken: '0xBB' + 'B'.repeat(38),
      },
      executor: upper,
    });
    expect(out.spender).toBe(upper.toLowerCase());
    expect(out.spendingToken).toBe(('0xBB' + 'B'.repeat(38)).toLowerCase());
  });
});

describe('disabledReasonLimit — Wave 3 allowance branches', () => {
  const base = {
    walletConnected: true,
    chainId: 8453,
    token: { address: '0x3333333333333333333333333333333333333333' },
    contractsReady: true,
    executorReady: true,
    amountWei: 10n ** 18n,
    triggerPriceWei: 10n ** 18n,
    slippageBps: 100,
    premium: true,
  };

  it('approvePending beats everything except submitting', () => {
    expect(disabledReasonLimit({ ...base, approvePending: true })).toMatch(/approve/i);
    expect(disabledReasonLimit({ ...base, approvePending: true, walletConnected: false })).toMatch(
      /approve/i,
    );
  });

  it('submitting still beats approvePending', () => {
    expect(
      disabledReasonLimit({ ...base, submitting: true, approvePending: true }),
    ).toMatch(/sign/i);
  });

  it('allowanceLoading blocks the CTA when no other reason fires', () => {
    expect(disabledReasonLimit({ ...base, allowanceLoading: true })).toMatch(
      /Checking allowance/i,
    );
  });

  it('allowanceLoading is not a blocker once a prior reason hits', () => {
    expect(
      disabledReasonLimit({ ...base, allowanceLoading: true, amountWei: null }),
    ).toMatch(/amount/i);
  });
});

describe('mountTradePanel — Wave 3 limit-mode allowance read', () => {
  it('reads executor allowance against the QUOTE token on player+Buy (limit-buy)', async () => {
    const readAllowance = vi.fn().mockResolvedValue(0n);
    const payment = makePayment({ readAllowance });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: VALID_PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await wallet.connectWallet('injected');
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    await flush();
    // The most recent allowance read targets the executor + the country
    // (quote) token of the player venue.
    const execCalls = readAllowance.mock.calls.filter(
      ([arg]) => arg.spender === CONFIG.contracts.limitOrderExecutor,
    );
    expect(execCalls.length).toBeGreaterThan(0);
    expect(execCalls.at(-1)[0].token).toBe(VALID_PLAYER_TOKEN.countryAddress.toLowerCase());
    handle.destroy();
  });

  it('reads executor allowance against the BASE token on take-profit (sell)', async () => {
    const readAllowance = vi.fn().mockResolvedValue(0n);
    const payment = makePayment({ readAllowance });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: VALID_PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      readQuote: vi.fn().mockResolvedValue(50n * 10n ** 18n),
      payment,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await wallet.connectWallet('injected');
    await flush();
    container.querySelector('[data-test-id="side-sell"]').click();
    container.querySelector('[data-test-id="mode-limit"]').click();
    await flush();
    const execCalls = readAllowance.mock.calls.filter(
      ([arg]) => arg.spender === CONFIG.contracts.limitOrderExecutor,
    );
    expect(execCalls.length).toBeGreaterThan(0);
    expect(execCalls.at(-1)[0].token).toBe(VALID_PLAYER_TOKEN.address.toLowerCase());
    handle.destroy();
  });
});

describe('mountTradePanel — Wave 3 limit-mode CTA mode (approve vs sign)', () => {
  it('CTA label flips to "Approve" when executor allowance < amount', async () => {
    const readAllowance = vi.fn().mockResolvedValue(0n);
    const payment = makePayment({ readAllowance });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: VALID_PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      payment,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await wallet.connectWallet('injected');
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    await flush();
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '1';
    amount.dispatchEvent(new Event('input'));
    const trigger = container.querySelector('[data-test-id="trade-limit-price"]');
    trigger.value = '12.5';
    trigger.dispatchEvent(new Event('input'));
    await flush();
    const cta = container.querySelector('[data-test-id="trade-cta"]');
    expect(cta.textContent).toBe('Approve');
    // Single unified action — `onPlaceLimitClick` auto-chains approve when
    // allowance is insufficient, so dataset.action is always `'limit'` in
    // limit-mode. Only the visible label differs.
    expect(cta.dataset.action).toBe('limit');
    expect(cta.disabled).toBe(false);
    handle.destroy();
  });

  it('CTA stays "Place limit-buy" when allowance ≥ amount', async () => {
    const readAllowance = vi.fn().mockResolvedValue(MAX_UINT256);
    const payment = makePayment({ readAllowance });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: VALID_PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      payment,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await wallet.connectWallet('injected');
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    await flush();
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '1';
    amount.dispatchEvent(new Event('input'));
    const trigger = container.querySelector('[data-test-id="trade-limit-price"]');
    trigger.value = '12.5';
    trigger.dispatchEvent(new Event('input'));
    await flush();
    const cta = container.querySelector('[data-test-id="trade-cta"]');
    expect(cta.textContent).toMatch(/Place limit-buy/i);
    expect(cta.dataset.action).toBe('limit');
    expect(cta.disabled).toBe(false);
    handle.destroy();
  });

  it('take-profit shows "Place take-profit" CTA when allowance suffices', async () => {
    const readAllowance = vi.fn().mockResolvedValue(MAX_UINT256);
    const payment = makePayment({ readAllowance });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: VALID_PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      payment,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await wallet.connectWallet('injected');
    await flush();
    container.querySelector('[data-test-id="side-sell"]').click();
    container.querySelector('[data-test-id="mode-limit"]').click();
    await flush();
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '1';
    amount.dispatchEvent(new Event('input'));
    const trigger = container.querySelector('[data-test-id="trade-limit-price"]');
    trigger.value = '12.5';
    trigger.dispatchEvent(new Event('input'));
    await flush();
    const cta = container.querySelector('[data-test-id="trade-cta"]');
    expect(cta.textContent).toMatch(/Place take-profit/i);
    expect(cta.dataset.action).toBe('limit');
    handle.destroy();
  });
});

describe('mountTradePanel — Wave 3 limit-mode approve trigger', () => {
  it('clicking Approve calls payment.approve with MAX_UINT256 + executor spender', async () => {
    const readAllowance = vi.fn().mockResolvedValue(0n);
    const approve = vi.fn().mockResolvedValue('0xapprovehash');
    const payment = makePayment({ readAllowance, approve });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: VALID_PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      payment,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await wallet.connectWallet('injected');
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    await flush();
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '1';
    amount.dispatchEvent(new Event('input'));
    const trigger = container.querySelector('[data-test-id="trade-limit-price"]');
    trigger.value = '12.5';
    trigger.dispatchEvent(new Event('input'));
    await flush();
    container.querySelector('[data-test-id="trade-cta"]').click();
    await flush();
    expect(approve).toHaveBeenCalledTimes(1);
    const arg = approve.mock.calls[0][0];
    expect(arg.spender).toBe(CONFIG.contracts.limitOrderExecutor);
    // Player+Buy → spending = country (quote) token.
    expect(arg.token).toBe(VALID_PLAYER_TOKEN.countryAddress.toLowerCase());
    expect(arg.amount).toBe(MAX_UINT256);
    expect(typeof arg.owner).toBe('string');
    handle.destroy();
  });

  it('approve success: re-reads allowance and auto-chains to sign + POST', async () => {
    // First N calls return 0n (so CTA stays "Approve" before user clicks).
    // After the approve resolves, we flip the mock to return MAX_UINT256 so
    // the post-approve re-read sees the new value and the auto-chain proceeds
    // straight to sign + createOrder.
    let approvedYet = false;
    const readAllowance = vi.fn().mockImplementation(async () => {
      return approvedYet ? MAX_UINT256 : 0n;
    });
    const approve = vi.fn().mockImplementation(async () => {
      approvedYet = true;
      return '0xhash';
    });
    const signTypedData = vi.fn().mockResolvedValue('0x' + '11'.repeat(65));
    const createOrder = vi.fn().mockResolvedValue({ ok: true });
    const payment = makePayment({ readAllowance, approve });
    const handle = mountTradePanel(container, {
      apiClient: { ...makeApi(), createOrder },
      token: VALID_PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      payment,
      signTypedData,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await wallet.connectWallet('injected');
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    await flush();
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '1';
    amount.dispatchEvent(new Event('input'));
    const trigger = container.querySelector('[data-test-id="trade-limit-price"]');
    trigger.value = '12.5';
    trigger.dispatchEvent(new Event('input'));
    await flush();
    container.querySelector('[data-test-id="trade-cta"]').click();
    for (let i = 0; i < 6; i++) await flush();
    expect(approve).toHaveBeenCalledTimes(1);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(createOrder).toHaveBeenCalledTimes(1);
    // After the chain completes, both pending flags clear and the trigger
    // input gets reset — CTA returns to disabled "Enter trigger price" state.
    expect(handle.getState().limitApprovePending).toBe(false);
    expect(handle.getState().limitSubmitting).toBe(false);
    handle.destroy();
  });

  it('approve in-flight → CTA shows "Approve…" + disabled', async () => {
    const readAllowance = vi.fn().mockResolvedValue(0n);
    let resolveApprove;
    const approveProm = new Promise((r) => {
      resolveApprove = r;
    });
    const approve = vi.fn().mockReturnValue(approveProm);
    const payment = makePayment({ readAllowance, approve });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: VALID_PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      payment,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await wallet.connectWallet('injected');
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    await flush();
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '1';
    amount.dispatchEvent(new Event('input'));
    const trigger = container.querySelector('[data-test-id="trade-limit-price"]');
    trigger.value = '12.5';
    trigger.dispatchEvent(new Event('input'));
    await flush();
    container.querySelector('[data-test-id="trade-cta"]').click();
    await flush();
    const cta = container.querySelector('[data-test-id="trade-cta"]');
    expect(cta.textContent).toBe('Approve…');
    expect(cta.disabled).toBe(true);
    expect(handle.getState().limitApprovePending).toBe(true);
    resolveApprove('0xhash');
    await flush();
    handle.destroy();
  });

  it('user-rejected approve does NOT surface an error toast and clears pending', async () => {
    const readAllowance = vi.fn().mockResolvedValue(0n);
    const rejection = Object.assign(new Error('User rejected'), { code: 4001 });
    const approve = vi.fn().mockRejectedValue(rejection);
    const payment = makePayment({ readAllowance, approve });
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: VALID_PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      payment,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await wallet.connectWallet('injected');
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    await flush();
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '1';
    amount.dispatchEvent(new Event('input'));
    const trigger = container.querySelector('[data-test-id="trade-limit-price"]');
    trigger.value = '12.5';
    trigger.dispatchEvent(new Event('input'));
    await flush();
    container.querySelector('[data-test-id="trade-cta"]').click();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(document.querySelector('[data-test-id="toast"]')).toBeNull();
    expect(handle.getState().limitApprovePending).toBe(false);
    handle.destroy();
  });

  it('insufficient allowance blocks the sign-and-POST path (no signTypedData call)', async () => {
    // Regression: pre-Wave-3, the CTA went straight to sign+POST even when the
    // executor had zero allowance, causing the keeper's pre-flight `eth_call`
    // to revert later. The CTA must surface Approve first.
    const readAllowance = vi.fn().mockResolvedValue(0n);
    const signTypedData = vi.fn();
    const createOrder = vi.fn();
    const payment = makePayment({ readAllowance });
    const handle = mountTradePanel(container, {
      apiClient: { ...makeApi(), createOrder },
      token: VALID_PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      payment,
      signTypedData,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await wallet.connectWallet('injected');
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    await flush();
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '1';
    amount.dispatchEvent(new Event('input'));
    const trigger = container.querySelector('[data-test-id="trade-limit-price"]');
    trigger.value = '12.5';
    trigger.dispatchEvent(new Event('input'));
    await flush();
    const cta = container.querySelector('[data-test-id="trade-cta"]');
    // CTA should be labelled "Approve" (auto-chain to sign on click).
    expect(cta.textContent).toBe('Approve');
    expect(cta.dataset.action).toBe('limit');
    // No click → no wallet popups.
    expect(signTypedData).not.toHaveBeenCalled();
    expect(createOrder).not.toHaveBeenCalled();
    handle.destroy();
  });

  it('auto-chain: single CTA click triggers approve THEN sign + createOrder', async () => {
    // Wave 4 follow-up — clicking the CTA in limit-mode with insufficient
    // allowance runs approve → re-reads allowance → continues to sign + POST,
    // all in one user gesture.
    let approvedYet = false;
    const readAllowance = vi.fn().mockImplementation(async () => {
      return approvedYet ? MAX_UINT256 : 0n;
    });
    const approve = vi.fn().mockImplementation(async () => {
      approvedYet = true;
      return '0xapprovehash';
    });
    const signTypedData = vi.fn().mockResolvedValue('0x' + '11'.repeat(65));
    const createOrder = vi.fn().mockResolvedValue({ ok: true });
    const payment = makePayment({ readAllowance, approve });
    const handle = mountTradePanel(container, {
      apiClient: { ...makeApi(), createOrder },
      token: VALID_PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      payment,
      signTypedData,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await wallet.connectWallet('injected');
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    await flush();
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '1';
    amount.dispatchEvent(new Event('input'));
    const trigger = container.querySelector('[data-test-id="trade-limit-price"]');
    trigger.value = '12.5';
    trigger.dispatchEvent(new Event('input'));
    await flush();
    container.querySelector('[data-test-id="trade-cta"]').click();
    // Multiple flushes — approve receipt → refreshLimitAllowance → sign → POST.
    for (let i = 0; i < 6; i++) await flush();
    expect(approve).toHaveBeenCalledTimes(1);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(createOrder).toHaveBeenCalledTimes(1);
    // Approve must complete before sign — assert call-order via mock invocation
    // order.
    expect(approve.mock.invocationCallOrder[0]).toBeLessThan(
      signTypedData.mock.invocationCallOrder[0],
    );
    expect(handle.getState().limitApprovePending).toBe(false);
    expect(handle.getState().limitSubmitting).toBe(false);
    handle.destroy();
  });

  it('auto-chain: approve rejection does NOT proceed to sign', async () => {
    // If the user rejects the approve popup, the EIP-712 signer must NOT be
    // popped.
    const readAllowance = vi.fn().mockResolvedValue(0n);
    const rejection = Object.assign(new Error('User rejected'), { code: 4001 });
    const approve = vi.fn().mockRejectedValue(rejection);
    const signTypedData = vi.fn();
    const createOrder = vi.fn();
    const payment = makePayment({ readAllowance, approve });
    const handle = mountTradePanel(container, {
      apiClient: { ...makeApi(), createOrder },
      token: VALID_PLAYER_TOKEN,
      readBalance: vi.fn().mockResolvedValue(100n * 10n ** 18n),
      payment,
      signTypedData,
      getAccessState: () => 'premium',
      subscribeAccess: () => () => {},
    });
    await wallet.connectWallet('injected');
    await flush();
    container.querySelector('[data-test-id="mode-limit"]').click();
    await flush();
    const amount = container.querySelector('[data-test-id="trade-amount"]');
    amount.value = '1';
    amount.dispatchEvent(new Event('input'));
    const trigger = container.querySelector('[data-test-id="trade-limit-price"]');
    trigger.value = '12.5';
    trigger.dispatchEvent(new Event('input'));
    await flush();
    container.querySelector('[data-test-id="trade-cta"]').click();
    for (let i = 0; i < 6; i++) await flush();
    expect(approve).toHaveBeenCalledTimes(1);
    expect(signTypedData).not.toHaveBeenCalled();
    expect(createOrder).not.toHaveBeenCalled();
    expect(handle.getState().limitApprovePending).toBe(false);
    expect(handle.getState().limitSubmitting).toBe(false);
    handle.destroy();
  });
});
