/**
 * Profile view (F0.15) — portfolio dashboard for the connected wallet.
 *
 * Mounted into `layout.profile` (the zone that becomes visible when
 * `body.mode-profile` is active). Reads `GET /api/v1/profile` (api-spec §6.1)
 * and renders eight blocks: summary, value-over-time chart, allocation,
 * balances, positions, closed positions, stats, and a paginated trades
 * table. Pagination cursor for `trades` is the opaque base64 `{block,logIndex}`
 * token returned by the backend.
 *
 * Public API:
 *   mountProfile(container, opts?) -> { reload, destroy }
 *
 * `opts.onTokenSelect(token)` — invoked when the user clicks a token in
 * positions/closed/trades; the host (main.js) switches back to dashboard
 * mode and tells the chart to load this token. We pass a partial token
 * row (address + symbol + kind) — the chart's setToken does the rest via
 * its own data sources.
 */

import * as defaultApi from './api.js';

const TRADES_PAGE_LIMIT = 100;

function el(tag, { className, dataset, attrs, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (dataset) for (const [k, v] of Object.entries(dataset)) node.dataset[k] = v;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function formatNumber(value, digits = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatPct(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function formatSigned(value, digits = 4) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatNumber(value, digits)}`;
}

function formatPrice(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1) return value.toFixed(4);
  if (abs >= 0.01) return value.toFixed(6);
  return value.toPrecision(3);
}

function formatWei(weiStr, decimals = 18, digits = 4) {
  if (typeof weiStr !== 'string' && typeof weiStr !== 'number') return '—';
  const s = String(weiStr);
  if (!/^-?\d+$/.test(s)) return '—';
  const neg = s.startsWith('-');
  const abs = neg ? s.slice(1) : s;
  const padded = abs.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals);
  const fracTrim = frac.slice(0, digits).replace(/0+$/, '');
  const out = fracTrim ? `${whole}.${fracTrim}` : whole;
  return neg ? `-${out}` : out;
}

function formatTs(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '—';
  const d = new Date(ts * 1000);
  // ISO with seconds, no milliseconds, swap T for space for readability.
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function shortTx(tx) {
  if (typeof tx !== 'string' || tx.length < 12) return tx || '';
  return `${tx.slice(0, 8)}…${tx.slice(-4)}`;
}

/** Build a card section with title + body container. */
function buildCard(title, testId) {
  const card = el('section', {
    className: 'pt-profile__card',
    dataset: { testId },
  });
  card.appendChild(el('h2', { className: 'pt-profile__card-title', text: title }));
  const body = el('div', { className: 'pt-profile__card-body' });
  card.appendChild(body);
  return { card, body };
}

function defaultChartLibFactory() {
  return import('lightweight-charts');
}

/**
 * @param {HTMLElement} container
 * @param {{
 *   apiClient?: { getProfile: Function },
 *   chartLibFactory?: () => Promise<{ createChart: Function }> | { createChart: Function },
 *   onTokenSelect?: (token: { address: string, symbol?: string, kind?: string }) => void,
 *   tradesLimit?: number,
 * }} [opts]
 */
export function mountProfile(container, opts = {}) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('mountProfile: container must be an HTMLElement');
  }
  const apiClient = opts.apiClient ?? defaultApi;
  const chartLibFactory = opts.chartLibFactory ?? defaultChartLibFactory;
  const tradesLimit = typeof opts.tradesLimit === 'number' ? opts.tradesLimit : TRADES_PAGE_LIMIT;
  const onTokenSelect = typeof opts.onTokenSelect === 'function' ? opts.onTokenSelect : null;

  container.replaceChildren();

  const wrapper = el('div', {
    className: 'pt-profile__wrap',
    dataset: { testId: 'profile-wrap' },
  });

  const status = el('div', {
    className: 'pt-profile__status',
    dataset: { testId: 'profile-status' },
    text: 'Loading profile…',
  });
  wrapper.appendChild(status);

  // ── Block containers ────────────────────────────────────────────────────
  const summary = buildCard('Summary', 'profile-summary');
  // Referral section was removed from Profile — referral surface now lives
  // exclusively in the header Referral button → dropdown popover. See
  // components/header-actions.js.
  const valueChart = buildCard('Portfolio value', 'profile-value-chart');
  const allocation = buildCard('Allocation', 'profile-allocation');
  const balances = buildCard('Balances', 'profile-balances');
  const positions = buildCard('Open positions', 'profile-positions');
  const closed = buildCard('Closed positions', 'profile-closed');
  const stats = buildCard('Stats', 'profile-stats');
  const trades = buildCard('Trades', 'profile-trades');
  const orders = buildCard('Limit orders', 'profile-orders');

  // Grid: top row = summary (full-width), then 2-col layout for the rest.
  const grid = el('div', { className: 'pt-profile__grid' });
  grid.appendChild(summary.card);
  grid.appendChild(valueChart.card);
  grid.appendChild(allocation.card);
  grid.appendChild(balances.card);
  grid.appendChild(stats.card);
  grid.appendChild(positions.card);
  grid.appendChild(closed.card);
  grid.appendChild(trades.card);
  grid.appendChild(orders.card);
  wrapper.appendChild(grid);
  container.appendChild(wrapper);

  // ── State ───────────────────────────────────────────────────────────────
  const state = {
    profile: null,
    trades: { items: [], nextCursor: null, history: [] }, // history of cursors for "prev"
    loading: false,
    error: null,
    reqSeq: 0,
  };

  // Chart lib (lazy).
  let chartLib = null;
  let chartInstance = null;
  let chartSeries = null;
  let chartHost = null;

  async function ensureChartLib() {
    if (chartLib) return chartLib;
    const result = chartLibFactory();
    chartLib = result && typeof result.then === 'function' ? await result : result;
    return chartLib;
  }

  // ── Renderers ───────────────────────────────────────────────────────────

  function setStatus(text, hidden = false) {
    status.hidden = hidden;
    status.textContent = text;
  }

  function renderSummary(s) {
    summary.body.replaceChildren();
    if (!s) {
      summary.body.appendChild(el('div', { className: 'pt-profile__empty', text: 'No data' }));
      return;
    }
    const grid = el('div', { className: 'pt-profile__summary-grid' });
    const items = [
      { label: 'Value (PITCH)', value: formatNumber(s.totalValuePitch, 2), key: 'totalValuePitch' },
      {
        label: 'Realised PnL',
        value: formatSigned(s.realizedPnlPitch, 2),
        key: 'realizedPnlPitch',
        sign: s.realizedPnlPitch,
      },
      {
        label: 'Unrealised PnL',
        value: formatSigned(s.unrealizedPnlPitch, 2),
        key: 'unrealizedPnlPitch',
        sign: s.unrealizedPnlPitch,
      },
      {
        label: 'Total PnL',
        value: formatSigned(s.totalPnlPitch, 2),
        key: 'totalPnlPitch',
        sign: s.totalPnlPitch,
      },
      { label: 'ROI', value: formatPct(s.roiPct), key: 'roiPct', sign: s.roiPct },
      {
        label: 'Open positions',
        value: typeof s.openPositions === 'number' ? String(s.openPositions) : '—',
        key: 'openPositions',
      },
      { label: 'Fees (PITCH)', value: formatNumber(s.feesPaidPitch, 4), key: 'feesPaidPitch' },
    ];
    for (const it of items) {
      const cell = el('div', { className: 'pt-profile__stat' });
      cell.appendChild(el('div', { className: 'pt-profile__stat-label', text: it.label }));
      const val = el('div', {
        className: 'pt-profile__stat-value',
        dataset: { testId: `profile-summary-${it.key}` },
        text: it.value,
      });
      if (typeof it.sign === 'number') {
        if (it.sign > 0) val.classList.add('positive');
        else if (it.sign < 0) val.classList.add('negative');
      }
      cell.appendChild(val);
      grid.appendChild(cell);
    }
    summary.body.appendChild(grid);
  }

  function renderAllocation(a) {
    allocation.body.replaceChildren();
    if (!a) {
      allocation.body.appendChild(el('div', { className: 'pt-profile__empty', text: 'No data' }));
      return;
    }
    const list = el('div', { className: 'pt-profile__alloc' });
    const totals = el('div', { className: 'pt-profile__alloc-totals' });
    totals.appendChild(el('span', { text: `Players: ${formatNumber(a.players, 2)}` }));
    totals.appendChild(el('span', { text: `Countries: ${formatNumber(a.countries, 2)}` }));
    list.appendChild(totals);

    function appendGroup(title, dict, testId) {
      if (!dict || typeof dict !== 'object') return;
      const entries = Object.entries(dict).sort((a, b) => Number(b[1]) - Number(a[1]));
      if (entries.length === 0) return;
      const grpTitle = el('div', { className: 'pt-profile__alloc-group-title', text: title });
      list.appendChild(grpTitle);
      const ul = el('ul', { className: 'pt-profile__alloc-list', dataset: { testId } });
      for (const [k, v] of entries) {
        const li = el('li');
        li.appendChild(el('span', { className: 'pt-profile__alloc-key', text: k }));
        li.appendChild(
          el('span', { className: 'pt-profile__alloc-val', text: formatNumber(Number(v), 2) }),
        );
        ul.appendChild(li);
      }
      list.appendChild(ul);
    }
    appendGroup('By country', a.byCountry, 'profile-alloc-by-country');
    appendGroup('By role', a.byRole, 'profile-alloc-by-role');
    allocation.body.appendChild(list);
  }

  function renderBalances(b) {
    balances.body.replaceChildren();
    if (!b) {
      balances.body.appendChild(el('div', { className: 'pt-profile__empty', text: 'No data' }));
      return;
    }
    const ul = el('ul', {
      className: 'pt-profile__balances',
      dataset: { testId: 'profile-balances-list' },
    });
    function row(label, weiStr, testId) {
      const li = el('li');
      li.appendChild(el('span', { className: 'pt-profile__bal-key', text: label }));
      li.appendChild(
        el('span', {
          className: 'pt-profile__bal-val',
          dataset: { testId },
          text: formatWei(weiStr),
        }),
      );
      ul.appendChild(li);
    }
    row('ETH', b.ethWei, 'profile-balance-eth');
    row('PITCH', b.pitchWei, 'profile-balance-pitch');
    for (const c of Array.isArray(b.countries) ? b.countries : []) {
      row(
        c.symbol || c.address || 'country',
        c.wei,
        `profile-balance-${(c.symbol || '').toLowerCase()}`,
      );
    }
    balances.body.appendChild(ul);
  }

  function renderStats(s) {
    stats.body.replaceChildren();
    if (!s) {
      stats.body.appendChild(el('div', { className: 'pt-profile__empty', text: 'No data' }));
      return;
    }
    const grid = el('div', { className: 'pt-profile__summary-grid' });
    const items = [
      {
        label: 'Total trades',
        value: typeof s.totalTrades === 'number' ? String(s.totalTrades) : '—',
        key: 'totalTrades',
      },
      { label: 'Buys', value: typeof s.buys === 'number' ? String(s.buys) : '—', key: 'buys' },
      { label: 'Sells', value: typeof s.sells === 'number' ? String(s.sells) : '—', key: 'sells' },
      { label: 'Volume (PITCH)', value: formatNumber(s.volumePitch, 2), key: 'volumePitch' },
      { label: 'Avg trade', value: formatNumber(s.avgTradePitch, 2), key: 'avgTradePitch' },
      { label: 'Fees', value: formatNumber(s.feesPaidPitch, 4), key: 'feesPaidPitch' },
      {
        label: 'Closed positions',
        value: typeof s.closedPositions === 'number' ? String(s.closedPositions) : '—',
        key: 'closedPositions',
      },
      { label: 'Win rate', value: formatPct(s.winRatePct), key: 'winRatePct' },
    ];
    for (const it of items) {
      const cell = el('div', { className: 'pt-profile__stat' });
      cell.appendChild(el('div', { className: 'pt-profile__stat-label', text: it.label }));
      cell.appendChild(
        el('div', {
          className: 'pt-profile__stat-value',
          dataset: { testId: `profile-stats-${it.key}` },
          text: it.value,
        }),
      );
      grid.appendChild(cell);
    }
    stats.body.appendChild(grid);

    // Best/worst row.
    const bw = el('div', { className: 'pt-profile__bw' });
    if (s.best) {
      bw.appendChild(
        el('span', {
          className: 'positive',
          dataset: { testId: 'profile-stats-best' },
          text: `Best: ${s.best.symbol || '—'} ${formatSigned(s.best.pnlPitch, 2)}`,
        }),
      );
    }
    if (s.worst) {
      bw.appendChild(
        el('span', {
          className: 'negative',
          dataset: { testId: 'profile-stats-worst' },
          text: `Worst: ${s.worst.symbol || '—'} ${formatSigned(s.worst.pnlPitch, 2)}`,
        }),
      );
    }
    if (bw.childElementCount > 0) stats.body.appendChild(bw);
  }

  function makeTokenLinkCell(addr, symbol, kind, testId) {
    const cell = el('td');
    if (!addr) {
      cell.textContent = symbol || '—';
      return cell;
    }
    const btn = el('button', {
      className: 'pt-profile__token-link',
      dataset: { testId, address: addr },
      attrs: { type: 'button' },
      text: symbol || addr,
    });
    btn.addEventListener('click', () => {
      if (onTokenSelect) onTokenSelect({ address: addr, symbol, kind });
    });
    cell.appendChild(btn);
    return cell;
  }

  function renderPositions(items) {
    positions.body.replaceChildren();
    if (!Array.isArray(items) || items.length === 0) {
      positions.body.appendChild(
        el('div', { className: 'pt-profile__empty', text: 'No open positions' }),
      );
      return;
    }
    const table = el('table', {
      className: 'pt-profile__table',
      dataset: { testId: 'profile-positions-table' },
    });
    const head = el('thead');
    const headRow = el('tr');
    for (const label of [
      'Token',
      'Type',
      'Country',
      'Qty',
      'Avg buy',
      'Price',
      'Value',
      'PnL',
      '%',
      'Share',
    ]) {
      headRow.appendChild(el('th', { text: label }));
    }
    head.appendChild(headRow);
    table.appendChild(head);

    const body = el('tbody');
    for (const p of items) {
      const tr = el('tr', { dataset: { testId: 'profile-position-row', address: p.token || '' } });
      tr.appendChild(makeTokenLinkCell(p.token, p.symbol, p.kind, 'profile-position-token'));
      tr.appendChild(el('td', { text: p.kind || '—' }));
      tr.appendChild(el('td', { text: p.country || '—' }));
      tr.appendChild(el('td', { text: formatNumber(p.qty, 4) }));
      tr.appendChild(el('td', { text: formatPrice(p.avgBuy) }));
      tr.appendChild(el('td', { text: formatPrice(p.currentPrice) }));
      tr.appendChild(el('td', { text: formatNumber(p.valuePitch, 2) }));
      const pnlCell = el('td', { text: formatSigned(p.unrealizedPnlPitch, 2) });
      if (typeof p.unrealizedPnlPitch === 'number') {
        if (p.unrealizedPnlPitch > 0) pnlCell.classList.add('positive');
        else if (p.unrealizedPnlPitch < 0) pnlCell.classList.add('negative');
      }
      tr.appendChild(pnlCell);
      tr.appendChild(el('td', { text: formatPct(p.unrealizedPct) }));
      tr.appendChild(el('td', { text: formatPct(p.sharePct) }));
      body.appendChild(tr);
    }
    table.appendChild(body);
    positions.body.appendChild(table);
  }

  function renderClosed(items) {
    closed.body.replaceChildren();
    if (!Array.isArray(items) || items.length === 0) {
      closed.body.appendChild(
        el('div', { className: 'pt-profile__empty', text: 'No closed positions' }),
      );
      return;
    }
    const table = el('table', {
      className: 'pt-profile__table',
      dataset: { testId: 'profile-closed-table' },
    });
    const head = el('thead');
    const headRow = el('tr');
    for (const label of ['Token', 'Type', 'Country', 'PnL', 'Buys', 'Sells', 'Last']) {
      headRow.appendChild(el('th', { text: label }));
    }
    head.appendChild(headRow);
    table.appendChild(head);

    const body = el('tbody');
    for (const c of items) {
      const tr = el('tr', { dataset: { testId: 'profile-closed-row' } });
      tr.appendChild(makeTokenLinkCell(c.token, c.symbol, c.kind, 'profile-closed-token'));
      tr.appendChild(el('td', { text: c.kind || '—' }));
      tr.appendChild(el('td', { text: c.country || '—' }));
      const pnlCell = el('td', { text: formatSigned(c.realizedPnlPitch, 2) });
      if (typeof c.realizedPnlPitch === 'number') {
        if (c.realizedPnlPitch > 0) pnlCell.classList.add('positive');
        else if (c.realizedPnlPitch < 0) pnlCell.classList.add('negative');
      }
      tr.appendChild(pnlCell);
      tr.appendChild(el('td', { text: typeof c.buys === 'number' ? String(c.buys) : '—' }));
      tr.appendChild(el('td', { text: typeof c.sells === 'number' ? String(c.sells) : '—' }));
      tr.appendChild(el('td', { text: formatTs(c.lastTs) }));
      body.appendChild(tr);
    }
    table.appendChild(body);
    closed.body.appendChild(table);
  }

  function renderTrades() {
    trades.body.replaceChildren();
    const items = state.trades.items;
    if (!Array.isArray(items) || items.length === 0) {
      trades.body.appendChild(el('div', { className: 'pt-profile__empty', text: 'No trades' }));
      return;
    }
    const table = el('table', {
      className: 'pt-profile__table',
      dataset: { testId: 'profile-trades-table' },
    });
    const head = el('thead');
    const headRow = el('tr');
    for (const label of ['Time', 'Token', 'Side', 'Price', 'Amount', 'Value', 'Fee', 'Tx']) {
      headRow.appendChild(el('th', { text: label }));
    }
    head.appendChild(headRow);
    table.appendChild(head);

    const body = el('tbody');
    for (const t of items) {
      const tr = el('tr', { dataset: { testId: 'profile-trade-row' } });
      tr.appendChild(el('td', { text: formatTs(t.timestamp) }));
      // /profile trades shape doesn't include `token` address per spec — but
      // backend may include it; fall back to making it non-clickable.
      const tokenAddr = typeof t.token === 'string' ? t.token : '';
      tr.appendChild(makeTokenLinkCell(tokenAddr, t.symbol, t.kind, 'profile-trade-token'));
      const sideCell = el('td', { text: t.type || '—' });
      if (t.type === 'buy') sideCell.classList.add('positive');
      else if (t.type === 'sell') sideCell.classList.add('negative');
      tr.appendChild(sideCell);
      tr.appendChild(el('td', { text: formatPrice(t.price) }));
      tr.appendChild(el('td', { text: formatNumber(t.amount, 4) }));
      tr.appendChild(el('td', { text: formatNumber(t.valuePitch, 2) }));
      tr.appendChild(el('td', { text: formatNumber(t.feePitch, 4) }));
      tr.appendChild(el('td', { text: shortTx(t.tx) }));
      body.appendChild(tr);
    }
    table.appendChild(body);

    // Pagination footer.
    const nav = el('div', {
      className: 'pt-profile__pager',
      dataset: { testId: 'profile-trades-pager' },
    });
    const prevBtn = el('button', {
      className: 'pt-btn',
      dataset: { testId: 'profile-trades-prev' },
      attrs: { type: 'button' },
      text: '◀ Prev',
    });
    const nextBtn = el('button', {
      className: 'pt-btn',
      dataset: { testId: 'profile-trades-next' },
      attrs: { type: 'button' },
      text: 'Next ▶',
    });
    prevBtn.disabled = state.trades.history.length === 0;
    nextBtn.disabled = !state.trades.nextCursor;
    prevBtn.addEventListener('click', () => loadTradesPrev());
    nextBtn.addEventListener('click', () => loadTradesNext());
    nav.appendChild(prevBtn);
    nav.appendChild(nextBtn);

    trades.body.appendChild(table);
    trades.body.appendChild(nav);
  }

  function renderOrders(items) {
    orders.body.replaceChildren();
    // Cross-token orders rendering — endpoint may not return this field yet.
    // Show a stub when missing/empty so the block is always visible.
    if (!Array.isArray(items) || items.length === 0) {
      orders.body.appendChild(
        el('div', {
          className: 'pt-profile__empty',
          dataset: { testId: 'profile-orders-empty' },
          text: 'No active orders',
        }),
      );
      return;
    }
    const table = el('table', {
      className: 'pt-profile__table',
      dataset: { testId: 'profile-orders-table' },
    });
    const head = el('thead');
    const headRow = el('tr');
    for (const label of ['Token', 'Side', 'Price', 'Status', 'Created']) {
      headRow.appendChild(el('th', { text: label }));
    }
    head.appendChild(headRow);
    table.appendChild(head);
    const body = el('tbody');
    for (const o of items) {
      const tr = el('tr');
      tr.appendChild(makeTokenLinkCell(o.token, o.tokenSymbol, o.tokenKind, 'profile-order-token'));
      tr.appendChild(el('td', { text: o.side || '—' }));
      tr.appendChild(el('td', { text: formatWei(o.targetPrice) }));
      tr.appendChild(el('td', { text: o.status || '—' }));
      tr.appendChild(el('td', { text: formatTs(o.createdAt) }));
      body.appendChild(tr);
    }
    table.appendChild(body);
    orders.body.appendChild(table);
  }

  async function renderValueChart(series) {
    valueChart.body.replaceChildren();
    if (!Array.isArray(series) || series.length === 0) {
      valueChart.body.appendChild(el('div', { className: 'pt-profile__empty', text: 'No data' }));
      return;
    }
    chartHost = el('div', {
      className: 'pt-profile__chart-host',
      dataset: { testId: 'profile-value-chart-host' },
    });
    valueChart.body.appendChild(chartHost);
    // Tear down previous instance (re-render after reload).
    if (chartInstance && typeof chartInstance.remove === 'function') {
      try {
        chartInstance.remove();
      } catch {
        /* ignore */
      }
    }
    chartInstance = null;
    chartSeries = null;
    let mod;
    try {
      mod = await ensureChartLib();
    } catch (err) {
      console.error('mountProfile: chart lib load failed', err);
      valueChart.body.appendChild(
        el('div', { className: 'pt-profile__empty', text: 'Chart unavailable' }),
      );
      return;
    }
    if (!mod || typeof mod.createChart !== 'function') return;
    chartInstance = mod.createChart(chartHost, {
      layout: { background: { color: '#0a0f0d' }, textColor: '#e8efe9' },
      grid: {
        vertLines: { color: '#141d1a' },
        horzLines: { color: '#141d1a' },
      },
      timeScale: { timeVisible: true, secondsVisible: false },
      autoSize: true,
    });
    if (typeof chartInstance.addLineSeries === 'function') {
      chartSeries = chartInstance.addLineSeries({ color: '#3ddb8e', lineWidth: 2 });
      // lightweight-charts requires ascending time order.
      const data = series
        .filter((p) => typeof p?.time === 'number' && typeof p?.value === 'number')
        .map((p) => ({ time: p.time, value: p.value }))
        .sort((a, b) => a.time - b.time);
      if (typeof chartSeries.setData === 'function') chartSeries.setData(data);
    }
  }

  // ── Data loading ────────────────────────────────────────────────────────

  async function loadProfile(tradesCursor) {
    const seq = ++state.reqSeq;
    state.loading = true;
    state.error = null;
    // Reset pagination — reload() must not preserve a stale cursor stack
    // from a previous session of the same Profile view.
    state.trades.history = [];
    setStatus('Loading profile…', false);

    let resp;
    try {
      resp = await apiClient.getProfile({ tradesLimit, tradesCursor });
    } catch (err) {
      if (seq !== state.reqSeq) return;
      state.loading = false;
      state.error = err;
      const msg =
        err && err.status === 402
          ? 'Profile is available after payment.'
          : err && err.status === 401
            ? 'Sign in with your wallet to view the profile.'
            : 'Failed to load profile.';
      setStatus(msg, false);
      return;
    }
    if (seq !== state.reqSeq) return;

    state.loading = false;
    state.profile = resp;
    setStatus('', true);

    renderSummary(resp?.summary);
    renderAllocation(resp?.allocation);
    renderBalances(resp?.balances);
    renderStats(resp?.stats);
    renderPositions(resp?.positions);
    renderClosed(resp?.closed);

    const t = resp?.trades || {};
    state.trades.items = Array.isArray(t.items) ? t.items : [];
    state.trades.nextCursor = t.nextCursor ?? null;
    renderTrades();

    // Orders may be embedded in profile (future) or fetched separately.
    // Render whatever's there; absence = empty stub.
    renderOrders(Array.isArray(resp?.orders) ? resp.orders : []);

    // Value-over-time chart — async, doesn't block other blocks.
    renderValueChart(resp?.valueSeries).catch((err) => {
      console.error('mountProfile: value chart failed', err);
    });
  }

  async function loadTradesNext() {
    // In-flight guard: rapid double-click would otherwise push the same
    // cursor twice and corrupt the history stack.
    if (state.loading) return;
    const cursor = state.trades.nextCursor;
    if (!cursor) return;
    state.loading = true;
    setStatus('Loading trades…', false);
    try {
      const resp = await apiClient.getProfile({ tradesLimit, tradesCursor: cursor });
      // history is a stack of cursors used to load each page; first page
      // used `undefined`. Push the cursor that produced the page we're now
      // leaving so "prev" can re-request it.
      state.trades.history.push(cursor);
      const t = resp?.trades || {};
      state.trades.items = Array.isArray(t.items) ? t.items : [];
      state.trades.nextCursor = t.nextCursor ?? null;
      setStatus('', true);
      renderTrades();
    } catch (err) {
      setStatus('Failed to load trades page.', false);
      console.error('mountProfile: loadTradesNext failed', err);
    } finally {
      state.loading = false;
    }
  }

  async function loadTradesPrev() {
    // In-flight guard — symmetric to loadTradesNext.
    if (state.loading) return;
    // Pop one off; if the resulting history is empty, we're back to the
    // initial (cursor-less) page.
    if (state.trades.history.length === 0) return;
    state.trades.history.pop();
    const cursor =
      state.trades.history.length > 0
        ? state.trades.history[state.trades.history.length - 1]
        : undefined;
    state.loading = true;
    setStatus('Loading trades…', false);
    try {
      const resp = await apiClient.getProfile({ tradesLimit, tradesCursor: cursor });
      const t = resp?.trades || {};
      state.trades.items = Array.isArray(t.items) ? t.items : [];
      state.trades.nextCursor = t.nextCursor ?? null;
      setStatus('', true);
      renderTrades();
    } catch (err) {
      setStatus('Failed to load trades page.', false);
      console.error('mountProfile: loadTradesPrev failed', err);
    } finally {
      state.loading = false;
    }
  }

  // Initial load fires immediately.
  loadProfile();

  function destroy() {
    if (chartInstance && typeof chartInstance.remove === 'function') {
      try {
        chartInstance.remove();
      } catch {
        /* ignore */
      }
    }
    chartInstance = null;
    chartSeries = null;
    container.replaceChildren();
  }

  return {
    reload: () => {
      return loadProfile();
    },
    destroy,
    _getState() {
      return {
        loading: state.loading,
        error: state.error,
        hasProfile: state.profile !== null,
        tradesCount: state.trades.items.length,
        nextCursor: state.trades.nextCursor,
        historyDepth: state.trades.history.length,
      };
    },
  };
}
