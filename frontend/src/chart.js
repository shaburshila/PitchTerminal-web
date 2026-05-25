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

// Overlay-checkboxes — Batch 4 (closes known-issues #3).
// "my" — markers for own trades, "others" — markers for everyone else,
// "avg" — horizontal price-line at the volume-weighted average of own
// trades, "netPos" — horizontal price-line at the current spot price
// of the active token when the user holds a nonzero balance (visual
// marker for "here is my open position"; the price source is the last
// candle close — same value the stats bar shows).
//
// Mockup parity: a-main.html shows 4 boxes [My][Others][Avg buy][Net pos]
// rendered inline in the toolbar row (.tb-check, separated by .tb-sep
// from the unit toggle, right-aligned via margin-left:auto). The
// floating-card slot above the chart is reserved for OHLC crosshair
// data (batch 4.5). Defaults reproduce mockup state: My on, Others off,
// Avg off, Net pos on.
const OVERLAYS = Object.freeze(['my', 'others', 'avg', 'netPos']);
const OVERLAY_LABEL = { my: 'My', others: 'Others', avg: 'Avg buy', netPos: 'Net pos' };
const OVERLAY_STORAGE_KEY = 'pt:chart:overlays';

function readPersistedOverlays() {
  // Best-effort — happy-dom + node env localStorage missing or quota errors
  // must never break chart mount.
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(OVERLAY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const out = {};
    for (const k of OVERLAYS) {
      if (typeof parsed[k] === 'boolean') out[k] = parsed[k];
    }
    return out;
  } catch {
    return null;
  }
}

function persistOverlays(show) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(OVERLAY_STORAGE_KEY, JSON.stringify(show));
  } catch {
    /* ignore */
  }
}

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

