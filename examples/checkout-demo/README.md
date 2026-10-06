# checkout-demo — Recurr end-to-end example

A minimal Express checkout API with a realistic, intentional bug — built to
show the whole Recurr workflow (capture → inspect → replay → diff →
regression) without any external services.

## The bug

`POST /api/orders` charges a payment simulator with an 800ms timeout and three
retries. `payment-sim` hangs on orders over $500, so a large order exhausts
every retry and throws `PaymentConfirmationTimeout` → HTTP 500.

`src/index.ts` is the buggy build. `src/index-fixed.ts` is the "fix": when the
payment call fails, the order is stored as `pending_payment` and the endpoint
returns 202 instead of crashing.

## Run it

```bash
# from the repo root — builds are required first
pnpm install && pnpm build
pnpm demo
```

`scripts/demo.mjs` does the whole loop and prints each step:

1. starts `payment-sim` (:4781) + instrumented `checkout-api` (:4790)
2. POSTs a $899 order → 500 → Recurr captures the Incident Record
3. `recurr incidents` + `recurr inspect RUN-…`
4. `recurr replay -t "node dist/index.js"` → reproduces the 500 (same code)
5. `recurr replay -t "node dist/index-fixed.js"` → 202 — fix verified
6. `recurr regression save` + `recurr regression run`

Records land in `.recurr/store` (gitignored). Open the UI against them:

```bash
RECURR_STORE=fs:examples/checkout-demo/.recurr/store recurr-server
# → http://127.0.0.1:4780 — the incident is ready to inspect/replay/diff
```

## What to look at

- `src/app.ts` — the instrumented app: `init()`, `recurr.middleware()`,
  `recurr.errorMiddleware()`, `recurr.instrumentDb()`, `recurr.auth()`,
  `recurr.recordEvent('retry', …)`.
- `src/db.ts` — embedded Postgres (pg-mem) so the demo needs no real DB;
  `instrumentDb` works identically on `pg.Pool`.
- `src/payment-sim.ts` — the flaky dependency; at replay its responses come
  from the record, not the network.
- `src/index-fixed.ts` — same app, `resilient: true`.

## Notes

- The demo wipes `.recurr/store` on every run — it's disposable by design.
- `authorization: Bearer demo-u1` is a fake credential: the record keeps the
  resolved principal (`u1`, `org-1`) while the token itself is redacted before
  persistence — that's the auth story in miniature.
