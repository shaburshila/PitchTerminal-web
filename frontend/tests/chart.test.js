// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountChart } from '../src/chart.js';

// ── Stub chart-library ───────────────────────────────────────────────────
//
// Implements the subset of the lightweight-charts API mountChart actually
// touches. Each created chart records the series it spawned and every
// setData / setMarkers / update call so the tests can assert on real chart
// behaviour without rendering a canvas.

function makeChartLib() {
  const created = { charts: [] };

  function makeSeries(kind) {
    const series = {
      kind,
      data: null,
      markers: null,
      updates: [],
      setData: vi.fn(function (d) {
        this.data = d;
      }),
      setMarkers: vi.fn(function (m) {
        this.markers = m;
      }),
      update: vi.fn(function (point) {
        this.updates.push(point);
      }),
    };
    return series;
  }

  const lib = {
    createChart: vi.fn((container, opts) => {
      const chart = {
        container,
        opts,
        seriesList: [],
        removed: false,
        resizes: [],
        addCandlestickSeries: vi.fn(function () {
          const s = makeSeries('candle');
          this.seriesList.push(s);
          return s;
        }),
        addLineSeries: vi.fn(function () {
          const s = makeSeries('line');
          this.seriesList.push(s);
          return s;
        }),
        removeSeries: vi.fn(function (s) {
          this.seriesList = this.seriesList.filter((x) => x !== s);
        }),
        resize: vi.fn(function (w, h) {
          this.resizes.push([w, h]);
        }),
        remove: vi.fn(function () {
          this.removed = true;
        }),
      };
      created.charts.push(chart);
      return chart;
    }),
  };
  return { lib, created };
}

function makeChartPayload({ candles, points } = {}) {
  return {
    kind: 'player',
    name: 'Pulisic',
    symbol: 'PULISIC',
    country: 'USA',
    candles: candles ?? [
      { time: 1709000000, open: 10, high: 11, low: 9.5, close: 10.5, volume: 100 },
      { time: 1709000300, open: 10.5, high: 12, low: 10.4, close: 11.8, volume: 80 },
    ],
    points: points ?? [
      { time: 1709000100, price: 10.7, volume: 5, type: 'buy', trader: '0xabc' },
      { time: 1709000200, price: 11.2, volume: 3, type: 'sell', trader: '0xdef' },
      { time: 1709000400, price: 11.8, volume: 0, type: 'spot', trader: '' },
    ],
  };
}

function makeApi(payload) {
  return {
    getChart: vi.fn().mockResolvedValue(payload ?? makeChartPayload()),
  };
}

function makePlayer(overrides = {}) {
  return {
    address: '0xaaa1',
    kind: 'player',
    name: 'Pulisic',
    symbol: 'PULISIC',
    country: 'USA',
    role: 'captain',
    pricePitch: 11.8,
    priceCountry: 1.5,
    supply: '1000000000000000000000000', // 1_000_000 tokens
    tradesCount: 100,
    holdersCount: 42,
    changePct: { all: 5, '1d': -2, '12h': 1, '6h': 0.5, '1h': 0.1, '15m': 0 },
    ...overrides,
  };
}

