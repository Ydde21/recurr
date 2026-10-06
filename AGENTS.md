# Recurr — agent notes

Production incident replay platform (pnpm + Turbo monorepo, TypeScript ESM,
NodeNext). Name is "Recurr" — packages `@recurr/*`, CLI binary `recurr`.

## Commands

- `pnpm install` — pnpm lives at `~/.local/bin/pnpm` (corepack can't write
  /usr/local/bin on this machine).
- `pnpm build` / `pnpm test` — turbo pipelines; `test` depends on `build`
  because the e2e spawns the compiled demo (`examples/checkout-demo/dist`).
- `pnpm demo` (root) or `node scripts/demo.mjs` in `examples/checkout-demo` —
  full scripted capture→replay→diff→fix-verification walkthrough.
- `packages/ui` — React+Vite developer UI; `pnpm --filter @recurr/ui dev` for
  local dev (proxies `/v1`+`/healthz` to :4780). `recurr-server` serves
  `packages/ui/dist` at `/` when built (`RECURR_UI_DIR` overrides).

## Architecture invariants

- All runtime interception consults `AsyncLocalStorage` context first —
  capture/replay must never pollute requests outside an incident context.
- Redaction happens **before persistence** in the SDK (see
  `packages/core/src/redact.ts`); stored records must never contain raw
  secrets.
- Replay mode (`RECURR_MODE=replay`): `listen` (http/https/net servers) is
  forced to `127.0.0.1:0`, all instrumented egress is served from the record —
  never dial production. `patches/isolation.ts` additionally blocks
  uninstrumented egress (raw sockets, DNS, dgram, child_process, workers),
  native addon loading (`process.dlopen`, `.node` requires) and dangerous
  `process.binding`/`_linkedBinding` internals (`spawn_sync`, `tcp_wrap`, …);
  the store endpoint (pg:/http(s): spec) is the only allowlisted target.
  A `NODE_OPTIONS` preload (`packages/replay/dist/replay-preload.mjs`)
  blocklists ESM loads of `child_process`/`worker_threads`/`dgram`/`cluster`
  so static named imports can't escape. Escape hatches:
  `RECURR_REPLAY_ALLOW_NET`, `RECURR_REPLAY_INHERIT_ENV`.
- Store I/O runs outside the request ALS context (`als.exit`) so SDK-internal
  randomness/time/HTTP never pollutes the record.
- Parent↔child IPC: `recurr:ready` `{port}` then `recurr:done` `{id}`.
  The preload exits the child on `disconnect` — a replay child must never
  outlive the orchestrator (SIGKILL skips the parent's exit handlers).
- Event kinds: `http.in`, `db.query`, `http.out`, `error`, `retry`, `log`,
  `custom`, `replay.note` (self-reported replay divergences).

## Testing

- CI: `.github/workflows/ci.yml` — node from `.nvmrc`, `pnpm install
  --frozen-lockfile` → `pnpm build` → `pnpm test`; pg job runs
  `@recurr/store` tests against a services-container postgres (opt-in
  locally, isolated in CI).
- Unit: `packages/*/test/*.test.ts` (vitest).
- Compat: `packages/sdk/test/compat.test.ts` — express/fastify+middie/koa
  adapter/raw node:http (Hono/fetch-style: unsupported, documented in README).
- Soak: `packages/sdk/test/soak.test.ts` — 100KB/1MB/10MB payloads, concurrent
  bursts, aborted requests, `flush()` in-flight semantics.
- Security e2e: `packages/replay/test/security.test.ts` — hostile fixture
  asserts every escape path is blocked at replay.
- E2E: `packages/replay/test/e2e.test.ts` — spawns real demo processes.
- Ports used by tests/demo: 4781/4790 (demo), 14781/14790 (e2e), 4780 (server).
- PgStore tests are opt-in: `DATABASE_URL=postgres://… pnpm --filter @recurr/store test`.
- NOTE: `await import('node:<builtin>')` yields namespace bindings that are
  pre-patch snapshots — use `.default` or `require()` to hit patched exports.
