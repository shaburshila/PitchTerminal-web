/**
 * Reown AppKit SIWE configuration.
 *
 * Replaces the hand-rolled `siwe.js` + `ui/signin-modal.js` flow. AppKit now
 * owns the SIWE prompt — after a successful wallet connect the modal stays
 * open and walks the user straight into the signing step, so the user sees a
 * single wallet prompt (Rabby in particular re-asked for "Authorize
 * Application" with our prior 2-step flow because we invoked
 * `wagmi.signMessage` against an already-connected session).
 *
 * Wire-up points:
 *   - Backend endpoints `/auth/nonce` + `/auth/verify` + `/auth/logout` are
 *     reused as-is. The nonce endpoint binds the issued nonce to a specific
 *     address (server security guard), so we read the connected address from
 *     wagmi inside `getNonce` rather than letting AppKit issue an
 *     address-less nonce.
 *   - `getSession` consults `/access` so AppKit can tell whether the user is
 *     already signed in (page reload with a live cookie); if 401 we return
 *     null and AppKit triggers the sign-in flow on next connect.
 *   - `onSignIn` / `onSignOut` reach into the existing pay-banner +
 *     access-store machinery via callbacks supplied by `main.js` at boot.
 */

import { getAccount } from '@wagmi/core';
import { createSIWEConfig, formatMessage } from '@reown/appkit-siwe';

import {
  getAuthNonce,
  verifySiwe,
  getAccess as apiGetAccess,
  getConfig as apiGetConfig,
  logout as apiLogout,
  ApiError,
} from './api.js';
import { set as setAccessState } from './access-store.js';

const SIWE_CHAIN_ID = 8453; // Base mainnet — see project_pitchwc_mainnet_only.md
const SIWE_STATEMENT = 'Sign in to PitchTerminal.';

/**
 * Cached `/config` SIWE block — fetched lazily, reused once.
 *
 * TODO(post-MVP): no TTL/invalidation. If a redeploy mid-session changes
 * `domain` or `uri` we'll keep using stale values until the user reloads.
 * `config-store.js` only tracks on-chain fields (price/discount/referral),
 * not the SIWE meta block, so there's no existing invalidation channel to
 * hook into. Low severity — redeploys are rare and SIWE verify fails
 * loudly on mismatch (the user can retry after a refresh). Revisit if we
 * ever start rotating SIWE domain/uri at runtime.
 */
let _siweMeta = null;

async function loadSiweMeta() {
  if (_siweMeta) return _siweMeta;
  const cfg = await apiGetConfig();
  const siwe = cfg?.siwe;
  if (!siwe || typeof siwe.domain !== 'string' || typeof siwe.uri !== 'string') {
    throw new Error('SIWE config missing from /api/v1/config');
  }
  _siweMeta = { domain: siwe.domain, uri: siwe.uri };
  return _siweMeta;
}

/**
 * Optional callbacks supplied by the bootstrap so it can refresh the pay-banner
 * + access-store after AppKit drives the SIWE round-trip to completion.
 *
 * @typedef {object} SiweHooks
 * @property {(info: { address: string }) => void} [onSignIn]
 * @property {() => void} [onSignOut]
 * @property {() => import('@wagmi/core').Config} getWagmiConfig
 *   Function returning the live wagmi Config. We can't import wallet.js
 *   directly here without creating a circular dep (wallet.js imports this
 *   module for the `createAppKit({ siweConfig })` call), so the bootstrap
 *   passes a thunk.
 */

let _hooks = {
  onSignIn: null,
  onSignOut: null,
  getWagmiConfig: null,
};

/**
 * Wire the bootstrap-provided callbacks. Called by `main.js` (and the mobile
 * bootstrap) before any user-facing connect attempt. Safe to call multiple
 * times — last writer wins.
 *
 * @param {Partial<SiweHooks>} hooks
 */
export function setSiweHooks(hooks) {
  if (!hooks || typeof hooks !== 'object') return;
  if (typeof hooks.onSignIn === 'function') _hooks.onSignIn = hooks.onSignIn;
  if (typeof hooks.onSignOut === 'function') _hooks.onSignOut = hooks.onSignOut;
  if (typeof hooks.getWagmiConfig === 'function') _hooks.getWagmiConfig = hooks.getWagmiConfig;
}

/** Return the currently-connected lowercase address, or throw. */
function currentAddressOrThrow() {
  if (typeof _hooks.getWagmiConfig !== 'function') {
    throw new Error('SIWE: getWagmiConfig hook not wired');
  }
  const cfg = _hooks.getWagmiConfig();
  const acc = getAccount(cfg);
  const addr = acc?.address;
  if (!addr) throw new Error('SIWE: no connected wallet');
  return addr.toLowerCase();
}

/**
 * Build the SIWE config object that gets passed to `createAppKit({ siweConfig })`.
 * Synchronous so `wallet.js` can construct AppKit in one shot without making
 * the wallet bootstrap async (callers like `access.js`/`trade-panel.js`
 * consume `getWagmiConfig()` synchronously).
 */
