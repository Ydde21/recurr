import { SCHEMA_VERSION, type ExecutionRecord } from './types.js';

/** ids are used as file names — keep them strict. */
export const RECORD_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

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
 * Validate an untrusted ExecutionRecord (import files, collector ingest).
 * Structural, not semantic — checks the fields the system depends on.
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
  for (let i = 0; i < r.events.length; i++) {
    const e = r.events[i] as Record<string, unknown>;
    if (typeof e !== 'object' || e === null || typeof e.seq !== 'number' || typeof e.kind !== 'string') {
      return { ok: false, error: `events[${i}] malformed` };
    }
  }
  if (!r.seed || typeof r.seed !== 'object') return { ok: false, error: 'seed required' };
  const seed = r.seed as Record<string, unknown>;
  if (!Array.isArray(seed.random) || !Array.isArray(seed.uuids) || typeof seed.startedAtWallMs !== 'number') {
    return { ok: false, error: 'seed malformed' };
  }
  if (r.request !== undefined) {
    const req = r.request as Record<string, unknown>;
    if (typeof req.method !== 'string' || typeof req.url !== 'string') {
      return { ok: false, error: 'request malformed' };
    }
  }
  return { ok: true, record: input as ExecutionRecord };
}
