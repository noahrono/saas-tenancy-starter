import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, type TestContext } from './helpers/context.ts';
import { createTestApp, signupAndToken, type TestApp } from './helpers/app.ts';

let ctx: TestContext;
let t: TestApp;
let token: string;

before(async () => {
  ctx = await createTestContext();
  t = await createTestApp(ctx);
  token = await signupAndToken(t, 'both@example.test');
  for (const slug of ['tenant-a', 'tenant-b']) {
    await t.app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${token}` },
      payload: { slug, name: slug },
    });
  }
});
after(async () => {
  await t.close();
  await ctx.cleanup();
});

const as = (slug: string) => ({ authorization: `Bearer ${token}`, 'x-tenant': slug });

test('data written in tenant A is never visible from tenant B, even to a member of both', async () => {
  const created = await t.app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: as('tenant-a'),
    payload: { name: 'alpha' },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().name, 'alpha');

  const fromB = await t.app.inject({ url: '/api/projects', headers: as('tenant-b') });
  assert.equal(fromB.statusCode, 200);
  assert.deepEqual(fromB.json(), []);

  const fromA = await t.app.inject({ url: '/api/projects', headers: as('tenant-a') });
  assert.deepEqual(
    fromA.json().map((p: { name: string }) => p.name),
    ['alpha'],
  );
});

test('each tenant really has its own database', async () => {
  const rows = await t.deps.central.sql`select db_name from tenants order by slug`;
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0]!.db_name, rows[1]!.db_name);
  const dbs = await ctx.adminSql`select datname from pg_database where datname in ${ctx.adminSql(rows.map((r) => r.db_name))}`;
  assert.equal(dbs.length, 2);
});

test('created_by records the user who wrote it', async () => {
  const me = (await t.app.inject({ url: '/auth/me', headers: { authorization: `Bearer ${token}` } })).json();
  const [p] = (await t.app.inject({ url: '/api/projects', headers: as('tenant-a') })).json();
  assert.equal(p.createdBy, me.id);
});
