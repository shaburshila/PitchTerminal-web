// Sentry init runs first so uncaught errors thrown during module evaluation
// of the heavier imports below still get captured.
import { initSentry } from './sentry.js';
initSentry();

// Phase 1.5 batch 1: tokens.css loads before styles.css so the redesign
// CSS variables (--bg-0/1/2/3, --line, --up, --down, --font-ui, --font-mono…)
// are defined as the existing component styles cascade in. Subsequent
// redesign batches will reference these variables directly; for now the
// old `--bg`, `--text`, `--accent` set in styles.css remains the source of
// truth for already-rendered surfaces.
import './styles/tokens.css';
import './styles.css';
// Phase 1.5 batch 3: sidebar sparkline + position marker. Loaded after
// styles.css so the extended row grid (4 columns instead of 3) overrides
// the base layout cleanly without touching the global stylesheet.
import './styles/sidebar-batch3.css';
// Sidebar role filter — segmented toggle-button group (replaces legacy
// `<select>`). Loaded after styles.css to override the input/select rule.
import './styles/sidebar-role.css';
// Phase 1.5 batch 8: resizable panel drag-handles.
import './styles/resizable.css';
// Phase 1.5 batch 7: modals (SIWE, pay-flow, profile, wallet-dropdown)
// redesigned to the dark-green design system. Loaded last so its overrides
// for `.pt-modal*`, `.pt-wallet-*`, `.pt-pay__*`, `.pt-profile__*` win the
// cascade against the legacy F0.x rules in styles.css. Pure CSS overlay —
// the underlying JS components keep their existing class names + test-ids.
import './styles/modals-batch7.css';
// Phase 1.5 batch 5: trade-panel redesign + Pro upsell cover overlay. Loaded
// after styles.css so the new `.pt-trade__*` declarations override the legacy
// F1.1 rules. The pro-cover (`.pt-trade__cover`) ships its own complete
// stylesheet — no shared styles cross over to other panels.
import './styles/trade-panel-batch5.css';
// Onboarding welcome modal + header help button (`?`).
import './styles/onboarding.css';
// Mobile stub — full-screen takeover for sub-1024px viewports (MVP-time
// fallback, see mobile-stub.js for rationale). Loaded eagerly because
// bootstrap() decides whether to mount the stub vs the full app synchronously.
import './styles/mobile-stub.css';
// Version-check banner — shown in header center on backend↔bundle SHA
// mismatch (see version-check.js for the trigger logic + threat model).
import './styles/version-check.css';
// Mobile layout overrides — must load LAST among style imports so its
// `body.is-mobile` selectors win the cascade against component stylesheets.
import './styles/mobile.css';
import { isMobileViewport, mountMobileStub, needsDesktopStub } from './mobile-stub.js';
import { mountLayout } from './layout.js';
import { mountResizable } from './resizable.js';
import { mountSidebar } from './sidebar.js';
import { mountChart } from './chart.js';
import { mountBottomTabs } from './components/bottom/index.js';
import { mountTradePanel } from './trade-panel.js';
import { openStream } from './sse.js';
import { mountWalletChip } from './ui/wallet-chip.js';
import { showSignInModal } from './ui/signin-modal.js';
import { ensureSignedIn } from './siwe.js';
import { onAccountChange, getAccount, tryAutoReconnect } from './wallet.js';
import { getConfig, getTokens, getPortfolio, ApiError, getAccess, logout } from './api.js';
import { bootstrapReferral } from './referral.js';
import { merge as mergeConfig } from './config-store.js';
import { set as setAccessState } from './access-store.js';
import { mountProfile } from './profile.js';
import { mountAccessBanner } from './access.js';
import { mountSoftLock } from './soft-lock.js';
import { showToast } from './ui/toast.js';
import { mountHeaderActions } from './components/header-actions.js';
import { showOnboardingModal, maybeShowOnboarding } from './onboarding.js';
import { mountVersionCheck } from './version-check.js';

/**
 * Convert a backend wei decimal-string into a whole-token Number.
 *
 * Exported for unit tests. Uses BigInt division for the integer part so a
 * supply string of exactly 18 digits with a leading non-zero (e.g.
 * `'1' * 18` = `'111111111111111111'` ≈ 0.111 PITCH) doesn't silently
 * lose precision through `Number(str)` (which converts `>2^53` int-likes
 * inexactly). The fractional part is approximated by `/ 1e18` for display —
 * for sub-wei precision callers should consume the BigInt directly.
 *
 * Returns `0` on any parse failure (empty / non-numeric / non-digit chars).
 *
 * @param {string|null|undefined} weiStr
 * @returns {number}
 */
