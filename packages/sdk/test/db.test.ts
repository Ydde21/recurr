import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createRedactor, type DbQueryData, type ExecutionRecord } from '@recurr-dev/core';
import { als } from '../src/context.js';
import { instrumentDb } from '../src/patches/db.js';
import { makeCtx, type RecurrState } from '../src/state.js';
import type { RecurrConfig } from '../src/config.js';

/**
 * DB deep suite — capture and replay semantics for the queryable surface:
 * params, rows, errors, transactions, pools, connect(), callbacks,
 * Submittable-style emitters, and the recorded-rowset replay model.
 */

type Result = { rows?: Record<string, unknown>[]; rowCount?: number; error?: Error };

class FakePool {
  calls: Array<{ text: string; params?: unknown[] }> = [];
  connectCalls = 0;
  constructor(private answer: (q: string) => Result) {}

  query(...args: unknown[]): unknown {
    const first = args[0] as { text?: string } | string;
    const text = typeof first === 'object' && first !== null && 'text' in first ? String(first.text) : String(first);
    const params =
      typeof first === 'object' && first !== null && 'values' in first
        ? (first as { values?: unknown[] }).values
        : Array.isArray(args[1])
          ? (args[1] as unknown[])
          : undefined;
    const cbIdx = args.findIndex((a) => typeof a === 'function');
    this.calls.push({ text, params });
    const r = this.answer(text);
    const finish = () => (r.error ? Promise.reject(r.error) : Promise.resolve({ rows: r.rows ?? [], rowCount: r.rowCount ?? r.rows?.length ?? 0, command: text.split(' ')[0].toUpperCase(), fields: [] }));
    if (cbIdx >= 0) {
      const cb = args[cbIdx] as (err: unknown, res?: unknown) => void;
      void finish().then(
        (res) => cb(null, res),
        (err) => cb(err),
      );
      return undefined;
    }
    return finish();
  }

  connect(cb?: (err: unknown, client?: FakeClient) => void): Promise<FakeClient> | undefined {
    this.connectCalls++;
    const c = new FakeClient(this);
    if (cb) {
      queueMicrotask(() => cb(null, c));
      return undefined;
    }
    return Promise.resolve(c);
  }
}

class FakeClient extends EventEmitter {
  released = false;
  constructor(private pool: FakePool) {
    super();
  }
  query(...args: unknown[]) {
    return this.pool.query(...args);
  }
  release() {
    this.released = true;
  }
  end() {
    return Promise.resolve();
  }
}

/** A pg-Submittable-style queryable: returns an EventEmitter, not a promise. */
class SubmittableDb extends EventEmitter {
  constructor(private rows: Record<string, unknown>[]) {
    super();
  }
  query() {
    const q = new EventEmitter();
    queueMicrotask(() => {
      for (const r of this.rows) q.emit('row', r);
      q.emit('end', { rows: this.rows, rowCount: this.rows.length });
    });
    return q;
  }
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
    cfg: { service: 'db-test', capture: { on: 'always' }, ...cfg },
    mode: replaySource ? 'replay' : 'capture',
    replaySource,
    store: storeStub,
    redactor: createRedactor(),
    pending: new Set(),
    inflight: 0,
  } as RecurrState;
}

function dbEvent(seq: number, text: string, data: Partial<DbQueryData> = {}) {
  return {
    seq,
    at: '2026-01-01T00:00:00Z',
    offsetMs: seq,
    kind: 'db.query' as const,
    name: 'postgres QUERY',
    data: { system: 'postgres', text, ...data } as unknown as Record<string, unknown>,
  };
}

