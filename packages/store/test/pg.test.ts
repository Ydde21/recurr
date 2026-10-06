import { describe, expect, it } from 'vitest';
import pg from 'pg';
import type { ExecutionRecord } from '@recurr-dev/core';
import { PgStore } from '../src/pg.js';

/**
 * PgStore integration test — runs only when DATABASE_URL points at a real
 * Postgres (e.g. `docker compose up -d db`). Otherwise skipped.
 */
const DSN = process.env.RECURR_TEST_PG ?? process.env.DATABASE_URL;
const describePg = DSN ? describe : describe.skip;

function rec(id: string, kind: 'incident' | 'replay' = 'incident', replayOf?: string): ExecutionRecord {
  return {
    schemaVersion: 1,
    id,
    kind,
    replayOf,
    service: { name: 'svc-pg', runtime: 'node v26' },
    environment: { name: 'test' },
    capturedAt: new Date().toISOString(),
    trigger: { type: 'http' },
    request: { method: 'POST', url: '/x?k=1', path: '/x', headers: { 'content-type': 'application/json' }, body: '{"a":1}' },
    response: { status: 500, headers: {}, body: '{"err":1}', durationMs: 3 },
    seed: { startedAtWallMs: 1, random: [0.5], uuids: ['u'], prngSeed: 7, timeReads: 2 },
    events: [{ seq: 1, at: '2026-01-01T00:00:00Z', offsetMs: 0, kind: 'http.in', name: 'POST /x' }],
    redaction: { redactedPaths: ['request.headers.authorization'], truncatedPaths: [] },
  };
}

describePg('PgStore (requires DATABASE_URL)', () => {
  it('migrates idempotently, saves, gets, lists, closes', async () => {
    const store = new PgStore(DSN!);
    // Fresh DB applies 0001_init.sql; already-migrated DB applies nothing.
    // Either is valid — the invariant is idempotency + a working schema.
    await store.migrate();
    const applied2 = await store.migrate();
    expect(applied2).toEqual([]);
    // Verify the migration actually exists in the bookkeeping table.
    const probe = new pg.Client({ connectionString: DSN });
    await probe.connect();
    try {
      const { rows } = await probe.query("SELECT name FROM _recurr_migrations WHERE name = '0001_init.sql'");
      expect(rows.length).toBe(1);
    } finally {
      await probe.end();
    }

    const suffix = Date.now().toString(36).toUpperCase();
    const id = `RUN-PG${suffix}`;
    await store.save(rec(id));
    const got = await store.get(id);
    expect(got?.id).toBe(id);
    expect(got?.seed.random).toEqual([0.5]);
    expect(got?.redaction.redactedPaths).toEqual(['request.headers.authorization']);

    // Upsert semantics on duplicate id — second save wins, no crash.
    const again = rec(id);
    again.response = { status: 503, headers: {}, durationMs: 5 };
    await store.save(again);
    expect((await store.get(id))?.response?.status).toBe(503);

    const list = await store.list({ kind: 'incident', service: 'svc-pg' });
    expect(list.some((s) => s.id === id)).toBe(true);

    const replay = rec(`RPL-${suffix}`, 'replay', id);
    await store.save(replay);
    const replays = await store.listReplays(id);
    expect(replays.map((r) => r.id)).toContain(`RPL-${suffix}`);

    await store.saveRegression({ id: `REG-${suffix}`, name: 'pg scenario', incidentId: id, createdAt: new Date().toISOString() });
    expect((await store.listRegressions()).some((s) => s.id === `REG-${suffix}`)).toBe(true);

    expect(await store.get('RUN-DOES-NOT-EXIST')).toBeNull();
    await store.close();
  });

  it('concurrent migrates do not corrupt state', async () => {
    // Two independent pools racing migrate() — advisory lock serializes.
    const a = new PgStore(DSN!);
    const b = new PgStore(DSN!);
    await expect(Promise.all([a.migrate(), b.migrate()])).resolves.toBeDefined();
    await a.close();
    await b.close();
  });
});
