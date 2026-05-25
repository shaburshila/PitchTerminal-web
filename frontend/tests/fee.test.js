// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';

import {
  FEE_BPS,
  FEE_FACTOR_NUMERATOR,
  FEE_FACTOR_DENOMINATOR,
  applyFeeToNaiveAmount,
  displayToExecution,
  executionToDisplay,
  feeBps,
} from '../src/lib/fee.js';

const WEI = 10n ** 18n;

describe('fee constants', () => {
  it('matches the hardcoded 5% pitchwc fee', () => {
    expect(FEE_BPS).toBe(500);
    expect(FEE_FACTOR_NUMERATOR).toBe(9500);
    expect(FEE_FACTOR_DENOMINATOR).toBe(10_000);
    expect(feeBps()).toBe(500);
  });
});

describe('displayToExecution', () => {
  it('limit-buy: signed ASK = display / 0.95', () => {
    // display = 10 (MID) → signed = 10 × 10000 / 9500 ≈ 10.5263…
    const signed = displayToExecution(10n * WEI, 'limit-buy');
    // 10 × 10000 / 9500 = 100000 / 9500 = 10.526315789473684210…
    // BigInt floor: (10 × 10000 × 1e18) / 9500
    const expected = (10n * 10000n * WEI) / 9500n;
    expect(signed).toBe(expected);
    // Sanity: > display.
    expect(signed > 10n * WEI).toBe(true);
  });

  it('take-profit: signed BID = display × 0.95', () => {
    const signed = displayToExecution(10n * WEI, 'take-profit');
    const expected = (10n * WEI * 9500n) / 10000n;
    expect(signed).toBe(expected);
    // Sanity: < display.
    expect(signed < 10n * WEI).toBe(true);
    expect(signed).toBe((10n * WEI * 95n) / 100n);
  });

  it('buy and sell are asymmetric (different signed prices for same display)', () => {
    const display = 10n * WEI;
    const buy = displayToExecution(display, 'limit-buy');
    const sell = displayToExecution(display, 'take-profit');
    expect(buy).not.toBe(sell);
    expect(buy > display).toBe(true);
    expect(sell < display).toBe(true);
  });

  it('accepts bigint, string, and number inputs', () => {
    const ref = displayToExecution(10n * WEI, 'limit-buy');
    expect(displayToExecution((10n * WEI).toString(), 'limit-buy')).toBe(ref);
    // Small Number-safe input — keep <2^53.
    const numInput = 1_000_000;
    const fromNumber = displayToExecution(numInput, 'limit-buy');
    const fromBig = displayToExecution(BigInt(numInput), 'limit-buy');
    expect(fromNumber).toBe(fromBig);
  });

  it('handles large uint256-scale values without overflow', () => {
    // 10^28 wei is well within uint256 (max ~1.15e77).
    const huge = 10n ** 28n;
    const signed = displayToExecution(huge, 'limit-buy');
    expect(signed).toBe((huge * 10000n) / 9500n);
    expect(signed > huge).toBe(true);
  });

  it('rejects zero / negative / non-numeric inputs', () => {
    expect(() => displayToExecution(0n, 'limit-buy')).toThrow(/displayWei/);
    expect(() => displayToExecution(-1n, 'limit-buy')).toThrow(/displayWei/);
    expect(() => displayToExecution('0', 'limit-buy')).toThrow(/displayWei/);
    expect(() => displayToExecution('not-a-number', 'limit-buy')).toThrow(/displayWei/);
    expect(() => displayToExecution({}, 'limit-buy')).toThrow(/displayWei/);
  });

  it('rejects unknown side strings', () => {
    expect(() => displayToExecution(1n * WEI, 'buy')).toThrow(/side/);
    expect(() => displayToExecution(1n * WEI, '')).toThrow(/side/);
  });
});

describe('executionToDisplay', () => {
  it('round-trips within ±1 wei for limit-buy (floor drift)', () => {
    for (const display of [
      1n * WEI,
      10n * WEI,
      123n * WEI,
      1n,
      10n ** 24n,
      (10n * WEI * 9500n) / 10000n + 7n,
    ]) {
      const signed = displayToExecution(display, 'limit-buy');
      const back = executionToDisplay(signed, 'limit-buy');
      // floor drift ≤ 1 wei (two floor ops, one in each direction).
      const drift = display > back ? display - back : back - display;
      expect(drift <= 1n).toBe(true);
    }
  });

  it('round-trips within ±1 wei for take-profit', () => {
    for (const display of [1n * WEI, 10n * WEI, 9999n * WEI, 10n ** 24n]) {
      const signed = displayToExecution(display, 'take-profit');
      const back = executionToDisplay(signed, 'take-profit');
      const drift = display > back ? display - back : back - display;
      expect(drift <= 1n).toBe(true);
    }
  });

  it('rejects bad inputs identically to displayToExecution', () => {
    expect(() => executionToDisplay(0n, 'limit-buy')).toThrow(/executionWei/);
    expect(() => executionToDisplay(-5n, 'take-profit')).toThrow(/executionWei/);
    expect(() => executionToDisplay(1n, 'invalid')).toThrow(/side/);
  });
});

describe('applyFeeToNaiveAmount', () => {
  it('returns net = 95% of naive, fee = 5% of naive (exact under integer math)', () => {
    const { net, fee, naive } = applyFeeToNaiveAmount(1n * WEI);
    expect(naive).toBe(1n * WEI);
    expect(net).toBe((1n * WEI * 9500n) / 10000n);
    expect(fee).toBe(naive - net);
    // Identity preserved exactly:
    expect(net + fee).toBe(naive);
  });

  it('handles small values without precision loss', () => {
    // 100 wei × 9500 / 10000 = 95 wei
    const { net, fee, naive } = applyFeeToNaiveAmount(100n);
    expect(net).toBe(95n);
    expect(fee).toBe(5n);
    expect(naive).toBe(100n);
  });

  it('rejects zero / negative input', () => {
    expect(() => applyFeeToNaiveAmount(0n)).toThrow(/naiveWei/);
    expect(() => applyFeeToNaiveAmount(-100n)).toThrow(/naiveWei/);
  });
});
