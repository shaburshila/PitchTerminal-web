/**
 * REST API client for PitchTerminal-web.
 *
 * Wraps the endpoints described in docs/api-spec.md. All adddresses are lowercase
 * (callers normalise via `viem.getAddress` only for display). Auth is via the
 * httpOnly `pt_session` cookie — every request sends `credentials: 'include'`,
 * never an `Authorization` header.
 */

export const API_BASE = '/api/v1';

/**
 * RFC 7807 error thrown by `apiFetch` when the response is not 2xx.
 *
 * @property {string} code     Stable machine-readable code (see api-spec §1.4).
 * @property {number} status   HTTP status code.
 * @property {string} [title]  Short human-readable title.
 * @property {string} [detail] Long human-readable detail.
 */
export class ApiError extends Error {
  constructor({ code, status, title, detail, message }) {
    super(message || title || detail || code || `HTTP ${status}`);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.title = title;
    this.detail = detail;
  }
}

/**
 * Build a `URLSearchParams` from a plain object, skipping undefined/null values.
 * @param {Record<string, unknown>} obj
 * @returns {string} Encoded query string (without leading "?"), or "" if empty.
 */
function buildQuery(obj) {
  if (!obj) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    params.append(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Core fetch wrapper.
 *
 * - Always sends the session cookie (`credentials: 'include'`).
 * - Accepts JSON by default; merges with caller headers.
 * - On non-ok response, parses the body — `application/problem+json` for
 *   regular errors, or plain JSON for health 503 — and throws `ApiError`.
 * - On 204, returns `null`. Otherwise returns parsed JSON.
 *
 * @param {string} path  Path under `API_BASE` (e.g. `'/tokens'`).
 * @param {RequestInit} [opts] Standard fetch init; `headers` are merged.
 * @returns {Promise<unknown>}
 */
export async function apiFetch(path, opts = {}) {
  const { headers: extraHeaders, ...rest } = opts;
  const init = {
    credentials: 'include',
    ...rest,
    headers: {
      Accept: 'application/json',
      ...(extraHeaders || {}),
    },
  };

  const response = await fetch(API_BASE + path, init);

  if (!response.ok) {
    const contentType = response.headers.get('content-type') || '';
    let parsed = null;

    if (contentType.includes('application/problem+json')) {
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      throw new ApiError({
        code: parsed?.code,
        status: parsed?.status ?? response.status,
        title: parsed?.title,
        detail: parsed?.detail,
      });
    }

    // Health endpoint may return plain JSON on 503 — handle separately.
    if (response.status === 503) {
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      throw new ApiError({
        code: 'server.degraded',
        status: 503,
        title: parsed?.status || 'degraded',
        detail: parsed ? JSON.stringify(parsed.components || {}) : undefined,
      });
    }

    // Last resort — unknown error shape.
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    throw new ApiError({
      code: parsed?.code,
      status: response.status,
      title: parsed?.title,
      detail: parsed?.detail,
    });
  }

  if (response.status === 204) return null;
  return response.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Public/FREE endpoints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /config — bootstrap config (FREE). See api-spec §3.2.
 * @param {{ fresh?: boolean }} [opts] Pass `fresh: true` to bypass the server
 *   cache and force an on-chain re-read of access-config (rate-limited;
 *   used by the pay-flow as a race-guard against just-arrived `setPrice`).
 */
export function getConfig({ fresh = false } = {}) {
  return apiFetch(`/config${fresh ? buildQuery({ fresh: 1 }) : ''}`);
}

/** GET /health — service health (FREE, public). See api-spec §9.1. */
export function getHealth() {
  return apiFetch('/health');
}

/** GET /tokens — full token registry with current prices. See api-spec §4.1. */
export function getTokens() {
  return apiFetch('/tokens');
}

/**
 * GET /tokens/:token/chart — candles + trade points.
 * @param {string} token   Lowercase token address.
 * @param {string} [tf]    Timeframe: 1m|5m|15m|1h|4h|1d. Default '5m'.
 * @param {string} [unit]  Denomination: 'pitch' | 'country'. Default 'pitch'.
 */
export function getChart(token, tf = '5m', unit = 'pitch') {
  return apiFetch(`/tokens/${token}/chart${buildQuery({ tf, unit })}`);
}

/**
 * GET /tokens/:token/trades — trades + holders + (premium) myWallet.
 * @param {string} token
 * @param {{ limit?: number, cursor?: string }} [opts]
 */
export function getTrades(token, { limit, cursor } = {}) {
  return apiFetch(`/tokens/${token}/trades${buildQuery({ limit, cursor })}`);
}

/**
 * GET /tokens/:token/position — connected wallet PnL for this token.
 * PREMIUM: may throw ApiError with status 401 (auth.unauthenticated) or
 * 402 (access.payment_required).
 * @param {string} token
 */
export function getPosition(token) {
  return apiFetch(`/tokens/${token}/position`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Authentication
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /auth/nonce — one-shot SIWE nonce bound to `address`. See api-spec §2.1.
 *
 * Security #5: the server stores the address next to the issued nonce and
 * `/auth/verify` rejects any SIWE message whose signer differs. The address
 * must be 0x-prefixed; the server lowercases server-side, but we lowercase
 * here too for consistency with the rest of the wire format.
 *
 * @param {string} address 0x-prefixed 42-char wallet address.
 */
export function getAuthNonce(address) {
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error('getAuthNonce: address must be a 0x-prefixed 42-char hex string');
  }
  return apiFetch('/auth/nonce', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: address.toLowerCase() }),
  });
}

/**
 * POST /auth/verify — submit a SIWE-signed message; server sets `pt_session`.
 * @param {string} message   SIWE message text.
 * @param {string} signature 0x-prefixed signature.
 */
export function verifySiwe(message, signature) {
  return apiFetch('/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  });
}

/** POST /auth/logout — clears `pt_session`. Always returns 204 → null. */
export function logout() {
  return apiFetch('/auth/logout', { method: 'POST' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Access / payments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /access — premium status of the session wallet.
 * @param {{ fresh?: boolean }} [opts] Pass `fresh: true` to bypass the server cache.
 */
export function getAccess({ fresh = false } = {}) {
  return apiFetch(`/access${fresh ? buildQuery({ fresh: 1 }) : ''}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Referral
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /ref/:code — resolve a referral handle to a wallet address. FREE.
 * Throws ApiError 404 for unknown/invalid codes (server treats malformed
 * codes as 404 too — see api-spec §5.2.1).
 * @param {string} code
 */
export function getRef(code) {
  return apiFetch(`/ref/${encodeURIComponent(code)}`);
}

/**
 * GET /ref/me — current handle of the connected wallet. AUTH.
 * Returns `{code, wallet, claimedAt}` on 200; throws ApiError 404
 * `referral.not_found` when the user has no handle, 401 when no session.
 */
export function getRefMe() {
  return apiFetch('/ref/me');
}

/**
 * PUT /ref/me — atomically claim/replace the user's handle. AUTH.
 *
 * @param {string|null} code  New code, or `null`/empty to release.
 * @returns {Promise<unknown>} 200 → `{code, wallet, claimedAt}`. 204 → null.
 *   Throws ApiError: 422 `referral.invalid_format`, 422 `referral.reserved`,
 *   409 `referral.taken`, 401 `auth.unauthenticated`.
 */
export function putRefMe(code) {
  return apiFetch('/ref/me', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code ?? null }),
  });
}

/**
 * DELETE /ref/me — release the user's handle (idempotent, 204). AUTH.
 */
export function deleteRefMe() {
  return apiFetch('/ref/me', { method: 'DELETE' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile (PREMIUM)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /profile — portfolio view of the session wallet.
 * @param {{ tradesLimit?: number, tradesCursor?: string }} [opts]
 */
export function getProfile({ tradesLimit, tradesCursor } = {}) {
  return apiFetch(`/profile${buildQuery({ tradesLimit, tradesCursor })}`);
}

/**
 * GET /portfolio — lightweight multi-token positions for the session wallet.
 * PREMIUM. Returns all tokens (country + player) where net wei-position > 0,
 * sorted by `valuePitch` desc. See api-spec §6.2.
 *
 * Response shape (see api-spec §6.2):
 *   { items: [ { token, symbol, kind, balance (wei str), balanceDisplay,
 *                avgEntryPitch (wei str), currentPricePitch (wei str),
 *                valuePitch (wei str), pnlPitch (wei str),
 *                *Display, feesPaidWei, spentBaseWei, receivedBaseWei } ] }
 *
 * Throws ApiError with status 401 (auth.unauthenticated) or 402
 * (access.payment_required).
 */
export function getPortfolio() {
  return apiFetch('/portfolio');
}

// ─────────────────────────────────────────────────────────────────────────────
// Limit orders (PREMIUM)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /orders — list user's limit orders.
 * @param {{ status?: string, token?: string, limit?: number, cursor?: string }} [opts]
 */
export function getOrders({ status, token, limit, cursor } = {}) {
  return apiFetch(`/orders${buildQuery({ status, token, limit, cursor })}`);
}

/**
 * POST /orders — submit a new EIP-712-signed limit order.
 * @param {object} order      The Order struct (fields per eip712.md §3.4).
 * @param {string} signature  0x-prefixed EIP-712 signature.
 */
export function createOrder(order, signature) {
  return apiFetch('/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order, signature }),
  });
}

/**
 * DELETE /orders/:id — cancel a pending order (idempotent — already cancelled → 204).
 * @param {string|number} id
 */
export function cancelOrder(id) {
  return apiFetch(`/orders/${id}`, { method: 'DELETE' });
}

/**
 * PUT /orders/armed — personal kill-switch (true = orders active, false = paused).
 * @param {boolean} armed
 */
export function setArmed(armed) {
  return apiFetch('/orders/armed', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ armed }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram (phase 3 — backend not implemented yet; stubs for forward compat)
// ─────────────────────────────────────────────────────────────────────────────

/** POST /telegram/link-token — request a one-shot deep-link token (phase 3). */
export function requestTelegramLink() {
  return apiFetch('/telegram/link-token', { method: 'POST' });
}

/** DELETE /telegram/link — unlink the Telegram account (phase 3). */
export function unlinkTelegram() {
  return apiFetch('/telegram/link', { method: 'DELETE' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cursor pagination helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk through every page of a cursor-paginated endpoint.
 *
 * Yields each response page (the shape with `items` + `nextCursor`), then
 * stops once `nextCursor` is null/undefined.
 *
 * @example
 *   for await (const page of paginate(getTrades, tokenAddr, { limit: 100 })) {
 *     for (const trade of page.trades.items) process(trade);
 *   }
 *
 * @param {Function} fetcher
 *   The endpoint wrapper. Called as `fetcher(...args, { ...opts, cursor })`.
 * @param {...unknown} args
 *   Positional args for the fetcher followed by `opts` as the last arg
 *   (an object with at minimum optional `cursor`). Pass `{}` if no opts.
 */
export async function* paginate(fetcher, ...args) {
  const opts = args.length > 0 && typeof args[args.length - 1] === 'object' ? args.pop() : {};
  let cursor = opts.cursor;

  while (true) {
    const page = await fetcher(...args, { ...opts, cursor });
    yield page;

    // Pages may either be flat (`{items, nextCursor}`) or nested
    // (`{trades: {items, nextCursor}, ...}` for /tokens/:t/trades).
    const nextCursor = extractNextCursor(page);
    if (!nextCursor) return;
    cursor = nextCursor;
  }
}

/**
 * Extract `nextCursor` from a paginated response, flat or one-level nested.
 * @param {unknown} page
 * @returns {string|null|undefined}
 */
function extractNextCursor(page) {
  if (!page || typeof page !== 'object') return null;
  if ('nextCursor' in page) return page.nextCursor;
  // Look one level down (e.g. `trades.nextCursor` in /tokens/:t/trades).
  for (const v of Object.values(page)) {
    if (v && typeof v === 'object' && 'nextCursor' in v) return v.nextCursor;
  }
  return null;
}
