import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openStream } from '../src/sse.js';

/**
 * Minimal mock of the EventSource API as observed by `sse.js`.
 *
 * - Records all instances in a static array so tests can introspect.
 * - Exposes `dispatch(name, data)` / `open()` / `fail()` helpers so tests
 *   can drive its lifecycle synchronously.
 */
class MockEventSource {
  static instances = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.readyState = MockEventSource.CONNECTING;
    this.listeners = {};
    this.onopen = null;
    this.onerror = null;
    this.onmessage = null;
    MockEventSource.instances.push(this);
  }

  addEventListener(name, cb) {
    (this.listeners[name] ??= []).push(cb);
  }

  removeEventListener(name, cb) {
    const arr = this.listeners[name];
    if (!arr) return;
    const idx = arr.indexOf(cb);
    if (idx >= 0) arr.splice(idx, 1);
  }

  /** Fire a named SSE event with a JSON-stringified payload. */
  dispatch(name, data) {
    const evt = { data: typeof data === 'string' ? data : JSON.stringify(data) };
    (this.listeners[name] || []).forEach((cb) => cb(evt));
  }

  /** Mark CONNECTING -> OPEN and trigger `onopen`. */
  open() {
    this.readyState = MockEventSource.OPEN;
    if (typeof this.onopen === 'function') this.onopen(new Event('open'));
  }

  /** Move directly to CLOSED and trigger `onerror`. */
  fail() {
    this.readyState = MockEventSource.CLOSED;
    if (typeof this.onerror === 'function') this.onerror(new Event('error'));
  }

  /** Transient connection blip — still CONNECTING (EventSource retries on its own). */
  hiccup() {
    this.readyState = MockEventSource.CONNECTING;
    if (typeof this.onerror === 'function') this.onerror(new Event('error'));
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('openStream — connection', () => {
  it('creates EventSource with /api/v1/stream and withCredentials:true', () => {
    const handle = openStream({}, { eventSourceCtor: MockEventSource });
    expect(MockEventSource.instances).toHaveLength(1);
    const es = MockEventSource.instances[0];
    expect(es.url).toBe('/api/v1/stream');
    expect(es.opts).toEqual({ withCredentials: true });
    handle.close();
  });

  it('allows overriding the URL via options', () => {
    const handle = openStream({}, { url: '/custom/stream', eventSourceCtor: MockEventSource });
    expect(MockEventSource.instances[0].url).toBe('/custom/stream');
    handle.close();
  });

  it('throws if no EventSource constructor is available', () => {
    expect(() => openStream({}, { eventSourceCtor: undefined })).toThrow(/EventSource/);
  });

  it('calls onOpen the first time the connection opens', () => {
    const onOpen = vi.fn();
    const handle = openStream({ onOpen }, { eventSourceCtor: MockEventSource });
    MockEventSource.instances[0].open();
    expect(onOpen).toHaveBeenCalledTimes(1);
    handle.close();
  });
});

describe('openStream — channel dispatch', () => {
  it('invokes onPrices with parsed JSON for prices events', () => {
    const onPrices = vi.fn();
    const handle = openStream({ onPrices }, { eventSourceCtor: MockEventSource });
    const payload = { updatedAt: 1, stale: false, tokens: [{ address: '0xabc' }] };
    MockEventSource.instances[0].dispatch('prices', payload);
    expect(onPrices).toHaveBeenCalledWith(payload);
    handle.close();
  });

  it('invokes onEvents for events channel', () => {
    const onEvents = vi.fn();
    const handle = openStream({ onEvents }, { eventSourceCtor: MockEventSource });
    const payload = { newTrades: [{ token: '0x1', type: 'buy' }] };
    MockEventSource.instances[0].dispatch('events', payload);
    expect(onEvents).toHaveBeenCalledWith(payload);
    handle.close();
  });

  it('invokes onConfig for config channel', () => {
    const onConfig = vi.fn();
    const handle = openStream({ onConfig }, { eventSourceCtor: MockEventSource });
    const payload = {
      accessPriceWei: '2000000000000000000',
      buyerDiscountBps: 2500,
      referralBps: 2500,
      updatedAt: 1,
      blockNumber: 42,
      txHash: '0xabc',
    };
    MockEventSource.instances[0].dispatch('config', payload);
    expect(onConfig).toHaveBeenCalledWith(payload);
    handle.close();
  });

  it('invokes onOrders for orders channel', () => {
    const onOrders = vi.fn();
    const handle = openStream({ onOrders }, { eventSourceCtor: MockEventSource });
    const payload = { order: { id: '1', status: 'filled' } };
    MockEventSource.instances[0].dispatch('orders', payload);
    expect(onOrders).toHaveBeenCalledWith(payload);
    handle.close();
  });

  it('skips invalid JSON and warns, without throwing', () => {
    const onPrices = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = openStream({ onPrices }, { eventSourceCtor: MockEventSource });
    // Push a non-JSON string directly via addEventListener path.
    MockEventSource.instances[0].dispatch('prices', '{not-json');
    expect(onPrices).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    handle.close();
  });

  it('isolates handler exceptions (does not break dispatch)', () => {
    const onPrices = vi.fn(() => {
      throw new Error('boom');
    });
    const onEvents = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = openStream({ onPrices, onEvents }, { eventSourceCtor: MockEventSource });
    const es = MockEventSource.instances[0];
    expect(() => es.dispatch('prices', { tokens: [] })).not.toThrow();
    // Subsequent dispatches still work after a throwing handler.
    es.dispatch('events', { newTrades: [] });
    expect(onEvents).toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    handle.close();
  });
});

describe('openStream — config deduplication', () => {
  it('ignores a second config event with the same txHash', () => {
    const onConfig = vi.fn();
    const handle = openStream({ onConfig }, { eventSourceCtor: MockEventSource });
    const snap = {
      accessPriceWei: '1',
      buyerDiscountBps: 2500,
      referralBps: 2500,
      updatedAt: 1,
      blockNumber: 100,
      txHash: '0xdeadbeef',
    };
    const es = MockEventSource.instances[0];
    es.dispatch('config', snap);
    es.dispatch('config', snap);
    expect(onConfig).toHaveBeenCalledTimes(1);
    handle.close();
  });

  it('passes through new txHash after dedup', () => {
    const onConfig = vi.fn();
    const handle = openStream({ onConfig }, { eventSourceCtor: MockEventSource });
    const es = MockEventSource.instances[0];
    es.dispatch('config', { txHash: '0x1', accessPriceWei: '1' });
    es.dispatch('config', { txHash: '0x1', accessPriceWei: '1' });
    es.dispatch('config', { txHash: '0x2', accessPriceWei: '2' });
    expect(onConfig).toHaveBeenCalledTimes(2);
    expect(onConfig.mock.calls[1][0].txHash).toBe('0x2');
    handle.close();
  });
});

describe('openStream — reconnect', () => {
  it('reconnects after CLOSED and fires onReconnect on the second open', () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const onReconnect = vi.fn();
    const onError = vi.fn();
    const handle = openStream(
      { onOpen, onReconnect, onError },
      { reconnectDelayMs: 1000, eventSourceCtor: MockEventSource },
    );

    const first = MockEventSource.instances[0];
    first.open();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onReconnect).not.toHaveBeenCalled();

    first.fail();
    expect(onError).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(MockEventSource.instances).toHaveLength(2);

    const second = MockEventSource.instances[1];
    second.open();
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onReconnect).toHaveBeenCalledTimes(1);

    handle.close();
  });

  it('does NOT manually reconnect on a transient hiccup (readyState=CONNECTING)', () => {
    vi.useFakeTimers();
    const handle = openStream({}, { reconnectDelayMs: 1000, eventSourceCtor: MockEventSource });
    const es = MockEventSource.instances[0];
    es.open();
    es.hiccup();
    vi.advanceTimersByTime(10_000);
    // Still only the original instance — native EventSource retries itself.
    expect(MockEventSource.instances).toHaveLength(1);
    handle.close();
  });

  it('stops after maxReconnectAttempts', () => {
    vi.useFakeTimers();
    const handle = openStream(
      {},
      { reconnectDelayMs: 100, maxReconnectAttempts: 2, eventSourceCtor: MockEventSource },
    );

    // Attempt 1: fail -> attempts=1, schedule -> instance #2 created.
    MockEventSource.instances[0].fail();
    vi.advanceTimersByTime(100);
    expect(MockEventSource.instances).toHaveLength(2);

    // Attempt 2: fail -> attempts=2, schedule -> instance #3 created.
    MockEventSource.instances[1].fail();
    vi.advanceTimersByTime(10_000);
    expect(MockEventSource.instances).toHaveLength(3);

    // Attempt 3 would push attempts to 3 — limit reached, no further reconnect.
    MockEventSource.instances[2].fail();
    vi.advanceTimersByTime(60_000);
    expect(MockEventSource.instances).toHaveLength(3);

    handle.close();
  });

  it('handle.close() prevents pending reconnect', () => {
    vi.useFakeTimers();
    const handle = openStream({}, { reconnectDelayMs: 500, eventSourceCtor: MockEventSource });
    MockEventSource.instances[0].fail();
    handle.close();
    vi.advanceTimersByTime(5000);
    expect(MockEventSource.instances).toHaveLength(1);
    expect(handle.isClosed()).toBe(true);
  });

  it('resets the attempt counter after a successful open', () => {
    vi.useFakeTimers();
    const handle = openStream(
      {},
      { reconnectDelayMs: 100, maxReconnectAttempts: 3, eventSourceCtor: MockEventSource },
    );

    MockEventSource.instances[0].fail();
    expect(handle.reconnectAttempts()).toBe(1);
    vi.advanceTimersByTime(100);
    // Second instance opens — counter resets.
    MockEventSource.instances[1].open();
    expect(handle.reconnectAttempts()).toBe(0);

    handle.close();
  });

  it('applies exponential backoff between attempts', () => {
    vi.useFakeTimers();
    const handle = openStream(
      {},
      {
        reconnectDelayMs: 1000,
        maxReconnectDelayMs: 30_000,
        eventSourceCtor: MockEventSource,
      },
    );

    // First failure: base delay 1000 ms.
    MockEventSource.instances[0].fail();
    vi.advanceTimersByTime(999);
    expect(MockEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockEventSource.instances).toHaveLength(2);

    // Second failure (no successful open between): backoff doubles -> 2000 ms.
    MockEventSource.instances[1].fail();
    vi.advanceTimersByTime(1999);
    expect(MockEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(MockEventSource.instances).toHaveLength(3);

    handle.close();
  });

  it('does not reconnect when autoReconnect is false', () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const handle = openStream(
      { onError },
      { autoReconnect: false, eventSourceCtor: MockEventSource },
    );
    MockEventSource.instances[0].fail();
    vi.advanceTimersByTime(60_000);
    expect(MockEventSource.instances).toHaveLength(1);
    expect(onError).toHaveBeenCalled();
    handle.close();
  });
});

