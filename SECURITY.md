# Security Policy

## What Recurr is — and the boundary that matters

Recurr captures production execution context and replays it locally. Two parts
of that design have security consequences that must be understood before
deploying or reporting:

### 1. `recurr-server` executes caller-supplied commands

`POST /v1/incidents/:id/replays` and `POST /v1/regressions/:id/run` run a
`command` field on the host — that is the product's core function. **The
server has no authentication.** Anyone who can reach the port can execute
commands.

Safe posture: bind to localhost (the default mental model), run it on a
developer machine or CI worker, or place it behind an authenticating reverse
proxy / VPN. Never expose `recurr-server` to an untrusted network. A report
that says "the replay endpoint runs commands" is the documented design — a
report that shows how to *reach* that endpoint where it should have been
inaccessible, or to escape its validations, is a vulnerability.

### 2. Replay isolation is not a formal sandbox

Replay children get real protections — loopback-only listeners, a
socket-level egress guard, a module-load blocklist (`child_process`,
`worker_threads`, `dgram`, `cluster`), env sanitization (credentials/keys/
tokens/DSNs stripped; `RECURR_*` escape hatches and `NODE_OPTIONS` can't be
overridden by target env), recorded-dependency answers instead of real
egress, and guaranteed child termination when the orchestrator dies.

But **filesystem access is not sandboxed** — replayed code keeps read/write
to its working tree, and process-level isolation is not a VM boundary. Run
replays of code you control, or on machines you consider disposable. The
store endpoint remains reachable (it has to be), so keep it on a separate
endpoint from production dependencies.

### 3. Stored records hold sensitive-shape data

The SDK redacts credentials before persistence (denylist fields + custom
`fields`/`paths`; auth stores the resolved *principal*, not the credential).
Treat records as sensitive anyway: `.recurr/store` is gitignored on `init`,
and records exported/shared for review should be scrubbed first.

## Reporting a vulnerability

This project has no dedicated security contact or bug-bounty program yet —
it's a single-maintainer open-source project. **Preferred channel: GitHub
private vulnerability reporting** — open a private security advisory at
github.com/Ydde21/recurr → Security → Advisories → "Report a vulnerability".
That keeps the report confidential until a fix lands.

For non-sensitive issues, the normal issue tracker is fine. Either way,
**do not attach exploit payloads, captured records containing real data,
or live credentials** to any report.

Please include: affected component (`sdk`/`replay`/`server`/`store`/`cli`/
`ui`), what escaped or what isolation guarantee failed, the smallest
reproduction you can share, and the Recurr version/commit.

## Scope notes

- Escape-path bugs are in scope: a replay child making real egress, loading a
  blocked module, inheriting a stripped credential, or surviving its
  orchestrator is a real vulnerability report.
- "A hostile replay command can run code" is not — that's the documented
  feature; the boundary is network exposure, not the replay sandbox.
- Redaction misses (a credential-shaped field that survives into a stored
  record despite the denylist) are in scope.
