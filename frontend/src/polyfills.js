// Node globals polyfill — must be the FIRST import in main.js entry.
//
// Why a separate module: ESM hoists `import` statements (resolving + evaluating
// imported modules) BEFORE any top-level statements in the importing file run.
// If we put `if (!globalThis.Buffer)` directly in main.js after the import, all
// other imports (including @reown/appkit which may touch Buffer during its
// module-init) would evaluate first and the polyfill would be too late. By
// living in its own module, this file's side-effects run as part of import
// resolution, in import order — so `import './polyfills.js'` at the very top
// of main.js guarantees the globals are set before any other module init runs.
//
// Root cause: @reown/appkit-polyfills declares "sideEffects": false in its
// package.json, so Rollup tree-shakes it out of the production bundle even
// though the package is intentionally side-effect-only. Without it, the
// WalletConnect `wc_authenticate` flow (cacao encoding) throws "Can't find
// variable: Buffer" on iOS Safari, where there is no native Node Buffer.
//
// Also polyfill:
//   - `global` → globalThis (some deep deps reference `global.X`)
//   - `process` with an empty env + queueMicrotask-based nextTick (EventEmitter
//     shims reference `process.nextTick` defensively)
// If we ever see other Node-globals errors in Sentry, extend this block.

import { Buffer } from 'buffer';

if (!globalThis.Buffer) globalThis.Buffer = Buffer;
if (!globalThis.global) globalThis.global = globalThis;
if (!globalThis.process) {
  // NOTE: queueMicrotask, not process.nextTick — runs AFTER pending Promise.then
  // microtasks (Node's nextTick runs BEFORE them). Sufficient for the
  // EventEmitter-style deferred emits used by wagmi/appkit deep deps; do NOT
  // rely on this if a future dep requires strict pre-Promise ordering.
  globalThis.process = { env: {}, nextTick: (cb) => queueMicrotask(cb) };
}
