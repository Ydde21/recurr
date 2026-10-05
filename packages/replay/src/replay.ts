import { spawn, type ChildProcess } from 'node:child_process';
import { diffExecutions, type DiffReport, type ExecutionRecord } from '@recurr/core';
import type { IncidentStore } from '@recurr/store';

export interface ReplayTarget {
  /** Command line to launch the app, e.g. "node dist/index.js". */
  command: string;
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
    readonly code: 'NOT_FOUND' | 'READY_TIMEOUT' | 'TARGET_EXIT' | 'TIMEOUT' | 'NO_RECORD',
  ) {
    super(message);
    this.name = 'ReplayError';
  }
}

/** Headers that must not be replayed verbatim — recomputed for the local target. */
const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'accept-encoding']);

function parseCommand(command: string): [string, string[]] {
  const parts = command.split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new ReplayError('empty target command', 'NO_RECORD');
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
  if (original.kind === 'replay' && original.replayOf) {
    throw new ReplayError(`${opts.incidentId} is a replay of ${original.replayOf} — replay the incident instead`, 'NO_RECORD');
  }
  if (!original.request) throw new ReplayError(`incident ${opts.incidentId} has no captured request`, 'NO_RECORD');

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 20_000;
  const [cmd, args] = parseCommand(opts.target.command);

  log(`reconstructing environment for ${original.id}…`);
  const child: ChildProcess = spawn(cmd, args, {
    cwd: opts.target.cwd ?? process.cwd(),
    env: {
      ...process.env,
      RECURR_MODE: 'replay',
      RECURR_REPLAY_OF: original.id,
      RECURR_STORE: opts.storeSpec,
      NODE_ENV: 'replay',
      ...opts.target.env,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  const stderr: Buffer[] = [];
  child.stderr?.on('data', (d: Buffer) => stderr.push(d));
  child.stdout?.on('data', (d: Buffer) => {
    if (opts.onProgress) process.stderr.write(d);
  });

  const deadline = Date.now() + timeoutMs;
  try {
    const port = await waitForMessage(child, 'recurr:ready', readyTimeoutMs).then((m) => m.port as number);
    log(`replay environment ready on 127.0.0.1:${port} — injecting ${original.request.method} ${original.request.url}`);

    const observed = await injectRequest(port, original, deadline - Date.now());
    log(`injected request → HTTP ${observed}`);

    const done = await waitForMessage(child, 'recurr:done', Math.max(1, deadline - Date.now()));
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
    const err = Buffer.concat(stderr).toString('utf8').trim();
    if (err) log(`target stderr: ${err.slice(-2000)}`);
  }
}

interface IpcMessage {
  type?: string;
  port?: number;
  id?: string;
}

function waitForMessage(child: ChildProcess, type: string, timeoutMs: number): Promise<IpcMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new ReplayError(`timed out waiting for ${type}`, type === 'recurr:ready' ? 'READY_TIMEOUT' : 'TIMEOUT'));
    }, timeoutMs);
    const onMsg = (m: IpcMessage) => {
      if (m?.type === type) {
        cleanup();
        resolve(m);
      }
    };
    const onExit = (code: number | null, signal: string | null) => {
      cleanup();
      reject(new ReplayError(`target exited (${code ?? signal}) while waiting for ${type}`, 'TARGET_EXIT'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMsg);
      child.off('exit', onExit);
    };
    child.on('message', onMsg);
    child.on('exit', onExit);
  });
}

async function injectRequest(port: number, original: ExecutionRecord, budgetMs: number): Promise<number> {
  const req = original.request!;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_HEADERS.has(k.toLowerCase())) continue;
    headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, budgetMs));
  try {
    const res = await fetch(`http://127.0.0.1:${port}${req.url}`, {
      method: req.method,
      headers,
      body: req.body && req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
      signal: controller.signal,
    });
    await res.arrayBuffer(); // drain
    return res.status;
  } finally {
    clearTimeout(timer);
  }
}
