import { describe, expect, it } from 'vitest';
import { diffExecutions } from '../src/diff.js';
import type { ExecutionRecord, TimelineEvent } from '../src/types.js';

/**
 * Diff fidelity — the report must never claim a clean match when behavior
 * differed, and must distinguish informational drift from real divergence.
 */

function ev(seq: number, kind: TimelineEvent['kind'], name: string, data?: Record<string, unknown>, status?: 'ok' | 'error'): TimelineEvent {
  return { seq, at: '2026-10-06T14:32:04.000Z', offsetMs: seq * 10, kind, name, data, status };
}

function record(over: Partial<ExecutionRecord>): ExecutionRecord {
  return {
    schemaVersion: 1,
    id: over.id ?? 'RUN-AAAAA',
    kind: 'incident',
    service: { name: 'svc', runtime: 'node v26' },
    environment: { name: 'test' },
    capturedAt: '2026-10-06T14:32:08.000Z',
    trigger: { type: 'http' },
    seed: { startedAtWallMs: 0, random: [], uuids: [], prngSeed: 1 },
    events: [],
    redaction: { redactedPaths: [], truncatedPaths: [] },
    ...over,
  } as ExecutionRecord;
}

const base = record({
  id: 'RUN-AAAAA',
  request: { method: 'POST', url: '/api/orders', path: '/api/orders', headers: {} },
  response: { status: 500, headers: {}, body: '{"error":"PaymentTimeout","code":"P13"}', durationMs: 800 },
  error: { name: 'PaymentTimeout', message: 'payment did not confirm' },
  events: [
    ev(1, 'http.in', 'POST /api/orders'),
    ev(2, 'db.query', 'postgres SELECT', { system: 'postgres', text: 'SELECT 1', rows: [{ a: 1 }] }),
    ev(3, 'custom', 'timing-op', { durationMs: 42, note: 'inner timing is app data' }),
    ev(4, 'http.out', 'POST payment', { method: 'POST', url: 'http://p/charge', errorKind: 'timeout' }, 'error'),
    ev(5, 'error', 'PaymentTimeout', { message: 'payment did not confirm' }, 'error'),
  ],
});

const asReplay = (id: string, over: Partial<ExecutionRecord> = {}) =>
  record({ ...base, id, kind: 'replay', replayOf: base.id, ...over });

