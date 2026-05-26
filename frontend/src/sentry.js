// Sentry browser SDK init. No-op when VITE_SENTRY_DSN is unset, so dev
// builds and CI tests don't ping the upstream. Only errors are captured
// (no APM / replays) to stay inside the free tier.
//
// Imported first from main.js so global error / unhandledrejection
// handlers are installed before any other module runs.

import * as Sentry from '@sentry/browser';

let initialised = false;

export function initSentry() {
  if (initialised) return false;

  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return false;

  Sentry.init({
    dsn,
    release: import.meta.env.VITE_APP_VERSION || 'dev',
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT || import.meta.env.MODE,
    // Errors only — performance tracing is off.
    tracesSampleRate: 0,
    sendDefaultPii: false,
    // Drop noisy events that are not actionable.
    ignoreErrors: [
      // Cross-origin script errors with no info — useless for debugging.
      'Script error.',
      // ResizeObserver loop warnings — benign browser quirk.
      'ResizeObserver loop limit exceeded',
      'ResizeObserver loop completed with undelivered notifications',
      // User-rejected wallet signature (intentional UX, not a bug).
      'User rejected the request',
      'User denied transaction signature',
    ],
  });

  initialised = true;
  return true;
}
