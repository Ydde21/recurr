import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Preflight — cheap static check on the replay target before spawning.
 *
 * The sandbox refuses blocked builtins at load time, which means a doomed
 * target fails ~20s in with a loader error. This scan catches the obvious
 * cases up front: known launcher binaries that own blocked modules
 * (tsx/next/nodemon/…), and static `import` of a blocked builtin in the entry
 * file (links unconditionally → guaranteed refusal). `require()`/`import()`
 * hits are warnings — the call may sit on a code path the replay never
 * reaches.
 *
 * Deliberately shallow: entry-file source only, no transitive resolution.
 * The preload remains the authority — this exists to fail fast with a
 * readable reason.
 */

export interface PreflightProblem {
  severity: 'fatal' | 'warn';
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  problems: PreflightProblem[];
}

/** Binaries that own a blocklisted builtin before user code runs. */
const FATAL_LAUNCHERS =
  /^(?:tsx|ts-node|nodemon|vite-node|vite|vitest|next|bun|deno|jest|mocha|pm2|forever|concurrently)$/i;

const BLOCKED = 'child_process|worker_threads|cluster|dgram';
const STATIC_IMPORT = new RegExp(`import\\s+(?:[\\w*{}\\s,$]+\\s+from\\s+)?['"](?:node:)?(?:${BLOCKED})['"]`);
const REQUIRE_CALL = new RegExp(`require\\(\\s*['"](?:node:)?(?:${BLOCKED})['"]`);
const DYN_IMPORT = new RegExp(`import\\(\\s*['"](?:node:)?(?:${BLOCKED})['"]`);
const NATIVE_ADDON = /\.node['"]|process\.dlopen/;

/** Strip line/block comments so commented-out imports don't false-positive. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function scanSource(src: string, label: string): PreflightProblem[] {
  const code = stripComments(src);
  const problems: PreflightProblem[] = [];
  const m = code.match(STATIC_IMPORT);
  if (m) {
    problems.push({
      severity: 'fatal',
      detail: `${label} statically imports a sandbox-blocked module — the replay child dies at module link before listen()`,
    });
  }
  for (const [re, what] of [
    [REQUIRE_CALL, 'requires'],
    [DYN_IMPORT, 'dynamically imports'],
  ] as const) {
    if (re.test(code)) {
      problems.push({
        severity: 'warn',
        detail: `${label} ${what} a sandbox-blocked module — fine if the replayed path never reaches it`,
      });
    }
  }
  if (NATIVE_ADDON.test(code)) {
    problems.push({
      severity: 'warn',
      detail: `${label} loads a native addon — dlopen is blocked at replay`,
    });
  }
  return problems;
}

/** node flags whose next arg is inline CODE. */
const CODE_FLAGS = new Set(['-e', '--eval', '-p', '--print']);
/** node flags whose next arg is a FILE loaded before/alongside the entry. */
const FILE_FLAGS = new Set(['-r', '--require', '--import', '--loader']);
/** node flags that take a value we don't care about. */
const SKIP_FLAGS = new Set(['--watch-path', '--env-file', '--conditions', '-C', '--test-name-pattern']);

export function preflightTarget(command: string[], cwd: string): PreflightResult {
  const problems: PreflightProblem[] = [];
  if (command.length === 0) return { ok: true, problems };

  const cmdName = path.basename(command[0]).replace(/\.(exe|cmd|bat)$/i, '');
  if (FATAL_LAUNCHERS.test(cmdName)) {
    problems.push({
      severity: 'fatal',
      detail: `target launched via '${cmdName}' — dev/framework launchers own sandbox-blocked modules; compile to plain node output and target that`,
    });
    return { ok: false, problems };
  }

  // Only scan node-style targets; other runtimes are out of scope.
  if (!/^node(?:\.exe)?$/i.test(cmdName)) return { ok: true, problems };

  const scanFile = (arg: string) => {
    const file = path.resolve(cwd, arg);
    if (!existsSync(file) || !/\.(?:[cm]?[jt]s|tsx?)$/i.test(file)) return;
    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    problems.push(...scanSource(src, path.basename(file)));
  };

  for (let i = 1; i < command.length; i++) {
    const arg = command[i];
    const inlineFile = arg.match(/^--(?:import|require|loader)=(.+)$/);
    if (inlineFile) {
      scanFile(inlineFile[1]);
      continue;
    }
    if (CODE_FLAGS.has(arg)) {
      const val = command[++i];
      if (val) problems.push(...scanSource(val, `inline ${arg} script`));
      continue;
    }
    if (FILE_FLAGS.has(arg)) {
      const val = command[++i];
      if (val) scanFile(val);
      continue;
    }
    if (SKIP_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    scanFile(arg);
  }

  return { ok: !problems.some((p) => p.severity === 'fatal'), problems };
}
