// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountSidebar } from '../src/sidebar.js';

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

    const captainBtn = container.querySelector('[data-test-id="sidebar-role-captain"]');
    captainBtn.click();

    const rows = container.querySelectorAll('[data-test-id="sidebar-row"]');
    expect(rows.length).toBe(1);
    expect(rows[0].dataset.tokenAddress).toBe('0xaaa1');
  });

  it('role filter group renders 4 buttons (all/best/captain/rookie)', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();

    const group = container.querySelector('[data-test-id="sidebar-role"]');
    expect(group).not.toBeNull();
    expect(group.getAttribute('role')).toBe('group');
    const buttons = group.querySelectorAll('button[data-role]');
    expect(buttons.length).toBe(4);
    const roles = Array.from(buttons).map((b) => b.dataset.role);
    expect(roles).toEqual(['all', 'best', 'captain', 'rookie']);
    for (const r of ['all', 'best', 'captain', 'rookie']) {
      expect(
        container.querySelector(`[data-test-id="sidebar-role-${r}"]`),
      ).not.toBeNull();
    }
  });

  it('default role is "all" — sidebar-role-all carries aria-pressed="true"', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();

    const all = container.querySelector('[data-test-id="sidebar-role-all"]');
    const best = container.querySelector('[data-test-id="sidebar-role-best"]');
    expect(all.getAttribute('aria-pressed')).toBe('true');
    expect(best.getAttribute('aria-pressed')).toBe('false');
  });

  it('clicking sidebar-role-best filters list to "best" players', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();

    const bestBtn = container.querySelector('[data-test-id="sidebar-role-best"]');
    bestBtn.click();

    expect(bestBtn.getAttribute('aria-pressed')).toBe('true');
    const rows = container.querySelectorAll('[data-test-id="sidebar-row"]');
    // Only Mbappé has role="best".
    expect(rows.length).toBe(1);
    expect(rows[0].dataset.tokenAddress).toBe('0xaaa2');
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

  it('player tab rows render a flag <img> resolved via countryAddress (batch 9 fix)', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();
    // Players resolve their flag via countryAddress → countries table (not
    // via the free-form `country` field which carries "France" / "England"
    // strings hasFlag() can't map). Fixture sort: Mbappé (+20%) → Pulisic
    // (+5%) → Smith (-10%). Mbappé (0xccc2 → FRA) + Pulisic (0xccc1 → USA)
    // both resolve; Smith (0xccc3) has no matching country in fixture so
    // the fallback "England" name fails hasFlag and renders no flag.
    const flags = container.querySelectorAll('[data-test-id="sidebar-flag"]');
    expect(flags.length).toBe(2);
    expect(flags[0].getAttribute('src')).toBe('/flags/fr.svg');
    expect(flags[1].getAttribute('src')).toBe('/flags/us.svg');
  });

  it('player row price-cell shows priceCountry + country ticker (not PITCH)', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();

    const rows = container.querySelectorAll('[data-test-id="sidebar-row"]');
    // Mbappé sorted first: priceCountry=2.0, countryAddress=0xccc2 → "FRA".
    expect(rows[0].querySelector('.price').textContent).toBe('2.00 FRA');
    // Pulisic: priceCountry=1.5, countryAddress=0xccc1 → "USA".
    expect(rows[1].querySelector('.price').textContent).toBe('1.50 USA');
    // No row should display PITCH suffix in the players tab.
    for (const row of rows) {
      expect(row.querySelector('.price').textContent).not.toContain('PITCH');
    }
  });

  it('country row price-cell still shows pricePitch + PITCH', async () => {
    const api = makeApi(defaultPayload());
    const handle = mountSidebar(container, { apiClient: api });
    await handle.refresh();
    container.querySelector('[data-test-id="sidebar-tab-countries"]').click();

    const rows = container.querySelectorAll('[data-test-id="sidebar-row"]');
    // FRA pricePitch=0.01 sorted first; USA pricePitch=0.002 second.
    expect(rows[0].querySelector('.price').textContent).toContain('PITCH');
    expect(rows[0].querySelector('.price').textContent).toContain('0.01');
    expect(rows[1].querySelector('.price').textContent).toContain('PITCH');
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

    // Push a fresh set with mutated price for Mbappé. Bumping `pricePitch`
    // keeps her in the first DESC slot, and `priceCountry` (now the displayed
    // unit on player rows) carries the assertion-friendly value.
    const updated = defaultPayload();
    updated.players[1].pricePitch = 99.99;
    updated.players[1].priceCountry = 99.99;
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

  // ── Phase 1.5 batch 3: sparkline + position marker ─────────────────────
  describe('batch 3 — sparkline + position marker', () => {
    it('omits sparkline + pos-marker when no providers are passed (backward compat)', async () => {
      const api = makeApi(defaultPayload());
      const handle = mountSidebar(container, { apiClient: api });
      await handle.refresh();

      // Empty spark cell rendered for layout stability — but contains no SVG.
      const cells = container.querySelectorAll('[data-test-id="sidebar-spark-cell"]');
      expect(cells.length).toBe(3);
      for (const c of cells) {
        expect(c.querySelector('svg')).toBeNull();
      }
      // No position markers either.
      expect(container.querySelector('[data-test-id="sidebar-pos-marker"]')).toBeNull();
    });

    it('renders sparkline SVG only for tokens that return a non-empty series', async () => {
      const api = makeApi(defaultPayload());
      const handle = mountSidebar(container, {
        apiClient: api,
        // Mbappé has the highest pricePitch → first row. Only it gets a series.
        getSparkline: (addr) => (addr === '0xaaa2' ? [1, 2, 3, 4, 5] : null),
      });
      await handle.refresh();

      const rows = container.querySelectorAll('[data-test-id="sidebar-row"]');
      expect(rows.length).toBe(3);
      // First row (Mbappé) → sparkline present, positive trend.
      const firstSpark = rows[0].querySelector('svg.pt-spark');
      expect(firstSpark).not.toBeNull();
      expect(firstSpark.classList.contains('pt-spark--positive')).toBe(true);
      // Other rows → empty cells, no svg.
      expect(rows[1].querySelector('svg.pt-spark')).toBeNull();
      expect(rows[2].querySelector('svg.pt-spark')).toBeNull();
    });

    it('providers receive the token address as their sole argument', async () => {
      const api = makeApi(defaultPayload());
      const sparkCalls = [];
      const posCalls = [];
      const handle = mountSidebar(container, {
        apiClient: api,
        getSparkline: (addr) => {
          sparkCalls.push(addr);
          return null;
        },
        getPosition: (addr) => {
          posCalls.push(addr);
          return null;
        },
      });
      await handle.refresh();

      // 3 player rows → each provider called for every render of those rows.
      // (Initial empty render fires no calls; refresh() triggers a populated
      // render. Re-renders or rebounded async cycles may add more calls — we
      // only care that providers were invoked with the right unique addrs.)
      expect([...new Set(sparkCalls)].sort()).toEqual(['0xaaa1', '0xaaa2', '0xaaa3']);
      expect([...new Set(posCalls)].sort()).toEqual(['0xaaa1', '0xaaa2', '0xaaa3']);
    });

    it('rerender() picks up provider changes without re-fetching tokens', async () => {
      const api = makeApi(defaultPayload());
      // Mutable closure — main.js mimics this exact pattern by writing into
      // its priceSeries Map between SSE ticks.
      const series = new Map();
      const handle = mountSidebar(container, {
        apiClient: api,
        getSparkline: (addr) => series.get(addr) ?? null,
      });
      await handle.refresh();
      api.getTokens.mockClear();

      // Before: no series → no svg on the top row.
      let firstRow = container.querySelector('[data-test-id="sidebar-row"]');
      expect(firstRow.querySelector('svg.pt-spark')).toBeNull();

      // After provider data arrives → rerender() reflects it without /tokens.
      series.set('0xaaa2', [1, 2, 3, 4]);
      handle.rerender();
      firstRow = container.querySelector('[data-test-id="sidebar-row"]');
      expect(firstRow.querySelector('svg.pt-spark')).not.toBeNull();
      expect(api.getTokens).not.toHaveBeenCalled();
    });

    it('renders position marker only for tokens with non-zero balance', async () => {
      const api = makeApi(defaultPayload());
      const handle = mountSidebar(container, {
        apiClient: api,
        getPosition: (addr) => {
          if (addr === '0xaaa2') return { balance: 42.5 };
          if (addr === '0xaaa1') return { balance: 0 };
          if (addr === '0xaaa3') return { hasPosition: true };
          return null;
        },
      });
      await handle.refresh();

      const markers = container.querySelectorAll('[data-test-id="sidebar-pos-marker"]');
      // Two rows are owned: Mbappé (balance>0) + Smith (hasPosition=true).
      // Pulisic has balance=0 → no dot.
      expect(markers.length).toBe(2);

      const rows = container.querySelectorAll('[data-test-id="sidebar-row"]');
      // First row Mbappé — dot present.
      expect(rows[0].querySelector('[data-test-id="sidebar-pos-marker"]')).not.toBeNull();
      // Pulisic (0xaaa1, pricePitch=12.34, second in DESC order) — no dot.
      expect(rows[1].dataset.tokenAddress).toBe('0xaaa1');
      expect(rows[1].querySelector('[data-test-id="sidebar-pos-marker"]')).toBeNull();
      // Smith (0xaaa3, lowest price, third) — dot present.
      expect(rows[2].dataset.tokenAddress).toBe('0xaaa3');
      expect(rows[2].querySelector('[data-test-id="sidebar-pos-marker"]')).not.toBeNull();
    });
  });
});
