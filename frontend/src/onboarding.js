/**
 * First-visit onboarding modal.
 *
 * Single-page (no carousel) gold-themed modal that explains what PitchTerminal
 * is, what's free vs. Pro, and a small disclaimer. Visual language mirrors the
 * pay-flow modal / soft-lock cover (gold hero star + gradient CTA) so the
 * free-vs-Pro framing is consistent.
 *
 * Public API:
 *   showOnboardingModal()      -> { close }   // always opens (used by Help)
 *   maybeShowOnboarding()      -> { close } | null // opens iff first visit
 *
 * Persistence: a single localStorage key (`pt:onboarded:v1`) records that the
 * user has dismissed the modal. The trailing `v1` is a content-version: bump
 * it (modify the key constant) to force every existing visitor to see the
 * modal again after a substantive copy change.
 */

const STORAGE_KEY = 'pt:onboarded:v1';

let _activeOverlay = null;
let _activeKeyListener = null;

function el(tag, { className, dataset, attrs, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (dataset) for (const [k, v] of Object.entries(dataset)) node.dataset[k] = v;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function safeRead(key) {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeWrite(key, value) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    /* private mode / quota — ignore, user just sees the modal again next time */
  }
}

/**
 * @returns {boolean} true if the user has dismissed the v1 modal before.
 */
export function hasOnboarded() {
  return safeRead(STORAGE_KEY) === '1';
}

/**
 * Mark the user as onboarded. Idempotent.
 */
export function markOnboarded() {
  safeWrite(STORAGE_KEY, '1');
}

/**
 * Show the modal if (and only if) the user has not dismissed it before.
 * Header `?` button calls `showOnboardingModal()` directly instead.
 */
export function maybeShowOnboarding() {
  if (typeof document === 'undefined') return null;
  if (hasOnboarded()) return null;
  return showOnboardingModal();
}

/**
 * Build a feature bullet row used inside the Free / Pro columns.
 */
function buildFeatureItem(label) {
  const li = el('li', { className: 'pt-onb__feat' });
  li.appendChild(
    el('span', { className: 'pt-onb__feat-tick', attrs: { 'aria-hidden': 'true' }, text: '✓' }),
  );
  li.appendChild(el('span', { text: label }));
  return li;
}

/**
 * Open the onboarding modal. Always opens regardless of `hasOnboarded()` —
 * caller is responsible for gating on first visit (use `maybeShowOnboarding`
 * for that). Dismissal (CTA or ✕) marks the user as onboarded; opening via
 * the help button does NOT clear that flag, so first-visit semantics survive
 * a help-button preview.
 *
 * @returns {{ close: () => void }}
 */
export function showOnboardingModal() {
  if (typeof document === 'undefined') return { close: () => {} };

  // Only one modal at a time. Clean up BOTH the DOM node AND the document-
  // level keydown listener from the previous invocation — otherwise repeated
  // Help-button clicks accumulate stale Esc listeners on `document`.
  if (_activeOverlay) {
    if (_activeKeyListener) {
      try {
        document.removeEventListener('keydown', _activeKeyListener);
      } catch {
        /* ignore */
      }
      _activeKeyListener = null;
    }
    try {
      _activeOverlay.remove();
    } catch {
      /* ignore */
    }
    _activeOverlay = null;
  }

  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const overlay = el('div', {
    className: 'pt-modal-overlay',
    dataset: { testId: 'onboarding-overlay' },
    attrs: { role: 'presentation' },
  });
  const card = el('div', {
    className: 'pt-modal pt-modal--onboarding',
    dataset: { testId: 'onboarding-modal' },
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pt-onb-title' },
  });

  const closeBtn = el('button', {
    className: 'pt-modal__close',
    dataset: { testId: 'onboarding-close' },
    attrs: { type: 'button', 'aria-label': 'Close' },
    text: '✕',
  });
  card.appendChild(closeBtn);

  // Gold hero — matches pay-flow / soft-lock visual language.
  const hero = el('div', { className: 'pt-pay__hero pt-onb__hero' });
  hero.appendChild(
    el('div', {
      className: 'pt-pay__hero-icon',
      attrs: { 'aria-hidden': 'true' },
      text: '★',
    }),
  );
  const heroText = el('div', { className: 'pt-pay__hero-text' });
  heroText.appendChild(
    el('h2', {
      className: 'pt-modal__title',
      attrs: { id: 'pt-onb-title' },
      text: 'Welcome to PitchTerminal',
    }),
  );
  heroText.appendChild(
    el('p', {
      className: 'pt-onb__sub',
      text:
        'A trading terminal for pitchwc.app player & country token markets on Base. ' +
        'Non-custodial — you connect your own wallet, we never hold your keys.',
    }),
  );
  hero.appendChild(heroText);
  card.appendChild(hero);

  // Free vs Pro grid — two cards, the Pro card gets the gold-tinted border.
  const grid = el('div', { className: 'pt-onb__grid' });

  const freeCard = el('div', {
    className: 'pt-onb__col pt-onb__col--free',
    dataset: { testId: 'onboarding-free' },
  });
  freeCard.appendChild(el('div', { className: 'pt-onb__col-label', text: 'Free' }));
  freeCard.appendChild(el('div', { className: 'pt-onb__col-headline', text: 'View everything' }));
  const freeList = el('ul', { className: 'pt-onb__feats' });
  freeList.appendChild(buildFeatureItem('View all markets (players + countries)'));
  freeList.appendChild(buildFeatureItem('Live charts with OHLC + crosshair'));
  freeList.appendChild(buildFeatureItem('Spot prices, holder counts, sparklines'));
  freeList.appendChild(buildFeatureItem('Sidebar with filters and search'));
  freeCard.appendChild(freeList);
  grid.appendChild(freeCard);

  const proCard = el('div', {
    className: 'pt-onb__col pt-onb__col--pro',
    dataset: { testId: 'onboarding-pro' },
  });
  const proLabel = el('div', { className: 'pt-onb__col-label pt-onb__col-label--pro' });
  proLabel.appendChild(el('span', { className: 'pt-onb__col-label-star', text: '★' }));
  proLabel.appendChild(document.createTextNode(' Pro · 1 PITCH (one-time)'));
  proCard.appendChild(proLabel);
  proCard.appendChild(el('div', { className: 'pt-onb__col-headline', text: 'Trade + portfolio' }));
  const proList = el('ul', { className: 'pt-onb__feats' });
  proList.appendChild(buildFeatureItem('Market & limit orders (trading)'));
  proList.appendChild(buildFeatureItem('My Wallet portfolio view'));
  proList.appendChild(buildFeatureItem('Orders tab (open + history)'));
  proList.appendChild(buildFeatureItem('Portfolio + Referral program'));
  proCard.appendChild(proList);
  grid.appendChild(proCard);

  card.appendChild(grid);

  // Disclaimer — small, muted, sits above the CTA.
  card.appendChild(
    el('p', {
      className: 'pt-onb__disclaimer',
      dataset: { testId: 'onboarding-disclaimer' },
      text:
        'Trading involves risk. Not financial advice. ' +
        "You're responsible for your wallet and signed transactions.",
    }),
  );

  // Single gold CTA.
  const actions = el('div', { className: 'pt-modal__actions pt-onb__actions' });
  const ctaBtn = el('button', {
    className: 'pt-onb__cta',
    dataset: { testId: 'onboarding-cta' },
    attrs: { type: 'button' },
  });
  ctaBtn.appendChild(el('span', { attrs: { 'aria-hidden': 'true' }, text: '★ ' }));
  ctaBtn.appendChild(document.createTextNode("Got it — let's go"));
  actions.appendChild(ctaBtn);
  card.appendChild(actions);

  overlay.appendChild(card);
  document.body.appendChild(overlay);
  _activeOverlay = overlay;

  let closed = false;

  function focusableNodes() {
    const sel =
      'a[href], button:not([disabled]), input:not([disabled]),' +
      ' [tabindex]:not([tabindex="-1"])';
    return Array.from(overlay.querySelectorAll(sel)).filter((node) => !node.hasAttribute('hidden'));
  }

  function close() {
    if (closed) return;
    closed = true;
    markOnboarded();
    document.removeEventListener('keydown', onKey);
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (_activeOverlay === overlay) _activeOverlay = null;
    if (_activeKeyListener === onKey) _activeKeyListener = null;
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      try {
        if (previouslyFocused.isConnected !== false) previouslyFocused.focus();
      } catch {
        /* ignore */
      }
    }
  }

  function onKey(ev) {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      close();
      return;
    }
    if (ev.key !== 'Tab') return;
    const nodes = focusableNodes();
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    const inOverlay = overlay.contains(active);
    if (ev.shiftKey) {
      if (!inOverlay || active === first) {
        ev.preventDefault();
        last.focus();
      }
    } else if (!inOverlay || active === last) {
      ev.preventDefault();
      first.focus();
    }
  }

  function onOverlayMousedown(ev) {
    if (ev.target === overlay) close();
  }

  ctaBtn.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('mousedown', onOverlayMousedown);
  document.addEventListener('keydown', onKey);
  _activeKeyListener = onKey;

  // Initial focus on the CTA — primary action, one Shift+Tab away from close.
  try {
    ctaBtn.focus();
  } catch {
    /* ignore */
  }

  return { close };
}

// Exposed for tests to reset shared state between runs.
export const __test = { STORAGE_KEY };
