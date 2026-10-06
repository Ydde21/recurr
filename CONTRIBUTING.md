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
`DATABASE_URL=postgres://… pnpm --filter @recurr-dev/store test`.

## Repository layout

| Path | What it is |
|---|---|
| `packages/core` | Incident Record schema, validation, redaction, diff engine |
| `packages/sdk` | Capture/replay SDK — middleware, db/http/determinism interception |
| `packages/store` | `FileStore`, `PgStore` (+`migrations/`), `HttpStore` |
| `packages/replay` | Replay orchestrator — spawn, isolate, inject, collect, diff |
| `packages/server` | Collector + query API (`recurr-server`) + UI host |
| `packages/ui` | React+Vite developer UI (incident → replay → diff → regression) |
| `packages/cli` | `@recurr-dev/cli` — the `recurr` binary |
| `examples/checkout-demo` | End-to-end demo app with an intentional bug |

## Development workflow

- UI dev server: `pnpm --filter @recurr-dev/ui dev` (Vite on :5179, proxies
  `/v1` + `/healthz` to `RECURR_API` or `127.0.0.1:4780`).
- Server: `RECURR_STORE=fs:examples/checkout-demo/.recurr/store recurr-server`
  (or `node packages/server/dist/bin.js`) — serves the API and, once built,
  `packages/ui/dist` at `/`.
- Per-package work: `pnpm --filter @recurr-dev/<pkg> build|test`.
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

All publishable packages carry `publishConfig.access: public` and are
versioned in lockstep — currently `0.1.x` (`@recurr-dev/cli` is a patch ahead
at 0.1.2 for a `--version` fix), which is honest for the first
public release (pre-1.0 signals the API may evolve). `pnpm pack`/`publish`
rewrites `workspace:*` deps to the real version — verified via tarball
inspection.

Prerequisites (not in the repo): push access to the git remote, an npm
account with publish rights to the `@recurr-dev` scope (or create the org), and
`npm login`.

```bash
# 1. clean checkout, everything green
git checkout main && git pull
pnpm install --frozen-lockfile && pnpm build && pnpm test

# 2. sanity-check the tarballs (what will actually ship)
for p in core sdk store replay server cli; do
  (cd packages/$p && pnpm pack --pack-destination /tmp/recurr-pack)
done

# 3. bump versions together, commit, tag
#    (edit every package.json "version" — no release bot yet)

# 4. publish — pnpm rewrites workspace:* → pinned versions
pnpm -r publish --no-git-checks

# 5. docker image: docker compose build && docker compose up -d
```

The CLI publishes as `@recurr-dev/cli` (the unscoped `recurr` name was already
taken on npm by an unrelated package); the installed binary is still `recurr`.
`@recurr-dev/ui` is `private` and ships inside `@recurr-dev/server`/`Dockerfile.server`,
not to npm.
