import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  API_BASE,
  ApiError,
  apiFetch,
  cancelOrder,
  createOrder,
  getAccess,
  getAuthNonce,
  getChart,
  getConfig,
  getHealth,
  getOrders,
  getPosition,
  getProfile,
  getTokens,
  getTrades,
  logout,
  paginate,
  setArmed,
  verifySiwe,
} from '../src/api.js';

/**
 * Build a Response-like object for the fetch mock.
 *
 * @param {object} opts
 * @param {number} [opts.status]
 * @param {unknown} [opts.body]
 * @param {string} [opts.contentType]
 */
function makeResponse({ status = 200, body, contentType = 'application/json' } = {}) {
  const headers = new Map([['content-type', contentType]]);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
    json: async () => body,
  };
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('apiFetch — request shape', () => {
  it('always sends credentials: include and Accept: application/json', async () => {
    fetch.mockResolvedValueOnce(makeResponse({ body: { ok: true } }));
    await apiFetch('/anything');

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${API_BASE}/anything`);
    expect(init.credentials).toBe('include');
    expect(init.headers.Accept).toBe('application/json');
  });

  it('merges caller headers with the default Accept header', async () => {
    fetch.mockResolvedValueOnce(makeResponse({ body: null, status: 204 }));
    await apiFetch('/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Custom': 'yes' },
      body: '{}',
    });

    const [, init] = fetch.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['X-Custom']).toBe('yes');
    expect(init.headers.Accept).toBe('application/json');
  });
});

describe('apiFetch — happy path', () => {
  it('returns parsed JSON for 200', async () => {
    const cfg = { chainId: 8453, accessPriceWei: '1000000000000000000' };
    fetch.mockResolvedValueOnce(makeResponse({ body: cfg }));

    const out = await getConfig();
    expect(out).toEqual(cfg);
    expect(fetch.mock.calls[0][0]).toBe(`${API_BASE}/config`);
  });

  it('returns null for 204 (e.g. logout)', async () => {
    fetch.mockResolvedValueOnce(makeResponse({ status: 204, body: undefined }));

    const out = await logout();
    expect(out).toBeNull();
    expect(fetch.mock.calls[0][1].method).toBe('POST');
  });
});

describe('apiFetch — errors', () => {
  it('throws ApiError with code/title/status on 404 application/problem+json', async () => {
    fetch.mockResolvedValueOnce(
      makeResponse({
        status: 404,
        contentType: 'application/problem+json',
        body: {
          type: 'https://pitchterminal.app/problems/tokens-unknown',
          title: 'Unknown token',
          status: 404,
          detail: 'Token not in registry.',
          code: 'tokens.unknown',
        },
      }),
    );

    await expect(getChart('0xdeadbeef')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'tokens.unknown',
      status: 404,
      title: 'Unknown token',
      detail: 'Token not in registry.',
    });
  });

  it('throws ApiError with code=access.payment_required on 402', async () => {
    fetch.mockResolvedValueOnce(
      makeResponse({
        status: 402,
        contentType: 'application/problem+json',
        body: {
          status: 402,
          title: 'Payment required',
          code: 'access.payment_required',
        },
      }),
    );

    let err;
    try {
      await getPosition('0xabc');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('access.payment_required');
    expect(err.status).toBe(402);
  });

  it('throws ApiError with code=auth.unauthenticated on 401', async () => {
    fetch.mockResolvedValueOnce(
      makeResponse({
        status: 401,
        contentType: 'application/problem+json',
        body: { status: 401, code: 'auth.unauthenticated', title: 'Not signed in' },
      }),
    );

    await expect(getProfile()).rejects.toMatchObject({
      code: 'auth.unauthenticated',
      status: 401,
    });
  });

  it('throws ApiError with code=server.degraded for health 503 (plain JSON)', async () => {
    fetch.mockResolvedValueOnce(
      makeResponse({
        status: 503,
        contentType: 'application/json',
        body: {
          status: 'degraded',
          components: { api: 'ok', db: 'down', worker: 'unknown', rpc: 'unknown' },
          checkedAt: 1709000010,
        },
      }),
    );

    await expect(getHealth()).rejects.toMatchObject({
      code: 'server.degraded',
      status: 503,
    });
  });
});

describe('endpoint wrappers — URLs', () => {
  it('getTokens hits /tokens', async () => {
    fetch.mockResolvedValueOnce(makeResponse({ body: { players: [], countries: [] } }));
    await getTokens();
    expect(fetch.mock.calls[0][0]).toBe(`${API_BASE}/tokens`);
  });

  it('getChart includes tf query param (defaults to 5m)', async () => {
    fetch.mockResolvedValueOnce(makeResponse({ body: { candles: [], points: [] } }));
    await getChart('0xabc');
    expect(fetch.mock.calls[0][0]).toBe(`${API_BASE}/tokens/0xabc/chart?tf=5m`);

    fetch.mockResolvedValueOnce(makeResponse({ body: { candles: [], points: [] } }));
    await getChart('0xabc', '1h');
    expect(fetch.mock.calls[1][0]).toBe(`${API_BASE}/tokens/0xabc/chart?tf=1h`);
  });

  it('getTrades encodes limit and cursor', async () => {
    fetch.mockResolvedValueOnce(
      makeResponse({ body: { trades: { items: [], nextCursor: null } } }),
    );
    await getTrades('0xabc', { limit: 50, cursor: 'eyJ0In0' });
    expect(fetch.mock.calls[0][0]).toBe(
      `${API_BASE}/tokens/0xabc/trades?limit=50&cursor=eyJ0In0`,
    );
  });

  it('getTrades with no opts skips query params', async () => {
    fetch.mockResolvedValueOnce(
      makeResponse({ body: { trades: { items: [], nextCursor: null } } }),
    );
    await getTrades('0xabc');
    expect(fetch.mock.calls[0][0]).toBe(`${API_BASE}/tokens/0xabc/trades`);
  });

  it('getAuthNonce hits /auth/nonce', async () => {
    fetch.mockResolvedValueOnce(makeResponse({ body: { nonce: 'abc', issuedAt: 1, expiresAt: 2 } }));
    await getAuthNonce();
    expect(fetch.mock.calls[0][0]).toBe(`${API_BASE}/auth/nonce`);
  });

  it('verifySiwe POSTs message+signature as JSON', async () => {
    fetch.mockResolvedValueOnce(makeResponse({ body: { address: '0xabc' } }));
    await verifySiwe('msg', '0xsig');

    const [, init] = fetch.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ message: 'msg', signature: '0xsig' });
  });

  it('getAccess({ fresh: true }) appends fresh=1; default omits it', async () => {
    fetch.mockResolvedValueOnce(makeResponse({ body: { hasAccess: false } }));
    await getAccess();
    expect(fetch.mock.calls[0][0]).toBe(`${API_BASE}/access`);

    fetch.mockResolvedValueOnce(makeResponse({ body: { hasAccess: true } }));
    await getAccess({ fresh: true });
    expect(fetch.mock.calls[1][0]).toBe(`${API_BASE}/access?fresh=1`);
  });

  it('getOrders filters by status and token', async () => {
    fetch.mockResolvedValueOnce(makeResponse({ body: { items: [], nextCursor: null } }));
    await getOrders({ status: 'pending', token: '0xabc', limit: 25 });
    expect(fetch.mock.calls[0][0]).toBe(
      `${API_BASE}/orders?status=pending&token=0xabc&limit=25`,
    );
  });

  it('createOrder POSTs the body and signature', async () => {
    fetch.mockResolvedValueOnce(makeResponse({ body: { id: '1' } }));
    const order = { owner: '0xabc', nonce: '0xff' };
    await createOrder(order, '0xsig');

    const [, init] = fetch.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ order, signature: '0xsig' });
  });

  it('cancelOrder DELETEs the resource', async () => {
    fetch.mockResolvedValueOnce(makeResponse({ status: 204 }));
    const out = await cancelOrder('1234');
    expect(out).toBeNull();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${API_BASE}/orders/1234`);
    expect(init.method).toBe('DELETE');
  });

  it('setArmed PUTs { armed }', async () => {
    fetch.mockResolvedValueOnce(makeResponse({ body: { armed: false } }));
    await setArmed(false);

    const [, init] = fetch.mock.calls[0];
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ armed: false });
  });
});

