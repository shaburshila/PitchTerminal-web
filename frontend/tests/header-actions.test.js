// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountHeaderActions } from '../src/components/header-actions.js';

function makeButtons() {
  // Real production buttons live inside `.pt-header__right`; the dropdown
  // anchors to `referralBtn.parentElement`, so we mirror that structure here.
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
    api: { getRefMe: vi.fn().mockResolvedValue({ code: 'cooluser', wallet: '0xabc' }) },
    getAccount: vi.fn().mockReturnValue({
      isConnected: true,
      address: '0x000000000000000000000000000000000000dead',
    }),
    showToast: vi.fn(),
    copy: vi.fn().mockResolvedValue(true),
    prodHost: 'https://pitchwc-terminal.xyz',
    // Batch 10: default to premium so the pre-existing tests exercise the
    // unlocked happy-path. Locked-state behavior is exercised in its own
    // describe block below.
    getAccessState: () => 'premium',
    subscribeAccess: () => () => {},
    openPayModal: vi.fn(),
    ...overrides,
  };
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

  // UX-fix: Referral click now opens a dropdown popover anchored to the
  // button rather than copying directly. The popover renders the ref-link
  // and a Copy button — the copy operation moves to that Copy button click.
  it('Referral click opens dropdown popover (does not copy directly)', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    const deps = makeDeps();
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
    referralBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const dropdown = document.querySelector('[data-test-id="header-referral-dropdown"]');
    expect(dropdown).not.toBeNull();
    expect(dropdown.hidden).toBe(false);
    // No direct copy on open — copy is a separate user gesture.
    expect(deps.copy).not.toHaveBeenCalled();
  });

  it('dropdown shows the handle-based link from /ref/me', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    const deps = makeDeps();
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
    referralBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const urlEl = document.querySelector('[data-test-id="header-referral-url"]');
    expect(urlEl).not.toBeNull();
    expect(urlEl.textContent).toBe('https://pitchwc-terminal.xyz/?ref=cooluser');
  });

  it('Copy button inside dropdown copies the link and shows toast', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    const deps = makeDeps();
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
    referralBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const copyBtn = document.querySelector('[data-test-id="header-referral-copy"]');
    copyBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.copy).toHaveBeenCalledWith('https://pitchwc-terminal.xyz/?ref=cooluser');
    expect(deps.showToast).toHaveBeenCalledWith('Referral link copied', { kind: 'info' });
  });

  it('dropdown falls back to wallet address on /ref/me 404', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    const err = Object.assign(new Error('not found'), { status: 404 });
    const deps = makeDeps({
      api: { getRefMe: vi.fn().mockRejectedValue(err) },
    });
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
    referralBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const urlEl = document.querySelector('[data-test-id="header-referral-url"]');
    expect(urlEl.textContent).toBe(
      'https://pitchwc-terminal.xyz/?ref=0x000000000000000000000000000000000000dead',
    );
    // Copy from the dropdown uses the address link.
    const copyBtn = document.querySelector('[data-test-id="header-referral-copy"]');
    copyBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.copy).toHaveBeenCalledWith(
      'https://pitchwc-terminal.xyz/?ref=0x000000000000000000000000000000000000dead',
    );
  });

  it('Referral click without a connected wallet opens dropdown with a hint', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    const deps = makeDeps({
      getAccount: vi.fn().mockReturnValue({ isConnected: false, address: null }),
    });
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
    referralBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    const dropdown = document.querySelector('[data-test-id="header-referral-dropdown"]');
    expect(dropdown.hidden).toBe(false);
    const status = document.querySelector('[data-test-id="header-referral-status"]');
    expect(status.hidden).toBe(false);
    expect(status.textContent).toMatch(/Connect your wallet/i);
    // No /ref/me fetch, no copy.
    expect(deps.api.getRefMe).not.toHaveBeenCalled();
    expect(deps.copy).not.toHaveBeenCalled();
  });

  it('Copy failure surfaces the link in a warn toast', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    const deps = makeDeps({ copy: vi.fn().mockResolvedValue(false) });
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
    referralBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const copyBtn = document.querySelector('[data-test-id="header-referral-copy"]');
    copyBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    const calls = deps.showToast.mock.calls;
    expect(calls[0][0]).toMatch(/Copy failed/);
    expect(calls[0][0]).toContain('https://pitchwc-terminal.xyz/?ref=cooluser');
    expect(calls[0][1]).toEqual({ kind: 'warn' });
  });

  it('second Referral click closes the dropdown (toggle)', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...makeDeps() });
    referralBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    const dropdown = document.querySelector('[data-test-id="header-referral-dropdown"]');
    expect(dropdown.hidden).toBe(false);
    referralBtn.click();
    expect(dropdown.hidden).toBe(true);
  });

  it('Escape key closes the dropdown', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...makeDeps() });
    referralBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    const dropdown = document.querySelector('[data-test-id="header-referral-dropdown"]');
    expect(dropdown.hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(dropdown.hidden).toBe(true);
  });

  it('destroy detaches click handlers', () => {
    const { profileBtn, referralBtn } = makeButtons();
    const onProfile = vi.fn();
    const handle = mountHeaderActions({
      profileBtn,
      referralBtn,
      onProfile,
      ...makeDeps(),
    });
    handle.destroy();
    profileBtn.click();
    expect(onProfile).not.toHaveBeenCalled();
  });

  // Premium-gating UX: Profile is premium-only and shows the `is-locked`
  // visual state when the user isn't premium; clicks open the pay modal
  // instead of routing into the gated surface. Referral is intentionally
  // available to *all* users (anon / free / premium) — only the disconnected
  // sub-state shows a "connect wallet" hint inside the dropdown.
  describe('locked state', () => {
    it.each(['unknown', 'anon', 'free'])(
      'marks ONLY profileBtn is-locked when access state is %s (referral stays unlocked)',
      (state) => {
        const { profileBtn, referralBtn } = makeButtons();
        mountHeaderActions({
          profileBtn,
          referralBtn,
          onProfile: () => {},
          ...makeDeps({ getAccessState: () => state }),
        });
        expect(profileBtn.classList.contains('is-locked')).toBe(true);
        expect(profileBtn.getAttribute('aria-disabled')).toBe('true');
        // Referral is open to all — never locked.
        expect(referralBtn.classList.contains('is-locked')).toBe(false);
        expect(referralBtn.hasAttribute('aria-disabled')).toBe(false);
      },
    );

    it('strips a stale is-locked class from referralBtn defensively', () => {
      const { profileBtn, referralBtn } = makeButtons();
      referralBtn.classList.add('is-locked');
      referralBtn.setAttribute('aria-disabled', 'true');
      mountHeaderActions({
        profileBtn,
        referralBtn,
        onProfile: () => {},
        ...makeDeps({ getAccessState: () => 'free' }),
      });
      expect(referralBtn.classList.contains('is-locked')).toBe(false);
      expect(referralBtn.hasAttribute('aria-disabled')).toBe(false);
    });

    it('does not mark profile is-locked when access state is premium', () => {
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

    it('Referral click on FREE state opens dropdown (NOT pay modal)', async () => {
      const { profileBtn, referralBtn } = makeButtons();
      const openPayModal = vi.fn();
      const deps = makeDeps({ getAccessState: () => 'free', openPayModal });
      mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
      referralBtn.click();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      const dropdown = document.querySelector('[data-test-id="header-referral-dropdown"]');
      expect(dropdown).not.toBeNull();
      expect(dropdown.hidden).toBe(false);
      // Free users with a connected wallet see the actual link.
      const urlEl = document.querySelector('[data-test-id="header-referral-url"]');
      expect(urlEl.textContent).toBe('https://pitchwc-terminal.xyz/?ref=cooluser');
      expect(openPayModal).not.toHaveBeenCalled();
    });

    it('Referral click on ANON state opens dropdown with connect-wallet hint', async () => {
      const { profileBtn, referralBtn } = makeButtons();
      const openPayModal = vi.fn();
      const deps = makeDeps({
        getAccessState: () => 'anon',
        getAccount: vi.fn().mockReturnValue({ isConnected: false, address: null }),
        openPayModal,
      });
      mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
      referralBtn.click();
      await new Promise((r) => setTimeout(r, 0));
      const dropdown = document.querySelector('[data-test-id="header-referral-dropdown"]');
      expect(dropdown.hidden).toBe(false);
      const status = document.querySelector('[data-test-id="header-referral-status"]');
      expect(status.hidden).toBe(false);
      expect(status.textContent).toMatch(/Connect your wallet/i);
      expect(openPayModal).not.toHaveBeenCalled();
    });

    it('subscription flips profile is-locked when access state changes; referral stays unlocked', () => {
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
      expect(referralBtn.classList.contains('is-locked')).toBe(false);
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
