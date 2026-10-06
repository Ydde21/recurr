import type { RedactionConfig } from '@recurr-dev/core';
import type { IncidentStore } from '@recurr-dev/store';

export interface CaptureOptions {
  /** When to persist a record. 'error' = only failures (default), 'always' = every request. */
  on?: 'error' | 'always';
  /** Max rows kept per db.query event. Default 50. */
  maxDbRows?: number;
  /** Capture db result rows (not just rowCount). Default true. */
  captureDbRows?: boolean;
  /** Capture db query params. Object params are always key-redacted; set
   *  'omit' to drop params entirely (weakens replay matching fidelity). */
  dbParams?: 'capture' | 'omit';
  /** Capture outbound request/response bodies. Default true. */
  captureOutboundBodies?: boolean;
}

export interface RecurrConfig {
  /** Service name, e.g. 'checkout-api'. Required. */
  service: string;
  /** Service version — replay fidelity depends on it. */
  version?: string;
  gitSha?: string;
  /** Environment name. Default NODE_ENV ?? 'development'. */
  env?: string;
  /** Storage backend. Default: fs at .recurr/store. */
  store?: IncidentStore | string;
  capture?: CaptureOptions;
  redaction?: RedactionConfig;
  /** Runtime diagnostics. `warn: false` silences the capture-only-runtime notice at init. */
  doctor?: { warn?: boolean };
  /** Arbitrary labels attached to every record. */
  labels?: Record<string, string>;
}

export interface EnvConfig {
  mode: 'capture' | 'replay' | 'off';
  replayOf?: string;
  storeSpec: string;
}

export function envConfig(): EnvConfig {
  const mode = (process.env.RECURR_MODE ?? 'capture') as EnvConfig['mode'];
  return {
    mode: mode === 'replay' || mode === 'off' ? mode : 'capture',
    replayOf: process.env.RECURR_REPLAY_OF,
    storeSpec: process.env.RECURR_STORE ?? 'fs:.recurr/store',
  };
}