function sourceWithDbEvents(events: ExecutionRecord['events']): ExecutionRecord {
  return {
    schemaVersion: 1,
    id: 'RUN-DBSRC1',
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

describe('db capture — queryable surface', () => {
  it('parameterized query records text + redacted params', async () => {
    const pool = instrumentDb(new FakePool(() => ({ rows: [{ id: 1 }] })) as never);
    const state = mkState();
    const ctx = makeCtx(state);
    await als.run(ctx, async () => {
      await pool.query('SELECT * FROM t WHERE id=$1 AND pw=$2', [7, 'hunter2']);
    });
    const e = ctx.events.find((x) => x.kind === 'db.query')!;
    const d = e.data as unknown as DbQueryData;
    expect(d.text).toBe('SELECT * FROM t WHERE id=$1 AND pw=$2');
    expect(d.params).toEqual([7, 'hunter2']); // params recorded verbatim (values aren't field names)
    expect(d.rows).toEqual([{ id: 1 }]);
    expect(d.rowCount).toBe(1);
    expect(e.status).toBe('ok');
  });

  it("dbParams:'omit' drops params entirely", async () => {
    const pool = instrumentDb(new FakePool(() => ({ rows: [] })) as never);
    const state = mkState({ capture: { on: 'always', dbParams: 'omit' } });
    const ctx = makeCtx(state);
    await als.run(ctx, async () => {
      await pool.query('SELECT $1', ['secret-value']);
    });
    const d = ctx.events[0].data as unknown as DbQueryData;
    expect(d.params).toBeUndefined();
  });

  it('query error records status=error with name/message', async () => {
    const err = new Error('relation "nope" does not exist');
    err.name = 'QueryFailedError';
    const pool = instrumentDb(new FakePool(() => ({ error: err })) as never);
    const ctx = makeCtx(mkState());
    await als.run(ctx, async () => {
      await expect(pool.query('SELECT * FROM nope')).rejects.toThrow('relation "nope" does not exist');
    });
    const e = ctx.events[0];
    expect(e.status).toBe('error');
    expect((e.data as unknown as DbQueryData).error).toContain('relation');
    expect((e.data as unknown as DbQueryData).errorName).toBe('QueryFailedError');
  });

  it('transaction sequence records BEGIN/queries/COMMIT in order', async () => {
    const pool = instrumentDb(new FakePool(() => ({ rows: [] })) as never);
    const ctx = makeCtx(mkState());
    await als.run(ctx, async () => {
      await pool.query('BEGIN');
      await pool.query('INSERT INTO t VALUES ($1)', [1]);
      await pool.query('COMMIT');
    });
    const texts = ctx.events.filter((e) => e.kind === 'db.query').map((e) => (e.data as unknown as DbQueryData).text);
    expect(texts).toEqual(['BEGIN', 'INSERT INTO t VALUES ($1)', 'COMMIT']);
  });

  it('empty + large results: rows bounded at maxDbRows with rowsTruncated flag', async () => {
    const big = Array.from({ length: 300 }, (_, i) => ({ i }));
    const pool = instrumentDb(new FakePool((q) => (q.includes('empty') ? { rows: [] } : { rows: big })) as never);
    const ctx = makeCtx(mkState({ capture: { on: 'always', maxDbRows: 50 } }));
    await als.run(ctx, async () => {
      await pool.query('SELECT empty');
      await pool.query('SELECT big');
    });
    const [empty, large] = ctx.events.map((e) => e.data as unknown as DbQueryData);
    expect(empty.rows).toEqual([]);
    expect(empty.rowCount).toBe(0);
    expect(large.rows!.length).toBe(50);
    expect(large.rowsTruncated).toBe(true);
    expect(ctx.truncatedPaths).toEqual([]); // row cap is its own flag, not a truncation
  });

  it('pool.connect() checked-out client queries are captured', async () => {
    const pool = instrumentDb(new FakePool(() => ({ rows: [{ ok: 1 }] })) as never);
    const ctx = makeCtx(mkState());
    await als.run(ctx, async () => {
      const client = (await pool.connect()) as FakeClient;
      await client.query('SELECT via-client');
      client.release();
    });
    const d = ctx.events[0].data as unknown as DbQueryData;
    expect(d.text).toBe('SELECT via-client');
    expect(d.rows).toEqual([{ ok: 1 }]);
  });

  it('callback-style query(text, params, cb) is captured', async () => {
    const pool = instrumentDb(new FakePool(() => ({ rows: [{ n: 2 }] })) as never);
    const ctx = makeCtx(mkState());
    await als.run(ctx, async () => {
      await new Promise<void>((res, rej) => {
        (pool.query as (...a: unknown[]) => void)('SELECT $1', [9], (err: unknown, r?: { rows: unknown[] }) =>
          err ? rej(err) : (expect(r!.rows).toEqual([{ n: 2 }]), res()),
        );
      });
    });
    expect((ctx.events[0].data as unknown as DbQueryData).text).toBe('SELECT $1');
  });

  it('query({text, values}) config-object form is normalized', async () => {
    const pool = instrumentDb(new FakePool(() => ({ rows: [] })) as never);
    const ctx = makeCtx(mkState());
    await als.run(ctx, async () => {
      await pool.query({ text: 'SELECT $1', values: [1] } as never);
    });
    const d = ctx.events[0].data as unknown as DbQueryData;
    expect(d.text).toBe('SELECT $1');
    expect(d.params).toEqual([1]);
  });

  it('Submittable-style query (EventEmitter) records on end', async () => {
    const db = instrumentDb(new SubmittableDb([{ a: 1 }, { a: 2 }]) as never);
    const ctx = makeCtx(mkState());
    await als.run(ctx, async () => {
      const q = db.query() as EventEmitter;
      await new Promise<void>((res) => q.on('end', () => res()));
    });
    const d = ctx.events[0].data as unknown as DbQueryData;
    expect(d.rowCount).toBe(2);
    expect(d.rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('queries outside a request ctx pass through untouched', async () => {
    const raw = new FakePool(() => ({ rows: [{ live: 1 }] }));
    const pool = instrumentDb(raw as never);
    const r = (await pool.query('SELECT live')) as { rows: unknown[] };
    expect(r.rows).toEqual([{ live: 1 }]);
    expect(raw.calls.length).toBe(1); // hit the real impl — no interception without ctx
  });
});

describe('db replay — recorded rowset model', () => {
  const source = sourceWithDbEvents([
    dbEvent(2, 'BEGIN'),
    dbEvent(3, 'SELECT * FROM items WHERE id=$1', { rows: [{ id: 1, name: 'widget' }], rowCount: 1, params: [1] }),
    dbEvent(4, 'COMMIT'),
    dbEvent(5, 'SELECT * FROM broken', { error: 'deadlock detected', errorName: 'DeadlockError' }),
  ]);

  it('serves recorded rows in order, synthesizing fields from row keys', async () => {
    const raw = new FakePool(() => ({ rows: [{ should: 'never' }] }));
    const pool = instrumentDb(raw as never);
    const ctx = makeCtx(mkState({}, source));
    await als.run(ctx, async () => {
      await pool.query('BEGIN');
      const res = (await pool.query('SELECT * FROM items WHERE id=$1', [1])) as { rows: Record<string, unknown>[]; fields: { name: string }[] };
      expect(res.rows).toEqual([{ id: 1, name: 'widget' }]);
      expect(res.fields.map((f) => f.name)).toEqual(['id', 'name']);
      await pool.query('COMMIT');
    });
    expect(raw.calls.length).toBe(0); // never touched a real queryable
    expect(ctx.events.filter((e) => e.kind === 'db.query').length).toBe(3);
  });

  it('recorded error replays as a rejection with the recorded error name', async () => {
    const raw = new FakePool(() => ({ rows: [] }));
    const pool = instrumentDb(raw as never);
    const ctx = makeCtx(mkState({}, source));
    await als.run(ctx, async () => {
      await pool.query('BEGIN');
      await pool.query('SELECT * FROM items WHERE id=$1', [1]);
      await pool.query('COMMIT');
      await expect(pool.query('SELECT * FROM broken')).rejects.toMatchObject({ name: 'DeadlockError', message: 'deadlock detected' });
    });
    expect(raw.calls.length).toBe(0);
    const evs = ctx.events.filter((e) => e.kind === 'db.query');
    expect(evs[3].status).toBe('error');
  });

  it('query text differing from the recorded sequence emits a replay.note', async () => {
    const raw = new FakePool(() => ({ rows: [] }));
    const pool = instrumentDb(raw as never);
    const ctx = makeCtx(mkState({}, source));
    await als.run(ctx, async () => {
      await pool.query('SELECT * FROM items WHERE id=$1', [1]); // skips the recorded BEGIN
    });
    const notes = ctx.events.filter((e) => e.kind === 'replay.note');
    expect(notes.length).toBeGreaterThan(0);
  });

  it('querying past the recorded sequence → honest empty result + note, not a crash', async () => {
    const raw = new FakePool(() => ({ rows: [] }));
    const pool = instrumentDb(raw as never);
    const ctx = makeCtx(mkState({}, source));
    await als.run(ctx, async () => {
      for (const q of ['BEGIN', 'SELECT * FROM items WHERE id=$1', 'COMMIT', 'SELECT * FROM broken']) {
        await pool.query(q).catch(() => {});
      }
      const res = (await pool.query('SELECT * FROM beyond')) as { rows: unknown[] };
      expect(res.rows).toEqual([]);
    });
    const notes = ctx.events.filter((e) => e.kind === 'replay.note');
    expect(notes.some((n) => (n.data as { message?: string }).message?.includes('no recorded result'))).toBe(true);
  });

  it('pool.connect() in replay returns a fake client — real pool never dialed', async () => {
    const raw = new FakePool(() => ({ rows: [{ real: true }] }));
    const pool = instrumentDb(raw as never);
    const ctx = makeCtx(mkState({}, source));
    await als.run(ctx, async () => {
      const client = (await pool.connect()) as FakeClient;
      await pool.query('BEGIN'); // consume BEGIN through the pool first? no — cursor shared
      const res = (await client.query('SELECT * FROM items WHERE id=$1', [1])) as { rows: unknown[] };
      expect(res.rows).toEqual([{ id: 1, name: 'widget' }]);
      client.release();
      await client.end();
    });
    expect(raw.connectCalls).toBe(0); // connect() never touched the real pool
    expect(raw.calls.length).toBe(0); // no real queries either
  });

  it('callback-style query in replay delivers recorded results', async () => {
    const raw = new FakePool(() => ({ rows: [] }));
    const pool = instrumentDb(raw as never);
    const ctx = makeCtx(mkState({}, source));
    await als.run(ctx, async () => {
      await new Promise<void>((res) => {
        (pool.connect as (cb: (e: unknown, c?: FakeClient) => void) => void)((_e, c) => {
          (c!.query as (...a: unknown[]) => void)('BEGIN', [], (_err: unknown) => {
            c!.release();
            res();
          });
        });
      });
    });
    expect(raw.calls.length).toBe(0);
  });
});