describe('diffExecutions — fidelity guarantees', () => {
  it('identical replay → 100, zero divergences', () => {
    const report = diffExecutions(base, asReplay('RPL-1'));
    expect(report.matchScore).toBe(100);
    expect(report.divergences).toHaveLength(0);
    expect(report.outcomeMatch).toBe(true);
  });

  it('app data fields named like timing fields are NOT skipped — a real divergence inside data must surface', () => {
    // Regression: volatile-name keys inside `data` used to be skipped, hiding
    // real mismatches (e.g. a custom event recording its own durationMs).
    const events = base.events.map((e) => ({ ...e }));
    events[2] = { ...events[2], data: { durationMs: 9999, note: 'inner timing is app data' } };
    const report = diffExecutions(base, asReplay('RPL-2', { events }));
    expect(report.divergences.some((d) => d.type === 'field-mismatch' && d.path === 'data.durationMs')).toBe(true);
    expect(report.matchScore).toBeLessThan(100);
  });

  it('response body JSON key order differences do NOT diverge', () => {
    const replay = asReplay('RPL-3', {
      response: { status: 500, headers: {}, body: '{"code":"P13","error":"PaymentTimeout"}', durationMs: 800 },
    });
    const report = diffExecutions(base, replay);
    expect(report.matchScore).toBe(100);
    expect(report.outcomeMatch).toBe(true);
  });

  it('response body semantic change → field-mismatch, never a silent pass', () => {
    const replay = asReplay('RPL-4', {
      response: { status: 500, headers: {}, body: '{"error":"PaymentTimeout","code":"P99"}', durationMs: 800 },
    });
    const report = diffExecutions(base, replay);
    expect(report.divergences.some((d) => d.type === 'field-mismatch')).toBe(true);
    expect(report.outcomeMatch).toBe(true); // same status + same error → outcome reproduced
    expect(report.matchScore).toBeLessThan(100);
  });

  it('reordered same-kind events align positionally; reordered different-kind events diverge', () => {
    // Swap custom and http.out — the kind sequence changes.
    const events = [base.events[0], base.events[1], base.events[3], base.events[2], base.events[4]];
    const report = diffExecutions(base, asReplay('RPL-5', { events }));
    expect(report.stats.missing + report.stats.extra + report.stats.eventsWithMismatch).toBeGreaterThan(0);
    expect(report.matchScore).toBeLessThan(100);
  });

  it('seed exhaustion (replay consumed MORE than captured) is flagged', () => {
    const withSeed = {
      ...base,
      seed: { startedAtWallMs: 0, random: [0.1, 0.2], uuids: [], prngSeed: 1 },
    };
    const replay = record({
      ...withSeed,
      id: 'RPL-6',
      kind: 'replay',
      replayOf: base.id,
      seed: { startedAtWallMs: 0, random: [0.1, 0.2], uuids: [], prngSeed: 1, randomConsumed: 5, uuidConsumed: 0 },
    });
    const report = diffExecutions(withSeed, replay);
    expect(report.divergences.some((d) => d.type === 'seed-usage' && d.path === 'seed.random')).toBe(true);
    expect(report.matchScore).toBeLessThan(100);
  });

  it('exact seed consumption → no seed divergence', () => {
    const withSeed = {
      ...base,
      seed: { startedAtWallMs: 0, random: [0.1, 0.2], uuids: ['u1'], prngSeed: 1 },
    };
    const replay = record({
      ...withSeed,
      id: 'RPL-7',
      kind: 'replay',
      replayOf: base.id,
      seed: { startedAtWallMs: 0, random: [0.1, 0.2], uuids: ['u1'], prngSeed: 1, randomConsumed: 2, uuidConsumed: 1 },
    });
    const report = diffExecutions(withSeed, replay);
    expect(report.divergences.filter((d) => d.type === 'seed-usage')).toHaveLength(0);
  });

  it('clock-read drift is informational — reported but not scored', () => {
    const withSeed = {
      ...base,
      seed: { startedAtWallMs: 0, random: [], uuids: [], prngSeed: 1, timeReads: 10 },
    };
    const replay = record({
      ...withSeed,
      id: 'RPL-8',
      kind: 'replay',
      replayOf: base.id,
      seed: { startedAtWallMs: 0, random: [], uuids: [], prngSeed: 1, timeReads: 3 },
    });
    const report = diffExecutions(withSeed, replay);
    const clock = report.divergences.filter((d) => d.path === 'seed.clock-reads');
    expect(clock.length).toBe(1);
    expect(clock[0].severity).toBe('info');
    expect(report.matchScore).toBe(100); // informational must not lower score
  });

  it('db-result mismatch (different rows) is a scored divergence', () => {
    const events = base.events.map((e) => ({ ...e }));
    events[1] = { ...events[1], data: { system: 'postgres', text: 'SELECT 1', rows: [{ a: 2 }] } };
    const report = diffExecutions(base, asReplay('RPL-9', { events }));
    expect(report.divergences.some((d) => d.type === 'field-mismatch' && d.kind === 'db.query')).toBe(true);
    expect(report.matchScore).toBeLessThan(100);
  });

  it('external-response mismatch (http.out status) is a scored divergence', () => {
    const events = base.events.map((e) => ({ ...e }));
    events[3] = { ...events[3], status: 'ok', data: { method: 'POST', url: 'http://p/charge', status: 200 } };
    const report = diffExecutions(base, asReplay('RPL-10', { events }));
    expect(report.divergences.some((d) => d.type === 'field-mismatch' && d.kind === 'http.out')).toBe(true);
    expect(report.matchScore).toBeLessThan(100);
  });

  it('empty-vs-empty event lists → genuine 100 (no phantom divergences)', () => {
    const empty = record({ id: 'RUN-EMPTY1', events: [], response: { status: 200, headers: {}, durationMs: 1 } });
    const replay = record({ ...empty, id: 'RPL-E1', kind: 'replay', replayOf: 'RUN-EMPTY1' });
    const report = diffExecutions(empty, replay);
    expect(report.matchScore).toBe(100);
    expect(report.divergences).toHaveLength(0);
  });

  it('missing trailing events are all reported, even past alignment window', () => {
    const replay = asReplay('RPL-11', { events: base.events.slice(0, 2) });
    const report = diffExecutions(base, replay);
    expect(report.stats.missing).toBe(3);
    expect(report.divergences.filter((d) => d.type === 'missing-event').length).toBe(3);
    expect(report.matchScore).toBeLessThan(100);
  });

  it('divergence cap bounds output but stats stay honest', () => {
    const many = Array.from({ length: 60 }, (_, i) => ev(i + 1, 'custom', `op-${i}`, { i }));
    const orig = record({ ...base, events: many });
    const replay = record({ ...base, id: 'RPL-12', kind: 'replay', replayOf: base.id, events: [] });
    const report = diffExecutions(orig, replay, { maxDivergences: 10 });
    expect(report.divergences.length).toBeLessThanOrEqual(10);
    expect(report.stats.missing).toBe(60); // stats count everything, cap or not
    expect(report.matchScore).toBe(0);
  });

  it('error present in original but absent in replay → outcome changed', () => {
    const replay = asReplay('RPL-13', { error: undefined });
    const report = diffExecutions(base, replay);
    expect(report.outcomeMatch).toBe(false);
    expect(report.statusChanged).toBe(true);
    expect(report.divergences.some((d) => d.type === 'error')).toBe(true);
  });
});
