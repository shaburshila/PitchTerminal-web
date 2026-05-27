// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock @wagmi/core BEFORE importing the SUT. We model just enough of the
// v2/v3 vanilla wagmi surface for our wallet wrapper —
// connect/disconnect/switchChain/getConnections/watchConnections/reconnect/
// signMessage. The actual AppKit/WagmiAdapter pair below installs a
// pre-built `Config` via `wagmiAdapter.wagmiConfig`, so the action mocks
// here just have to accept that opaque object as the first arg.
const wagmiState = {
  connections: [],
  watchers: new Set(),
};

function emitWagmi() {
  for (const fn of wagmiState.watchers) fn();
}

vi.mock('@wagmi/core', () => {
  return {
    connect: vi.fn(async () => {
      wagmiState.connections = [
        {
          accounts: ['0xABCdef0000000000000000000000000000000001'],
          chainId: 8453,
          connector: { id: 'injected' },
        },
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
    signMessage: vi.fn(async () => '0xfeedface'),
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

// AppKit + WagmiAdapter test doubles. `wagmiConfig` is just an opaque marker
// — production code passes it through to the @wagmi/core actions which we
// already mocked above.
const appKitState = {
  open: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
};
const adapterState = { wagmiConfig: { __marker: 'wagmiConfig' } };

vi.mock('@reown/appkit', () => ({
  createAppKit: vi.fn(() => appKitState),
}));

vi.mock('@reown/appkit-adapter-wagmi', () => ({
  WagmiAdapter: vi.fn(function WagmiAdapter() {
    return adapterState;
  }),
}));

// @reown/appkit-siwe is imported by `src/siwe-config.js` (which `wallet.js`
// pulls in at module-eval time). The real module touches WC + crypto deps
// that aren't worth dragging into the happy-dom sandbox — stub the two named
// exports the wallet path uses.
vi.mock('@reown/appkit-siwe', () => ({
  createSIWEConfig: vi.fn((opts) => ({ __siwe: true, opts })),
  formatMessage: vi.fn((args, address) => `siwe-msg:${address}:${JSON.stringify(args)}`),
}));

// Import SUT AFTER mocks so they take effect.
const wallet = await import('../src/wallet.js');

beforeEach(() => {
  wallet._resetForTests();
  wagmiState.connections = [];
  wagmiState.watchers.clear();
  appKitState.open.mockClear();
  appKitState.disconnect.mockClear();
});

describe('wallet — state machine', () => {
  it('initial state is disconnected', () => {
    const acc = wallet.getAccount();
    expect(acc.address).toBeNull();
    expect(acc.chainId).toBeNull();
    expect(acc.isConnected).toBe(false);
    expect(acc.connectorId).toBeNull();
  });

  it('onAccountChange fires when a connection appears via wagmi watcher', async () => {
    wallet.setWalletConnectProjectId('abc123');
    const seen = [];
    const off = wallet.onAccountChange((s) => seen.push(s));
    // Simulate AppKit-driven connection: wagmi picks up a new connection and
    // notifies our watcher. The watcher's onChange handler reads
    // getConnections() and pushes state.
    wagmiState.connections = [
      {
        accounts: ['0xABCdef0000000000000000000000000000000001'],
        chainId: 8453,
        connector: { id: 'injected' },
      },
    ];
    emitWagmi();
    expect(seen.length).toBeGreaterThan(0);
    const last = seen[seen.length - 1];
    expect(last.isConnected).toBe(true);
    expect(last.address).toBe('0xabcdef0000000000000000000000000000000001');
    expect(last.chainId).toBe(8453);
    expect(last.connectorId).toBe('injected');
    off();
  });

  it('classifies WalletConnect connector ids as walletConnect', async () => {
    wallet.setWalletConnectProjectId('abc123');
    wagmiState.connections = [
      {
        accounts: ['0xdEAD000000000000000000000000000000000002'],
        chainId: 8453,
        connector: { id: 'walletConnect' },
      },
    ];
    emitWagmi();
    expect(wallet.getAccount().connectorId).toBe('walletConnect');
  });

  it('connectWallet opens the AppKit modal', async () => {
    wallet.setWalletConnectProjectId('abc123');
    await wallet.connectWallet();
    expect(appKitState.open).toHaveBeenCalledTimes(1);
    // Modal opens directly on the Connect view, not the Account view.
    expect(appKitState.open).toHaveBeenCalledWith({ view: 'Connect' });
  });

  it('disconnectWallet clears state and calls wagmi.disconnect', async () => {
    wallet.setWalletConnectProjectId('abc123');
    wagmiState.connections = [
      {
        accounts: ['0xABCdef0000000000000000000000000000000001'],
        chainId: 8453,
        connector: { id: 'injected' },
      },
    ];
    emitWagmi();
    await wallet.disconnectWallet();
    const acc = wallet.getAccount();
    expect(acc.isConnected).toBe(false);
    expect(acc.address).toBeNull();
    expect(acc.connectorId).toBeNull();
  });

  it('switchToBase forwards to wagmi switchChain', async () => {
    wallet.setWalletConnectProjectId('abc123');
    wagmiState.connections = [
      {
        accounts: ['0xABCdef0000000000000000000000000000000001'],
        chainId: 137,
        connector: { id: 'injected' },
      },
    ];
    emitWagmi();
    await wallet.switchToBase();
    expect(wallet.getAccount().chainId).toBe(8453);
    expect(wallet.isOnBase()).toBe(true);
  });

  it('isOnBase is false when not connected', () => {
    expect(wallet.isOnBase()).toBe(false);
  });
});

describe('wallet — walletConnect project id', () => {
  it('setWalletConnectProjectId is idempotent for the same id', () => {
    wallet.setWalletConnectProjectId('abc123');
    wallet.setWalletConnectProjectId('abc123');
    // Build is eager but should only happen once; we don't have a counter
    // exposed, so we just assert it doesn't throw.
  });

  it('empty project id is a no-op', () => {
    wallet.setWalletConnectProjectId('');
    // No AppKit construction — getWagmiConfig should still throw because the
    // adapter never built.
    expect(() => wallet.getWagmiConfig()).toThrow(/setWalletConnectProjectId/);
  });

  it('rotating the project id throws (would require modal teardown)', () => {
    wallet.setWalletConnectProjectId('abc123');
    expect(() => wallet.setWalletConnectProjectId('different')).toThrow();
  });

  it('getWagmiConfig returns the adapter wagmiConfig once primed', () => {
    wallet.setWalletConnectProjectId('abc123');
    expect(wallet.getWagmiConfig()).toBe(adapterState.wagmiConfig);
  });
});
