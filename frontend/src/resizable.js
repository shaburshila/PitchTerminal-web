// Phase 1.5 batch 8 — resizable dashboard panels.
//
// Wires three drag-handles into the existing layout WITHOUT touching the
// internals of chart.js / trade-panel.js / bottom tabs:
//
//   1. between .pt-sidebar and .pt-center   (vertical, col-resize)
//   2. between .pt-center__chart and .pt-center__bottom (horizontal, row-resize)
//   3. between .pt-center and .pt-right     (vertical, col-resize)
//
// Sizes are persisted to localStorage under `pt.layout.v1`. On load we hydrate
// the inline CSS variables on .pt-main / .pt-center; chart.js + trade-panel
// pick up the new dimensions via their existing ResizeObserver / autoSize
// plumbing.
//
// Public API:
//   mountResizable({ main, sidebar, center, right, chart, bottom, storage? })
//     → { destroy() }
//
// `storage` defaults to window.localStorage but can be injected for tests.
//
// Persistence shape (pt.layout.v1):
//   { v: 1, sidebarW: number, rightW: number, chartH: number | null }
//
// `chartH === null` means "auto" — chart takes remaining space (default).
// Once the user drags the horizontal handle, chartH is committed in px and
// the bottom row becomes the 1fr filler. Resetting (currently no UI, but the
// localStorage key can be removed manually) reverts to auto on next reload.

const STORAGE_KEY = 'pt.layout.v1';
const STORAGE_VERSION = 1;

// Constraints (px). Chosen so neither panel can be hidden to 0 and the layout
// remains usable on a typical 1280-wide screen. Caller can override but we
// also clamp by viewport at drag-time so a small window doesn't blow up.
export const DEFAULTS = Object.freeze({
  sidebar: { min: 180, max: 480, def: 260 },
  right: { min: 240, max: 520, def: 320 },
  chart: { min: 200, max: 1600, def: null }, // null = auto / no manual height
  bottom: { min: 160 }, // implicit constraint via chartH max relative to host
});

/**
 * Clamp a value into [min, max].
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Validate + clamp a stored layout snapshot. Returns a sanitized object with
 * the SAME shape, or null if the snapshot is unsalvageable (caller should
 * fall back to defaults).
 *
 * Accepted as-is:
 *   { v: 1, sidebarW: number, rightW: number, chartH: number | null }
 *
 * Anything missing → filled from DEFAULTS. Wrong types in a required slot
 * (e.g. sidebarW = "abc") → null so we don't half-apply junk.
 *
 * @param {unknown} raw
 * @returns {{sidebarW: number, rightW: number, chartH: number | null} | null}
 */
export function sanitizeSnapshot(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  /** @type {{v?: unknown, sidebarW?: unknown, rightW?: unknown, chartH?: unknown}} */
  const obj = /** @type {any} */ (raw);
  // Reject future / unknown versions outright — we'd rather start fresh than
  // mis-apply a schema we don't understand.
  if (obj.v !== STORAGE_VERSION) return null;
  const sidebarW =
    typeof obj.sidebarW === 'number' && Number.isFinite(obj.sidebarW)
      ? clamp(obj.sidebarW, DEFAULTS.sidebar.min, DEFAULTS.sidebar.max)
      : DEFAULTS.sidebar.def;
  const rightW =
    typeof obj.rightW === 'number' && Number.isFinite(obj.rightW)
      ? clamp(obj.rightW, DEFAULTS.right.min, DEFAULTS.right.max)
      : DEFAULTS.right.def;
  let chartH = /** @type {number | null} */ (null);
  if (obj.chartH === null) {
    chartH = null;
  } else if (typeof obj.chartH === 'number' && Number.isFinite(obj.chartH)) {
    chartH = clamp(obj.chartH, DEFAULTS.chart.min, DEFAULTS.chart.max);
  } else {
    chartH = DEFAULTS.chart.def;
  }
  return { sidebarW, rightW, chartH };
}

/**
 * Load + sanitize from a Storage-like object. Returns defaults when missing
 * or corrupted (never throws).
 *
 * @param {Storage | null | undefined} storage
 * @returns {{sidebarW: number, rightW: number, chartH: number | null}}
 */
