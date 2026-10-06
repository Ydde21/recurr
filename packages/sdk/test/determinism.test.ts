import { describe, expect, it } from 'vitest';
import { createRedactor, type ExecutionRecord } from '@recurr-dev/core';
import { als } from '../src/context.js';
import { installDeterminism, setReplayOffset } from '../src/patches/determinism.js';
import { makeCtx, type RecurrState } from '../src/state.js';
import type { RecurrConfig } from '../src/config.js';
import nodeCrypto from 'node:crypto';

/**
 * Determinism suite — capture records sequences; replay consumes them in
 * order; exhaustion/under-consumption emit notes; crypto entropy APIs are
 * honest (PRNG-derived + flagged, never silently real); SDK bookkeeping
 * reads never pollute the recorded seed.
 */

installDeterminism();

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
    cfg: { service: 'det-test', capture: { on: 'always' }, ...cfg },
    mode: replaySource ? 'replay' : 'capture',
    replaySource,
    store: storeStub,
    redactor: createRedactor(),
    pending: new Set(),
    inflight: 0,
  } as RecurrState;
}

function sourceWithSeed(random: number[], uuids: string[]): ExecutionRecord {
  return {
    schemaVersion: 1,
    id: 'RUN-DETSRC',
    kind: 'incident',
    service: { name: 'src' },
    environment: { name: 'test' },
    capturedAt: '2026-01-01T00:00:00Z',
    trigger: { type: 'http' },
    seed: { startedAtWallMs: 1_700_000_000_000, random, uuids, prngSeed: 1 },
    events: [],
    redaction: { redactedPaths: [], truncatedPaths: [] },
  };
}

describe('nondeterminism — capture', () => {
  it('Math.random + crypto.randomUUID inside a ctx are recorded in order', async () => {
    const ctx = makeCtx(mkState());
    await als.run(ctx, async () => {
      const a = Math.random();
      const b = Math.random();
      const u = crypto.randomUUID();
      expect(ctx.randomSeq).toEqual([a, b]);
      expect(ctx.uuidSeq).toEqual([u]);
    });
  });

  it('reads outside a ctx are not recorded (and remain real)', () => {
    const before = Math.random();
    expect(typeof before).toBe('number');
    // no ctx → nothing to assert beyond: it didn't throw and didn't recurse.
  });
});

