/**
 * Recurr record schema (schemaVersion 1).
 *
 * An ExecutionRecord is the serializable form of one captured execution.
 * `kind: 'incident'` is a production capture; `kind: 'replay'` is a replay
 * attempt linked to its source incident via `replayOf`.
 */

export const SCHEMA_VERSION = 1 as const;

export type RecordKind = 'incident' | 'replay';

export interface ServiceInfo {
  name: string;
  version?: string;
  gitSha?: string;
  runtime: string; // e.g. "node v26.8.1"
  region?: string;
}

export interface EnvironmentInfo {
  name: string; // production | staging | replay
  [key: string]: unknown;
}

export interface CapturedHttpRequest {
  method: string;
  /** Path + query exactly as received, e.g. /api/orders?expand=items */
  url: string;
  path: string;
  headers: Record<string, string | string[]>;
  /** UTF-8 body, or {base64} for binary, or {truncated} marker. */
  body?: string;
  bodyBase64?: boolean;
  bodyTruncated?: boolean;
  remoteAddr?: string;
}

export interface CapturedHttpResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body?: string;
  bodyBase64?: boolean;
  bodyTruncated?: boolean;
  durationMs: number;
}

export interface CapturedError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
}

/** Nondeterministic inputs captured at runtime so replay can reproduce them. */
export interface ExecutionSeed {
  /** Wall-clock ms at execution start; replay shifts its clock to this. */
  startedAtWallMs: number;
  /** Math.random() outputs in call order. */
  random: number[];
  /** crypto.randomUUID() outputs in call order. */
  uuids: string[];
  /** Stable seed derived from the record id; powers PRNG fallback when a
   *  replay consumes more values than were captured. */
  prngSeed: number;
  /**
   * Replay records only: how many Math.random() calls the replay consumed.
   * Compared against the original's `random.length` by the diff engine —
   * a mismatch means the replay's code path diverged.
   */
  randomConsumed?: number;
  /** Replay records only: crypto.randomUUID() calls consumed. */
  uuidConsumed?: number;
  /** Clock reads (Date.now / new Date) made inside the capture context. */
  timeReads?: number;
}

/**
 * What the authentication layer resolved to — principal, not credential.
 * Captured credentials are redacted; the resolved principal is what replay
 * re-injects so auth never needs production secrets.
 */
export interface CapturedAuth {
  principal?: unknown;
  scheme?: string;
}

export type EventKind =
  | 'http.in'
  | 'db.query'
  | 'http.out'
  | 'error'
  | 'retry'
  | 'log'
  | 'custom'
  | 'replay.note';

export interface TimelineEvent {
  /** Monotonic sequence number within the execution. */
  seq: number;
  /** ISO timestamp of the event. */
  at: string;
  /** Milliseconds since execution start. */
  offsetMs: number;
  kind: EventKind;
  /** Short label: 'postgres', 'payment-api', 'POST https://…'. */
  name?: string;
  durationMs?: number;
  status?: 'ok' | 'error';
  /** Kind-specific payload, already redacted. */
  data?: Record<string, unknown>;
}

export interface DbQueryData {
  system: string; // 'postgres' | 'mysql' | …
  text: string;
  params?: unknown[];
  rowCount?: number;
  /** Captured rows, bounded by capture config. */
  rows?: unknown[];
  rowsTruncated?: boolean;
  error?: string;
  errorName?: string;
}

export interface HttpOutData {
  method: string;
  url: string;
  requestBody?: string;
  status?: number;
  responseBody?: string;
  /** Response headers (redacted) — needed to synthesize faithful replays. */
  responseHeaders?: Record<string, string | string[]>;
  /** True when the response headers arrived but the body was never consumed
   *  before the record closed (fire-and-forget callers) — the absent body is
   *  a capture gap, not an empty body. */
  responsePending?: boolean;
  error?: string;
  errorName?: string;
  /** 'timeout' | 'reset' | 'error' for failed calls. */
  errorKind?: 'timeout' | 'reset' | 'error';
  attempt?: number;
}

export interface RedactionReport {
  /** Dotted paths that were redacted, e.g. 'request.headers.authorization'. */
  redactedPaths: string[];
  /** Paths where bodies were dropped/truncated by size limits. */
  truncatedPaths: string[];
}

export interface ExecutionRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  kind: RecordKind;
  /** For kind='replay': the incident this replay attempted to reproduce. */
  replayOf?: string;
  service: ServiceInfo;
  environment: EnvironmentInfo;
  capturedAt: string; // ISO
  trigger: { type: 'http' | 'error' | 'manual' | 'replay' };
  request?: CapturedHttpRequest;
  response?: CapturedHttpResponse;
  error?: CapturedError;
  auth?: CapturedAuth;
  seed: ExecutionSeed;
  events: TimelineEvent[];
  redaction: RedactionReport;
  labels?: Record<string, string>;
}

export interface ExecutionSummary {
  id: string;
  kind: RecordKind;
  replayOf?: string;
  service: string;
  env: string;
  method?: string;
  path?: string;
  status?: number;
  errorName?: string;
  capturedAt: string;
  durationMs?: number;
}

/** An incident promoted to a permanent regression scenario. */
export interface RegressionScenario {
  id: string;
  name: string;
  incidentId: string;
  createdAt: string;
  /** Status/error expected when the bug is still present. */
  expectedBugStatus?: number;
  notes?: string;
}

export function summarize(record: ExecutionRecord): ExecutionSummary {
  return {
    id: record.id,
    kind: record.kind,
    replayOf: record.replayOf,
    service: record.service.name,
    env: record.environment.name,
    method: record.request?.method,
    path: record.request?.path,
    status: record.response?.status,
    errorName: record.error?.name,
    capturedAt: record.capturedAt,
    durationMs: record.response?.durationMs,
  };
}
