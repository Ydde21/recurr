import { mkdtemp, readdir, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express, { type Express } from 'express';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExecutionRecord } from '@recurr/core';
import { FileStore } from '@recurr/store';
import { init } from '../src/index.js';

/**
 * Soak suite — payload sizes, backpressure, concurrency, repeated captures.
 *
 * What this proves:
 *  - Records stay bounded by maxBodyBytes regardless of payload size —
 *    a 10 MB request must NOT produce a 10 MB record or crash capture.
 *  - Oversized captures are marked in redaction.truncatedPaths — honest,
 *    never silently dropped or silently complete.
 *  - Concurrent/repeated requests each get their own record with isolated
 *    seeds (no cross-request contamination).
 *  - The SDK keeps working under load — capture is additive, not fragile.
 */

const dirs: string[] = [];
async function tmpDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'recurr-soak-'));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function serve(app: Express): Promise<{ port: number; close: () => void }> {
  const server = await new Promise<http.Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  return {
    port: (server.address() as { port: number }).port,
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

async function recordsIn(storeDir: string): Promise<ExecutionRecord[]> {
  const files = (await readdir(path.join(storeDir, 'executions'))).filter((f) => f.endsWith('.json'));
  const out: ExecutionRecord[] = [];
  for (const f of files) {
    const rec = await new FileStore(storeDir).get(f.replace('.json', ''));
    if (rec) out.push(rec);
  }
  return out;
}

const KB = 1024;
const MB = 1024 * 1024;

describe('capture soak — payload sizes and backpressure', () => {
  it.each([
    { label: '100KB', bytes: 100 * KB },
    { label: '1MB', bytes: 1 * MB },
    { label: '10MB', bytes: 10 * MB },
  ])('request body $label → record stays bounded and honestly truncated', async ({ bytes }) => {
    const storeDir = await tmpDir();
    const recurr = await init({ service: 'soak-req', store: `fs:${storeDir}`, capture: { on: 'always' } });
    const app = express();
    app.use(recurr.middleware());
    app.use(express.json({ limit: '25mb' }));
    app.post('/big', (_req, res) => res.json({ ok: true }));
    const { port, close } = await serve(app);

    const payload = JSON.stringify({ blob: 'x'.repeat(bytes) });
    const res = await fetch(`http://127.0.0.1:${port}/big`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    expect(res.status).toBe(200);
    await recurr.flush();
    const recs = await recordsIn(storeDir);
    expect(recs.length).toBe(1);
    const rec = recs[0];

    // The record must stay bounded by maxBodyBytes (64 KiB default + record
    // overhead) regardless of payload size — a 10MB request does NOT produce
    // a 10MB record.
    const file = path.join(storeDir, 'executions', `${rec.id}.json`);
    const fileSize = (await stat(file)).size;
    expect(fileSize).toBeLessThan(96 * KB);

    // Honest truncation — flagged, never silently dropped.
    if (bytes > 64 * KB) {
      expect(rec.redaction.truncatedPaths.length).toBeGreaterThan(0);
      expect(JSON.parse((await readFile(file, 'utf8'))).redaction.truncatedPaths.length).toBeGreaterThan(0);
    }
    // Record is still valid JSON → parseable downstream.
    const reparsed = JSON.parse(await readFile(file, 'utf8'));
    expect(reparsed.id).toBe(rec.id);
    close();
  });

  it('response body 5MB → streamed through tee, bounded in record', async () => {
    const storeDir = await tmpDir();
    const recurr = await init({ service: 'soak-res', store: `fs:${storeDir}`, capture: { on: 'always' } });
    const app = express();
    app.use(recurr.middleware());
    const big = 'y'.repeat(5 * MB);
    app.get('/dl', (_req, res) => {
      res.setHeader('content-type', 'text/plain');
      res.end(big);
    });
    const { port, close } = await serve(app);
    const res = await fetch(`http://127.0.0.1:${port}/dl`);
    expect((await res.text()).length).toBe(5 * MB); // app sees the FULL body
    await recurr.flush();
    const recs = await recordsIn(storeDir);
    expect(recs.length).toBe(1);
    const fileSize = (await stat(path.join(storeDir, 'executions', `${recs[0].id}.json`))).size;
    expect(fileSize).toBeLessThan(256 * KB);
    expect(recs[0].redaction.truncatedPaths).toContain('response.body');
    close();
  });

  it('outbound 2MB upstream body → captured bounded, app receives full body', async () => {
    const storeDir = await tmpDir();
    const recurr = await init({ service: 'soak-out', store: `fs:${storeDir}`, capture: { on: 'always' } });
    const upstream = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ blob: 'z'.repeat(2 * MB) }));
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const upPort = (upstream.address() as { port: number }).port;

    const app = express();
    app.use(recurr.middleware());
    app.get('/proxy', async (_req, res) => {
      const r = await fetch(`http://127.0.0.1:${upPort}/data`);
      const j = (await r.json()) as { blob: string };
      res.json({ len: j.blob.length });
    });
    const { port, close } = await serve(app);
    const res = await fetch(`http://127.0.0.1:${port}/proxy`);
    expect((await res.json()).len).toBe(2 * MB); // app received the full 2MB
    await recurr.flush();
    const recs = await recordsIn(storeDir);
    const httpOut = recs[0].events.find((e) => e.kind === 'http.out');
    expect(httpOut).toBeDefined();
    const fileSize = (await stat(path.join(storeDir, 'executions', `${recs[0].id}.json`))).size;
    expect(fileSize).toBeLessThan(256 * KB);
    upstream.close();
    close();
  });

  it('many concurrent requests → one record each, isolated seeds, no leakage', async () => {
    const storeDir = await tmpDir();
    const recurr = await init({ service: 'soak-conc', store: `fs:${storeDir}`, capture: { on: 'always' } });
    const app = express();
    app.use(recurr.middleware());
    app.get('/w/:id', async (req, res) => {
      const r = Math.random();
      await new Promise((ok) => setTimeout(ok, Math.floor(r * 30)));
      res.json({ id: req.params.id, r });
    });
    const { port, close } = await serve(app);

    const N = 40;
    const ress = await Promise.all(
      Array.from({ length: N }, (_, i) => fetch(`http://127.0.0.1:${port}/w/${i}`)),
    );
    for (const r of ress) expect(r.status).toBe(200);
    await recurr.flush();
    const recs = await recordsIn(storeDir);
    expect(recs.length).toBe(N);

    const ids = new Set(recs.map((r) => r.id));
    expect(ids.size).toBe(N); // no collisions / shared records
    for (const rec of recs) {
      // Every record's random seed must match the r it returned — proves no
      // cross-request seed leakage under concurrency.
      const body = JSON.parse(rec.response!.body!);
      expect(rec.seed.random.length).toBe(1);
      expect(rec.seed.random[0]).toBeCloseTo(body.r, 10);
      expect(rec.request?.path).toBe(body ? `/w/${body.id}` : '');
    }
    close();
  });

  it('repeated sequential requests → every capture independent', async () => {
    const storeDir = await tmpDir();
    const recurr = await init({ service: 'soak-seq', store: `fs:${storeDir}`, capture: { on: 'always' } });
    const app = express();
    app.use(recurr.middleware());
    app.get('/ping', (_req, res) => res.json({ t: Date.now() }));
    const { port, close } = await serve(app);
    const N = 25;
    for (let i = 0; i < N; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/ping`);
      expect(res.status).toBe(200);
    }
    await recurr.flush();
    const recs = await recordsIn(storeDir);
    expect(recs.length).toBe(N);
    const ids = new Set(recs.map((r) => r.id));
    expect(ids.size).toBe(N);
    close();
  });

  it('configurable maxBodyBytes — 1MB cap keeps a 512KB body intact', async () => {
    const storeDir = await tmpDir();
    const recurr = await init({
      service: 'soak-cap',
      store: `fs:${storeDir}`,
      capture: { on: 'always' },
      redaction: { maxBodyBytes: 1 * MB },
    });
    const app = express();
    app.use(recurr.middleware());
    app.use(express.json({ limit: '5mb' }));
    const body = 'q'.repeat(512 * KB);
    app.get('/mid', (_req, res) => {
      res.setHeader('content-type', 'text/plain');
      res.end(body);
    });
    const { port, close } = await serve(app);
    await fetch(`http://127.0.0.1:${port}/mid`);
    await recurr.flush();
    const recs = await recordsIn(storeDir);
    const rec = recs[0];
    // Under the 1MB cap the full body is kept — no truncation flags.
    expect(rec.response?.body?.length).toBe(body.length);
    expect(rec.redaction.truncatedPaths.length).toBe(0);
    close();
  });

  it('aborted client mid-response → partial record captured, not lost', async () => {
    const storeDir = await tmpDir();
    const recurr = await init({ service: 'soak-abort', store: `fs:${storeDir}`, capture: { on: 'always' } });
    const app = express();
    app.use(recurr.middleware());
    app.get('/slow', async (_req, res) => {
      res.setHeader('content-type', 'text/plain');
      res.write('chunk1-');
      await new Promise((r) => setTimeout(r, 300));
      res.end('chunk2'); // client already gone
    });
    const { port, close } = await serve(app);
    const controller = new AbortController();
    const p = fetch(`http://127.0.0.1:${port}/slow`, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 60));
    controller.abort();
    await p.catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    await recurr.flush();
    const recs = await recordsIn(storeDir);
    expect(recs.length).toBe(1);
    const rec = recs[0];
    // The partial capture is honest: labelled aborted, partial body kept.
    expect(rec.labels?.aborted).toBe('true');
    expect(rec.response?.body).toContain('chunk1-');
    close();
  });
});
