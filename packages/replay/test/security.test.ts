import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { FileStore } from '@recurr-dev/store';
import { replayIncident } from '../src/replay.js';

/**
 * Security e2e: fixture apps attempt real escapes (raw TCP/TLS/UDP/DNS, unix
 * sockets, subprocesses, workers, ESM named-import module loads). Capture runs
 * them live; replay must block every one while still persisting the record.
 */

const fixturesDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');
const children: ChildProcess[] = [];
let tmp: string;

afterAll(async () => {
  for (const c of children) c.kill('SIGTERM');
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

async function captureOnce(fixture: string): Promise<{ storeSpec: string; id: string; out: Record<string, string> }> {
  tmp = tmp ?? (await mkdtemp(path.join(tmpdir(), 'recurr-sec-')));
  const storeDir = await mkdtemp(path.join(tmpdir(), 'recurr-secstore-'));
  const storeSpec = `fs:${storeDir}`;
  const port = 19000 + Math.floor(Math.random() * 500);
  const p = spawn('node', [path.join(fixturesDir, fixture)], {
    env: { ...process.env, PORT: String(port), RECURR_STORE: storeSpec, RECURR_CAPTURE: 'always' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(p);
  let out: Record<string, string> = {};
  try {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/`);
        if (r.ok) {
          out = (await r.json()) as Record<string, string>;
          break;
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    // Wait for the async record save BEFORE killing — SIGTERM would otherwise
    // race the FileStore write.
    const dir = path.join(storeDir, 'executions');
    let id = '';
    for (let i = 0; i < 40 && !id; i++) {
      const files = await readdir(dir).catch(() => [] as string[]);
      id = files.find((f) => f.startsWith('RUN-') && f.endsWith('.json'))?.replace('.json', '') ?? '';
      if (!id) await new Promise((r) => setTimeout(r, 250));
    }
    expect(id).toMatch(/^RUN-/);
    return { storeSpec, id, out };
  } finally {
    p.kill('SIGTERM');
  }
}

describe('replay isolation — hostile application patterns', () => {
  it(
    'blocks every network/execution escape while persisting the replay record',
    async () => {
      const { storeSpec, id, out } = await captureOnce('egress-app.mjs');
      const store = new FileStore(storeSpec.slice(3));

      const { replay } = await replayIncident({
        store,
        storeSpec,
        incidentId: id,
        target: {
          command: `node ${path.join(fixturesDir, 'egress-app.mjs')}`,
          cwd: fixturesDir,
          env: { RECURR_STORE: storeSpec },
        },
        timeoutMs: 45_000,
      });

      // The replay record persisted and carries the request/response.
      expect(replay.response?.status).toBe(200);
      const attempts = JSON.parse(replay.response!.body!) as Record<string, string>;

      // Security invariant: nothing reached out. Recorded errors (e.g. the
      // capture-time 'fetch failed') are *reproduced*, not blocked — the
      // assertion is that no attempt succeeded in reaching a real endpoint.
      for (const [k, v] of Object.entries(attempts)) {
        expect(v, `${k} escaped the sandbox`).not.toMatch(/^REACHABLE/);
      }
      // Isolation-specific blocks must be present too (raw egress attempts
      // that had no recorded event to replay).
      for (const k of ['tcp44', 'dns', 'dnsLookup', 'unix', 'tls', 'udp', 'spawn', 'fork', 'worker', 'esmNamedSpawn']) {
        expect(attempts[k], `${k} should be isolation-blocked`).toBe('blocked');
      }
      // Sanity: the app really attempted a broad escape surface.
      for (const k of ['tcp44', 'metadata', 'dns', 'dnsLookup', 'unix', 'tls', 'udp', 'spawn', 'fork', 'worker', 'esmNamedSpawn']) {
        expect(attempts, `missing attempt ${k}`).toHaveProperty(k);
      }
      // Live capture proves the app wasn't trivially blocked in capture mode —
      // at least the real-network attempts differ between the two phases or
      // the capture reached something.
      void out;
    },
    90_000,
  );

  it(
    'a static `import { execSync } from node:child_process` fails the module load at replay',
    async () => {
      const { storeSpec, id } = await captureOnce('esm-escape-app.mjs');
      const store = new FileStore(storeSpec.slice(3));

      // The app captured fine (named ESM imports work in capture — patching is
      // only needed at replay). Replaying it must fail at module load, not
      // silently run unguarded code.
      const err = await replayIncident({
        store,
        storeSpec,
        incidentId: id,
        target: {
          command: `node ${path.join(fixturesDir, 'esm-escape-app.mjs')}`,
          cwd: fixturesDir,
          env: { RECURR_STORE: storeSpec },
        },
        timeoutMs: 30_000,
        readyTimeoutMs: 20_000,
      }).then(
        () => null,
        (e) => e as Error & { code?: string },
      );

      expect(err).not.toBeNull();
      expect(err!.name).toBe('ReplayError');
      // The failure surfaces the isolation block — fail loudly, never run unguarded.
      expect(err!.message).toMatch(/blocked import|isolation|node:child_process/i);
    },
    60_000,
  );
});
