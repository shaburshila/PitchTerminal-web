// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { mountMyWalletTab } from '../src/my-wallet-tab.js';
import * as accessStore from '../src/access-store.js';

const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
const TOKEN_2 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2';

function makeItem(overrides = {}) {
  return {
    token: TOKEN,
    symbol: 'FRA',
    kind: 'country',
    balance: '2500000000000000000',
    balanceDisplay: 2.5,
    avgEntryPitch: '12000000000000000000',
    avgEntryPitchDisplay: 12.0,
    currentPricePitch: '12000000000000000000',
    currentPricePitchDisplay: 12.0,
    valuePitch: '30000000000000000000',
    valuePitchDisplay: 30.0,
    pnlPitch: '1000000000000000000',
    pnlPitchDisplay: 1.0,
    breakEvenPitch: '11600000000000000000',
    breakEvenPitchDisplay: 11.6,
    realizedPitch: '3100000000000000000',
    realizedPitchDisplay: 3.1,
    feesPaidWei: '400000000000000000',
    spentBaseWei: '30000000000000000000',
    receivedBaseWei: '12000000000000000000',
    ...overrides,
  };
}

function makeApi(items = [makeItem()]) {
  return {
    getPortfolio: vi.fn(async () => ({ items })),
  };
}

function makeAccount({ connected = true, address = '0xUSER' } = {}) {
  let snapshot = { isConnected: connected, address: connected ? address : null };
  const listeners = new Set();
  return {
    getAccount: () => snapshot,
    onAccountChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setState(next) {
      snapshot = { ...snapshot, ...next };
      for (const fn of [...listeners]) fn(snapshot);
    },
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
    const acc = makeAccount();
    mountMyWalletTab(c, {
      apiClient: makeApi(),
      token: TOKEN,
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    expect(c.querySelector('[data-test-id="mywallet-locked"]')).toBeTruthy();
    expect(c.querySelector('[data-test-id="soft-lock"]')).toBeFalsy();
    expect(c.querySelector('[data-test-id="mywallet-list"]')).toBeFalsy();
  });

  it('does not fetch when not premium', async () => {
    const c = makeContainer();
    const api = makeApi();
    const acc = makeAccount();
    mountMyWalletTab(c, {
      apiClient: api,
      token: TOKEN,
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    await flush();
    expect(api.getPortfolio).not.toHaveBeenCalled();
  });

  it('shows disconnected placeholder when premium but wallet not connected', () => {
    accessStore.set('premium');
    const c = makeContainer();
    const acc = makeAccount({ connected: false });
    mountMyWalletTab(c, {
      apiClient: makeApi(),
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    expect(c.querySelector('[data-test-id="mywallet-disconnected"]')).toBeTruthy();
    expect(c.querySelector('[data-test-id="mywallet-locked"]')).toBeFalsy();
  });

  it('fetches and renders portfolio table for premium + connected', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const api = makeApi([
      makeItem({ token: TOKEN, symbol: 'FRA', kind: 'country', valuePitchDisplay: 30 }),
      makeItem({
        token: TOKEN_2,
        symbol: 'BRA',
        kind: 'country',
        balanceDisplay: 5.0,
        avgEntryPitchDisplay: 4.0,
        currentPricePitchDisplay: 5.0,
        valuePitchDisplay: 25.0,
        pnlPitchDisplay: 5.0,
      }),
    ]);
    const acc = makeAccount();
    mountMyWalletTab(c, {
      apiClient: api,
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    await flush();
    expect(api.getPortfolio).toHaveBeenCalledTimes(1);
    expect(c.querySelector('[data-test-id="mywallet-list"]')).toBeTruthy();
    const rows = c.querySelectorAll('[data-test-id="mywallet-row"]');
    expect(rows.length).toBe(2);
    // Sorted by value desc — FRA(30) before BRA(25)
    expect(rows[0].dataset.token).toBe(TOKEN);
    expect(rows[1].dataset.token).toBe(TOKEN_2);
  });

  it('renders empty-state when items array is empty', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const api = makeApi([]);
    const acc = makeAccount();
    mountMyWalletTab(c, {
      apiClient: api,
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    await flush();
    expect(c.querySelector('[data-test-id="mywallet-empty"]')).toBeTruthy();
    expect(c.querySelector('[data-test-id="mywallet-list"]')).toBeFalsy();
  });

  it('renders error when getPortfolio rejects with non-auth error', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const api = {
      getPortfolio: vi.fn(async () => {
        const err = new Error('Server down');
        err.status = 500;
        throw err;
      }),
    };
    const acc = makeAccount();
    mountMyWalletTab(c, {
      apiClient: api,
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    await flush();
    const errEl = c.querySelector('[data-test-id="mywallet-error"]');
    expect(errEl).toBeTruthy();
    expect(errEl.textContent).toContain('Server down');
    expect(errEl.textContent).toContain('500');
  });

  it('treats 402 as empty (silent gating) without error banner', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const api = {
      getPortfolio: vi.fn(async () => {
        const err = new Error('Payment required');
        err.status = 402;
        throw err;
      }),
    };
    const acc = makeAccount();
    mountMyWalletTab(c, {
      apiClient: api,
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    await flush();
    expect(c.querySelector('[data-test-id="mywallet-error"]')).toBeFalsy();
    expect(c.querySelector('[data-test-id="mywallet-empty"]')).toBeTruthy();
  });

  it('auto-fetches when access flips from free to premium', async () => {
    accessStore.set('free');
    const c = makeContainer();
    const api = makeApi();
    const acc = makeAccount();
    mountMyWalletTab(c, {
      apiClient: api,
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    await flush();
    expect(api.getPortfolio).not.toHaveBeenCalled();

    accessStore.set('premium');
    await flush();
    expect(api.getPortfolio).toHaveBeenCalledTimes(1);
    expect(c.querySelector('[data-test-id="mywallet-list"]')).toBeTruthy();
  });

  it('clears data + re-renders locked placeholder when access downgrades from premium', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const acc = makeAccount();
    mountMyWalletTab(c, {
      apiClient: makeApi(),
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    await flush();
    expect(c.querySelector('[data-test-id="mywallet-list"]')).toBeTruthy();

    accessStore.set('free');
    await flush();
    expect(c.querySelector('[data-test-id="mywallet-list"]')).toBeFalsy();
    expect(c.querySelector('[data-test-id="mywallet-locked"]')).toBeTruthy();
  });

  it('refresh() re-fetches', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const api = makeApi();
    const acc = makeAccount();
    const handle = mountMyWalletTab(c, {
      apiClient: api,
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    await flush();
    expect(api.getPortfolio).toHaveBeenCalledTimes(1);
    await handle.refresh();
    expect(api.getPortfolio).toHaveBeenCalledTimes(2);
  });

  it('destroy() unsubscribes from access changes', async () => {
    accessStore.set('free');
    const c = makeContainer();
    const api = makeApi();
    const acc = makeAccount();
    const handle = mountMyWalletTab(c, {
      apiClient: api,
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    handle.destroy();
    accessStore.set('premium');
    await flush();
    expect(api.getPortfolio).not.toHaveBeenCalled();
  });

  it('emits onTabCount=N (item count) when premium loads, null when downgraded', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const counts = [];
    const acc = makeAccount();
    mountMyWalletTab(c, {
      apiClient: makeApi([makeItem(), makeItem({ token: TOKEN_2, symbol: 'BRA' })]),
      onTabCount: (n) => counts.push(n),
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    await flush();
    expect(counts[counts.length - 1]).toBe(2);

    accessStore.set('free');
    await flush();
    expect(counts[counts.length - 1]).toBeNull();
  });

  it('clicking a row fires onTokenSelect with token/symbol/kind', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const selected = [];
    const acc = makeAccount();
    mountMyWalletTab(c, {
      apiClient: makeApi([makeItem({ token: TOKEN, symbol: 'FRA', kind: 'country' })]),
      onTokenSelect: (item) => selected.push(item),
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    await flush();
    const row = c.querySelector('[data-test-id="mywallet-row"]');
    row.click();
    expect(selected.length).toBe(1);
    expect(selected[0]).toEqual({ token: TOKEN, symbol: 'FRA', kind: 'country' });
  });

  it('emits onBalance with active-token balance after load', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const balances = [];
    const acc = makeAccount();
    mountMyWalletTab(c, {
      apiClient: makeApi([
        makeItem({ token: TOKEN, balanceDisplay: 7.5, breakEvenPitchDisplay: 9.25 }),
      ]),
      token: TOKEN,
      onBalance: (addr, bal, be) => balances.push({ addr, bal, be }),
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    await flush();
    const last = balances[balances.length - 1];
    expect(last.addr).toBe(TOKEN);
    expect(last.bal).toBe(7.5);
    // Break-even is plumbed through as the 3rd arg → chart draws Net pos here.
    expect(last.be).toBe(9.25);
  });

  it('emits onBalance=0 when active token is not in portfolio', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const balances = [];
    const acc = makeAccount();
    mountMyWalletTab(c, {
      apiClient: makeApi([makeItem({ token: TOKEN_2 })]),
      token: TOKEN,
      onBalance: (addr, bal) => balances.push({ addr, bal }),
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    await flush();
    const last = balances[balances.length - 1];
    expect(last.addr).toBe(TOKEN);
    expect(last.bal).toBe(0);
  });

  it('setToken clears stale balance on previous token before swap', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const balances = [];
    const acc = makeAccount();
    const handle = mountMyWalletTab(c, {
      apiClient: makeApi([makeItem({ token: TOKEN, balanceDisplay: 7.5 })]),
      token: TOKEN,
      onBalance: (addr, bal) => balances.push({ addr, bal }),
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    await flush();
    balances.length = 0;
    await handle.setToken(TOKEN_2);
    // Should emit a clear (TOKEN, 0) BEFORE the active token changes.
    const clearEmit = balances.find((b) => b.addr === TOKEN && b.bal === 0);
    expect(clearEmit).toBeTruthy();
  });

  it('head strip shows total holdings value across all items', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const acc = makeAccount();
    mountMyWalletTab(c, {
      apiClient: makeApi([
        makeItem({ valuePitchDisplay: 30 }),
        makeItem({ token: TOKEN_2, symbol: 'BRA', valuePitchDisplay: 25, pnlPitchDisplay: 5 }),
      ]),
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    await flush();
    const head = c.querySelector('[data-test-id="mywallet-head"]');
    expect(head).toBeTruthy();
    expect(c.querySelector('[data-test-id="mywallet-head-value"]').textContent).toContain('55');
  });

  it('country row with hasFlag symbol renders flag img', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const acc = makeAccount();
    mountMyWalletTab(c, {
      apiClient: makeApi([makeItem({ symbol: 'BRA', kind: 'country' })]),
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    await flush();
    const img = c.querySelector('[data-test-id="mywallet-flag"]');
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe('/flags/br.svg');
  });

  it('player row renders placeholder flag (no img)', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const acc = makeAccount();
    mountMyWalletTab(c, {
      apiClient: makeApi([makeItem({ symbol: 'MESSI', kind: 'player' })]),
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    await flush();
    expect(c.querySelector('[data-test-id="mywallet-flag"]')).toBeFalsy();
    expect(c.querySelector('.pt-mywallet__flag--placeholder')).toBeTruthy();
  });

  it('selecting a held token renders its focused card (replaces table)', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const acc = makeAccount();
    mountMyWalletTab(c, {
      apiClient: makeApi([makeItem({ token: TOKEN }), makeItem({ token: TOKEN_2, symbol: 'BRA' })]),
      token: TOKEN,
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    await flush();
    const card = c.querySelector('[data-test-id="mywallet-card"]');
    expect(card).toBeTruthy();
    expect(card.dataset.token).toBe(TOKEN);
    expect(c.querySelector('[data-test-id="mywallet-row"]')).toBeFalsy();
  });

  it('account-change to disconnect clears portfolio and emits onBalance=0', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const balances = [];
    const acc = makeAccount();
    mountMyWalletTab(c, {
      apiClient: makeApi(),
      token: TOKEN,
      onBalance: (addr, bal) => balances.push({ addr, bal }),
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    await flush();
    balances.length = 0;
    acc.setState({ isConnected: false, address: null });
    await flush();
    expect(c.querySelector('[data-test-id="mywallet-disconnected"]')).toBeTruthy();
    const clearEmit = balances.find((b) => b.addr === TOKEN && b.bal === 0);
    expect(clearEmit).toBeTruthy();
  });

  it('account-change to connect (when premium) triggers fetch', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const api = makeApi();
    const acc = makeAccount({ connected: false });
    mountMyWalletTab(c, {
      apiClient: api,
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    await flush();
    expect(api.getPortfolio).not.toHaveBeenCalled();
    acc.setState({ isConnected: true, address: '0xUSER' });
    await flush();
    expect(api.getPortfolio).toHaveBeenCalledTimes(1);
  });

  it('discards stale response from a previous fetch when refresh() is called rapidly', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    let resolveFirst;
    const firstPromise = new Promise((res) => {
      resolveFirst = res;
    });
    const api = {
      getPortfolio: vi
        .fn()
        .mockImplementationOnce(() => firstPromise)
        .mockImplementationOnce(async () => ({
          items: [makeItem({ token: TOKEN_2, symbol: 'BRA', balanceDisplay: 9.9 })],
        })),
    };
    const acc = makeAccount();
    const handle = mountMyWalletTab(c, {
      apiClient: api,
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    await flush();
    // First fetch in flight; trigger a refresh.
    const second = handle.refresh();
    // Now resolve the stale first fetch — should be discarded.
    resolveFirst({ items: [makeItem({ token: TOKEN, symbol: 'OLD', balanceDisplay: 1.1 })] });
    await second;
    await flush();
    const rows = c.querySelectorAll('[data-test-id="mywallet-row"]');
    expect(rows.length).toBe(1);
    expect(rows[0].dataset.token).toBe(TOKEN_2);
  });

  it('falls back to wei-string parsing when *Display fields are missing', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const acc = makeAccount();
    // 5e18 wei = 5.0 display
    mountMyWalletTab(c, {
      apiClient: {
        getPortfolio: vi.fn(async () => ({
          items: [
            {
              token: TOKEN,
              symbol: 'FRA',
              kind: 'country',
              balance: '5000000000000000000',
              avgEntryPitch: '2000000000000000000',
              currentPricePitch: '3000000000000000000',
              valuePitch: '15000000000000000000',
              pnlPitch: '5000000000000000000',
            },
          ],
        })),
      },
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    await flush();
    const row = c.querySelector('[data-test-id="mywallet-row"]');
    expect(row).toBeTruthy();
    // Balance cell should show 5
    expect(row.textContent).toContain('5');
  });

  it('does not fetch when wallet is disconnected even if premium', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const api = makeApi();
    const acc = makeAccount({ connected: false });
    mountMyWalletTab(c, {
      apiClient: api,
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    await flush();
    expect(api.getPortfolio).not.toHaveBeenCalled();
  });

  it('total PnL pill flips between is-positive and is-negative', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const acc = makeAccount();
    mountMyWalletTab(c, {
      apiClient: makeApi([makeItem({ pnlPitchDisplay: -3.5 })]),
      getAccount: acc.getAccount,
      onAccountChange: acc.onAccountChange,
    });
    await flush();
    const pill = c.querySelector('[data-test-id="mywallet-head-pnl"]');
    expect(pill.className).toContain('is-negative');
    expect(pill.textContent).toContain('-3.5');
  });

  describe('single-token position card', () => {
    it('renders the card (not the table/head) when an active token is held', async () => {
      accessStore.set('premium');
      const c = makeContainer();
      const acc = makeAccount();
      mountMyWalletTab(c, {
        apiClient: makeApi([
          makeItem({ token: TOKEN, symbol: 'FRA' }),
          makeItem({ token: TOKEN_2, symbol: 'BRA' }),
        ]),
        token: TOKEN,
        getAccount: acc.getAccount,
        onAccountChange: acc.onAccountChange,
      });
      await flush();
      expect(c.querySelector('[data-test-id="mywallet-card"]')).toBeTruthy();
      // Table + head-totals are suppressed in card mode.
      expect(c.querySelector('[data-test-id="mywallet-list"]')).toBeFalsy();
      expect(c.querySelector('[data-test-id="mywallet-head"]')).toBeFalsy();
      expect(c.querySelector('[data-test-id="mywallet-card"]').dataset.token).toBe(TOKEN);
    });

    it('shows all six metric rows with PITCH-suffixed values', async () => {
      accessStore.set('premium');
      const c = makeContainer();
      const acc = makeAccount();
      mountMyWalletTab(c, {
        apiClient: makeApi([
          makeItem({
            token: TOKEN,
            symbol: 'FRA',
            balanceDisplay: 1250,
            valuePitchDisplay: 84.3,
            avgEntryPitchDisplay: 0.0612,
            breakEvenPitchDisplay: 0.054,
            realizedPitchDisplay: 3.1,
          }),
        ]),
        token: TOKEN,
        getAccount: acc.getAccount,
        onAccountChange: acc.onAccountChange,
      });
      await flush();
      expect(c.querySelector('[data-test-id="mywallet-card-qty"]').textContent).toContain('1,250');
      expect(c.querySelector('[data-test-id="mywallet-card-value"]').textContent).toBe(
        '84.3 PITCH',
      );
      expect(c.querySelector('[data-test-id="mywallet-card-avg"]').textContent).toBe('0.0612');
      expect(c.querySelector('[data-test-id="mywallet-card-breakeven"]').textContent).toBe('0.054');
      expect(c.querySelector('[data-test-id="mywallet-card-realized"]').textContent).toBe(
        '+3.1 PITCH',
      );
    });

    it('colors gains green and losses red', async () => {
      accessStore.set('premium');
      const c = makeContainer();
      const acc = makeAccount();
      mountMyWalletTab(c, {
        apiClient: makeApi([
          makeItem({ token: TOKEN, pnlPitchDisplay: 9.3, realizedPitchDisplay: -2.0 }),
        ]),
        token: TOKEN,
        getAccount: acc.getAccount,
        onAccountChange: acc.onAccountChange,
      });
      await flush();
      expect(c.querySelector('[data-test-id="mywallet-card-pnl"]').className).toContain(
        'is-positive',
      );
      expect(c.querySelector('[data-test-id="mywallet-card-realized"]').className).toContain(
        'is-negative',
      );
      expect(c.querySelector('[data-test-id="mywallet-card-pnlpct"]').className).toContain(
        'is-positive',
      );
    });

    it('shows em-dash for break-even when floored at 0', async () => {
      accessStore.set('premium');
      const c = makeContainer();
      const acc = makeAccount();
      mountMyWalletTab(c, {
        apiClient: makeApi([makeItem({ token: TOKEN, breakEvenPitchDisplay: 0 })]),
        token: TOKEN,
        getAccount: acc.getAccount,
        onAccountChange: acc.onAccountChange,
      });
      await flush();
      expect(c.querySelector('[data-test-id="mywallet-card-breakeven"]').textContent).toBe('—');
    });

    it('falls back to table when no token selected, empty-state when token not held', async () => {
      accessStore.set('premium');
      const c = makeContainer();
      const acc = makeAccount();
      // No token → table.
      const handle = mountMyWalletTab(c, {
        apiClient: makeApi([makeItem({ token: TOKEN_2, symbol: 'BRA' })]),
        getAccount: acc.getAccount,
        onAccountChange: acc.onAccountChange,
      });
      await flush();
      expect(c.querySelector('[data-test-id="mywallet-list"]')).toBeTruthy();
      expect(c.querySelector('[data-test-id="mywallet-card"]')).toBeFalsy();
      // Select a token the user does NOT hold → scoped empty state, no card.
      await handle.setToken(TOKEN);
      expect(c.querySelector('[data-test-id="mywallet-empty"]')).toBeTruthy();
      expect(c.querySelector('[data-test-id="mywallet-card"]')).toBeFalsy();
    });
  });
});
