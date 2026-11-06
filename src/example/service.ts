import { desc } from 'drizzle-orm';
import type { TenantDb } from '../db/tenant/client.ts';
import { projects } from '../db/tenant/schema.ts';

export type Project = typeof projects.$inferSelect;

/** Every query here runs on the request's tenant database, so no tenant filter is needed. */
export function listProjects(db: TenantDb): Promise<Project[]> {
  return db.select().from(projects).orderBy(desc(projects.createdAt));
}

export async function createProject(db: TenantDb, input: { name: string; createdBy: string }): Promise<Project> {
  const [row] = await db.insert(projects).values(input).returning();
  return row!;
}
