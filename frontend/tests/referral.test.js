// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks (declared BEFORE SUT import) ─────────────────────────────────────

const apiState = {
  /** Per-test handler for getRef — returns object or throws ApiError. */
  getRefImpl: null,
  calls: [],
};

vi.mock('../src/api.js', async () => {
  // Recreate ApiError class to match the real export shape.
  class ApiError extends Error {
    constructor({ code, status, title, detail, message }) {
      super(message || title || detail || code || `HTTP ${status}`);
      this.name = 'ApiError';
      this.code = code;
      this.status = status;
      this.title = title;
      this.detail = detail;
    }
  }
  return {
    ApiError,
    getRef: vi.fn(async (code) => {
      apiState.calls.push(code);
      if (apiState.getRefImpl) return apiState.getRefImpl(code);
      throw new ApiError({ code: 'referral.not_found', status: 404 });
    }),
  };
});

// Import AFTER mock.
const {
  parseRefFromUrl,
  resolveRef,
  bootstrapReferral,
  getEffectiveRef,
  _resetForTests,
} = await import('../src/referral.js');

const ZERO = '0x0000000000000000000000000000000000000000';

/** Replace location.search with the provided query string (incl. leading "?"). */
function setQuery(query) {
  // happy-dom's location is writable via history.replaceState.
  history.replaceState(null, '', '/' + (query || ''));
}

