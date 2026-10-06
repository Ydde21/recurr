# Recurr

**Run production incidents back locally.**

Recurr captures what actually happened when a request failed in production —
the request, the DB queries and their rows, the outbound HTTP calls and their
responses, the randomness, the clock, the error — into a structured **Incident
Record**. Then it rebuilds that execution inside an isolated local process so
you can replay it deterministically, diff original vs replay, and verify that
your fix actually fixes it.

```
production incident → capture → Incident Record → replay → diff → verify fix
```

Node.js only, single-service replay, self-hosted. Free and open source (MIT).

## Why it exists

A timeout in production is usually a *sequence*: request → user lookup →
product lookup → three retried calls to a payment API that hung →
`PaymentConfirmationTimeout` → 500. Logs give you the last line. Recurr gives
you the whole execution — captured, replayable, diffable.

| Without Recurr | With Recurr |
|---|---|
| Reconstruct prod state by hand | The record *is* the state — DB rowsets and HTTP responses replay verbatim |
| "Can't reproduce locally" | `recurr replay RUN-…` injects the recorded request into your real code |
| Did the fix work? shrug | `recurr regression run` exits non-zero until the bug stops reproducing |

## Try it in 60 seconds

```bash
git clone <this-repo> && cd recurr
pnpm install && pnpm build
pnpm demo
```

The demo needs nothing but Node ≥ 20 — it runs an embedded Postgres (pg-mem)
and a payment simulator locally. It walks the whole loop:

```
checkout-api (Express, instrumented)  →  POST /api/orders
  payment-sim hangs on orders > $500  →  PaymentConfirmationTimeout → HTTP 500
  recurr captures the incident        →  recurr replay reproduces it
  index-fixed.js returns 202          →  regression scenario proves the fix
```

Then open the debugging UI:

```bash
RECURR_STORE=fs:examples/checkout-demo/.recurr/store recurr-server
# → http://127.0.0.1:4780
```

Incidents → timeline → event inspector → replay → diff → divergence
investigation → regression scenario. The UI talks to the same store the CLI
uses; replays launched from the browser run through the same isolation and
diff engine as `recurr replay`.

## Install

Once published to npm:

```bash
npm install @recurr/sdk        # the capture/replay SDK (in your service)
npm install -g recurr          # the CLI
npm install -g @recurr/server  # optional: collector + browser UI
```

**Until the first npm release**, run from source — everything below works:

```bash
pnpm install && pnpm build
node packages/cli/dist/cli.js init        # or: pnpm link --global ./packages/cli
node packages/server/dist/bin.js          # recurr-server
```

To use the SDK from an external app before release, link the workspace:
run `npm link` inside `packages/core`, `packages/store`, and `packages/sdk`,
then `npm link @recurr/core @recurr/store @recurr/sdk` in your app.

## Instrument your service

Three lines of middleware plus optional DB instrumentation:

```ts
import { init } from '@recurr/sdk';

const recurr = await init({
  service: 'checkout-api',
  version: '1.8.2',
  capture: { on: 'error' },               // persist only failing executions
  redaction: { fields: ['x-internal-token'] },  // extra denylist fields
});

app.use(recurr.middleware());          // captures request/response/timeline
app.use(recurr.errorMiddleware());     // BEFORE your error handler
recurr.instrumentDb(pool);             // pg.Pool / pg.Client / pg-mem

// auth: captures the resolved principal — never the credential
const principal = await recurr.auth(req, verifyBearer);
```

In a project, `recurr init` writes `.recurr/config.json` and a gitignored
`.recurr/store/` — that's where Incident Records land. Per request, the SDK
records: the HTTP request/response, auth principal, `db.query` calls (text,
params, rows, timing), outbound `fetch`/`http.request` calls, `Math.random()` /
`crypto.randomUUID()` outputs, wall-clock start, errors, retries, and custom
events — scoped via `AsyncLocalStorage`, **redacted before persistence**.

## The workflow

```bash
recurr incidents                        # what's captured?
recurr inspect RUN-KFE489               # request, timeline, error, seed, redaction
recurr replay  RUN-KFE489 -t "node dist/index.js"        # reproduce it
recurr replay  RUN-KFE489 -t "node dist/index-fixed.js"  # verify the fix
recurr regression save RUN-KFE489 --name "payment timeout"
recurr regression run  "payment timeout" -t "node dist/index-fixed.js"  # CI gate
```

A replay against unchanged code prints:

```
outcome   reproduced — same result as the original execution
match     100%
events    10 matched · 0 missing · 0 extra · 0 mismatched
timing    original 2.42s → replay 4.2ms (-99.8%)
```

Against the fixed build the outcome flips (500 → 202), `statusChanged` reports
it, and `recurr regression run` exits 0 — or stays exit 1 while the bug still
reproduces, which is what makes it usable in CI.

