/**
 * Premium-access pay flow — F0.12.
 *
 * Renders a pay-banner in the layout banner zone for users without premium
 * access and drives the full purchase flow when clicked:
 *   1. Defensive `/config?fresh=1` re-fetch (race-proof against fresh
 *      `setPrice` / `setReferralSplit` on-chain) — see api-spec §3.2.
 *   2. Compute the buyer payment with the referral discount (BigInt math).
 *   3. Display the breakdown in a payment modal — price, discount, total,
 *      referrer (address + handle if known), disclaimer, links.
 *   4. Read `allowance(pitch, owner, accessContract)` via the injected viem
 *      reader.
 *   5. If allowance < payment:
 *        - allowance > 0 → `approve(0)` then `approve(payment)` (USDT-safety).
 *        - allowance == 0 → single `approve(payment)`.
 *   6. `accessContract.buyAccess(referrer)` — one popup.
 *   7. Wait for receipt.
 *   8. `getAccess({fresh:true})` — bypass server cache, instant unlock.
 *   9. Trigger an SSE reconnect via the supplied `onPaid` hook (the actual
 *      reconnect is wired by main.js; F0.13/F0.14 will add the premium
 *      `orders` channel).
 *
 * UI errors:
 *   - User rejection → silent close.
 *   - Insufficient PITCH balance → show Uniswap deep-link, block buy button.
 *   - RPC / tx revert → inline error in modal (stays open for retry).
 *
 * Public API:
 *   mountAccessBanner(container, opts?) -> { destroy, refresh }
 *   openPayModal(opts?)                 -> { close }
 *
 * `opts.payment` is the on-chain interface — read it as the seam for
 * dependency injection. Tests pass a mock; production omits it and gets the
 * default viem/wagmi-backed implementation built lazily on first use.
 *
 * Spec: docs/plans/frontend.md §F0.12, docs/functional-spec.md §9,
 * docs/api-spec.md §3.2 + §5.1.
 */

import * as defaultApi from './api.js';
import { getEffectiveRef } from './referral.js';
import {
  subscribe as subscribeConfig,
  get as getConfigSnap,
  merge as mergeConfigSnap,
} from './config-store.js';
import { set as setAccessState } from './access-store.js';
import { getAccount } from './wallet.js';
import { showToast } from './ui/toast.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const STORAGE_RAW = 'referralRaw';
const BPS_DENOMINATOR = 10000n;

const PORTABLE_DOWNLOAD_URL = 'https://github.com/Shaburshila/PitchTerminal';

// ─── Helpers ────────────────────────────────────────────────────────────────

