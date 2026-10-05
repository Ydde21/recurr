import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Transform } from 'node:stream';
import type { HttpOutData, TimelineEvent } from '@recurr/core';
import { als, pushEvent, replayNote, type RuntimeCtx } from '../context.js';

/**
 * Outbound HTTP interception.
 *
 * Capture: real egress is performed; method/url/status/duration and bounded
 * bodies are recorded as http.out events.
 *
 * Replay: NO real egress. Calls are matched against recorded http.out events
 * (in order, with a small lookahead for structural divergence) and the
 * recorded response — including recorded failures like timeouts — is
 * synthesized locally.
 */

const LOOKAHEAD = 3;
let installed = false;

export function installHttpPatches(): void {
  if (installed) return;
  installed = true;
  patchFetch();
  patchRequestModule(http, 'http:');
  patchRequestModule(https, 'https:');
}

// ---------------------------------------------------------------------------
// shared matching helpers
// ---------------------------------------------------------------------------

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
}

/** Find the next recorded http.out event, preferring an exact method+url match. */
export function nextRecordedHttpOut(ctx: RuntimeCtx, method: string, url: string): HttpOutData | undefined {
  const events = ctx.replaySource?.events ?? [];
  const isHttpOut = (e: TimelineEvent) => e.kind === 'http.out';
  let idx = -1;
  for (let i = ctx.httpOutCursor; i < events.length; i++) {
    if (isHttpOut(events[i])) {
      idx = i;
      break;
    }
  }
  if (idx === -1) {
    replayNote(ctx, `outbound call with no recorded response: ${method} ${url}`, { method, url });
    return undefined;
  }
  // Lookahead for a closer match if the in-order candidate disagrees.
  const cand = events[idx].data as unknown as HttpOutData | undefined;
  if (cand && (cand.method !== method || cand.url !== url)) {
    for (let k = idx + 1; k <= Math.min(events.length - 1, idx + LOOKAHEAD); k++) {
      const d = events[k].kind === 'http.out' ? (events[k].data as unknown as HttpOutData) : undefined;
      if (d && d.method === method && d.url === url) {
        for (let s = idx; s < k; s++) {
          const skipped = events[s].data as unknown as HttpOutData;
          replayNote(ctx, `recorded call not made during replay: ${skipped?.method} ${skipped?.url}`, { seq: events[s].seq });
        }
        ctx.httpOutCursor = k + 1;
        return d;
      }
    }
    replayNote(ctx, `outbound call differs from recorded: ${method} ${url} (recorded: ${cand.method} ${cand.url})`, { seq: events[idx].seq });
  }
  ctx.httpOutCursor = idx + 1;
  return cand;
}

function classifyError(err: unknown): HttpOutData['errorKind'] {
  const e = err as { name?: string; code?: string; cause?: { code?: string } };
  const name = e?.name ?? '';
  const code = e?.code ?? e?.cause?.code ?? '';
  if (name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') return 'timeout';
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE' || code === 'UND_ERR_SOCKET' || name === 'SocketError') return 'reset';
  return 'error';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

function pushHttpOut(ctx: RuntimeCtx, data: HttpOutData, durationMs: number, ok: boolean): TimelineEvent {
  return pushEvent(ctx, 'http.out', {
    name: `${data.method} ${hostOf(data.url)}`,
    durationMs,
    status: ok ? 'ok' : 'error',
    data: data as unknown as Record<string, unknown>,
  });
}

function bodyToString(body: unknown, maxBytes: number): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body.slice(0, maxBytes);
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body).subarray(0, maxBytes).toString('utf8');
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof body === 'object' && 'pipe' in (body as object)) return '[stream]';
  if (body instanceof ReadableStream) return '[stream]';
  try {
    return JSON.stringify(body)?.slice(0, maxBytes);
  } catch {
    return '[unserializable]';
  }
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

