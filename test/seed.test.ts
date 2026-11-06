import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { seed, DEMO_EMAIL, DEMO_PASSWORD } from '../src/dev/seed.ts';
import { createTestContext, type TestContext } from './helpers/context.ts';
import { createTestApp, type TestApp } from './helpers/app.ts';

let ctx: TestContext;
let t: TestApp;

before(async () => {
  ctx = await createTestContext();
  t = await createTestApp(ctx);
});
after(async () => {
  await t.close();
  await ctx.cleanup();
});

test('seeding twice gives one demo user, two tenants and one project in each', async () => {
  await seed(t.deps);
  await seed(t.deps);
  const users = await t.deps.central.sql`select email from users`;
  assert.deepEqual(users.map((u) => u.email), [DEMO_EMAIL]);
  const tenants = await t.deps.central.sql`select slug, status from tenants order by slug`;
  assert.deepEqual(tenants.map((r) => [r.slug, r.status]), [
    ['tenant-a', 'active'],
    ['tenant-b', 'active'],
  ]);

  const login = await t.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  const auth = { authorization: `Bearer ${login.json().accessToken}` };

  const mine = (await t.app.inject({ url: '/tenants', headers: auth })).json();
  assert.deepEqual(mine.map((m: { role: string }) => m.role), ['owner', 'owner']);

  for (const [slug, name] of [
    ['tenant-a', 'Tenant A project'],
    ['tenant-b', 'Tenant B project'],
  ]) {
    const projects = (await t.app.inject({ url: '/api/projects', headers: { ...auth, 'x-tenant': slug! } })).json();
    assert.deepEqual(projects.map((p: { name: string }) => p.name), [name]);
  }
});
