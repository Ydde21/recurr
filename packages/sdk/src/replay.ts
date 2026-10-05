import http from 'node:http';
import https from 'node:https';
import type { ExecutionRecord } from '@recurr/core';
import { installDateShift } from './patches/determinism.js';
import type { RecurrState } from './state.js';

/**
 * Replay-mode bootstrap, called by init() when RECURR_MODE=replay.
 *
 * 1. Load the source incident from the store.
 * 2. Shift the process clock to the original wall time.
 * 3. Hijack http(s).Server.listen — replay apps always bind 127.0.0.1:0
 *    (ephemeral loopback only) and announce the port to the orchestrator
 *    over IPC.
 */
export async function setupReplay(state: RecurrState, replayOf: string): Promise<void> {
  const source = await state.store.get(replayOf);
  if (!source) {
    throw new Error(`[recurr] replay source ${replayOf} not found in store`);
  }
  state.replaySource = source;
  installDateShift(source.seed.startedAtWallMs);
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
