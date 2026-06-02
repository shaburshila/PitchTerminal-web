/**
 * Wallet module — Reown AppKit integration.
 *
 * Replaces the prior hand-rolled `@wagmi/core` + `@walletconnect/ethereum-provider`
 * dual-path setup. AppKit (formerly Web3Modal) is the de-facto standard wallet
 * connection UI used by most major DEXes — it ships a unified modal that
 * handles QR codes on desktop and native deep-links on mobile, eliminating
 * the custom mobile bottom-sheet we used to maintain.
 *
 * Public API surface — unchanged so existing call sites (`siwe.js`,
 * `access.js`, `trade-panel.js`, `wallet-chip.js`, `main.js`, …) keep working:
 *   - `getAccount()` / `onAccountChange(cb)`  — state machine
 *   - `connectWallet()`                       — opens the AppKit modal
 *   - `disconnectWallet()`                    — tears down active connection
 *   - `switchToBase()`                        — switches active wallet to Base
 *   - `isOnBase()`                            — chainId === 8453 predicate
 *   - `setWalletConnectProjectId(id)`         — primes AppKit (must be called
 *     before any user-facing connect attempt; main.js does this after /config)
 *   - `getWalletConnectProvider()`            — EIP-1193 provider for WC
 *     sessions (used by SIWE personal_sign on the WC path)
 *   - `getWagmiConfig()`                      — underlying wagmi Config (used
 *     by access.js + trade-panel.js for readContract/writeContract/
 *     signTypedData)
 *   - `tryAutoReconnect()`                    — silent rehydrate on boot
 *   - `BASE_CHAIN_ID`, `CONNECTOR_INJECTED`, `CONNECTOR_WALLET_CONNECT`,
 *     `SUPPORTED_CHAINS`
 *
 * Why a single AppKit setup instead of injected-vs-WC branching?
 *   AppKit's modal owns the picker UX. It detects injected providers itself,
 *   shows them as first-class entries alongside WalletConnect deep-links, and
 *   warms the WC universal-provider eagerly so a mobile tap on a wallet row
 *   opens that wallet immediately (the prior implementation took 10-15 s
 *   because we lazy-init'd the WC provider only on click).
 */

import {
  connect,
  disconnect,
  switchChain,
  getConnections,
  watchConnections,
  reconnect,
  signMessage as wagmiSignMessage,
} from '@wagmi/core';
import { base, baseSepolia } from 'viem/chains';
import { createPublicClient, http, fallback } from 'viem';

// AppKit + WagmiAdapter — the modal owns the picker, the adapter exposes the
// wagmi `Config` everything else in the app still consumes.
import { createAppKit } from '@reown/appkit';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
// AppKit-managed SIWE — replaces the prior `signin-modal.js` + `siwe.js`
// 2-step flow. The signing prompt is now rendered inside the AppKit modal
// immediately after the wallet picker resolves, so wallets like Rabby don't
// re-ask for "Authorize Application" between connect and personal_sign.
import { buildSiweConfig, setSiweHooks } from './siwe-config.js';

export const SUPPORTED_CHAINS = Object.freeze([base, baseSepolia]);
export const BASE_CHAIN_ID = base.id; // 8453

// ─── Public RPC endpoints ────────────────────────────────────────────────────
//
// We run on free, public Base RPC only (project policy: no paid/keyed RPC).
// A single public endpoint is a recurring source of intermittent "RPC error"
// complaints on prod — public nodes rate-limit and have transient outages.
// viem's `fallback([...])` transport rotates to the next URL on failure and,
// with `rank`, periodically re-scores endpoints by latency/stability so the
// healthiest node leads. These transports back the read path AppKit/wagmi uses
// when a call can't go through the wallet's own provider; writes still route
// through the connected wallet.
//
// All entries below are public, keyless Base endpoints.
const BASE_MAINNET_RPCS = [
  'https://mainnet.base.org',
  'https://base.llamarpc.com',
  'https://base-rpc.publicnode.com',
];
const BASE_SEPOLIA_RPCS = ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'];

