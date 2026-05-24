import './styles.css';
import { mountLayout } from './layout.js';
import { mountSidebar } from './sidebar.js';
import { mountChart } from './chart.js';
import { mountBottomTabs } from './components/bottom/index.js';
import { mountTradePanel } from './trade-panel.js';
import { openStream } from './sse.js';
import { mountWalletChip } from './ui/wallet-chip.js';
import { showSignInModal } from './ui/signin-modal.js';
import { ensureSignedIn } from './siwe.js';
import { onAccountChange } from './wallet.js';
import { getConfig, ApiError, getAccess } from './api.js';
import { bootstrapReferral } from './referral.js';
import { merge as mergeConfig } from './config-store.js';
import { mountProfile } from './profile.js';
import { mountAccessBanner } from './access.js';
import { mountSoftLock } from './soft-lock.js';

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

  const chart = mountChart(chartZone);
  const bottom = mountBottomTabs(bottomZone);
  // F1.1: Market trade panel — read-only quote in this phase. Approve/swap
  // (F1.2) will be wired in the next batch. Mounted BEFORE the soft-lock so
  // the lock overlay sits on top (DOM order) and `.pt-soft-locked > *:not(.pt-soft-lock)`
  // applies the blur to the trade panel for non-premium users.
  const trade = mountTradePanel(layout.right);

  mountSidebar(layout.sidebar, {
    onTokenSelect: (token) => {
      chart.setToken(token);
      bottom.setToken(token.address);
      trade.setToken(token);
    },
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
    label: 'Premium — торговая панель',
  });
  const profileLock = mountSoftLock(layout.profile, {
    zone: 'profile',
    label: 'Premium — профиль',
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
  // user retry via wallet menu when backend recovers.
  let lastSignedInAddress = null;
  let modalOpen = false;
  onAccountChange((acc) => {
    if (!acc.isConnected || !acc.address) {
      lastSignedInAddress = null;
      accessBanner.refresh().catch(() => { /* surfaced via state */ });
      return;
    }
    if (acc.address === lastSignedInAddress || modalOpen) {
      accessBanner.refresh().catch(() => { /* surfaced via state */ });
      return;
    }
    modalOpen = true;
    getAccess()
      .then(() => {
        modalOpen = false;
        lastSignedInAddress = acc.address;
        accessBanner.refresh().catch(() => { /* surfaced via state */ });
      })
      .catch((err) => {
        if (!(err instanceof ApiError) || err.status !== 401) {
          modalOpen = false;
          accessBanner.refresh().catch(() => { /* surfaced via state */ });
          return;
        }
        showSignInModal({
          onSuccess: () => {
            modalOpen = false;
            lastSignedInAddress = acc.address;
            accessBanner.refresh().catch(() => { /* surfaced via state */ });
          },
          onCancel: () => {
            modalOpen = false;
          },
        });
      });
  });
  // Suppress unused-import warning — `ensureSignedIn` is re-exported here for
  // ad-hoc retry from other UI surfaces (e.g. premium-locked action buttons).
  void ensureSignedIn;

  let streamHandle = null;
  function openOrReopenStream() {
    if (typeof globalThis.EventSource !== 'function') return;
    streamHandle = openStream({
      onPrices: (payload) => {
        for (const t of payload?.tokens ?? []) {
          if (t?.address && t.pricePitch != null) {
            chart.applyPrice(t.address, Number(t.pricePitch));
          }
        }
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
      try { streamHandle.close(); } catch { /* ignore */ }
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
