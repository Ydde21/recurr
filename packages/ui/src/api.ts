import type { ExecutionRecord, ExecutionSummary, RegressionScenario } from '@recurr/core/types';
import type { DiffReport } from '@recurr/core/diff';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError('cannot reach the recurr server', 0);
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      if (body.error) msg = body.error;
      code = body.code;
    } catch {
      /* non-json error */
    }
    throw new ApiError(msg, res.status, code);
  }
  return (await res.json()) as T;
}

export interface Healthz {
  ok: boolean;
  service: string;
  schemaVersion: number;
  store?: string;
}

export interface ReplayRunResult {
  replayId: string;
  observedStatus?: number;
  report: DiffReport;
  log: string[];
}

export interface RegressionRunResult extends ReplayRunResult {
  scenario: RegressionScenario;
  fixed: boolean;
}

export const api = {
  healthz: () => req<Healthz>('/healthz'),
  listExecutions: (filter?: { kind?: 'incident' | 'replay'; service?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (filter?.kind) q.set('kind', filter.kind);
    if (filter?.service) q.set('service', filter.service);
    if (filter?.limit) q.set('limit', String(filter.limit));
    const qs = q.toString();
    return req<ExecutionSummary[]>(`/v1/executions${qs ? `?${qs}` : ''}`);
  },
  getRecord: (id: string) => req<ExecutionRecord>(`/v1/executions/${encodeURIComponent(id)}`),
  listReplays: (incidentId: string) => req<ExecutionSummary[]>(`/v1/incidents/${encodeURIComponent(incidentId)}/replays`),
  listRegressions: () => req<RegressionScenario[]>('/v1/regressions'),
  saveRegression: (s: RegressionScenario) =>
    req<{ id: string }>('/v1/regressions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(s),
    }),
  startReplay: (incidentId: string, target: { command: string; cwd?: string; env?: Record<string, string> }, timeouts?: { timeoutMs?: number; readyTimeoutMs?: number }) =>
    req<ReplayRunResult>(`/v1/incidents/${encodeURIComponent(incidentId)}/replays`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...target, ...timeouts }),
    }),
  runRegression: (id: string, target: { command: string; cwd?: string }, timeouts?: { timeoutMs?: number }) =>
    req<RegressionRunResult>(`/v1/regressions/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...target, ...timeouts }),
    }),
};
