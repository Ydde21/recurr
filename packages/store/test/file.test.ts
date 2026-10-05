import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExecutionRecord } from '@recurr/core';
import { FileStore } from '../src/file.js';
import { openStore } from '../src/index.js';

const dirs: string[] = [];

async function tmpStore(): Promise<FileStore> {
  const dir = await mkdtemp(path.join(tmpdir(), 'recurr-store-'));
  dirs.push(dir);
  return new FileStore(dir);
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

function rec(id: string, kind: 'incident' | 'replay' = 'incident', replayOf?: string): ExecutionRecord {
  return {
    schemaVersion: 1,
    id,
    kind,
    replayOf,
    service: { name: 'svc', runtime: 'node v26' },
    environment: { name: 'test' },
    capturedAt: new Date().toISOString(),
    trigger: { type: 'http' },
    request: { method: 'POST', url: '/x', path: '/x', headers: {} },
    response: { status: 500, headers: {}, durationMs: 12 },
    seed: { startedAtWallMs: 0, random: [], uuids: [], prngSeed: 0 },
    events: [],
    redaction: { redactedPaths: [], truncatedPaths: [] },
  };
}

describe('FileStore', () => {
  it('round-trips records', async () => {
    const store = await tmpStore();
    await store.save(rec('RUN-T0001'));
    const got = await store.get('RUN-T0001');
    expect(got?.id).toBe('RUN-T0001');
    expect(got?.response?.status).toBe(500);
  });

  it('lists summaries newest-first with filters', async () => {
    const store = await tmpStore();
    const a = rec('RUN-T0002');
    const b = rec('RUN-T0003');
    b.capturedAt = new Date(Date.now() + 1000).toISOString();
    const r = rec('RPL-T0001', 'replay', 'RUN-T0002');
    await store.save(a);
    await store.save(b);
    await store.save(r);
    const incidents = await store.list({ kind: 'incident' });
    expect(incidents.map((s) => s.id)).toEqual(['RUN-T0003', 'RUN-T0002']);
    const replays = await store.listReplays('RUN-T0002');
    expect(replays.map((s) => s.id)).toEqual(['RPL-T0001']);
  });

  it('returns null for missing records', async () => {
    const store = await tmpStore();
    expect(await store.get('RUN-NOPE1')).toBeNull();
  });

  it('rejects path-traversal record ids', async () => {
    const store = await tmpStore();
    await expect(store.save(rec('../escape'))).rejects.toThrow(/invalid record id/);
    await expect(store.get('../../secret')).rejects.toThrow(/invalid record id/);
    await expect(
      store.saveRegression({ id: '../reg', incidentId: 'RUN-X', name: 'x', createdAt: new Date().toISOString() }),
    ).rejects.toThrow(/invalid record id/);
  });

  it('reports corrupt record files clearly', async () => {
    const store = await tmpStore();
    await store.save(rec('RUN-CORRUPT'));
    const dir = path.join((store as unknown as { dir: string }).dir, 'executions');
    await (await import('node:fs/promises')).writeFile(path.join(dir, 'RUN-CORRUPT.json'), '{broken!!');
    await expect(store.get('RUN-CORRUPT')).rejects.toThrow(/corrupt/);
  });

  it('untrusted files: hostile ids inside records cannot escape; non-object JSON is skipped', async () => {
    const store = await tmpStore();
    const dir = path.join((store as unknown as { dir: string }).dir, 'executions');
    const fs = await import('node:fs/promises');
    await fs.mkdir(dir, { recursive: true });
    // A record file whose embedded id is hostile — listing survives it,
    // and fetching by that id is still rejected at the boundary.
    const hostile = rec('RUN-SAFE99');
    hostile.id = '../../escape';
    await fs.writeFile(path.join(dir, 'RUN-SAFE99.json'), JSON.stringify(hostile));
    // Non-object JSON that happens to parse.
    await fs.writeFile(path.join(dir, 'RUN-ARRAY1.json'), '[1,2,3]');
    await fs.writeFile(path.join(dir, 'RUN-STRING.json'), '"just a string"');
    const listed = await store.list();
    // The hostile-id record lists under its hostile name but cannot be read back out.
    expect(listed.some((s) => s.id === '../../escape')).toBe(true);
    await expect(store.get('../../escape')).rejects.toThrow(/invalid record id/);
    // Non-object files are skipped, not fatal.
    expect(listed.some((s) => s.id === 'RUN-ARRAY1')).toBe(false);
  });

  it('openStore resolves fs: specs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'recurr-spec-'));
    dirs.push(dir);
    const s = openStore(`fs:${dir}`);
    expect(s).toBeInstanceOf(FileStore);
  });
});
