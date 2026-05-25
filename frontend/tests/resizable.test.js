// @vitest-environment happy-dom

import { describe, it, expect, beforeEach } from 'vitest';
import {
  mountResizable,
  loadLayout,
  saveLayout,
  sanitizeSnapshot,
  clamp,
  DEFAULTS,
  STORAGE_KEY_INTERNAL,
} from '../src/resizable.js';

// In-memory Storage shim — happy-dom provides one but we want isolated state
// per-test without relying on globalThis.localStorage leak between describes.
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
    clear() {
      map.clear();
    },
    key(i) {
      return Array.from(map.keys())[i] ?? null;
    },
    get length() {
      return map.size;
    },
    _raw: map,
  };
}

function buildShell() {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = 'app';
  document.body.appendChild(root);
  const main = document.createElement('main');
  main.className = 'pt-main';
  const sidebar = document.createElement('aside');
  sidebar.className = 'pt-sidebar';
  const center = document.createElement('section');
  center.className = 'pt-center';
  const right = document.createElement('aside');
  right.className = 'pt-right';
  const chart = document.createElement('div');
  chart.className = 'pt-center__chart';
  const bottom = document.createElement('div');
  bottom.className = 'pt-center__bottom';
  center.append(chart, bottom);
  main.append(sidebar, center, right);
  root.append(main);
  return { root, main, sidebar, center, right, chart, bottom };
}

describe('clamp', () => {
  it('returns value when in range', () => {
    expect(clamp(50, 0, 100)).toBe(50);
  });
  it('clamps below min', () => {
    expect(clamp(-5, 0, 100)).toBe(0);
  });
  it('clamps above max', () => {
    expect(clamp(150, 0, 100)).toBe(100);
  });
  it('returns min for NaN', () => {
    expect(clamp(Number.NaN, 10, 100)).toBe(10);
  });
});

describe('sanitizeSnapshot', () => {
  it('passes through a valid snapshot', () => {
    const out = sanitizeSnapshot({ v: 1, sidebarW: 280, rightW: 340, chartH: 500 });
    expect(out).toEqual({ sidebarW: 280, rightW: 340, chartH: 500 });
  });

  it('null chartH means auto', () => {
    const out = sanitizeSnapshot({ v: 1, sidebarW: 260, rightW: 320, chartH: null });
    expect(out?.chartH).toBeNull();
  });

  it('clamps oversized sidebarW into [min, max]', () => {
    const out = sanitizeSnapshot({ v: 1, sidebarW: 9999, rightW: 320, chartH: null });
    expect(out?.sidebarW).toBe(DEFAULTS.sidebar.max);
  });

  it('clamps undersized rightW into [min, max]', () => {
    const out = sanitizeSnapshot({ v: 1, sidebarW: 260, rightW: 50, chartH: null });
    expect(out?.rightW).toBe(DEFAULTS.right.min);
  });

  it('rejects future versions', () => {
    expect(sanitizeSnapshot({ v: 2, sidebarW: 260, rightW: 320, chartH: null })).toBeNull();
  });

  it('rejects non-objects', () => {
    expect(sanitizeSnapshot(null)).toBeNull();
    expect(sanitizeSnapshot('hello')).toBeNull();
    expect(sanitizeSnapshot(42)).toBeNull();
  });

  it('fills missing fields from defaults', () => {
    const out = sanitizeSnapshot({ v: 1 });
    expect(out).toEqual({
      sidebarW: DEFAULTS.sidebar.def,
      rightW: DEFAULTS.right.def,
      chartH: DEFAULTS.chart.def,
    });
  });

  it('treats wrong-typed sidebarW as missing → default', () => {
    const out = sanitizeSnapshot({ v: 1, sidebarW: 'wide', rightW: 320, chartH: null });
    expect(out?.sidebarW).toBe(DEFAULTS.sidebar.def);
  });
});

describe('loadLayout', () => {
  it('returns defaults when storage is null', () => {
    const out = loadLayout(null);
    expect(out.sidebarW).toBe(DEFAULTS.sidebar.def);
    expect(out.rightW).toBe(DEFAULTS.right.def);
    expect(out.chartH).toBe(DEFAULTS.chart.def);
  });

  it('returns defaults when key is absent', () => {
    const storage = makeStorage();
    const out = loadLayout(storage);
    expect(out.sidebarW).toBe(DEFAULTS.sidebar.def);
  });

  it('returns defaults when value is malformed JSON', () => {
    const storage = makeStorage({ [STORAGE_KEY_INTERNAL]: '{not json' });
    const out = loadLayout(storage);
    expect(out.sidebarW).toBe(DEFAULTS.sidebar.def);
  });

  it('returns defaults when snapshot is unsalvageable (wrong version)', () => {
    const storage = makeStorage({
      [STORAGE_KEY_INTERNAL]: JSON.stringify({ v: 99, sidebarW: 280 }),
    });
    const out = loadLayout(storage);
    expect(out.sidebarW).toBe(DEFAULTS.sidebar.def);
  });

  it('returns persisted snapshot when valid', () => {
    const storage = makeStorage({
      [STORAGE_KEY_INTERNAL]: JSON.stringify({
        v: 1,
        sidebarW: 300,
        rightW: 360,
        chartH: 420,
      }),
    });
    const out = loadLayout(storage);
    expect(out).toEqual({ sidebarW: 300, rightW: 360, chartH: 420 });
  });

  it('swallows storage.getItem throws (SecurityError)', () => {
    const throwing = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {},
    };
    const out = loadLayout(throwing);
    expect(out.sidebarW).toBe(DEFAULTS.sidebar.def);
  });
});