export function weiToWhole(weiStr) {
  if (typeof weiStr !== 'string' || !weiStr) return 0;
  // Reject anything that isn't an optional minus + digits — BigInt would
  // throw on '1.5e10' etc. and we'd swallow it.
  if (!/^-?\d+$/.test(weiStr)) return 0;
  try {
    const big = BigInt(weiStr);
    const WEI = 1000000000000000000n;
    const negative = big < 0n;
    const abs = negative ? -big : big;
    const whole = abs / WEI;
    const rem = abs % WEI;
    // remainder always fits in a double (max < 1e18 ≈ 10^18 ≈ 2^59.79 — actually
    // > 2^53 so we still lose a few low bits, but for display precision this is
    // acceptable; the high-magnitude part is precise via the BigInt division).
    const result = Number(whole) + Number(rem) / 1e18;
    return negative ? -result : result;
  } catch {
    return 0;
  }
}

/**
 * Build a throttled `schedule()` for sidebar sparkline updates with a
 * matching `cleanup()` that cancels the pending trailing-edge timer.
 *
 * Phase 1.5 follow-up issue #2: the original inline `sparkTimer` had no
 * teardown path — if sidebar.destroy() is called (tests, hot-reload, future
 * SPA remount) a pending setTimeout still fires and calls sidebar.rerender()
 * on a detached component. We expose `cleanup()` so the caller can patch
 * sidebar.destroy and clear the timer.
 *
 * @param {{ rerender: () => void }} sidebar
 * @param {number} delayMs  Trailing-edge throttle interval.
 * @param {{ setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout }} [timers]
 *   Override for tests so we can spy on clearTimeout without faking timers.
 */
export function createSparkRerender(sidebar, delayMs, timers = {}) {
  const _setTimeout = timers.setTimeout ?? setTimeout;
  const _clearTimeout = timers.clearTimeout ?? clearTimeout;
  let timer = null;
  function schedule() {
    if (timer) return;
    timer = _setTimeout(() => {
      timer = null;
      try {
        sidebar.rerender();
      } catch {
        /* sidebar may have been destroyed during teardown — safe to swallow */
      }
    }, delayMs);
  }
  function cleanup() {
    if (timer) {
      _clearTimeout(timer);
      timer = null;
    }
  }
  return { schedule, cleanup };
}

/**
 * Build a `refreshPositions(): void` function with a built-in generation
 * counter so concurrent calls discard stale responses.
 *
 * Wave 2B: switched source from `/profile.balances.countries` (country-only)
 * to `/api/v1/portfolio.items[]` (multi-token — countries + players). The
 * sidebar consumes the same `positionByAddr` Map (keyed by lowercased token
 * address), so a player token now gets a dot whenever the wallet holds a
 * positive position. Edge cases:
 *
 *   - Anonymous-boot guard kept (issue #4): no point hitting an auth-only
 *     endpoint while disconnected; sidebar is still cleared synchronously
 *     so logout immediately wipes dots.
 *   - Generation counter (issue #1) kept: concurrent calls from rapid
 *     wallet-switch resolve in arbitrary order; only the newest wins.
 *   - 401 / 402 (not premium yet, or session expired) → silently degrade
 *     to no dots. Free users see the country/player lists without any
 *     position markers. We don't surface an error.
 *
 * @param {object} deps
 * @param {() => { isConnected: boolean }} deps.getAccount
 * @param {() => Promise<{ items?: Array<{token:string, balance?:string, balanceDisplay?:number}> }>} deps.getPortfolio
 * @param {Map<string, number>} deps.positionByAddr  Mutated in place.
 * @param {{ rerender: () => void }} deps.sidebar
 * @param {(weiStr: string) => number} [deps.weiToWhole]  Override for tests.
 */
export function createPositionsRefresher({
  getAccount: _getAccount,
  getPortfolio: _getPortfolio,
  positionByAddr,
  sidebar,
  weiToWhole: _weiToWhole = weiToWhole,
}) {
  let gen = 0;
  function safeRerender() {
    try {
      sidebar.rerender();
    } catch {
      /* sidebar torn down — fine */
    }
  }
  function refreshPositions() {
    // Anonymous-boot guard: no point hitting an auth-only endpoint.
    if (!_getAccount().isConnected) {
      positionByAddr.clear();
      safeRerender();
      return;
    }
    const myGen = ++gen;
    _getPortfolio()
      .then((resp) => {
        if (myGen !== gen) return;
        positionByAddr.clear();
        const items = Array.isArray(resp?.items) ? resp.items : [];
        for (const it of items) {
          if (!it || typeof it.token !== 'string' || !it.token) continue;
          // Prefer the backend-rounded *Display float; fall back to BigInt
          // path on the wei string for forward-compat with a future shape
          // change. Skip entries we can't make sense of (no balance at all).
          let bal;
          if (typeof it.balanceDisplay === 'number' && Number.isFinite(it.balanceDisplay)) {
            bal = it.balanceDisplay;
          } else if (typeof it.balance === 'string' && it.balance) {
            bal = _weiToWhole(it.balance);
          } else {
            continue;
          }
          if (!(bal > 0)) continue;
          positionByAddr.set(it.token.toLowerCase(), bal);
        }
        sidebar.rerender();
      })
      .catch(() => {
        if (myGen !== gen) return;
        // 401 / 402 / any other failure → no dots, no error surface.
        positionByAddr.clear();
        safeRerender();
      });
  }
  return refreshPositions;
}

