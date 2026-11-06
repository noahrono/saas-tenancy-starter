import type { FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { currentUser } from '../auth/guard.ts';
import type { CentralDb } from '../db/central/client.ts';
import { memberships, type Role } from '../db/central/schema.ts';
import type { PoolRegistry } from '../db/pool-registry.ts';
import type { TenantDb } from '../db/tenant/client.ts';
import { AppError } from '../errors.ts';
import type { TenantCache } from './cache.ts';
import { findTenantBySlug, type Tenant } from './provision.ts';

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: Tenant;
    membership?: { role: Role };
    tenantDb?: TenantDb;
    releaseTenantDb?: () => void;
  }
}

/**
 * Works out which tenant a request is for. With `tenantHeader` on, an `X-Tenant`
 * header wins (local dev, curl, tests); otherwise the first label of the Host under
 * `baseDomain`. The bare domain, `api.` and anything else are not tenant hosts.
 */
export function tenantSlugFromRequest(
  host: string | undefined,
  header: string | undefined,
  cfg: { baseDomain: string; tenantHeader: boolean },
): string | null {
  if (cfg.tenantHeader && header) return header.trim().toLowerCase() || null;
  if (!host) return null;
  const name = host.toLowerCase().replace(/:\d+$/, '');
  const suffix = `.${cfg.baseDomain}`;
  if (!name.endsWith(suffix)) return null;
  const label = name.slice(0, -suffix.length);
  if (!label || label.includes('.') || label === 'api') return null;
  return label;
}

const notFound = () => new AppError('TENANT_NOT_FOUND', 404, 'Tenant not found');

export interface ResolveDeps {
  central: CentralDb;
  pools: PoolRegistry;
  cache: TenantCache;
  config: { baseDomain: string; tenantHeader: boolean };
}

/**
 * preHandler for tenant routes, run after requireAuth: resolves the tenant, checks it's
 * usable and that the user is a member, then attaches `req.tenantDb`.
 * Non-members get the same 404 as unknown tenants, so outsiders can't probe slugs.
 */
export function makeRequireTenant(deps: ResolveDeps) {
  return async function requireTenant(req: FastifyRequest): Promise<void> {
    const header = req.headers['x-tenant'];
    const slug = tenantSlugFromRequest(req.headers.host, Array.isArray(header) ? header[0] : header, deps.config);
    if (!slug) throw notFound();

    let tenant = deps.cache.bySlug.get(slug);
    if (!tenant) {
      tenant = await findTenantBySlug(deps.central, slug);
      if (!tenant) throw notFound();
      deps.cache.bySlug.set(slug, tenant);
    }

    const user = currentUser(req);
    const key = `${tenant.id}:${user.id}`;
    let member = deps.cache.memberships.get(key);
    if (!member) {
      const [row] = await deps.central.db
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenant.id), eq(memberships.userId, user.id)));
      member = row ?? { role: null };
      deps.cache.memberships.set(key, member);
    }
    if (member.role === null) throw notFound();

    if (tenant.status === 'suspended') throw new AppError('TENANT_SUSPENDED', 403, 'This tenant is suspended');
    if (tenant.status !== 'active') throw new AppError('TENANT_NOT_READY', 403, 'This tenant is still being set up');

    req.tenant = tenant;
    req.membership = { role: member.role };
    const lease = await deps.pools.acquire(tenant);
    req.tenantDb = lease.db;
    req.releaseTenantDb = lease.release;
  };
}

/** The tenant database for handlers behind requireTenant. */
export function tenantDb(req: FastifyRequest): TenantDb {
  if (!req.tenantDb) throw new Error('requireTenant did not run for this route');
  return req.tenantDb;
}
