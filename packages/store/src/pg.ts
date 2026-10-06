import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { summarize, type ExecutionRecord, type ExecutionSummary, type RegressionScenario } from '@recurr-dev/core';
import type { IncidentStore, ListFilter } from './store.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/** PostgreSQL store — used by the collector/API service. */
export class PgStore implements IncidentStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string);
  constructor(pool: pg.Pool);
  constructor(arg: string | pg.Pool) {
    this.pool =
      typeof arg === 'string'
        ? new pg.Pool({ connectionString: arg, connectionTimeoutMillis: 10_000 })
        : arg;
  }

  /** Apply SQL migrations in lexicographic order. Idempotent; safe under
   *  concurrent boots via a Postgres advisory lock. */
  async migrate(): Promise<string[]> {
    const applied: string[] = [];
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(727207)');
      try {
        for (const f of files) {
          const { rows } = await client.query('SELECT 1 FROM _recurr_migrations WHERE name = $1', [f]).catch(() => ({ rows: [] as never[] }));
          if (rows.length > 0) continue;
          const sql = await fs.readFile(path.join(MIGRATIONS_DIR, f), 'utf8');
          await client.query('BEGIN');
          try {
            await client.query(sql);
            await client.query('INSERT INTO _recurr_migrations (name) VALUES ($1)', [f]);
            await client.query('COMMIT');
            applied.push(f);
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          }
        }
      } finally {
        await client.query('SELECT pg_advisory_unlock(727207)').catch(() => {});
      }
    } finally {
      client.release();
    }
    return applied;
  }

  async save(record: ExecutionRecord): Promise<void> {
    const s = summarize(record);
    await this.pool.query(
      `INSERT INTO executions (id, kind, replay_of, service, env, method, path, status, error_name, captured_at, duration_ms, record)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         record = EXCLUDED.record, kind = EXCLUDED.kind, replay_of = EXCLUDED.replay_of,
         service = EXCLUDED.service, env = EXCLUDED.env, method = EXCLUDED.method,
         path = EXCLUDED.path, status = EXCLUDED.status, error_name = EXCLUDED.error_name,
         duration_ms = EXCLUDED.duration_ms, captured_at = EXCLUDED.captured_at`,
      [s.id, s.kind, s.replayOf ?? null, s.service, s.env, s.method ?? null, s.path ?? null, s.status ?? null, s.errorName ?? null, s.capturedAt, s.durationMs ?? null, JSON.stringify(record)],
    );
  }

  async get(id: string): Promise<ExecutionRecord | null> {
    const { rows } = await this.pool.query('SELECT record FROM executions WHERE id = $1', [id]);
    return rows.length ? (rows[0].record as ExecutionRecord) : null;
  }

  async list(filter: ListFilter = {}): Promise<ExecutionSummary[]> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter.kind) {
      params.push(filter.kind);
      conds.push(`kind = $${params.length}`);
    }
    if (filter.service) {
      params.push(filter.service);
      conds.push(`service = $${params.length}`);
    }
    params.push(filter.limit ?? 100);
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows } = await this.pool.query(
      `SELECT id, kind, replay_of, service, env, method, path, status, error_name, captured_at, duration_ms
       FROM executions ${where} ORDER BY captured_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      replayOf: r.replay_of ?? undefined,
      service: r.service,
      env: r.env,
      method: r.method ?? undefined,
      path: r.path ?? undefined,
      status: r.status ?? undefined,
      errorName: r.error_name ?? undefined,
      capturedAt: new Date(r.captured_at).toISOString(),
      durationMs: r.duration_ms ?? undefined,
    }));
  }

  async listReplays(incidentId: string): Promise<ExecutionSummary[]> {
    const { rows } = await this.pool.query(
      `SELECT id, kind, replay_of, service, env, method, path, status, error_name, captured_at, duration_ms
       FROM executions WHERE replay_of = $1 ORDER BY captured_at DESC`,
      [incidentId],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      replayOf: r.replay_of ?? undefined,
      service: r.service,
      env: r.env,
      method: r.method ?? undefined,
      path: r.path ?? undefined,
      status: r.status ?? undefined,
      errorName: r.error_name ?? undefined,
      capturedAt: new Date(r.captured_at).toISOString(),
      durationMs: r.duration_ms ?? undefined,
    }));
  }

  async saveRegression(scenario: RegressionScenario): Promise<void> {
    await this.pool.query(
      `INSERT INTO regression_scenarios (id, name, incident_id, expected_bug_status, notes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, notes = EXCLUDED.notes`,
      [scenario.id, scenario.name, scenario.incidentId, scenario.expectedBugStatus ?? null, scenario.notes ?? null, scenario.createdAt],
    );
  }

  async listRegressions(): Promise<RegressionScenario[]> {
    const { rows } = await this.pool.query('SELECT * FROM regression_scenarios ORDER BY created_at');
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      incidentId: r.incident_id,
      createdAt: new Date(r.created_at).toISOString(),
      expectedBugStatus: r.expected_bug_status ?? undefined,
      notes: r.notes ?? undefined,
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
