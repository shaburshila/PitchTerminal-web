// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountProfileReferral } from '../src/profile-referral.js';

// Lightweight ApiError stand-in matching the shape mountProfileReferral checks.
class ApiError extends Error {
  constructor({ code, status, title, detail }) {
    super(title || detail || code || `HTTP ${status}`);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.title = title;
    this.detail = detail;
  }
}

function makeApi({ refMe, putImpl, delImpl } = {}) {
  return {
    getRefMe: vi.fn(async () => {
      if (refMe === '__throw_404') throw new ApiError({ code: 'referral.not_found', status: 404 });
      if (refMe === '__throw_401') throw new ApiError({ code: 'auth.unauthenticated', status: 401 });
      if (refMe === '__throw_500') throw new ApiError({ code: 'server.error', status: 500 });
      return refMe;
    }),
    putRefMe: vi.fn(async (code) => {
      if (typeof putImpl === 'function') return putImpl(code);
      return { code, wallet: '0xabc', claimedAt: 1709000000 };
    }),
    deleteRefMe: vi.fn(async () => {
      if (typeof delImpl === 'function') return delImpl();
      return null;
    }),
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('mountProfileReferral', () => {
  let container;

  beforeEach(() => {
    document.body.replaceChildren();
    container = document.createElement('div');
    document.body.appendChild(container);
    // happy-dom location origin defaults to 'http://localhost:3000'.
  });

  afterEach(() => {
    // Tear down any overlays left after each test.
    for (const ov of Array.from(document.querySelectorAll('.pt-modal-overlay'))) {
      ov.remove();
    }
  });

  it('throws when container is not an HTMLElement', () => {
    expect(() => mountProfileReferral(null)).toThrow(TypeError);
  });

  it('renders link with handle on 200', async () => {
    const api = makeApi({ refMe: { code: 'alex42', wallet: '0xabc', claimedAt: 1 } });
    mountProfileReferral(container, { apiClient: api });
    await flush();

    expect(api.getRefMe).toHaveBeenCalledTimes(1);
    const section = container.querySelector('[data-test-id="profile-referral"]');
    expect(section).not.toBeNull();
    expect(section.hidden).toBe(false);

    const url = container.querySelector('[data-test-id="profile-referral-url"]');
    expect(url.textContent).toContain('?ref=alex42');
    expect(container.querySelector('[data-test-id="profile-referral-copy"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="profile-referral-change"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="profile-referral-release"]')).not.toBeNull();
  });

  it('renders no-handle state + claim CTA on 404', async () => {
    const api = makeApi({ refMe: '__throw_404' });
    mountProfileReferral(container, { apiClient: api, userAddress: '0xdef' });
    await flush();

    const section = container.querySelector('[data-test-id="profile-referral"]');
    expect(section.hidden).toBe(false);

    const claim = container.querySelector('[data-test-id="profile-referral-claim"]');
    expect(claim).not.toBeNull();

    const url = container.querySelector('[data-test-id="profile-referral-url"]');
    expect(url.textContent).toContain('?ref=0xdef');
  });

  it('hides the section on 401', async () => {
    const api = makeApi({ refMe: '__throw_401' });
    mountProfileReferral(container, { apiClient: api });
    await flush();
    const section = container.querySelector('[data-test-id="profile-referral"]');
    expect(section.hidden).toBe(true);
  });

  it('shows error state on 5xx', async () => {
    const api = makeApi({ refMe: '__throw_500' });
    mountProfileReferral(container, { apiClient: api });
    await flush();
    const section = container.querySelector('[data-test-id="profile-referral"]');
    expect(section.hidden).toBe(false);
    expect(container.querySelector('[data-test-id="profile-referral-error"]')).not.toBeNull();
  });

  // ── Claim modal ─────────────────────────────────────────────────────────

  it('opens claim modal; submit disabled until input valid', async () => {
    const api = makeApi({ refMe: '__throw_404' });
    mountProfileReferral(container, { apiClient: api });
    await flush();

    container.querySelector('[data-test-id="profile-referral-claim"]').click();
    const modal = document.querySelector('[data-test-id="profile-referral-modal"]');
    expect(modal).not.toBeNull();
    const input = modal.querySelector('[data-test-id="profile-referral-input"]');
    const submit = modal.querySelector('[data-test-id="profile-referral-modal-submit"]');
    expect(submit.disabled).toBe(true);

    // Invalid: too short.
    input.value = 'ab';
    input.dispatchEvent(new Event('input'));
    expect(submit.disabled).toBe(true);

    // Invalid: edge underscore.
    input.value = '_alex';
    input.dispatchEvent(new Event('input'));
    expect(submit.disabled).toBe(true);
    expect(modal.querySelector('[data-test-id="profile-referral-modal-error"]').hidden).toBe(false);

    // Reserved.
    input.value = 'admin';
    input.dispatchEvent(new Event('input'));
    expect(submit.disabled).toBe(true);

    // Valid.
    input.value = 'alex42';
    input.dispatchEvent(new Event('input'));
    expect(submit.disabled).toBe(false);
  });

  it('submits valid handle → PUT → refresh → has-handle state', async () => {
    let mode = '__throw_404';
    const api = {
      getRefMe: vi.fn(async () => {
        if (mode === '__throw_404') throw new ApiError({ code: 'referral.not_found', status: 404 });
        return mode;
      }),
      putRefMe: vi.fn(async (code) => {
        mode = { code, wallet: '0xabc', claimedAt: 1 };
        return mode;
      }),
      deleteRefMe: vi.fn(),
    };
    mountProfileReferral(container, { apiClient: api });
    await flush();
    container.querySelector('[data-test-id="profile-referral-claim"]').click();

    const modal = document.querySelector('[data-test-id="profile-referral-modal"]');
    const input = modal.querySelector('[data-test-id="profile-referral-input"]');
    const form = modal.querySelector('form');
    input.value = 'alex42';
    input.dispatchEvent(new Event('input'));
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    await flush();

    expect(api.putRefMe).toHaveBeenCalledWith('alex42');
    // Modal closed.
    expect(document.querySelector('[data-test-id="profile-referral-modal"]')).toBeNull();
    // Optimistic + refreshed render.
    const url = container.querySelector('[data-test-id="profile-referral-url"]');
    expect(url.textContent).toContain('?ref=alex42');
  });

  it('shows "taken" message on 409', async () => {
    const api = makeApi({
      refMe: '__throw_404',
      putImpl: () => { throw new ApiError({ code: 'referral.taken', status: 409 }); },
    });
    mountProfileReferral(container, { apiClient: api });
    await flush();
    container.querySelector('[data-test-id="profile-referral-claim"]').click();
    const modal = document.querySelector('[data-test-id="profile-referral-modal"]');
    const input = modal.querySelector('[data-test-id="profile-referral-input"]');
    const form = modal.querySelector('form');
    input.value = 'taken1';
    input.dispatchEvent(new Event('input'));
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    await flush();
    const err = modal.querySelector('[data-test-id="profile-referral-modal-error"]');
    expect(err.hidden).toBe(false);
    expect(err.textContent).toContain('занято');
  });

  it('shows reserved message on 422 referral.reserved', async () => {
    const api = makeApi({
      refMe: '__throw_404',
      putImpl: () => { throw new ApiError({ code: 'referral.reserved', status: 422 }); },
    });
    mountProfileReferral(container, { apiClient: api });
    await flush();
    container.querySelector('[data-test-id="profile-referral-claim"]').click();
    const modal = document.querySelector('[data-test-id="profile-referral-modal"]');
    const input = modal.querySelector('[data-test-id="profile-referral-input"]');
    const form = modal.querySelector('form');
    // bypass client reserved-check: "alpha" is not in client RESERVED_CODES, so submit fires.
    input.value = 'alpha';
    input.dispatchEvent(new Event('input'));
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    await flush();
    const err = modal.querySelector('[data-test-id="profile-referral-modal-error"]');
    expect(err.textContent).toContain('зарезервировано');
  });

  it('release: confirm → DELETE → no-handle state', async () => {
    let mode = { code: 'alex42', wallet: '0xabc', claimedAt: 1 };
    const api = {
      getRefMe: vi.fn(async () => {
        if (mode === '__throw_404') throw new ApiError({ code: 'referral.not_found', status: 404 });
        return mode;
      }),
      putRefMe: vi.fn(),
      deleteRefMe: vi.fn(async () => {
        mode = '__throw_404';
        return null;
      }),
    };
    window.confirm = vi.fn().mockReturnValue(true);
    mountProfileReferral(container, { apiClient: api, userAddress: '0xdef' });
    await flush();

    container.querySelector('[data-test-id="profile-referral-release"]').click();
    await flush();
    await flush();

    expect(api.deleteRefMe).toHaveBeenCalled();
    expect(container.querySelector('[data-test-id="profile-referral-claim"]')).not.toBeNull();
    expect(container.querySelector('[data-test-id="profile-referral-url"]').textContent).toContain('?ref=0xdef');
  });

  it('release: confirm cancelled → no DELETE call', async () => {
    const api = makeApi({ refMe: { code: 'alex42', wallet: '0xabc', claimedAt: 1 } });
    window.confirm = vi.fn().mockReturnValue(false);
    mountProfileReferral(container, { apiClient: api });
    await flush();
    container.querySelector('[data-test-id="profile-referral-release"]').click();
    await flush();
    expect(api.deleteRefMe).not.toHaveBeenCalled();
  });

  it('copy button uses clipboard.writeText', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const origClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    try {
      const api = makeApi({ refMe: { code: 'alex42', wallet: '0xabc', claimedAt: 1 } });
      mountProfileReferral(container, { apiClient: api });
      await flush();
      container.querySelector('[data-test-id="profile-referral-copy"]').click();
      await flush();
      expect(writeText).toHaveBeenCalled();
      expect(String(writeText.mock.calls[0][0])).toContain('?ref=alex42');
    } finally {
      if (origClipboard) Object.defineProperty(navigator, 'clipboard', origClipboard);
      else delete navigator.clipboard;
    }
  });

  it('destroy() removes modal and clears container', async () => {
    const api = makeApi({ refMe: '__throw_404' });
    const handle = mountProfileReferral(container, { apiClient: api });
    await flush();
    container.querySelector('[data-test-id="profile-referral-claim"]').click();
    expect(document.querySelector('[data-test-id="profile-referral-modal"]')).not.toBeNull();
    handle.destroy();
    expect(document.querySelector('[data-test-id="profile-referral-modal"]')).toBeNull();
    expect(container.children.length).toBe(0);
  });
});
