import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { init, type Recurr } from '@recurr-dev/sdk';
import { createDb, seed, type Db } from './db.js';

/**
 * checkout-api — intentionally buggy checkout endpoint.
 *
 * POST /api/orders charges a payment API with an 800ms timeout and retries.
 * The payment simulator hangs on orders over $500, so every retry times out
 * and the endpoint throws PaymentConfirmationTimeout → 500.
 *
 * buildApp({ resilient: true }) is the "fixed" variant: instead of throwing,
 * it marks the order pending_payment and returns 202 — the replay then shows
 * the incident no longer reproduces.
 */
export async function buildApp(opts: { resilient: boolean }): Promise<{ app: Express; recurr: Recurr; db: Db }> {
  const recurr = await init({
    service: 'checkout-api',
    version: process.env.APP_VERSION ?? '1.8.2',
    env: process.env.NODE_ENV ?? 'development',
    capture: { on: 'error', captureDbRows: true, maxDbRows: 25 },
    redaction: { fields: ['x-internal-token'] },
  });

  const db = recurr.instrumentDb(createDb());
  await seed(db);

  const app = express();
  app.use(express.json());
  app.use(recurr.middleware());

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  interface Principal {
    userId: string;
    orgId: string;
  }

  // Auth resolves a principal. recurr.auth() records it during capture and
  // re-injects the recorded principal during replay — the bearer token itself
  // is redacted and never needed at replay time.
  async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const principal = await recurr.auth<Principal>(req, () => {
      const h = req.headers.authorization;
      if (!h?.startsWith('Bearer demo-')) return null;
      return { userId: h.slice('Bearer demo-'.length), orgId: 'org-1' };
    });
    if (!principal) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    (req as Request & { principal: Principal }).principal = principal;
    next();
  }

  const PAYMENT_URL = process.env.PAYMENT_URL ?? 'http://127.0.0.1:4781';
  const PAYMENT_TIMEOUT_MS = 800;
  const MAX_ATTEMPTS = 3;

  app.post('/api/orders', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { principal } = req as Request & { principal: Principal };
      const { items } = req.body as { items: { sku: string; qty: number }[] };
      if (!Array.isArray(items) || items.length === 0) {
        res.status(400).json({ error: 'items required' });
        return;
      }

      const { rows: userRows } = await db.query('SELECT id, org_id, email FROM users WHERE id = $1', [principal.userId]);
      if (userRows.length === 0) {
        res.status(404).json({ error: 'user not found' });
        return;
      }

      const skus = items.map((i) => i.sku);
      const placeholders = skus.map((_, i) => `$${i + 1}`).join(',');
      const { rows: products } = await db.query(
        `SELECT sku, name, price_cents, stock FROM products WHERE sku IN (${placeholders})`,
        skus,
      );
      const priceBySku = new Map(products.map((p) => [p.sku as string, p.price_cents as number]));
      const totalCents = items.reduce((sum, i) => sum + (priceBySku.get(i.sku) ?? 0) * i.qty, 0);

      const orderId = `ord_${crypto.randomUUID().slice(0, 8)}`;
      const idempotencyKey = `idem_${Math.random().toString(36).slice(2, 12)}`;

      // Charge the payment API with retries — the bug: persistent timeouts
      // are not handled, the error escapes as a 500.
      let lastError: unknown = null;
      let charged = false;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !charged; attempt++) {
        try {
          const payRes = await fetch(`${PAYMENT_URL}/charge`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
            body: JSON.stringify({ orderId, amountCents: totalCents, idempotencyKey }),
            signal: AbortSignal.timeout(PAYMENT_TIMEOUT_MS),
          });
          if (payRes.ok) {
            charged = true;
          } else {
            lastError = new Error(`payment rejected: ${payRes.status}`);
          }
        } catch (err) {
          lastError = err;
          recurr.recordEvent('retry', { attempt, max: MAX_ATTEMPTS, reason: err instanceof Error ? err.name : 'error' }, 'retry');
        }
      }

      if (!charged) {
        if (opts.resilient) {
          // Fixed behavior: accept the order as pending_payment.
          await db.query('INSERT INTO orders (id, user_id, total_cents, status, created_at) VALUES ($1,$2,$3,$4,$5)', [
            orderId,
            principal.userId,
            totalCents,
            'pending_payment',
            new Date().toISOString(),
          ]);
          res.status(202).json({ orderId, status: 'pending_payment', totalCents });
          return;
        }
        const err = new Error(`payment did not confirm after ${MAX_ATTEMPTS} attempts`);
        err.name = 'PaymentConfirmationTimeout';
        throw err;
      }

      await db.query('INSERT INTO orders (id, user_id, total_cents, status, created_at) VALUES ($1,$2,$3,$4,$5)', [
        orderId,
        principal.userId,
        totalCents,
        'paid',
        new Date().toISOString(),
      ]);
      res.status(201).json({ orderId, status: 'paid', totalCents });
    } catch (err) {
      next(err);
    }
  });

  // recurr's error middleware must precede the app's own error handler so the
  // thrown error is captured into the record.
  app.use(recurr.errorMiddleware());
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { name?: string; message?: string };
    res.status(500).json({ error: e?.name ?? 'Error', message: e?.message ?? 'unknown' });
  });

  return { app, recurr, db };
}
