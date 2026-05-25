// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountHeaderActions } from '../src/components/header-actions.js';

function makeButtons() {
  // Mirror the production header cluster: both buttons live inside
  // `.pt-header__right`. The modal mounts on document.body so the
  // parent shape doesn't matter for it, but we keep this realistic.
  const wrap = document.createElement('div');
  wrap.className = 'pt-header__right';
  const profileBtn = document.createElement('button');
  profileBtn.dataset.testId = 'header-profile-btn';
  const referralBtn = document.createElement('button');
  referralBtn.dataset.testId = 'header-referral-btn';
  wrap.appendChild(referralBtn);
  wrap.appendChild(profileBtn);
  document.body.appendChild(wrap);
  return { profileBtn, referralBtn, wrap };
}

function makeDeps(overrides = {}) {
  return {
    api: {
      getRefMe: vi.fn().mockResolvedValue({ code: 'cooluser', wallet: '0xabc' }),
      // Default putRefMe is never called when getRefMe returns 200; supplied
      // so individual tests can override one without spelling out both.
      putRefMe: vi.fn().mockResolvedValue({ code: 'auto1234' }),
    },
    // Tests that need a deterministic auto-generated code pass their own
    // generateCode; default produces a recognizable stand-in.
    generateCode: vi.fn(() => 'gen0test'),
    getAccount: vi.fn().mockReturnValue({
      isConnected: true,
      address: '0x000000000000000000000000000000000000dead',
    }),
    showToast: vi.fn(),
    copy: vi.fn().mockResolvedValue(true),
    prodHost: 'https://pitchwc-terminal.xyz',
    // Default to premium so the happy-path tests don't trip the lock gate.
    getAccessState: () => 'premium',
    subscribeAccess: () => () => {},
    openPayModal: vi.fn(),
    ...overrides,
  };
}

// Construct a minimal ApiError-shaped object (the production `ApiError`
// just sets `.status` on the Error instance — tests don't import the class
// so they can match this shape without coupling to it).
function apiError(status, code) {
  const err = new Error(`HTTP ${status}`);
  err.status = status;
  if (code) err.code = code;
  return err;
}

