import { describe, expect, it } from 'vitest';
import { isSafeRecordId, validateRecord } from '../src/validate.js';
import type { ExecutionRecord } from '../src/types.js';

function rec(over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    schemaVersion: 1,
    id: 'RUN-VALID1',
    kind: 'incident',
    service: { name: 'svc', runtime: 'node v26' },
    environment: { name: 'test' },
    capturedAt: '2026-10-06T14:32:08.000Z',
    trigger: { type: 'http' },
    request: { method: 'POST', url: '/x', path: '/x', headers: {} },
    response: { status: 500, headers: {}, durationMs: 1 },
    seed: { startedAtWallMs: 0, random: [], uuids: [], prngSeed: 0 },
    events: [],
    redaction: { redactedPaths: [], truncatedPaths: [] },
    ...over,
  } as ExecutionRecord;
}

describe('validateRecord', () => {
  it('accepts a valid incident record', () => {
    expect(validateRecord(rec()).ok).toBe(true);
  });

  it('accepts a valid replay record', () => {
    expect(validateRecord(rec({ id: 'RPL-ABC12', kind: 'replay', replayOf: 'RUN-VALID1' })).ok).toBe(true);
  });

  it('rejects non-objects and null', () => {
    expect(validateRecord(null).ok).toBe(false);
    expect(validateRecord('x').ok).toBe(false);
    expect(validateRecord(42).ok).toBe(false);
  });

  it('rejects bad schemaVersion', () => {
    expect(validateRecord(rec({ schemaVersion: 2 })).ok).toBe(false);
  });

  it('rejects path-traversal ids', () => {
    expect(validateRecord(rec({ id: '../../../etc/passwd' })).ok).toBe(false);
    expect(validateRecord(rec({ id: 'a/b' })).ok).toBe(false);
    expect(validateRecord(rec({ id: '..\\win' })).ok).toBe(false);
  });

  it('rejects malformed shapes', () => {
    expect(validateRecord(rec({ kind: 'bogus' as never })).ok).toBe(false);
    expect(validateRecord(rec({ events: 'nope' as never })).ok).toBe(false);
    expect(validateRecord(rec({ seed: null as never })).ok).toBe(false);
    expect(validateRecord(rec({ service: { name: '' } as never })).ok).toBe(false);
    expect(validateRecord(rec({ capturedAt: 'not-a-date' })).ok).toBe(false);
  });

  it('rejects hostile event entries', () => {
    const base = { seq: 1, at: '2026-01-01T00:00:00Z', offsetMs: 0, kind: 'custom' };
    expect(validateRecord(rec({ events: [{ ...base, seq: Number.NaN }] })).ok).toBe(false);
    expect(validateRecord(rec({ events: [{ ...base, seq: Infinity }] })).ok).toBe(false);
    expect(validateRecord(rec({ events: [{ ...base, kind: 'exec.shell' }] })).ok).toBe(false);
    expect(validateRecord(rec({ events: [null] })).ok).toBe(false);
    expect(validateRecord(rec({ events: ['custom'] })).ok).toBe(false);
  });

  it('rejects hostile seed payloads', () => {
    // Elements are replayed verbatim — a string here would inject into app arithmetic.
    expect(
      validateRecord(rec({ seed: { startedAtWallMs: 0, random: ['0.5' as never], uuids: [], prngSeed: 0 } })).ok,
    ).toBe(false);
    expect(
      validateRecord(rec({ seed: { startedAtWallMs: 0, random: [Number.NaN], uuids: [], prngSeed: 0 } })).ok,
    ).toBe(false);
    expect(
      validateRecord(rec({ seed: { startedAtWallMs: 0, random: [], uuids: [42 as never], prngSeed: 0 } })).ok,
    ).toBe(false);
    expect(
      validateRecord(rec({ seed: { startedAtWallMs: Number.NaN, random: [], uuids: [], prngSeed: 0 } })).ok,
    ).toBe(false);
  });

  it('rejects oversized event arrays (bounded work on hostile records)', () => {
    const huge = Array.from({ length: 100_001 }, (_, i) => ({ seq: i, at: 'x', offsetMs: i, kind: 'custom' }));
    const v = validateRecord(rec({ events: huge }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/events exceeds cap/);
  });

  it('rejects malformed request/response blocks', () => {
    expect(validateRecord(rec({ request: { method: 42, url: '/x', headers: {} } as never })).ok).toBe(false);
    expect(validateRecord(rec({ request: { method: 'GET', url: '/x', headers: 'bogus' } as never })).ok).toBe(false);
    expect(validateRecord(rec({ response: { status: 500.5 } as never })).ok).toBe(false);
    expect(validateRecord(rec({ response: { status: 'ok' } as never })).ok).toBe(false);
  });

  it('rejects a replay pointing at a traversal id', () => {
    expect(validateRecord(rec({ kind: 'replay', replayOf: '../escape' })).ok).toBe(false);
  });
});

describe('isSafeRecordId', () => {
  it('accepts normal ids', () => {
    for (const id of ['RUN-ABC123', 'RPL-X9', 'REG-FOO_BAR', 'a.b-c_d']) {
      expect(isSafeRecordId(id)).toBe(true);
    }
  });
  it('rejects traversal and weird input', () => {
    for (const id of ['../x', 'a/b', 'a\\b', 'x;y', 'x y', '', 1, null, {}, 'a'.repeat(200)]) {
      expect(isSafeRecordId(id)).toBe(false);
    }
  });
});
