/**
 * Mobile stub — full-screen takeover for mobile viewports.
 *
 * Rationale: PitchTerminal's MVP is desktop-only. The 3-column dashboard
 * layout (sidebar / chart / trade-panel) doesn't fit on a 390px viewport,
 * and on mobile Safari/Chrome there's no browser-extension wallet provider,
 * so wagmi's `injected()` connector throws `Provider not found.` which
 * surfaces as a red banner. Until a dedicated mobile experience (WalletConnect
 * + responsive layout) lands post-MVP, we suppress the broken UI and the
 * wagmi init entirely on small viewports and show a branded explainer card
 * instead.
 *
 * Detection: `window.innerWidth < MOBILE_BREAKPOINT_PX` (default 1024).
 * The cutoff is generous on purpose — iPad portrait (768px) and Android
 * tablets fall into the stub bucket too, because:
 *   - The 3-col grid + bottom-tabs + trade-panel can't fit horizontally even
 *     at 768px.
 *   - Most tablets don't carry an injected EVM wallet in the browser anyway.
 * iPad landscape (1024px) and above is treated as "desktop" — the layout is
 * tight but functional, and lab testing showed it works.
 *
 * The stub is a `position: fixed; inset: 0; z-index: 9999` overlay so it
 * covers anything that might paint underneath (defensive — we also skip
 * the bootstrap entirely, but if a future caller mounts the stub late it
 * still hides the broken UI).
 */

export const MOBILE_BREAKPOINT_PX = 1024;

/**
 * Returns true when the current viewport should render the mobile stub
 * instead of the full app. Safe to call in non-DOM contexts (returns false
 * — there's no viewport to be "mobile" in).
 *
 * Also returns true on ANY viewport when there is no injected EVM provider
 * (`window.ethereum` absent). Without this, an iPad-landscape (≥1024px) or
 * desktop-Chromebook user with no browser-extension wallet would fall
 * through into wagmi's `injected()` connector and see the original red
 * "Provider not found" banner — the exact regression this stub exists to
 * prevent. The stub copy ("desktop browser with a browser-extension
 * wallet") covers both cases accurately.
 *
 * @param {{ innerWidth?: number, ethereum?: unknown }} [win] Override for tests.
 */
export function isMobileViewport(win) {
  const w = win ?? (typeof window !== 'undefined' ? window : null);
  if (!w || typeof w.innerWidth !== 'number') return false;
  if (w.innerWidth < MOBILE_BREAKPOINT_PX) return true;
  if (typeof w.ethereum === 'undefined') return true;
  return false;
}

function el(tag, { className, dataset, attrs, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (dataset) {
    for (const [k, v] of Object.entries(dataset)) node.dataset[k] = v;
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  }
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Render the mobile stub into `root`. Replaces any existing children.
 * Returns a handle with `destroy()` for symmetry with other mount-* helpers
 * (tests + a future "re-mount on resize past breakpoint" flow can use it).
 *
 * The DOM is fully accessible:
 *   - The card uses `role="status"` so screen readers announce the message.
 *   - Copy-link button is a real `<button type="button">`.
 *
 * @param {HTMLElement} root
 */
export function mountMobileStub(root) {
  if (!(root instanceof HTMLElement)) {
    throw new TypeError('mountMobileStub: root must be an HTMLElement');
  }
  root.replaceChildren();

  const overlay = el('div', {
    className: 'pt-mobile-stub',
    dataset: { testId: 'mobile-stub' },
    attrs: { role: 'status', 'aria-live': 'polite' },
  });

  const card = el('div', { className: 'pt-mobile-stub__card' });

  card.appendChild(
    el('div', {
      className: 'pt-mobile-stub__brand',
      text: 'PitchTerminal',
    }),
  );

  card.appendChild(
    el('p', {
      className: 'pt-mobile-stub__lead',
      text: 'Desktop-only for now.',
    }),
  );

  card.appendChild(
    el('p', {
      className: 'pt-mobile-stub__body',
      text:
        'Please open this page on a desktop browser with a browser-extension wallet ' +
        '(MetaMask, Rabby, Coinbase Wallet, etc.) to access charts and trading.',
    }),
  );

  card.appendChild(
    el('div', {
      className: 'pt-mobile-stub__soon',
      dataset: { testId: 'mobile-stub-soon' },
      text: 'Mobile version coming soon',
    }),
  );

  // Optional copy-link affordance — best-effort, no error surface if the
  // clipboard API rejects (mobile Safari requires user-gesture, which we have
  // via the click). On success we flip the button label briefly.
  const copyBtn = el('button', {
    className: 'pt-mobile-stub__copy',
    dataset: { testId: 'mobile-stub-copy' },
    attrs: { type: 'button' },
    text: 'Copy link',
  });
  copyBtn.addEventListener('click', () => {
    const href = typeof window !== 'undefined' && window.location ? window.location.href : '';
    if (!href) return;
    const done = () => {
      const original = copyBtn.textContent;
      copyBtn.textContent = 'Copied';
      copyBtn.disabled = true;
      setTimeout(() => {
        copyBtn.textContent = original;
        copyBtn.disabled = false;
      }, 1500);
    };
    try {
      if (navigator?.clipboard?.writeText) {
        navigator.clipboard
          .writeText(href)
          .then(done)
          .catch(() => {
            /* silent — user can still copy via long-press */
          });
      }
    } catch {
      /* clipboard unsupported — silent */
    }
  });
  card.appendChild(copyBtn);

  overlay.appendChild(card);
  root.appendChild(overlay);

  function destroy() {
    if (overlay.parentNode === root) root.removeChild(overlay);
  }

  return { destroy };
}