describe('nondeterminism — replay', () => {
  it('Math.random + randomUUID replay captured values in order', async () => {
    const source = sourceWithSeed([0.11, 0.22, 0.33], ['u-1', 'u-2']);
    const ctx = makeCtx(mkState({}, source));
    await als.run(ctx, async () => {
      expect(Math.random()).toBe(0.11);
      expect(Math.random()).toBe(0.22);
      expect(Math.random()).toBe(0.33);
      expect(crypto.randomUUID()).toBe('u-1');
      expect(crypto.randomUUID()).toBe('u-2');
    });
  });

  it('exhaustion → deterministic PRNG fallback + a replay.note (never silent)', async () => {
    const source = sourceWithSeed([0.5], []);
    const ctx = makeCtx(mkState({}, source));
    await als.run(ctx, async () => {
      expect(Math.random()).toBe(0.5); // captured
      const a = Math.random();
      const b = Math.random();
      // Fallback values are deterministic (record-seeded) but flagged.
      expect(a).not.toBe(0.5);
      expect(a).not.toBe(b);
    });
    const notes = ctx.events.filter((e) => e.kind === 'replay.note');
    expect(notes.some((n) => (n.data as { message?: string }).message?.includes('Math.random'))).toBe(true);
    expect(ctx.randomReads).toBe(3);
  });

  it('under-consumption is visible in seed counters for the diff to flag', async () => {
    const source = sourceWithSeed([0.1, 0.2, 0.3], ['u1']);
    const ctx = makeCtx(mkState({}, source));
    await als.run(ctx, async () => {
      Math.random(); // consumes 1 of 3
    });
    expect(ctx.randomReads).toBe(1); // diff sees consumed=1 vs captured=3
  });

  it('crypto.randomBytes at replay is deterministic + flagged, not real entropy', async () => {
    const ctx = makeCtx(mkState({}, sourceWithSeed([], [])));
    const other = makeCtx(mkState({}, sourceWithSeed([], [])));
    let a: Buffer = Buffer.alloc(0);
    let b: Buffer = Buffer.alloc(0);
    await als.run(ctx, async () => {
      a = nodeCrypto.randomBytes(16);
    });
    await als.run(other, async () => {
      b = nodeCrypto.randomBytes(16);
    });
    expect(a.equals(b)).toBe(true); // same record seed → same bytes
    const notes = ctx.events.filter((e) => e.kind === 'replay.note');
    expect(notes.some((n) => (n.data as { message?: string }).message?.includes('randomBytes'))).toBe(true);
  });

  it('crypto.randomInt + getRandomValues + randomFillSync are PRNG-derived at replay', async () => {
    const ctx = makeCtx(mkState({}, sourceWithSeed([], [])));
    await als.run(ctx, async () => {
      const n = nodeCrypto.randomInt(0, 1000);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1000);
      const buf = new Uint8Array(8);
      nodeCrypto.randomFillSync(buf);
      expect(buf.some((x) => x !== 0)).toBe(true);
      const arr = new Uint8Array(8);
      crypto.getRandomValues(arr);
      expect(arr.some((x) => x !== 0)).toBe(true);
      // callback form of randomBytes works too
      const b2 = await new Promise<Buffer>((res) => nodeCrypto.randomBytes(8, (_e, bb) => res(bb)));
      expect(b2.length).toBe(8);
    });
    const kinds = ctx.events.filter((e) => e.kind === 'replay.note').map((e) => (e.data as { message?: string }).message);
    expect(kinds.some((m) => m?.includes('randomInt'))).toBe(true);
    expect(kinds.some((m) => m?.includes('randomFillSync'))).toBe(true);
    expect(kinds.some((m) => m?.includes('getRandomValues'))).toBe(true);
  });

  it('entropy APIs still produce REAL entropy in capture mode', async () => {
    const ctx = makeCtx(mkState());
    await als.run(ctx, async () => {
      const a = nodeCrypto.randomBytes(16);
      const b = nodeCrypto.randomBytes(16);
      expect(a.equals(b)).toBe(false); // real randomness, not PRNG
    });
  });

  it('wall-clock reads are shifted to the incident time at replay', async () => {
    const wallStart = 1_700_000_000_000;
    setReplayOffset(wallStart);
    try {
      const ctx = makeCtx(mkState({}, sourceWithSeed([], [])));
      await als.run(ctx, async () => {
        const t = Date.now();
        // Shifted near wallStart (within a few seconds), not real now.
        expect(Math.abs(t - wallStart)).toBeLessThan(5000);
        const d = new Date();
        expect(Math.abs(d.getTime() - wallStart)).toBeLessThan(5000);
        expect(ctx.timeReads).toBe(2);
        // Fixed-date construction consumes no nondeterminism.
        new Date('2020-01-01T00:00:00Z');
        expect(ctx.timeReads).toBe(2);
      });
    } finally {
      setReplayOffset(Date.now());
    }
  });

  it('Date() call form still returns a string — legal JS must not throw', () => {
    const s = Date();
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThan(10);
  });

  it('new Date() instances remain instanceof Date across the patch', () => {
    const d = new Date();
    expect(d instanceof Date).toBe(true);
    expect(d.getTime()).toBeGreaterThan(0);
  });

  it('SDK bookkeeping reads do not count toward app nondeterminism', async () => {
    const ctx = makeCtx(mkState());
    await als.run(ctx, async () => {
      const before = ctx.timeReads;
      // pushEvent does internal Date work under ctx.bookkeeping.
      const { pushEvent } = await import('../src/context.js');
      pushEvent(ctx, 'custom', { name: 'x' });
      expect(ctx.timeReads).toBe(before);
    });
  });
});
