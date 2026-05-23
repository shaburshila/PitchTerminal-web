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
 * @property {(err: Event|Error) => void} [onError]
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
    if (payload === undefined) return;

    if (channel === 'prices') {
      safeInvoke(handlers.onPrices, payload);
    } else if (channel === 'events') {
      safeInvoke(handlers.onEvents, payload);
    } else if (channel === 'config') {
      // Dedup: same on-chain tx may be re-scanned by the worker.
      if (payload && payload.txHash && payload.txHash === lastConfigTxHash) {
        return;
      }
      if (payload && payload.txHash) {
        lastConfigTxHash = payload.txHash;
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
      safeInvoke(handlers.onOpen);
      if (totalOpens > 1) {
        safeInvoke(handlers.onReconnect);
      }
    };

    es.onerror = (err) => {
      safeInvoke(handlers.onError, err);
      // Only escalate to manual reconnect once the native EventSource has
      // given up (readyState === CLOSED). For transient hiccups
      // (readyState === CONNECTING) EventSource retries on its own.
      const CLOSED_STATE =
        (eventSourceCtor && eventSourceCtor.CLOSED) ??
        (globalThis.EventSource && globalThis.EventSource.CLOSED) ??
        2;
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