/**
 * Connector id labels — kept for back-compat with callers that branch on the
 * connection kind (`siwe.js` picks personal_sign-via-WC for the WC path; the
 * trade panel doesn't care). AppKit's underlying connector ids match these.
 */
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
  return { ...state };
}

function setState(patch) {
  const next = { ...state, ...patch };
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

// ─── AppKit instance + wagmi Config ─────────────────────────────────────────

let _wcProjectId = '';
let _appKit = null;
let _wagmiAdapter = null;
let _unwatchWagmi = null;
let _unsubAppKitWallet = null;
let _activeProvider = null; // EIP-1193 provider currently in use (any source)
// Monotonic generation counter — bumped at the start of every `syncFromWagmi`
// call so a stale `await head.connector.getProvider()` can detect that a newer
// sync (triggered by a rapid disconnect→connect from `watchConnections`) has
// superseded it and bail before writing `_activeProvider`/`setState`. Without
// this guard the older promise resolves last and clobbers the fresh state.
let _syncGen = 0;

// Universal-link map for the wallets the AppKit picker surfaces. Mirrored in
// `signin-modal.js#readLastWalletDeepLink`; kept here as the single source of
// truth that ALSO gates whether we persist the wallet id at all (so we only
// store ids the modal can deep-link back to — anything else stays unwritten
// rather than poisoning the cache with an unknown name).
const KNOWN_WALLET_IDS = ['metamask', 'rainbow', 'coinbase', 'trust', 'okx', 'imtoken'];

function classifyWalletName(rawName) {
  if (!rawName || typeof rawName !== 'string') return null;
  const lc = rawName.toLowerCase();
  for (const id of KNOWN_WALLET_IDS) {
    if (lc.includes(id)) return id;
  }
  return null;
}

function persistLastWalletId(id) {
  if (typeof localStorage === 'undefined') return;
  try {
    if (id) {
      localStorage.setItem('pt:lastWalletId', id);
    } else {
      localStorage.removeItem('pt:lastWalletId');
    }
  } catch {
    // private mode / disabled — silently accept.
  }
}

function classifyConnector(connector) {
  // AppKit's wagmi connectors expose `.id` (e.g. 'injected', 'walletConnect',
  // 'metaMaskSDK', 'io.metamask', 'coinbaseWalletSDK'). The only branch in our
  // code that consumes this is SIWE → it needs to know whether to ask the WC
  // universal-provider for personal_sign vs the wagmi signMessage action.
  const raw = connector?.id ?? connector?.type ?? '';
  const id = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (id.includes('walletconnect')) return CONNECTOR_WALLET_CONNECT;
  return CONNECTOR_INJECTED;
}

async function syncFromWagmi() {
  if (!_wagmiAdapter) return;
  // Race guard (2026-05-27): rapid disconnect→connect can fire two
  // `watchConnections.onChange` callbacks before either resolves its
  // `await head.connector.getProvider()`. The older promise must NOT clobber
  // the newer connection state. We capture our generation here and re-check
  // after every await; if a newer sync started we bail without touching
  // `_activeProvider` or calling `setState`.
  const myGen = ++_syncGen;
  const conns = getConnections(_wagmiAdapter.wagmiConfig);
  const head = conns[0];
  if (head) {
    const connectorId = classifyConnector(head.connector);
    const address = head.accounts[0]?.toLowerCase() ?? null;
    const chainId = head.chainId;
    // P1 fix (2026-05-27): resolve the WalletConnect provider BEFORE flipping
    // `isConnected` so a fast user-tap on Sign in the SIWE modal doesn't race
    // a still-null `_activeProvider`. The prior fire-and-forget chain let
    // `signMessageWithWallet` throw "WalletConnect provider missing" if the
    // user reacted in <50ms. Injected connectors don't need this — wagmi's
    // `signMessage` action talks straight to the wagmi config.
    if (
      connectorId === CONNECTOR_WALLET_CONNECT &&
      typeof head.connector?.getProvider === 'function'
    ) {
      let provider = null;
      try {
        provider = await head.connector.getProvider();
      } catch (err) {
        // Surface to console so the SIWE failure has a visible cause; Sentry
        // (if wired) would pick it up automatically via the global handler.
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('wallet: getProvider() failed on WC connector', err);
        }
        provider = null;
      }
      // Stale-sync check — a newer onChange may have run while we awaited
      // getProvider(). Bail before writing module state so the fresh sync's
      // values stay authoritative.
      if (myGen !== _syncGen) return;
      _activeProvider = provider ?? null;
      // Best-effort wallet-id capture from the WC session metadata. AppKit's
      // own `subscribeWalletInfo` is the primary path (set up below in
      // `getWagmiConfig`); this fallback covers headless / test flows that
      // skip the AppKit modal but still come through a WC connector.
      const wcName = provider?.session?.peer?.metadata?.name;
      const id = classifyWalletName(wcName);
      if (id) persistLastWalletId(id);
    } else {
      // No await on this branch, but the generation check is cheap and keeps
      // ordering consistent with the awaited branch above.
      if (myGen !== _syncGen) return;
      _activeProvider = null;
    }
    setState({ address, chainId, isConnected: true, connectorId });
  } else {
    if (myGen !== _syncGen) return;
    setState({ address: null, chainId: null, isConnected: false, connectorId: null });
    _activeProvider = null;
    persistLastWalletId(null);
  }
}

