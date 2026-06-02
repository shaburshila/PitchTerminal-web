// Layout: 3-column dashboard shell + header + banner.
// See docs/functional-spec.md §2 for screen structure.
//
// Exports:
//   mountLayout(root)  -> LayoutHandle
//
// LayoutHandle shape:
//   { header, banner, sidebar, center, right, setMode(mode), destroy() }
//
// All DOM is built via document.createElement (no innerHTML with user data).

const MODE_DASHBOARD = 'dashboard';
const MODE_PROFILE = 'profile';

const VALID_MODES = new Set([MODE_DASHBOARD, MODE_PROFILE]);

function el(tag, { className, dataset, attrs, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (dataset) {
    for (const [k, v] of Object.entries(dataset)) {
      node.dataset[k] = v;
    }
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      node.setAttribute(k, v);
    }
  }
  if (text != null) node.textContent = text;
  return node;
}

function buildHeader() {
  const header = el('header', {
    className: 'pt-header',
    dataset: { testId: 'header', zone: 'header' },
    attrs: { role: 'banner' },
  });

  // Left: logo. Rendered as a <button> so it can act as "exit Profile →
  // dashboard" trigger. Styled to look like a plain text node via CSS (no
  // native button chrome). Click handler is wired in main.js so it shares
  // the live `layout.setMode` reference.
  const left = el('div', { className: 'pt-header__left' });
  const logo = el('button', {
    className: 'pt-header__logo',
    dataset: { testId: 'header-logo' },
    attrs: { type: 'button', 'aria-label': 'Go to dashboard' },
  });
  logo.appendChild(
    el('span', {
      className: 'pt-header__logo-mark',
      attrs: { 'aria-hidden': 'true' },
      text: 'P',
    }),
  );
  logo.appendChild(el('span', { className: 'pt-header__logo-name', text: 'PitchTerminal' }));
  left.appendChild(logo);

  // Help (?) button — re-opens the onboarding modal. Sits immediately after
  // the "PitchTerminal" wordmark so first-time users find it right next
  // to the brand. Click handler is wired in main.js. Hidden on mobile (see
  // styles/mobile.css) — mobile uses the first-visit auto-open instead.
  const helpBtn = el('button', {
    className: 'pt-btn pt-header__action pt-header__action--help',
    dataset: { testId: 'header-help-btn' },
    attrs: { type: 'button', 'aria-label': 'What is PitchTerminal? (help)' },
    text: '?',
  });
  left.appendChild(helpBtn);

  // Center: mount point for the version-check "update available" banner.
  // Empty by default — `version-check.js` populates it on backend↔bundle
  // SHA mismatch, hiding via CSS `:empty` selector when in sync.
  const center = el('div', {
    className: 'pt-header__center',
    dataset: { testId: 'header-center' },
  });

  // Right side cluster — [Profile] [Referral] [wallet-area]. The cluster
  // itself is a flex container; the wallet-area is the placeholder that
  // `mountWalletChip` populates (kept on the same `[data-test-id="wallet-area"]`
  // selector for backward compat with main.js + tests). Profile/Referral
  // buttons are wired up in main.js (phase 1.5 batch 2, closes known-issues
  // #4 + #5).
  const right = el('div', {
    className: 'pt-header__right',
  });

  // Phase 1.5 batch 10: Profile + Referral are premium-only surfaces. We keep
  // the buttons visible for everyone (canonical mockup hides them in the
  // wallet-chip dropdown — separate refactor) but render them in a disabled
  // visual state with a small lock badge when the user isn't premium. Click
  // on a locked button opens the pay modal instead of routing into the gated
  // surface. header-actions.js wires the access-store subscription that
  // toggles `is-locked`.
  const profileBtn = el('button', {
    className: 'pt-btn pt-header__action',
    dataset: { testId: 'header-profile-btn' },
    attrs: { type: 'button', 'aria-label': 'Open portfolio' },
    text: 'Portfolio',
  });
  profileBtn.appendChild(
    el('span', {
      className: 'pt-header__action-lock',
      dataset: { testId: 'header-profile-lock' },
      attrs: { 'aria-hidden': 'true' },
      text: '🔒',
    }),
  );

  const referralBtn = el('button', {
    className: 'pt-btn pt-header__action',
    dataset: { testId: 'header-referral-btn' },
    attrs: { type: 'button', 'aria-label': 'Copy referral link' },
    text: 'Referral',
  });
  referralBtn.appendChild(
    el('span', {
      className: 'pt-header__action-lock',
      dataset: { testId: 'header-referral-lock' },
      attrs: { 'aria-hidden': 'true' },
      text: '🔒',
    }),
  );

  // Wallet-area placeholder — `mountWalletChip` (F0.9/F0.10) replaces its
  // children with the connect-button → chip flow on every `onAccountChange`.
  const walletArea = el('div', {
    className: 'pt-header__wallet-area',
    dataset: { testId: 'wallet-area' },
  });
  const connectBtn = el('button', {
    className: 'pt-btn pt-btn--primary',
    dataset: { testId: 'connect-btn' },
    attrs: { type: 'button' },
    text: 'Connect wallet',
  });
  // F0.9 will attach the actual wagmi click handler — until then the button
  // exists as a visible CTA but has no listener (no dead-no-op handler that
  // would leak listeners on re-mount).
  walletArea.appendChild(connectBtn);

  // Order: Referral → Profile → wallet-area. The Help (?) button moved next
  // to the brand wordmark in the left cluster (see above).
  right.appendChild(referralBtn);
  right.appendChild(profileBtn);
  right.appendChild(walletArea);

  header.appendChild(left);
  header.appendChild(center);
  header.appendChild(right);
  return header;
}

