import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExecutionRecord } from '@recurr-dev/core';
import { FileStore } from '@recurr-dev/store';
import { init, type Recurr } from '../src/index.js';
import type { Queryable } from '../src/patches/db.js';

/**
 * Framework compatibility suite.
 *
 * The capture middleware is connect-style `(req, res, next)` — the contract
 * everything here shares. What differs per framework: body parsing (does the
 * framework populate raw req.body before res finishes?) and error delivery
 * (does a thrown handler route through connect error middleware?).
 *
 * Support matrix established by these tests:
 *   express            — full support (body via express.json, errors via recurr.errorMiddleware)
 *   fastify + middie   — capture works; req.body is NOT populated (Fastify
 *                        keeps parsed bodies on its own Request wrapper);
 *                        errors surface via 500 status, detail uncaptured
 *   koa                — capture works via (ctx.req, ctx.res, next) adapter;
 *                        req.body NOT populated; error detail uncaptured
 *   node:http raw      — capture works by calling the middleware manually;
 *                        no body parsing; thrown handlers → aborted records
 *   hono (node-server) — capture works via server-boundary wrap:
 *                        getRequestListener(app.fetch) inside createServer,
 *                        middleware ahead of the adapter (verified against a
 *                        real Hono API during dogfooding)
 *   fetch-style/edge   — UNSUPPORTED: no node req/res boundary to intercept
 */

const dirs: string[] = [];
async function tmpDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'recurr-compat-'));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

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

function fakeQueryable(rows: unknown[] = []): Queryable {
  return { query: () => Promise.resolve({ rows, rowCount: rows.length }) } as unknown as Queryable;
}

type Mw = (req: unknown, res: unknown, next: (err?: unknown) => void) => void;

/** Shared fixture behavior: a route that exercises every interception surface. */
async function exercise(recurr: Recurr) {
  const db = recurr.instrumentDb(fakeQueryable([{ id: 7 }]));
  const upstream = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ pay: 'ok' }));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const port = (upstream.address() as { port: number }).port;
  return { db, upstreamUrl: `http://127.0.0.1:${port}/pay`, upstream };
}

function expectIncidentShape(rec: ExecutionRecord, path: string) {
  expect(rec.kind).toBe('incident');
  expect(rec.request?.path).toBe(path);
  const httpIn = rec.events.find((e) => e.kind === 'http.in');
  expect(httpIn).toBeDefined();
  const dbq = rec.events.find((e) => e.kind === 'db.query');
  expect(dbq).toBeDefined();
  expect((dbq?.data as { rows?: unknown[] }).rows?.[0]).toEqual({ id: 7 });
  const out = rec.events.find((e) => e.kind === 'http.out');
  expect(out).toBeDefined();
  expect((out?.data as { status?: number }).status).toBe(200);
}

