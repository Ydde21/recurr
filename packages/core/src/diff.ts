/**
 * Execution diff — compares an original incident record with a replay record
 * and reports where the replay diverged.
 *
 * Events are aligned by kind in order (executions are deterministic in
 * structure, so a two-pointer walk with a small resync window suffices).
 * Timing fields are excluded from equality and reported separately as drift.
 */

import type { DbQueryData, ExecutionRecord, HttpOutData, TimelineEvent } from './types.js';

export type DivergenceType =
  | 'missing-event'
  | 'extra-event'
  | 'field-mismatch'
  | 'response-status'
  | 'response-body'
  | 'error'
  | 'seed-usage';

export interface Divergence {
  type: DivergenceType;
  /** 'info' divergences are reported but don't lower the match score — e.g.
   *  infra-level clock reads that legitimately differ between a live capture
   *  and a replay with mocked dependencies. */
  severity?: 'info';
  /** Original-side seq when applicable. */
  seq?: number;
  kind?: string;
  /** Dotted field path inside the event/response. */
  path?: string;
  expected?: unknown;
  actual?: unknown;
  message: string;
}

export interface DiffStats {
  originalEvents: number;
  replayEvents: number;
  matched: number;
  missing: number;
  extra: number;
  eventsWithMismatch: number;
}

export interface DiffReport {
  incidentId: string;
  replayId: string;
  /** Same HTTP status and same error outcome — the replay reproduced the bug. */
  outcomeMatch: boolean;
  /** Status/error outcome differed — expected once a fix lands. */
  statusChanged: boolean;
  /** 0–100: fraction of aligned events with no field mismatches. */
  matchScore: number;
  divergences: Divergence[];
  stats: DiffStats;
  timing: { originalMs: number; replayMs: number; driftPct: number };
}

export interface DiffOptions {
  /** Max divergences collected. Default 100. */
  maxDivergences?: number;
  /** Resync window for event alignment. Default 6. */
  window?: number;
}

/** Fields that legitimately differ between runs — excluded from equality. */
const VOLATILE_KEYS = new Set(['at', 'offsetMs', 'durationMs', 'seq']);

const PREVIEW_LEN = 140;

