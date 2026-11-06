import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { PoolRegistry } from '../src/db/pool-registry.ts';
import { tenantDbName } from '../src/tenancy/slug.ts';
import { createTestContext, type TestContext } from './helpers/context.ts';

let ctx: TestContext;
const tenants: { id: string; dbHost: string; dbName: string }[] = [];

before(async () => {
  ctx = await createTestContext();
  for (let i = 0; i < 3; i++) {
    const id = randomUUID();
    const dbName = tenantDbName(id);
    await ctx.adminSql.unsafe(`create database "${dbName}"`);
    tenants.push({ id, dbHost: ctx.config.tenantDb.host, dbName });
  }
});
after(async () => {
  for (const t of tenants) await ctx.adminSql.unsafe(`drop database if exists "${t.dbName}" with (force)`);
  await ctx.cleanup();
});

function registry(maxPools: number) {
  const created: string[] = [];
  const ended: string[] = [];
  const reg = new PoolRegistry({
    ...ctx.config.tenantDb,
    maxPools,
    poolMax: 2,
    createClient: (url, poolMax) => {
      const name = new URL(url).pathname.slice(1);
      created.push(name);
      const client = postgres(url, { max: poolMax, onnotice: () => {} });
      const end = client.end.bind(client);
      client.end = (opts) => {
        ended.push(name);
        return end(opts);
      };
      return client;
    },
  });
  return { reg, created, ended };
}

test('reuses one client per tenant', async () => {
  const { reg, created } = registry(10);
  const a = await reg.get(tenants[0]!);
  const b = await reg.get(tenants[0]!);
  assert.equal(a, b);
  assert.equal(created.length, 1);
  await reg.closeAll();
});

test('concurrent gets for one tenant share a single client', async () => {
  const { reg, created } = registry(10);
  await Promise.all(Array.from({ length: 10 }, () => reg.get(tenants[1]!)));
  assert.equal(created.length, 1);
  await reg.closeAll();
});

test('evicts the least recently used pool beyond the limit and ends it', async () => {
  const { reg, ended } = registry(2);
  await reg.get(tenants[0]!);
  await reg.get(tenants[1]!);
  await reg.get(tenants[2]!);
  assert.equal(reg.size, 2);
  assert.deepEqual(ended, [tenants[0]!.dbName]);
  await reg.closeAll();
});

test('the returned database is usable', async () => {
  const { reg } = registry(10);
  const db = await reg.get(tenants[0]!);
  const rows = await db.execute(dsql`select current_database() as name`);
  assert.equal(rows[0]!.name, tenants[0]!.dbName);
  await reg.closeAll();
});

test('closeAll ends every client', async () => {
  const { reg, ended } = registry(10);
  await reg.get(tenants[0]!);
  await reg.get(tenants[1]!);
  await reg.closeAll();
  assert.equal(reg.size, 0);
  assert.deepEqual([...ended].sort(), [tenants[0]!.dbName, tenants[1]!.dbName].sort());
});

test('evict closes one tenant pool', async () => {
  const { reg, ended } = registry(10);
  await reg.get(tenants[2]!);
  await reg.evict(tenants[2]!.id);
  assert.equal(reg.size, 0);
  assert.deepEqual(ended, [tenants[2]!.dbName]);
});

test('an evicted pool stays open until the request holding it releases it', async () => {
  const { reg, ended } = registry(1);
  const lease = await reg.acquire(tenants[0]!);
  await reg.get(tenants[1]!); // evicts tenant 0 from the LRU
  assert.equal(ended.length, 0, 'not closed while leased');
  const rows = await lease.db.execute(dsql`select 1 as ok`);
  assert.equal(rows[0]!.ok, 1);
  lease.release();
  lease.release(); // releasing twice is harmless
  await reg.closeAll();
  assert.ok(ended.includes(tenants[0]!.dbName), 'closed once released');
});

test('a leased pool that stays in the LRU is reused, not reopened', async () => {
  const { reg, created } = registry(10);
  const a = await reg.acquire(tenants[0]!);
  const b = await reg.acquire(tenants[0]!);
  assert.equal(a.db, b.db);
  a.release();
  b.release();
  assert.equal(created.length, 1);
  await reg.closeAll();
});