export function loadLayout(storage) {
  const fallback = {
    sidebarW: DEFAULTS.sidebar.def,
    rightW: DEFAULTS.right.def,
    chartH: DEFAULTS.chart.def,
  };
  if (!storage) return fallback;
  let raw;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    // SecurityError on disabled storage — fall through.
    return fallback;
  }
  if (raw == null || raw === '') return fallback;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  const ok = sanitizeSnapshot(parsed);
  return ok ?? fallback;
}

/**
 * Persist a snapshot. Best-effort — swallows quota / disabled-storage errors.
 *
 * @param {Storage | null | undefined} storage
 * @param {{sidebarW: number, rightW: number, chartH: number | null}} snapshot
 */
export function saveLayout(storage, snapshot) {
  if (!storage) return;
  const sanitized = sanitizeSnapshot({ v: STORAGE_VERSION, ...snapshot });
  if (!sanitized) return;
  try {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ v: STORAGE_VERSION, ...sanitized }),
    );
  } catch {
    /* quota / disabled — accept loss */
  }
}

export const STORAGE_KEY_INTERNAL = STORAGE_KEY;

function createHandle(orientation, ariaLabel, dataTestId) {
  const el = document.createElement('div');
  el.className = `pt-handle pt-handle--${orientation === 'vertical' ? 'v' : 'h'}`;
  el.setAttribute('role', 'separator');
  el.setAttribute('aria-orientation', orientation);
  el.setAttribute('aria-label', ariaLabel);
  el.setAttribute('tabindex', '0');
  el.dataset.testId = dataTestId;
  return el;
}

/**
 * Mount the three drag-handles + restore persisted sizes.
 *
 * @param {{
 *   main: HTMLElement,
 *   sidebar: HTMLElement,
 *   center: HTMLElement,
 *   right: HTMLElement,
 *   chart: HTMLElement,
 *   bottom: HTMLElement,
 *   storage?: Storage | null,
 *   window?: Window,
 * }} opts
 * @returns {{ destroy: () => void, getSnapshot: () => {sidebarW: number, rightW: number, chartH: number | null} }}
 */