// Exported for unit tests. The bootstrap() flow wires this into
// `onAccountChange`; tests drive the returned handler directly with deps
// injected so we can assert the synchronous access-store transitions without
// spinning up the full layout/sidebar/sse stack.
//
// Known issue #2 fix (2026-05-24): on EVERY account change we must
//   1. synchronously force-lock the premium UI by resetting the access-store
//      to `'unknown'` (soft-lock listeners react before the async /access
//      round-trip resolves — no "premium flash" window for wallet-B), and
//   2. clear the stale wallet-A `pt_session` cookie via /auth/logout, so the
//      subsequent /access call doesn't return wallet-A's `hasAccess=true`
//      under wallet-B's UI.
// The previous code skipped both steps and let access-store retain the
// wallet-A `'premium'` state until refresh() resolved — billing bypass.
export function createAccountChangeHandler({ accessBanner, deps = {} } = {}) {
  const _setAccessState = deps.setAccessState ?? setAccessState;
  const _logout = deps.logout ?? logout;
  const _getAccess = deps.getAccess ?? getAccess;
  const _showSignInModal = deps.showSignInModal ?? showSignInModal;
  const _ApiError = deps.ApiError ?? ApiError;

  let lastSignedInAddress = null;
  let modalOpen = false;
  return (acc) => {
    // Disconnect → release any session and lock UI.
    if (!acc.isConnected || !acc.address) {
      const hadPriorSession = lastSignedInAddress !== null;
      lastSignedInAddress = null;
      // refresh() sees `addr === null` and sets state synchronously to 'anon';
      // we still pre-set 'unknown' so soft-locks flip BEFORE the microtask.
      _setAccessState('unknown');
      if (hadPriorSession) {
        _logout().catch(() => {
          /* best-effort; cookie may expire anyway */
        });
      }
      accessBanner.refresh().catch(() => {
        /* surfaced via state */
      });
      return;
    }
    // Same address re-fired (e.g. chain switch reuses the connection). Just
    // refresh — the existing session is still valid and the UI shouldn't flicker.
    if (acc.address === lastSignedInAddress || modalOpen) {
      // Rapid double-switch guard (H-1): if the SIWE modal is already open for
      // wallet-A and the user switches to wallet-B before it closes, we still
      // bail out of the full re-auth flow (modalOpen is true) but the UI would
      // otherwise keep wallet-A's `'premium'` state until the modal resolves.
      // Synchronously force-lock here whenever the address actually changed.
      if (acc.address !== lastSignedInAddress) {
        _setAccessState('unknown');
      }
      accessBanner.refresh().catch(() => {
        /* surfaced via state */
      });
      return;
    }
    // Wallet switched (or first connect): synchronously force-lock + drop the
    // previous JWT before any /access call. The store will be re-published by
    // refresh()/getAccess(); during the gap the UI shows the lock.
    _setAccessState('unknown');
    const swap = lastSignedInAddress !== null && lastSignedInAddress !== acc.address;
    modalOpen = true;
    const proceed = swap
      ? _logout().catch(() => {
          /* server-side cookie clear is best-effort; if it 5xxs the
             subsequent /access will still 401 because the server rotates
             SIWE address binding on next verify, and worst case we just
             re-SIWE under the wrong address — which the user can fix by
             reconnecting. Not a regression vs. the prior behaviour. */
        })
      : Promise.resolve();
    proceed.then(() =>
      _getAccess()
        .then(() => {
          modalOpen = false;
          lastSignedInAddress = acc.address;
          accessBanner.refresh().catch(() => {
            /* surfaced via state */
          });
        })
        .catch((err) => {
          if (!(err instanceof _ApiError) || err.status !== 401) {
            modalOpen = false;
            accessBanner.refresh().catch(() => {
              /* surfaced via state */
            });
            return;
          }
          _showSignInModal({
            onSuccess: () => {
              modalOpen = false;
              lastSignedInAddress = acc.address;
              accessBanner.refresh().catch(() => {
                /* surfaced via state */
              });
            },
            onCancel: () => {
              modalOpen = false;
            },
          });
        }),
    );
  };
}

