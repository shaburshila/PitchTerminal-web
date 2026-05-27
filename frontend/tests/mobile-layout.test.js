// @vitest-environment happy-dom

import { describe, it, expect, beforeEach } from 'vitest';
import { mountMobileLayout } from '../src/mobile-layout.js';
import {
  set as setAccessState,
  _resetForTests as resetAccessStore,
} from '../src/access-store.js';

describe('mountMobileLayout', () => {
  let root;

  beforeEach(() => {
    document.body.replaceChildren();
    document.body.className = '';
    if (typeof window !== 'undefined' && window.location) {
      window.location.hash = '';
    }
    resetAccessStore();
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  it('adds body.is-mobile and builds shell with header + banner + 4 panels + nav', () => {
    const handle = mountMobileLayout(root);
    expect(document.body.classList.contains('is-mobile')).toBe(true);
    expect(root.querySelector('[data-test-id="mobile-shell"]')).not.toBeNull();
    expect(root.querySelector('[data-test-id="mobile-header"]')).not.toBeNull();
    expect(root.querySelector('[data-test-id="mobile-banner"]')).not.toBeNull();
    expect(root.querySelector('[data-test-id="mobile-nav"]')).not.toBeNull();
    expect(root.querySelector('[data-test-id="mobile-panel-markets"]')).not.toBeNull();
    expect(root.querySelector('[data-test-id="mobile-panel-chart"]')).not.toBeNull();
    expect(root.querySelector('[data-test-id="mobile-panel-trade"]')).not.toBeNull();
    expect(root.querySelector('[data-test-id="mobile-panel-wallet"]')).not.toBeNull();
    handle.destroy();
  });

  it('handle exposes banner element with the mobile-banner zone', () => {
    const handle = mountMobileLayout(root);
    expect(handle.banner).toBeInstanceOf(HTMLElement);
    expect(handle.banner.dataset.zone).toBe('mobile-banner');
    expect(handle.banner.classList.contains('pt-mobile-banner')).toBe(true);
    // The banner sits between the header and the main panels area.
    const shell = root.querySelector('[data-test-id="mobile-shell"]');
    const children = Array.from(shell.children);
    const headerIdx = children.indexOf(handle.header);
    const bannerIdx = children.indexOf(handle.banner);
    expect(bannerIdx).toBeGreaterThan(headerIdx);
    handle.destroy();
  });

  it('destroy removes the shell AND the banner together (no orphan slot)', () => {
    const handle = mountMobileLayout(root);
    expect(root.contains(handle.banner)).toBe(true);
    handle.destroy();
    expect(root.querySelector('[data-test-id="mobile-banner"]')).toBeNull();
    expect(document.body.classList.contains('is-mobile')).toBe(false);
  });

  it('Trade + Wallet tabs render is-locked when access-state is not premium', () => {
    // Default access-store state is `'unknown'` after _resetForTests.
    const handle = mountMobileLayout(root);
    const trade = root.querySelector('[data-test-id="mobile-nav-trade"]');
    const wallet = root.querySelector('[data-test-id="mobile-nav-wallet"]');
    const markets = root.querySelector('[data-test-id="mobile-nav-markets"]');
    const chart = root.querySelector('[data-test-id="mobile-nav-chart"]');
    expect(trade.classList.contains('is-locked')).toBe(true);
    expect(wallet.classList.contains('is-locked')).toBe(true);
    // Markets + Chart never lock.
    expect(markets.classList.contains('is-locked')).toBe(false);
    expect(chart.classList.contains('is-locked')).toBe(false);
    // Lock badge present in DOM for premium-gated tabs only.
    expect(trade.querySelector('.pt-mobile-nav__tab-lock')).not.toBeNull();
    expect(wallet.querySelector('.pt-mobile-nav__tab-lock')).not.toBeNull();
    expect(markets.querySelector('.pt-mobile-nav__tab-lock')).toBeNull();
    expect(chart.querySelector('.pt-mobile-nav__tab-lock')).toBeNull();
    handle.destroy();
  });

  it('access-store → premium removes is-locked live; revert → anon restores it', () => {
    const handle = mountMobileLayout(root);
    const trade = root.querySelector('[data-test-id="mobile-nav-trade"]');
    const wallet = root.querySelector('[data-test-id="mobile-nav-wallet"]');
    expect(trade.classList.contains('is-locked')).toBe(true);
    expect(wallet.classList.contains('is-locked')).toBe(true);

    setAccessState('premium');
    expect(trade.classList.contains('is-locked')).toBe(false);
    expect(wallet.classList.contains('is-locked')).toBe(false);

    setAccessState('anon');
    expect(trade.classList.contains('is-locked')).toBe(true);
    expect(wallet.classList.contains('is-locked')).toBe(true);

    handle.destroy();
  });

  it('non-premium states (connecting / free) keep the lock', () => {
    const handle = mountMobileLayout(root);
    const trade = root.querySelector('[data-test-id="mobile-nav-trade"]');
    setAccessState('connecting');
    expect(trade.classList.contains('is-locked')).toBe(true);
    setAccessState('free');
    expect(trade.classList.contains('is-locked')).toBe(true);
    setAccessState('premium');
    expect(trade.classList.contains('is-locked')).toBe(false);
    handle.destroy();
  });

  it('destroy unsubscribes — later access-state changes do not touch DOM', () => {
    const handle = mountMobileLayout(root);
    // Snapshot is-mobile-shell while alive; after destroy buttons are detached.
    const trade = root.querySelector('[data-test-id="mobile-nav-trade"]');
    expect(trade.classList.contains('is-locked')).toBe(true);
    handle.destroy();
    // Mutate state — must not throw and the detached button class stays.
    expect(() => setAccessState('premium')).not.toThrow();
    expect(trade.classList.contains('is-locked')).toBe(true);
  });
});
