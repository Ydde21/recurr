import { describe, expect, it } from 'vitest';
import { diffExecutions } from '../src/diff.js';
import type { ExecutionRecord, TimelineEvent } from '../src/types.js';

function ev(seq: number, kind: TimelineEvent['kind'], name: string, data?: Record<string, unknown>, status?: 'ok' | 'error'): TimelineEvent {
  return { seq, at: '2026-10-06T14:32:04.000Z', offsetMs: seq * 10, kind, name, data, status };
}

function record(over: Partial<ExecutionRecord>): ExecutionRecord {
  return {
    schemaVersion: 1,
    id: over.id ?? 'RUN-AAAAA',
    kind: 'incident',
    service: { name: 'checkout-api', runtime: 'node v26' },
    environment: { name: 'production' },
    capturedAt: '2026-10-06T14:32:08.000Z',
    trigger: { type: 'http' },
    seed: { startedAtWallMs: 0, random: [], uuids: [], prngSeed: 1 },
    events: [],
    redaction: { redactedPaths: [], truncatedPaths: [] },
    ...over,
  } as ExecutionRecord;
}

describe('diffExecutions', () => {
  const base = record({
    id: 'RUN-AAAAA',
    request: { method: 'POST', url: '/api/orders', path: '/api/orders', headers: {} },
    response: { status: 500, headers: {}, body: '{"error":"PaymentConfirmationTimeout"}', durationMs: 8400 },
    error: { name: 'PaymentConfirmationTimeout', message: 'payment did not confirm' },
    events: [
      ev(1, 'http.in', 'POST /api/orders'),
      ev(2, 'db.query', 'postgres SELECT', { system: 'postgres', text: 'SELECT 1', rowCount: 1, rows: [{ a: 1 }] }),
      ev(3, 'http.out', 'POST payment:4781', { method: 'POST', url: 'http://p/charge', errorKind: 'timeout', error: 'timeout' }, 'error'),
      ev(4, 'error', 'PaymentConfirmationTimeout', { message: 'payment did not confirm' }, 'error'),
    ],
  });

  /** Clone the base incident into a replay record, overriding fields. */
  const asReplay = (id: string, over: Partial<ExecutionRecord> = {}) =>
    record({ ...base, id, kind: 'replay', replayOf: base.id, ...over });

  it('identical replay → 100% match, outcomeMatch', () => {
    const replay = asReplay('RPL-00001');
    const report = diffExecutions(base, replay);
    expect(report.outcomeMatch).toBe(true);
    expect(report.matchScore).toBe(100);
    expect(report.divergences).toHaveLength(0);
  });

  it('detects a fixed bug via response status + error change', () => {
    const replay = asReplay('RPL-00002', {
      response: { status: 202, headers: {}, body: '{"status":"pending_payment"}', durationMs: 40 },
      error: undefined,
    });
    const report = diffExecutions(base, replay);
    expect(report.outcomeMatch).toBe(false);
    expect(report.statusChanged).toBe(true);
    expect(report.divergences.some((d) => d.type === 'response-status')).toBe(true);
    expect(report.divergences.some((d) => d.type === 'error')).toBe(true);
  });

  it('flags missing and extra events', () => {
    const replay = asReplay('RPL-00003', {
      events: [
        ev(1, 'http.in', 'POST /api/orders'),
        // db.query missing
        ev(3, 'http.out', 'POST payment:4781', { method: 'POST', url: 'http://p/charge', errorKind: 'timeout', error: 'timeout' }, 'error'),
        ev(4, 'error', 'PaymentConfirmationTimeout', { message: 'payment did not confirm' }, 'error'),
        ev(5, 'custom', 'unexpected-work', { x: 1 }),
      ],
    });
    const report = diffExecutions(base, replay);
    expect(report.stats.missing).toBe(1);
    expect(report.stats.extra).toBe(1);
    expect(report.matchScore).toBeLessThan(100);
  });

  it('flags field mismatches inside aligned events', () => {
    const events = base.events.map((e) => ({ ...e }));
    events[1] = { ...events[1], data: { system: 'postgres', text: 'SELECT 2', rowCount: 0 } };
    const replay = asReplay('RPL-00004', { events });
    const report = diffExecutions(base, replay);
    expect(report.stats.eventsWithMismatch).toBe(1);
    expect(report.divergences.some((d) => d.type === 'field-mismatch' && d.path?.includes('text'))).toBe(true);
  });

  it('ignores timing differences — drift is reported, not a divergence', () => {
    const replay = asReplay('RPL-00005', {
      response: { status: 500, headers: {}, body: '{"error":"PaymentConfirmationTimeout"}', durationMs: 42 },
      events: base.events.map((e) => ({ ...e, offsetMs: e.offsetMs / 100, durationMs: 1 })),
    });
    const report = diffExecutions(base, replay);
    expect(report.matchScore).toBe(100);
    expect(report.timing.originalMs).toBe(8400);
    expect(report.timing.replayMs).toBe(42);
  });
});
