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

  it('renders soft-lock when not premium', () => {
    const c = makeContainer();
    mountOrdersTab(c, { apiClient: makeApi(), token: TOKEN, softLock: { openPayModal: vi.fn() } });
    expect(c.querySelector('[data-test-id="soft-lock"]')).toBeTruthy();
    expect(c.querySelector('[data-test-id="orders-table"]')).toBeFalsy();
  });

  it('does not fetch when not premium', async () => {
    const c = makeContainer();
    const api = makeApi();
    mountOrdersTab(c, { apiClient: api, token: TOKEN, softLock: { openPayModal: vi.fn() } });
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

  it('auto-fetches when access flips from free to premium', async () => {
    accessStore.set('free');
    const c = makeContainer();
    const api = makeApi({ items: [makeOrder()] });
    mountOrdersTab(c, { apiClient: api, token: TOKEN, softLock: { openPayModal: vi.fn() } });
    await flush();
    expect(api.getOrders).not.toHaveBeenCalled();

    accessStore.set('premium');
    await flush();
    expect(api.getOrders).toHaveBeenCalledTimes(1);
    expect(c.querySelector('[data-test-id="orders-table"]')).toBeTruthy();
  });

  it('destroy() tears down lock and stops ticker', () => {
    const c = makeContainer();
    const handle = mountOrdersTab(c, {
      apiClient: makeApi(),
      token: TOKEN,
      softLock: { openPayModal: vi.fn() },
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
});
