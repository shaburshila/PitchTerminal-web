// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountBottomTabs } from '../src/components/bottom/index.js';

const TOKEN_A = '0xaaa1';
const TOKEN_B = '0xbbb2';

function makeTradesResponse({ items = [], wallets = [], nextCursor = null, totalTrades = 0 } = {}) {
  return {
    trades: { items, nextCursor, limit: 100 },
    wallets,
    totalTrades,
    myWallet: { configured: false },
  };
}

function sampleTrades() {
  return [
    {
      type: 'buy',
      trader: '0x0000000000000000000000000000000000000001',
      baseValue: 12.5,
      tokenValue: 1.0,
      price: 12.5,
      marketPrice: 11.875,
      fee: 0.625,
      tx: '0xtx1',
      timestamp: 1709000000,
    },
    {
      type: 'sell',
      trader: '0x0000000000000000000000000000000000000002',
      baseValue: 6.0,
      tokenValue: 0.5,
      price: 12.0,
      marketPrice: 12.1,
      fee: 0.3,
      tx: '0xtx2',
      timestamp: 1709000050,
    },
  ];
}

function sampleWallets() {
  return [
    {
      address: '0x0000000000000000000000000000000000000001',
      buys: 3,
      sells: 0,
      position: 30,
      spent: 100,
      received: 0,
      avgBuy: 3.33,
      avgNet: 3.33,
    },
    {
      address: '0x0000000000000000000000000000000000000002',
      buys: 2,
      sells: 1,
      position: 10,
      spent: 50,
      received: 12,
      avgBuy: 2.5,
      avgNet: 1.9,
    },
    {
      address: '0x0000000000000000000000000000000000000003',
      buys: 1,
      sells: 1,
      position: 0,
      spent: 12,
      received: 13,
      avgBuy: 12,
      avgNet: 1,
    },
  ];
}

