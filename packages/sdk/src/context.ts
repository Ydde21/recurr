import { AsyncLocalStorage } from 'node:async_hooks';
import type { CapturedAuth, ExecutionRecord, TimelineEvent } from '@recurr/core';
import type { Redactor } from '@recurr/core';
import type { RecurrConfig } from './config.js';

/** Per-execution runtime state, carried through the request via ALS. */
export interface RuntimeCtx {
  mode: 'capture' | 'replay';
  recordId: string;
  startedMonoMs: number;
  startedWallMs: number;
  seq: number;
  events: TimelineEvent[];
  hadError: boolean;
  auth?: CapturedAuth;

  // ---- nondeterminism ----
  /** capture: appended; replay: consumed in order. */
  randomSeq: number[];
  uuidSeq: string[];
  randomIdx: number;
  uuidIdx: number;
  /** Total calls made (including beyond-captured fallbacks). */
  randomReads: number;
  uuidReads: number;
  /** Date.now() + no-arg `new Date()` reads inside this ctx. */
  timeReads: number;
  prng: () => number;

  // ---- replay cursors over the source incident's events ----
  replaySource?: ExecutionRecord;
  dbCursor: number;
  httpOutCursor: number;

  /** Async captures still resolving (e.g. cloned fetch bodies). */
  pending: Promise<unknown>[];
  /** True once the response finished and the record was saved. Events that
   *  arrive afterward are flagged and trigger a re-save. */
  closed: boolean;
  /** State needed to re-save the record when late events arrive. */
  repersist?: () => void;
  /** Dedupe set for one-shot replay notes / flags. */
  flags: Set<string>;
  /** Set while the SDK itself is doing record bookkeeping — clock reads made
   *  internally (event timestamps, capturedAt) don't count toward the app's
   *  nondeterminism usage. */
  bookkeeping?: boolean;
  /** Set when the client disconnected before the response finished. */
  aborted?: boolean;

  /** Accumulated redaction hits / truncations for the final record. */
  redactionHits: string[];
  truncatedPaths: string[];
  /** Set when the execution threw. */
  error?: { name: string; message: string; stack?: string; code?: string };

  config: RecurrConfig;
  redactor: Redactor;
}

export const als = new AsyncLocalStorage<RuntimeCtx>();

export function currentCtx(): RuntimeCtx | undefined {
  return als.getStore();
}

export function nextSeq(ctx: RuntimeCtx): number {
  return ++ctx.seq;
}

export function offsetMs(ctx: RuntimeCtx): number {
  return Math.round((performance.now() - ctx.startedMonoMs) * 1000) / 1000;
}

export function pushEvent(
  ctx: RuntimeCtx,
  kind: TimelineEvent['kind'],
  opts: { name?: string; durationMs?: number; status?: 'ok' | 'error'; data?: Record<string, unknown> } = {},
): TimelineEvent {
  const data =
    ctx.closed
      ? { ...(opts.data ?? {}), _afterResponse: true }
      : opts.data;
  ctx.bookkeeping = true;
  const at = new Date().toISOString();
  ctx.bookkeeping = false;
  const ev: TimelineEvent = {
    seq: nextSeq(ctx),
    at,
    offsetMs: offsetMs(ctx),
    kind,
    name: opts.name,
    durationMs: opts.durationMs,
    status: opts.status,
    data,
  };
  ctx.events.push(ev);
  if (ctx.closed) ctx.repersist?.();
  return ev;
}

/**
 * Replay-mode note: surfaces divergence inside the replay record itself.
 * Pass `onceKey` to emit a given note at most once per execution.
 */
export function replayNote(
  ctx: RuntimeCtx,
  message: string,
  data?: Record<string, unknown>,
  onceKey?: string,
): void {
  if (onceKey) {
    if (ctx.flags.has(onceKey)) return;
    ctx.flags.add(onceKey);
  }
  pushEvent(ctx, 'replay.note', { name: 'divergence', status: 'error', data: { message, ...data } });
}
