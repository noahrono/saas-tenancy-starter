import { sql } from 'drizzle-orm';
import type { CentralDb } from '../db/central/client.ts';

export type CentralTx = Parameters<Parameters<CentralDb['db']['transaction']>[0]>[0];

/**
 * Runs `fn` in a central transaction that first locks the tenant's row. Every change to a
 * tenant's members or invitations goes through here, so checks like "is this the last owner?"
 * or "is there a free seat?" can't race with another request for the same tenant.
 */
export function withTenantLock<T>(central: CentralDb, tenantId: string, fn: (tx: CentralTx) => Promise<T>): Promise<T> {
  return central.db.transaction(async (tx) => {
    await tx.execute(sql`select id from tenants where id = ${tenantId} for update`);
    return fn(tx);
  });
}
