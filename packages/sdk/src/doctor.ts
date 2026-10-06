import nodeModule from 'node:module';

// Feature-detect: module.registerHooks requires Node >= 22.15; a named import
// would SyntaxError at link time on Node 20 (capture must still work there).
const registerHooks = (nodeModule as { registerHooks?: unknown }).registerHooks;

/** Builtins the replay sandbox refuses to load (see packages/replay replay-preload). */
const BLOCKED_BUILTINS = ['child_process', 'worker_threads', 'cluster', 'dgram'] as const;

// process.moduleLoadList is a stable-but-undocumented runtime list of loaded
// modules; absent from @types/node, so read it defensively.
const loadList = (): string[] =>
  (process as unknown as { moduleLoadList?: string[] }).moduleLoadList ?? [];

// Baseline — runs at module eval. index.ts imports this module FIRST, so by
// this point the process's whole static import graph (ours AND the host's)
// has already linked: presence of a builtin here can't be attributed. But a
// builtin that appears in loadList() AFTER this snapshot is unambiguously a
// post-init load (runtime require / dynamic import) — always host activity.
const baseline = new Set(BLOCKED_BUILTINS.filter((m) => loadList().includes(`NativeModule ${m}`)));

// Watch for loads that happen after our eval — runtime requires and dynamic
// imports of blocked builtins are always host activity (our own blocked
// imports are static and already linked). registerHooks is same-thread since
// 22.15 and fires for CJS require() too, not just ESM.
const lateLoads = new Map<string, string>();
if (typeof registerHooks === 'function' && process.env.RECURR_MODE !== 'replay') {
  registerHooks({
    load(url: string, context: { parentURL?: string }, nextLoad: (u: string, c: unknown) => unknown) {
      const name = url.replace(/^node:/, '');
      if ((BLOCKED_BUILTINS as readonly string[]).includes(name) && !lateLoads.has(name)) {
        lateLoads.set(name, context.parentURL ?? 'unknown');
      }
      return nextLoad(url, context);
    },
  });
}

export interface DoctorFinding {
  code: 'replay-unsupported-node' | 'blocked-module-loaded' | 'framework-launcher';
  detail: string;
  remediation: string;
}

export interface DoctorReport {
  /** True when this process could serve as a replay target. */
  replayable: boolean;
  findings: DoctorFinding[];
}

/** Wrappers that own a blocklisted builtin before user code runs. */
const LAUNCHER_PATTERN = /next|tsx|ts-node|nodemon|vite-node|bun|deno|vitest|jest|mocha/i;

const REPLAY_ENTRY_NOTE =
  'replay needs a plain-Node entry that doesn’t touch blocked modules (e.g. an esbuild bundle); capture keeps working';

/**
 * Inspect the current process and report whether it could ever serve as a
 * replay target. Capture works anywhere; replay requires a plain Node entry
 * that hasn't loaded a sandbox-blocked builtin.
 */
export function checkRuntime(): DoctorReport {
  const findings: DoctorFinding[] = [];

  if (typeof registerHooks !== 'function') {
    findings.push({
      code: 'replay-unsupported-node',
      detail: `Node ${process.version} lacks module.registerHooks (needs >= 22.15)`,
      remediation: 'replay requires Node >= 22.15 — capture keeps working on this runtime',
    });
  }

  // Post-baseline loads: not present at eval, present now → loaded at runtime
  // after the SDK imported. Detectable on every Node version.
  const now = loadList();
  const seen = new Set<string>();
  for (const name of BLOCKED_BUILTINS) {
    if (!baseline.has(name) && now.includes(`NativeModule ${name}`) && !seen.has(name)) {
      seen.add(name);
      findings.push({
        code: 'blocked-module-loaded',
        detail: `'${name}' loaded after SDK init — the replay sandbox would refuse this process`,
        remediation: REPLAY_ENTRY_NOTE,
      });
    }
  }

  // Watcher adds attribution where available (registerHooks, Node >= 22.15).
  for (const [name, via] of lateLoads) {
    if (seen.has(name)) continue;
    seen.add(name);
    findings.push({
      code: 'blocked-module-loaded',
      detail: `'${name}' loaded after SDK init (${via}) — the replay sandbox would refuse this process`,
      remediation: REPLAY_ENTRY_NOTE,
    });
  }

  const entry = process.argv[1] ?? '';
  if (LAUNCHER_PATTERN.test(entry)) {
    findings.push({
      code: 'framework-launcher',
      detail: `launched via '${entry.split('/').pop()}' — framework/dev-tool entries typically own blocked modules`,
      remediation: 'replay against a plain-Node entry point instead (capture-only on this runtime)',
    });
  }

  return { replayable: findings.length === 0, findings };
}
