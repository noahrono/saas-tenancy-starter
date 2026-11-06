import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCentralDb, type CentralDb } from '../src/db/central/client.ts';
import { TENANT_MIGRATIONS_DIR } from '../src/db/tenant/client.ts';
import { migrateAllTenants } from '../src/tenancy/migrate-all.ts';
import { provisionTenant } from '../src/tenancy/provision.ts';
import { createTestContext, type TestContext } from './helpers/context.ts';

let ctx: TestContext;
let central: CentralDb;
let dir: string;

beforeEach(async () => {
  ctx = await createTestContext();
  central = createCentralDb(ctx.centralUrl);
  const [u] = await central.sql`insert into users (email, password_hash) values ('owner@example.test', 'h') returning id`;
  for (const slug of ['tenant-a', 'tenant-b', 'tenant-c']) {
    await provisionTenant({ central, config: ctx.config }, { slug, name: slug, ownerUserId: u!.id });
  }
  dir = await mkdtemp(path.join(tmpdir(), 'tenant-mig-'));
  await cp(TENANT_MIGRATIONS_DIR, dir, { recursive: true });
  await writeFile(path.join(dir, '0001_add_archived.sql'), 'alter table projects add column archived boolean not null default false;\n');
});
afterEach(async () => {
  await central.end();
  await ctx.cleanup();
});

const run = (concurrency = 2) => migrateAllTenants({ central, config: ctx.config }, { concurrency, dir });

test('migrates every tenant, then reports them up to date', async () => {
  const first = await run();
  assert.deepEqual([...first.migrated].sort(), ['tenant-a', 'tenant-b', 'tenant-c']);
  assert.deepEqual(first.failed, []);
  const second = await run();
  assert.deepEqual(second.migrated, []);
  assert.deepEqual([...second.upToDate].sort(), ['tenant-a', 'tenant-b', 'tenant-c']);
});

test('one broken tenant is reported while the others still migrate', async () => {
  const [b] = await central.sql`select db_name from tenants where slug = 'tenant-b'`;
  await ctx.adminSql.unsafe(`drop database "${b!.db_name}" with (force)`);
  const res = await run();
  assert.deepEqual([...res.migrated].sort(), ['tenant-a', 'tenant-c']);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0]!.slug, 'tenant-b');
  assert.ok(res.failed[0]!.error.length > 0);
});

test('a failed tenant that migrates cleanly becomes active again', async () => {
  await central.sql`update tenants set status = 'failed', status_error = 'earlier problem' where slug = 'tenant-c'`;
  await run();
  const [c] = await central.sql`select status, status_error from tenants where slug = 'tenant-c'`;
  assert.equal(c!.status, 'active');
  assert.equal(c!.status_error, null);
});

test('suspended tenants are migrated too, and stay suspended', async () => {
  await central.sql`update tenants set status = 'suspended' where slug = 'tenant-a'`;
  const res = await run();
  assert.ok(res.migrated.includes('tenant-a'));
  const [a] = await central.sql`select status from tenants where slug = 'tenant-a'`;
  assert.equal(a!.status, 'suspended');
});

test('provisioning tenants are skipped: provisioning migrates them itself', async () => {
  await central.sql`update tenants set status = 'provisioning' where slug = 'tenant-b'`;
  const res = await run();
  assert.equal([...res.migrated, ...res.upToDate].includes('tenant-b'), false);
});

test('the CLI exits 1 when any tenant fails', async () => {
  const [a] = await central.sql`select db_name from tenants where slug = 'tenant-a'`;
  await ctx.adminSql.unsafe(`drop database "${a!.db_name}" with (force)`);
  const res = spawnSync(process.execPath, ['scripts/migrate-tenants.ts'], {
    env: {
      ...process.env,
      DATABASE_URL: ctx.config.databaseUrl,
      TENANT_DB_USER: ctx.config.tenantDb.user,
      TENANT_DB_PASSWORD: ctx.config.tenantDb.password,
      JWT_PRIVATE_KEY: ctx.config.jwt.privateKeyPem,
      JWT_PUBLIC_KEY: ctx.config.jwt.publicKeyPem,
    },
    encoding: 'utf8',
  });
  assert.equal(res.status, 1, res.stderr || res.stdout);
  assert.match(res.stdout, /tenant-a/);
});