function patchFetch(): void {
  const origFetch = globalThis.fetch;
  if (!origFetch) return;

  globalThis.fetch = async function fetch(input: Parameters<typeof origFetch>[0], init?: Parameters<typeof origFetch>[1]): Promise<Response> {
    const ctx = als.getStore();
    if (!ctx) return origFetch(input, init);

    const method = (init?.method ?? (input as Request).method ?? 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const maxBody = ctx.redactor.maxBodyBytes;
    const redUrl = ctx.redactor.redactUrl(url).value;
    const requestBody = ctx.config.capture?.captureOutboundBodies === false ? undefined : bodyToString(init?.body, maxBody);

    if (ctx.mode === 'replay') {
      const rec = nextRecordedHttpOut(ctx, method, redUrl);
      const reqRed = requestBody !== undefined ? ctx.redactor.redactBody(requestBody, undefined, 'http.out.requestBody') : undefined;
      if (reqRed) ctx.redactionHits.push(...reqRed.hits);
      const data: HttpOutData = rec
        ? { ...rec, requestBody: reqRed?.value ?? rec.requestBody }
        : { method, url: redUrl, requestBody: reqRed?.value, errorKind: 'error', error: 'no recorded response' };
      const ok = !!rec && !rec.error && !rec.errorKind;
      pushHttpOut(ctx, data, rec ? recLatency(ctx, data) : 0, ok);
      return synthesizeFetchResponse(rec, method, url);
    }

    const t0 = performance.now();
    try {
      const res = await origFetch(input, init);
      const durationMs = Math.round((performance.now() - t0) * 1000) / 1000;
      const hdrRed = ctx.redactor.redactHeaders(Object.fromEntries(res.headers.entries()), 'http.out.responseHeaders');
      ctx.redactionHits.push(...hdrRed.hits);
      const data: HttpOutData = { method, url: redUrl, status: res.status, responseHeaders: hdrRed.value };
      const reqRed = requestBody !== undefined ? ctx.redactor.redactBody(requestBody, undefined, 'http.out.requestBody') : undefined;
      if (reqRed) {
        ctx.redactionHits.push(...reqRed.hits);
        data.requestBody = reqRed.value;
      }
      // Push now so event ordering reflects response arrival; the body is
      // captured asynchronously so large/streamed bodies never delay the app.
      pushHttpOut(ctx, data, durationMs, true);
      if (ctx.config.capture?.captureOutboundBodies !== false) {
        const ct = res.headers.get('content-type') ?? undefined;
        const p = res
          .clone()
          .text()
          .then((raw) => {
            const clipped = Buffer.byteLength(raw, 'utf8') > maxBody ? Buffer.from(raw, 'utf8').subarray(0, maxBody).toString('utf8') : raw;
            const red = ctx.redactor.redactBody(clipped, ct, 'http.out.responseBody');
            ctx.redactionHits.push(...red.hits);
            ctx.truncatedPaths.push(...red.truncated);
            data.responseBody = red.value;
            // Body may resolve after the response finished — re-save so the
            // record isn't missing it.
            if (ctx.closed) ctx.repersist?.();
          })
          .catch(() => {
            data.responseBody = '[capture-failed]';
            if (ctx.closed) ctx.repersist?.();
          });
        ctx.pending.push(p);
      }
      return res;
    } catch (err) {
      const durationMs = Math.round((performance.now() - t0) * 1000) / 1000;
      pushHttpOut(
        ctx,
        {
          method,
          url: redUrl,
          requestBody,
          error: errorMessage(err),
          errorName: errorName(err),
          errorKind: classifyError(err),
        },
        durationMs,
        false,
      );
      throw err;
    }
  };
}

/** Approximate the original latency so downstream timing logic behaves. */
function recLatency(ctx: RuntimeCtx, _data: HttpOutData): number {
  return 0; // response arrives immediately; recorded duration kept on the event
}

/** Headers that must not be replayed into a synthesized response — the body
 *  we stored is already decoded, and hop headers would be wrong anyway. */
const DROP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'date',
]);

function replayResponseHeaders(rec: HttpOutData | undefined): Headers {
  const headers = new Headers();
  if (rec?.responseHeaders) {
    for (const [k, v] of Object.entries(rec.responseHeaders)) {
      if (DROP_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
      headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
  }
  if (rec?.responseBody !== undefined && !headers.has('content-type')) {
    headers.set('content-type', guessJson(rec.responseBody) ? 'application/json' : 'text/plain');
  }
  return headers;
}

function synthesizeFetchResponse(rec: HttpOutData | undefined, method: string, url: string): Promise<Response> {
  if (!rec) {
    return Promise.reject(new TypeError(`fetch failed (recurr replay: no recorded response for ${method} ${url})`));
  }
  if (rec.error || rec.errorKind) {
    switch (rec.errorKind) {
      case 'timeout':
        return Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));
      case 'reset': {
        const cause = Object.assign(new Error(rec.error ?? 'socket hang up'), { code: 'ECONNRESET' });
        return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause }));
      }
      default:
        return Promise.reject(new TypeError(rec.error ?? 'fetch failed'));
    }
  }
  // 204/304 responses must not carry a body — Response() throws otherwise.
  const bodiless = rec.status === 204 || rec.status === 304;
  return Promise.resolve(
    new Response(bodiless ? null : (rec.responseBody ?? null), { status: rec.status ?? 200, headers: replayResponseHeaders(rec) }),
  );
}

