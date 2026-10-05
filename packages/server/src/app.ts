import express, { type Express } from 'express';
import { isSafeRecordId, validateRecord, type RegressionScenario } from '@recurr/core';
import type { IncidentStore } from '@recurr/store';

/** Collector + query API. Thin HTTP layer over an IncidentStore. */
export function createApp(store: IncidentStore): Express {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'recurr-server' });
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
      if (!isSafeRecordId(s.id) || !isSafeRecordId(s.incidentId)) {
        res.status(400).json({ error: 'invalid id' });
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
