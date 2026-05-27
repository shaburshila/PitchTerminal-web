// @vitest-environment happy-dom

import { describe, it, expect } from 'vitest';
import {
  MOBILE_WALLETS,
  isMobileBrowser,
  hasInjectedProvider,
} from '../src/wallet-deep-links.js';

const SAMPLE_URI = 'wc:abc123@2?relay-protocol=irn&symKey=def456';

describe('MOBILE_WALLETS', () => {
  it('is a non-empty frozen array', () => {
    expect(Array.isArray(MOBILE_WALLETS)).toBe(true);
    expect(MOBILE_WALLETS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(MOBILE_WALLETS)).toBe(true);
  });

  it('each entry has id, name, and deepLink fn that yields a string', () => {
    for (const wallet of MOBILE_WALLETS) {
      expect(typeof wallet.id).toBe('string');
      expect(wallet.id.length).toBeGreaterThan(0);
      expect(typeof wallet.name).toBe('string');
      expect(wallet.name.length).toBeGreaterThan(0);
      expect(typeof wallet.deepLink).toBe('function');
      const link = wallet.deepLink(SAMPLE_URI);
      expect(typeof link).toBe('string');
      expect(link.length).toBeGreaterThan(0);
    }
  });

  it('each deep-link contains the percent-encoded URI', () => {
    const encoded = encodeURIComponent(SAMPLE_URI);
    for (const wallet of MOBILE_WALLETS) {
      const link = wallet.deepLink(SAMPLE_URI);
      // OKX double-encodes; we still expect the original encoded payload to
      // appear once (as substring of the doubly-encoded inner) — the
      // `encodeURIComponent(encodeURIComponent(uri))` would be visible.
      // Simpler check: link must reference the wallet name's deep-link prefix.
      if (wallet.id === 'okx') {
        // Inner deep-link is double-encoded; just check it contains the
        // wallet-protocol marker.
        expect(link).toMatch(/okx%3A%2F%2Fwallet%2Fwc/);
      } else {
        expect(link).toContain(encoded);
      }
    }
  });

  it('builds known prefixes for each wallet', () => {
    const byId = Object.fromEntries(MOBILE_WALLETS.map((w) => [w.id, w]));
    expect(byId.metamask.deepLink(SAMPLE_URI)).toMatch(/^https:\/\/metamask\.app\.link\/wc\?uri=/);
    expect(byId.rainbow.deepLink(SAMPLE_URI)).toMatch(/^https:\/\/rnbwapp\.com\/wc\?uri=/);
    expect(byId.coinbase.deepLink(SAMPLE_URI)).toMatch(/^https:\/\/go\.cb-wallet\.com\/wc\?uri=/);
    expect(byId.trust.deepLink(SAMPLE_URI)).toMatch(/^https:\/\/link\.trustwallet\.com\/wc\?uri=/);
    expect(byId.okx.deepLink(SAMPLE_URI)).toMatch(/^https:\/\/www\.okx\.com\/download\?deeplink=/);
    expect(byId.imtoken.deepLink(SAMPLE_URI)).toMatch(/^imtokenv2:\/\/wc\?uri=/);
  });
});

describe('isMobileBrowser', () => {
  const IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const IPAD =
    'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const ANDROID =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/120.0.0.0 Mobile Safari/537.36';
  const CHROME_DESKTOP =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/120.0.0.0 Safari/537.36';
  const FIREFOX_DESKTOP =
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0';
  const MAC_SAFARI =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';

  it('returns true for iPhone / iPad / iPod UAs', () => {
    expect(isMobileBrowser(IPHONE)).toBe(true);
    expect(isMobileBrowser(IPAD)).toBe(true);
    expect(isMobileBrowser('Mozilla/5.0 (iPod; ...)')).toBe(true);
  });

  it('returns true for Android UAs', () => {
    expect(isMobileBrowser(ANDROID)).toBe(true);
  });

  it('returns false for desktop Chrome / Firefox / macOS Safari', () => {
    expect(isMobileBrowser(CHROME_DESKTOP)).toBe(false);
    expect(isMobileBrowser(FIREFOX_DESKTOP)).toBe(false);
    expect(isMobileBrowser(MAC_SAFARI)).toBe(false);
  });

  it('returns false on empty / missing UA', () => {
    expect(isMobileBrowser('')).toBe(false);
    expect(isMobileBrowser(null)).toBe(false);
    expect(isMobileBrowser(undefined)).toBe(false);
  });
});

describe('hasInjectedProvider', () => {
  it('returns true when ethereum is set on the window stub', () => {
    expect(hasInjectedProvider({ ethereum: {} })).toBe(true);
    expect(hasInjectedProvider({ ethereum: { isMetaMask: true } })).toBe(true);
  });

  it('returns false when ethereum is missing', () => {
    expect(hasInjectedProvider({})).toBe(false);
  });

  it('returns false for null/undefined window', () => {
    expect(hasInjectedProvider(null)).toBe(false);
  });

  it('reads from the real window if no override is supplied', () => {
    // happy-dom: no ethereum by default.
    expect(hasInjectedProvider()).toBe(false);
    window.ethereum = {};
    try {
      expect(hasInjectedProvider()).toBe(true);
    } finally {
      delete window.ethereum;
    }
  });
});
