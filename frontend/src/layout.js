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

  // Left: logo
  const left = el('div', { className: 'pt-header__left' });
  const logo = el('div', { className: 'pt-header__logo', text: 'PitchTerminal' });
  left.appendChild(logo);

  // Center: network badge
  const center = el('div', { className: 'pt-header__center' });
  const netBadge = el('div', {
    className: 'pt-net-badge',
    dataset: { testId: 'network-badge' },
    text: 'Base · 8453',
  });
  center.appendChild(netBadge);

  // Right: wallet area (anonymous by default — single "connect" button)
  const right = el('div', {
    className: 'pt-header__right',
    dataset: { testId: 'wallet-area' },
  });
  const connectBtn = el('button', {
    className: 'pt-btn pt-btn--primary',
    dataset: { testId: 'connect-btn' },
    attrs: { type: 'button' },
    text: 'Подключить кошелёк',
  });
  // F0.9 will attach the actual wagmi click handler — until then the button
  // exists as a visible CTA but has no listener (no dead-no-op handler that
  // would leak listeners on re-mount).
  right.appendChild(connectBtn);

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
    attrs: { 'aria-label': 'Список токенов' },
  });
  return sidebar;
}

function buildCenter() {
  const center = el('section', {
    className: 'pt-center',
    dataset: { testId: 'center', zone: 'center' },
    attrs: { 'aria-label': 'График и вкладки' },
  });
  return center;
}

function buildRight() {
  const right = el('aside', {
    className: 'pt-right',
    dataset: { testId: 'right', zone: 'right' },
    attrs: { 'aria-label': 'Торговая панель' },
  });
  return right;
}

function buildProfileZone() {
  // Hidden by default — shown when setMode('profile') is called.
  // Real content is rendered by F0.15.
  const profile = el('section', {
    className: 'pt-profile',
    dataset: { testId: 'profile', zone: 'profile' },
    attrs: { 'aria-label': 'Профиль кошелька' },
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
    setMode,
    destroy,
  };
}
