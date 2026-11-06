import path from 'node:path';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema.ts';

export const CENTRAL_MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

export interface CentralDb {
  sql: postgres.Sql;
  db: PostgresJsDatabase<typeof schema>;
  end(): Promise<void>;
}

export function createCentralDb(url: string, max = 10): CentralDb {
  const sql = postgres(url, { max, onnotice: () => {} });
  return { sql, db: drizzle(sql, { schema }), end: () => sql.end({ timeout: 5 }) };
}
