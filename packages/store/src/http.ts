import type { ExecutionRecord, ExecutionSummary, RegressionScenario } from '@recurr/core';
import type { IncidentStore, ListFilter } from './store.js';

/** HTTP store — talks to a recurr-server collector over its REST API. */
export class HttpStore implements IncidentStore {
  constructor(private readonly baseUrl: string) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`;
  }

  private async req(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(this.url(path), init);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`recurr server ${res.status} ${path}: ${body.slice(0, 200)}`);
    }
    return res;
  }

  async save(record: ExecutionRecord): Promise<void> {
    await this.req('/v1/executions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(record),
    });
  }

  async get(id: string): Promise<ExecutionRecord | null> {
    const res = await fetch(this.url(`/v1/executions/${encodeURIComponent(id)}`));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`recurr server ${res.status}`);
    return (await res.json()) as ExecutionRecord;
  }

  async list(filter: ListFilter = {}): Promise<ExecutionSummary[]> {
    const q = new URLSearchParams();
    if (filter.kind) q.set('kind', filter.kind);
    if (filter.service) q.set('service', filter.service);
    if (filter.limit) q.set('limit', String(filter.limit));
    const res = await this.req(`/v1/executions?${q}`);
    return (await res.json()) as ExecutionSummary[];
  }

  async listReplays(incidentId: string): Promise<ExecutionSummary[]> {
    const res = await this.req(`/v1/incidents/${encodeURIComponent(incidentId)}/replays`);
    return (await res.json()) as ExecutionSummary[];
  }

  async saveRegression(scenario: RegressionScenario): Promise<void> {
    await this.req('/v1/regressions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(scenario),
    });
  }

  async listRegressions(): Promise<RegressionScenario[]> {
    const res = await this.req('/v1/regressions');
    return (await res.json()) as RegressionScenario[];
  }

  async close(): Promise<void> {}
}
