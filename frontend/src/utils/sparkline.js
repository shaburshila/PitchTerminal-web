/**
 * Sparkline — tiny inline SVG line-chart for sidebar rows (Phase 1.5 batch 3).
 *
 * Renders a fixed-size SVG <polyline> from an array of numbers. Designed to
 * be cheap to call once per visible sidebar row: pure DOM creation, no
 * external dependencies. The colour reflects net direction (last vs first
 * point) using --up / --down design tokens, falling back to --text-3 for
 * a flat / unknown series.
 *
 * Why a helper rather than inline in sidebar.js: sparklines may later be
 * reused in My Wallet / Orders rows (batch 6). Keeping the geometry +
 * trend-class logic in one place avoids drift between callers.
 *
 * Pure / testable: returns the SVGElement; caller appends it. The function
 * never reads from `state` or DOM globals. Pass `document` via the global
 * (happy-dom supplies one in unit tests).
 */

const DEFAULT_WIDTH = 48;
const DEFAULT_HEIGHT = 14;
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Decide the trend class from the first/last finite samples in the series.
 * Returns 'positive' | 'negative' | 'flat'. A series with <2 finite points
 * is 'flat' (we don't have enough signal to colour it).
 *
 * Exported for unit tests — internal callers should use renderSparkline().
 */
export function trendOf(values) {
  if (!Array.isArray(values) || values.length < 2) return 'flat';
  let first = null;
  let last = null;
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (first === null) first = v;
      last = v;
    }
  }
  if (first === null || last === null || first === last) return 'flat';
  return last > first ? 'positive' : 'negative';
}

/**
 * Normalize a numeric series into SVG-coordinate points. Missing / non-finite
 * entries are skipped (the line just bridges them, mirroring how chart libs
 * treat gaps in sparse data). Returns a string suitable for `polyline points`.
 *
 * Exported for unit tests.
 */
export function pointsOf(values, width, height) {
  if (!Array.isArray(values) || values.length === 0) return '';
  const finite = [];
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) finite.push(v);
  }
  if (finite.length === 0) return '';
  if (finite.length === 1) {
    // Single sample → centre dot rendered as a degenerate two-point line.
    const y = height / 2;
    return `0,${y} ${width},${y}`;
  }
  let min = finite[0];
  let max = finite[0];
  for (const v of finite) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  const stepX = finite.length > 1 ? width / (finite.length - 1) : 0;
  const parts = [];
  for (let i = 0; i < finite.length; i += 1) {
    const x = i * stepX;
    // Invert Y: SVG origin is top-left, but we want higher values higher.
    const y = range === 0 ? height / 2 : height - ((finite[i] - min) / range) * height;
    parts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return parts.join(' ');
}

/**
 * Build an SVG sparkline element for the given series.
 *
 * @param {number[]} values  Series of numbers (e.g. recent close prices).
 *   Non-finite entries are filtered. Returns `null` if no usable data.
 * @param {object}   [opts]
 * @param {number}   [opts.width]   default 48
 * @param {number}   [opts.height]  default 14
 * @param {string}   [opts.testId]  data-test-id on the root <svg>
 * @returns {SVGElement|null}
 */
export function renderSparkline(values, opts = {}) {
  const width = typeof opts.width === 'number' ? opts.width : DEFAULT_WIDTH;
  const height = typeof opts.height === 'number' ? opts.height : DEFAULT_HEIGHT;
  const points = pointsOf(values, width, height);
  if (!points) return null;

  const trend = trendOf(values);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('pt-spark');
  svg.classList.add(`pt-spark--${trend}`);
  if (opts.testId) svg.setAttribute('data-test-id', opts.testId);

  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('points', points);
  line.setAttribute('fill', 'none');
  // The stroke colour is set by CSS via the trend modifier class so the
  // up/down tokens stay the single source of truth.
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', '1.25');
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(line);

  return svg;
}
