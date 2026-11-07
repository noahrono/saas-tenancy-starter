import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { seed, DEMO_ADMIN_EMAIL, DEMO_EMAIL, DEMO_MEMBER_EMAIL, DEMO_PASSWORD } from '../src/dev/seed.ts';
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

test('seeding twice gives three demo users, two tenants and one project in each', async () => {
  await seed(t.deps);
  await seed(t.deps);
  const users = await t.deps.central.sql`select email from users order by email`;
  assert.deepEqual(users.map((u) => u.email), [DEMO_ADMIN_EMAIL, DEMO_EMAIL, DEMO_MEMBER_EMAIL]);
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

test('tenant-a has an owner, an admin and a member on pro; tenant-b is on free', async () => {
  await seed(t.deps);
  const roles = await t.deps.central.sql`
    select u.email, m.role from memberships m
    join users u on u.id = m.user_id join tenants tn on tn.id = m.tenant_id
    where tn.slug = 'tenant-a' order by u.email`;
  assert.deepEqual(roles.map((r) => [r.email, r.role]), [
    [DEMO_ADMIN_EMAIL, 'admin'],
    [DEMO_EMAIL, 'owner'],
    [DEMO_MEMBER_EMAIL, 'member'],
  ]);
  const plans = await t.deps.central.sql`select slug, plan from tenants order by slug`;
  assert.deepEqual(plans.map((r) => [r.slug, r.plan]), [
    ['tenant-a', 'pro'],
    ['tenant-b', 'free'],
  ]);

  const login = await t.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: DEMO_MEMBER_EMAIL, password: DEMO_PASSWORD },
  });
  const headers = { authorization: `Bearer ${login.json().accessToken}`, 'x-tenant': 'tenant-a' };
  const [project] = (await t.app.inject({ url: '/api/projects', headers })).json();
  const del = await t.app.inject({ method: 'DELETE', url: `/api/projects/${project.id}`, headers });
  assert.equal(del.statusCode, 403);
});
