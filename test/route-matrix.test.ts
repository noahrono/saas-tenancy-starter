import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, type TestContext } from './helpers/context.ts';
import {
  addMember,
  asIn,
  createTeam,
  createTestApp,
  signupAndToken,
  type Team,
  type TeamUser,
  type TestApp,
} from './helpers/app.ts';

/**
 * Every protected tenant route, called as each role and as an outsider. Expected statuses come
 * from the spec's role table. A route registered without requireTenant or requirePermission, or
 * a change to who may do what, shows up here.
 */

let ctx: TestContext;
let t: TestApp;
let tm: Team;
let outsider: TeamUser;

before(async () => {
  ctx = await createTestContext();
  t = await createTestApp(ctx);
  // Business, so plan limits never get in the way of a permission check.
  tm = await createTeam(t, { plan: 'business' });
  const email = 'outsider@example.test';
  const token = await signupAndToken(t, email);
  outsider = { token, id: '', email };
});
after(async () => {
  await t.close();
  await ctx.cleanup();
});

type Who = 'owner' | 'admin' | 'member' | 'outsider';
const user = (who: Who) => (who === 'outsider' ? outsider : tm[who]);

let k = 0;
const fresh = (label: string) => `${label}-${++k}@example.test`;
const userIdOf = async (email: string) =>
  (await t.deps.central.sql<{ id: string }[]>`select id from users where email = ${email}`)[0]!.id;

/** Something for a request to act on, created as the owner so each case starts clean. */
const setup = {
  project: async () =>
    (await t.app.inject({ method: 'POST', url: '/api/projects', headers: asIn(tm, tm.owner), payload: { name: 'p' } })).json()
      .id as string,
  extraMember: async () => {
    const email = fresh('extra');
    await addMember(t, tm.slug, email, 'member');
    return userIdOf(email);
  },
  invitation: async () =>
    (
      await t.app.inject({
        method: 'POST',
        url: '/members/invitations',
        headers: asIn(tm, tm.owner),
        remoteAddress: `10.55.0.${(k % 250) + 1}`,
        payload: { email: fresh('pending'), role: 'member' },
      })
    ).json().id as string,
};

interface Case {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: (id: string) => string;
  target?: () => Promise<string>;
  body?: () => object;
  expect: Record<Who, number>;
}

const CASES: Record<string, Case> = {
  'GET /api/projects': { method: 'GET', url: () => '/api/projects', expect: { owner: 200, admin: 200, member: 200, outsider: 404 } },
  'POST /api/projects': {
    method: 'POST',
    url: () => '/api/projects',
    body: () => ({ name: 'n' }),
    expect: { owner: 201, admin: 201, member: 201, outsider: 404 },
  },
  'DELETE /api/projects/:id': {
    method: 'DELETE',
    url: (id) => `/api/projects/${id}`,
    target: setup.project,
    expect: { owner: 204, admin: 204, member: 403, outsider: 404 },
  },
  'GET /api/projects/export': {
    method: 'GET',
    url: () => '/api/projects/export',
    expect: { owner: 200, admin: 200, member: 200, outsider: 404 },
  },
  'GET /members': { method: 'GET', url: () => '/members', expect: { owner: 200, admin: 200, member: 200, outsider: 404 } },
  'PATCH /members/:userId': {
    method: 'PATCH',
    url: (id) => `/members/${id}`,
    target: setup.extraMember,
    body: () => ({ role: 'admin' }),
    expect: { owner: 200, admin: 200, member: 403, outsider: 404 },
  },
  'DELETE /members/:userId (someone else)': {
    method: 'DELETE',
    url: (id) => `/members/${id}`,
    target: setup.extraMember,
    expect: { owner: 204, admin: 204, member: 403, outsider: 404 },
  },
  'POST /members/invitations': {
    method: 'POST',
    url: () => '/members/invitations',
    body: () => ({ email: fresh('invitee'), role: 'member' }),
    expect: { owner: 201, admin: 201, member: 403, outsider: 404 },
  },
  'GET /members/invitations': {
    method: 'GET',
    url: () => '/members/invitations',
    expect: { owner: 200, admin: 200, member: 403, outsider: 404 },
  },
  'DELETE /members/invitations/:id': {
    method: 'DELETE',
    url: (id) => `/members/invitations/${id}`,
    target: setup.invitation,
    expect: { owner: 204, admin: 204, member: 403, outsider: 404 },
  },
  'GET /tenant/plan': { method: 'GET', url: () => '/tenant/plan', expect: { owner: 200, admin: 200, member: 200, outsider: 404 } },
  'PUT /tenant/plan': {
    method: 'PUT',
    url: () => '/tenant/plan',
    body: () => ({ plan: 'business' }),
    expect: { owner: 200, admin: 403, member: 403, outsider: 404 },
  },
};

for (const [route, c] of Object.entries(CASES)) {
  for (const [who, status] of Object.entries(c.expect) as [Who, number][]) {
    test(`${route} as ${who} → ${status}`, async () => {
      const id = c.target ? await c.target() : '';
      const res = await t.app.inject({
        method: c.method,
        url: c.url(id),
        headers: asIn(tm, user(who)),
        remoteAddress: `10.56.0.${(++k % 250) + 1}`,
        ...(c.body ? { payload: c.body() } : {}),
      });
      assert.equal(res.statusCode, status, res.body);
      if (status === 404 && who === 'outsider') assert.equal(res.json().error.code, 'TENANT_NOT_FOUND');
      if (status === 403) assert.equal(res.json().error.code, 'FORBIDDEN');
    });
  }
}
