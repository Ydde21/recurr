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
  const name = (err as { name?: string })?.name ?? '';
  // undici wraps socket failures in AggregateError — walk the cause chain
  // and aggregate members, not just e.cause.code.
  const codes = new Set<string>();
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur; i++) {
    const c = cur as { code?: string; cause?: unknown; errors?: unknown[] };
    if (typeof c.code === 'string') codes.add(c.code);
    if (Array.isArray(c.errors)) for (const e2 of c.errors) {
      const cc = (e2 as { code?: string })?.code;
      if (typeof cc === 'string') codes.add(cc);
    }
    cur = c.cause;
  }
  if (name === 'TimeoutError' || codes.has('ETIMEDOUT') || codes.has('UND_ERR_CONNECT_TIMEOUT') || codes.has('UND_ERR_HEADERS_TIMEOUT') || codes.has('UND_ERR_BODY_TIMEOUT')) return 'timeout';
  if (codes.has('ECONNRESET') || codes.has('ECONNREFUSED') || codes.has('EPIPE') || codes.has('UND_ERR_SOCKET') || name === 'SocketError') return 'reset';
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

/** Clip to max BYTES, not chars — a 64k-char UTF-8 string can be 192k bytes. */
function clipUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  return Buffer.from(s, 'utf8').subarray(0, maxBytes).toString('utf8');
}

function bodyToString(body: unknown, maxBytes: number): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return clipUtf8(body, maxBytes);
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body).subarray(0, maxBytes).toString('utf8');
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof body === 'object' && 'pipe' in (body as object)) return '[stream]';
  if (body instanceof ReadableStream) return '[stream]';
  try {
    const s = JSON.stringify(body);
    return s === undefined ? undefined : clipUtf8(s, maxBytes);
  } catch {
    return '[unserializable]';
  }
}

/** Read at most maxBytes from a Response/Request clone — never materializes
 *  the full body the way .text() would on a multi-hundred-MB payload. */
