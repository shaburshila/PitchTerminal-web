/**
 * Chart component — lightweight-charts candles/line + timeframe selector + stats bar.
 *
 * Public to the dashboard host (main.js / future shell):
 *   const chart = mountChart(container, { apiClient, chartLibFactory });
 *   chart.setToken(token);            // pre-resolved token row from getTokens()
 *   chart.applyPrice(address, price); // live price tick from SSE prices channel
 *   chart.applyTrade(trade);          // live trade from SSE events channel
 *   chart.destroy();
 *
 * Reads from `GET /api/v1/tokens/{token}/chart` (see api-spec §4.2). Stats bar
 * derives most fields from the token row passed in via `setToken` since the
 * chart endpoint does not return changePct/marketCap.
 *
 * UI parity rules (docs/functional-spec.md §4):
 *   - Timeframes 1m / 5m / 15m / 1h / 4h / 1d, default 5m.
 *   - Type toggle: line / candles.
 *   - Country/PITCH unit toggle hidden for country tokens (only one unit there).
 *   - No technical indicators (MA/RSI/etc).
 *
 * Markers (trade dots) for OTHERS' trades come from `points` (FREE). Own-trade
 * markers + avg-entry overlays are PREMIUM — wired by F0.13.
 */

import * as defaultApi from './api.js';

const TIMEFRAMES = Object.freeze(['1m', '5m', '15m', '1h', '4h', '1d']);
const DEFAULT_TF = '5m';
const TYPES = Object.freeze(['candles', 'line']);
const UNITS = Object.freeze(['pitch', 'country']);

const TYPE_LABEL = { candles: 'Candles', line: 'Line' };
const UNIT_LABEL = { pitch: 'PITCH', country: 'Country' };

function el(tag, { className, dataset, attrs, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (dataset) {
    for (const [k, v] of Object.entries(dataset)) node.dataset[k] = v;
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  }
  if (text != null) node.textContent = text;
  return node;
}

function formatPrice(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1) return value.toFixed(2);
  if (abs >= 0.01) return value.toFixed(4);
  return value.toPrecision(3);
}

