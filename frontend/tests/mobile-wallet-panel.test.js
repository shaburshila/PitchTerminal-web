// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/profile.js', () => ({
  mountProfile: vi.fn((container) => {
    const node = document.createElement('div');
    node.dataset.testId = 'mock-profile';
    container.appendChild(node);
    return { destroy: vi.fn(), reload: vi.fn() };
  }),
}));
vi.mock('../src/orders-tab.js', () => ({
  mountOrdersTab: vi.fn((container) => {
    const node = document.createElement('div');
    node.dataset.testId = 'mock-orders';
    container.appendChild(node);
    return { destroy: vi.fn(), setToken: vi.fn(), pushOrderUpdate: vi.fn() };
  }),
}));
vi.mock('../src/profile-referral.js', () => ({
  mountProfileReferral: vi.fn((container) => {
    const node = document.createElement('div');
    node.dataset.testId = 'mock-referral';
    container.appendChild(node);
    return { destroy: vi.fn() };
  }),
}));
vi.mock('../src/my-wallet-tab.js', () => ({
  mountMyWalletTab: vi.fn((container) => {
    const node = document.createElement('div');
    node.dataset.testId = 'mock-mywallet';
    container.appendChild(node);
    return { destroy: vi.fn(), setToken: vi.fn(), refresh: vi.fn() };
  }),
}));

// Mock mobile-router so we can assert navigateTo calls + drive onTabChange.
const routerSubs = new Set();
let routerState = { tab: 'wallet', subroute: null };
const navigateToMock = vi.fn((tab, sub) => {
  routerState = { tab, subroute: sub == null || sub === '' ? null : String(sub) };
  for (const fn of routerSubs) fn({ ...routerState });
});
vi.mock('../src/mobile-router.js', () => ({
  TABS: Object.freeze({ MARKETS: 'markets', CHART: 'chart', TRADE: 'trade', WALLET: 'wallet' }),
  navigateTo: (...args) => navigateToMock(...args),
  onTabChange: (fn) => {
    routerSubs.add(fn);
    return () => routerSubs.delete(fn);
  },
  getActiveTab: () => ({ ...routerState }),
}));

const { mountProfile } = await import('../src/profile.js');
const { mountOrdersTab } = await import('../src/orders-tab.js');
const { mountProfileReferral } = await import('../src/profile-referral.js');
const { mountMyWalletTab } = await import('../src/my-wallet-tab.js');
const { mountMobileWalletPanel } = await import('../src/mobile-wallet-panel.js');

function setup() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return container;
}

// Default opts grant premium so the existing tests exercise mount paths.
// Premium-gating-specific tests override `getAccessState`.
function defaultOpts(overrides = {}) {
  return {
    getAccessState: () => 'premium',
    subscribeAccess: () => () => {},
    openPayModal: vi.fn(),
    ...overrides,
  };
}

