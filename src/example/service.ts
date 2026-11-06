import { desc, eq } from 'drizzle-orm';
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

/** Returns false when there was no such project. */
export async function deleteProject(db: TenantDb, id: string): Promise<boolean> {
  const rows = await db.delete(projects).where(eq(projects.id, id)).returning({ id: projects.id });
  return rows.length > 0;
}
