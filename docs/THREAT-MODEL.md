# Threat model

What Recurr protects, what it deliberately does not, and what operators must
own. Read this before evaluating Recurr for a security-sensitive deployment.

## Assets at risk

| Asset | Where it lives |
|---|---|
| Incident records (request/response bodies, headers, DB rows, outbound HTTP traffic, error details) | The store (`fs:` dir, `pg:` database, or collector) — **contains production data** |
| Production credentials (env vars, API keys, DSNs) | The capturing process's environment |
| The replay host | Executes the target command |
| The collector's network surface | Whatever port it's bound to |
| npm package integrity | The registry → consumer's `node_modules` |

## Trust boundaries

1. **Production app ↔ store** — the SDK writes records shaped by live traffic.
2. **Collector ↔ network** — anyone who can reach the port can call `/v1/*`.
3. **Orchestrator ↔ replay child** — a replay runs the target's real code with recorded inputs.
4. **Supply chain** — the SDK runs inside the consumer's production request path.

## Controls in place

### Capture (SDK, in the production process)

- **Redaction before persistence.** Bodies/headers/values matching the sensitive
  denylist (case/format-insensitive, substring-aware) are replaced with
  `[REDACTED]` *before* the record is serialized — raw secrets never reach the
  store or disk. Operators extend it via `init({ redact: { fields } })`.
- **Bounded capture.** Bodies ≤ 64KB, strings ≤ 32KB, object graphs ≤ 50k nodes —
  hostile or malformed payloads can't turn redaction into a CPU DoS.
- **Observe-only in capture.** Patches record; they do not block egress, alter
  responses, or touch process behavior. Failure mode is a dropped incident,
  not a broken request.
- **Context isolation.** Instrumentation consults AsyncLocalStorage per
  request — capture state can't bleed between requests; SDK-internal I/O is
  explicitly excluded from records.
- **Opt-in surface.** Middleware applies only to routes it's mounted on.

### Collector (server)

- **Optional bearer auth** — `RECURR_TOKEN` requires `Authorization: Bearer`
  on every `/v1/*` route, compared in constant time. `/healthz` stays
  unauthenticated (it exposes only a redacted store spec — connection-string
  userinfo is stripped before it's returned or logged).
- **Input validation** — records are schema-validated; replay requests bound
  command/cwd/env sizes; record IDs must match a safe pattern before touching
  the filesystem; replay concurrency is capped (429 past 4 in-flight).
- **Body limit** — 25MB JSON cap.

### Replay (isolated child process)

- **Env sanitization** — keys/secrets/tokens/passwords/DSNs/proxies/cloud and
  agent credentials are stripped before spawn. `target.env` cannot re-enable
  networking (`RECURR_REPLAY_ALLOW_NET`) or env inheritance
  (`RECURR_REPLAY_INHERIT_ENV`) — those are dropped from caller-supplied env.
- **Network isolation** — listeners forced to `127.0.0.1:0`; raw sockets, DNS,
  `dgram`, `child_process`, `worker_threads`, `cluster`, native addons, and
  dangerous `process.binding` internals are refused at the module boundary.
  The only allowed egress is the store endpoint.
- **Static preflight** — known-unreplayable targets (framework launchers,
  unconditional blocked-builtin imports) fail before spawn.
  `RECURR_REPLAY_SKIP_PREFLIGHT=1` bypasses detection but **not** the runtime
  isolation.
- **Process lifetime** — the child is killed if the orchestrator exits;
  `disconnect` from IPC self-terminates it.
- **Header sanitization on injection** — hop-by-hop and stored credential
  headers are not replayed verbatim.

## Explicit non-guarantees

These are documented boundaries, not bugs — design around them:

- **Replay is not a filesystem sandbox.** Replayed code keeps read/write
  access to its working tree. Do not run untrusted targets on machines you
  care about.
- **Redaction is a denylist, not a guarantee.** Secrets under field names the
  denylist doesn't recognize survive. Operators must verify captured records
  against their own data shapes and add custom `redact.fields`.
- **Records may contain PII.** Bodies and DB rows are stored verbatim
  (post-redaction). The store is a sensitive datastore — encrypt at rest,
  restrict access, set retention. Replaying moves that data to the replay
  host; treat compliance implications accordingly.
- **The collector is not internet-facing.** Even with `RECURR_TOKEN`, the
  replay endpoint executes caller-supplied commands — it is RCE by design for
  anyone who authenticates. Run it on localhost, a private subnet, or behind
  an authenticating/TLS-terminating proxy. Never naked on the public internet.
- **Store specs embed credentials.** `pg:postgres://user:pass@…` and
  `RECURR_TOKEN` are secrets — same hygiene as `DATABASE_URL`.
- **Capture overhead.** Per-request ALS tracking + body buffering is nonzero
  cost — load-test before enabling on high-throughput routes.

## Supply chain

- Releases are published by CI from signed-off tags with npm **provenance**
  (`publish.yml`) — each npm artifact attests to the exact repo commit that
  built it. Verify at `https://www.npmjs.com/package/@recurr-dev/cli#provenance`
  or `npm audit signatures`.
- Packages ship no install scripts and a minimal dependency tree — review the
  `dependencies` block on any registry page.
- Pin versions and review diffs on upgrade, as with any production dependency.
- `pnpm publish` (not `npm publish`) is required — npm ships `workspace:*`
  literally, producing uninstallable artifacts.

## Reporting

Report vulnerabilities privately via GitHub's private vulnerability reporting
on this repository — see `SECURITY.md`. Do not open public issues for
exploitable findings.
