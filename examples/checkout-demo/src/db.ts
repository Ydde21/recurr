import { newDb } from 'pg-mem';
import pg from 'pg';

export interface Db {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
}

/**
 * Demo database. Uses embedded pg-mem by default so the demo runs with zero
 * external dependencies; set DATABASE_URL to use a real PostgreSQL.
 */
export function createDb(): Db {
  if (process.env.DATABASE_URL) {
    return new pg.Pool({ connectionString: process.env.DATABASE_URL }) as unknown as Db;
  }
  const db = newDb();
  const adapter = db.adapters.createPg();
  return new adapter.Pool() as unknown as Db;
}

export async function seed(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS products (
      sku TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price_cents INT NOT NULL,
      stock INT NOT NULL
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      total_cents INT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
  await db.query(`INSERT INTO users VALUES ('u1','org-1','ada@example.com','hash-deadbeef') ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO products VALUES
    ('sku-teapot','Ceramic Teapot',4200,12),
    ('sku-keyboard','Mech Keyboard',18900,4),
    ('sku-server','1U Server Chassis',89900,2)
    ON CONFLICT DO NOTHING`);
}
