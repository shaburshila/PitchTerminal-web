/**
 * Referral link handling — F0.12a.
 *
 * On first visit with `?ref=<raw>`:
 *   1. Parse the param (trim + lowercase).
 *   2. If it looks like an Ethereum address (`^0x[a-f0-9]{40}$`) use it verbatim.
 *   3. If it looks like a handle (`^[a-z0-9_-]{4,32}$`) resolve via
 *      `GET /api/v1/ref/{code}` — 200 → write `wallet` to localStorage,
 *      404 → write `referralUnresolved` (for UX/debug).
 *   4. Anything else (e.g. cyrillic, too short/long) — silent ignore (no API
 *      call).
 *
 * The `?ref=` param is NOT stripped from the URL — the visitor may copy the
 * full URL and share it further; downstream visitors must see the ref.
 *
 * `getEffectiveRef(currentWallet, accessContractAddr)` returns the saved
 * referrer with silent-skip rules per docs/contracts.md Model C:
 *   - empty localStorage → `0x0…0`,
 *   - referrer == own wallet → `0x0…0` (self-ref forbidden on-chain),
 *   - referrer == access contract → `0x0…0` (defensive — contract rejects too).
 *
 * Spec: docs/plans/frontend.md §F0.12a.
 */

import { getRef, ApiError } from './api.js';

const STORAGE_WALLET = 'referralWallet';
const STORAGE_RAW = 'referralRaw';
const STORAGE_UNRESOLVED = 'referralUnresolved';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const ADDRESS_RE = /^0x[a-f0-9]{40}$/;
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{2,30}[a-z0-9]$/;

function safeStorage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function safeSet(key, value) {
  const s = safeStorage();
  if (!s) return;
  try {
    s.setItem(key, value);
  } catch {
    /* quota / private-mode — swallow */
  }
}

function safeGet(key) {
  const s = safeStorage();
  if (!s) return null;
  try {
    return s.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Extract `?ref=` from `location.search`, trim + lowercase, or `null`.
 * @returns {string | null}
 */
export function parseRefFromUrl() {
  try {
    if (typeof location === 'undefined' || typeof location.search !== 'string') {
      return null;
    }
    const raw = new URLSearchParams(location.search).get('ref');
    if (raw == null) return null;
    const trimmed = raw.trim().toLowerCase();
    return trimmed || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a raw `?ref=` value to a wallet address.
 *
 * - Address-shaped → returned as-is (already lowercase).
 * - Handle-shaped → fetched from `GET /api/v1/ref/{code}`.
 *   - 200 → returns `wallet` (lowercased defensively).
 *   - 404 → returns `null` and writes `referralUnresolved` to localStorage.
 * - Otherwise → `null` (no API call).
 *
 * Other errors (5xx, network) propagate so the caller can decide. The
 * bootstrap helper below swallows them.
 *
 * @param {string} raw
 * @returns {Promise<string | null>}
 */
export async function resolveRef(raw) {
  if (typeof raw !== 'string') return null;
  if (ADDRESS_RE.test(raw)) return raw;
  if (!HANDLE_RE.test(raw)) return null;
  try {
    const resp = await getRef(raw);
    const wallet = resp?.wallet;
    if (typeof wallet !== 'string') return null;
    return wallet.toLowerCase();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      safeSet(STORAGE_UNRESOLVED, raw);
      return null;
    }
    throw err;
  }
}

/**
 * Bootstrap referral handling. Fire-and-forget — does NOT block render.
 *
 * - No `?ref=` → no-op (keeps any pre-existing localStorage entry intact).
 * - `?ref=` present → resolves async; on success writes both
 *   `referralWallet` and `referralRaw` (last wins — visiting with a fresh ref
 *   overrides a previous one).
 *
 * @returns {Promise<void>}
 */
export async function bootstrapReferral() {
  const raw = parseRefFromUrl();
  if (raw == null) return;
  try {
    const wallet = await resolveRef(raw);
    if (!wallet) return;
    safeSet(STORAGE_WALLET, wallet);
    safeSet(STORAGE_RAW, raw);
  } catch {
    // Network/5xx — swallow. User may revisit with the same link later.
  }
}

/**
 * Effective on-chain referrer to pass to `buyAccess(referrer)`.
 *
 * Silent-skip rules (return `0x0…0` instead of throwing) match the on-chain
 * contract's invariants — invalid referrers would just revert the tx, so the
 * pay-flow degrades to a no-referrer purchase.
 *
 * @param {string|null|undefined} currentWallet     Connected wallet address.
 * @param {string|null|undefined} accessContractAddr  PitchTerminalAccess address.
 * @returns {string} Lowercase 0x address, or `0x0…0`.
 */
export function getEffectiveRef(currentWallet, accessContractAddr) {
  const stored = safeGet(STORAGE_WALLET);
  if (!stored || typeof stored !== 'string') return ZERO_ADDRESS;
  const saved = stored.toLowerCase();
  if (!ADDRESS_RE.test(saved)) return ZERO_ADDRESS;
  if (typeof currentWallet === 'string' && currentWallet.toLowerCase() === saved) {
    return ZERO_ADDRESS;
  }
  if (typeof accessContractAddr === 'string' && accessContractAddr.toLowerCase() === saved) {
    return ZERO_ADDRESS;
  }
  return saved;
}

/** Test-only helper — wipes both localStorage keys + cached state. */
export function _resetForTests() {
  const s = safeStorage();
  if (!s) return;
  try {
    s.removeItem(STORAGE_WALLET);
    s.removeItem(STORAGE_RAW);
    s.removeItem(STORAGE_UNRESOLVED);
  } catch {
    /* ignore */
  }
}
