import { EventEmitter } from 'node:events';
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
 *
 * For pools, `connect()` is wrapped so checked-out clients are instrumented
 * too — without that, `pool.connect()` + `client.query()` would bypass
 * interception and (at replay) touch a real database.
 */

export interface Queryable {
  query: (...args: never[]) => unknown;
  connect?: (...args: never[]) => unknown;
}

const INSTRUMENTED = Symbol.for('recurr.instrumented');

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

function resultFromRecorded(rec: DbQueryData | undefined): { rows: unknown[]; rowCount: number; command: string; fields: { name: string; dataTypeID: number }[] } {
  const rows = rec?.rows ?? [];
  // pg fills `fields` with column metadata — derive names from row keys so
  // apps reading res.fields[i].name don't crash on undefined.
  const first = rows.find((r) => r !== null && typeof r === 'object') as Record<string, unknown> | undefined;
  const fields = first ? Object.keys(first).map((name) => ({ name, dataTypeID: 0 })) : [];
  return {
    rows,
    rowCount: rec?.rowCount ?? rows.length,
    command: rec ? commandOf(rec.text) : 'QUERY',
    fields,
  };
}

function errorFromRecorded(rec: DbQueryData | undefined): Error | null {
  if (!rec?.error) return null;
  const err = new Error(rec.error);
  err.name = rec.errorName ?? 'DatabaseError';
  return err;
}

/** Thenable + EventEmitter-shaped result covering both consumer styles. */
function fakeSubmittable(
  res: { rows: unknown[]; rowCount: number; command: string; fields: { name: string; dataTypeID: number }[] },
  err: Error | null,
): EventEmitter & Promise<typeof res> {
  const q = new EventEmitter();
  const p: Promise<typeof res> = err ? Promise.reject(err) : Promise.resolve(res);
  // An unhandled rejection on a promise nobody awaits is fatal in newer Node —
  // swallow it here; the 'error' event below is the honest delivery channel.
  p.catch(() => {});
  queueMicrotask(() => {
    if (err) {
      // Emitting 'error' on an unlistened EventEmitter throws synchronously —
      // only emit when someone is actually listening; awaiting callers still
      // get the rejection through the promise channel.
      if (q.listenerCount('error') > 0) q.emit('error', err);
      return;
    }
    for (const row of res.rows) q.emit('row', row);
    q.emit('end', res);
  });
  const hybrid = q as EventEmitter & Promise<typeof res>;
  hybrid.then = p.then.bind(p);
  hybrid.catch = p.catch.bind(p);
  hybrid.finally = p.finally.bind(p);
  return hybrid;
}

/**
 * Synthetic pool client for replay: query() delegates to the pool's patched
 * query (which serves recorded results), release()/end() are no-ops. Keeps
 * `const client = await pool.connect(); … client.release()` working at replay
 * without opening a real connection.
 */
function fakeReplayClient(pool: { query: (...args: unknown[]) => unknown }): unknown {
  const client = new EventEmitter() as EventEmitter & {
    query: (...a: unknown[]) => unknown;
    release: (err?: unknown) => void;
    end: () => Promise<void>;
    destroy: () => void;
  };
  client.query = (...a: unknown[]) => pool.query(...a);
  client.release = () => {};
  client.end = () => Promise.resolve();
  client.destroy = () => {};
  return client;
}

function isSubmittable(out: unknown): out is EventEmitter {
  return (
    typeof out === 'object' &&
    out !== null &&
    typeof (out as EventEmitter).on === 'function' &&
    typeof (out as Promise<unknown>).then !== 'function'
  );
}

