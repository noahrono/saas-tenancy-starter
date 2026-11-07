import { hashPassword } from '../auth/passwords.ts';
import type { Config } from '../config/index.ts';
import type { CentralDb } from '../db/central/client.ts';
import type { Role } from '../db/central/schema.ts';
import type { PoolRegistry } from '../db/pool-registry.ts';
import { createProject, listProjects } from '../example/service.ts';
import type { PlanId } from '../plans/plans.ts';
import { changePlan } from '../plans/service.ts';
import { TenantCache } from '../tenancy/cache.ts';
import { findTenantBySlug, provisionTenant, retryProvision } from '../tenancy/provision.ts';

export const DEMO_EMAIL = 'demo@example.test';
export const DEMO_ADMIN_EMAIL = 'admin@example.test';
export const DEMO_MEMBER_EMAIL = 'member@example.test';
export const DEMO_PASSWORD = 'demo-password-123';

const DEMO_TENANTS: { slug: string; name: string; project: string; plan: PlanId }[] = [
  { slug: 'tenant-a', name: 'Tenant A', project: 'Tenant A project', plan: 'pro' },
  { slug: 'tenant-b', name: 'Tenant B', project: 'Tenant B project', plan: 'free' },
];

/** Extra people in tenant-a, so every role can be tried. The demo user owns both tenants. */
const TENANT_A_TEAM: { email: string; role: Role }[] = [
  { email: DEMO_ADMIN_EMAIL, role: 'admin' },
  { email: DEMO_MEMBER_EMAIL, role: 'member' },
];

async function demoUser(central: CentralDb, email: string, passwordHash: string): Promise<string> {
  const [user] = await central.sql<{ id: string }[]>`
    insert into users (email, password_hash, email_verified_at)
    values (${email}, ${passwordHash}, now())
    on conflict (email) do update set email = excluded.email
    returning id`;
  return user!.id;
}

/**
 * Creates the demo users, two tenants (tenant-a on pro with an admin and a member, tenant-b on
 * free) and one project in each. Safe to run repeatedly.
 */
export async function seed(deps: { central: CentralDb; config: Config; pools: PoolRegistry }): Promise<void> {
  const { central } = deps;
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const ownerId = await demoUser(central, DEMO_EMAIL, passwordHash);
  const cache = new TenantCache();

  for (const t of DEMO_TENANTS) {
    const existing = await findTenantBySlug(central, t.slug);
    const tenant = existing
      ? await retryProvision(deps, t.slug)
      : await provisionTenant(deps, { slug: t.slug, name: t.name, ownerUserId: ownerId });
    await changePlan(central, cache, tenant.id, t.plan);
    const db = await deps.pools.get(tenant);
    if ((await listProjects(db)).length === 0) await createProject(db, { name: t.project, createdBy: ownerId });

    if (t.slug === 'tenant-a') {
      for (const person of TENANT_A_TEAM) {
        const userId = await demoUser(central, person.email, passwordHash);
        await central.sql`
          insert into memberships (user_id, tenant_id, role) values (${userId}, ${tenant.id}, ${person.role})
          on conflict do nothing`;
      }
    }
  }
}