describe('openStream — handle inspection', () => {
  it('reports closed=false initially and closed=true after close()', () => {
    const handle = openStream({}, { eventSourceCtor: MockEventSource });
    expect(handle.isClosed()).toBe(false);
    handle.close();
    expect(handle.isClosed()).toBe(true);
  });

  it('close() is idempotent', () => {
    const handle = openStream({}, { eventSourceCtor: MockEventSource });
    handle.close();
    expect(() => handle.close()).not.toThrow();
    expect(handle.isClosed()).toBe(true);
  });
});

describe('openStream — error payload', () => {
  it('passes {readyState, willReconnect:true, attempts:1} on CLOSED with retry budget', () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const handle = openStream(
      { onError },
      { reconnectDelayMs: 1000, eventSourceCtor: MockEventSource },
    );
    MockEventSource.instances[0].fail();
    expect(onError).toHaveBeenCalledTimes(1);
    const [, info] = onError.mock.calls[0];
    expect(info).toBeDefined();
    expect(info.readyState).toBe(MockEventSource.CLOSED);
    expect(info.willReconnect).toBe(true);
    expect(info.attempts).toBe(1);
    handle.close();
  });

  it('passes {willReconnect:false} on transient CONNECTING hiccup', () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const handle = openStream({ onError }, { eventSourceCtor: MockEventSource });
    const es = MockEventSource.instances[0];
    es.open();
    es.hiccup();
    expect(onError).toHaveBeenCalledTimes(1);
    const [, info] = onError.mock.calls[0];
    expect(info.readyState).toBe(MockEventSource.CONNECTING);
    expect(info.willReconnect).toBe(false);
    handle.close();
  });

  it('passes {willReconnect:false} once maxReconnectAttempts is exhausted', () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const handle = openStream(
      { onError },
      { reconnectDelayMs: 100, maxReconnectAttempts: 1, eventSourceCtor: MockEventSource },
    );
    MockEventSource.instances[0].fail(); // attempts -> 1 (schedule)
    vi.advanceTimersByTime(100);
    MockEventSource.instances[1].fail(); // budget exhausted → no reschedule
    const lastInfo = onError.mock.calls[onError.mock.calls.length - 1][1];
    expect(lastInfo.willReconnect).toBe(false);
    handle.close();
  });
});