function ensureWagmiSubscription() {
  if (_unwatchWagmi || !_wagmiAdapter) return;
  _unwatchWagmi = watchConnections(_wagmiAdapter.wagmiConfig, {
    onChange() {
      // syncFromWagmi is async (awaits the WC provider before flipping
      // state); we fire-and-forget here because the wagmi watcher contract
      // is synchronous and any error path is logged inside.
      syncFromWagmi();
    },
  });
}

/**
 * Wire AppKit's `subscribeWalletInfo` so we capture the connected wallet's
 * human-readable name and persist a normalised id under `pt:lastWalletId`.
 * That id is what `signin-modal.js#readLastWalletDeepLink` reads to decide
 * which universal link to push on the iOS Safari "Open wallet app" CTA.
 *
 * AppKit emits the wallet info synchronously after a successful connect,
 * including for the wagmi-injected path (the `name` for injected wallets
 * comes from the EIP-6963 announce). On disconnect AppKit emits `undefined`
 * — we treat that as "clear" so the cached id doesn't leak into a future
 * different-wallet session.
 */
function ensureAppKitWalletSubscription() {
  if (_unsubAppKitWallet || !_appKit || typeof _appKit.subscribeWalletInfo !== 'function') return;
  try {
    _unsubAppKitWallet = _appKit.subscribeWalletInfo((info) => {
      if (!info) {
        persistLastWalletId(null);
        return;
      }
      const id = classifyWalletName(info.name);
      if (id) persistLastWalletId(id);
      // If unrecognised, leave the prior value in place — a desktop
      // injected MetaMask connect after a prior mobile WC session
      // shouldn't clobber the cached mobile id (next disconnect will
      // clear it via the `!info` branch).
    });
  } catch {
    // happy-dom / minimal stub — leave the subscription unset; the WC
    // session-name fallback in syncFromWagmi still covers the mobile path.
  }
}

