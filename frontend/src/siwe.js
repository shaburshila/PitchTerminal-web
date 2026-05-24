/**
 * SIWE (Sign-In With Ethereum) flow — F0.11.
 *
 * After the wallet is connected (see `wallet.js`) we authenticate the user to
 * the backend by signing an EIP-4361 message and POSTing it to
 * `/api/v1/auth/verify`; the server sets the httpOnly `pt_session` cookie and
 * we never touch the JWT directly. Premium status thereafter comes from
 * `getAccess()`.
 *
 * Public API:
 *   - `buildSiweMessage({ domain, uri, address, chainId, nonce, issuedAt, expirationTime })`
 *     Pure helper — returns the exact §2.2 api-spec template body. Exposed so
 *     tests can assert byte-for-byte equality and the pay-flow could reuse it.
 *   - `signIn(opts?)`:
 *     1. Read `siwe.domain` + `siwe.uri` from `/api/v1/config` (cached one call
 *        for the lifetime of the module — same-origin same-domain values).
 *     2. `GET /auth/nonce`.
 *     3. Build the message with the connected address checksummed via
 *        `viem.getAddress` (server rejects lowercase per spec §1.2 + §2.2).
 *     4. Ask the wallet to sign — wagmi's `signMessage` for injected,
 *        `personal_sign` JSON-RPC for WalletConnect (which doesn't go through
 *        a wagmi connector here).
 *     5. `POST /auth/verify { message, signature }` — server returns
 *        `{address}` and sets the cookie.
 *   - `ensureSignedIn(opts?)`:
 *     Call after connect. Probes `getAccess()`; on 200 → skip. On 401 →
 *     triggers `signIn`. Returns whether the user is now authenticated.
 *
 * Disconnect logout: the backend has `POST /auth/logout` (api-spec §2.3) but
 * UI-wise we only call it on explicit logout — see `wallet-chip.js` callers.
 *
 * EIP-1271 smart-contract wallets: the client side is identical. The wallet
 * just returns a non-65-byte signature; we forward it verbatim. Server
 * (`shared/siwe.py`) checks ECDSA first, falls back to EIP-1271 on-chain.
 */

import { getAddress } from 'viem';
import { signMessage as wagmiSignMessage } from '@wagmi/core';

import { getAuthNonce, verifySiwe, getAccess, getConfig, ApiError } from './api.js';
import {
  getAccount,
  getWagmiConfig,
  getWalletConnectProvider,
  CONNECTOR_WALLET_CONNECT,
} from './wallet.js';

export const SIWE_VERSION = '1';
export const SIWE_CHAIN_ID = 8453; // Base mainnet — see project_pitchwc_mainnet_only.md
export const SIWE_STATEMENT = 'Sign in to PitchTerminal.';

/** Cached `/config` SIWE block — fetched lazily, reused for subsequent signIns. */
let _siweConfig = null;

/**
 * Build the SIWE message per api-spec §2.2 template. Whitespace and order are
 * load-bearing — the server compares against this template position by
 * position. Do not reorder lines or change punctuation.
 *
 * @param {object} p
 * @param {string} p.domain    e.g. 'pitchterminal.app'
 * @param {string} p.uri       e.g. 'https://pitchterminal.app'
 * @param {string} p.address   EIP-55 checksum address (will be re-checksummed
 *                             defensively in case the caller passed lowercase)
 * @param {number|string} p.chainId
 * @param {string} p.nonce
 * @param {string|number|Date} p.issuedAt
 * @param {string|number|Date} p.expirationTime
 * @returns {string}
 */
export function buildSiweMessage({
  domain,
  uri,
  address,
  chainId,
  nonce,
  issuedAt,
  expirationTime,
}) {
  if (!domain || typeof domain !== 'string') {
    throw new Error('buildSiweMessage: domain is required');
  }
  if (!uri || typeof uri !== 'string') {
    throw new Error('buildSiweMessage: uri is required');
  }
  if (!address || typeof address !== 'string') {
    throw new Error('buildSiweMessage: address is required');
  }
  if (!nonce || typeof nonce !== 'string') {
    throw new Error('buildSiweMessage: nonce is required');
  }
  // Defensive — caller is expected to pass already-checksummed, but doing it
  // again is cheap and guards against lowercase addresses reaching the server.
  const checksumAddress = getAddress(address);
  const issuedAtIso = toIsoUtc(issuedAt);
  const expirationIso = toIsoUtc(expirationTime);

  return (
    `${domain} wants you to sign in with your Ethereum account:\n` +
    `${checksumAddress}\n` +
    `\n` +
    `${SIWE_STATEMENT}\n` +
    `\n` +
    `URI: ${uri}\n` +
    `Version: ${SIWE_VERSION}\n` +
    `Chain ID: ${chainId}\n` +
    `Nonce: ${nonce}\n` +
    `Issued At: ${issuedAtIso}\n` +
    `Expiration Time: ${expirationIso}`
  );
}

/**
 * Convert various inputs to ISO-8601 UTC with seconds precision (`...Z`).
 * Accepts: number (unix seconds OR ms), Date, ISO string.
 */
function toIsoUtc(value) {
  if (value instanceof Date) return trimMillis(value.toISOString());
  if (typeof value === 'number') {
    // Treat values < 1e12 as seconds (post-2001 timestamps in seconds are < 4e9).
    const ms = value < 1e12 ? value * 1000 : value;
    return trimMillis(new Date(ms).toISOString());
  }
  if (typeof value === 'string') {
    // Trust ISO strings; if not a Date-parsable string, fall through and let
    // the server complain.
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return trimMillis(d.toISOString());
    return value;
  }
  throw new Error('toIsoUtc: unsupported value');
}

