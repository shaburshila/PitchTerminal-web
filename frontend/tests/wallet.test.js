// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock @wagmi/core BEFORE importing the SUT so its module-level imports
// resolve to the test doubles. We model just enough of the v3 surface for
// the SUT — connect/disconnect/switchChain/getConnections/watchConnections/reconnect/createConfig/injected/http/chains.
const wagmiState = {
  connections: [],
  watchers: new Set(),
};

function emitWagmi() {
  for (const fn of wagmiState.watchers) fn();
}

vi.mock('@wagmi/core', () => {
  return {
    createConfig: vi.fn(() => ({ connectors: [{ id: 'injected' }] })),
    injected: vi.fn(() => ({ id: 'injected' })),
    connect: vi.fn(async () => {
      wagmiState.connections = [
        { accounts: ['0xABCdef0000000000000000000000000000000001'], chainId: 8453 },
      ];
      emitWagmi();
      return wagmiState.connections[0];
    }),
    disconnect: vi.fn(async () => {
      wagmiState.connections = [];
      emitWagmi();
    }),
    switchChain: vi.fn(async (_cfg, { chainId }) => {
      if (wagmiState.connections[0]) wagmiState.connections[0].chainId = chainId;
      emitWagmi();
      return { id: chainId };
    }),
    getConnections: vi.fn(() => wagmiState.connections),
    watchConnections: vi.fn((_cfg, { onChange }) => {
      wagmiState.watchers.add(onChange);
      return () => wagmiState.watchers.delete(onChange);
    }),
    reconnect: vi.fn(async () => []),
  };
});

vi.mock('viem/chains', () => ({
  base: { id: 8453, name: 'Base' },
  baseSepolia: { id: 84532, name: 'Base Sepolia' },
}));

vi.mock('viem', () => ({
  createPublicClient: vi.fn(() => ({})),
  http: vi.fn(() => ({})),
}));

// Mock the WC provider import — it's `import()`-ed lazily in wallet.js.
const wcState = { provider: null, init: vi.fn() };
vi.mock('@walletconnect/ethereum-provider', () => {
  const provider = {
    accounts: ['0xdEAD000000000000000000000000000000000002'],
    chainId: 8453,
    _handlers: new Map(),
    on(event, cb) {
      this._handlers.set(event, cb);
    },
    request: vi.fn(async () => null),
    connect: vi.fn(async () => null),
    disconnect: vi.fn(async () => null),
  };
  wcState.provider = provider;
  return {
    EthereumProvider: {
      init: vi.fn(async () => {
        wcState.init();
        return provider;
      }),
    },
  };
});

// Import SUT AFTER mocks so they take effect.
const wallet = await import('../src/wallet.js');

beforeEach(() => {
  wallet._resetForTests();
  wagmiState.connections = [];
  wagmiState.watchers.clear();
  wcState.init.mockClear();
  if (wcState.provider) {
    wcState.provider._handlers.clear();
    wcState.provider.disconnect.mockClear?.();
    wcState.provider.request.mockClear?.();
  }
});

describe('wallet — state machine', () => {
  it('initial state is disconnected', () => {
    const acc = wallet.getAccount();
    expect(acc.address).toBeNull();
    expect(acc.chainId).toBeNull();
    expect(acc.isConnected).toBe(false);
    expect(acc.connectorId).toBeNull();
  });

  it('connectWallet(injected) updates state and lowercases address', async () => {
    await wallet.connectWallet('injected');
    const acc = wallet.getAccount();
    expect(acc.isConnected).toBe(true);
    expect(acc.address).toBe('0xabcdef0000000000000000000000000000000001');
    expect(acc.chainId).toBe(8453);
    expect(acc.connectorId).toBe('injected');
  });

  it('onAccountChange fires on state transitions', async () => {
    const seen = [];
    const off = wallet.onAccountChange((s) => seen.push(s));
    await wallet.connectWallet('injected');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1].isConnected).toBe(true);
    off();

    await wallet.disconnectWallet();
    // No additional callbacks after unsubscribe.
    const lenAfter = seen.length;
    await wallet.connectWallet('injected');
    expect(seen.length).toBe(lenAfter);
  });

  it('disconnectWallet resets state', async () => {
    await wallet.connectWallet('injected');
    await wallet.disconnectWallet();
    const acc = wallet.getAccount();
    expect(acc.isConnected).toBe(false);
    expect(acc.address).toBeNull();
    expect(acc.connectorId).toBeNull();
  });

  it('switchToBase forwards to wagmi for injected sessions', async () => {
    await wallet.connectWallet('injected');
    // Pretend we ended up on Polygon.
    wagmiState.connections[0].chainId = 137;
    await wallet.switchToBase();
    expect(wallet.getAccount().chainId).toBe(8453);
    expect(wallet.isOnBase()).toBe(true);
  });

  it('isOnBase is false when not connected', () => {
    expect(wallet.isOnBase()).toBe(false);
  });

  it('isOnBase is false when on a different chain', async () => {
    await wallet.connectWallet('injected');
    wagmiState.connections[0].chainId = 1; // Ethereum mainnet
    // Trigger sync via a fresh connect (mocked syncFromWagmi reads head conn)
    // by emitting watcher event:
    for (const w of wagmiState.watchers) w();
    expect(wallet.isOnBase()).toBe(false);
  });
});

describe('wallet — walletConnect path', () => {
  it('setWalletConnectProjectId is idempotent', () => {
    wallet.setWalletConnectProjectId('abc123');
    wallet.setWalletConnectProjectId('abc123');
    expect(wcState.init).not.toHaveBeenCalled(); // init only on connect
  });

  it('connectWallet(walletConnect) without projectId throws', async () => {
    await expect(wallet.connectWallet('walletConnect')).rejects.toThrow(/projectId/);
  });

  it('connectWallet(walletConnect) initialises the WC provider and updates state', async () => {
    wallet.setWalletConnectProjectId('abc123');
    await wallet.connectWallet('walletConnect');
    expect(wcState.init).toHaveBeenCalledTimes(1);
    const acc = wallet.getAccount();
    expect(acc.isConnected).toBe(true);
    expect(acc.address).toBe('0xdead000000000000000000000000000000000002');
    expect(acc.connectorId).toBe('walletConnect');
  });

  it('WC accountsChanged event flips address (lowercased)', async () => {
    wallet.setWalletConnectProjectId('abc123');
    await wallet.connectWallet('walletConnect');
    const cb = wcState.provider._handlers.get('accountsChanged');
    expect(typeof cb).toBe('function');
    cb(['0xFEEDFACE00000000000000000000000000000003']);
    expect(wallet.getAccount().address).toBe('0xfeedface00000000000000000000000000000003');
  });

  it('WC chainChanged event normalises hex chainId', async () => {
    wallet.setWalletConnectProjectId('abc123');
    await wallet.connectWallet('walletConnect');
    const cb = wcState.provider._handlers.get('chainChanged');
    cb('0x2105'); // 8453
    expect(wallet.getAccount().chainId).toBe(8453);
  });

  it('WC disconnect event clears state', async () => {
    wallet.setWalletConnectProjectId('abc123');
    await wallet.connectWallet('walletConnect');
    const cb = wcState.provider._handlers.get('disconnect');
    cb();
    expect(wallet.getAccount().isConnected).toBe(false);
  });
});
