import express, { type Express } from 'express';
import { SCHEMA_VERSION, type ExecutionRecord, type RegressionScenario } from '@recurr/core';
import type { IncidentStore } from '@recurr/store';

/** Collector + query API. Thin HTTP layer over an IncidentStore. */
export function createApp(store: IncidentStore): Express {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'recurr-server' });
  });

  // Ingest
  app.post('/v1/executions', async (req, res, next) => {
    try {
      const record = req.body as ExecutionRecord;
      if (!record?.id || record.schemaVersion !== SCHEMA_VERSION) {
        res.status(400).json({ error: `invalid record: expected schemaVersion ${SCHEMA_VERSION} and id` });
        return;
      }
      await store.save(record);
      res.status(201).json({ id: record.id });
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/executions', async (req, res, next) => {
    try {
      const kind = req.query.kind === 'incident' || req.query.kind === 'replay' ? req.query.kind : undefined;
      const service = typeof req.query.service === 'string' ? req.query.service : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      res.json(await store.list({ kind, service, limit }));
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/executions/:id', async (req, res, next) => {
    try {
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
      res.json(await store.listReplays(req.params.id));
    } catch (err) {
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
      await store.saveRegression(s);
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[recurr-server]', err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