function buildAppKit(projectId) {
  // Build the wagmi adapter ourselves so we can re-export its `wagmiConfig`
  // unchanged to the existing read/write call sites (`access.js`,
  // `trade-panel.js`). AppKit will mount its own modal as `<w3m-modal>` on
  // first `.open()`.
  const wagmiAdapter = new WagmiAdapter({
    projectId,
    networks: [base, baseSepolia],
    // Multi-endpoint fallback over public Base RPCs (project policy: no paid
    // RPC). Previously these were bare `http()` calls that pinned us to viem's
    // single default public node — when it rate-limited or blipped, reads
    // surfaced as "RPC error" with no recovery. `fallback` rotates to the next
    // URL on failure; `rank` re-scores endpoints periodically so the fastest
    // healthy node leads. Contract writes in `access.js`/`trade-panel.js` still
    // go through the wallet's own provider, not these transports.
    transports: {
      [base.id]: fallback(
        BASE_MAINNET_RPCS.map((url) => http(url)),
        { rank: true },
      ),
      [baseSepolia.id]: fallback(
        BASE_SEPOLIA_RPCS.map((url) => http(url)),
        { rank: true },
      ),
    },
  });

  // Wire the SIWE-config hooks BEFORE `createAppKit` — AppKit invokes
  // `getSession()` synchronously on init to figure out whether to surface a
  // sign-in prompt, and that callback needs a working `getWagmiConfig`
  // thunk. We pass a thunk (rather than the live `wagmiAdapter.wagmiConfig`)
  // because the SIWE module is also imported by `main.js` for the bootstrap
  // hooks; using a thunk keeps both call sites pointing at the same config
  // instance even if `_resetForTests` rebuilds the adapter.
  setSiweHooks({
    getWagmiConfig: () => wagmiAdapter.wagmiConfig,
  });
  const siweConfig = buildSiweConfig();

  const appKit = createAppKit({
    adapters: [wagmiAdapter],
    networks: [base, baseSepolia],
    defaultNetwork: base,
    projectId,
    siweConfig,
    metadata: {
      name: 'PitchTerminal',
      description: 'PitchTerminal — pitchwc.app trading terminal',
      url: typeof window !== 'undefined' ? window.location.origin : 'https://pitchterminal.app',
      // Wallet-app rendering of the connection-request screen uses this icon
      // — empty array shows a placeholder, which looks broken on mobile WC.
      // The SVG is served from the SPA bundle (`/favicon.svg`) so any deploy
      // resolves it; if the origin can't be detected (SSR / tests) we fall
      // back to the prod canonical URL.
      icons: [
        typeof window !== 'undefined' && window.location?.origin
          ? `${window.location.origin}/favicon.svg`
          : 'https://pitchwc-terminal.xyz/favicon.svg',
      ],
    },
    features: {
      // Hide email/social login surfaces — this is a non-custodial DEX
      // terminal; we only want EOA wallet flows.
      email: false,
      socials: [],
      analytics: false,
    },
    // Keep enableReconnect on (default true) so AppKit hydrates prior sessions
    // — that also takes care of our injected re-hydrate path, which used to
    // be a separate `tryAutoReconnect → wagmi.reconnect` call.
  });

  return { wagmiAdapter, appKit };
}

/**
 * Build (idempotent) and return the singleton wagmi Config. We construct it
 * lazily so tests can stub `localStorage` / window before first use.
 *
 * Callers in production (`access.js`, `trade-panel.js`) rely on this returning
 * the same Config that the wallet UI drives, so write actions go through the
 * actually-connected account.
 */
export function getWagmiConfig() {
  if (!_wagmiAdapter) {
    if (!_wcProjectId) {
      throw new Error(
        'getWagmiConfig: setWalletConnectProjectId must be called before AppKit/wagmi can be used',
      );
    }
    const built = buildAppKit(_wcProjectId);
    _wagmiAdapter = built.wagmiAdapter;
    _appKit = built.appKit;
    ensureWagmiSubscription();
    ensureAppKitWalletSubscription();
  }
  return _wagmiAdapter.wagmiConfig;
}

function getAppKit() {
  if (!_appKit) {
    // Force lazy build — `getWagmiConfig` populates `_appKit` as a side-effect.
    getWagmiConfig();
  }
  return _appKit;
}

