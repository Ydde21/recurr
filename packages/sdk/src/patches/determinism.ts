import { createRequire } from 'node:module';
import { als, replayNote } from '../context.js';

/**
 * Nondeterminism handling.
 *
 * Capture mode: values are produced normally and recorded into ctx
 * (Math.random / crypto.randomUUID sequences; clock reads counted).
 * The global Date is a pass-through subclass — same values, plus counting.
 *
 * Replay mode: Math.random / crypto.randomUUID pop the captured sequences;
 * Date is shifted so wall time matches the original incident. When a captured
 * sequence is exhausted the fallback PRNG kicks in AND a divergence note is
 * emitted — never a silent fallthrough.
 */

let installed = false;
let replayOffsetMs = 0;
const RealDate = Date;

/** Called in replay mode so wall-clock reads mirror the original incident. */
export function setReplayOffset(wallStartMs: number): void {
  replayOffsetMs = wallStartMs - RealDate.now();
}

function uuidFromPrng(prng: () => number): string {
  const hex = () => Math.floor(prng() * 16).toString(16);
  let s = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += '-';
    else s += hex();
  }
  return `${s.slice(0, 14)}4${s.slice(15, 19)}${'89ab'[Math.floor(prng() * 4)]}${s.slice(20)}`;
}

/** Capture the original binding — a thunk that re-reads crypto.randomUUID
 *  at call time would recurse into our own patch. */
function globalUuidSource(): (() => string) | undefined {
  return globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
}

