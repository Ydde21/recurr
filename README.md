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

- `listen()` is hijacked to `127.0.0.1:0` — loopback only, ephemeral port
  (covers `http`, `https` and raw `net` servers).
- A hard egress guard refuses outbound `net`/`tls`/`dgram` sockets, DNS
  lookups, `child_process` spawns and `worker_threads` — instrumented and
  *un*instrumented egress alike. Only the record store endpoint
  (`pg:`/`http(s):` spec) stays reachable so the replay record can persist.
- `db.query` never touches a database — recorded rowsets are returned in
  order. `pool.connect()` returns a synthetic client.
- `fetch` / `http.request` never egress — recorded responses (including
  recorded timeouts/resets) are synthesized.
- `Math.random` / `crypto.randomUUID` replay the captured sequences; the clock
  is shifted to the incident's wall time. Over-consumption falls back to a
  deterministic PRNG *and* emits a `replay.note` divergence — never silently.
- `recurr.auth()` returns the captured principal — production credentials are
  never needed (they were redacted before storage anyway). Environment
  variables matching `key|secret|token|passw|credential|dsn|…` are stripped
  from the child.

The original request is injected over loopback HTTP, the replay produces its
own Execution Record, and the diff engine reports where it diverged —
including nondeterminism usage drift, recorded calls the replay never made,
and calls the replay made that were never recorded.

Escape hatches (explicit, for constrained environments):
`RECURR_REPLAY_ALLOW_NET=1` disables the egress guard;
`RECURR_REPLAY_INHERIT_ENV=1` disables env sanitization.

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
  (`authorization`, `cookie`, `password*`, `*token*`, `credit_card`, `ssn`,
  `session`, `csrf`, `jwt`, …), case/underscore-insensitive, plus custom
  `fields` and explicit `paths`. Circular structures, `__proto__` keys and
  URL userinfo (`user:pass@host`) are handled safely.
- Auth replays use the captured *principal*, not the credential.
- Replay processes bind loopback-only on ephemeral ports; instrumented egress
  (`fetch`, `http(s)`, `db`) is served from the record — no production systems
  are touched. A socket-level egress guard also refuses uninstrumented
  outbound connections, DNS lookups, subprocesses and workers.
- Sensitive env vars are not inherited by replay children.
- Records imported via `recurr import` or posted to the collector are
  schema-validated; unsafe ids can't traverse the filesystem store.

## Known limitations (MVP scope)

- Named ESM imports of builtins snapshot the binding and escape monkeypatching
  (`import { request } from 'node:http'`, `import { randomUUID } from
  'node:crypto'`). Default/namespace-style `import http from 'node:http'` and
  `http.request(...)` are intercepted; `fetch` is recommended.
- Request body capture relies on a body parser populating `req.body`
  (raw/stream bodies are not yet captured).
- Replay DB fidelity is "recorded rowsets in order" — not a materialized
  database snapshot. Lookahead matching tolerates small structural drift and
  emits `replay.note` divergences.
- Code executed inside a *fresh* `vm` realm gets unpatched globals — very
  rare, but such code would bypass interception.
- If the record store shares a host:port with a production dependency (e.g.
  the same Postgres server is both store and app DB), the egress allowlist
  can't distinguish them at socket level — keep them on separate endpoints.
- An `http.out` event carrying `responsePending: true` means the app never
  consumed the upstream response body — headers/status are recorded, the body
  isn't (capture gap, surfaced honestly rather than shown as an empty body).
- Clock-read counts (`seed.timeReads`) are reported as informational drift —
  infrastructure-level `Date.now()` calls legitimately differ between live and
  mocked dependencies and don't lower the match score.
- `crypto.randomBytes` / `randomInt` / `randomFillSync` / `getRandomValues`
  are not captured. At replay they draw deterministic bytes from the
  record-seeded PRNG and emit a `replay.note` divergence rather than
  silently producing real entropy.
- Single-service replay; distributed multi-service replay is future work.

## Development

```bash
pnpm install
pnpm build     # turbo: builds all packages
pnpm test      # unit + e2e (spawns the demo, captures, replays, diffs)
pnpm demo      # scripted end-to-end walkthrough
```