function guessJson(body: string): boolean {
  const t = body.trimStart();
  return t.startsWith('{') || t.startsWith('[');
}

// ---------------------------------------------------------------------------
// http.request / https.request
// ---------------------------------------------------------------------------

interface NormalizedArgs {
  args: unknown[];
  method: string;
  url: string;
  cb?: (res: http.IncomingMessage) => void;
}

function normalizeRequestArgs(scheme: string, args: unknown[]): NormalizedArgs {
  const a = [...args];
  let cb: ((res: http.IncomingMessage) => void) | undefined;
  if (typeof a[a.length - 1] === 'function') cb = a.pop() as (res: http.IncomingMessage) => void;

  let urlStr = '';
  let options: Record<string, unknown> = {};
  if (typeof a[0] === 'string' || a[0] instanceof URL) {
    const u = new URL(a[0].toString());
    options = typeof a[1] === 'object' && a[1] !== null ? { ...(a[1] as object) } : {};
    urlStr = u.toString();
  } else {
    options = typeof a[0] === 'object' && a[0] !== null ? { ...(a[0] as object) } : {};
    const proto = (options.protocol as string) ?? scheme;
    const host = (options.hostname as string) ?? (options.host as string) ?? 'localhost';
    const port = options.port ? `:${options.port}` : '';
    const path = (options.path as string) ?? '/';
    urlStr = `${proto}//${host}${port}${path}`;
  }
  const method = ((options.method as string) ?? 'GET').toUpperCase();
  return { args: a, method, url: urlStr, cb };
}

