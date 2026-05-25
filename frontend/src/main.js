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
// Phase 1.5 batch 8: resizable panel drag-handles.
import './styles/resizable.css';
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
import { onAccountChange } from './wallet.js';
import { getConfig, getTokens, getProfile, ApiError, getAccess, logout } from './api.js';
import { bootstrapReferral } from './referral.js';
import { merge as mergeConfig } from './config-store.js';
import { set as setAccessState } from './access-store.js';
import { mountProfile } from './profile.js';
import { mountAccessBanner } from './access.js';
import { mountSoftLock } from './soft-lock.js';
import { showToast } from './ui/toast.js';
import { mountHeaderActions } from './components/header-actions.js';

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

function bootstrap() {
  const root = document.getElementById('app');
  if (!root) {
    console.error('PitchTerminal: #app root element not found');
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
  // Phase 1.5 batch 4 wiring — when my-wallet-tab fetches a fresh position,
  // feed the balance (display units, NOT wei) into chart.setOwnBalance so
  // the Net pos overlay line shows. Cleared to 0 on token swap / no-data.
  const bottom = mountBottomTabs(bottomZone, {
    onBalance: (addr, balance) => chart.setOwnBalance(addr, balance),
  });
  // F1.3 — address → token-row map for country tokens, populated from a
  // one-shot getTokens() fetch below. Used by the trade panel's "Купить
  // country" CTA: the panel hands us a lowercase address; we look up the
  // full registry row and feed it through the same chart/bottom/trade
  // setToken plumbing the sidebar uses.
  const countryTokensByAddr = new Map();

  function selectToken(token) {
    if (!token || typeof token.address !== 'string') return;
    chart.setToken(token);
    bottom.setToken(token.address);
    trade.setToken(token);
  }

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
  // Position source — `/profile.balances` resolves country tokens only
  // (backend does not return per-player balances). Loaded lazily on first
  // wallet-connect (so anonymous + free users don't pay the request) and
  // refreshed when the account changes. Missing data → no dot (graceful).
  // For per-player markers a future extension would need either a multi-
  // balance endpoint or a Multicall3 client-side path — out of scope for
  // batch 3.
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
  // edge timer so the first tick after a quiet period is reflected promptly
  // (next animation frame), then subsequent ticks are batched.
  let sparkTimer = null;
  function scheduleSidebarRerender() {
    if (sparkTimer) return;
    sparkTimer = setTimeout(() => {
      sparkTimer = null;
      try {
        sidebar.rerender();
      } catch {
        /* sidebar may have been destroyed during teardown — safe to swallow */
      }
    }, SPARK_RERENDER_MS);
  }

  // Convert backend wei-string into a whole-token number. Used for /profile
  // balances which arrive as decimal strings ("12345000000000000000" etc).
  function weiToWhole(weiStr) {
    if (typeof weiStr !== 'string' || !weiStr) return 0;
    try {
      const s = weiStr;
      if (s.length > 18) return Number(s.slice(0, s.length - 18));
      return Number(s) / 1e18;
    } catch {
      return 0;
    }
  }

  function refreshPositions() {
    // /profile requires SIWE auth — anonymous users 401. Swallow + clear so
    // disconnecting wipes the position dots that belonged to the previous
    // wallet.
    getProfile()
      .then((resp) => {
        positionByAddr.clear();
        const countries = Array.isArray(resp?.balances?.countries) ? resp.balances.countries : [];
        for (const c of countries) {
          if (c && typeof c.address === 'string' && c.address) {
            positionByAddr.set(c.address.toLowerCase(), weiToWhole(c.wei));
          }
        }
        // No per-player balances in the response — sidebar will show dots
        // for country tokens only. Players: tracked-by /trades activity
        // would need its own endpoint; deferred per batch-3 scope.
        sidebar.rerender();
      })
      .catch(() => {
        positionByAddr.clear();
        try {
          sidebar.rerender();
        } catch {
          /* fine */
        }
      });
  }

  // Populate the country-token registry once; same /tokens endpoint the
  // sidebar already hits, so the response is hot in the HTTP cache.
  getTokens()
    .then((data) => {
      const countries = Array.isArray(data?.countries) ? data.countries : [];
      for (const c of countries) {
        if (c && typeof c.address === 'string' && c.address) {
          countryTokensByAddr.set(c.address.toLowerCase(), c);
        }
      }
    })
    .catch(() => {
      // Silent — CTA degrades to no-op if registry never loads.
    });

  // F0.13: blur + lock the right-side trading panel for non-premium users.
  // The trade-panel (mounted above) provides the actual content; the soft-lock
  // overlay sits on top and blurs the panel until the user becomes premium.
  // The Profile zone gets its own soft-lock since mode-profile hides .pt-right
  // via CSS.
  //
  // Save the handles so the access-store subscriptions can be cleaned up at
  // any future re-mount (currently bootstrap runs once, but tests and a
  // potential mode-switch refactor would leak listeners without this).
  // Exposed via `window.__pt_locks` for ad-hoc debug + test teardown.
  const rightLock = mountSoftLock(layout.right, {
    zone: 'right',
    label: 'Premium — trading panel',
  });
  const profileLock = mountSoftLock(layout.profile, {
    zone: 'profile',
    label: 'Premium — profile',
  });
  if (typeof window !== 'undefined') {
    window.__pt_locks = { rightLock, profileLock };
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
  // Phase 1.5 batch 3: refresh position dots whenever the wallet flips.
  // Disconnect → /profile 401 → positionByAddr cleared, dots vanish.
  // Connect → /profile resolves with the new wallet's country balances.
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

  let streamHandle = null;
  function openOrReopenStream() {
    if (typeof globalThis.EventSource !== 'function') return;
    streamHandle = openStream({
      onPrices: (payload) => {
        let touched = false;
        for (const t of payload?.tokens ?? []) {
          if (t?.address && t.pricePitch != null) {
            const price = Number(t.pricePitch);
            chart.applyPrice(t.address, price);
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
