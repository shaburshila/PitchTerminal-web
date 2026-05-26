/**
 * Wallet chip in the header (F0.9 + F0.10).
 *
 * Renders one of two states:
 *   - disconnected → "Connect Wallet" button; click triggers a tiny picker
 *     (Injected vs WalletConnect, the latter hidden if no projectId).
 *   - connected → chip with shortened EIP-55 address; click opens a dropdown
 *     with "View Profile" and "Disconnect". When chain != Base, a red dot
 *     and "Switch to Base" button appear inline.
 *
 * The chip subscribes to `wallet.onAccountChange` so it always reflects
 * current state. UI is built imperatively (no innerHTML with user data —
 * the address is the only dynamic string, set via textContent).
 *
 * Public API:
 *   mountWalletChip(container, opts?) -> { destroy }
 *
 * `opts.onViewProfile()` is invoked when the user picks "View Profile".
 * `opts.wcProjectId` is forwarded to wallet.setWalletConnectProjectId
 * (caller already read /config, so we don't re-fetch it here).
 */

import { getAddress } from 'viem';
import {
  getAccount,
  onAccountChange,
  connectWallet,
  disconnectWallet,
  switchToBase,
  setWalletConnectProjectId,
  isOnBase,
  CONNECTOR_INJECTED,
  CONNECTOR_WALLET_CONNECT,
  tryAutoReconnect,
} from '../wallet.js';
import { isMobileBrowser, hasInjectedProvider } from '../wallet-deep-links.js';
import { openWcMobileModal } from './wallet-connect-modal.js';
import { showToast } from './toast.js';

