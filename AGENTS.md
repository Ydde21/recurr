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
- Replay mode (`RECURR_MODE=replay`): `listen` is forced to `127.0.0.1:0`, all
  instrumented egress is served from the record — never dial production.
- Parent↔child IPC: `recurr:ready` `{port}` then `recurr:done` `{id}`.
- Event kinds: `http.in`, `db.query`, `http.out`, `error`, `retry`, `log`,
  `custom`, `replay.note` (self-reported replay divergences).

## Testing

- Unit: `packages/*/test/*.test.ts` (vitest).
- E2E: `packages/replay/test/e2e.test.ts` — spawns real demo processes.
- Ports used by tests/demo: 4781/4790 (demo), 14781/14790 (e2e), 4780 (server).
