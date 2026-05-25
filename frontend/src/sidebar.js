/**
 * Token-lists sidebar — Players / Countries tabs with search, role filter,
 * change-period selector and sort.
 *
 * Reads from `GET /api/v1/tokens` (see api-spec §4.1):
 *   - players: { address, name, symbol, country, countryAddress, role,
 *                pricePitch, priceCountry, supply, tradesCount, holdersCount,
 *                changePct: { all, 1d, 12h, 6h, 1h, 15m } }
 *   - countries: { address, name, symbol, pricePitch, supply, tradesCount,
 *                  holdersCount, changePct: { ... } }
 *
 * UI parity rules (docs/functional-spec.md §3):
 *   - Both tabs: sort by pricePitch DESC (most expensive first). The period
 *     selector affects which changePct is shown in the row, but NOT the order.
 *     Known-issue #7 (2026-05-24): players were sorted by changePct[period]
 *     which produced a seemingly-random order when most tokens have pricePitch=0
 *     during worker backfill. Unified with countries' price-sort.
 *   - Role filter visible only on Players tab.
 *
 * All DOM is built via `document.createElement` (no innerHTML).
 *
 * NB: `main.js` integration is intentionally deferred — F0.5 only ships the
 * component + its tests; wiring into the live app is a separate step.
 */

import * as defaultApi from './api.js';
import { flagSrc, hasFlag } from './flags.js';
import { renderSparkline } from './utils/sparkline.js';

const TABS = Object.freeze(['players', 'countries']);
const ROLES = Object.freeze(['all', 'best', 'captain', 'rookie']);
const PERIODS = Object.freeze(['all', '1d', '12h', '6h', '1h', '15m']);

const ROLE_LABEL = {
  all: 'All',
  best: 'Best',
  captain: 'Captain',
  rookie: 'Rookie',
};

const TAB_LABEL = {
  players: 'Players',
  countries: 'Countries',
};

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

/** Format pricePitch for display. Falls back to `?` for missing values. */
function formatPrice(value) {
  // `Number.isNaN(stringValue)` is false — guard the type too so a stray
  // non-number (e.g. backend returning a wei-string) doesn't blow up the
  // `.toFixed` call below (review J, M6).
  if (typeof value !== 'number' || Number.isNaN(value)) return '?';
  if (value === 0) return '0';
  // Unified 3-decimal format for visual consistency across the sidebar.
  // Sub-0.001 values collapse to '0.000' (acceptable sentinel — sidebar is
  // a glance-view, not a precision tool).
  return value.toFixed(3);
}

