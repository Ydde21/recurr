import { FileStore } from './file.js';
import { HttpStore } from './http.js';
import { PgStore } from './pg.js';
import type { IncidentStore } from './store.js';

export * from './store.js';
export * from './file.js';
export * from './pg.js';
export * from './http.js';

/**
 * Open a store from a spec string:
 *   'fs:<path>'                    filesystem store
 *   'pg:<connection-string>'       PostgreSQL store
 *   'postgres://…'                 PostgreSQL store
 *   'http(s)://…'                  recurr-server collector API
 *   '<path>'                       shorthand for fs:
 */
export function openStore(spec: string): IncidentStore {
  if (spec.startsWith('pg:')) return new PgStore(spec.slice(3));
  if (spec.startsWith('postgres://') || spec.startsWith('postgresql://')) return new PgStore(spec);
  if (spec.startsWith('http://') || spec.startsWith('https://')) return new HttpStore(spec);
  if (spec.startsWith('fs:')) return new FileStore(spec.slice(3));
  return new FileStore(spec);
}