// ─── WalletConnect / AppKit project-id wiring ───────────────────────────────

/**
 * Prime AppKit with the WalletConnect project id from `/config`. Safe to call
 * multiple times — the second call with the same id is a no-op; with a
 * different id we currently throw because a runtime swap would orphan the
 * existing modal DOM and pending sessions.
 *
 * Calling with an empty string is a no-op (used in tests that don't have a
 * project id wired in).
 *
 * @param {string} projectId
 */
export function setWalletConnectProjectId(projectId) {
  const next = typeof projectId === 'string' ? projectId.trim() : '';
  if (!next) return;
  if (next === _wcProjectId) return;
  if (_wcProjectId && _wcProjectId !== next) {
    // Project-id rotation at runtime isn't supported — would need to tear down
    // AppKit's DOM + open WC sessions. In practice /config returns a stable
    // value per deployment.
    throw new Error('setWalletConnectProjectId: project id already initialised');
  }
  _wcProjectId = next;
  // Eager build — warming AppKit + WC universal-provider on boot is the whole
  // point of the migration: a tap on Connect should open the picker (and
  // mobile deep-links) instantly, not 10-15 s later.
  getWagmiConfig();
}

/**
 * Returns the active WC provider if the current session is WC, otherwise null.
 * Used by SIWE personal_sign on the WC path — wagmi's `signMessage` action
 * works for WC too, but historically we routed through the raw provider so
 * the message is delivered as a string (some wallet apps misrender hex).
 */
export function getWalletConnectProvider() {
  if (state.connectorId !== CONNECTOR_WALLET_CONNECT) return null;
  return _activeProvider;
}

// ─── Public actions ─────────────────────────────────────────────────────────

/**
 * Open the AppKit picker. Resolves once the user has either connected a
 * wallet (state flips via `onAccountChange`) or closed the modal — we don't
 * await the actual connection here because the AppKit modal manages its own
 * lifecycle and the wallet-chip listens to state.
 *
 * The legacy `connectorId` argument is accepted for back-compat with tests
 * that drive a connection programmatically (no real user interaction). When
 * passed, we go straight through wagmi's `connect()` action against the
 * adapter's registered connector list, bypassing the modal.
 *
 * @param {string} [connectorId]  Optional 'injected' | 'walletConnect'.
 */
export async function connectWallet(connectorId) {
  // Test/back-compat path — drive the underlying wagmi connect directly
  // instead of opening the modal. Production callers (wallet-chip) pass no
  // argument and get the AppKit picker.
  if (typeof connectorId === 'string' && connectorId) {
    const config = getWagmiConfig();
    // wagmi config exposes `connectors` (array). Pick the first matching
    // entry by classified id so the test harness's `{ id: 'injected' }`
    // connector stub still flows through.
    const connectors = (config && Array.isArray(config.connectors) && config.connectors) || [];
    const target = connectors.find((c) => classifyConnector(c) === connectorId) ?? connectors[0];
    if (!target) {
      throw new Error(`connectWallet: no connector matching ${connectorId}`);
    }
    await connect(config, { connector: target });
    await syncFromWagmi();
    return snapshot();
  }
  const appKit = getAppKit();
  if (!appKit || typeof appKit.open !== 'function') {
    throw new Error('connectWallet: AppKit not initialised');
  }
  // `view: 'Connect'` opens directly on the wallet picker instead of the
  // account screen, which is what we want for a Connect button click.
  await appKit.open({ view: 'Connect' });
  return snapshot();
}

/** Tear down the current connection. Safe to call when already disconnected. */
export async function disconnectWallet() {
  if (!_wagmiAdapter) {
    setState({ address: null, chainId: null, isConnected: false, connectorId: null });
    return;
  }
  try {
    await disconnect(_wagmiAdapter.wagmiConfig);
  } catch {
    // best-effort
  }
  await syncFromWagmi();
  // Belt + braces — if wagmi held no connection but AppKit thinks there's a
  // dangling session, ask AppKit to clear its state too.
  if (_appKit && typeof _appKit.disconnect === 'function') {
    try {
      await _appKit.disconnect();
    } catch {
      // best-effort
    }
  }
}