function patchRequestModule(mod: typeof http | typeof https, scheme: string): void {
  const origRequest = mod.request.bind(mod);
  const origGet = mod.get.bind(mod);

  // Intentional monkeypatch of the module export — affects method-call style
  // usage (http.request(…)) and CJS consumers. Note: `import { request } from
  // 'node:http'` snapshots the binding and escapes patching.
  mod.request = function request(...rawArgs: unknown[]): http.ClientRequest {
    const ctx = als.getStore();
    const { args, method, url, cb } = normalizeRequestArgs(scheme, rawArgs);
    if (!ctx) return (origRequest as (...a: unknown[]) => http.ClientRequest)(...rawArgs);

    const maxBody = ctx.redactor.maxBodyBytes;
    const redUrl = ctx.redactor.redactUrl(url).value;

    if (ctx.mode === 'replay') {
      const rec = nextRecordedHttpOut(ctx, method, redUrl);
      return fakeClientRequest(ctx, rec, method, url, cb);
    }

    const t0 = performance.now();
    const reqChunks: Buffer[] = [];
    let reqBytes = 0;

    const wrappedCb = (res: http.IncomingMessage) => {
      // Record at headers-arrival, not body end — a consumer that never reads
      // the body (fire-and-forget) would otherwise produce NO event at all.
      const cleanHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v !== undefined) cleanHeaders[k] = v;
      }
      const hdrRed = ctx.redactor.redactHeaders(cleanHeaders, 'http.out.responseHeaders');
      ctx.redactionHits.push(...hdrRed.hits);
      const data: HttpOutData & { responsePending?: boolean } = {
        method,
        url: redUrl,
        requestBody: reqBytes ? Buffer.concat(reqChunks).toString('utf8').slice(0, maxBody) : undefined,
        status: res.statusCode,
        responseHeaders: hdrRed.value,
        responsePending: true,
      };
      const ev = pushHttpOut(ctx, data, Math.round((performance.now() - t0) * 1000) / 1000, true);
      const settle = () => {
        delete data.responsePending;
        ev.durationMs = Math.round((performance.now() - t0) * 1000) / 1000;
        if (ctx.closed) ctx.repersist?.();
      };

      // Tee response body through a transform so the consumer sees a normal stream.
      const resChunks: Buffer[] = [];
      let resBytes = 0;
      const collector = new Transform({
        transform(chunk: Buffer, _enc, done) {
          if (resBytes < maxBody) {
            resBytes += chunk.length;
            resChunks.push(chunk);
          }
          done(null, chunk);
        },
      });
      const out = new PassThrough();
      res.pipe(collector).pipe(out);
      const outMsg = out as unknown as http.IncomingMessage;
      outMsg.statusCode = res.statusCode;
      outMsg.statusMessage = res.statusMessage;
      outMsg.headers = res.headers;
      outMsg.rawHeaders = res.rawHeaders;
      outMsg.httpVersion = res.httpVersion;
      const resAny = res as unknown as Record<string, unknown>;
      for (const k of ['socket', 'complete', 'aborted', 'trailers', 'rawTrailers']) {
        Object.defineProperty(outMsg, k, { get: () => resAny[k], configurable: true });
      }
      (outMsg as { setTimeout?: unknown }).setTimeout = res.setTimeout?.bind(res);
      // Upstream failures must propagate to the consumer's stream or it hangs.
      res.on('error', (err) => {
        ev.status = 'error';
        data.error = errorMessage(err);
        data.errorName = errorName(err);
        data.errorKind = classifyError(err);
        settle();
        out.destroy(err as Error);
      });
      res.on('aborted', () => {
        ev.status = 'error';
        data.error = 'response aborted';
        data.errorName = 'Error';
        data.errorKind = 'reset';
        settle();
        out.destroy(Object.assign(new Error('response aborted'), { code: 'ECONNRESET' }));
      });
      res.on('end', () => {
        const rawBody = Buffer.concat(resChunks).toString('utf8');
        const red = ctx.redactor.redactBody(rawBody, String(res.headers['content-type'] ?? ''), 'http.out.responseBody');
        ctx.redactionHits.push(...red.hits);
        data.responseBody = red.value;
        settle();
      });
      cb?.(outMsg);
    };

    const req = (origRequest as (...a: unknown[]) => http.ClientRequest)(...args, wrappedCb);
    const origWrite = req.write.bind(req);
    const origEnd = req.end.bind(req);
    req.write = function (chunk: unknown, ...rest: unknown[]) {
      if (reqBytes < maxBody && chunk !== undefined) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        reqBytes += b.length;
        reqChunks.push(b.subarray(0, Math.max(0, maxBody - (reqBytes - b.length))));
      }
      // @ts-expect-error passthrough signature
      return origWrite(chunk, ...rest);
    } as typeof req.write;
    req.end = function (chunk?: unknown, ...rest: unknown[]) {
      if (chunk !== undefined && typeof chunk !== 'function' && reqBytes < maxBody) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        reqBytes += b.length;
        reqChunks.push(b);
      }
      // @ts-expect-error passthrough signature
      return origEnd(chunk, ...rest);
    } as typeof req.end;
    req.on('error', (err) => {
      pushHttpOut(ctx, { method, url: redUrl, error: errorMessage(err), errorName: errorName(err), errorKind: classifyError(err) }, performance.now() - t0, false);
    });
    return req;
  };

  mod.get = function get(...rawArgs: unknown[]): http.ClientRequest {
    const req = (mod.request as (...a: unknown[]) => http.ClientRequest)(...rawArgs);
    req.end();
    return req;
  };
  void origGet;
}

// ---------------------------------------------------------------------------
// replay fakes
// ---------------------------------------------------------------------------

class FakeIncomingMessage extends Readable {
  statusCode?: number;
  statusMessage?: string;
  headers: Record<string, string | string[]> = {};
  rawHeaders: string[] = [];
  httpVersion = '1.1';
  complete = true;
  aborted = false;
  trailers: Record<string, string> = {};
  rawTrailers: string[] = [];
  socket = null;
  private body: Buffer;
  private pushed = false;

  setTimeout(): this {
    return this;
  }

