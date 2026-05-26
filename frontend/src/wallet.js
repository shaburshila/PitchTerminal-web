/**
 * Wallet module (F0.9/F0.10).
 *
 * Wraps `@wagmi/core` for the injected wallet path (MetaMask, Coinbase
 * extension, Rabby, etc.) and `@walletconnect/ethereum-provider` for the
 * WalletConnect QR path. Exposes a small state machine — UI subscribes via
 * `onAccountChange` and reads `getAccount()` for the current snapshot.
 *
 * Addresses are normalised to lowercase in state (so `===` works and matches
 * the JWT `sub` casing — see conventions §4.1). Callers render via
 * `viem.getAddress` for EIP-55 checksum display.
 *
 * Why two parallel paths instead of one wagmi config?
 *   `@wagmi/core` v2 ships only the `injected` connector in the published
 *   tarball; the `walletConnect` factory lives in `@wagmi/connectors` which
 *   we don't depend on yet (avoids a transitive-dep blowup). For the MVP
 *   the WC provider is managed standalone and feeds the same state, which
 *   is enough to satisfy the F0.9/F0.10 DoD. When/if we adopt
 *   `@wagmi/connectors`, this can collapse to a single wagmi `Config`
 *   without breaking the public API of this module.
 */

import {
  createConfig,
  connect,
  disconnect,
  switchChain,
  getConnections,
  watchConnections,
  reconnect,
} from '@wagmi/core';
import { injected } from '@wagmi/core';
import { base, baseSepolia } from 'viem/chains';
import { createPublicClient, http } from 'viem';

export const SUPPORTED_CHAINS = Object.freeze([base, baseSepolia]);
export const BASE_CHAIN_ID = base.id; // 8453

/** Public connector ids — what `connect()` accepts. */
export const CONNECTOR_INJECTED = 'injected';
export const CONNECTOR_WALLET_CONNECT = 'walletConnect';

// ─── State ──────────────────────────────────────────────────────────────────

/**
 * @typedef {object} AccountState
 * @property {string | null} address       lowercase 0x-prefixed, or null
 * @property {number | null} chainId
 * @property {boolean} isConnected
 * @property {string | null} connectorId   'injected' | 'walletConnect' | null
 */

/** @type {AccountState} */
let state = {
  address: null,
  chainId: null,
  isConnected: false,
  connectorId: null,
};

/** @type {Set<(s: AccountState) => void>} */
const listeners = new Set();

function snapshot() {
  // Shallow clone — listeners shouldn't mutate the live state.
  return { ...state };
}

function setState(patch) {
  const next = { ...state, ...patch };
  // Cheap equality — avoids spurious notifications on identical re-renders.
  if (
    next.address === state.address &&
    next.chainId === state.chainId &&
    next.isConnected === state.isConnected &&
    next.connectorId === state.connectorId
  ) {
    return;
  }
  state = next;
  const snap = snapshot();
  for (const fn of listeners) {
    try {
      fn(snap);
    } catch {
      // Don't let one bad listener kill the others.
    }
  }
}

/** Current snapshot — never returns the internal object. */
export function getAccount() {
  return snapshot();
}

/**
 * Subscribe to account changes. Returns an unsubscribe function.
 * @param {(s: AccountState) => void} listener
 */
