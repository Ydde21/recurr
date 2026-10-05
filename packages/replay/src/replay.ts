import { spawn, type ChildProcess } from 'node:child_process';
import { diffExecutions, validateRecord, type DiffReport, type ExecutionRecord } from '@recurr/core';
import type { IncidentStore } from '@recurr/store';

export interface ReplayTarget {
  /** Command to launch the app, e.g. "node dist/index.js" or an argv array. */
  command: string | string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface ReplayOptions {
  store: IncidentStore;
  /** Store spec string propagated to the replay child (e.g. 'fs:.recurr/store'). */
  storeSpec: string;
  incidentId: string;
  target: ReplayTarget;
  /** Max wall time for the whole replay. Default 60s. */
  timeoutMs?: number;
  /** Max time to wait for the target to report ready. Default 20s. */
  readyTimeoutMs?: number;
  onProgress?: (msg: string) => void;
}

export interface ReplayResult {
  replay: ExecutionRecord;
  report: DiffReport;
  /** HTTP status the injected request observed from the outside. */
  observedStatus?: number;
}

export class ReplayError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'READY_TIMEOUT' | 'TARGET_EXIT' | 'TIMEOUT' | 'NO_RECORD' | 'BAD_ARGS',
  ) {
    super(message);
    this.name = 'ReplayError';
  }
}

/**
 * Env vars matching this pattern are stripped from the replay child by
 * default — production credentials must never leak into a replay. Explicit
 * `target.env` entries and RECURR_* vars are applied after stripping.
 * Escape hatch: RECURR_REPLAY_INHERIT_ENV=1 (warns loudly when used).
 *
 * The pattern is deliberately broad — over-stripping costs the replay an env
 * var; under-stripping leaks a production credential into an untrusted record
 * pipeline. Covers: secrets/keys/tokens, DSNs, certs, proxy config (proxy env
 * points at internal infrastructure and could steer egress), socket paths
 * (SSH_AUTH_SOCK, DOCKER_HOST, GPG agent), cloud provider conventions, and
 * password shorthands like MYSQL_PWD / PGPASSFILE.
 */
const SENSITIVE_ENV =
  /(key|secret|token|pass|credential|private|dsn|database_url|connection_string|cert|ssl|proxy|sock|ssh|kube|docker|boto|azure|gcloud|gcp_|oauth|_pwd|jwt|salt|_pem|auth_|agent|gpg)/i;

/** Exact names that must always be stripped even though they don't match the
 *  pattern — PWD is the only one we *don't* strip (harmless cwd hint). */
const ALWAYS_STRIP_ENV = new Set([
  'AWS_PROFILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  'KUBECONFIG',
  'DOCKER_CONFIG',
  'NPM_CONFIG_USERCONFIG',
  'GIT_ASKPASS',
  'GOPROXY',
  'npm_config_//registry',
]);

/** target.env keys that could disable the sandbox are dropped — replay
 *  isolation is not something a target spec may opt out of. */
const FORBIDDEN_TARGET_ENV = new Set(['RECURR_REPLAY_ALLOW_NET', 'RECURR_REPLAY_INHERIT_ENV']);

export function sanitizeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.env.RECURR_REPLAY_INHERIT_ENV === '1') {
    console.error(
      '[recurr] WARNING: RECURR_REPLAY_INHERIT_ENV=1 — replay child inherits ALL environment variables, including production credentials. Only use on disposable machines.',
    );
    return { ...base };
  }
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (SENSITIVE_ENV.test(k) || ALWAYS_STRIP_ENV.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Headers that must not be replayed verbatim — recomputed for the local target. */
const HOP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'accept-encoding',
  'content-encoding',
]);

/** Shell-ish tokenizer — handles single/double quotes and backslash escapes
 *  so `node -e "code"` targets behave the way the caller wrote them. */
