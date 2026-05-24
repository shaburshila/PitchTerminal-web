// @vitest-environment happy-dom

import { describe, it, expect } from 'vitest';
import { renderSparkline, pointsOf, trendOf } from '../src/utils/sparkline.js';

describe('sparkline utils', () => {
  describe('trendOf', () => {
    it('returns "positive" when last > first', () => {
      expect(trendOf([1, 2, 3])).toBe('positive');
    });

    it('returns "negative" when last < first', () => {
      expect(trendOf([3, 2, 1])).toBe('negative');
    });

    it('returns "flat" when first === last', () => {
      expect(trendOf([2, 5, 2])).toBe('flat');
    });

    it('returns "flat" for series with <2 finite points', () => {
      expect(trendOf([])).toBe('flat');
      expect(trendOf([42])).toBe('flat');
      expect(trendOf(null)).toBe('flat');
      expect(trendOf([NaN, Infinity])).toBe('flat');
    });

    it('ignores non-finite entries when picking endpoints', () => {
      // First finite = 1, last finite = 3 → positive.
      expect(trendOf([NaN, 1, 2, 3, Infinity])).toBe('positive');
    });
  });

  describe('pointsOf', () => {
    it('returns empty string for empty / no-finite input', () => {
      expect(pointsOf([], 48, 14)).toBe('');
      expect(pointsOf(null, 48, 14)).toBe('');
      expect(pointsOf([NaN, Infinity], 48, 14)).toBe('');
    });

    it('produces N points across the full width for N samples', () => {
      const out = pointsOf([1, 2, 3, 4], 30, 10);
      const pts = out.split(' ');
      expect(pts.length).toBe(4);
      // x coordinates equally spaced 0, 10, 20, 30.
      expect(pts[0].startsWith('0.00,')).toBe(true);
      expect(pts[3].startsWith('30.00,')).toBe(true);
    });

    it('maps highest sample to y=0 (top) and lowest to y=height', () => {
      const out = pointsOf([1, 10], 100, 20);
      const [first, last] = out.split(' ');
      // 1 is min → y=height (bottom = 20.00). 10 is max → y=0.00 (top).
      expect(first).toBe('0.00,20.00');
      expect(last).toBe('100.00,0.00');
    });

    it('renders a single sample as a flat centre line', () => {
      const out = pointsOf([5], 40, 10);
      // Two endpoints at y=center for a degenerate 2-point line.
      expect(out).toBe('0,5 40,5');
    });

    it('flatlines a constant series at vertical centre', () => {
      const out = pointsOf([2, 2, 2], 20, 10);
      // range=0 → all y set to height/2 = 5.00 (toFixed(2) format).
      for (const p of out.split(' ')) expect(p.endsWith(',5.00')).toBe(true);
    });
  });

  describe('renderSparkline', () => {
    it('returns null for empty / unusable data', () => {
      expect(renderSparkline([])).toBeNull();
      expect(renderSparkline(null)).toBeNull();
      expect(renderSparkline([NaN, Infinity])).toBeNull();
    });

    it('builds an SVG with a single polyline child', () => {
      const svg = renderSparkline([1, 2, 3]);
      expect(svg).not.toBeNull();
      expect(svg.tagName.toLowerCase()).toBe('svg');
      const line = svg.querySelector('polyline');
      expect(line).not.toBeNull();
      expect(line.getAttribute('fill')).toBe('none');
      expect(line.getAttribute('stroke')).toBe('currentColor');
    });

    it('applies trend modifier class based on direction', () => {
      const up = renderSparkline([1, 2, 3]);
      expect(up.classList.contains('pt-spark')).toBe(true);
      expect(up.classList.contains('pt-spark--positive')).toBe(true);

      const down = renderSparkline([3, 2, 1]);
      expect(down.classList.contains('pt-spark--negative')).toBe(true);

      const flat = renderSparkline([2, 2, 2]);
      expect(flat.classList.contains('pt-spark--flat')).toBe(true);
    });

    it('honors width / height / testId options', () => {
      const svg = renderSparkline([1, 2], { width: 80, height: 20, testId: 'foo' });
      expect(svg.getAttribute('width')).toBe('80');
      expect(svg.getAttribute('height')).toBe('20');
      expect(svg.getAttribute('viewBox')).toBe('0 0 80 20');
      expect(svg.getAttribute('data-test-id')).toBe('foo');
    });

    it('marks svg aria-hidden so screen readers skip it', () => {
      const svg = renderSparkline([1, 2, 3]);
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    });
  });
});