describe('saveLayout', () => {
  it('writes sanitized snapshot under canonical key', () => {
    const storage = makeStorage();
    saveLayout(storage, { sidebarW: 280, rightW: 340, chartH: 500 });
    const raw = storage.getItem(STORAGE_KEY_INTERNAL);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({ v: 1, sidebarW: 280, rightW: 340, chartH: 500 });
  });

  it('clamps out-of-range values before writing', () => {
    const storage = makeStorage();
    saveLayout(storage, { sidebarW: 5, rightW: 999, chartH: 50 });
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY_INTERNAL));
    expect(parsed.sidebarW).toBe(DEFAULTS.sidebar.min);
    expect(parsed.rightW).toBe(DEFAULTS.right.max);
    expect(parsed.chartH).toBe(DEFAULTS.chart.min);
  });

  it('no-ops when storage is null', () => {
    expect(() => saveLayout(null, { sidebarW: 280, rightW: 340, chartH: null })).not.toThrow();
  });

  it('swallows quota errors', () => {
    const throwing = {
      getItem: () => null,
      setItem() {
        throw new Error('QuotaExceeded');
      },
    };
    expect(() =>
      saveLayout(throwing, { sidebarW: 280, rightW: 340, chartH: null }),
    ).not.toThrow();
  });
});

describe('mountResizable — DOM wiring', () => {
  let dom;
  let storage;

  beforeEach(() => {
    dom = buildShell();
    storage = makeStorage();
  });

  it('inserts three handles with role=separator', () => {
    mountResizable({ ...dom, storage });
    const handles = dom.root.querySelectorAll('[role="separator"]');
    expect(handles.length).toBe(3);
    const ids = Array.from(handles).map((h) => h.dataset.testId).sort();
    expect(ids).toEqual(['handle-chart', 'handle-right', 'handle-sidebar']);
  });

  it('places vertical handles between sidebar/center and center/right', () => {
    mountResizable({ ...dom, storage });
    const children = Array.from(dom.main.children);
    expect(children[0]).toBe(dom.sidebar);
    expect(children[1].dataset.testId).toBe('handle-sidebar');
    expect(children[2]).toBe(dom.center);
    expect(children[3].dataset.testId).toBe('handle-right');
    expect(children[4]).toBe(dom.right);
  });

  it('places horizontal handle between chart and bottom', () => {
    mountResizable({ ...dom, storage });
    const children = Array.from(dom.center.children);
    expect(children[0]).toBe(dom.chart);
    expect(children[1].dataset.testId).toBe('handle-chart');
    expect(children[2]).toBe(dom.bottom);
  });

  it('applies default CSS variables on init when no storage entry', () => {
    mountResizable({ ...dom, storage });
    expect(dom.main.style.getPropertyValue('--sidebar-w')).toBe(`${DEFAULTS.sidebar.def}px`);
    expect(dom.main.style.getPropertyValue('--right-w')).toBe(`${DEFAULTS.right.def}px`);
    // chartH=null → auto / 1fr
    expect(dom.center.style.getPropertyValue('--chart-h')).toBe('1fr');
  });

  it('hydrates CSS variables from persisted snapshot', () => {
    storage.setItem(
      STORAGE_KEY_INTERNAL,
      JSON.stringify({ v: 1, sidebarW: 290, rightW: 360, chartH: 480 }),
    );
    mountResizable({ ...dom, storage });
    expect(dom.main.style.getPropertyValue('--sidebar-w')).toBe('290px');
    expect(dom.main.style.getPropertyValue('--right-w')).toBe('360px');
    expect(dom.center.style.getPropertyValue('--chart-h')).toBe('480px');
    expect(dom.center.style.getPropertyValue('--bottom-h')).toBe('1fr');
  });

  it('adds resizable classes on main + center', () => {
    mountResizable({ ...dom, storage });
    expect(dom.main.classList.contains('pt-main--resizable')).toBe(true);
    expect(dom.center.classList.contains('pt-center--resizable')).toBe(true);
  });

  it('throws when a required zone is missing', () => {
    expect(() => mountResizable({ ...dom, sidebar: null, storage })).toThrow(TypeError);
  });

  it('destroy removes handles and resets classes / inline vars', () => {
    const handle = mountResizable({ ...dom, storage });
    handle.destroy();
    expect(dom.root.querySelectorAll('[role="separator"]').length).toBe(0);
    expect(dom.main.classList.contains('pt-main--resizable')).toBe(false);
    expect(dom.center.classList.contains('pt-center--resizable')).toBe(false);
    expect(dom.main.style.getPropertyValue('--sidebar-w')).toBe('');
    expect(dom.center.style.getPropertyValue('--chart-h')).toBe('');
  });

  it('getSnapshot returns the current state', () => {
    const handle = mountResizable({ ...dom, storage });
    expect(handle.getSnapshot()).toEqual({
      sidebarW: DEFAULTS.sidebar.def,
      rightW: DEFAULTS.right.def,
      chartH: DEFAULTS.chart.def,
    });
  });
});

