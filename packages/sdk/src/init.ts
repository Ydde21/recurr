import { createRedactor } from '@recurr-dev/core';
import { openStore, type IncidentStore } from '@recurr-dev/store';
import { als, pushEvent } from './context.js';
import { envConfig, type RecurrConfig } from './config.js';
import { createErrorMiddleware, createMiddleware } from './middleware.js';
import { instrumentDb, type Queryable } from './patches/db.js';
import { installDeterminism } from './patches/determinism.js';
import { installHttpPatches } from './patches/http.js';
import { setupReplay } from './replay.js';
import type { RecurrState } from './state.js';

export interface Recurr {
  /** Express/connect middleware — mount once per app, before routes. */
  middleware(): (req: unknown, res: unknown, next: (err?: unknown) => void) => void;
  /** Express error middleware — mount BEFORE your own error handler so errors land in the record. */
  errorMiddleware(): (err: unknown, req: unknown, res: unknown, next: (err?: unknown) => void) => void;
  /**
   * Instrument a queryable (pg.Pool, pg.Client, pg-mem adapter, …) so its
   * queries are captured — and replayed — automatically.
   */
  instrumentDb<T extends Queryable>(db: T, opts?: { system?: string }): T;
  /**
   * Resolve the request's principal. In capture mode calls `verify()` and
   * records the result (redacted). In replay mode returns the principal
   * captured during the original execution — credentials never needed.
   */
  auth<T>(req: { headers?: Record<string, string | string[] | undefined> }, verify: () => Promise<T | null> | T | null): Promise<T | null>;
  /** Push a custom event onto the current execution timeline. */
  recordEvent(name: string, data?: Record<string, unknown>, kind?: 'custom' | 'retry' | 'log'): void;
  /** True while this process is replaying an incident. */
  isReplay(): boolean;
  /** Drain in-flight record saves (await before shutdown in tests/short-lived procs). */
  flush(): Promise<void>;
  readonly store: IncidentStore;
  readonly config: RecurrConfig;
}

export async function init(config: RecurrConfig): Promise<Recurr> {
  const env = envConfig();
  const store =
    typeof config.store === 'string' ? openStore(config.store) : (config.store ?? openStore(env.storeSpec));
  const redactor = createRedactor(config.redaction);
  const state: RecurrState = {
    cfg: config,
    mode: env.mode,
    store,
    redactor,
    pending: new Set(),
    inflight: 0,
  };

  if (env.mode !== 'off') {
    installDeterminism();
    installHttpPatches();
  }
  if (env.mode === 'replay') {
    if (!env.replayOf) throw new Error('[recurr] RECURR_MODE=replay requires RECURR_REPLAY_OF=<incident id>');
    try {
      await setupReplay(state, env.replayOf);
    } catch (err) {
      // Give the orchestrator a structured failure before we throw.
      if (typeof process.send === 'function') {
        try {
          process.send({ type: 'recurr:init-error', message: err instanceof Error ? err.message : String(err) });
        } catch {
          /* parent gone */
        }
      }
      throw err;
    }
  }

  return new RecurrHandle(state);
}

class RecurrHandle implements Recurr {
  readonly config: RecurrConfig;
  readonly store: IncidentStore;

  constructor(private readonly state: RecurrState) {
    this.config = state.cfg;
    this.store = state.store;
  }

  middleware(): (req: unknown, res: unknown, next: (err?: unknown) => void) => void {
    return createMiddleware(this.state) as unknown as (req: unknown, res: unknown, next: (err?: unknown) => void) => void;
  }

  errorMiddleware(): (err: unknown, req: unknown, res: unknown, next: (err?: unknown) => void) => void {
    return createErrorMiddleware(this.state) as unknown as (err: unknown, req: unknown, res: unknown, next: (err?: unknown) => void) => void;
  }

  instrumentDb<T extends Queryable>(db: T, opts?: { system?: string }): T {
    return instrumentDb(db, opts);
  }

  async auth<T>(req: { headers?: Record<string, string | string[] | undefined> }, verify: () => Promise<T | null> | T | null): Promise<T | null> {
    const ctx = als.getStore();
    if (ctx?.mode === 'replay') {
      return (ctx.replaySource?.auth?.principal as T) ?? null;
    }
    const principal = await verify();
    if (ctx && principal !== undefined) {
      const r = ctx.redactor.redactValue(principal, 'auth.principal');
      ctx.redactionHits.push(...r.hits);
      const authz = req.headers?.authorization ?? req.headers?.Authorization;
      ctx.auth = {
        principal: r.value,
        scheme: typeof authz === 'string' && authz.startsWith('Bearer ') ? 'bearer' : undefined,
      };
    }
    return principal;
  }

  recordEvent(name: string, data?: Record<string, unknown>, kind: 'custom' | 'retry' | 'log' = 'custom'): void {
    const ctx = als.getStore();
    if (!ctx) return;
    pushEvent(ctx, kind, { name, data });
  }

  isReplay(): boolean {
    return this.state.mode === 'replay';
  }

  async flush(): Promise<void> {
    // Drain until stable — record saves are queued from async finalize chains
    // and requests can still be mid-flight when flush is called.
    while (this.state.pending.size > 0 || this.state.inflight > 0) {
      await Promise.allSettled([...this.state.pending]);
      await new Promise((r) => setImmediate(r));
    }
  }
}