function makeCountry(overrides = {}) {
  return {
    address: '0xccc1',
    kind: 'country',
    name: 'USA',
    symbol: 'USA',
    pricePitch: 0.01,
    supply: '500000000000000000000000',
    tradesCount: 50,
    holdersCount: 5,
    changePct: { all: 1, '1d': 0.5, '12h': 0, '6h': 0, '1h': 0, '15m': 0 },
    ...overrides,
  };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('mountChart', () => {
  let container;

  beforeEach(() => {
    document.body.replaceChildren();
    container = document.createElement('section');
    document.body.appendChild(container);
  });

  it('throws when container is not an HTMLElement', () => {
    expect(() => mountChart(null)).toThrow(TypeError);
    expect(() => mountChart({})).toThrow(TypeError);
  });

  it('builds toolbar (tf + type + unit) and stats bar skeleton', () => {
    const { lib } = makeChartLib();
    mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });

    expect(container.querySelector('[data-test-id="chart-toolbar"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="chart-tf"]')).not.toBeNull();
    for (const tf of ['1m', '5m', '15m', '1h', '4h', '1d']) {
      expect(container.querySelector(`[data-test-id="chart-tf-${tf}"]`)).not.toBeNull();
    }
    expect(container.querySelector('[data-test-id="chart-type-candles"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="chart-type-line"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="chart-unit-pitch"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="chart-unit-country"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="chart-stats"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="chart-canvas"]')).not.toBeNull();
  });

  it('default timeframe is 5m (aria-pressed=true)', () => {
    const { lib } = makeChartLib();
    mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
    const five = container.querySelector('[data-test-id="chart-tf-5m"]');
    const one = container.querySelector('[data-test-id="chart-tf-1m"]');
    expect(five.getAttribute('aria-pressed')).toBe('true');
    expect(one.getAttribute('aria-pressed')).toBe('false');
  });

  it('shows "Выберите токен" status before any setToken', () => {
    const { lib } = makeChartLib();
    mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
    const status = container.querySelector('[data-test-id="chart-status"]');
    expect(status.hidden).toBe(false);
    expect(status.textContent).toMatch(/Выберите токен/);
  });

  it('setToken triggers getChart with token addr + default tf, then renders series', async () => {
    const { lib, created } = makeChartLib();
    const api = makeApi();
    const chart = mountChart(container, { apiClient: api, chartLibFactory: () => lib });

    chart.setToken(makePlayer());
    await flush();

    expect(api.getChart).toHaveBeenCalledWith('0xaaa1', '5m');
    expect(created.charts.length).toBe(1);
    const series = created.charts[0].seriesList[0];
    expect(series.kind).toBe('candle');
    expect(series.data).toEqual(makeChartPayload().candles);
    // Markers: only buy + sell points, "spot" is filtered out.
    expect(series.markers.length).toBe(2);
    expect(series.markers[0].position).toBe('belowBar'); // buy
    expect(series.markers[1].position).toBe('aboveBar'); // sell
  });

  it('switching timeframe re-fetches and re-renders series', async () => {
    const { lib } = makeChartLib();
    const api = makeApi();
    const chart = mountChart(container, { apiClient: api, chartLibFactory: () => lib });

    chart.setToken(makePlayer());
    await flush();
    expect(api.getChart).toHaveBeenCalledTimes(1);

    const oneHour = container.querySelector('[data-test-id="chart-tf-1h"]');
    oneHour.click();
    await flush();

    expect(api.getChart).toHaveBeenCalledTimes(2);
    expect(api.getChart).toHaveBeenLastCalledWith('0xaaa1', '1h');
    expect(oneHour.getAttribute('aria-pressed')).toBe('true');
    const fiveM = container.querySelector('[data-test-id="chart-tf-5m"]');
    expect(fiveM.getAttribute('aria-pressed')).toBe('false');
  });

  it('clicking the same tf does NOT trigger a refetch', async () => {
    const { lib } = makeChartLib();
    const api = makeApi();
    const chart = mountChart(container, { apiClient: api, chartLibFactory: () => lib });
    chart.setToken(makePlayer());
    await flush();
    api.getChart.mockClear();

    container.querySelector('[data-test-id="chart-tf-5m"]').click();
    await flush();
    expect(api.getChart).not.toHaveBeenCalled();
  });

  it('switching type from candles to line rebuilds with addLineSeries', async () => {
    const { lib, created } = makeChartLib();
    const chart = mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
    chart.setToken(makePlayer());
    await flush();

    container.querySelector('[data-test-id="chart-type-line"]').click();
    await flush();

    const chartInst = created.charts[0];
    // candle series removed, line series active.
    const kinds = chartInst.seriesList.map((s) => s.kind);
    expect(kinds).toContain('line');
    const lineSeries = chartInst.seriesList.find((s) => s.kind === 'line');
    // Line data uses {time, value} pairs derived from candle.close.
    expect(lineSeries.data).toEqual([
      { time: 1709000000, value: 10.5 },
      { time: 1709000300, value: 11.8 },
    ]);
  });

  it('unit toggle is hidden for country tokens, visible for players', () => {
    const { lib } = makeChartLib();
    const chart = mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
    chart.setToken(makePlayer());
    const unitGroup = container.querySelector('[data-test-id="chart-unit"]');
    expect(unitGroup.hidden).toBe(false);

    chart.setToken(makeCountry());
    expect(unitGroup.hidden).toBe(true);
  });

  it('stats bar populates price, change, supply, mcap, holders', async () => {
    const { lib } = makeChartLib();
    const chart = mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
    chart.setToken(makePlayer());
    await flush();

    // Price = last candle close = 11.8.
    expect(container.querySelector('[data-test-id="chart-stat-price"]').textContent).toBe('11.80');
    // Change% for period=all = +5.0%.
    const changeEl = container.querySelector('[data-test-id="chart-stat-change"]');
    expect(changeEl.textContent).toBe('+5.0%');
    expect(changeEl.classList.contains('positive')).toBe(true);
    // Supply = 1M tokens → "1.00M".
    expect(container.querySelector('[data-test-id="chart-stat-supply"]').textContent).toBe('1.00M');
    // Mcap = 1_000_000 * 11.8 = 11_800_000 → "11.80M".
    expect(container.querySelector('[data-test-id="chart-stat-mcap"]').textContent).toBe('11.80M');
    expect(container.querySelector('[data-test-id="chart-stat-holders"]').textContent).toBe('42');
  });

  it('setPeriod switches which changePct is shown', async () => {
    const { lib } = makeChartLib();
    const chart = mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
    chart.setToken(makePlayer());
    await flush();

    // Default 'all' → +5.0%.
    expect(container.querySelector('[data-test-id="chart-stat-change"]').textContent).toBe('+5.0%');
    chart.setPeriod('1d');
    // 1d = -2 → "-2.0%".
    const changeEl = container.querySelector('[data-test-id="chart-stat-change"]');
    expect(changeEl.textContent).toBe('-2.0%');
    expect(changeEl.classList.contains('negative')).toBe(true);
  });

  it('applyPrice updates the last candle and calls series.update', async () => {
    const { lib, created } = makeChartLib();
    const chart = mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
    chart.setToken(makePlayer());
    await flush();

    const series = created.charts[0].seriesList[0];
    series.update.mockClear();
    chart.applyPrice('0xAAA1', 13.5);

    expect(series.update).toHaveBeenCalledTimes(1);
    const arg = series.update.mock.calls[0][0];
    expect(arg.close).toBe(13.5);
    expect(arg.high).toBeGreaterThanOrEqual(13.5);
    // Price stat reflects new close.
    expect(container.querySelector('[data-test-id="chart-stat-price"]').textContent).toBe('13.50');
  });

  it('applyPrice ignores ticks for other tokens', async () => {
    const { lib, created } = makeChartLib();
    const chart = mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
    chart.setToken(makePlayer());
    await flush();

    const series = created.charts[0].seriesList[0];
    series.update.mockClear();
    chart.applyPrice('0xbbb9', 999);
    expect(series.update).not.toHaveBeenCalled();
  });

  it('applyTrade appends a marker for the active token', async () => {
    const { lib, created } = makeChartLib();
    const chart = mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
    chart.setToken(makePlayer());
    await flush();
    const series = created.charts[0].seriesList[0];
    expect(series.markers.length).toBe(2);

    chart.applyTrade({ token: '0xaaa1', type: 'buy', time: 1709000500, price: 12.0 });
    expect(series.markers.length).toBe(3);
    expect(series.markers[2].position).toBe('belowBar');
  });

  it('applyTrade accepts SSE shape with `timestamp` field (api-spec §8.3)', async () => {
    const { lib, created } = makeChartLib();
    const chart = mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
    chart.setToken(makePlayer());
    await flush();
    const series = created.charts[0].seriesList[0];
    const before = series.markers.length;

    chart.applyTrade({ token: '0xaaa1', type: 'sell', timestamp: 1709000600, price: 11.5 });
    expect(series.markers.length).toBe(before + 1);
    expect(series.markers[series.markers.length - 1].position).toBe('aboveBar');
  });

  it('applyTrade keeps setMarkers sorted ascending by time', async () => {
    const { lib, created } = makeChartLib();
    const chart = mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
    chart.setToken(makePlayer());
    await flush();
    const series = created.charts[0].seriesList[0];

    chart.applyTrade({ token: '0xaaa1', type: 'buy', timestamp: 1709000800, price: 12.0 });
    chart.applyTrade({ token: '0xaaa1', type: 'sell', timestamp: 1709000400, price: 13.0 });

    const times = series.markers.map((m) => m.time);
    const sorted = [...times].sort((a, b) => a - b);
    expect(times).toEqual(sorted);
  });

  it('handles getChart rejection without throwing', async () => {
    const { lib } = makeChartLib();
    const api = { getChart: vi.fn().mockRejectedValue(new Error('boom')) };
    const chart = mountChart(container, { apiClient: api, chartLibFactory: () => lib });
    chart.setToken(makePlayer());
    await flush();

    const status = container.querySelector('[data-test-id="chart-status"]');
    expect(status.hidden).toBe(false);
    expect(status.textContent).toMatch(/Ошибка/);
  });

  it('destroy() removes chart instance and clears DOM', async () => {
    const { lib, created } = makeChartLib();
    const chart = mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
    chart.setToken(makePlayer());
    await flush();

    chart.destroy();
    expect(created.charts[0].removed).toBe(true);
    expect(container.children.length).toBe(0);
  });

  it('stale fetch does not overwrite newer response', async () => {
    const { lib } = makeChartLib();
    // First call resolves slowly with stale data, second call resolves with fresh data first.
    let resolveSlow;
    const slow = new Promise((r) => {
      resolveSlow = r;
    });
    const api = {
      getChart: vi
        .fn()
        .mockImplementationOnce(() => slow)
        .mockResolvedValueOnce(
          makeChartPayload({
            candles: [{ time: 2000, open: 1, high: 1, low: 1, close: 1, volume: 0 }],
            points: [],
          }),
        ),
    };
    const chart = mountChart(container, { apiClient: api, chartLibFactory: () => lib });
    chart.setToken(makePlayer());
    // Trigger second fetch (tf change) before first resolves.
    container.querySelector('[data-test-id="chart-tf-1h"]').click();
    await flush();
    // Now resolve the stale one.
    resolveSlow(makeChartPayload());
    await flush();
    // Price should be the fresh response's last close = 1, not 11.8 from stale.
    expect(container.querySelector('[data-test-id="chart-stat-price"]').textContent).toBe('1.00');
  });
});
