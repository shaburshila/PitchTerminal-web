// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openStream } from '../src/sse.js';
import {
  get as getConfigSnap,
  merge as mergeConfig,
  subscribe as subscribeConfig,
  _resetForTests as resetConfigStore,
} from '../src/config-store.js';

/**
 * Minimal EventSource mock — same shape as the one in `sse.test.js`. Kept
 * local so this file is self-contained.
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
    MockEventSource.instances.push(this);
  }
  addEventListener(name, cb) {
    (this.listeners[name] ??= []).push(cb);
  }
  dispatch(name, data) {
    const evt = { data: typeof data === 'string' ? data : JSON.stringify(data) };
    (this.listeners[name] || []).forEach((cb) => cb(evt));
  }
  open() {
    this.readyState = MockEventSource.OPEN;
    if (typeof this.onopen === 'function') this.onopen(new Event('open'));
  }
  fail() {
    this.readyState = MockEventSource.CLOSED;
    if (typeof this.onerror === 'function') this.onerror(new Event('error'));
  }
  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  resetConfigStore();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── config-store unit ──────────────────────────────────────────────────────

describe('config-store', () => {
  it('starts with all-null snapshot', () => {
    const snap = getConfigSnap();
    expect(snap).toEqual({
      accessPriceWei: null,
      buyerDiscountBps: null,
      referralBps: null,
      txHash: null,
    });
  });

  it('merge() updates only specified keys and notifies subscribers once', () => {
    const listener = vi.fn();
    subscribeConfig(listener);
    mergeConfig({ accessPriceWei: '1', buyerDiscountBps: 2500 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getConfigSnap()).toEqual({
      accessPriceWei: '1',
      buyerDiscountBps: 2500,
      referralBps: null,
      txHash: null,
    });
  });

  it('merge() with no actual changes does NOT notify', () => {
    mergeConfig({ accessPriceWei: '1' });
    const listener = vi.fn();
    subscribeConfig(listener);
    mergeConfig({ accessPriceWei: '1' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('subscribe() returns an unsubscribe fn', () => {
    const listener = vi.fn();
    const off = subscribeConfig(listener);
    off();
    mergeConfig({ accessPriceWei: '42' });
    expect(listener).not.toHaveBeenCalled();
  });
});

// ─── SSE → store integration ────────────────────────────────────────────────

describe('openStream — config channel → config-store', () => {
  it('SSE `event: config` populates the store and notifies subscribers', () => {
    const listener = vi.fn();
    subscribeConfig(listener);
    const handle = openStream({}, { eventSourceCtor: MockEventSource });
    const es = MockEventSource.instances[0];
    es.dispatch('config', {
      accessPriceWei: '2000000000000000000',
      buyerDiscountBps: 2500,
      referralBps: 2500,
      txHash: '0xabc',
    });
    expect(getConfigSnap()).toMatchObject({
      accessPriceWei: '2000000000000000000',
      buyerDiscountBps: 2500,
      referralBps: 2500,
      txHash: '0xabc',
    });
    expect(listener).toHaveBeenCalledTimes(1);
    handle.close();
  });

  it('dedup: same txHash → store + subscribers untouched on second event', () => {
    const listener = vi.fn();
    const handle = openStream({}, { eventSourceCtor: MockEventSource });
    const es = MockEventSource.instances[0];
    const snap = {
      accessPriceWei: '1',
      buyerDiscountBps: 2500,
      referralBps: 2500,
      txHash: '0xdeadbeef',
    };
    es.dispatch('config', snap);
    subscribeConfig(listener); // subscribe AFTER first event
    es.dispatch('config', snap); // dedup → no merge → no notify
    expect(listener).not.toHaveBeenCalled();
    handle.close();
  });

  it('still invokes onConfig callback for raw payload consumers', () => {
    const onConfig = vi.fn();
    const handle = openStream({ onConfig }, { eventSourceCtor: MockEventSource });
    const es = MockEventSource.instances[0];
    es.dispatch('config', { accessPriceWei: '7', txHash: '0xa' });
    expect(onConfig).toHaveBeenCalledTimes(1);
    expect(onConfig.mock.calls[0][0]).toMatchObject({
      accessPriceWei: '7',
      txHash: '0xa',
    });
    handle.close();
  });

  it('on reconnect, caller-supplied onReconnect handler is invoked (catch-up hook)', () => {
    vi.useFakeTimers();
    const onReconnect = vi.fn();
    const handle = openStream(
      { onReconnect },
      { reconnectDelayMs: 100, eventSourceCtor: MockEventSource },
    );
    const first = MockEventSource.instances[0];
    first.open();
    first.fail();
    vi.advanceTimersByTime(100);
    const second = MockEventSource.instances[1];
    second.open();
    expect(onReconnect).toHaveBeenCalledTimes(1);
    handle.close();
  });

  it('after reconnect, same-txHash snapshot is re-delivered to the store (cache cleared)', () => {
    vi.useFakeTimers();
    const handle = openStream({}, { reconnectDelayMs: 100, eventSourceCtor: MockEventSource });
    const first = MockEventSource.instances[0];
    first.open();
    first.dispatch('config', { accessPriceWei: '1', txHash: '0xabc' });
    expect(getConfigSnap().accessPriceWei).toBe('1');

    // Mutate store between events to prove the post-reconnect merge actually
    // runs (it would be a no-op if the value matched).
    mergeConfig({ accessPriceWei: '999' });

    first.fail();
    vi.advanceTimersByTime(100);
    const second = MockEventSource.instances[1];
    second.open();
    // Worker re-emits same txHash during catch-up — store must accept it.
    second.dispatch('config', { accessPriceWei: '1', txHash: '0xabc' });
    expect(getConfigSnap().accessPriceWei).toBe('1');
    handle.close();
  });
});