async function readCloneBounded(clone: { body: ReadableStream<Uint8Array> | null }, maxBytes: number): Promise<string> {
  const stream = clone.body;
  if (!stream) return '';
  const reader = stream.getReader();
  const parts: Buffer[] = [];
  let n = 0;
  try {
    while (n <= maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value));
      n += value.length;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return Buffer.concat(parts).subarray(0, maxBytes).toString('utf8');
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

    const isReq = typeof input === 'object' && input !== null && typeof (input as Request).url === 'string';
    const method = (init?.method ?? (isReq ? (input as Request).method : 'GET')).toUpperCase();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
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
      // Honor caller aborts — a replayed response must not arrive after the
      // app's own AbortController fired.
      const sig = init?.signal ?? (isReq ? (input as Request).signal : undefined);
      const response = synthesizeFetchResponse(rec, method, url);
      if (sig) {
        if (sig.aborted) return Promise.reject(sig.reason instanceof Error ? sig.reason : new DOMException('This operation was aborted', 'AbortError'));
        return Promise.race([
          response,
          new Promise<never>((_res, rej) => {
            sig.addEventListener('abort', () => rej(sig.reason instanceof Error ? sig.reason : new DOMException('This operation was aborted', 'AbortError')), { once: true });
          }),
        ]);
      }
      return response;
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
      // Push now so event ordering reflects response arrival; bodies are
      // captured asynchronously (bounded) so large/streamed payloads never
      // delay the app.
      pushHttpOut(ctx, data, durationMs, true);
      if (ctx.config.capture?.captureOutboundBodies !== false) {
        // fetch(new Request(url, {body})) — the body lives on the Request
        // object, not in init. Read a clone, bounded.
        if (requestBody === undefined && isReq && (input as Request).body) {
          const reqClone = (input as Request).clone();
          const p = readCloneBounded(reqClone, maxBody)
            .then((raw) => {
              if (!raw) return;
              const red = ctx.redactor.redactBody(raw, undefined, 'http.out.requestBody');
              ctx.redactionHits.push(...red.hits);
              data.requestBody = red.value;
              if (ctx.closed) ctx.repersist?.();
            })
            .catch(() => {});
          ctx.pending.push(p);
        }
        const ct = res.headers.get('content-type') ?? undefined;
        const p = readCloneBounded(res.clone(), maxBody)
          .then((raw) => {
            const red = ctx.redactor.redactBody(raw, ct, 'http.out.responseBody');
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
  signal?: AbortSignal;
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
  return { args: a, method, url: urlStr, cb, signal: options.signal as AbortSignal | undefined };
}

function patchRequestModule(mod: typeof http | typeof https, scheme: string): void {
  const origRequest = mod.request.bind(mod);
  const origGet = mod.get.bind(mod);

  // Intentional monkeypatch of the module export — affects method-call style
  // usage (http.request(…)) and CJS consumers. Note: `import { request } from
  // 'node:http'` snapshots the binding and escapes patching.
  mod.request = function request(...rawArgs: unknown[]): http.ClientRequest {
    const ctx = als.getStore();
    const { args, method, url, cb, signal } = normalizeRequestArgs(scheme, rawArgs);
    if (!ctx) return (origRequest as (...a: unknown[]) => http.ClientRequest)(...rawArgs);

    const maxBody = ctx.redactor.maxBodyBytes;
    const redUrl = ctx.redactor.redactUrl(url).value;

    if (ctx.mode === 'replay') {
      const rec = nextRecordedHttpOut(ctx, method, redUrl);
      return fakeClientRequest(ctx, rec, method, url, cb, signal);
    }

    const t0 = performance.now();
    const reqChunks: Buffer[] = [];
    let reqBytes = 0;
    let resData: (HttpOutData & { responsePending?: boolean }) | undefined;
    let resEv: TimelineEvent | undefined;

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
      resData = data;
      resEv = ev;
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
        const b = Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? Buffer.from(chunk as Uint8Array) : Buffer.from(String(chunk));
        reqBytes += b.length;
        reqChunks.push(b.subarray(0, Math.max(0, maxBody - (reqBytes - b.length))));
      }
      // @ts-expect-error passthrough signature
      return origWrite(chunk, ...rest);
    } as typeof req.write;
    req.end = function (chunk?: unknown, ...rest: unknown[]) {
      if (chunk !== undefined && typeof chunk !== 'function' && reqBytes < maxBody) {
        const b = Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? Buffer.from(chunk as Uint8Array) : Buffer.from(String(chunk));
        reqBytes += b.length;
        reqChunks.push(b);
      }
      // @ts-expect-error passthrough signature
      return origEnd(chunk, ...rest);
    } as typeof req.end;
    req.on('finish', () => {
      // Body kept streaming after headers arrived — top up the recorded
      // requestBody with whatever was written by 'finish'.
      if (resData && reqBytes) {
        resData.requestBody = Buffer.concat(reqChunks).toString('utf8').slice(0, maxBody);
        if (ctx.closed) ctx.repersist?.();
      }
    });
    req.on('error', (err) => {
      // One event per outbound call — an error AFTER the response was
      // recorded mutates that event rather than emitting a duplicate that
      // would misalign replay matching.
      if (resData) {
        if (!resData.errorKind) {
          resData.error = errorMessage(err);
          resData.errorName = errorName(err);
          resData.errorKind = classifyError(err);
          if (resEv) resEv.status = 'error';
          if (ctx.closed) ctx.repersist?.();
        }
        return;
      }
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

/** Minimal socket stand-in — apps commonly touch res.socket/req.socket for
 *  keep-alive tuning and remote-address checks. */
function fakeSocket(): EventEmitter & { remoteAddress: string; remotePort: number; localAddress: string; setNoDelay: () => void; setKeepAlive: () => void; ref: () => void; unref: () => void; destroy: () => void } {
  const s = new EventEmitter() as EventEmitter & {
    remoteAddress: string;
    remotePort: number;
    localAddress: string;
    setNoDelay: () => void;
    setKeepAlive: () => void;
    ref: () => void;
    unref: () => void;
    destroy: () => void;
  };
  s.remoteAddress = '127.0.0.1';
  s.remotePort = 0;
  s.localAddress = '127.0.0.1';
  s.setNoDelay = () => {};
  s.setKeepAlive = () => {};
  s.ref = () => {};
  s.unref = () => {};
  s.destroy = () => {};
  return s;
}

class FakeIncomingMessage extends Readable {
  statusCode?: number;
  statusMessage?: string;
  headers: Record<string, string | string[]> = {};
  rawHeaders: string[] = [];
  httpVersion = '1.1';
  httpVersionMajor = 1;
  httpVersionMinor = 1;
  complete = true;
  aborted = false;
  trailers: Record<string, string> = {};
  rawTrailers: string[] = [];
  socket: unknown;
  connection: unknown;
  private body: Buffer;
  private pushed = false;

  setTimeout(_ms?: number, _cb?: () => void): this {
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
    this.socket = fakeSocket();
    this.connection = this.socket;
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
  private destroyedFlag = false;
  private timeoutCb?: () => void;
  aborted = false;
  readonly path: string;
  readonly protocol: string;
  readonly host: string;
  readonly socket: unknown;
  readonly connection: unknown;
  reusedSocket = false;

  constructor(
    private readonly ctx: RuntimeCtx,
    private readonly rec: HttpOutData | undefined,
    readonly method: string,
    private readonly url: string,
    cb: ((res: http.IncomingMessage) => void) | undefined,
    signal?: AbortSignal,
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
    this.socket = fakeSocket();
    this.connection = this.socket;
    // Node registers the request() callback as a 'response' listener.
    if (cb) this.once('response', cb as (...a: unknown[]) => void);
    if (signal) {
      const onAbort = () => {
        this.aborted = true;
        this.emit('error', signal.reason instanceof Error ? signal.reason : Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' }));
      };
      if (signal.aborted) queueMicrotask(onAbort);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  write(chunk: unknown, encOrCb?: unknown, cb?: unknown): boolean {
    if (this.destroyedFlag) return false;
    const b = Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? Buffer.from(chunk as Uint8Array) : Buffer.from(String(chunk));
    this.chunks.push(b);
    const done = typeof encOrCb === 'function' ? encOrCb : typeof cb === 'function' ? cb : undefined;
    if (done) queueMicrotask(done as () => void);
    return true;
  }

  end(chunk?: unknown, encOrCb?: unknown, cb?: unknown): this {
    const done =
      typeof chunk === 'function' ? (chunk as () => void) : typeof encOrCb === 'function' ? (encOrCb as () => void) : typeof cb === 'function' ? (cb as () => void) : undefined;
    if (chunk !== undefined && typeof chunk !== 'function') {
      const b = Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? Buffer.from(chunk as Uint8Array) : Buffer.from(String(chunk));
      this.chunks.push(b);
    }
    if (!this.finished) {
      this.finished = true;
      this.emit('finish');
      queueMicrotask(() => {
        this.respond();
        done?.();
      });
    }
    return this;
  }

  setHeader(name: string, value: string | string[]): this {
    this.headerMap.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
    return this;
  }
  getHeader(name: string): string | undefined {
    return this.headerMap.get(name.toLowerCase());
  }
  removeHeader(name: string): this {
    this.headerMap.delete(name.toLowerCase());
    return this;
  }
  hasHeader(name: string): boolean {
    return this.headerMap.has(name.toLowerCase());
  }
  getHeaders(): Record<string, string> {
    return Object.fromEntries(this.headerMap);
  }
  getHeaderNames(): string[] {
    return [...this.headerMap.keys()];
  }
  getRawHeaderNames(): string[] {
    return [...this.headerMap.keys()];
  }
  get headersSent(): boolean {
    return this.finished;
  }
  setTimeout(_ms?: number, cb?: () => void): this {
    this.timeoutCb = cb;
    return this;
  }
  setNoDelay(): this {
    return this;
  }
  setSocketKeepAlive(): this {
    return this;
  }
  flushHeaders(): void {}
  addTrailers(): void {}
  cork(): void {}
  uncork(): void {}
  get writableEnded(): boolean {
    return this.finished;
  }
  get writableFinished(): boolean {
    return this.finished;
  }
  get writableLength(): number {
    return this.chunks.reduce((n, c) => n + c.length, 0);
  }
  get destroyed(): boolean {
    return this.destroyedFlag;
  }
  abort(): void {
    this.aborted = true;
    this.destroyedFlag = true;
  }
  destroy(err?: Error): this {
    this.destroyedFlag = true;
    // Real ClientRequest emits 'error' unconditionally — unhandled 'error'
    // crashing the replay is faithful to production behavior.
    if (err) this.emit('error', err);
    return this;
  }

  private respond(): void {
    if (this.destroyedFlag) return;
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
      this.timeoutCb?.();
      this.emit('error', err);
      return;
    }
    if (rec.error || rec.errorKind) {
      this.emit('error', Object.assign(new Error(rec.error ?? 'request failed'), { code: rec.errorKind === 'reset' ? 'ECONNRESET' : 'ERECURR' }));
      return;
    }
    const res = new FakeIncomingMessage(rec) as unknown as http.IncomingMessage;
    this.emit('response', res);
  }
}

function fakeClientRequest(
  ctx: RuntimeCtx,
  rec: HttpOutData | undefined,
  method: string,
  url: string,
  cb?: (res: http.IncomingMessage) => void,
  signal?: AbortSignal,
): http.ClientRequest {
  return new FakeClientRequest(ctx, rec, method, url, cb, signal) as unknown as http.ClientRequest;
}