describe('mountMobileWalletPanel', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    routerSubs.clear();
    routerState = { tab: 'wallet', subroute: null };
    navigateToMock.mockClear();
    mountProfile.mockClear();
    mountOrdersTab.mockClear();
    mountProfileReferral.mockClear();
    mountMyWalletTab.mockClear();
  });

  it('mounts Profile by default and marks the Profile chip active', () => {
    const container = setup();
    const handle = mountMobileWalletPanel(container, defaultOpts());
    expect(mountProfile).toHaveBeenCalledTimes(1);
    expect(handle.getActiveSub()).toBe('profile');
    const profileChip = container.querySelector('[data-test-id="mobile-wallet-chip-profile"]');
    expect(profileChip.classList.contains('is-active')).toBe(true);
    expect(profileChip.getAttribute('aria-selected')).toBe('true');
  });

  it('honors initial subroute from getInitialSub (e.g. #/wallet/orders)', () => {
    const container = setup();
    routerState = { tab: 'wallet', subroute: 'orders' };
    const handle = mountMobileWalletPanel(container, defaultOpts());
    expect(mountOrdersTab).toHaveBeenCalledTimes(1);
    expect(mountProfile).not.toHaveBeenCalled();
    expect(handle.getActiveSub()).toBe('orders');
  });

  it('chip click destroys previous sub-page and mounts the new one', () => {
    const container = setup();
    mountMobileWalletPanel(container, defaultOpts());
    const profileHandle = mountProfile.mock.results[0].value;

    container.querySelector('[data-test-id="mobile-wallet-chip-referral"]').click();
    expect(profileHandle.destroy).toHaveBeenCalledTimes(1);
    expect(mountProfileReferral).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-test-id="mock-referral"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="mock-profile"]')).toBeNull();
  });

  it('chip click updates URL hash via navigateTo', () => {
    const container = setup();
    mountMobileWalletPanel(container, defaultOpts());
    container.querySelector('[data-test-id="mobile-wallet-chip-mywallet"]').click();
    expect(navigateToMock).toHaveBeenCalledWith('wallet', 'mywallet');
    container.querySelector('[data-test-id="mobile-wallet-chip-profile"]').click();
    // Default sub omits the explicit subroute so the URL stays clean.
    expect(navigateToMock).toHaveBeenLastCalledWith('wallet', undefined);
  });

  it('does NOT loop when the chip-driven navigateTo triggers its own onTabChange', () => {
    const container = setup();
    mountMobileWalletPanel(container, defaultOpts());
    // Reset counts after the initial profile mount.
    mountOrdersTab.mockClear();
    container.querySelector('[data-test-id="mobile-wallet-chip-orders"]').click();
    // Exactly one orders mount, not two (would indicate a re-entrancy loop).
    expect(mountOrdersTab).toHaveBeenCalledTimes(1);
  });

  it('external hashchange (back button) re-mounts the matching sub-page', async () => {
    const container = setup();
    const handle = mountMobileWalletPanel(container, defaultOpts());
    mountProfileReferral.mockClear();
    // Simulate hashchange landing on `#/wallet/referral`.
    routerState = { tab: 'wallet', subroute: 'referral' };
    for (const fn of routerSubs) fn({ ...routerState });
    expect(mountProfileReferral).toHaveBeenCalledTimes(1);
    expect(handle.getActiveSub()).toBe('referral');
  });

  it('pushOrderUpdate reaches Orders sub-page when active', () => {
    const container = setup();
    const handle = mountMobileWalletPanel(container, defaultOpts());
    container.querySelector('[data-test-id="mobile-wallet-chip-orders"]').click();
    const ordersHandle = mountOrdersTab.mock.results[0].value;
    const payload = { order: { id: 'o1' } };
    handle.pushOrderUpdate(payload);
    expect(ordersHandle.pushOrderUpdate).toHaveBeenCalledWith(payload);
  });

  it('pushOrderUpdate is a no-op when Orders sub-page is not active', () => {
    const container = setup();
    const handle = mountMobileWalletPanel(container, defaultOpts());
    // Profile is active, not orders.
    handle.pushOrderUpdate({ order: { id: 'o1' } });
    expect(mountOrdersTab).not.toHaveBeenCalled();
  });

  it('destroy tears down the active sub-page and removes the root', () => {
    const container = setup();
    const handle = mountMobileWalletPanel(container, defaultOpts());
    const profileHandle = mountProfile.mock.results[0].value;
    handle.destroy();
    expect(profileHandle.destroy).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-test-id="mobile-wallet"]')).toBeNull();
  });
});

describe('mountMobileWalletPanel — premium gating', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    routerSubs.clear();
    routerState = { tab: 'wallet', subroute: null };
    navigateToMock.mockClear();
    mountProfile.mockClear();
    mountOrdersTab.mockClear();
    mountProfileReferral.mockClear();
    mountMyWalletTab.mockClear();
  });

  it('free user lands on Orders (not Profile) on initial mount', () => {
    const container = setup();
    const openPayModal = vi.fn();
    mountMobileWalletPanel(container, { ...defaultOpts({ getAccessState: () => 'free' }), openPayModal });
    expect(mountOrdersTab).toHaveBeenCalledTimes(1);
    expect(mountProfile).not.toHaveBeenCalled();
    expect(openPayModal).not.toHaveBeenCalled();
  });

  it('free user tapping Profile chip opens pay modal and does NOT mount Profile', () => {
    const container = setup();
    const openPayModal = vi.fn();
    mountMobileWalletPanel(container, { ...defaultOpts({ getAccessState: () => 'free' }), openPayModal });
    mountProfile.mockClear();
    container.querySelector('[data-test-id="mobile-wallet-chip-profile"]').click();
    expect(openPayModal).toHaveBeenCalledTimes(1);
    expect(mountProfile).not.toHaveBeenCalled();
  });

  it('free user tapping Referral chip opens pay modal and does NOT mount Referral', () => {
    const container = setup();
    const openPayModal = vi.fn();
    mountMobileWalletPanel(container, { ...defaultOpts({ getAccessState: () => 'free' }), openPayModal });
    container.querySelector('[data-test-id="mobile-wallet-chip-referral"]').click();
    expect(openPayModal).toHaveBeenCalledTimes(1);
    expect(mountProfileReferral).not.toHaveBeenCalled();
  });

  it('premium-required chips are visually locked when access is free', () => {
    const container = setup();
    mountMobileWalletPanel(container, defaultOpts({ getAccessState: () => 'free' }));
    const profileChip = container.querySelector('[data-test-id="mobile-wallet-chip-profile"]');
    const referralChip = container.querySelector('[data-test-id="mobile-wallet-chip-referral"]');
    const ordersChip = container.querySelector('[data-test-id="mobile-wallet-chip-orders"]');
    expect(profileChip.classList.contains('is-locked')).toBe(true);
    expect(referralChip.classList.contains('is-locked')).toBe(true);
    expect(ordersChip.classList.contains('is-locked')).toBe(false);
  });

  it('subscribeAccess fires re-apply when access flips free → premium', () => {
    const container = setup();
    let accessFn = null;
    const subscribeAccess = vi.fn((fn) => {
      accessFn = fn;
      return () => {};
    });
    let state = 'free';
    mountMobileWalletPanel(container, {
      ...defaultOpts({ getAccessState: () => state, subscribeAccess }),
    });
    const profileChip = container.querySelector('[data-test-id="mobile-wallet-chip-profile"]');
    expect(profileChip.classList.contains('is-locked')).toBe(true);
    state = 'premium';
    accessFn();
    expect(profileChip.classList.contains('is-locked')).toBe(false);
  });

  it('destroy unsubscribes from access-store', () => {
    const container = setup();
    const unsub = vi.fn();
    const subscribeAccess = vi.fn(() => unsub);
    const handle = mountMobileWalletPanel(container, { ...defaultOpts({ subscribeAccess }) });
    handle.destroy();
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});

