import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCentralDb, type CentralDb } from '../src/db/central/client.ts';
import { buildApp } from '../src/app.ts';
import { createTestContext, type TestContext } from './helpers/context.ts';

let ctx: TestContext;
let central: CentralDb;

beforeEach(async () => {
  ctx = await createTestContext();
  central = createCentralDb(ctx.centralUrl);
});
afterEach(async () => {
  await central.end().catch(() => {});
  await ctx.cleanup();
});

test('central migrations create the core tables', async () => {
  const rows = await central.sql<{ table_name: string }[]>`
    select table_name from information_schema.tables where table_schema = 'public' order by table_name`;
  const names = rows.map((r) => r.table_name);
  for (const t of ['email_tokens', 'memberships', 'refresh_tokens', 'tenants', 'users']) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
});

test('users.email is unique', async () => {
  await central.sql`insert into users (email, password_hash) values ('demo@example.test', 'h')`;
  await assert.rejects(() => central.sql`insert into users (email, password_hash) values ('demo@example.test', 'h')`);
});

test('memberships are unique per user and tenant, and status and role are constrained', async () => {
  const [u] = await central.sql`insert into users (email, password_hash) values ('a@example.test', 'h') returning id`;
  const [t] = await central.sql`
    insert into tenants (slug, name, status, db_host, db_name) values ('tenant-a', 'Tenant A', 'active', 'h', 't_1') returning id`;
  await central.sql`insert into memberships (user_id, tenant_id, role) values (${u!.id}, ${t!.id}, 'owner')`;
  await assert.rejects(() => central.sql`insert into memberships (user_id, tenant_id, role) values (${u!.id}, ${t!.id}, 'member')`);
  await assert.rejects(() => central.sql`update tenants set status = 'deleted' where id = ${t!.id}`);
  await assert.rejects(() => central.sql`update memberships set role = 'superuser' where user_id = ${u!.id}`);
});

test('GET /ready reports the central database', async () => {
  const app = await buildApp({ config: ctx.config, central });
  assert.equal((await app.inject('/ready')).statusCode, 200);
  await central.end();
  const res = await app.inject('/ready');
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, 'INTERNAL');
  await app.close();
});
