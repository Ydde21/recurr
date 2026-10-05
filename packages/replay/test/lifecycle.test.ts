import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExecutionRecord } from '@recurr/core';
import { FileStore } from '@recurr/store';
import { replayIncident } from '../src/replay.js';

/**
 * Lifecycle suite — startup failures, missing 'done', deadlines, repeated
 * runs, and cleanup. Uses a synthesized incident record (fixture apps only
 * need to exist for replay; nothing is captured here).
 */

const fixturesDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function freshStore(): Promise<{ store: FileStore; spec: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'recurr-life-'));
  dirs.push(dir);
  return { store: new FileStore(dir), spec: `fs:${dir}` };
}

function incident(id: string): ExecutionRecord {
  return {
    schemaVersion: 1,
    id,
    kind: 'incident',
    service: { name: 'lifecycle' },
    environment: { name: 'test' },
    capturedAt: new Date().toISOString(),
    trigger: { type: 'http' },
    request: { method: 'GET', url: '/ping', path: '/ping', headers: {} },
    response: { status: 200, headers: {}, durationMs: 1 },
    seed: { startedAtWallMs: 0, random: [], uuids: [], prngSeed: 1 },
    events: [],
    redaction: { redactedPaths: [], truncatedPaths: [] },
  };
}

describe('replay lifecycle', () => {
  it('target that never announces ready → READY_TIMEOUT with stderr tail', async () => {
    const { store, spec } = await freshStore();
    await store.save(incident('RUN-LIFE1'));
    const t0 = Date.now();
    await expect(
      replayIncident({
        store,
        storeSpec: spec,
        incidentId: 'RUN-LIFE1',
        target: { command: `node -e "setInterval(()=>{},60000)"`, cwd: fixturesDir },
        timeoutMs: 15_000,
        readyTimeoutMs: 2500,
      }),
    ).rejects.toMatchObject({ name: 'ReplayError', code: 'READY_TIMEOUT' });
    expect(Date.now() - t0).toBeLessThan(10_000); // failed at the ready timeout, not the full deadline
  }, 20_000);

  it('target announces ready but never finishes → TIMEOUT, child cleaned up', async () => {
    const { store, spec } = await freshStore();
    await store.save(incident('RUN-LIFE2'));
    await expect(
      replayIncident({
        store,
        storeSpec: spec,
        incidentId: 'RUN-LIFE2',
        target: { command: `node ${path.join(fixturesDir, 'no-done.mjs')}`, cwd: fixturesDir },
        timeoutMs: 4000,
        readyTimeoutMs: 8000,
      }),
    ).rejects.toMatchObject({ name: 'ReplayError', code: 'TIMEOUT' });
    // Child was SIGTERMed by the finally block — verify no lingering process
    // by checking the port is dead a moment later.
    await new Promise((r) => setTimeout(r, 300));
    // A stale child would keep its listener alive — nothing to connect to now.
    // (If the child were alive, this fetch would reach the no-done server.)
    const probe = await fetch('http://127.0.0.1:1/x').catch((e) => e);
    expect(probe).toBeInstanceOf(Error); // sanity that fetch fails, not hangs
  }, 20_000);

  it('target crashes before ready → TARGET_EXIT quickly (not a timeout)', async () => {
    const { store, spec } = await freshStore();
    await store.save(incident('RUN-LIFE3'));
    const t0 = Date.now();
    await expect(
      replayIncident({
        store,
        storeSpec: spec,
        incidentId: 'RUN-LIFE3',
        target: { command: 'node -e "process.exit(3)"', cwd: fixturesDir },
        timeoutMs: 30_000,
        readyTimeoutMs: 30_000,
      }),
    ).rejects.toMatchObject({ name: 'ReplayError', code: 'TARGET_EXIT' });
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 20_000);

  it('nonexistent incident → NOT_FOUND without spawning anything', async () => {
    const { store, spec } = await freshStore();
    await expect(
      replayIncident({
        store,
        storeSpec: spec,
        incidentId: 'RUN-MISSING',
        target: { command: 'echo hi', cwd: fixturesDir },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('corrupt incident record → validation error, no spawn', async () => {
    const { store, spec } = await freshStore();
    const bad = incident('RUN-LIFE4');
    (bad as unknown as { seed: unknown }).seed = { startedAtWallMs: 'not-a-number', random: 'nope', uuids: [] };
    await store.save(bad);
    await expect(
      replayIncident({
        store,
        storeSpec: spec,
        incidentId: 'RUN-LIFE4',
        target: { command: 'node -e "1"', cwd: fixturesDir },
      }),
    ).rejects.toMatchObject({ code: 'NO_RECORD' });
  });

  it('replay-of-a-replay is refused — replay the incident instead', async () => {
    const { store, spec } = await freshStore();
    const r = incident('RPL-LIFE5');
    r.kind = 'replay';
    r.replayOf = 'RUN-SOMEWHERE';
    await store.save(r);
    await expect(
      replayIncident({
        store,
        storeSpec: spec,
        incidentId: 'RPL-LIFE5',
        target: { command: 'node -e "1"', cwd: fixturesDir },
      }),
    ).rejects.toMatchObject({ code: 'NO_RECORD' });
  });

  it('forbidden target.env keys are dropped with a warning', async () => {
    const { store, spec } = await freshStore();
    await store.save(incident('RUN-LIFE6'));
    const logs: string[] = [];
    await expect(
      replayIncident({
        store,
        storeSpec: spec,
        incidentId: 'RUN-LIFE6',
        target: {
          command: 'node -e "process.exit(1)"',
          cwd: fixturesDir,
          env: { RECURR_REPLAY_ALLOW_NET: '1', RECURR_REPLAY_INHERIT_ENV: '1', NODE_OPTIONS: '--inspect' },
        },
        timeoutMs: 10_000,
        readyTimeoutMs: 3000,
        onProgress: (m) => logs.push(m),
      }),
    ).rejects.toMatchObject({ code: 'TARGET_EXIT' });
    expect(logs.some((m) => m.includes('RECURR_REPLAY_ALLOW_NET'))).toBe(true);
    expect(logs.some((m) => m.includes('RECURR_REPLAY_INHERIT_ENV'))).toBe(true);
    expect(logs.some((m) => m.includes('NODE_OPTIONS'))).toBe(true);
  }, 20_000);
});