/** `2026-05-23T12:00:00.000Z` → `2026-05-23T12:00:00Z`. */
function trimMillis(iso) {
  return iso.replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Ask the connected wallet to sign `message` via personal_sign semantics.
 * Returns the 0x-prefixed signature. Throws on user rejection (the wallet's
 * native error bubbles up — surface it to the UI as-is).
 *
 * @param {string} message
 * @param {string} address  lowercase 0x address of the signer
 */
export async function signMessageWithWallet(message, address) {
  const account = getAccount();
  if (!account.isConnected || !account.address) {
    throw new Error('signMessageWithWallet: wallet not connected');
  }
  if (account.connectorId === CONNECTOR_WALLET_CONNECT) {
    const provider = getWalletConnectProvider();
    if (!provider) {
      throw new Error('signMessageWithWallet: WalletConnect provider missing');
    }
    // EIP-191 personal_sign — params order is `[message, address]`. WC clients
    // expect a UTF-8 string or hex; sending the raw string is the documented
    // path used by viem's `signMessage` internally.
    return provider.request({
      method: 'personal_sign',
      params: [message, address],
    });
  }
  // Injected (MetaMask, Coinbase wallet extension, Rabby…) — wagmi handles
  // the JSON-RPC plumbing and returns a 0x-signature.
  return wagmiSignMessage(getWagmiConfig(), {
    account: /** @type {`0x${string}`} */ (address),
    message,
  });
}

/**
 * Fetch the SIWE config from `/api/v1/config` once per page-load. The values
 * (`domain`, `uri`) don't change at runtime — they are wired to the host
 * deployment and validated against `Domain`/`URI` lines on the server.
 */
async function loadSiweConfig() {
  if (_siweConfig) return _siweConfig;
  const cfg = await getConfig();
  const siwe = cfg?.siwe;
  if (!siwe || typeof siwe.domain !== 'string' || typeof siwe.uri !== 'string') {
    throw new Error('SIWE config missing from /api/v1/config');
  }
  _siweConfig = { domain: siwe.domain, uri: siwe.uri };
  return _siweConfig;
}

/**
 * Full SIWE flow. Returns `{ address }` on success, throws on failure.
 *
 * Common failure modes:
 *   - User rejects in wallet → wallet-specific error from the provider.
 *   - Nonce expired / replayed → `ApiError` status 401, code
 *     `auth.siwe.invalid_nonce`.
 *   - Bad signature → `ApiError` status 401, code `auth.siwe.invalid_signature`.
 *
 * @param {{ address?: string }} [opts]
 *   `address` — override the address used (must match the currently connected
 *   wallet; mostly useful for tests). Defaults to `getAccount().address`.
 * @returns {Promise<{ address: string }>}
 */
export async function signIn(opts = {}) {
  const account = getAccount();
  const rawAddress = opts.address || account.address;
  if (!rawAddress) {
    throw new Error('signIn: no connected wallet');
  }

  const checksumAddress = getAddress(rawAddress);
  const [{ domain, uri }, nonceResp] = await Promise.all([loadSiweConfig(), getAuthNonce()]);

  const nonce = nonceResp?.nonce;
  const issuedAtSec = Number(nonceResp?.issuedAt);
  const expiresAtSec = Number(nonceResp?.expiresAt);
  if (!nonce || !Number.isFinite(issuedAtSec) || !Number.isFinite(expiresAtSec)) {
    throw new Error('signIn: malformed /auth/nonce response');
  }

  const message = buildSiweMessage({
    domain,
    uri,
    address: checksumAddress,
    chainId: SIWE_CHAIN_ID,
    nonce,
    issuedAt: issuedAtSec,
    expirationTime: expiresAtSec,
  });

  // The wallet's address parameter to `personal_sign` is matched against the
  // signer the wallet has unlocked; lowercase is the canonical form used by
  // both MetaMask and WalletConnect. (The address inside the *message body*
  // is checksummed — that's a separate concern, validated by the server.)
  const signature = await signMessageWithWallet(message, rawAddress.toLowerCase());

  const resp = await verifySiwe(message, signature);
  return { address: resp?.address || checksumAddress.toLowerCase() };
}

/**
 * If the user already has a valid session cookie, do nothing; otherwise run
 * the SIWE flow. Returns `true` if the user is authenticated at exit, `false`
 * if the SIWE attempt was cancelled or failed.
 *
 * This is what UI callers should invoke right after a successful `connect` —
 * not `signIn` directly — to avoid prompting MetaMask on every page reload
 * for users whose cookie is still valid.
 *
 * @param {{ address?: string, onSignInError?: (err: unknown) => void }} [opts]
 * @returns {Promise<boolean>}
 */
export async function ensureSignedIn(opts = {}) {
  try {
    await getAccess();
    // 200 — cookie is valid, nothing to do.
    return true;
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) {
      // Either 5xx or unexpected — let caller decide; don't auto-prompt.
      if (typeof opts.onSignInError === 'function') opts.onSignInError(err);
      return false;
    }
    // Fall through to signIn.
  }
  try {
    await signIn(opts);
    return true;
  } catch (err) {
    if (typeof opts.onSignInError === 'function') opts.onSignInError(err);
    return false;
  }
}

/** Test-only reset. */
export function _resetForTests() {
  _siweConfig = null;
}
