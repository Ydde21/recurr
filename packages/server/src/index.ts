import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, PgStore, type IncidentStore } from '@recurr-dev/store';
import { createApp, redactStoreSpec } from './app.js';

export { createApp, redactStoreSpec };
export type { AppOptions } from './app.js';

export interface ServerOptions {
  port?: number;
  store?: IncidentStore;
  /** 'fs:<path>' | 'pg:<conn>' | 'postgres://…'. Default env RECURR_STORE or DATABASE_URL or fs:.recurr/store. */
  storeSpec?: string;
  /** Directory containing the built developer UI (packages/ui/dist). */
  uiDir?: string;
}

/** Replay children resolve the store spec in their own cwd — fs: paths must
 *  be absolute or they'd read/write a different directory than the server. */
function absolutizeSpec(spec: string): string {
  if (spec.startsWith('fs:')) return `fs:${path.resolve(spec.slice(3))}`;
  if (/^(pg:|postgres(ql)?:|https?:)/.test(spec)) return spec;
  return `fs:${path.resolve(spec)}`;
}

export async function start(opts: ServerOptions = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const spec = absolutizeSpec(opts.storeSpec ?? process.env.RECURR_STORE ?? process.env.DATABASE_URL ?? 'fs:.recurr/store');
  const store = opts.store ?? openStore(spec);
  if (store instanceof PgStore) {
    const applied = await store.migrate();
    if (applied.length) console.log(`[recurr-server] applied migrations: ${applied.join(', ')}`);
  }
  const uiDir =
    opts.uiDir ??
    process.env.RECURR_UI_DIR ??
    // repo layout: packages/server/dist → packages/ui/dist
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ui/dist');
  const app = createApp(store, { storeSpec: spec, uiDir });
  const port = opts.port ?? Number(process.env.PORT ?? 4780);
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      console.log(`[recurr-server] listening on :${actual} (store: ${redactStoreSpec(spec)})`);
      resolve({
        port: actual,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => void store.close().then(() => res()));
          }),
      });
    });
  });
}