## What replay actually does

`recurr replay` spawns your app with `RECURR_MODE=replay`. Inside that child:

- `listen()` (http/https/net) is forced to `127.0.0.1:0` — loopback, ephemeral.
- DB queries never reach a database — the recorded rowsets are returned in
  order, with lookahead matching for small structural drift.
- `fetch`/`http.request` never egress — recorded responses (including
  recorded timeouts/resets) are synthesized.
- `Math.random`/`crypto.randomUUID` replay the captured sequences; the clock
  is shifted to the incident's wall time. Over-consumption falls back to a
  deterministic PRNG and emits a `replay.note` divergence — never silently.
- `recurr.auth()` returns the captured principal — production credentials are
  never needed (the credential itself was redacted before storage).
- A socket-level guard blocks *un*instrumented egress too: raw `net`/`tls`/
  `dgram` sockets, DNS, `child_process`, `worker_threads`, native addon
  loading, and dangerous `process.binding` internals — plus a module-load
  blocklist so `import { execSync } from 'node:child_process'` fails at load
  time. The record store endpoint is the only permitted external target.
- The child exits when its orchestrator dies — even on SIGKILL — so replays
  can't orphan instrumented processes.

Then the original request is injected over loopback, the replay writes its
own Execution Record, and the diff engine reports every divergence —
including nondeterminism drift, recorded calls never made, and calls made
that were never recorded.

The result is honest: a replay that diverged says `diverged` or
`partially matched` with a score below 100 — it never reports success on a
mismatch.

## CLI reference

| Command | What it does |
|---|---|
| `recurr init [--service <name>]` | create `.recurr/` config + gitignored local store |
| `recurr incidents [--service] [--limit] [--json]` | list captured incidents |
| `recurr inspect <id> [--json]` | request, timeline, error, seed, redaction report |
| `recurr replay <id> -t <cmd> [--cwd] [--timeout] [--ready-timeout]` | isolated replay + diff report |
| `recurr diff <inc> <rpl> [--json]` | re-diff any stored pair |
| `recurr export <id> [-o file]` / `recurr import <file>` | move records between stores as JSON |
| `recurr regression save <id> --name <n>` | pin an incident as a scenario |
| `recurr regression list` / `run <idOrName> -t <cmd>` | run exits 1 while the bug reproduces |
| `recurr doctor` | node version, config file, store connectivity, collector health |

`recurr --help` prints the full typical-flow cheatsheet. Store resolution:
`--store` flag → `RECURR_STORE` env → `.recurr/config.json` → `fs:.recurr/store`.
Specs: `fs:<path>`, `postgres://…` / `pg:<conn>`, `http(s)://<collector>`.

## Self-hosting the server + UI

`recurr-server` is the collector + query API + UI host. Default port `4780`.

```bash
RECURR_STORE=fs:.recurr/store recurr-server        # filesystem store
DATABASE_URL=postgres://… recurr-server            # Postgres (migrations auto-apply)
```

Or with Docker (Postgres + server + UI in one shot):

```bash
docker compose up     # → http://127.0.0.1:4780, pg-backed, data in the pgdata volume
```

Point a CLI at a remote collector with `--store http://host:4780` or
`RECURR_STORE=http://…`. Instrumented services can write to it the same way
(`init({ store: 'http://…' })`).

## Security model — read this before exposing the server

**`recurr-server` has no authentication, and the replay endpoints
intentionally execute a caller-supplied command on the host.** That is the
product: a replay must run your code. Exposing the port to an untrusted
network is remote code execution for anyone who can reach it.

- Default safe posture: **localhost only**, or bound behind an authenticating
  reverse proxy / VPN. The UI and CLI assume this.
- Replay children are network-isolated (loopback-only listeners, egress
  guard, module blocklist) and env-sanitized (`*_KEY`, `*TOKEN*`, `*PASS*`,
  `DATABASE_URL`, proxy vars, cloud/kube/docker credentials are stripped;
  `target.env` cannot re-enable networking or `NODE_OPTIONS`).
- **Replay is not a formal sandbox.** Filesystem access is not sandboxed —
  replayed code keeps read/write to its working tree. Don't run untrusted
  replay targets on machines you care about.
- Redaction runs in the SDK *before* persistence: denylist fields
  (`authorization`, `cookie`, `password*`, `*token*`, `credit_card`, `ssn`,
  `session`, `csrf`, `jwt`, …) case/underscore-insensitive, plus custom
  `fields`/`paths`. Circular structures, `__proto__`, and URL userinfo are
  handled. The store should never contain raw secrets — treat a record as
  still sensitive and keep `.recurr/store` gitignored (init does this).
- Records imported or POSTed to the collector are schema-validated; unsafe
  ids can't traverse the filesystem store; `/healthz` redacts store-spec
  credentials; at most 4 replays run concurrently (extras get `429`).

