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

## Architecture invariants

- All runtime interception consults `AsyncLocalStorage` context first —
  capture/replay must never pollute requests outside an incident context.
- Redaction happens **before persistence** in the SDK (see
  `packages/core/src/redact.ts`); stored records must never contain raw
  secrets.
- Replay mode (`RECURR_MODE=replay`): `listen` (http/https/net servers) is
  forced to `127.0.0.1:0`, all instrumented egress is served from the record —
  never dial production. `patches/isolation.ts` additionally blocks
  uninstrumented egress (raw sockets, DNS, dgram, child_process, workers);
  the store endpoint (pg:/http(s): spec) is the only allowlisted target.
  Escape hatches: `RECURR_REPLAY_ALLOW_NET`, `RECURR_REPLAY_INHERIT_ENV`.
- Store I/O runs outside the request ALS context (`als.exit`) so SDK-internal
  randomness/time/HTTP never pollutes the record.
- Parent↔child IPC: `recurr:ready` `{port}` then `recurr:done` `{id}`.
- Event kinds: `http.in`, `db.query`, `http.out`, `error`, `retry`, `log`,
  `custom`, `replay.note` (self-reported replay divergences).

## Testing

- Unit: `packages/*/test/*.test.ts` (vitest).
- E2E: `packages/replay/test/e2e.test.ts` — spawns real demo processes.
- Ports used by tests/demo: 4781/4790 (demo), 14781/14790 (e2e), 4780 (server).
- PgStore tests are opt-in: `DATABASE_URL=postgres://… pnpm --filter @recurr/store test`.
- NOTE: `await import('node:<builtin>')` yields namespace bindings that are
  pre-patch snapshots — use `.default` or `require()` to hit patched exports.
