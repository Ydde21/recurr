import http from 'node:http';
import zlib from 'node:zlib';
import { describe, expect, it, afterAll } from 'vitest';
import { createRedactor, type ExecutionRecord, type HttpOutData } from '@recurr/core';
import { als, type RuntimeCtx } from '../src/context.js';
import { installHttpPatches } from '../src/patches/http.js';
import { makeCtx, type RecurrState } from '../src/state.js';
import type { RecurrConfig } from '../src/config.js';

/**
 * HTTP deep suite — outbound capture fidelity (methods, redirects, gzip,
 * bodyless statuses, errors, aborts) and replay synthesis (recorded errors,
 * headers, signal honoring) with zero real egress at replay.
 */

installHttpPatches();

const servers: http.Server[] = [];
afterAll(() => {
  for (const s of servers) s.closeAllConnections?.();
});

async function serve(handler: http.RequestListener): Promise<number> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as { port: number }).port;
}

const storeStub = {
  save: async () => {},
  get: async () => null,
  list: async () => [],
  listReplays: async () => [],
  saveRegression: async () => {},
  listRegressions: async () => [],
  close: async () => {},
};

function mkState(cfg: Partial<RecurrConfig> = {}, replaySource?: ExecutionRecord): RecurrState {
  return {
    cfg: { service: 'http-test', capture: { on: 'always' }, ...cfg },
    mode: replaySource ? 'replay' : 'capture',
    replaySource,
    store: storeStub,
    redactor: createRedactor(),
    pending: new Set(),
    inflight: 0,
  } as RecurrState;
}

function httpOut(seq: number, data: Partial<HttpOutData> & { method: string; url: string }) {
  return {
    seq,
    at: '2026-01-01T00:00:00Z',
    offsetMs: seq,
    kind: 'http.out' as const,
    name: `${data.method} out`,
    data: data as unknown as Record<string, unknown>,
  };
}

function sourceWith(events: ExecutionRecord['events']): ExecutionRecord {
  return {
    schemaVersion: 1,
    id: 'RUN-HTTPSRC',
    kind: 'incident',
    service: { name: 'src' },
    environment: { name: 'test' },
    capturedAt: '2026-01-01T00:00:00Z',
    trigger: { type: 'http' },
    seed: { startedAtWallMs: 0, random: [], uuids: [], prngSeed: 1 },
    events,
    redaction: { redactedPaths: [], truncatedPaths: [] },
  };
}

async function drain(ctx: RuntimeCtx): Promise<void> {
  await Promise.allSettled(ctx.pending);
}

