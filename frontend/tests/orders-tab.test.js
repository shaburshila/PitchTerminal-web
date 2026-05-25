// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { mountOrdersTab } from '../src/orders-tab.js';
import * as accessStore from '../src/access-store.js';

const TOKEN = '0xaaa1';

function makeOrder(overrides = {}) {
  return {
    id: '1234',
    owner: '0x1111111111111111111111111111111111111111',
    token: TOKEN,
    quoteToken: '0xeae13ea73bec936664a51734c8c01ec7c3b0699c',
    tokenSymbol: 'PLR',
    tokenKind: 'player',
    venue: 'player',
    side: 'limit-buy',
    targetPrice: '1234500000000000000', // 1.2345
    amountIn: '1000000000000000000', // 1.0
    slippageBps: 100,
    expiresAt: 0,
    nonce: '0xabc',
    status: 'pending',
    createdAt: 1709000000,
    executedTxHash: null,
    failReason: null,
    failDetail: null,
    ...overrides,
  };
}

function makeApi({ items = [], armed = true, cancel, setArmed } = {}) {
  return {
    getOrders: vi.fn(async () => ({ items, armed, nextCursor: null, limit: 100 })),
    cancelOrder: vi.fn(cancel ?? (async () => null)),
    setArmed: vi.fn(setArmed ?? (async (a) => ({ armed: a }))),
  };
}

