// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock viem / @wagmi/core BEFORE importing the SUT — same pattern as wallet.test.js.
// We need wallet.js to be importable; its module-level imports go through these mocks.

const wagmiState = { connections: [], watchers: new Set() };
function emitWagmi() {
  for (const fn of wagmiState.watchers) fn();
}

vi.mock('@wagmi/core', () => ({
  createConfig: vi.fn(() => ({ connectors: [{ id: 'injected' }] })),
  injected: vi.fn(() => ({ id: 'injected' })),
  connect: vi.fn(async () => {
    wagmiState.connections = [
      { accounts: ['0xABCdef0000000000000000000000000000000001'], chainId: 8453 },
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

vi.mock('@walletconnect/ethereum-provider', () => ({
  EthereumProvider: { init: vi.fn(async () => ({})) },
}));

const wallet = await import('../src/wallet.js');
const {
  mountTradePanel,
  parseAmountToWei,
  formatWei,
  percentOfBalance,
  applySlippage,
  resolveVenue,
  disabledReason,
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

  it('flags limit mode', () => {
    expect(disabledReason({ ...baseCtx, limitMode: true })).toMatch(/фаза 2/i);
  });

  it('flags wallet disconnected', () => {
    expect(disabledReason({ ...baseCtx, walletConnected: false })).toMatch(/кошелёк/);
  });

  it('flags wrong chain', () => {
    expect(disabledReason({ ...baseCtx, chainId: 1 })).toMatch(/Base/);
  });

  it('flags missing token', () => {
    expect(disabledReason({ ...baseCtx, token: null })).toMatch(/токен/);
  });

  it('flags missing contracts', () => {
    expect(disabledReason({ ...baseCtx, contractsReady: false })).toMatch(/конфиг/i);
  });

  it('flags zero amount', () => {
    expect(disabledReason({ ...baseCtx, amountWei: 0n })).toMatch(/сумму/i);
    expect(disabledReason({ ...baseCtx, amountWei: null })).toMatch(/сумму/i);
  });

  it('flags insufficient balance', () => {
    expect(disabledReason({ ...baseCtx, amountWei: 100n * 10n ** 18n, balanceWei: 10n ** 18n })).toMatch(/Недостаточно/);
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
    expect(limit.disabled).toBe(true);
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
    expect(container.querySelector('[data-test-id="trade-status"]').textContent).toMatch(/кошелёк/);
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

  it('clicking the disabled Limit toggle does nothing', async () => {
    const handle = mountTradePanel(container, { apiClient: makeApi() });
    await flush();
    const limitBtn = container.querySelector('[data-test-id="mode-limit"]');
    limitBtn.click();
    // marketBtn still active
    expect(container.querySelector('[data-test-id="mode-market"]').getAttribute('aria-pressed')).toBe('true');
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
    const handle = mountTradePanel(container, {
      apiClient: makeApi(),
      token: PLAYER_TOKEN,
      readBalance,
      readQuote,
      debounceMs: 50,
    });
    await wallet.connectWallet('injected');
    await vi.advanceTimersByTimeAsync(0);
    container.querySelector('[data-test-id="trade-amount"]').value = '100';
    container.querySelector('[data-test-id="trade-amount"]').dispatchEvent(new Event('input'));
    expect(container.querySelector('[data-test-id="trade-cta"]').disabled).toBe(true);
    expect(container.querySelector('[data-test-id="trade-status"]').textContent).toMatch(/Недостаточно/);
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
    ).toMatch(/своп|подтвержд/i);
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
    ).toMatch(/фаза 2/);
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
    expect(status.textContent).toMatch(/allowance|Проверка/i);

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
    expect(toast.textContent).toMatch(/Своп/);
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
