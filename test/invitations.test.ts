import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { hashToken } from '../src/auth/tokens.ts';
import { createTestContext, type TestContext } from './helpers/context.ts';
import {
  asIn,
  createTeam,
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

let ip = 0;
/** Each invite comes from its own address so only the rate-limit test hits the per-IP limit. */
const invite = (tm: Team, as: TeamUser, email: string, role = 'member', remoteAddress = `10.77.0.${++ip % 250}`) =>
  t.app.inject({
    method: 'POST',
    url: '/members/invitations',
    headers: asIn(tm, as),
    remoteAddress,
    payload: { email, role },
  });
const mailsTo = (email: string) => t.mails.filter((m) => m.to === email);

test('an owner invites someone by email: the token is mailed, never returned', async () => {
  const tm = await createTeam(t, { plan: 'business' });
  const res = await invite(tm, tm.owner, 'new-1@example.test');
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.deepEqual(Object.keys(body).sort(), ['email', 'expiresAt', 'id', 'invitedBy', 'role']);
  assert.equal(body.email, 'new-1@example.test');
  assert.equal(body.role, 'member');
  assert.equal(body.invitedBy, tm.owner.id);
  assert.equal(JSON.stringify(body).includes('token'), false);

  const mails = mailsTo('new-1@example.test');
  assert.equal(mails.length, 1);
  assert.equal(mails[0]!.subject, `You're invited to ${tm.slug}`);
  assert.match(mails[0]!.text, new RegExp(tm.owner.email));
  assert.match(mails[0]!.text, /member/);
  assert.match(mails[0]!.text, /\/invitations\/accept\?token=/);
});

test('admins may invite admins; nobody may invite an owner; members may not invite', async () => {
  const tm = await createTeam(t, { plan: 'business' });
  assert.equal((await invite(tm, tm.admin, 'new-2@example.test', 'admin')).statusCode, 201);
  const owner = await invite(tm, tm.owner, 'new-3@example.test', 'owner');
  assert.equal(owner.statusCode, 400);
  assert.equal(owner.json().error.code, 'VALIDATION_FAILED');
  const byMember = await invite(tm, tm.member, 'new-4@example.test');
  assert.equal(byMember.statusCode, 403);
  assert.equal(byMember.json().error.code, 'FORBIDDEN');
});

test('inviting someone who is already a member is 409 ALREADY_MEMBER', async () => {
  const tm = await createTeam(t, { plan: 'business' });
  const res = await invite(tm, tm.owner, tm.member.email.toUpperCase());
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'ALREADY_MEMBER');
});

test('re-inviting the same email replaces the old link', async () => {
  const tm = await createTeam(t, { plan: 'business' });
  await invite(tm, tm.owner, 'again@example.test');
  const firstToken = tokenFromMail(mailsTo('again@example.test').at(-1));
  assert.equal((await invite(tm, tm.owner, 'again@example.test', 'admin')).statusCode, 201);

  const [old] = await t.deps.central.sql`select revoked_at from invitations where token_hash = ${hashToken(firstToken)}`;
  assert.ok(old!.revoked_at, 'first invitation should be revoked');
  const list = await t.app.inject({ url: '/members/invitations', headers: asIn(tm, tm.owner) });
  const mine = list.json().filter((i: { email: string }) => i.email === 'again@example.test');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].role, 'admin');
});

test('listing shows usable invitations only, newest first, and members may not list', async () => {
  const tm = await createTeam(t, { plan: 'business' });
  await invite(tm, tm.owner, 'one@example.test');
  await invite(tm, tm.owner, 'two@example.test');
  await invite(tm, tm.owner, 'expired@example.test');
  await t.deps.central.sql`update invitations set expires_at = now() - interval '1 second' where email = 'expired@example.test'`;

  const list = await t.app.inject({ url: '/members/invitations', headers: asIn(tm, tm.admin) });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(
    list.json().map((i: { email: string }) => i.email),
    ['two@example.test', 'one@example.test'],
  );
  assert.equal((await t.app.inject({ url: '/members/invitations', headers: asIn(tm, tm.member) })).statusCode, 403);
});

test('revoking an invitation removes it; revoking again is 404', async () => {
  const tm = await createTeam(t, { plan: 'business' });
  const { id } = (await invite(tm, tm.owner, 'revoke@example.test')).json();
  const del = () => t.app.inject({ method: 'DELETE', url: `/members/invitations/${id}`, headers: asIn(tm, tm.owner) });
  assert.equal((await del()).statusCode, 204);
  const list = await t.app.inject({ url: '/members/invitations', headers: asIn(tm, tm.owner) });
  assert.equal(list.json().length, 0);
  const again = await del();
  assert.equal(again.statusCode, 404);
  assert.equal(again.json().error.code, 'NOT_FOUND');
});

test("an invitation can't be revoked from another tenant", async () => {
  const a = await createTeam(t, { plan: 'business' });
  const b = await createTeam(t, { plan: 'business' });
  // a's owner also owns b, so the request passes b's guards.
  await t.deps.central.sql`
    insert into memberships (user_id, tenant_id, role)
    select ${a.owner.id}, id, 'owner' from tenants where slug = ${b.slug}`;
  const { id } = (await invite(a, a.owner, 'cross@example.test')).json();

  const res = await t.app.inject({ method: 'DELETE', url: `/members/invitations/${id}`, headers: asIn(b, a.owner) });
  assert.equal(res.statusCode, 404);
  const list = await t.app.inject({ url: '/members/invitations', headers: asIn(a, a.owner) });
  assert.equal(list.json().length, 1);
});

