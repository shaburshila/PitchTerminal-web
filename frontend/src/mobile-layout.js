/**
 * mobile-layout.js — mobile shell (header + 4 empty panels + bottom-nav).
 *
 * Phase 1 (M-0 + M-1): foundation only. This module builds the DOM skeleton
 * and wires the bottom-nav to `mobile-router`. It does NOT mount sidebar /
 * chart / trade / wallet components — that is Track C in the next phase.
 *
 * The returned handle exposes `panels.markets`, `panels.chart`,
 * `panels.trade`, `panels.wallet` so the next phase can mount components
 * directly into the empty containers.
 *
 * Locking: Trade + Wallet tabs render with `is-locked` class — purely
 * cosmetic at this phase (no cover overlay; Track C will render the upsell).
 * The tap behavior is unchanged from a free tab — navigate into the panel.
 */

import { TABS, navigateTo, onTabChange, initFromHash, getActiveTab } from './mobile-router.js';

/**
 * Tab spec — order here is the visual order in the bottom-nav.
 * `locked: true` only adds the `is-locked` class for now.
 */
const TAB_SPEC = [
  { id: TABS.MARKETS, label: 'Markets', icon: '☰', locked: false }, // ☰
  { id: TABS.CHART, label: 'Chart', icon: '▦', locked: false }, // ▦
  { id: TABS.TRADE, label: 'Trade', icon: '⇄', locked: true }, // ⇄
  { id: TABS.WALLET, label: 'Wallet', icon: '◉', locked: true }, // ◉
];

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
 * Mount the mobile shell into `root`. Returns a handle with:
 *   - `destroy()` — removes the shell + class + subscribers.
 *   - `panels` — { markets, chart, trade, wallet } DOM nodes for Track C.
 *   - `header` — header element for Track A wallet-area mounting.
 *
 * @param {HTMLElement} root
 * @param {object} [opts] reserved for future
 * @returns {{
 *   destroy: () => void,
 *   panels: { markets: HTMLElement, chart: HTMLElement, trade: HTMLElement, wallet: HTMLElement },
 *   header: HTMLElement,
 *   banner: HTMLElement,
 * }}
 */
export function mountMobileLayout(root) {
  if (!(root instanceof HTMLElement)) {
    throw new TypeError('mountMobileLayout: root must be an HTMLElement');
  }
  // Add the class BEFORE building DOM so CSS rules under body.is-mobile
  // apply on first paint without a flash.
  if (typeof document !== 'undefined' && document.body) {
    document.body.classList.add('is-mobile');
  }

  root.replaceChildren();

  const shell = el('div', { className: 'pt-shell', dataset: { testId: 'mobile-shell' } });

  // ── Header ────────────────────────────────────────────────────────────
  const header = el('header', { className: 'pt-header', dataset: { testId: 'mobile-header' } });
  header.appendChild(
    el('div', {
      className: 'pt-header__brand',
      dataset: { testId: 'header-logo' },
      text: 'PitchTerminal',
    }),
  );
  // Wallet-area slot — Track A mounts the wallet chip here.
  header.appendChild(
    el('div', {
      className: 'pt-header__wallet-area',
      dataset: { zone: 'wallet-area', testId: 'wallet-area' },
    }),
  );
  shell.appendChild(header);

  // ── Mobile banner slot ────────────────────────────────────────────────
  // Visible slot for the access banner (Phase 3b-2). Sits between the header
  // and the panels area. The banner itself collapses when empty (existing
  // behaviour in access.js); the slot collapses too via `:empty` in
  // styles/mobile.css so an unauth/premium user doesn't see a blank strip.
  const banner = el('div', {
    className: 'pt-mobile-banner',
    dataset: { zone: 'mobile-banner', testId: 'mobile-banner' },
  });
  shell.appendChild(banner);

  // ── Main (panels) ─────────────────────────────────────────────────────
  const main = el('main', { className: 'pt-main' });

  /** @type {Record<string, HTMLElement>} */
  const panels = {};
  for (const spec of TAB_SPEC) {
    const panel = el('div', {
      className: `pt-mobile-panel pt-mobile-panel--${spec.id}`,
      dataset: { tab: spec.id, testId: `mobile-panel-${spec.id}` },
    });
    panels[spec.id] = panel;
    main.appendChild(panel);
  }
  shell.appendChild(main);

  // ── Bottom nav ────────────────────────────────────────────────────────
  const nav = el('nav', {
    className: 'pt-mobile-nav',
    dataset: { testId: 'mobile-nav' },
    attrs: { role: 'tablist', 'aria-label': 'Primary' },
  });

  /** @type {Record<string, HTMLButtonElement>} */
  const tabButtons = {};
  for (const spec of TAB_SPEC) {
    const btn = el('button', {
      className: 'pt-mobile-nav__tab' + (spec.locked ? ' is-locked' : ''),
      dataset: { tab: spec.id, testId: `mobile-nav-${spec.id}` },
      attrs: { type: 'button', role: 'tab', 'aria-label': spec.label },
    });
    btn.appendChild(
      el('span', {
        className: 'pt-mobile-nav__tab-icon',
        attrs: { 'aria-hidden': 'true' },
        text: spec.icon,
      }),
    );
    btn.appendChild(el('span', { className: 'pt-mobile-nav__tab-label', text: spec.label }));
    if (spec.locked) {
      btn.appendChild(
        el('span', {
          className: 'pt-mobile-nav__tab-lock',
          attrs: { 'aria-hidden': 'true' },
          text: '\u{1F512}', // 🔒
        }),
      );
    }
    btn.addEventListener('click', () => {
      navigateTo(spec.id);
    });
    tabButtons[spec.id] = btn;
    nav.appendChild(btn);
  }
  shell.appendChild(nav);

  root.appendChild(shell);

  // ── Active-tab sync ───────────────────────────────────────────────────
  function applyActive({ tab }) {
    for (const id of Object.keys(panels)) {
      panels[id].classList.toggle('is-active', id === tab);
    }
    for (const id of Object.keys(tabButtons)) {
      const isActive = id === tab;
      tabButtons[id].classList.toggle('is-active', isActive);
      tabButtons[id].setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
  }

  const unsubscribe = onTabChange(applyActive);
  // Seed initial state from URL hash, then apply.
  initFromHash();
  applyActive(getActiveTab());

  function destroy() {
    try {
      unsubscribe();
    } catch {
      /* idempotent */
    }
    if (shell.parentNode === root) root.removeChild(shell);
    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.remove('is-mobile');
    }
  }

  return { destroy, panels, header, banner };
}
