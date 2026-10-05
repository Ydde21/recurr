# Recurr

**Run production incidents back locally.**

Recurr is an open-source production incident replay & debugging platform. When
an incident occurs in production, Recurr captures the minimum sufficient
execution context into a structured **Incident Record** — then reconstructs and
replays that execution inside an isolated local environment so you can debug,
modify inputs, and verify fixes.

```
production incident → capture → Incident Record → reconstruct → replay → diff → verify fix
```

## Quick start (demo)

```bash
pnpm install && pnpm build
pnpm demo          # runs the full capture → replay → diff → fix-verification loop
```

The demo spins up a `checkout-api` (Express + embedded Postgres via pg-mem) plus
a `payment-sim` dependency that hangs on orders over $500. A large order triggers
`PaymentConfirmationTimeout` → Recurr captures the incident → `recurr replay`
reproduces it deterministically (mocked DB + payment API, replayed
randomness/uuids, shifted wall clock) → `index-fixed.js` shows the fix landing
(500 → 202) → the incident is saved as a regression scenario.

## How it works

### Capture

```ts
import * as recurr from '@recurr/sdk';

const recurr = await recurr.init({
  service: 'checkout-api',
  version: '1.8.2',
  capture: { on: 'error' },            // persist only failing executions
  redaction: { fields: ['x-internal-token'] },
});

app.use(recurr.middleware());          // request/response + timeline capture
app.use(recurr.errorMiddleware());     // before your error handler
recurr.instrumentDb(pool);             // pg.Pool / pg.Client / pg-mem

// auth: captures the resolved principal (not the credential)
const principal = await recurr.auth(req, verifyBearer);
```

The SDK captures, per request: the HTTP request/response, resolved auth
principal, `db.query` calls (text, params, rows, timing), outbound
`fetch`/`http.request` calls (url, status, bodies, failures), `Math.random()` /
`crypto.randomUUID()` outputs, the wall-clock start, errors, retries and custom
events — all scoped via `AsyncLocalStorage`, redacted before persistence.

### Replay

```bash
recurr replay RUN-KFE489 -t "node dist/index.js"
```

The replay engine spawns your app with `RECURR_MODE=replay`. Inside that
process:

- `listen()` is hijacked to `127.0.0.1:0` — loopback only, ephemeral port.
- `db.query` never touches a database — recorded rowsets are returned in order.
- `fetch` / `http.request` never egress — recorded responses (including
  recorded timeouts/resets) are synthesized.
- `Math.random` / `crypto.randomUUID` replay the captured sequences; the clock
  is shifted to the incident's wall time.
- `recurr.auth()` returns the captured principal — production credentials are
  never needed (they were redacted before storage anyway).

The original request is injected over loopback HTTP, the replay produces its
own Execution Record, and the diff engine reports where it diverged.

### Diff

```bash
recurr diff RUN-KFE489 RPL-QCW44B
```

```
outcome   reproduced — same result as the original execution
match     100%
events    10 matched · 0 missing · 0 extra · 0 mismatched
timing    original 2.42s → replay 4.2ms (-99.8%)
```

After a fix, `statusChanged` reports the outcome flip — the incident becomes a
regression check: `recurr regression save <id> --name ...` then
`recurr regression run <name> -t "node dist/index-fixed.js"`.

## CLI

| Command | What it does |
|---|---|
| `recurr init` | create `.recurr/` config + local store |
| `recurr incidents` | list captured incidents |
| `recurr inspect <id>` | request, timeline, error, redaction report |
| `recurr replay <id> -t <cmd>` | isolated replay + diff report |
| `recurr diff <inc> <rpl>` | re-diff any stored pair |
| `recurr export/import` | move records between stores as JSON |
| `recurr regression save/list/run` | incidents → permanent test scenarios |
| `recurr doctor` | environment & store health check |

Store resolution: `--store` flag → `RECURR_STORE` env → `.recurr/config.json` →
`fs:.recurr/store`. Specs: `fs:<path>`, `postgres://…` / `pg:<conn>`,
`http(s)://<collector>`.

## Packages

| Package | Purpose |
|---|---|
| `@recurr/core` | Incident Record schema, redaction engine, execution diff |
| `@recurr/sdk` | Node.js capture & replay SDK (express middleware, db/http/determinism interception) |
| `@recurr/store` | `FileStore`, `PgStore` (migrations in `packages/store/migrations`), `HttpStore` |
| `@recurr/replay` | Replay orchestrator — spawn, inject, collect, diff |
| `@recurr/server` | Collector + query API (`recurr-server`) |
| `recurr` | CLI |
| `examples/checkout-demo` | End-to-end demo app |

## Self-hosting

```bash
docker compose up        # postgres + recurr-server on :4780
RECURR_STORE=http://localhost:4780 recurr incidents
```

Or point the server at Postgres directly:
`DATABASE_URL=postgres://… recurr-server` (migrations auto-apply on boot).

## Privacy & safety

- Redaction runs **in the SDK before persistence** — denylist fields
  (`authorization`, `cookie`, `password*`, `*token*`, `credit_card`, `ssn`, …),
  case/underscore-insensitive, plus custom `fields` and explicit `paths`.
- Auth replays use the captured *principal*, not the credential.
- Replay processes bind loopback-only on ephemeral ports; instrumented egress
  (`fetch`, `http(s)`, `db`) is served from the record — no production systems
  are touched.

## Known limitations (MVP scope)

- `import { request } from 'node:http'` snapshots the binding and escapes the
  monkeypatch — `fetch` (recommended) or method-style `http.request(...)` are
  intercepted.
- Request body capture relies on a body parser populating `req.body`
  (raw/stream bodies are not yet captured).
- Replay DB fidelity is "recorded rowsets in order" — not a materialized
  database snapshot. Lookahead matching tolerates small structural drift and
  emits `replay.note` divergences.
- Single-service replay; distributed multi-service replay is future work.

## Development

```bash
pnpm install
pnpm build     # turbo: builds all packages
pnpm test      # unit + e2e (spawns the demo, captures, replays, diffs)
pnpm demo      # scripted end-to-end walkthrough
```
