import { mulberry32, seedFromString } from '@recurr/core';
import { als } from '../context.js';

/**
 * Determinism capture & replay.
 *
 * Capture: Math.random / crypto.randomUUID calls made inside an active
 * capture context have their outputs appended to the record's seed.
 *
 * Replay: the same calls consume the captured sequences in order. If a replay
 * consumes MORE values than the original produced (e.g. code changed), it
 * falls back to a deterministic PRNG seeded from the incident id — so replays
 * degrade gracefully instead of diverging randomly.
 *
 * Wall-clock: replay installs a shifted Date so Date.now()/new Date() track
 * the original incident's timeline (wallStart + real elapsed).
 */

const origRandom = Math.random.bind(Math);
const origRandomUUID = globalThis.crypto.randomUUID.bind(globalThis.crypto);
const RealDate = Date;

let installed = false;

export function installDeterminism(): void {
  if (installed) return;
  installed = true;

  Math.random = function random(): number {
    const ctx = als.getStore();
    if (!ctx) return origRandom();
    if (ctx.mode === 'capture') {
      const v = origRandom();
      ctx.randomSeq.push(v);
      return v;
    }
    if (ctx.randomIdx < ctx.randomSeq.length) return ctx.randomSeq[ctx.randomIdx++];
    return ctx.prng();
  };

  globalThis.crypto.randomUUID = function randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
    const ctx = als.getStore();
    if (!ctx) return origRandomUUID();
    if (ctx.mode === 'capture') {
      const v = origRandomUUID();
      ctx.uuidSeq.push(v);
      return v;
    }
    if (ctx.uuidIdx < ctx.uuidSeq.length) {
      return ctx.uuidSeq[ctx.uuidIdx++] as `${string}-${string}-${string}-${string}-${string}`;
    }
    return uuidFromPrng(ctx.prng);
  };
}

/** Replace Date with a wall-shifted variant for the whole replay process. */
export function installDateShift(wallStartMs: number): () => void {
  const offset = wallStartMs - RealDate.now();

  class ShiftedDate extends RealDate {
    constructor();
    constructor(value: number | string);
    constructor(y: number, m: number, d?: number, h?: number, min?: number, s?: number, ms?: number);
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...(args as [number]));
    }
    static now(): number {
      return RealDate.now() + offset;
    }
  }

  globalThis.Date = ShiftedDate as DateConstructor;
  return () => {
    globalThis.Date = RealDate;
  };
}

function uuidFromPrng(prng: () => number): `${string}-${string}-${string}-${string}-${string}` {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(prng() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // v4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as `${string}-${string}-${string}-${string}-${string}`;
}

export function prngFor(recordId: string): () => number {
  return mulberry32(seedFromString(recordId));
}