export function buildSiweConfig() {
  return createSIWEConfig({
    // `getMessageParams` is invoked *before* the user is asked to sign. It
    // must return synchronous-or-async config that AppKit then feeds into
    // `createMessage` along with the connected `address` + freshly fetched
    // `nonce`. We pull domain/uri from `/api/v1/config` so a deploy on a
    // different host doesn't need a code change — the server's SIWE verifier
    // pins these values too, so a mismatch would 401 anyway.
    getMessageParams: async () => {
      const { domain, uri } = await loadSiweMeta();
      return {
        domain,
        uri,
        chains: [SIWE_CHAIN_ID],
        statement: SIWE_STATEMENT,
      };
    },
    // AppKit calls this with the SIWE field bag (domain, uri, address, nonce,
    // chainId, statement, ...). `formatMessage` returns the canonical
    // EIP-4361 message body — the backend matches the same template so the
    // signature verifies on the server side.
    createMessage: ({ address, ...args }) => formatMessage(args, address),
    // Backend binds the nonce to a specific address (security #5). AppKit
    // calls this with the connected `address` as an argument — prefer it
    // over reading wagmi state, because on a fast WalletConnect connect
    // AppKit has the address before `syncFromWagmi`/`getAccount` settles
    // (race observed on mobile). Fall back to live wagmi state for
    // belt-and-braces.
    getNonce: async (address) => {
      const addr =
        typeof address === 'string' && address ? address.toLowerCase() : currentAddressOrThrow();
      const resp = await getAuthNonce(addr);
      const nonce = resp?.nonce;
      if (typeof nonce !== 'string' || !nonce) {
        throw new Error('SIWE: malformed /auth/nonce response');
      }
      return nonce;
    },
    verifyMessage: async ({ message, signature }) => {
      try {
        await verifySiwe(message, signature);
        return true;
      } catch (err) {
        // AppKit treats `false` as "invalid signature" and surfaces a retry
        // option inside its modal. Anything else (network blip, 5xx) is
        // reported the same way — the user can re-tap Sign.
        console.warn('SIWE verifyMessage failed', err);
        return false;
      }
    },
    // AppKit polls this on init to figure out whether a prior session is
    // still alive. If `/access` returns 200 we have a valid `pt_session`
    // cookie — return a fake-but-truthy session object so AppKit treats us as
    // signed in. 401 + everything else → null (AppKit then drives the sign-in
    // flow on next connect attempt).
    getSession: async () => {
      try {
        const a = await apiGetAccess();
        // Returning-user case: cookie is valid but wagmi connector may not
        // have reconnected yet on page load. The `a.address` fallback from
        // /access is LOAD-BEARING here — without it, getSession would return
        // null while wagmi state is empty, AppKit would treat the user as
        // signed-out, and re-prompt SIWE on the next connect. The live wagmi
        // address is used only when /access doesn't surface one (the cookie
        // is opaque to us anyway).
        let cfg = null;
        if (typeof _hooks.getWagmiConfig === 'function') {
          try {
            cfg = _hooks.getWagmiConfig();
          } catch {
            cfg = null;
          }
        }
        const acc = cfg ? getAccount(cfg) : null;
        const address = acc?.address || a?.address || null;
        if (!address) return null;
        return { address, chainId: SIWE_CHAIN_ID };
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        // 5xx / network — pretend no session; better to ask the user to
        // re-sign than to claim an authenticated state we can't prove.
        return null;
      }
    },
    signOut: async () => {
      try {
        await apiLogout();
      } catch {
        /* best-effort — cookie expires naturally either way */
      }
      return true;
    },
    onSignIn: (session) => {
      try {
        if (typeof _hooks.onSignIn === 'function') {
          _hooks.onSignIn({ address: session?.address ?? null });
        }
      } catch (err) {
        console.error('SIWE onSignIn hook threw', err);
      }
    },
    onSignOut: () => {
      try {
        // Synchronously demote any premium UI before the bootstrap hook (if
        // any) runs — same pattern createAccountChangeHandler used to apply
        // on disconnect. Without this an explicit AppKit "Sign Out" leaves
        // the access-store published as 'premium' until the next refresh.
        setAccessState('anon');
        if (typeof _hooks.onSignOut === 'function') {
          _hooks.onSignOut();
        }
      } catch (err) {
        console.error('SIWE onSignOut hook threw', err);
      }
    },
    // When the wallet disconnects, drop the backend session too. Without
    // this an explicit wallet disconnect would leave the orphan cookie in
    // place until the user reconnected the same wallet (covered already by
    // createStaleSessionCleanup, but pruning here is cheaper).
    signOutOnDisconnect: true,
  });
}

/** Test-only reset. */
export function _resetForTests() {
  _siweMeta = null;
  _hooks = { onSignIn: null, onSignOut: null, getWagmiConfig: null };
}
