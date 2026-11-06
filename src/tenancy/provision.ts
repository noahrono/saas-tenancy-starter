import { randomUUID } from 'node:crypto';
import { and, count, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import type { Config } from '../config/index.ts';
import type { CentralDb } from '../db/central/client.ts';
import { memberships, tenants, type TenantStatus } from '../db/central/schema.ts';
import { migrate } from '../db/migrator.ts';
import { TENANT_MIGRATIONS_DIR } from '../db/tenant/client.ts';
import { AppError } from '../errors.ts';
import type { TenantCache } from './cache.ts';
import { tenantDbName, validateSlug } from './slug.ts';

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  statusError: string | null;
  dbHost: string;
  dbName: string;
}

export interface ProvisionDeps {
  central: CentralDb;
  config: Config;
  cache?: TenantCache;
}

export interface ProvisionHooks {
  /** Test hook: runs right after CREATE DATABASE, to simulate a crash mid-provisioning. */
  afterCreateDatabase?: () => Promise<void>;
}

const tenantColumns = {
  id: tenants.id,
  slug: tenants.slug,
  name: tenants.name,
  status: tenants.status,
  statusError: tenants.statusError,
  dbHost: tenants.dbHost,
  dbName: tenants.dbName,
};

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}

/** Connection URL for a database on a tenant server, using the shared service role. */
export function serverUrl(config: Config, host: string, database: string): string {
  const url = new URL('postgres://placeholder');
  url.hostname = host;
  url.port = String(config.tenantDb.port);
  url.username = encodeURIComponent(config.tenantDb.user);
  url.password = encodeURIComponent(config.tenantDb.password);
  url.pathname = `/${database}`;
  return url.toString();
}

export async function findTenantBySlug(central: CentralDb, slug: string): Promise<Tenant | undefined> {
  const [row] = await central.db.select(tenantColumns).from(tenants).where(eq(tenants.slug, slug));
  return row;
}

async function setStatus(deps: ProvisionDeps, tenant: Tenant, status: TenantStatus, statusError: string | null) {
  await deps.central.db
    .update(tenants)
    .set({ status, statusError, updatedAt: new Date() })
    .where(eq(tenants.id, tenant.id));
  deps.cache?.invalidateTenant(tenant.id);
  return { ...tenant, status, statusError };
}

/** Steps 2-4: create the database, migrate it, mark active. Each step is safe to repeat. */
async function finish(deps: ProvisionDeps, tenant: Tenant, hooks: ProvisionHooks): Promise<Tenant> {
  try {
    const admin = postgres(serverUrl(deps.config, tenant.dbHost, 'postgres'), { max: 1, onnotice: () => {} });
    try {
      // dbName is generated from the tenant uuid (see tenantDbName), never from user input.
      await admin.unsafe(`create database "${tenant.dbName}"`);
    } catch (err) {
      if (pgCode(err) !== '42P04') throw err; // 42P04 = already exists: a retry after a crash
    } finally {
      await admin.end();
    }

    await hooks.afterCreateDatabase?.();

    const db = postgres(serverUrl(deps.config, tenant.dbHost, tenant.dbName), { max: 1, onnotice: () => {} });
    try {
      await migrate(db, TENANT_MIGRATIONS_DIR);
    } finally {
      await db.end();
    }
    return await setStatus(deps, tenant, 'active', null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setStatus(deps, tenant, 'failed', message);
    throw new AppError('TENANT_PROVISION_FAILED', 500, `Could not set up tenant "${tenant.slug}"`, {
      slug: tenant.slug,
    });
  }
}

/** Creates a tenant: records it with its owner, then creates and migrates its own database. */
export async function provisionTenant(
  deps: ProvisionDeps,
  input: { slug: string; name: string; ownerUserId: string; maxOwned?: number },
  hooks: ProvisionHooks = {},
): Promise<Tenant> {
  const slug = validateSlug(input.slug);
  const id = randomUUID();
  const tenant: Tenant = {
    id,
    slug,
    name: input.name,
    status: 'provisioning',
    statusError: null,
    dbHost: deps.config.tenantDb.host,
    dbName: tenantDbName(id),
  };

  try {
    await deps.central.db.transaction(async (tx) => {
      if (input.maxOwned !== undefined) {
        // Serialise this user's creates so parallel requests can't overshoot the quota.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.ownerUserId}))`);
        const [{ owned } = { owned: 0 }] = await tx
          .select({ owned: count() })
          .from(memberships)
          .where(and(eq(memberships.userId, input.ownerUserId), eq(memberships.role, 'owner')));
        if (owned >= input.maxOwned) {
          throw new AppError('TENANT_LIMIT_REACHED', 403, `You can own at most ${input.maxOwned} tenants`);
        }
      }
      await tx.insert(tenants).values(tenant);
      await tx.insert(memberships).values({ userId: input.ownerUserId, tenantId: id, role: 'owner' });
    });
  } catch (err) {
    if (pgCode(err) === '23505') throw new AppError('SLUG_TAKEN', 409, `"${slug}" is already taken`);
    throw err;
  }

  return finish(deps, tenant, hooks);
}

/** Resumes a tenant stuck in `failed` or `provisioning`. Other tenants are returned unchanged. */
export async function retryProvision(deps: ProvisionDeps, slug: string, hooks: ProvisionHooks = {}): Promise<Tenant> {
  const tenant = await findTenantBySlug(deps.central, slug);
  if (!tenant) throw new AppError('TENANT_NOT_FOUND', 404, `No tenant "${slug}"`);
  if (tenant.status !== 'failed' && tenant.status !== 'provisioning') return tenant;
  return finish(deps, tenant, hooks);
}
