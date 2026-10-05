import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExecutionRecord } from '@recurr/core';
import { FileStore } from '@recurr/store';
import { init, type Recurr } from '../src/index.js';
import type { Queryable } from '../src/patches/db.js';
import { EventEmitter } from 'node:events';

const dirs: string[] = [];
async function tmpDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'recurr-sdk-'));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function serve(app: Express): Promise<{ url: string; close: () => void }> {
  const server = await new Promise<import('node:http').Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const addr = server.address();
  return {
    url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`,
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

async function captured(storeDir: string, wait = 2500): Promise<ExecutionRecord[]> {
  const dir = path.join(storeDir, 'executions');
  const deadline = Date.now() + wait;
  let files: string[] = [];
  while (Date.now() < deadline) {
    files = await readdir(dir).catch(() => []);
    if (files.length) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  const out: ExecutionRecord[] = [];
  for (const f of files) {
    const rec = await new FileStore(storeDir).get(f.replace('.json', ''));
    if (rec) out.push(rec);
  }
  return out;
}

/** Fake pg-ish queryable for instrumentation tests. */
function fakeQueryable(rows: unknown[] = [], fail?: Error): Queryable {
  const impl = (...args: unknown[]) => {
    const cb = args.find((a): a is (err: unknown, res?: unknown) => void => typeof a === 'function');
    if (cb) {
      queueMicrotask(() => (fail ? cb(fail) : cb(null, { rows, rowCount: rows.length })));
      return undefined;
    }
    return fail ? Promise.reject(fail) : Promise.resolve({ rows, rowCount: rows.length });
  };
  return { query: impl } as unknown as Queryable;
}

describe('capture mode', () => {
  it('isolates concurrent request contexts — no seed/event leakage', async () => {
    const storeDir = await tmpDir();
    const recurr = await init({ service: 'svc', store: `fs:${storeDir}`, capture: { on: 'always' } });
    const app = express();
    app.use(recurr.middleware());
    app.get('/a', async (_req, res) => {
      const r = Math.random();
      await new Promise((ok) => setTimeout(ok, 30));
      res.json({ who: 'a', r, uuid: crypto.randomUUID() });
    });
    app.get('/b', async (_req, res) => {
      await new Promise((ok) => setTimeout(ok, 10));
      const r = Math.random();
      res.json({ who: 'b', r, uuid: crypto.randomUUID() });
    });
    const { url, close } = await serve(app);
    try {
      const [ra, rb] = await Promise.all([fetch(`${url}/a`), fetch(`${url}/b`)]);
      const [ba, bb] = [await ra.json(), await rb.json()];
      await recurr.flush();
      const recs = await captured(storeDir);
      expect(recs.length).toBe(2);
      const byPath = Object.fromEntries(recs.map((x) => [x.request!.path, x]));
      // Each record's seed contains exactly the values its own response used.
      expect(byPath['/a'].seed.random).toEqual([ba.r]);
      expect(byPath['/a'].seed.uuids).toEqual([ba.uuid]);
      expect(byPath['/b'].seed.random).toEqual([bb.r]);
      expect(byPath['/b'].seed.uuids).toEqual([bb.uuid]);
      // And neither record's events mention the other's path.
      for (const [p, rec] of Object.entries(byPath)) {
        expect(rec.events.every((e) => !(e.name ?? '').includes(p === '/a' ? '/b' : '/a'))).toBe(true);
      }
    } finally {
      close();
    }
  });

  it('capture.on=error saves only failures; always saves everything', async () => {
    const storeDir = await tmpDir();
    const recurr = await init({ service: 'svc', store: `fs:${storeDir}` });
    const app = express();
    app.use(recurr.middleware());
    app.get('/ok', (_req, res) => res.json({ ok: true }));
    app.get('/boom', (_req, res) => res.status(500).json({ err: true }));
    const { url, close } = await serve(app);
    try {
      await fetch(`${url}/ok`);
      await fetch(`${url}/boom`);
      await recurr.flush();
      await new Promise((r) => setTimeout(r, 100));
      const recs = await captured(storeDir);
      expect(recs.length).toBe(1);
      expect(recs[0].response?.status).toBe(500);
    } finally {
      close();
    }
  });

  it('errorMiddleware captures thrown errors with name/message/stack', async () => {
    const storeDir = await tmpDir();
    const recurr = await init({ service: 'svc', store: `fs:${storeDir}` });
    const app = express();
    app.use(recurr.middleware());
    app.get('/throw', () => {
      throw Object.assign(new Error('kaboom'), { name: 'KaboomError' });
    });
    app.use(recurr.errorMiddleware());
    app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: 'handled' });
    });
    const { url, close } = await serve(app);
    try {
      const res = await fetch(`${url}/throw`);
      expect(res.status).toBe(500);
      await recurr.flush();
      await new Promise((r) => setTimeout(r, 100));
      const recs = await captured(storeDir);
      expect(recs.length).toBe(1);
      expect(recs[0].error?.name).toBe('KaboomError');
      expect(recs[0].error?.message).toBe('kaboom');
      expect(recs[0].events.some((e) => e.kind === 'error')).toBe(true);
    } finally {
      close();
    }
  });

  it('records http.out even when the app never reads the upstream body', async () => {
    const storeDir = await tmpDir();
    // NOTE: `import http from 'node:http'` (default) reads module.exports live —
    // the namespace object's `get` would be a pre-patch snapshot binding.
    const http = (await import('node:http')).default;
    // upstream that answers immediately
    const upstream = await new Promise<import('node:http').Server>((r) => {
      const s = http.createServer((_req, res) => res.end('upstream-body')).listen(0, '127.0.0.1', () => r(s));
    });
    const uAddr = upstream.address();
    const uPort = typeof uAddr === 'object' && uAddr ? uAddr.port : 0;

    const recurr = await init({ service: 'svc', store: `fs:${storeDir}`, capture: { on: 'always' } });
    const app = express();
    app.use(recurr.middleware());
    app.get('/fire', (_req, res) => {
      // fire-and-forget: response body deliberately never consumed
      http.get(`http://127.0.0.1:${uPort}/ping`, () => {});
      res.json({ ok: true });
    });
    const { url, close } = await serve(app);
    try {
      await fetch(`${url}/fire`);
      await recurr.flush();
      // The upstream response can land after our response finished — it lands
      // via the late-event repersist path, so poll rather than fixed-wait.
      const deadline = Date.now() + 3000;
      let out: ExecutionRecord['events'][number] | undefined;
      while (Date.now() < deadline && !out) {
        const recs = await captured(storeDir, 200);
        out = recs[0]?.events.find((e) => e.kind === 'http.out');
        if (!out) await new Promise((r) => setTimeout(r, 60));
      }
      expect(out).toBeDefined();
      expect((out!.data as { status?: number }).status).toBe(200);
    } finally {
      close();
      upstream.closeAllConnections?.();
      upstream.close();
    }
  });

  it('double-mounted middleware produces a single record per request', async () => {
    const storeDir = await tmpDir();
    const recurr = await init({ service: 'svc', store: `fs:${storeDir}`, capture: { on: 'always' } });
    const app = express();
    app.use(recurr.middleware());
    app.use(recurr.middleware()); // accidental duplicate mount
    app.get('/x', (_req, res) => res.json({ ok: 1 }));
    const { url, close } = await serve(app);
    try {
      await fetch(`${url}/x`);
      await recurr.flush();
      await new Promise((r) => setTimeout(r, 100));
      const recs = await captured(storeDir);
      expect(recs.length).toBe(1);
      expect(recs[0].events.filter((e) => e.kind === 'http.in').length).toBe(1);
    } finally {
      close();
    }
  });

  it('recurr.auth captures the resolved principal; null stays null', async () => {
    const storeDir = await tmpDir();
    const recurr = await init({ service: 'svc', store: `fs:${storeDir}`, capture: { on: 'always' } });
    const app = express();
    app.use(recurr.middleware());
    app.get('/whoami', async (req, res) => {
      const p = await recurr.auth(req, async () => {
        const h = req.headers.authorization;
        return h === 'Bearer demo' ? { userId: 'u9', apiKey: 'secret-key-material' } : null;
      });
      res.json({ p });
    });
    const { url, close } = await serve(app);
    try {
      await fetch(`${url}/whoami`, { headers: { authorization: 'Bearer demo' } });
      await fetch(`${url}/whoami`);
      await recurr.flush();
      await new Promise((r) => setTimeout(r, 100));
      const recs = await captured(storeDir);
      expect(recs.length).toBe(2);
      const withAuth = recs.find((r) => r.auth?.principal);
      expect(withAuth?.auth?.principal).toMatchObject({ userId: 'u9', apiKey: '[REDACTED]' });
      // Second request had no credential — verify resolved null.
      const anon = recs.find((r) => r.auth?.principal === null || r.auth === undefined || r.auth?.principal === undefined);
      expect(anon).toBeDefined();
    } finally {
      close();
    }
  });
});