/** Switch the connected wallet to Base (chainId 8453). */
export async function switchToBase() {
  if (!state.isConnected) throw new Error('Not connected');
  if (!_wagmiAdapter) throw new Error('switchToBase: wagmi adapter not initialised');
  await switchChain(_wagmiAdapter.wagmiConfig, { chainId: BASE_CHAIN_ID });
  await syncFromWagmi();
}

/**
 * Re-hydrate any prior connection on page load. AppKit's own
 * `enableReconnect` covers most cases; this wrapper exists so existing call
 * sites (`main.js`, `wallet-chip.js`) don't change.
 */
export async function tryAutoReconnect() {
  if (!_wagmiAdapter) {
    // Nothing to reconnect to before AppKit is primed.
    return snapshot();
  }
  ensureWagmiSubscription();
  try {
    await reconnect(_wagmiAdapter.wagmiConfig);
    await syncFromWagmi();
  } catch {
    // No prior session — fine.
  }
  return snapshot();
}

// ─── Public read-only constants for UI ──────────────────────────────────────

export function isOnBase() {
  return state.isConnected && state.chainId === BASE_CHAIN_ID;
}

// ─── Sign helper (used by SIWE on the WC path) ──────────────────────────────

/**
 * Sign `message` via personal_sign with the currently connected wallet.
 * For the WC connector we go through the raw provider (better mobile UX —
 * some WC wallets misrender hex-encoded messages); injected uses wagmi.
 *
 * Kept here (rather than in `siwe.js`) so the connector-vs-provider plumbing
 * stays inside the wallet module.
 *
 * @param {string} message
 * @param {string} address  lowercase 0x address
 */
export async function signMessageWithActive(message, address) {
  if (!state.isConnected) throw new Error('signMessage: wallet not connected');
  if (!_wagmiAdapter) throw new Error('signMessage: wagmi adapter not initialised');
  if (state.connectorId === CONNECTOR_WALLET_CONNECT) {
    const provider = getWalletConnectProvider();
    if (provider && typeof provider.request === 'function') {
      return provider.request({
        method: 'personal_sign',
        params: [message, address],
      });
    }
  }
  return wagmiSignMessage(_wagmiAdapter.wagmiConfig, {
    account: /** @type {`0x${string}`} */ (address),
    message,
  });
}

/**
 * Test-only: reset internal state + listeners. Lives next to the prod API so
 * unit tests don't reach into module internals via brittle ESM tricks.
 */
export function _resetForTests() {
  state = { address: null, chainId: null, isConnected: false, connectorId: null };
  listeners.clear();
  if (_unwatchWagmi) {
    try {
      _unwatchWagmi();
    } catch {
      // ignore
    }
    _unwatchWagmi = null;
  }
  if (_unsubAppKitWallet) {
    try {
      _unsubAppKitWallet();
    } catch {
      // ignore
    }
    _unsubAppKitWallet = null;
  }
  _wagmiAdapter = null;
  _appKit = null;
  _activeProvider = null;
  _wcProjectId = '';
  _syncGen = 0;
}

// Unused helper kept for future pay-flow code that needs a read-only client.
export { createPublicClient };

// Back-compat re-exports — older call sites used these wagmi actions through
// the wallet module. Keeping them avoids touching unrelated files.
export { connect, disconnect, switchChain, getConnections, reconnect };

// Re-export so the bootstrap can register the onSignIn/onSignOut hooks
// against the SAME siwe-config module instance the AppKit modal is bound
// to (vitest's module registry is per-import-path; re-exporting via
// wallet.js keeps `main.js`'s import graph aligned with the AppKit init).
export { setSiweHooks };
