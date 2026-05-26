// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mocks must be declared BEFORE the SUT is imported.
vi.mock('../src/trade-panel.js', () => {
  return {
    mountTradePanel: vi.fn((container) => {
      const node = document.createElement('div');
      node.dataset.testId = 'mock-trade-panel';
      container.appendChild(node);
      return {
        setToken: vi.fn(),
        destroy: vi.fn(),
        getState: vi.fn(() => ({})),
        refreshQuote: vi.fn(async () => {}),
      };
    }),
  };
});

vi.mock('../src/orders-tab.js', () => {
  return {
    mountOrdersTab: vi.fn((container) => {
      const node = document.createElement('div');
      node.dataset.testId = 'mock-orders-tab';
      container.appendChild(node);
      return {
        setToken: vi.fn(),
        destroy: vi.fn(),
        pushOrderUpdate: vi.fn(),
        refresh: vi.fn(async () => {}),
        getState: vi.fn(() => ({})),
      };
    }),
  };
});

const { mountTradePanel } = await import('../src/trade-panel.js');
const { mountOrdersTab } = await import('../src/orders-tab.js');
const { mountMobileTradeTabs } = await import('../src/mobile-trade-tabs.js');

function setup() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return container;
}

describe('mountMobileTradeTabs', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    mountTradePanel.mockClear();
    mountOrdersTab.mockClear();
  });

  it('mounts both sub-components immediately on init', () => {
    const container = setup();
    mountMobileTradeTabs(container, {});
    expect(mountTradePanel).toHaveBeenCalledTimes(1);
    expect(mountOrdersTab).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state and hides the inner wrapper on init (no token yet)', () => {
    const container = setup();
    mountMobileTradeTabs(container, {});
    const empty = container.querySelector('[data-test-id="mobile-trade-empty"]');
    const inner = container.querySelector('[data-test-id="mobile-trade-inner"]');
    expect(empty.hidden).toBe(false);
    expect(inner.hidden).toBe(true);
  });

  it('"Browse Markets" tap calls navigateToMarkets', () => {
    const container = setup();
    const navigateToMarkets = vi.fn();
    mountMobileTradeTabs(container, { navigateToMarkets });
    container.querySelector('[data-test-id="trade-browse-markets"]').click();
    expect(navigateToMarkets).toHaveBeenCalledTimes(1);
  });

  it('setToken(token) hides empty state, shows inner, forwards to trade + orders', () => {
    const container = setup();
    const handle = mountMobileTradeTabs(container, {});
    const tradeMock = mountTradePanel.mock.results[0].value;
    const ordersMock = mountOrdersTab.mock.results[0].value;

    const token = { address: '0xAbC', symbol: 'BRA', kind: 'country' };
    handle.setToken(token);

    const empty = container.querySelector('[data-test-id="mobile-trade-empty"]');
    const inner = container.querySelector('[data-test-id="mobile-trade-inner"]');
    expect(empty.hidden).toBe(true);
    expect(inner.hidden).toBe(false);
    expect(tradeMock.setToken).toHaveBeenCalledWith(token);
    expect(ordersMock.setToken).toHaveBeenCalledWith(
      '0xAbC',
      expect.objectContaining({ symbol: 'BRA', kind: 'country' }),
    );
  });

  it('setToken(null) re-shows empty state and clears inner sub-components', () => {
    const container = setup();
    const handle = mountMobileTradeTabs(container, {});
    const tradeMock = mountTradePanel.mock.results[0].value;
    const ordersMock = mountOrdersTab.mock.results[0].value;

    handle.setToken({ address: '0xAbC' });
    handle.setToken(null);

    const empty = container.querySelector('[data-test-id="mobile-trade-empty"]');
    const inner = container.querySelector('[data-test-id="mobile-trade-inner"]');
    expect(empty.hidden).toBe(false);
    expect(inner.hidden).toBe(true);
    expect(tradeMock.setToken).toHaveBeenLastCalledWith(null);
    expect(ordersMock.setToken).toHaveBeenLastCalledWith(null);
  });

  it('sub-tab click swaps the is-active class on buttons and panes', () => {
    const container = setup();
    mountMobileTradeTabs(container, {});

    const tradeBtn = container.querySelector('[data-test-id="mobile-subtab-trade"]');
    const ordersBtn = container.querySelector('[data-test-id="mobile-subtab-orders"]');
    const tradePane = container.querySelector('[data-test-id="mobile-trade-pane-trade"]');
    const ordersPane = container.querySelector('[data-test-id="mobile-trade-pane-orders"]');

    expect(tradeBtn.classList.contains('is-active')).toBe(true);
    expect(ordersBtn.classList.contains('is-active')).toBe(false);
    expect(tradePane.classList.contains('is-active')).toBe(true);
    expect(ordersPane.classList.contains('is-active')).toBe(false);

    ordersBtn.click();

    expect(tradeBtn.classList.contains('is-active')).toBe(false);
    expect(ordersBtn.classList.contains('is-active')).toBe(true);
    expect(tradePane.classList.contains('is-active')).toBe(false);
    expect(ordersPane.classList.contains('is-active')).toBe(true);

    tradeBtn.click();
    expect(tradeBtn.classList.contains('is-active')).toBe(true);
    expect(ordersPane.classList.contains('is-active')).toBe(false);
  });

  it('pushOrderUpdate forwards to the Orders tab handle', () => {
    const container = setup();
    const handle = mountMobileTradeTabs(container, {});
    const ordersMock = mountOrdersTab.mock.results[0].value;

    const payload = { order: { id: 'o1', status: 'filled' } };
    handle.pushOrderUpdate(payload);
    expect(ordersMock.pushOrderUpdate).toHaveBeenCalledWith(payload);
  });

  it('destroy() tears down both sub-components and removes the root', () => {
    const container = setup();
    const handle = mountMobileTradeTabs(container, {});
    const tradeMock = mountTradePanel.mock.results[0].value;
    const ordersMock = mountOrdersTab.mock.results[0].value;

    handle.destroy();
    expect(tradeMock.destroy).toHaveBeenCalledTimes(1);
    expect(ordersMock.destroy).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-test-id="mobile-trade"]')).toBeNull();
  });
});
