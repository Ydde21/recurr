import type { DbQueryData } from '@recurr/core';
import { als, pushEvent, replayNote, type RuntimeCtx } from '../context.js';

/**
 * Database interception — explicit instrumentation of a queryable.
 *
 *   const pool = new pg.Pool();
 *   recurr.instrumentDb(pool);
 *
 * Works with pg.Pool, pg.Client, pg-mem adapters, or any object exposing a
 * promise- or callback-style query(). In capture mode queries run normally and
 * text/params/rows/duration are recorded. In replay mode queries are answered
 * from the incident record — no database is touched.
 */

export interface Queryable {
  query: (...args: never[]) => unknown;
}

interface NormalizedQuery {
  text: string;
  params?: unknown[];
}

function normalizeQueryArgs(args: unknown[]): NormalizedQuery {
  const first = args[0];
  if (typeof first === 'object' && first !== null && 'text' in (first as object)) {
    const cfg = first as { text: string; values?: unknown[] };
    return { text: cfg.text, params: cfg.values };
  }
  const text = typeof first === 'string' ? first : String(first);
  const params = Array.isArray(args[1]) ? (args[1] as unknown[]) : undefined;
  return { text, params };
}

function normalizeSql(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const LOOKAHEAD = 3;

function nextRecordedDbQuery(ctx: RuntimeCtx, text: string): DbQueryData | undefined {
  const events = ctx.replaySource?.events ?? [];
  let idx = -1;
  for (let i = ctx.dbCursor; i < events.length; i++) {
    if (events[i].kind === 'db.query') {
      idx = i;
      break;
    }
  }
  if (idx === -1) {
    replayNote(ctx, `db query with no recorded result: ${text.slice(0, 120)}`, { text });
    return undefined;
  }
  const cand = events[idx].data as unknown as DbQueryData | undefined;
  if (cand && normalizeSql(cand.text) !== normalizeSql(text)) {
    for (let k = idx + 1; k <= Math.min(events.length - 1, idx + LOOKAHEAD); k++) {
      const d = events[k].kind === 'db.query' ? (events[k].data as unknown as DbQueryData) : undefined;
      if (d && normalizeSql(d.text) === normalizeSql(text)) {
        for (let s = idx; s < k; s++) {
          replayNote(ctx, `recorded query not executed during replay: ${(events[s].data as unknown as DbQueryData)?.text?.slice(0, 120)}`, { seq: events[s].seq });
        }
        ctx.dbCursor = k + 1;
        return d;
      }
    }
    replayNote(ctx, `db query differs from recorded: ${normalizeSql(text).slice(0, 120)} (recorded: ${normalizeSql(cand.text).slice(0, 120)})`, { seq: events[idx].seq });
  }
  ctx.dbCursor = idx + 1;
  return cand;
}

function commandOf(text: string): string {
  return normalizeSql(text).split(' ')[0]?.toUpperCase() ?? 'QUERY';
}

function resultFromRecorded(rec: DbQueryData | undefined): { rows: unknown[]; rowCount: number; command: string; fields: never[] } {
  const rows = rec?.rows ?? [];
  return {
    rows,
    rowCount: rec?.rowCount ?? rows.length,
    command: rec ? commandOf(rec.text) : 'QUERY',
    fields: [],
  };
}

function errorFromRecorded(rec: DbQueryData | undefined): Error | null {
  if (!rec?.error) return null;
  const err = new Error(rec.error);
  err.name = rec.errorName ?? 'DatabaseError';
  return err;
}

export function instrumentDb<T extends Queryable>(db: T, opts: { system?: string } = {}): T {
  const target = db as unknown as { query: (...args: unknown[]) => unknown };
  const origQuery = target.query;
  if (typeof origQuery !== 'function') throw new Error('recurr.instrumentDb: object has no query()');
  const system = opts.system ?? 'postgres';

  target.query = function patchedQuery(this: unknown, ...args: unknown[]): unknown {
    const ctx = als.getStore();
    if (!ctx) return origQuery.apply(target, args);

    const cbIdx = args.findIndex((a) => typeof a === 'function');
    const cb = cbIdx >= 0 ? (args[cbIdx] as (err: unknown, res?: unknown) => void) : undefined;
    const { text, params } = normalizeQueryArgs(args);
    const t0 = performance.now();
    const name = `${system} ${commandOf(text)}`;

    if (ctx.mode === 'replay') {
      const rec = nextRecordedDbQuery(ctx, text);
      const durationMs = 0;
      const err = errorFromRecorded(rec);
      const res = resultFromRecorded(rec);
      pushEvent(ctx, 'db.query', {
        name,
        durationMs,
        status: err ? 'error' : 'ok',
        data: rec
          ? ({ ...rec, text, params: params ?? rec.params } as unknown as Record<string, unknown>)
          : ({ system, text, params, error: 'no recorded result' } as unknown as Record<string, unknown>),
      });
      if (cb) {
        queueMicrotask(() => (err ? cb(err) : cb(null, res)));
        return undefined;
      }
      return err ? Promise.reject(err) : Promise.resolve(res);
    }

    const record = (err: unknown, res?: { rows?: unknown[]; rowCount?: number }) => {
      const durationMs = Math.round((performance.now() - t0) * 1000) / 1000;
      const data: DbQueryData = { system, text, params };
      if (err) {
        data.error = err instanceof Error ? err.message : String(err);
        data.errorName = err instanceof Error ? err.name : 'Error';
      } else if (res) {
        data.rowCount = res.rowCount ?? res.rows?.length;
        if (ctx.config.capture?.captureDbRows !== false && Array.isArray(res.rows)) {
          const max = ctx.config.capture?.maxDbRows ?? 50;
          const kept = res.rows.slice(0, max);
          const red = ctx.redactor.redactValue(kept, 'db.rows');
          ctx.redactionHits.push(...red.hits);
          ctx.truncatedPaths.push(...red.truncated);
          data.rows = red.value;
          data.rowsTruncated = res.rows.length > max;
        }
      }
      pushEvent(ctx, 'db.query', { name, durationMs, status: err ? 'error' : 'ok', data: data as unknown as Record<string, unknown> });
    };

    if (cb) {
      const newArgs = [...args];
      newArgs[cbIdx] = (err: unknown, res?: { rows?: unknown[]; rowCount?: number }) => {
        record(err, res);
        cb(err, res);
      };
      return origQuery.apply(target, newArgs);
    }
    try {
      const out = origQuery.apply(target, args) as Promise<{ rows?: unknown[]; rowCount?: number }> & { rows?: unknown[] };
      if (out && typeof (out as Promise<unknown>).then === 'function') {
        return (out as Promise<{ rows?: unknown[]; rowCount?: number }>).then(
          (res) => {
            record(null, res);
            return res;
          },
          (err) => {
            record(err);
            throw err;
          },
        );
      }
      record(null, out as { rows?: unknown[]; rowCount?: number });
      return out;
    } catch (err) {
      record(err);
      throw err;
    }
  };

  return db;
}
