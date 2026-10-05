import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  SCHEMA_VERSION,
  mulberry32,
  newIncidentId,
  newReplayId,
  seedFromString,
  type CapturedHttpRequest,
  type ExecutionRecord,
  type Redactor,
} from '@recurr/core';
import type { IncidentStore } from '@recurr/store';
import type { RecurrConfig } from './config.js';
import { offsetMs, pushEvent, type RuntimeCtx } from './context.js';

export interface RecurrState {
  cfg: RecurrConfig;
  mode: 'capture' | 'replay' | 'off';
  store: IncidentStore;
  redactor: Redactor;
  /** In replay mode: the incident being reproduced. */
  replaySource?: ExecutionRecord;
  /** In-flight record saves, drained by flush(). */
  pending: Set<Promise<unknown>>;
}

export function makeCtx(state: RecurrState): RuntimeCtx {
  const mode = state.mode === 'replay' ? 'replay' : 'capture';
  const source = state.replaySource;
  const id = mode === 'replay' ? newReplayId() : newIncidentId();
  return {
    mode,
    recordId: id,
    startedMonoMs: performance.now(),
    startedWallMs: Date.now(),
    seq: 0,
    events: [],
    hadError: false,
    randomSeq: source ? [...source.seed.random] : [],
    uuidSeq: source ? [...source.seed.uuids] : [],
    randomIdx: 0,
    uuidIdx: 0,
    prng: mulberry32(seedFromString(source?.id ?? id)),
    replaySource: source,
    dbCursor: 0,
    httpOutCursor: 0,
    redactionHits: [],
    truncatedPaths: [],
    config: state.cfg,
    redactor: state.redactor,
  };
}

export function recordError(ctx: RuntimeCtx, err: unknown): void {
  ctx.hadError = true;
  const e = err as { name?: string; message?: string; stack?: string; code?: string };
  ctx.error = {
    name: e?.name ?? 'Error',
    message: e?.message ?? String(err),
    stack: e?.stack,
    code: e?.code,
  };
  if (ctx.events[ctx.events.length - 1]?.kind !== 'error') {
    pushEvent(ctx, 'error', { name: ctx.error.name, status: 'error', data: { message: ctx.error.message, stack: ctx.error.stack } });
  }
}

export interface RequestLike {
  method?: string;
  url?: string;
  originalUrl?: string;
  path?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  socket?: { remoteAddress?: string };
}

function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

export function extractRequest(ctx: RuntimeCtx, req: RequestLike): CapturedHttpRequest {
  const url = req.originalUrl ?? req.url ?? '/';
  const hdrs: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) hdrs[k] = v;
  }
  const red = ctx.redactor.redactHeaders(hdrs, 'request.headers');
  ctx.redactionHits.push(...red.hits);
  const redUrl = ctx.redactor.redactUrl(url);

  let body: string | undefined;
  let bodyBase64 = false;
  const raw = req.body;
  if (raw !== undefined && raw !== null) {
    if (typeof raw === 'object' && !Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) {
      body = safeJson(raw);
    } else if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
      body = Buffer.from(raw as Uint8Array).toString('base64');
      bodyBase64 = true;
    } else {
      body = String(raw);
    }
    if (body !== undefined && !bodyBase64) {
      const ct = String(hdrs['content-type'] ?? '');
      const rb = ctx.redactor.redactBody(body, ct, 'request.body');
      ctx.redactionHits.push(...rb.hits);
      ctx.truncatedPaths.push(...rb.truncated);
      body = rb.value;
    }
  }
  return {
    method: req.method ?? 'GET',
    url: redUrl.value,
    path: pathOf(redUrl.value),
    headers: red.value,
    body,
    bodyBase64: bodyBase64 || undefined,
    remoteAddr: req.socket?.remoteAddress?.replace(/^::ffff:/, ''),
  };
}

function safeJson(v: unknown): string | undefined {
  try {
    return JSON.stringify(v);
  } catch {
    return undefined;
  }
}

export function buildRecord(
  ctx: RuntimeCtx,
  state: RecurrState,
  req: RequestLike,
  res: ServerResponse,
  resBody: string | undefined,
  resBodyBase64: boolean,
): ExecutionRecord {
  const request = extractRequest(ctx, req);
  const resHeaders: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(res.getHeaders())) {
    if (v !== undefined) resHeaders[k] = Array.isArray(v) ? v.map(String) : String(v);
  }
  const redHeaders = ctx.redactor.redactHeaders(resHeaders, 'response.headers');
  ctx.redactionHits.push(...redHeaders.hits);

  let body = resBody;
  if (body !== undefined && !resBodyBase64) {
    const rb = ctx.redactor.redactBody(body, String(res.getHeader('content-type') ?? ''), 'response.body');
    ctx.redactionHits.push(...rb.hits);
    ctx.truncatedPaths.push(...rb.truncated);
    body = rb.value;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    id: ctx.recordId,
    kind: ctx.mode === 'replay' ? 'replay' : 'incident',
    replayOf: ctx.replaySource?.id,
    service: {
      name: state.cfg.service,
      version: state.cfg.version,
      gitSha: state.cfg.gitSha,
      runtime: `node ${process.version}`,
    },
    environment: { name: state.cfg.env ?? process.env.NODE_ENV ?? 'development' },
    capturedAt: new Date().toISOString(),
    trigger: { type: ctx.mode === 'replay' ? 'replay' : 'http' },
    request,
    response: {
      status: res.statusCode,
      headers: redHeaders.value,
      body,
      bodyBase64: resBodyBase64 || undefined,
      durationMs: offsetMs(ctx),
    },
    error: ctx.error,
    auth: ctx.auth,
    seed: {
      startedAtWallMs: ctx.startedWallMs,
      random: ctx.mode === 'replay' ? ctx.randomSeq.slice(0, ctx.randomIdx) : ctx.randomSeq,
      uuids: ctx.mode === 'replay' ? ctx.uuidSeq.slice(0, ctx.uuidIdx) : ctx.uuidSeq,
      prngSeed: seedFromString(ctx.recordId),
    },
    events: ctx.events,
    redaction: {
      redactedPaths: dedupe(ctx.redactionHits),
      truncatedPaths: dedupe(ctx.truncatedPaths),
    },
    labels: state.cfg.labels,
  };
}

function dedupe(a: string[]): string[] {
  return [...new Set(a)];
}

export function shouldPersist(ctx: RuntimeCtx, state: RecurrState, status: number): boolean {
  if (ctx.mode === 'replay') return true;
  if (state.cfg.capture?.on === 'always') return true;
  return status >= 500 || ctx.hadError;
}

export function persist(ctx: RuntimeCtx, state: RecurrState, record: ExecutionRecord): void {
  const p = state.store
    .save(record)
    .catch((err) => console.error('[recurr] failed to persist record:', err))
    .finally(() => state.pending.delete(p));
  state.pending.add(p);
  if (ctx.mode === 'replay' && typeof process.send === 'function') {
    void p.then(() => {
      try {
        process.send?.({ type: 'recurr:done', id: record.id });
      } catch {
        /* parent not listening */
      }
    });
  }
}