/** Format unix-second timestamp as "YYYY-MM-DD HH:mm" UTC for the OHLC card. */
function formatCrosshairTime(time) {
  if (typeof time !== 'number' || !Number.isFinite(time)) return '';
  const d = new Date(time * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
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
 * Decide whether a point's trader matches the current "own address" for
 * the purposes of My/Others filtering. Case-insensitive; missing address
 * means "not mine".
 */
function isOwnTrade(trader, ownAddress) {
  if (!ownAddress) return false;
  if (typeof trader !== 'string' || !trader) return false;
  return trader.toLowerCase() === ownAddress.toLowerCase();
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

  const persistedShow = readPersistedOverlays();
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
    // Batch 4 — overlay-checkbox state (closes known-issues #3). `my` and
    // `others` filter trade markers by trader-address; `avg` renders a
    // horizontal price-line at the volume-weighted average of own trades;
    // `netPos` renders a horizontal line at the current spot price when
    // the user holds a nonzero balance for the active token. Defaults
    // reproduce mockup state (a-main.html): My on, Others off, Avg off,
    // Net pos on.
    show: {
      my: persistedShow?.my ?? true,
      others: persistedShow?.others ?? false,
      avg: persistedShow?.avg ?? false,
      netPos: persistedShow?.netPos ?? true,
    },
    // Lowercased current wallet address (or null). Used to split markers
    // into my/others. Wired by main.js via setOwnAddress().
    ownAddress: null,
    // Map of lowercased token-address → balance (number, in display units;
    // 0 / undefined / negative = no position). Net-pos line renders only
    // for tokens with a nonzero balance here. Wired via setOwnBalance().
    // Until batch 6 (My Wallet tab) plumbs real balances, this stays empty
    // and the Net-pos toggle is a no-op on the live app — the setter
    // exists so tests can drive the behaviour today.
    ownBalances: new Map(),
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

  // Overlay-checkboxes group (My / Others / Avg buy / Net pos) — Batch 4.
  // Inline in the toolbar row, right-aligned via margin-left:auto, with
  // a separator on its left edge — mirrors a-main.html .tb-check group
  // sitting next to the unit toggle. The floating overlay slot above the
  // canvas is reserved for OHLC crosshair data (batch 4.5).
  const overlaySep = el('span', {
    className: 'pt-chart__tb-sep',
    attrs: { 'aria-hidden': 'true' },
  });
  const overlayGroup = el('div', {
    className: 'pt-chart__overlays',
    dataset: { testId: 'chart-overlays' },
    attrs: { role: 'group', 'aria-label': 'Chart overlays' },
  });
  const overlayButtons = {};
  for (const key of OVERLAYS) {
    const btn = el('button', {
      className: 'pt-chart__overlay-btn',
      dataset: { overlay: key, testId: `chart-overlay-${key}` },
      attrs: {
        type: 'button',
        role: 'checkbox',
        'aria-checked': state.show[key] ? 'true' : 'false',
      },
    });
    const cb = el('span', { className: 'pt-chart__overlay-cb', attrs: { 'aria-hidden': 'true' } });
    const label = el('span', { className: 'pt-chart__overlay-label', text: OVERLAY_LABEL[key] });
    btn.appendChild(cb);
    btn.appendChild(label);
    overlayButtons[key] = btn;
    overlayGroup.appendChild(btn);
  }

  toolbar.appendChild(tfGroup);
  toolbar.appendChild(typeGroup);
  toolbar.appendChild(unitGroup);
  toolbar.appendChild(overlaySep);
  toolbar.appendChild(overlayGroup);

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

  // Chart canvas host. position:relative is set in styles.css so the
  // OHLC crosshair overlay (batch 4.5) can absolutely-position itself
  // inside this slot.
  const canvasHost = el('div', {
    className: 'pt-chart__canvas',
    dataset: { testId: 'chart-canvas' },
  });

  // OHLC crosshair floating-card (batch 4.5). Sits absolutely inside the
  // canvas host, top-left by default; populated by subscribeCrosshairMove
  // when the cursor scrubs over a data point. Hidden when the cursor
  // leaves the chart area or no data is under the crosshair. Mockup
  // parity: a-main.html .chart-overlay (O/H/L/C cells, mono font, blurred
  // backdrop).
  const ohlcCard = el('div', {
    className: 'pt-chart__ohlc',
    dataset: { testId: 'chart-ohlc' },
    attrs: { 'aria-hidden': 'true', hidden: '' },
  });
  function ohlcCell(label, key) {
    const cell = el('span', { className: 'pt-chart__ohlc-cell' });
    cell.appendChild(el('span', { className: 'pt-chart__ohlc-label', text: label }));
    const v = el('span', {
      className: 'pt-chart__ohlc-value',
      dataset: { testId: `chart-ohlc-${key}` },
      text: '—',
    });
    cell.appendChild(v);
    return { cell, value: v };
  }
  const ohlcO = ohlcCell('O', 'open');
  const ohlcH = ohlcCell('H', 'high');
  const ohlcL = ohlcCell('L', 'low');
  const ohlcC = ohlcCell('C', 'close');
  const ohlcV = ohlcCell('Vol', 'volume');
  const ohlcTime = el('span', {
    className: 'pt-chart__ohlc-time',
    dataset: { testId: 'chart-ohlc-time' },
    text: '',
  });
  ohlcCard.appendChild(ohlcO.cell);
  ohlcCard.appendChild(ohlcH.cell);
  ohlcCard.appendChild(ohlcL.cell);
  ohlcCard.appendChild(ohlcC.cell);
  ohlcCard.appendChild(ohlcV.cell);
  ohlcCard.appendChild(ohlcTime);
  canvasHost.appendChild(ohlcCard);

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
    if (crosshairUnsub) {
      try {
        crosshairUnsub();
      } catch {
        /* ignore */
      }
      crosshairUnsub = null;
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
    hideOhlcCard();
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
      return chartInstance.addLineSeries({ color: '#3ddb8e', lineWidth: 2 });
    }
    return null;
  }

  function computeMarkers() {
    // Filter points by overlay state, then map to lightweight-charts markers.
    // lightweight-charts v4 requires markers sorted ascending by time.
    return state.points
      .filter((p) => {
        if (!p || (p.type !== 'buy' && p.type !== 'sell')) return false;
        const mine = isOwnTrade(p.trader, state.ownAddress);
        if (mine && !state.show.my) return false;
        if (!mine && !state.show.others) return false;
        return true;
      })
      .map(pointToMarker)
      .filter(Boolean)
      .sort((a, b) => a.time - b.time);
  }

  /** Volume-weighted average price across own trades. NaN if no own data. */
  function computeOwnAvgPrice() {
    let sum = 0;
    let weight = 0;
    for (const p of state.points) {
      if (!isOwnTrade(p?.trader, state.ownAddress)) continue;
      if (p.type !== 'buy' && p.type !== 'sell') continue;
      const price = Number(p.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      const vol = Number(p.volume);
      const w = Number.isFinite(vol) && vol > 0 ? vol : 1;
      sum += price * w;
      weight += w;
    }
    if (weight === 0) return NaN;
    return sum / weight;
  }

  let avgPriceLine = null;
  let netPosPriceLine = null;
  let crosshairUnsub = null;
  // Phase 1.5 follow-up: between ensureChartInstance() awaiting and the
  // subsequent removeSeries call in rebuildSeries(), an SSE price tick can
  // race in and call applyPrice() → renderNetPosLine() against the OLD
  // series. createPriceLine on a removed series leaks a priceLine object
  // (held by the now-detached series instance, no removePriceLine ever
  // called against the live series). Skip applyPrice's side-effects while
  // we're between series.
  let rebuilding = false;

  // ── OHLC crosshair card (batch 4.5) ─────────────────────────────────────
  // Show the OHLCV + time of the candle under the cursor in a floating
  // card pinned to the canvas top-left. Hide the card when the cursor
  // leaves the chart area or no candle is under the crosshair.
  function hideOhlcCard() {
    if (!ohlcCard.hidden) ohlcCard.hidden = true;
  }

  function findCandleByTime(time) {
    if (typeof time !== 'number') return null;
    // Candles are time-ascending; binary-search keeps this O(log n) for
    // large series without allocating intermediate arrays.
    const arr = state.candles;
    let lo = 0;
    let hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = arr[mid]?.time;
      if (t === time) return arr[mid];
      if (typeof t !== 'number' || t < time) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  function showOhlcCardForCandle(candle) {
    if (!candle) {
      hideOhlcCard();
      return;
    }
    ohlcO.value.textContent = formatPrice(candle.open);
    ohlcH.value.textContent = formatPrice(candle.high);
    ohlcL.value.textContent = formatPrice(candle.low);
    ohlcC.value.textContent = formatPrice(candle.close);
    // Close colour tracks candle direction — green up / red down vs open.
    const dir =
      typeof candle.close === 'number' && typeof candle.open === 'number'
        ? candle.close >= candle.open
          ? 'up'
          : 'down'
        : null;
    ohlcC.value.classList.toggle('is-up', dir === 'up');
    ohlcC.value.classList.toggle('is-down', dir === 'down');
    ohlcV.value.textContent = formatCompact(Number(candle.volume));
    ohlcTime.textContent = formatCrosshairTime(candle.time);
    ohlcCard.hidden = false;
  }

  /**
   * lightweight-charts crosshair handler. `param.time` is the bucket
   * timestamp of the hovered candle (matches state.candles[i].time);
   * `param.point` is the pixel coordinate or null when the cursor is
   * outside the chart area. We hide the card if either is missing.
   */
  function onCrosshairMove(param) {
    if (!param || !param.time || !param.point) {
      hideOhlcCard();
      return;
    }
    const candle = findCandleByTime(param.time);
    if (!candle) {
      hideOhlcCard();
      return;
    }
    showOhlcCardForCandle(candle);
  }

  function renderAvgLine() {
    if (!series) return;
    if (avgPriceLine && typeof series.removePriceLine === 'function') {
      try {
        series.removePriceLine(avgPriceLine);
      } catch {
        /* ignore */
      }
    }
    avgPriceLine = null;
    if (!state.show.avg) return;
    if (typeof series.createPriceLine !== 'function') return;
    const avg = computeOwnAvgPrice();
    if (!Number.isFinite(avg)) return;
    try {
      avgPriceLine = series.createPriceLine({
        price: avg,
        color: '#e0a93a',
        lineWidth: 1,
        lineStyle: 2, // dashed (lightweight-charts LineStyle.Dashed = 2)
        axisLabelVisible: true,
        title: 'Avg',
      });
    } catch {
      avgPriceLine = null;
    }
  }

  /**
   * Return the current user's balance for the active token, in display
   * units (number). 0 (or unknown) means "no position" → no line.
   *
   * Best-effort interpretation: the mockup shows Net pos as a marker
   * indicating an open position. We treat the line as "render at current
   * spot price iff the wallet holds >0 of the active token". When batch 6
   * (My Wallet tab) plumbs real balances via setOwnBalance(), this lights
   * up; until then the toggle is a controlled no-op on the live app.
   */
  function currentOwnBalance() {
    const addr = state.token?.address;
    if (!addr) return 0;
    const b = state.ownBalances.get(addr.toLowerCase());
    return typeof b === 'number' && Number.isFinite(b) && b > 0 ? b : 0;
  }

  function renderNetPosLine() {
    if (!series) return;
    if (netPosPriceLine && typeof series.removePriceLine === 'function') {
      try {
        series.removePriceLine(netPosPriceLine);
      } catch {
        /* ignore */
      }
    }
    netPosPriceLine = null;
    if (!state.show.netPos) return;
    if (!state.ownAddress) return; // disconnected → no position to draw
    if (currentOwnBalance() <= 0) return;
    if (typeof series.createPriceLine !== 'function') return;
    const price = lastCandleClose();
    if (typeof price !== 'number' || !Number.isFinite(price)) return;
    try {
      netPosPriceLine = series.createPriceLine({
        price,
        // Use the design-system accent with an inline fallback — tokens.css
        // owns the canonical value; we don't introduce new tokens here.
        color: 'var(--accent, #3ddb8e)',
        lineWidth: 1,
        lineStyle: 2, // dashed
        axisLabelVisible: true,
        title: 'Pos',
      });
    } catch {
      netPosPriceLine = null;
    }
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
      s.setMarkers(computeMarkers());
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
        background: { color: '#0a0f0d' },
        textColor: '#e8efe9',
      },
      grid: {
        vertLines: { color: '#141d1a' },
        horzLines: { color: '#141d1a' },
      },
      timeScale: { timeVisible: true, secondsVisible: false },
      autoSize: true,
    });

    // Batch 4.5 — wire crosshair handler for the OHLC floating card.
    // lightweight-charts returns an unsubscribe callback from v4; older
    // builds expect unsubscribeCrosshairMove(handler) instead. Capture
    // both shapes so destroyChart can clean up reliably.
    if (chartInstance && typeof chartInstance.subscribeCrosshairMove === 'function') {
      try {
        const ret = chartInstance.subscribeCrosshairMove(onCrosshairMove);
        if (typeof ret === 'function') {
          crosshairUnsub = ret;
        } else if (typeof chartInstance.unsubscribeCrosshairMove === 'function') {
          crosshairUnsub = () => {
            try {
              chartInstance.unsubscribeCrosshairMove(onCrosshairMove);
            } catch {
              /* ignore */
            }
          };
        }
      } catch {
        crosshairUnsub = null;
      }
    }

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
    rebuilding = true;
    try {
      await ensureChartInstance();
      if (series && chartInstance && typeof chartInstance.removeSeries === 'function') {
        try {
          chartInstance.removeSeries(series);
        } catch {
          /* ignore */
        }
      }
      // Old series is gone — its priceLine handles are invalid.
      avgPriceLine = null;
      netPosPriceLine = null;
      series = createSeries();
      setSeriesData(series);
      renderAvgLine();
      renderNetPosLine();
    } finally {
      rebuilding = false;
    }
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
    for (const k of OVERLAYS) {
      const on = !!state.show[k];
      overlayButtons[k].setAttribute('aria-checked', on ? 'true' : 'false');
      overlayButtons[k].classList.toggle('is-on', on);
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

  function onOverlayClick(e) {
    const btn = e.target.closest('[data-overlay]');
    if (!btn) return;
    const key = btn.dataset.overlay;
    if (!OVERLAYS.includes(key)) return;
    state.show[key] = !state.show[key];
    persistOverlays(state.show);
    applyToolbarAria();
    // My/Others changes affect which markers render. Avg and Net pos
    // change horizontal price-lines. All are cheap — just refresh.
    if (series && typeof series.setMarkers === 'function') {
      series.setMarkers(computeMarkers());
    }
    renderAvgLine();
    renderNetPosLine();
  }

  tfGroup.addEventListener('click', onTfClick);
  typeGroup.addEventListener('click', onTypeClick);
  unitGroup.addEventListener('click', onUnitClick);
  overlayGroup.addEventListener('click', onOverlayClick);

  // ── Public API ──────────────────────────────────────────────────────────
  function setToken(token) {
    state.token = token || null;
    applyUnitVisibility();
    // Previous candles are about to be replaced — drop stale OHLC text so
    // the floating card doesn't flash old data before the next hover.
    hideOhlcCard();
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
    // Phase 1.5 follow-up: don't touch the series (or its priceLines) while
    // rebuildSeries is mid-flight — the current `series` is about to be
    // removed and any createPriceLine on it would leak a detached object.
    // The post-rebuild renderNetPosLine() in rebuildSeries() will rebind
    // against the fresh series at the latest candle close.
    if (rebuilding) return;
    if (state.type === 'candles') {
      if (typeof series.update === 'function') series.update(updated);
    } else if (typeof series.update === 'function') {
      series.update({ time: updated.time, value: updated.close });
    }
    // Net-pos line tracks current spot — refresh when price ticks.
    if (state.show.netPos) renderNetPosLine();
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
      series.setMarkers(computeMarkers());
    }
    // Own trade may shift the avg — refresh the price-line if visible.
    if (state.show.avg && isOwnTrade(trade.trader, state.ownAddress)) {
      renderAvgLine();
    }
  }

  function destroy() {
    tfGroup.removeEventListener('click', onTfClick);
    typeGroup.removeEventListener('click', onTypeClick);
    unitGroup.removeEventListener('click', onUnitClick);
    overlayGroup.removeEventListener('click', onOverlayClick);
    destroyChart();
    container.replaceChildren();
  }

  /**
   * Wire the current wallet address (or null). Used for the My/Others
   * marker split and the own-trades volume-weighted Avg line. Pass lower-
   * or mixed-case; comparison is case-insensitive.
   */
  function setOwnAddress(addr) {
    const next = typeof addr === 'string' && addr ? addr.toLowerCase() : null;
    if (next === state.ownAddress) return;
    state.ownAddress = next;
    if (next === null) {
      // Disconnect → forget balances too (next connect re-supplies).
      state.ownBalances.clear();
    }
    if (series && typeof series.setMarkers === 'function') {
      series.setMarkers(computeMarkers());
    }
    renderAvgLine();
    renderNetPosLine();
  }

  /**
   * Set the current user's balance for a token.
   *
   * ⚠️ CONTRACT: `balance` MUST be in **display units** (e.g. `12.5`), NOT in
   * wei (`12500000000000000000`). Passing a wei amount would render a Net-pos
   * line at an astronomical "balance × spot" — almost certainly off-axis.
   * Current callers: `my-wallet-tab.js` emits `apiClient.getPosition(...)
   * .position` which the backend already serialises in display units.
   *
   * If you wire this to a wei-source (Multicall3, raw ERC-20 balanceOf), you
   * MUST divide by 10^18 (or token decimals) at the call site first. We
   * defensively early-return + warn when the input looks like raw wei
   * (>1e15 ≈ 10^-3 of a wei unit's worth of display-unit position; well above
   * any plausible holding).
   *
   * Pass 0 / negative / non-number to clear. Triggers a Net-pos line
   * re-render when the token is the active one.
   *
   * @param {string} tokenAddress  Token contract address (any case).
   * @param {number} balance       Display-unit balance; 0 to clear.
   */
  function setOwnBalance(tokenAddress, balance) {
    if (typeof tokenAddress !== 'string' || !tokenAddress) return;
    const key = tokenAddress.toLowerCase();
    const num = typeof balance === 'number' && Number.isFinite(balance) ? balance : 0;
    // Plausibility guard — if a caller accidentally passes wei (~1e18 for 1
    // PITCH) the chart would draw a horizontal line at a value beyond the
    // candle price range. 1e15 in display units (= 1 quadrillion tokens) is
    // a safe ceiling; any real holding is many orders of magnitude smaller.
    if (num > 1e15) {
      console.warn(
        'chart.setOwnBalance: balance %s for %s looks like wei, not display units; ignoring',
        num,
        key,
      );
      state.ownBalances.delete(key);
      const activeAddr = state.token?.address?.toLowerCase();
      if (activeAddr === key) renderNetPosLine();
      return;
    }
    if (num > 0) {
      state.ownBalances.set(key, num);
    } else {
      state.ownBalances.delete(key);
    }
    const active = state.token?.address?.toLowerCase();
    if (active === key) renderNetPosLine();
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
    setOwnAddress,
    setOwnBalance,
    refresh: loadChart,
    destroy,
    // Test seams — read-only views.
    _getState() {
      return { ...state };
    },
  };
}