export function onAccountChange(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ─── Wagmi config (injected path) ───────────────────────────────────────────

let _wagmiConfig = null;

function buildTransports() {
  // Public RPC fallback — sufficient for read-only ops at boot. Chains'
  // default RPC is wired in by viem; no need to hardcode our env values
  // here (frontend doesn't have direct access to backend RPC env anyway).
  return {
    [base.id]: http(),
    [baseSepolia.id]: http(),
  };
}

/**
 * Build (idempotent) and return the singleton wagmi Config. We construct it
 * lazily so tests can stub `localStorage` / window before first use.
 */
export function getWagmiConfig() {
  if (_wagmiConfig) return _wagmiConfig;
  _wagmiConfig = createConfig({
    chains: [base, baseSepolia],
    connectors: [injected({ shimDisconnect: true })],
    transports: buildTransports(),
  });
  return _wagmiConfig;
}

let _unwatch = null;

function syncFromWagmi() {
  // Resolve the currently-active wagmi connection (the most recent one) and
  // mirror it into our state. If none — and we don't currently believe we're
  // connected via WC — clear state.
  const conns = getConnections(getWagmiConfig());
  const head = conns[0];
  if (head) {
    setState({
      address: head.accounts[0]?.toLowerCase() ?? null,
      chainId: head.chainId,
      isConnected: true,
      connectorId: CONNECTOR_INJECTED,
    });
  } else if (state.connectorId === CONNECTOR_INJECTED) {
    setState({ address: null, chainId: null, isConnected: false, connectorId: null });
  }
}

function ensureWagmiSubscription() {
  if (_unwatch) return;
  _unwatch = watchConnections(getWagmiConfig(), {
    onChange() {
      // The connector this fires for may be either the injected one or a
      // disconnect. `syncFromWagmi` reads the canonical store.
      if (state.connectorId !== CONNECTOR_WALLET_CONNECT) syncFromWagmi();
    },
  });
}

// ─── WalletConnect path ─────────────────────────────────────────────────────

let _wcProvider = null;
let _wcProjectId = '';
let _wcShowQrModal = true;

/**
 * Initialise WalletConnect with a project id pulled from `/config`. Safe to
 * call multiple times — the second call with the same id is a no-op; with a
 * different id it tears down the previous provider.
 * @param {string} projectId
 */
export function setWalletConnectProjectId(projectId) {
  const next = typeof projectId === 'string' ? projectId.trim() : '';
  if (next === _wcProjectId) return;
  _wcProjectId = next;
  if (_wcProvider) {
    // Best-effort teardown; ignore errors.
    try {
      _wcProvider.disconnect?.();
    } catch {
      // ignore
    }
    _wcProvider = null;
  }
}

/**
 * Lazily build (or return cached) the WalletConnect provider. By default
 * `showQrModal: true` — desktop flow renders WC's own QR modal. The mobile
 * flow (`ui/wallet-connect-modal.js`) overrides this to `false` so it can
 * intercept the `display_uri` event and render a bottom-sheet wallet picker
 * instead.
 *
 * Exported so the mobile picker can call it directly; the desktop
 * `connectWallet('walletConnect')` path still calls it internally with the
 * default options.
 *
 * @param {{ showQrModal?: boolean }} [opts]
 */
export async function loadWcProvider({ showQrModal = true } = {}) {
  if (!_wcProjectId) {
    throw new Error('walletConnect: projectId not configured');
  }
  // The cached provider was built with a fixed `showQrModal`. If the caller
  // now wants the opposite (e.g. desktop QR-flow opened first, then a mobile
  // path opens with `showQrModal: false`), tear it down and rebuild so the
  // built-in modal doesn't double-render alongside our own bottom-sheet.
  if (_wcProvider && _wcShowQrModal !== showQrModal) {
    try {
      _wcProvider.disconnect?.();
    } catch {
      // ignore — provider may already be torn down
    }
    _wcProvider = null;
  }
  if (_wcProvider) return _wcProvider;
  _wcShowQrModal = showQrModal;
  // Lazy import — keeps initial bundle small for users who never click the
  // WC button. Vite tree-shakes the import for builds that never call this.
  const mod = await import('@walletconnect/ethereum-provider');
  const EthereumProvider = mod.EthereumProvider ?? mod.default;
  _wcProvider = await EthereumProvider.init({
    projectId: _wcProjectId,
    chains: [BASE_CHAIN_ID],
    optionalChains: [baseSepolia.id],
    showQrModal,
    // metadata kept minimal — full app metadata flows from the page in
    // prod; in dev these defaults suffice to render the modal.
    metadata: {
      name: 'PitchTerminal',
      description: 'PitchTerminal — pitchwc.app trading terminal',
      url: typeof window !== 'undefined' ? window.location.origin : 'https://pitchterminal.app',
      icons: [],
    },
  });
  _wcProvider.on('accountsChanged', (accounts) => {
    if (state.connectorId !== CONNECTOR_WALLET_CONNECT) return;
    const addr = Array.isArray(accounts) && accounts[0] ? String(accounts[0]).toLowerCase() : null;
    if (!addr) {
      setState({ address: null, chainId: null, isConnected: false, connectorId: null });
      return;
    }
    setState({ address: addr });
  });
  _wcProvider.on('chainChanged', (cid) => {
    if (state.connectorId !== CONNECTOR_WALLET_CONNECT) return;
    const parsed = typeof cid === 'string' ? Number.parseInt(cid, 16) : Number(cid);
    setState({ chainId: Number.isFinite(parsed) ? parsed : null });
  });
  _wcProvider.on('disconnect', () => {
    if (state.connectorId !== CONNECTOR_WALLET_CONNECT) return;
    setState({ address: null, chainId: null, isConnected: false, connectorId: null });
  });
  return _wcProvider;
}

/**
 * Returns the active WC provider if we're connected via WC, otherwise null.
 * Exposed for callers that need to make on-chain calls through it (e.g. the
 * future pay-flow in F0.12). The injected path uses `getWagmiConfig()` +
 * wagmi actions instead.
 */
export function getWalletConnectProvider() {
  return state.connectorId === CONNECTOR_WALLET_CONNECT ? _wcProvider : null;
}

/**
 * Push WC-provider state into the module-level state machine. The mobile
 * picker (`ui/wallet-connect-modal.js`) bypasses `connectWallet()` so that
 * it can own the deep-link UI; without this helper the provider connects
 * but our state stays `connectorId: null`, `isConnected: false`, and
 * downstream consumers (wallet chip, SIWE bootstrap, access banner) never
 * react. Idempotent — repeated calls with the same address are a no-op.
 *
 * @param {{ accounts?: string[]; chainId?: number | string }} provider
 */
export function setWcConnected(provider) {
  if (!provider) return;
  const accounts = provider.accounts ?? [];
  const addr = accounts[0] ? String(accounts[0]).toLowerCase() : null;
  if (!addr) return;
  const rawChain = provider.chainId;
  const parsedChain =
    typeof rawChain === 'string' ? Number.parseInt(rawChain, 16) : Number(rawChain);
  const chainId = Number.isFinite(parsedChain) && parsedChain > 0 ? parsedChain : BASE_CHAIN_ID;
  setState({
    address: addr,
    chainId,
    isConnected: true,
    connectorId: CONNECTOR_WALLET_CONNECT,
  });
}

// ─── Public actions ─────────────────────────────────────────────────────────

/**
 * Connect via the chosen connector. Defaults to `injected`.
 * @param {string} [connectorId] one of CONNECTOR_INJECTED, CONNECTOR_WALLET_CONNECT
 */
export async function connectWallet(connectorId = CONNECTOR_INJECTED) {
  if (connectorId === CONNECTOR_WALLET_CONNECT) {
    const provider = await loadWcProvider();
    // Pass `chains` to ensure the WC modal proposes Base.
    await provider.connect({ chains: [BASE_CHAIN_ID] });
    const accounts = provider.accounts ?? [];
    const addr = accounts[0] ? String(accounts[0]).toLowerCase() : null;
    if (!addr) throw new Error('walletConnect: no account returned');
    setState({
      address: addr,
      chainId: Number(provider.chainId) || BASE_CHAIN_ID,
      isConnected: true,
      connectorId: CONNECTOR_WALLET_CONNECT,
    });
    return snapshot();
  }
  // Injected path — wagmi handles MetaMask, Coinbase Wallet extension, etc.
  ensureWagmiSubscription();
  const config = getWagmiConfig();
  const [injectedConnector] = config.connectors;
  if (!injectedConnector) throw new Error('No injected connector configured');
  await connect(config, { connector: injectedConnector });
  syncFromWagmi();
  return snapshot();
}

/** Tear down the current connection. Safe to call when already disconnected. */
export async function disconnectWallet() {
  if (state.connectorId === CONNECTOR_WALLET_CONNECT && _wcProvider) {
    try {
      await _wcProvider.disconnect();
    } catch {
      // ignore
    }
    _wcProvider = null;
    setState({ address: null, chainId: null, isConnected: false, connectorId: null });
    return;
  }
  if (state.connectorId === CONNECTOR_INJECTED) {
    try {
      await disconnect(getWagmiConfig());
    } catch {
      // ignore — best effort
    }
    syncFromWagmi();
    return;
  }
  // Already idle.
  setState({ address: null, chainId: null, isConnected: false, connectorId: null });
}

/** Switch the connected wallet to Base (chainId 8453). */
export async function switchToBase() {
  if (!state.isConnected) throw new Error('Not connected');
  if (state.connectorId === CONNECTOR_WALLET_CONNECT && _wcProvider) {
    await _wcProvider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: `0x${BASE_CHAIN_ID.toString(16)}` }],
    });
    setState({ chainId: BASE_CHAIN_ID });
    return;
  }
  if (state.connectorId === CONNECTOR_INJECTED) {
    await switchChain(getWagmiConfig(), { chainId: BASE_CHAIN_ID });
    syncFromWagmi();
    return;
  }
}

/**
 * Re-hydrate any prior connection on page load. Currently only the injected
 * path supports silent reconnect — WC requires the user to scan again.
 */
export async function tryAutoReconnect() {
  ensureWagmiSubscription();
  try {
    await reconnect(getWagmiConfig());
    syncFromWagmi();
  } catch {
    // No prior session — that's fine.
  }
  return snapshot();
}

// ─── Public read-only constants for UI ──────────────────────────────────────

export function isOnBase() {
  return state.isConnected && state.chainId === BASE_CHAIN_ID;
}

/**
 * Test-only: reset internal state + listeners. Lives next to the prod API so
 * unit tests don't reach into module internals via brittle ESM tricks.
 */
export function _resetForTests() {
  state = { address: null, chainId: null, isConnected: false, connectorId: null };
  listeners.clear();
  if (_unwatch) {
    try {
      _unwatch();
    } catch {
      // ignore
    }
    _unwatch = null;
  }
  _wagmiConfig = null;
  _wcProvider = null;
  _wcProjectId = '';
  _wcShowQrModal = true;
}

// Unused helper kept for future pay-flow code that needs a read-only client.
export { createPublicClient };