function makeApi(response) {
  return {
    getTrades: vi.fn().mockResolvedValue(response),
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('mountBottomTabs', () => {
  let container;

  beforeEach(() => {
    document.body.replaceChildren();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('builds tabs shell and panes', () => {
    const api = makeApi(makeTradesResponse());
    mountBottomTabs(container, { apiClient: api });
    expect(container.querySelector('[data-test-id="bottom"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="bottom-tabs"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="bottom-tab-trades"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="bottom-tab-holders"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="bottom-pane-trades"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="bottom-pane-holders"]')).not.toBeNull();
  });

  it('throws when container is not an HTMLElement', () => {
    expect(() => mountBottomTabs(null)).toThrow(TypeError);
    expect(() => mountBottomTabs({})).toThrow(TypeError);
  });

  it('default tab is Trades (aria-selected=true)', () => {
    const api = makeApi(makeTradesResponse());
    mountBottomTabs(container, { apiClient: api });
    expect(
      container.querySelector('[data-test-id="bottom-tab-trades"]').getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      container.querySelector('[data-test-id="bottom-tab-holders"]').getAttribute('aria-selected'),
    ).toBe('false');
  });

  it('no API call until setToken is invoked', () => {
    const api = makeApi(makeTradesResponse());
    mountBottomTabs(container, { apiClient: api });
    expect(api.getTrades).not.toHaveBeenCalled();
  });

  it('setToken triggers getTrades and renders trade rows', async () => {
    const api = makeApi(
      makeTradesResponse({ items: sampleTrades(), wallets: sampleWallets(), totalTrades: 99 }),
    );
    const handle = mountBottomTabs(container, { apiClient: api });
    await handle.setToken(TOKEN_A);

    expect(api.getTrades).toHaveBeenCalledWith(TOKEN_A, { limit: 100, cursor: null });
    const rows = container.querySelectorAll('[data-test-id="trade-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0].dataset.type).toBe('buy');
    expect(rows[1].dataset.type).toBe('sell');
  });

  it('renders holders pane from wallets[] sorted by position DESC, hides zero-balance', async () => {
    const api = makeApi(
      makeTradesResponse({ items: sampleTrades(), wallets: sampleWallets() }),
    );
    const handle = mountBottomTabs(container, { apiClient: api });
    await handle.setToken(TOKEN_A);

    const holdersTab = container.querySelector('[data-test-id="bottom-tab-holders"]');
    holdersTab.click();
    expect(holdersTab.getAttribute('aria-selected')).toBe('true');

    const rows = container.querySelectorAll('[data-test-id="holder-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0].dataset.rank).toBe('1');
    // Address ending in 1 has position=30, ending in 2 has position=10. Zero excluded.
    expect(rows[0].textContent).toContain('0x0000…0001');
    expect(rows[1].textContent).toContain('0x0000…0002');
  });

  it('computes share% across visible holders', async () => {
    const api = makeApi(
      makeTradesResponse({ items: [], wallets: sampleWallets() }),
    );
    const handle = mountBottomTabs(container, { apiClient: api });
    await handle.setToken(TOKEN_A);
    container.querySelector('[data-test-id="bottom-tab-holders"]').click();

    const rows = container.querySelectorAll('[data-test-id="holder-row"]');
    // Total position = 30 + 10 = 40 → top = 75%, second = 25%
    expect(rows[0].textContent).toContain('75.00%');
    expect(rows[1].textContent).toContain('25.00%');
  });

  it('highlights own row when myAddress matches trader', async () => {
    const api = makeApi(
      makeTradesResponse({ items: sampleTrades(), wallets: sampleWallets() }),
    );
    const handle = mountBottomTabs(container, {
      apiClient: api,
      myAddress: '0x0000000000000000000000000000000000000001',
    });
    await handle.setToken(TOKEN_A);

    const rows = container.querySelectorAll('[data-test-id="trade-row"]');
    expect(rows[0].dataset.mine).toBe('1');
    expect(rows[1].dataset.mine).toBe('0');

    container.querySelector('[data-test-id="bottom-tab-holders"]').click();
    const holderRows = container.querySelectorAll('[data-test-id="holder-row"]');
    expect(holderRows[0].dataset.mine).toBe('1');
    expect(holderRows[1].dataset.mine).toBe('0');
  });

  it('setMyAddress updates highlighting without re-fetching', async () => {
    const api = makeApi(
      makeTradesResponse({ items: sampleTrades(), wallets: sampleWallets() }),
    );
    const handle = mountBottomTabs(container, { apiClient: api });
    await handle.setToken(TOKEN_A);
    expect(api.getTrades).toHaveBeenCalledTimes(1);

    handle.setMyAddress('0x0000000000000000000000000000000000000002');
    const rows = container.querySelectorAll('[data-test-id="trade-row"]');
    expect(rows[0].dataset.mine).toBe('0');
    expect(rows[1].dataset.mine).toBe('1');
    expect(api.getTrades).toHaveBeenCalledTimes(1);
  });

  it('shows "Load more" button when nextCursor is present, then loads next page', async () => {
    const page1 = makeTradesResponse({
      items: sampleTrades(),
      wallets: sampleWallets(),
      nextCursor: '{"b":100,"l":3}',
    });
    const page2 = makeTradesResponse({
      items: [
        {
          type: 'buy',
          trader: '0x0000000000000000000000000000000000000004',
          baseValue: 2,
          tokenValue: 0.2,
          price: 10,
          marketPrice: 10,
          fee: 0.1,
          tx: '0xtx3',
          timestamp: 1708999000,
        },
      ],
      wallets: sampleWallets(),
    });
    const api = {
      getTrades: vi
        .fn()
        .mockResolvedValueOnce(page1)
        .mockResolvedValueOnce(page2),
    };
    const handle = mountBottomTabs(container, { apiClient: api });
    await handle.setToken(TOKEN_A);

    const more = container.querySelector('[data-test-id="bottom-load-more"]');
    expect(more).not.toBeNull();
    more.click();
    await flush();

    expect(api.getTrades).toHaveBeenCalledTimes(2);
    expect(api.getTrades).toHaveBeenLastCalledWith(TOKEN_A, {
      limit: 100,
      cursor: '{"b":100,"l":3}',
    });
    const rows = container.querySelectorAll('[data-test-id="trade-row"]');
    expect(rows.length).toBe(3);
    expect(container.querySelector('[data-test-id="bottom-load-more"]')).toBeNull();
  });

  it('switching token discards stale in-flight response (generation guard)', async () => {
    let resolveA;
    const respA = new Promise((res) => {
      resolveA = res;
    });
    const respB = makeTradesResponse({
      items: [
        {
          type: 'buy',
          trader: '0xfff',
          baseValue: 1,
          tokenValue: 1,
          price: 1,
          marketPrice: 1,
          fee: 0,
          tx: '0xtxB',
          timestamp: 1709001000,
        },
      ],
      wallets: [],
    });
    const api = {
      getTrades: vi
        .fn()
        .mockImplementationOnce(() => respA)
        .mockImplementationOnce(() => Promise.resolve(respB)),
    };
    const handle = mountBottomTabs(container, { apiClient: api });
    const p1 = handle.setToken(TOKEN_A);
    await handle.setToken(TOKEN_B);
    resolveA(makeTradesResponse({ items: sampleTrades(), wallets: sampleWallets() }));
    await p1;
    await flush();

    const rows = container.querySelectorAll('[data-test-id="trade-row"]');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('0xfff');
  });

  it('pushTrades prepends matching token trades and ignores others', async () => {
    const api = makeApi(makeTradesResponse({ items: sampleTrades(), wallets: [] }));
    const handle = mountBottomTabs(container, { apiClient: api });
    await handle.setToken(TOKEN_A);

    handle.pushTrades([
      {
        token: TOKEN_A,
        type: 'buy',
        trader: '0xnew',
        baseValue: 1,
        tokenValue: 1,
        price: 1,
        marketPrice: 1,
        tx: '0xtxNew',
        timestamp: 1709000999,
      },
      {
        token: TOKEN_B,
        type: 'sell',
        trader: '0xother',
        baseValue: 1,
        tokenValue: 1,
        price: 1,
        marketPrice: 1,
        tx: '0xtxOther',
        timestamp: 1709001000,
      },
    ]);

    const rows = container.querySelectorAll('[data-test-id="trade-row"]');
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toContain('0xnew');
  });

  it('pushTrades dedupes by tx hash', async () => {
    const api = makeApi(makeTradesResponse({ items: sampleTrades(), wallets: [] }));
    const handle = mountBottomTabs(container, { apiClient: api });
    await handle.setToken(TOKEN_A);

    // Push a trade with same tx as an existing one.
    handle.pushTrades([{ ...sampleTrades()[0], token: TOKEN_A }]);
    const rows = container.querySelectorAll('[data-test-id="trade-row"]');
    expect(rows.length).toBe(2);
  });

  it('preserves SSE-pushed trades that arrive during in-flight setToken fetch', async () => {
    let resolveFetch;
    const pending = new Promise((res) => {
      resolveFetch = res;
    });
    const api = { getTrades: vi.fn().mockReturnValueOnce(pending) };
    const handle = mountBottomTabs(container, { apiClient: api });

    const p = handle.setToken(TOKEN_A);
    // SSE delivers a trade for TOKEN_A while the fetch is still pending.
    handle.pushTrades([
      {
        token: TOKEN_A,
        type: 'buy',
        trader: '0xsse',
        baseValue: 1,
        tokenValue: 1,
        price: 1,
        marketPrice: 1,
        tx: '0xtxSse',
        timestamp: 1709000999,
      },
    ]);
    resolveFetch(makeTradesResponse({ items: sampleTrades(), wallets: [] }));
    await p;
    await flush();

    const rows = container.querySelectorAll('[data-test-id="trade-row"]');
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toContain('0xsse');
  });

  it('renders empty states for trades and holders when none exist', async () => {
    const api = makeApi(makeTradesResponse({ items: [], wallets: [] }));
    const handle = mountBottomTabs(container, { apiClient: api });
    await handle.setToken(TOKEN_A);
    expect(container.querySelector('[data-test-id="trades-empty"]')).not.toBeNull();
    container.querySelector('[data-test-id="bottom-tab-holders"]').click();
    expect(container.querySelector('[data-test-id="holders-empty"]')).not.toBeNull();
  });

  it('shows error string when getTrades rejects', async () => {
    const api = {
      getTrades: vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { detail: 'boom-detail' })),
    };
    const handle = mountBottomTabs(container, { apiClient: api });
    await handle.setToken(TOKEN_A);
    const status = container.querySelector('[data-test-id="bottom-status"]');
    expect(status.textContent).toContain('boom-detail');
  });

  it('trade rows include BaseScan links for address and tx', async () => {
    const api = makeApi(makeTradesResponse({ items: sampleTrades(), wallets: [] }));
    const handle = mountBottomTabs(container, { apiClient: api });
    await handle.setToken(TOKEN_A);

    const links = container.querySelectorAll('[data-test-id="trade-row"] a');
    const hrefs = Array.from(links).map((a) => a.getAttribute('href'));
    expect(hrefs.some((h) => h.startsWith('https://basescan.org/address/'))).toBe(true);
    expect(hrefs.some((h) => h.startsWith('https://basescan.org/tx/'))).toBe(true);
    for (const a of links) {
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      expect(a.getAttribute('target')).toBe('_blank');
    }
  });

  // ── Phase 1.5 batch 6 — visual redesign ────────────────────────────────
  describe('Phase 1.5 batch 6 redesign', () => {
    it('renders tab labels + hidden count badges initially', () => {
      const api = makeApi(makeTradesResponse());
      mountBottomTabs(container, { apiClient: api });
      // Each tab has a label span + a count span (initially hidden).
      const labelTrades = container.querySelector(
        '[data-test-id="bottom-tab-trades"] .pt-bottom__tab-label',
      );
      expect(labelTrades).toBeTruthy();
      expect(labelTrades.textContent).toBe('Trades');
      const counter = container.querySelector('[data-test-id="bottom-tab-count-trades"]');
      expect(counter).toBeTruthy();
      expect(counter.hidden).toBe(true);
    });

    it('populates trades + holders count badges after setToken loads data', async () => {
      const api = makeApi(
        makeTradesResponse({
          items: sampleTrades(),
          wallets: sampleWallets(),
          totalTrades: 42,
        }),
      );
      const handle = mountBottomTabs(container, { apiClient: api });
      await handle.setToken(TOKEN_A);

      const tradesCount = container.querySelector('[data-test-id="bottom-tab-count-trades"]');
      const holdersCount = container.querySelector('[data-test-id="bottom-tab-count-holders"]');
      expect(tradesCount.hidden).toBe(false);
      expect(tradesCount.textContent).toBe('42');
      // Holders = positive-position wallets = 2 (third has position=0).
      expect(holdersCount.hidden).toBe(false);
      expect(holdersCount.textContent).toBe('2');
    });

    it('setToken accepts (addr, meta) and threads meta to lazy sub-tabs without crashing', async () => {
      const api = makeApi(makeTradesResponse());
      const handle = mountBottomTabs(container, { apiClient: api });
      // Just ensure the 2-arg signature is accepted (and no exception thrown).
      await handle.setToken(TOKEN_A, { symbol: 'FRA', kind: 'country', name: 'France' });
      expect(api.getTrades).toHaveBeenCalledWith(TOKEN_A, { limit: 100, cursor: null });
    });

    it('setToken with same address but fresh meta literal does not re-fetch trades', async () => {
      const api = makeApi(makeTradesResponse());
      const handle = mountBottomTabs(container, { apiClient: api });
      await handle.setToken(TOKEN_A, { symbol: 'FRA', kind: 'country' });
      expect(api.getTrades).toHaveBeenCalledTimes(1);
      // Same address, fresh literal — reference-inequal but data unchanged.
      await handle.setToken(TOKEN_A, { symbol: 'FRA', kind: 'country' });
      await handle.setToken(TOKEN_A, { symbol: 'FRA', kind: 'country' });
      expect(api.getTrades).toHaveBeenCalledTimes(1);
    });
  });

  // ── Phase 1.5: premium-gating on My Wallet + Orders tab BUTTONS ─────────
  describe('premium tab gating (lock badge on tab button)', () => {
    function makeAccess(initial = 'free') {
      let state = initial;
      const listeners = new Set();
      return {
        getAccessState: () => state,
        subscribeAccess: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        set(next) {
          state = next;
          for (const fn of [...listeners]) fn(next);
        },
      };
    }

    it('adds .is-locked + aria-disabled to My Wallet + Orders tabs for non-premium users', () => {
      const access = makeAccess('free');
      const openPayModal = vi.fn();
      mountBottomTabs(container, {
        apiClient: makeApi(makeTradesResponse()),
        getAccessState: access.getAccessState,
        subscribeAccess: access.subscribeAccess,
        softLock: { openPayModal },
      });
      const myWallet = container.querySelector('[data-test-id="bottom-tab-my-wallet"]');
      const orders = container.querySelector('[data-test-id="bottom-tab-orders"]');
      const trades = container.querySelector('[data-test-id="bottom-tab-trades"]');
      expect(myWallet.classList.contains('is-locked')).toBe(true);
      expect(orders.classList.contains('is-locked')).toBe(true);
      expect(trades.classList.contains('is-locked')).toBe(false);
      expect(myWallet.getAttribute('aria-disabled')).toBe('true');
      expect(orders.getAttribute('aria-disabled')).toBe('true');
      // Lock badge nodes are appended once and revealed via CSS.
      expect(
        container.querySelector('[data-test-id="bottom-tab-lock-my-wallet"]'),
      ).not.toBeNull();
      expect(container.querySelector('[data-test-id="bottom-tab-lock-orders"]')).not.toBeNull();
    });

    it('does NOT lock tabs for premium users', () => {
      const access = makeAccess('premium');
      mountBottomTabs(container, {
        apiClient: makeApi(makeTradesResponse()),
        getAccessState: access.getAccessState,
        subscribeAccess: access.subscribeAccess,
        softLock: { openPayModal: vi.fn() },
      });
      const myWallet = container.querySelector('[data-test-id="bottom-tab-my-wallet"]');
      const orders = container.querySelector('[data-test-id="bottom-tab-orders"]');
      expect(myWallet.classList.contains('is-locked')).toBe(false);
      expect(orders.classList.contains('is-locked')).toBe(false);
      expect(myWallet.getAttribute('aria-disabled')).toBe('false');
      expect(orders.getAttribute('aria-disabled')).toBe('false');
    });

    it('click on locked My Wallet tab opens pay modal and does NOT switch tab', () => {
      const access = makeAccess('free');
      const openPayModal = vi.fn();
      mountBottomTabs(container, {
        apiClient: makeApi(makeTradesResponse()),
        getAccessState: access.getAccessState,
        subscribeAccess: access.subscribeAccess,
        softLock: { openPayModal },
      });
      const myWallet = container.querySelector('[data-test-id="bottom-tab-my-wallet"]');
      myWallet.click();
      expect(openPayModal).toHaveBeenCalledTimes(1);
      // Tab did NOT switch — trades stays selected.
      expect(
        container.querySelector('[data-test-id="bottom-tab-trades"]').getAttribute('aria-selected'),
      ).toBe('true');
      expect(myWallet.getAttribute('aria-selected')).toBe('false');
    });

    it('click on locked Orders tab opens pay modal', () => {
      const access = makeAccess('free');
      const openPayModal = vi.fn();
      mountBottomTabs(container, {
        apiClient: makeApi(makeTradesResponse()),
        getAccessState: access.getAccessState,
        subscribeAccess: access.subscribeAccess,
        softLock: { openPayModal },
      });
      container.querySelector('[data-test-id="bottom-tab-orders"]').click();
      expect(openPayModal).toHaveBeenCalledTimes(1);
    });

    it('flipping access to premium removes .is-locked from premium tabs', () => {
      const access = makeAccess('free');
      mountBottomTabs(container, {
        apiClient: makeApi(makeTradesResponse()),
        getAccessState: access.getAccessState,
        subscribeAccess: access.subscribeAccess,
        softLock: { openPayModal: vi.fn() },
      });
      const myWallet = container.querySelector('[data-test-id="bottom-tab-my-wallet"]');
      expect(myWallet.classList.contains('is-locked')).toBe(true);
      access.set('premium');
      expect(myWallet.classList.contains('is-locked')).toBe(false);
      expect(myWallet.getAttribute('aria-disabled')).toBe('false');
    });

    it('premium user clicking My Wallet switches the tab (no pay modal)', () => {
      const access = makeAccess('premium');
      const openPayModal = vi.fn();
      mountBottomTabs(container, {
        apiClient: makeApi(makeTradesResponse()),
        getAccessState: access.getAccessState,
        subscribeAccess: access.subscribeAccess,
        softLock: { openPayModal },
      });
      const myWallet = container.querySelector('[data-test-id="bottom-tab-my-wallet"]');
      myWallet.click();
      expect(openPayModal).not.toHaveBeenCalled();
      expect(myWallet.getAttribute('aria-selected')).toBe('true');
    });
  });

  it('destroy clears container', async () => {
    const api = makeApi(makeTradesResponse());
    const handle = mountBottomTabs(container, { apiClient: api });
    await handle.setToken(TOKEN_A);
    handle.destroy();
    expect(container.children.length).toBe(0);
  });
});
