import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, type TestContext } from './helpers/context.ts';
import { asIn, createTeam, createTestApp, type TestApp } from './helpers/app.ts';

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

test('export is refused on free, naming the plan that has it', async () => {
  const tm = await createTeam(t);
  const res = await t.app.inject({ url: '/api/projects/export', headers: asIn(tm, tm.owner) });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'FEATURE_NOT_AVAILABLE');
  assert.deepEqual(res.json().error.details, { feature: 'projects:export', plan: 'free', requiredPlan: 'pro' });
});

test('after upgrading to pro, the very next export works', async () => {
  const tm = await createTeam(t);
  await t.app.inject({ method: 'POST', url: '/api/projects', headers: asIn(tm, tm.member), payload: { name: 'Roadmap, 2027' } });
  // Warm the tenant cache on the free plan first.
  assert.equal((await t.app.inject({ url: '/api/projects/export', headers: asIn(tm, tm.owner) })).statusCode, 403);

  const up = await t.app.inject({ method: 'PUT', url: '/tenant/plan', headers: asIn(tm, tm.owner), payload: { plan: 'pro' } });
  assert.equal(up.statusCode, 200, up.body);
  assert.equal(up.json().plan, 'pro');
  assert.equal(up.json().limits.members, 20);

  const res = await t.app.inject({ url: '/api/projects/export', headers: asIn(tm, tm.member) });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.headers['content-type'] as string, /^text\/csv/);
  const lines = res.body.split('\r\n');
  assert.equal(lines[0], 'id,name,createdBy,createdAt');
  assert.match(lines[1]!, /"Roadmap, 2027"/);
});

test('only an owner can change the plan, and only to a real plan', async () => {
  const tm = await createTeam(t);
  const byAdmin = await t.app.inject({ method: 'PUT', url: '/tenant/plan', headers: asIn(tm, tm.admin), payload: { plan: 'pro' } });
  assert.equal(byAdmin.statusCode, 403);
  assert.equal(byAdmin.json().error.code, 'FORBIDDEN');
  const gold = await t.app.inject({ method: 'PUT', url: '/tenant/plan', headers: asIn(tm, tm.owner), payload: { plan: 'gold' } });
  assert.equal(gold.statusCode, 400);
});

test('any member can see the plan, its limits and current usage', async () => {
  const tm = await createTeam(t);
  for (const name of ['one', 'two']) {
    await t.app.inject({ method: 'POST', url: '/api/projects', headers: asIn(tm, tm.owner), payload: { name } });
  }
  const res = await t.app.inject({ url: '/tenant/plan', headers: asIn(tm, tm.member) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    plan: 'free',
    name: 'Free',
    features: [],
    limits: { members: 3, projects: 10 },
    usage: { members: 3, projects: 2 },
  });
});
