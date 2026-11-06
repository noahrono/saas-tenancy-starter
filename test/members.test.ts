import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, type TestContext } from './helpers/context.ts';
import { addMember, createTenant, createTestApp, signupAndToken, type TestApp } from './helpers/app.ts';

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

interface Who {
  token: string;
  id: string;
}
interface Team {
  slug: string;
  owner: Who;
  admin: Who;
  member: Who;
}

let n = 0;
const userId = async (email: string) =>
  (await t.deps.central.sql<{ id: string }[]>`select id from users where email = ${email}`)[0]!.id;

/** A fresh tenant with one owner, one admin and one member. */
async function team(): Promise<Team> {
  const slug = `team-${++n}`;
  const ownerEmail = `owner-${n}@example.test`;
  const ownerToken = await signupAndToken(t, ownerEmail);
  await createTenant(t, ownerToken, slug);
  const adminToken = await addMember(t, slug, `admin-${n}@example.test`, 'admin');
  const memberToken = await addMember(t, slug, `member-${n}@example.test`, 'member');
  return {
    slug,
    owner: { token: ownerToken, id: await userId(ownerEmail) },
    admin: { token: adminToken, id: await userId(`admin-${n}@example.test`) },
    member: { token: memberToken, id: await userId(`member-${n}@example.test`) },
  };
}

const h = (tm: Team, who: Who) => ({ authorization: `Bearer ${who.token}`, 'x-tenant': tm.slug });
const patch = (tm: Team, as: Who, target: string, role: string) =>
  t.app.inject({ method: 'PATCH', url: `/members/${target}`, headers: h(tm, as), payload: { role } });
const remove = (tm: Team, as: Who, target: string) =>
  t.app.inject({ method: 'DELETE', url: `/members/${target}`, headers: h(tm, as) });
const owners = async (tm: Team) =>
  (await t.app.inject({ url: '/members', headers: h(tm, tm.owner) }))
    .json()
    .filter((m: { role: string }) => m.role === 'owner').length;

test('GET /members lists everyone, owners first', async () => {
  const tm = await team();
  const res = await t.app.inject({ url: '/members', headers: h(tm, tm.member) });
  assert.equal(res.statusCode, 200);
  const list = res.json();
  assert.equal(list.length, 3);
  assert.equal(list[0].role, 'owner');
  assert.equal(list[0].userId, tm.owner.id);
  assert.deepEqual(Object.keys(list[0]).sort(), ['email', 'joinedAt', 'role', 'userId']);
});

test('an admin can promote a member to admin and demote an admin to member', async () => {
  const tm = await team();
  assert.equal((await patch(tm, tm.admin, tm.member.id, 'admin')).statusCode, 200);
  const back = await patch(tm, tm.admin, tm.member.id, 'member');
  assert.equal(back.statusCode, 200);
  assert.equal(back.json().role, 'member');
});

test('an admin cannot touch owners or create them, including themselves', async () => {
  const tm = await team();
  assert.equal((await patch(tm, tm.admin, tm.owner.id, 'member')).statusCode, 403);
  assert.equal((await patch(tm, tm.admin, tm.member.id, 'owner')).statusCode, 403);
  const self = await patch(tm, tm.admin, tm.admin.id, 'owner');
  assert.equal(self.statusCode, 403);
  assert.equal(self.json().error.code, 'FORBIDDEN');
  assert.equal((await remove(tm, tm.admin, tm.owner.id)).statusCode, 403);
  assert.equal(await owners(tm), 1);
});

test('a member cannot change roles or remove others', async () => {
  const tm = await team();
  assert.equal((await patch(tm, tm.member, tm.admin.id, 'member')).statusCode, 403);
  assert.equal((await remove(tm, tm.member, tm.admin.id)).statusCode, 403);
});

test('an owner can make another owner, and an admin can remove a member', async () => {
  const tm = await team();
  assert.equal((await patch(tm, tm.owner, tm.admin.id, 'owner')).statusCode, 200);
  assert.equal(await owners(tm), 2);
  assert.equal((await remove(tm, tm.admin, tm.member.id)).statusCode, 204);
});

test('the only owner cannot be demoted or leave', async () => {
  const tm = await team();
  const demote = await patch(tm, tm.owner, tm.owner.id, 'admin');
  assert.equal(demote.statusCode, 409);
  assert.equal(demote.json().error.code, 'LAST_OWNER');
  const leave = await remove(tm, tm.owner, tm.owner.id);
  assert.equal(leave.statusCode, 409);
  assert.equal(leave.json().error.code, 'LAST_OWNER');
  assert.equal(await owners(tm), 1);
});

test('an owner can step down once there is another owner', async () => {
  const tm = await team();
  await patch(tm, tm.owner, tm.admin.id, 'owner');
  assert.equal((await patch(tm, tm.owner, tm.owner.id, 'member')).statusCode, 200);
  assert.equal(await owners(tm), 1);
});

test('two owners demoting each other at the same moment leaves exactly one owner', async () => {
  const tm = await team();
  await patch(tm, tm.owner, tm.admin.id, 'owner');
  const results = await Promise.all([
    patch(tm, tm.owner, tm.admin.id, 'member'),
    patch(tm, tm.admin, tm.owner.id, 'member'),
  ]);
  // Whoever goes second has just been demoted to member, so their request is refused for lack
  // of permission. Either way the tenant keeps exactly one owner.
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 403]);
  assert.equal(await owners(tm), 1);
});

test('a member who leaves loses access on their very next request', async () => {
  const tm = await team();
  const warm = await t.app.inject({ url: '/api/projects', headers: h(tm, tm.member) });
  assert.equal(warm.statusCode, 200);
  assert.equal((await remove(tm, tm.member, tm.member.id)).statusCode, 204);
  const after = await t.app.inject({ url: '/api/projects', headers: h(tm, tm.member) });
  assert.equal(after.statusCode, 404);
  assert.equal(after.json().error.code, 'TENANT_NOT_FOUND');
});

test('a removed member loses access straight away too', async () => {
  const tm = await team();
  await t.app.inject({ url: '/api/projects', headers: h(tm, tm.member) });
  assert.equal((await remove(tm, tm.owner, tm.member.id)).statusCode, 204);
  assert.equal((await t.app.inject({ url: '/api/projects', headers: h(tm, tm.member) })).statusCode, 404);
});

test('a demoted admin loses admin rights straight away', async () => {
  const tm = await team();
  await t.app.inject({ url: '/members', headers: h(tm, tm.admin) });
  await patch(tm, tm.owner, tm.admin.id, 'member');
  assert.equal((await remove(tm, tm.admin, tm.member.id)).statusCode, 403);
});

test('changing or removing someone who is not a member is 404 NOT_FOUND', async () => {
  const tm = await team();
  const stranger = await userId((await signupAndToken(t, `stranger-${n}@example.test`), `stranger-${n}@example.test`));
  for (const res of [await patch(tm, tm.owner, stranger, 'member'), await remove(tm, tm.owner, stranger)]) {
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'NOT_FOUND');
  }
});

test('setting the role someone already has changes nothing', async () => {
  const tm = await team();
  const res = await patch(tm, tm.owner, tm.member.id, 'member');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().role, 'member');
});