describe('instrumentDb', () => {
  async function captureOneQuery(storeDir: string, db: Queryable, run: (db: Queryable) => Promise<unknown>) {
    const recurr = await init({ service: 'svc', store: `fs:${storeDir}`, capture: { on: 'always' } });
    const inst = recurr.instrumentDb(db);
    const app = express();
    app.use(recurr.middleware());
    app.get('/q', async (_req, res) => {
      try {
        res.json({ rows: (await run(inst)) ?? [] });
      } catch (e) {
        res.status(500).json({ err: String(e) });
      }
    });
    const { url, close } = await serve(app);
    try {
      await fetch(`${url}/q`);
      await recurr.flush();
      await new Promise((r) => setTimeout(r, 100));
      const recs = await captured(storeDir);
      return recs[0];
    } finally {
      close();
    }
  }

  it('records promise-style queries with rows + params', async () => {
    const storeDir = await tmpDir();
    const db = fakeQueryable([{ id: 1 }]);
    const rec = await captureOneQuery(storeDir, db, (d) => d.query('SELECT * FROM t WHERE id = $1', [7]) as Promise<never>);
    const q = rec.events.find((e) => e.kind === 'db.query');
    expect(q).toBeDefined();
    const data = q!.data as { text: string; params: unknown[]; rows: unknown[]; rowCount: number };
    expect(data.text).toBe('SELECT * FROM t WHERE id = $1');
    expect(data.params).toEqual([7]);
    expect(data.rows).toEqual([{ id: 1 }]);
    expect(data.rowCount).toBe(1);
  });

  it('records callback-style queries', async () => {
    const storeDir = await tmpDir();
    const db = fakeQueryable([{ ok: true }]);
    const rec = await captureOneQuery(
      storeDir,
      db,
      (d) =>
        new Promise((resolve, reject) =>
          d.query('SELECT 1', ((err: unknown, res?: unknown) => (err ? reject(err) : resolve(res))) as never),
        ),
    );
    const q = rec.events.find((e) => e.kind === 'db.query');
    expect(q).toBeDefined();
    expect((q!.data as { rowCount: number }).rowCount).toBe(1);
  });

  it('records Submittable-style (EventEmitter) queries', async () => {
    const storeDir = await tmpDir();
    const db = {
      query: () => {
        const q = new EventEmitter();
        queueMicrotask(() => {
          q.emit('row', { x: 1 });
          q.emit('end', { rows: [{ x: 1 }], rowCount: 1 });
        });
        return q;
      },
    } as unknown as Queryable;
    const rec = await captureOneQuery(storeDir, db, async (d) => {
      const q = d.query('SELECT x') as unknown as EventEmitter;
      await new Promise((resolve) => q.on('end', resolve));
    });
    const ev = rec.events.find((e) => e.kind === 'db.query');
    expect(ev).toBeDefined();
    expect((ev!.data as { rowCount: number }).rowCount).toBe(1);
  });

  it('records db errors as error events', async () => {
    const storeDir = await tmpDir();
    const db = fakeQueryable([], new Error('deadlock detected'));
    const rec = await captureOneQuery(storeDir, db, (d) => (d.query('DELETE FROM t') as Promise<never>).catch(() => []));
    const ev = rec.events.find((e) => e.kind === 'db.query');
    expect(ev?.status).toBe('error');
    expect((ev!.data as { error: string }).error).toBe('deadlock detected');
  });

  it('instruments clients checked out via pool.connect()', async () => {
    const storeDir = await tmpDir();
    const client = fakeQueryable([{ via: 'client' }]);
    const pool = {
      query: fakeQueryable([{ via: 'pool' }]).query,
      connect: async () => client,
    } as unknown as Queryable;
    const rec = await captureOneQuery(storeDir, pool, async (d) => {
      const c = await (d.connect as () => Promise<Queryable>)();
      return c.query('SELECT 1') as Promise<{ rows: unknown[] }>;
    });
    const ev = rec.events.find((e) => e.kind === 'db.query');
    expect(ev).toBeDefined();
    expect((ev!.data as { rows: unknown[] }).rows).toEqual([{ via: 'client' }]);
  });

  it('does not double-instrument the same client', async () => {
    const storeDir = await tmpDir();
    const client = fakeQueryable([]);
    let connectCalls = 0;
    const pool = {
      query: fakeQueryable([]).query,
      connect: async () => {
        connectCalls++;
        return client;
      },
    } as unknown as Queryable;
    const rec = await captureOneQuery(storeDir, pool, async (d) => {
      const c1 = await (d.connect as () => Promise<Queryable>)();
      const c2 = await (d.connect as () => Promise<Queryable>)();
      await c1.query('SELECT 1');
      await c2.query('SELECT 2');
      return [];
    });
    expect(connectCalls).toBe(2);
    expect(rec.events.filter((e) => e.kind === 'db.query').length).toBe(2);
  });

  it('queries outside a request context pass through unrecorded', async () => {
    const storeDir = await tmpDir();
    const db = fakeQueryable([{ boot: true }]);
    const recurr = await init({ service: 'svc', store: `fs:${storeDir}`, capture: { on: 'always' } });
    const inst = recurr.instrumentDb(db);
    // No ctx → straight passthrough, no record created.
    const res = await inst.query('SELECT boot') as { rows: unknown[] };
    expect(res.rows).toEqual([{ boot: true }]);
    await recurr.flush();
    expect((await captured(storeDir, 300)).length).toBe(0);
  });
});