Escape hatches for constrained environments (explicit and loud):
`RECURR_REPLAY_ALLOW_NET=1` disables the egress guard;
`RECURR_REPLAY_INHERIT_ENV=1` disables env sanitization.

## Compatibility

`recurr.middleware()` is connect-style `(req, res, next)`. Verified by
`packages/sdk/test/compat.test.ts`:

| Framework | Status | Notes |
|---|---|---|
| Express 4 | ✅ full | body via `express.json()`/`urlencoded()`/`raw()` |
| Fastify 5 + `@fastify/middie` | ✅ capture | `req.body` isn't populated in connect middleware — needs a preHandler or raw body |
| Koa 3 | ✅ capture via adapter | `app.use(async (ctx, next) => { await new Promise(r => mw(ctx.req, ctx.res, r)); await next(); })`; body needs `@koa/bodyparser`-style population |
| `node:http` raw | ✅ manual | call the middleware inside your handler |
| Hono / fetch-style | ❌ unsupported | no `(req,res,next)` mount — `Request`/`Response` bypasses `http.IncomingMessage` teeing |

DB instrumentation covers `pg.Pool`/`pg.Client`/`pg-mem` — anything else is
untouched. Replay DB fidelity is *recorded rowsets in order*, not a
materialized snapshot.

## Known limitations

- Named ESM imports of builtins snapshot bindings and escape monkeypatching
  (`import { request } from 'node:http'`). Default/namespace imports are
  intercepted; `fetch` is recommended.
- Request body capture needs a body parser populating `req.body`.
- Code in a fresh `vm` realm gets unpatched globals (very rare escape).
- If the record store shares host:port with a production dependency, the
  egress allowlist can't distinguish them — keep stores on separate endpoints.
- `responsePending: true` on an `http.out` event means the app never consumed
  the upstream body — headers/status recorded, body isn't (honest gap).
- `crypto.randomBytes`/`randomInt`/`randomFillSync`/`getRandomValues` aren't
  captured; replay draws deterministic PRNG bytes + emits `replay.note`.
- Native addons (`sharp`, `bcrypt` native, …) fail at replay — `dlopen` is
  blocked because uninstrumented native code would bypass isolation.
- `matchScore` counts events + outcome; a status/body/error divergence docks
  the score (a false 100% is impossible), clock-read drift is informational.
- Single-service replay; distributed multi-service replay is future work.
- Capture limits: bodies cap at 64 KiB (`maxBodyBytes`), records at 100k
  events / 1M seed values — over-limit bodies are flagged `truncated`, not
  silently clipped.

## Troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| `recurr incidents` is empty | Capture is `on: 'error'` by default — only failing requests persist. Check `recurr doctor` for store/config. |
| `replay failed: timed out waiting for recurr:ready` | The target didn't reach its `listen()` within `--ready-timeout` (default 20s; max 120s). Confirm the command starts the app (`-t "node dist/index.js"`, `--cwd` correct) and the app loads `@recurr/sdk` at startup. |
| `target exited (1)` / module load error at replay | The app imports a blocked module (`child_process`, `worker_threads`, `dgram`, `cluster`) or a native addon. Both are blocked by design — see Security model / Known limitations. |
| Replay can't write the record | The child needs to reach the store: `fs:` specs are absolutized automatically; for `pg:`/`http:` make sure the store is reachable from the replay host. `RECURR_STORE` is propagated to the child. |
| Egress blocked at replay | Expected — that's the isolation. Instrumented calls are served from the record; anything else must be mocked or moved behind `instrumentDb`/recorded HTTP. `RECURR_REPLAY_ALLOW_NET=1` opts out (loudly). |
| `no record RUN-…` / `404` | Wrong store — check `--store`/`RECURR_STORE`/`.recurr/config.json`. `recurr doctor` shows the resolved spec. |
| Port already in use | Server default is `4780` (`PORT` env overrides); demo uses `4790`/`4781`. |
| `docker compose up` serves API but no UI | Rebuild the image (`docker compose build`) — older images lack `packages/ui`. |
| Incident shows as diverged even unchanged | Check divergence kinds: `replay.note`/`seed-usage` drift is informational; `status`/`body`/`error` divergences dock the score. |

## Development

```bash
pnpm install
pnpm build       # turbo: all packages
pnpm test        # unit + compat + soak + replay e2e (spawns the demo)
pnpm demo        # scripted capture → replay → diff → fix walkthrough
pnpm --filter @recurr/ui dev   # UI dev server on :5179, proxies /v1 → :4780
```

Layout: `packages/{core,sdk,store,replay,server,ui,cli}` +
`examples/checkout-demo`. PgStore tests are opt-in
(`DATABASE_URL=postgres://… pnpm --filter @recurr/store test`). See
[CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for architecture
invariants.

## License

[MIT](LICENSE).
