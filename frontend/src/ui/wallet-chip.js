/**
 * Wallet chip in the header (F0.9 + F0.10).
 *
 * Renders one of two states:
 *   - disconnected → "Connect Wallet" button; click opens the AppKit modal
 *     (Reown), which handles all wallet picking — injected on desktop,
 *     deep-links on mobile, QR code as fallback.
 *   - connected → chip with shortened EIP-55 address; click opens a dropdown
 *     with a single "Disconnect" item. When chain != Base, a red dot and
 *     "Switch to Base" button appear inline.
 *
 * The chip subscribes to `wallet.onAccountChange` so it always reflects
 * current state. UI is built imperatively (no innerHTML with user data —
 * the address is the only dynamic string, set via textContent).
 *
 * Public API:
 *   mountWalletChip(container, opts?) -> { destroy }
 *
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
  tryAutoReconnect,
} from '../wallet.js';
import { logout } from '../api.js';
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

  // ── DOM ────────────────────────────────────────────────────────────────
  const wrap = el('div', {
    className: 'pt-wallet-area',
    dataset: { testId: 'wallet-chip-wrap' },
  });

  // Disconnected view: a primary "Connect" button. The picker UX itself lives
  // inside the AppKit modal — no per-app picker DOM here anymore.
  const connectBtn = el('button', {
    className: 'pt-btn pt-btn--primary',
    dataset: { testId: 'wallet-connect-btn' },
    attrs: { type: 'button' },
    text: 'Connect wallet',
  });

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

  // Connected dropdown — single "Disconnect" item. Address + copy were
  // removed 2026-05-27 per user feedback (juniors found the row noisy on
  // mobile, and the full address is rarely useful here).
  const disconnectItem = el('button', {
    className: 'pt-wallet-dropdown__item',
    dataset: { testId: 'wallet-disconnect' },
    attrs: { type: 'button', role: 'menuitem' },
    text: 'Disconnect',
  });
  dropdown.appendChild(disconnectItem);

  // Container holding the connected chip and its dropdown so we can position
  // the dropdown relative to the chip via CSS (`position: absolute`).
  const chipBox = el('div', { className: 'pt-wallet-chip-box' });
  chipBox.style.position = 'relative';
  chipBox.appendChild(chip);
  chipBox.appendChild(dropdown);
  chipBox.appendChild(switchBtn);

  // Connect button host — no in-app picker DOM; AppKit owns it.
  const connectBox = el('div', { className: 'pt-wallet-connect-box' });
  connectBox.style.position = 'relative';
  connectBox.appendChild(connectBtn);

  wrap.appendChild(connectBox);
  wrap.appendChild(chipBox);
  container.appendChild(wrap);

  // ── Behaviour ──────────────────────────────────────────────────────────
  function closeDropdown() {
    if (!dropdown.hidden) {
      dropdown.hidden = true;
      chip.setAttribute('aria-expanded', 'false');
    }
  }

  function render() {
    const acc = getAccount();
    if (acc.isConnected && acc.address) {
      connectBox.hidden = true;
      chipBox.hidden = false;
      chip.hidden = false;
      chipText.textContent = shortAddr(acc.address);
      if (isOnBase()) {
        chipDot.classList.remove('pt-wallet-chip__dot--wrong');
        switchBtn.hidden = true;
      } else {
        chipDot.classList.add('pt-wallet-chip__dot--wrong');
        switchBtn.hidden = false;
      }
    } else {
      connectBox.hidden = false;
      chipBox.hidden = true;
      chip.hidden = true;
      switchBtn.hidden = true;
      closeDropdown();
    }
  }

  async function onConnectClick() {
    // AppKit's modal is the entire picker UX — desktop QR, mobile deep-links,
    // injected detection. Errors here are usually projectId/network setup
    // issues we want surfaced via toast.
    try {
      await connectWallet();
    } catch (e) {
      const msg =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Failed to connect';
      showToast(msg, { kind: 'error' });
    }
  }

  function onChipClick() {
    const willOpen = dropdown.hidden;
    dropdown.hidden = !willOpen;
    chip.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  }

  async function onDisconnectClick() {
    dropdown.hidden = true;
    chip.setAttribute('aria-expanded', 'false');
    try {
      await disconnectWallet();
    } catch {
      // best-effort
    }
    // Clear the backend session on a DELIBERATE disconnect. AppKit's
    // `signOutOnDisconnect` was turned OFF (it falsely fired on page-reload's
    // transient disconnect and wiped the still-valid session), so the explicit
    // Disconnect button now owns the server-side logout. This path is only
    // reached by a real user click — never on reload — so it can't recreate the
    // reload-logout bug. Best-effort: a failed POST just leaves an orphan cookie
    // that createStaleSessionCleanup sweeps on the next load.
    try {
      await logout();
    } catch {
      // best-effort
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

  // Close dropdown on outside click. Listener lives on document so the
  // dropdown closes even when the click lands outside `wrap`.
  function onDocClick(ev) {
    if (!(ev.target instanceof Node)) return;
    if (wrap.contains(ev.target)) return;
    closeDropdown();
  }

  function onDocKey(ev) {
    if (ev.key === 'Escape') closeDropdown();
  }

  connectBtn.addEventListener('click', onConnectClick);
  chip.addEventListener('click', onChipClick);
  disconnectItem.addEventListener('click', onDisconnectClick);
  switchBtn.addEventListener('click', onSwitchClick);
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKey);

  const unsubscribe = onAccountChange(render);
  render();

  // Best-effort silent reconnect on mount. AppKit's own enableReconnect=true
  // covers most cases; this is a no-op when AppKit hasn't been primed.
  if (opts.autoReconnect !== false) {
    tryAutoReconnect().catch(() => {});
  }

  function destroy() {
    connectBtn.removeEventListener('click', onConnectClick);
    chip.removeEventListener('click', onChipClick);
    disconnectItem.removeEventListener('click', onDisconnectClick);
    switchBtn.removeEventListener('click', onSwitchClick);
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onDocKey);
    unsubscribe();
    container.replaceChildren();
  }

  return { destroy };
}
