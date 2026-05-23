// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Mocks (declared BEFORE SUT import) ─────────────────────────────────────

const apiState = {
  config: {
    siwe: { domain: 'pitchterminal.app', uri: 'https://pitchterminal.app' },
  },
  nonce: {
    nonce: 'ABCdef0123456789',
    issuedAt: 1709000000,
    expiresAt: 1709000300,
  },
  verifyResp: { address: '0x71ecd1a09380ca46cca741bc48d04c556674756f' },
  // Set per-test to control which response /access returns.
  accessImpl: null,
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
    getConfig: vi.fn(async () => apiState.config),
    getAuthNonce: vi.fn(async () => apiState.nonce),
    verifySiwe: vi.fn(async (message, signature) => {
      apiState.lastVerifyCall = { message, signature };
      return apiState.verifyResp;
    }),
    getAccess: vi.fn(async () => {
      if (apiState.accessImpl) return apiState.accessImpl();
      return { hasAccess: false, source: 'none' };
    }),
  };
});

// Mock wallet.js — replace with a simple controllable state.
const walletState = {
  account: {
    address: '0x71ecd1a09380ca46cca741bc48d04c556674756f',
    chainId: 8453,
    isConnected: true,
    connectorId: 'injected',
  },
  wcProvider: null,
};

vi.mock('../src/wallet.js', () => ({
  getAccount: () => ({ ...walletState.account }),
  getWagmiConfig: () => ({ _fake: 'config' }),
  getWalletConnectProvider: () => walletState.wcProvider,
  CONNECTOR_INJECTED: 'injected',
  CONNECTOR_WALLET_CONNECT: 'walletConnect',
}));

// Mock @wagmi/core#signMessage — capture parameters for assertions.
const wagmiSignState = {
  signature: '0xdeadbeef' + '00'.repeat(30) + '1b', // 65 bytes — typical ECDSA
  lastCall: null,
  throwOn: null,
};

vi.mock('@wagmi/core', () => ({
  signMessage: vi.fn(async (config, params) => {
    wagmiSignState.lastCall = { config, params };
    if (wagmiSignState.throwOn) {
      const err = wagmiSignState.throwOn;
      wagmiSignState.throwOn = null;
      throw err;
    }
    return wagmiSignState.signature;
  }),
}));

// Use the real `viem` (we want getAddress for genuine checksum behaviour).

// ─── SUT ───────────────────────────────────────────────────────────────────
const siwe = await import('../src/siwe.js');
const api = await import('../src/api.js');