beforeEach(() => {
  localStorage.clear();
  apiState.getRefImpl = null;
  apiState.calls = [];
  setQuery('');
  _resetForTests();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── parseRefFromUrl ────────────────────────────────────────────────────────

describe('parseRefFromUrl', () => {
  it('returns null when ?ref is absent', () => {
    setQuery('');
    expect(parseRefFromUrl()).toBeNull();
  });

  it('returns null when ?ref is empty', () => {
    setQuery('?ref=');
    expect(parseRefFromUrl()).toBeNull();
  });

  it('trims and lowercases the value', () => {
    setQuery('?ref=%20ALEX42%20');
    expect(parseRefFromUrl()).toBe('alex42');
  });

  it('preserves address shape (just lowercased)', () => {
    setQuery('?ref=0xABCDEF0123456789012345678901234567890123');
    expect(parseRefFromUrl()).toBe('0xabcdef0123456789012345678901234567890123');
  });
});

// ─── resolveRef ─────────────────────────────────────────────────────────────

describe('resolveRef', () => {
  it('returns address verbatim for valid 40-char hex (no API call)', async () => {
    const addr = '0xabcdef0123456789012345678901234567890123';
    const out = await resolveRef(addr);
    expect(out).toBe(addr);
    expect(apiState.calls).toHaveLength(0);
  });

  it('calls /api/v1/ref/{code} for handle-shaped input and returns lowercased wallet', async () => {
    apiState.getRefImpl = (code) => ({
      code,
      wallet: '0x71ECD1a09380cA46CcA741Bc48d04C556674756F',
    });
    const out = await resolveRef('alex42');
    expect(apiState.calls).toEqual(['alex42']);
    expect(out).toBe('0x71ecd1a09380ca46cca741bc48d04c556674756f');
  });

  it('returns null on 404 and writes referralUnresolved', async () => {
    // default impl throws 404
    const out = await resolveRef('alex42');
    expect(out).toBeNull();
    expect(localStorage.getItem('referralUnresolved')).toBe('alex42');
  });

  it('returns null for cyrillic / invalid-format input (no API call)', async () => {
    const out = await resolveRef('невалидное');
    expect(out).toBeNull();
    expect(apiState.calls).toHaveLength(0);
  });

  it('returns null for too-short handle (no API call)', async () => {
    const out = await resolveRef('abc');
    expect(out).toBeNull();
    expect(apiState.calls).toHaveLength(0);
  });

  it('returns null for too-long handle (no API call)', async () => {
    const out = await resolveRef('a'.repeat(33));
    expect(out).toBeNull();
    expect(apiState.calls).toHaveLength(0);
  });

  it('propagates non-404 ApiError (caller decides)', async () => {
    const { ApiError } = await import('../src/api.js');
    apiState.getRefImpl = () => {
      throw new ApiError({ code: 'server.error', status: 500 });
    };
    await expect(resolveRef('alex42')).rejects.toBeInstanceOf(ApiError);
  });
});

// ─── bootstrapReferral ──────────────────────────────────────────────────────

describe('bootstrapReferral', () => {
  it('writes referralWallet + referralRaw for address-shaped ref', async () => {
    setQuery('?ref=0xABCDEF0123456789012345678901234567890123');
    await bootstrapReferral();
    expect(localStorage.getItem('referralWallet')).toBe(
      '0xabcdef0123456789012345678901234567890123',
    );
    expect(localStorage.getItem('referralRaw')).toBe(
      '0xabcdef0123456789012345678901234567890123',
    );
  });

  it('writes resolved wallet for handle-shaped ref (200)', async () => {
    apiState.getRefImpl = () => ({
      code: 'alex42',
      wallet: '0x71ECD1a09380cA46CcA741Bc48d04C556674756F',
    });
    setQuery('?ref=alex42');
    await bootstrapReferral();
    expect(localStorage.getItem('referralWallet')).toBe(
      '0x71ecd1a09380ca46cca741bc48d04c556674756f',
    );
    expect(localStorage.getItem('referralRaw')).toBe('alex42');
  });

  it('does NOT write referralWallet on 404 but stores referralUnresolved', async () => {
    setQuery('?ref=unknown');
    // default impl throws 404
    await bootstrapReferral();
    expect(localStorage.getItem('referralWallet')).toBeNull();
    expect(localStorage.getItem('referralUnresolved')).toBe('unknown');
  });

  it('silent-ignores cyrillic ?ref= (regex fail, no API call)', async () => {
    setQuery('?ref=' + encodeURIComponent('Невалидное'));
    await bootstrapReferral();
    expect(localStorage.getItem('referralWallet')).toBeNull();
    expect(localStorage.getItem('referralUnresolved')).toBeNull();
    expect(apiState.calls).toHaveLength(0);
  });

  it('no-op when ?ref is absent — does not touch localStorage', async () => {
    setQuery('');
    localStorage.setItem('referralWallet', '0xpreserved');
    await bootstrapReferral();
    expect(localStorage.getItem('referralWallet')).toBe('0xpreserved');
    expect(apiState.calls).toHaveLength(0);
  });

  it('last-wins: second visit with a different ?ref= overwrites the first', async () => {
    setQuery('?ref=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    await bootstrapReferral();
    expect(localStorage.getItem('referralWallet')).toBe(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    setQuery('?ref=0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    await bootstrapReferral();
    expect(localStorage.getItem('referralWallet')).toBe(
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
  });

  it('swallows non-404 errors (no throw)', async () => {
    const { ApiError } = await import('../src/api.js');
    apiState.getRefImpl = () => {
      throw new ApiError({ code: 'server.error', status: 500 });
    };
    setQuery('?ref=alex42');
    await expect(bootstrapReferral()).resolves.toBeUndefined();
    expect(localStorage.getItem('referralWallet')).toBeNull();
  });
});

// ─── getEffectiveRef ────────────────────────────────────────────────────────

describe('getEffectiveRef', () => {
  const REF = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const CONTRACT = '0xcccccccccccccccccccccccccccccccccccccccc';
  const SELF = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  it('returns ZERO when localStorage is empty', () => {
    expect(getEffectiveRef('0x71ecd1a09380ca46cca741bc48d04c556674756f', CONTRACT)).toBe(ZERO);
  });

  it('returns ZERO when saved ref == own wallet (self-ref, case-insensitive)', () => {
    localStorage.setItem('referralWallet', REF);
    expect(getEffectiveRef(SELF.toUpperCase(), CONTRACT)).toBe(ZERO);
  });

  it('returns ZERO when saved ref == access contract (case-insensitive)', () => {
    localStorage.setItem('referralWallet', CONTRACT);
    expect(
      getEffectiveRef('0x71ecd1a09380ca46cca741bc48d04c556674756f', CONTRACT.toUpperCase()),
    ).toBe(ZERO);
  });

  it('returns the saved address (lowercased) for the happy path', () => {
    localStorage.setItem('referralWallet', REF.toUpperCase());
    expect(getEffectiveRef('0x71ecd1a09380ca46cca741bc48d04c556674756f', CONTRACT)).toBe(REF);
  });

  it('returns ZERO when saved value is not an address-shaped string', () => {
    localStorage.setItem('referralWallet', 'not-an-address');
    expect(getEffectiveRef('0x71ecd1a09380ca46cca741bc48d04c556674756f', CONTRACT)).toBe(ZERO);
  });
});