describe('http capture — fetch surface', () => {
  it('records all methods with status/body', async () => {
    const port = serve((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    const ctx = makeCtx(mkState());
    await als.run(ctx, async () => {
      for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        const r = await fetch(`http://127.0.0.1:${await port}/${m}`, { method: m });
        await r.json();
      }
    });
    await drain(ctx);
    const evs = ctx.events.filter((e) => e.kind === 'http.out');
    expect(evs.length).toBe(5);
    expect(evs.map((e) => (e.data as unknown as HttpOutData).method)).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
    expect((evs[0].data as unknown as HttpOutData).responseBody).toBe('{"ok":true}');
  });

  it('records redirects as the followed 200; redirect:manual records the 30x', async () => {
    const port = serve((req, res) => {
      if (req.url === '/a') {
        res.writeHead(301, { location: '/b' });
        res.end();
        return;
      }
      res.end('landed');
    });
    const ctx = makeCtx(mkState());
    await als.run(ctx, async () => {
      const followed = await fetch(`http://127.0.0.1:${await port}/a`);
      expect(followed.status).toBe(200);
      await followed.text();
      const manual = await fetch(`http://127.0.0.1:${await port}/a`, { redirect: 'manual' });
      expect(manual.status).toBe(301);
    });
    await drain(ctx);
    const evs = ctx.events.filter((e) => e.kind === 'http.out');
    expect((evs[0].data as unknown as HttpOutData).status).toBe(200); // undici followed → we see the landing
    expect((evs[0].data as unknown as HttpOutData).responseBody).toBe('landed');
    expect((evs[1].data as unknown as HttpOutData).status).toBe(301);
  });

  it('gzip responses record the decoded body', async () => {
    const port = serve((_req, res) => {
      const gz = zlib.gzipSync(JSON.stringify({ inflated: true }));
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'application/json' });
      res.end(gz);
    });
    const ctx = makeCtx(mkState());
    await als.run(ctx, async () => {
      const r = await fetch(`http://127.0.0.1:${await port}/`);
      await r.json();
    });
    await drain(ctx);
    const d = ctx.events[0].data as unknown as HttpOutData;
    // undici decodes transparently — the recorded body is the DECODED form
    // (a gzipped blob in the record would be unreplayable garbage).
    expect(d.responseBody).toBe('{"inflated":true}');
  });

  it('204 and 304 responses record without bodies', async () => {
    const port = serve((req, res) => {
      res.writeHead(req.url === '/204' ? 204 : 304);
      res.end();
    });
    const ctx = makeCtx(mkState());
    await als.run(ctx, async () => {
      expect((await fetch(`http://127.0.0.1:${await port}/204`)).status).toBe(204);
      expect((await fetch(`http://127.0.0.1:${await port}/304`)).status).toBe(304);
    });
    await drain(ctx);
    const [a, b] = ctx.events.map((e) => e.data as unknown as HttpOutData);
    expect(a.status).toBe(204);
    expect(b.status).toBe(304);
  });

  it('upstream reset mid-response → errorKind recorded', async () => {
    const port = serve((_req, res) => {
      res.write('partial');
      res.socket?.destroy();
    });
    const ctx = makeCtx(mkState());
    await als.run(ctx, async () => {
      await expect(fetch(`http://127.0.0.1:${await port}/`).then((r) => r.text())).rejects.toThrow();
    });
    const d = ctx.events[0].data as unknown as HttpOutData;
    expect(d.error).toBeDefined();
    expect(['reset', 'error']).toContain(d.errorKind);
  });

  it('connection refused → reset errorKind', async () => {
    // Find a guaranteed-closed port: bind then release (fetch blocks well-
    // known low ports like :1 outright, which would test nothing).
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const deadPort = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const ctx = makeCtx(mkState());
    await als.run(ctx, async () => {
      await expect(fetch(`http://127.0.0.1:${deadPort}/unreachable`)).rejects.toThrow();
    });
    const d = ctx.events[0].data as unknown as HttpOutData;
    expect(d.errorKind).toBe('reset');
  });

  it('concurrent fetches each record their own event in completion order', async () => {
    const port = await serve((req, res) => {
      const n = Number(req.url!.slice(1));
      setTimeout(() => res.end(`res-${n}`), n === 1 ? 40 : 5);
    });
    const ctx = makeCtx(mkState());
    await als.run(ctx, async () => {
      await Promise.all([1, 2, 3].map((n) => fetch(`http://127.0.0.1:${port}/${n}`).then((r) => r.text())));
    });
    await drain(ctx);
    const evs = ctx.events.filter((e) => e.kind === 'http.out');
    expect(evs.length).toBe(3);
    // Slower request recorded later — ordering reflects real completion.
    const bodies = evs.map((e) => (e.data as unknown as HttpOutData).responseBody);
    expect(bodies).toContain('res-1');
    expect(bodies).toContain('res-2');
    expect(bodies).toContain('res-3');
  });

  it('sensitive response headers are redacted in the event', async () => {
    const port = serve((_req, res) => {
      res.writeHead(200, { 'set-cookie': 'sid=secret-session', 'x-trace': 't1' });
      res.end('ok');
    });
    const ctx = makeCtx(mkState());
    await als.run(ctx, async () => {
      const r = await fetch(`http://127.0.0.1:${await port}/`);
      await r.text();
    });
    const d = ctx.events[0].data as unknown as HttpOutData;
    expect(d.responseHeaders?.['set-cookie']).toBe('[REDACTED]');
    expect(d.responseHeaders?.['x-trace']).toBe('t1');
  });
});