beforeEach(() => {
  siwe._resetForTests();
  apiState.accessImpl = null;
  apiState.lastVerifyCall = null;
  wagmiSignState.lastCall = null;
  wagmiSignState.throwOn = null;
  wagmiSignState.signature = '0xdeadbeef' + '00'.repeat(30) + '1b';
  walletState.account = {
    address: '0x71ecd1a09380ca46cca741bc48d04c556674756f',
    chainId: 8453,
    isConnected: true,
    connectorId: 'injected',
  };
  walletState.wcProvider = null;
  api.getConfig.mockClear();
  api.getAuthNonce.mockClear();
  api.verifySiwe.mockClear();
  api.getAccess.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── buildSiweMessage ──────────────────────────────────────────────────────

describe('buildSiweMessage', () => {
  it('matches the §2.2 api-spec template exactly', () => {
    const msg = siwe.buildSiweMessage({
      domain: 'pitchterminal.app',
      uri: 'https://pitchterminal.app',
      address: '0x71ECD1a09380cA46CcA741Bc48d04C556674756F',
      chainId: 8453,
      nonce: 'ABCdef0123456789',
      issuedAt: '2026-05-23T12:00:00Z',
      expirationTime: '2026-05-23T12:05:00Z',
    });
    const expected =
      'pitchterminal.app wants you to sign in with your Ethereum account:\n' +
      '0x71ECD1a09380cA46CcA741Bc48d04C556674756F\n' +
      '\n' +
      'Sign in to PitchTerminal.\n' +
      '\n' +
      'URI: https://pitchterminal.app\n' +
      'Version: 1\n' +
      'Chain ID: 8453\n' +
      'Nonce: ABCdef0123456789\n' +
      'Issued At: 2026-05-23T12:00:00Z\n' +
      'Expiration Time: 2026-05-23T12:05:00Z';
    expect(msg).toBe(expected);
  });

  it('checksums the address even when the caller passes lowercase', () => {
    const msg = siwe.buildSiweMessage({
      domain: 'pitchterminal.app',
      uri: 'https://pitchterminal.app',
      address: '0x71ecd1a09380ca46cca741bc48d04c556674756f', // lowercase
      chainId: 8453,
      nonce: 'NONCE0000000000000',
      issuedAt: 1709000000,
      expirationTime: 1709000300,
    });
    expect(msg).toContain('0x71ECD1a09380cA46CcA741Bc48d04C556674756F');
    // And NOT the lowercase form on the address line.
    expect(msg.split('\n')[1]).toBe('0x71ECD1a09380cA46CcA741Bc48d04C556674756F');
  });

  it('formats unix-second timestamps as ISO without milliseconds', () => {
    const msg = siwe.buildSiweMessage({
      domain: 'pitchterminal.app',
      uri: 'https://pitchterminal.app',
      address: '0x71ECD1a09380cA46CcA741Bc48d04C556674756F',
      chainId: 8453,
      nonce: 'NONCE0000000000000',
      issuedAt: 1709000000, // seconds
      expirationTime: 1709000300,
    });
    expect(msg).toMatch(/Issued At: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    expect(msg).not.toMatch(/\.\d{3}Z/);
  });

  it('throws on missing required fields', () => {
    expect(() => siwe.buildSiweMessage({})).toThrow(/domain/);
    expect(() =>
      siwe.buildSiweMessage({ domain: 'x', uri: 'y' })
    ).toThrow(/address/);
  });
});

// ─── signIn ────────────────────────────────────────────────────────────────

describe('signIn', () => {
  it('runs the full flow and posts a correctly-formed SIWE message', async () => {
    const result = await siwe.signIn();

    expect(api.getConfig).toHaveBeenCalledTimes(1);
    expect(api.getAuthNonce).toHaveBeenCalledTimes(1);
    expect(api.verifySiwe).toHaveBeenCalledTimes(1);

    const [postedMessage, postedSignature] = api.verifySiwe.mock.calls[0];
    // EIP-55 checksum on the address line (server rejects lowercase).
    expect(postedMessage.split('\n')[1]).toBe(
      '0x71ECD1a09380cA46CcA741Bc48d04C556674756F'
    );
    // Domain, URI, chain id, nonce from /config + /auth/nonce.
    expect(postedMessage).toContain('Chain ID: 8453');
    expect(postedMessage).toContain('Nonce: ABCdef0123456789');
    expect(postedMessage).toContain('URI: https://pitchterminal.app');
    expect(postedMessage.startsWith('pitchterminal.app wants you to sign in'))
      .toBe(true);

    expect(postedSignature).toBe(wagmiSignState.signature);
    expect(result.address).toBe('0x71ecd1a09380ca46cca741bc48d04c556674756f');
  });

  it('uses wagmi signMessage with the connected (lowercase) address', async () => {
    await siwe.signIn();
    expect(wagmiSignState.lastCall).not.toBeNull();
    expect(wagmiSignState.lastCall.params.account).toBe(
      '0x71ecd1a09380ca46cca741bc48d04c556674756f'
    );
    // The `message` passed to the wallet equals the `message` posted.
    expect(wagmiSignState.lastCall.params.message).toBe(
      api.verifySiwe.mock.calls[0][0]
    );
  });

  it('uses WalletConnect personal_sign when the wallet is connected via WC', async () => {
    const wcCalls = [];
    walletState.account.connectorId = 'walletConnect';
    walletState.wcProvider = {
      request: vi.fn(async ({ method, params }) => {
        wcCalls.push({ method, params });
        return '0x' + 'ab'.repeat(32) + '1c'; // 65-byte sig
      }),
    };

    await siwe.signIn();
    expect(wcCalls.length).toBe(1);
    expect(wcCalls[0].method).toBe('personal_sign');
    expect(wcCalls[0].params[1]).toBe(
      '0x71ecd1a09380ca46cca741bc48d04c556674756f'
    );
  });

  it('throws if no wallet is connected', async () => {
    walletState.account = {
      address: null,
      chainId: null,
      isConnected: false,
      connectorId: null,
    };
    await expect(siwe.signIn()).rejects.toThrow(/no connected wallet/);
  });

  it('propagates wallet rejection errors (user pressed Reject)', async () => {
    wagmiSignState.throwOn = Object.assign(new Error('User rejected the request'), {
      code: 4001,
    });
    await expect(siwe.signIn()).rejects.toThrow(/User rejected/);
    // verifySiwe must NOT have been called — we never produced a signature.
    expect(api.verifySiwe).not.toHaveBeenCalled();
  });

  it('propagates 401 invalid_nonce from /auth/verify', async () => {
    api.verifySiwe.mockRejectedValueOnce(
      new api.ApiError({
        code: 'auth.siwe.invalid_nonce',
        status: 401,
        title: 'Invalid nonce',
      })
    );
    await expect(siwe.signIn()).rejects.toMatchObject({
      status: 401,
      code: 'auth.siwe.invalid_nonce',
    });
  });

  it('throws on malformed /auth/nonce response', async () => {
    api.getAuthNonce.mockResolvedValueOnce({ nonce: '', issuedAt: 0, expiresAt: 0 });
    await expect(siwe.signIn()).rejects.toThrow(/malformed/);
  });

  it('forwards arbitrary-length signatures unchanged (EIP-1271 smart wallets)', async () => {
    // Smart-contract wallets (Safe / Coinbase Smart Wallet) return blobs that
    // can be far longer than 65 bytes. signIn should pass through verbatim.
    const longSig = '0x' + 'aa'.repeat(256);
    wagmiSignState.signature = longSig;
    await siwe.signIn();
    expect(api.verifySiwe.mock.calls[0][1]).toBe(longSig);
  });

  it('caches /config across multiple signIn calls', async () => {
    await siwe.signIn();
    await siwe.signIn();
    expect(api.getConfig).toHaveBeenCalledTimes(1);
    expect(api.getAuthNonce).toHaveBeenCalledTimes(2);
  });

  it('throws if /config lacks the siwe block', async () => {
    api.getConfig.mockResolvedValueOnce({ chainId: 8453 });
    await expect(siwe.signIn()).rejects.toThrow(/SIWE config missing/);
  });
});

// ─── ensureSignedIn ────────────────────────────────────────────────────────

describe('ensureSignedIn', () => {
  it('returns true and skips signMessage when /access already returns 200', async () => {
    apiState.accessImpl = () => ({ hasAccess: true, source: 'paid' });
    const ok = await siwe.ensureSignedIn();
    expect(ok).toBe(true);
    expect(api.verifySiwe).not.toHaveBeenCalled();
    expect(wagmiSignState.lastCall).toBeNull();
  });

  it('triggers signIn when /access throws 401', async () => {
    apiState.accessImpl = () => {
      throw new api.ApiError({
        code: 'auth.unauthenticated',
        status: 401,
        title: 'auth required',
      });
    };
    const ok = await siwe.ensureSignedIn();
    expect(ok).toBe(true);
    expect(api.verifySiwe).toHaveBeenCalledTimes(1);
  });

  it('returns false and surfaces the error on non-401 /access failures', async () => {
    const onErr = vi.fn();
    apiState.accessImpl = () => {
      throw new api.ApiError({ code: 'server.degraded', status: 503 });
    };
    const ok = await siwe.ensureSignedIn({ onSignInError: onErr });
    expect(ok).toBe(false);
    expect(onErr).toHaveBeenCalledTimes(1);
    expect(api.verifySiwe).not.toHaveBeenCalled();
  });

  it('returns false and reports the error if user rejects the signature', async () => {
    apiState.accessImpl = () => {
      throw new api.ApiError({ code: 'auth.unauthenticated', status: 401 });
    };
    wagmiSignState.throwOn = Object.assign(new Error('User rejected'), { code: 4001 });
    const onErr = vi.fn();
    const ok = await siwe.ensureSignedIn({ onSignInError: onErr });
    expect(ok).toBe(false);
    expect(onErr).toHaveBeenCalledTimes(1);
  });
});
