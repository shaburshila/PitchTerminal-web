/**
 * EIP-712 helpers for limit-order signing — F2.x.
 *
 * Single source of truth: `docs/eip712.md`. The Order type, domain constants,
 * and field order MUST match the Solidity `LimitOrderExecutor` byte-for-byte;
 * any drift here = unverifiable signatures on-chain.
 *
 * This module is intentionally:
 *   - pure (no DOM / network / wagmi);
 *   - dependency-free at runtime (no viem imports — `signTypedData` lives in
 *     a thin wrapper imported lazily by callers, so the helper can be unit-
 *     tested without pulling wagmi).
 *
 * Tests cross-check digests against a fixed fixture identical to the Foundry
 * test in `contracts/test/LimitOrderExecutor.t.sol` (see docs/eip712.md §7).
 *
 * Exports:
 *   - EIP712_DOMAIN_NAME     domain.name constant
 *   - EIP712_DOMAIN_VERSION  domain.version constant
 *   - ORDER_TYPES            viem-shaped `types` map for typedData
 *   - DEFAULT_TTL_PRESETS    UI-friendly expiry options (label + seconds)
 *   - buildOrderTypedData    assemble { domain, types, primaryType, message }
 *   - randomNonce            cryptographic 32-byte hex nonce (0x-prefixed)
 *   - validateOrderShape     throw-on-invalid sanity check (UI-side guard)
 *   - buildSignableOrder     Wave 2A — convert display-space order →
 *                            { signOrder, displayTargetPriceWei }; the keeper
 *                            uses displayTargetPrice (MID) for trigger, the
 *                            contract verifies the signed (ASK/BID) target.
 */

import { displayToExecution } from './lib/fee.js';

/** EIP-712 domain name — see docs/eip712.md §2. */
export const EIP712_DOMAIN_NAME = 'PitchTerminal LimitOrders';

/** EIP-712 domain version — see docs/eip712.md §2. */
export const EIP712_DOMAIN_VERSION = '1';

/**
 * viem-shaped `types` map. Order MUST match the on-chain `ORDER_TYPEHASH`
 * exactly (docs/eip712.md §3.1) — any reordering shifts the typeHash and
 * invalidates every signature.
 */
