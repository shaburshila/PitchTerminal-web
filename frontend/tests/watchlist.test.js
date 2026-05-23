// @vitest-environment happy-dom

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getWatchlist,
  isWatched,
  toggle,
  add,
  remove,
  clear,
  onChange,
  WATCHLIST_LIMIT,
  _resetForTests,
} from '../src/watchlist.js';

const STORAGE_KEY = 'pt:watchlist';

beforeEach(() => {
  localStorage.clear();
  _resetForTests();
});

describe('watchlist', () => {
  it('starts empty', () => {
    expect(getWatchlist()).toEqual([]);
  });

  it('add() inserts a lowercased address', () => {
    const r = add('0xABCDEF0123456789012345678901234567890123');
    expect(r.added).toBe(true);
    expect(r.full).toBe(false);
    expect(getWatchlist()).toEqual(['0xabcdef0123456789012345678901234567890123']);
    expect(isWatched('0xAbCdEf0123456789012345678901234567890123')).toBe(true);
  });

  it('add() rejects invalid input gracefully', () => {
    expect(add(null).added).toBe(false);
    expect(add(undefined).added).toBe(false);
    expect(add('').added).toBe(false);
    expect(add('not-an-address').added).toBe(false);
    expect(add(42).added).toBe(false);
    expect(getWatchlist()).toEqual([]);
  });

  it('add() is a no-op for duplicates', () => {
    add('0xaaaa000000000000000000000000000000000001');
    const second = add('0xAAAA000000000000000000000000000000000001');
    expect(second.added).toBe(false);
    expect(getWatchlist().length).toBe(1);
  });

  it('remove() drops the entry', () => {
    add('0xbbbb000000000000000000000000000000000002');
    const r = remove('0xBBBB000000000000000000000000000000000002');
    expect(r.removed).toBe(true);
    expect(getWatchlist()).toEqual([]);
  });

  it('toggle() adds when absent and removes when present', () => {
    const addr = '0xcccc000000000000000000000000000000000003';
    const r1 = toggle(addr);
    expect(r1.added).toBe(true);
    expect(isWatched(addr)).toBe(true);

    const r2 = toggle(addr);
    expect(r2.added).toBe(false);
    expect(r2.full).toBe(false);
    expect(isWatched(addr)).toBe(false);
  });

  it('honours the 50-token limit', () => {
    for (let i = 0; i < WATCHLIST_LIMIT; i++) {
      const addr = '0x' + i.toString(16).padStart(40, '0');
      const r = add(addr);
      expect(r.added).toBe(true);
    }
    expect(getWatchlist().length).toBe(WATCHLIST_LIMIT);

    const overflow = add('0x' + 'f'.repeat(40));
    expect(overflow.added).toBe(false);
    expect(overflow.full).toBe(true);
    expect(getWatchlist().length).toBe(WATCHLIST_LIMIT);
  });

  it('toggle() at-limit on a NEW entry signals full', () => {
    for (let i = 0; i < WATCHLIST_LIMIT; i++) {
      add('0x' + i.toString(16).padStart(40, '0'));
    }
    const r = toggle('0x' + 'a'.repeat(40));
    expect(r.added).toBe(false);
    expect(r.full).toBe(true);
  });

  it('toggle() at-limit on an EXISTING entry removes it (full=false)', () => {
    for (let i = 0; i < WATCHLIST_LIMIT; i++) {
      add('0x' + i.toString(16).padStart(40, '0'));
    }
    const existing = '0x' + (0).toString(16).padStart(40, '0');
    const r = toggle(existing);
    expect(r.added).toBe(false);
    expect(r.full).toBe(false);
    expect(getWatchlist().length).toBe(WATCHLIST_LIMIT - 1);
  });

  it('persists to localStorage across module re-loads (simulated)', () => {
    add('0xdddd000000000000000000000000000000000004');
    // Inspect raw storage and verify shape.
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw);
    expect(parsed.tokens).toEqual(['0xdddd000000000000000000000000000000000004']);

    // Reset module cache to simulate a fresh page load.
    _resetForTests();
    expect(getWatchlist()).toEqual(['0xdddd000000000000000000000000000000000004']);
    expect(isWatched('0xDDDD000000000000000000000000000000000004')).toBe(true);
  });

  it('loads gracefully when localStorage holds corrupt JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not-json');
    _resetForTests();
    expect(getWatchlist()).toEqual([]);
  });

  it('truncates stored list to WATCHLIST_LIMIT on load', () => {
    const tokens = [];
    for (let i = 0; i < WATCHLIST_LIMIT + 5; i++) {
      tokens.push('0x' + i.toString(16).padStart(40, '0'));
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tokens }));
    _resetForTests();
    expect(getWatchlist().length).toBe(WATCHLIST_LIMIT);
  });

  it('clear() empties the list and persists', () => {
    add('0xeeee000000000000000000000000000000000005');
    clear();
    expect(getWatchlist()).toEqual([]);
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(JSON.parse(raw).tokens).toEqual([]);
  });

  it('onChange() fires on mutations and stops after unsubscribe', () => {
    const calls = [];
    const unsubscribe = onChange((list) => calls.push(list.slice()));
    add('0xa000000000000000000000000000000000000001');
    add('0xa000000000000000000000000000000000000002');
    expect(calls.length).toBe(2);
    expect(calls[1].length).toBe(2);

    unsubscribe();
    add('0xa000000000000000000000000000000000000003');
    expect(calls.length).toBe(2);
  });

  it('onChange() ignores non-function input', () => {
    expect(() => onChange(null)).not.toThrow();
    expect(() => onChange(42)).not.toThrow();
  });

  it('getWatchlist() returns a copy (mutation is safe)', () => {
    add('0xa000000000000000000000000000000000000010');
    const list = getWatchlist();
    list.push('0xfake');
    expect(getWatchlist().length).toBe(1);
  });
});