export function instrumentDb<T extends Queryable>(db: T, opts: { system?: string } = {}): T {
  const target = db as unknown as { query: (...args: unknown[]) => unknown; [INSTRUMENTED]?: boolean; connect?: (...args: unknown[]) => unknown };
  if (target[INSTRUMENTED]) return db;
  const origQuery = target.query;
  if (typeof origQuery !== 'function') throw new Error('recurr.instrumentDb: object has no query()');
  target[INSTRUMENTED] = true;
  const system = opts.system ?? 'postgres';

  // Checked-out clients must be instrumented too — otherwise client.query()
  // bypasses interception entirely (capture gap + real-DB access at replay).
  const origConnect = target.connect?.bind(target);
  if (origConnect) {
    target.connect = function (...args: unknown[]): unknown {
      const cbIdx = args.findIndex((a) => typeof a === 'function');
      const cb = cbIdx >= 0 ? (args[cbIdx] as (err: unknown, client?: T) => void) : undefined;

      // Replay: never touch the real pool — a connect() would attempt a real
      // connection (blocked by egress isolation). Hand back a fake client whose
      // query() flows through the same recorded-result path.
      if (als.getStore()?.mode === 'replay') {
        const fake = fakeReplayClient(target);
        if (cb) {
          queueMicrotask(() => cb(null, fake as T));
          return undefined;
        }
        return Promise.resolve(fake as T);
      }

      const pArgs = cbIdx >= 0 ? args.slice(0, cbIdx).concat(args.slice(cbIdx + 1)) : args;
      const wrap = (client: T) =>
        client && typeof (client as Queryable).query === 'function' ? instrumentDb(client, opts) : client;
      if (cb) {
        return origConnect(...pArgs, (err: unknown, client?: T) => cb(err, err ? client : wrap(client as T)));
      }
      const out = origConnect(...pArgs) as Promise<T>;
      return out && typeof out.then === 'function' ? out.then(wrap) : out;
    };
  }

  target.query = function patchedQuery(this: unknown, ...args: unknown[]): unknown {
    const ctx = als.getStore();
    if (!ctx) return origQuery.apply(target, args);

    const cbIdx = args.findIndex((a) => typeof a === 'function');
    const cb = cbIdx >= 0 ? (args[cbIdx] as (err: unknown, res?: unknown) => void) : undefined;
    const { text, params } = normalizeQueryArgs(args);
    const t0 = performance.now();
    const name = `${system} ${commandOf(text)}`;

    // Params may embed secrets in object values — walk them; scalar params
    // pass through untouched. capture.dbParams:'omit' drops them entirely.
    const capturedParams =
      ctx.config.capture?.dbParams === 'omit'
        ? undefined
        : params === undefined
          ? undefined
          : (() => {
              const r = ctx.redactor.redactValue(params, 'db.params');
              ctx.redactionHits.push(...r.hits);
              ctx.truncatedPaths.push(...r.truncated);
              return r.value;
            })();

    if (ctx.mode === 'replay') {
      const rec = nextRecordedDbQuery(ctx, text);
      const err = errorFromRecorded(rec);
      const res = resultFromRecorded(rec);
      pushEvent(ctx, 'db.query', {
        name,
        durationMs: 0,
        status: err ? 'error' : 'ok',
        data: rec
          ? ({ ...rec, text, params: capturedParams ?? rec.params } as unknown as Record<string, unknown>)
          : ({ system, text, params: capturedParams, error: 'no recorded result' } as unknown as Record<string, unknown>),
      });
      if (cb) {
        queueMicrotask(() => (err ? cb(err) : cb(null, res)));
        return undefined;
      }
      // Return a hybrid: thenable (for `await` callers) + EventEmitter (for
      // pg Submittable-style `.on('row'/'end'/'error')` consumers).
      return fakeSubmittable(res, err);
    }

    const record = (err: unknown, res?: { rows?: unknown[]; rowCount?: number }) => {
      const durationMs = Math.round((performance.now() - t0) * 1000) / 1000;
      const data: DbQueryData = { system, text, params: capturedParams };
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
      if (isSubmittable(out)) {
        // Submittable path (e.g. client.query() w/o callback): rows/results
        // arrive via 'end'/'error' events — record on completion.
        let done = false;
        const once = (err: unknown, res?: { rows?: unknown[]; rowCount?: number }) => {
          if (done) return;
          done = true;
          record(err, res);
        };
        out.on('end', (res: { rows?: unknown[]; rowCount?: number }) => once(null, res));
        out.on('error', (err: unknown) => once(err));
        return out;
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
