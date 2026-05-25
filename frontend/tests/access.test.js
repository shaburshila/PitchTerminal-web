// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependent modules BEFORE importing the SUT.

// wallet.js — provide a deterministic connected wallet by default. Tests may
// override `accountState` to simulate disconnects.
const accountState = { address: '0x1111111111111111111111111111111111111111' };
vi.mock('../src/wallet.js', () => ({
  getAccount: () => ({
    address: accountState.address,
    chainId: 8453,
    isConnected: Boolean(accountState.address),
    connectorId: 'injected',
  }),
  getWagmiConfig: () => ({}),
}));

// Toast — no-op so it never tries to mount in unit tests.
vi.mock('../src/ui/toast.js', () => ({
  showToast: vi.fn(),
}));

const { openPayModal, mountAccessBanner, computeBuyerPay, formatPitch, buildUniswapUrl, _resetForTests } =
  await import('../src/access.js');
const referral = await import('../src/referral.js');
const configStore = await import('../src/config-store.js');
const accessStore = await import('../src/access-store.js');

// ── Common fixtures ────────────────────────────────────────────────────────

const ACCESS_ADDR = '0xa4c416986a1ee95c0c6ecd66ab77dfda61803527';
const PITCH_ADDR = '0xeae13ea73bec936664a51734c8c01ec7c3b0699c';
const WALLET = '0x1111111111111111111111111111111111111111';
const REF_WALLET = '0x2222222222222222222222222222222222222222';

const ONE_PITCH = 10n ** 18n;
const SEVENTY_FIVE_PCT = (ONE_PITCH * 7500n) / 10000n;

function makeConfig({
  price = ONE_PITCH.toString(),
  buyerDiscountBps = 2500,
  referralBps = 2500,
} = {}) {
  return {
    chainId: 8453,
    contracts: {
      pitch: PITCH_ADDR,
      access: ACCESS_ADDR,
    },
    accessPriceWei: price,
    buyerDiscountBps,
    referralBps,
  };
}

function makeApiClient({ accessResp, configResp } = {}) {
  return {
    getConfig: vi.fn(async () => configResp ?? makeConfig()),
    getAccess: vi.fn(async () => accessResp ?? { hasAccess: false, source: 'none' }),
  };
}

function makePaymentClient({
  balance = ONE_PITCH * 10n,
  allowance = 0n,
  onApprove,
  onBuy,
} = {}) {
  const calls = { approve: [], buy: [], allowance: [], balance: [] };
  let allowanceState = allowance;
  return {
    calls,
    readAllowance: vi.fn(async (args) => {
      calls.allowance.push(args);
      return allowanceState;
    }),
    readBalance: vi.fn(async (args) => {
      calls.balance.push(args);
      return balance;
    }),
    approve: vi.fn(async (args) => {
      calls.approve.push(args);
      allowanceState = args.amount;
      if (typeof onApprove === 'function') return onApprove(args);
      return '0xapprovehash';
    }),
    buyAccess: vi.fn(async (args) => {
      calls.buy.push(args);
      if (typeof onBuy === 'function') return onBuy(args);
      return '0xbuyhash';
    }),
  };
}

