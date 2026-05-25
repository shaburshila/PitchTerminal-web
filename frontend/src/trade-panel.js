/**
 * Trade panel (Market) — F1.1 + F1.2 + F1.3.
 *
 * Right-column market-trade widget. Implements:
 *   - Toggle Market / Limit (Limit disabled — phase 2)
 *   - Buy / Sell tabs
 *   - amount input + 25/50/75/Max quick-fill buttons (from balance)
 *   - slippage input (default 1%)
 *   - live quote via viem `readContract` against pitchwc Hook (quoteBuy/Sell)
 *   - fee breakdown (5% pitchwc + slippage)
 *   - disabled state when not on Base / wallet disconnected / no token
 *   - F1.2: allowance read against the matching Router, "Approve" CTA when
 *     allowance < amountIn, max-approve write tx, swap (`buy`/`sell`) via the
 *     Router, pending → success/error toast, balance + quote refresh on
 *     success.
 *   - F1.3: player+Buy UX — explicit "required <X> <country>" hint, balance
 *     line shows country symbol, "insufficient country" CTA labels the
 *     missing country amount and exposes a "Купить country" shortcut that
 *     hops the sidebar selection to the country token row. Country symbols
 *     come from a one-shot `getTokens()` fetch at mount (cached map);
 *     unresolved addresses fall back to `0xcccc…0001` short-form.
 *
 * Venue resolution:
 *   - token has `countryAddress` (truthy)  → player venue, hook = playerHook,
 *     quoteToken = countryAddress,  baseToken = token.address
 *   - otherwise                            → country venue, hook = countryHook,
 *     quoteToken = PITCH,           baseToken = token.address
 *
 * Router resolution (F1.2):
 *   - player venue → `contracts.playerRouter`
 *   - country venue → `contracts.countryRouter`
 *   Router signature (see docs/eip712.md §6, lines 328-336):
 *     `function buy(address token, uint256 amountIn, uint256 minOut)`
 *     `function sell(address token, uint256 amountIn, uint256 minOut)`
 *   `token` here is the *traded* (player/country) token, identical to the
 *   Hook's `quoteBuy/Sell` first arg.
 *
 * Mount contract follows the rest of the codebase (build-once DOM, hidden
 * toggle for tabs, `state.loading` guard, returned handle for destroy/re-wire).
 *
 * Payment seam (F1.2): tests inject `options.payment` — a small object with
 * `readAllowance`, `approve`, `swap` — mirroring the access.js pattern. Prod
 * lazily builds a wagmi/viem-backed client on first use of the CTA.
 */

import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

import * as defaultApi from './api.js';
import { getAccount, onAccountChange, BASE_CHAIN_ID } from './wallet.js';
import { showToast } from './ui/toast.js';
import { get as getAccessState, subscribe as subscribeAccessState } from './access-store.js';
import {
  DEFAULT_TTL_PRESETS as TTL_PRESETS,
  buildOrderTypedData,
  buildSignableOrder,
  randomNonce,
  serializeOrder,
  validateOrderShape,
} from './eip712.js';
import { applyFeeToNaiveAmount, FEE_BPS as PITCHWC_FEE_BPS_FROM_LIB } from './lib/fee.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const QUOTE_DEBOUNCE_MS = 400;
const DEFAULT_SLIPPAGE_PCT = 1.0;
const MAX_SLIPPAGE_PCT = 10.0; // matches LimitOrderExecutor MAX_SLIPPAGE_BPS = 1000
// pitchwc 5% — informational. The Hook quote already nets it out for market
// trades; for limit orders we use it to display a breakdown alongside the user
// input. Funnelled through lib/fee.js so we only have ONE place that knows the
// magic 500.
const PITCHWC_FEE_BPS = PITCHWC_FEE_BPS_FROM_LIB;

// F2.x — limit-order defaults. The TTL preset list lives in `eip712.js` so the
// unit tests can verify the canonical shape; we only re-export the default
// selection (1h, conservative for first-time users).
const DEFAULT_TTL_SECONDS = 3600;

const TABS = Object.freeze(['buy', 'sell']);

// Minimal ABIs — kept inline rather than pulling /abis JSON files so the
// component is self-contained and tree-shake friendly. These match the
// signatures in docs/eip712.md §4.
const HOOK_ABI = [
  {
    type: 'function',
    name: 'quoteBuy',
    stateMutability: 'view',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'quoteIn', type: 'uint256' },
    ],
    outputs: [{ name: 'baseOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'quoteSell',
    stateMutability: 'view',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'baseIn', type: 'uint256' },
    ],
    outputs: [{ name: 'quoteOut', type: 'uint256' }],
  },
];

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
];

// Router (pitchwc) ABI — signatures from docs/eip712.md §6.
const ROUTER_ABI = [
  {
    type: 'function',
    name: 'buy',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'minOut', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'sell',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'minOut', type: 'uint256' },
    ],
    outputs: [],
  },
];

// Max-uint256 — approve-once UX (no re-approve on every trade).
export const MAX_UINT256 = (1n << 256n) - 1n;

// ─── Pure helpers (exported for unit tests) ─────────────────────────────────

/**
 * Convert a human-readable amount string (e.g. "1.5") to wei (BigInt, 18 dec).
 * Returns null on malformed/negative input. Truncates beyond 18 fractional
 * digits — no rounding (matches viem's `parseUnits` behaviour for valid input
 * but stays dependency-free for the parser).
 *
 * @param {string|number|null|undefined} value
 * @returns {bigint|null}
 */
export function parseAmountToWei(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (raw === '') return null;
  // Accept "1", "1.5", "0.000001", ".5". Reject anything else.
  // Authoritative filter: requires at least one digit on either side of the
  // optional decimal point — rejects "", "." inherently.
  if (!/^(\d+\.?\d*|\.\d+)$/.test(raw)) return null;
  const [intPart, fracPart = ''] = raw.split('.');
  const intStr = intPart === '' ? '0' : intPart;
  const fracTrimmed = fracPart.slice(0, 18).padEnd(18, '0');
  try {
    const wei = BigInt(intStr) * 10n ** 18n + BigInt(fracTrimmed || '0');
    return wei;
  } catch {
    return null;
  }
}

/**
 * Format a wei BigInt as a human-readable 18-decimal string. Strips trailing
 * zeros from the fractional part; returns "0" for 0n. Negative inputs (which
 * shouldn't appear for balances/quotes) get a leading "-".
 *
 * @param {bigint|null|undefined} wei
 * @param {number} [maxFractionalDigits] truncate fractional digits to this
 *                                       (after stripping trailing zeros).
 * @returns {string}
 */
export function formatWei(wei, maxFractionalDigits = 6) {
  if (wei == null) return '';
  if (typeof wei !== 'bigint') return '';
  if (wei === 0n) return '0';
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const intPart = abs / 10n ** 18n;
  const fracPart = abs % 10n ** 18n;
  let frac = fracPart.toString().padStart(18, '0');
  // Truncate to N digits, then strip trailing zeros.
  if (maxFractionalDigits >= 0 && maxFractionalDigits < 18) {
    frac = frac.slice(0, maxFractionalDigits);
  }
  frac = frac.replace(/0+$/, '');
  const body = frac ? `${intPart}.${frac}` : intPart.toString();
  return neg ? `-${body}` : body;
}

/**
 * Compute amount = balance * percent / 100 (integer math on wei).
 *
 * @param {bigint} balanceWei
 * @param {number} percent  one of 25 / 50 / 75 / 100
 * @returns {bigint}
 */
export function percentOfBalance(balanceWei, percent) {
  if (typeof balanceWei !== 'bigint' || balanceWei < 0n) return 0n;
  const p = Number(percent);
  if (!Number.isFinite(p) || p <= 0) return 0n;
  // Clamp to [0, 100].
  const clamped = Math.min(100, Math.max(0, p));
  // Use bigint maths — multiply first then divide.
  return (balanceWei * BigInt(Math.round(clamped * 100))) / 10000n;
}

/**
 * Apply slippage to a quoted output. minOut = quoteOut * (10000 - slippageBps) / 10000.
 *
 * @param {bigint} quoteOutWei
 * @param {number} slippagePct  e.g. 1.0 for 1%
 * @returns {bigint}
 */
export function applySlippage(quoteOutWei, slippagePct) {
  if (typeof quoteOutWei !== 'bigint' || quoteOutWei <= 0n) return 0n;
  const pct = Number(slippagePct);
  if (!Number.isFinite(pct) || pct < 0) return quoteOutWei;
  const clamped = Math.min(MAX_SLIPPAGE_PCT, Math.max(0, pct));
  const slippageBps = BigInt(Math.round(clamped * 100));
  if (slippageBps >= 10000n) return 0n;
  return (quoteOutWei * (10000n - slippageBps)) / 10000n;
}

/**
 * Resolve venue + token addresses for a given selected token.
 *
 * @param {object|null} token   token row from /tokens (has address, optional countryAddress)
 * @param {string|null} pitchAddr  PITCH ERC20 address (from /config)
 * @returns {{ venue: 'player'|'country', baseToken: string, quoteToken: string }|null}
 */
export function resolveVenue(token, pitchAddr) {
  if (!token || typeof token.address !== 'string') return null;
  const base_ = token.address.toLowerCase();
  if (typeof token.countryAddress === 'string' && token.countryAddress) {
    return {
      venue: 'player',
      baseToken: base_,
      quoteToken: token.countryAddress.toLowerCase(),
    };
  }
  if (typeof pitchAddr !== 'string' || !pitchAddr) return null;
  return {
    venue: 'country',
    baseToken: base_,
    quoteToken: pitchAddr.toLowerCase(),
  };
}

/**
 * Reason string for a disabled trade button, or null if enabled.
 * Order matters — first hit wins. F1.2 added approvePending / swapPending
 * branches; they take precedence over insufficient-balance so the user always
 * sees the in-flight tx state rather than getting bumped back to an earlier
 * reason if their balance briefly drops mid-tx (e.g. post-approve gas spend).
 *
 * F1.3: when `playerBuy` is true (player venue + Buy side) AND the balance
 * shortfall fires, the message is rewritten to spell out the missing country
 * amount + nudge towards the Country panel. The branch sits at the SAME
 * priority as the generic insufficient-balance check (just specialises the
 * text) — pending flags still win above.
 *
 * @param {{
 *   walletConnected: boolean,
 *   chainId: number|null,
 *   token: object|null,
 *   contractsReady: boolean,
 *   amountWei: bigint|null,
 *   balanceWei: bigint|null,
 *   limitMode: boolean,
 *   approvePending?: boolean,
 *   swapPending?: boolean,
 *   allowanceLoading?: boolean,
 *   playerBuy?: boolean,
 *   countrySymbol?: string|null,
 * }} ctx
 * @returns {string|null}
 */
export function disabledReason(ctx) {
  if (ctx.limitMode) return 'Limit orders — phase 2';
  if (ctx.approvePending) return 'Confirm approve in wallet…';
  if (ctx.swapPending) return 'Awaiting swap confirmation…';
  if (!ctx.walletConnected) return 'Connect wallet';
  if (ctx.chainId !== BASE_CHAIN_ID) return 'Switch to Base';
  if (!ctx.token) return 'Select a token';
  if (!ctx.contractsReady) return 'Loading config…';
  if (!ctx.amountWei || ctx.amountWei <= 0n) return 'Enter amount';
  if (ctx.balanceWei != null && ctx.amountWei > ctx.balanceWei) {
    if (ctx.playerBuy) {
      const sym = ctx.countrySymbol || 'country';
      const need = formatWei(ctx.amountWei, 6);
      return `Required: ${need} ${sym}. Buy it on the Country panel.`;
    }
    return 'Insufficient balance';
  }
  // F1.2 fix: while allowance is being read we can't decide approve-vs-swap.
  // Block the CTA to prevent a null-allowance race where the user clicks
  // "Buy" before refreshAllowance resolves and the swap reverts on ERC20
  // transferFrom. Sits below balance check so the more informative
  // "Insufficient balance" still wins; sits below pending flags so an
  // in-flight tx label keeps priority.
  if (ctx.allowanceLoading) return 'Checking allowance…';
  return null;
}

// ─── F2.x — limit-order CTA disabled reason ─────────────────────────────────

