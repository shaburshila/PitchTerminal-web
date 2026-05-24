// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountSidebar } from '../src/sidebar.js';
import { _resetForTests as resetWatchlist, WATCHLIST_LIMIT } from '../src/watchlist.js';

// ── Test fixtures ────────────────────────────────────────────────────────
//
// Sample players + countries shaped per docs/api-spec.md §4.1.

function makePlayers() {
  return [
    {
      address: '0xaaa1',
      name: 'Pulisic',
      symbol: 'PULISIC',
      country: 'USA',
      countryAddress: '0xccc1',
      role: 'captain',
      pricePitch: 12.34,
      priceCountry: 1.5,
      supply: '1000000',
      tradesCount: 100,
      holdersCount: 10,
      changePct: { all: 5, '1d': -2, '12h': 1, '6h': 0.5, '1h': 0.1, '15m': 0 },
    },
    {
      address: '0xaaa2',
      name: 'Mbappé',
      symbol: 'MBAPPE',
      country: 'France',
      countryAddress: '0xccc2',
      role: 'best',
      pricePitch: 30.0,
      priceCountry: 2.0,
      supply: '1000000',
      tradesCount: 500,
      holdersCount: 80,
      changePct: { all: 20, '1d': 10, '12h': 5, '6h': 2, '1h': 1, '15m': 0.5 },
    },
    {
      address: '0xaaa3',
      name: 'Smith',
      symbol: 'SMITH',
      country: 'England',
      countryAddress: '0xccc3',
      role: 'rookie',
      pricePitch: 0.5,
      priceCountry: 0.05,
      supply: '500000',
      tradesCount: 5,
      holdersCount: 2,
      changePct: { all: -10, '1d': -5, '12h': -1, '6h': 0, '1h': 0, '15m': 0 },
    },
  ];
}

function makeCountries() {
  return [
    {
      address: '0xccc1',
      name: 'USA',
      symbol: 'USA',
      pricePitch: 0.002,
      supply: '500000',
      tradesCount: 50,
      holdersCount: 5,
      changePct: { all: 1, '1d': 0.5, '12h': 0, '6h': 0, '1h': 0, '15m': 0 },
    },
    {
      address: '0xccc2',
      name: 'France',
      symbol: 'FRA',
      pricePitch: 0.01,
      supply: '500000',
      tradesCount: 200,
      holdersCount: 30,
      changePct: { all: 8, '1d': 2, '12h': 1, '6h': 0, '1h': 0, '15m': 0 },
    },
  ];
}

function makeApi(payload) {
  return {
    getTokens: vi.fn().mockResolvedValue(payload),
  };
}

function defaultPayload() {
  return {
    players: makePlayers(),
    countries: makeCountries(),
    lastUpdate: 1709000000,
    stale: false,
  };
}