// Flush the async /ref/me + putRefMe + microtask chain inside
// openReferralModal. ensureReferralHandle can chain up to
// 1 + MAX_CLAIM_ATTEMPTS (=6) awaits on the collision-retry path, so we
// pump generously to be deterministic regardless of test scenario.
async function flushMicrotasks() {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('mountHeaderActions', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('throws when required opts are missing', () => {
    expect(() => mountHeaderActions(null)).toThrow(TypeError);
    expect(() =>
      mountHeaderActions({ profileBtn: null, referralBtn: null, onProfile: () => {} }),
    ).toThrow(TypeError);
    const { profileBtn, referralBtn } = makeButtons();
    expect(() => mountHeaderActions({ profileBtn, referralBtn })).toThrow(TypeError);
  });

  it('Profile click invokes onProfile callback', () => {
    const { profileBtn, referralBtn } = makeButtons();
    const onProfile = vi.fn();
    mountHeaderActions({ profileBtn, referralBtn, onProfile, ...makeDeps() });
    profileBtn.click();
    expect(onProfile).toHaveBeenCalledTimes(1);
  });

  it('Profile click survives a throwing onProfile and surfaces a toast', () => {
    const { profileBtn, referralBtn } = makeButtons();
    const showToast = vi.fn();
    const onProfile = vi.fn(() => {
      throw new Error('boom');
    });
    mountHeaderActions({
      profileBtn,
      referralBtn,
      onProfile,
      ...makeDeps({ showToast }),
    });
    profileBtn.click();
    expect(showToast).toHaveBeenCalledWith('boom', { kind: 'error' });
  });

  it('Referral button gets the gold-accent class on mount', () => {
    const { profileBtn, referralBtn } = makeButtons();
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...makeDeps() });
    // Cosmetic-only modifier — makes Referral stand out in the header
    // cluster. Tested as a contract so a future refactor doesn't silently
    // drop the premium-accent treatment.
    expect(referralBtn.classList.contains('pt-header__action--gold')).toBe(true);
  });

  // ── Modal open / close ─────────────────────────────────────────────────

  it('Referral click opens a centered modal (not an inline dropdown)', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    const deps = makeDeps();
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
    referralBtn.click();
    await flushMicrotasks();
    const modal = document.querySelector('[data-test-id="referral-modal"]');
    expect(modal).not.toBeNull();
    const overlay = document.querySelector('[data-test-id="referral-modal-overlay"]');
    expect(overlay).not.toBeNull();
    // No legacy dropdown is left around.
    expect(document.querySelector('[data-test-id="header-referral-dropdown"]')).toBeNull();
    // No direct copy on open — copy is a separate user gesture.
    expect(deps.copy).not.toHaveBeenCalled();
  });

  it('modal renders the two-column benefits block (you get / they get)', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...makeDeps() });
    referralBtn.click();
    await flushMicrotasks();
    const you = document.querySelector('[data-test-id="referral-modal-you"]');
    const them = document.querySelector('[data-test-id="referral-modal-them"]');
    expect(you).not.toBeNull();
    expect(them).not.toBeNull();
    expect(you.textContent).toMatch(/25%/);
    expect(them.textContent).toMatch(/25%/);
  });

  it('modal shows the handle-based link from /ref/me', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    const deps = makeDeps();
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
    referralBtn.click();
    await flushMicrotasks();
    const urlEl = document.querySelector('[data-test-id="referral-modal-url"]');
    expect(urlEl).not.toBeNull();
    expect(urlEl.textContent).toBe('https://pitchwc-terminal.xyz/?ref=cooluser');
  });

  it('Copy button inside modal copies the link and shows toast', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    const deps = makeDeps();
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
    referralBtn.click();
    await flushMicrotasks();
    const copyBtn = document.querySelector('[data-test-id="referral-modal-copy"]');
    copyBtn.click();
    await flushMicrotasks();
    expect(deps.copy).toHaveBeenCalledWith('https://pitchwc-terminal.xyz/?ref=cooluser');
    expect(deps.showToast).toHaveBeenCalledWith('Referral link copied', { kind: 'info' });
  });

  it('share buttons (X / Telegram) are pre-filled with the referral URL', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...makeDeps() });
    referralBtn.click();
    await flushMicrotasks();
    const shareX = document.querySelector('[data-test-id="referral-modal-share-x"]');
    const shareTg = document.querySelector('[data-test-id="referral-modal-share-tg"]');
    expect(shareX).not.toBeNull();
    expect(shareTg).not.toBeNull();
    // URL-encoded handle link appears in both share targets.
    const encoded = encodeURIComponent('https://pitchwc-terminal.xyz/?ref=cooluser');
    expect(shareX.getAttribute('href')).toContain(encoded);
    expect(shareTg.getAttribute('href')).toContain(encoded);
    expect(shareX.getAttribute('href')).toMatch(/twitter\.com\/intent\/tweet/);
    expect(shareTg.getAttribute('href')).toMatch(/t\.me\/share\/url/);
    // Anchors open in new tabs and don't leak referrer/window-opener.
    expect(shareX.getAttribute('target')).toBe('_blank');
    expect(shareX.getAttribute('rel')).toBe('noopener noreferrer');
  });

  // Auto-claim flow (replaces the old "fallback to wallet" behavior — the
  // referral link must NEVER expose the wallet address).
  it('first open: GET /ref/me 404 → PUT /ref/me claims an auto-generated code', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    const getRefMe = vi.fn().mockRejectedValue(apiError(404, 'referral.not_found'));
    const putRefMe = vi.fn().mockResolvedValue({ code: 'k3h7m9q2' });
    const generateCode = vi.fn(() => 'k3h7m9q2');
    const deps = makeDeps({ api: { getRefMe, putRefMe }, generateCode });
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
    referralBtn.click();
    await flushMicrotasks();
    expect(getRefMe).toHaveBeenCalledTimes(1);
    expect(putRefMe).toHaveBeenCalledTimes(1);
    // Server-side regex `^[a-z0-9_-]{4,32}$` — our generator stays in
    // [a-z0-9]{8} which is a strict subset.
    const sentCode = putRefMe.mock.calls[0][0];
    expect(sentCode).toMatch(/^[a-z0-9]{8}$/);
    const urlEl = document.querySelector('[data-test-id="referral-modal-url"]');
    expect(urlEl.textContent).toBe('https://pitchwc-terminal.xyz/?ref=k3h7m9q2');
  });

  it('already-claimed: GET /ref/me 200 → never calls PUT', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    const getRefMe = vi.fn().mockResolvedValue({ code: 'alex42', wallet: '0xabc' });
    const putRefMe = vi.fn();
    const deps = makeDeps({ api: { getRefMe, putRefMe } });
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
    referralBtn.click();
    await flushMicrotasks();
    expect(putRefMe).not.toHaveBeenCalled();
    const urlEl = document.querySelector('[data-test-id="referral-modal-url"]');
    expect(urlEl.textContent).toBe('https://pitchwc-terminal.xyz/?ref=alex42');
  });

  it('PUT 409 collision retries with a new code, succeeds on second try', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    const getRefMe = vi.fn().mockRejectedValue(apiError(404));
    const putRefMe = vi
      .fn()
      .mockRejectedValueOnce(apiError(409, 'referral.conflict'))
      .mockResolvedValueOnce({ code: 'second77' });
    let callCount = 0;
    const generateCode = vi.fn(() => {
      callCount += 1;
      return callCount === 1 ? 'first123' : 'second77';
    });
    const deps = makeDeps({ api: { getRefMe, putRefMe }, generateCode });
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
    referralBtn.click();
    await flushMicrotasks();
    expect(putRefMe).toHaveBeenCalledTimes(2);
    expect(putRefMe.mock.calls[0][0]).toBe('first123');
    expect(putRefMe.mock.calls[1][0]).toBe('second77');
    const urlEl = document.querySelector('[data-test-id="referral-modal-url"]');
    expect(urlEl.textContent).toBe('https://pitchwc-terminal.xyz/?ref=second77');
  });

  it('5 consecutive 409 conflicts → status error, no link is set', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    const getRefMe = vi.fn().mockRejectedValue(apiError(404));
    const putRefMe = vi.fn().mockRejectedValue(apiError(409, 'referral.conflict'));
    const deps = makeDeps({ api: { getRefMe, putRefMe } });
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
    referralBtn.click();
    await flushMicrotasks();
    // 5 attempts then give up.
    expect(putRefMe).toHaveBeenCalledTimes(5);
    const urlEl = document.querySelector('[data-test-id="referral-modal-url"]');
    expect(urlEl.textContent).toBe('');
    const status = document.querySelector('[data-test-id="referral-modal-status"]');
    expect(status.hidden).toBe(false);
    expect(status.textContent.toLowerCase()).toMatch(/could not|try again/);
    // Copy and share are disabled in the error state.
    const copyBtn = document.querySelector('[data-test-id="referral-modal-copy"]');
    expect(copyBtn.disabled).toBe(true);
    const shareX = document.querySelector('[data-test-id="referral-modal-share-x"]');
    expect(shareX.hasAttribute('href')).toBe(false);
  });

  it('no wallet leak: every URL produced by the modal contains only the code', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    const getRefMe = vi.fn().mockRejectedValue(apiError(404));
    const putRefMe = vi.fn().mockResolvedValue({ code: 'safecode' });
    const deps = makeDeps({
      api: { getRefMe, putRefMe },
      generateCode: () => 'safecode',
      // Use a real-looking wallet so a regex sweep would catch a leak.
      getAccount: () => ({ isConnected: true, address: '0xDEADBEEFcafebabe1234567890abcdef12345678' }),
    });
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
    referralBtn.click();
    await flushMicrotasks();
    const urlEl = document.querySelector('[data-test-id="referral-modal-url"]');
    const copyBtn = document.querySelector('[data-test-id="referral-modal-copy"]');
    copyBtn.click();
    await flushMicrotasks();
    const shareX = document.querySelector('[data-test-id="referral-modal-share-x"]');
    const shareTg = document.querySelector('[data-test-id="referral-modal-share-tg"]');
    const copiedArg = deps.copy.mock.calls.at(-1)?.[0] ?? '';
    const surfaces = [
      urlEl.textContent,
      shareX.getAttribute('href') || '',
      shareTg.getAttribute('href') || '',
      copiedArg,
    ];
    // Pre-flight: every surface contains the expected code so we know we
    // tested the right URLs (not an empty placeholder).
    for (const s of surfaces) {
      expect(s).toContain('safecode');
    }
    // No hex-address substring (lowercase or mixed case) anywhere.
    const hexAddr = /0x[0-9a-fA-F]{6,}/;
    for (const s of surfaces) {
      expect(s).not.toMatch(hexAddr);
    }
  });

  it('share buttons stay disabled while the code is loading', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    // Resolve PUT only when we say so — lets us observe the loading state.
    let resolvePut;
    const putRefMe = vi.fn(
      () =>
        new Promise((res) => {
          resolvePut = res;
        }),
    );
    const getRefMe = vi.fn().mockRejectedValue(apiError(404));
    const deps = makeDeps({
      api: { getRefMe, putRefMe },
      generateCode: () => 'pending1',
    });
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
    referralBtn.click();
    await flushMicrotasks();
    // Still loading — copy/share disabled, status visible.
    const copyBtn = document.querySelector('[data-test-id="referral-modal-copy"]');
    expect(copyBtn.disabled).toBe(true);
    const shareX = document.querySelector('[data-test-id="referral-modal-share-x"]');
    expect(shareX.hasAttribute('href')).toBe(false);
    const status = document.querySelector('[data-test-id="referral-modal-status"]');
    expect(status.hidden).toBe(false);
    // Finish the PUT — link materializes.
    resolvePut({ code: 'pending1' });
    await flushMicrotasks();
    expect(copyBtn.disabled).toBe(false);
    expect(shareX.getAttribute('href')).toContain(encodeURIComponent('?ref=pending1'));
  });

  it('GET /ref/me 401 → status hints sign-in, no PUT is sent', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    const getRefMe = vi.fn().mockRejectedValue(apiError(401, 'auth.unauthenticated'));
    const putRefMe = vi.fn();
    const deps = makeDeps({ api: { getRefMe, putRefMe } });
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
    referralBtn.click();
    await flushMicrotasks();
    expect(putRefMe).not.toHaveBeenCalled();
    const status = document.querySelector('[data-test-id="referral-modal-status"]');
    expect(status.hidden).toBe(false);
    expect(status.textContent.toLowerCase()).toMatch(/sign in|connect/);
    const copyBtn = document.querySelector('[data-test-id="referral-modal-copy"]');
    expect(copyBtn.disabled).toBe(true);
  });

  it('Referral click without a connected wallet opens modal with a hint', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    const deps = makeDeps({
      getAccount: vi.fn().mockReturnValue({ isConnected: false, address: null }),
    });
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
    referralBtn.click();
    await flushMicrotasks();
    const modal = document.querySelector('[data-test-id="referral-modal"]');
    expect(modal).not.toBeNull();
    const status = document.querySelector('[data-test-id="referral-modal-status"]');
    expect(status.hidden).toBe(false);
    expect(status.textContent).toMatch(/Connect your wallet/i);
    const copyBtn = document.querySelector('[data-test-id="referral-modal-copy"]');
    expect(copyBtn.disabled).toBe(true);
    // No /ref/me fetch, no copy on open.
    expect(deps.api.getRefMe).not.toHaveBeenCalled();
    expect(deps.copy).not.toHaveBeenCalled();
  });

  it('Copy failure surfaces the link in a warn toast', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    const deps = makeDeps({ copy: vi.fn().mockResolvedValue(false) });
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
    referralBtn.click();
    await flushMicrotasks();
    const copyBtn = document.querySelector('[data-test-id="referral-modal-copy"]');
    copyBtn.click();
    await flushMicrotasks();
    const calls = deps.showToast.mock.calls;
    expect(calls[0][0]).toMatch(/Copy failed/);
    expect(calls[0][0]).toContain('https://pitchwc-terminal.xyz/?ref=cooluser');
    expect(calls[0][1]).toEqual({ kind: 'warn' });
  });

  // ── New tests for the modal contract (≥3 requested) ────────────────────

  it('clicking the modal close (✕) button closes the modal', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...makeDeps() });
    referralBtn.click();
    await flushMicrotasks();
    expect(document.querySelector('[data-test-id="referral-modal"]')).not.toBeNull();
    const closeBtn = document.querySelector('[data-test-id="referral-modal-close"]');
    closeBtn.click();
    expect(document.querySelector('[data-test-id="referral-modal"]')).toBeNull();
    expect(referralBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('Escape key closes the modal', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...makeDeps() });
    referralBtn.click();
    await flushMicrotasks();
    expect(document.querySelector('[data-test-id="referral-modal"]')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('[data-test-id="referral-modal"]')).toBeNull();
  });

  it('clicking the backdrop closes the modal', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...makeDeps() });
    referralBtn.click();
    await flushMicrotasks();
    const overlay = document.querySelector('[data-test-id="referral-modal-overlay"]');
    // Simulate a mousedown directly on the overlay (outside the card).
    overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.querySelector('[data-test-id="referral-modal"]')).toBeNull();
  });

  it('Copy uses the clipboard mock (verified through a fresh open)', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    const clipboardMock = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({ copy: clipboardMock });
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
    referralBtn.click();
    await flushMicrotasks();
    document.querySelector('[data-test-id="referral-modal-copy"]').click();
    await flushMicrotasks();
    expect(clipboardMock).toHaveBeenCalledTimes(1);
    expect(clipboardMock).toHaveBeenCalledWith('https://pitchwc-terminal.xyz/?ref=cooluser');
  });

  it('second Referral click closes the open modal (toggle behavior)', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...makeDeps() });
    referralBtn.click();
    await flushMicrotasks();
    expect(document.querySelector('[data-test-id="referral-modal"]')).not.toBeNull();
    referralBtn.click();
    expect(document.querySelector('[data-test-id="referral-modal"]')).toBeNull();
  });

  it('destroy detaches click handlers and tears down any open modal', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    const onProfile = vi.fn();
    const handle = mountHeaderActions({
      profileBtn,
      referralBtn,
      onProfile,
      ...makeDeps(),
    });
    referralBtn.click();
    await flushMicrotasks();
    expect(document.querySelector('[data-test-id="referral-modal"]')).not.toBeNull();
    handle.destroy();
    expect(document.querySelector('[data-test-id="referral-modal"]')).toBeNull();
    profileBtn.click();
    expect(onProfile).not.toHaveBeenCalled();
  });

  // ── Premium-gating (Batch 10, preserved) ────────────────────────────────

  describe('locked state (batch 10)', () => {
    it.each(['unknown', 'anon', 'free'])(
      'marks both buttons is-locked when access state is %s',
      (state) => {
        const { profileBtn, referralBtn } = makeButtons();
        mountHeaderActions({
          profileBtn,
          referralBtn,
          onProfile: () => {},
          ...makeDeps({ getAccessState: () => state }),
        });
        expect(profileBtn.classList.contains('is-locked')).toBe(true);
        expect(referralBtn.classList.contains('is-locked')).toBe(true);
        expect(profileBtn.getAttribute('aria-disabled')).toBe('true');
        expect(referralBtn.getAttribute('aria-disabled')).toBe('true');
      },
    );

    it('does not mark is-locked when access state is premium', () => {
      const { profileBtn, referralBtn } = makeButtons();
      mountHeaderActions({
        profileBtn,
        referralBtn,
        onProfile: () => {},
        ...makeDeps({ getAccessState: () => 'premium' }),
      });
      expect(profileBtn.classList.contains('is-locked')).toBe(false);
      expect(referralBtn.classList.contains('is-locked')).toBe(false);
      expect(profileBtn.getAttribute('aria-disabled')).toBe('false');
    });

    it('Profile click on locked state opens pay modal, not onProfile', () => {
      const { profileBtn, referralBtn } = makeButtons();
      const onProfile = vi.fn();
      const openPayModal = vi.fn();
      mountHeaderActions({
        profileBtn,
        referralBtn,
        onProfile,
        ...makeDeps({ getAccessState: () => 'free', openPayModal }),
      });
      profileBtn.click();
      expect(onProfile).not.toHaveBeenCalled();
      expect(openPayModal).toHaveBeenCalledTimes(1);
    });

    it('Referral click on locked state opens pay modal, not the referral modal', async () => {
      const { profileBtn, referralBtn } = makeButtons();
      const openPayModal = vi.fn();
      const deps = makeDeps({ getAccessState: () => 'free', openPayModal });
      mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
      referralBtn.click();
      await flushMicrotasks();
      expect(deps.copy).not.toHaveBeenCalled();
      expect(openPayModal).toHaveBeenCalledTimes(1);
      // No referral modal was created.
      expect(document.querySelector('[data-test-id="referral-modal"]')).toBeNull();
    });

    it('subscription flips is-locked when access state changes', () => {
      const { profileBtn, referralBtn } = makeButtons();
      let listener = () => {};
      const subscribeAccess = (fn) => {
        listener = fn;
        return () => {};
      };
      let state = 'free';
      mountHeaderActions({
        profileBtn,
        referralBtn,
        onProfile: () => {},
        ...makeDeps({ getAccessState: () => state, subscribeAccess }),
      });
      expect(profileBtn.classList.contains('is-locked')).toBe(true);
      state = 'premium';
      listener('premium');
      expect(profileBtn.classList.contains('is-locked')).toBe(false);
      expect(referralBtn.classList.contains('is-locked')).toBe(false);
    });

    it('destroy unsubscribes the access listener', () => {
      const { profileBtn, referralBtn } = makeButtons();
      const unsubscribe = vi.fn();
      const subscribeAccess = vi.fn(() => unsubscribe);
      const handle = mountHeaderActions({
        profileBtn,
        referralBtn,
        onProfile: () => {},
        ...makeDeps({ subscribeAccess }),
      });
      handle.destroy();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
  });
});
