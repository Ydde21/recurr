import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileStore } from '@recurr-dev/store';
import { replayIncident, ReplayError, sanitizeEnv } from '../src/replay.js';

/**
 * End-to-end: real checkout-api process (pg-mem db, fetch payment call)
 * → capture incident → replay in fresh process → diff → fixed-build replay.
 */

const demoDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../examples/checkout-demo');
const PAYMENT_PORT = 14781;
const API_PORT = 14790;

const children: ChildProcess[] = [];
let tmp: string;
let storeSpec: string;
let store: FileStore;
let incidentId: string;

function launch(file: string, env: Record<string, string>): ChildProcess {
  const p = spawn('node', [`dist/${file}`], {
    cwd: demoDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(p);
  return p;
}

async function waitReady(url: string, tries = 80): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} never became ready`);
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'recurr-e2e-'));
  storeSpec = `fs:${path.join(tmp, 'store')}`;
  store = new FileStore(path.join(tmp, 'store'));

  launch('payment-sim.js', { PAYMENT_PORT: String(PAYMENT_PORT) });
  launch('index.js', {
    PORT: String(API_PORT),
    PAYMENT_URL: `http://127.0.0.1:${PAYMENT_PORT}`,
    RECURR_STORE: storeSpec,
  });
  await waitReady(`http://127.0.0.1:${PAYMENT_PORT}/healthz`);
  await waitReady(`http://127.0.0.1:${API_PORT}/healthz`);

  // Trigger the bug — $899 order hangs the payment sim past the timeout.
  const res = await fetch(`http://127.0.0.1:${API_PORT}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer demo-u1' },
    body: JSON.stringify({ items: [{ sku: 'sku-server', qty: 1 }] }),
  });
  expect(res.status).toBe(500);

  const dir = path.join(tmp, 'store', 'executions');
  for (let i = 0; i < 40 && !incidentId; i++) {
    const files = await readdir(dir).catch(() => [] as string[]);
    incidentId = files.find((f) => f.startsWith('RUN-') && f.endsWith('.json'))?.replace('.json', '') ?? '';
    if (!incidentId) await new Promise((r) => setTimeout(r, 250));
  }
  expect(incidentId).toMatch(/^RUN-/);
}, 120_000);

afterAll(async () => {
  for (const c of children) c.kill('SIGTERM');
  await rm(tmp, { recursive: true, force: true });
});

describe('e2e capture → replay → diff', () => {
  it('captured a rich incident record', async () => {
    const rec = await store.get(incidentId);
    expect(rec).not.toBeNull();
    expect(rec!.response?.status).toBe(500);
    expect(rec!.error?.name).toBe('PaymentConfirmationTimeout');
    const kinds = rec!.events.map((e) => e.kind);
    expect(kinds).toContain('http.in');
    expect(kinds).toContain('db.query');
    expect(kinds).toContain('http.out');
    expect(kinds).toContain('retry');
    // auth principal captured, credential redacted
    expect(rec!.auth?.principal).toMatchObject({ userId: 'u1' });
    expect(rec!.request!.headers.authorization).toBe('[REDACTED]');
    // nondeterminism captured
    expect(rec!.seed.uuids.length).toBeGreaterThan(0);
  });

  it('replays the incident deterministically — same outcome', async () => {
    const { replay, report, observedStatus } = await replayIncident({
      store,
      storeSpec,
      incidentId,
      target: {
        command: 'node dist/index.js',
        cwd: demoDir,
        env: { RECURR_STORE: storeSpec, PAYMENT_URL: `http://127.0.0.1:${PAYMENT_PORT}` },
      },
      timeoutMs: 45_000,
    });
    expect(observedStatus).toBe(500);
    expect(replay.response?.status).toBe(500);
    expect(replay.error?.name).toBe('PaymentConfirmationTimeout');
    // The route sits behind authMiddleware — the bearer credential was
    // redacted, so reaching the handler proves recurr.auth() served the
    // captured principal (a 401 here would mean auth replay regressed).
    expect(replay.response?.status).not.toBe(401);
    expect(report.outcomeMatch).toBe(true);
    // payment API was mocked — replay ran in ms not the original ~2.4s
    expect(replay.response!.durationMs).toBeLessThan(5000);
    // deterministic: replayed uuid → same order id in response body
    const origBody = JSON.parse((await store.get(incidentId))!.response!.body!);
    const replayBody = JSON.parse(replay.response!.body!);
    expect(replayBody).toEqual(origBody);
    expect(report.matchScore).toBeGreaterThanOrEqual(95);
    const origTimeouts = (await store.get(incidentId))!.events.filter((e) => e.kind === 'http.out').length;
    const replayTimeouts = replay.events.filter((e) => e.kind === 'http.out').length;
    expect(replayTimeouts).toBe(origTimeouts);
  }, 60_000);

  it('never performs real egress during replay — recorded timeouts are served from the record', async () => {
    // Point PAYMENT_URL at a dead address. If interception failed, the real
    // fetch would produce ECONNREFUSED ('reset'), not the recorded 'timeout'.
    const { replay, report } = await replayIncident({
      store,
      storeSpec,
      incidentId,
      target: {
        command: 'node dist/index.js',
        cwd: demoDir,
        env: { RECURR_STORE: storeSpec, PAYMENT_URL: 'http://127.0.0.1:1/dead' },
      },
      timeoutMs: 45_000,
    });
    const outs = replay.events.filter((e) => e.kind === 'http.out');
    expect(outs.length).toBeGreaterThan(0);
    for (const e of outs) {
      expect((e.data as { errorKind?: string }).errorKind).toBe('timeout');
    }
    // outcome still matches — the app never touched the real network
    expect(replay.response?.status).toBe(500);
    expect(report.outcomeMatch).toBe(true);
    // URL mismatch vs the recorded call surfaces as replay.note divergence
    expect(replay.events.some((e) => e.kind === 'replay.note')).toBe(true);
  }, 60_000);

  it('verifies the fix — replay against the fixed build flips the outcome', async () => {
    const { replay, report } = await replayIncident({
      store,
      storeSpec,
      incidentId,
      target: {
        command: 'node dist/index-fixed.js',
        cwd: demoDir,
        env: { RECURR_STORE: storeSpec, PAYMENT_URL: 'http://127.0.0.1:1/unreachable' },
      },
      timeoutMs: 45_000,
    });
    expect(replay.response?.status).toBe(202);
    expect(report.outcomeMatch).toBe(false);
    expect(report.statusChanged).toBe(true);
    expect(report.divergences.some((d) => d.type === 'response-status')).toBe(true);
  }, 60_000);

  it('concurrent replays of the same incident both succeed and persist distinct records', async () => {
    const [a, b] = await Promise.all([
      replayIncident({
        store,
        storeSpec,
        incidentId,
        target: {
          command: 'node dist/index.js',
          cwd: demoDir,
          env: { RECURR_STORE: storeSpec, PAYMENT_URL: 'http://127.0.0.1:1/dead' },
        },
        timeoutMs: 45_000,
      }),
      replayIncident({
        store,
        storeSpec,
        incidentId,
        target: {
          command: 'node dist/index.js',
          cwd: demoDir,
          env: { RECURR_STORE: storeSpec, PAYMENT_URL: 'http://127.0.0.1:1/dead' },
        },
        timeoutMs: 45_000,
      }),
    ]);
    expect(a.replay.id).not.toBe(b.replay.id);
    expect(a.report.outcomeMatch).toBe(true);
    expect(b.report.outcomeMatch).toBe(true);
    // Both replay records persisted against the same incident.
    const replays = await store.listReplays(incidentId);
    expect(replays.length).toBeGreaterThanOrEqual(2);
    const ids = new Set(replays.map((r) => r.id));
    expect(ids.has(a.replay.id)).toBe(true);
    expect(ids.has(b.replay.id)).toBe(true);
  }, 90_000);

  it('strips sensitive env vars from the replay child', () => {
    const env = sanitizeEnv({
      PATH: '/usr/bin',
      AWS_SECRET_ACCESS_KEY: 'sekret',
      DATABASE_URL: 'postgres://prod',
      NPM_TOKEN: 'tok',
      PAYMENT_API_KEY: 'key',
      PGSSLROOTCERT: '/cert',
      NODE_ENV: 'development',
    } as NodeJS.ProcessEnv);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.NODE_ENV).toBe('development');
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.PAYMENT_API_KEY).toBeUndefined();
    expect(env.PGSSLROOTCERT).toBeUndefined();
  });

  it('fails fast when the target crashes during startup', async () => {
    const t0 = Date.now();
    await expect(
      replayIncident({
        store,
        storeSpec,
        incidentId,
        target: { command: 'node -e process.exit(1)', cwd: demoDir },
        timeoutMs: 30_000,
        readyTimeoutMs: 30_000,
      }),
    ).rejects.toMatchObject({ name: 'ReplayError', code: 'TARGET_EXIT' });
    // Should fail in well under the ready timeout — not hang.
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 45_000);

  it('fails clearly when the target command does not exist', async () => {
    await expect(
      replayIncident({
        store,
        storeSpec,
        incidentId,
        target: { command: 'recurr-definitely-not-a-real-binary-xyz serve', cwd: demoDir },
        timeoutMs: 30_000,
      }),
    ).rejects.toMatchObject({ name: 'ReplayError', code: 'TARGET_EXIT' });
  }, 45_000);

  it('rejects malformed timeouts', async () => {
    await expect(
      replayIncident({
        store,
        storeSpec,
        incidentId,
        target: { command: 'node dist/index.js', cwd: demoDir },
        timeoutMs: Number.NaN,
      }),
    ).rejects.toMatchObject({ code: 'BAD_ARGS' });
    await expect(
      replayIncident({ store, storeSpec, incidentId, target: { command: '', cwd: demoDir } }),
    ).rejects.toBeInstanceOf(ReplayError);
  });
});