/**
 * Reason string for disabling the limit-order submit CTA, or null if enabled.
 * Limit mode shares the EIP-712 sign-and-POST flow with the keeper, which
 * later calls `execute()` on the user's behalf. For that call to succeed the
 * executor needs an ERC20 allowance on the *spending* token (different
 * spender than the market router) — otherwise the keeper's pre-flight
 * `eth_call` reverts and the order ends up in `failed`. Wave 3 hotfix added
 * the `approvePending` / `allowanceLoading` branches so the CTA mirrors the
 * market-mode F1.2 pattern.
 *
 * Order matters — first hit wins. `submitting` / `approvePending` take top
 * priority so an in-flight signature / approve always shows the in-flight
 * label.
 *
 * @param {{
 *   walletConnected: boolean,
 *   chainId: number|null,
 *   token: object|null,
 *   contractsReady: boolean,
 *   executorReady: boolean,
 *   amountWei: bigint|null,
 *   triggerPriceWei: bigint|null,
 *   slippageBps: number,
 *   premium: boolean,
 *   submitting?: boolean,
 *   approvePending?: boolean,
 *   allowanceLoading?: boolean,
 * }} ctx
 * @returns {string|null}
 */
export function disabledReasonLimit(ctx) {
  if (ctx.submitting) return 'Signing limit order…';
  if (ctx.approvePending) return 'Confirm approve in wallet…';
  if (!ctx.walletConnected) return 'Connect wallet';
  if (ctx.chainId !== BASE_CHAIN_ID) return 'Switch to Base';
  if (!ctx.premium) return 'Premium feature';
  if (!ctx.token) return 'Select a token';
  if (!ctx.contractsReady) return 'Loading config…';
  if (!ctx.executorReady) return 'Limit-order contract unavailable';
  if (!ctx.amountWei || ctx.amountWei <= 0n) return 'Enter amount';
  if (!ctx.triggerPriceWei || ctx.triggerPriceWei <= 0n) return 'Enter trigger price';
  if (typeof ctx.slippageBps === 'number' && (ctx.slippageBps < 0 || ctx.slippageBps > 1000)) {
    return 'Slippage must be ≤ 10%';
  }
  // Wave 3 — keeper requires the executor allowance to be ≥ amountIn. Block
  // the CTA while we're reading it (race with mode toggle / token switch);
  // the actual `< amountIn` branch is handled by `renderLimitCta` directly
  // since it needs to swap the label to "Approve" rather than disable.
  if (ctx.allowanceLoading) return 'Checking allowance…';
  return null;
}

/**
 * Wave 3 hotfix — resolve the ERC20 the user must approve and the spender
 * that will pull the funds, for a limit order. Unlike the market flow, the
 * spender is the LimitOrderExecutor contract (not the per-venue router):
 *
 *   - limit-buy (side=0): user spends the QUOTE token. Player venue →
 *     country token; country venue → PITCH.
 *   - take-profit (side=1): user spends the BASE token (the player or
 *     country token they're selling).
 *
 * Returns null when the executor address or venue is missing so callers can
 * gracefully no-op (CTA stays disabled via `executorReady`/`token` checks).
 *
 * @param {{
 *   side: 'buy'|'sell',
 *   venue: { baseToken: string, quoteToken: string }|null,
 *   executor: string|null|undefined,
 * }} ctx
 * @returns {{ spendingToken: string, spender: string }|null}
 */
export function resolveLimitSpenderAndToken(ctx) {
  if (!ctx || !ctx.venue || typeof ctx.executor !== 'string' || !ctx.executor) return null;
  const spender = ctx.executor.toLowerCase();
  const spendingToken = ctx.side === 'buy' ? ctx.venue.quoteToken : ctx.venue.baseToken;
  if (typeof spendingToken !== 'string' || !spendingToken) return null;
  return { spendingToken: spendingToken.toLowerCase(), spender };
}

// ─── Pro-cover (Batch 5) — pay-modal lazy import ────────────────────────────

/**
 * Batch 5: Pro upsell cover overlay shown over the trade panel when the user
 * is not premium. The cover button delegates to `access.js`'s `openPayModal`,
 * lazily imported so that free-only test fixtures don't pull viem/wagmi into
 * their dependency graph.
 *
 * Tests inject `options.openPayModal` to skip the dynamic import and assert
 * the click handler invokes the modal opener directly.
 */
async function defaultOpenPayModal(opts) {
  const mod = await import('./access.js');
  return mod.openPayModal(opts);
}

// ─── Internal: viem client factory ──────────────────────────────────────────

let _client = null;
function getReadClient() {
  if (_client) return _client;
  _client = createPublicClient({ chain: base, transport: http() });
  return _client;
}

/**
 * Reset the cached module-level viem client. Tests must call this in
 * `beforeEach` to prevent leak of a mocked client between test cases
 * (otherwise a forgotten `readBalanceOverride`/`readQuoteOverride` would
 * silently hit the stale stub returning 0n).
 */
export function _resetClientForTests() {
  _client = null;
  _defaultPaymentClient = null;
}

// ─── Default payment client (lazy wagmi binding) ────────────────────────────

/** @typedef {object} TradePaymentClient
 *  @property {(p:{token:string,owner:string,spender:string}) => Promise<bigint>} readAllowance
 *  @property {(p:{token:string,spender:string,amount:bigint,owner:string}) => Promise<string>} approve
 *  @property {(p:{router:string,side:'buy'|'sell',token:string,amountIn:bigint,minOut:bigint,owner:string}) => Promise<string>} swap
 */

let _defaultPaymentClient = null;

/**
 * Build the default payment client backed by wagmi/viem. Lazy import to keep
 * cold-load light for users who never click Buy/Sell. The unit tests inject
 * `options.payment` instead so this code path never runs under vitest.
 *
 * @returns {Promise<TradePaymentClient>}
 */
async function buildDefaultPaymentClient() {
  const [{ getWagmiConfig }, wagmi] = await Promise.all([
    import('./wallet.js'),
    import('@wagmi/core'),
  ]);
  const config = getWagmiConfig();
  return {
    async readAllowance({ token, owner, spender }) {
      const out = await wagmi.readContract(config, {
        abi: ERC20_ABI,
        address: token,
        functionName: 'allowance',
        args: [owner, spender],
      });
      return BigInt(out ?? 0);
    },
    async approve({ token, spender, amount, owner }) {
      const hash = await wagmi.writeContract(config, {
        abi: ERC20_ABI,
        address: token,
        functionName: 'approve',
        args: [spender, amount],
        account: owner,
      });
      await wagmi.waitForTransactionReceipt(config, { hash });
      return hash;
    },
    async swap({ router, side, token, amountIn, minOut, owner }) {
      const hash = await wagmi.writeContract(config, {
        abi: ROUTER_ABI,
        address: router,
        functionName: side, // 'buy' | 'sell'
        args: [token, amountIn, minOut],
        account: owner,
      });
      await wagmi.waitForTransactionReceipt(config, { hash });
      return hash;
    },
  };
}

async function getDefaultPaymentClient() {
  if (_defaultPaymentClient) return _defaultPaymentClient;
  _defaultPaymentClient = await buildDefaultPaymentClient();
  return _defaultPaymentClient;
}

// F2.x — lazy wagmi-backed signTypedData. Returns a 0x-prefixed hex signature
// for the given typedData (Order). Tests inject `options.signTypedData` to
// skip the wagmi import.
async function defaultSignTypedData({ account, typedData }) {
  const [{ getWagmiConfig }, wagmi] = await Promise.all([
    import('./wallet.js'),
    import('@wagmi/core'),
  ]);
  const config = getWagmiConfig();
  return wagmi.signTypedData(config, {
    account,
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  });
}

/**
 * MetaMask uses `code: 4001` for user rejection; viem wraps wallet errors as
 * `UserRejectedRequestError` with `code: 4001` too. Mirrors access.js — kept
 * inline rather than imported to avoid cross-module coupling.
 */
function isUserRejection(err) {
  if (!err) return false;
  if (typeof err.code === 'number' && err.code === 4001) return true;
  const cause = err.cause;
  if (cause && typeof cause.code === 'number' && cause.code === 4001) return true;
  if (typeof err.name === 'string' && /UserRejected/i.test(err.name)) return true;
  const msg = (err.shortMessage || err.message || '').toLowerCase();
  if (msg.includes('user rejected') || msg.includes('user denied')) return true;
  return false;
}

/**
 * Truncate an address `0xabcd…7f9c` for UI labels. Returns `'tokens'` as a
 * safe fallback for falsy/short input so a success toast never reads ": ".
 * Mirrors the helper in access.js — kept inline to avoid cross-module
 * coupling for one-line use.
 *
 * @param {string|null|undefined} addr
 * @returns {string}
 */
function shortenAddress(addr) {
  if (typeof addr !== 'string' || addr.length < 10) return 'tokens';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function errorMessage(err, fallback) {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    if ('shortMessage' in err && err.shortMessage) return String(err.shortMessage);
    if ('message' in err && err.message) return String(err.message);
  }
  return fallback;
}

// ─── DOM helpers ────────────────────────────────────────────────────────────