// Wait for the initial async refresh() (kicked off inside mountSidebar) to
// resolve. Using `await Promise.resolve()` twice flushes microtasks.
async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('mountSidebar', () => {
  let container;

  beforeEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    resetWatchlist();
    container = document.createElement('aside');
    container.dataset.testId = 'sidebar';
    document.body.appendChild(container);
  });

  it('builds DOM skeleton with tablist, filters and list', () => {
    const api = makeApi(defaultPayload());
    mountSidebar(container, { apiClient: api });

    expect(container.querySelector('[data-test-id="sidebar-tabs"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="sidebar-tab-players"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="sidebar-tab-countries"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="sidebar-search"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="sidebar-role"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="sidebar-period"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="sidebar-list"]')).not.toBeNull();

    const tabs = container.querySelector('[data-test-id="sidebar-tabs"]');
    expect(tabs.getAttribute('role')).toBe('tablist');
  });

  it('throws when container is not an HTMLElement', () => {
    expect(() => mountSidebar(null)).toThrow(TypeError);
    expect(() => mountSidebar({})).toThrow(TypeError);
  });

  it('default tab is Players (aria-selected=true)', () => {
    const api = makeApi(defaultPayload());
    mountSidebar(container, { apiClient: api });
    const playersTab = container.querySelector('[data-test-id="sidebar-tab-players"]');
    const countriesTab = container.querySelector('[data-test-id="sidebar-tab-countries"]');
    expect(playersTab.getAttribute('aria-selected')).toBe('true');
    expect(countriesTab.getAttribute('aria-selected')).toBe('false');
  });

  it('renders 3 player rows initially after refresh', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();
    const rows = container.querySelectorAll('[data-test-id="sidebar-row"]');
    expect(rows.length).toBe(3);
  });

  it('switching to Countries tab renders 2 country rows and hides role filter', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();

    const countriesTab = container.querySelector('[data-test-id="sidebar-tab-countries"]');
    countriesTab.click();

    expect(countriesTab.getAttribute('aria-selected')).toBe('true');
    const rows = container.querySelectorAll('[data-test-id="sidebar-row"]');
    expect(rows.length).toBe(2);

    const roleSelect = container.querySelector('[data-test-id="sidebar-role"]');
    expect(roleSelect.hidden).toBe(true);
  });

  it('search filters by symbol / name (case-insensitive)', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();

    const search = container.querySelector('[data-test-id="sidebar-search"]');
    search.value = 'pul';
    search.dispatchEvent(new Event('input'));

    const rows = container.querySelectorAll('[data-test-id="sidebar-row"]');
    expect(rows.length).toBe(1);
    expect(rows[0].dataset.tokenAddress).toBe('0xaaa1');
  });

  it('role filter "captain" leaves only captains', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();

    const roleSelect = container.querySelector('[data-test-id="sidebar-role"]');
    roleSelect.value = 'captain';
    roleSelect.dispatchEvent(new Event('change'));

    const rows = container.querySelectorAll('[data-test-id="sidebar-row"]');
    expect(rows.length).toBe(1);
    expect(rows[0].dataset.tokenAddress).toBe('0xaaa1');
  });

  it('period selector changes which changePct is shown in rows', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();

    // Default period is 'all'. Mbappé.all = 20 → first in DESC sort.
    let firstRow = container.querySelector('[data-test-id="sidebar-row"]');
    expect(firstRow.querySelector('.change').textContent).toContain('20');

    const periodSelect = container.querySelector('[data-test-id="sidebar-period"]');
    periodSelect.value = '1d';
    periodSelect.dispatchEvent(new Event('change'));

    // Mbappé.1d = 10 → still first.
    firstRow = container.querySelector('[data-test-id="sidebar-row"]');
    expect(firstRow.querySelector('.change').textContent).toContain('10');
  });

  it('players are sorted by pricePitch DESC (known-issue #7)', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();

    const rows = container.querySelectorAll('[data-test-id="sidebar-row"]');
    // pricePitch: Mbappé 30 > Pulisic 12.34 > Smith 0.5.
    expect(rows[0].dataset.tokenAddress).toBe('0xaaa2');
    expect(rows[1].dataset.tokenAddress).toBe('0xaaa1');
    expect(rows[2].dataset.tokenAddress).toBe('0xaaa3');
  });

  it('countries are sorted by pricePitch DESC', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();

    container.querySelector('[data-test-id="sidebar-tab-countries"]').click();

    const rows = container.querySelectorAll('[data-test-id="sidebar-row"]');
    // FRA 0.01 > USA 0.002
    expect(rows[0].dataset.tokenAddress).toBe('0xccc2');
    expect(rows[1].dataset.tokenAddress).toBe('0xccc1');
  });

  it('players sort is stable on pricePitch tie — uses address ASC tiebreaker', async () => {
    // Known-issue #7 caveat: during worker backfill every token may have
    // pricePitch=0 (or duplicates). Order must still be deterministic so the
    // list doesn't shuffle between renders.
    const payload = {
      players: [
        { ...makePlayers()[0], address: '0xbbb', pricePitch: 0 },
        { ...makePlayers()[1], address: '0xaaa', pricePitch: 0 },
        { ...makePlayers()[2], address: '0xccc', pricePitch: 0 },
      ],
      countries: [],
      lastUpdate: 0,
      stale: true,
    };
    const api = makeApi(payload);
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();

    const rows = container.querySelectorAll('[data-test-id="sidebar-row"]');
    expect(rows[0].dataset.tokenAddress).toBe('0xaaa');
    expect(rows[1].dataset.tokenAddress).toBe('0xbbb');
    expect(rows[2].dataset.tokenAddress).toBe('0xccc');
  });

  it('non-numeric/missing pricePitch is treated as 0 in sort', async () => {
    // Strip pricePitch off the third row so the field is undefined, not 0.5.
    const third = { ...makePlayers()[2], address: '0xc' };
    delete third.pricePitch;
    const payload = {
      players: [
        { ...makePlayers()[0], address: '0xa', pricePitch: 5 },
        { ...makePlayers()[1], address: '0xb', pricePitch: null },
        third,
      ],
      countries: [],
      lastUpdate: 0,
      stale: true,
    };
    const api = makeApi(payload);
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();

    const rows = container.querySelectorAll('[data-test-id="sidebar-row"]');
    // 5 first; then 0xb and 0xc tied at 0 → address ASC.
    expect(rows[0].dataset.tokenAddress).toBe('0xa');
    expect(rows[1].dataset.tokenAddress).toBe('0xb');
    expect(rows[2].dataset.tokenAddress).toBe('0xc');
  });

  it('clicking a row fires onTokenSelect with the full token object', async () => {
    const api = makeApi(defaultPayload());
    const onTokenSelect = vi.fn();
    const handle = mountSidebar(container, { apiClient: api, onTokenSelect });
    await handle.refresh();

    const firstRow = container.querySelector('[data-test-id="sidebar-row"]');
    firstRow.click();

    expect(onTokenSelect).toHaveBeenCalledTimes(1);
    const arg = onTokenSelect.mock.calls[0][0];
    expect(arg.address).toBe('0xaaa2'); // Mbappé sorted first
    expect(arg.symbol).toBe('MBAPPE');
    expect(arg.role).toBe('best');
  });

  // F1.4 — sidebar threads `countrySymbol` so the trade panel doesn't need
  // its own getTokens() lookup.
  it('player onTokenSelect payload includes countrySymbol from the country table', async () => {
    const api = makeApi(defaultPayload());
    const onTokenSelect = vi.fn();
    const handle = mountSidebar(container, { apiClient: api, onTokenSelect });
    await handle.refresh();

    const firstRow = container.querySelector('[data-test-id="sidebar-row"]');
    firstRow.click();
    const arg = onTokenSelect.mock.calls[0][0];
    // Mbappé's countryAddress = 0xccc2 → countries[].symbol = 'FRA'.
    expect(arg.countrySymbol).toBe('FRA');
  });

  it('falls back to player.country when countries table is missing the address', async () => {
    const payload = defaultPayload();
    payload.countries = []; // strip the table
    const api = makeApi(payload);
    const onTokenSelect = vi.fn();
    const handle = mountSidebar(container, { apiClient: api, onTokenSelect });
    await handle.refresh();

    const firstRow = container.querySelector('[data-test-id="sidebar-row"]');
    firstRow.click();
    const arg = onTokenSelect.mock.calls[0][0];
    // Mbappé's country = 'France' — used as fallback.
    expect(arg.countrySymbol).toBe('France');
  });

  it('country-tab rows pass through unchanged (no countrySymbol injected)', async () => {
    const api = makeApi(defaultPayload());
    const onTokenSelect = vi.fn();
    const handle = mountSidebar(container, { apiClient: api, onTokenSelect });
    await handle.refresh();
    // Switch to countries tab.
    container.querySelector('[data-test-id="sidebar-tab-countries"]').click();

    const firstRow = container.querySelector('[data-test-id="sidebar-row"]');
    firstRow.click();
    const arg = onTokenSelect.mock.calls[0][0];
    expect(arg.countryAddress).toBeUndefined();
    expect(arg.countrySymbol).toBeUndefined();
  });

  it('clicked row gets aria-selected="true"', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();

    const firstRow = container.querySelector('[data-test-id="sidebar-row"]');
    firstRow.click();
    expect(firstRow.getAttribute('aria-selected')).toBe('true');
  });

  it('country tab rows render a flag <img> for known symbols (phase 1.5)', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();
    const countriesTab = container.querySelector('[data-test-id="sidebar-tab-countries"]');
    countriesTab.click();

    const flags = container.querySelectorAll('[data-test-id="sidebar-flag"]');
    expect(flags.length).toBe(2);
    // FRA sorts first (higher pricePitch), then USA.
    expect(flags[0].getAttribute('src')).toBe('/flags/fr.svg');
    expect(flags[1].getAttribute('src')).toBe('/flags/us.svg');
    // Alt is intentionally empty + aria-hidden — the adjacent text node
    // already carries the symbol for screen readers.
    expect(flags[0].getAttribute('alt')).toBe('');
    expect(flags[0].getAttribute('aria-hidden')).toBe('true');
  });

  it('player tab rows render a flag <img> for mapped country field', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();
    // Fixture players have country "USA" (mapped), "France" (full-word, not in
    // the ticker map), "England" (also full-word). Only Pulisic gets a flag.
    const flags = container.querySelectorAll('[data-test-id="sidebar-flag"]');
    expect(flags.length).toBe(1);
    expect(flags[0].getAttribute('src')).toBe('/flags/us.svg');
  });

  it('change cell has positive/negative class', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();

    const rows = container.querySelectorAll('[data-test-id="sidebar-row"]');
    // Mbappé (sorted first) all=20 → positive
    expect(rows[0].querySelector('.change').classList.contains('positive')).toBe(true);
    // Smith (last) all=-10 → negative
    expect(rows[2].querySelector('.change').classList.contains('negative')).toBe(true);
  });

  it('refresh() re-invokes the API', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await flushAsync(); // initial auto-refresh
    expect(api.getTokens).toHaveBeenCalledTimes(1);

    await handle.refresh();
    expect(api.getTokens).toHaveBeenCalledTimes(2);
  });

  it('update(tokens) re-renders without calling the API', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();
    api.getTokens.mockClear();

    // Push a fresh set with mutated price for Mbappé.
    const updated = defaultPayload();
    updated.players[1].pricePitch = 99.99;
    handle.update(updated);

    const firstRow = container.querySelector('[data-test-id="sidebar-row"]');
    expect(firstRow.querySelector('.price').textContent).toContain('99');
    expect(api.getTokens).not.toHaveBeenCalled();
  });

  it('update() is a no-op when given invalid input', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();
    const before = container.querySelectorAll('[data-test-id="sidebar-row"]').length;
    handle.update(null);
    handle.update(undefined);
    handle.update('nope');
    const after = container.querySelectorAll('[data-test-id="sidebar-row"]').length;
    expect(after).toBe(before);
  });

  it('empty state is shown when no rows match', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();

    const search = container.querySelector('[data-test-id="sidebar-search"]');
    search.value = 'nothing-matches-this';
    search.dispatchEvent(new Event('input'));

    expect(container.querySelectorAll('[data-test-id="sidebar-row"]').length).toBe(0);
    const empty = container.querySelector('[data-test-id="sidebar-empty"]');
    expect(empty.hidden).toBe(false);
  });

  it('destroy() clears the DOM', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();
    handle.destroy();
    expect(container.children.length).toBe(0);
  });

  it('is idempotent — second mount on same container replaces the first', async () => {
    const api1 = makeApi(defaultPayload());
    mountSidebar(container, { apiClient: api1 });
    container.dataset.marker = 'first';

    const api2 = makeApi(defaultPayload());
    mountSidebar(container, { apiClient: api2 });
    // Only one tablist / one list — no duplicates.
    expect(container.querySelectorAll('[data-test-id="sidebar-tabs"]').length).toBe(1);
    expect(container.querySelectorAll('[data-test-id="sidebar-list"]').length).toBe(1);
  });

  it('initial auto-refresh failure leaves empty state without throwing', async () => {
    const api = {
      getTokens: vi.fn().mockRejectedValue(new Error('boom')),
    };
    expect(() => mountSidebar(container, { apiClient: api })).not.toThrow();
    await flushAsync();
    const empty = container.querySelector('[data-test-id="sidebar-empty"]');
    expect(empty.hidden).toBe(false);
  });

  // ── F0.8 watchlist integration ──────────────────────────────────────────

  it('renders a star button on every row (empty/off state)', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();
    const stars = container.querySelectorAll('[data-test-id="sidebar-star"]');
    expect(stars.length).toBe(3);
    expect(stars[0].getAttribute('aria-pressed')).toBe('false');
    expect(stars[0].textContent).toBe('☆');
  });

  it('clicking a star toggles the row into the watchlist without selecting it', async () => {
    const api = makeApi(defaultPayload());
    const onTokenSelect = vi.fn();
    const handle = mountSidebar(container, { apiClient: api, onTokenSelect });
    await handle.refresh();

    const star = container.querySelector('[data-test-id="sidebar-star"]');
    star.click();
    expect(onTokenSelect).not.toHaveBeenCalled();

    // After re-render the star reflects watched state.
    const refreshed = container.querySelector('[data-test-id="sidebar-star"]');
    expect(refreshed.textContent).toBe('★');
    expect(refreshed.getAttribute('aria-pressed')).toBe('true');
  });

  it('"only favorites" toggle filters list to watched rows', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();

    // Star Pulisic (sorted at index 1: Mbappé first).
    const rows = container.querySelectorAll('[data-test-id="sidebar-row"]');
    // Mbappé is rows[0], Pulisic rows[1] (sorted by pricePitch DESC).
    rows[1].querySelector('[data-test-id="sidebar-star"]').click();

    const favBtn = container.querySelector('[data-test-id="sidebar-fav-toggle"]');
    favBtn.click();

    const visible = container.querySelectorAll('[data-test-id="sidebar-row"]');
    expect(visible.length).toBe(1);
    expect(visible[0].dataset.tokenAddress).toBe('0xaaa1');
    expect(favBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('overflow add (> WATCHLIST_LIMIT) shows a toast and does not enlarge list', async () => {
    // Pre-fill localStorage to the cap.
    const tokens = [];
    for (let i = 0; i < WATCHLIST_LIMIT; i++) {
      tokens.push('0x' + i.toString(16).padStart(40, '0'));
    }
    localStorage.setItem('pt:watchlist', JSON.stringify({ tokens }));
    resetWatchlist();

    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();

    // The 3 sample tokens aren't in the prefilled list — starring one should
    // be rejected.
    const star = container.querySelector('[data-test-id="sidebar-star"]');
    star.click();

    const toast = document.querySelector('[data-test-id="toast"]');
    expect(toast).not.toBeNull();
    expect(toast.dataset.kind).toBe('warn');
    expect(toast.textContent).toMatch(/full/i);

    // Star did NOT flip on.
    const after = container.querySelector('[data-test-id="sidebar-star"]');
    expect(after.textContent).toBe('☆');
  });
});
