// @vitest-environment happy-dom

import { describe, it, expect, beforeEach } from 'vitest';
import { mountLayout } from '../src/layout.js';

describe('mountLayout', () => {
  let root;

  beforeEach(() => {
    document.body.replaceChildren();
    document.body.className = '';
    root = document.createElement('div');
    root.id = 'app';
    document.body.appendChild(root);
  });

  it('builds the shell with header, banner, 3 columns, and footer', () => {
    mountLayout(root);
    expect(root.querySelector('[data-test-id="shell"]')).not.toBeNull();
    expect(root.querySelector('[data-test-id="header"]')).not.toBeNull();
    expect(root.querySelector('[data-test-id="banner"]')).not.toBeNull();
    expect(root.querySelector('[data-test-id="sidebar"]')).not.toBeNull();
    expect(root.querySelector('[data-test-id="center"]')).not.toBeNull();
    expect(root.querySelector('[data-test-id="right"]')).not.toBeNull();
    expect(root.querySelector('[data-test-id="profile"]')).not.toBeNull();
    expect(root.querySelector('[data-test-id="footer"]')).not.toBeNull();
  });

  it('returns handle with named zones + helpers', () => {
    const handle = mountLayout(root);
    expect(handle.header).toBeInstanceOf(HTMLElement);
    expect(handle.banner).toBeInstanceOf(HTMLElement);
    expect(handle.sidebar).toBeInstanceOf(HTMLElement);
    expect(handle.center).toBeInstanceOf(HTMLElement);
    expect(handle.right).toBeInstanceOf(HTMLElement);
    expect(handle.profile).toBeInstanceOf(HTMLElement);
    expect(handle.footer).toBeInstanceOf(HTMLElement);
    expect(typeof handle.setMode).toBe('function');
    expect(typeof handle.destroy).toBe('function');
  });

  it('handle zones match DOM nodes by data-test-id', () => {
    const handle = mountLayout(root);
    expect(handle.sidebar).toBe(root.querySelector('[data-test-id="sidebar"]'));
    expect(handle.center).toBe(root.querySelector('[data-test-id="center"]'));
    expect(handle.right).toBe(root.querySelector('[data-test-id="right"]'));
    expect(handle.header).toBe(root.querySelector('[data-test-id="header"]'));
    expect(handle.banner).toBe(root.querySelector('[data-test-id="banner"]'));
    expect(handle.footer).toBe(root.querySelector('[data-test-id="footer"]'));
  });

  it('connect button has type="button" and no listener until F0.9', () => {
    mountLayout(root);
    const btn = root.querySelector('[data-test-id="connect-btn"]');
    expect(btn.getAttribute('type')).toBe('button');
    // The button shouldn't trigger any side effects when clicked from the
    // dead-listener-free state (F0.9 will add the wagmi handler).
    expect(() => btn.click()).not.toThrow();
  });

  it('aria-labels on zones are localized', () => {
    const handle = mountLayout(root);
    expect(handle.sidebar.getAttribute('aria-label')).toMatch(/token/i);
    expect(handle.right.getAttribute('aria-label')).toMatch(/trading/i);
    expect(handle.profile.getAttribute('aria-label')).toMatch(/profile/i);
  });

  it('renders Referral and Profile buttons to the left of wallet-area (UX-fix: Referral first)', () => {
    mountLayout(root);
    const profileBtn = root.querySelector('[data-test-id="header-profile-btn"]');
    const referralBtn = root.querySelector('[data-test-id="header-referral-btn"]');
    const walletArea = root.querySelector('[data-test-id="wallet-area"]');
    expect(profileBtn).not.toBeNull();
    expect(referralBtn).not.toBeNull();
    expect(walletArea).not.toBeNull();
    // Sibling order — all three live inside .pt-header__right.
    const right = walletArea.parentElement;
    expect(right.classList.contains('pt-header__right')).toBe(true);
    const order = Array.from(right.children).map((c) => c.dataset.testId);
    expect(order).toEqual([
      'header-referral-btn',
      'header-help-btn',
      'header-profile-btn',
      'wallet-area',
    ]);
  });

  it('renders the PitchTerminal logo as a clickable button', () => {
    mountLayout(root);
    const logo = root.querySelector('[data-test-id="header-logo"]');
    expect(logo).not.toBeNull();
    expect(logo.tagName).toBe('BUTTON');
    expect(logo.getAttribute('type')).toBe('button');
    expect(logo.textContent).toContain('PitchTerminal');
    expect(logo.textContent).toContain('beta');
    expect(logo.getAttribute('aria-label')).toMatch(/dashboard/i);
  });

  it('renders the anonymous-state connect button by default', () => {
    mountLayout(root);
    const btn = root.querySelector('[data-test-id="connect-btn"]');
    expect(btn).not.toBeNull();
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.textContent).toMatch(/Connect/);
  });

  it('does not render the network badge', () => {
    mountLayout(root);
    const badge = root.querySelector('[data-test-id="network-badge"]');
    expect(badge).toBeNull();
  });

  it('sets mode-dashboard on body by default', () => {
    mountLayout(root);
    expect(document.body.classList.contains('mode-dashboard')).toBe(true);
    expect(document.body.classList.contains('mode-profile')).toBe(false);
  });

  it('setMode("profile") swaps body class', () => {
    const handle = mountLayout(root);
    handle.setMode('profile');
    expect(document.body.classList.contains('mode-profile')).toBe(true);
    expect(document.body.classList.contains('mode-dashboard')).toBe(false);
  });

  it('setMode("dashboard") reverts body class', () => {
    const handle = mountLayout(root);
    handle.setMode('profile');
    handle.setMode('dashboard');
    expect(document.body.classList.contains('mode-dashboard')).toBe(true);
    expect(document.body.classList.contains('mode-profile')).toBe(false);
  });

  it('setMode throws on unknown mode', () => {
    const handle = mountLayout(root);
    expect(() => handle.setMode('bogus')).toThrow(RangeError);
  });

  it('is idempotent — second call clears previous content', () => {
    const first = mountLayout(root);
    // mark the first sidebar so we can verify it's replaced
    first.sidebar.dataset.marker = 'first';
    const second = mountLayout(root);
    expect(root.querySelectorAll('[data-test-id="sidebar"]').length).toBe(1);
    expect(root.querySelectorAll('[data-test-id="header"]').length).toBe(1);
    expect(second.sidebar.dataset.marker).toBeUndefined();
  });

  it('throws when root is not an HTMLElement', () => {
    expect(() => mountLayout(null)).toThrow(TypeError);
    expect(() => mountLayout(undefined)).toThrow(TypeError);
    expect(() => mountLayout({})).toThrow(TypeError);
  });

  it('destroy clears DOM and body mode class', () => {
    const handle = mountLayout(root);
    handle.destroy();
    expect(root.children.length).toBe(0);
    expect(document.body.classList.contains('mode-dashboard')).toBe(false);
    expect(document.body.classList.contains('mode-profile')).toBe(false);
  });
});