describe('mountMobileWalletPanel — active-token sync', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    routerSubs.clear();
    routerState = { tab: 'wallet', subroute: null };
    navigateToMock.mockClear();
    mountProfile.mockClear();
    mountOrdersTab.mockClear();
    mountProfileReferral.mockClear();
    mountMyWalletTab.mockClear();
  });

  it('setToken(token) then chip-switch to Orders forwards token to the fresh orders handle on mount', () => {
    const container = setup();
    const handle = mountMobileWalletPanel(container, defaultOpts());
    const token = { address: '0xabc', symbol: 'FOO' };
    handle.setToken(token);
    // Orders not yet mounted — nothing to forward to yet.
    expect(mountOrdersTab).not.toHaveBeenCalled();
    container.querySelector('[data-test-id="mobile-wallet-chip-orders"]').click();
    expect(mountOrdersTab).toHaveBeenCalledTimes(1);
    const ordersHandle = mountOrdersTab.mock.results[0].value;
    expect(ordersHandle.setToken).toHaveBeenCalledWith(token);
  });

  it('setToken(token) while Orders is active forwards immediately to the live handle', () => {
    const container = setup();
    const handle = mountMobileWalletPanel(container, defaultOpts());
    container.querySelector('[data-test-id="mobile-wallet-chip-orders"]').click();
    const ordersHandle = mountOrdersTab.mock.results[0].value;
    ordersHandle.setToken.mockClear();
    const token = { address: '0xdef', symbol: 'BAR' };
    handle.setToken(token);
    expect(ordersHandle.setToken).toHaveBeenCalledWith(token);
  });

  it('setToken is a no-op when current sub-page has no setToken surface', () => {
    const container = setup();
    const handle = mountMobileWalletPanel(container, defaultOpts());
    // Profile is active; mountProfile mock returns no setToken — should not throw.
    expect(() => handle.setToken({ address: '0xabc' })).not.toThrow();
  });

  it('null setToken clears the cached selection (no replay on next Orders mount)', () => {
    const container = setup();
    const handle = mountMobileWalletPanel(container, defaultOpts());
    handle.setToken({ address: '0xabc' });
    handle.setToken(null);
    container.querySelector('[data-test-id="mobile-wallet-chip-orders"]').click();
    const ordersHandle = mountOrdersTab.mock.results[0].value;
    expect(ordersHandle.setToken).not.toHaveBeenCalled();
  });
});

describe('mountMobileWalletPanel — mount failure retry recovery', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    routerSubs.clear();
    routerState = { tab: 'wallet', subroute: null };
    mountProfile.mockClear();
    mountOrdersTab.mockClear();
    mountProfileReferral.mockClear();
  });

  it('a failed sub-page mount leaves activeSub null so the same chip can be retried', () => {
    const container = setup();
    // First mountProfile throws; second succeeds.
    mountProfile.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    mountProfile.mockImplementationOnce((node) => {
      const child = document.createElement('div');
      child.dataset.testId = 'mock-profile';
      node.appendChild(child);
      return { destroy: vi.fn() };
    });
    const handle = mountMobileWalletPanel(container, defaultOpts());
    expect(handle.getActiveSub()).toBeNull();
    // Tap Profile again — should re-attempt instead of being a no-op.
    container.querySelector('[data-test-id="mobile-wallet-chip-profile"]').click();
    expect(mountProfile).toHaveBeenCalledTimes(2);
    expect(handle.getActiveSub()).toBe('profile');
  });
});
