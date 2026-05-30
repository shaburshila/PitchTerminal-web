/**
 * Mobile viewport detection.
 *
 * `isMobileViewport()` decides whether bootstrap hands off to the mobile
 * layout (Track A WalletConnect + responsive shell) instead of the desktop
 * 3-column dashboard. The 1024px cutoff is generous on purpose — iPad portrait
 * (768px) and Android tablets fall into the mobile bucket because the 3-col
 * grid + bottom-tabs + trade-panel can't fit horizontally below 1024px. iPad
 * landscape (1024px) and above is treated as desktop.
 *
 * NOTE: the old `needsDesktopStub` / `mountMobileStub` full-screen takeover was
 * removed — desktop without an injected wallet now loads the full app (wallet
 * init is lazy via AppKit; WalletConnect works without an extension).
 */

export const MOBILE_BREAKPOINT_PX = 1024;

/**
 * Returns true when the current viewport is narrower than
 * `MOBILE_BREAKPOINT_PX`. Safe to call in non-DOM contexts (returns false —
 * there's no viewport to be "mobile" in).
 *
 * @param {{ innerWidth?: number }} [win] Override for tests.
 */
export function isMobileViewport(win) {
  const w = win ?? (typeof window !== 'undefined' ? window : null);
  if (!w || typeof w.innerWidth !== 'number') return false;
  return w.innerWidth < MOBILE_BREAKPOINT_PX;
}