function preview(v: unknown): unknown {
  if (typeof v === 'string' && v.length > PREVIEW_LEN) return v.slice(0, PREVIEW_LEN) + '…';
  if (v !== null && typeof v === 'object') {
    const s = safeStringify(v);
    if (s.length > PREVIEW_LEN) return s.slice(0, PREVIEW_LEN) + '…';
    return v;
  }
  return v;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function compareValues(
  path: string,
  expected: unknown,
  actual: unknown,
  out: Divergence[],
  kind: string,
  seq: number,
  depth: number,
): void {
  if (depth > 12) return;
  if (expected === actual) return;
  const eObj = expected !== null && typeof expected === 'object';
  const aObj = actual !== null && typeof actual === 'object';
  if (eObj && aObj) {
    const eArr = Array.isArray(expected);
    const aArr = Array.isArray(actual);
    if (eArr !== aArr) {
      out.push({ type: 'field-mismatch', seq, kind, path, expected: preview(expected), actual: preview(actual), message: `${path}: type mismatch` });
      return;
    }
    if (eArr && aArr) {
      const ea = expected as unknown[];
      const aa = actual as unknown[];
      const n = Math.max(ea.length, aa.length);
      if (ea.length !== aa.length) {
        out.push({ type: 'field-mismatch', seq, kind, path: `${path}.length`, expected: ea.length, actual: aa.length, message: `${path}: array length ${ea.length} → ${aa.length}` });
      }
      for (let i = 0; i < Math.min(ea.length, aa.length); i++) {
        compareValues(`${path}[${i}]`, ea[i], aa[i], out, kind, seq, depth + 1);
      }
      void n;
      return;
    }
    const eo = expected as Record<string, unknown>;
    const ao = actual as Record<string, unknown>;
    for (const key of new Set([...Object.keys(eo), ...Object.keys(ao)])) {
      if (VOLATILE_KEYS.has(key)) continue;
      compareValues(path ? `${path}.${key}` : key, eo[key], ao[key], out, kind, seq, depth + 1);
    }
    return;
  }
  out.push({
    type: 'field-mismatch',
    seq,
    kind,
    path,
    expected: preview(expected),
    actual: preview(actual),
    message: `${path}: ${safeStringify(preview(expected))} → ${safeStringify(preview(actual))}`,
  });
}

/** Semantic comparison for one aligned event pair. */
function compareEvent(a: TimelineEvent, b: TimelineEvent, out: Divergence[]): void {
  if (a.name !== b.name) {
    out.push({ type: 'field-mismatch', seq: a.seq, kind: a.kind, path: 'name', expected: a.name, actual: b.name, message: `event name ${a.name} → ${b.name}` });
  }
  if (a.status !== b.status && a.status !== undefined && b.status !== undefined) {
    out.push({ type: 'field-mismatch', seq: a.seq, kind: a.kind, path: 'status', expected: a.status, actual: b.status, message: `event status ${a.status} → ${b.status}` });
  }
  compareValues('data', a.data ?? {}, b.data ?? {}, out, a.kind, a.seq, 0);
}

function indexOfKind(list: TimelineEvent[], kind: string, from: number, window: number): number {
  for (let k = from; k < Math.min(list.length, from + window); k++) {
    if (list[k].kind === kind) return k;
  }
  return -1;
}

function eventSummary(e: TimelineEvent): string {
  return `${e.kind}${e.name ? ` ${e.name}` : ''}`;
}

function summarizeError(e: { name: string; message: string } | undefined): string | null {
  return e ? `${e.name}: ${e.message}` : null;
}

export function diffExecutions(original: ExecutionRecord, replay: ExecutionRecord, opts: DiffOptions = {}): DiffReport {
  const maxDivergences = opts.maxDivergences ?? 100;
  const window = opts.window ?? 6;
  const divergences: Divergence[] = [];
  const push = (d: Divergence) => {
    if (divergences.length < maxDivergences) divergences.push(d);
  };

  const a = original.events;
  const b = replay.events;

  let matched = 0;
  let missing = 0;
  let extra = 0;
  const mismatchSeqs = new Set<number>();

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].kind === b[j].kind) {
      const before = divergences.length;
      compareEvent(a[i], b[j], divergences);
      if (divergences.length > before) mismatchSeqs.add(a[i].seq);
      i++;
      j++;
      matched++;
      continue;
    }
    const jNext = indexOfKind(b, a[i].kind, j + 1, window);
    const iNext = indexOfKind(a, b[j].kind, i + 1, window);
    if (jNext === -1 && iNext === -1) {
      push({ type: 'missing-event', seq: a[i].seq, kind: a[i].kind, expected: eventSummary(a[i]), message: `missing: ${eventSummary(a[i])}` });
      push({ type: 'extra-event', kind: b[j].kind, actual: eventSummary(b[j]), message: `extra: ${eventSummary(b[j])}` });
      missing++;
      extra++;
      i++;
      j++;
    } else if (iNext !== -1 && (jNext === -1 || iNext - i <= jNext - j)) {
      push({ type: 'missing-event', seq: a[i].seq, kind: a[i].kind, expected: eventSummary(a[i]), message: `missing: ${eventSummary(a[i])}` });
      missing++;
      i++;
    } else {
      push({ type: 'extra-event', kind: b[j].kind, actual: eventSummary(b[j]), message: `extra: ${eventSummary(b[j])}` });
      extra++;
      j++;
    }
  }
  while (i < a.length) {
    push({ type: 'missing-event', seq: a[i].seq, kind: a[i].kind, expected: eventSummary(a[i]), message: `missing: ${eventSummary(a[i])}` });
    missing++;
    i++;
  }
  while (j < b.length) {
    push({ type: 'extra-event', kind: b[j].kind, actual: eventSummary(b[j]), message: `extra: ${eventSummary(b[j])}` });
    extra++;
    j++;
  }

  // Response comparison
  const os = original.response?.status;
  const rs = replay.response?.status;
  if (os !== rs) {
    push({ type: 'response-status', expected: os, actual: rs, message: `response status ${os} → ${rs}` });
  }
  if (original.response?.body !== undefined || replay.response?.body !== undefined) {
    const before = divergences.length;
    compareValues('response.body', tryJson(original.response?.body), tryJson(replay.response?.body), divergences, 'response', -1, 0);
    if (divergences.length === before && normalizeBody(original.response?.body) !== normalizeBody(replay.response?.body)) {
      push({ type: 'response-body', expected: preview(original.response?.body), actual: preview(replay.response?.body), message: 'response body differs' });
    }
  }

  // Error comparison
  const oe = original.error;
  const re = replay.error;
  if (summarizeError(oe) !== summarizeError(re)) {
    push({ type: 'error', expected: summarizeError(oe), actual: summarizeError(re), message: `error ${summarizeError(oe) ?? 'none'} → ${summarizeError(re) ?? 'none'}` });
  }

  // Nondeterminism usage — under/over-consumption means the replay's code
  // path diverged from the original even if events happened to align.
  const seedDiffs: Array<[string, number, number, boolean]> = [
    ['random', original.seed.random.length, replay.seed.randomConsumed ?? replay.seed.random.length, false],
    ['uuid', original.seed.uuids.length, replay.seed.uuidConsumed ?? replay.seed.uuids.length, false],
    // Clock-read counts differ legitimately between live deps and mocked deps —
    // reported for visibility but not scored.
    ['clock-reads', original.seed.timeReads ?? -1, replay.seed.timeReads ?? -1, true],
  ];
  for (const [label, expected, actual, info] of seedDiffs) {
    if (expected >= 0 && actual >= 0 && expected !== actual) {
      push({
        type: 'seed-usage',
        severity: info ? 'info' : undefined,
        path: `seed.${label}`,
        expected,
        actual,
        message: `${label} consumed ${actual} — original captured ${expected}`,
      });
    }
  }

  // Enforce the divergence cap after all comparisons.
  if (divergences.length > maxDivergences) divergences.length = maxDivergences;

  // Seed/nondeterminism divergences weigh against the score just like event
  // mismatches — a replay that consumed a different amount of nondeterminism
  // took a different code path and must not score as a clean match.
  // Score = clean aligned fraction of max(|a|,|b|); an empty-vs-empty record
  // pair with no divergences is a genuine 100.
  const seedDivergences = divergences.filter((d) => d.type === 'seed-usage' && d.severity !== 'info').length;
  const total = Math.max(a.length, b.length, 1);
  const clean = total - missing - extra - mismatchSeqs.size - seedDivergences;
  const matchScore = Math.max(0, Math.min(100, Math.round((clean / total) * 100)));

  const originalMs = original.response?.durationMs ?? lastOffset(original);
  const replayMs = replay.response?.durationMs ?? lastOffset(replay);
  const driftPct = originalMs > 0 ? Math.round(((replayMs - originalMs) / originalMs) * 1000) / 10 : 0;

  return {
    incidentId: original.id,
    replayId: replay.id,
    outcomeMatch: os === rs && (oe === undefined) === (re === undefined) && oe?.name === re?.name,
    statusChanged: os !== rs || (oe === undefined) !== (re === undefined),
    matchScore,
    divergences,
    stats: {
      originalEvents: a.length,
      replayEvents: b.length,
      matched,
      missing,
      extra,
      eventsWithMismatch: mismatchSeqs.size,
    },
    timing: { originalMs, replayMs, driftPct },
  };
}

function lastOffset(r: ExecutionRecord): number {
  return r.events.length ? r.events[r.events.length - 1].offsetMs : 0;
}

function tryJson(body: string | undefined): unknown {
  if (body === undefined) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function normalizeBody(body: string | undefined): string {
  if (body === undefined) return '';
  try {
    return JSON.stringify(JSON.parse(body));
  } catch {
    return body;
  }
}
