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
      priceLines: [],
      setData: vi.fn(function (d) {
        this.data = d;
      }),
      setMarkers: vi.fn(function (m) {
        this.markers = m;
      }),
      update: vi.fn(function (point) {
        this.updates.push(point);
      }),
      createPriceLine: vi.fn(function (opts) {
        const line = { opts, removed: false };
        this.priceLines.push(line);
        return line;
      }),
      removePriceLine: vi.fn(function (line) {
        if (line) line.removed = true;
        this.priceLines = this.priceLines.filter((l) => l !== line);
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
        crosshairHandlers: [],
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
        // Batch 4.5 — emulate lightweight-charts v4: returns an unsubscribe
        // fn the chart module is expected to call on destroy.
        subscribeCrosshairMove: vi.fn(function (handler) {
          this.crosshairHandlers.push(handler);
          return () => {
            this.crosshairHandlers = this.crosshairHandlers.filter((h) => h !== handler);
          };
        }),
        // Helper used by tests to simulate a crosshair move.
        _emitCrosshair(param) {
          for (const h of this.crosshairHandlers) h(param);
        },
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
    // Batch 4: chart overlays persist to localStorage. Clear between tests
    // so prior toggles don't leak default state.
    try {
      localStorage.removeItem('pt:chart:overlays');
    } catch {
      /* ignore */
    }
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
    // Batch 4 — overlay checkboxes My / Others / Avg buy / Net pos
    // rendered inline in the toolbar row (a-main.html .tb-check parity).
    // The floating slot above the canvas is reserved for OHLC crosshair
    // data (batch 4.5).
    const overlays = container.querySelector('[data-test-id="chart-overlays"]');
    expect(overlays).not.toBeNull();
    const toolbar = container.querySelector('[data-test-id="chart-toolbar"]');
    expect(toolbar.contains(overlays)).toBe(true);
    const canvas = container.querySelector('[data-test-id="chart-canvas"]');
    expect(canvas.contains(overlays)).toBe(false);
    for (const key of ['my', 'others', 'avg', 'netPos']) {
      const btn = container.querySelector(`[data-test-id="chart-overlay-${key}"]`);
      expect(btn).not.toBeNull();
      expect(btn.getAttribute('role')).toBe('checkbox');
    }
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

  it('shows "Select a token" status before any setToken', () => {
    const { lib } = makeChartLib();
    mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
    const status = container.querySelector('[data-test-id="chart-status"]');
    expect(status.hidden).toBe(false);
    expect(status.textContent).toMatch(/Select a token/);
  });

  it('setToken triggers getChart with token addr + default tf, then renders series', async () => {
    const { lib, created } = makeChartLib();
    const api = makeApi();
    const chart = mountChart(container, { apiClient: api, chartLibFactory: () => lib });

    // Mockup default is others=off — this test asserts on all markers,
    // so turn Others on to keep its non-overlay-specific intent.
    container.querySelector('[data-test-id="chart-overlay-others"]').click();
    chart.setToken(makePlayer());
    await flush();

    expect(api.getChart).toHaveBeenCalledWith('0xaaa1', '5m', 'pitch');
    expect(created.charts.length).toBe(1);
    const series = created.charts[0].seriesList[0];
    // Default type is `line` (see docs/known-issues.md #1 — candles look empty
    // with sparse trades). Line data is {time, value} derived from candle.close.
    expect(series.kind).toBe('line');
    expect(series.data).toEqual([
      { time: 1709000000, value: 10.5 },
      { time: 1709000300, value: 11.8 },
    ]);
    // Markers: only buy + sell points, "spot" is filtered out.
    expect(series.markers.length).toBe(2);
    expect(series.markers[0].position).toBe('belowBar'); // buy
    expect(series.markers[1].position).toBe('aboveBar'); // sell
  });

  it('default chart type is line (aria-pressed=true on line button)', () => {
    const { lib } = makeChartLib();
    mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
    const line = container.querySelector('[data-test-id="chart-type-line"]');
    const candles = container.querySelector('[data-test-id="chart-type-candles"]');
    expect(line.getAttribute('aria-pressed')).toBe('true');
    expect(candles.getAttribute('aria-pressed')).toBe('false');
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
    expect(api.getChart).toHaveBeenLastCalledWith('0xaaa1', '1h', 'pitch');
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

  it('switching type from line to candles rebuilds with addCandlestickSeries', async () => {
    const { lib, created } = makeChartLib();
    const chart = mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
    chart.setToken(makePlayer());
    await flush();

    container.querySelector('[data-test-id="chart-type-candles"]').click();
    await flush();

    const chartInst = created.charts[0];
    // line series removed, candle series active.
    const kinds = chartInst.seriesList.map((s) => s.kind);
    expect(kinds).toContain('candle');
    const candleSeries = chartInst.seriesList.find((s) => s.kind === 'candle');
    expect(candleSeries.data).toEqual(makeChartPayload().candles);
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

  it('switching unit (pitch → country) refetches candles with unit=country', async () => {
    const { lib } = makeChartLib();
    const api = makeApi();
    const chart = mountChart(container, { apiClient: api, chartLibFactory: () => lib });
    chart.setToken(makePlayer());
    await flush();
    expect(api.getChart).toHaveBeenCalledTimes(1);
    expect(api.getChart).toHaveBeenLastCalledWith('0xaaa1', '5m', 'pitch');

    const countryBtn = container.querySelector('[data-test-id="chart-unit-country"]');
    countryBtn.click();
    await flush();

    expect(api.getChart).toHaveBeenCalledTimes(2);
    expect(api.getChart).toHaveBeenLastCalledWith('0xaaa1', '5m', 'country');
    expect(countryBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('clicking the same unit does NOT trigger a refetch', async () => {
    const { lib } = makeChartLib();
    const api = makeApi();
    const chart = mountChart(container, { apiClient: api, chartLibFactory: () => lib });
    chart.setToken(makePlayer());
    await flush();
    api.getChart.mockClear();

    container.querySelector('[data-test-id="chart-unit-pitch"]').click();
    await flush();
    expect(api.getChart).not.toHaveBeenCalled();
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

  it('applyPrice updates the last point and calls series.update (line default)', async () => {
    const { lib, created } = makeChartLib();
    const chart = mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
    chart.setToken(makePlayer());
    await flush();

    const series = created.charts[0].seriesList[0];
    expect(series.kind).toBe('line');
    series.update.mockClear();
    chart.applyPrice('0xAAA1', 13.5);

    expect(series.update).toHaveBeenCalledTimes(1);
    const arg = series.update.mock.calls[0][0];
    // Line series receives {time, value} updates.
    expect(arg.value).toBe(13.5);
    // Price stat reflects new close.
    expect(container.querySelector('[data-test-id="chart-stat-price"]').textContent).toBe('13.50');
  });

  it('applyPrice updates with candle shape when type=candles', async () => {
    const { lib, created } = makeChartLib();
    const chart = mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
    chart.setToken(makePlayer());
    await flush();

    // Switch to candles, then rebuild swaps series.
    container.querySelector('[data-test-id="chart-type-candles"]').click();
    await flush();

    const candleSeries = created.charts[0].seriesList.find((s) => s.kind === 'candle');
    candleSeries.update.mockClear();
    chart.applyPrice('0xAAA1', 13.5);

    expect(candleSeries.update).toHaveBeenCalledTimes(1);
    const arg = candleSeries.update.mock.calls[0][0];
    expect(arg.close).toBe(13.5);
    expect(arg.high).toBeGreaterThanOrEqual(13.5);
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
    // Mockup default others=off — turn on so all markers render.
    container.querySelector('[data-test-id="chart-overlay-others"]').click();
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
    container.querySelector('[data-test-id="chart-overlay-others"]').click();
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
    expect(status.textContent).toMatch(/Failed/);
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

  // ── Batch 4: overlay-checkboxes (My / Others / Avg) — closes #3 ──────────

  it('default overlays match mockup: my=on, others=off, avg=off, netPos=on', () => {
    const { lib } = makeChartLib();
    mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
    const my = container.querySelector('[data-test-id="chart-overlay-my"]');
    const others = container.querySelector('[data-test-id="chart-overlay-others"]');
    const avg = container.querySelector('[data-test-id="chart-overlay-avg"]');
    const netPos = container.querySelector('[data-test-id="chart-overlay-netPos"]');
    expect(my.getAttribute('aria-checked')).toBe('true');
    expect(others.getAttribute('aria-checked')).toBe('false');
    expect(avg.getAttribute('aria-checked')).toBe('false');
    expect(netPos.getAttribute('aria-checked')).toBe('true');
    expect(my.classList.contains('is-on')).toBe(true);
    expect(others.classList.contains('is-on')).toBe(false);
    expect(avg.classList.contains('is-on')).toBe(false);
    expect(netPos.classList.contains('is-on')).toBe(true);
  });

  it('toggling "Others" hides others-only markers, keeps "my" markers', async () => {
    const { lib, created } = makeChartLib();
    const payload = makeChartPayload({
      points: [
        { time: 1709000100, price: 10.7, volume: 5, type: 'buy', trader: '0xMe' },
        { time: 1709000200, price: 11.2, volume: 3, type: 'sell', trader: '0xOther' },
      ],
    });
    const chart = mountChart(container, {
      apiClient: makeApi(payload),
      chartLibFactory: () => lib,
    });
    chart.setOwnAddress('0xme');
    chart.setToken(makePlayer());
    await flush();

    const series = created.charts[0].seriesList[0];
    // Mockup default: my=on, others=off → only my marker rendered.
    expect(series.markers.length).toBe(1);
    expect(series.markers[0].position).toBe('belowBar'); // my=buy

    // Toggle Others ON → both markers.
    container.querySelector('[data-test-id="chart-overlay-others"]').click();
    expect(series.markers.length).toBe(2);

    // Toggle Others OFF → only my marker remains.
    container.querySelector('[data-test-id="chart-overlay-others"]').click();
    expect(series.markers.length).toBe(1);
    expect(series.markers[0].position).toBe('belowBar');

    // Toggle My OFF → no markers.
    container.querySelector('[data-test-id="chart-overlay-my"]').click();
    expect(series.markers.length).toBe(0);

    // Toggle Others back ON → only others marker.
    container.querySelector('[data-test-id="chart-overlay-others"]').click();
    expect(series.markers.length).toBe(1);
    expect(series.markers[0].position).toBe('aboveBar'); // other=sell
  });

  it('toggling "Avg" creates a price-line at volume-weighted own-trade average', async () => {
    const { lib, created } = makeChartLib();
    const payload = makeChartPayload({
      points: [
        { time: 1709000100, price: 10, volume: 1, type: 'buy', trader: '0xMe' },
        { time: 1709000200, price: 20, volume: 3, type: 'buy', trader: '0xMe' },
        // Other trade ignored for avg even with high volume.
        { time: 1709000250, price: 999, volume: 100, type: 'sell', trader: '0xOther' },
      ],
    });
    const chart = mountChart(container, {
      apiClient: makeApi(payload),
      chartLibFactory: () => lib,
    });
    chart.setOwnAddress('0xme');
    chart.setToken(makePlayer());
    await flush();

    const series = created.charts[0].seriesList[0];
    expect(series.priceLines.length).toBe(0); // avg off by default

    container.querySelector('[data-test-id="chart-overlay-avg"]').click();
    expect(series.priceLines.length).toBe(1);
    // Volume-weighted avg = (10*1 + 20*3) / (1+3) = 70/4 = 17.5.
    expect(series.priceLines[0].opts.price).toBeCloseTo(17.5, 5);

    // Toggle off → price-line removed.
    container.querySelector('[data-test-id="chart-overlay-avg"]').click();
    expect(series.priceLines.length).toBe(0);
  });

  it('overlay state persists via localStorage across remounts', async () => {
    const { lib } = makeChartLib();
    const chart1 = mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
    // From mockup defaults (my=on, others=off, avg=off, netPos=on), flip
    // each one once so we know persistence respects per-key state.
    container.querySelector('[data-test-id="chart-overlay-my"]').click(); // my → off
    container.querySelector('[data-test-id="chart-overlay-others"]').click(); // others → on
    container.querySelector('[data-test-id="chart-overlay-avg"]').click(); // avg → on
    container.querySelector('[data-test-id="chart-overlay-netPos"]').click(); // netPos → off
    chart1.destroy();

    const container2 = document.createElement('section');
    document.body.appendChild(container2);
    const { lib: lib2 } = makeChartLib();
    mountChart(container2, { apiClient: makeApi(), chartLibFactory: () => lib2 });

    expect(
      container2.querySelector('[data-test-id="chart-overlay-my"]').getAttribute('aria-checked'),
    ).toBe('false');
    expect(
      container2.querySelector('[data-test-id="chart-overlay-others"]').getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      container2.querySelector('[data-test-id="chart-overlay-avg"]').getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      container2.querySelector('[data-test-id="chart-overlay-netPos"]').getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('setOwnAddress re-classifies markers without refetching data', async () => {
    const { lib, created } = makeChartLib();
    const payload = makeChartPayload({
      points: [
        { time: 1709000100, price: 10, volume: 1, type: 'buy', trader: '0xMe' },
        { time: 1709000200, price: 11, volume: 1, type: 'sell', trader: '0xOther' },
      ],
    });
    const api = makeApi(payload);
    const chart = mountChart(container, { apiClient: api, chartLibFactory: () => lib });
    chart.setToken(makePlayer());
    await flush();
    expect(api.getChart).toHaveBeenCalledTimes(1);

    // Anonymous fallback (Phase 1.5 batch 11): with ownAddress=null the
    // My/Others toggles collapse to OR — default state.show.my=true alone is
    // enough to render every marker. This fixes the user-visible bug where
    // anonymous viewers saw zero markers and the toggles "did nothing".
    const series = created.charts[0].seriesList[0];
    expect(series.markers.length).toBe(2);

    // Now identify ourselves → only 0xMe's marker should appear (my=on,
    // others=off — the regular two-bucket classifier kicks in).
    chart.setOwnAddress('0xme');
    expect(api.getChart).toHaveBeenCalledTimes(1); // no refetch
    expect(series.markers.length).toBe(1);
    expect(series.markers[0].position).toBe('belowBar');
  });

  it('setOwnAddress(null) clears avg price-line when avg is on', async () => {
    const { lib, created } = makeChartLib();
    const payload = makeChartPayload({
      points: [{ time: 1709000100, price: 10, volume: 1, type: 'buy', trader: '0xMe' }],
    });
    const chart = mountChart(container, {
      apiClient: makeApi(payload),
      chartLibFactory: () => lib,
    });
    chart.setOwnAddress('0xme');
    chart.setToken(makePlayer());
    await flush();

    const series = created.charts[0].seriesList[0];
    container.querySelector('[data-test-id="chart-overlay-avg"]').click(); // avg → on
    expect(series.priceLines.length).toBeGreaterThanOrEqual(1);
    const hadAvg = series.priceLines.some((l) => l.opts?.title === 'Avg');
    expect(hadAvg).toBe(true);

    // Disconnect → avg has no own-trades → line goes away.
    chart.setOwnAddress(null);
    const stillHasAvg = series.priceLines.some((l) => l.opts?.title === 'Avg');
    expect(stillHasAvg).toBe(false);
  });

  it('Net pos line renders at spot when balance>0 and clears on disconnect', async () => {
    const { lib, created } = makeChartLib();
    const player = makePlayer();
    const chart = mountChart(container, {
      apiClient: makeApi(),
      chartLibFactory: () => lib,
    });
    chart.setOwnAddress('0xme');
    chart.setToken(player);
    await flush();

    const series = created.charts[0].seriesList[0];
    // netPos default = on, but no balance set → no line.
    let netLines = series.priceLines.filter((l) => l.opts?.title === 'Pos');
    expect(netLines.length).toBe(0);

    // Supply a balance → line appears at last candle close (11.8 per payload).
    chart.setOwnBalance(player.address, 5);
    netLines = series.priceLines.filter((l) => l.opts?.title === 'Pos');
    expect(netLines.length).toBe(1);
    expect(netLines[0].opts.price).toBeCloseTo(11.8, 5);

    // Disconnect → net pos line cleared (ownAddress null → no position).
    chart.setOwnAddress(null);
    netLines = series.priceLines.filter((l) => l.opts?.title === 'Pos');
    expect(netLines.length).toBe(0);
  });

  it('toggling Net pos off removes the line without affecting balance state', async () => {
    const { lib, created } = makeChartLib();
    const player = makePlayer();
    const chart = mountChart(container, {
      apiClient: makeApi(),
      chartLibFactory: () => lib,
    });
    chart.setOwnAddress('0xme');
    chart.setToken(player);
    chart.setOwnBalance(player.address, 5);
    await flush();

    const series = created.charts[0].seriesList[0];
    expect(series.priceLines.filter((l) => l.opts?.title === 'Pos').length).toBe(1);

    container.querySelector('[data-test-id="chart-overlay-netPos"]').click(); // off
    expect(series.priceLines.filter((l) => l.opts?.title === 'Pos').length).toBe(0);

    container.querySelector('[data-test-id="chart-overlay-netPos"]').click(); // on
    expect(series.priceLines.filter((l) => l.opts?.title === 'Pos').length).toBe(1);
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

  // ── Batch 4.5 — OHLC crosshair floating-card overlay ─────────────────
  // Sits absolutely inside the canvas host; populated by
  // subscribeCrosshairMove when the cursor hovers a candle; hidden when
  // the cursor leaves the chart or no data is under the crosshair.

  describe('OHLC crosshair card (batch 4.5)', () => {
    it('mounts the OHLC card inside the canvas host, hidden by default', async () => {
      const { lib } = makeChartLib();
      mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
      const canvas = container.querySelector('[data-test-id="chart-canvas"]');
      const card = container.querySelector('[data-test-id="chart-ohlc"]');
      expect(card).not.toBeNull();
      expect(canvas.contains(card)).toBe(true);
      expect(card.hidden).toBe(true);
    });

    it('subscribes to crosshair move once the chart instance is created', async () => {
      const { lib, created } = makeChartLib();
      const chart = mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
      chart.setToken(makePlayer());
      await flush();
      expect(created.charts.length).toBe(1);
      expect(created.charts[0].subscribeCrosshairMove).toHaveBeenCalledTimes(1);
      expect(created.charts[0].crosshairHandlers.length).toBe(1);
    });

    it('crosshair on a candle fills O/H/L/C/Vol values and shows the card', async () => {
      const { lib, created } = makeChartLib();
      const chart = mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
      chart.setToken(makePlayer());
      await flush();
      const c = created.charts[0];
      // Emit a move over the second candle (close 11.8).
      c._emitCrosshair({ time: 1709000300, point: { x: 100, y: 50 } });
      const card = container.querySelector('[data-test-id="chart-ohlc"]');
      expect(card.hidden).toBe(false);
      expect(container.querySelector('[data-test-id="chart-ohlc-open"]').textContent).toBe('10.50');
      expect(container.querySelector('[data-test-id="chart-ohlc-high"]').textContent).toBe('12.00');
      expect(container.querySelector('[data-test-id="chart-ohlc-low"]').textContent).toBe('10.40');
      expect(container.querySelector('[data-test-id="chart-ohlc-close"]').textContent).toBe('11.80');
      // close (11.8) > open (10.5) → close cell flagged as up.
      const closeEl = container.querySelector('[data-test-id="chart-ohlc-close"]');
      expect(closeEl.classList.contains('is-up')).toBe(true);
      expect(closeEl.classList.contains('is-down')).toBe(false);
      // Time label present and non-empty.
      expect(container.querySelector('[data-test-id="chart-ohlc-time"]').textContent).not.toBe('');
    });

    it('crosshair leaving the chart area (no point) hides the card', async () => {
      const { lib, created } = makeChartLib();
      const chart = mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
      chart.setToken(makePlayer());
      await flush();
      const c = created.charts[0];
      c._emitCrosshair({ time: 1709000300, point: { x: 100, y: 50 } });
      const card = container.querySelector('[data-test-id="chart-ohlc"]');
      expect(card.hidden).toBe(false);
      // point=null → cursor left chart area; card must hide.
      c._emitCrosshair({ time: 1709000300, point: null });
      expect(card.hidden).toBe(true);
    });

    it('crosshair on a timestamp not in candles keeps the card hidden', async () => {
      const { lib, created } = makeChartLib();
      const chart = mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
      chart.setToken(makePlayer());
      await flush();
      const c = created.charts[0];
      c._emitCrosshair({ time: 9999999999, point: { x: 1, y: 1 } });
      expect(container.querySelector('[data-test-id="chart-ohlc"]').hidden).toBe(true);
    });

    it('down-candle marks close cell with is-down', async () => {
      const { lib, created } = makeChartLib();
      const api = makeApi(
        makeChartPayload({
          candles: [
            { time: 1709000000, open: 11, high: 11.2, low: 9.5, close: 9.6, volume: 100 },
          ],
        }),
      );
      const chart = mountChart(container, { apiClient: api, chartLibFactory: () => lib });
      chart.setToken(makePlayer());
      await flush();
      const c = created.charts[0];
      c._emitCrosshair({ time: 1709000000, point: { x: 10, y: 10 } });
      const closeEl = container.querySelector('[data-test-id="chart-ohlc-close"]');
      expect(closeEl.classList.contains('is-down')).toBe(true);
      expect(closeEl.classList.contains('is-up')).toBe(false);
    });

    it('setToken hides any stale OHLC card before new data loads', async () => {
      const { lib, created } = makeChartLib();
      const chart = mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
      chart.setToken(makePlayer());
      await flush();
      created.charts[0]._emitCrosshair({ time: 1709000300, point: { x: 1, y: 1 } });
      const card = container.querySelector('[data-test-id="chart-ohlc"]');
      expect(card.hidden).toBe(false);
      chart.setToken(makeCountry());
      // Card is hidden synchronously on setToken; new candles arrive async.
      expect(card.hidden).toBe(true);
    });

    it('destroy() unsubscribes the crosshair handler', async () => {
      const { lib, created } = makeChartLib();
      const chart = mountChart(container, { apiClient: makeApi(), chartLibFactory: () => lib });
      chart.setToken(makePlayer());
      await flush();
      const c = created.charts[0];
      expect(c.crosshairHandlers.length).toBe(1);
      chart.destroy();
      expect(c.crosshairHandlers.length).toBe(0);
    });
  });

  // ── Phase 1.5 follow-up issues #5 + #6 ───────────────────────────────────

  it('applyPrice is a no-op while rebuildSeries is in flight (issue #5)', async () => {
    // Set up a chart with data + a non-zero own balance so renderNetPosLine
    // would normally create a priceLine on every applyPrice tick.
    const { lib, created } = makeChartLib();
    const player = makePlayer();
    const chart = mountChart(container, {
      apiClient: makeApi(),
      chartLibFactory: () => lib,
    });
    chart.setOwnAddress('0xme');
    chart.setToken(player);
    await flush();
    chart.setOwnBalance(player.address, 5);

    // Now toggle type=candles — onTypeClick calls rebuildSeries() which
    // awaits ensureChartInstance() (already resolved here, so the await is
    // a single microtask). We squeeze an applyPrice tick BETWEEN the
    // rebuildSeries kick-off and its microtask resolution. The guard must
    // prevent the tick from creating a priceLine on the about-to-be-removed
    // series.
    const seriesBefore = created.charts[0].seriesList[0];
    const priceLinesBeforeCount = seriesBefore.priceLines.length;

    // Fire rebuild — synchronously calls into the async function; series
    // removal happens on the next microtask.
    container.querySelector('[data-test-id="chart-type-candles"]').click();

    // SSE tick lands BEFORE the microtask. With the fix, applyPrice early-
    // returns because rebuilding=true. Without the fix, it would call
    // series.update + renderNetPosLine on the old series → leaked priceLine.
    chart.applyPrice(player.address, 12.5);

    // The old series should NOT have gained a new priceLine from the tick.
    expect(seriesBefore.priceLines.length).toBe(priceLinesBeforeCount);
    // Also no series.update should have been called on it.
    expect(seriesBefore.update).not.toHaveBeenCalled();

    // Drain microtasks → rebuild completes, new series is in place.
    await flush();
    const seriesAfter =
      created.charts[0].seriesList[created.charts[0].seriesList.length - 1];
    expect(seriesAfter).not.toBe(seriesBefore);
    // Post-rebuild renderNetPosLine ran against the FRESH series.
    expect(
      seriesAfter.priceLines.filter((l) => l.opts?.title === 'Pos').length,
    ).toBe(1);
  });

  it('setOwnBalance ignores wei-magnitude inputs and warns (issue #6 guard)', async () => {
    const { lib, created } = makeChartLib();
    const player = makePlayer();
    const chart = mountChart(container, {
      apiClient: makeApi(),
      chartLibFactory: () => lib,
    });
    chart.setOwnAddress('0xme');
    chart.setToken(player);
    await flush();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 1 PITCH in wei = 1e18 — far above the 1e15 ceiling. The guard must
    // refuse the update so the Net pos line is never drawn at 1e18 × spot.
    chart.setOwnBalance(player.address, 1e18);

    const series = created.charts[0].seriesList[0];
    expect(series.priceLines.filter((l) => l.opts?.title === 'Pos').length).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
