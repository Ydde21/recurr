import express, { type Express } from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { isSafeRecordId, validateRecord, SCHEMA_VERSION, type RegressionScenario } from '@recurr-dev/core';
import { replayIncident, ReplayError } from '@recurr-dev/replay';
import type { IncidentStore } from '@recurr-dev/store';

/** Strip userinfo from store specs before logging/exposing them — pg
 *  connection strings embed passwords. */
export function redactStoreSpec(spec: string): string {
  return spec.replace(/(\w+:\/\/)[^/@]*@/, '$1***@');
}

export interface AppOptions {
  /**
   * Store spec string propagated to replay children (RECURR_STORE). Required
   * for the replay endpoints — without it, /v1/incidents/:id/replays and
   * /v1/regressions/:id/run return 501.
   */
  storeSpec?: string;
  /** Directory containing the built developer UI. Served at / when present. */
  uiDir?: string;
  /**
   * When set, every /v1/* route requires `Authorization: Bearer <token>`.
   * /healthz stays open for liveness probes; the static UI shell is
   * unauthenticated but holds no data — all data flows through /v1.
   */
  authToken?: string;
}

interface ReplayRequestBody {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
  timeoutMs?: unknown;
  readyTimeoutMs?: unknown;
}

/** Validate the replay-target fields a UI/CLI caller supplies over HTTP. */
function parseReplayBody(body: ReplayRequestBody):
  | { ok: true; target: { command: string; cwd?: string; env?: Record<string, string> }; timeoutMs?: number; readyTimeoutMs?: number }
  | { ok: false; error: string } {
  const command = body?.command;
  if (typeof command !== 'string' || !command.trim() || command.length > 4096) {
    return { ok: false, error: 'command must be a non-empty string (≤4KB)' };
  }
  const cwd = body?.cwd;
  if (cwd !== undefined && (typeof cwd !== 'string' || cwd.length > 4096)) {
    return { ok: false, error: 'cwd must be a string (≤4KB)' };
  }
  const env = body?.env;
  let envOut: Record<string, string> | undefined;
  if (env !== undefined) {
    if (typeof env !== 'object' || env === null || Array.isArray(env)) {
      return { ok: false, error: 'env must be an object of string values' };
    }
    envOut = {};
    for (const [k, v] of Object.entries(env)) {
      if (typeof v !== 'string' || k.length > 256 || v.length > 8192) {
        return { ok: false, error: `env.${k} must be a string (≤8KB)` };
      }
      envOut[k] = v;
    }
  }
  const timeoutMs = body?.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000)) {
    return { ok: false, error: 'timeoutMs must be 1000–300000' };
  }
  const readyTimeoutMs = body?.readyTimeoutMs;
  if (readyTimeoutMs !== undefined && (typeof readyTimeoutMs !== 'number' || !Number.isFinite(readyTimeoutMs) || readyTimeoutMs < 500 || readyTimeoutMs > 120_000)) {
    return { ok: false, error: 'readyTimeoutMs must be 500–120000' };
  }
  return {
    ok: true,
    target: { command, cwd: cwd as string | undefined, env: envOut },
    timeoutMs: timeoutMs as number | undefined,
    readyTimeoutMs: readyTimeoutMs as number | undefined,
  };
}

/** Each replay spawns a real child process — bound how many can run at once
 *  so a burst of requests can't exhaust the host. Excess requests get 429. */
const MAX_CONCURRENT_REPLAYS = 4;
let inflightReplays = 0;

function replayErrorStatus(err: ReplayError): number {
  switch (err.code) {
    case 'NOT_FOUND':
      return 404;
    case 'NO_RECORD':
    case 'BAD_ARGS':
      return 400;
    case 'READY_TIMEOUT':
    case 'TIMEOUT':
      return 504;
    case 'TARGET_EXIT':
      return 502;
    default:
      return 500;
  }
}

/** Constant-time bearer check — auth'd deployments shouldn't leak the token
 *  length/content through compare timing. */
function bearerAuth(token: string): express.RequestHandler {
  const expected = Buffer.from(`Bearer ${token}`);
  return (req, res, next) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    if (got.length === expected.length && timingSafeEqual(got, expected)) return next();
    res.status(401).json({ error: 'unauthorized — set Authorization: Bearer <RECURR_TOKEN>' });
  };
}

