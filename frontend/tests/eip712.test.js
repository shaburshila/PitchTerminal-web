// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';

import {
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  ORDER_TYPES,
  DEFAULT_TTL_PRESETS,
  buildOrderTypedData,
  buildSignableOrder,
  randomNonce,
  validateOrderShape,
  serializeOrder,
} from '../src/eip712.js';
import { displayToExecution } from '../src/lib/fee.js';

const EXECUTOR = '0xb22f38a0c133a32ab9582ace9e2da41d1738b9d5';
const OWNER = '0x71ecd1a09380ca46cca741bc48d04c556674756f';
const TOKEN = '0x1111111111111111111111111111111111111111';
const QUOTE = '0x2222222222222222222222222222222222222222';
const NONCE = '0x' + 'ab'.repeat(32);

function makeValidOrder(over = {}) {
  return {
    owner: OWNER,
    token: TOKEN,
    quoteToken: QUOTE,
    venue: 0,
    side: 0,
    targetPrice: '12500000000000000000',
    amountIn: '1000000000000000000',
    slippageBps: 100,
    expiry: 0,
    nonce: NONCE,
    ...over,
  };
}

describe('eip712 constants', () => {
  it('domain name + version match the spec', () => {
    expect(EIP712_DOMAIN_NAME).toBe('PitchTerminal LimitOrders');
    expect(EIP712_DOMAIN_VERSION).toBe('1');
  });

  it('ORDER_TYPES field order matches Solidity ORDER_TYPEHASH', () => {
    // Order MUST be:
    //   owner, token, quoteToken, venue, side, targetPrice, amountIn,
    //   slippageBps, expiry, nonce
    const names = ORDER_TYPES.Order.map((f) => f.name);
    expect(names).toEqual([
      'owner',
      'token',
      'quoteToken',
      'venue',
      'side',
      'targetPrice',
      'amountIn',
      'slippageBps',
      'expiry',
      'nonce',
    ]);
    const types = ORDER_TYPES.Order.map((f) => f.type);
    expect(types).toEqual([
      'address',
      'address',
      'address',
      'uint8',
      'uint8',
      'uint256',
      'uint256',
      'uint256',
      'uint256',
      'uint256',
    ]);
  });

  it('DEFAULT_TTL_PRESETS includes no-expiry option', () => {
    const noExpiry = DEFAULT_TTL_PRESETS.find((p) => p.seconds === 0);
    expect(noExpiry).toBeDefined();
    for (const p of DEFAULT_TTL_PRESETS) {
      expect(typeof p.label).toBe('string');
      expect(Number.isFinite(p.seconds)).toBe(true);
      expect(p.seconds).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('randomNonce', () => {
  it('returns 0x + 64 hex chars', () => {
    const n = randomNonce();
    expect(n).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('produces unique values on successive calls', () => {
    const a = randomNonce();
    const b = randomNonce();
    expect(a).not.toBe(b);
  });
});

describe('buildOrderTypedData', () => {
  it('builds a complete EIP-712 typedData object', () => {
    const order = makeValidOrder();
    const td = buildOrderTypedData(order, EXECUTOR, 8453);
    expect(td.primaryType).toBe('Order');
    expect(td.types).toBe(ORDER_TYPES);
    expect(td.domain).toEqual({
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: 8453,
      verifyingContract: EXECUTOR,
    });
    // Numeric fields coerced to BigInt for safety.
    expect(typeof td.message.targetPrice).toBe('bigint');
    expect(typeof td.message.amountIn).toBe('bigint');
    expect(typeof td.message.slippageBps).toBe('bigint');
    expect(typeof td.message.expiry).toBe('bigint');
    expect(typeof td.message.nonce).toBe('bigint');
    // venue/side are uint8 — viem accepts plain numbers.
    expect(td.message.venue).toBe(0);
    expect(td.message.side).toBe(0);
    expect(td.message.targetPrice).toBe(12500000000000000000n);
    expect(td.message.amountIn).toBe(1000000000000000000n);
    expect(td.message.nonce).toBe(BigInt(NONCE));
  });

  it('defaults chainId to 8453', () => {
    const td = buildOrderTypedData(makeValidOrder(), EXECUTOR);
    expect(td.domain.chainId).toBe(8453);
  });

  it('rejects invalid executor address', () => {
    expect(() => buildOrderTypedData(makeValidOrder(), '0xnope')).toThrow(/executor/);
  });

  it('rejects non-positive chainId', () => {
    expect(() => buildOrderTypedData(makeValidOrder(), EXECUTOR, 0)).toThrow(/chainId/);
  });

  it('rejects non-object order', () => {
    expect(() => buildOrderTypedData(null, EXECUTOR)).toThrow(/order/);
  });
});

describe('validateOrderShape', () => {
  it('accepts a well-formed order', () => {
    expect(() => validateOrderShape(makeValidOrder())).not.toThrow();
  });

  it('rejects invalid addresses', () => {
    expect(() => validateOrderShape(makeValidOrder({ owner: '0xshort' }))).toThrow(/owner/);
    expect(() => validateOrderShape(makeValidOrder({ token: 'not-hex' }))).toThrow(/token/);
    expect(() => validateOrderShape(makeValidOrder({ quoteToken: '' }))).toThrow(/quoteToken/);
  });

  it('rejects out-of-range venue/side', () => {
    expect(() => validateOrderShape(makeValidOrder({ venue: 2 }))).toThrow(/venue/);
    expect(() => validateOrderShape(makeValidOrder({ side: -1 }))).toThrow(/side/);
  });

  it('rejects non-positive targetPrice / amountIn', () => {
    expect(() => validateOrderShape(makeValidOrder({ targetPrice: 0 }))).toThrow(/targetPrice/);
    expect(() => validateOrderShape(makeValidOrder({ amountIn: '0' }))).toThrow(/amountIn/);
  });

  it('caps slippageBps at 1000', () => {
    expect(() => validateOrderShape(makeValidOrder({ slippageBps: 1001 }))).toThrow(/slippage/);
    expect(() => validateOrderShape(makeValidOrder({ slippageBps: 1000 }))).not.toThrow();
  });

  it('rejects already-passed expiry', () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    expect(() => validateOrderShape(makeValidOrder({ expiry: past }))).toThrow(/expiry/);
  });

  it('accepts expiry=0 (no expiry)', () => {
    expect(() => validateOrderShape(makeValidOrder({ expiry: 0 }))).not.toThrow();
  });

  it('rejects malformed nonce', () => {
    expect(() => validateOrderShape(makeValidOrder({ nonce: '0xbeef' }))).toThrow(/nonce/);
    expect(() => validateOrderShape(makeValidOrder({ nonce: 123 }))).toThrow(/nonce/);
  });
});

describe('buildSignableOrder', () => {
  const WEI = 10n ** 18n;

  it('limit-buy (side=0): signed target = display × 10000 / 9500 (ASK)', () => {
    const order = makeValidOrder({ side: 0, targetPrice: 10n * WEI });
    const { signOrder, displayTargetPriceWei, signedTargetPriceWei } = buildSignableOrder(order);
    expect(displayTargetPriceWei).toBe(10n * WEI);
    expect(signedTargetPriceWei).toBe(displayToExecution(10n * WEI, 'limit-buy'));
    expect(signOrder.targetPrice).toBe(signedTargetPriceWei);
    // Sanity: signed > display for buys.
    expect(signedTargetPriceWei > displayTargetPriceWei).toBe(true);
  });

  it('take-profit (side=1): signed target = display × 9500 / 10000 (BID)', () => {
    const order = makeValidOrder({ side: 1, targetPrice: 10n * WEI });
    const { signOrder, displayTargetPriceWei, signedTargetPriceWei } = buildSignableOrder(order);
    expect(displayTargetPriceWei).toBe(10n * WEI);
    expect(signedTargetPriceWei).toBe(displayToExecution(10n * WEI, 'take-profit'));
    expect(signOrder.targetPrice).toBe(signedTargetPriceWei);
    // Sanity: signed < display for sells.
    expect(signedTargetPriceWei < displayTargetPriceWei).toBe(true);
  });

  it('does not mutate the input order', () => {
    const order = makeValidOrder({ side: 0, targetPrice: 10n * WEI });
    const before = { ...order };
    buildSignableOrder(order);
    expect(order).toEqual(before);
  });

  it('preserves all non-target fields verbatim', () => {
    const order = makeValidOrder({ side: 0, targetPrice: 10n * WEI, slippageBps: 200 });
    const { signOrder } = buildSignableOrder(order);
    expect(signOrder.owner).toBe(order.owner);
    expect(signOrder.token).toBe(order.token);
    expect(signOrder.quoteToken).toBe(order.quoteToken);
    expect(signOrder.venue).toBe(order.venue);
    expect(signOrder.side).toBe(order.side);
    expect(signOrder.amountIn).toBe(order.amountIn);
    expect(signOrder.slippageBps).toBe(200);
    expect(signOrder.expiry).toBe(order.expiry);
    expect(signOrder.nonce).toBe(order.nonce);
  });

  it('rejects invalid side', () => {
    expect(() => buildSignableOrder(makeValidOrder({ side: 2 }))).toThrow(/side/);
  });

  it('rejects non-positive targetPrice', () => {
    expect(() => buildSignableOrder(makeValidOrder({ targetPrice: 0 }))).toThrow(/targetPrice/);
    expect(() => buildSignableOrder(makeValidOrder({ targetPrice: '-1' }))).toThrow(/targetPrice/);
  });

  it('rejects non-object input', () => {
    expect(() => buildSignableOrder(null)).toThrow(/displayOrder/);
  });
});

describe('serializeOrder', () => {
  it('emits wire-format payload (wei as strings, lowercase addresses)', () => {
    const order = makeValidOrder({
      owner: OWNER.toUpperCase(),
      targetPrice: 12500000000000000000n,
      amountIn: 1000000000000000000n,
    });
    const out = serializeOrder(order);
    expect(out.owner).toBe(OWNER.toLowerCase());
    expect(typeof out.targetPrice).toBe('string');
    expect(out.targetPrice).toBe('12500000000000000000');
    expect(typeof out.amountIn).toBe('string');
    expect(out.amountIn).toBe('1000000000000000000');
    expect(out.slippageBps).toBe(100);
    expect(out.expiry).toBe(0);
    expect(out.nonce).toBe(NONCE);
    expect(out.venue).toBe(0);
    expect(out.side).toBe(0);
  });
});