export function mountResizable(opts) {
  const {
    main,
    sidebar,
    center,
    right,
    chart,
    bottom,
    storage = typeof globalThis !== 'undefined' ? globalThis.localStorage : null,
    window: win = typeof globalThis !== 'undefined' ? globalThis : undefined,
  } = opts;

  if (
    !(main instanceof HTMLElement) ||
    !(sidebar instanceof HTMLElement) ||
    !(center instanceof HTMLElement) ||
    !(right instanceof HTMLElement) ||
    !(chart instanceof HTMLElement) ||
    !(bottom instanceof HTMLElement)
  ) {
    throw new TypeError('mountResizable: all zones must be HTMLElements');
  }

  // Hydrate state from storage (or defaults). chartH=null means "use 1fr".
  let state = loadLayout(storage);

  main.classList.add('pt-main--resizable');
  center.classList.add('pt-center--resizable');

  applyState();

  // Build + insert the 3 handles. Sidebar↔center and center↔right live as
  // siblings inside .pt-main (grid). Chart↔bottom lives inside .pt-center
  // (grid) between the two existing children.
  const handleLeft = createHandle('vertical', 'Resize sidebar', 'handle-sidebar');
  const handleRight = createHandle('vertical', 'Resize trade panel', 'handle-right');
  const handleChart = createHandle('horizontal', 'Resize chart', 'handle-chart');

  // Insert in grid order: [sidebar][handle][center][handle][right]
  if (sidebar.nextSibling === center) {
    main.insertBefore(handleLeft, center);
  } else {
    main.insertBefore(handleLeft, sidebar.nextSibling);
  }
  if (center.nextSibling === right) {
    main.insertBefore(handleRight, right);
  } else {
    main.insertBefore(handleRight, right);
  }
  // chart→bottom: insert handle between them inside .pt-center.
  if (chart.nextSibling === bottom) {
    center.insertBefore(handleChart, bottom);
  } else {
    // Defensive: chart/bottom not direct siblings — append handle before
    // bottom anyway so the visual order is correct.
    center.insertBefore(handleChart, bottom);
  }

  // --- drag plumbing --------------------------------------------------------
  //
  // Each drag tracks: which axis + which value we're updating + the starting
  // pointer coord + the value at start. We commit to state on pointerup. To
  // avoid layout thrash during the drag we coalesce moves into a single
  // requestAnimationFrame callback.

  /** @type {{ kind: 'left' | 'right' | 'chart', startCoord: number, startValue: number, host: DOMRect | null } | null} */
  let drag = null;
  let rafId = 0;
  let pendingCoord = 0;
  let activeHandle = /** @type {HTMLElement | null} */ (null);

  function rafSchedule() {
    if (!win || typeof win.requestAnimationFrame !== 'function') {
      applyDrag();
      return;
    }
    if (rafId) return;
    rafId = win.requestAnimationFrame(() => {
      rafId = 0;
      applyDrag();
    });
  }

  function applyDrag() {
    if (!drag) return;
    const delta = pendingCoord - drag.startCoord;
    if (drag.kind === 'left') {
      const next = clamp(
        drag.startValue + delta,
        DEFAULTS.sidebar.min,
        Math.min(DEFAULTS.sidebar.max, viewportSidebarMax()),
      );
      state = { ...state, sidebarW: next };
    } else if (drag.kind === 'right') {
      // Dragging the right handle: pointer moves left → right panel grows.
      const next = clamp(
        drag.startValue - delta,
        DEFAULTS.right.min,
        Math.min(DEFAULTS.right.max, viewportRightMax()),
      );
      state = { ...state, rightW: next };
    } else if (drag.kind === 'chart') {
      const next = clamp(
        drag.startValue + delta,
        DEFAULTS.chart.min,
        Math.max(DEFAULTS.chart.min, viewportChartMax()),
      );
      state = { ...state, chartH: next };
    }
    applyState();
  }

  function viewportSidebarMax() {
    // Don't let sidebar+right consume more than 80% of main width.
    const w = main.clientWidth || 1280;
    return Math.max(DEFAULTS.sidebar.min, w - state.rightW - 240);
  }
  function viewportRightMax() {
    const w = main.clientWidth || 1280;
    return Math.max(DEFAULTS.right.min, w - state.sidebarW - 240);
  }
  function viewportChartMax() {
    const h = center.clientHeight || 720;
    // Reserve at least DEFAULTS.bottom.min for the bottom row + handle.
    return Math.max(DEFAULTS.chart.min, h - DEFAULTS.bottom.min - 6);
  }

  function applyState() {
    main.style.setProperty('--sidebar-w', `${state.sidebarW}px`);
    main.style.setProperty('--right-w', `${state.rightW}px`);
    if (state.chartH == null) {
      // Auto mode — chart fills remaining; bottom keeps its default 320px.
      center.style.setProperty('--chart-h', '1fr');
      center.style.setProperty('--bottom-h', '320px');
    } else {
      center.style.setProperty('--chart-h', `${state.chartH}px`);
      center.style.setProperty('--bottom-h', '1fr');
    }
  }

  function onPointerMove(ev) {
    if (!drag) return;
    pendingCoord = drag.kind === 'chart' ? ev.clientY : ev.clientX;
    rafSchedule();
  }

  function endDrag() {
    if (!drag) return;
    drag = null;
    if (rafId && win && typeof win.cancelAnimationFrame === 'function') {
      win.cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (activeHandle) {
      activeHandle.dataset.dragging = 'false';
      activeHandle = null;
    }
    // Persist final state (mouseup commit per spec). No debounce needed —
    // mouseup fires once per drag.
    saveLayout(storage, state);
    detachWindow();
  }

  function attachWindow() {
    if (!win || typeof win.addEventListener !== 'function') return;
    win.addEventListener('pointermove', onPointerMove);
    win.addEventListener('pointerup', endDrag);
    win.addEventListener('pointercancel', endDrag);
    win.addEventListener('blur', endDrag);
  }

  function detachWindow() {
    if (!win || typeof win.removeEventListener !== 'function') return;
    win.removeEventListener('pointermove', onPointerMove);
    win.removeEventListener('pointerup', endDrag);
    win.removeEventListener('pointercancel', endDrag);
    win.removeEventListener('blur', endDrag);
  }

  function startDrag(kind, startCoord, handle) {
    // chart kind: ensure we switch from auto → px before the first move so
    // the user sees immediate response. If chartH is still null, seed it
    // with the current chart clientHeight so dragging starts from the
    // visual current value.
    if (kind === 'chart' && state.chartH == null) {
      const initial = chart.clientHeight || center.clientHeight / 2 || 400;
      state = { ...state, chartH: initial };
      applyState();
    }
    const startValue =
      kind === 'left'
        ? state.sidebarW
        : kind === 'right'
          ? state.rightW
          : /* chart */ (state.chartH ?? chart.clientHeight ?? 400);
    drag = { kind, startCoord, startValue, host: null };
    activeHandle = handle;
    handle.dataset.dragging = 'true';
    attachWindow();
  }

  function onPointerDownLeft(ev) {
    if (ev.button !== 0 && ev.button !== undefined) return;
    ev.preventDefault();
    startDrag('left', ev.clientX, handleLeft);
  }
  function onPointerDownRight(ev) {
    if (ev.button !== 0 && ev.button !== undefined) return;
    ev.preventDefault();
    startDrag('right', ev.clientX, handleRight);
  }
  function onPointerDownChart(ev) {
    if (ev.button !== 0 && ev.button !== undefined) return;
    ev.preventDefault();
    startDrag('chart', ev.clientY, handleChart);
  }

  // Keyboard a11y — Left/Right or Up/Down arrows nudge by 16px. Persisted
  // immediately so users without pointing devices still get persistence.
  const KEY_STEP = 16;
  function onKeyDown(kind, ev) {
    let delta = 0;
    if (kind === 'chart') {
      if (ev.key === 'ArrowUp') delta = -KEY_STEP;
      else if (ev.key === 'ArrowDown') delta = KEY_STEP;
    } else {
      if (ev.key === 'ArrowLeft') delta = kind === 'left' ? -KEY_STEP : KEY_STEP;
      else if (ev.key === 'ArrowRight') delta = kind === 'left' ? KEY_STEP : -KEY_STEP;
    }
    if (delta === 0) return;
    ev.preventDefault();
    if (kind === 'left') {
      state = {
        ...state,
        sidebarW: clamp(state.sidebarW + delta, DEFAULTS.sidebar.min, DEFAULTS.sidebar.max),
      };
    } else if (kind === 'right') {
      state = {
        ...state,
        rightW: clamp(state.rightW + delta, DEFAULTS.right.min, DEFAULTS.right.max),
      };
    } else if (kind === 'chart') {
      const current = state.chartH ?? chart.clientHeight ?? 400;
      state = {
        ...state,
        chartH: clamp(current + delta, DEFAULTS.chart.min, DEFAULTS.chart.max),
      };
    }
    applyState();
    saveLayout(storage, state);
  }

  handleLeft.addEventListener('pointerdown', onPointerDownLeft);
  handleRight.addEventListener('pointerdown', onPointerDownRight);
  handleChart.addEventListener('pointerdown', onPointerDownChart);
  const onKeyLeft = (ev) => onKeyDown('left', ev);
  const onKeyRight = (ev) => onKeyDown('right', ev);
  const onKeyChart = (ev) => onKeyDown('chart', ev);
  handleLeft.addEventListener('keydown', onKeyLeft);
  handleRight.addEventListener('keydown', onKeyRight);
  handleChart.addEventListener('keydown', onKeyChart);

  function destroy() {
    endDrag();
    handleLeft.removeEventListener('pointerdown', onPointerDownLeft);
    handleRight.removeEventListener('pointerdown', onPointerDownRight);
    handleChart.removeEventListener('pointerdown', onPointerDownChart);
    handleLeft.removeEventListener('keydown', onKeyLeft);
    handleRight.removeEventListener('keydown', onKeyRight);
    handleChart.removeEventListener('keydown', onKeyChart);
    handleLeft.remove();
    handleRight.remove();
    handleChart.remove();
    main.classList.remove('pt-main--resizable');
    center.classList.remove('pt-center--resizable');
    main.style.removeProperty('--sidebar-w');
    main.style.removeProperty('--right-w');
    center.style.removeProperty('--chart-h');
    center.style.removeProperty('--bottom-h');
  }

  return {
    destroy,
    getSnapshot: () => ({ ...state }),
  };
}
