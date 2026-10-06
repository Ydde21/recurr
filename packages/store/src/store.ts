import type { ExecutionRecord, ExecutionSummary, RegressionScenario } from '@recurr-dev/core';

export interface ListFilter {
  /** Only 'incident' | 'replay' records, or all when unset. */
  kind?: 'incident' | 'replay';
  service?: string;
  /** Max results, newest first. */
  limit?: number;
}

export interface IncidentStore {
  save(record: ExecutionRecord): Promise<void>;
  get(id: string): Promise<ExecutionRecord | null>;
  list(filter?: ListFilter): Promise<ExecutionSummary[]>;
  listReplays(incidentId: string): Promise<ExecutionSummary[]>;
  saveRegression(scenario: RegressionScenario): Promise<void>;
  listRegressions(): Promise<RegressionScenario[]>;
  close(): Promise<void>;
}
