// Pure unit tests for the central error classifier. No DOM required — the
// module under test imports no UI (that's the whole point of lib/errors.js).

import { describe, expect, it } from 'vitest';

import { isUserRejected, describeError, categorizeError } from '../src/lib/errors.js';
import { ApiError } from '../src/api.js';

describe('isUserRejected', () => {
  it('matches EIP-1193 code 4001', () => {
    expect(isUserRejected({ code: 4001 })).toBe(true);
  });

  it('matches a rejection nested under cause', () => {
    expect(isUserRejected({ message: 'x', cause: { code: 4001 } })).toBe(true);
  });

  it('matches viem UserRejectedRequestError by name', () => {
    expect(isUserRejected({ name: 'UserRejectedRequestError', message: 'nope' })).toBe(true);
  });

  it('matches textual "user rejected" / "user denied"', () => {
    expect(isUserRejected({ message: 'User rejected the request' })).toBe(true);
    expect(isUserRejected({ shortMessage: 'User denied transaction signature' })).toBe(true);
  });

  it('is false for unrelated errors and non-objects', () => {
    expect(isUserRejected(new Error('boom'))).toBe(false);
    expect(isUserRejected(null)).toBe(false);
    expect(isUserRejected('user rejected')).toBe(false); // strings aren't sniffed here
    expect(isUserRejected({ code: 5000 })).toBe(false);
  });
});

describe('describeError', () => {
  it('prefers viem shortMessage', () => {
    expect(describeError({ shortMessage: 'Insufficient funds', message: 'long blob' })).toBe(
      'Insufficient funds',
    );
  });

  it('falls back to message then to the fallback', () => {
    expect(describeError({ message: 'plain' })).toBe('plain');
    expect(describeError({}, 'fb')).toBe('fb');
    expect(describeError(null, 'fb')).toBe('fb');
  });

  it('passes strings through', () => {
    expect(describeError('already a string', 'fb')).toBe('already a string');
  });
});

describe('categorizeError', () => {
  it('classifies user-rejected as silent', () => {
    const r = categorizeError({ code: 4001 });
    expect(r.category).toBe('user-rejected');
    expect(r.silent).toBe(true);
  });

  it('classifies ApiError 401 as backend → sign-in prompt', () => {
    const r = categorizeError(new ApiError({ status: 401, code: 'auth.unauthenticated' }));
    expect(r.category).toBe('backend');
    expect(r.silent).toBe(false);
    expect(r.message).toBe('Please sign in to continue.');
  });

  it('classifies ApiError 402 as backend → premium', () => {
    const r = categorizeError(new ApiError({ status: 402, code: 'access.payment_required' }));
    expect(r.category).toBe('backend');
    expect(r.message).toMatch(/premium/i);
  });

  it('classifies ApiError 429 as backend → rate limit', () => {
    const r = categorizeError(new ApiError({ status: 429 }));
    expect(r.category).toBe('backend');
    expect(r.message).toMatch(/too many requests/i);
  });

  it('classifies ApiError 503 / 5xx as backend → temporarily unavailable', () => {
    expect(categorizeError(new ApiError({ status: 503 })).message).toMatch(/temporarily/i);
    expect(categorizeError(new ApiError({ status: 500 })).message).toMatch(/temporarily/i);
  });

  it('shows the server title for an unmapped 4xx', () => {
    const r = categorizeError(new ApiError({ status: 409, title: 'referral.taken' }));
    expect(r.category).toBe('backend');
    expect(r.message).toBe('referral.taken');
  });

  it('detects ApiError by duck-typing (no instanceof needed)', () => {
    const r = categorizeError({ name: 'ApiError', status: 401 });
    expect(r.category).toBe('backend');
    expect(r.message).toBe('Please sign in to continue.');
  });

  it('classifies network failures as rpc', () => {
    expect(categorizeError(new TypeError('Failed to fetch')).category).toBe('rpc');
    expect(categorizeError({ name: 'HttpRequestError', message: 'x' }).category).toBe('rpc');
    expect(categorizeError({ name: 'TimeoutError', message: 'timed out' }).category).toBe('rpc');
    expect(categorizeError({ message: 'connection refused' }).category).toBe('rpc');
    const r = categorizeError({ message: 'network error' });
    expect(r.category).toBe('rpc');
    expect(r.message).toMatch(/network\/rpc/i);
  });

  it('prefers backend over rpc for an HTTP 5xx ApiError', () => {
    // An ApiError carries no network signature, but guard the ordering anyway.
    const r = categorizeError(new ApiError({ status: 503 }));
    expect(r.category).toBe('backend');
  });

  it('classifies wallet/contract errors via shortMessage', () => {
    const r = categorizeError({ shortMessage: 'Insufficient allowance' });
    expect(r.category).toBe('wallet');
    expect(r.message).toBe('Insufficient allowance');
  });

  it('falls back to unknown with the fallback message', () => {
    const r = categorizeError({}, 'Custom fallback');
    expect(r.category).toBe('unknown');
    expect(r.message).toBe('Custom fallback');
    expect(r.silent).toBe(false);
  });
});
