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

  it('renders compact locked placeholder when not premium (no soft-lock overlay)', () => {
    const c = makeContainer();
    mountMyWalletTab(c, {
      apiClient: makeApi(),
      token: TOKEN,
    });
    // Lock affordance now lives on the bottom-tab BUTTON. The pane just shows
    // a compact "Premium feature" placeholder — no gold cover, no skeleton.
    expect(c.querySelector('[data-test-id="mywallet-locked"]')).toBeTruthy();
    expect(c.querySelector('[data-test-id="soft-lock"]')).toBeFalsy();
    expect(c.querySelector('[data-test-id="mywallet-skeleton"]')).toBeFalsy();
    expect(c.querySelector('[data-test-id="mywallet-grid"]')).toBeFalsy();
  });

  it('does not fetch when not premium', async () => {
    const c = makeContainer();
    const api = makeApi();
    mountMyWalletTab(c, { apiClient: api, token: TOKEN });
    await flush();
    expect(api.getPosition).not.toHaveBeenCalled();
  });

  it('shows placeholder for premium + no token', () => {
    accessStore.set('premium');
    const c = makeContainer();
    mountMyWalletTab(c, { apiClient: makeApi(), token: null });
    expect(c.querySelector('[data-test-id="mywallet-no-token"]')).toBeTruthy();
    expect(c.querySelector('[data-test-id="mywallet-locked"]')).toBeFalsy();
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
    mountMyWalletTab(c, { apiClient: api, token: TOKEN });
    await flush();
    expect(api.getPosition).not.toHaveBeenCalled();

    accessStore.set('premium');
    await flush();
    expect(api.getPosition).toHaveBeenCalledTimes(1);
    expect(c.querySelector('[data-test-id="mywallet-grid"]')).toBeTruthy();
  });

  it('clears data + re-renders locked placeholder when access downgrades from premium', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    mountMyWalletTab(c, { apiClient: makeApi(), token: TOKEN });
    await flush();
    expect(c.querySelector('[data-test-id="mywallet-grid"]')).toBeTruthy();

    accessStore.set('free');
    await flush();
    expect(c.querySelector('[data-test-id="mywallet-grid"]')).toBeFalsy();
    expect(c.querySelector('[data-test-id="mywallet-locked"]')).toBeTruthy();
    expect(c.querySelector('[data-test-id="soft-lock"]')).toBeFalsy();
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

  it('setToken with same address but fresh meta literal does not re-fetch', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const api = makeApi();
    const handle = mountMyWalletTab(c, {
      apiClient: api,
      token: TOKEN,
      tokenMeta: { symbol: 'FRA', kind: 'country' },
    });
    await flush();
    expect(api.getPosition).toHaveBeenCalledTimes(1);

    // Caller rebuilds the meta object literal — reference inequality, but
    // address unchanged. Guard should treat this as display-only update.
    await handle.setToken(TOKEN, { symbol: 'FRA', kind: 'country' });
    await flush();
    expect(api.getPosition).toHaveBeenCalledTimes(1);

    await handle.setToken(TOKEN, { symbol: 'FRA', kind: 'country' });
    await flush();
    expect(api.getPosition).toHaveBeenCalledTimes(1);
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
    const handle = mountMyWalletTab(c, { apiClient: api, token: TOKEN });
    handle.destroy();
    accessStore.set('premium');
    await flush();
    expect(api.getPosition).not.toHaveBeenCalled();
  });

  // ── Phase 1.5 batch 6 — visual redesign ────────────────────────────────
  describe('Phase 1.5 batch 6 redesign', () => {
    it('renders the head strip with total holdings value + positive PnL pill', async () => {
      accessStore.set('premium');
      const c = makeContainer();
      const api = makeApi(makePosition({ positionValue: 42.5, totalPnl: 5.25, totalPnlPct: 14.2 }));
      mountMyWalletTab(c, { apiClient: api, token: TOKEN });
      await flush();
      const head = c.querySelector('[data-test-id="mywallet-head"]');
      expect(head).toBeTruthy();
      expect(c.querySelector('[data-test-id="mywallet-head-value"]').textContent).toContain('42.5');
      const pill = c.querySelector('[data-test-id="mywallet-head-pnl"]');
      expect(pill).toBeTruthy();
      expect(pill.className).toContain('is-positive');
      expect(pill.textContent).toContain('+5.25');
      expect(pill.textContent).toContain('+14.20%');
    });

    it('PnL pill flips to is-negative when totalPnl is negative', async () => {
      accessStore.set('premium');
      const c = makeContainer();
      const api = makeApi(makePosition({ totalPnl: -3.1, totalPnlPct: -8.7 }));
      mountMyWalletTab(c, { apiClient: api, token: TOKEN });
      await flush();
      const pill = c.querySelector('[data-test-id="mywallet-head-pnl"]');
      expect(pill.className).toContain('is-negative');
      expect(pill.textContent).toContain('-3.1');
    });

    it('renders flag image when tokenMeta has country symbol with hasFlag mapping', async () => {
      accessStore.set('premium');
      const c = makeContainer();
      mountMyWalletTab(c, {
        apiClient: makeApi(),
        token: TOKEN,
        tokenMeta: { symbol: 'BRA', kind: 'country', name: 'Brazil' },
      });
      await flush();
      const img = c.querySelector('[data-test-id="mywallet-flag"]');
      expect(img).toBeTruthy();
      expect(img.getAttribute('src')).toBe('/flags/br.svg');
      const name = c.querySelector('.pt-mywallet__name');
      expect(name.textContent).toBe('Brazil');
    });

    it('renders placeholder flag (no img) when no tokenMeta is provided', async () => {
      accessStore.set('premium');
      const c = makeContainer();
      mountMyWalletTab(c, { apiClient: makeApi(), token: TOKEN });
      await flush();
      expect(c.querySelector('[data-test-id="mywallet-flag"]')).toBeFalsy();
      expect(c.querySelector('.pt-mywallet__flag--placeholder')).toBeTruthy();
    });

    it('illustrated empty state has icon + title "No position yet"', async () => {
      accessStore.set('premium');
      const c = makeContainer();
      const api = makeApi({ configured: true, hasActivity: false });
      mountMyWalletTab(c, { apiClient: api, token: TOKEN });
      await flush();
      const empty = c.querySelector('[data-test-id="mywallet-empty"]');
      expect(empty).toBeTruthy();
      expect(empty.querySelector('.pt-mywallet__empty-title').textContent).toContain('No position');
      expect(empty.querySelector('.pt-mywallet__empty-icon svg')).toBeTruthy();
    });

    it('emits onTabCount=1 when a position with activity loads, null when downgraded', async () => {
      accessStore._resetForTests();
      accessStore.set('premium');
      const c = makeContainer();
      const counts = [];
      mountMyWalletTab(c, {
        apiClient: makeApi(),
        token: TOKEN,
        onTabCount: (n) => counts.push(n),
      });
      await flush();
      expect(counts[counts.length - 1]).toBe(1);

      accessStore.set('free');
      await flush();
      expect(counts[counts.length - 1]).toBeNull();
    });
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
