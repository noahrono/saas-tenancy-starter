import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, type TestContext } from './helpers/context.ts';
import { addMember, createTenant, createTestApp, signupAndToken, type TestApp } from './helpers/app.ts';

let ctx: TestContext;
let t: TestApp;
const tokens: Record<string, string> = {};

before(async () => {
  ctx = await createTestContext();
  t = await createTestApp(ctx);
  tokens.owner = await signupAndToken(t, 'owner@example.test');
  await createTenant(t, tokens.owner, 'tenant-a');
  tokens.admin = await addMember(t, 'tenant-a', 'admin@example.test', 'admin');
  tokens.member = await addMember(t, 'tenant-a', 'member@example.test', 'member');
  tokens.outsider = await signupAndToken(t, 'outsider@example.test');
});
after(async () => {
  await t.close();
  await ctx.cleanup();
});

const as = (who: string) => ({ authorization: `Bearer ${tokens[who]}`, 'x-tenant': 'tenant-a' });

async function newProjectId(): Promise<string> {
  const res = await t.app.inject({ method: 'POST', url: '/api/projects', headers: as('owner'), payload: { name: 'p' } });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}

const EXPECT = {
  'GET /api/projects': { owner: 200, admin: 200, member: 200, outsider: 404 },
  'POST /api/projects': { owner: 201, admin: 201, member: 201, outsider: 404 },
  'DELETE /api/projects/:id': { owner: 204, admin: 204, member: 403, outsider: 404 },
} as const;

for (const [route, byRole] of Object.entries(EXPECT)) {
  for (const [who, status] of Object.entries(byRole)) {
    test(`${route} as ${who} → ${status}`, async () => {
      const [method, path] = route.split(' ') as ['GET' | 'POST' | 'DELETE', string];
      const url = path.replace(':id', method === 'DELETE' ? await newProjectId() : '');
      const res = await t.app.inject({
        method,
        url,
        headers: as(who),
        ...(method === 'POST' ? { payload: { name: `by ${who}` } } : {}),
      });
      assert.equal(res.statusCode, status, res.body);
    });
  }
}

test('a forbidden request names the permission it lacks', async () => {
  const res = await t.app.inject({ method: 'DELETE', url: `/api/projects/${await newProjectId()}`, headers: as('member') });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'FORBIDDEN');
  assert.deepEqual(res.json().error.details, { permission: 'projects:delete' });
});

test('deleting a project that does not exist is 404 NOT_FOUND', async () => {
  const res = await t.app.inject({
    method: 'DELETE',
    url: '/api/projects/00000000-0000-4000-8000-000000000000',
    headers: as('owner'),
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, 'NOT_FOUND');
});

test('a deleted project is gone from the list', async () => {
  const id = await newProjectId();
  await t.app.inject({ method: 'DELETE', url: `/api/projects/${id}`, headers: as('admin') });
  const list = await t.app.inject({ url: '/api/projects', headers: as('owner') });
  assert.equal(list.json().some((p: { id: string }) => p.id === id), false);
});
