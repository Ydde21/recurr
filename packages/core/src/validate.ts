import { SCHEMA_VERSION, type ExecutionRecord } from './types.js';

/** ids are used as file names — keep them strict. First char must be
 *  alphanumeric so '.', '..' and dotfile-style names can't slip through. */
export const RECORD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Sanity bounds — a record beyond these is corrupt or hostile, not a real
 *  capture. */
export const MAX_EVENTS = 100_000;
export const MAX_SEED_VALUES = 1_000_000;

export function isSafeRecordId(id: unknown): id is string {
  return typeof id === 'string' && RECORD_ID_PATTERN.test(id);
}

export interface ValidationOk {
  ok: true;
  record: ExecutionRecord;
}
export interface ValidationFail {
  ok: false;
  error: string;
}

/**
 * Validate an untrusted ExecutionRecord (import files, collector ingest,
 * records loaded from a shared store). Structural, not semantic — checks the
 * fields the system depends on, plus sanity bounds that keep hostile
 * payloads from exhausting memory/CPU downstream.
 */
export function validateRecord(input: unknown): ValidationOk | ValidationFail {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'record is not an object' };
  const r = input as Record<string, unknown>;

  if (r.schemaVersion !== SCHEMA_VERSION) return { ok: false, error: `schemaVersion must be ${SCHEMA_VERSION}` };
  if (!isSafeRecordId(r.id)) return { ok: false, error: `id must match ${RECORD_ID_PATTERN}` };
  if (r.kind !== 'incident' && r.kind !== 'replay') return { ok: false, error: `kind must be 'incident' or 'replay'` };
  if (r.replayOf !== undefined && !isSafeRecordId(r.replayOf)) return { ok: false, error: 'invalid replayOf' };

  const svc = r.service as Record<string, unknown> | undefined;
  if (!svc || typeof svc.name !== 'string' || !svc.name) return { ok: false, error: 'service.name required' };

  if (typeof r.capturedAt !== 'string' || Number.isNaN(Date.parse(r.capturedAt))) {
    return { ok: false, error: 'capturedAt must be an ISO timestamp' };
  }
  if (!Array.isArray(r.events)) return { ok: false, error: 'events must be an array' };
  if (r.events.length > MAX_EVENTS) return { ok: false, error: `events exceeds cap (${r.events.length} > ${MAX_EVENTS})` };
  const KINDS = new Set(['http.in', 'db.query', 'http.out', 'error', 'retry', 'log', 'custom', 'replay.note']);
  for (let i = 0; i < r.events.length; i++) {
    const e = r.events[i] as Record<string, unknown>;
    if (typeof e !== 'object' || e === null || typeof e.seq !== 'number' || !Number.isFinite(e.seq) || typeof e.kind !== 'string') {
      return { ok: false, error: `events[${i}] malformed` };
    }
    if (!KINDS.has(e.kind)) return { ok: false, error: `events[${i}] unknown kind '${e.kind}'` };
  }
  if (!r.seed || typeof r.seed !== 'object') return { ok: false, error: 'seed required' };
  const seed = r.seed as Record<string, unknown>;
  if (!Array.isArray(seed.random) || !Array.isArray(seed.uuids) || typeof seed.startedAtWallMs !== 'number') {
    return { ok: false, error: 'seed malformed' };
  }
  if (seed.random.length > MAX_SEED_VALUES || seed.uuids.length > MAX_SEED_VALUES) {
    return { ok: false, error: 'seed sequences exceed cap' };
  }
  if (!Number.isFinite(seed.startedAtWallMs as number)) return { ok: false, error: 'seed.startedAtWallMs must be finite' };
  // Element types matter — replayed `Math.random()` returns these verbatim.
  // A hostile record could otherwise inject strings/objects into the app's
  // arithmetic.
  if (seed.random.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    return { ok: false, error: 'seed.random must be finite numbers' };
  }
  if (seed.uuids.some((v) => typeof v !== 'string')) {
    return { ok: false, error: 'seed.uuids must be strings' };
  }

  if (r.request !== undefined) {
    const req = r.request as Record<string, unknown>;
    if (typeof req.method !== 'string' || typeof req.url !== 'string' || typeof req.headers !== 'object' || req.headers === null) {
      return { ok: false, error: 'request malformed' };
    }
  }
  if (r.response !== undefined) {
    const res = r.response as Record<string, unknown>;
    if (typeof res.status !== 'number' || !Number.isInteger(res.status)) {
      return { ok: false, error: 'response.status must be an integer' };
    }
  }
  return { ok: true, record: input as ExecutionRecord };
}