export function installDeterminism(): void {
  if (installed) return;
  installed = true;

  // -- Math.random -----------------------------------------------------------
  const origRandom = Math.random;
  Math.random = function random(): number {
    const ctx = als.getStore();
    if (!ctx || ctx.bookkeeping) return origRandom();
    if (ctx.mode === 'capture') {
      const v = origRandom();
      ctx.randomSeq.push(v);
      return v;
    }
    ctx.randomReads++;
    if (ctx.randomIdx < ctx.randomSeq.length) return ctx.randomSeq[ctx.randomIdx++];
    replayNote(ctx, 'Math.random consumed beyond captured sequence — PRNG fallback is deterministic but not original', undefined, 'random-exhausted');
    return ctx.prng();
  };

  // -- crypto.randomUUID -----------------------------------------------------
  const uuidWrapper = (orig: () => string) =>
    function randomUUID(): string {
      const ctx = als.getStore();
      if (!ctx || ctx.bookkeeping) return orig();
      if (ctx.mode === 'capture') {
        const v = orig();
        ctx.uuidSeq.push(v);
        return v;
      }
      ctx.uuidReads++;
      if (ctx.uuidIdx < ctx.uuidSeq.length) return ctx.uuidSeq[ctx.uuidIdx++];
      replayNote(ctx, 'crypto.randomUUID consumed beyond captured sequence — PRNG fallback is deterministic but not original', undefined, 'uuid-exhausted');
      return uuidFromPrng(ctx.prng);
    };

  // WebCrypto (global crypto.randomUUID) and the node:crypto module export —
  // separate bindings that both need patching. Named `import { randomUUID }`
  // still snapshots the original binding; that escape is documented.
  const globalUuid = globalUuidSource();
  if (globalUuid) {
    crypto.randomUUID = uuidWrapper(globalUuid) as typeof crypto.randomUUID;
  }

  // -- crypto.getRandomValues (WebCrypto) ------------------------------------
  // Not captured — at replay, fill from the record-seeded PRNG and emit a
  // divergence note rather than silently producing real entropy.
  const origGRV = crypto.getRandomValues?.bind(crypto);
  if (origGRV) {
    (crypto as { getRandomValues?: (a: Uint8Array) => Uint8Array }).getRandomValues = ((arr: Uint8Array) => {
      const ctx = als.getStore();
      if (ctx?.mode === 'replay' && !ctx.bookkeeping) {
        replayNote(ctx, 'crypto.getRandomValues used at replay — value is PRNG-derived, not the captured original', undefined, 'getRandomValues-unrecorded');
        const view = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
        for (let i = 0; i < view.length; i++) view[i] = Math.floor(ctx.prng() * 256);
        return arr;
      }
      return origGRV(arr as never) as never;
    }) as typeof crypto.getRandomValues;
  }

  try {
    const nodeCrypto = createRequire(import.meta.url)('node:crypto') as {
      randomUUID?: () => string;
      randomBytes?: (size: number, cb?: (err: Error | null, buf: Buffer) => void) => Buffer | void;
      randomInt?: (min: number, max?: number, cb?: (err: Error | null, n: number) => void) => number | void;
      randomFillSync?: (buf: Uint8Array, offset?: number, size?: number) => Uint8Array;
    };
    if (nodeCrypto.randomUUID) {
      nodeCrypto.randomUUID = uuidWrapper(nodeCrypto.randomUUID.bind(nodeCrypto)) as typeof nodeCrypto.randomUUID;
    }

    // randomBytes/randomInt/randomFillSync are NOT captured (call count and
    // byte entropy vary) — at replay they draw from the record-seeded PRNG and
    // emit a divergence note rather than silently producing real randomness.
    const origRandomBytes = nodeCrypto.randomBytes?.bind(nodeCrypto);
    const origRandomInt = nodeCrypto.randomInt?.bind(nodeCrypto);
    const origRandomFillSync = nodeCrypto.randomFillSync?.bind(nodeCrypto);
    const replayPrngBytes = (ctx: { prng: () => number }, n: number): Buffer => {
      const b = Buffer.alloc(n);
      for (let i = 0; i < n; i++) b[i] = Math.floor(ctx.prng() * 256);
      return b;
    };
    if (origRandomBytes) {
      nodeCrypto.randomBytes = ((size: number, cb?: (err: Error | null, buf: Buffer) => void) => {
        const ctx = als.getStore();
        if (ctx?.mode === 'replay' && !ctx.bookkeeping) {
          replayNote(ctx, 'crypto.randomBytes used at replay — value is PRNG-derived, not the captured original', undefined, 'randomBytes-unrecorded');
          const buf = replayPrngBytes(ctx, size);
          if (cb) queueMicrotask(() => cb(null, buf));
          else return buf;
          return undefined;
        }
        return origRandomBytes(size, cb as never);
      }) as typeof nodeCrypto.randomBytes;
    }
    if (origRandomInt) {
      nodeCrypto.randomInt = ((min: number, max?: number, cb?: (err: Error | null, n: number) => void) => {
        const ctx = als.getStore();
        if (ctx?.mode === 'replay' && !ctx.bookkeeping) {
          replayNote(ctx, 'crypto.randomInt used at replay — value is PRNG-derived, not the captured original', undefined, 'randomInt-unrecorded');
          const hi = typeof max === 'number' ? max : min;
          const lo = typeof max === 'number' ? min : 0;
          const n = lo + Math.floor(ctx.prng() * (hi - lo));
          if (cb) queueMicrotask(() => cb(null, n));
          else return n;
          return undefined;
        }
        return origRandomInt(min as never, max as never, cb as never);
      }) as typeof nodeCrypto.randomInt;
    }
    if (origRandomFillSync) {
      nodeCrypto.randomFillSync = ((buf: Uint8Array, offset = 0, size = buf.length - offset) => {
        const ctx = als.getStore();
        if (ctx?.mode === 'replay' && !ctx.bookkeeping) {
          replayNote(ctx, 'crypto.randomFillSync used at replay — value is PRNG-derived, not the captured original', undefined, 'randomFill-unrecorded');
          const fill = replayPrngBytes(ctx, size);
          buf.set(fill.subarray(0, size), offset);
          return buf;
        }
        return origRandomFillSync(buf, offset, size);
      }) as typeof nodeCrypto.randomFillSync;
    }
  } catch {
    /* createRequire unavailable — global crypto patch still applies */
  }

  // -- Date ------------------------------------------------------------------
  // One subclass for both modes: counts clock reads inside a ctx, returns real
  // values in capture, shifted values in replay. Applies process-wide so
  // timestamps outside a request context also mirror the incident timeline.
  class RecurrDate extends RealDate {
    constructor(...args: unknown[]) {
      const ctx = als.getStore();
      if (ctx && !ctx.bookkeeping) ctx.timeReads++;
      if (args.length === 0) super(RealDate.now() + replayOffsetMs);
      else super(...(args as []));
    }
    static override now(): number {
      const ctx = als.getStore();
      if (ctx && !ctx.bookkeeping) ctx.timeReads++;
      return RealDate.now() + replayOffsetMs;
    }
    // Dates created before the patch landed are plain Date instances —
    // `x instanceof Date` must still hold for them inside app code.
    static override [Symbol.hasInstance](x: unknown): boolean {
      return x instanceof RealDate;
    }
  }
  globalThis.Date = RecurrDate as unknown as DateConstructor;
}