describe('openStream — null/edge payloads', () => {
  it('drops JSON-null payloads without invoking handlers', () => {
    const onPrices = vi.fn();
    const handle = openStream({ onPrices }, { eventSourceCtor: MockEventSource });
    // SSE `data: null\n\n` parses to JSON null — must not crash handler with
    // `payload.foo` access.
    MockEventSource.instances[0].dispatch('prices', null);
    expect(onPrices).not.toHaveBeenCalled();
    handle.close();
  });

  it('passes config payloads without txHash straight through (no dedup)', () => {
    const onConfig = vi.fn();
    const handle = openStream({ onConfig }, { eventSourceCtor: MockEventSource });
    const es = MockEventSource.instances[0];
    es.dispatch('config', { accessPriceWei: '1', buyerDiscountBps: 0, referralBps: 0 });
    es.dispatch('config', { accessPriceWei: '2', buyerDiscountBps: 0, referralBps: 0 });
    expect(onConfig).toHaveBeenCalledTimes(2);
    handle.close();
  });
});

describe('openStream — config dedup reset on reconnect', () => {
  it('re-delivers the same txHash AFTER a reconnect (cache cleared on re-open)', () => {
    vi.useFakeTimers();
    const onConfig = vi.fn();
    const handle = openStream(
      { onConfig },
      { reconnectDelayMs: 100, eventSourceCtor: MockEventSource },
    );
    const first = MockEventSource.instances[0];
    first.open();
    first.dispatch('config', { txHash: '0xabc', accessPriceWei: '1' });
    expect(onConfig).toHaveBeenCalledTimes(1);

    // Drop and reconnect.
    first.fail();
    vi.advanceTimersByTime(100);
    const second = MockEventSource.instances[1];
    second.open();

    // Worker re-emits the same snapshot during catch-up — must reach handler
    // so any stale-from-disconnect UI gets refreshed.
    second.dispatch('config', { txHash: '0xabc', accessPriceWei: '1' });
    expect(onConfig).toHaveBeenCalledTimes(2);
    handle.close();
  });
});

describe('openStream — constructor failure', () => {
  it('routes synchronous constructor throws to onError and schedules reconnect', () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    let throwOnce = true;
    function BrokenES(url, opts) {
      if (throwOnce) {
        throwOnce = false;
        throw new Error('connection refused');
      }
      return new MockEventSource(url, opts);
    }
    BrokenES.CONNECTING = MockEventSource.CONNECTING;
    BrokenES.OPEN = MockEventSource.OPEN;
    BrokenES.CLOSED = MockEventSource.CLOSED;

    const handle = openStream(
      { onError },
      { reconnectDelayMs: 100, eventSourceCtor: BrokenES },
    );
    // Constructor threw on first call — onError called, no live source yet.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(MockEventSource.instances).toHaveLength(0);

    // After the backoff a real mock instance opens.
    vi.advanceTimersByTime(100);
    expect(MockEventSource.instances).toHaveLength(1);
    handle.close();
  });
});
