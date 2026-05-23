// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountProfile } from '../src/profile.js';

// ── Chart lib stub (subset of lightweight-charts used by profile.js) ──
function makeChartLib() {
  const created = { charts: [] };
  const lib = {
    createChart: vi.fn((container, opts) => {
      const series = {
        data: null,
        setData: vi.fn(function (d) { this.data = d; }),
      };
      const chart = {
        container,
        opts,
        series,
        removed: false,
        addLineSeries: vi.fn(function () { return series; }),
        remove: vi.fn(function () { this.removed = true; }),
      };
      created.charts.push(chart);
      return chart;
    }),
  };
  return { lib, created };
}

function makeProfilePayload(overrides = {}) {
  return {
    address: '0xabc',
    summary: {
      totalValuePitch: 1234.56,
      realizedPnlPitch: 100.0,
      unrealizedPnlPitch: -50.0,
      totalPnlPitch: 50.0,
      roiPct: 5.0,
      openPositions: 4,
      feesPaidPitch: 12.34,
    },
    positions: [
      {
        token: '0xpos1', symbol: 'PLR', kind: 'player', country: 'Brazil',
        role: 'captain', qty: 1.0, avgBuy: 12.5, currentPrice: 12.35,
        valuePitch: 12.35, unrealizedPnlPitch: -0.15, unrealizedPct: -1.2,
        sharePct: 1.0,
      },
    ],
    closed: [
      {
        token: '0xclo1', symbol: 'CLO', kind: 'player', country: 'Germany',
        realizedPnlPitch: 10.5, buys: 3, sells: 3, lastTs: 1709000000,
      },
    ],
    trades: {
      items: [
        {
          symbol: 'PLR', kind: 'player', type: 'buy',
          price: 12.5, marketPrice: 11.875, amount: 1.0,
          valuePitch: 12.35, feePitch: 0.625,
          timestamp: 1709000000, tx: '0xdeadbeef00000000',
        },
      ],
      nextCursor: 'CURSOR_PAGE_2',
      limit: 100,
    },
    stats: {
      totalTrades: 100, buys: 60, sells: 40,
      volumePitch: 5000.0, avgTradePitch: 50.0,
      feesPaidPitch: 12.34, closedPositions: 5, winRatePct: 60.0,
      best: { symbol: 'PLR', pnlPitch: 20.0 },
      worst: { symbol: 'PLR2', pnlPitch: -5.0 },
    },
    allocation: {
      byCountry: { Brazil: 800.0, Germany: 434.56 },
      byRole: { captain: 600.0, best: 400.0, rookie: 234.56 },
      players: 1000.0,
      countries: 234.56,
    },
    balances: {
      ethWei: '12345000000000000000',
      pitchWei: '98765000000000000000',
      countries: [
        { address: '0xbra', symbol: 'BRA', wei: '1000000000000000000' },
      ],
    },
    valueSeries: [
      { time: 1708000000, value: 1000.0 },
      { time: 1709000000, value: 1234.56 },
    ],
    ...overrides,
  };
}

function makeApi(payload) {
  // Default referral stubs: 404 so the section renders in "no handle" state
  // (always visible, doesn't break existing assertions for other blocks).
  const refErr = Object.assign(new Error('not found'), { status: 404, code: 'referral.not_found' });
  return {
    getProfile: vi.fn().mockResolvedValue(payload ?? makeProfilePayload()),
    getRefMe: vi.fn().mockRejectedValue(refErr),
    putRefMe: vi.fn().mockResolvedValue({ code: 'newcode', wallet: '0xabc', claimedAt: 1709000000 }),
    deleteRefMe: vi.fn().mockResolvedValue(null),
  };
}