function el(tag, { className, dataset, attrs, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (dataset) for (const [k, v] of Object.entries(dataset)) node.dataset[k] = v;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function shortAddr(addr) {
  if (!addr || addr.length < 10) return addr || '';
  try {
    const checksum = getAddress(addr);
    return `${checksum.slice(0, 6)}…${checksum.slice(-4)}`;
  } catch {
    // Fallback if `addr` isn't a valid 20-byte hex (e.g. test stub).
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  }
}

/**
 * @param {HTMLElement} container  the right-side header zone
 * @param {{
 *   onViewProfile?: () => void,
 *   wcProjectId?: string,
 *   autoReconnect?: boolean,
 * }} [opts]
 */
export function mountWalletChip(container, opts = {}) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('mountWalletChip: container must be an HTMLElement');
  }
  container.replaceChildren();

  if (typeof opts.wcProjectId === 'string') {
    setWalletConnectProjectId(opts.wcProjectId);
  }
  const wcEnabled = typeof opts.wcProjectId === 'string' && opts.wcProjectId.trim() !== '';

  // ── DOM ────────────────────────────────────────────────────────────────
  const wrap = el('div', {
    className: 'pt-wallet-area',
    dataset: { testId: 'wallet-chip-wrap' },
  });

  // Disconnected view: a primary "Connect" button + lazy connector picker.
  const connectBtn = el('button', {
    className: 'pt-btn pt-btn--primary',
    dataset: { testId: 'wallet-connect-btn' },
    attrs: { type: 'button' },
    text: 'Connect wallet',
  });

  // Picker — hidden by default, opened by clicking `connectBtn` when WC is
  // available (otherwise we connect injected directly).
  const picker = el('div', {
    className: 'pt-wallet-dropdown',
    dataset: { testId: 'wallet-connector-picker' },
    attrs: { role: 'menu' },
  });
  picker.hidden = true;
  const pickInjected = el('button', {
    className: 'pt-wallet-dropdown__item',
    dataset: { testId: 'wallet-pick-injected' },
    attrs: { type: 'button', role: 'menuitem' },
    text: 'MetaMask / Brave / Coinbase',
  });
  const pickWc = el('button', {
    className: 'pt-wallet-dropdown__item',
    dataset: { testId: 'wallet-pick-wc' },
    attrs: { type: 'button', role: 'menuitem' },
    text: 'WalletConnect (QR)',
  });
  picker.appendChild(pickInjected);
  if (wcEnabled) picker.appendChild(pickWc);

  // Connected view: chip + dropdown.
  // Phase 1.5 batch 7: dot + address + chevron, with a status-dot replacing
  // the abstract avatar from the mockup (we don't generate identicons yet —
  // the colored dot still communicates online/wrong-network).
  const chip = el('button', {
    className: 'pt-wallet-chip',
    dataset: { testId: 'wallet-chip' },
    attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
  });
  const chipDot = el('span', {
    className: 'pt-wallet-chip__dot',
    dataset: { testId: 'wallet-chip-dot' },
  });
  const chipText = el('span', {
    className: 'pt-wallet-chip__text',
    dataset: { testId: 'wallet-chip-text' },
    text: '',
  });
  const chipChev = el('span', {
    className: 'pt-wallet-chip__chev',
    attrs: { 'aria-hidden': 'true' },
    text: '▾',
  });
  chip.appendChild(chipDot);
  chip.appendChild(chipText);
  chip.appendChild(chipChev);
  chip.hidden = true;

  const switchBtn = el('button', {
    className: 'pt-wallet-chip__switch',
    dataset: { testId: 'wallet-switch-btn' },
    attrs: { type: 'button' },
    text: 'Switch to Base',
  });
  switchBtn.hidden = true;

  const dropdown = el('div', {
    className: 'pt-wallet-dropdown pt-wallet-dropdown--connected',
    dataset: { testId: 'wallet-dropdown' },
    attrs: { role: 'menu' },
  });
  dropdown.hidden = true;

  // Phase 1.5 batch 7: dropdown header with full address + copy button.
  // The address span is updated by `render()` so it always reflects the
  // currently-connected wallet.
  const ddHeader = el('div', { className: 'pt-wallet-dropdown__header' });
  const ddAddr = el('span', {
    className: 'pt-wallet-dropdown__addr',
    dataset: { testId: 'wallet-dropdown-addr' },
    text: '',
  });
  const ddCopy = el('button', {
    className: 'pt-wallet-dropdown__copy',
    dataset: { testId: 'wallet-dropdown-copy' },
    attrs: { type: 'button', 'aria-label': 'Copy address' },
    text: 'Copy',
  });
  ddHeader.appendChild(ddAddr);
  ddHeader.appendChild(ddCopy);
  dropdown.appendChild(ddHeader);

  const viewProfile = el('button', {
    className: 'pt-wallet-dropdown__item',
    dataset: { testId: 'wallet-view-profile' },
    attrs: { type: 'button', role: 'menuitem' },
    text: 'Profile',
  });
  const disconnectItem = el('button', {
    className: 'pt-wallet-dropdown__item',
    dataset: { testId: 'wallet-disconnect' },
    attrs: { type: 'button', role: 'menuitem' },
    text: 'Disconnect',
  });
  dropdown.appendChild(viewProfile);
  dropdown.appendChild(disconnectItem);

  // Container holding the connected chip and its dropdown so we can position
  // the dropdown relative to the chip via CSS (`position: absolute`).
  const chipBox = el('div', { className: 'pt-wallet-chip-box' });
  chipBox.style.position = 'relative';
  chipBox.appendChild(chip);
  chipBox.appendChild(dropdown);
  chipBox.appendChild(switchBtn);

  // Picker is positioned relative to the connect button.
  const pickerBox = el('div', { className: 'pt-wallet-connect-box' });
  pickerBox.style.position = 'relative';
  pickerBox.appendChild(connectBtn);
  pickerBox.appendChild(picker);

  wrap.appendChild(pickerBox);
  wrap.appendChild(chipBox);
  container.appendChild(wrap);

  // ── Behaviour ──────────────────────────────────────────────────────────
  function closeAllMenus() {
    if (!picker.hidden) {
      picker.hidden = true;
    }
    if (!dropdown.hidden) {
      dropdown.hidden = true;
      chip.setAttribute('aria-expanded', 'false');
    }
  }

  function render() {
    const acc = getAccount();
    if (acc.isConnected && acc.address) {
      pickerBox.hidden = true;
      chipBox.hidden = false;
      chip.hidden = false;
      chipText.textContent = shortAddr(acc.address);
      // Phase 1.5 batch 7: full address in the dropdown header.
      try {
        ddAddr.textContent = getAddress(acc.address);
      } catch {
        ddAddr.textContent = acc.address;
      }
      if (isOnBase()) {
        chipDot.classList.remove('pt-wallet-chip__dot--wrong');
        switchBtn.hidden = true;
      } else {
        chipDot.classList.add('pt-wallet-chip__dot--wrong');
        switchBtn.hidden = false;
      }
    } else {
      pickerBox.hidden = false;
      chipBox.hidden = true;
      chip.hidden = true;
      switchBtn.hidden = true;
      closeAllMenus();
    }
  }

  async function doConnect(connectorId) {
    picker.hidden = true;
    try {
      await connectWallet(connectorId);
    } catch (e) {
      const msg =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Failed to connect';
      showToast(msg, { kind: 'error' });
    }
  }

  function onConnectClick() {
    // Mobile browser without an injected provider: skip the desktop picker
    // and open the WalletConnect bottom-sheet. The deep-link list is the
    // only UI that makes sense — there is no extension to fall back on, and
    // a stock `wc:` URI alone doesn't reliably trigger any app on iOS.
    if (wcEnabled && isMobileBrowser() && !hasInjectedProvider()) {
      openWcMobileModal({
        onConnected: () => {
          // wallet.js state listener will re-render this chip; nothing to
          // do here. We don't toast — the chip flip is signal enough.
        },
        onCancel: () => {},
      });
      return;
    }
    // If only one option is available, skip the picker entirely.
    if (!wcEnabled) {
      void doConnect(CONNECTOR_INJECTED);
      return;
    }
    picker.hidden = !picker.hidden;
  }

  function onPickInjected() {
    void doConnect(CONNECTOR_INJECTED);
  }
  function onPickWc() {
    void doConnect(CONNECTOR_WALLET_CONNECT);
  }

  function onChipClick() {
    const willOpen = dropdown.hidden;
    dropdown.hidden = !willOpen;
    chip.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  }

  function onViewProfileClick() {
    dropdown.hidden = true;
    chip.setAttribute('aria-expanded', 'false');
    if (typeof opts.onViewProfile === 'function') {
      opts.onViewProfile();
    } else {
      // TODO(F0.15): wire to layout.setMode('profile') once Profile view exists.
      showToast('Profile — coming soon', { kind: 'info' });
    }
  }

  async function onDisconnectClick() {
    dropdown.hidden = true;
    chip.setAttribute('aria-expanded', 'false');
    try {
      await disconnectWallet();
    } catch {
      // best-effort
    }
  }

  async function onCopyClick(ev) {
    // Don't bubble up — outside-click handler would close the dropdown.
    if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
    const addr = ddAddr.textContent || '';
    if (!addr) return;
    try {
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function'
      ) {
        await navigator.clipboard.writeText(addr);
      }
    } catch {
      // best-effort — no toast (the user can read the address in-place).
    }
  }

  async function onSwitchClick() {
    try {
      await switchToBase();
    } catch (e) {
      const msg =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Switch failed';
      showToast(msg, { kind: 'error' });
    }
  }

  // Close dropdowns on outside click. Listener lives on document so the
  // dropdown closes even when the click lands outside `wrap`.
  function onDocClick(ev) {
    if (!(ev.target instanceof Node)) return;
    if (wrap.contains(ev.target)) return;
    closeAllMenus();
  }

  function onDocKey(ev) {
    if (ev.key === 'Escape') closeAllMenus();
  }

  connectBtn.addEventListener('click', onConnectClick);
  pickInjected.addEventListener('click', onPickInjected);
  pickWc.addEventListener('click', onPickWc);
  chip.addEventListener('click', onChipClick);
  viewProfile.addEventListener('click', onViewProfileClick);
  disconnectItem.addEventListener('click', onDisconnectClick);
  switchBtn.addEventListener('click', onSwitchClick);
  ddCopy.addEventListener('click', onCopyClick);
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKey);

  const unsubscribe = onAccountChange(render);
  render();

  // Best-effort silent reconnect on mount (injected only).
  if (opts.autoReconnect !== false) {
    tryAutoReconnect().catch(() => {});
  }

  function destroy() {
    connectBtn.removeEventListener('click', onConnectClick);
    pickInjected.removeEventListener('click', onPickInjected);
    pickWc.removeEventListener('click', onPickWc);
    chip.removeEventListener('click', onChipClick);
    viewProfile.removeEventListener('click', onViewProfileClick);
    disconnectItem.removeEventListener('click', onDisconnectClick);
    switchBtn.removeEventListener('click', onSwitchClick);
    ddCopy.removeEventListener('click', onCopyClick);
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onDocKey);
    unsubscribe();
    container.replaceChildren();
  }

  return { destroy };
}
