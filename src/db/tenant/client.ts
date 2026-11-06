import path from 'node:path';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as tenantSchema from './schema.ts';

export const TENANT_MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

export type TenantDb = PostgresJsDatabase<typeof tenantSchema>;