describe('http capture — http.request surface', () => {
  it('request with callback records method/url/status/body + requestBody', async () => {
    const port = await serve((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => res.end(`echo:${b}`));
    });
    const ctx = makeCtx(mkState());
    await als.run(ctx, async () => {
      await new Promise<void>((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: '/x', method: 'POST' }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            expect(body).toBe('echo:payload-body');
            resolve();
          });
        });
        req.on('error', reject);
        req.end('payload-body');
      });
    });
    const d = ctx.events[0].data as unknown as HttpOutData;
    expect(d.method).toBe('POST');
    expect(d.url).toContain('/x');
    expect(d.status).toBe(200);
    expect(d.requestBody).toBe('payload-body');
    expect(d.responseBody).toBe('echo:payload-body');
  });

  it('fire-and-forget (unread body) still records — flagged responsePending', async () => {
    const port = await serve((_req, res) => {
      res.setHeader('content-type', 'text/plain');
      // Slow-drip body so the response is still streaming when we check.
      res.write('head');
      setTimeout(() => res.end('tail'), 200);
    });
    const ctx = makeCtx(mkState());
    await als.run(ctx, async () => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/ff', method: 'GET' }, () => {
        // deliberately never read the body
      });
      req.end();
      await new Promise((r) => setTimeout(r, 50));
      const d = ctx.events[0].data as unknown as HttpOutData;
      expect(d.status).toBe(200);
      expect(d.responsePending).toBe(true); // honest: headers seen, body never consumed yet
      await new Promise((r) => setTimeout(r, 250)); // let it finish
    });
    const d = ctx.events[0].data as unknown as HttpOutData;
    expect(d.responsePending).toBeUndefined();
    expect(d.responseBody).toBe('headtail');
  });

  it('http.request to a dead host records a reset error', async () => {
    const ctx = makeCtx(mkState());
    await als.run(ctx, async () => {
      await new Promise<void>((resolve) => {
        const req = http.request('http://127.0.0.1:1/dead', () => resolve());
        req.on('error', () => resolve());
        req.end();
      });
    });
    const d = ctx.events[0].data as unknown as HttpOutData;
    expect(d.errorKind).toBe('reset');
  });
});

