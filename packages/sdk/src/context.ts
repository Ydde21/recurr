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
  prng: () => number;

  // ---- replay cursors over the source incident's events ----
  replaySource?: ExecutionRecord;
  dbCursor: number;
  httpOutCursor: number;

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
  const ev: TimelineEvent = {
    seq: nextSeq(ctx),
    at: new Date().toISOString(),
    offsetMs: offsetMs(ctx),
    kind,
    name: opts.name,
    durationMs: opts.durationMs,
    status: opts.status,
    data: opts.data,
  };
  ctx.events.push(ev);
  return ev;
}

/** Replay-mode note: surfaces divergence inside the replay record itself. */
export function replayNote(ctx: RuntimeCtx, message: string, data?: Record<string, unknown>): void {
  pushEvent(ctx, 'replay.note', { name: 'divergence', status: 'error', data: { message, ...data } });
}
