// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { mountVersionCheck } from '../src/version-check.js';

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('mountVersionCheck', () => {
  let container;
  let reload;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    reload = vi.fn();
  });

  it('no-ops when bundle version is "dev"', async () => {
    const getConfig = vi.fn().mockResolvedValue({ version: 'abc1234' });
    const handle = mountVersionCheck(container, {
      getConfig,
      getBundleVersion: () => 'dev',
      reload,
    });
    await flushMicrotasks();
    expect(getConfig).not.toHaveBeenCalled();
    expect(container.children.length).toBe(0);
    handle.destroy();
  });

  it('no-ops when getConfig is missing', async () => {
    const handle = mountVersionCheck(container, {
      getBundleVersion: () => 'abc1234',
      reload,
    });
    await flushMicrotasks();
    expect(container.children.length).toBe(0);
    handle.destroy();
  });

  it('shows banner on backend↔bundle version mismatch', async () => {
    const getConfig = vi.fn().mockResolvedValue({ version: 'newer99' });
    const handle = mountVersionCheck(container, {
      getConfig,
      getBundleVersion: () => 'older11',
      reload,
    });
    await flushMicrotasks();
    expect(getConfig).toHaveBeenCalledTimes(1);
    const banner = container.querySelector('[data-test-id="version-check-banner"]');
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('New version available');
    handle.destroy();
  });

  it('stays silent when versions match', async () => {
    const getConfig = vi.fn().mockResolvedValue({ version: 'sameSha' });
    const handle = mountVersionCheck(container, {
      getConfig,
      getBundleVersion: () => 'sameSha',
      reload,
    });
    await flushMicrotasks();
    expect(container.children.length).toBe(0);
    handle.destroy();
  });

  it('treats server "dev" version as no-mismatch (server pre-deploy state)', async () => {
    const getConfig = vi.fn().mockResolvedValue({ version: 'dev' });
    const handle = mountVersionCheck(container, {
      getConfig,
      getBundleVersion: () => 'realSha',
      reload,
    });
    await flushMicrotasks();
    expect(container.children.length).toBe(0);
    handle.destroy();
  });

  it('refresh button calls reload', async () => {
    const getConfig = vi.fn().mockResolvedValue({ version: 'newer99' });
    const handle = mountVersionCheck(container, {
      getConfig,
      getBundleVersion: () => 'older11',
      reload,
    });
    await flushMicrotasks();
    const btn = container.querySelector('[data-test-id="version-check-refresh"]');
    expect(btn).toBeTruthy();
    btn.click();
    expect(reload).toHaveBeenCalledTimes(1);
    handle.destroy();
  });

  it('removes banner if versions converge on a later poll', async () => {
    const getConfig = vi
      .fn()
      .mockResolvedValueOnce({ version: 'newer99' })
      .mockResolvedValueOnce({ version: 'older11' });
    const handle = mountVersionCheck(container, {
      getConfig,
      getBundleVersion: () => 'older11',
      reload,
    });
    await flushMicrotasks();
    expect(container.querySelector('[data-test-id="version-check-banner"]')).toBeTruthy();
    await handle.check();
    expect(container.querySelector('[data-test-id="version-check-banner"]')).toBeFalsy();
    handle.destroy();
  });

  it('swallows getConfig errors without mounting', async () => {
    const getConfig = vi.fn().mockRejectedValue(new Error('network'));
    const handle = mountVersionCheck(container, {
      getConfig,
      getBundleVersion: () => 'realSha',
      reload,
    });
    await flushMicrotasks();
    expect(container.children.length).toBe(0);
    handle.destroy();
  });

  it('destroy clears the polling interval and removes banner', async () => {
    const clearIntervalFn = vi.fn();
    const getConfig = vi.fn().mockResolvedValue({ version: 'newer99' });
    const handle = mountVersionCheck(container, {
      getConfig,
      getBundleVersion: () => 'older11',
      reload,
      setInterval: () => 12345,
      clearInterval: clearIntervalFn,
    });
    await flushMicrotasks();
    expect(container.querySelector('[data-test-id="version-check-banner"]')).toBeTruthy();
    handle.destroy();
    expect(clearIntervalFn).toHaveBeenCalledWith(12345);
    expect(container.querySelector('[data-test-id="version-check-banner"]')).toBeFalsy();
  });
});