/** Format changePct for display: signed with one decimal place. */
function formatChange(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

/** Read a changePct value for the given period, defaulting to 0. */
function pctOf(token, period) {
  const v = token?.changePct?.[period];
  return typeof v === 'number' ? v : 0;
}

/**
 * Filter + sort tokens for the current view.
 * Pure function — easy to test, no DOM.
 */
function selectTokens(state, source) {
  const list = state.tab === 'players' ? (source.players ?? []) : (source.countries ?? []);
  const q = state.search.trim().toLowerCase();

  let filtered = list.filter((t) => {
    if (q) {
      const name = (t.name || '').toLowerCase();
      const symbol = (t.symbol || '').toLowerCase();
      if (!name.includes(q) && !symbol.includes(q)) return false;
    }
    if (state.tab === 'players' && state.role !== 'all') {
      if (t.role !== state.role) return false;
    }
    return true;
  });

  // Sort by pricePitch DESC for both tabs (known-issue #7). Stable tiebreaker
  // on address keeps the order deterministic when several tokens share the
  // same price (very common while everything is 0 during worker backfill).
  filtered = filtered.slice().sort((a, b) => {
    const pa = typeof a.pricePitch === 'number' ? a.pricePitch : 0;
    const pb = typeof b.pricePitch === 'number' ? b.pricePitch : 0;
    if (pb !== pa) return pb - pa;
    const aa = typeof a.address === 'string' ? a.address : '';
    const ab = typeof b.address === 'string' ? b.address : '';
    return aa < ab ? -1 : aa > ab ? 1 : 0;
  });

  return filtered;
}

/**
 * Mount the token-lists sidebar into the given container.
 *
 * @param {HTMLElement} container - the sidebar zone from layout.js
 * @param {{
 *   onTokenSelect?: (token: object) => void,
 *   apiClient?: { getTokens: () => Promise<object> },
 *   getSparkline?: (tokenAddress: string) => number[]|null|undefined,
 *   getPosition?: (tokenAddress: string) => ({balance?: number, hasPosition?: boolean}|null|undefined),
 * }} [options]
 *
 * Phase 1.5 batch 3 (sparkline + pos-marker): both providers are optional and
 * pulled lazily during each render(). The sidebar does NOT fetch chart or
 * position data on its own — keeping the component decoupled from network
 * concerns. Wiring lives in main.js (deferred) where chart candles + the
 * wallet position cache already exist.
 * @returns {{
 *   refresh: () => Promise<void>,
 *   update: (tokens: object) => void,
 *   rerender: () => void,
 *   destroy: () => void,
 * }}
 *
 * `rerender()` re-runs the row build using the current cached tokens — used
 * by main.js to reflect sparkline / position provider updates without an
 * API round-trip. No-op if no tokens have loaded yet.
 */
export function mountSidebar(container, options = {}) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('mountSidebar: container must be an HTMLElement');
  }

  const apiClient = options.apiClient ?? defaultApi;
  const onTokenSelect = typeof options.onTokenSelect === 'function' ? options.onTokenSelect : null;
  // Phase 1.5 batch 3: optional sparkline / position providers. Both default
  // to no-ops so existing callers (and tests that don't pass them) keep their
  // current behaviour — the row simply omits the sparkline cell content and
  // the position dot.
  const getSparkline =
    typeof options.getSparkline === 'function' ? options.getSparkline : () => null;
  const getPosition = typeof options.getPosition === 'function' ? options.getPosition : () => null;

  // Idempotent — clear any prior mount.
  container.replaceChildren();

  const state = {
    tab: 'players',
    search: '',
    role: 'all',
    period: 'all',
    tokens: { players: [], countries: [], lastUpdate: 0, stale: false },
    selectedAddress: null,
    // Index of the row that owns the roving tabindex (review J H-1).
    focusedIndex: 0,
  };

  // ── Build skeleton ──────────────────────────────────────────────────────
  const inner = el('div', { className: 'pt-sidebar__inner' });

  // Tabs
  const tabs = el('div', {
    className: 'pt-sidebar__tabs',
    dataset: { testId: 'sidebar-tabs' },
    attrs: { role: 'tablist' },
  });
  const tabButtons = {};
  for (const tab of TABS) {
    const btn = el('button', {
      className: 'pt-sidebar__tab',
      dataset: { tab, testId: `sidebar-tab-${tab}` },
      attrs: {
        type: 'button',
        role: 'tab',
        'aria-selected': tab === state.tab ? 'true' : 'false',
      },
      text: TAB_LABEL[tab],
    });
    tabButtons[tab] = btn;
    tabs.appendChild(btn);
  }

  // Filters
  const filters = el('div', { className: 'pt-sidebar__filters' });
  const search = el('input', {
    className: 'pt-sidebar__search',
    dataset: { testId: 'sidebar-search' },
    attrs: { type: 'search', placeholder: 'Search...', 'aria-label': 'Search tokens' },
  });
  // Role filter — horizontal group of toggle buttons (All / Best / Captain /
  // Rookie). Mirrors the portable-app UX; the `<select>` was replaced in this
  // batch. The root container keeps `data-test-id="sidebar-role"` for backward
  // compatibility (visibility toggle + a few existing tests). Each individual
  // button carries `data-test-id="sidebar-role-<role>"`.
  const roleGroup = el('div', {
    className: 'pt-sidebar__role',
    dataset: { testId: 'sidebar-role' },
    attrs: { role: 'group', 'aria-label': 'Filter by role' },
  });
  const roleButtons = {};
  for (const r of ROLES) {
    const btn = el('button', {
      className: 'pt-sidebar__role-btn',
      dataset: { role: r, testId: `sidebar-role-${r}` },
      attrs: {
        type: 'button',
        'aria-pressed': r === state.role ? 'true' : 'false',
      },
      text: ROLE_LABEL[r],
    });
    if (r === state.role) btn.classList.add('is-active');
    roleButtons[r] = btn;
    roleGroup.appendChild(btn);
  }
  const periodSelect = el('select', {
    className: 'pt-sidebar__period',
    dataset: { testId: 'sidebar-period' },
    attrs: { 'aria-label': 'Price change period' },
  });
  for (const p of PERIODS) {
    const opt = el('option', { text: p });
    opt.value = p;
    periodSelect.appendChild(opt);
  }
  filters.appendChild(search);
  filters.appendChild(roleGroup);
  filters.appendChild(periodSelect);

  // List
  const list = el('ul', {
    className: 'pt-sidebar__list',
    dataset: { testId: 'sidebar-list' },
    attrs: { role: 'listbox', 'aria-label': 'Token list' },
  });

  // Empty state placeholder (sibling, hidden by default)
  const empty = el('div', {
    className: 'pt-sidebar__empty',
    dataset: { testId: 'sidebar-empty' },
    text: 'No tokens',
  });
  empty.hidden = true;

  inner.appendChild(tabs);
  inner.appendChild(filters);
  inner.appendChild(list);
  inner.appendChild(empty);
  container.appendChild(inner);

  // ── Render ──────────────────────────────────────────────────────────────
  function applyRoleVisibility() {
    // Role filter only meaningful for players.
    roleGroup.hidden = state.tab !== 'players';
  }

  function applyRoleAria() {
    for (const r of ROLES) {
      const btn = roleButtons[r];
      const active = r === state.role;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.classList.toggle('is-active', active);
    }
  }

  function applyTabAria() {
    for (const tab of TABS) {
      tabButtons[tab].setAttribute('aria-selected', tab === state.tab ? 'true' : 'false');
    }
  }

  function render() {
    applyTabAria();
    applyRoleAria();
    applyRoleVisibility();

    const rows = selectTokens(state, state.tokens);
    list.replaceChildren();

    if (rows.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    rows.forEach((token, idx) => {
      const isSelected = state.selectedAddress === token.address;
      // H-2 (review J): single-select listbox pattern. Only the selected row
      // carries `aria-selected="true"`; others omit the attribute (rather
      // than `="false"`, which makes a screen-reader announce "not selected"
      // on every row). H-1: roving tabindex — only the currently-focused
      // row is in tab order; arrow keys move within the list.
      const focusable = idx === state.focusedIndex;
      const attrs = {
        role: 'option',
        tabindex: focusable ? '0' : '-1',
      };
      if (isSelected) attrs['aria-selected'] = 'true';
      const li = el('li', {
        className: 'pt-sidebar__row',
        dataset: {
          testId: 'sidebar-row',
          tokenAddress: token.address || '',
        },
        attrs,
      });

      // Phase 1.5 batch 1: prefix country tokens with a flag SVG, and prefix
      // player rows whose `country` field has a mapped flag. Fall back to
      // text-only when the symbol is unmapped (covers any future country
      // ticker not yet vendored in /public/flags/).
      //
      // Batch 9 fix: backend's `players[].country` is a free-form name
      // ("France"), not the ISO-mapped ticker hasFlag() expects ("FRA"). We
      // resolve via the same path enrichTokenPayload uses for the trade panel
      // — countryAddress → state.tokens.countries[].symbol.
      const symbol = el('div', { className: 'symbol' });
      const enriched = state.tab === 'players' ? enrichTokenPayload(token) : token;
      const flagSymbol = state.tab === 'countries' ? token.symbol : enriched.countrySymbol;
      if (flagSymbol && hasFlag(flagSymbol)) {
        const flag = el('img', {
          className: 'pt-sidebar__flag',
          dataset: { testId: 'sidebar-flag' },
          attrs: {
            src: flagSrc(flagSymbol),
            alt: '',
            'aria-hidden': 'true',
            width: '16',
            height: '12',
            loading: 'lazy',
            decoding: 'async',
          },
        });
        symbol.appendChild(flag);
      }
      // Phase 1.5 batch 3: position marker — small dot before the symbol when
      // the user holds a non-zero balance of this token. The provider may
      // return either `{hasPosition: true}` (preferred — explicit) or a
      // `{balance: number}` we check ourselves. Anything else → no dot.
      const posInfo = token.address ? getPosition(token.address) : null;
      const hasPos =
        posInfo &&
        (posInfo.hasPosition === true ||
          (typeof posInfo.balance === 'number' && posInfo.balance > 0));
      if (hasPos) {
        const dot = el('span', {
          className: 'pt-sidebar__pos',
          dataset: { testId: 'sidebar-pos-marker' },
          attrs: {
            'aria-label': 'You hold this token',
            title: 'You hold this token',
          },
        });
        symbol.appendChild(dot);
      }
      // Country rows show the full name (e.g. "France") — the ticker
      // ("FRA") is reserved for the flag/symbol lookup and quote-suffix.
      // Player rows continue to display their ticker as the primary label.
      // The empty-string check is explicit (not `||`) so a backend-supplied
      // `name: ""` correctly falls back to the symbol.
      const labelText =
        state.tab === 'countries'
          ? typeof token.name === 'string' && token.name
            ? token.name
            : token.symbol || ''
          : token.symbol || '';
      symbol.appendChild(document.createTextNode(labelText));
      const metaParts = [];
      if (state.tab === 'players') {
        // Show country symbol + role for player rows. countryAddress is not
        // directly shown — only the country symbol if exposed via `country`.
        if (token.country) metaParts.push(token.country);
        if (token.role) metaParts.push(token.role);
      }
      const meta = el('div', { className: 'meta', text: metaParts.join(' · ') });

      // Phase 1.5 follow-up: player rows display price in their native country
      // denomination (e.g. "1.50 FRA") instead of the cross-token PITCH unit.
      // Country tickers come from `enrichTokenPayload` which resolves
      // `countryAddress → countries[].symbol` (with fallback to player.country).
      // If the country symbol cannot be resolved at all, we still surface the
      // priceCountry value but omit the unit suffix rather than misleading the
      // user with a PITCH value (formatPrice handles undefined → "?").
      // Country-tab rows keep the existing PITCH denomination.
      let priceText;
      if (state.tab === 'players') {
        const countrySymbol = enriched.countrySymbol;
        priceText = countrySymbol
          ? `${formatPrice(token.priceCountry)} ${countrySymbol}`
          : formatPrice(token.priceCountry);
      } else {
        priceText = `${formatPrice(token.pricePitch)} PITCH`;
      }
      const price = el('div', {
        className: 'price',
        text: priceText,
      });

      const changeValue = pctOf(token, state.period);
      const change = el('div', {
        className: `change ${changeValue >= 0 ? 'positive' : 'negative'}`,
        text: formatChange(token.changePct?.[state.period]),
      });

      // Phase 1.5 batch 3: sparkline cell. Always rendered as an empty <div>
      // so the row grid keeps a stable 4-column layout — the cell receives
      // an SVG only when the provider returns a non-empty series. This
      // matches how Real-Time-Updating components in this codebase handle
      // missing data (mirrors flag fallback in batch 1).
      const sparkCell = el('div', {
        className: 'pt-sidebar__spark-cell',
        dataset: { testId: 'sidebar-spark-cell' },
      });
      const series = token.address ? getSparkline(token.address) : null;
      if (Array.isArray(series) && series.length > 0) {
        const sparkSvg = renderSparkline(series, { testId: 'sidebar-spark' });
        if (sparkSvg) sparkCell.appendChild(sparkSvg);
      }

      li.appendChild(symbol);
      li.appendChild(meta);
      li.appendChild(sparkCell);
      li.appendChild(price);
      li.appendChild(change);

      li.addEventListener('click', () => handleSelect(token, idx));
      li.addEventListener('keydown', (ev) => onRowKeydown(ev, token, idx, rows));

      list.appendChild(li);
    });
  }

  function handleSelect(token, idx) {
    state.selectedAddress = token.address || null;
    if (typeof idx === 'number') state.focusedIndex = idx;
    // H-2 (review J): single-select aria pattern — remove aria-selected from
    // all rows, then set "true" only on the chosen one. Avoids the screen
    // reader announcing "not selected" 192 times.
    for (const node of list.querySelectorAll('[data-test-id="sidebar-row"]')) {
      const isSel = node.dataset.tokenAddress === state.selectedAddress;
      if (isSel) {
        node.setAttribute('aria-selected', 'true');
      } else {
        node.removeAttribute('aria-selected');
      }
    }
    if (onTokenSelect) onTokenSelect(enrichTokenPayload(token));
  }

  /**
   * F1.4 — enrich the player-row payload with `countrySymbol` resolved from
   * the country table the sidebar already holds. The backend's
   * `players[].country` field carries the symbol most of the time, but is
   * occasionally missing or out-of-sync for new entries; we lookup by
   * `countryAddress` against `state.tokens.countries` and prefer that.
   *
   * The trade panel uses this to skip its own `getTokens()` fetch and avoids
   * the race where the panel renders a player-Buy hint before the legacy
   * `countrySymbolMap` resolves. Country-only rows pass through unchanged.
   */
  function enrichTokenPayload(token) {
    if (!token || typeof token !== 'object') return token;
    if (typeof token.countryAddress !== 'string' || !token.countryAddress) return token;
    const addrLc = token.countryAddress.toLowerCase();
    const countries = state.tokens.countries || [];
    let resolved = null;
    for (const c of countries) {
      if (c && typeof c.address === 'string' && c.address.toLowerCase() === addrLc) {
        if (typeof c.symbol === 'string' && c.symbol) {
          resolved = c.symbol;
        }
        break;
      }
    }
    // Fallback to the player row's `country` field — it's the symbol in
    // practice (e.g. "BRA"). Keeps the threading useful when the country
    // table didn't include the entry (test fixtures, partial loads).
    const fallback = typeof token.country === 'string' && token.country ? token.country : null;
    const countrySymbol = resolved ?? fallback;
    if (!countrySymbol) return token;
    return { ...token, countrySymbol };
  }

  function focusRowAt(idx) {
    const rows = list.querySelectorAll('[data-test-id="sidebar-row"]');
    if (rows.length === 0) return;
    const safe = Math.max(0, Math.min(idx, rows.length - 1));
    state.focusedIndex = safe;
    // Update roving tabindex: only one row at tabindex=0 at a time.
    rows.forEach((node, i) => {
      node.setAttribute('tabindex', i === safe ? '0' : '-1');
    });
    /** @type {HTMLElement} */ (rows[safe]).focus();
  }

  // H-1 (review J): roving-tabindex + arrow keys for `role="listbox"`. Tab
  // enters the list at one row, arrows move between options.
  function onRowKeydown(ev, token, idx, rows) {
    switch (ev.key) {
      case 'Enter':
      case ' ':
        ev.preventDefault();
        handleSelect(token, idx);
        return;
      case 'ArrowDown':
        ev.preventDefault();
        focusRowAt(idx + 1);
        return;
      case 'ArrowUp':
        ev.preventDefault();
        focusRowAt(idx - 1);
        return;
      case 'Home':
        ev.preventDefault();
        focusRowAt(0);
        return;
      case 'End':
        ev.preventDefault();
        focusRowAt(rows.length - 1);
        return;
      default:
        // No-op — let other keys bubble (typing into search etc).
        return;
    }
  }

  // ── Event handlers ──────────────────────────────────────────────────────
  function onTabClick(ev) {
    // Review J M5: `ev.target` can be a nested icon/span once we add chrome
    // to tab buttons. `.closest('[data-tab]')` walks up to the actual button.
    const target = ev.target instanceof Element ? ev.target.closest('[data-tab]') : null;
    if (!(target instanceof HTMLElement)) return;
    const tab = target.dataset.tab;
    if (!tab || !TABS.includes(tab)) return;
    if (state.tab === tab) return;
    state.tab = tab;
    // H-3 (review J): role filter is meaningful only for Players. When we
    // switch to Countries, reset it so a later switch back to Players
    // doesn't keep a surprise filter active (and so the visible-but-hidden
    // selectbox doesn't carry stale state). focusedIndex is also reset —
    // the new dataset has different length.
    if (tab !== 'players') {
      state.role = 'all';
    }
    state.focusedIndex = 0;
    render();
  }

  function onSearchInput() {
    state.search = search.value || '';
    render();
  }

  function onRoleClick(ev) {
    const target = ev.target instanceof Element ? ev.target.closest('[data-role]') : null;
    if (!(target instanceof HTMLElement)) return;
    const role = target.dataset.role;
    if (!role || !ROLES.includes(role)) return;
    if (state.role === role) return;
    state.role = role;
    state.focusedIndex = 0;
    render();
  }

  function onPeriodChange() {
    state.period = periodSelect.value || 'all';
    render();
  }

  tabs.addEventListener('click', onTabClick);
  search.addEventListener('input', onSearchInput);
  roleGroup.addEventListener('click', onRoleClick);
  periodSelect.addEventListener('change', onPeriodChange);

  // ── Public API ──────────────────────────────────────────────────────────
  async function refresh() {
    const data = await apiClient.getTokens();
    update(data);
  }

  function update(tokens) {
    if (!tokens || typeof tokens !== 'object') return;
    state.tokens = {
      players: Array.isArray(tokens.players) ? tokens.players : [],
      countries: Array.isArray(tokens.countries) ? tokens.countries : [],
      lastUpdate: tokens.lastUpdate ?? 0,
      stale: !!tokens.stale,
    };
    render();
  }

  function destroy() {
    tabs.removeEventListener('click', onTabClick);
    search.removeEventListener('input', onSearchInput);
    roleGroup.removeEventListener('click', onRoleClick);
    periodSelect.removeEventListener('change', onPeriodChange);
    container.replaceChildren();
  }

  // Initial render (empty state).
  render();

  // Kick off initial fetch but don't block; tests can await `refresh()` directly
  // if they need a deterministic load.
  refresh().catch(() => {
    // Swallow — the empty state remains visible. Errors will surface via the
    // upcoming toast/banner subsystem (F0.13).
  });

  return { refresh, update, rerender: render, destroy };
}
