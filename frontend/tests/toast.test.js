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
});
