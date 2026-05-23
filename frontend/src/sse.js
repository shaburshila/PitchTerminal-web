/**
 * Server-Sent Events client for PitchTerminal-web.
 *
 * Wraps the `/api/v1/stream` endpoint described in docs/api-spec.md §8. The
 * session cookie (`pt_session`) is sent automatically via `withCredentials`;
 * there is no separate auth for SSE.
 *
 * Channels (see api-spec §8.3):
 *   - prices   — every ~5 s, delta of changed token prices.
 *   - events   — new on-chain trades.
 *   - config   — reactive update of access-config (price / discount / referral).
 *   - orders   — premium only; per-order status updates.
 *
 * Reconnect:
 *   - EventSource retries natively (~3 s). On top of that we explicitly
 *     re-create the EventSource if `readyState === CLOSED` after `onerror`,
 *     with capped exponential backoff and a configurable attempt limit.
 *   - On reconnect we invoke `handlers.onReconnect` AFTER the new connection
 *     opens — the caller is expected to fire catch-up GETs (see §8.4).
 *
 * Out of scope for this module (caller responsibility):
 *   - Premium-payment-triggered reconnect (close + re-open after buyAccess).
 *   - Connection-limit (429) recovery — surfaced via `onError`.
 *   - Catch-up REST fetches after reconnect — fired from `onReconnect`.
 *
 * The `config` channel additionally merges every accepted (non-deduplicated)
 * snapshot into the shared `config-store` module — see F0.12c. UI components
 * can subscribe to that store directly without each one wiring an `onConfig`
 * handler. The `onConfig` callback is still invoked for callers that want
 * the raw payload (e.g. logging, pay-flow re-render hints).
 *
 * `Last-Event-ID` note: native EventSource automatically sends the last seen
 * event id on its OWN reconnect attempts (CONNECTING-state retries). Manual
 * reconnects from this module open a brand-new EventSource and therefore do
 * NOT send Last-Event-ID. Both behaviours are fine because the server is
 * specified to **ignore** Last-Event-ID and rely on caller-issued catch-up
 * GETs (api-spec.md §8.2). If a future backend regression starts honouring
 * the header, the manual-reconnect path will already be drift-resistant.
 */

/**
 * @typedef {object} StreamHandlers
 * @property {(payload: object) => void} [onPrices]
 *   `{ updatedAt, stale, tokens }` per api-spec §8.3.
 * @property {(payload: object) => void} [onEvents]
 *   `{ newTrades }`.
 * @property {(payload: object) => void} [onConfig]
 *   `{ accessPriceWei, buyerDiscountBps, referralBps, updatedAt, blockNumber, txHash }`.
 *   Deduplicated by `txHash` inside this client.
 * @property {(payload: object) => void} [onOrders]
 *   `{ order: { id, status, executedTxHash, failReason } }`.
 * @property {(err: Event|Error, info?: {readyState: number, willReconnect: boolean, attempts: number}) => void} [onError]
 *   `info.readyState` is the EventSource state (0=CONNECTING, 1=OPEN, 2=CLOSED).
 *   `info.willReconnect` is true if this module will attempt a manual reconnect
 *   after this error; false for transient CONNECTING-state hiccups (native
 *   retry handles those). `info.attempts` is the consecutive-failure count
 *   AFTER this error — useful to surface a banner after N failed retries
 *   (e.g. 429 connection-limit loops).
 * @property {() => void} [onOpen]
 *   Called every time a connection opens (including the very first).
 * @property {() => void} [onReconnect]
 *   Called after a connection successfully re-opens (NOT the first open).
 */

/**
 * @typedef {object} StreamOptions
 * @property {string} [url='/api/v1/stream']
 * @property {boolean} [autoReconnect=true]
 * @property {number} [reconnectDelayMs=3000]   Base delay; doubles each attempt up to `maxReconnectDelayMs`.
 * @property {number} [maxReconnectDelayMs=30000]
 * @property {number} [maxReconnectAttempts=Infinity]
 * @property {typeof EventSource} [eventSourceCtor]
 *   Inject a mock EventSource for tests; defaults to `globalThis.EventSource`.
 */

/**
 * @typedef {object} StreamHandle
 * @property {() => void} close
 *   Tear down the connection and cancel any pending reconnect.
 * @property {() => boolean} isClosed
 * @property {() => number} reconnectAttempts
 *   Current consecutive-failure count (zeroed on successful open).
 */

import { merge as mergeConfig } from './config-store.js';

const CHANNELS = ['prices', 'events', 'config', 'orders'];

/**
 * Open a managed SSE connection.
 *
 * @param {StreamHandlers} [handlers]
 * @param {StreamOptions} [options]
 * @returns {StreamHandle}
 */
