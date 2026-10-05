import { openStore, PgStore, type IncidentStore } from '@recurr/store';
import { createApp } from './app.js';

export { createApp };

export interface ServerOptions {
  port?: number;
  store?: IncidentStore;
  /** 'fs:<path>' | 'pg:<conn>' | 'postgres://…'. Default env RECURR_STORE or DATABASE_URL or fs:.recurr/store. */
  storeSpec?: string;
}

export async function start(opts: ServerOptions = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const spec = opts.storeSpec ?? process.env.RECURR_STORE ?? process.env.DATABASE_URL ?? 'fs:.recurr/store';
  const store = opts.store ?? openStore(spec);
  if (store instanceof PgStore) {
    const applied = await store.migrate();
    if (applied.length) console.log(`[recurr-server] applied migrations: ${applied.join(', ')}`);
  }
  const app = createApp(store);
  const port = opts.port ?? Number(process.env.PORT ?? 4780);
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      console.log(`[recurr-server] listening on :${actual} (store: ${spec})`);
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
