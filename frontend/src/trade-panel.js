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

// ─── Constants ──────────────────────────────────────────────────────────────

const QUOTE_DEBOUNCE_MS = 400;
const DEFAULT_SLIPPAGE_PCT = 1.0;
const MAX_SLIPPAGE_PCT = 10.0; // matches LimitOrderExecutor MAX_SLIPPAGE_BPS = 1000
const PITCHWC_FEE_BPS = 500; // pitchwc 5% — informational, the Hook quote already nets it out

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
  if (ctx.limitMode) return 'Лимит-ордера — фаза 2';
  if (ctx.approvePending) return 'Подтвердите approve в кошельке…';
  if (ctx.swapPending) return 'Ждём подтверждение свопа…';
  if (!ctx.walletConnected) return 'Подключите кошелёк';
  if (ctx.chainId !== BASE_CHAIN_ID) return 'Переключитесь на Base';
  if (!ctx.token) return 'Выберите токен';
  if (!ctx.contractsReady) return 'Загрузка конфига…';
  if (!ctx.amountWei || ctx.amountWei <= 0n) return 'Введите сумму';
  if (ctx.balanceWei != null && ctx.amountWei > ctx.balanceWei) {
    if (ctx.playerBuy) {
      const sym = ctx.countrySymbol || 'country';
      const need = formatWei(ctx.amountWei, 6);
      return `Нужно ${need} ${sym}. Купи на Country panel.`;
    }
    return 'Недостаточно средств';
  }
  // F1.2 fix: while allowance is being read we can't decide approve-vs-swap.
  // Block the CTA to prevent a null-allowance race where the user clicks
  // "Buy" before refreshAllowance resolves and the swap reverts on ERC20
  // transferFrom. Sits below balance check so the more informative
  // "Недостаточно средств" still wins; sits below pending flags so an
  // in-flight tx label keeps priority.
  if (ctx.allowanceLoading) return 'Проверка allowance…';
  return null;
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
  const debounceMs = typeof options.debounceMs === 'number' ? options.debounceMs : QUOTE_DEBOUNCE_MS;

  // Test-overrides for chain reads. In prod we hit viem.
  const readBalanceOverride = options.readBalance ?? null;
  const readQuoteOverride = options.readQuote ?? null;
  const readAllowanceOverride = options.readAllowance ?? null;
  // F1.2 — payment client (writes). Tests inject a mock; prod gets lazy
  // viem/wagmi client on first use.
  const paymentOverride = options.payment ?? null;

  // F1.3 — callback to ask the host to switch to the country token row.
  // Optional — if absent the "Купить country" CTA is hidden entirely so the
  // standalone panel still degrades gracefully.
  const onCountrySwitch = typeof options.onCountrySwitch === 'function'
    ? options.onCountrySwitch
    : null;

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
  };

  // ── Build skeleton (build-once) ────────────────────────────────────────
  const root = el('div', {
    className: 'pt-trade',
    dataset: { testId: 'trade-panel', zone: 'trade' },
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
      disabled: 'disabled',
      title: 'Лимит-ордера — фаза 2',
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
    text: 'Баланс: —',
  });

  const amountWrap = el('label', { className: 'pt-trade__amount' });
  amountWrap.appendChild(el('span', { className: 'pt-trade__label', text: 'Сумма' }));
  const amountInput = el('input', {
    className: 'pt-trade__input',
    dataset: { testId: 'trade-amount' },
    attrs: {
      type: 'text',
      inputmode: 'decimal',
      placeholder: '0.0',
      'aria-label': 'Сумма для обмена',
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
      'aria-label': 'Slippage в процентах',
    },
  });
  slipInput.value = String(DEFAULT_SLIPPAGE_PCT);
  slipWrap.appendChild(slipInput);

  // Quote block.
  const quoteBlock = el('div', {
    className: 'pt-trade__quote',
    dataset: { testId: 'trade-quote' },
  });
  const quoteOutLine = el('div', { className: 'pt-trade__quote-out', dataset: { testId: 'quote-out' } });
  const quoteMinLine = el('div', { className: 'pt-trade__quote-min', dataset: { testId: 'quote-min' } });
  const quoteFeeLine = el('div', { className: 'pt-trade__quote-fee', dataset: { testId: 'quote-fee' } });
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

  // CTA button (disabled in F1.1 — wired in F1.2).
  const cta = el('button', {
    className: 'pt-btn pt-btn--primary pt-trade__cta',
    dataset: { testId: 'trade-cta' },
    attrs: { type: 'button', disabled: 'disabled' },
    text: 'Buy',
  });

  // F1.3 — secondary CTA: "Купить country". Shown only when player+Buy AND
  // insufficient country balance AND a `onCountrySwitch` callback was wired.
  // Click delegates back to the host (sidebar/router) — the panel never
  // touches navigation itself.
  const countryCta = el('button', {
    className: 'pt-btn pt-trade__country-cta',
    dataset: { testId: 'trade-country-cta' },
    attrs: { type: 'button' },
    text: 'Купить country',
  });
  countryCta.hidden = true;

  const status = el('div', {
    className: 'pt-trade__status',
    dataset: { testId: 'trade-status' },
  });

  root.appendChild(modeRow);
  root.appendChild(sideRow);
  root.appendChild(balanceLine);
  root.appendChild(amountWrap);
  root.appendChild(pctRow);
  root.appendChild(slipWrap);
  root.appendChild(quoteBlock);
  root.appendChild(hintBlock);
  root.appendChild(cta);
  root.appendChild(countryCta);
  root.appendChild(status);
  container.appendChild(root);

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
    const router = v.venue === 'player' ? state.contracts?.playerRouter : state.contracts?.countryRouter;
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
   * Resolve a display symbol for a country-token address. Returns the cached
   * symbol when getTokens() has filled the map; falls back to the shortened
   * address (e.g. `0xcccc…0001`) otherwise. F1.3 helper.
   */
  function symbolForCountry(addr) {
    if (typeof addr !== 'string' || !addr) return 'country';
    const cached = state.countrySymbolMap.get(addr.toLowerCase());
    if (cached) return cached;
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
      balanceLine.textContent = 'Баланс: подключите кошелёк';
      return;
    }
    if (state.balanceLoading) {
      balanceLine.textContent = 'Баланс: загрузка…';
      return;
    }
    if (state.balanceWei == null) {
      balanceLine.textContent = 'Баланс: —';
      return;
    }
    // F1.3: suffix the symbol of the *input* token so the user knows what the
    // balance refers to (e.g. on player+Buy this is the country balance, not
    // the player token's). Falls back to an unsuffixed label if we can't
    // resolve.
    const sym = inputTokenSymbol();
    const value = formatWei(state.balanceWei, 6);
    balanceLine.textContent = sym ? `Баланс: ${value} ${sym}` : `Баланс: ${value}`;
  }

  /**
   * F1.3 — player+Buy hint block. Renders "Требуется: X CC / Ваш баланс: Y CC"
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
    hintRequiredLine.textContent = `Требуется: ${need} ${sym}`;
    hintBalanceLine.textContent = `Ваш баланс: ${have} ${sym}`;
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
      quoteOutLine.textContent = 'Котировка…';
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
    quoteOutLine.textContent = `Получите ≈ ${outText}`;
    quoteMinLine.textContent = `Минимум (с учётом slippage): ${minText}`;
    quoteFeeLine.textContent = `Комиссия pitchwc: ${(PITCHWC_FEE_BPS / 100).toFixed(1)}% + slippage ${state.slippagePct}%`;
  }

  function renderCta() {
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
      limitMode: state.mode === 'limit',
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
    // "Нужно X CC. Купи на Country panel." string — the CTA reinforces it.
    const insufficientCountry =
      playerBuy &&
      state.balanceWei != null &&
      amountWei != null &&
      amountWei > 0n &&
      amountWei > state.balanceWei;
    const showCountryCta =
      onCountrySwitch != null &&
      insufficientCountry &&
      !state.approvePending &&
      !state.swapPending;
    countryCta.hidden = !showCountryCta;
    if (showCountryCta) {
      // Best-effort symbol label so the user sees "Купить BRA" not
      // "Купить country" once the registry has loaded.
      const sym = countrySymbol && countrySymbol !== 'country' ? countrySymbol : null;
      countryCta.textContent = sym ? `Купить ${sym}` : 'Купить country';
      countryCta.dataset.countryAddress = (state.token?.countryAddress ?? '').toLowerCase();
    } else {
      delete countryCta.dataset.countryAddress;
    }

    // F1.2 — CTA label & mode (swap vs approve).
    // When user must approve before swap, swap the label to "Approve" so the
    // expected popup matches the click.
    const needsApprove =
      !reason &&
      amountWei != null &&
      state.allowanceWei != null &&
      state.allowanceWei < amountWei;

    if (state.approvePending) {
      cta.textContent = 'Approve…';
    } else if (state.swapPending) {
      cta.textContent = state.side === 'buy' ? 'Buy…' : 'Sell…';
    } else if (needsApprove) {
      cta.textContent = 'Approve';
    } else {
      cta.textContent = state.side === 'buy' ? 'Buy' : 'Sell';
    }
    cta.dataset.action = needsApprove && !state.approvePending && !state.swapPending
      ? 'approve'
      : 'swap';

    // Swap requires a fresh quote (otherwise no minOut). Approve doesn't.
    const swapNeedsQuote = !needsApprove && (state.quote == null || state.quote.amountInWei !== amountWei);

    cta.disabled = reason != null || swapNeedsQuote;
    status.textContent = reason ?? '';
  }

  function renderAll() {
    renderSideAria();
    renderBalance();
    renderQuote();
    renderHint();
    renderCta();
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
      state.quoteError = err?.shortMessage || err?.message || 'Не удалось получить котировку';
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
    if (
      !sideInfo ||
      !sideInfo.router ||
      !state.account.isConnected ||
      !state.account.address
    ) {
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
    renderSideAria();
    refreshBalance();
    refreshAllowance();
    scheduleQuote();
  }

  function onModeClick(ev) {
    const target = ev.target instanceof Element ? ev.target.closest('[data-mode]') : null;
    if (!(target instanceof HTMLElement)) return;
    const mode = target.dataset.mode;
    if (mode === 'limit') {
      // Disabled — phase 2.
      return;
    }
    if (mode !== 'market' || state.mode === mode) return;
    state.mode = mode;
    renderCta();
  }

  function onAmountInput() {
    state.amountStr = amountInput.value;
    renderCta();
    // The previous quote (if any) is now stale relative to the live input.
    // renderHint() compares quote.amountInWei to the live amount and hides
    // the country-required block during the debounce window so we never show
    // "Требуется: 5 BRA" while the user is typing "10".
    renderHint();
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
      showToast(errorMessage(err, 'Не удалось подключить кошелёк'), { kind: 'error' });
      return;
    }
    try {
      await client.approve({
        token: sideInfo.inputToken,
        spender: sideInfo.router,
        amount: MAX_UINT256,
        owner: state.account.address,
      });
      showToast('Approve выполнен', { kind: 'info' });
      // Re-read allowance from chain — don't optimistically set MAX_UINT256
      // (in case the wallet sub-allowance got truncated by some odd token).
      await refreshAllowance();
    } catch (err) {
      if (!isUserRejection(err)) {
        showToast(errorMessage(err, 'Approve не удался'), { kind: 'error' });
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
      showToast(errorMessage(err, 'Не удалось подключить кошелёк'), { kind: 'error' });
      return;
    }
    const minOut = state.quote.minOutWei;
    // Output-token label for the success toast. Sell on a player venue means
    // the user receives the country token, whose symbol we don't carry on
    // state.token (it lives on the sidebar row); fall back to a shortened
    // address rather than the literal "country". F1.4 refinement: thread
    // countrySymbol through setToken.
    const outSymbol =
      state.side === 'buy'
        ? state.token?.symbol || 'tokens'
        : sideInfo.venue === 'country'
          ? 'PITCH'
          : shortenAddress(state.token?.countryAddress);
    try {
      await client.swap({
        router: sideInfo.router,
        side: state.side,
        token: tradedToken,
        amountIn: amountWei,
        minOut,
        owner: state.account.address,
      });
      const outText = formatWei(state.quote.amountOutWei, 6);
      showToast(`Своп выполнен: ${outText} ${outSymbol}`, { kind: 'info' });
      // Clear amount, refresh chain state. Order matters — clear first so
      // CTA reverts to "введите сумму" while balance refetches.
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
        showToast(errorMessage(err, 'Своп не удался'), { kind: 'error' });
      }
    } finally {
      state.swapPending = false;
      renderCta();
    }
  }

  function onCtaClick() {
    // Defensive — disabled CTA can still fire in some happy-dom paths.
    if (cta.disabled) return;
    const action = cta.dataset.action;
    if (action === 'approve') {
      onApproveClick();
    } else {
      onSwapClick();
    }
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

  modeRow.addEventListener('click', onModeClick);
  sideRow.addEventListener('click', onSideClick);
  amountInput.addEventListener('input', onAmountInput);
  slipInput.addEventListener('input', onSlippageInput);
  pctRow.addEventListener('click', onPctClick);
  cta.addEventListener('click', onCtaClick);
  countryCta.addEventListener('click', onCountryCtaClick);

  // ── Wallet subscription ────────────────────────────────────────────────
  const unsubscribeAccount = onAccountChange((acc) => {
    const prev = state.account;
    state.account = acc;
    // Address or chain changed → invalidate balance + allowance + quote.
    if (prev.address !== acc.address || prev.chainId !== acc.chainId || prev.isConnected !== acc.isConnected) {
      state.balanceWei = null;
      state.allowanceWei = null;
      refreshBalance();
      refreshAllowance();
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
    state.contracts = {
      pitch: typeof c.pitch === 'string' ? c.pitch.toLowerCase() : null,
      playerHook: typeof c.playerHook === 'string' ? c.playerHook.toLowerCase() : null,
      countryHook: typeof c.countryHook === 'string' ? c.countryHook.toLowerCase() : null,
      playerRouter: typeof c.playerRouter === 'string' ? c.playerRouter.toLowerCase() : null,
      countryRouter: typeof c.countryRouter === 'string' ? c.countryRouter.toLowerCase() : null,
    };
    configLoaded = true;
    refreshBalance();
    refreshAllowance();
    if (state.amountStr) scheduleQuote();
    renderAll();
  }

  // Kick off config fetch — but don't block UI mount.
  Promise.resolve()
    .then(() => apiClient.getConfig())
    .then((cfg) => {
      if (!configLoaded) applyContracts(cfg);
    })
    .catch(() => {
      // Stays in "config loading" disabled state. A future retry path
      // (F1.4 polish) can re-fetch; for now the user can refresh the page.
    });

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
      refreshBalance();
      refreshAllowance();
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
    };
  }

  function destroy() {
    if (state.quoteTimer != null) {
      clearTimeout(state.quoteTimer);
      state.quoteTimer = null;
    }
    modeRow.removeEventListener('click', onModeClick);
    sideRow.removeEventListener('click', onSideClick);
    amountInput.removeEventListener('input', onAmountInput);
    slipInput.removeEventListener('input', onSlippageInput);
    pctRow.removeEventListener('click', onPctClick);
    cta.removeEventListener('click', onCtaClick);
    countryCta.removeEventListener('click', onCountryCtaClick);
    unsubscribeAccount();
    container.replaceChildren();
  }

  // Initial paint.
  renderAll();

  return { setToken, refreshQuote, getState, destroy };
}