function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === '"') {
      if (ch === '"') quote = undefined;
      else if (ch === '\\' && command[i + 1] === '"') cur += command[++i];
      else cur += ch;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '\\' && command[i + 1] && !/\s/.test(command[i + 1])) cur += command[++i];
    else if (/\s/.test(ch)) {
      if (cur.length) {
        parts.push(cur);
        cur = '';
      }
    } else cur += ch;
  }
  if (quote) throw new ReplayError(`unterminated quote in target command`, 'BAD_ARGS');
  if (cur.length) parts.push(cur);
  return parts;
}

function parseCommand(command: string | string[]): [string, string[]] {
  const parts = Array.isArray(command) ? command : splitCommand(command);
  if (parts.length === 0) throw new ReplayError('empty target command', 'BAD_ARGS');
  return [parts[0], parts.slice(1)];
}

/**
 * Replay an incident: spawn the target app in replay mode, inject the
 * recorded request, collect the replay record, diff against the original.
 */
export async function replayIncident(opts: ReplayOptions): Promise<ReplayResult> {
  const log = opts.onProgress ?? (() => {});
  const original = await opts.store.get(opts.incidentId);
  if (!original) throw new ReplayError(`incident ${opts.incidentId} not found`, 'NOT_FOUND');
  // A stored record is untrusted input — it may have been imported from a
  // file or a shared collector. Structural validation before we act on it.
  const v = validateRecord(original);
  if (!v.ok) throw new ReplayError(`incident ${opts.incidentId} fails validation: ${v.error}`, 'NO_RECORD');
  if (original.kind === 'replay' && original.replayOf) {
    throw new ReplayError(`${opts.incidentId} is a replay of ${original.replayOf} — replay the incident instead`, 'NO_RECORD');
  }
  if (!original.request) throw new ReplayError(`incident ${opts.incidentId} has no captured request`, 'NO_RECORD');

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ReplayError(`invalid timeoutMs: ${opts.timeoutMs}`, 'BAD_ARGS');
  if (!Number.isFinite(readyTimeoutMs) || readyTimeoutMs <= 0) throw new ReplayError(`invalid readyTimeoutMs: ${opts.readyTimeoutMs}`, 'BAD_ARGS');
  const [cmd, args] = parseCommand(opts.target.command);

  // target.env is developer-supplied — apply it after sanitization, minus the
  // keys that would switch the sandbox off.
  const targetEnv: Record<string, string> = {};
  for (const [k, val] of Object.entries(opts.target.env ?? {})) {
    if (FORBIDDEN_TARGET_ENV.has(k) || k === 'NODE_OPTIONS') {
      log(`warning: ignoring target.env ${k} — replay wiring/isolation is not optional`);
      continue;
    }
    if (val !== undefined) targetEnv[k] = val;
  }

  // The module-load blocklist must be in place before ANY app module loads —
  // call-site patching alone can't catch `import { spawn }` namespace
  // snapshots. NODE_OPTIONS --import runs this preload first; it's a no-op
  // outside RECURR_MODE=replay.
  const preloadUrl = new URL('./replay-preload.mjs', import.meta.url).href;
  // Only the *parent's* NODE_OPTIONS may contribute flags — a target-supplied
  // --loader/--require would run before our preload and could bypass the
  // module blocklist.
  const baseNodeOpts = process.env.NODE_OPTIONS ?? '';
  const nodeOptions = `${baseNodeOpts} --import ${preloadUrl}`.trim();

  log(`reconstructing environment for ${original.id}…`);
  const child: ChildProcess = spawn(cmd, args, {
    cwd: opts.target.cwd ?? process.cwd(),
    env: {
      ...sanitizeEnv(process.env),
      ...targetEnv,
      NODE_OPTIONS: nodeOptions,
      // These are non-negotiable — target.env must not break replay wiring.
      RECURR_MODE: 'replay',
      RECURR_REPLAY_OF: original.id,
      RECURR_STORE: opts.storeSpec,
      NODE_ENV: 'replay',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  // If the parent dies hard, the isolated child must not linger.
  const killOnParentExit = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  };
  process.once('exit', killOnParentExit);

  const stderr: Buffer[] = [];
  const stdout: Buffer[] = [];
  child.stderr?.on('data', (d: Buffer) => stderr.push(d));
  child.stdout?.on('data', (d: Buffer) => {
    stdout.push(d);
    if (opts.onProgress) process.stderr.write(d);
  });
  const tail = () => {
    const parts = [Buffer.concat(stderr).toString('utf8').trim(), Buffer.concat(stdout).toString('utf8').trim()].filter(Boolean);
    return parts.length ? `\ntarget output (tail): ${parts.join('\n').slice(-2000)}` : '';
  };

  const deadline = Date.now() + timeoutMs;
  try {
    const port = await waitForMessage(child, 'recurr:ready', readyTimeoutMs, tail).then((m) => m.port as number);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new ReplayError(`target announced invalid port: ${String(port)}`, 'TARGET_EXIT');
    }
    log(`replay environment ready on 127.0.0.1:${port} — injecting ${original.request.method} ${original.request.url}`);

    const observed = await injectRequest(port, original, deadline - Date.now());
    log(`injected request → HTTP ${observed}`);

    const done = await waitForMessage(child, 'recurr:done', Math.max(1, deadline - Date.now()), tail);
    const replay = await opts.store.get(String(done.id));
    if (!replay) throw new ReplayError(`replay record ${done.id} not found in store`, 'NO_RECORD');

    const report = diffExecutions(original, replay);
    return { replay, report, observedStatus: observed };
  } finally {
    if (!child.killed) {
      child.kill('SIGTERM');
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, 2000).unref();
    }
    process.off('exit', killOnParentExit);
    const err = Buffer.concat(stderr).toString('utf8').trim();
    if (err) log(`target stderr: ${err.slice(-2000)}`);
  }
}