  constructor(rec: HttpOutData) {
    super();
    this.statusCode = rec.status ?? 200;
    this.body = Buffer.from(rec.responseBody ?? '', 'utf8');
    const hdrs: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(rec.responseHeaders ?? {})) {
      if (!DROP_RESPONSE_HEADERS.has(k.toLowerCase())) hdrs[k] = v;
    }
    if (this.body.length && hdrs['content-type'] === undefined) {
      hdrs['content-type'] = guessJson(this.body.toString('utf8')) ? 'application/json' : 'text/plain';
    }
    this.headers = hdrs;
    this.rawHeaders = Object.entries(hdrs).flatMap(([k, v]) => (Array.isArray(v) ? v.flatMap((x) => [k, x]) : [k, v]));
  }

  override _read(): void {
    if (this.pushed) return;
    this.pushed = true;
    if (this.body.length) this.push(this.body);
    this.push(null);
  }
}

class FakeClientRequest extends EventEmitter {
  private chunks: Buffer[] = [];
  private headerMap = new Map<string, string>();
  private finished = false;
  aborted = false;
  readonly path: string;
  readonly protocol: string;
  readonly host: string;
  reusedSocket = false;

  constructor(
    private readonly ctx: RuntimeCtx,
    private readonly rec: HttpOutData | undefined,
    readonly method: string,
    private readonly url: string,
    private readonly cb?: (res: http.IncomingMessage) => void,
  ) {
    super();
    try {
      const u = new URL(url);
      this.path = u.pathname + u.search;
      this.protocol = u.protocol;
      this.host = u.host;
    } catch {
      this.path = url;
      this.protocol = 'http:';
      this.host = '';
    }
  }

  write(chunk: unknown): boolean {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.chunks.push(b);
    return true;
  }

  end(chunk?: unknown, cb?: () => void): this {
    if (chunk !== undefined && typeof chunk !== 'function') {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    if (typeof chunk === 'function') cb = chunk as () => void;
    if (!this.finished) {
      this.finished = true;
      this.emit('finish');
      queueMicrotask(() => {
        this.respond();
        cb?.();
      });
    }
    return this;
  }

  setHeader(name: string, value: string): this {
    this.headerMap.set(name.toLowerCase(), String(value));
    return this;
  }
  getHeader(name: string): string | undefined {
    return this.headerMap.get(name.toLowerCase());
  }
  removeHeader(name: string): this {
    this.headerMap.delete(name.toLowerCase());
    return this;
  }
  getHeaders(): Record<string, string> {
    return Object.fromEntries(this.headerMap);
  }
  setTimeout(): this {
    return this;
  }
  setNoDelay(): this {
    return this;
  }
  setSocketKeepAlive(): this {
    return this;
  }
  flushHeaders(): void {}
  get writableEnded(): boolean {
    return this.finished;
  }
  abort(): void {
    this.aborted = true;
  }
  destroy(err?: Error): this {
    if (err) this.emit('error', err);
    return this;
  }

  private respond(): void {
    const rec = this.rec;
    const rawBody = this.chunks.length ? Buffer.concat(this.chunks).toString('utf8') : undefined;
    const rb = rawBody !== undefined ? this.ctx.redactor.redactBody(rawBody, undefined, 'http.out.requestBody') : undefined;
    if (rb) this.ctx.redactionHits.push(...rb.hits);
    const requestBody = rb?.value;
    if (!rec) {
      pushHttpOut(this.ctx, { method: this.method, url: this.url, requestBody, error: 'no recorded response', errorKind: 'error' }, 0, false);
      this.emit('error', new TypeError(`recurr replay: no recorded response for ${this.method} ${this.url}`));
      return;
    }
    pushHttpOut(this.ctx, { ...rec, requestBody: requestBody ?? rec.requestBody }, 0, !rec.error && !rec.errorKind);
    if (rec.errorKind === 'timeout') {
      const err = Object.assign(new Error(rec.error ?? 'ETIMEDOUT'), { code: 'ETIMEDOUT' });
      this.emit('timeout');
      this.emit('error', err);
      return;
    }
    if (rec.error || rec.errorKind) {
      this.emit('error', Object.assign(new Error(rec.error ?? 'request failed'), { code: rec.errorKind === 'reset' ? 'ECONNRESET' : 'ERECURR' }));
      return;
    }
    const res = new FakeIncomingMessage(rec) as unknown as http.IncomingMessage;
    if (this.cb) this.cb(res);
    else this.emit('response', res);
  }
}

function fakeClientRequest(
  ctx: RuntimeCtx,
  rec: HttpOutData | undefined,
  method: string,
  url: string,
  cb?: (res: http.IncomingMessage) => void,
): http.ClientRequest {
  return new FakeClientRequest(ctx, rec, method, url, cb) as unknown as http.ClientRequest;
}