async function flush(n = 4) {
  for (let i = 0; i < n; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

function makeContainer() {
  const c = document.createElement('div');
  document.body.appendChild(c);
  return c;
}

beforeEach(() => {
  accessStore._resetForTests();
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('mountOrdersTab', () => {
  it('throws on bad container', () => {
    expect(() => mountOrdersTab(null)).toThrow(TypeError);
  });

  it('renders compact locked placeholder when not premium (no soft-lock overlay)', () => {
    const c = makeContainer();
    mountOrdersTab(c, { apiClient: makeApi(), token: TOKEN });
    // Lock affordance now lives on the bottom-tab BUTTON. The pane just shows
    // a compact "Premium feature" placeholder — no gold cover, no skeleton.
    expect(c.querySelector('[data-test-id="orders-locked"]')).toBeTruthy();
    expect(c.querySelector('[data-test-id="soft-lock"]')).toBeFalsy();
    expect(c.querySelector('[data-test-id="orders-table"]')).toBeFalsy();
  });

  it('does not fetch when not premium', async () => {
    const c = makeContainer();
    const api = makeApi();
    mountOrdersTab(c, { apiClient: api, token: TOKEN });
    await flush();
    expect(api.getOrders).not.toHaveBeenCalled();
  });

  it('shows no-token placeholder for premium without token', () => {
    accessStore.set('premium');
    const c = makeContainer();
    mountOrdersTab(c, { apiClient: makeApi(), token: null });
    expect(c.querySelector('[data-test-id="orders-no-token"]')).toBeTruthy();
  });

  it('fetches and renders orders table for premium + token', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const api = makeApi({ items: [makeOrder(), makeOrder({ id: '5678', status: 'filled' })] });
    mountOrdersTab(c, { apiClient: api, token: TOKEN });
    await flush();
    expect(api.getOrders).toHaveBeenCalledWith({ token: TOKEN });
    const rows = c.querySelectorAll('[data-test-id="order-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0].dataset.status).toBe('pending');
    expect(rows[1].dataset.status).toBe('filled');
  });

  it('shows phase-2 stub on 404 from backend', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const api = {
      getOrders: vi.fn(async () => {
        const err = new Error('Not found');
        err.status = 404;
        throw err;
      }),
      cancelOrder: vi.fn(),
      setArmed: vi.fn(),
    };
    mountOrdersTab(c, { apiClient: api, token: TOKEN });
    await flush();
    expect(c.querySelector('[data-test-id="orders-phase2"]')).toBeTruthy();
    expect(c.querySelector('[data-test-id="orders-error"]')).toBeFalsy();
  });

  it('shows phase-2 stub on 501 from backend', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const api = {
      getOrders: vi.fn(async () => {
        const err = new Error('Not implemented');
        err.status = 501;
        throw err;
      }),
      cancelOrder: vi.fn(),
      setArmed: vi.fn(),
    };
    mountOrdersTab(c, { apiClient: api, token: TOKEN });
    await flush();
    expect(c.querySelector('[data-test-id="orders-phase2"]')).toBeTruthy();
  });

  it('shows error for non-404/501 backend failures', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const api = {
      getOrders: vi.fn(async () => {
        const err = new Error('Server down');
        err.status = 500;
        throw err;
      }),
      cancelOrder: vi.fn(),
      setArmed: vi.fn(),
    };
    mountOrdersTab(c, { apiClient: api, token: TOKEN });
    await flush();
    const errEl = c.querySelector('[data-test-id="orders-error"]');
    expect(errEl).toBeTruthy();
    expect(errEl.textContent).toContain('Server down');
  });

  it('renders armed toggle reflecting server-provided state', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    mountOrdersTab(c, {
      apiClient: makeApi({ items: [makeOrder()], armed: false }),
      token: TOKEN,
    });
    await flush();
    const checkbox = c.querySelector('[data-test-id="orders-armed"]');
    expect(checkbox).toBeTruthy();
    expect(checkbox.checked).toBe(false);
  });

  it('cancel button on pending order calls cancelOrder + flips status optimistically', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const api = makeApi({ items: [makeOrder()] });
    const actions = [];
    mountOrdersTab(c, {
      apiClient: api,
      token: TOKEN,
      onActionDone: (action, info) => actions.push([action, info]),
    });
    await flush();
    const cancelBtn = c.querySelector('[data-test-id="orders-cancel"]');
    expect(cancelBtn).toBeTruthy();
    cancelBtn.click();
    await flush();
    expect(api.cancelOrder).toHaveBeenCalledWith('1234');
    const row = c.querySelector('[data-test-id="order-row"]');
    expect(row.dataset.status).toBe('cancelled');
    expect(actions[0][0]).toBe('cancel');
    expect(actions[0][1].ok).toBe(true);
  });

  it('cancel 404 is treated as idempotent success (does NOT flip to phase-2 stub)', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const cancelErr = new Error('Not found');
    cancelErr.status = 404;
    const api = makeApi({
      items: [makeOrder(), makeOrder({ id: '5678', status: 'pending' })],
      cancel: async () => { throw cancelErr; },
    });
    const actions = [];
    const handle = mountOrdersTab(c, {
      apiClient: api,
      token: TOKEN,
      onActionDone: (action, info) => actions.push([action, info]),
    });
    await flush();

    // Sanity: list rendered, no phase-2 stub.
    expect(c.querySelector('[data-test-id="orders-phase2"]')).toBeFalsy();
    expect(c.querySelectorAll('[data-test-id="order-row"]').length).toBe(2);

    const cancelBtn = c.querySelector('[data-test-id="orders-cancel"]');
    cancelBtn.click();
    await flush();

    // Phase-2 stub MUST NOT appear — that would hide the actual list.
    expect(c.querySelector('[data-test-id="orders-phase2"]')).toBeFalsy();
    // List remains intact, cancelled row marked locally.
    const rows = c.querySelectorAll('[data-test-id="order-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0].dataset.status).toBe('cancelled');
    // Action surfaced as success with idempotent flag.
    expect(actions[0][0]).toBe('cancel');
    expect(actions[0][1].ok).toBe(true);
    expect(actions[0][1].idempotent).toBe(true);
    // No spurious error banner.
    expect(c.querySelector('[data-test-id="orders-error"]')).toBeFalsy();
    expect(handle.getState().phase2).toBe(false);
    expect(handle.getState().error).toBeNull();
  });

  it('cancel 500 surfaces inline error without flipping to phase-2 stub', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const cancelErr = new Error('Server down');
    cancelErr.status = 500;
    const api = makeApi({
      items: [makeOrder()],
      cancel: async () => { throw cancelErr; },
    });
    const handle = mountOrdersTab(c, { apiClient: api, token: TOKEN });
    await flush();
    c.querySelector('[data-test-id="orders-cancel"]').click();
    await flush();
    expect(c.querySelector('[data-test-id="orders-phase2"]')).toBeFalsy();
    expect(handle.getState().phase2).toBe(false);
    expect(handle.getState().error).toMatch(/Server down/);
  });

  it('setArmed 404 surfaces inline error without flipping to phase-2 stub', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const armedErr = new Error('Not found');
    armedErr.status = 404;
    const api = makeApi({
      items: [makeOrder()],
      armed: true,
      setArmed: async () => { throw armedErr; },
    });
    const handle = mountOrdersTab(c, { apiClient: api, token: TOKEN });
    await flush();
    const checkbox = c.querySelector('[data-test-id="orders-armed"]');
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    await flush();
    expect(c.querySelector('[data-test-id="orders-phase2"]')).toBeFalsy();
    expect(handle.getState().phase2).toBe(false);
    expect(handle.getState().error).toBeTruthy();
  });

  it('cancel button is absent for non-pending orders', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    mountOrdersTab(c, {
      apiClient: makeApi({ items: [makeOrder({ status: 'filled' })] }),
      token: TOKEN,
    });
    await flush();
    expect(c.querySelector('[data-test-id="orders-cancel"]')).toBeFalsy();
  });

  it('armed toggle calls setArmed', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const api = makeApi({ items: [], armed: true });
    const actions = [];
    mountOrdersTab(c, {
      apiClient: api,
      token: TOKEN,
      onActionDone: (action, info) => actions.push([action, info]),
    });
    await flush();
    const checkbox = c.querySelector('[data-test-id="orders-armed"]');
    expect(checkbox.checked).toBe(true);
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    await flush();
    expect(api.setArmed).toHaveBeenCalledWith(false);
    expect(actions[0][0]).toBe('armed');
    expect(actions[0][1].armed).toBe(false);

    // Re-fetch the checkbox (table re-rendered after server response)
    const fresh = c.querySelector('[data-test-id="orders-armed"]');
    expect(fresh.checked).toBe(false);
  });

  it('pushOrderUpdate merges incoming SSE payloads', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const handle = mountOrdersTab(c, {
      apiClient: makeApi({ items: [makeOrder()] }),
      token: TOKEN,
    });
    await flush();
    let row = c.querySelector('[data-test-id="order-row"]');
    expect(row.dataset.status).toBe('pending');

    handle.pushOrderUpdate({ order: { id: '1234', status: 'executing' } });
    row = c.querySelector('[data-test-id="order-row"]');
    expect(row.dataset.status).toBe('executing');
  });

  it('pushOrderUpdate prepends new orders not seen before', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const handle = mountOrdersTab(c, {
      apiClient: makeApi({ items: [makeOrder()] }),
      token: TOKEN,
    });
    await flush();
    handle.pushOrderUpdate({ order: makeOrder({ id: '9999', status: 'pending' }) });
    const rows = c.querySelectorAll('[data-test-id="order-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0].dataset.orderId).toBe('9999');
  });

  it('pushOrderUpdate ignores orders for a different token', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const handle = mountOrdersTab(c, {
      apiClient: makeApi({ items: [makeOrder()] }),
      token: TOKEN,
    });
    await flush();
    handle.pushOrderUpdate({ order: makeOrder({ id: '9999', token: '0xbbb2' }) });
    const rows = c.querySelectorAll('[data-test-id="order-row"]');
    expect(rows.length).toBe(1);
  });

  it('TTL cell formats relative time when expiresAt is set', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const now = 1709000000_000; // ms
    mountOrdersTab(c, {
      apiClient: makeApi({ items: [makeOrder({ expiresAt: 1709003600 })] }), // +1h
      token: TOKEN,
      now: () => now,
    });
    await flush();
    const ttl = c.querySelector('[data-test-id="orders-ttl"]');
    expect(ttl.textContent).toMatch(/01:00:00/);
  });

  it('TTL cell renders ∞ for expiresAt=0', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    mountOrdersTab(c, {
      apiClient: makeApi({ items: [makeOrder({ expiresAt: 0 })] }),
      token: TOKEN,
    });
    await flush();
    const ttl = c.querySelector('[data-test-id="orders-ttl"]');
    expect(ttl.textContent).toBe('∞');
  });

  it('setToken refetches', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const api = makeApi({ items: [] });
    const handle = mountOrdersTab(c, { apiClient: api, token: TOKEN });
    await flush();
    expect(api.getOrders).toHaveBeenCalledTimes(1);
    await handle.setToken('0xbbb2');
    expect(api.getOrders).toHaveBeenCalledTimes(2);
    expect(api.getOrders).toHaveBeenLastCalledWith({ token: '0xbbb2' });
  });

  it('setToken with same address but fresh meta literal does not re-fetch', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    const api = makeApi({ items: [] });
    const handle = mountOrdersTab(c, {
      apiClient: api,
      token: TOKEN,
      tokenMeta: { symbol: 'FRA', kind: 'country' },
    });
    await flush();
    expect(api.getOrders).toHaveBeenCalledTimes(1);

    // Same address, different object literal — should NOT trigger refetch.
    await handle.setToken(TOKEN, { symbol: 'FRA', kind: 'country' });
    await flush();
    expect(api.getOrders).toHaveBeenCalledTimes(1);

    await handle.setToken(TOKEN, { symbol: 'FRA', kind: 'country' });
    await flush();
    expect(api.getOrders).toHaveBeenCalledTimes(1);
  });

  it('auto-fetches when access flips from free to premium', async () => {
    accessStore.set('free');
    const c = makeContainer();
    const api = makeApi({ items: [makeOrder()] });
    mountOrdersTab(c, { apiClient: api, token: TOKEN });
    await flush();
    expect(api.getOrders).not.toHaveBeenCalled();

    accessStore.set('premium');
    await flush();
    expect(api.getOrders).toHaveBeenCalledTimes(1);
    expect(c.querySelector('[data-test-id="orders-table"]')).toBeTruthy();
  });

  it('destroy() stops ticker and clears the pane', () => {
    const c = makeContainer();
    const handle = mountOrdersTab(c, {
      apiClient: makeApi(),
      token: TOKEN,
    });
    expect(() => handle.destroy()).not.toThrow();
    expect(c.children.length).toBe(0);
  });

  it('shows empty-state for empty items array', async () => {
    accessStore.set('premium');
    const c = makeContainer();
    mountOrdersTab(c, { apiClient: makeApi({ items: [] }), token: TOKEN });
    await flush();
    expect(c.querySelector('[data-test-id="orders-empty"]')).toBeTruthy();
  });

  // ── Phase 1.5 batch 6 — visual redesign ────────────────────────────────
  describe('Phase 1.5 batch 6 redesign', () => {
    it('renders filter chips with status counts and switches active chip on click', async () => {
      accessStore.set('premium');
      const c = makeContainer();
      const api = makeApi({
        items: [
          makeOrder({ id: '1', status: 'pending' }),
          makeOrder({ id: '2', status: 'pending' }),
          makeOrder({ id: '3', status: 'filled' }),
          makeOrder({ id: '4', status: 'cancelled' }),
        ],
      });
      mountOrdersTab(c, { apiClient: api, token: TOKEN });
      await flush();

      const filters = c.querySelector('[data-test-id="orders-filters"]');
      expect(filters).toBeTruthy();
      // Counts inside the chips. Wave 2A — `pending` rolls into the `open`
      // chip (legacy alias) until backend backfill renames the column.
      const allChip = c.querySelector('[data-test-id="orders-filter-all"]');
      const openChip = c.querySelector('[data-test-id="orders-filter-open"]');
      expect(allChip.textContent).toContain('4');
      expect(openChip.textContent).toContain('2');
      expect(allChip.className).toContain('is-active');
      expect(openChip.className).not.toContain('is-active');

      // Click open → only pending (legacy) rows visible.
      openChip.click();
      const rows = c.querySelectorAll('[data-test-id="order-row"]');
      expect(rows.length).toBe(2);
      for (const r of rows) expect(r.dataset.status).toBe('pending');
      expect(c.querySelector('[data-test-id="orders-filter-open"]').className).toContain(
        'is-active',
      );
    });

    it('side-badge cell renders BUY/SELL and uses side-buy / side-sell class', async () => {
      accessStore.set('premium');
      const c = makeContainer();
      const api = makeApi({
        items: [
          makeOrder({ id: '1', side: 'limit-buy', status: 'pending' }),
          makeOrder({ id: '2', side: 'take-profit', status: 'pending' }),
        ],
      });
      mountOrdersTab(c, { apiClient: api, token: TOKEN });
      await flush();

      const rows = c.querySelectorAll('[data-test-id="order-row"]');
      const side0 = rows[0].querySelector('td.side');
      const side1 = rows[1].querySelector('td.side');
      expect(side0.textContent).toBe('BUY');
      expect(side0.className).toContain('side--buy');
      expect(side1.textContent).toBe('SELL');
      expect(side1.className).toContain('side--sell');
    });

    it('status pill renders with dot + uppercase label inside a colored span', async () => {
      accessStore.set('premium');
      const c = makeContainer();
      const api = makeApi({ items: [makeOrder({ status: 'filled' })] });
      mountOrdersTab(c, { apiClient: api, token: TOKEN });
      await flush();
      const pill = c.querySelector('[data-test-id="orders-status"]');
      expect(pill).toBeTruthy();
      expect(pill.dataset.status).toBe('filled');
      expect(pill.className).toContain('status--filled');
      expect(pill.querySelector('.status-dot')).toBeTruthy();
      expect(pill.textContent).toContain('Filled');
    });

    it('renders flag image when tokenMeta has a country symbol with hasFlag mapping', async () => {
      accessStore.set('premium');
      const c = makeContainer();
      const api = makeApi({ items: [makeOrder()] });
      mountOrdersTab(c, {
        apiClient: api,
        token: TOKEN,
        tokenMeta: { symbol: 'FRA', kind: 'country', name: 'France' },
      });
      await flush();
      const img = c.querySelector('[data-test-id="orders-flag"]');
      expect(img).toBeTruthy();
      expect(img.getAttribute('src')).toBe('/flags/fr.svg');
      // Name renders too.
      expect(c.querySelector('.pt-orders__name').textContent).toContain('France');
    });

    it('illustrated empty-state has data-test-id orders-empty + matches "No orders yet"', async () => {
      accessStore.set('premium');
      const c = makeContainer();
      mountOrdersTab(c, { apiClient: makeApi({ items: [] }), token: TOKEN });
      await flush();
      const panel = c.querySelector('[data-test-id="orders-empty"]');
      expect(panel).toBeTruthy();
      expect(panel.querySelector('.pt-orders__empty-title').textContent).toContain('No orders yet');
      // Filter chips still render above (with all counts = 0) — the toolbar is
      // a persistent part of the redesigned tab. No table or order rows.
      expect(c.querySelector('[data-test-id="orders-table"]')).toBeFalsy();
      expect(c.querySelectorAll('[data-test-id="order-row"]').length).toBe(0);
    });

    it('emits onTabCount when orders load and on access-state transitions', async () => {
      accessStore._resetForTests();
      accessStore.set('premium');
      const c = makeContainer();
      const counts = [];
      const api = makeApi({
        items: [makeOrder({ id: '1' }), makeOrder({ id: '2' })],
      });
      mountOrdersTab(c, {
        apiClient: api,
        token: TOKEN,
        onTabCount: (n) => counts.push(n),
      });
      await flush();
      // Last emitted count after data load should be 2.
      expect(counts[counts.length - 1]).toBe(2);

      accessStore.set('free');
      await flush();
      expect(counts[counts.length - 1]).toBeNull();
    });
  });

  // Wave 2A — Target column shows DISPLAY (MID) value, not signed; status
  // labels render `open` (legacy `pending` rolls into the same label).
  describe('Wave 2A — display target + open status', () => {
    it('renders displayTargetPrice in the Target column when present', async () => {
      accessStore.set('premium');
      const c = makeContainer();
      // 10.0 PITCH display, signed = 10 × 10000 / 9500 ≈ 10.5263
      const api = makeApi({
        items: [
          makeOrder({
            targetPrice: '10526315789473684210',
            displayTargetPrice: '10000000000000000000',
          }),
        ],
      });
      mountOrdersTab(c, { apiClient: api, token: TOKEN });
      await flush();
      const targetCell = c.querySelector('[data-test-id="order-row"] td.num');
      // display = 10 PITCH → renders "10" (trailing zeros stripped).
      expect(targetCell.textContent).toBe('10');
    });

    it('falls back to targetPrice when displayTargetPrice missing (legacy rows)', async () => {
      accessStore.set('premium');
      const c = makeContainer();
      const api = makeApi({ items: [makeOrder({ targetPrice: '1234500000000000000' })] });
      mountOrdersTab(c, { apiClient: api, token: TOKEN });
      await flush();
      const targetCell = c.querySelector('[data-test-id="order-row"] td.num');
      // 1.2345 → "1.2345" after trailing-zero strip.
      expect(targetCell.textContent).toBe('1.2345');
    });

    it('legacy `pending` status renders as "Open" + tooltip', async () => {
      accessStore.set('premium');
      const c = makeContainer();
      const api = makeApi({ items: [makeOrder({ status: 'pending' })] });
      mountOrdersTab(c, { apiClient: api, token: TOKEN });
      await flush();
      const pill = c.querySelector('[data-test-id="orders-status"]');
      expect(pill.textContent).toContain('Open');
      expect(pill.className).toContain('status--open');
      expect(pill.getAttribute('title')).toMatch(/waiting/i);
    });

    it('new `open` status renders the Open label too', async () => {
      accessStore.set('premium');
      const c = makeContainer();
      const api = makeApi({ items: [makeOrder({ status: 'open' })] });
      mountOrdersTab(c, { apiClient: api, token: TOKEN });
      await flush();
      const pill = c.querySelector('[data-test-id="orders-status"]');
      expect(pill.textContent).toContain('Open');
      expect(pill.className).toContain('status--open');
    });

    it('cancel button shows for both `pending` (legacy) and `open` statuses', async () => {
      accessStore.set('premium');
      const c = makeContainer();
      const api = makeApi({
        items: [
          makeOrder({ id: 'a', status: 'pending' }),
          makeOrder({ id: 'b', status: 'open' }),
        ],
      });
      mountOrdersTab(c, { apiClient: api, token: TOKEN });
      await flush();
      const buttons = c.querySelectorAll('[data-test-id="orders-cancel"]');
      expect(buttons.length).toBe(2);
    });
  });
});