test('sending invitations is rate limited to 20 a minute per IP', async () => {
  const tm = await createTeam(t, { plan: 'business' });
  const codes: number[] = [];
  for (let i = 0; i < 21; i++) {
    codes.push((await invite(tm, tm.owner, `bulk-${i}@example.test`, 'member', '10.78.0.1')).statusCode);
  }
  assert.deepEqual(codes.slice(0, 20), Array(20).fill(201));
  assert.equal(codes[20], 429);
});

// --- accepting ---

const accept = (token: string, bearer?: string) =>
  t.app.inject({
    method: 'POST',
    url: '/invitations/accept',
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    payload: { token },
  });
/** The token from the latest invitation email (signing up also mails a verification link). */
const linkFor = (email: string) =>
  tokenFromMail(
    mailsTo(email.toLowerCase())
      .filter((m) => m.subject.startsWith("You're invited"))
      .at(-1),
  );

test('someone who already has an account accepts and can use the tenant', async () => {
  const tm = await createTeam(t, { plan: 'business' });
  const bearer = await signupAndToken(t, `existing-${tm.slug}@example.test`);
  await invite(tm, tm.owner, `existing-${tm.slug}@example.test`);
  const res = await accept(linkFor(`existing-${tm.slug}@example.test`), bearer);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().tenant.slug, tm.slug);
  assert.equal(res.json().role, 'member');
  const projects = await t.app.inject({ url: '/api/projects', headers: { authorization: `Bearer ${bearer}`, 'x-tenant': tm.slug } });
  assert.equal(projects.statusCode, 200);
});

test('someone new signs up from the link, accepts, and their email counts as verified', async () => {
  const tm = await createTeam(t, { plan: 'business' });
  const email = `fresh-${tm.slug}@example.test`;
  await invite(tm, tm.owner, email, 'admin');
  const bearer = await signupAndToken(t, email);
  const res = await accept(linkFor(email), bearer);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().role, 'admin');
  const [u] = await t.deps.central.sql`select email_verified_at from users where email = ${email}`;
  assert.ok(u!.email_verified_at);
});

test('an invitation to a differently-cased email is accepted by the same address', async () => {
  const tm = await createTeam(t, { plan: 'business' });
  await invite(tm, tm.owner, `Jane-${tm.slug}@Example.TEST`);
  const bearer = await signupAndToken(t, `jane-${tm.slug}@example.test`);
  assert.equal((await accept(linkFor(`jane-${tm.slug}@example.test`), bearer)).statusCode, 200);
});

test('used, revoked, expired and unknown links are all 400 INVITATION_INVALID', async () => {
  const tm = await createTeam(t, { plan: 'business' });
  const email = `links-${tm.slug}@example.test`;
  const bearer = await signupAndToken(t, email);
  const expectInvalid = async (token: string) => {
    const res = await accept(token, bearer);
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error.code, 'INVITATION_INVALID');
  };

  await invite(tm, tm.owner, email);
  const used = linkFor(email);
  assert.equal((await accept(used, bearer)).statusCode, 200);
  await expectInvalid(used);

  await t.deps.central.sql`delete from memberships where user_id = (select id from users where email = ${email})`;
  t.deps.cache.memberships.clear();
  const { id } = (await invite(tm, tm.owner, email)).json();
  const revoked = linkFor(email);
  await t.app.inject({ method: 'DELETE', url: `/members/invitations/${id}`, headers: asIn(tm, tm.owner) });
  await expectInvalid(revoked);

  await invite(tm, tm.owner, email);
  const expired = linkFor(email);
  await t.deps.central.sql`update invitations set expires_at = now() - interval '1 second' where token_hash = ${hashToken(expired)}`;
  await expectInvalid(expired);

  await expectInvalid('not-a-real-token');
});

test('the wrong account is refused and the link still works for the right one', async () => {
  const tm = await createTeam(t, { plan: 'business' });
  const email = `right-${tm.slug}@example.test`;
  await invite(tm, tm.owner, email);
  const token = linkFor(email);
  const wrong = await signupAndToken(t, `wrong-${tm.slug}@example.test`);
  const res = await accept(token, wrong);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'INVITATION_EMAIL_MISMATCH');
  assert.equal((await accept(token, await signupAndToken(t, email))).statusCode, 200);
});

test('accepting when already a member keeps the existing role', async () => {
  const tm = await createTeam(t, { plan: 'business' });
  const token = 'known-token-for-an-existing-admin';
  await t.deps.central.sql`
    insert into invitations (tenant_id, email, role, token_hash, expires_at)
    select id, ${tm.admin.email}, 'member', ${hashToken(token)}, now() + interval '7 days' from tenants where slug = ${tm.slug}`;
  const res = await accept(token, tm.admin.token);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().role, 'admin');
});

test('an invitation to a suspended tenant cannot be accepted', async () => {
  const tm = await createTeam(t, { plan: 'business' });
  const email = `susp-${tm.slug}@example.test`;
  await invite(tm, tm.owner, email);
  await t.deps.central.sql`update tenants set status = 'suspended' where slug = ${tm.slug}`;
  t.deps.cache.bySlug.clear();
  const res = await accept(linkFor(email), await signupAndToken(t, email));
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'TENANT_SUSPENDED');
});

test('accepting needs a signed-in user', async () => {
  assert.equal((await accept('anything')).statusCode, 401);
});
