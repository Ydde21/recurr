import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import express, { type Express } from 'express';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExecutionRecord } from '@recurr/core';
import { FileStore } from '@recurr/store';
import { init } from '../src/index.js';

/**
 * Concurrency suite — cross-request contamination, nested ALS contexts,
 * concurrent persistence, event attribution under interleaving.
 */

const dirs: string[] = [];
async function tmpDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'recurr-conc-'));
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
import http from 'node:http';

describe('concurrency — context isolation and persistence', () => {
  it('interleaved requests: custom events attributed to the right record', async () => {
    const storeDir = await tmpDir();
    const recurr = await init({ service: 'conc-attr', store: `fs:${storeDir}`, capture: { on: 'always' } });
    const app = express();
    app.use(recurr.middleware());
    app.get('/e/:tag', async (req, res) => {
      const tag = req.params.tag;
      recurr.recordEvent('mark', { tag, seq: 1 });
      await new Promise((r) => setTimeout(r, Math.random() * 40));
      recurr.recordEvent('mark', { tag, seq: 2 });
      await new Promise((r) => setTimeout(r, Math.random() * 40));
      recurr.recordEvent('mark', { tag, seq: 3 });
      res.json({ tag });
    });
    const { port, close } = await serve(app);

    await Promise.all(
      ['alpha', 'beta', 'gamma', 'delta'].map((tag) => fetch(`http://127.0.0.1:${port}/e/${tag}`)),
    );
    await recurr.flush();
    const recs = await recordsIn(storeDir);
    expect(recs.length).toBe(4);
    for (const rec of recs) {
      const tag = JSON.parse(rec.response!.body!).tag as string;
      const marks = rec.events.filter((e) => e.kind === 'custom');
      // Each record must carry exactly its own 3 marks in order — no leakage.
      expect(marks.map((m) => (m.data as { tag: string }).tag)).toEqual([tag, tag, tag]);
      expect(marks.map((m) => (m.data as { seq: number }).seq)).toEqual([1, 2, 3]);
      expect(rec.request?.path).toBe(`/e/${tag}`);
    }
    close();
  });

  it('app-owned AsyncLocalStorage nested inside the request ctx does not break capture', async () => {
    const storeDir = await tmpDir();
    const recurr = await init({ service: 'conc-als', store: `fs:${storeDir}`, capture: { on: 'always' } });
    const appAls = new AsyncLocalStorage<{ n: number }>();
    const app = express();
    app.use(recurr.middleware());
    app.get('/nested', async (_req, res) => {
      // App wraps part of its work in its own ALS — recurr's ctx must survive.
      const inner = await appAls.run({ n: 42 }, async () => {
        recurr.recordEvent('inside', {});
        await new Promise((r) => setTimeout(r, 5));
        return appAls.getStore()?.n;
      });
      recurr.recordEvent('outside', {});
      res.json({ inner });
    });
    const { port, close } = await serve(app);
    const res = await fetch(`http://127.0.0.1:${port}/nested`);
    expect((await res.json()).inner).toBe(42);
    await recurr.flush();
    const recs = await recordsIn(storeDir);
    expect(recs.length).toBe(1);
    // Both events landed — the app ALS didn't swallow the recurr ctx.
    const names = recs[0].events.filter((e) => e.kind === 'custom').map((e) => e.name);
    expect(names).toEqual(['inside', 'outside']);
    close();
  });

  it('concurrent FileStore.save to the same dir never collides or corrupts', async () => {
    const dir = await tmpDir();
    const store = new FileStore(dir);
    const mk = (i: number): ExecutionRecord => ({
      schemaVersion: 1,
      id: `RUN-C${i.toString().padStart(4, '0')}`,
      kind: 'incident',
      service: { name: 'conc-save' },
      environment: { name: 'test' },
      capturedAt: new Date().toISOString(),
      trigger: { type: 'http' },
      request: { method: 'GET', path: `/${i}`, headers: {} },
      response: { status: 200, headers: {}, durationMs: 1 },
      events: [],
      seed: { startedAtWallMs: 0, random: [], uuids: [], timeReads: 0 },
      redaction: { redactedPaths: [], truncatedPaths: [] },
    });
    const N = 60;
    await Promise.all(Array.from({ length: N }, (_, i) => store.save(mk(i))));
    const listed = await store.list();
    expect(listed.length).toBe(N);
    for (let i = 0; i < N; i++) {
      const rec = await store.get(`RUN-C${i.toString().padStart(4, '0')}`);
      expect(rec?.request?.path).toBe(`/${i}`);
    }
    // No stray tmp files left behind.
    const files = await readdir(path.join(dir, 'executions'));
    expect(files.every((f) => /^RUN-C\d{4}\.json$/.test(f))).toBe(true);
  });

  it('a burst of 25 requests while an error request also runs → all records consistent', async () => {
    const storeDir = await tmpDir();
    const recurr = await init({ service: 'conc-mix', store: `fs:${storeDir}`, capture: { on: 'always' } });
    const app = express();
    app.use(recurr.middleware());
    app.get('/ok/:i', async (_req, res) => {
      await new Promise((r) => setTimeout(r, Math.random() * 30));
      res.json({ ok: true });
    });
    app.get('/boom', async (_req, _res, next) => {
      await new Promise((r) => setTimeout(r, 10));
      next(new Error('kaboom')); // express 4 doesn't catch async throws
    });
    // Error middleware order: routes → recurr error capture → app's own handler.
    app.use(recurr.errorMiddleware());
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ err: err.message });
    });
    const { port, close } = await serve(app);

    const reqs = Array.from({ length: 25 }, (_, i) => fetch(`http://127.0.0.1:${port}/ok/${i}`));
    reqs.push(fetch(`http://127.0.0.1:${port}/boom`));
    const ress = await Promise.all(reqs);
    expect(ress.filter((r) => r.status === 500).length).toBe(1);
    await recurr.flush();
    const recs = await recordsIn(storeDir);
    expect(recs.length).toBe(26);
    const boom = recs.find((r) => r.request?.path === '/boom');
    expect(boom?.error?.message).toBe('kaboom');
    expect(boom?.response?.status).toBe(500);
    // The error record didn't contaminate healthy records.
    const oks = recs.filter((r) => r.request?.path !== '/boom');
    expect(oks.every((r) => !r.error && r.response?.status === 200)).toBe(true);
    close();
  });

  it('slow + fast requests finishing out of order keep correct response/status', async () => {
    const storeDir = await tmpDir();
    const recurr = await init({ service: 'conc-ord', store: `fs:${storeDir}`, capture: { on: 'always' } });
    const app = express();
    app.use(recurr.middleware());
    app.get('/v/:ms', async (req, res) => {
      await new Promise((r) => setTimeout(r, Number(req.params.ms)));
      res.status(201).json({ ms: Number(req.params.ms) });
    });
    const { port, close } = await serve(app);
    await Promise.all([
      fetch(`http://127.0.0.1:${port}/v/150`),
      fetch(`http://127.0.0.1:${port}/v/10`),
      fetch(`http://127.0.0.1:${port}/v/80`),
    ]);
    await recurr.flush();
    const recs = await recordsIn(storeDir);
    expect(recs.length).toBe(3);
    for (const rec of recs) {
      const ms = Number(rec.request!.path!.split('/')[2]);
      expect(JSON.parse(rec.response!.body!).ms).toBe(ms);
      expect(rec.response?.status).toBe(201);
      expect(rec.response?.durationMs).toBeGreaterThanOrEqual(Math.min(ms - 5, ms));
    }
    close();
  });
});