interface IpcMessage {
  type?: string;
  port?: number;
  id?: string;
  message?: string;
}

function waitForMessage(child: ChildProcess, type: string, timeoutMs: number, tail: () => string): Promise<IpcMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new ReplayError(`timed out waiting for ${type}${tail()}`, type === 'recurr:ready' ? 'READY_TIMEOUT' : 'TIMEOUT'));
    }, timeoutMs);
    const onMsg = (m: IpcMessage) => {
      if (m?.type === type) {
        cleanup();
        resolve(m);
      } else if (m?.type === 'recurr:init-error') {
        cleanup();
        reject(new ReplayError(`target init failed: ${m.message ?? 'unknown'}${tail()}`, 'TARGET_EXIT'));
      }
    };
    const onExit = (code: number | null, signal: string | null) => {
      cleanup();
      reject(new ReplayError(`target exited (${code ?? signal}) while waiting for ${type}${tail()}`, 'TARGET_EXIT'));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(new ReplayError(`failed to spawn target: ${err.message}`, 'TARGET_EXIT'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMsg);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.on('message', onMsg);
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

/** Token chars per RFC 7230 — rejects whitespace/CRLF/control in stored data. */
const METHOD_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,32}$/;

/** Reduce a stored request URL to a safe path+query for local injection. */
function injectPath(url: string): string {
  // Absolute URLs (proxied/forwarded captures) reduce to their path.
  if (url.includes('://')) {
    try {
      const u = new URL(url);
      return u.pathname + u.search + u.hash;
    } catch {
      return '/';
    }
  }
  if (!url.startsWith('/')) return `/${url}`;
  return url;
}

async function injectRequest(port: number, original: ExecutionRecord, budgetMs: number): Promise<number> {
  const req = original.request!;
  const method = METHOD_RE.test(req.method) ? req.method : 'GET';
  const path = injectPath(req.url);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_HEADERS.has(k.toLowerCase())) continue;
    // Header names/values came from a stored record — drop anything fetch
    // rejects rather than failing the whole injection.
    try {
      headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    } catch {
      continue;
    }
  }
  const body =
    req.body === undefined || req.method === 'GET' || req.method === 'HEAD'
      ? undefined
      : req.bodyBase64
        ? Buffer.from(req.body, 'base64')
        : req.body;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, budgetMs));
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body,
      signal: controller.signal,
      redirect: 'manual',
    });
    await res.arrayBuffer(); // drain
    return res.status;
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      throw new ReplayError(`injected request timed out after ${budgetMs}ms`, 'TIMEOUT');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
