/**
 * Recurr replay preload — injected into replay children via NODE_OPTIONS
 * (`--import …`) BEFORE any application module loads.
 *
 * The call-site egress guard in @recurr-dev/sdk's patches/isolation.ts patches
 * module exports — but ESM named/namespace imports (`import { spawn } from
 * 'node:child_process'`, `import * as cp`) snapshot their bindings and would
 * bypass those patches entirely. This preload closes that gap at the module
 * boundary: inside a replay child, loading egress-capable modules throws.
 *
 * Modules blocked outright (a replay has no legitimate need for them):
 *   child_process, worker_threads, dgram, cluster
 *   (cluster.fork reaches internal spawn machinery that bypasses the
 *   call-level child_process patch — so it must fail at the module boundary)
 *
 * DNS is NOT blocked here — it is guarded at call level (loopback + the
 * record-store host stay resolvable), because dependency code imports `dns`
 * at load time even when it never performs a lookup.
 *
 * No-op outside `RECURR_MODE=replay`, or when the documented escape hatch
 * RECURR_REPLAY_ALLOW_NET=1 disables isolation.
 */
import nodeModule from 'node:module';

// registerHooks landed in Node 22.15 — a named import would SyntaxError at
// link time on older runtimes before we can say anything useful. Default
// import + feature check lets the preload deliver a clear refusal instead.
const registerHooks = nodeModule.registerHooks;

const BLOCKED = new Set([
  'child_process',
  'node:child_process',
  'worker_threads',
  'node:worker_threads',
  'dgram',
  'node:dgram',
  'cluster',
  'node:cluster',
]);

/** Our own packages legitimately import these modules to patch their
 *  exports — exempt them so instrumentation still installs.
 *
 *  Derive the scope root from THIS file's URL — <scope>/replay/dist/
 *  replay-preload.mjs → <scope>/ (node_modules/@recurr-dev/ when installed,
 *  packages/ in the monorepo). Matching the directory prefix rather than a
 *  hardcoded package name means a scope rename or a nested-install layout
 *  (pnpm store, file: links under the scope dir) can't silently break the
 *  exemption — the failure mode that shipped broken 0.1.0 artifacts. */
// The SDK is the ONLY package that legitimately imports blocked modules (to
// patch their exports) — the exemption must cover exactly its tree, never a
// wider scope dir (a hostile file placed under it would inherit the pass).
// Derive its root from this file's URL — <scope>/replay/dist/… → <scope>/sdk/
// — so the repo layout needs no hardcoded name. The published-path regex
// covers consumer node_modules where this preload resolves from a different
// tree (e.g. workspace-built CLI + npm-installed SDK); a scope rename must
// update it, and pack-smoke exercises that path so a stale name fails loudly.
const SDK_ROOT = new URL('../../sdk/', import.meta.url).href;
const PUBLISHED_SDK = /\/@recurr-dev\/sdk\//;

function isOwnCode(parentURL) {
  return (
    parentURL.startsWith('node:') ||
    parentURL.startsWith(SDK_ROOT) ||
    PUBLISHED_SDK.test(parentURL)
  );
}

if (process.env.RECURR_MODE === 'replay') {
  // If the orchestrator dies (even SIGKILL, which skips its exit handlers),
  // the IPC channel closes — a replay child must never outlive its parent.
  process.on('disconnect', () => process.exit(0));
}

if (process.env.RECURR_MODE === 'replay' && process.env.RECURR_REPLAY_ALLOW_NET !== '1') {
  if (typeof registerHooks !== 'function') {
    // Without module-load hooks the ESM named-import escape path stays open —
    // refuse to run an incompletely isolated replay rather than degrade it.
    throw new Error(
      '[recurr] replay requires Node >= 22.15 (module.registerHooks) — capture works on Node 20, replay does not',
    );
  }
  registerHooks({
    resolve(specifier, context, next) {
      if (BLOCKED.has(specifier)) {
        if (!isOwnCode(context.parentURL ?? '')) {
          throw new Error(
            `[recurr] replay isolation: blocked import of '${specifier}' — replays may not load egress-capable modules`,
          );
        }
      }
      return next(specifier, context);
    },
  });
}