function formatChange(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function formatCompact(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toFixed(2);
}

/** Convert wei-string supply to a plain number (assumes 18 decimals). */
function supplyToNumber(supplyWei) {
  if (typeof supplyWei !== 'string' && typeof supplyWei !== 'number') return NaN;
  try {
    const s = String(supplyWei);
    // Split off last 18 digits to avoid BigInt → Number precision loss for
    // small fractional parts. Whole supply rarely needs sub-token precision
    // for display.
    if (s.length > 18) {
      const whole = s.slice(0, s.length - 18);
      return Number(whole);
    }
    return Number(s) / 1e18;
  } catch {
    return NaN;
  }
}

/** Map a chart trade-point or events-channel trade to a series marker. */
function pointToMarker(point) {
  if (!point || point.type === 'spot') return null;
  if (point.type !== 'buy' && point.type !== 'sell') return null;
  return {
    time: point.time,
    position: point.type === 'buy' ? 'belowBar' : 'aboveBar',
    color: point.type === 'buy' ? '#4caf6e' : '#ff5c5c',
    shape: point.type === 'buy' ? 'arrowUp' : 'arrowDown',
  };
}

/**
 * Default factory: dynamically import `lightweight-charts`. Tests pass a
 * synchronous factory returning a stub.
 */
async function defaultChartLibFactory() {
  return import('lightweight-charts');
}

/**
 * Mount the chart component into a container.
 *
 * @param {HTMLElement} container
 * @param {{
 *   apiClient?: { getChart: (token: string, tf: string) => Promise<object> },
 *   chartLibFactory?: () => Promise<{ createChart: Function }> | { createChart: Function },
 * }} [options]
 */
export function mountChart(container, options = {}) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('mountChart: container must be an HTMLElement');
  }

  const apiClient = options.apiClient ?? defaultApi;
  const chartLibFactory = options.chartLibFactory ?? defaultChartLibFactory;

  container.replaceChildren();

  const state = {
    token: null,
    tf: DEFAULT_TF,
    // Default to line chart: with sparse trades (1-2/day) candles look empty
    // and lose the trend signal. Users can still switch to candles via the
    // toolbar toggle. See docs/known-issues.md #1.
    type: 'line',
    unit: 'pitch',
    period: 'all',
    candles: [],
    points: [],
    loading: false,
    error: null,
    // Latest in-flight request id so stale fetches don't overwrite newer ones.
    reqSeq: 0,
  };

  // ── Skeleton ────────────────────────────────────────────────────────────
  const wrapper = el('div', { className: 'pt-chart' });

  // Toolbar: tf buttons + type toggle + unit toggle.
  const toolbar = el('div', {
    className: 'pt-chart__toolbar',
    dataset: { testId: 'chart-toolbar' },
  });

  const tfGroup = el('div', {
    className: 'pt-chart__tf',
    dataset: { testId: 'chart-tf' },
    attrs: { role: 'group', 'aria-label': 'Timeframe' },
  });
  const tfButtons = {};
  for (const tf of TIMEFRAMES) {
    const btn = el('button', {
      className: 'pt-chart__tf-btn',
      dataset: { tf, testId: `chart-tf-${tf}` },
      attrs: {
        type: 'button',
        'aria-pressed': tf === state.tf ? 'true' : 'false',
      },
      text: tf,
    });
    tfButtons[tf] = btn;
    tfGroup.appendChild(btn);
  }

  const typeGroup = el('div', {
    className: 'pt-chart__type',
    dataset: { testId: 'chart-type' },
    attrs: { role: 'group', 'aria-label': 'Chart type' },
  });
  const typeButtons = {};
  for (const t of TYPES) {
    const btn = el('button', {
      className: 'pt-chart__type-btn',
      dataset: { type: t, testId: `chart-type-${t}` },
      attrs: {
        type: 'button',
        'aria-pressed': t === state.type ? 'true' : 'false',
      },
      text: TYPE_LABEL[t],
    });
    typeButtons[t] = btn;
    typeGroup.appendChild(btn);
  }

  const unitGroup = el('div', {
    className: 'pt-chart__unit',
    dataset: { testId: 'chart-unit' },
    attrs: { role: 'group', 'aria-label': 'Price unit' },
  });
  const unitButtons = {};
  for (const u of UNITS) {
    const btn = el('button', {
      className: 'pt-chart__unit-btn',
      dataset: { unit: u, testId: `chart-unit-${u}` },
      attrs: {
        type: 'button',
        'aria-pressed': u === state.unit ? 'true' : 'false',
      },
      text: UNIT_LABEL[u],
    });
    unitButtons[u] = btn;
    unitGroup.appendChild(btn);
  }

  toolbar.appendChild(tfGroup);
  toolbar.appendChild(typeGroup);
  toolbar.appendChild(unitGroup);

  // Stats bar: price · change% · supply · marketCap · holders.
  const statsBar = el('div', {
    className: 'pt-chart__stats',
    dataset: { testId: 'chart-stats' },
  });
  function statCell(label, key) {
    const cell = el('div', { className: 'pt-chart__stat' });
    cell.appendChild(el('span', { className: 'pt-chart__stat-label', text: label }));
    const val = el('span', {
      className: 'pt-chart__stat-value',
      dataset: { testId: `chart-stat-${key}` },
      text: '—',
    });
    cell.appendChild(val);
    return { cell, val };
  }
  const priceStat = statCell('Price', 'price');
  const changeStat = statCell('Δ', 'change');
  const supplyStat = statCell('Supply', 'supply');
  const mcapStat = statCell('Mkt cap', 'mcap');
  const holdersStat = statCell('Holders', 'holders');
  statsBar.appendChild(priceStat.cell);
  statsBar.appendChild(changeStat.cell);
  statsBar.appendChild(supplyStat.cell);
  statsBar.appendChild(mcapStat.cell);
  statsBar.appendChild(holdersStat.cell);

  // Chart canvas host.
  const canvasHost = el('div', {
    className: 'pt-chart__canvas',
    dataset: { testId: 'chart-canvas' },
  });

  // Status line (empty/loading/error). Sibling, hidden by default.
  const status = el('div', {
    className: 'pt-chart__status',
    dataset: { testId: 'chart-status' },
    text: 'Select a token',
  });

  wrapper.appendChild(toolbar);
  wrapper.appendChild(statsBar);
  wrapper.appendChild(canvasHost);
  wrapper.appendChild(status);
  container.appendChild(wrapper);

  // ── Chart lib (lazy) ────────────────────────────────────────────────────
  let lib = null; // resolved lightweight-charts module
  let chartInstance = null;
  let series = null; // active series (candles or line)
  let resizeObserver = null;

  async function ensureLib() {
    if (lib) return lib;
    const result = chartLibFactory();
    lib = result && typeof result.then === 'function' ? await result : result;
    return lib;
  }

  function destroyChart() {
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (chartInstance && typeof chartInstance.remove === 'function') {
      try {
        chartInstance.remove();
      } catch {
        /* ignore */
      }
    }
    chartInstance = null;
    series = null;
  }

  function createSeries() {
    if (!chartInstance) return null;
    if (state.type === 'candles' && typeof chartInstance.addCandlestickSeries === 'function') {
      return chartInstance.addCandlestickSeries({
        upColor: '#4caf6e',
        downColor: '#ff5c5c',
        borderUpColor: '#4caf6e',
        borderDownColor: '#ff5c5c',
        wickUpColor: '#4caf6e',
        wickDownColor: '#ff5c5c',
      });
    }
    if (typeof chartInstance.addLineSeries === 'function') {
      return chartInstance.addLineSeries({ color: '#3a7bff', lineWidth: 2 });
    }
    return null;
  }

  function setSeriesData(s) {
    if (!s) return;
    if (state.type === 'candles') {
      if (typeof s.setData === 'function') s.setData(state.candles);
    } else {
      const lineData = state.candles.map((c) => ({ time: c.time, value: c.close }));
      if (typeof s.setData === 'function') s.setData(lineData);
    }
    if (typeof s.setMarkers === 'function') {
      // lightweight-charts v4 requires markers sorted ascending by time.
      const markers = state.points
        .map(pointToMarker)
        .filter(Boolean)
        .sort((a, b) => a.time - b.time);
      s.setMarkers(markers);
    }
  }

  async function ensureChartInstance() {
    if (chartInstance) return chartInstance;
    const mod = await ensureLib();
    if (!mod || typeof mod.createChart !== 'function') {
      throw new Error('mountChart: chart library missing createChart');
    }
    chartInstance = mod.createChart(canvasHost, {
      layout: {
        background: { color: '#0e1117' },
        textColor: '#e6edf3',
      },
      grid: {
        vertLines: { color: '#1c2230' },
        horzLines: { color: '#1c2230' },
      },
      timeScale: { timeVisible: true, secondsVisible: false },
      autoSize: true,
    });

    // Fallback resize if autoSize isn't supported (older builds, or test env).
    if (
      typeof ResizeObserver !== 'undefined' &&
      chartInstance &&
      typeof chartInstance.resize === 'function'
    ) {
      resizeObserver = new ResizeObserver(() => {
        const { clientWidth, clientHeight } = canvasHost;
        if (clientWidth > 0 && clientHeight > 0) {
          try {
            chartInstance.resize(clientWidth, clientHeight);
          } catch {
            /* ignore */
          }
        }
      });
      resizeObserver.observe(canvasHost);
    }
    return chartInstance;
  }

  async function rebuildSeries() {
    await ensureChartInstance();
    if (series && chartInstance && typeof chartInstance.removeSeries === 'function') {
      try {
        chartInstance.removeSeries(series);
      } catch {
        /* ignore */
      }
    }
    series = createSeries();
    setSeriesData(series);
  }

  // ── Stats / status rendering ────────────────────────────────────────────
  function renderStats() {
    const t = state.token;
    const last = lastCandleClose();
    const price = typeof last === 'number' ? last : t?.pricePitch;
    priceStat.val.textContent = formatPrice(price);

    const changeVal = t?.changePct?.[state.period];
    changeStat.val.textContent = formatChange(changeVal);
    changeStat.val.classList.toggle('positive', typeof changeVal === 'number' && changeVal > 0);
    changeStat.val.classList.toggle('negative', typeof changeVal === 'number' && changeVal < 0);

    const supplyNum = supplyToNumber(t?.supply);
    supplyStat.val.textContent = formatCompact(supplyNum);

    const mcap = typeof price === 'number' && Number.isFinite(supplyNum) ? supplyNum * price : NaN;
    mcapStat.val.textContent = formatCompact(mcap);

    const holders = t?.holdersCount;
    holdersStat.val.textContent = typeof holders === 'number' ? String(holders) : '—';
  }

  function renderStatus() {
    if (!state.token) {
      status.hidden = false;
      status.textContent = 'Select a token';
      return;
    }
    if (state.loading) {
      status.hidden = false;
      status.textContent = 'Loading…';
      return;
    }
    if (state.error) {
      status.hidden = false;
      status.textContent = 'Failed to load chart';
      return;
    }
    if (state.candles.length === 0) {
      status.hidden = false;
      status.textContent = 'No data';
      return;
    }
    status.hidden = true;
  }

  function applyToolbarAria() {
    for (const tf of TIMEFRAMES) {
      tfButtons[tf].setAttribute('aria-pressed', tf === state.tf ? 'true' : 'false');
    }
    for (const t of TYPES) {
      typeButtons[t].setAttribute('aria-pressed', t === state.type ? 'true' : 'false');
    }
    for (const u of UNITS) {
      unitButtons[u].setAttribute('aria-pressed', u === state.unit ? 'true' : 'false');
    }
  }

  function applyUnitVisibility() {
    // Countries are denominated only in PITCH — hide the toggle entirely.
    const isCountry = state.token?.kind === 'country';
    unitGroup.hidden = isCountry;
  }

  function lastCandleClose() {
    if (state.candles.length === 0) return undefined;
    const last = state.candles[state.candles.length - 1];
    return typeof last?.close === 'number' ? last.close : undefined;
  }

  // ── Data loading ────────────────────────────────────────────────────────
  async function loadChart() {
    const token = state.token;
    if (!token?.address) {
      state.candles = [];
      state.points = [];
      renderStats();
      renderStatus();
      return;
    }
    const seq = ++state.reqSeq;
    state.loading = true;
    state.error = null;
    renderStatus();

    let resp;
    try {
      resp = await apiClient.getChart(token.address, state.tf);
    } catch (err) {
      if (seq !== state.reqSeq) return;
      state.loading = false;
      state.error = err;
      renderStatus();
      return;
    }
    if (seq !== state.reqSeq) return;

    state.candles = Array.isArray(resp?.candles) ? resp.candles : [];
    state.points = Array.isArray(resp?.points) ? resp.points : [];
    state.loading = false;
    renderStats();
    renderStatus();

    // Build/refresh series — async, fire-and-forget; errors bubble to console.
    rebuildSeries().catch((err) => {
      console.error('mountChart: rebuildSeries failed', err);
    });
  }

  // ── Handlers ────────────────────────────────────────────────────────────
  function onTfClick(e) {
    const btn = e.target.closest('[data-tf]');
    if (!btn) return;
    const tf = btn.dataset.tf;
    if (!TIMEFRAMES.includes(tf) || tf === state.tf) return;
    state.tf = tf;
    applyToolbarAria();
    loadChart();
  }

  function onTypeClick(e) {
    const btn = e.target.closest('[data-type]');
    if (!btn) return;
    const t = btn.dataset.type;
    if (!TYPES.includes(t) || t === state.type) return;
    state.type = t;
    applyToolbarAria();
    rebuildSeries().catch((err) => {
      console.error('mountChart: rebuildSeries failed', err);
    });
  }

  function onUnitClick(e) {
    const btn = e.target.closest('[data-unit]');
    if (!btn) return;
    const u = btn.dataset.unit;
    if (!UNITS.includes(u) || u === state.unit) return;
    state.unit = u;
    applyToolbarAria();
    // Unit toggle is visual-only for now: /chart endpoint returns PITCH-denominated
    // candles. Switching units would require a separate priceCountry feed.
    // F0.6 ships the control; backend extension is out of scope.
  }

  tfGroup.addEventListener('click', onTfClick);
  typeGroup.addEventListener('click', onTypeClick);
  unitGroup.addEventListener('click', onUnitClick);

  // ── Public API ──────────────────────────────────────────────────────────
  function setToken(token) {
    state.token = token || null;
    applyUnitVisibility();
    renderStats();
    loadChart();
  }

  function setPeriod(period) {
    if (typeof period !== 'string') return;
    state.period = period;
    renderStats();
  }

  /**
   * Update the latest candle's close from an SSE price tick. Does NOT
   * recreate the series — pushes a single `update` per lightweight-charts.
   */
  function applyPrice(address, price) {
    if (!state.token || !address) return;
    if (address.toLowerCase() !== String(state.token.address || '').toLowerCase()) return;
    if (typeof price !== 'number' || Number.isNaN(price)) return;
    if (state.candles.length === 0) return;
    const last = state.candles[state.candles.length - 1];
    const updated = {
      time: last.time,
      open: last.open,
      high: Math.max(last.high ?? price, price),
      low: Math.min(last.low ?? price, price),
      close: price,
      volume: last.volume,
    };
    state.candles[state.candles.length - 1] = updated;
    renderStats();
    if (!series || !chartInstance) return;
    if (state.type === 'candles') {
      if (typeof series.update === 'function') series.update(updated);
    } else if (typeof series.update === 'function') {
      series.update({ time: updated.time, value: updated.close });
    }
  }

  /**
   * Append a marker for a new trade event on the active token.
   * Expects SSE events-channel shape (api-spec §8.3):
   *   { token, type: 'buy'|'sell', timestamp, price, trader, ... }
   * Accepts legacy `time` field as fallback.
   */
  function applyTrade(trade) {
    if (!state.token || !trade) return;
    const addr = trade.token || trade.tokenAddress;
    if (!addr) return;
    if (addr.toLowerCase() !== String(state.token.address || '').toLowerCase()) return;
    const marker = pointToMarker({
      type: trade.type,
      time: trade.time ?? trade.timestamp,
    });
    if (!marker) return;
    state.points.push({
      type: trade.type,
      time: marker.time,
      price: trade.price,
      volume: trade.volume ?? 0,
      trader: trade.trader || '',
    });
    if (series && typeof series.setMarkers === 'function') {
      const markers = state.points
        .map(pointToMarker)
        .filter(Boolean)
        .sort((a, b) => a.time - b.time);
      series.setMarkers(markers);
    }
  }

  function destroy() {
    tfGroup.removeEventListener('click', onTfClick);
    typeGroup.removeEventListener('click', onTypeClick);
    unitGroup.removeEventListener('click', onUnitClick);
    destroyChart();
    container.replaceChildren();
  }

  // Initial state.
  applyToolbarAria();
  applyUnitVisibility();
  renderStats();
  renderStatus();

  return {
    setToken,
    setPeriod,
    applyPrice,
    applyTrade,
    refresh: loadChart,
    destroy,
    // Test seams — read-only views.
    _getState() {
      return { ...state };
    },
  };
}