/** Collector + query API + replay runner. Thin HTTP layer over an IncidentStore. */
export function createApp(store: IncidentStore, opts: AppOptions = {}): Express {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  if (opts.authToken) app.use('/v1', bearerAuth(opts.authToken));

  app.get('/healthz', (_req, res) => {
    // The pg spec embeds credentials — strip the authority's userinfo before
    // advertising it to anyone who can reach the endpoint.
    res.json({ ok: true, service: 'recurr-server', schemaVersion: SCHEMA_VERSION, store: opts.storeSpec ? redactStoreSpec(opts.storeSpec) : undefined });
  });

  // Ingest — untrusted input, validate before it touches the store.
  app.post('/v1/executions', async (req, res, next) => {
    try {
      const v = validateRecord(req.body);
      if (!v.ok) {
        res.status(400).json({ error: `invalid record: ${v.error}` });
        return;
      }
      await store.save(v.record);
      res.status(201).json({ id: v.record.id });
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/executions', async (req, res, next) => {
    try {
      const kind = req.query.kind === 'incident' || req.query.kind === 'replay' ? req.query.kind : undefined;
      const service = typeof req.query.service === 'string' ? req.query.service : undefined;
      const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
        res.status(400).json({ error: `invalid limit: ${String(req.query.limit)}` });
        return;
      }
      res.json(await store.list({ kind, service, limit }));
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/executions/:id', async (req, res, next) => {
    try {
      if (!isSafeRecordId(req.params.id)) {
        res.status(400).json({ error: 'invalid id' });
        return;
      }
      const record = await store.get(req.params.id);
      if (!record) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json(record);
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/incidents/:id/replays', async (req, res, next) => {
    try {
      if (!isSafeRecordId(req.params.id)) {
        res.status(400).json({ error: 'invalid id' });
        return;
      }
      res.json(await store.listReplays(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  // Run a replay — synchronous like the CLI: the request stays open while the
  // replay orchestrator spawns/isolates the target (bounded by timeoutMs).
  app.post('/v1/incidents/:id/replays', async (req, res, next) => {
    try {
      if (!opts.storeSpec) {
        res.status(501).json({ error: 'server was not started with a resolvable store spec — replays unavailable' });
        return;
      }
      if (!isSafeRecordId(req.params.id)) {
        res.status(400).json({ error: 'invalid id' });
        return;
      }
      const parsed = parseReplayBody(req.body as ReplayRequestBody);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      if (inflightReplays >= MAX_CONCURRENT_REPLAYS) {
        res.status(429).json({ error: `${MAX_CONCURRENT_REPLAYS} replays already running — retry when one finishes`, code: 'BUSY' });
        return;
      }
      inflightReplays++;
      const progress: string[] = [];
      let result;
      try {
        result = await replayIncident({
          store,
          storeSpec: opts.storeSpec,
          incidentId: req.params.id,
          target: parsed.target,
          timeoutMs: parsed.timeoutMs,
          readyTimeoutMs: parsed.readyTimeoutMs,
          onProgress: (m) => progress.push(m),
        });
      } finally {
        inflightReplays--;
      }
      res.status(201).json({
        replayId: result.replay.id,
        observedStatus: result.observedStatus,
        report: result.report,
        log: progress,
      });
    } catch (err) {
      if (err instanceof ReplayError) {
        res.status(replayErrorStatus(err)).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  app.post('/v1/regressions', async (req, res, next) => {
    try {
      const s = req.body as RegressionScenario;
      if (!s?.id || !s.incidentId || !s.name) {
        res.status(400).json({ error: 'expected {id, incidentId, name}' });
        return;
      }
      if (!isSafeRecordId(s.id) || !isSafeRecordId(s.incidentId)) {
        res.status(400).json({ error: 'invalid id' });
        return;
      }
      if (typeof s.name !== 'string' || s.name.length > 512 || (s.notes !== undefined && typeof s.notes !== 'string')) {
        res.status(400).json({ error: 'invalid name/notes' });
        return;
      }
      if (s.createdAt !== undefined && (typeof s.createdAt !== 'string' || Number.isNaN(Date.parse(s.createdAt)))) {
        res.status(400).json({ error: 'invalid createdAt' });
        return;
      }
      // FileStore would happily persist a missing timestamp; pg's NOT NULL
      // column would 500. Default it so both stores behave identically.
      await store.saveRegression({ ...s, createdAt: s.createdAt ?? new Date().toISOString() });
      res.status(201).json({ id: s.id });
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/regressions', async (_req, res, next) => {
    try {
      res.json(await store.listRegressions());
    } catch (err) {
      next(err);
    }
  });

  // Run a regression scenario — replays its incident and reports whether the
  // bug still reproduces. Same semantics as `recurr regression run`.
  app.post('/v1/regressions/:id/run', async (req, res, next) => {
    try {
      if (!opts.storeSpec) {
        res.status(501).json({ error: 'server was not started with a resolvable store spec — replays unavailable' });
        return;
      }
      if (!isSafeRecordId(req.params.id)) {
        res.status(400).json({ error: 'invalid id' });
        return;
      }
      const parsed = parseReplayBody(req.body as ReplayRequestBody);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      const scenario = (await store.listRegressions()).find((s) => s.id === req.params.id);
      if (!scenario) {
        res.status(404).json({ error: `no regression scenario ${req.params.id}` });
        return;
      }
      if (inflightReplays >= MAX_CONCURRENT_REPLAYS) {
        res.status(429).json({ error: `${MAX_CONCURRENT_REPLAYS} replays already running — retry when one finishes`, code: 'BUSY' });
        return;
      }
      inflightReplays++;
      const progress: string[] = [];
      let result;
      try {
        result = await replayIncident({
          store,
          storeSpec: opts.storeSpec,
          incidentId: scenario.incidentId,
          target: parsed.target,
          timeoutMs: parsed.timeoutMs,
          readyTimeoutMs: parsed.readyTimeoutMs,
          onProgress: (m) => progress.push(m),
        });
      } finally {
        inflightReplays--;
      }
      res.status(201).json({
        scenario,
        replayId: result.replay.id,
        observedStatus: result.observedStatus,
        report: result.report,
        log: progress,
        fixed: !result.report.outcomeMatch,
      });
    } catch (err) {
      if (err instanceof ReplayError) {
        res.status(replayErrorStatus(err)).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  // Developer UI — static assets + SPA fallback. Only mounted when a built
  // uiDir is present; the API works standalone regardless.
  if (opts.uiDir) {
    const uiDir = path.resolve(opts.uiDir);
    if (existsSync(path.join(uiDir, 'index.html'))) {
      app.use(express.static(uiDir, { index: 'index.html', maxAge: '1h' }));
      app.get('*', (req, res, next) => {
        if (req.path.startsWith('/v1/') || req.path === '/healthz') return next();
        res.sendFile(path.join(uiDir, 'index.html'));
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const type = (err as { type?: string }).type ?? '';
    if (type.startsWith('entity.parse') || type === 'entity.too.large') {
      res.status(400).json({ error: `bad request body: ${type}` });
      return;
    }
    console.error('[recurr-server]', err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
