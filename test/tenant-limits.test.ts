import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, type TestContext } from './helpers/context.ts';
import { createTestApp, signupAndToken, type TestApp } from './helpers/app.ts';

let ctx: TestContext;
let t: TestApp;
let auth: { authorization: string };

beforeEach(async () => {
  ctx = await createTestContext({ env: { MAX_TENANTS_PER_USER: '2' } });
  t = await createTestApp(ctx);
  auth = { authorization: `Bearer ${await signupAndToken(t, 'owner@example.test')}` };
});
afterEach(async () => {
  await t.close();
  await ctx.cleanup();
});

const create = (slug: string) =>
  t.app.inject({ method: 'POST', url: '/tenants', headers: auth, payload: { slug, name: slug } });

test('a user cannot own more tenants than the configured limit', async () => {
  assert.equal((await create('tenant-a')).statusCode, 201);
  assert.equal((await create('tenant-b')).statusCode, 201);
  const third = await create('tenant-c');
  assert.equal(third.statusCode, 403);
  assert.equal(third.json().error.code, 'TENANT_LIMIT_REACHED');
  const dbs = await t.deps.central.sql`select count(*)::int as n from tenants`;
  assert.equal(dbs[0]!.n, 2, 'no row or database for the refused tenant');
});

test('tenant creation is rate limited per IP', async () => {
  const codes: number[] = [];
  for (let i = 0; i < 11; i++) codes.push((await create('BAD')).statusCode);
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(400));
  assert.equal(codes[10], 429);
});
