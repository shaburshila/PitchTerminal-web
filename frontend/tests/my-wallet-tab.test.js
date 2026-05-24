// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { mountMyWalletTab } from '../src/my-wallet-tab.js';
import * as accessStore from '../src/access-store.js';

const TOKEN = '0xaaa1';

function makePosition(overrides = {}) {
  return {
    configured: true,
    address: '0x1111111111111111111111111111111111111111',
    hasActivity: true,
    buys: 3,
    sells: 1,
    position: 2.5,
    positionValue: 30.0,
    spent: 30.0,
    received: 12.0,
    tokensSold: 1.0,
    avgBuy: 12.0,
    breakEven: 7.2,
    currentPrice: 12.0,
    realizedPnl: 1.5,
    unrealizedPnl: -0.5,
    totalPnl: 1.0,
    totalPnlPct: 3.3,
    breakEvenDistPct: 66.6,
    feesPaid: 0.4,
    ownershipPct: 0.001,
    rank: 5,
    holdersCount: 12,
    firstTradeTs: 1709000000,
    holdingDays: 1.5,
    ...overrides,
  };
}

function makeApi(resp) {
  return {
    getPosition: vi.fn(async () => resp ?? makePosition()),
  };
}

async function flush(n = 4) {
  for (let i = 0; i < n; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

function makeContainer() {
  const c = document.createElement('div');
  document.body.appendChild(c);
  return c;
}

beforeEach(() => {
  accessStore._resetForTests();
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('mountMyWalletTab', () => {
  it('throws on bad container', () => {
    expect(() => mountMyWalletTab(null)).toThrow(TypeError);
  });

  it('renders soft-lock when not premium (default state)', () => {
    const c = makeContainer();
    mountMyWalletTab(c, {
      apiClient: makeApi(),
      token: TOKEN,
      softLock: { openPayModal: vi.fn() },
    });
    expect(c.querySelector('[data-test-id="soft-lock"]')).toBeTruthy();
    expect(c.querySelector('[data-test-id="mywallet-skeleton"]')).toBeTruthy();
    expect(c.querySelector('[data-test-id="mywallet-grid"]')).toBeFalsy();
  });

  it('renders soft-lock and never fetches when not premium', async () => {
    const c = makeContainer();
    const api = makeApi();
    mountMyWalletTab(c, { apiClient: api, token: TOKEN, softLock: { openPayModal: vi.fn() } });
    await flush();
    expect(api.getPosition).not.toHaveBeenCalled();
  });

  it('shows placeholder for premium + no token', () => {
    accessStore.set('premium');
    const c = makeContainer();
    mountMyWalletTab(c, { apiClient: makeApi(), token: null });
    expect(c.querySelector('[data-test-id="mywallet-no-token"]')).toBeTruthy();
    expect(c.querySelector('[data-test-id="soft-lock"]')).toBeFalsy();
  });

  it('fetches and renders PnL grid for premium + token', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const api = makeApi();
    mountMyWalletTab(c, { apiClient: api, token: TOKEN });
    await flush();
    expect(api.getPosition).toHaveBeenCalledWith(TOKEN);
    expect(c.querySelector('[data-test-id="mywallet-grid"]')).toBeTruthy();
    expect(c.querySelector('[data-test-id="mywallet-position"]')).toBeTruthy();
    // Position value cell shows 2.5
    expect(c.querySelector('[data-test-id="mywallet-position"]').textContent).toContain('2.5');
    // Total PnL has positive class (+1.0)
    const total = c.querySelector('[data-test-id="mywallet-total"]');
    expect(total.querySelector('.pt-mywallet__stat-value').className).toContain('positive');
  });

  it('renders empty-state for hasActivity=false', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const api = makeApi({ configured: true, hasActivity: false });
    mountMyWalletTab(c, { apiClient: api, token: TOKEN });
    await flush();
    expect(c.querySelector('[data-test-id="mywallet-empty"]')).toBeTruthy();
    expect(c.querySelector('[data-test-id="mywallet-grid"]')).toBeFalsy();
  });

  it('renders error when getPosition rejects', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const api = {
      getPosition: vi.fn(async () => {
        const err = new Error('Server down');
        err.status = 500;
        throw err;
      }),
    };
    mountMyWalletTab(c, { apiClient: api, token: TOKEN });
    await flush();
    const errEl = c.querySelector('[data-test-id="mywallet-error"]');
    expect(errEl).toBeTruthy();
    expect(errEl.textContent).toContain('Server down');
    expect(errEl.textContent).toContain('500');
  });

  it('auto-fetches when access flips from free to premium', async () => {
    accessStore.set('free');
    const c = makeContainer();
    const api = makeApi();
    mountMyWalletTab(c, { apiClient: api, token: TOKEN, softLock: { openPayModal: vi.fn() } });
    await flush();
    expect(api.getPosition).not.toHaveBeenCalled();

    accessStore.set('premium');
    await flush();
    expect(api.getPosition).toHaveBeenCalledTimes(1);
    expect(c.querySelector('[data-test-id="mywallet-grid"]')).toBeTruthy();
  });

  it('clears data + re-renders lock when access downgrades from premium', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    mountMyWalletTab(c, { apiClient: makeApi(), token: TOKEN, softLock: { openPayModal: vi.fn() } });
    await flush();
    expect(c.querySelector('[data-test-id="mywallet-grid"]')).toBeTruthy();

    accessStore.set('free');
    await flush();
    expect(c.querySelector('[data-test-id="mywallet-grid"]')).toBeFalsy();
    expect(c.querySelector('[data-test-id="soft-lock"]')).toBeTruthy();
  });

  it('setToken fetches new data for new token', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const api = makeApi();
    const handle = mountMyWalletTab(c, { apiClient: api, token: TOKEN });
    await flush();
    expect(api.getPosition).toHaveBeenCalledWith(TOKEN);

    await handle.setToken('0xbbb2');
    expect(api.getPosition).toHaveBeenCalledWith('0xbbb2');
    expect(api.getPosition).toHaveBeenCalledTimes(2);
  });

  it('setToken(null) clears and shows no-token placeholder', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const handle = mountMyWalletTab(c, { apiClient: makeApi(), token: TOKEN });
    await flush();
    await handle.setToken(null);
    expect(c.querySelector('[data-test-id="mywallet-no-token"]')).toBeTruthy();
  });

  it('refresh() re-fetches', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const api = makeApi();
    const handle = mountMyWalletTab(c, { apiClient: api, token: TOKEN });
    await flush();
    expect(api.getPosition).toHaveBeenCalledTimes(1);
    await handle.refresh();
    expect(api.getPosition).toHaveBeenCalledTimes(2);
  });

  it('destroy() unsubscribes from access changes', async () => {
    accessStore.set('free');
    const c = makeContainer();
    const api = makeApi();
    const handle = mountMyWalletTab(c, { apiClient: api, token: TOKEN, softLock: { openPayModal: vi.fn() } });
    handle.destroy();
    accessStore.set('premium');
    await flush();
    expect(api.getPosition).not.toHaveBeenCalled();
  });

  it('discards stale response from a previous token', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    let resolveFirst;
    const firstPromise = new Promise((res) => { resolveFirst = res; });
    const api = {
      getPosition: vi.fn((t) => {
        if (t === TOKEN) return firstPromise;
        return Promise.resolve(makePosition({ position: 9.9 }));
      }),
    };
    const handle = mountMyWalletTab(c, { apiClient: api, token: TOKEN });
    // First fetch in flight; switch token before it resolves.
    await handle.setToken('0xbbb2');
    // Now resolve the stale first fetch — should be discarded.
    resolveFirst(makePosition({ position: 1.1 }));
    await flush();
    const positionCell = c.querySelector('[data-test-id="mywallet-position"]');
    expect(positionCell.textContent).toContain('9.9');
  });
});
