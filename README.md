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
| `@recurr/ui` | Developer UI — incident inspection, replay launch, diff workspace |
| `recurr` | CLI |
| `examples/checkout-demo` | End-to-end demo app |

## Developer UI

`pnpm build` produces `packages/ui/dist`, which `recurr-server` serves
automatically at `/` (override with `RECURR_UI_DIR`). The API works standalone
regardless — the UI is optional.

The UI exposes the debugging workflow end-to-end: incident list (search /
service / env / status filters, sortable columns) → incident workspace
(request, response, error, auth principal, seed, redaction report) →
virtualized execution timeline with a per-event inspector and a derived
dependency graph → replay dialog → original-vs-replay diff (divergence list,
synchronized side-by-side timelines, body diff) → regression scenarios
(save from an incident, run against a target build, reports whether the bug
still reproduces).

Replays triggered from the UI run through the same orchestrator as the CLI —
same isolation, same diff engine (`POST /v1/incidents/:id/replays`,
`POST /v1/regressions/:id/run`). Both endpoints need a resolvable store spec
on the server (`RECURR_STORE`/`DATABASE_URL`/`fs:` path) and return 501
without one.

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
  outbound connections, DNS lookups, UDP sends, subprocesses, worker threads,
  native addon loading (`process.dlopen` / `.node` requires) and dangerous
  `process.binding`/`_linkedBinding` internals (`spawn_sync`, `tcp_wrap`, …).
- A `NODE_OPTIONS` preload blocklist refuses ESM/CJS module loads of the
  blocked subsystems (`node:child_process`, `node:worker_threads`, `node:dgram`,
  `node:cluster`) so even a static `import { execSync }` fails at load time.
- Sensitive env vars are not inherited by replay children (`*_KEY`, `*TOKEN*`,
  `*PASS*`, `*DSN*`, `DATABASE_URL`, proxy vars, cloud credentials, kube/docker
  config, …). A target-provided env can never override
  `RECURR_REPLAY_ALLOW_NET`, `RECURR_REPLAY_INHERIT_ENV`, or `NODE_OPTIONS`.
- Records imported via `recurr import` or posted to the collector are
  schema-validated; unsafe ids can't traverse the filesystem store.

## Framework compatibility

`recurr.middleware()` is connect-style `(req, res, next)`. Verified by the
compat suite (`packages/sdk/test/compat.test.ts`):

| Framework | Status | Notes |
|---|---|---|
| Express 4 | ✅ full | body via `express.json()`/`urlencoded()`/`raw()`; `errorMiddleware()` captures thrown/nexted errors |
| Fastify 5 + `@fastify/middie` | ✅ capture | `req.body` is NOT populated in connect middleware (Fastify keeps the parsed body on its own wrapper) — body capture needs a preHandler or the raw body |
| Koa 3 | ✅ capture via adapter | wrap: `app.use(async (ctx, next) => { await new Promise(r => mw(ctx.req, ctx.res, r)); await next(); })`; `req.body` needs `@koa/bodyparser`-style population |
| `node:http` raw | ✅ manual | call the middleware inside your request handler; thrown handlers abort the record honestly |
| Hono / fetch-style | ❌ unsupported | no `(req, res, next)` mount point — `Request`/`Response` objects bypass `http.IncomingMessage` teeing entirely |

Multipart/form bodies, binary bodies, URL-encoded forms and compressed
(gzip/deflate) responses are all verified — encoded/binary payloads store
base64, textual bodies store UTF-8.

## Capture limits & soak results

| Limit | Default | Behavior when exceeded |
|---|---|---|
| `maxBodyBytes` (init option) | 64 KiB | body clipped at a valid UTF-8 boundary; `redaction.truncatedPaths` records `request.body`/`response.body` honestly |
| `MAX_EVENTS` per record | 100,000 | `validateRecord` rejects; record fails safe |
| `MAX_SEED_VALUES` | 1,000,000 | same |

Soak suite (`packages/sdk/test/soak.test.ts`) exercises 100 KB / 1 MB / 10 MB
payloads, 40-request concurrent bursts, aborted clients mid-response, and
repeated captures: records stay bounded by `maxBodyBytes`, oversized bodies
are flagged truncated, aborted requests persist honest partial records,
concurrent records get unique ids with no seed/event cross-talk, and
`await recurr.flush()` does not return until in-flight requests persist.

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
- Dependencies that load native addons (`sharp`, `bcrypt` native, …) fail at
  replay — `process.dlopen` is blocked because uninstrumented native code
  would escape the sandbox entirely.
- `matchScore` measures events + outcome: a response status/body/error
  divergence docks the score once (it can't falsely report 100%), while the
  per-field divergences stay visible in the report.
- Filesystem access is not sandboxed — replayed code keeps read/write to the
  replay child's working tree. Run replays on machines you consider
  disposable for hostile-target scenarios.
- Single-service replay; distributed multi-service replay is future work.

## Development

```bash
pnpm install
pnpm build     # turbo: builds all packages
pnpm test      # unit + e2e (spawns the demo, captures, replays, diffs)
pnpm demo      # scripted end-to-end walkthrough
```
