import { beforeAll, describe, expect, it } from 'vitest';
import { Redactor, type ExecutionRecord, type TimelineEvent } from '@recurr/core';
import { als, type RuntimeCtx } from '../src/context.js';
import { installDeterminism } from '../src/patches/determinism.js';
import { installHttpPatches } from '../src/patches/http.js';
import { instrumentDb, type Queryable } from '../src/patches/db.js';
import type { RecurrConfig } from '../src/config.js';

/**
 * Replay-path semantics, exercised in-process by running code inside a
 * hand-built replay ctx — no subprocess needed. The e2e suite covers the
 * real process boundary; these tests cover per-call behavior.
 */

beforeAll(() => {
  installDeterminism();
  installHttpPatches();
});

function mkCtx(mode: 'capture' | 'replay', source?: Partial<ExecutionRecord>): RuntimeCtx {
  return {
    mode,
    recordId: mode === 'replay' ? 'RPL-TESTX' : 'RUN-TESTX',
    startedMonoMs: performance.now(),
    startedWallMs: Date.now(),
    seq: 0,
    events: [],
    hadError: false,
    randomSeq: source ? [...(source.seed?.random ?? [])] : [],
    uuidSeq: source ? [...(source.seed?.uuids ?? [])] : [],
    randomIdx: 0,
    uuidIdx: 0,
    randomReads: 0,
    uuidReads: 0,
    timeReads: 0,
    prng: () => 0.777,
    replaySource: source as ExecutionRecord | undefined,
    dbCursor: 0,
    httpOutCursor: 0,
    pending: [],
    closed: false,
    flags: new Set(),
    redactionHits: [],
    truncatedPaths: [],
    config: { service: 'test' } as RecurrConfig,
    redactor: new Redactor(),
  };
}

const ev = (seq: number, kind: TimelineEvent['kind'], data: Record<string, unknown>): TimelineEvent => ({
  seq,
  at: '2026-01-01T00:00:00Z',
  offsetMs: seq,
  kind,
  data,
});

const notesOf = (ctx: RuntimeCtx) => ctx.events.filter((e) => e.kind === 'replay.note').map((e) => String((e.data as { message?: string }).message));

describe('replay-mode determinism', () => {
  it('Math.random replays captured values in order, then notes PRNG fallback', async () => {
    const ctx = mkCtx('replay', { seed: { startedAtWallMs: 0, random: [0.11, 0.22], uuids: [], prngSeed: 1 } });
    await als.run(ctx, async () => {
      expect(Math.random()).toBe(0.11);
      expect(Math.random()).toBe(0.22);
      const fallback = Math.random();
      expect(fallback).toBe(0.777); // ctx.prng — deterministic, but flagged
      expect(ctx.randomReads).toBe(3);
      expect(notesOf(ctx).some((m) => m.includes('Math.random consumed beyond'))).toBe(true);
      // Second over-read does NOT spam another note.
      Math.random();
      expect(notesOf(ctx).filter((m) => m.includes('Math.random')).length).toBe(1);
    });
  });

  it('crypto.randomUUID replays captured values, then notes fallback', async () => {
    const ctx = mkCtx('replay', {
      seed: { startedAtWallMs: 0, random: [], uuids: ['11111111-2222-4333-8444-555555555555'], prngSeed: 1 },
    });
    await als.run(ctx, async () => {
      expect(crypto.randomUUID()).toBe('11111111-2222-4333-8444-555555555555');
      const v = crypto.randomUUID();
      expect(v).toMatch(/^[0-9a-f-]{36}$/);
      expect(v).not.toBe('11111111-2222-4333-8444-555555555555');
      expect(notesOf(ctx).some((m) => m.includes('randomUUID consumed beyond'))).toBe(true);
    });
  });

  it('clock reads are counted (capture + replay)', async () => {
    const cap = mkCtx('capture');
    await als.run(cap, async () => {
      Date.now();
      Date.now();
      new Date();
      expect(cap.timeReads).toBe(3);
    });
    const rep = mkCtx('replay', { seed: { startedAtWallMs: 0, random: [], uuids: [], prngSeed: 1 } });
    await als.run(rep, async () => {
      Date.now();
      expect(rep.timeReads).toBe(1);
    });
  });

  it('capture mode records Math.random values actually returned', async () => {
    const ctx = mkCtx('capture');
    await als.run(ctx, async () => {
      const v1 = Math.random();
      const v2 = Math.random();
      expect(ctx.randomSeq).toEqual([v1, v2]);
    });
  });
});