describe('paginate', () => {
  it('yields every page until nextCursor is null (3 pages)', async () => {
    const pages = [
      { items: [1, 2, 3], nextCursor: 'c1' },
      { items: [4, 5, 6], nextCursor: 'c2' },
      { items: [7, 8, 9], nextCursor: null },
    ];
    let call = 0;
    const fetcher = vi.fn(async () => pages[call++]);

    const collected = [];
    for await (const page of paginate(fetcher, {})) collected.push(page);

    expect(collected).toEqual(pages);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0][0]).toEqual({ cursor: undefined });
    expect(fetcher.mock.calls[1][0]).toEqual({ cursor: 'c1' });
    expect(fetcher.mock.calls[2][0]).toEqual({ cursor: 'c2' });
  });

  it('passes through positional args before opts', async () => {
    const pages = [
      { items: [], nextCursor: 'c1' },
      { items: [], nextCursor: null },
    ];
    let call = 0;
    const fetcher = vi.fn(async (tokenAddr, opts) => {
      expect(tokenAddr).toBe('0xabc');
      expect(opts.limit).toBe(50);
      return pages[call++];
    });

    const collected = [];
    for await (const page of paginate(fetcher, '0xabc', { limit: 50 })) collected.push(page);

    expect(collected).toHaveLength(2);
    expect(fetcher.mock.calls[1][1].cursor).toBe('c1');
  });

  it('handles nested nextCursor (e.g. trades.nextCursor)', async () => {
    const pages = [
      { trades: { items: [1], nextCursor: 'c1' }, wallets: [] },
      { trades: { items: [2], nextCursor: null }, wallets: [] },
    ];
    let call = 0;
    const fetcher = vi.fn(async () => pages[call++]);

    const collected = [];
    for await (const page of paginate(fetcher, {})) collected.push(page);

    expect(collected).toHaveLength(2);
  });
});