function el(tag, { className, dataset, attrs, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (dataset) for (const [k, v] of Object.entries(dataset)) node.dataset[k] = v;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function safeLocalStorageGet(key) {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Build the Uniswap "buy PITCH" deep-link. Uses the v3 widget URL — outputs
 * PITCH on Base, lets the user pick the input themselves. The spec doesn't
 * prescribe a slippage/amount; we link to the unparameterised swap page and
 * let Uniswap default.
 *
 * @param {string} pitchAddress
 * @returns {string}
 */
export function buildUniswapUrl(pitchAddress) {
  const addr = typeof pitchAddress === 'string' && pitchAddress ? pitchAddress : '';
  // Base chain — 8453 = chain id. Output param = our PITCH token.
  return `https://app.uniswap.org/swap?chain=base&outputCurrency=${encodeURIComponent(addr)}`;
}

/**
 * Format wei (BigInt or numeric string) → human PITCH string, up to `digits`
 * fractional digits, trailing zeros stripped. 18-decimal assumption.
 *
 * @param {bigint|string|number} wei
 * @param {number} [digits=4]
 * @returns {string}
 */
export function formatPitch(wei, digits = 4) {
  let asStr;
  if (typeof wei === 'bigint') asStr = wei.toString();
  else if (typeof wei === 'number' && Number.isFinite(wei)) asStr = String(Math.trunc(wei));
  else if (typeof wei === 'string' && /^-?\d+$/.test(wei.trim())) asStr = wei.trim();
  else return '—';
  const neg = asStr.startsWith('-');
  const abs = neg ? asStr.slice(1) : asStr;
  const padded = abs.padStart(19, '0');
  const whole = padded.slice(0, padded.length - 18);
  const frac = padded.slice(padded.length - 18);
  const fracTrim = frac.slice(0, Math.max(0, digits)).replace(/0+$/, '');
  const out = fracTrim ? `${whole}.${fracTrim}` : whole;
  return neg ? `-${out}` : out;
}

/**
 * Truncate an address `0xabc…7f9`. Returns `''` for falsy input.
 * @param {string|null|undefined} addr
 */
function shortenAddress(addr) {
  if (typeof addr !== 'string' || addr.length < 10) return '';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Compute the buyer payment in wei with discount applied iff a referrer is
 * present. All math is BigInt — never coerce wei through Number.
 *
 * @param {bigint} priceWei
 * @param {number} buyerDiscountBps
 * @param {boolean} hasValidRef
 * @returns {bigint}
 */
export function computeBuyerPay(priceWei, buyerDiscountBps, hasValidRef) {
  if (typeof priceWei !== 'bigint') throw new TypeError('priceWei must be bigint');
  if (!hasValidRef) return priceWei;
  const bps = BigInt(Number.isFinite(buyerDiscountBps) ? buyerDiscountBps : 0);
  if (bps <= 0n) return priceWei;
  if (bps >= BPS_DENOMINATOR) return 0n;
  return (priceWei * (BPS_DENOMINATOR - bps)) / BPS_DENOMINATOR;
}

// ─── Default payment client (lazy viem/wagmi binding) ───────────────────────

const ERC20_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
];

const ACCESS_ABI = [
  {
    type: 'function',
    name: 'buyAccess',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'referrer', type: 'address' }],
    outputs: [],
  },
];

/**
 * Build the default payment client backed by wagmi (`@wagmi/core`) +
 * viem. Lazy — the import only runs when the user actually clicks "Pay" so
 * the cold-load cost of the contract stack is paid post-CTA.
 *
 * Test code never reaches this — pass an `opts.payment` mock instead.
 *
 * @returns {Promise<PaymentClient>}
 */
async function buildDefaultPaymentClient() {
  const [{ getWagmiConfig }, wagmi] = await Promise.all([
    import('./wallet.js'),
    import('@wagmi/core'),
  ]);
  const config = getWagmiConfig();
  return {
    async readAllowance({ pitchAddress, owner, spender }) {
      return wagmi.readContract(config, {
        abi: ERC20_ABI,
        address: pitchAddress,
        functionName: 'allowance',
        args: [owner, spender],
      });
    },
    async readBalance({ pitchAddress, owner }) {
      return wagmi.readContract(config, {
        abi: ERC20_ABI,
        address: pitchAddress,
        functionName: 'balanceOf',
        args: [owner],
      });
    },
    async approve({ pitchAddress, spender, amount, owner }) {
      const hash = await wagmi.writeContract(config, {
        abi: ERC20_ABI,
        address: pitchAddress,
        functionName: 'approve',
        args: [spender, amount],
        account: owner,
      });
      await wagmi.waitForTransactionReceipt(config, { hash });
      return hash;
    },
    async buyAccess({ accessAddress, referrer, owner }) {
      const hash = await wagmi.writeContract(config, {
        abi: ACCESS_ABI,
        address: accessAddress,
        functionName: 'buyAccess',
        args: [referrer],
        account: owner,
      });
      await wagmi.waitForTransactionReceipt(config, { hash });
      return hash;
    },
  };
}

/** @typedef {object} PaymentClient
 *  @property {(p:{pitchAddress:string,owner:string,spender:string}) => Promise<bigint>} readAllowance
 *  @property {(p:{pitchAddress:string,owner:string}) => Promise<bigint>} readBalance
 *  @property {(p:{pitchAddress:string,spender:string,amount:bigint,owner:string}) => Promise<string>} approve
 *  @property {(p:{accessAddress:string,referrer:string,owner:string}) => Promise<string>} buyAccess
 */

let _defaultPaymentClient = null;
async function getDefaultPaymentClient() {
  if (_defaultPaymentClient) return _defaultPaymentClient;
  _defaultPaymentClient = await buildDefaultPaymentClient();
  return _defaultPaymentClient;
}

// ─── Wallet-rejection error detection ───────────────────────────────────────

/**
 * MetaMask uses `code: 4001` for user rejection; viem wraps wallet errors as
 * `UserRejectedRequestError` with `code: 4001` too. We treat anything that
 * looks like a rejection as a silent close.
 */
function isUserRejection(err) {
  if (!err) return false;
  if (typeof err.code === 'number' && err.code === 4001) return true;
  const cause = err.cause;
  if (cause && typeof cause.code === 'number' && cause.code === 4001) return true;
  // viem's UserRejectedRequestError class name (no need to import the class).
  if (typeof err.name === 'string' && /UserRejected/i.test(err.name)) return true;
  const msg = (err.shortMessage || err.message || '').toLowerCase();
  if (msg.includes('user rejected') || msg.includes('user denied')) return true;
  return false;
}

function errorMessage(err) {
  if (!err) return 'Transaction failed';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    if ('shortMessage' in err && err.shortMessage) return String(err.shortMessage);
    if ('message' in err && err.message) return String(err.message);
  }
  return 'Transaction failed';
}

