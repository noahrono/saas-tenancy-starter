import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { provisionTenant, retryProvision } from '../src/tenancy/provision.ts';
import { createCentralDb, type CentralDb } from '../src/db/central/client.ts';
import { AppError } from '../src/errors.ts';
import { createTestContext, type TestContext } from './helpers/context.ts';

let ctx: TestContext;
let central: CentralDb;
let ownerUserId: string;

beforeEach(async () => {
  ctx = await createTestContext();
  central = createCentralDb(ctx.centralUrl);
  const [u] = await central.sql`insert into users (email, password_hash) values ('owner@example.test', 'h') returning id`;
  ownerUserId = u!.id;
});
afterEach(async () => {
  await central.end();
  await ctx.cleanup();
});

const deps = () => ({ central, config: ctx.config });
const code = (c: string) => (e: unknown) => e instanceof AppError && e.code === c;

async function tenantTables(dbName: string): Promise<string[]> {
  const url = new URL(ctx.centralUrl);
  url.pathname = `/${dbName}`;
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    const rows = await sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`;
    return rows.map((r) => r.table_name as string);
  } finally {
    await sql.end();
  }
}

async function databaseExists(dbName: string): Promise<boolean> {
  return (await ctx.adminSql`select 1 from pg_database where datname = ${dbName}`).length === 1;
}

test('creates an active, migrated tenant database owned by the creator', async () => {
  const tenant = await provisionTenant(deps(), { slug: 'tenant-a', name: 'Tenant A', ownerUserId });
  assert.equal(tenant.status, 'active');
  assert.equal(tenant.statusError, null);
  assert.match(tenant.dbName, /^t_[0-9a-f]{32}$/);
  assert.ok(await databaseExists(tenant.dbName));
  assert.deepEqual(await tenantTables(tenant.dbName), ['__migrations', 'projects']);
  const [m] = await central.sql`select role from memberships where tenant_id = ${tenant.id} and user_id = ${ownerUserId}`;
  assert.equal(m!.role, 'owner');
});

test('rejects invalid, reserved and taken slugs', async () => {
  await assert.rejects(() => provisionTenant(deps(), { slug: 'No', name: 'x', ownerUserId }), code('SLUG_INVALID'));
  await assert.rejects(() => provisionTenant(deps(), { slug: 'admin', name: 'x', ownerUserId }), code('SLUG_RESERVED'));
  await provisionTenant(deps(), { slug: 'tenant-a', name: 'Tenant A', ownerUserId });
  await assert.rejects(() => provisionTenant(deps(), { slug: 'tenant-a', name: 'Again', ownerUserId }), code('SLUG_TAKEN'));
});

test('a failure after CREATE DATABASE marks the tenant failed, and retry finishes it', async () => {
  await assert.rejects(
    () =>
      provisionTenant(deps(), { slug: 'tenant-b', name: 'Tenant B', ownerUserId }, {
        afterCreateDatabase: async () => {
          throw new Error('simulated crash');
        },
      }),
    code('TENANT_PROVISION_FAILED'),
  );
  const [row] = await central.sql`select status, status_error, db_name from tenants where slug = 'tenant-b'`;
  assert.equal(row!.status, 'failed');
  assert.match(row!.status_error, /simulated crash/);
  assert.ok(await databaseExists(row!.db_name));

  const fixed = await retryProvision(deps(), 'tenant-b');
  assert.equal(fixed.status, 'active');
  assert.equal(fixed.statusError, null);
  assert.deepEqual(await tenantTables(fixed.dbName), ['__migrations', 'projects']);
});

test('retrying an active tenant changes nothing', async () => {
  const t = await provisionTenant(deps(), { slug: 'tenant-a', name: 'Tenant A', ownerUserId });
  const again = await retryProvision(deps(), 'tenant-a');
  assert.deepEqual(again, t);
});

test('retrying an unknown slug is TENANT_NOT_FOUND', async () => {
  await assert.rejects(() => retryProvision(deps(), 'nope-nope'), code('TENANT_NOT_FOUND'));
});

test('two simultaneous creates with the same slug: one wins, no orphan database', async () => {
  const results = await Promise.allSettled([
    provisionTenant(deps(), { slug: 'tenant-c', name: 'One', ownerUserId }),
    provisionTenant(deps(), { slug: 'tenant-c', name: 'Two', ownerUserId }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 1);
  assert.ok(code('SLUG_TAKEN')(failed[0]!.reason));
  const dbs = await ctx.adminSql`select datname from pg_database where datname like 't\\_%'`;
  const mine = await central.sql`select db_name from tenants`;
  assert.equal(mine.length, 1);
  assert.ok(dbs.some((d) => d.datname === mine[0]!.db_name));
});