describe('mountResizable — keyboard nudge', () => {
  let dom;
  let storage;

  beforeEach(() => {
    dom = buildShell();
    storage = makeStorage();
  });

  it('ArrowRight on left handle grows sidebar by 16px and persists', () => {
    const handle = mountResizable({ ...dom, storage });
    const leftHandle = dom.root.querySelector('[data-test-id="handle-sidebar"]');
    leftHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(handle.getSnapshot().sidebarW).toBe(DEFAULTS.sidebar.def + 16);
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY_INTERNAL));
    expect(parsed.sidebarW).toBe(DEFAULTS.sidebar.def + 16);
  });

  it('ArrowLeft on left handle shrinks sidebar — clamped at min', () => {
    storage.setItem(
      STORAGE_KEY_INTERNAL,
      JSON.stringify({ v: 1, sidebarW: DEFAULTS.sidebar.min + 8, rightW: 320, chartH: null }),
    );
    const handle = mountResizable({ ...dom, storage });
    const leftHandle = dom.root.querySelector('[data-test-id="handle-sidebar"]');
    leftHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    leftHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    // Min applies regardless of how many key presses
    expect(handle.getSnapshot().sidebarW).toBe(DEFAULTS.sidebar.min);
  });

  it('ArrowLeft on right handle grows trade panel (delta is negated)', () => {
    const handle = mountResizable({ ...dom, storage });
    const rightHandle = dom.root.querySelector('[data-test-id="handle-right"]');
    rightHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(handle.getSnapshot().rightW).toBe(DEFAULTS.right.def + 16);
  });

  it('ArrowDown on chart handle grows chart height', () => {
    const handle = mountResizable({ ...dom, storage });
    const chartHandle = dom.root.querySelector('[data-test-id="handle-chart"]');
    chartHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    // Starts at null → seeded from chart.clientHeight which is 0 in happy-dom
    // → falls back to 400 (default in startDrag) — but keyboard nudge uses
    // chart.clientHeight ?? 400. Either way, after one ArrowDown we land at
    // min(default) + 16, but the min clamp kicks in.
    const snap = handle.getSnapshot();
    expect(snap.chartH).not.toBeNull();
    expect(snap.chartH).toBeGreaterThanOrEqual(DEFAULTS.chart.min);
  });

  it('Arrow keys clamped at max', () => {
    storage.setItem(
      STORAGE_KEY_INTERNAL,
      JSON.stringify({
        v: 1,
        sidebarW: DEFAULTS.sidebar.max - 8,
        rightW: 320,
        chartH: null,
      }),
    );
    const handle = mountResizable({ ...dom, storage });
    const leftHandle = dom.root.querySelector('[data-test-id="handle-sidebar"]');
    leftHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    leftHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(handle.getSnapshot().sidebarW).toBe(DEFAULTS.sidebar.max);
  });

  it('unrecognized key is a no-op', () => {
    const handle = mountResizable({ ...dom, storage });
    const before = handle.getSnapshot();
    const leftHandle = dom.root.querySelector('[data-test-id="handle-sidebar"]');
    leftHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(handle.getSnapshot()).toEqual(before);
  });
});