// ─── Pay modal ──────────────────────────────────────────────────────────────

let _activeModal = null;

/**
 * @typedef {object} PayModalOpts
 * @property {string} [accessAddress]      Override `/config.contracts.access`.
 * @property {string} [pitchAddress]       Override `/config.contracts.pitch`.
 * @property {string} [ownerAddress]       Override the connected wallet.
 * @property {{ getConfig: Function, getAccess: Function }} [apiClient]
 * @property {PaymentClient} [payment]     On-chain seam (default: viem/wagmi).
 * @property {() => string|null|undefined} [getCurrentAddress]
 *   Returns the wallet to charge. Defaults to `getAccount().address`.
 * @property {() => string} [getRef]
 *   Returns the effective referrer 0x-address. Default: `getEffectiveRef`.
 * @property {(info:{txHash:string})=>void} [onPaid]
 *   Fired after the buy receipt + `getAccess({fresh:true})`. Use this to
 *   trigger SSE reconnect / premium-channel attach.
 * @property {() => void} [onClose]        Modal closed without success.
 */

/**
 * Open the payment modal. Returns a handle with `close()`.
 * @param {PayModalOpts} [opts]
 */
export function openPayModal(opts = {}) {
  if (typeof document === 'undefined') return { close: () => {} };
  if (_activeModal) {
    try {
      _activeModal.remove();
    } catch {
      /* ignore */
    }
    _activeModal = null;
  }

  const apiClient = opts.apiClient ?? defaultApi;
  const getCurrentAddress =
    typeof opts.getCurrentAddress === 'function'
      ? opts.getCurrentAddress
      : () => getAccount().address;
  const refFn = typeof opts.getRef === 'function' ? opts.getRef : getEffectiveRef;

  // ── DOM scaffold ───────────────────────────────────────────────────────
  const overlay = el('div', {
    className: 'pt-modal-overlay',
    dataset: { testId: 'pay-overlay' },
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pt-pay-title' },
  });
  const card = el('div', { className: 'pt-modal pt-modal--pay' });
  card.appendChild(
    el('h2', {
      className: 'pt-modal__title',
      attrs: { id: 'pt-pay-title' },
      text: 'Premium access',
    }),
  );

  const statusEl = el('div', {
    className: 'pt-modal__status',
    dataset: { testId: 'pay-status' },
  });
  statusEl.hidden = true;

  const breakdownEl = el('div', {
    className: 'pt-pay__breakdown',
    dataset: { testId: 'pay-breakdown' },
  });

  const refEl = el('div', {
    className: 'pt-pay__ref',
    dataset: { testId: 'pay-ref' },
  });
  refEl.hidden = true;

  const disclaimerEl = el('p', {
    className: 'pt-pay__disclaimer',
    dataset: { testId: 'pay-disclaimer' },
    text:
      'One-time payment, lifetime access. One wallet, one access — not a subscription. ' +
      'The transaction is sent directly to the PitchTerminalAccess contract on Base. ' +
      'PitchTerminal never holds your private key.',
  });

  const linksEl = el('div', { className: 'pt-pay__links' });
  const uniLinkWrap = el('div', {
    className: 'pt-pay__uniswap',
    dataset: { testId: 'pay-uniswap' },
  });
  uniLinkWrap.hidden = true;
  const portableLink = el('a', {
    className: 'pt-pay__portable',
    dataset: { testId: 'pay-portable' },
    attrs: { href: PORTABLE_DOWNLOAD_URL, target: '_blank', rel: 'noopener noreferrer' },
    text: 'Download portable version',
  });
  linksEl.appendChild(uniLinkWrap);
  linksEl.appendChild(portableLink);

  const errEl = el('div', {
    className: 'pt-modal__error',
    dataset: { testId: 'pay-error' },
  });
  errEl.hidden = true;

  const actions = el('div', { className: 'pt-modal__actions' });
  const cancelBtn = el('button', {
    className: 'pt-btn',
    dataset: { testId: 'pay-cancel' },
    attrs: { type: 'button' },
    text: 'Cancel',
  });
  const payBtn = el('button', {
    className: 'pt-btn pt-btn--primary',
    dataset: { testId: 'pay-submit' },
    attrs: { type: 'button' },
    text: 'Pay',
  });
  payBtn.disabled = true;
  actions.appendChild(cancelBtn);
  actions.appendChild(payBtn);

  card.appendChild(statusEl);
  card.appendChild(breakdownEl);
  card.appendChild(refEl);
  card.appendChild(disclaimerEl);
  card.appendChild(linksEl);
  card.appendChild(errEl);
  card.appendChild(actions);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  _activeModal = overlay;

  // ── State ──────────────────────────────────────────────────────────────
  /** @type {bigint|null} */
  let priceWei = null;
  /** @type {bigint|null} */
  let payWei = null;
  /** @type {bigint|null} */
  let discountWei = null;
  /** @type {bigint|null} */
  let balanceWei = null;
  /** @type {string} */
  let referrer = ZERO_ADDRESS;
  /** @type {string|null} */
  let accessAddress = null;
  /** @type {string|null} */
  let pitchAddress = null;
  /** @type {string|null} */
  let ownerAddress = null;

  let busy = false;
  let closed = false;
  let paid = false;

  // ── DOM helpers ────────────────────────────────────────────────────────
  function setStatus(text) {
    if (!text) {
      statusEl.hidden = true;
      statusEl.textContent = '';
      return;
    }
    statusEl.hidden = false;
    statusEl.textContent = text;
  }

  function showError(text) {
    errEl.hidden = false;
    errEl.textContent = text;
  }
  function clearError() {
    errEl.hidden = true;
    errEl.textContent = '';
  }

  function renderBreakdown() {
    breakdownEl.replaceChildren();
    if (priceWei == null || payWei == null) {
      breakdownEl.appendChild(
        el('div', {
          className: 'pt-pay__row pt-pay__row--loading',
          dataset: { testId: 'pay-loading' },
          text: 'Fetching current price…',
        }),
      );
      return;
    }
    breakdownEl.appendChild(buildRow('Price', `${formatPitch(priceWei)} PITCH`, 'pay-price'));
    if (discountWei != null && discountWei > 0n) {
      breakdownEl.appendChild(
        buildRow('Referral discount', `−${formatPitch(discountWei)} PITCH`, 'pay-discount'),
      );
    }
    breakdownEl.appendChild(buildRow('Total', `${formatPitch(payWei)} PITCH`, 'pay-total', true));
  }

  function buildRow(label, value, testId, strong = false) {
    const row = el('div', {
      className: strong ? 'pt-pay__row pt-pay__row--strong' : 'pt-pay__row',
      dataset: { testId },
    });
    row.appendChild(el('span', { className: 'pt-pay__row-label', text: label }));
    row.appendChild(el('span', { className: 'pt-pay__row-value', text: value }));
    return row;
  }

  function renderRefBlock() {
    if (referrer === ZERO_ADDRESS) {
      refEl.hidden = true;
      refEl.replaceChildren();
      return;
    }
    refEl.hidden = false;
    refEl.replaceChildren();
    const rawHandle = safeLocalStorageGet(STORAGE_RAW);
    const short = shortenAddress(referrer);
    let txt = `Referred by: ${short}`;
    if (rawHandle && rawHandle !== referrer && !/^0x/i.test(rawHandle)) {
      txt += ` (${rawHandle})`;
    }
    refEl.appendChild(el('span', { text: txt }));
  }

  function renderUniswapLink() {
    uniLinkWrap.replaceChildren();
    if (balanceWei == null || payWei == null || balanceWei >= payWei) {
      uniLinkWrap.hidden = true;
      return;
    }
    uniLinkWrap.hidden = false;
    const need = payWei - balanceWei;
    const msg = el('span', {
      className: 'pt-pay__need',
      text: `Short by ${formatPitch(need)} PITCH. `,
    });
    const link = el('a', {
      className: 'pt-pay__uniswap-link',
      dataset: { testId: 'pay-uniswap-link' },
      attrs: {
        href: buildUniswapUrl(pitchAddress || ''),
        target: '_blank',
        rel: 'noopener noreferrer',
      },
      text: 'Buy PITCH on Uniswap',
    });
    uniLinkWrap.appendChild(msg);
    uniLinkWrap.appendChild(link);
  }

  function updatePayButton() {
    if (paid || busy) return;
    const ready =
      priceWei != null &&
      payWei != null &&
      accessAddress &&
      pitchAddress &&
      ownerAddress &&
      balanceWei != null &&
      balanceWei >= payWei;
    payBtn.disabled = !ready;
  }

  // ── Close ──────────────────────────────────────────────────────────────
  function close({ silent = false } = {}) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (_activeModal === overlay) _activeModal = null;
    if (!paid && !silent && typeof opts.onClose === 'function') {
      try {
        opts.onClose();
      } catch {
        /* ignore */
      }
    }
  }

  function onCancel() {
    if (busy) return; // forbid cancel mid-tx
    close();
  }

  function onKey(ev) {
    if (ev.key === 'Escape') onCancel();
  }

  cancelBtn.addEventListener('click', onCancel);
  document.addEventListener('keydown', onKey);

  // ── Initial load: defensive /config?fresh=1 + balance probe ────────────
  (async () => {
    setStatus('Fetching current price…');
    renderBreakdown();
    try {
      const cfg = await apiClient.getConfig({ fresh: true });
      if (closed) return;
      // Merge into the shared store so other subscribers (banner) see the
      // freshly-fetched values too.
      mergeConfigSnap({
        accessPriceWei: cfg?.accessPriceWei ?? null,
        buyerDiscountBps: cfg?.buyerDiscountBps ?? null,
        referralBps: cfg?.referralBps ?? null,
      });
      accessAddress = opts.accessAddress || cfg?.contracts?.access || null;
      pitchAddress = opts.pitchAddress || cfg?.contracts?.pitch || null;
      const rawPrice = cfg?.accessPriceWei;
      if (typeof rawPrice !== 'string' || !/^\d+$/.test(rawPrice)) {
        throw new Error('Access price is unavailable — please try again later.');
      }
      if (!accessAddress || !pitchAddress) {
        throw new Error('Contract address is not configured.');
      }
      priceWei = BigInt(rawPrice);
      const buyerDiscountBps = Number(cfg?.buyerDiscountBps) || 0;

      ownerAddress = (opts.ownerAddress || getCurrentAddress() || '').toLowerCase() || null;
      if (!ownerAddress) {
        throw new Error('Wallet is not connected.');
      }
      referrer = refFn(ownerAddress, accessAddress) || ZERO_ADDRESS;
      const hasValidRef = referrer !== ZERO_ADDRESS;
      payWei = computeBuyerPay(priceWei, buyerDiscountBps, hasValidRef);
      discountWei = hasValidRef ? priceWei - payWei : 0n;

      renderBreakdown();
      renderRefBlock();
      setStatus('');

      // Probe balance — non-fatal if it fails; user still sees the modal.
      try {
        const client = opts.payment ?? (await getDefaultPaymentClient());
        balanceWei = await client.readBalance({ pitchAddress, owner: ownerAddress });
        if (typeof balanceWei !== 'bigint') {
          balanceWei = balanceWei != null ? BigInt(balanceWei) : null;
        }
      } catch {
        balanceWei = null;
      }
      if (closed) return;
      renderUniswapLink();
      updatePayButton();
    } catch (err) {
      if (closed) return;
      setStatus('');
      showError(errorMessage(err));
    }
  })();

  // ── Pay click ──────────────────────────────────────────────────────────
  async function onPay() {
    if (busy || paid || closed) return;
    if (priceWei == null || payWei == null || !accessAddress || !pitchAddress || !ownerAddress) {
      return;
    }
    busy = true;
    payBtn.disabled = true;
    cancelBtn.disabled = true;
    clearError();

    let client;
    try {
      client = opts.payment ?? (await getDefaultPaymentClient());
    } catch (err) {
      busy = false;
      cancelBtn.disabled = false;
      updatePayButton();
      showError(errorMessage(err));
      return;
    }

    try {
      // 1. Read allowance.
      setStatus('Checking token allowance…');
      let allowance = await client.readAllowance({
        pitchAddress,
        owner: ownerAddress,
        spender: accessAddress,
      });
      if (typeof allowance !== 'bigint') allowance = BigInt(allowance ?? 0);

      // 2. If insufficient, approve (with USDT-style reset if > 0).
      if (allowance < payWei) {
        if (allowance > 0n) {
          setStatus('Resetting allowance… (popup 1/3)');
          await client.approve({
            pitchAddress,
            spender: accessAddress,
            amount: 0n,
            owner: ownerAddress,
          });
          setStatus('Setting new allowance… (popup 2/3)');
          await client.approve({
            pitchAddress,
            spender: accessAddress,
            amount: payWei,
            owner: ownerAddress,
          });
        } else {
          setStatus('Confirm token allowance… (popup 1/2)');
          await client.approve({
            pitchAddress,
            spender: accessAddress,
            amount: payWei,
            owner: ownerAddress,
          });
        }
      }

      // 3. buyAccess.
      setStatus('Purchasing access…');
      const txHash = await client.buyAccess({
        accessAddress,
        referrer,
        owner: ownerAddress,
      });

      // 4. Force-refresh /access — bypass server cache.
      setStatus('Verifying access…');
      try {
        await apiClient.getAccess({ fresh: true });
      } catch {
        // If /access flakes here we still consider the on-chain success
        // authoritative — the next periodic refresh will pick it up. UX-wise
        // the modal can close so the user sees their unlocked premium.
      }

      paid = true;
      if (typeof opts.onPaid === 'function') {
        try {
          opts.onPaid({ txHash });
        } catch {
          /* ignore */
        }
      }
      try {
        showToast('Payment successful. Premium activated.', { kind: 'info' });
      } catch {
        /* non-DOM safe */
      }
      close({ silent: true });
    } catch (err) {
      if (isUserRejection(err)) {
        close({ silent: true });
        return;
      }
      busy = false;
      cancelBtn.disabled = false;
      setStatus('');
      showError(errorMessage(err));
      updatePayButton();
    }
  }

  payBtn.addEventListener('click', onPay);

  return { close };
}

