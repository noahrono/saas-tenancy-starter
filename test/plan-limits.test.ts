import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, type TestContext } from './helpers/context.ts';
import {
  addMember,
  asIn,
  createTeam,
  createTenant,
  createTestApp,
  signupAndToken,
  tokenFromMail,
  type Team,
  type TeamUser,
  type TestApp,
} from './helpers/app.ts';

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

let n = 0;
let ip = 0;

/** A free tenant with only its owner, so it has 2 seats left. */
async function solo(): Promise<Team> {
  const slug = `solo-${++n}`;
  const email = `solo-owner-${n}@example.test`;
  const token = await signupAndToken(t, email);
  await createTenant(t, token, slug);
  const [row] = await t.deps.central.sql<{ id: string }[]>`select id from users where email = ${email}`;
  const owner: TeamUser = { token, id: row!.id, email };
  return { slug, owner, admin: owner, member: owner };
}

const invite = (tm: Team, email: string) =>
  t.app.inject({
    method: 'POST',
    url: '/members/invitations',
    headers: asIn(tm, tm.owner),
    remoteAddress: `10.66.0.${(++ip % 250) + 1}`,
    payload: { email, role: 'member' },
  });
const accept = async (email: string) => {
  const mail = t.mails.filter((m) => m.to === email && m.subject.startsWith("You're invited")).at(-1);
  return t.app.inject({
    method: 'POST',
    url: '/invitations/accept',
    headers: { authorization: `Bearer ${await signupAndToken(t, email)}` },
    payload: { token: tokenFromMail(mail) },
  });
};
const setPlan = (tm: Team, plan: string) =>
  t.app.inject({ method: 'PUT', url: '/tenant/plan', headers: asIn(tm, tm.owner), payload: { plan } });

test('free allows 3 members counting open invitations; the next invite is refused', async () => {
  const tm = await solo();
  assert.equal((await invite(tm, `a-${n}@example.test`)).statusCode, 201);
  assert.equal((await invite(tm, `b-${n}@example.test`)).statusCode, 201);
  const third = await invite(tm, `c-${n}@example.test`);
  assert.equal(third.statusCode, 403);
  assert.equal(third.json().error.code, 'PLAN_LIMIT_REACHED');
  assert.deepEqual(third.json().error.details, { limit: 'members', max: 3, plan: 'free' });
});

test('re-inviting a pending email does not count it twice', async () => {
  const tm = await solo();
  await invite(tm, `a-${n}@example.test`);
  await invite(tm, `b-${n}@example.test`);
  assert.equal((await invite(tm, `a-${n}@example.test`)).statusCode, 201);
});

test('a pending invitation can be accepted when the tenant is exactly at its limit', async () => {
  const tm = await solo();
  await invite(tm, `a-${n}@example.test`);
  await invite(tm, `b-${n}@example.test`);
  assert.equal((await accept(`a-${n}@example.test`)).statusCode, 200);
});

test('two invitations racing for the last seat: exactly one wins', async () => {
  const tm = await solo();
  await invite(tm, `a-${n}@example.test`);
  const codes = (await Promise.all([invite(tm, `x-${n}@example.test`), invite(tm, `y-${n}@example.test`)])).map(
    (r) => r.statusCode,
  );
  assert.deepEqual(codes.sort(), [201, 403]);
});

test('downgrading keeps everyone but blocks new members, including pending invitations', async () => {
  const tm = await createTeam(t);
  assert.equal((await setPlan(tm, 'pro')).statusCode, 200);
  await addMember(t, tm.slug, `extra1-${tm.slug}@example.test`, 'member');
  await addMember(t, tm.slug, `extra2-${tm.slug}@example.test`, 'member');
  assert.equal((await invite(tm, `pending-${tm.slug}@example.test`)).statusCode, 201);

  assert.equal((await setPlan(tm, 'free')).statusCode, 200);
  const members = await t.app.inject({ url: '/members', headers: asIn(tm, tm.owner) });
  assert.equal(members.json().length, 5);
  assert.equal((await invite(tm, `late-${tm.slug}@example.test`)).statusCode, 403);
  const acc = await accept(`pending-${tm.slug}@example.test`);
  assert.equal(acc.statusCode, 403);
  assert.equal(acc.json().error.code, 'PLAN_LIMIT_REACHED');
});

test('plan usage counts open invitations as members', async () => {
  const tm = await solo();
  await invite(tm, `a-${n}@example.test`);
  const res = await t.app.inject({ url: '/tenant/plan', headers: asIn(tm, tm.owner) });
  assert.equal(res.json().usage.members, 2);
});