export const ORDER_TYPES = Object.freeze({
  Order: [
    { name: 'owner', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'quoteToken', type: 'address' },
    { name: 'venue', type: 'uint8' },
    { name: 'side', type: 'uint8' },
    { name: 'targetPrice', type: 'uint256' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'slippageBps', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
});

/**
 * UI-friendly TTL presets — values are seconds; `0` = no expiry. Mirrors
 * `/api/v1/config.limits.limitOrderTtlPresets` so this stays stable when the
 * backend ships the actual values. Kept here so the form has sensible defaults
 * even before /config arrives.
 */
export const DEFAULT_TTL_PRESETS = Object.freeze([
  { label: '1h', seconds: 3600 },
  { label: '24h', seconds: 86400 },
  { label: '7d', seconds: 604800 },
  { label: 'No expiry', seconds: 0 },
]);

const HEX_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Generate a cryptographic 256-bit (32-byte) nonce as a 0x-prefixed hex
 * string. Uses `globalThis.crypto.getRandomValues` — present in every modern
 * browser AND happy-dom (vitest). Falls back to a `Math.random` mix as a last
 * resort with a console.warn (should never trigger in production).
 *
 * @returns {string} 0x + 64 hex chars
 */
export function randomNonce() {
  const buf = new Uint8Array(32);
  const g = /** @type {{ crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } }} */ (
    globalThis
  );
  if (g.crypto && typeof g.crypto.getRandomValues === 'function') {
    g.crypto.getRandomValues(buf);
  } else {
    // Defensive — should not happen on any supported runtime.
    console.warn('eip712: crypto.getRandomValues unavailable, falling back to Math.random');
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  let out = '0x';
  for (let i = 0; i < buf.length; i++) out += buf[i].toString(16).padStart(2, '0');
  return out;
}

/**
 * Throw with a descriptive message if `order` fails basic shape checks. Catches
 * the common mistakes BEFORE we ask the wallet to pop a signing modal:
 *   - missing/invalid addresses (owner / token / quoteToken),
 *   - venue/side out of {0,1},
 *   - targetPrice/amountIn ≤ 0 or non-bigint-coercible,
 *   - slippageBps > 1000 (10% — `MAX_SLIPPAGE_BPS`),
 *   - expiry that already passed (when non-zero),
 *   - nonce not a 32-byte hex string.
 *
 * @param {object} order
 * @param {{ nowSec?: number }} [opts]
 */
export function validateOrderShape(order, opts = {}) {
  if (!order || typeof order !== 'object') {
    throw new TypeError('order must be an object');
  }
  const nowSec = typeof opts.nowSec === 'number' ? opts.nowSec : Math.floor(Date.now() / 1000);
  for (const field of ['owner', 'token', 'quoteToken']) {
    const v = order[field];
    if (typeof v !== 'string' || !HEX_ADDR_RE.test(v)) {
      throw new TypeError(`${field} must be a 0x-prefixed 20-byte address`);
    }
  }
  if (order.venue !== 0 && order.venue !== 1) {
    throw new RangeError('venue must be 0 (player) or 1 (country)');
  }
  if (order.side !== 0 && order.side !== 1) {
    throw new RangeError('side must be 0 (limit-buy) or 1 (take-profit)');
  }
  for (const field of ['targetPrice', 'amountIn']) {
    let n;
    try {
      n = BigInt(order[field]);
    } catch {
      throw new TypeError(`${field} must be a bigint-coercible value`);
    }
    if (n <= 0n) throw new RangeError(`${field} must be > 0`);
  }
  const slip = Number(order.slippageBps);
  if (!Number.isFinite(slip) || slip < 0 || slip > 1000) {
    throw new RangeError('slippageBps must be in [0, 1000]');
  }
  const expiry = Number(order.expiry);
  if (!Number.isFinite(expiry) || expiry < 0) {
    throw new RangeError('expiry must be ≥ 0 (0 = no expiry)');
  }
  if (expiry > 0 && expiry <= nowSec) {
    throw new RangeError('expiry already passed');
  }
  if (typeof order.nonce !== 'string' || !HEX32_RE.test(order.nonce)) {
    throw new TypeError('nonce must be a 32-byte 0x-prefixed hex string');
  }
}

/**
 * Build the viem-compatible typedData object for an Order. Returns a plain
 * structure shaped for `signTypedData({ domain, types, primaryType, message })`.
 *
 * Inputs:
 *   - `order` — the user's order with snake-cased or camel-cased fields. We
 *     accept either input style but emit `camelCase` per docs/eip712.md.
 *   - `executor` — the LimitOrderExecutor address (from /config).
 *   - `chainId` — the chain id (default 8453, Base mainnet).
 *
 * The function does NOT mutate `order`. It coerces uint256 fields to BigInt
 * for viem's typedData encoder (strings/numbers also work via viem coercion,
 * but BigInt is unambiguous and protects against precision loss).
 *
 * @param {object} order
 * @param {string} executor
 * @param {number} [chainId]
 * @returns {{ domain: object, types: object, primaryType: 'Order', message: object }}
 */
export function buildOrderTypedData(order, executor, chainId = 8453) {
  if (!order || typeof order !== 'object') {
    throw new TypeError('order must be an object');
  }
  if (typeof executor !== 'string' || !HEX_ADDR_RE.test(executor)) {
    throw new TypeError('executor must be a 0x-prefixed 20-byte address');
  }
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new RangeError('chainId must be a positive integer');
  }
  // The message uses raw lowercase addresses (viem checksums internally for
  // EIP-55 if needed). Cast uint8 / uint256 fields to BigInt — viem accepts
  // bigint/number/string but we standardize on bigint to avoid 2^53 footguns
  // on `targetPrice`/`amountIn`.
  const message = {
    owner: order.owner,
    token: order.token,
    quoteToken: order.quoteToken,
    venue: Number(order.venue),
    side: Number(order.side),
    targetPrice: BigInt(order.targetPrice),
    amountIn: BigInt(order.amountIn),
    slippageBps: BigInt(order.slippageBps),
    expiry: BigInt(order.expiry),
    // nonce is a 32-byte hex string in EIP-712 land but represented as uint256
    // in the on-chain struct — viem accepts the hex form directly for uint256.
    nonce: BigInt(order.nonce),
  };
  return {
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId,
      verifyingContract: executor,
    },
    types: ORDER_TYPES,
    primaryType: 'Order',
    message,
  };
}

/**
 * Wave 2A — bridge between MID-space user input and execution-space signed
 * target price. Given an order whose `targetPrice` field is a MID-space value
 * (what the user typed, what the chart shows, what the keeper compares
 * against), returns:
 *   - `signOrder`: a shallow copy with `targetPrice` rewritten to the
 *     execution-space (ASK for limit-buy, BID for take-profit) value the
 *     contract verifies under the EIP-712 signature.
 *   - `displayTargetPriceWei`: the original MID-space value as BigInt (echoed
 *     for the POST payload's `displayTargetPrice` field).
 *   - `signedTargetPriceWei`: same as `signOrder.targetPrice`, as BigInt.
 *
 * The function does NOT mutate the input order. Side mapping:
 *   side: 0 → 'limit-buy'   (Buy tab)
 *   side: 1 → 'take-profit' (Sell tab)
 *
 * @param {object} displayOrder  order with MID-space `targetPrice`
 * @returns {{ signOrder: object, displayTargetPriceWei: bigint, signedTargetPriceWei: bigint }}
 */
export function buildSignableOrder(displayOrder) {
  if (!displayOrder || typeof displayOrder !== 'object') {
    throw new TypeError('displayOrder must be an object');
  }
  if (displayOrder.side !== 0 && displayOrder.side !== 1) {
    throw new RangeError('side must be 0 (limit-buy) or 1 (take-profit)');
  }
  let displayWei;
  try {
    displayWei = BigInt(displayOrder.targetPrice);
  } catch {
    throw new TypeError('targetPrice must be a bigint-coercible value');
  }
  if (displayWei <= 0n) {
    throw new RangeError('targetPrice must be > 0');
  }
  const sideName = displayOrder.side === 0 ? 'limit-buy' : 'take-profit';
  const signedWei = displayToExecution(displayWei, sideName);
  const signOrder = { ...displayOrder, targetPrice: signedWei };
  return {
    signOrder,
    displayTargetPriceWei: displayWei,
    signedTargetPriceWei: signedWei,
  };
}

/**
 * Serialize an Order for HTTP transport (`POST /api/v1/orders`).
 *
 * The wire format (api-spec §7.2) expects:
 *   - addresses lowercase 0x-hex,
 *   - venue/side as integers,
 *   - slippageBps/expiry as integers,
 *   - targetPrice/amountIn as decimal STRINGS (api-spec §1.2 wei convention),
 *   - nonce as 0x-prefixed 64-hex string.
 *
 * @param {object} order
 * @returns {object} JSON-safe payload for the `order` field
 */
export function serializeOrder(order) {
  if (!order || typeof order !== 'object') {
    throw new TypeError('order must be an object');
  }
  return {
    owner: String(order.owner).toLowerCase(),
    token: String(order.token).toLowerCase(),
    quoteToken: String(order.quoteToken).toLowerCase(),
    venue: Number(order.venue),
    side: Number(order.side),
    targetPrice: BigInt(order.targetPrice).toString(),
    amountIn: BigInt(order.amountIn).toString(),
    slippageBps: Number(order.slippageBps),
    expiry: Number(order.expiry),
    nonce: String(order.nonce).toLowerCase(),
  };
}