function el(tag, { className, dataset, attrs, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (dataset) {
    for (const [k, v] of Object.entries(dataset)) node.dataset[k] = v;
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  }
  if (text != null) node.textContent = text;
  return node;
}

// ─── Mount ──────────────────────────────────────────────────────────────────

/**
 * @typedef {object} TradePanelOptions
 * @property {object} [apiClient]
 * @property {object|null} [token]             selected token data (sidebar row)
 * @property {object} [readClient]             override for tests (viem-shaped)
 * @property {(opts: { token: string, ownerAddress: string }) => Promise<bigint>} [readBalance]
 *                                            override for tests
 * @property {(opts: { hook: string, fn: 'quoteBuy'|'quoteSell', token: string, amountIn: bigint }) => Promise<bigint>} [readQuote]
 *                                            override for tests
 * @property {(opts: { token: string, owner: string, spender: string }) => Promise<bigint>} [readAllowance]
 *                                            F1.2: override for tests (default uses options.payment)
 * @property {TradePaymentClient} [payment]   F1.2: full on-chain seam (read+write)
 * @property {number} [debounceMs]
 * @property {(countryAddress: string) => void} [onCountrySwitch]
 *                                            F1.3: invoked when user clicks the
 *                                            "Купить country" shortcut (insufficient
 *                                            country balance during player+Buy).
 *                                            Argument is the lowercase address;
 *                                            wiring in main.js looks the row up
 *                                            in the sidebar registry.
 * @property {(opts?: object) => unknown} [openPayModal]
 *                                            Batch 5: pay-modal factory used by the
 *                                            pro-cover upsell button. Defaults to the
 *                                            dynamic-import of `./access.js`. Tests
 *                                            override with a `vi.fn()` to avoid
 *                                            loading the heavy access module.
 * @property {() => 'unknown'|'anon'|'free'|'premium'} [getAccessState]
 *                                            Batch 5: read current access state.
 *                                            Defaults to `access-store.js#get`.
 * @property {(fn: (s: string) => void) => () => void} [subscribeAccess]
 *                                            Batch 5: subscribe to access-state
 *                                            transitions. Defaults to
 *                                            `access-store.js#subscribe`.
 * @property {boolean} [proCoverEnabled]
 *                                            Batch 5: gate the pro-cover overlay
 *                                            entirely (e.g. for the standalone
 *                                            DOM unit tests that don't mock the
 *                                            access store). Defaults to `true`.
 */

/**
 * Mount the Market trade panel.
 *
 * @param {HTMLElement} container
 * @param {TradePanelOptions} [options]
 * @returns {{
 *   setToken: (token: object|null) => void,
 *   refreshQuote: () => Promise<void>,
 *   getState: () => object,
 *   destroy: () => void,
 * }}
 */
export function mountTradePanel(container, options = {}) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('mountTradePanel: container must be an HTMLElement');
  }

  const apiClient = options.apiClient ?? defaultApi;
  const debounceMs =
    typeof options.debounceMs === 'number' ? options.debounceMs : QUOTE_DEBOUNCE_MS;

  // Test-overrides for chain reads. In prod we hit viem.
  const readBalanceOverride = options.readBalance ?? null;
  const readQuoteOverride = options.readQuote ?? null;
  const readAllowanceOverride = options.readAllowance ?? null;
  // F1.2 — payment client (writes). Tests inject a mock; prod gets lazy
  // viem/wagmi client on first use.
  const paymentOverride = options.payment ?? null;

  // F2.x — signing seam. Tests inject `options.signTypedData` to bypass wagmi.
  const signTypedDataOverride =
    typeof options.signTypedData === 'function' ? options.signTypedData : null;

  // F1.3 — callback to ask the host to switch to the country token row.
  // Optional — if absent the "Купить country" CTA is hidden entirely so the
  // standalone panel still degrades gracefully.
  const onCountrySwitch =
    typeof options.onCountrySwitch === 'function' ? options.onCountrySwitch : null;

  // Batch 5 — Pro-cover wiring. Tests can disable the overlay entirely by
  // passing `proCoverEnabled: false`, or inject custom access-state getters /
  // subscribers + pay-modal factory.
  const proCoverEnabled = options.proCoverEnabled !== false;
  const _getAccessState =
    typeof options.getAccessState === 'function' ? options.getAccessState : getAccessState;
  const _subscribeAccess =
    typeof options.subscribeAccess === 'function' ? options.subscribeAccess : subscribeAccessState;
  const _openPayModal =
    typeof options.openPayModal === 'function' ? options.openPayModal : defaultOpenPayModal;

  container.replaceChildren();

  // ── State ──────────────────────────────────────────────────────────────
  const state = {
    mode: 'market', // 'market' | 'limit' (limit disabled — phase 2)
    side: 'buy', // 'buy' | 'sell'
    token: options.token ?? null,
    contracts: null, // { pitch, playerHook, countryHook, ... } from /config
    account: getAccount(), // { address, chainId, isConnected, ... }
    amountStr: '',
    slippagePct: DEFAULT_SLIPPAGE_PCT,
    balanceWei: null, // current balance for the input side
    quote: null, // { amountInWei, amountOutWei, minOutWei, side, base, quote, hook, ts }
    quoteError: null,
    quoteLoading: false,
    balanceLoading: false,
    // F1.2 — allowance / approve / swap.
    allowanceWei: null, // current allowance(input → router); null = unknown
    allowanceLoading: false,
    approvePending: false, // tx in flight (popup or receipt wait)
    swapPending: false,
    // Generation counters discard stale async results.
    quoteGen: 0,
    balanceGen: 0,
    allowanceGen: 0,
    // Debounce timer.
    quoteTimer: null,
    // F1.3 — `address(lowercase) → symbol` map for country tokens, populated
    // by a single getTokens() fetch on mount. Used to render real symbols
    // (e.g. "BRA") instead of the `shortenAddress` fallback in the country
    // balance line, hint block, and disabledReason text.
    countrySymbolMap: new Map(),
    // F2.x — limit-order form state.
    chainId: BASE_CHAIN_ID,
    limitTriggerPriceStr: '',
    limitTtlSec: DEFAULT_TTL_SECONDS,
    limitSubmitting: false,
    limitError: null,
    // Wave 3 hotfix — limit-mode allowance against the EXECUTOR (not the
    // market router). Kept parallel to the market `allowanceWei` / pending
    // flags so a stale market value can never satisfy a limit submit (and
    // vice-versa).
    limitAllowanceWei: null,
    limitAllowanceLoading: false,
    limitApprovePending: false,
    limitAllowanceGen: 0,
  };

  // ── Build skeleton (build-once) ────────────────────────────────────────
  // Batch 5: outer root holds an optional sticky header + a `pt-trade__body`
  // wrapper for the actual form controls + the pro-cover overlay. The cover
  // is absolutely positioned over `body` and toggled via the `is-locked`
  // modifier on `root`. The CSS file (`trade-panel-batch5.css`) hides the body
  // (visibility:hidden) when locked so the cover sits flush against the head.
  const root = el('div', {
    className: 'pt-trade',
    dataset: { testId: 'trade-panel', zone: 'trade' },
  });

  // Sticky header — "Trade · SYMBOL" matches the premium mockup.
  const head = el('div', {
    className: 'pt-trade__head',
    dataset: { testId: 'trade-head' },
  });
  const headLabel = el('span', {
    className: 'pt-trade__head-label',
    dataset: { testId: 'trade-head-label' },
    text: 'Trade',
  });
  const headLock = el('span', {
    className: 'pt-trade__head-lock',
    dataset: { testId: 'trade-head-lock' },
    attrs: { 'aria-hidden': 'true' },
    text: '🔒',
  });
  headLock.hidden = true;
  head.appendChild(headLabel);
  head.appendChild(headLock);

  const body = el('div', {
    className: 'pt-trade__body',
    dataset: { testId: 'trade-body' },
  });

  // Mode toggle (Market / Limit). Limit is disabled.
  const modeRow = el('div', { className: 'pt-trade__mode', dataset: { testId: 'trade-mode' } });
  const marketBtn = el('button', {
    className: 'pt-trade__mode-btn is-active',
    dataset: { testId: 'mode-market', mode: 'market' },
    attrs: { type: 'button', 'aria-pressed': 'true' },
    text: 'Market',
  });
  const limitBtn = el('button', {
    className: 'pt-trade__mode-btn',
    dataset: { testId: 'mode-limit', mode: 'limit' },
    attrs: {
      type: 'button',
      'aria-pressed': 'false',
      title: 'Place a limit order (signed off-chain, executed when price hits target)',
    },
    text: 'Limit',
  });
  modeRow.appendChild(marketBtn);
  modeRow.appendChild(limitBtn);

  // Side tabs (Buy / Sell).
  const sideRow = el('div', {
    className: 'pt-trade__side',
    dataset: { testId: 'trade-side' },
    attrs: { role: 'tablist', 'aria-label': 'Buy or sell' },
  });
  const sideButtons = {};
  for (const side of TABS) {
    const btn = el('button', {
      className: `pt-trade__side-btn pt-trade__side-btn--${side}`,
      dataset: { testId: `side-${side}`, side },
      attrs: {
        type: 'button',
        role: 'tab',
        'aria-selected': side === state.side ? 'true' : 'false',
      },
      text: side === 'buy' ? 'Buy' : 'Sell',
    });
    sideButtons[side] = btn;
    sideRow.appendChild(btn);
  }

  // Balance line + input + percent buttons.
  const balanceLine = el('div', {
    className: 'pt-trade__balance',
    dataset: { testId: 'trade-balance' },
    text: 'Balance: —',
  });

  const amountWrap = el('label', { className: 'pt-trade__amount' });
  amountWrap.appendChild(el('span', { className: 'pt-trade__label', text: 'Amount' }));
  const amountInput = el('input', {
    className: 'pt-trade__input',
    dataset: { testId: 'trade-amount' },
    attrs: {
      type: 'text',
      inputmode: 'decimal',
      placeholder: '0.0',
      'aria-label': 'Swap amount',
      autocomplete: 'off',
    },
  });
  amountWrap.appendChild(amountInput);

  const pctRow = el('div', { className: 'pt-trade__pct', dataset: { testId: 'trade-pct' } });
  const PCT_PRESETS = [25, 50, 75, 100];
  const pctButtons = {};
  for (const p of PCT_PRESETS) {
    const btn = el('button', {
      className: 'pt-trade__pct-btn',
      dataset: { testId: `pct-${p}`, pct: String(p) },
      attrs: { type: 'button' },
      text: p === 100 ? 'Max' : `${p}%`,
    });
    pctButtons[p] = btn;
    pctRow.appendChild(btn);
  }

  // Wave 2A — fee breakdown block. Appears under the amount field whenever
  // amount > 0 + token meta is loaded, in both market and limit modes.
  // Renders one line for the headline ("Spending X NOR → you'll receive ≈ Y
  // HAALAN") and one secondary line for the math ("naive 0.1, fee 0.005").
  // Lightweight by design — three textContent writes, no separate component.
  const feeBlock = el('div', {
    className: 'pt-trade__fee-breakdown',
    dataset: { testId: 'fee-breakdown' },
  });
  feeBlock.hidden = true;
  const feeHeadlineLine = el('div', {
    className: 'pt-trade__fee-headline',
    dataset: { testId: 'fee-breakdown-headline' },
  });
  const feeMathLine = el('div', {
    className: 'pt-trade__fee-math',
    dataset: { testId: 'fee-breakdown-math' },
  });
  feeBlock.appendChild(feeHeadlineLine);
  feeBlock.appendChild(feeMathLine);

  // Slippage.
  const slipWrap = el('label', { className: 'pt-trade__slippage' });
  slipWrap.appendChild(el('span', { className: 'pt-trade__label', text: 'Slippage, %' }));
  const slipInput = el('input', {
    className: 'pt-trade__input pt-trade__input--narrow',
    dataset: { testId: 'trade-slippage' },
    attrs: {
      type: 'number',
      step: '0.1',
      min: '0',
      max: String(MAX_SLIPPAGE_PCT),
      value: String(DEFAULT_SLIPPAGE_PCT),
      'aria-label': 'Slippage percent',
    },
  });
  slipInput.value = String(DEFAULT_SLIPPAGE_PCT);
  slipWrap.appendChild(slipInput);

  // Quote block.
  const quoteBlock = el('div', {
    className: 'pt-trade__quote',
    dataset: { testId: 'trade-quote' },
  });
  const quoteOutLine = el('div', {
    className: 'pt-trade__quote-out',
    dataset: { testId: 'quote-out' },
  });
  const quoteMinLine = el('div', {
    className: 'pt-trade__quote-min',
    dataset: { testId: 'quote-min' },
  });
  const quoteFeeLine = el('div', {
    className: 'pt-trade__quote-fee',
    dataset: { testId: 'quote-fee' },
  });
  const quoteErrLine = el('div', {
    className: 'pt-trade__quote-error',
    dataset: { testId: 'quote-error' },
  });
  quoteErrLine.hidden = true;
  quoteBlock.appendChild(quoteOutLine);
  quoteBlock.appendChild(quoteMinLine);
  quoteBlock.appendChild(quoteFeeLine);
  quoteBlock.appendChild(quoteErrLine);

  // F1.3 — player+Buy hint block: shows "Требуется: X CC / Ваш баланс: Y CC".
  // Hidden whenever the conditions don't hold (not player venue / not Buy /
  // no quote yet). Kept separate from `pt-trade__quote` because that block is
  // already overloaded with quote+fee+error lines.
  const hintBlock = el('div', {
    className: 'pt-trade__hint',
    dataset: { testId: 'trade-country-hint' },
  });
  hintBlock.hidden = true;
  const hintRequiredLine = el('div', {
    className: 'pt-trade__hint-required',
    dataset: { testId: 'trade-country-required' },
  });
  const hintBalanceLine = el('div', {
    className: 'pt-trade__hint-balance',
    dataset: { testId: 'trade-country-balance' },
  });
  hintBlock.appendChild(hintRequiredLine);
  hintBlock.appendChild(hintBalanceLine);

  // F2.x — Limit order fields. Only visible when `state.mode === 'limit'`.
  // Contains:
  //   - target price input (number, in country/PITCH per docs/eip712.md §1)
  //   - TTL preset select (1h / 24h / 7d / no expiry — see DEFAULT_TTL_PRESETS)
  //   - inline preview "Trigger when price ≤ X" / "≥ X" depending on side
  //   - error line for last submit failure
  // The amount + slippage inputs are reused from market mode — they share
  // the same signed-message fields (`amountIn`, `slippageBps`).
  const limitBlock = el('div', {
    className: 'pt-trade__limit',
    dataset: { testId: 'trade-limit' },
  });
  limitBlock.hidden = true;
  const limitPriceWrap = el('label', { className: 'pt-trade__limit-price' });
  // B3 — F2.x #9: dynamic label so the quote-currency is explicit. Filled in
  // by renderLimit() based on the resolved venue:
  //   country venue → "Trigger price (PITCH per 1 {ticker})"
  //   player venue  → "Trigger price ({countryTicker} per 1 {playerTicker})"
  // Default text matches the legacy label so SSR / pre-token-render output
  // never reads blank.
  const limitPriceLabel = el('span', {
    className: 'pt-trade__label',
    dataset: { testId: 'trade-limit-price-label' },
    text: 'Trigger price',
  });
  limitPriceWrap.appendChild(limitPriceLabel);
  const limitPriceInput = el('input', {
    className: 'pt-trade__input',
    dataset: { testId: 'trade-limit-price' },
    attrs: {
      type: 'text',
      inputmode: 'decimal',
      placeholder: '0.0',
      'aria-label': 'Limit-order trigger price',
      autocomplete: 'off',
    },
  });
  limitPriceWrap.appendChild(limitPriceInput);
  limitBlock.appendChild(limitPriceWrap);

  const limitTtlWrap = el('label', { className: 'pt-trade__limit-ttl' });
  limitTtlWrap.appendChild(el('span', { className: 'pt-trade__label', text: 'Expires in' }));
  const limitTtlSelect = el('select', {
    className: 'pt-trade__input pt-trade__input--ttl',
    dataset: { testId: 'trade-limit-ttl' },
    attrs: { 'aria-label': 'Limit-order expiry' },
  });
  for (const preset of TTL_PRESETS) {
    const opt = el('option', {
      attrs: { value: String(preset.seconds) },
      text: preset.label,
    });
    limitTtlSelect.appendChild(opt);
  }
  limitTtlSelect.value = String(DEFAULT_TTL_SECONDS);
  limitTtlWrap.appendChild(limitTtlSelect);
  limitBlock.appendChild(limitTtlWrap);

  const limitHint = el('div', {
    className: 'pt-trade__limit-hint',
    dataset: { testId: 'trade-limit-hint' },
  });
  limitBlock.appendChild(limitHint);

  const limitError = el('div', {
    className: 'pt-trade__limit-error',
    dataset: { testId: 'trade-limit-error' },
  });
  limitError.hidden = true;
  limitBlock.appendChild(limitError);

  // CTA button (disabled in F1.1 — wired in F1.2).
  const cta = el('button', {
    className: 'pt-btn pt-btn--primary pt-trade__cta',
    dataset: { testId: 'trade-cta' },
    attrs: { type: 'button', disabled: 'disabled' },
    text: 'Buy',
  });

  // F1.3 — secondary CTA: "Buy country". Shown only when player+Buy AND
  // insufficient country balance AND a `onCountrySwitch` callback was wired.
  // Click delegates back to the host (sidebar/router) — the panel never
  // touches navigation itself.
  const countryCta = el('button', {
    className: 'pt-btn pt-trade__country-cta',
    dataset: { testId: 'trade-country-cta' },
    attrs: { type: 'button' },
    text: 'Buy country',
  });
  countryCta.hidden = true;

  const status = el('div', {
    className: 'pt-trade__status',
    dataset: { testId: 'trade-status' },
  });

  // Batch 5: SELL tab is built last in the loop, but the mockup orders BUY
  // on the left + SELL on the right (which matches `TABS = ['buy', 'sell']`).
  // The mockup also stacks side tabs above the MARKET/LIMIT mode segment,
  // so we render `sideRow` first when appending — visually closer to mockup
  // — then `modeRow`. Existing test-ids unchanged.
  body.appendChild(sideRow);
  body.appendChild(modeRow);
  body.appendChild(balanceLine);
  body.appendChild(amountWrap);
  body.appendChild(pctRow);
  body.appendChild(feeBlock);
  body.appendChild(slipWrap);
  body.appendChild(quoteBlock);
  body.appendChild(hintBlock);
  body.appendChild(limitBlock);
  body.appendChild(cta);
  body.appendChild(countryCta);
  body.appendChild(status);

  root.appendChild(head);
  root.appendChild(body);
  container.appendChild(root);

  // Batch 5: Pro-cover overlay. Built once + appended to root so it sits as a
  // sibling of `body` and can be absolutely positioned via CSS to cover the
  // entire panel (head + body). Visibility is driven by the `is-locked` class
  // on `root` so a single class toggle controls both the cover's display and
  // the body's pointer-events.
  const cover = el('div', {
    className: 'pt-trade__cover',
    dataset: { testId: 'trade-cover' },
    attrs: { role: 'group', 'aria-label': 'Trading requires Pro' },
  });
  cover.hidden = true;
  const coverIcon = el('div', {
    className: 'pt-trade__cover-icon',
    attrs: { 'aria-hidden': 'true' },
    text: '★',
  });
  const coverTitle = el('div', {
    className: 'pt-trade__cover-title',
    dataset: { testId: 'trade-cover-title' },
    text: 'Trading requires Pro',
  });
  const coverSub = el('div', {
    className: 'pt-trade__cover-sub',
    text: 'Trade 192 markets, place limit orders, sleep through fills. Our 24/7 server fires your orders the moment they trigger.',
  });
  const coverFeats = el('ul', { className: 'pt-trade__cover-feats' });
  for (const feat of ['Market swaps', 'Limit orders', 'Take-profit', 'Price alerts']) {
    coverFeats.appendChild(el('li', { text: feat }));
  }
  const coverQuote = el('div', { className: 'pt-trade__cover-quote' });
  coverQuote.appendChild(
    el('span', { className: 'pt-trade__cover-quote-l', text: 'One-time payment' }),
  );
  coverQuote.appendChild(el('span', { className: 'pt-trade__cover-quote-sep', text: '·' }));
  coverQuote.appendChild(
    el('span', {
      className: 'pt-trade__cover-quote-r',
      dataset: { testId: 'trade-cover-price' },
      text: '1 PITCH',
    }),
  );
  const coverCta = el('button', {
    className: 'pt-trade__cover-cta',
    dataset: { testId: 'trade-cover-cta' },
    attrs: { type: 'button' },
  });
  coverCta.appendChild(
    el('span', {
      className: 'pt-trade__cover-cta-star',
      attrs: { 'aria-hidden': 'true' },
      text: '★',
    }),
  );
  coverCta.appendChild(el('span', { text: 'Upgrade to Pro' }));

  cover.appendChild(coverIcon);
  cover.appendChild(coverTitle);
  cover.appendChild(coverSub);
  cover.appendChild(coverFeats);
  cover.appendChild(coverQuote);
  cover.appendChild(coverCta);
  root.appendChild(cover);

  // ── Derived: side-token mapping ────────────────────────────────────────
  /**
   * For the current side and token, return {inputToken, outputToken, hook, fn}.
   * Buy: inputToken = quoteToken, outputToken = baseToken, fn = quoteBuy.
   * Sell: inputToken = baseToken, outputToken = quoteToken, fn = quoteSell.
   *
   * Returns null when we can't resolve (no token / contracts not loaded).
   */
  function resolveSide() {
    const v = resolveVenue(state.token, state.contracts?.pitch);
    if (!v) return null;
    const hook = v.venue === 'player' ? state.contracts?.playerHook : state.contracts?.countryHook;
    const router =
      v.venue === 'player' ? state.contracts?.playerRouter : state.contracts?.countryRouter;
    if (typeof hook !== 'string' || !hook) return null;
    // Router can be missing in early config-load — still allow quote/balance,
    // approve+swap branches gate on it themselves.
    const routerLower = typeof router === 'string' && router ? router.toLowerCase() : null;
    if (state.side === 'buy') {
      return {
        venue: v.venue,
        hook: hook.toLowerCase(),
        router: routerLower,
        fn: 'quoteBuy',
        inputToken: v.quoteToken,
        outputToken: v.baseToken,
      };
    }
    return {
      venue: v.venue,
      hook: hook.toLowerCase(),
      router: routerLower,
      fn: 'quoteSell',
      inputToken: v.baseToken,
      outputToken: v.quoteToken,
    };
  }

  /**
   * Resolve a display symbol for a country-token address. F1.4 refinement —
   * priority order:
   *   1. `state.token.countrySymbol` when the sidebar threaded it through
   *      `setToken({ ..., countrySymbol })`. Always the canonical source
   *      when the address matches the currently-selected token's country.
   *   2. `state.countrySymbolMap` populated by the legacy one-shot
   *      `getTokens()` fetch (defence-in-depth; survives a sidebar that
   *      forgets to thread the symbol).
   *   3. Shortened address fallback (`0xcccc…0001`) — last-ditch label so
   *      the user never sees the literal word "country" or an empty string.
   *
   * F1.3 helper, F1.4 extended.
   */
  function symbolForCountry(addr) {
    if (typeof addr !== 'string' || !addr) return 'country';
    const addrLower = addr.toLowerCase();
    // Step 1: prefer the symbol threaded via setToken when it matches the
    // address we were asked about. Guard the equality so a stale value from
    // a previous setToken() doesn't leak across token switches.
    const threaded =
      typeof state.token?.countrySymbol === 'string' && state.token.countrySymbol
        ? state.token.countrySymbol
        : null;
    const tokenCountryAddr =
      typeof state.token?.countryAddress === 'string'
        ? state.token.countryAddress.toLowerCase()
        : null;
    if (threaded && tokenCountryAddr === addrLower) return threaded;
    // Step 2: legacy map fallback.
    const cached = state.countrySymbolMap.get(addrLower);
    if (cached) return cached;
    // Step 3: shortened address.
    return shortenAddress(addr);
  }

  /**
   * Compute the symbol of the *input* token for the current side+venue. Used
   * by the balance line and the F1.3 hint. Returns null when we can't
   * resolve (no token / contracts not loaded) so the caller can pick a
   * generic label.
   */
  function inputTokenSymbol() {
    const v = resolveVenue(state.token, state.contracts?.pitch);
    if (!v) return null;
    if (state.side === 'buy') {
      // Buy → input is the quote token. Player venue: country; country
      // venue: PITCH.
      if (v.venue === 'player') return symbolForCountry(state.token?.countryAddress);
      return 'PITCH';
    }
    // Sell → input is the traded (base) token = the currently-selected token.
    return state.token?.symbol || shortenAddress(state.token?.address);
  }

  /**
   * True when the user is staring at a player token in Buy mode (input = the
   * country token). Drives the F1.3 hint + insufficient-country CTA path.
   */
  function isPlayerBuy() {
    return (
      state.side === 'buy' &&
      state.token != null &&
      typeof state.token.countryAddress === 'string' &&
      !!state.token.countryAddress
    );
  }

  // ── Renderers ──────────────────────────────────────────────────────────
  function renderSideAria() {
    for (const side of TABS) {
      sideButtons[side].setAttribute('aria-selected', side === state.side ? 'true' : 'false');
      sideButtons[side].classList.toggle('is-active', side === state.side);
    }
    cta.textContent = state.side === 'buy' ? 'Buy' : 'Sell';
  }

  function renderBalance() {
    if (!state.account.isConnected) {
      balanceLine.textContent = 'Balance: connect wallet';
      return;
    }
    if (state.balanceLoading) {
      balanceLine.textContent = 'Balance: loading…';
      return;
    }
    if (state.balanceWei == null) {
      balanceLine.textContent = 'Balance: —';
      return;
    }
    // F1.3: suffix the symbol of the *input* token so the user knows what the
    // balance refers to (e.g. on player+Buy this is the country balance, not
    // the player token's). Falls back to an unsuffixed label if we can't
    // resolve.
    const sym = inputTokenSymbol();
    const value = formatWei(state.balanceWei, 6);
    balanceLine.textContent = sym ? `Balance: ${value} ${sym}` : `Balance: ${value}`;
  }

  /**
   * F1.3 — player+Buy hint block. Renders "Required: X CC / Your balance: Y CC"
   * once we have BOTH a quote (so we know how much country is needed) AND a
   * balance read (so the user can compare). Hidden in every other case so it
   * doesn't add empty rows on the country panel or pre-quote.
   */
  function renderHint() {
    const liveAmountWei = parseAmountToWei(state.amountStr);
    if (
      !isPlayerBuy() ||
      !state.quote ||
      state.balanceWei == null ||
      state.quote.amountInWei !== liveAmountWei
    ) {
      hintBlock.hidden = true;
      return;
    }
    const sym = symbolForCountry(state.token?.countryAddress);
    const need = formatWei(state.quote.amountInWei, 6);
    const have = formatWei(state.balanceWei, 6);
    hintRequiredLine.textContent = `Required: ${need} ${sym}`;
    hintBalanceLine.textContent = `Your balance: ${have} ${sym}`;
    hintBlock.hidden = false;
  }

  function renderQuote() {
    if (state.quoteError) {
      quoteErrLine.hidden = false;
      quoteErrLine.textContent = state.quoteError;
      quoteOutLine.textContent = '';
      quoteMinLine.textContent = '';
      quoteFeeLine.textContent = '';
      return;
    }
    quoteErrLine.hidden = true;
    if (state.quoteLoading) {
      quoteOutLine.textContent = 'Quoting…';
      quoteMinLine.textContent = '';
      quoteFeeLine.textContent = '';
      return;
    }
    if (!state.quote) {
      quoteOutLine.textContent = '';
      quoteMinLine.textContent = '';
      quoteFeeLine.textContent = '';
      return;
    }
    const outText = formatWei(state.quote.amountOutWei, 6);
    const minText = formatWei(state.quote.minOutWei, 6);
    quoteOutLine.textContent = `You receive ≈ ${outText}`;
    quoteMinLine.textContent = `Minimum (after slippage): ${minText}`;
    quoteFeeLine.textContent = `pitchwc fee: ${(PITCHWC_FEE_BPS / 100).toFixed(1)}% + slippage ${state.slippagePct}%`;
  }

  /**
   * B3 — F2.x #9: build the "Trigger price (… per 1 …)" label for the
   * currently-resolved venue. Trigger price denomination depends on venue
   * (per docs/eip712.md §1), NOT on side: a limit-sell of a player token
   * still triggers on a country-unit threshold. Falls back to the bare
   * legacy label when token or contracts haven't loaded.
   *
   * - country venue → "Trigger price (PITCH per 1 BRA)"
   * - player venue  → "Trigger price (BRA per 1 PLR)"
   */
  function computeLimitPriceLabel() {
    const v = resolveVenue(state.token, state.contracts?.pitch);
    if (!v) return 'Trigger price';
    const baseSym = state.token?.symbol;
    if (v.venue === 'country') {
      return baseSym ? `Trigger price (PITCH per 1 ${baseSym})` : 'Trigger price (PITCH)';
    }
    // player venue — quote = country
    const quoteSym = symbolForCountry(state.token?.countryAddress);
    if (baseSym && quoteSym) return `Trigger price (${quoteSym} per 1 ${baseSym})`;
    if (quoteSym) return `Trigger price (${quoteSym})`;
    return 'Trigger price';
  }

  // F2.x — limit-mode render: trigger-price hint + error line. Visible only
  // when `state.mode === 'limit'`. Reads from state and the live input.
  // B3 also keeps the label updated whenever venue / token / symbols change.
  function renderLimit() {
    // B3 — label text is venue-aware. We refresh it even when limit mode is
    // hidden so a token-switch made in market mode primes the correct text
    // before the user toggles into limit mode.
    limitPriceLabel.textContent = computeLimitPriceLabel();
    if (state.mode !== 'limit') {
      limitError.hidden = true;
      limitHint.textContent = '';
      return;
    }
    const triggerWei = parseAmountToWei(state.limitTriggerPriceStr);
    if (triggerWei && triggerWei > 0n) {
      const op = state.side === 'buy' ? '≤' : '≥';
      // Render the per-1-token trigger price with a fixed 4-decimal shape
      // (`0.0000`) — matches the visual contract for spot/current price
      // displays across the trade panel.
      const triggerNumForFmt = Number(formatWei(triggerWei, 18));
      const price = formatSpotPrice(triggerNumForFmt);
      const quoteSym = isPlayerBuy() ? symbolForCountry(state.token?.countryAddress) : 'PITCH';
      const side = state.side === 'buy' ? 'limit-buy' : 'take-profit';
      // Wave 2A — pre-check "target already met": warn the user when the
      // current MID would already trigger the order (limit-buy: MID ≤ target;
      // take-profit: MID ≥ target). The keeper would fire it on the next
      // poll tick which is technically fine, but the user almost certainly
      // didn't mean to "limit-buy at a price the market is already below".
      // We compare against the MID (chart price), NOT the signed ASK/BID.
      const mid = getDisplayMid();
      let warning = '';
      if (mid != null) {
        const triggerNum = Number(formatWei(triggerWei, 18));
        if (Number.isFinite(triggerNum) && triggerNum > 0) {
          if (state.side === 'buy' && mid <= triggerNum) {
            warning = ' (current MID already at or below target — order would fire immediately)';
          } else if (state.side === 'sell' && mid >= triggerNum) {
            warning = ' (current MID already at or above target — order would fire immediately)';
          }
        }
      }
      limitHint.textContent = `${side}: trigger when price ${op} ${price} ${quoteSym}${warning}`;
    } else {
      limitHint.textContent = state.token
        ? 'Enter a trigger price in the quote currency.'
        : 'Select a token first.';
    }
    if (state.limitError) {
      limitError.hidden = false;
      limitError.textContent = state.limitError;
    } else {
      limitError.hidden = true;
      limitError.textContent = '';
    }
  }

  function renderCta() {
    if (state.mode === 'limit') {
      renderLimitCta();
      return;
    }
    const amountWei = parseAmountToWei(state.amountStr);
    const playerBuy = isPlayerBuy();
    const countrySymbol = playerBuy ? symbolForCountry(state.token?.countryAddress) : null;
    const reason = disabledReason({
      walletConnected: state.account.isConnected,
      chainId: state.account.chainId,
      token: state.token,
      contractsReady: !!state.contracts,
      amountWei,
      balanceWei: state.balanceWei,
      limitMode: false,
      approvePending: state.approvePending,
      swapPending: state.swapPending,
      allowanceLoading: state.allowanceLoading,
      playerBuy,
      countrySymbol,
    });

    // F1.3 — toggle "Купить country" shortcut. Visible only when:
    //   * a host wired `onCountrySwitch` (otherwise click is no-op anyway),
    //   * we're in player+Buy mode,
    //   * a balance is known and is short of the requested amount, AND
    //   * no tx is in flight (so we don't surprise-navigate mid-approve/swap).
    // The disabledReason for this case is the explicit
    // "Required: X CC. Buy it on the Country panel." string — the CTA reinforces it.
    const insufficientCountry =
      playerBuy &&
      state.balanceWei != null &&
      amountWei != null &&
      amountWei > 0n &&
      amountWei > state.balanceWei;
    const showCountryCta =
      onCountrySwitch != null && insufficientCountry && !state.approvePending && !state.swapPending;
    countryCta.hidden = !showCountryCta;
    if (showCountryCta) {
      // Best-effort symbol label so the user sees "Buy BRA" not
      // "Buy country" once the registry has loaded.
      const sym = countrySymbol && countrySymbol !== 'country' ? countrySymbol : null;
      countryCta.textContent = sym ? `Buy ${sym}` : 'Buy country';
      countryCta.dataset.countryAddress = (state.token?.countryAddress ?? '').toLowerCase();
    } else {
      delete countryCta.dataset.countryAddress;
    }

    // F1.2 — CTA label & mode (swap vs approve).
    // When user must approve before swap, swap the label to "Approve" so the
    // expected popup matches the click.
    const needsApprove =
      !reason && amountWei != null && state.allowanceWei != null && state.allowanceWei < amountWei;

    if (state.approvePending) {
      cta.textContent = 'Approve…';
    } else if (state.swapPending) {
      cta.textContent = state.side === 'buy' ? 'Buy…' : 'Sell…';
    } else if (needsApprove) {
      cta.textContent = 'Approve';
    } else {
      cta.textContent = state.side === 'buy' ? 'Buy' : 'Sell';
    }
    cta.dataset.action =
      needsApprove && !state.approvePending && !state.swapPending ? 'approve' : 'swap';

    // Swap requires a fresh quote (otherwise no minOut). Approve doesn't.
    const swapNeedsQuote =
      !needsApprove && (state.quote == null || state.quote.amountInWei !== amountWei);

    cta.disabled = reason != null || swapNeedsQuote;
    status.textContent = reason ?? '';
  }

  /**
   * F2.x — CTA wiring for limit mode. Distinct from `renderCta` so the market
   * approve/swap state machine doesn't bleed into the sign-and-POST flow.
   *
   * Wave 3 hotfix — adds the approve branch. The executor needs an ERC20
   * allowance on the spending token before the keeper can call `execute()`;
   * without it the keeper's pre-flight `eth_call` reverts and the order ends
   * up `failed`. Mirrors the F1.2 market-mode pattern but against the
   * executor address rather than the matching router.
   */
  function renderLimitCta() {
    const amountWei = parseAmountToWei(state.amountStr);
    const triggerWei = parseAmountToWei(state.limitTriggerPriceStr);
    const slippageBps = Math.round((state.slippagePct || 0) * 100);
    const premium = _getAccessState() === 'premium';
    const reason = disabledReasonLimit({
      walletConnected: state.account.isConnected,
      chainId: state.account.chainId,
      token: state.token,
      contractsReady: !!state.contracts,
      executorReady: !!state.contracts?.limitOrderExecutor,
      amountWei,
      triggerPriceWei: triggerWei,
      slippageBps,
      premium,
      submitting: state.limitSubmitting,
      approvePending: state.limitApprovePending,
      allowanceLoading: state.limitAllowanceLoading,
    });

    // Wave 3 — approve-vs-sign decision. We only swap the label to "Approve"
    // when there's no other blocking reason AND the live allowance is known
    // AND insufficient. While the allowance is still loading, `reason` above
    // already returns "Checking allowance…" so we don't need to handle it
    // here.
    const needsApprove =
      !reason &&
      amountWei != null &&
      amountWei > 0n &&
      state.limitAllowanceWei != null &&
      state.limitAllowanceWei < amountWei;

    if (state.limitApprovePending) {
      cta.textContent = 'Approve…';
    } else if (state.limitSubmitting) {
      cta.textContent = 'Signing…';
    } else if (needsApprove) {
      cta.textContent = 'Approve';
    } else {
      cta.textContent = state.side === 'buy' ? 'Place limit-buy' : 'Place take-profit';
    }
    cta.dataset.action = needsApprove && !state.limitApprovePending ? 'limit-approve' : 'limit';
    cta.disabled = reason != null;
    status.textContent = reason ?? '';
  }

  // Batch 5 — sticky-header label tracks the currently selected token's
  // symbol. Falls back to "Trade" when no token is picked (e.g. first paint
  // before sidebar has resolved a row).
  function renderHead() {
    const sym = state.token?.symbol;
    headLabel.textContent = typeof sym === 'string' && sym ? `Trade · ${sym}` : 'Trade';
  }

  // Batch 5 — Pro-cover visibility. Mirrors `soft-lock.js` semantics: anything
  // other than `'premium'` shows the cover. `is-locked` on root drives CSS
  // hiding the body content (visibility:hidden so the panel keeps its size).
  // `headLock` icon mirrors the cover state so the locked panel still has a
  // visual cue inside its sticky header.
  function renderCover() {
    if (!proCoverEnabled) {
      root.classList.remove('is-locked');
      cover.hidden = true;
      headLock.hidden = true;
      return;
    }
    const isLocked = _getAccessState() !== 'premium';
    root.classList.toggle('is-locked', isLocked);
    cover.hidden = !isLocked;
    headLock.hidden = !isLocked;
  }

  function renderAll() {
    renderHead();
    renderSideAria();
    renderBalance();
    renderQuote();
    renderHint();
    renderLimit();
    renderFeeBreakdown();
    renderCta();
    renderCover();
  }

  // ── Wave 2A — fee-breakdown render ──────────────────────────────────────
  /**
   * Compute the MID price the user sees on the chart (in quote-per-base
   * units). For country venue the chart denomination is PITCH (pricePitch);
   * for player venue it's the country token (priceCountry). Both come from
   * the sidebar token row as JS Numbers.
   *
   * @returns {number|null} MID, or null when the token meta hasn't loaded.
   */
  function getDisplayMid() {
    if (!state.token) return null;
    const v = resolveVenue(state.token, state.contracts?.pitch);
    if (!v) return null;
    if (v.venue === 'country') {
      const p = state.token.pricePitch;
      return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null;
    }
    const pc = state.token.priceCountry;
    return typeof pc === 'number' && Number.isFinite(pc) && pc > 0 ? pc : null;
  }

  /**
   * Pretty-print a positive Number into a short decimal string with up to
   * `digits` significant fractional places, no trailing zeros.
   */
  function formatNumber(n, digits = 6) {
    if (!Number.isFinite(n) || n <= 0) return '0';
    if (n >= 1) return Number(n.toFixed(digits)).toString();
    // Use 6 fractional digits then trim.
    return Number(n.toFixed(digits)).toString();
  }

  /**
   * Format the current/spot/MID price of a token for display in the trade
   * panel UI (e.g. "0.0000"). Always 4 fractional digits, fixed shape — keeps
   * the visual locked to `0.0000` regardless of magnitude. Used for
   * per-1-token price renderings (e.g. trigger-price echo in the limit hint).
   * Distinct from `formatNumber` which formats amounts (typed input quantities)
   * with trimmed trailing zeros.
   */
  function formatSpotPrice(n) {
    if (!Number.isFinite(n) || n <= 0) return '0.0000';
    return n.toFixed(4);
  }

  /**
   * Symbol of the quote token (what the user spends on buy / receives on sell).
   * Country venue → "PITCH". Player venue → the country ticker (resolved
   * via existing symbolForCountry helper).
   */
  function quoteTokenSymbol() {
    const v = resolveVenue(state.token, state.contracts?.pitch);
    if (!v) return null;
    if (v.venue === 'country') return 'PITCH';
    return symbolForCountry(state.token?.countryAddress);
  }

  function baseTokenSymbol() {
    return state.token?.symbol || (state.token?.address ? shortenAddress(state.token.address) : '');
  }

  /**
   * Choose the MID price the fee-breakdown should be computed against.
   *
   * Market mode: current chart MID (`getDisplayMid`) — what the user gets if
   * the swap executes right now.
   * Limit mode:  user's target price (in the same display units as MID) —
   * what the user will get when the keeper fires the order. Returns
   * `null` when the target is empty / zero / invalid, so the breakdown
   * stays hidden until a real target is entered (showing numbers against
   * current MID before that would be misleading).
   *
   * @returns {number|null}
   */
  function getEffectiveMid() {
    if (state.mode === 'limit') {
      const triggerWei = parseAmountToWei(state.limitTriggerPriceStr);
      if (!triggerWei || triggerWei <= 0n) return null;
      const n = Number(formatWei(triggerWei, 18));
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    return getDisplayMid();
  }

  function renderFeeBreakdown() {
    const amountWei = parseAmountToWei(state.amountStr);
    const effectiveMid = getEffectiveMid();
    const baseSym = baseTokenSymbol();
    const quoteSym = quoteTokenSymbol();
    // Limit mode + valid amount but no target yet → show a single-line
    // placeholder so the user understands why the breakdown is empty.
    if (
      state.mode === 'limit' &&
      amountWei &&
      amountWei > 0n &&
      baseSym &&
      quoteSym &&
      (effectiveMid === null || effectiveMid <= 0)
    ) {
      feeHeadlineLine.textContent = 'Enter trigger price to estimate fill';
      feeMathLine.textContent = '';
      feeBlock.classList.add('is-placeholder');
      feeBlock.hidden = false;
      return;
    }
    if (!amountWei || amountWei <= 0n || !effectiveMid || !baseSym || !quoteSym) {
      feeBlock.hidden = true;
      feeBlock.classList.remove('is-placeholder');
      feeHeadlineLine.textContent = '';
      feeMathLine.textContent = '';
      return;
    }
    // Convert amount to a JS Number for the breakdown (purely informational —
    // the on-chain math still uses the Hook quote / signed BigInt). We keep
    // the BigInt path for `applyFeeToNaiveAmount` which preserves precision
    // for the receiving-side wei estimate.
    const amountNum = Number(formatWei(amountWei, 18));
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      feeBlock.hidden = true;
      feeBlock.classList.remove('is-placeholder');
      return;
    }
    // "Naive" = the amount the user would receive at the effective MID
    // with no fee. In limit mode this is what the user gets when the
    // keeper triggers at the target price, not what they'd get right now.
    // Buy:  naive base = amountIn (quote) / effectiveMid
    // Sell: naive quote = amountIn (base)  × effectiveMid
    let naiveNum;
    let inSym;
    let outSym;
    if (state.side === 'buy') {
      naiveNum = amountNum / effectiveMid;
      inSym = quoteSym;
      outSym = baseSym;
    } else {
      naiveNum = amountNum * effectiveMid;
      inSym = baseSym;
      outSym = quoteSym;
    }
    // Scale to wei for the BigInt fee math. JS Number → wei via parseAmount
    // (truncates beyond 18 fractional digits; good enough for UI breakdown).
    const naiveWei = parseAmountToWei(naiveNum.toFixed(18));
    if (!naiveWei || naiveWei <= 0n) {
      feeBlock.hidden = true;
      feeBlock.classList.remove('is-placeholder');
      return;
    }
    const { net, fee } = applyFeeToNaiveAmount(naiveWei);
    const naiveStr = formatWei(naiveWei, 6);
    const netStr = formatWei(net, 6);
    const feeStr = formatWei(fee, 6);
    const amountStr = formatNumber(amountNum, 6);
    const feePct = (PITCHWC_FEE_BPS / 100).toFixed(1);
    const verb = state.side === 'buy' ? 'Spending' : 'Selling';
    feeHeadlineLine.textContent = `${verb} ${amountStr} ${inSym} → ≈ ${netStr} ${outSym}`;
    feeMathLine.textContent = `naive ${naiveStr} ${outSym}, ${feePct}% fee ${feeStr} ${outSym}`;
    feeBlock.classList.remove('is-placeholder');
    feeBlock.hidden = false;
  }

  // ── Chain reads ────────────────────────────────────────────────────────
  async function readBalanceFor({ token, owner }) {
    if (readBalanceOverride) {
      return readBalanceOverride({ token, ownerAddress: owner });
    }
    const client = options.readClient ?? getReadClient();
    // viem returns bigint for uint256.
    const result = await client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [owner],
    });
    return BigInt(result);
  }

  async function readQuoteFor({ hook, fn, token, amountIn }) {
    if (readQuoteOverride) {
      return readQuoteOverride({ hook, fn, token, amountIn });
    }
    const client = options.readClient ?? getReadClient();
    const result = await client.readContract({
      address: hook,
      abi: HOOK_ABI,
      functionName: fn,
      args: [token, amountIn],
    });
    return BigInt(result);
  }

  // ── Data fetch ─────────────────────────────────────────────────────────
  async function refreshBalance() {
    const sideInfo = resolveSide();
    if (!sideInfo || !state.account.isConnected || !state.account.address) {
      state.balanceWei = null;
      renderBalance();
      renderHint();
      renderCta();
      return;
    }
    state.balanceGen += 1;
    const myGen = state.balanceGen;
    state.balanceLoading = true;
    renderBalance();
    try {
      const bal = await readBalanceFor({
        token: sideInfo.inputToken,
        owner: state.account.address,
      });
      if (myGen !== state.balanceGen) return; // stale
      state.balanceWei = bal;
    } catch (err) {
      if (myGen !== state.balanceGen) return;
      state.balanceWei = null;
      // Surface as quote-area error so user sees something; don't block CTA
      // on balance alone — disabledReason has its own checks.
      console.warn('trade-panel: balance read failed', err);
    } finally {
      if (myGen === state.balanceGen) {
        state.balanceLoading = false;
        renderBalance();
        renderHint();
        renderCta();
      }
    }
  }

  async function refreshQuote() {
    const sideInfo = resolveSide();
    const amountWei = parseAmountToWei(state.amountStr);
    if (!sideInfo || !amountWei || amountWei <= 0n) {
      state.quote = null;
      state.quoteError = null;
      state.quoteLoading = false;
      renderQuote();
      renderHint();
      renderCta();
      return;
    }
    state.quoteGen += 1;
    const myGen = state.quoteGen;
    // Double-click guard: if a fetch is already in-flight for the SAME gen,
    // skip. We bumped gen above so any earlier fetch is now stale.
    if (state.quoteLoading) {
      // a previous fetch is still running but will be discarded by its
      // own gen-check; we still kick off the new one.
    }
    state.quoteLoading = true;
    state.quoteError = null;
    renderQuote();
    // Hook expects the *traded* (player/country) token as `token` regardless
    // of buy/sell — that's always the non-quote side, which lives in
    // resolveVenue()'s `baseToken` and equals state.token.address.
    const tradedToken = (state.token?.address ?? '').toLowerCase();
    try {
      const out = await readQuoteFor({
        hook: sideInfo.hook,
        fn: sideInfo.fn,
        token: tradedToken,
        amountIn: amountWei,
      });
      if (myGen !== state.quoteGen) return;
      const minOut = applySlippage(out, state.slippagePct);
      state.quote = {
        amountInWei: amountWei,
        amountOutWei: out,
        minOutWei: minOut,
        side: state.side,
        hook: sideInfo.hook,
        ts: Date.now(),
      };
    } catch (err) {
      if (myGen !== state.quoteGen) return;
      state.quote = null;
      state.quoteError = err?.shortMessage || err?.message || 'Failed to fetch quote';
    } finally {
      if (myGen === state.quoteGen) {
        state.quoteLoading = false;
        renderQuote();
        renderHint();
        renderCta();
      }
    }
  }

  // ── F1.2: allowance read ───────────────────────────────────────────────
  async function readAllowanceFor({ token, owner, spender }) {
    if (readAllowanceOverride) {
      return readAllowanceOverride({ token, owner, spender });
    }
    if (paymentOverride && typeof paymentOverride.readAllowance === 'function') {
      return paymentOverride.readAllowance({ token, owner, spender });
    }
    const client = options.readClient ?? getReadClient();
    const result = await client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [owner, spender],
    });
    return BigInt(result);
  }

  async function refreshAllowance() {
    const sideInfo = resolveSide();
    if (!sideInfo || !sideInfo.router || !state.account.isConnected || !state.account.address) {
      state.allowanceWei = null;
      renderCta();
      return;
    }
    state.allowanceGen += 1;
    const myGen = state.allowanceGen;
    state.allowanceLoading = true;
    try {
      const a = await readAllowanceFor({
        token: sideInfo.inputToken,
        owner: state.account.address,
        spender: sideInfo.router,
      });
      if (myGen !== state.allowanceGen) return; // stale
      state.allowanceWei = a;
    } catch (err) {
      if (myGen !== state.allowanceGen) return;
      // Don't surface — allowance failure shouldn't break the quote UI.
      // CTA will fall back to disabled-by-balance/quote checks; the user
      // can retry by typing.
      state.allowanceWei = null;
      console.warn('trade-panel: allowance read failed', err);
    } finally {
      if (myGen === state.allowanceGen) {
        state.allowanceLoading = false;
        renderCta();
      }
    }
  }

  // ── Wave 3 — limit-mode allowance (executor spender) ─────────────────────
  /**
   * Resolve the spending-token + spender pair for the current side / venue.
   * Returns null when we can't resolve (no token / no executor / no PITCH
   * address). Used by both the allowance read and the approve click handler.
   */
  function resolveLimitApproval() {
    const v = resolveVenue(state.token, state.contracts?.pitch);
    if (!v) return null;
    return resolveLimitSpenderAndToken({
      side: state.side,
      venue: v,
      executor: state.contracts?.limitOrderExecutor,
    });
  }

  async function refreshLimitAllowance() {
    const approval = resolveLimitApproval();
    if (!approval || !state.account.isConnected || !state.account.address) {
      state.limitAllowanceWei = null;
      if (state.mode === 'limit') renderCta();
      return;
    }
    state.limitAllowanceGen += 1;
    const myGen = state.limitAllowanceGen;
    state.limitAllowanceLoading = true;
    if (state.mode === 'limit') renderCta();
    try {
      const a = await readAllowanceFor({
        token: approval.spendingToken,
        owner: state.account.address,
        spender: approval.spender,
      });
      if (myGen !== state.limitAllowanceGen) return; // stale
      state.limitAllowanceWei = a;
    } catch (err) {
      if (myGen !== state.limitAllowanceGen) return;
      state.limitAllowanceWei = null;
      console.warn('trade-panel: limit allowance read failed', err);
    } finally {
      if (myGen === state.limitAllowanceGen) {
        state.limitAllowanceLoading = false;
        if (state.mode === 'limit') renderCta();
      }
    }
  }

  function scheduleQuote() {
    if (state.quoteTimer != null) {
      clearTimeout(state.quoteTimer);
      state.quoteTimer = null;
    }
    state.quoteTimer = setTimeout(() => {
      state.quoteTimer = null;
      refreshQuote().catch(() => {
        // Errors are already stored in state.quoteError.
      });
    }, debounceMs);
  }

  // ── Event handlers ─────────────────────────────────────────────────────
  function onSideClick(ev) {
    const target = ev.target instanceof Element ? ev.target.closest('[data-side]') : null;
    if (!(target instanceof HTMLElement)) return;
    const side = target.dataset.side;
    if (!side || !TABS.includes(side) || state.side === side) return;
    state.side = side;
    // Side change → input/output swap → balance/allowance/quote must refresh.
    state.allowanceWei = null;
    // Wave 3 — limit-mode spending token also flips on side change
    // (limit-buy spends quote, take-profit spends base) — invalidate the
    // stale allowance so the CTA can't misread "approved" for the wrong
    // token while the new read is in flight.
    state.limitAllowanceWei = null;
    renderSideAria();
    refreshBalance();
    refreshAllowance();
    refreshLimitAllowance();
    // Wave 2A — breakdown sense (Spending vs Selling, naive direction) flips
    // with the side; render synchronously without waiting for the quote.
    renderFeeBreakdown();
    scheduleQuote();
  }

  function onModeClick(ev) {
    const target = ev.target instanceof Element ? ev.target.closest('[data-mode]') : null;
    if (!(target instanceof HTMLElement)) return;
    const mode = target.dataset.mode;
    if (mode !== 'market' && mode !== 'limit') return;
    if (state.mode === mode) return;
    state.mode = mode;
    // F2.x — reflect mode toggle on buttons + show/hide limit-only fields.
    marketBtn.classList.toggle('is-active', state.mode === 'market');
    marketBtn.setAttribute('aria-pressed', state.mode === 'market' ? 'true' : 'false');
    limitBtn.classList.toggle('is-active', state.mode === 'limit');
    limitBtn.setAttribute('aria-pressed', state.mode === 'limit' ? 'true' : 'false');
    limitBlock.hidden = state.mode !== 'limit';
    // Quote block is market-only — limit mode has its own preview line inside
    // `limitBlock`. Hide the live-quote area to avoid confusion ("You receive
    // ≈ X" against an unrelated `quoteBuy` quote).
    quoteBlock.hidden = state.mode === 'limit';
    // Wave 3 — read the executor allowance the first time the user enters
    // limit mode (and on every subsequent toggle in case the user external-
    // approved / revoked between toggles). Fire-and-forget — render guards
    // are in place.
    if (state.mode === 'limit') refreshLimitAllowance();
    renderAll();
  }

  function onAmountInput() {
    state.amountStr = amountInput.value;
    renderCta();
    // The previous quote (if any) is now stale relative to the live input.
    // renderHint() compares quote.amountInWei to the live amount and hides
    // the country-required block during the debounce window so we never show
    // "Required: 5 BRA" while the user is typing "10".
    renderHint();
    // Wave 2A — fee-breakdown depends on amount + token MID; re-render on every
    // keystroke (cheap, no chain reads).
    renderFeeBreakdown();
    scheduleQuote();
  }

  function onSlippageInput() {
    const raw = slipInput.value;
    let parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) parsed = DEFAULT_SLIPPAGE_PCT;
    if (parsed > MAX_SLIPPAGE_PCT) parsed = MAX_SLIPPAGE_PCT;
    state.slippagePct = parsed;
    // Recompute minOut against last quote without re-hitting the chain.
    if (state.quote) {
      state.quote = {
        ...state.quote,
        minOutWei: applySlippage(state.quote.amountOutWei, state.slippagePct),
      };
    }
    renderQuote();
  }

  function onPctClick(ev) {
    const target = ev.target instanceof Element ? ev.target.closest('[data-pct]') : null;
    if (!(target instanceof HTMLElement)) return;
    const pct = Number(target.dataset.pct);
    if (!Number.isFinite(pct)) return;
    if (state.balanceWei == null || state.balanceWei <= 0n) return;
    const amountWei = percentOfBalance(state.balanceWei, pct);
    state.amountStr = formatWei(amountWei, 18);
    amountInput.value = state.amountStr;
    renderCta();
    scheduleQuote();
  }

  // ── F1.2: payment client resolution + approve/swap actions ─────────────
  async function getPayment() {
    if (paymentOverride) return paymentOverride;
    return getDefaultPaymentClient();
  }

  async function onApproveClick() {
    if (state.approvePending || state.swapPending) return;
    const sideInfo = resolveSide();
    if (!sideInfo || !sideInfo.router) return;
    if (!state.account.isConnected || !state.account.address) return;

    state.approvePending = true;
    renderCta();
    let client;
    try {
      client = await getPayment();
    } catch (err) {
      state.approvePending = false;
      renderCta();
      showToast(errorMessage(err, 'Failed to connect wallet'), { kind: 'error' });
      return;
    }
    try {
      await client.approve({
        token: sideInfo.inputToken,
        spender: sideInfo.router,
        amount: MAX_UINT256,
        owner: state.account.address,
      });
      showToast('Approve confirmed', { kind: 'info' });
      // Re-read allowance from chain — don't optimistically set MAX_UINT256
      // (in case the wallet sub-allowance got truncated by some odd token).
      await refreshAllowance();
    } catch (err) {
      if (!isUserRejection(err)) {
        showToast(errorMessage(err, 'Approve failed'), { kind: 'error' });
      }
    } finally {
      state.approvePending = false;
      renderCta();
    }
  }

  async function onSwapClick() {
    if (state.approvePending || state.swapPending) return;
    const sideInfo = resolveSide();
    const amountWei = parseAmountToWei(state.amountStr);
    if (!sideInfo || !sideInfo.router || !amountWei || amountWei <= 0n) return;
    if (!state.account.isConnected || !state.account.address) return;
    if (!state.quote || state.quote.amountInWei !== amountWei) return;

    const tradedToken = (state.token?.address ?? '').toLowerCase();
    if (!tradedToken) return;

    state.swapPending = true;
    renderCta();
    let client;
    try {
      client = await getPayment();
    } catch (err) {
      state.swapPending = false;
      renderCta();
      showToast(errorMessage(err, 'Failed to connect wallet'), { kind: 'error' });
      return;
    }
    const minOut = state.quote.minOutWei;
    // Output-token label for the success toast. F1.4 — sell on a player venue
    // means the user receives the country token; prefer the threaded
    // `countrySymbol` (sidebar) over the legacy address-fallback path.
    const outSymbol =
      state.side === 'buy'
        ? state.token?.symbol || 'tokens'
        : sideInfo.venue === 'country'
          ? 'PITCH'
          : symbolForCountry(state.token?.countryAddress);
    try {
      // F1.4 — capture the tx hash so the success toast can link to Basescan.
      // `payment.swap` returns the hash both for the default wagmi-backed
      // client (`writeContract` → hash) and the test stubs
      // (`vi.fn().mockResolvedValue('0xswaphash')`). When the seam returns
      // something non-stringy we just omit the link rather than crashing.
      const txHash = await client.swap({
        router: sideInfo.router,
        side: state.side,
        token: tradedToken,
        amountIn: amountWei,
        minOut,
        owner: state.account.address,
      });
      const outText = formatWei(state.quote.amountOutWei, 6);
      const link =
        typeof txHash === 'string' && /^0x[0-9a-fA-F]+$/.test(txHash)
          ? { url: `https://basescan.org/tx/${txHash}`, label: 'View on Basescan' }
          : null;
      showToast(`Swap done: ${outText} ${outSymbol}`, { kind: 'info', link });
      // Clear amount, refresh chain state. Order matters — clear first so
      // CTA reverts to "enter amount" while balance refetches.
      state.amountStr = '';
      amountInput.value = '';
      state.quote = null;
      state.quoteError = null;
      renderQuote();
      // Fire-and-forget — refreshes can race each other safely (gen counters
      // guard them).
      refreshBalance();
      refreshAllowance();
    } catch (err) {
      if (!isUserRejection(err)) {
        showToast(errorMessage(err, 'Swap failed'), { kind: 'error' });
      }
    } finally {
      state.swapPending = false;
      renderCta();
    }
  }

  // Wave 3 — limit-mode approve. Calls `approve(executor, max-uint256)` on
  // the spending token (quote for limit-buy, base for take-profit). Mirrors
  // `onApproveClick` for the market path but targets the executor contract
  // rather than the venue router. On success the allowance is re-read so the
  // CTA flips to "Place limit-buy" / "Place take-profit" automatically.
  async function onLimitApproveClick() {
    if (state.limitApprovePending || state.limitSubmitting) return;
    const approval = resolveLimitApproval();
    if (!approval) return;
    if (!state.account.isConnected || !state.account.address) return;

    state.limitApprovePending = true;
    renderCta();
    let client;
    try {
      client = await getPayment();
    } catch (err) {
      state.limitApprovePending = false;
      renderCta();
      showToast(errorMessage(err, 'Failed to connect wallet'), { kind: 'error' });
      return;
    }
    try {
      await client.approve({
        token: approval.spendingToken,
        spender: approval.spender,
        amount: MAX_UINT256,
        owner: state.account.address,
      });
      showToast('Approve confirmed', { kind: 'info' });
      // Re-read allowance from chain — don't optimistically set MAX_UINT256
      // (in case the wallet sub-allowance got truncated by some odd token).
      await refreshLimitAllowance();
    } catch (err) {
      if (!isUserRejection(err)) {
        showToast(errorMessage(err, 'Approve failed'), { kind: 'error' });
      }
    } finally {
      state.limitApprovePending = false;
      renderCta();
    }
  }

  // F2.x — limit-order submit: build typedData → wallet signs → POST /orders.
  // The function is the limit-mode counterpart of `onSwapClick`; both share
  // the same disabled-state guards but live in separate code paths because
  // their dependencies (quote vs signature) are disjoint.
  async function onPlaceLimitClick() {
    if (state.limitSubmitting) return;
    const amountWei = parseAmountToWei(state.amountStr);
    // Wave 2A — `displayWei` is what the user typed (MID-space, chart-space).
    // We sign the EXECUTION-space (ASK/BID) target so the on-chain rate check
    // passes when MID hits the user's number; we also POST `displayWei` as
    // `displayTargetPrice` so the keeper triggers on MID.
    const displayWei = parseAmountToWei(state.limitTriggerPriceStr);
    if (!amountWei || amountWei <= 0n) return;
    if (!displayWei || displayWei <= 0n) return;
    if (!state.account.isConnected || !state.account.address) return;
    if (!state.contracts?.limitOrderExecutor) return;
    const v = resolveVenue(state.token, state.contracts?.pitch);
    if (!v) return;

    // Per docs/eip712.md §3.3 — venue 0=player, 1=country; side 0=limit-buy,
    // 1=take-profit. Frontend maps Buy → limit-buy, Sell → take-profit.
    // `targetPrice` here is still DISPLAY-space; `buildSignableOrder` below
    // converts it to the execution-space value before signing.
    const displayOrder = {
      owner: state.account.address.toLowerCase(),
      token: v.baseToken,
      quoteToken: v.quoteToken,
      venue: v.venue === 'player' ? 0 : 1,
      side: state.side === 'buy' ? 0 : 1,
      targetPrice: displayWei,
      amountIn: amountWei,
      slippageBps: Math.round((state.slippagePct || 0) * 100),
      expiry: state.limitTtlSec > 0 ? Math.floor(Date.now() / 1000) + state.limitTtlSec : 0,
      nonce: randomNonce(),
    };

    // Wave 2A — bridge to execution-space. `signOrder.targetPrice` is now the
    // ASK (limit-buy) or BID (take-profit) the contract verifies; the original
    // displayWei is echoed back so we can POST both.
    let signOrder;
    let displayTargetPriceWei;
    try {
      const out = buildSignableOrder(displayOrder);
      signOrder = out.signOrder;
      displayTargetPriceWei = out.displayTargetPriceWei;
    } catch (err) {
      state.limitError = errorMessage(err, 'Invalid order');
      renderLimit();
      return;
    }

    // UI-side sanity check — keeps us from popping the wallet signer for an
    // obviously-malformed payload. Server still re-validates. We validate the
    // SIGNED order (which is what the wallet pops) so any drift from the
    // bridge surface here, not after the wallet round-trip.
    try {
      validateOrderShape(signOrder);
    } catch (err) {
      state.limitError = errorMessage(err, 'Invalid order');
      renderLimit();
      return;
    }

    state.limitError = null;
    state.limitSubmitting = true;
    renderLimit();
    renderCta();

    const typedData = buildOrderTypedData(
      signOrder,
      state.contracts.limitOrderExecutor,
      state.chainId,
    );
    const signer = signTypedDataOverride ?? defaultSignTypedData;

    try {
      const signature = await signer({ account: state.account.address, typedData });
      if (typeof signature !== 'string' || !signature.startsWith('0x')) {
        throw new Error('Wallet returned an invalid signature');
      }
      const payload = serializeOrder(signOrder);
      // Wave 2A — backend (d94c2af) accepts `displayTargetPrice` as a wei
      // string alongside the existing `targetPrice`. Keeper uses the display
      // value to compare against MID; contract uses the signed value for the
      // rate check. Old backends silently ignore the extra field.
      payload.displayTargetPrice = displayTargetPriceWei.toString();
      await apiClient.createOrder(payload, signature);
      showToast(state.side === 'buy' ? 'Limit-buy order placed' : 'Take-profit order placed', {
        kind: 'info',
      });
      // Clear the form so a follow-up order doesn't accidentally reuse the
      // previous trigger. Amount + slippage stay so the user can tweak +
      // resubmit without retyping.
      state.limitTriggerPriceStr = '';
      limitPriceInput.value = '';
    } catch (err) {
      if (isUserRejection(err)) {
        // User declined in the wallet — surface a soft notice + clear the
        // submitting flag, no toast (matches access.js pay-flow UX).
        state.limitError = null;
      } else {
        state.limitError = errorMessage(err, 'Failed to place order');
        showToast(state.limitError, { kind: 'error' });
      }
    } finally {
      state.limitSubmitting = false;
      renderLimit();
      renderCta();
    }
  }

  function onCtaClick() {
    // Defensive — disabled CTA can still fire in some happy-dom paths.
    if (cta.disabled) return;
    const action = cta.dataset.action;
    if (action === 'limit-approve') {
      onLimitApproveClick();
      return;
    }
    if (action === 'limit') {
      onPlaceLimitClick();
      return;
    }
    if (action === 'approve') {
      onApproveClick();
    } else {
      onSwapClick();
    }
  }

  // F2.x — limit-form input wiring.
  function onLimitPriceInput() {
    state.limitTriggerPriceStr = limitPriceInput.value;
    renderLimit();
    renderCta();
    // Wave 3 — limit-mode fee breakdown is computed against the target price,
    // not current MID. Re-render on every trigger-price keystroke so the
    // "≈ net out" estimate stays in sync with what the user is typing.
    renderFeeBreakdown();
  }

  function onLimitTtlChange() {
    const v = Number(limitTtlSelect.value);
    state.limitTtlSec = Number.isFinite(v) && v >= 0 ? v : DEFAULT_TTL_SECONDS;
  }

  // F1.3 — country shortcut: fires only when the button is visible (gated by
  // `renderCta`). Calls back to the host with the lowercase address — the
  // host (main.js) resolves it against the sidebar registry and dispatches
  // the same `onTokenSelect` callback the sidebar uses, keeping a single
  // token-switch path.
  function onCountryCtaClick() {
    if (countryCta.hidden || !onCountrySwitch) return;
    const addr = countryCta.dataset.countryAddress;
    if (typeof addr !== 'string' || !addr) return;
    onCountrySwitch(addr);
  }

  // Batch 5 — pro-cover upgrade CTA. Delegates to the host-provided pay-modal
  // factory (or the lazy default import). We swallow open-modal exceptions
  // here so a broken modal dependency never bubbles past the click handler;
  // the modal itself surfaces its own errors via toasts.
  function onCoverCtaClick() {
    if (cover.hidden) return;
    try {
      _openPayModal();
    } catch (err) {
      console.error('trade-panel: openPayModal threw:', err);
    }
  }

  modeRow.addEventListener('click', onModeClick);
  sideRow.addEventListener('click', onSideClick);
  amountInput.addEventListener('input', onAmountInput);
  slipInput.addEventListener('input', onSlippageInput);
  pctRow.addEventListener('click', onPctClick);
  cta.addEventListener('click', onCtaClick);
  countryCta.addEventListener('click', onCountryCtaClick);
  coverCta.addEventListener('click', onCoverCtaClick);
  limitPriceInput.addEventListener('input', onLimitPriceInput);
  limitTtlSelect.addEventListener('change', onLimitTtlChange);

  // Batch 5 — subscribe to access-store transitions so the cover flips off
  // (premium grant) or back on (account switch → unknown/free) without the
  // host having to call refresh manually. Stored in `unsubscribeAccess` for
  // destroy(). Subscribe BEFORE the initial paint so a transition between
  // mount and the first renderAll() can't be missed.
  const unsubscribeAccess = proCoverEnabled ? _subscribeAccess(() => renderCover()) : () => {};

  // ── Wallet subscription ────────────────────────────────────────────────
  const unsubscribeAccount = onAccountChange((acc) => {
    const prev = state.account;
    state.account = acc;
    // Address or chain changed → invalidate balance + allowance + quote.
    if (
      prev.address !== acc.address ||
      prev.chainId !== acc.chainId ||
      prev.isConnected !== acc.isConnected
    ) {
      state.balanceWei = null;
      state.allowanceWei = null;
      state.limitAllowanceWei = null;
      // F1.4 — drop the cached quote on account/chain change. The disabledReason
      // chainId guard already blocks the CTA when the user is off Base, but a
      // stale quote (taken against a previous address/chain) would resurface
      // the moment they switched back to Base and could mislead them about
      // current pool state. Clearing forces a fresh fetch on the next input.
      state.quote = null;
      state.quoteError = null;
      refreshBalance();
      refreshAllowance();
      refreshLimitAllowance();
      // Quote isn't user-specific but disabled-state depends on chainId; re-render.
    }
    renderAll();
  });

  // ── Config bootstrap ───────────────────────────────────────────────────
  // We need the hook + PITCH addresses before we can quote/read balances.
  // /config is FREE — no auth required.
  let configLoaded = false;
  function applyContracts(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    const c = cfg.contracts || {};
    // F2.x — also stash the LimitOrderExecutor address (verifyingContract in
    // the EIP-712 domain). Treat the well-known "all-zeros placeholder" as
    // unset so the limit-CTA stays disabled before the contract is deployed.
    const exec =
      typeof c.limitOrderExecutor === 'string' ? c.limitOrderExecutor.toLowerCase() : null;
    const execValid = exec && exec !== '0x0000000000000000000000000000000000000000' ? exec : null;
    state.contracts = {
      pitch: typeof c.pitch === 'string' ? c.pitch.toLowerCase() : null,
      playerHook: typeof c.playerHook === 'string' ? c.playerHook.toLowerCase() : null,
      countryHook: typeof c.countryHook === 'string' ? c.countryHook.toLowerCase() : null,
      playerRouter: typeof c.playerRouter === 'string' ? c.playerRouter.toLowerCase() : null,
      countryRouter: typeof c.countryRouter === 'string' ? c.countryRouter.toLowerCase() : null,
      limitOrderExecutor: execValid,
    };
    // F2.x — `chainId` from the config response wins over the hardcoded
    // BASE_CHAIN_ID for typedData signing. Falls back to Base (8453).
    state.chainId = typeof cfg.chainId === 'number' && cfg.chainId > 0 ? cfg.chainId : 8453;
    configLoaded = true;
    refreshBalance();
    refreshAllowance();
    refreshLimitAllowance();
    if (state.amountStr) scheduleQuote();
    renderAll();
  }

  // F1.4 — exponential-backoff retry for /config. Without this the panel
  // stayed in "Загрузка конфига…" forever if the first fetch failed (network
  // hiccup, server restart). Schedule: 1s, 2s, 4s, 8s, 16s (capped to 60s),
  // up to 5 attempts after the initial try. After exhaustion we surface a
  // toast asking the user to reload and leave the CTA disabled — that's
  // strictly better than silent failure, and a manual reload is the right
  // remediation since the rest of the bootstrap chain (sidebar, chart) may
  // also be broken in a way the panel can't see.
  //
  // Each timer is tracked so destroy() can cancel pending retries — without
  // this a re-mount would leak a fetcher that races the new instance's state.
  const configRetryTimers = new Set();
  const CONFIG_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000]; // capped at 60s by Math.min if extended
  let configAttempt = 0;
  // F1.4 fix — destroyed flag for in-flight `getConfig()` continuations.
  // destroy() clears the pending retry timers but cannot cancel an
  // already-fired fetch. Without this guard the resolved `.then`/`.catch`
  // would call applyContracts() / showToast() / schedule a fresh retry
  // against a torn-down panel — writing to detached state and re-rendering
  // a detached DOM. Setting `destroyed = true` in destroy() short-circuits
  // both branches.
  let destroyed = false;
  function attemptConfigFetch() {
    return Promise.resolve()
      .then(() => apiClient.getConfig())
      .then((cfg) => {
        if (configLoaded || destroyed) return;
        applyContracts(cfg);
      })
      .catch(() => {
        if (configLoaded || destroyed) return; // somebody else succeeded, or panel is gone
        if (configAttempt >= CONFIG_RETRY_DELAYS_MS.length) {
          // Out of retries — surface ONE final toast. Stays disabled.
          showToast('Failed to load config. Reload the page.', {
            kind: 'error',
            duration: 8000,
          });
          return;
        }
        const delay = Math.min(60000, CONFIG_RETRY_DELAYS_MS[configAttempt]);
        configAttempt += 1;
        const t = setTimeout(() => {
          configRetryTimers.delete(t);
          attemptConfigFetch();
        }, delay);
        configRetryTimers.add(t);
      });
  }
  attemptConfigFetch();

  // F1.3 — populate the country symbol map from /tokens. One-shot; if it
  // fails the UI degrades to `shortenAddress` labels. Same endpoint the
  // sidebar already uses, so the response is hot in the HTTP cache on a
  // typical bootstrap. No `getTokens` on the apiClient → skip silently
  // (mainly the older standalone test fixtures that only stub getConfig).
  if (typeof apiClient.getTokens === 'function') {
    Promise.resolve()
      .then(() => apiClient.getTokens())
      .then((data) => {
        const countries = Array.isArray(data?.countries) ? data.countries : [];
        for (const c of countries) {
          if (
            c &&
            typeof c.address === 'string' &&
            c.address &&
            typeof c.symbol === 'string' &&
            c.symbol
          ) {
            state.countrySymbolMap.set(c.address.toLowerCase(), c.symbol);
          }
        }
        // Re-render the affected surfaces so the new symbols replace any
        // shortenAddress placeholders that rendered during the initial paint.
        renderBalance();
        renderHint();
        renderCta();
      })
      .catch(() => {
        // Silent — the address-based fallback still works.
      });
  }

  // ── Public API ─────────────────────────────────────────────────────────
  function setToken(token) {
    const same = state.token?.address === token?.address;
    state.token = token ?? null;
    if (!same) {
      // Reset transient state on token switch — but keep amount/slippage so
      // the user doesn't have to re-type when flipping between tokens.
      state.quote = null;
      state.quoteError = null;
      state.balanceWei = null;
      state.allowanceWei = null;
      state.limitAllowanceWei = null;
      refreshBalance();
      refreshAllowance();
      refreshLimitAllowance();
      if (state.amountStr) scheduleQuote();
    }
    renderAll();
  }

  function getState() {
    // Shallow snapshot — for tests + future debug overlay.
    return {
      mode: state.mode,
      side: state.side,
      amountStr: state.amountStr,
      slippagePct: state.slippagePct,
      balanceWei: state.balanceWei,
      quote: state.quote,
      quoteError: state.quoteError,
      quoteLoading: state.quoteLoading,
      allowanceWei: state.allowanceWei,
      approvePending: state.approvePending,
      swapPending: state.swapPending,
      token: state.token,
      account: state.account,
      contracts: state.contracts,
      // F2.x — limit-mode state surfaced for tests + debug overlay.
      limitTriggerPriceStr: state.limitTriggerPriceStr,
      limitTtlSec: state.limitTtlSec,
      limitSubmitting: state.limitSubmitting,
      limitError: state.limitError,
      // Wave 3 hotfix — executor-spender allowance state.
      limitAllowanceWei: state.limitAllowanceWei,
      limitAllowanceLoading: state.limitAllowanceLoading,
      limitApprovePending: state.limitApprovePending,
    };
  }

  function destroy() {
    // F1.4 fix — set flag BEFORE clearing timers so any continuation that
    // resolves between this call and the timer cleanup also sees `destroyed`
    // and bails out of applyContracts/retry-scheduling.
    destroyed = true;
    if (state.quoteTimer != null) {
      clearTimeout(state.quoteTimer);
      state.quoteTimer = null;
    }
    // F1.4 — clean up any pending config-retry timers to prevent a stale
    // fetcher resolving against a torn-down state.
    for (const t of configRetryTimers) clearTimeout(t);
    configRetryTimers.clear();
    modeRow.removeEventListener('click', onModeClick);
    sideRow.removeEventListener('click', onSideClick);
    amountInput.removeEventListener('input', onAmountInput);
    slipInput.removeEventListener('input', onSlippageInput);
    pctRow.removeEventListener('click', onPctClick);
    cta.removeEventListener('click', onCtaClick);
    countryCta.removeEventListener('click', onCountryCtaClick);
    coverCta.removeEventListener('click', onCoverCtaClick);
    limitPriceInput.removeEventListener('input', onLimitPriceInput);
    limitTtlSelect.removeEventListener('change', onLimitTtlChange);
    unsubscribeAccount();
    try {
      unsubscribeAccess();
    } catch {
      /* ignore */
    }
    container.replaceChildren();
  }

  // Initial paint.
  renderAll();

  // Batch 5 — expose lock state for hosts that need to coordinate other UI
  // (e.g. main.js can keep the right-zone soft-lock disabled now that the
  // panel ships its own cover, but a future debug overlay might want to query).
  function isLocked() {
    return proCoverEnabled && _getAccessState() !== 'premium';
  }

  return { setToken, refreshQuote, getState, destroy, isLocked };
}
