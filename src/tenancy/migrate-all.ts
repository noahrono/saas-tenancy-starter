import { and, eq, inArray } from 'drizzle-orm';
import postgres from 'postgres';
import type { Config } from '../config/index.ts';
import type { CentralDb } from '../db/central/client.ts';
import { tenants } from '../db/central/schema.ts';
import { migrate } from '../db/migrator.ts';
import { TENANT_MIGRATIONS_DIR } from '../db/tenant/client.ts';
import type { TenantCache } from './cache.ts';
import { serverUrl } from './provision.ts';

export interface MigrateAllResult {
  migrated: string[];
  upToDate: string[];
  failed: { slug: string; error: string }[];
}

/**
 * Brings every active, failed or suspended tenant database up to the latest migration
 * (suspension blocks access, not schema changes),
 * `concurrency` at a time. One tenant failing never stops the others.
 */
export async function migrateAllTenants(
  deps: { central: CentralDb; config: Config; cache?: TenantCache },
  opts: { concurrency?: number; dir?: string } = {},
): Promise<MigrateAllResult> {
  const dir = opts.dir ?? TENANT_MIGRATIONS_DIR;
  const concurrency = Math.max(1, opts.concurrency ?? deps.config.migrateConcurrency);
  const queue = await deps.central.db
    .select({ id: tenants.id, slug: tenants.slug, status: tenants.status, dbHost: tenants.dbHost, dbName: tenants.dbName })
    .from(tenants)
    .where(inArray(tenants.status, ['active', 'failed', 'suspended']))
    .orderBy(tenants.slug);

  const result: MigrateAllResult = { migrated: [], upToDate: [], failed: [] };
  let next = 0;

  async function worker() {
    while (next < queue.length) {
      const tenant = queue[next++]!;
      const sql = postgres(serverUrl(deps.config, tenant.dbHost, tenant.dbName), { max: 1, onnotice: () => {} });
      try {
        const { applied } = await migrate(sql, dir);
        (applied.length > 0 ? result.migrated : result.upToDate).push(tenant.slug);
        if (tenant.status === 'failed') {
          await deps.central.db
            .update(tenants)
            .set({ status: 'active', statusError: null, updatedAt: new Date() })
            .where(and(eq(tenants.id, tenant.id), eq(tenants.status, 'failed')));
          deps.cache?.invalidateTenant(tenant.id);
        }
      } catch (err) {
        result.failed.push({ slug: tenant.slug, error: err instanceof Error ? err.message : String(err) });
      } finally {
        await sql.end({ timeout: 5 }).catch(() => {});
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return result;
}
