// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Test-double state for wallet.js. Listeners and a mutable account snapshot
// drive the chip's render path.
const fake = {
  account: { address: null, chainId: null, isConnected: false, connectorId: null },
  listeners: new Set(),
  connectCalls: [],
  disconnectCalls: 0,
  switchCalls: 0,
  wcProjectId: '',
};

function setAccount(next) {
  fake.account = { ...fake.account, ...next };
  for (const fn of fake.listeners) fn({ ...fake.account });
}

vi.mock('../src/wallet.js', () => ({
  getAccount: () => ({ ...fake.account }),
  onAccountChange: (cb) => {
    fake.listeners.add(cb);
    return () => fake.listeners.delete(cb);
  },
  connectWallet: vi.fn(async (id) => {
    fake.connectCalls.push(id);
    setAccount({
      address: '0xabcdef0000000000000000000000000000000001',
      chainId: 8453,
      isConnected: true,
      connectorId: id,
    });
  }),
  disconnectWallet: vi.fn(async () => {
    fake.disconnectCalls++;
    setAccount({ address: null, chainId: null, isConnected: false, connectorId: null });
  }),
  switchToBase: vi.fn(async () => {
    fake.switchCalls++;
    setAccount({ chainId: 8453 });
  }),
  setWalletConnectProjectId: vi.fn((id) => {
    fake.wcProjectId = id;
  }),
  isOnBase: () => fake.account.isConnected && fake.account.chainId === 8453,
  tryAutoReconnect: vi.fn(async () => ({ ...fake.account })),
  CONNECTOR_INJECTED: 'injected',
  CONNECTOR_WALLET_CONNECT: 'walletConnect',
}));

const { mountWalletChip } = await import('../src/ui/wallet-chip.js');

beforeEach(() => {
  document.body.replaceChildren();
  fake.account = { address: null, chainId: null, isConnected: false, connectorId: null };
  fake.listeners.clear();
  fake.connectCalls.length = 0;
  fake.disconnectCalls = 0;
  fake.switchCalls = 0;
  fake.wcProjectId = '';
});

function host() {
  const node = document.createElement('div');
  document.body.appendChild(node);
  return node;
}

describe('mountWalletChip — disconnected state', () => {
  it('renders a connect button', () => {
    mountWalletChip(host());
    expect(document.querySelector('[data-test-id="wallet-connect-btn"]')).not.toBeNull();
    expect(document.querySelector('[data-test-id="wallet-chip"]').hidden).toBe(true);
  });

  it('connect-btn directly connects when WC not enabled', async () => {
    mountWalletChip(host()); // no wcProjectId
    document.querySelector('[data-test-id="wallet-connect-btn"]').click();
    // microtask flush
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.connectCalls).toEqual(['injected']);
  });

  it('connect-btn opens the picker when WC IS enabled', () => {
    mountWalletChip(host(), { wcProjectId: 'abc123' });
    const picker = document.querySelector('[data-test-id="wallet-connector-picker"]');
    expect(picker.hidden).toBe(true);
    document.querySelector('[data-test-id="wallet-connect-btn"]').click();
    expect(picker.hidden).toBe(false);
    expect(document.querySelector('[data-test-id="wallet-pick-wc"]')).not.toBeNull();
  });

  it('WC picker entry is omitted when projectId is empty', () => {
    mountWalletChip(host(), { wcProjectId: '' });
    expect(document.querySelector('[data-test-id="wallet-pick-wc"]')).toBeNull();
  });

  it('picking injected from the picker triggers connect', async () => {
    mountWalletChip(host(), { wcProjectId: 'abc123' });
    document.querySelector('[data-test-id="wallet-connect-btn"]').click();
    document.querySelector('[data-test-id="wallet-pick-injected"]').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.connectCalls).toContain('injected');
  });

  it('picking WC triggers connectWallet("walletConnect")', async () => {
    mountWalletChip(host(), { wcProjectId: 'abc123' });
    document.querySelector('[data-test-id="wallet-connect-btn"]').click();
    document.querySelector('[data-test-id="wallet-pick-wc"]').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.connectCalls).toContain('walletConnect');
  });
});

