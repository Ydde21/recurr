import express from 'express';

/**
 * payment-sim — stand-in for an external payment API.
 * POST /charge: responds instantly for amounts ≤ $500; hangs for 5s on
 * larger amounts (long enough to blow the checkout's 800ms timeout).
 */
const app = express();
app.use(express.json());

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.post('/charge', (req, res) => {
  const { amountCents } = req.body as { amountCents?: number };
  if ((amountCents ?? 0) > 50000) {
    setTimeout(() => res.status(504).json({ error: 'upstream timeout' }), 5000);
    return;
  }
  res.json({ status: 'ok', chargeId: `ch_${Math.random().toString(36).slice(2, 10)}` });
});

const port = Number(process.env.PAYMENT_PORT ?? 4781);
app.listen(port, () => console.log(`[payment-sim] listening on :${port}`));
