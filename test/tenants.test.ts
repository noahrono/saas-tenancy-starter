import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, type TestContext } from './helpers/context.ts';
import { createTestApp, signupAndToken, type TestApp } from './helpers/app.ts';

let ctx: TestContext;
let t: TestApp;
let token: string;

beforeEach(async () => {
  ctx = await createTestContext();
  t = await createTestApp(ctx);
  token = await signupAndToken(t, 'owner@example.test');
});
afterEach(async () => {
  await t.close();
  await ctx.cleanup();
});

const auth = () => ({ authorization: `Bearer ${token}` });

test('POST /tenants creates the tenant and makes the caller owner', async () => {
  const res = await t.app.inject({
    method: 'POST',
    url: '/tenants',
    headers: auth(),
    payload: { slug: 'tenant-a', name: 'Tenant A' },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.role, 'owner');
  assert.equal(body.tenant.slug, 'tenant-a');
  assert.equal(body.tenant.status, 'active');
  assert.equal('dbName' in body.tenant, false, 'database details are not exposed');
});

test('GET /tenants lists my tenants with my role', async () => {
  for (const slug of ['tenant-a', 'tenant-b']) {
    await t.app.inject({ method: 'POST', url: '/tenants', headers: auth(), payload: { slug, name: slug } });
  }
  const res = await t.app.inject({ url: '/tenants', headers: auth() });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.json().map((m: { tenant: { slug: string }; role: string }) => [m.tenant.slug, m.role]),
    [
      ['tenant-a', 'owner'],
      ['tenant-b', 'owner'],
    ],
  );
});

test('slug errors map to their codes', async () => {
  const post = (slug: string) =>
    t.app.inject({ method: 'POST', url: '/tenants', headers: auth(), payload: { slug, name: 'x' } });
  assert.equal((await post('www')).json().error.code, 'SLUG_RESERVED');
  assert.equal((await post('Bad_Slug')).json().error.code, 'SLUG_INVALID');
  await post('tenant-a');
  const taken = await post('tenant-a');
  assert.equal(taken.statusCode, 409);
  assert.equal(taken.json().error.code, 'SLUG_TAKEN');
});

test('tenant routes need a signed-in user', async () => {
  assert.equal((await t.app.inject('/tenants')).statusCode, 401);
});
