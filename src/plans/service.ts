import { count, eq, sql } from 'drizzle-orm';
import type { CentralDb } from '../db/central/client.ts';
import { memberships, tenants } from '../db/central/schema.ts';
import type { TenantDb } from '../db/tenant/client.ts';
import { projects } from '../db/tenant/schema.ts';
import type { TenantCache } from '../tenancy/cache.ts';
import type { Tenant } from '../tenancy/provision.ts';
import { PLANS, type Feature, type Limit, type PlanId } from './plans.ts';

export interface PlanSummary {
  plan: PlanId;
  name: string;
  features: Feature[];
  limits: Record<Limit, number | null>;
  usage: Record<Limit, number>;
}

/**
 * Moves a tenant to `plan`. This is the one function a billing integration would call after a
 * payment. Downgrading never deletes anything: limits only block adding more.
 */
export async function changePlan(central: CentralDb, cache: TenantCache, tenantId: string, plan: PlanId): Promise<void> {
  await central.db.update(tenants).set({ plan, updatedAt: sql`now()` }).where(eq(tenants.id, tenantId));
  cache.invalidateTenant(tenantId);
}

export async function planSummary(central: CentralDb, tenant: Tenant, db: TenantDb): Promise<PlanSummary> {
  const [members] = await central.db
    .select({ n: count() })
    .from(memberships)
    .where(eq(memberships.tenantId, tenant.id));
  const [projectRows] = await db.select({ n: count() }).from(projects);
  const def = PLANS[tenant.plan];
  return {
    plan: tenant.plan,
    name: def.name,
    features: [...def.features],
    limits: { ...def.limits },
    usage: { members: members?.n ?? 0, projects: projectRows?.n ?? 0 },
  };
}