export function openStream(handlers = {}, options = {}) {
  const {
    url = '/api/v1/stream',
    autoReconnect = true,
    reconnectDelayMs = 3000,
    maxReconnectDelayMs = 30000,
    maxReconnectAttempts = Infinity,
    eventSourceCtor = globalThis.EventSource,
  } = options;

  if (typeof eventSourceCtor !== 'function') {
    throw new Error('openStream: no EventSource constructor available');
  }

  // State captured in closure — survives reconnect.
  let source = null;
  let closed = false;
  let attempts = 0;
  let totalOpens = 0;
  let reconnectTimer = null;
  let lastConfigTxHash = null;

  function clearTimer() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function safeInvoke(fn, ...args) {
    if (typeof fn !== 'function') return;
    try {
      fn(...args);
    } catch (err) {
      // Never let a handler bubble up and break the SSE loop.
      console.error('openStream handler threw:', err);
    }
  }

  function parseData(raw) {
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.warn('openStream: ignoring malformed SSE data', err);
      return undefined;
    }
  }

  function handleChannel(channel, evt) {
    const payload = parseData(evt?.data);
    // Both `undefined` (parse failure) and `null` (JSON `null` literal) are
    // discarded — handlers would otherwise crash on `payload.foo` access.
    if (payload === undefined || payload === null) return;

    if (channel === 'prices') {
      safeInvoke(handlers.onPrices, payload);
    } else if (channel === 'events') {
      safeInvoke(handlers.onEvents, payload);
    } else if (channel === 'config') {
      // Dedup: same on-chain tx may be re-scanned by the worker.
      if (payload.txHash && payload.txHash === lastConfigTxHash) {
        return;
      }
      if (payload.txHash) {
        lastConfigTxHash = payload.txHash;
      }
      // Merge into shared store first — subscribers (banner, pay-flow modal)
      // pick up the new values reactively. Then fire the callback for any
      // imperative consumer (logging, debug overlay, …).
      try {
        mergeConfig({
          accessPriceWei: payload.accessPriceWei,
          buyerDiscountBps: payload.buyerDiscountBps,
          referralBps: payload.referralBps,
          txHash: payload.txHash,
        });
      } catch (err) {
        console.error('openStream: configStore merge failed:', err);
      }
      safeInvoke(handlers.onConfig, payload);
    } else if (channel === 'orders') {
      safeInvoke(handlers.onOrders, payload);
    }
  }

  function scheduleReconnect() {
    if (closed || !autoReconnect) return;
    if (attempts >= maxReconnectAttempts) return;

    // Exponential backoff: base * 2^attempts (0-indexed), capped.
    const exp = Math.min(reconnectDelayMs * 2 ** attempts, maxReconnectDelayMs);
    attempts += 1;

    clearTimer();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (closed) return;
      connect();
    }, exp);
  }

  function connect() {
    if (closed) return;

    // Tear down any zombie reference.
    if (source) {
      try {
        source.close();
      } catch {
        /* ignore */
      }
      source = null;
    }

    let es;
    try {
      es = new eventSourceCtor(url, { withCredentials: true });
    } catch (err) {
      safeInvoke(handlers.onError, err);
      scheduleReconnect();
      return;
    }
    source = es;

    es.onopen = () => {
      attempts = 0;
      totalOpens += 1;
      if (totalOpens > 1) {
        // Reset config-dedup cache on every successful reconnect so the first
        // config snapshot post-reconnect always reaches the handler — caller
        // may have rendered stale UI while disconnected.
        lastConfigTxHash = null;
      }
      safeInvoke(handlers.onOpen);
      if (totalOpens > 1) {
        safeInvoke(handlers.onReconnect);
      }
    };

    es.onerror = (err) => {
      // Only escalate to manual reconnect once the native EventSource has
      // given up (readyState === CLOSED). For transient hiccups
      // (readyState === CONNECTING) EventSource retries on its own.
      const CLOSED_STATE =
        (eventSourceCtor && eventSourceCtor.CLOSED) ??
        (globalThis.EventSource && globalThis.EventSource.CLOSED) ??
        2;
      const willReconnect =
        es.readyState === CLOSED_STATE &&
        !closed &&
        autoReconnect &&
        attempts < maxReconnectAttempts;
      const info = {
        readyState: es.readyState,
        willReconnect,
        // Post-error attempts count: scheduleReconnect increments it, so
        // surface what it WILL be so callers see the next-retry number.
        attempts: willReconnect ? attempts + 1 : attempts,
      };
      safeInvoke(handlers.onError, err, info);
      if (es.readyState === CLOSED_STATE) {
        scheduleReconnect();
      }
    };

    for (const channel of CHANNELS) {
      es.addEventListener(channel, (evt) => handleChannel(channel, evt));
    }
  }

  connect();

  return {
    close() {
      closed = true;
      clearTimer();
      if (source) {
        try {
          source.close();
        } catch {
          /* ignore */
        }
        source = null;
      }
    },
    isClosed() {
      return closed;
    },
    reconnectAttempts() {
      return attempts;
    },
  };
}
