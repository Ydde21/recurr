/**
 * Recurr replay preload — injected into replay children via NODE_OPTIONS
 * (`--import …`) BEFORE any application module loads.
 *
 * The call-site egress guard in @recurr/sdk's patches/isolation.ts patches
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
import { registerHooks } from 'node:module';

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

/** The SDK itself legitimately imports these modules to patch their exports —
 *  exempt its own files so instrumentation still installs. */
const SDK_PATH = /\/(@recurr\/sdk|packages\/sdk)\//;

if (process.env.RECURR_MODE === 'replay') {
  // If the orchestrator dies (even SIGKILL, which skips its exit handlers),
  // the IPC channel closes — a replay child must never outlive its parent.
  process.on('disconnect', () => process.exit(0));
}

if (process.env.RECURR_MODE === 'replay' && process.env.RECURR_REPLAY_ALLOW_NET !== '1') {
  registerHooks({
    resolve(specifier, context, next) {
      if (BLOCKED.has(specifier)) {
        const parent = context.parentURL ?? '';
        if (!parent.startsWith('node:') && !SDK_PATH.test(parent)) {
          throw new Error(
            `[recurr] replay isolation: blocked import of '${specifier}' — replays may not load egress-capable modules`,
          );
        }
      }
      return next(specifier, context);
    },
  });
}