// ─── Banner ─────────────────────────────────────────────────────────────────

/**
 * @typedef {object} BannerOpts
 * @property {{ getAccess: Function, getConfig: Function }} [apiClient]
 * @property {() => string|null|undefined} [getCurrentAddress]
 * @property {PaymentClient} [payment]
 * @property {(info:{txHash:string})=>void} [onPaid]
 * @property {() => string} [getRef]
 * @property {boolean} [autoRefresh=true]
 *   When true, the banner re-checks `/access` whenever the connected wallet
 *   changes. Tests pass `false` and drive the state via `refresh()` directly.
 */

/**
 * Mount the pay-banner into the given container. The container is the
 * `layout.banner` element (see `layout.js`). The banner renders nothing
 * (empty → CSS collapses the strip) while we don't yet know access state,
 * for premium users, or for anonymous visitors. For not-paid users it shows
 * the "Pay" CTA + a download-portable link.
 *
 * @param {HTMLElement} container
 * @param {BannerOpts} [opts]
 */
export function mountAccessBanner(container, opts = {}) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('mountAccessBanner: container must be an HTMLElement');
  }
  const apiClient = opts.apiClient ?? defaultApi;
  const getCurrentAddress =
    typeof opts.getCurrentAddress === 'function'
      ? opts.getCurrentAddress
      : () => getAccount().address;

  let destroyed = false;
  let reqSeq = 0;
  /** @type {'unknown'|'anon'|'premium'|'free'|'error'} */
  let state = 'unknown';
  /** Last address we resolved /access for — used to detect wallet switches
   *  inside refresh() and synchronously lock the UI before the async round
   *  trip resolves (issue #2 — premium-gating bypass on wallet switch). */
  let lastResolvedAddress = null;

  function render() {
    container.replaceChildren();
    if (destroyed) return;
    if (state !== 'free') return; // empty banner → CSS collapses it

    const snap = getConfigSnap();
    const priceWei =
      snap.accessPriceWei && /^\d+$/.test(snap.accessPriceWei) ? BigInt(snap.accessPriceWei) : null;
    const priceTxt = priceWei != null ? `${formatPitch(priceWei)} PITCH` : '1 PITCH';

    const wrap = el('div', {
      className: 'pt-banner__pay',
      dataset: { testId: 'pay-banner' },
    });
    wrap.appendChild(
      el('span', {
        className: 'pt-banner__text',
        text: `Premium access — one-time payment of ${priceTxt}. `,
      }),
    );
    const payBtn = el('button', {
      className: 'pt-btn pt-btn--primary pt-btn--sm',
      dataset: { testId: 'pay-banner-btn' },
      attrs: { type: 'button' },
      text: 'Pay',
    });
    payBtn.addEventListener('click', () => {
      openPayModal({
        apiClient,
        payment: opts.payment,
        getCurrentAddress,
        getRef: opts.getRef,
        onPaid: (info) => {
          // Optimistic — flip the banner off immediately. The pay-modal
          // already called `getAccess({fresh:true})` (F0.12 step 8) so the
          // server cache is already busted; we don't re-call refresh() here
          // because the cached `/access` response may still be stale for one
          // more poll cycle, which would briefly flip the banner back to
          // 'free'. Next account-change event (or manual refresh) will
          // reconfirm via /access.
          state = 'premium';
          // Pin the resolved address so the wallet-switch guard in refresh()
          // doesn't demote this freshly-paid 'premium' back to 'unknown' on
          // the next refresh for the same wallet.
          const paidAddr = getCurrentAddress();
          lastResolvedAddress = paidAddr ? String(paidAddr).toLowerCase() : null;
          publishState();
          render();
          if (typeof opts.onPaid === 'function') {
            try {
              opts.onPaid(info);
            } catch {
              /* ignore */
            }
          }
        },
      });
    });
    wrap.appendChild(payBtn);

    const portable = el('a', {
      className: 'pt-banner__portable',
      dataset: { testId: 'pay-banner-portable' },
      attrs: { href: PORTABLE_DOWNLOAD_URL, target: '_blank', rel: 'noopener noreferrer' },
      text: 'Download portable version',
    });
    wrap.appendChild(portable);

    container.appendChild(wrap);
  }

  async function refresh() {
    const seq = ++reqSeq;
    const addr = getCurrentAddress();
    // Wallet switched (or disconnected) since the last resolved /access:
    // synchronously demote the published state to 'unknown' before the async
    // /access call resolves so soft-lock listeners hide premium UI for the
    // new wallet immediately. Without this, the stale 'premium' state from
    // wallet-A would leak through to wallet-B for the entire RTT window
    // (#2 — security/billing bypass).
    const normalized = addr ? String(addr).toLowerCase() : null;
    if (normalized !== lastResolvedAddress && state === 'premium') {
      state = 'unknown';
      publishState();
      // No render() here — 'unknown' renders the same empty banner as 'anon',
      // and we're about to render again once the async resolves.
    }
    if (!addr) {
      state = 'anon';
      lastResolvedAddress = null;
      publishState();
      render();
      return;
    }
    try {
      const resp = await apiClient.getAccess();
      if (seq !== reqSeq || destroyed) return;
      state = resp?.hasAccess ? 'premium' : 'free';
      lastResolvedAddress = normalized;
    } catch (err) {
      if (seq !== reqSeq || destroyed) return;
      const status = err && typeof err.status === 'number' ? err.status : null;
      if (status === 401) {
        // Not signed-in yet — show no banner. The SIWE flow in main.js
        // pops up the sign-in modal; once that finishes, account-change
        // listener calls refresh() again.
        state = 'anon';
        lastResolvedAddress = null;
      } else {
        state = 'error';
        // Don't update lastResolvedAddress on transient error — next refresh
        // will retry and the wallet-switch guard above will still fire.
      }
    }
    publishState();
    render();
  }

  /**
   * Mirror the banner's internal state into the shared `access-store` so
   * soft-lock overlays (F0.13) and other premium-gated UIs react without each
   * one polling `/access` independently. `'error'` is reported as `'anon'` —
   * a transient failure shouldn't accidentally unlock anything, and once the
   * next refresh succeeds the store will catch up.
   */
  function publishState() {
    if (state === 'premium' || state === 'free' || state === 'anon' || state === 'unknown') {
      setAccessState(state);
    } else if (state === 'error') {
      setAccessState('anon');
    }
    // 'unknown' IS published — needed by the wallet-switch guard in refresh()
    // to synchronously demote a previously-premium UI before the new /access
    // resolves (issue #2). The store treats 'unknown' as locked, same as 'anon'.
  }

  // Re-render when shared config (price/discount) changes.
  const unsubscribeConfig = subscribeConfig(() => {
    if (state === 'free') render();
  });

  refresh().catch(() => {
    /* surfaced via state */
  });

  function destroy() {
    destroyed = true;
    try {
      unsubscribeConfig();
    } catch {
      /* ignore */
    }
    container.replaceChildren();
  }

  return {
    refresh,
    destroy,
    _getState() {
      return state;
    },
  };
}

/** Test-only: close any active modal + reset module-level state. */
export function _resetForTests() {
  if (_activeModal) {
    try {
      _activeModal.remove();
    } catch {
      /* ignore */
    }
    _activeModal = null;
  }
  _defaultPaymentClient = null;
}