async function flush() {
  // Run microtasks (promise callbacks) so async loadProfile finishes.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('mountProfile', () => {
  let container;

  beforeEach(() => {
    document.body.replaceChildren();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('throws when container is not an HTMLElement', () => {
    expect(() => mountProfile(null)).toThrow(TypeError);
    expect(() => mountProfile({})).toThrow(TypeError);
  });

  it('renders all blocks after initial load', async () => {
    const { lib } = makeChartLib();
    const api = makeApi();
    mountProfile(container, { apiClient: api, chartLibFactory: () => lib });
    await flush();
    expect(api.getProfile).toHaveBeenCalledTimes(1);

    expect(container.querySelector('[data-test-id="profile-summary"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="profile-value-chart"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="profile-allocation"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="profile-balances"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="profile-stats"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="profile-positions"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="profile-closed"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="profile-trades"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="profile-orders"]')).not.toBeNull();
  });

  it('renders summary values formatted', async () => {
    const { lib } = makeChartLib();
    const api = makeApi();
    mountProfile(container, { apiClient: api, chartLibFactory: () => lib });
    await flush();

    const totVal = container.querySelector('[data-test-id="profile-summary-totalValuePitch"]');
    expect(totVal.textContent).toContain('1,234.56');

    const realised = container.querySelector('[data-test-id="profile-summary-realizedPnlPitch"]');
    expect(realised.textContent.startsWith('+')).toBe(true);
    expect(realised.classList.contains('positive')).toBe(true);

    const unrealised = container.querySelector('[data-test-id="profile-summary-unrealizedPnlPitch"]');
    expect(unrealised.classList.contains('negative')).toBe(true);

    const roi = container.querySelector('[data-test-id="profile-summary-roiPct"]');
    expect(roi.textContent).toContain('5.00%');
  });

  it('renders balances formatted from wei strings', async () => {
    const { lib } = makeChartLib();
    const api = makeApi();
    mountProfile(container, { apiClient: api, chartLibFactory: () => lib });
    await flush();

    const eth = container.querySelector('[data-test-id="profile-balance-eth"]');
    // 12.345 ETH
    expect(eth.textContent).toBe('12.345');
    const pitch = container.querySelector('[data-test-id="profile-balance-pitch"]');
    expect(pitch.textContent).toBe('98.765');
    const bra = container.querySelector('[data-test-id="profile-balance-bra"]');
    expect(bra.textContent).toBe('1');
  });

  it('renders positions table with one row per position', async () => {
    const { lib } = makeChartLib();
    const api = makeApi();
    mountProfile(container, { apiClient: api, chartLibFactory: () => lib });
    await flush();

    const rows = container.querySelectorAll('[data-test-id="profile-position-row"]');
    expect(rows.length).toBe(1);
    const tokenBtn = rows[0].querySelector('[data-test-id="profile-position-token"]');
    expect(tokenBtn.textContent).toBe('PLR');
    expect(tokenBtn.dataset.address).toBe('0xpos1');
  });

  it('clicking a token in positions invokes onTokenSelect and back-switches to dashboard', async () => {
    const { lib } = makeChartLib();
    const api = makeApi();
    const onTokenSelect = vi.fn();
    mountProfile(container, { apiClient: api, chartLibFactory: () => lib, onTokenSelect });
    await flush();

    const btn = container.querySelector('[data-test-id="profile-position-token"]');
    btn.click();
    expect(onTokenSelect).toHaveBeenCalledTimes(1);
    expect(onTokenSelect.mock.calls[0][0]).toMatchObject({
      address: '0xpos1',
      symbol: 'PLR',
      kind: 'player',
    });
  });

  it('renders trades and shows pager — prev disabled, next enabled when nextCursor present', async () => {
    const { lib } = makeChartLib();
    const api = makeApi();
    mountProfile(container, { apiClient: api, chartLibFactory: () => lib });
    await flush();

    const tradeRows = container.querySelectorAll('[data-test-id="profile-trade-row"]');
    expect(tradeRows.length).toBe(1);
    const prev = container.querySelector('[data-test-id="profile-trades-prev"]');
    const next = container.querySelector('[data-test-id="profile-trades-next"]');
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
  });

  it('paginates trades forward via cursor and backward via history', async () => {
    const { lib } = makeChartLib();
    const page1 = makeProfilePayload();
    const page2 = makeProfilePayload({
      trades: {
        items: [
          { symbol: 'P2', kind: 'player', type: 'sell', price: 1, amount: 1, valuePitch: 1, feePitch: 0.05, timestamp: 1710000000, tx: '0xpage2tx' },
        ],
        nextCursor: null,
        limit: 100,
      },
    });
    const refErr = Object.assign(new Error('not found'), { status: 404 });
    const api = {
      getProfile: vi
        .fn()
        .mockResolvedValueOnce(page1)
        .mockResolvedValueOnce(page2)
        .mockResolvedValueOnce(page1),
      getRefMe: vi.fn().mockRejectedValue(refErr),
      putRefMe: vi.fn(),
      deleteRefMe: vi.fn(),
    };
    const handle = mountProfile(container, { apiClient: api, chartLibFactory: () => lib });
    await flush();
    expect(handle._getState().tradesCount).toBe(1);
    expect(handle._getState().nextCursor).toBe('CURSOR_PAGE_2');

    const next = container.querySelector('[data-test-id="profile-trades-next"]');
    next.click();
    await flush();

    expect(api.getProfile).toHaveBeenCalledTimes(2);
    // Second call should include the cursor.
    expect(api.getProfile.mock.calls[1][0]).toMatchObject({ tradesCursor: 'CURSOR_PAGE_2' });
    expect(handle._getState().nextCursor).toBeNull();
    expect(handle._getState().historyDepth).toBe(1);

    // After moving to page 2, next is disabled, prev is enabled.
    const prev = container.querySelector('[data-test-id="profile-trades-prev"]');
    const nextAfter = container.querySelector('[data-test-id="profile-trades-next"]');
    expect(prev.disabled).toBe(false);
    expect(nextAfter.disabled).toBe(true);

    // Click prev → loads first page again (cursor=undefined).
    prev.click();
    await flush();
    expect(api.getProfile).toHaveBeenCalledTimes(3);
    expect(api.getProfile.mock.calls[2][0]).toMatchObject({ tradesCursor: undefined });
    expect(handle._getState().historyDepth).toBe(0);
  });

  it('shows 402 error message when /profile returns payment_required', async () => {
    const err = new Error('payment_required');
    err.status = 402;
    const refErr = Object.assign(new Error('not found'), { status: 404 });
    const api = {
      getProfile: vi.fn().mockRejectedValue(err),
      getRefMe: vi.fn().mockRejectedValue(refErr),
      putRefMe: vi.fn(),
      deleteRefMe: vi.fn(),
    };
    const { lib } = makeChartLib();
    mountProfile(container, { apiClient: api, chartLibFactory: () => lib });
    await flush();

    const status = container.querySelector('[data-test-id="profile-status"]');
    expect(status.hidden).toBe(false);
    expect(status.textContent).toMatch(/оплат/i);
  });

  it('shows 401 error message when unauthenticated', async () => {
    const err = new Error('unauthenticated');
    err.status = 401;
    const refErr = Object.assign(new Error('unauthenticated'), { status: 401 });
    const api = {
      getProfile: vi.fn().mockRejectedValue(err),
      getRefMe: vi.fn().mockRejectedValue(refErr),
      putRefMe: vi.fn(),
      deleteRefMe: vi.fn(),
    };
    const { lib } = makeChartLib();
    mountProfile(container, { apiClient: api, chartLibFactory: () => lib });
    await flush();

    const status = container.querySelector('[data-test-id="profile-status"]');
    expect(status.textContent).toMatch(/кошельком/i);
  });

  it('renders empty stubs when blocks are missing', async () => {
    const empty = {
      address: '0xabc',
      summary: null,
      positions: [],
      closed: [],
      trades: { items: [], nextCursor: null, limit: 100 },
      stats: null,
      allocation: null,
      balances: null,
      valueSeries: [],
    };
    const refErr = Object.assign(new Error('not found'), { status: 404 });
    const api = {
      getProfile: vi.fn().mockResolvedValue(empty),
      getRefMe: vi.fn().mockRejectedValue(refErr),
      putRefMe: vi.fn(),
      deleteRefMe: vi.fn(),
    };
    const { lib } = makeChartLib();
    mountProfile(container, { apiClient: api, chartLibFactory: () => lib });
    await flush();

    // Positions and closed both show "empty" placeholder.
    expect(container.querySelector('[data-test-id="profile-positions"] .pt-profile__empty')).not.toBeNull();
    expect(container.querySelector('[data-test-id="profile-closed"] .pt-profile__empty')).not.toBeNull();
    expect(container.querySelector('[data-test-id="profile-trades"] .pt-profile__empty')).not.toBeNull();
    // Orders block always present, shows empty stub.
    expect(container.querySelector('[data-test-id="profile-orders-empty"]')).not.toBeNull();
  });

  it('renders value-series via lightweight-charts addLineSeries with sorted data', async () => {
    const { lib, created } = makeChartLib();
    // Pass time out of order to test sorting.
    const payload = makeProfilePayload({
      valueSeries: [
        { time: 1709000000, value: 1234.56 },
        { time: 1708000000, value: 1000.0 },
      ],
    });
    const api = makeApi(payload);
    mountProfile(container, { apiClient: api, chartLibFactory: () => lib });
    await flush();
    await flush();

    expect(created.charts.length).toBe(1);
    const chart = created.charts[0];
    expect(chart.addLineSeries).toHaveBeenCalledTimes(1);
    const data = chart.series.data;
    expect(data.map((p) => p.time)).toEqual([1708000000, 1709000000]);
    expect(data.map((p) => p.value)).toEqual([1000.0, 1234.56]);
  });

  it('reload() re-fetches /profile', async () => {
    const { lib } = makeChartLib();
    const api = makeApi();
    const handle = mountProfile(container, { apiClient: api, chartLibFactory: () => lib });
    await flush();
    expect(api.getProfile).toHaveBeenCalledTimes(1);
    handle.reload();
    await flush();
    expect(api.getProfile).toHaveBeenCalledTimes(2);
  });

  it('destroy() clears the container', async () => {
    const { lib } = makeChartLib();
    const api = makeApi();
    const handle = mountProfile(container, { apiClient: api, chartLibFactory: () => lib });
    await flush();
    handle.destroy();
    expect(container.children.length).toBe(0);
  });
});
