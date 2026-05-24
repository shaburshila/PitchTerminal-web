// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showToast } from '../src/ui/toast.js';

describe('showToast', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('appends a toast node and auto-dismisses after duration', () => {
    showToast('hello', { duration: 1000 });
    const node = document.querySelector('[data-test-id="toast"]');
    expect(node).not.toBeNull();
    expect(node.textContent).toBe('hello');
    expect(node.dataset.kind).toBe('info');

    vi.advanceTimersByTime(1000);
    expect(document.querySelector('[data-test-id="toast"]')).toBeNull();
  });

  it('kind is applied as CSS class + dataset', () => {
    showToast('warn me', { kind: 'warn', duration: 100 });
    const node = document.querySelector('[data-test-id="toast"]');
    expect(node.classList.contains('pt-toast--warn')).toBe(true);
    expect(node.dataset.kind).toBe('warn');
  });

  it('returns a dismiss function that removes the toast early', () => {
    const dismiss = showToast('quick', { duration: 5000 });
    expect(document.querySelector('[data-test-id="toast"]')).not.toBeNull();
    dismiss();
    expect(document.querySelector('[data-test-id="toast"]')).toBeNull();
  });

  it('stacks multiple toasts in the same host', () => {
    showToast('one', { duration: 1000 });
    showToast('two', { duration: 1000 });
    const host = document.getElementById('pt-toast-host');
    expect(host.children.length).toBe(2);
  });

  it('reuses a single host across calls', () => {
    showToast('a', { duration: 1000 });
    showToast('b', { duration: 1000 });
    expect(document.querySelectorAll('#pt-toast-host').length).toBe(1);
  });

  it('host has aria-live=polite for accessibility', () => {
    showToast('x', { duration: 1000 });
    const host = document.getElementById('pt-toast-host');
    expect(host.getAttribute('aria-live')).toBe('polite');
    expect(host.getAttribute('role')).toBe('status');
  });

  // F1.4 — optional inline link (e.g. Basescan tx).
  it('renders an anchor when `link` is provided', () => {
    showToast('Swap done', {
      duration: 1000,
      link: { url: 'https://basescan.org/tx/0xabc', label: 'View on Basescan' },
    });
    const anchor = document.querySelector('[data-test-id="toast-link"]');
    expect(anchor).not.toBeNull();
    expect(anchor.getAttribute('href')).toBe('https://basescan.org/tx/0xabc');
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
    expect(anchor.textContent).toBe('View on Basescan');
  });

  it('omits link node when `link` is missing or malformed', () => {
    showToast('Plain', { duration: 1000 });
    expect(document.querySelector('[data-test-id="toast-link"]')).toBeNull();
    showToast('Bad link', { duration: 1000, link: { label: 'no url' } });
    expect(document.querySelector('[data-test-id="toast-link"]')).toBeNull();
  });

  it('falls back to the url as label when label is omitted', () => {
    showToast('msg', { duration: 1000, link: { url: 'https://example.com' } });
    const anchor = document.querySelector('[data-test-id="toast-link"]');
    expect(anchor).not.toBeNull();
    expect(anchor.textContent).toBe('https://example.com');
  });

  // F1.4 fix — protocol allowlist hardening for the public API.
  describe('link protocol allowlist', () => {
    it('rejects javascript: URLs (XSS-vector)', () => {
      showToast('bad', { duration: 1000, link: { url: 'javascript:alert(1)', label: 'click me' } });
      // No anchor rendered → text-only fallback.
      expect(document.querySelector('[data-test-id="toast-link"]')).toBeNull();
      const node = document.querySelector('[data-test-id="toast"]');
      expect(node).not.toBeNull();
      expect(node.textContent).toBe('bad');
    });

    it('rejects data: URLs', () => {
      showToast('bad', {
        duration: 1000,
        link: { url: 'data:text/html,<script>alert(1)</script>', label: 'data' },
      });
      expect(document.querySelector('[data-test-id="toast-link"]')).toBeNull();
    });

    it('rejects file:, ftp:, vbscript:, and other non-http(s) schemes', () => {
      const schemes = ['file:///etc/passwd', 'ftp://example.com', 'vbscript:msgbox', 'about:blank'];
      for (const url of schemes) {
        document.body.replaceChildren();
        showToast('bad', { duration: 1000, link: { url, label: 'x' } });
        expect(document.querySelector('[data-test-id="toast-link"]')).toBeNull();
      }
    });

    it('accepts https: URLs', () => {
      showToast('ok', { duration: 1000, link: { url: 'https://example.com', label: 'site' } });
      const anchor = document.querySelector('[data-test-id="toast-link"]');
      expect(anchor).not.toBeNull();
      expect(anchor.getAttribute('href')).toBe('https://example.com');
    });

    it('accepts http: URLs (legitimate in rare cases)', () => {
      showToast('ok', { duration: 1000, link: { url: 'http://example.com', label: 'site' } });
      const anchor = document.querySelector('[data-test-id="toast-link"]');
      expect(anchor).not.toBeNull();
      expect(anchor.getAttribute('href')).toBe('http://example.com');
    });
  });
});
