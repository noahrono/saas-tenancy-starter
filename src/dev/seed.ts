import { hashPassword } from '../auth/passwords.ts';
import type { Config } from '../config/index.ts';
import type { CentralDb } from '../db/central/client.ts';
import type { PoolRegistry } from '../db/pool-registry.ts';
import { createProject, listProjects } from '../example/service.ts';
import { findTenantBySlug, provisionTenant, retryProvision } from '../tenancy/provision.ts';

export const DEMO_EMAIL = 'demo@example.test';
export const DEMO_PASSWORD = 'demo-password-123';

const DEMO_TENANTS = [
  { slug: 'tenant-a', name: 'Tenant A', project: 'Tenant A project' },
  { slug: 'tenant-b', name: 'Tenant B', project: 'Tenant B project' },
];

/** Creates the demo user, two tenants and one project in each. Safe to run repeatedly. */
export async function seed(deps: { central: CentralDb; config: Config; pools: PoolRegistry }): Promise<void> {
  const { central } = deps;
  const [user] = await central.sql<{ id: string }[]>`
    insert into users (email, password_hash, email_verified_at)
    values (${DEMO_EMAIL}, ${await hashPassword(DEMO_PASSWORD)}, now())
    on conflict (email) do update set email = excluded.email
    returning id`;

  for (const t of DEMO_TENANTS) {
    const existing = await findTenantBySlug(central, t.slug);
    const tenant = existing
      ? await retryProvision(deps, t.slug)
      : await provisionTenant(deps, { slug: t.slug, name: t.name, ownerUserId: user!.id });
    const db = await deps.pools.get(tenant);
    if ((await listProjects(db)).length === 0) await createProject(db, { name: t.project, createdBy: user!.id });
  }
}
