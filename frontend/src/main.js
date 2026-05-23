import './styles.css';
import { mountLayout } from './layout.js';
import { mountSidebar } from './sidebar.js';
import { mountChart } from './chart.js';
import { mountBottomTabs } from './components/bottom/index.js';
import { openStream } from './sse.js';
import { mountWalletChip } from './ui/wallet-chip.js';
import { getConfig } from './api.js';

function bootstrap() {
  const root = document.getElementById('app');
  if (!root) {
    console.error('PitchTerminal: #app root element not found');
    return;
  }
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

  mountSidebar(layout.sidebar, {
    onTokenSelect: (token) => {
      chart.setToken(token);
      bottom.setToken(token.address);
    },
  });

  // F0.9/F0.10: header wallet area. We need `/config` for the WC projectId
  // before mounting so the picker shows/hides the WC entry deterministically.
  // If `/config` fails, fall back to injected-only.
  const walletArea = layout.header.querySelector('[data-test-id="wallet-area"]');
  if (walletArea instanceof HTMLElement) {
    getConfig()
      .catch(() => null)
      .then((cfg) => {
        const wcProjectId = cfg?.walletConnect?.projectId ?? '';
        mountWalletChip(walletArea, {
          wcProjectId,
          onViewProfile: () => layout.setMode('profile'),
        });
      });
  }

  if (typeof globalThis.EventSource === 'function') {
    openStream({
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
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