describe('mountResizable — pointer drag', () => {
  let dom;
  let storage;

  beforeEach(() => {
    dom = buildShell();
    storage = makeStorage();
  });

  function pointerEvent(type, x, y, btn = 0) {
    // happy-dom doesn't ship PointerEvent constructor in all versions —
    // fall back to a synthetic Event with the coordinate fields tacked on.
    let ev;
    try {
      ev = new PointerEvent(type, { clientX: x, clientY: y, button: btn, bubbles: true });
    } catch {
      ev = new Event(type, { bubbles: true });
      Object.defineProperty(ev, 'clientX', { value: x });
      Object.defineProperty(ev, 'clientY', { value: y });
      Object.defineProperty(ev, 'button', { value: btn });
    }
    return ev;
  }

  it('pointerdown→move→up on sidebar handle updates state + persists on up', () => {
    const handle = mountResizable({ ...dom, storage });
    const leftHandle = dom.root.querySelector('[data-test-id="handle-sidebar"]');
    leftHandle.dispatchEvent(pointerEvent('pointerdown', 260, 100));
    // Without rAF the drag won't apply — we use synchronous applyDrag by
    // pretending rAF isn't there. happy-dom does provide rAF though, so we
    // dispatch and let microtask flush.
    window.dispatchEvent(pointerEvent('pointermove', 310, 100));
    // Drive rAF flush by waiting one tick.
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        expect(handle.getSnapshot().sidebarW).toBe(DEFAULTS.sidebar.def + 50);
        // Nothing persisted until pointerup
        expect(storage.getItem(STORAGE_KEY_INTERNAL)).toBeNull();
        window.dispatchEvent(pointerEvent('pointerup', 310, 100));
        const parsed = JSON.parse(storage.getItem(STORAGE_KEY_INTERNAL));
        expect(parsed.sidebarW).toBe(DEFAULTS.sidebar.def + 50);
        // dragging dataset cleared
        expect(leftHandle.dataset.dragging).toBe('false');
        resolve();
      });
    });
  });

  it('right-handle drag inverts delta (moving left grows right panel)', () => {
    const handle = mountResizable({ ...dom, storage });
    const rightHandle = dom.root.querySelector('[data-test-id="handle-right"]');
    rightHandle.dispatchEvent(pointerEvent('pointerdown', 800, 100));
    window.dispatchEvent(pointerEvent('pointermove', 760, 100));
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        // pointer moved -40 in X → right panel should grow by 40
        expect(handle.getSnapshot().rightW).toBe(DEFAULTS.right.def + 40);
        window.dispatchEvent(pointerEvent('pointerup', 760, 100));
        resolve();
      });
    });
  });

  it('pointerup with no active drag is a safe no-op', () => {
    mountResizable({ ...dom, storage });
    expect(() => window.dispatchEvent(pointerEvent('pointerup', 0, 0))).not.toThrow();
  });

  it('non-primary button is ignored', () => {
    const handle = mountResizable({ ...dom, storage });
    const leftHandle = dom.root.querySelector('[data-test-id="handle-sidebar"]');
    const before = handle.getSnapshot();
    leftHandle.dispatchEvent(pointerEvent('pointerdown', 260, 100, /* button = */ 2));
    window.dispatchEvent(pointerEvent('pointermove', 360, 100));
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        expect(handle.getSnapshot()).toEqual(before);
        resolve();
      });
    });
  });

  it('clamps sidebar drag at max', () => {
    const handle = mountResizable({ ...dom, storage });
    const leftHandle = dom.root.querySelector('[data-test-id="handle-sidebar"]');
    leftHandle.dispatchEvent(pointerEvent('pointerdown', 260, 100));
    window.dispatchEvent(pointerEvent('pointermove', 9999, 100));
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        // Either DEFAULTS.sidebar.max or the viewport-derived max — both
        // are bounded; here viewportSidebarMax depends on main.clientWidth
        // which is 0 in happy-dom → fallback 1280, so max = min(480, 1280-320-240) = 480.
        expect(handle.getSnapshot().sidebarW).toBeLessThanOrEqual(DEFAULTS.sidebar.max);
        expect(handle.getSnapshot().sidebarW).toBeGreaterThan(DEFAULTS.sidebar.def);
        window.dispatchEvent(pointerEvent('pointerup', 9999, 100));
        resolve();
      });
    });
  });
});

describe('persistence — round-trip', () => {
  it('save then load returns the same snapshot', () => {
    const storage = makeStorage();
    saveLayout(storage, { sidebarW: 275, rightW: 350, chartH: 460 });
    const out = loadLayout(storage);
    expect(out).toEqual({ sidebarW: 275, rightW: 350, chartH: 460 });
  });

  it('mounting after a save hydrates the variables', () => {
    const storage = makeStorage();
    saveLayout(storage, { sidebarW: 275, rightW: 350, chartH: 460 });
    const dom = buildShell();
    mountResizable({ ...dom, storage });
    expect(dom.main.style.getPropertyValue('--sidebar-w')).toBe('275px');
    expect(dom.main.style.getPropertyValue('--right-w')).toBe('350px');
    expect(dom.center.style.getPropertyValue('--chart-h')).toBe('460px');
  });
});