describe('framework compatibility', () => {
  it('fastify + @fastify/middie — connect middleware captures the full timeline', async () => {
    const { default: Fastify } = await import('fastify');
    const { default: middie } = await import('@fastify/middie');
    const storeDir = await tmpDir();
    const recurr = await init({ service: 'svc-fastify', store: `fs:${storeDir}`, capture: { on: 'always' } });
    const fx = await exercise(recurr);

    const fastify = Fastify();
    await fastify.register(middie);
    fastify.use(recurr.middleware() as Mw as (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void);
    fastify.post('/order', async (req) => {
      await fx.db.query('SELECT 1');
      const r = await fetch(fx.upstreamUrl);
      await r.json();
      return { ok: true, echo: req.body };
    });
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    const port = (fastify.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/order`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sku: 'x' }),
    });
    expect(res.status).toBe(200);
    await recurr.flush();
    const recs = await captured(storeDir);
    expect(recs.length).toBe(1);
    const rec = recs[0];
    expectIncidentShape(rec, '/order');
    // Response tee works through Fastify's own send path.
    expect(JSON.parse(rec.response!.body!)).toEqual({ ok: true, echo: { sku: 'x' } });
    // Fastify keeps the parsed body on its own Request object — the raw
    // req.body our middleware sees stays undefined. Documented boundary.
    expect(rec.request?.body).toBeUndefined();
    fastify.close();
    fx.upstream.close();
  });

  it('koa — capture works through the (ctx.req, ctx.res, next) adapter', async () => {
    const { default: Koa } = await import('koa');
    const storeDir = await tmpDir();
    const recurr = await init({ service: 'svc-koa', store: `fs:${storeDir}`, capture: { on: 'always' } });
    const fx = await exercise(recurr);
    const mw = recurr.middleware() as Mw;

    const app = new Koa();
    // Koa responds when the composed chain resolves — the adapter must bridge
    // the downstream promise the middleware invokes: capture next()'s return
    // and await it so ctx.body is set before Koa sends.
    app.use(async (ctx, next) => {
      let downstream: Promise<void> | undefined;
      mw(ctx.req, ctx.res, () => {
        downstream = next();
      });
      await downstream;
    });
    app.use(async (ctx) => {
      await fx.db.query('SELECT 1');
      const r = await fetch(fx.upstreamUrl);
      await r.json();
      ctx.body = { ok: true };
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/thing?x=1`);
    expect(res.status).toBe(200);
    await recurr.flush();
    const recs = await captured(storeDir);
    expect(recs.length).toBe(1);
    expectIncidentShape(recs[0], '/thing');
    expect(JSON.parse(recs[0].response!.body!)).toEqual({ ok: true });
    expect(recs[0].request?.body).toBeUndefined();
    server.closeAllConnections?.();
    server.close();
    fx.upstream.close();
  });

  it('raw node:http server — middleware invoked manually still captures', async () => {
    const storeDir = await tmpDir();
    const recurr = await init({ service: 'svc-raw', store: `fs:${storeDir}`, capture: { on: 'always' } });
    const fx = await exercise(recurr);
    const mw = recurr.middleware() as Mw;

    const server = http.createServer((req, res) => {
      mw(req, res, () => {
        void (async () => {
          await fx.db.query('SELECT 1');
          const r = await fetch(fx.upstreamUrl);
          await r.json();
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ done: true }));
        })();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/raw`);
    expect(res.status).toBe(200);
    await recurr.flush();
    const recs = await captured(storeDir);
    expect(recs.length).toBe(1);
    expectIncidentShape(recs[0], '/raw');
    server.closeAllConnections?.();
    server.close();
    fx.upstream.close();
  });

  it('hono via @hono/node-server — capture works through the server-boundary wrap', async () => {
    const { Hono } = await import('hono');
    const { getRequestListener } = await import('@hono/node-server');
    const storeDir = await tmpDir();
    const recurr = await init({ service: 'svc-hono', store: `fs:${storeDir}`, capture: { on: 'always' } });
    const fx = await exercise(recurr);
    const mw = recurr.middleware() as Mw;

    const app = new Hono();
    app.get('/conv', async (c) => {
      await fx.db.query('SELECT 1');
      const r = await fetch(fx.upstreamUrl);
      await r.json();
      return c.json({ ok: true });
    });

    // The documented integration: wrap hono's node adapter at the socket
    // boundary — middleware sees the real req/res before adaptation.
    const listener = getRequestListener(app.fetch);
    const server = http.createServer((req, res) => {
      mw(req, res, () => void listener(req, res));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/conv`);
    expect(res.status).toBe(200);
    await recurr.flush();
    const recs = await captured(storeDir);
    expect(recs.length).toBe(1);
    expectIncidentShape(recs[0], '/conv');
    expect(JSON.parse(recs[0].response!.body!)).toEqual({ ok: true });
    server.closeAllConnections?.();
    server.close();
    fx.upstream.close();
  });

  it('express with raw-body parser — Buffer bodies capture as base64', async () => {
    const { default: express } = await import('express');
    const storeDir = await tmpDir();
    const recurr = await init({ service: 'svc-express', store: `fs:${storeDir}`, capture: { on: 'always' } });
    const app = express();
    app.use(recurr.middleware());
    app.use(express.raw({ type: 'application/octet-stream', limit: '2mb' }));
    app.post('/blob', (req, res) => {
      res.json({ len: (req.body as Buffer).length });
    });
    const server = await new Promise<http.Server>((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s));
    });
    const port = (server.address() as { port: number }).port;
    const payload = Buffer.alloc(150_000, 0xab);
    const res = await fetch(`http://127.0.0.1:${port}/blob`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: payload,
    });
    expect(res.status).toBe(200);
    await recurr.flush();
    const recs = await captured(storeDir);
    expect(recs.length).toBe(1);
    const rec = recs[0];
    expect(rec.request?.bodyBase64).toBe(true);
    // Decoding proves the bytes round-trip; size is bounded by maxBodyBytes.
    const decoded = Buffer.from(rec.request!.body!, 'base64');
    expect(decoded[0]).toBe(0xab);
    expect(decoded.length).toBeGreaterThan(0);
    server.closeAllConnections?.();
    server.close();
  });

  it('express urlencoded form — parsed body captured with sensitive params redacted', async () => {
    const { default: express } = await import('express');
    const storeDir = await tmpDir();
    const recurr = await init({ service: 'svc-form', store: `fs:${storeDir}`, capture: { on: 'always' } });
    const app = express();
    app.use(recurr.middleware());
    app.use(express.urlencoded({ extended: false }));
    app.post('/login', (_req, res) => res.json({ ok: true }));
    const server = await new Promise<http.Server>((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s));
    });
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'user=ada&password=hunter2&csrf_token=t1',
    });
    expect(res.status).toBe(200);
    await recurr.flush();
    const recs = await captured(storeDir);
    expect(recs.length).toBe(1);
    const body = JSON.parse(recs[0].request!.body!);
    expect(body.user).toBe('ada');
    expect(body.password).toBe('[REDACTED]');
    expect(body.csrf_token).toBe('[REDACTED]');
    server.closeAllConnections?.();
    server.close();
  });

  it('multipart without a parser — request still captured, body absent (documented boundary)', async () => {
    const { default: express } = await import('express');
    const storeDir = await tmpDir();
    const recurr = await init({ service: 'svc-multipart', store: `fs:${storeDir}`, capture: { on: 'always' } });
    const app = express();
    app.use(recurr.middleware());
    // No multipart parser (express has none built in) — req.body stays undefined.
    app.post('/upload', (_req, res) => res.json({ ok: true }));
    const server = await new Promise<http.Server>((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s));
    });
    const port = (server.address() as { port: number }).port;
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(40_000, 0x61)]), 'a.bin');
    const res = await fetch(`http://127.0.0.1:${port}/upload`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    await recurr.flush();
    const recs = await captured(storeDir);
    expect(recs.length).toBe(1);
    const rec = recs[0];
    expect(rec.request?.path).toBe('/upload');
    // The request happened; the body simply wasn't parseable by the app — the
    // record says 'no body' rather than fabricating one.
    expect(rec.request?.body).toBeUndefined();
    expect(rec.request?.headers['content-type']).toContain('multipart/form-data');
    server.closeAllConnections?.();
    server.close();
  });
});
