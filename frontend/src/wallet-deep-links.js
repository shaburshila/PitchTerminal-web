/**
 * wallet-deep-links.js — pure data module for mobile WalletConnect flow.
 *
 * Maps WC URIs to wallet-specific universal/deep-link URLs. The mobile picker
 * (`ui/wallet-connect-modal.js`) builds one `<a href>` per entry so a tap
 * leaves the browser, opens the wallet app, surfaces the WC pairing prompt,
 * then iOS/Android returns the user to our tab via `visibilitychange`.
 *
 * Why per-wallet links instead of a generic `wc:` URI?
 *   - Plain `wc:` opens the OS chooser, which on iOS Safari shows nothing
 *     useful (no association between the bare scheme and a specific app).
 *   - Universal links (https://...) are routed by the OS to the installed
 *     wallet, falling back to the App Store / Play Store if the wallet
 *     isn't installed — exactly what we want.
 *   - Each wallet has its own URL shape; we hardcode the small set documented
 *     by the wallets themselves. The list is intentionally short — adding a
 *     new wallet is two lines.
 *
 * The `isMobileBrowser` / `hasInjectedProvider` helpers live here too so the
 * one module owns "is this a mobile-WC scenario?".
 */

/**
 * @typedef {object} MobileWallet
 * @property {string} id       Stable id (used as test-id).
 * @property {string} name     Display name for the row.
 * @property {(uri: string) => string} deepLink  Builds the universal link
 *   for the given WC pairing URI (already non-encoded; we encode here).
 */

/** @type {ReadonlyArray<MobileWallet>} */
export const MOBILE_WALLETS = Object.freeze([
  {
    id: 'metamask',
    name: 'MetaMask',
    deepLink: (uri) => `https://metamask.app.link/wc?uri=${encodeURIComponent(uri)}`,
  },
  {
    id: 'rainbow',
    name: 'Rainbow',
    deepLink: (uri) => `https://rnbwapp.com/wc?uri=${encodeURIComponent(uri)}`,
  },
  {
    id: 'coinbase',
    name: 'Coinbase Wallet',
    deepLink: (uri) => `https://go.cb-wallet.com/wc?uri=${encodeURIComponent(uri)}`,
  },
  {
    id: 'trust',
    name: 'Trust Wallet',
    deepLink: (uri) => `https://link.trustwallet.com/wc?uri=${encodeURIComponent(uri)}`,
  },
  {
    id: 'okx',
    name: 'OKX Wallet',
    // OKX requires a nested deep-link: the outer universal link points to
    // their App Store / Play Store fallback page, with the inner
    // `okx://wallet/wc?uri=...` carried as the `deeplink` query param.
    deepLink: (uri) => {
      const inner = `okx://wallet/wc?uri=${encodeURIComponent(uri)}`;
      return `https://www.okx.com/download?deeplink=${encodeURIComponent(inner)}`;
    },
  },
  {
    id: 'imtoken',
    name: 'imToken',
    deepLink: (uri) => `imtokenv2://wc?uri=${encodeURIComponent(uri)}`,
  },
]);

/**
 * Heuristic mobile-browser detection by UA. Best-effort — UA spoofing in
 * desktop devtools emulation will return true here even on a desktop;
 * that's acceptable because the user explicitly picks a wallet from the
 * sheet and a non-installed deep-link is a no-op.
 *
 * @param {string} [ua]  Override for tests.
 * @returns {boolean}
 */
export function isMobileBrowser(ua) {
  const source =
    typeof ua === 'string'
      ? ua
      : typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
        ? navigator.userAgent
        : '';
  if (!source) return false;
  // iOS family + iPadOS (which reports as Mac on Safari 13+, but iPad
  // landscape >= 1024 won't hit the mobile branch anyway, so we don't
  // try to disambiguate via maxTouchPoints here).
  if (/iPhone|iPad|iPod/i.test(source)) return true;
  if (/Android/i.test(source)) return true;
  return false;
}

/**
 * Whether the current (or supplied) window has an injected EVM provider.
 * Wrapper exists for testability — tests pass a plain object instead of
 * fighting with `window.ethereum` cleanup.
 *
 * @param {{ ethereum?: unknown } | null | undefined} [win]
 * @returns {boolean}
 */
export function hasInjectedProvider(win) {
  const w = win ?? (typeof window !== 'undefined' ? window : null);
  if (!w) return false;
  return typeof w.ethereum !== 'undefined';
}
