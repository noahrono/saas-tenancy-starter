import { count, desc, eq, sql } from 'drizzle-orm';
import type { TenantDb } from '../db/tenant/client.ts';
import { projects } from '../db/tenant/schema.ts';
import type { PlanId } from '../plans/plans.ts';
import { assertWithinLimit } from '../plans/service.ts';

/** Advisory lock key that serialises project creation within one tenant database. */
export const PROJECT_LIMIT_LOCK_KEY = 727275;

export type Project = typeof projects.$inferSelect;

/** Every query here runs on the request's tenant database, so no tenant filter is needed. */
export function listProjects(db: TenantDb): Promise<Project[]> {
  return db.select().from(projects).orderBy(desc(projects.createdAt));
}

/**
 * Creates a project. With `opts.plan`, the plan's project limit is enforced: the count and the
 * insert run under a lock, so parallel requests can't overshoot it. Seeding passes no plan.
 */
export async function createProject(
  db: TenantDb,
  input: { name: string; createdBy: string },
  opts?: { plan: PlanId },
): Promise<Project> {
  if (!opts) {
    const [row] = await db.insert(projects).values(input).returning();
    return row!;
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${PROJECT_LIMIT_LOCK_KEY})`);
    const [existing] = await tx.select({ n: count() }).from(projects);
    assertWithinLimit(opts.plan, 'projects', (existing?.n ?? 0) + 1);
    const [row] = await tx.insert(projects).values(input).returning();
    return row!;
  });
}

/** Returns false when there was no such project. */
export async function deleteProject(db: TenantDb, id: string): Promise<boolean> {
  const rows = await db.delete(projects).where(eq(projects.id, id)).returning({ id: projects.id });
  return rows.length > 0;
}
