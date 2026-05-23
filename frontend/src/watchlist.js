/**
 * Watchlist: localStorage-backed set of favourite token addresses.
 *
 * Spec: docs/conventions.md §6 — key `pt:watchlist`, payload
 * `{ tokens: ["0x...", ...] }`. Hard cap 50 (UI shows toast on overflow).
 *
 * All addresses are stored lowercase (canonical form, see conventions §4.1).
 * Callers may pass any case — module normalises on read & write.
 *
 * Public API:
 *   getWatchlist(): string[]                 — ordered list (insertion order).
 *   isWatched(addr): boolean
 *   toggle(addr): { added: boolean, full: boolean, list: string[] }
 *   add(addr):    { added: boolean, full: boolean, list: string[] }
 *   remove(addr): { removed: boolean, list: string[] }
 *   clear(): void
 *   onChange(listener): unsubscribe fn
 *
 * Storage failures (Safari private mode, quota, etc.) are caught — module
 * degrades to an in-memory shadow so the UI stays functional for the session.
 */

const STORAGE_KEY = 'pt:watchlist';
export const WATCHLIST_LIMIT = 50;

/** Lowercased addresses, ordered by insertion. */
let cache = null;
/** @type {Set<(list: string[]) => void>} */
const listeners = new Set();

function safeStorage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function normaliseAddr(addr) {
  if (typeof addr !== 'string') return null;
  const trimmed = addr.trim().toLowerCase();
  if (!trimmed) return null;
  // Loose check — accept anything starting with 0x. Stricter validation is
  // not the watchlist's job (tokens come from the API).
  if (!trimmed.startsWith('0x')) return null;
  return trimmed;
}

function load() {
  if (cache !== null) return cache;
  const storage = safeStorage();
  if (!storage) {
    cache = [];
    return cache;
  }
  let raw;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    cache = [];
    return cache;
  }
  if (!raw) {
    cache = [];
    return cache;
  }
  try {
    const parsed = JSON.parse(raw);
    const tokens = Array.isArray(parsed?.tokens) ? parsed.tokens : [];
    const seen = new Set();
    const out = [];
    for (const t of tokens) {
      const a = normaliseAddr(t);
      if (a && !seen.has(a)) {
        seen.add(a);
        out.push(a);
        if (out.length >= WATCHLIST_LIMIT) break;
      }
    }
    cache = out;
  } catch {
    cache = [];
  }
  return cache;
}

function persist() {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ tokens: cache }));
  } catch {
    // Quota / private-mode — swallow. In-memory state remains accurate.
  }
}

function notify() {
  // Snapshot list to protect against listener mutation during iteration.
  const snapshot = cache ? cache.slice() : [];
  for (const fn of listeners) {
    try {
      fn(snapshot);
    } catch {
      // Don't let one bad listener kill the rest.
    }
  }
}

/** @returns {string[]} */
export function getWatchlist() {
  return load().slice();
}

/** @param {string} addr */
export function isWatched(addr) {
  const a = normaliseAddr(addr);
  if (!a) return false;
  return load().includes(a);
}

/**
 * Add an address. No-op if already present or invalid; returns full=true
 * when the list is at capacity and the address wasn't already in it.
 * @param {string} addr
 */
export function add(addr) {
  const a = normaliseAddr(addr);
  if (!a) return { added: false, full: false, list: getWatchlist() };
  const list = load();
  if (list.includes(a)) return { added: false, full: list.length >= WATCHLIST_LIMIT, list: list.slice() };
  if (list.length >= WATCHLIST_LIMIT) {
    return { added: false, full: true, list: list.slice() };
  }
  list.push(a);
  persist();
  notify();
  return { added: true, full: list.length >= WATCHLIST_LIMIT, list: list.slice() };
}

/** @param {string} addr */
export function remove(addr) {
  const a = normaliseAddr(addr);
  if (!a) return { removed: false, list: getWatchlist() };
  const list = load();
  const idx = list.indexOf(a);
  if (idx === -1) return { removed: false, list: list.slice() };
  list.splice(idx, 1);
  persist();
  notify();
  return { removed: true, list: list.slice() };
}

/**
 * Toggle membership.
 * @param {string} addr
 * @returns {{ added: boolean, full: boolean, list: string[] }}
 *   `added=true` when newly inserted, `added=false` when removed (or
 *   blocked by full+invalid). `full=true` means the add was rejected
 *   because capacity was reached.
 */
export function toggle(addr) {
  if (isWatched(addr)) {
    const r = remove(addr);
    return { added: false, full: false, list: r.list };
  }
  return add(addr);
}

export function clear() {
  if (cache !== null && cache.length === 0) return;
  cache = [];
  persist();
  notify();
}

/**
 * Subscribe to watchlist changes. Listener receives a snapshot of the
 * current list every time it mutates. Returns an unsubscribe function.
 * @param {(list: string[]) => void} listener
 */
export function onChange(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Test-only: drop the in-memory cache so the next read re-loads from
 * localStorage. Not exported through `index` but available for tests that
 * mutate `localStorage` directly between cases.
 */
export function _resetForTests() {
  cache = null;
  listeners.clear();
}
