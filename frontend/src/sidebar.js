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
 *   - Players tab: sort by changePct[period] DESC by default.
 *   - Countries tab: sort by pricePitch DESC (portable parity); period selector
 *     still affects which changePct is shown in the row, but not the order.
 *   - Role filter visible only on Players tab.
 *
 * All DOM is built via `document.createElement` (no innerHTML).
 *
 * NB: `main.js` integration is intentionally deferred — F0.5 only ships the
 * component + its tests; wiring into the live app is a separate step.
 */

import * as defaultApi from './api.js';

const TABS = Object.freeze(['players', 'countries']);
const ROLES = Object.freeze(['all', 'best', 'captain', 'rookie']);
const PERIODS = Object.freeze(['all', '1d', '12h', '6h', '1h', '15m']);

const ROLE_LABEL = {
  all: 'Все',
  best: 'Best',
  captain: 'Captain',
  rookie: 'Rookie',
};

const TAB_LABEL = {
  players: 'Игроки',
  countries: 'Страны',
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
  // `.toFixed`/`.toPrecision` calls below (review J, M6).
  if (typeof value !== 'number' || Number.isNaN(value)) return '?';
  // Use up to 6 significant digits — prices range from ~0.000001 to ~1000.
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1) return value.toFixed(2);
  if (abs >= 0.01) return value.toFixed(4);
  return value.toPrecision(3);
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
  const list = state.tab === 'players' ? source.players ?? [] : source.countries ?? [];
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

  // Sort.
  if (state.tab === 'countries') {
    filtered = filtered.slice().sort((a, b) => (b.pricePitch ?? 0) - (a.pricePitch ?? 0));
  } else {
    filtered = filtered
      .slice()
      .sort((a, b) => pctOf(b, state.period) - pctOf(a, state.period));
  }

  return filtered;
}

/**
 * Mount the token-lists sidebar into the given container.
 *
 * @param {HTMLElement} container - the sidebar zone from layout.js
 * @param {{
 *   onTokenSelect?: (token: object) => void,
 *   apiClient?: { getTokens: () => Promise<object> },
 * }} [options]
 * @returns {{
 *   refresh: () => Promise<void>,
 *   update: (tokens: object) => void,
 *   destroy: () => void,
 * }}
 */
export function mountSidebar(container, options = {}) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('mountSidebar: container must be an HTMLElement');
  }

  const apiClient = options.apiClient ?? defaultApi;
  const onTokenSelect = typeof options.onTokenSelect === 'function' ? options.onTokenSelect : null;

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
    attrs: { type: 'search', placeholder: 'Поиск...', 'aria-label': 'Поиск токенов' },
  });
  const roleSelect = el('select', {
    className: 'pt-sidebar__role',
    dataset: { testId: 'sidebar-role' },
    attrs: { 'aria-label': 'Фильтр по роли' },
  });
  for (const r of ROLES) {
    const opt = el('option', { text: ROLE_LABEL[r] });
    opt.value = r;
    roleSelect.appendChild(opt);
  }
  const periodSelect = el('select', {
    className: 'pt-sidebar__period',
    dataset: { testId: 'sidebar-period' },
    attrs: { 'aria-label': 'Период изменения цены' },
  });
  for (const p of PERIODS) {
    const opt = el('option', { text: p });
    opt.value = p;
    periodSelect.appendChild(opt);
  }
  filters.appendChild(search);
  filters.appendChild(roleSelect);
  filters.appendChild(periodSelect);

  // List
  const list = el('ul', {
    className: 'pt-sidebar__list',
    dataset: { testId: 'sidebar-list' },
    attrs: { role: 'listbox', 'aria-label': 'Список токенов' },
  });

  // Empty state placeholder (sibling, hidden by default)
  const empty = el('div', {
    className: 'pt-sidebar__empty',
    dataset: { testId: 'sidebar-empty' },
    text: 'Нет токенов',
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
    roleSelect.hidden = state.tab !== 'players';
  }

  function applyTabAria() {
    for (const tab of TABS) {
      tabButtons[tab].setAttribute('aria-selected', tab === state.tab ? 'true' : 'false');
    }
  }

  function render() {
    applyTabAria();
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

      const symbol = el('div', { className: 'symbol', text: token.symbol || '' });
      const metaParts = [];
      if (state.tab === 'players') {
        // Show country symbol + role for player rows. countryAddress is not
        // directly shown — only the country symbol if exposed via `country`.
        if (token.country) metaParts.push(token.country);
        if (token.role) metaParts.push(token.role);
      }
      const meta = el('div', { className: 'meta', text: metaParts.join(' · ') });

      const price = el('div', {
        className: 'price',
        text: `${formatPrice(token.pricePitch)} PITCH`,
      });

      const changeValue = pctOf(token, state.period);
      const change = el('div', {
        className: `change ${changeValue >= 0 ? 'positive' : 'negative'}`,
        text: formatChange(token.changePct?.[state.period]),
      });

      li.appendChild(symbol);
      li.appendChild(meta);
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
    if (onTokenSelect) onTokenSelect(token);
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
    const target = ev.target instanceof Element
      ? ev.target.closest('[data-tab]')
      : null;
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
      roleSelect.value = 'all';
    }
    state.focusedIndex = 0;
    render();
  }

  function onSearchInput() {
    state.search = search.value || '';
    render();
  }

  function onRoleChange() {
    state.role = roleSelect.value || 'all';
    render();
  }

  function onPeriodChange() {
    state.period = periodSelect.value || 'all';
    render();
  }

  tabs.addEventListener('click', onTabClick);
  search.addEventListener('input', onSearchInput);
  roleSelect.addEventListener('change', onRoleChange);
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
    roleSelect.removeEventListener('change', onRoleChange);
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

  return { refresh, update, destroy };
}
