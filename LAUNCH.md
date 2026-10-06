# Launch kit — Recurr v0.1.x

## Show HN draft

**Show HN: Recurr – capture a production incident, replay it locally, diff it against your fix**

Recurr turns a real production failure into a self-contained Incident Record
(the request, every DB query with rowsets, every outbound HTTP call, RNG/clock
seed, the error) — then replays your code against it in an isolated sandbox:
no egress, deterministic entropy, recorded responses served back.

The loop: `capture → replay → fix → replay again → honest diff → save as a
regression`. A regression check exits 1 while the bug still reproduces and 0
once your fix lands.

It's not a demo script — after publishing to npm I pointed it at two real
projects:

- A **Hono API** (auth, connectors, sync pipeline): ~25 lines of
  server-boundary wrap captured real traffic; replayed authenticated routes
  reproduce exactly — the recorded principal stands in for the redacted
  credential.
- A **Next.js app**: capture works and even records the rewrite-proxy hop to
  the backend (timing + body) — but replay can't work there, and the README
  now says so: frameworks that boot-load `child_process`/workers trip the
  replay sandbox's module blocklist. Capture-only, by design.

Honest limits: single-service replay, recorded-rowset DB fidelity (not a
snapshot), Node-only, Express/Fastify/Koa/raw-http/Hono-node-server adapters,
no auth on the collector (localhost or behind a proxy), native addons blocked.

`npm i @recurr-dev/sdk @recurr-dev/cli` — github.com/Ydde21/recurr

## GIF recipe (~5 min)

```bash
brew install asciinema agg        # or: cargo install agg
cd ~/Projects/Recurr
asciinema rec -c 'pnpm demo' demo.cast
agg --speed 1.5 --font-size 16 demo.cast docs/demo.gif
```

`pnpm demo` runs the scripted checkout-demo flow: capture → inspect → replay
(bug reproduces) → diff → regression → fixed-build verification. ~60–90s.

Even better material — the real-app capture on Synqra (record this instead
of / in addition to the demo):

```bash
cd ~/Projects/Synqra/apps/api && npx tsx src/index-recurr.ts   # one terminal
# another: hit /api/auth/dev, /api/connections/facebook/connect, /api/sync
npx recurr incidents --store fs:.recurr/store
npx recurr inspect <RUN-…> --store fs:.recurr/store
npx recurr replay <RUN-…> --store fs:.recurr/store -t "node dist-recurr/index.mjs"
```

Then drop `docs/demo.gif` into the README under "Try it in 60 seconds".

## Checklist before posting

- [ ] GIF recorded + committed to `docs/` + README embed
- [ ] Repo topics verified (done): incident-replay, debugging, observability…
- [ ] Post at ~8–10am ET weekday; first comment = the honest-limits paragraph
- [ ] npm: `npm i @recurr-dev/sdk` instructions are live in README (done)