describe('replay-mode fetch', () => {
  const source = {
    seed: { startedAtWallMs: 0, random: [], uuids: [], prngSeed: 1 },
    events: [
      ev(1, 'http.out', {
        method: 'GET',
        url: 'http://svc.internal/api',
        status: 418,
        responseHeaders: { 'content-type': 'application/json', 'x-upstream': 'yes' },
        responseBody: '{"ok":true}',
      }),
      ev(2, 'http.out', { method: 'POST', url: 'http://svc.internal/slow', errorKind: 'timeout', error: 'timed out' }),
    ],
  };

  it('synthesizes the recorded response without touching the network', async () => {
    const ctx = mkCtx('replay', source);
    await als.run(ctx, async () => {
      const res = await fetch('http://svc.internal/api');
      expect(res.status).toBe(418);
      expect(res.headers.get('x-upstream')).toBe('yes');
      expect(await res.json()).toEqual({ ok: true });
      const out = ctx.events.find((e) => e.kind === 'http.out');
      expect(out?.status).toBe('ok');
    });
  });

  it('replays recorded timeouts as TimeoutError', async () => {
    const ctx = mkCtx('replay', source);
    await als.run(ctx, async () => {
      // First call consumes the 418 event — matching is positional.
      await fetch('http://svc.internal/api');
      await expect(fetch('http://svc.internal/slow', { method: 'POST' })).rejects.toMatchObject({ name: 'TimeoutError' });
    });
  });

  it('unmatched calls fail loudly and emit a divergence note — never egress', async () => {
    const ctx = mkCtx('replay', { seed: { startedAtWallMs: 0, random: [], uuids: [], prngSeed: 1 }, events: [] });
    await als.run(ctx, async () => {
      await expect(fetch('http://nowhere.internal/x')).rejects.toThrow(/no recorded response/);
      expect(notesOf(ctx).some((m) => m.includes('no recorded response'))).toBe(true);
    });
  });

  it('notes divergence when the called URL differs from the recorded one', async () => {
    const ctx = mkCtx('replay', source);
    await als.run(ctx, async () => {
      // Different URL than the recorded first event → note + falls through to it.
      const res = await fetch('http://svc.internal/CHANGED');
      expect(res.status).toBe(418);
      expect(notesOf(ctx).some((m) => m.includes('differs from recorded'))).toBe(true);
    });
  });
});

describe('replay-mode db', () => {
  const source = {
    seed: { startedAtWallMs: 0, random: [], uuids: [], prngSeed: 1 },
    events: [
      ev(1, 'db.query', { system: 'postgres', text: 'SELECT * FROM users WHERE id = $1', params: [7], rowCount: 1, rows: [{ id: 7, name: 'ada' }] }),
      ev(2, 'db.query', { system: 'postgres', text: 'DELETE FROM sessions', error: 'deadlock detected', errorName: 'Error' }),
    ],
  };

  it('serves recorded rows for matching queries', async () => {
    const ctx = mkCtx('replay', source);
    const db = instrumentDb({ query: () => Promise.reject(new Error('must not be called')) } as unknown as Queryable);
    await als.run(ctx, async () => {
      const res = (await db.query('SELECT * FROM users WHERE id = $1', [7] as never)) as { rows: { name: string }[]; rowCount: number };
      expect(res.rows).toEqual([{ id: 7, name: 'ada' }]);
      expect(res.rowCount).toBe(1);
    });
  });

  it('replays recorded errors', async () => {
    const ctx = mkCtx('replay', source);
    const db = instrumentDb({ query: () => Promise.resolve({ rows: [] }) } as unknown as Queryable);
    await als.run(ctx, async () => {
      await db.query('SELECT * FROM users WHERE id = $1', [7] as never);
      await expect(db.query('DELETE FROM sessions' as never)).rejects.toThrow('deadlock detected');
    });
  });

  it('callback-style replay delivers the recorded result', async () => {
    const ctx = mkCtx('replay', source);
    const db = instrumentDb({ query: () => Promise.resolve({ rows: [] }) } as unknown as Queryable);
    await als.run(ctx, async () => {
      const res = await new Promise<{ rows: unknown[] }>((resolve, reject) =>
        db.query('SELECT * FROM users WHERE id = $1', [7] as never, ((err: unknown, r?: { rows: unknown[] }) => (err ? reject(err) : resolve(r!))) as never),
      );
      expect(res.rows).toEqual([{ id: 7, name: 'ada' }]);
    });
  });

  it('queries with no recorded result return empty rows + divergence note', async () => {
    const ctx = mkCtx('replay', { seed: { startedAtWallMs: 0, random: [], uuids: [], prngSeed: 1 }, events: [] });
    const db = instrumentDb({ query: () => Promise.resolve({ rows: [] }) } as unknown as Queryable);
    await als.run(ctx, async () => {
      const res = (await db.query('SELECT mystery' as never)) as { rows: unknown[] };
      expect(res.rows).toEqual([]);
      expect(notesOf(ctx).some((m) => m.includes('no recorded result'))).toBe(true);
    });
  });

  it('sql mismatch emits a note but still consumes the positional record', async () => {
    const ctx = mkCtx('replay', source);
    const db = instrumentDb({ query: () => Promise.resolve({ rows: [] }) } as unknown as Queryable);
    await als.run(ctx, async () => {
      await db.query('SELECT something_else' as never);
      expect(notesOf(ctx).some((m) => m.includes('differs from recorded'))).toBe(true);
    });
  });

  it('pool.connect() at replay returns a fake client — real pool never touched', async () => {
    const ctx = mkCtx('replay', source);
    let realConnects = 0;
    const pool = instrumentDb({
      query: () => Promise.resolve({ rows: [] }),
      connect: () => {
        realConnects++;
        return Promise.reject(new Error('real connect must not happen at replay'));
      },
    } as unknown as Queryable);
    await als.run(ctx, async () => {
      const client = (await (pool.connect as () => Promise<Queryable & { release(): void }>)()) as Queryable & { release(): void };
      const res = (await client.query('SELECT * FROM users WHERE id = $1', [7] as never)) as { rows: { name: string }[] };
      expect(res.rows[0].name).toBe('ada');
      client.release();
      expect(realConnects).toBe(0);
    });
  });
});
