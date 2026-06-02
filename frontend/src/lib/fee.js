/**
 * pitchwc protocol fee helpers — Wave 2A.
 *
 * The pitchwc Hook applies a flat 5% fee on either side of a swap. The chart
 * shows the fee-free MID price (= `Hook.currentPrice`), but the actual rate a
 * buyer pays / a seller receives is offset by the fee:
 *
 *   MID = Hook.currentPrice                     (fee-free, chart-space)
 *   ASK = MID / (1 - feeBps/10000)              (what a buyer pays per base)
 *   BID = MID × (1 - feeBps/10000)              (what a seller receives)
 *
 * The keeper (B2.3) compares MID against `display_target_price`. The contract
 * verifies the swap rate against the SIGNED `targetPrice`, which lives in the
 * "execution space" (ASK for limit-buy, BID for take-profit). This module is
 * the single converter between the two spaces — every other caller MUST funnel
 * through `displayToExecution` / `executionToDisplay` rather than open-coding
 * the 9500/10000 math.
 *
 * Number policy: BigInt throughout. `wei` arguments are uint256-sized integers
 * (18-decimal fixed point downstream). Number → loses precision past 2^53; we
 * never accept floats here, even for the bps factor.
 *
 * Fee source: the backend serves the fee via `/api/v1/config.feeBps`, seeded
 * into `config-store` on bootstrap. We read it at CALL TIME (never freeze it at
 * module-load) via `feeBps()` so the converters pick up the configured value
 * once /config has loaded. Until then `config-store.getFeeBps()` returns its
 * 500 (5%) pre-bootstrap default, so callers are always safe. The magic 5%
 * still lives in exactly one place (config-store's default) — touch nowhere
 * else.
 */

import { getFeeBps } from '../config-store.js';

/** Denominator of the fee factor. Fixed at 10_000 to match basis-point math. */
export const FEE_FACTOR_DENOMINATOR = 10_000;

const DENOMINATOR_BIG = BigInt(FEE_FACTOR_DENOMINATOR);

/**
 * Live fee factor numerator: (10000 - feeBps). For 5% → 9500. Computed per call
 * from the config-store so a configured fee takes effect without a reload.
 *
 * @returns {bigint}
 */
function numeratorBig() {
  return BigInt(FEE_FACTOR_DENOMINATOR - getFeeBps());
}

/**
 * Coerce a wei input to BigInt and assert it's strictly positive. Mirrors the
 * "no float wei" rule from trade-panel.parseAmountToWei — we never want a
 * Number > 2^53 silently quantized before reaching the math here.
 *
 * @param {bigint|string|number} value
 * @param {string} label  used in the thrown error message
 * @returns {bigint}
 */
function coercePositiveWei(value, label) {
  if (typeof value === 'bigint') {
    if (value <= 0n) {
      throw new RangeError(`${label} must be > 0`);
    }
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    let big;
    try {
      big = BigInt(value);
    } catch {
      throw new TypeError(`${label} must be a bigint-coercible value`);
    }
    if (big <= 0n) {
      throw new RangeError(`${label} must be > 0`);
    }
    return big;
  }
  throw new TypeError(`${label} must be a bigint, string, or number`);
}

function assertSide(side) {
  if (side !== 'limit-buy' && side !== 'take-profit') {
    throw new RangeError(`side must be "limit-buy" or "take-profit" (got ${side})`);
  }
}

/**
 * Convert a user-displayed MID-space target price into the execution-space
 * value that gets signed in the EIP-712 message.
 *
 * For `limit-buy` (the user is buying base, paying with quote):
 *   execution = display × 10000 / (10000 - feeBps) = display × 10000 / 9500
 *   (= the ASK price; what the buyer actually pays per base token)
 *
 * For `take-profit` (the user is selling base, receiving quote):
 *   execution = display × (10000 - feeBps) / 10000 = display × 9500 / 10000
 *   (= the BID price; what the seller actually receives per base token)
 *
 * Integer floor division (BigInt) — matches Solidity's `mulDiv` behaviour and
 * is deterministic for HALF-DOWN rounding regardless of locale/runtime.
 *
 * @param {bigint|string|number} displayWei  MID-space wei (must be > 0)
 * @param {'limit-buy' | 'take-profit'} side
 * @returns {bigint} execution-space wei (ASK for buy, BID for sell)
 */
export function displayToExecution(displayWei, side) {
  assertSide(side);
  const value = coercePositiveWei(displayWei, 'displayWei');
  const num = numeratorBig();
  if (side === 'limit-buy') {
    // ASK = display / 0.95 = display × 10000 / 9500
    return (value * DENOMINATOR_BIG) / num;
  }
  // BID = display × 0.95 = display × 9500 / 10000
  return (value * num) / DENOMINATOR_BIG;
}

/**
 * Inverse of `displayToExecution`. Convert an execution-space (signed) target
 * back into the MID-space value the user sees on the chart.
 *
 * For `limit-buy`:  display = execution × 9500 / 10000
 * For `take-profit`: display = execution × 10000 / 9500
 *
 * Round-trip `displayToExecution(displayToExecution(X, s), s)` is NOT
 * guaranteed to return X exactly because each operation floors — but the drift
 * is bounded by 1 wei per direction (typically zero for human-scale inputs).
 * Callers that need exact round-trip should keep the original `displayWei`.
 *
 * @param {bigint|string|number} executionWei
 * @param {'limit-buy' | 'take-profit'} side
 * @returns {bigint} MID-space wei
 */
export function executionToDisplay(executionWei, side) {
  assertSide(side);
  const value = coercePositiveWei(executionWei, 'executionWei');
  const num = numeratorBig();
  if (side === 'limit-buy') {
    return (value * num) / DENOMINATOR_BIG;
  }
  return (value * DENOMINATOR_BIG) / num;
}

/**
 * Apply the fee to a "naive amount" (the amount the user would receive if the
 * Hook charged zero fee). Returns the net (post-fee) amount, the fee that was
 * deducted, and the naive amount echoed back — all in the receiving token's
 * wei.
 *
 *   net   = naive × (10000 - feeBps) / 10000
 *   fee   = naive - net    (NOT naive × feeBps / 10000 directly — keeps
 *                            `net + fee === naive` exact under integer math)
 *
 * Worked example (5% fee):
 *   naive = 1e18 (= 1.0)
 *   net   = 1e18 × 9500 / 10000 = 9.5e17 (= 0.95)
 *   fee   = 1e18 - 9.5e17 = 5e16 (= 0.05)
 *
 * @param {bigint|string|number} naiveWei  must be > 0
 * @returns {{ net: bigint, fee: bigint, naive: bigint }}
 */
export function applyFeeToNaiveAmount(naiveWei) {
  const naive = coercePositiveWei(naiveWei, 'naiveWei');
  const net = (naive * numeratorBig()) / DENOMINATOR_BIG;
  const fee = naive - net;
  return { net, fee, naive };
}

/**
 * The live pitchwc fee in basis points, for callers that want to render it
 * without computing the fee themselves. e.g. UI breakdown text:
 *   `pitchwc fee: ${(feeBps() / 100).toFixed(1)}%`
 *
 * Reads from `config-store` at call time, so it reflects the configured fee
 * once /config has loaded (500 default before then). Always < 2^53.
 *
 * @returns {number} fee bps as a plain number
 */
export function feeBps() {
  return getFeeBps();
}