/**
 * Stale-session cleanup (security fix #6).
 *
 * Threat model: user signs in via WalletConnect on a shared/public computer,
 * gets the `pt_session` httpOnly cookie (TTL 72h), then closes the tab without
 * clicking Disconnect. The cookie persists in the browser for up to 72h. On
 * the next visit `tryAutoReconnect()` is intentionally a no-op for WC (mobile
 * WC pattern — needs a fresh QR scan), so the wallet appears disconnected —
 * but `/access` still succeeds because the cookie is alive, and any premium
 * request the browser makes would be authenticated as the previous user.
 *
 * Mitigation: on boot, after the injected-wallet reconnect has had a chance
 * to settle, detect the orphaned-cookie case (backend says authenticated +
 * wallet is NOT connected) and silently POST `/auth/logout` to clear the
 * server-side cookie. No UI banner — the user simply lands on an anonymous
 * session, which is the correct posture when no wallet is attached.
 *
 * Edge cases:
 *   - Wallet connected (any connector): leave session alone — normal flow,
 *     the cookie matches the live wallet.
 *   - `/access` returns 401 (cookie already expired/missing): nothing to do.
 *   - `/access` 5xx or network error: leave session alone (don't punish the
 *     user for transient backend hiccups; security only degrades for the
 *     short window the backend is down).
 *
 * @param {object} [deps] Injection points for tests.
 * @param {() => { isConnected: boolean }} [deps.getAccount]
 * @param {(opts?: object) => Promise<unknown>} [deps.getAccess]
 * @param {() => Promise<unknown>} [deps.logout]
 * @returns {() => Promise<void>}
 */
export function createStaleSessionCleanup(deps = {}) {
  const _getAccount = deps.getAccount ?? getAccount;
  const _getAccess = deps.getAccess ?? getAccess;
  const _logout = deps.logout ?? logout;
  return async function cleanupStaleSession() {
    // Wallet is live — the cookie (if any) belongs to this wallet. Leave it.
    if (_getAccount().isConnected) return;
    let authenticated = false;
    try {
      await _getAccess();
      // 200 OK → backend recognises the cookie. With no wallet attached this
      // means the session is orphaned from a prior tab.
      authenticated = true;
    } catch {
      // 401 / network error / 5xx → nothing to clean up (or can't tell).
      return;
    }
    if (!authenticated) return;
    try {
      await _logout();
    } catch {
      // Best-effort: if the logout call itself fails the cookie still expires
      // naturally within 72h. We don't surface this to the user.
    }
  };
}

async function bootstrapMobile(root) {
  // Minimal mobile bootstrap for Phase 1 (M-0 + M-1).
  // Track A will add wallet flow. Track C will mount components into panels.
  // This phase only proves the shell + router + nav work.
  const { mountMobileLayout } = await import('./mobile-layout.js');
  const handle = mountMobileLayout(root);
  // Rotate-past-breakpoint reload (B4 decision): if the user rotates a
  // tablet into desktop width we reload so the full desktop bootstrap takes
  // over cleanly. We don't try to live-swap the layout in place.
  let mqCleanup = () => {};
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const mq = window.matchMedia('(max-width: 1023px)');
    const onChange = (e) => {
      if (!e.matches) window.location.reload();
    };
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      mqCleanup = () => mq.removeEventListener('change', onChange);
    }
  }
  const originalDestroy = handle.destroy;
  handle.destroy = function () {
    mqCleanup();
    if (typeof originalDestroy === 'function') originalDestroy.call(handle);
  };
  return handle;
}

