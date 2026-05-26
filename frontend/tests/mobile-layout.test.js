// @vitest-environment happy-dom

import { describe, it, expect, beforeEach } from 'vitest';
import { mountMobileLayout } from '../src/mobile-layout.js';

describe('mountMobileLayout', () => {
  let root;

  beforeEach(() => {
    document.body.replaceChildren();
    document.body.className = '';
    if (typeof window !== 'undefined' && window.location) {
      window.location.hash = '';
    }
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
});
