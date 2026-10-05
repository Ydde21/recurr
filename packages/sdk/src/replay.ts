import http from 'node:http';
import https from 'node:https';
import { validateRecord, type ExecutionRecord } from '@recurr/core';
import { setReplayOffset } from './patches/determinism.js';
import { installReplayIsolation } from './patches/isolation.js';
import { envConfig } from './config.js';
import type { RecurrState } from './state.js';

/** The record store must stay reachable for saves — pg:/http: store specs
 *  resolve to an allowlisted host:port; everything else stays sealed. */
function storeTargets(spec: string): string[] {
  try {
    const pgUrl = spec.startsWith('pg:') ? spec.slice(3) : /^postgres(ql)?:/.test(spec) ? spec : undefined;
    if (pgUrl !== undefined) {
      const u = new URL(pgUrl);
      return [`${u.hostname}:${u.port || '5432'}`];
    }
    if (spec.startsWith('http:') || spec.startsWith('https:')) {
      const u = new URL(spec);
      return [`${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`];
    }
  } catch {
    /* malformed spec — nothing allowed */
  }
  return [];
}

/**
 * Replay-mode bootstrap, called by init() when RECURR_MODE=replay.
 *
 * 1. Load the source incident from the store (following replayOf chains so a
 *    replay record passed as the source resolves to the original incident).
 * 2. Shift the process clock to the original wall time.
 * 3. Install the egress guard — no outbound sockets, DNS, or subprocesses.
 * 4. Hijack http(s).Server.listen — replay apps always bind 127.0.0.1:0
 *    (ephemeral loopback only) and announce the port to the orchestrator
 *    over IPC.
 */
export async function setupReplay(state: RecurrState, replayOf: string): Promise<void> {
  let source = await state.store.get(replayOf);
  if (!source) {
    throw new Error(`[recurr] replay source ${replayOf} not found in store`);
  }
  // A replay record handed in as the source resolves to the original incident —
  // its captured seed/events are the meaningful ones, not the replay's.
  let hops = 0;
  while (source.kind === 'replay' && source.replayOf) {
    const parent = await state.store.get(source.replayOf);
    if (!parent || hops++ > 16) break;
    source = parent;
  }
  // Records from a shared store are untrusted — refuse malformed input before
  // we let it steer replay behavior.
  const v = validateRecord(source);
  if (!v.ok) {
    throw new Error(`[recurr] replay source ${source.id} fails validation: ${v.error}`);
  }
  state.replaySource = source;
  installReplayIsolation({ allowHosts: storeTargets(envConfig().storeSpec) });
  setReplayOffset(source.seed.startedAtWallMs);
  installReplayListen();
}

let listenPatched = false;
let announced = false;

function installReplayListen(): void {
  if (listenPatched) return;
  listenPatched = true;
  for (const proto of [http.Server.prototype, https.Server.prototype]) {
    const orig = proto.listen;
    proto.listen = function patchedListen(this: http.Server, ...args: unknown[]) {
      const cb = args.find((a): a is () => void => typeof a === 'function');
      const server = this;
      const origFn = orig as (...a: unknown[]) => unknown;
      return origFn.call(this, 0, '127.0.0.1', function () {
        if (!announced) {
          announced = true;
          const addr = server.address();
          const port = typeof addr === 'object' && addr ? addr.port : undefined;
          if (typeof process.send === 'function' && port) {
            try {
              process.send({ type: 'recurr:ready', port });
            } catch {
              /* parent gone */
            }
          }
        }
        cb?.call(server);
      });
    } as typeof proto.listen;
  }
}
