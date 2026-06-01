// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  TABS,
  parseHash,
  parsePortfolioPath,
  portfolioPath,
  navigateTo,
  onTabChange,
  getActiveTab,
  initFromHash,
  __resetForTests,
} from '../src/mobile-router.js';

function setHash(h) {
  // Set hash silently — happy-dom fires `hashchange`, which our listener
  // ignores when we haven't initialised. We always call __resetForTests
  // before each test so no stale listener fires.
  window.location.hash = h;
}

describe('parseHash', () => {
  it('returns markets default on empty hash', () => {
    expect(parseHash('')).toEqual({ tab: 'markets', subroute: null });
  });

  it("returns markets default on a bare '#'", () => {
    expect(parseHash('#')).toEqual({ tab: 'markets', subroute: null });
  });

  it("parses '#/chart' as chart tab without subroute", () => {
    expect(parseHash('#/chart')).toEqual({ tab: 'chart', subroute: null });
  });

  it("parses '#/wallet/orders' as wallet tab with 'orders' subroute", () => {
    expect(parseHash('#/wallet/orders')).toEqual({ tab: 'wallet', subroute: 'orders' });
  });

  it('falls back to markets on unknown tab', () => {
    expect(parseHash('#/foo')).toEqual({ tab: 'markets', subroute: null });
  });

  it('falls back to markets when input is non-string', () => {
    expect(parseHash(undefined)).toEqual({ tab: 'markets', subroute: null });
    expect(parseHash(null)).toEqual({ tab: 'markets', subroute: null });
  });

  it('accepts each known tab', () => {
    expect(parseHash('#/markets').tab).toBe('markets');
    expect(parseHash('#/chart').tab).toBe('chart');
    expect(parseHash('#/trade').tab).toBe('trade');
    expect(parseHash('#/wallet').tab).toBe('wallet');
  });
});

describe('parsePortfolioPath', () => {
  const ADDR = '0x71ecd1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  it('returns not-a-portfolio for the dashboard root', () => {
    expect(parsePortfolioPath('/')).toEqual({ isPortfolio: false, address: null, valid: true });
  });

  it('returns not-a-portfolio for an unrelated path', () => {
    expect(parsePortfolioPath('/markets')).toEqual({
      isPortfolio: false,
      address: null,
      valid: true,
    });
  });

  it('parses bare /portfolio as own portfolio (no address)', () => {
    expect(parsePortfolioPath('/portfolio')).toEqual({
      isPortfolio: true,
      address: null,
      valid: true,
    });
  });

  it('parses /portfolio/ (trailing slash) as own portfolio', () => {
    expect(parsePortfolioPath('/portfolio/')).toEqual({
      isPortfolio: true,
      address: null,
      valid: true,
    });
  });

  it('parses /portfolio/0x… and lowercases the address', () => {
    expect(parsePortfolioPath(`/portfolio/${ADDR.toUpperCase().replace('0X', '0x')}`)).toEqual({
      isPortfolio: true,
      address: ADDR,
      valid: true,
    });
  });

  it('flags /portfolio/<garbage> as a portfolio path but invalid', () => {
    expect(parsePortfolioPath('/portfolio/not-an-address')).toEqual({
      isPortfolio: true,
      address: null,
      valid: false,
    });
  });

  it('rejects a too-short hex segment as invalid', () => {
    expect(parsePortfolioPath('/portfolio/0xabc')).toEqual({
      isPortfolio: true,
      address: null,
      valid: false,
    });
  });

  it('returns not-a-portfolio for non-string / empty input', () => {
    expect(parsePortfolioPath(undefined)).toEqual({
      isPortfolio: false,
      address: null,
      valid: true,
    });
    expect(parsePortfolioPath('')).toEqual({ isPortfolio: false, address: null, valid: true });
  });

  it('does not match a path that merely starts with /portfolio', () => {
    expect(parsePortfolioPath('/portfolios')).toEqual({
      isPortfolio: false,
      address: null,
      valid: true,
    });
  });
});

describe('portfolioPath', () => {
  const ADDR = '0x71ecd1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  it('returns /portfolio for null', () => {
    expect(portfolioPath(null)).toBe('/portfolio');
  });

  it('returns /portfolio for a non-address string', () => {
    expect(portfolioPath('nope')).toBe('/portfolio');
  });

  it('returns /portfolio/0x… lowercased for a valid address', () => {
    expect(portfolioPath(ADDR.toUpperCase().replace('0X', '0x'))).toBe(`/portfolio/${ADDR}`);
  });

  it('round-trips with parsePortfolioPath', () => {
    const parsed = parsePortfolioPath(portfolioPath(ADDR));
    expect(parsed).toEqual({ isPortfolio: true, address: ADDR, valid: true });
  });
});

describe('TABS constant', () => {
  it('is frozen with the four expected ids', () => {
    expect(Object.isFrozen(TABS)).toBe(true);
    expect(TABS).toEqual({
      MARKETS: 'markets',
      CHART: 'chart',
      TRADE: 'trade',
      WALLET: 'wallet',
    });
  });
});

describe('navigateTo + onTabChange', () => {
  beforeEach(() => {
    __resetForTests();
    setHash('');
  });

  it('fires subscriber with new state on navigateTo(chart)', () => {
    const fn = vi.fn();
    onTabChange(fn);
    navigateTo('chart');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ tab: 'chart', subroute: null });
    expect(getActiveTab()).toEqual({ tab: 'chart', subroute: null });
  });

  it('does not fire when navigating to the same tab twice', () => {
    const fn = vi.fn();
    onTabChange(fn);
    navigateTo('chart');
    navigateTo('chart');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fires once per distinct subroute change', () => {
    const fn = vi.fn();
    onTabChange(fn);
    navigateTo('wallet');
    navigateTo('wallet', 'orders');
    navigateTo('wallet', 'orders');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith({ tab: 'wallet', subroute: 'orders' });
  });

  it('supports multiple subscribers', () => {
    const a = vi.fn();
    const b = vi.fn();
    onTabChange(a);
    onTabChange(b);
    navigateTo('trade');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops further calls', () => {
    const fn = vi.fn();
    const off = onTabChange(fn);
    navigateTo('chart');
    off();
    navigateTo('trade');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('ignores unknown tab in navigateTo', () => {
    const fn = vi.fn();
    onTabChange(fn);
    navigateTo('nope');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('initFromHash', () => {
  beforeEach(() => {
    __resetForTests();
  });

  it('seeds state from current location.hash', () => {
    setHash('#/chart');
    initFromHash();
    expect(getActiveTab()).toEqual({ tab: 'chart', subroute: null });
  });

  it('defaults to markets when hash is empty', () => {
    setHash('');
    initFromHash();
    expect(getActiveTab()).toEqual({ tab: 'markets', subroute: null });
  });

  it('defaults to markets on unknown hash', () => {
    setHash('#/foo');
    initFromHash();
    expect(getActiveTab()).toEqual({ tab: 'markets', subroute: null });
  });

  it('fires subscribers when hash differs from default state', () => {
    setHash('#/chart');
    const fn = vi.fn();
    onTabChange(fn);
    initFromHash();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ tab: 'chart', subroute: null });
  });
});
