import { and, count, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { CentralDb } from '../db/central/client.ts';
import { invitations, memberships, tenants } from '../db/central/schema.ts';
import type { TenantDb } from '../db/tenant/client.ts';
import { projects } from '../db/tenant/schema.ts';
import { AppError } from '../errors.ts';
import type { CentralTx } from '../members/lock.ts';
import type { TenantCache } from '../tenancy/cache.ts';
import type { Tenant } from '../tenancy/provision.ts';
import { PLANS, limitFor, type Feature, type Limit, type PlanId } from './plans.ts';

/** Refuses with 403 PLAN_LIMIT_REACHED when `usedAfter` (usage once the new thing exists) is over the plan's limit. */
export function assertWithinLimit(plan: PlanId, limit: Limit, usedAfter: number): void {
  const max = limitFor(plan, limit);
  if (max !== null && usedAfter > max) {
    throw new AppError('PLAN_LIMIT_REACHED', 403, `Your ${PLANS[plan].name} plan allows ${max} ${limit}`, {
      limit,
      max,
      plan,
    });
  }
}

/**
 * Seats in use: members plus invitations that can still be accepted, since each of those will
 * become a member. `excludeEmail` leaves out the open invitation that a re-invite replaces;
 * `excludeInvitationId` leaves out the one being accepted, which is about to become a member.
 */
export async function memberUsage(
  db: CentralTx | CentralDb['db'],
  tenantId: string,
  opts: { excludeEmail?: string; excludeInvitationId?: string } = {},
): Promise<number> {
  const [members] = await db.select({ n: count() }).from(memberships).where(eq(memberships.tenantId, tenantId));
  const [pending] = await db
    .select({ n: count() })
    .from(invitations)
    .where(
      and(
        eq(invitations.tenantId, tenantId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, sql`now()`),
        opts.excludeEmail ? ne(invitations.email, opts.excludeEmail) : undefined,
        opts.excludeInvitationId ? ne(invitations.id, opts.excludeInvitationId) : undefined,
      ),
    );
  return (members?.n ?? 0) + (pending?.n ?? 0);
}

/** The tenant's plan as stored now, for decisions made under the tenant lock (the cache can be a minute old). */
export async function lockedPlan(tx: CentralTx, tenantId: string): Promise<PlanId> {
  const [row] = await tx.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId));
  return row!.plan;
}

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
  const members = await memberUsage(central.db, tenant.id);
  const [projectRows] = await db.select({ n: count() }).from(projects);
  const def = PLANS[tenant.plan];
  return {
    plan: tenant.plan,
    name: def.name,
    features: [...def.features],
    limits: { ...def.limits },
    usage: { members, projects: projectRows?.n ?? 0 },
  };
}
