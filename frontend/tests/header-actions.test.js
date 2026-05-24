// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountHeaderActions } from '../src/components/header-actions.js';

function makeButtons() {
  const profileBtn = document.createElement('button');
  profileBtn.dataset.testId = 'header-profile-btn';
  const referralBtn = document.createElement('button');
  referralBtn.dataset.testId = 'header-referral-btn';
  document.body.appendChild(profileBtn);
  document.body.appendChild(referralBtn);
  return { profileBtn, referralBtn };
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

  it('Referral click builds link with handle from /ref/me and copies it', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    const deps = makeDeps();
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
    referralBtn.click();
    // wait for async chain
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.copy).toHaveBeenCalledWith('https://pitchwc-terminal.xyz/?ref=cooluser');
    expect(deps.showToast).toHaveBeenCalledWith('Referral link copied', { kind: 'info' });
  });

  it('Referral click falls back to wallet address on /ref/me 404', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    const err = Object.assign(new Error('not found'), { status: 404 });
    const deps = makeDeps({
      api: { getRefMe: vi.fn().mockRejectedValue(err) },
    });
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
    referralBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.copy).toHaveBeenCalledWith(
      'https://pitchwc-terminal.xyz/?ref=0x000000000000000000000000000000000000dead',
    );
    expect(deps.showToast).toHaveBeenCalledWith('Referral link copied', { kind: 'info' });
  });

  it('Referral click without a connected wallet warns the user', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    const deps = makeDeps({
      getAccount: vi.fn().mockReturnValue({ isConnected: false, address: null }),
    });
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
    referralBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.copy).not.toHaveBeenCalled();
    expect(deps.showToast).toHaveBeenCalledWith(
      'Connect your wallet to share a referral link',
      { kind: 'warn' },
    );
  });

  it('shows the link in a toast when clipboard copy fails', async () => {
    const { profileBtn, referralBtn } = makeButtons();
    const deps = makeDeps({ copy: vi.fn().mockResolvedValue(false) });
    mountHeaderActions({ profileBtn, referralBtn, onProfile: () => {}, ...deps });
    referralBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const calls = deps.showToast.mock.calls;
    expect(calls[0][0]).toMatch(/Copy failed/);
    expect(calls[0][0]).toContain('https://pitchwc-terminal.xyz/?ref=cooluser');
    expect(calls[0][1]).toEqual({ kind: 'warn' });
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
});