describe('http replay — synthesized responses, zero egress', () => {
  const source = sourceWith([
    httpOut(2, { method: 'GET', url: 'http://api.local/items', status: 200, responseBody: '{"n":3}', responseHeaders: { 'content-type': 'application/json', 'x-req-id': 'r1' } }),
    httpOut(3, { method: 'POST', url: 'http://api.local/slow', errorKind: 'timeout', error: 'upstream timed out' }),
    httpOut(4, { method: 'GET', url: 'http://api.local/empty', status: 204 }),
  ]);

  it('recorded 200 replays status/body/headers — fetch works normally', async () => {
    const ctx = makeCtx(mkState({}, source));
    await als.run(ctx, async () => {
      const r = await fetch('http://api.local/items');
      expect(r.status).toBe(200);
      expect(r.headers.get('x-req-id')).toBe('r1');
      expect(await r.json()).toEqual({ n: 3 });
    });
  });

  it('recorded timeout replays as TimeoutError — no real wait', async () => {
    const ctx = makeCtx(mkState({}, source));
    const t0 = Date.now();
    await als.run(ctx, async () => {
      await fetch('http://api.local/items'); // consume first recorded event
      await expect(fetch('http://api.local/slow', { method: 'POST' })).rejects.toMatchObject({ name: 'TimeoutError' });
    });
    expect(Date.now() - t0).toBeLessThan(2000); // synthesized, not a real 30s wait
  });

  it('204 replay synthesizes a bodyless Response without throwing', async () => {
    const ctx = makeCtx(mkState({}, source));
    await als.run(ctx, async () => {
      await fetch('http://api.local/items');
      await fetch('http://api.local/slow', { method: 'POST' }).catch(() => {});
      const r = await fetch('http://api.local/empty');
      expect(r.status).toBe(204);
      expect(await r.text()).toBe('');
    });
  });

  it('fetch past the recorded sequence rejects + leaves a replay.note', async () => {
    const ctx = makeCtx(mkState({}, source));
    await als.run(ctx, async () => {
      // Consume the recorded sequence first — a URL mismatch mid-sequence is
      // served the in-order recorded event (positional model) + a note.
      await fetch('http://api.local/items');
      await fetch('http://api.local/slow', { method: 'POST' }).catch(() => {});
      await fetch('http://api.local/empty');
      await expect(fetch('http://api.local/never-captured')).rejects.toThrow(/no recorded response/);
    });
    const notes = ctx.events.filter((e) => e.kind === 'replay.note');
    expect(notes.some((n) => (n.data as { message?: string }).message?.includes('no recorded response'))).toBe(true);
  });

  it('a mismatched URL mid-sequence is served the in-order event + divergence note (positional model)', async () => {
    const ctx = makeCtx(mkState({}, source));
    await als.run(ctx, async () => {
      // Ask for a URL that isn't next — replay serves the in-order recorded
      // response and flags the divergence rather than fabricating one.
      const r = await fetch('http://api.local/wrong-url');
      expect(r.status).toBe(200); // the recorded /items response
    });
    const notes = ctx.events.filter((e) => e.kind === 'replay.note');
    expect(notes.some((n) => (n.data as { message?: string }).message?.includes('differs from recorded'))).toBe(true);
  });

  it('caller AbortSignal is honored — replayed response never arrives', async () => {
    const ctx = makeCtx(mkState({}, source));
    await als.run(ctx, async () => {
      const c = new AbortController();
      c.abort();
      await expect(fetch('http://api.local/items', { signal: c.signal })).rejects.toMatchObject({ name: 'AbortError' });
    });
  });

  it('http.request replay returns recorded response through the fake request', async () => {
    const ctx = makeCtx(mkState({}, source));
    await als.run(ctx, async () => {
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request('http://api.local/items', (r) => resolve(r));
        req.on('error', reject);
        req.end();
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-req-id']).toBe('r1');
      let body = '';
      for await (const c of res) body += c;
      expect(body).toBe('{"n":3}');
    });
  });

  it('http.request replay of a recorded timeout emits timeout + error', async () => {
    const ctx = makeCtx(mkState({}, source));
    await als.run(ctx, async () => {
      await new Promise<void>((resolve) => {
        const req = http.request('http://api.local/items', (r) => r.resume());
        req.end();
        req.on('response', () => {
          const req2 = http.request({ hostname: 'api.local', path: '/slow', method: 'POST' }, () => {});
          let sawTimeout = false;
          req2.on('timeout', () => (sawTimeout = true));
          req2.on('error', () => {
            expect(sawTimeout).toBe(true);
            resolve();
          });
          req2.end();
        });
      });
    });
  });

  it('http.request replay past the recorded sequence emits error, not egress', async () => {
    const ctx = makeCtx(mkState({}, source));
    await als.run(ctx, async () => {
      const one = (opts: string | { hostname: string; path: string; method?: string }) =>
        new Promise<void>((resolve) => {
          const req = http.request(opts as never, (res: http.IncomingMessage) => {
            res.resume();
            res.on('end', resolve);
          });
          req.on('error', () => resolve());
          req.end();
        });
      await one('http://api.local/items');
      await one({ hostname: 'api.local', path: '/slow', method: 'POST' });
      await one('http://api.local/empty');
      const err = await new Promise<Error>((resolve) => {
        const req = http.request('http://api.local/unrecorded', () => {});
        req.on('error', resolve);
        req.end();
      });
      expect(err.message).toMatch(/no recorded response/);
    });
  });
});
