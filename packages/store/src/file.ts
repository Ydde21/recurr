import { promises as fs } from 'node:fs';
import path from 'node:path';
import { summarize, type ExecutionRecord, type ExecutionSummary, type RegressionScenario } from '@recurr/core';
import type { IncidentStore, ListFilter } from './store.js';

/**
 * Filesystem store — default for local development and `recurr` CLI use.
 *
 *   <dir>/executions/<ID>.json    full execution records
 *   <dir>/regressions/<ID>.json   saved regression scenarios
 */
export class FileStore implements IncidentStore {
  constructor(private readonly dir: string) {}

  private executionsDir(): string {
    return path.join(this.dir, 'executions');
  }

  private regressionsDir(): string {
    return path.join(this.dir, 'regressions');
  }

  private async ensure(): Promise<void> {
    await fs.mkdir(this.executionsDir(), { recursive: true });
    await fs.mkdir(this.regressionsDir(), { recursive: true });
  }

  async save(record: ExecutionRecord): Promise<void> {
    await this.ensure();
    const file = path.join(this.executionsDir(), `${record.id}.json`);
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(record, null, 2));
    await fs.rename(tmp, file);
  }

  async get(id: string): Promise<ExecutionRecord | null> {
    try {
      const raw = await fs.readFile(path.join(this.executionsDir(), `${id}.json`), 'utf8');
      return JSON.parse(raw) as ExecutionRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async list(filter: ListFilter = {}): Promise<ExecutionSummary[]> {
    await this.ensure();
    let files: string[];
    try {
      files = (await fs.readdir(this.executionsDir())).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const summaries: ExecutionSummary[] = [];
    for (const f of files) {
      try {
        const raw = await fs.readFile(path.join(this.executionsDir(), f), 'utf8');
        const rec = JSON.parse(raw) as ExecutionRecord;
        const s = summarize(rec);
        if (filter.kind && s.kind !== filter.kind) continue;
        if (filter.service && s.service !== filter.service) continue;
        summaries.push(s);
      } catch {
        /* skip unreadable/partial files */
      }
    }
    summaries.sort((x, y) => y.capturedAt.localeCompare(x.capturedAt));
    return summaries.slice(0, filter.limit ?? 100);
  }

  async listReplays(incidentId: string): Promise<ExecutionSummary[]> {
    const all = await this.list({ kind: 'replay', limit: 10_000 });
    return all.filter((s) => s.replayOf === incidentId);
  }

  async saveRegression(scenario: RegressionScenario): Promise<void> {
    await this.ensure();
    const file = path.join(this.regressionsDir(), `${scenario.id}.json`);
    await fs.writeFile(file, JSON.stringify(scenario, null, 2));
  }

  async listRegressions(): Promise<RegressionScenario[]> {
    await this.ensure();
    try {
      const files = (await fs.readdir(this.regressionsDir())).filter((f) => f.endsWith('.json'));
      const out: RegressionScenario[] = [];
      for (const f of files) {
        out.push(JSON.parse(await fs.readFile(path.join(this.regressionsDir(), f), 'utf8')) as RegressionScenario);
      }
      return out.sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {}
}
