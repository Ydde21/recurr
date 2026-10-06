# Contributing to Recurr

Thanks for digging in. Recurr is a pnpm + Turbo monorepo in strict TypeScript
(ESM, NodeNext). Requirements: **Node ≥ 20**, **pnpm 9.x** (`corepack enable`
or `npm i -g pnpm@9`).

## Setup

```bash
pnpm install
pnpm build        # builds all packages via turbo
pnpm test         # unit + compat + soak + replay e2e — must stay green
pnpm demo         # scripted end-to-end walkthrough (the fastest sanity check)
```

`pnpm test` depends on `build` — the replay e2e spawns the compiled demo app.
PgStore integration tests are opt-in:
`DATABASE_URL=postgres://… pnpm --filter @recurr/store test`.

## Repository layout

| Path | What it is |
|---|---|
| `packages/core` | Incident Record schema, validation, redaction, diff engine |
| `packages/sdk` | Capture/replay SDK — middleware, db/http/determinism interception |
| `packages/store` | `FileStore`, `PgStore` (+`migrations/`), `HttpStore` |
| `packages/replay` | Replay orchestrator — spawn, isolate, inject, collect, diff |
| `packages/server` | Collector + query API (`recurr-server`) + UI host |
| `packages/ui` | React+Vite developer UI (incident → replay → diff → regression) |
| `packages/cli` | `recurr` CLI |
| `examples/checkout-demo` | End-to-end demo app with an intentional bug |

## Development workflow

- UI dev server: `pnpm --filter @recurr/ui dev` (Vite on :5179, proxies
  `/v1` + `/healthz` to `RECURR_API` or `127.0.0.1:4780`).
- Server: `RECURR_STORE=fs:examples/checkout-demo/.recurr/store recurr-server`
  (or `node packages/server/dist/bin.js`) — serves the API and, once built,
  `packages/ui/dist` at `/`.
- Per-package work: `pnpm --filter @recurr/<pkg> build|test`.
- Ports to keep free for tests/demo: 4780 (server), 4781/4790 (demo),
  14781/14790 (e2e).

## The rules that matter

The architecture invariants live in [AGENTS.md](AGENTS.md) — read them before
touching `sdk`/`replay`/`store`. The short version:

- Runtime interception consults `AsyncLocalStorage` first — never pollute
  requests outside an incident context.
- Redaction happens **before persistence**. Stored records must never contain
  raw secrets.
- Replay never dials production. The store endpoint is the only permitted
  egress target; the sandbox guardrails aren't optional for targets.
- A replay child must never outlive its orchestrator.
- Stay honest: report capture gaps (`truncatedPaths`, `responsePending`) and
  divergence uncertainty instead of claiming clean matches.

## Making changes

- Match the existing style — compact TS, no stray comments, error paths that
  fail safe and say so.
- Keep diffs focused; don't reformat unrelated code.
- New dependencies need a reason; prefer versions >7 days old.
- Tests: unit tests per package in `test/*.test.ts` (vitest). If you change
  capture/replay semantics, the compat/soak/security suites are the contract —
  extend them rather than weakening an assertion.
- Never commit secrets, captured records, or `.recurr/store` contents (it's
  gitignored for a reason).

## Releasing (maintainers)

All publishable packages carry `publishConfig.access: public`. With
`pnpm publish -r`, `workspace:*` deps are rewritten to real versions — verify
`pnpm pack` contents (`files` whitelist: `dist`, plus `migrations` for store)
before pushing to npm.