// Drain microtasks / pending promises a few ticks. Used by tests that need
// to wait for async chains inside event handlers.
async function flush(n = 8) {
  for (let i = 0; i < n; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

beforeEach(() => {
  document.body.replaceChildren();
  accountState.address = WALLET;
  try { localStorage.clear(); } catch { /* ignore */ }
  configStore._resetForTests();
  referral._resetForTests();
  accessStore._resetForTests();
  _resetForTests();
});

afterEach(() => {
  vi.clearAllMocks();
  _resetForTests();
});

// ── Pure helpers ───────────────────────────────────────────────────────────

describe('computeBuyerPay', () => {
  it('returns full price when no referrer', () => {
    expect(computeBuyerPay(ONE_PITCH, 2500, false)).toBe(ONE_PITCH);
  });
  it('applies discount when referrer present', () => {
    expect(computeBuyerPay(ONE_PITCH, 2500, true)).toBe(SEVENTY_FIVE_PCT);
  });
  it('returns full price when buyerDiscountBps is 0', () => {
    expect(computeBuyerPay(ONE_PITCH, 0, true)).toBe(ONE_PITCH);
  });
  it('handles odd-bps math without overflow', () => {
    // 1234 bps off — 8766 / 10000 * price
    const expected = (ONE_PITCH * 8766n) / 10000n;
    expect(computeBuyerPay(ONE_PITCH, 1234, true)).toBe(expected);
  });
  it('caps at zero for absurd discounts', () => {
    expect(computeBuyerPay(ONE_PITCH, 100000, true)).toBe(0n);
  });
});

describe('formatPitch', () => {
  it('formats 1 PITCH wei → "1"', () => {
    expect(formatPitch(ONE_PITCH)).toBe('1');
  });
  it('formats 0.75 PITCH → "0.75"', () => {
    expect(formatPitch(SEVENTY_FIVE_PCT)).toBe('0.75');
  });
  it('formats numeric strings', () => {
    expect(formatPitch('250000000000000000')).toBe('0.25');
  });
});

describe('buildUniswapUrl', () => {
  it('contains chain=base + outputCurrency', () => {
    const url = buildUniswapUrl(PITCH_ADDR);
    expect(url).toContain('chain=base');
    expect(url).toContain(`outputCurrency=${encodeURIComponent(PITCH_ADDR)}`);
  });
});

// ── Pay modal flow ─────────────────────────────────────────────────────────

describe('openPayModal — no referrer', () => {
  it('approves full price then buys with 0x0 referrer', async () => {
    const api = makeApiClient();
    const payment = makePaymentClient();
    const onPaid = vi.fn();
    openPayModal({ apiClient: api, payment, onPaid });

    await flush(10);
    // Modal rendered.
    expect(document.querySelector('[data-test-id="pay-overlay"]')).not.toBeNull();
    expect(api.getConfig).toHaveBeenCalledWith({ fresh: true });
    // Breakdown: price = 1 PITCH, no discount, total = 1 PITCH.
    const priceRow = document.querySelector('[data-test-id="pay-price"]');
    expect(priceRow.textContent).toContain('1 PITCH');
    expect(document.querySelector('[data-test-id="pay-discount"]')).toBeNull();
    const totalRow = document.querySelector('[data-test-id="pay-total"]');
    expect(totalRow.textContent).toContain('1 PITCH');
    // Ref block hidden.
    expect(document.querySelector('[data-test-id="pay-ref"]').hidden).toBe(true);

    const submit = document.querySelector('[data-test-id="pay-submit"]');
    expect(submit.disabled).toBe(false);
    submit.click();
    await flush(20);

    expect(payment.calls.approve.length).toBe(1);
    expect(payment.calls.approve[0].amount).toBe(ONE_PITCH);
    expect(payment.calls.approve[0].spender).toBe(ACCESS_ADDR);
    expect(payment.calls.buy.length).toBe(1);
    expect(payment.calls.buy[0].referrer).toBe('0x0000000000000000000000000000000000000000');
    expect(api.getAccess).toHaveBeenCalledWith({ fresh: true });
    expect(onPaid).toHaveBeenCalledWith({ txHash: '0xbuyhash' });
    // Modal closes on success.
    expect(document.querySelector('[data-test-id="pay-overlay"]')).toBeNull();
  });
});

describe('openPayModal — batch-7 redesign chrome', () => {
  it('renders hero + stepper + close button', async () => {
    const api = makeApiClient();
    const payment = makePaymentClient();
    openPayModal({ apiClient: api, payment });
    await flush(10);
    expect(document.querySelector('.pt-pay__hero')).not.toBeNull();
    expect(document.querySelector('.pt-pay__hero-icon')).not.toBeNull();
    expect(document.querySelector('[data-test-id="pay-stepper"]')).not.toBeNull();
    expect(document.querySelectorAll('.pt-pay__step').length).toBe(2);
    const close = document.querySelector('[data-test-id="pay-close"]');
    expect(close).not.toBeNull();
    // Close button closes the modal (same handler as Cancel).
    close.click();
    expect(document.querySelector('[data-test-id="pay-overlay"]')).toBeNull();
  });
});

describe('openPayModal — with valid referrer', () => {
  beforeEach(() => {
    localStorage.setItem('referralWallet', REF_WALLET);
    localStorage.setItem('referralRaw', 'alex42');
  });

  it('approves discounted price and buys with the referrer address', async () => {
    const api = makeApiClient();
    const payment = makePaymentClient();
    openPayModal({ apiClient: api, payment });
    await flush(10);

    // Breakdown shows discount line.
    expect(document.querySelector('[data-test-id="pay-discount"]')).not.toBeNull();
    const totalRow = document.querySelector('[data-test-id="pay-total"]');
    expect(totalRow.textContent).toContain('0.75 PITCH');
    // Ref block shows handle from localStorage.
    const refBlock = document.querySelector('[data-test-id="pay-ref"]');
    expect(refBlock.hidden).toBe(false);
    expect(refBlock.textContent).toContain('alex42');
    expect(refBlock.textContent).toContain('0x2222');

    document.querySelector('[data-test-id="pay-submit"]').click();
    await flush(20);

    expect(payment.calls.approve[0].amount).toBe(SEVENTY_FIVE_PCT);
    expect(payment.calls.buy[0].referrer).toBe(REF_WALLET);
  });
});

describe('openPayModal — self-referrer silent skip', () => {
  it('treats own wallet as no-ref and charges full price', async () => {
    localStorage.setItem('referralWallet', WALLET);
    const api = makeApiClient();
    const payment = makePaymentClient();
    openPayModal({ apiClient: api, payment });
    await flush(10);

    expect(document.querySelector('[data-test-id="pay-discount"]')).toBeNull();
    const totalRow = document.querySelector('[data-test-id="pay-total"]');
    expect(totalRow.textContent).toContain('1 PITCH');

    document.querySelector('[data-test-id="pay-submit"]').click();
    await flush(20);

    expect(payment.calls.approve[0].amount).toBe(ONE_PITCH);
    expect(payment.calls.buy[0].referrer).toBe('0x0000000000000000000000000000000000000000');
  });
});

describe('openPayModal — late self-referral guard (wallet switched mid-modal)', () => {
  // Scenario: user opens the modal with wallet A and a valid referrer B
  // (different addresses → discount applied). Before clicking Pay, they
  // switch to wallet B in their injected provider, which would make them
  // their own referrer. The pre-tx guard MUST abort the flow rather than
  // submitting a tx that would (a) revert on-chain (contract rejects
  // self-ref) or (b) silently switch to full-price with a stale allowance.
  it('aborts when live wallet equals the cached referrer at click time', async () => {
    // Opener wallet = WALLET, referrer = REF_WALLET → discount, modal opens.
    localStorage.setItem('referralWallet', REF_WALLET);
    const api = makeApiClient();
    const payment = makePaymentClient();
    openPayModal({ apiClient: api, payment });
    await flush(10);
    // Pre-click sanity: discount line shown, total = 0.75 PITCH.
    expect(document.querySelector('[data-test-id="pay-discount"]')).not.toBeNull();

    // Simulate wallet-switch: live account flips to the referrer.
    accountState.address = REF_WALLET;

    document.querySelector('[data-test-id="pay-submit"]').click();
    await flush(20);

    // No approve, no buy — guard fires BEFORE touching allowance to avoid
    // wasted popups + a guaranteed on-chain revert.
    expect(payment.calls.approve.length).toBe(0);
    expect(payment.calls.buy.length).toBe(0);
    // Modal stays open so the user can recover (reopen or cancel).
    expect(document.querySelector('[data-test-id="pay-overlay"]')).not.toBeNull();
  });
});

describe('openPayModal — contract-as-referrer silent skip', () => {
  it('treats access contract as no-ref', async () => {
    localStorage.setItem('referralWallet', ACCESS_ADDR);
    const api = makeApiClient();
    const payment = makePaymentClient();
    openPayModal({ apiClient: api, payment });
    await flush(10);

    document.querySelector('[data-test-id="pay-submit"]').click();
    await flush(20);

    expect(payment.calls.buy[0].referrer).toBe('0x0000000000000000000000000000000000000000');
  });
});

describe('openPayModal — allowance > 0 but != needed', () => {
  it('issues two approvals: reset to 0, then set to payment', async () => {
    const api = makeApiClient();
    const payment = makePaymentClient({ allowance: ONE_PITCH / 2n });
    openPayModal({ apiClient: api, payment });
    await flush(10);

    document.querySelector('[data-test-id="pay-submit"]').click();
    await flush(30);

    expect(payment.calls.approve.length).toBe(2);
    expect(payment.calls.approve[0].amount).toBe(0n);
    expect(payment.calls.approve[1].amount).toBe(ONE_PITCH);
    expect(payment.calls.buy.length).toBe(1);
  });
});

describe('openPayModal — allowance >= needed', () => {
  it('skips approve and goes straight to buy', async () => {
    const api = makeApiClient();
    const payment = makePaymentClient({ allowance: ONE_PITCH * 5n });
    openPayModal({ apiClient: api, payment });
    await flush(10);

    document.querySelector('[data-test-id="pay-submit"]').click();
    await flush(20);

    expect(payment.calls.approve.length).toBe(0);
    expect(payment.calls.buy.length).toBe(1);
  });
});

describe('openPayModal — insufficient PITCH balance', () => {
  it('disables Pay button and renders Uniswap link', async () => {
    const api = makeApiClient();
    const payment = makePaymentClient({ balance: ONE_PITCH / 10n });
    openPayModal({ apiClient: api, payment });
    await flush(10);

    const submit = document.querySelector('[data-test-id="pay-submit"]');
    expect(submit.disabled).toBe(true);
    const uniLink = document.querySelector('[data-test-id="pay-uniswap-link"]');
    expect(uniLink).not.toBeNull();
    expect(uniLink.getAttribute('href')).toContain('outputCurrency=');
  });
});

describe('openPayModal — user rejection', () => {
  it('silently closes the modal when wallet rejects approve', async () => {
    const api = makeApiClient();
    const payment = makePaymentClient({
      onApprove: () => {
        const err = new Error('User rejected the request');
        err.code = 4001;
        throw err;
      },
    });
    const onPaid = vi.fn();
    openPayModal({ apiClient: api, payment, onPaid });
    await flush(10);

    document.querySelector('[data-test-id="pay-submit"]').click();
    await flush(20);

    expect(document.querySelector('[data-test-id="pay-overlay"]')).toBeNull();
    expect(onPaid).not.toHaveBeenCalled();
  });
});

describe('openPayModal — RPC error', () => {
  it('shows inline error and keeps the modal open for retry', async () => {
    const api = makeApiClient();
    const payment = makePaymentClient({
      onBuy: () => { throw new Error('execution reverted: AlreadyHasAccess'); },
    });
    openPayModal({ apiClient: api, payment });
    await flush(10);

    document.querySelector('[data-test-id="pay-submit"]').click();
    await flush(20);

    expect(document.querySelector('[data-test-id="pay-overlay"]')).not.toBeNull();
    const errBox = document.querySelector('[data-test-id="pay-error"]');
    expect(errBox.hidden).toBe(false);
    expect(errBox.textContent).toContain('AlreadyHasAccess');
  });
});

describe('openPayModal — config refetch error', () => {
  it('shows inline error when /config?fresh=1 fails', async () => {
    const api = {
      getConfig: vi.fn(async () => { throw new Error('boom'); }),
      getAccess: vi.fn(),
    };
    openPayModal({ apiClient: api, payment: makePaymentClient() });
    await flush(10);

    const errBox = document.querySelector('[data-test-id="pay-error"]');
    expect(errBox.hidden).toBe(false);
    expect(errBox.textContent).toContain('boom');
  });
});

// ── Banner ─────────────────────────────────────────────────────────────────

describe('mountAccessBanner', () => {
  function getHost() {
    const host = document.createElement('div');
    host.dataset.testId = 'banner-host';
    document.body.appendChild(host);
    return host;
  }

  it('renders empty for premium users', async () => {
    const api = makeApiClient({ accessResp: { hasAccess: true, source: 'paid' } });
    const host = getHost();
    const handle = mountAccessBanner(host, { apiClient: api });
    await flush(5);
    expect(host.children.length).toBe(0);
    expect(handle._getState()).toBe('premium');
  });

  it('renders the pay CTA for free users', async () => {
    configStore.merge({ accessPriceWei: ONE_PITCH.toString() });
    const api = makeApiClient({ accessResp: { hasAccess: false, source: 'none' } });
    const host = getHost();
    mountAccessBanner(host, { apiClient: api });
    await flush(5);
    const btn = host.querySelector('[data-test-id="pay-banner-btn"]');
    expect(btn).not.toBeNull();
    expect(host.textContent).toContain('1 PITCH');
    expect(host.querySelector('[data-test-id="pay-banner-portable"]')).not.toBeNull();
  });

  it('renders empty when /access returns 401 (anon)', async () => {
    const api = {
      getConfig: vi.fn(async () => makeConfig()),
      getAccess: vi.fn(async () => {
        const e = new Error('auth');
        e.status = 401;
        throw e;
      }),
    };
    const host = getHost();
    mountAccessBanner(host, { apiClient: api });
    await flush(5);
    expect(host.children.length).toBe(0);
  });

  it('opens the pay modal on click', async () => {
    const api = makeApiClient({ accessResp: { hasAccess: false } });
    const host = getHost();
    const payment = makePaymentClient();
    mountAccessBanner(host, { apiClient: api, payment });
    await flush(5);
    host.querySelector('[data-test-id="pay-banner-btn"]').click();
    await flush(5);
    expect(document.querySelector('[data-test-id="pay-overlay"]')).not.toBeNull();
  });

  it('flips to premium immediately on successful payment', async () => {
    const api = makeApiClient({ accessResp: { hasAccess: false } });
    const host = getHost();
    const payment = makePaymentClient();
    const onPaid = vi.fn();
    const handle = mountAccessBanner(host, { apiClient: api, payment, onPaid });
    await flush(5);
    host.querySelector('[data-test-id="pay-banner-btn"]').click();
    await flush(5);
    document.querySelector('[data-test-id="pay-submit"]').click();
    await flush(30);

    expect(onPaid).toHaveBeenCalled();
    // Banner now empty (premium) regardless of refresh outcome.
    expect(handle._getState()).toBe('premium');
    expect(host.children.length).toBe(0);
  });
});

// ── Wallet-switch premium-gating — issue #2 (2026-05-24) ───────────────────
//
// Regression coverage for the soft-launch finding: when the connected wallet
// changes mid-session the premium UI must lock BEFORE the new wallet's
// /access call resolves. Without these guarantees a wallet-A paid user
// switching to an unpaid wallet-B sees premium content (Trade panel +
// My Wallet + Orders) for the duration of the /access round trip.

describe('mountAccessBanner — wallet switch', () => {
  function getHost() {
    const host = document.createElement('div');
    document.body.appendChild(host);
    return host;
  }
  const WALLET_B = '0x3333333333333333333333333333333333333333';

  it('demotes access-store from premium to unknown synchronously on wallet switch refresh', async () => {
    // Wallet-A: paid.
    const api = makeApiClient({ accessResp: { hasAccess: true, source: 'paid' } });
    const host = getHost();
    const handle = mountAccessBanner(host, { apiClient: api });
    await flush(5);
    expect(handle._getState()).toBe('premium');
    expect(accessStore.get()).toBe('premium');

    // Wallet-B: unpaid (but the /access mock will return whatever we set —
    // crucially, we assert the SYNCHRONOUS pre-publish before the await
    // resolves, not the eventual state).
    accountState.address = WALLET_B;
    api.getAccess = vi.fn(async () => ({ hasAccess: false, source: 'none' }));
    const pending = handle.refresh();
    // Before any microtask: store must already be demoted away from 'premium'
    // so subscribed soft-locks re-render the lock for wallet-B.
    expect(accessStore.get()).not.toBe('premium');

    await pending;
    expect(accessStore.get()).toBe('free');
    expect(handle._getState()).toBe('free');
  });

  it('resets cached resolved address on disconnect so a re-connect re-checks /access', async () => {
    const api = makeApiClient({ accessResp: { hasAccess: true, source: 'paid' } });
    const host = getHost();
    const handle = mountAccessBanner(host, { apiClient: api });
    await flush(5);
    expect(handle._getState()).toBe('premium');

    accountState.address = null;
    await handle.refresh();
    expect(handle._getState()).toBe('anon');
    expect(accessStore.get()).toBe('anon');

    // Reconnect under wallet-B — /access now returns no access; the banner
    // must re-resolve and publish 'free' (not stale 'premium').
    accountState.address = WALLET_B;
    api.getAccess = vi.fn(async () => ({ hasAccess: false, source: 'none' }));
    await handle.refresh();
    expect(handle._getState()).toBe('free');
    expect(api.getAccess).toHaveBeenCalled();
  });

  it('does NOT demote premium for repeated refresh under the same wallet', async () => {
    // Regression guard: the wallet-switch guard must only fire when the
    // address actually changes — a periodic refresh under the same wallet
    // must not flicker premium → unknown → premium.
    const api = makeApiClient({ accessResp: { hasAccess: true, source: 'paid' } });
    const host = getHost();
    const handle = mountAccessBanner(host, { apiClient: api });
    await flush(5);
    expect(handle._getState()).toBe('premium');

    // Spy on accessStore for any spurious 'unknown' publish.
    const seen = [];
    const unsub = accessStore.subscribe((s) => seen.push(s));
    await handle.refresh();
    unsub();
    expect(seen).not.toContain('unknown');
    expect(handle._getState()).toBe('premium');
  });

  it('keeps premium after successful payment even when refresh fires for the same wallet', async () => {
    // Regression guard for the onPaid race: the pay-flow sets state='premium'
    // optimistically with lastResolvedAddress=null (no pre-payment refresh
    // succeeded). A subsequent refresh under the same wallet must NOT demote
    // premium back to 'unknown'.
    const api = makeApiClient({ accessResp: { hasAccess: false } });
    const host = getHost();
    const payment = makePaymentClient();
    const handle = mountAccessBanner(host, { apiClient: api, payment });
    await flush(5);
    host.querySelector('[data-test-id="pay-banner-btn"]').click();
    await flush(5);
    document.querySelector('[data-test-id="pay-submit"]').click();
    await flush(30);
    expect(handle._getState()).toBe('premium');

    // Now a refresh fires (e.g. SSE reconnect). /access returns hasAccess=true
    // for the same wallet — the post-refresh state must remain 'premium', and
    // there must have been no transient 'unknown' published in between.
    api.getAccess = vi.fn(async () => ({ hasAccess: true, source: 'paid' }));
    const seen = [];
    const unsub = accessStore.subscribe((s) => seen.push(s));
    await handle.refresh();
    unsub();
    expect(seen).not.toContain('unknown');
    expect(handle._getState()).toBe('premium');
  });
});
