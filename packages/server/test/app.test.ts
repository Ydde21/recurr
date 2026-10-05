import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionRecord } from '@recurr/core';
import { FileStore, HttpStore } from '@recurr/store';
import { createApp } from '../src/app.js';

let tmp: string;
let baseUrl: string;
let server: import('node:http').Server;

function rec(id: string, kind: 'incident' | 'replay' = 'incident'): ExecutionRecord {
  return {
    schemaVersion: 1,
    id,
    kind,
    service: { name: 'svc', runtime: 'node v26' },
    environment: { name: 'test' },
    capturedAt: new Date().toISOString(),
    trigger: { type: 'http' },
    request: { method: 'GET', url: '/x', path: '/x', headers: {} },
    response: { status: 200, headers: {}, durationMs: 1 },
    seed: { startedAtWallMs: 0, random: [], uuids: [], prngSeed: 0 },
    events: [],
    redaction: { redactedPaths: [], truncatedPaths: [] },
  };
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'recurr-server-'));
  const app = createApp(new FileStore(tmp));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  server?.closeAllConnections?.();
  server?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe('collector API', () => {
  it('ingests and serves a valid record', async () => {
    const res = await fetch(`${baseUrl}/v1/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rec('RUN-SRV001')),
    });
    expect(res.status).toBe(201);
    const got = await fetch(`${baseUrl}/v1/executions/RUN-SRV001`);
    expect(got.status).toBe(200);
    expect((await got.json()).id).toBe('RUN-SRV001');
  });

  it('rejects malformed JSON bodies with 400', async () => {
    const res = await fetch(`${baseUrl}/v1/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{broken json',
    });
    expect(res.status).toBe(400);
  });

  it('rejects structurally invalid records with 400', async () => {
    for (const bad of [{}, { id: 'x' }, { ...rec('RUN-EVIL'), id: '../x' }]) {
      const res = await fetch(`${baseUrl}/v1/executions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bad),
      });
      expect(res.status).toBe(400);
    }
  });

  it('rejects traversal ids on GET without touching the fs', async () => {
    const res = await fetch(`${baseUrl}/v1/executions/..%2F..%2Fetc%2Fpasswd`);
    expect(res.status).toBe(400);
  });

  it('404s on missing records', async () => {
    const res = await fetch(`${baseUrl}/v1/executions/RUN-MISSING`);
    expect(res.status).toBe(404);
  });

  it('validates regression scenario posts', async () => {
    const res = await fetch(`${baseUrl}/v1/regressions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '../x', incidentId: 'RUN-A', name: 'n' }),
    });
    expect(res.status).toBe(400);
    const ok = await fetch(`${baseUrl}/v1/regressions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'REG-SRV1', incidentId: 'RUN-SRV001', name: 'n', createdAt: new Date().toISOString() }),
    });
    expect(ok.status).toBe(201);
    expect((await (await fetch(`${baseUrl}/v1/regressions`)).json()).length).toBe(1);
  });
});

describe('replay endpoints', () => {
  let specUrl: string;
  let specServer: import('node:http').Server;

  beforeAll(async () => {
    // A storeSpec makes replay endpoints reachable; validation failures return
    // before any child is spawned, so a bogus spec is safe here.
    const app = createApp(new FileStore(tmp), { storeSpec: `file://${tmp}` });
    await new Promise<void>((resolve) => {
      specServer = app.listen(0, '127.0.0.1', resolve);
    });
    const addr = specServer.address();
    specUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(() => {
    specServer?.closeAllConnections?.();
    specServer?.close();
  });

  it('reports healthz metadata', async () => {
    const res = await fetch(`${specUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schemaVersion).toBe(1);
    expect(body.store).toBe(`file://${tmp}`);
  });

  it('501s replay when the server has no resolvable store spec', async () => {
    const res = await fetch(`${baseUrl}/v1/incidents/RUN-SRV001/replays`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'node x.js' }),
    });
    expect(res.status).toBe(501);
    const reg = await fetch(`${baseUrl}/v1/regressions/REG-SRV1/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'node x.js' }),
    });
    expect(reg.status).toBe(501);
  });

  it('rejects invalid replay request bodies with 400', async () => {
    for (const bad of [{}, { command: '' }, { command: 'x', timeoutMs: 5 }, { command: 'x', env: { k: 1 } }]) {
      const res = await fetch(`${specUrl}/v1/incidents/RUN-SRV001/replays`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bad),
      });
      expect(res.status).toBe(400);
    }
  });

  it('404s a regression run for an unknown scenario', async () => {
    const res = await fetch(`${specUrl}/v1/regressions/REG-NOPE/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'node x.js' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('HttpStore', () => {
  it('round-trips records against the live server', async () => {
    const hs = new HttpStore(baseUrl);
    await hs.save(rec('RUN-HTTP01'));
    expect((await hs.get('RUN-HTTP01'))?.response?.status).toBe(200);
    const list = await hs.list({ kind: 'incident' });
    expect(list.some((s) => s.id === 'RUN-HTTP01')).toBe(true);
    expect(await hs.get('RUN-NOPE9')).toBeNull();
  });

  it('fails cleanly when the server is down', async () => {
    const hs = new HttpStore('http://127.0.0.1:1');
    await expect(hs.get('RUN-X')).rejects.toThrow();
    await expect(hs.list()).rejects.toThrow();
  });
});