async function bootstrap() {
  const root = document.getElementById('app');
  if (!root) {
    console.error('PitchTerminal: #app root element not found');
    return;
  }
  // Mobile viewport — hand off to the mobile layout (Track A WalletConnect +
  // Track C component mounts). Bails BEFORE any desktop wallet / wagmi / SSE
  // init.
  if (isMobileViewport()) {
    return bootstrapMobile(root);
  }
  // Desktop viewport WITHOUT an injected wallet provider — render the
  // desktop-only stub. wagmi's `injected()` connector throws "Provider not
  // found." on contexts without `window.ethereum`, which would otherwise
  // surface as a red banner. See mobile-stub.js for the rationale.
  if (needsDesktopStub()) {
    mountMobileStub(root);
    return;
  }
  // F0.12a: parse `?ref=` and resolve it asynchronously. Fire-and-forget —
  // pay-flow reads `localStorage.referralWallet` lazily, and the user is
  // overwhelmingly unlikely to click "Pay" in the few hundred ms it takes
  // to resolve a handle.
  bootstrapReferral().catch(() => {
    /* already swallowed inside, but guard against future refactors */
  });
  const layout = mountLayout(root);

  // Version-check banner: mounts into the header's center slot on
  // backend↔bundle SHA mismatch. No-op when running a "dev" bundle (local
  // builds without a real APP_VERSION).
  const headerCenter = layout.header.querySelector('[data-test-id="header-center"]');
  if (headerCenter) {
    mountVersionCheck(headerCenter, { getConfig });
  }

  const chartZone = document.createElement('div');
  chartZone.className = 'pt-center__chart';
  chartZone.dataset.testId = 'center-chart';
  const bottomZone = document.createElement('div');
  bottomZone.className = 'pt-center__bottom';
  bottomZone.dataset.testId = 'center-bottom';
  layout.center.appendChild(chartZone);
  layout.center.appendChild(bottomZone);

  // Phase 1.5 batch 8: insert resizable drag-handles between sidebar/center
  // and chart/bottom. Mounted BEFORE mountChart so the CSS-var driven track
  // sizes are already in place when lightweight-charts measures its host.
  // Storage hydration happens inside mountResizable — when `pt.layout.v1` is
  // present in localStorage, --sidebar-w/--right-w/--chart-h are set on the
  // grid containers and chart.js's ResizeObserver picks up the new dimensions
  // on first paint. Stored under `window.__pt_resizable` for debug + teardown.
  const resizable = mountResizable({
    main: layout.main,
    sidebar: layout.sidebar,
    center: layout.center,
    right: layout.right,
    chart: chartZone,
    bottom: bottomZone,
  });
  if (typeof window !== 'undefined') {
    window.__pt_resizable = resizable;
  }

  const chart = mountChart(chartZone);
  // F1.3 — address → token-row map for country tokens, populated from a
  // one-shot getTokens() fetch below. Used by the trade panel's "Купить
  // country" CTA: the panel hands us a lowercase address; we look up the
  // full registry row and feed it through the same chart/bottom/trade
  // setToken plumbing the sidebar uses.
  const countryTokensByAddr = new Map();
  /** @type {Map<string, object>} address (lc) → player token-registry row. */
  const playerTokensByAddr = new Map();

  function selectToken(token) {
    if (!token || typeof token.address !== 'string') return;
    chart.setToken(token);
    bottom.setToken(token.address);
    trade.setToken(token);
  }

  /**
   * Resolve a token address to a registry row (country or player) and call
   * selectToken. Used by my-wallet portfolio row clicks (Wave 2B). When the
   * registry doesn't have the row yet (race on first mount), build a minimal
   * row from the supplied meta so the click still does something useful.
   */
  function selectByAddress(addr, meta) {
    if (typeof addr !== 'string' || !addr) return;
    const key = addr.toLowerCase();
    const row =
      countryTokensByAddr.get(key) ||
      playerTokensByAddr.get(key) ||
      (meta
        ? {
            address: addr,
            symbol: meta.symbol || '',
            name: meta.symbol || addr,
            kind: meta.kind || null,
          }
        : null);
    if (!row) return;
    selectToken(row);
  }

  // Phase 1.5 batch 4 wiring — when my-wallet-tab fetches a fresh position,
  // feed the balance (display units, NOT wei) into chart.setOwnBalance so
  // the Net pos overlay line shows. Cleared to 0 on token swap / no-data.
  // Wave 2B: also forward portfolio row-clicks via onTokenSelect → selectByAddress.
  const bottom = mountBottomTabs(bottomZone, {
    onBalance: (addr, balance) => chart.setOwnBalance(addr, balance),
    onTokenSelect: (item) =>
      selectByAddress(item?.token, { symbol: item?.symbol, kind: item?.kind }),
  });

  // F1.1: Market trade panel — read-only quote in this phase. Approve/swap
  // (F1.2) will be wired in the next batch. Mounted BEFORE the soft-lock so
  // the lock overlay sits on top (DOM order) and `.pt-soft-locked > *:not(.pt-soft-lock)`
  // applies the blur to the trade panel for non-premium users.
  const trade = mountTradePanel(layout.right, {
    onCountrySwitch: async (addr) => {
      const key = (addr || '').toLowerCase();
      let row = countryTokensByAddr.get(key);
      if (!row) {
        // Race: getTokens() hasn't resolved yet (rare — sidebar usually
        // primes the registry first). Try one immediate refetch before
        // giving up so the click isn't a silent no-op.
        try {
          const data = await getTokens();
          const countries = Array.isArray(data?.countries) ? data.countries : [];
          for (const c of countries) {
            if (c && typeof c.address === 'string' && c.address) {
              countryTokensByAddr.set(c.address.toLowerCase(), c);
            }
          }
          row = countryTokensByAddr.get(key);
        } catch {
          /* fall through to toast */
        }
      }
      if (!row) {
        showToast('Country token not found. Please reload the page.', { kind: 'error' });
        return;
      }
      selectToken(row);
    },
  });

  // Phase 1.5 batch 3 wiring: feed sidebar with sparkline + position providers.
  //
  // Sparkline source — a per-token price ring buffer built from the SSE
  // `pt_prices` channel. We reuse the same `onPrices` payload that already
  // ticks the chart (see openOrReopenStream below), so no extra network
  // calls. Cap each series at SPARK_MAX samples; older samples drop off the
  // front. Sidebar re-renders at most once per SPARK_RERENDER_MS to avoid
  // thrashing `list.replaceChildren()` on every tick (the worker batches
  // prices, but several ticks per minute is normal).
  //
  // Position source — `/api/v1/portfolio` (Wave 2B) returns ALL owned tokens
  // (country + player), so both sidebar tabs get position dots when the
  // wallet holds the token. Loaded lazily on first wallet-connect (so
  // anonymous users don't pay the request) and refreshed when the account
  // changes. 401/402 (not premium) → no dots, no error surface.
  const SPARK_MAX = 16;
  const SPARK_RERENDER_MS = 5000;
  /** @type {Map<string, number[]>} address (lc) → recent prices, oldest first. */
  const priceSeries = new Map();
  /** @type {Map<string, number>} address (lc) → balance (whole tokens). */
  const positionByAddr = new Map();

  function pushPrice(addrLc, price) {
    if (typeof price !== 'number' || !Number.isFinite(price)) return;
    let series = priceSeries.get(addrLc);
    if (!series) {
      series = [];
      priceSeries.set(addrLc, series);
    }
    // Drop adjacent duplicates so a flat-priced token doesn't fill the buffer
    // with identical samples and the trend stays meaningful when prices
    // finally move.
    if (series.length > 0 && series[series.length - 1] === price) return;
    series.push(price);
    if (series.length > SPARK_MAX) series.shift();
  }

  const sidebar = mountSidebar(layout.sidebar, {
    onTokenSelect: selectToken,
    getSparkline: (addr) => {
      if (typeof addr !== 'string' || !addr) return null;
      const series = priceSeries.get(addr.toLowerCase());
      // Need at least 2 points for a trend; 1 point would render as a flat
      // line at the viewBox midpoint which is visually misleading.
      return series && series.length >= 2 ? series : null;
    },
    getPosition: (addr) => {
      if (typeof addr !== 'string' || !addr) return null;
      const bal = positionByAddr.get(addr.toLowerCase());
      return typeof bal === 'number' && bal > 0 ? { balance: bal } : null;
    },
  });

  // Throttled rerender — coalesces SSE-driven price ticks. We use a trailing-
  // edge timer so the first tick after a quiet period is reflected promptly,
  // then subsequent ticks are batched. cleanup() is wired into sidebar.destroy
  // below to fix the Phase 1.5 follow-up #2 timer leak.
  const spark = createSparkRerender(sidebar, SPARK_RERENDER_MS);
  const scheduleSidebarRerender = spark.schedule;

  // Phase 1.5 follow-up issue #2: wrap sidebar.destroy so a torn-down sidebar
  // can't leak its pending rerender timer. bootstrap() doesn't itself tear
  // down sidebar today, but tests + any future SPA re-mount would otherwise
  // leave the trailing setTimeout queued — and once it fires, it calls into
  // a destroyed sidebar.
  const originalSidebarDestroy = sidebar.destroy;
  sidebar.destroy = function patchedSidebarDestroy() {
    spark.cleanup();
    if (typeof originalSidebarDestroy === 'function') {
      originalSidebarDestroy.call(sidebar);
    }
  };

  // Phase 1.5 follow-up issues #1 + #4 — generation-counted refresh that
  // also skips the request when no wallet is connected. Wave 2B: source is
  // now `/api/v1/portfolio` (multi-token) instead of `/profile.balances`
  // (country-only), so player tokens get dots too. See
  // createPositionsRefresher above for the full rationale.
  const refreshPositions = createPositionsRefresher({
    getAccount,
    getPortfolio,
    positionByAddr,
    sidebar,
  });

  // Populate the country + player token registries once; same /tokens endpoint
  // the sidebar already hits, so the response is hot in the HTTP cache. The
  // player registry feeds selectByAddress (Wave 2B) so my-wallet row clicks
  // on player tokens resolve to a full token row.
  getTokens()
    .then((data) => {
      const countries = Array.isArray(data?.countries) ? data.countries : [];
      for (const c of countries) {
        if (c && typeof c.address === 'string' && c.address) {
          countryTokensByAddr.set(c.address.toLowerCase(), c);
        }
      }
      const players = Array.isArray(data?.players) ? data.players : [];
      for (const p of players) {
        if (p && typeof p.address === 'string' && p.address) {
          playerTokensByAddr.set(p.address.toLowerCase(), p);
        }
      }
    })
    .catch(() => {
      // Silent — CTA degrades to no-op if registry never loads.
    });

  // F0.13 + Phase 1.5 Batch 5: premium gating.
  //
  // - **Right (trading) zone:** the trade panel ships its own dedicated
  //   pro-cover overlay (see `trade-panel.js#renderCover`). It subscribes to
  //   access-store directly, so no soft-lock is mounted here anymore. The
  //   in-panel cover renders the full upsell card (icon + feature list + 1
  //   PITCH price + "Upgrade to Pro" button) instead of a generic blur.
  // - **Profile zone:** still uses the generic soft-lock because the profile
  //   view is mounted lazily on tab-switch and doesn't carry its own lock.
  //
  // Save the handle so the access-store subscription can be cleaned up at
  // any future re-mount (currently bootstrap runs once, but tests and a
  // potential mode-switch refactor would leak listeners without this).
  // Exposed via `window.__pt_locks` for ad-hoc debug + test teardown — the
  // shape is preserved (`rightLock` is null now) so the dev console keeps
  // working.
  const profileLock = mountSoftLock(layout.profile, {
    zone: 'profile',
    label: 'Premium — profile',
  });
  if (typeof window !== 'undefined') {
    window.__pt_locks = { rightLock: null, profileLock, tradeIsLocked: () => trade.isLocked() };
  }

  // F0.15: Profile view is mounted lazily on first "View Profile" click and
  // re-loaded on subsequent activations. Clicking a token inside profile
  // switches back to the dashboard with that token selected.
  let profileHandle = null;
  function activateProfile() {
    if (profileHandle) {
      profileHandle.reload();
    } else {
      profileHandle = mountProfile(layout.profile, {
        onTokenSelect: (token) => {
          if (!token?.address) return;
          layout.setMode('dashboard');
          chart.setToken(token);
          bottom.setToken(token.address);
        },
      });
    }
    layout.setMode('profile');
  }

  // Phase 1.5 batch 2: wire header Profile + Referral buttons (closes
  // known-issues #4 + #5). Buttons themselves are built by layout.js; we
  // attach the click handlers here so they share the live activateProfile()
  // + api / wallet plumbing.
  const profileBtn = layout.header.querySelector('[data-test-id="header-profile-btn"]');
  const referralBtn = layout.header.querySelector('[data-test-id="header-referral-btn"]');
  if (profileBtn instanceof HTMLElement && referralBtn instanceof HTMLElement) {
    mountHeaderActions({
      profileBtn,
      referralBtn,
      onProfile: activateProfile,
    });
  }

  // Onboarding: header "?" re-opens the welcome modal; first-visit auto-open
  // happens once per browser via localStorage flag (pt:onboarded:v1).
  const helpBtn = layout.header.querySelector('[data-test-id="header-help-btn"]');
  if (helpBtn instanceof HTMLElement) {
    helpBtn.addEventListener('click', () => {
      try {
        showOnboardingModal();
      } catch (err) {
        console.error('help click: showOnboardingModal failed', err);
      }
    });
  }
  try {
    maybeShowOnboarding();
  } catch (err) {
    console.error('maybeShowOnboarding failed', err);
  }

  // Logo click → exit Profile back to dashboard. Without this the only way
  // out of Profile mode was a full page reload.
  const logoBtn = layout.header.querySelector('[data-test-id="header-logo"]');
  if (logoBtn instanceof HTMLElement) {
    logoBtn.addEventListener('click', () => {
      try {
        layout.setMode('dashboard');
      } catch (err) {
        console.error('logo click: setMode failed', err);
      }
    });
  }

  // F0.9/F0.10: header wallet area. We need `/config` for the WC projectId
  // before mounting so the picker shows/hides the WC entry deterministically.
  // If `/config` fails, fall back to injected-only.
  const walletArea = layout.header.querySelector('[data-test-id="wallet-area"]');
  if (walletArea instanceof HTMLElement) {
    getConfig()
      .catch(() => null)
      .then((cfg) => {
        const wcProjectId = cfg?.walletConnect?.projectId ?? '';
        // F0.12c: seed the config-store with the baseline values from REST so
        // subscribers (price banner, pay-flow) have data BEFORE the first SSE
        // `event: config` arrives.
        if (cfg) {
          mergeConfig({
            accessPriceWei: cfg.accessPriceWei ?? null,
            buyerDiscountBps: cfg.buyerDiscountBps ?? null,
            referralBps: cfg.referralBps ?? null,
          });
        }
        mountWalletChip(walletArea, {
          wcProjectId,
          onViewProfile: activateProfile,
        });
      });
  }

  // F0.12: mount the pay-banner into `layout.banner`. The banner is empty
  // for anonymous + premium users (CSS collapses the strip) — only free,
  // signed-in users see the "Pay" CTA. Wallet/session changes trigger
  // `refresh()` via the `onAccountChange` listener below.
  const accessBanner = mountAccessBanner(layout.banner, {
    onPaid: () => {
      // Re-open SSE so the (future) premium `orders` channel attaches.
      reopenStream();
    },
  });

  // F0.11: after a successful wallet connect, ensure we have a valid backend
  // session. If `/access` returns 200 the cookie is still valid (refresh /
  // re-connect during 72h TTL) and we skip the SIWE popup; on 401 we open the
  // modal. We don't auto-popup on any other status (5xx / network) — let the
  // user retry via wallet menu when backend recovers. See
  // `createAccountChangeHandler` above for the full state-machine docs.
  onAccountChange(createAccountChangeHandler({ accessBanner }));
  // Phase 1.5 batch 3 + Wave 2B: refresh position dots whenever the wallet
  // flips. Disconnect → /portfolio 401 → positionByAddr cleared, dots vanish.
  // Connect → /portfolio resolves with the new wallet's country + player holdings.
  // Runs as a separate listener so it stays independent of the SIWE/access
  // state machine in createAccountChangeHandler (which has its own race
  // semantics we don't want to entangle with).
  onAccountChange(() => {
    refreshPositions();
  });
  // Phase 1.5 batch 4: keep chart's My/Others filter and Avg/Net-pos
  // overlays in sync with the active wallet. `setOwnAddress(null)` on
  // disconnect also clears the chart's internal balance map (Net pos line
  // disappears cleanly). Balances themselves (chart.setOwnBalance) are
  // not plumbed yet — follow-up wires bottom.setToken → chart.setOwnBalance.
  onAccountChange((acc) => {
    chart.setOwnAddress(acc?.address ?? null);
  });
  // Kick positions once on boot so a returning user (cookie still valid)
  // sees their dots on first paint instead of after the next wallet event.
  refreshPositions();
  // Suppress unused-import warning — `ensureSignedIn` is re-exported here for
  // ad-hoc retry from other UI surfaces (e.g. premium-locked action buttons).
  void ensureSignedIn;

  // Security fix #6 — stale WalletConnect session cleanup. Await the injected
  // wallet's silent reconnect (idempotent w.r.t. the parallel call from
  // wallet-chip — wagmi's `reconnect()` is debounced internally) so that
  // `getAccount().isConnected` is accurate before we decide whether the cookie
  // is orphaned. See `createStaleSessionCleanup` for the full rationale.
  // Fire-and-forget — bootstrap doesn't block on this and any failure is
  // silently swallowed inside the cleanup helper.
  const cleanupStaleSession = createStaleSessionCleanup();
  tryAutoReconnect()
    .catch(() => {
      /* no prior injected session — that's fine, we still want to run the
         cleanup (an orphaned cookie can exist without any wagmi state). */
    })
    .then(() => cleanupStaleSession());

  let streamHandle = null;
  function openOrReopenStream() {
    if (typeof globalThis.EventSource !== 'function') return;
    streamHandle = openStream({
      onPrices: (payload) => {
        let touched = false;
        for (const t of payload?.tokens ?? []) {
          if (t?.address && t.pricePitch != null) {
            const price = Number(t.pricePitch);
            // Pass both denominations to the chart so it can pick the one
            // matching the active unit toggle. priceCountry is only present
            // for player tokens (api-spec §8.3); falls back to NaN-safe
            // handling inside chart.applyPrice for countries / missing
            // values. Fixes: player-token chart in country units jumped to
            // PITCH on live ticks.
            const priceCountry = t.priceCountry != null ? Number(t.priceCountry) : undefined;
            chart.applyPrice(t.address, { pricePitch: price, priceCountry });
            // Phase 1.5 batch 3: also feed the sidebar sparkline buffer.
            // Skip zero prices that come in during worker backfill — they'd
            // pin the whole series at zero and the sparkline would look dead.
            if (Number.isFinite(price) && price > 0) {
              pushPrice(t.address.toLowerCase(), price);
              touched = true;
            }
          }
        }
        if (touched) scheduleSidebarRerender();
      },
      onEvents: (payload) => {
        const trades = payload?.newTrades ?? [];
        if (trades.length === 0) return;
        bottom.pushTrades(trades);
        for (const trade of trades) chart.applyTrade(trade);
        // Wave 2B Task 3: forward the additive `balances` field to the
        // Holders tab so the count + per-row amounts update live without
        // waiting for a token-switch /trades refetch. No-op when the
        // backend hasn't started shipping the field yet (defensive).
        const balances = payload?.balances;
        if (Array.isArray(balances) && balances.length > 0) {
          bottom.pushBalances(balances);
        }
      },
      // F0.14: forward premium `orders` channel updates to the Orders tab.
      // The bottom tabs no-op if the Orders sub-tab hasn't been mounted yet
      // (lazy-mount on first activation); the next list-fetch will pick up
      // any missed transitions. Backend ships this channel in phase 2.
      onOrders: (payload) => {
        bottom.pushOrderUpdate(payload);
      },
      // F0.12c: after a manual reconnect the worker may have already emitted
      // an `event: config` we missed while disconnected. Re-fetch `/config`
      // and merge — the store dedups by value so an unchanged snapshot is a
      // no-op.
      onReconnect: () => {
        getConfig()
          .then((cfg) => {
            if (!cfg) return;
            mergeConfig({
              accessPriceWei: cfg.accessPriceWei ?? null,
              buyerDiscountBps: cfg.buyerDiscountBps ?? null,
              referralBps: cfg.referralBps ?? null,
            });
          })
          .catch(() => {
            /* transient — next SSE config event (or next reconnect) recovers */
          });
      },
    });
  }

  function reopenStream() {
    if (streamHandle && typeof streamHandle.close === 'function') {
      try {
        streamHandle.close();
      } catch {
        /* ignore */
      }
    }
    streamHandle = null;
    openOrReopenStream();
  }

  openOrReopenStream();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