describe('mountWalletChip — connected state', () => {
  it('shows shortened EIP-55 address after connect', async () => {
    mountWalletChip(host());
    setAccount({
      address: '0x71ecd1a09380ca46cca741bc48d04c556674756f',
      chainId: 8453,
      isConnected: true,
      connectorId: 'injected',
    });
    const text = document.querySelector('[data-test-id="wallet-chip-text"]');
    expect(text.textContent).toMatch(/^0x71EC.+756F$/i);
  });

  it('hides connect area while connected', () => {
    mountWalletChip(host());
    setAccount({
      address: '0xabc0000000000000000000000000000000000001',
      chainId: 8453,
      isConnected: true,
      connectorId: 'injected',
    });
    const chip = document.querySelector('[data-test-id="wallet-chip"]');
    expect(chip.hidden).toBe(false);
  });

  it('wrong-chain → switch button visible + red dot', () => {
    mountWalletChip(host());
    setAccount({
      address: '0xabc0000000000000000000000000000000000001',
      chainId: 137,
      isConnected: true,
      connectorId: 'injected',
    });
    const dot = document.querySelector('[data-test-id="wallet-chip-dot"]');
    expect(dot.classList.contains('pt-wallet-chip__dot--wrong')).toBe(true);
    const btn = document.querySelector('[data-test-id="wallet-switch-btn"]');
    expect(btn.hidden).toBe(false);
  });

  it('clicking switch button triggers switchToBase', async () => {
    mountWalletChip(host());
    setAccount({
      address: '0xabc0000000000000000000000000000000000001',
      chainId: 137,
      isConnected: true,
      connectorId: 'injected',
    });
    document.querySelector('[data-test-id="wallet-switch-btn"]').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.switchCalls).toBe(1);
  });

  it('chip click opens dropdown; second click closes it', () => {
    mountWalletChip(host());
    setAccount({
      address: '0xabc0000000000000000000000000000000000001',
      chainId: 8453,
      isConnected: true,
      connectorId: 'injected',
    });
    const dropdown = document.querySelector('[data-test-id="wallet-dropdown"]');
    expect(dropdown.hidden).toBe(true);
    const chip = document.querySelector('[data-test-id="wallet-chip"]');
    chip.click();
    expect(dropdown.hidden).toBe(false);
    chip.click();
    expect(dropdown.hidden).toBe(true);
  });

  it('outside click closes the dropdown', () => {
    mountWalletChip(host());
    setAccount({
      address: '0xabc0000000000000000000000000000000000001',
      chainId: 8453,
      isConnected: true,
      connectorId: 'injected',
    });
    document.querySelector('[data-test-id="wallet-chip"]').click();
    expect(document.querySelector('[data-test-id="wallet-dropdown"]').hidden).toBe(false);
    document.body.click();
    expect(document.querySelector('[data-test-id="wallet-dropdown"]').hidden).toBe(true);
  });

  it('view-profile invokes the onViewProfile callback', () => {
    const onViewProfile = vi.fn();
    mountWalletChip(host(), { onViewProfile });
    setAccount({
      address: '0xabc0000000000000000000000000000000000001',
      chainId: 8453,
      isConnected: true,
      connectorId: 'injected',
    });
    document.querySelector('[data-test-id="wallet-chip"]').click();
    document.querySelector('[data-test-id="wallet-view-profile"]').click();
    expect(onViewProfile).toHaveBeenCalledTimes(1);
  });

  it('disconnect-menu invokes disconnectWallet', async () => {
    mountWalletChip(host());
    setAccount({
      address: '0xabc0000000000000000000000000000000000001',
      chainId: 8453,
      isConnected: true,
      connectorId: 'injected',
    });
    document.querySelector('[data-test-id="wallet-chip"]').click();
    document.querySelector('[data-test-id="wallet-disconnect"]').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.disconnectCalls).toBe(1);
  });

  it('forwards wcProjectId to setWalletConnectProjectId on mount', () => {
    mountWalletChip(host(), { wcProjectId: 'abc123' });
    expect(fake.wcProjectId).toBe('abc123');
  });
});
