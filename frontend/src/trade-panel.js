/**
 * Trade panel (Market) — F1.1.
 *
 * Right-column market-trade widget. This phase implements ONLY:
 *   - Toggle Market / Limit (Limit disabled — phase 2)
 *   - Buy / Sell tabs
 *   - amount input + 25/50/75/Max quick-fill buttons (from balance)
 *   - slippage input (default 1%)
 *   - live quote via viem `readContract` against pitchwc Hook (quoteBuy/Sell)
 *   - fee breakdown (5% pitchwc + slippage)
 *   - disabled state when not on Base / wallet disconnected / no token
 *
 * Approve + swap (F1.2) is intentionally OUT of scope — this is read-only.
 *
 * Venue resolution:
 *   - token has `countryAddress` (truthy)  → player venue, hook = playerHook,
 *     quoteToken = countryAddress,  baseToken = token.address
 *   - otherwise                            → country venue, hook = countryHook,
 *     quoteToken = PITCH,           baseToken = token.address
 *
 * Mount contract follows the rest of the codebase (build-once DOM, hidden
 * toggle for tabs, `state.loading` guard, returned handle for destroy/re-wire).
 */

import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

import * as defaultApi from './api.js';
import { getAccount, onAccountChange, BASE_CHAIN_ID } from './wallet.js';

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
];

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
 * Order matters — first hit wins.
 *
 * @param {{
 *   walletConnected: boolean,
 *   chainId: number|null,
 *   token: object|null,
 *   contractsReady: boolean,
 *   amountWei: bigint|null,
 *   balanceWei: bigint|null,
 *   limitMode: boolean,
 * }} ctx
 * @returns {string|null}
 */
export function disabledReason(ctx) {
  if (ctx.limitMode) return 'Лимит-ордера — фаза 2';
  if (!ctx.walletConnected) return 'Подключите кошелёк';
  if (ctx.chainId !== BASE_CHAIN_ID) return 'Переключитесь на Base';
  if (!ctx.token) return 'Выберите токен';
  if (!ctx.contractsReady) return 'Загрузка конфига…';
  if (!ctx.amountWei || ctx.amountWei <= 0n) return 'Введите сумму';
  if (ctx.balanceWei != null && ctx.amountWei > ctx.balanceWei) return 'Недостаточно средств';
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
 * @property {number} [debounceMs]
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
    // Generation counters discard stale async results.
    quoteGen: 0,
    balanceGen: 0,
    // Debounce timer.
    quoteTimer: null,
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

  // CTA button (disabled in F1.1 — wired in F1.2).
  const cta = el('button', {
    className: 'pt-btn pt-btn--primary pt-trade__cta',
    dataset: { testId: 'trade-cta' },
    attrs: { type: 'button', disabled: 'disabled' },
    text: 'Buy',
  });

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
  root.appendChild(cta);
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
    if (typeof hook !== 'string' || !hook) return null;
    if (state.side === 'buy') {
      return {
        venue: v.venue,
        hook: hook.toLowerCase(),
        fn: 'quoteBuy',
        inputToken: v.quoteToken,
        outputToken: v.baseToken,
      };
    }
    return {
      venue: v.venue,
      hook: hook.toLowerCase(),
      fn: 'quoteSell',
      inputToken: v.baseToken,
      outputToken: v.quoteToken,
    };
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
    balanceLine.textContent = `Баланс: ${formatWei(state.balanceWei, 6)}`;
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
    const reason = disabledReason({
      walletConnected: state.account.isConnected,
      chainId: state.account.chainId,
      token: state.token,
      contractsReady: !!state.contracts,
      amountWei,
      balanceWei: state.balanceWei,
      limitMode: state.mode === 'limit',
    });
    cta.disabled = reason != null;
    status.textContent = reason ?? '';
  }

  function renderAll() {
    renderSideAria();
    renderBalance();
    renderQuote();
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
    // Side change → input/output swap → both balance and quote must refresh.
    renderSideAria();
    refreshBalance();
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

  modeRow.addEventListener('click', onModeClick);
  sideRow.addEventListener('click', onSideClick);
  amountInput.addEventListener('input', onAmountInput);
  slipInput.addEventListener('input', onSlippageInput);
  pctRow.addEventListener('click', onPctClick);

  // ── Wallet subscription ────────────────────────────────────────────────
  const unsubscribeAccount = onAccountChange((acc) => {
    const prev = state.account;
    state.account = acc;
    // Address or chain changed → invalidate balance + quote.
    if (prev.address !== acc.address || prev.chainId !== acc.chainId || prev.isConnected !== acc.isConnected) {
      state.balanceWei = null;
      refreshBalance();
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
      refreshBalance();
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
    unsubscribeAccount();
    container.replaceChildren();
  }

  // Initial paint.
  renderAll();

  return { setToken, refreshQuote, getState, destroy };
}