function buildBanner() {
  // Thin band under header. Content filled in F0.13.
  return el('div', {
    className: 'pt-banner',
    dataset: { testId: 'banner', zone: 'banner' },
  });
}

function buildSidebar() {
  const sidebar = el('aside', {
    className: 'pt-sidebar',
    dataset: { testId: 'sidebar', zone: 'sidebar' },
    attrs: { 'aria-label': 'Token list' },
  });
  return sidebar;
}

function buildCenter() {
  const center = el('section', {
    className: 'pt-center',
    dataset: { testId: 'center', zone: 'center' },
    attrs: { 'aria-label': 'Chart and tabs' },
  });
  return center;
}

function buildRight() {
  const right = el('aside', {
    className: 'pt-right',
    dataset: { testId: 'right', zone: 'right' },
    attrs: { 'aria-label': 'Trading panel' },
  });
  return right;
}

function buildProfileZone() {
  // Hidden by default — shown when setMode('profile') is called.
  // Real content is rendered by F0.15.
  const profile = el('section', {
    className: 'pt-profile',
    dataset: { testId: 'profile', zone: 'profile' },
    attrs: { 'aria-label': 'Wallet profile' },
  });
  return profile;
}

function buildFooter() {
  // Thin footer band — content filled later (links to portable version,
  // docs, etc). Plan F0.4 DoD calls for a footer row in the shell grid.
  return el('footer', {
    className: 'pt-footer',
    dataset: { testId: 'footer', zone: 'footer' },
  });
}

/**
 * Mount the 3-column dashboard shell into the given root element.
 * Idempotent: re-mounting on the same root clears previous content.
 *
 * @param {HTMLElement} root
 * @returns {{
 *   header: HTMLElement,
 *   banner: HTMLElement,
 *   sidebar: HTMLElement,
 *   center: HTMLElement,
 *   right: HTMLElement,
 *   profile: HTMLElement,
 *   footer: HTMLElement,
 *   setMode: (mode: 'dashboard' | 'profile') => void,
 *   destroy: () => void,
 * }}
 */
export function mountLayout(root) {
  if (!(root instanceof HTMLElement)) {
    throw new TypeError('mountLayout: root must be an HTMLElement');
  }

  // Idempotent — clear any previous mount.
  root.replaceChildren();

  const header = buildHeader();
  const banner = buildBanner();
  const sidebar = buildSidebar();
  const center = buildCenter();
  const right = buildRight();
  const profile = buildProfileZone();
  const footer = buildFooter();

  const main = el('main', {
    className: 'pt-main',
    dataset: { testId: 'main' },
  });
  main.appendChild(sidebar);
  main.appendChild(center);
  main.appendChild(right);
  main.appendChild(profile);

  const shell = el('div', { className: 'pt-shell', dataset: { testId: 'shell' } });
  shell.appendChild(header);
  shell.appendChild(banner);
  shell.appendChild(main);
  shell.appendChild(footer);

  root.appendChild(shell);

  // Default mode = dashboard.
  const bodyEl = root.ownerDocument?.body;
  function setMode(mode) {
    if (!VALID_MODES.has(mode)) {
      throw new RangeError(`setMode: unknown mode "${mode}"`);
    }
    if (!bodyEl) return;
    bodyEl.classList.remove('mode-dashboard', 'mode-profile');
    bodyEl.classList.add(`mode-${mode}`);
  }
  setMode(MODE_DASHBOARD);

  function destroy() {
    root.replaceChildren();
    if (bodyEl) {
      bodyEl.classList.remove('mode-dashboard', 'mode-profile');
    }
  }

  return {
    header,
    banner,
    sidebar,
    center,
    right,
    profile,
    footer,
    // Phase 1.5 batch 8: expose the inner <main> grid container so
    // mountResizable can insert drag-handle siblings between sidebar/center
    // and center/right. Kept at the end of the handle so existing call-sites
    // (which destructure named zones) aren't affected.
    main,
    setMode,
    destroy,
  };
}
