/**
 * Version-check banner — detects backend↔bundle SHA drift and prompts a
 * page refresh.
 *
 * After a deploy, anyone with a stale browser tab keeps running the old JS
 * bundle while the backend is on the new SHA. If the API contract drifted
 * (e.g. an endpoint moved from GET to POST), API calls fail with generic
 * 4xx errors and the user has no idea they need to refresh. This module
 * mounts a small pulsing pill in the header center on mismatch with a
 * one-click "Refresh" button.
 *
 * Trigger conditions:
 *   - Bundle version is a "real" build (i.e. != 'dev').
 *   - Backend `/api/v1/config` returns a `version` field that differs from
 *     `import.meta.env.VITE_APP_VERSION`.
 *
 * Polling cadence: once at boot, then every 5 minutes. We piggy-back on
 * the existing `/config` cache (60s TTL server-side) so cost is minimal.
 *
 * @module version-check
 */

const POLL_INTERVAL_MS = 5 * 60 * 1000;

function el(tag, { className, dataset, attrs, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (dataset) for (const [k, v] of Object.entries(dataset)) node.dataset[k] = v;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function buildBanner(onRefresh) {
  const root = el('div', {
    className: 'pt-version-check',
    dataset: { testId: 'version-check-banner' },
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  root.appendChild(
    el('span', { className: 'pt-version-check__dot', attrs: { 'aria-hidden': 'true' } }),
  );
  root.appendChild(
    el('span', {
      className: 'pt-version-check__text',
      text: 'New version available',
    }),
  );
  const btn = el('button', {
    className: 'pt-version-check__btn',
    dataset: { testId: 'version-check-refresh' },
    attrs: { type: 'button' },
    text: 'Refresh',
  });
  btn.addEventListener('click', onRefresh);
  root.appendChild(btn);
  return root;
}

/**
 * Mount the version-check banner into a container element (typically the
 * header's center slot). Returns a handle with `destroy()` and `check()` so
 * tests / bootstrap can drive it manually.
 *
 * Dependency injection: pass `{ getConfig, getBundleVersion, reload, setInterval, clearInterval }`
 * to swap the real implementations during tests. Defaults wire to the
 * production API client + `window.location.reload`.
 *
 * @param {HTMLElement} container
 * @param {object} [deps]
 */
export function mountVersionCheck(container, deps = {}) {
  if (!container) throw new TypeError('mountVersionCheck: container required');

  const bundleVersion =
    deps.getBundleVersion?.() ??
    (typeof import.meta !== 'undefined' ? import.meta.env?.VITE_APP_VERSION : null) ??
    null;
  const getConfig = deps.getConfig;
  const reload =
    deps.reload ??
    (() => {
      if (typeof window !== 'undefined') window.location.reload();
    });
  const setIntervalFn = deps.setInterval ?? setInterval;
  const clearIntervalFn = deps.clearInterval ?? clearInterval;

  // No bundle version (dev build) → version check is a no-op. Avoids
  // pestering local devs whose backend will always be on a different SHA.
  if (!bundleVersion || bundleVersion === 'dev') {
    return { destroy() {}, check() {} };
  }
  if (typeof getConfig !== 'function') {
    return { destroy() {}, check() {} };
  }

  let mounted = true;
  let banner = null;

  async function check() {
    if (!mounted) return;
    try {
      const cfg = await getConfig();
      if (!mounted) return;
      const serverVersion = cfg?.version;
      // Server still on "dev" or no version field → ignore (deploy
      // pipeline not yet pushing APP_VERSION, or response shape changed).
      if (!serverVersion || serverVersion === 'dev') return;
      if (serverVersion === bundleVersion) {
        // Versions in sync — if the banner was previously shown (e.g. user
        // ignored it and a subsequent deploy reverted to their version),
        // tear it down silently.
        if (banner) {
          banner.remove();
          banner = null;
        }
        return;
      }
      // Mismatch — show banner if not already up.
      if (!banner) {
        banner = buildBanner(() => reload());
        container.appendChild(banner);
      }
    } catch {
      // /config 5xx or network error — stay quiet. Either the backend is
      // briefly down (deploy cold-start) or the user is offline; in both
      // cases the next poll will recover.
    }
  }

  // Fire-and-forget initial check; subsequent polls every POLL_INTERVAL_MS.
  check();
  const handle = setIntervalFn(check, POLL_INTERVAL_MS);

  return {
    destroy() {
      mounted = false;
      clearIntervalFn(handle);
      if (banner) {
        banner.remove();
        banner = null;
      }
    },
    check,
  };
}
