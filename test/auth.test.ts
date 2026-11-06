import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, type TestContext } from './helpers/context.ts';
import { createTestApp, refreshCookie, tokenFromMail, type TestApp } from './helpers/app.ts';

let ctx: TestContext;
let t: TestApp;
const PASSWORD = 'correct-horse-9';

beforeEach(async () => {
  ctx = await createTestContext();
  t = await createTestApp(ctx);
});
afterEach(async () => {
  await t.close();
  await ctx.cleanup();
});

const signup = (email = 'demo@example.test', password = PASSWORD) =>
  t.app.inject({ method: 'POST', url: '/auth/signup', payload: { email, password } });
const login = (email = 'demo@example.test', password = PASSWORD) =>
  t.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });

test('signup returns an access token and sets the refresh cookie', async () => {
  const res = await signup();
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.user.email, 'demo@example.test');
  assert.equal(typeof body.accessToken, 'string');
  const cookie = res.cookies.find((c) => c.name === 'rt');
  assert.ok(cookie);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'Strict');
  assert.equal(cookie.path, '/auth');
  assert.equal(cookie.maxAge, 30 * 24 * 3600);
});

test('a duplicate email is rejected', async () => {
  await signup();
  const res = await signup();
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'EMAIL_TAKEN');
});

test('email case and surrounding spaces do not create a second account', async () => {
  assert.equal((await signup(' Demo@Example.test ')).statusCode, 201);
  assert.equal((await login('demo@example.test')).statusCode, 200);
  assert.equal((await signup('DEMO@example.test')).json().error.code, 'EMAIL_TAKEN');
});

test('a wrong password and an unknown email look the same', async () => {
  await signup();
  const wrong = await login('demo@example.test', 'wrong-password-1');
  const unknown = await login('nobody@example.test', PASSWORD);
  assert.equal(wrong.statusCode, 401);
  assert.equal(unknown.statusCode, 401);
  assert.equal(wrong.json().error.code, 'INVALID_CREDENTIALS');
  assert.equal(wrong.json().error.message, unknown.json().error.message);
});

test('passwords must be 10 to 128 characters', async () => {
  assert.equal((await signup('a@example.test', 'nine-char')).json().error.code, 'VALIDATION_FAILED');
  assert.equal((await signup('b@example.test', 'x'.repeat(129))).statusCode, 400);
});

test('GET /auth/me needs a bearer token', async () => {
  const { accessToken } = (await signup()).json();
  const me = await t.app.inject({ url: '/auth/me', headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().email, 'demo@example.test');
  assert.equal(me.json().emailVerified, false);
  const anon = await t.app.inject('/auth/me');
  assert.equal(anon.statusCode, 401);
  assert.equal(anon.json().error.code, 'UNAUTHENTICATED');
});

test('refresh rotates the cookie, and logout ends the session', async () => {
  const first = refreshCookie(await signup());
  const refreshed = await t.app.inject({ method: 'POST', url: '/auth/refresh', cookies: { rt: first } });
  assert.equal(refreshed.statusCode, 200);
  assert.equal(typeof refreshed.json().accessToken, 'string');
  const second = refreshCookie(refreshed);
  assert.notEqual(second, first);

  const out = await t.app.inject({ method: 'POST', url: '/auth/logout', cookies: { rt: second } });
  assert.equal(out.statusCode, 204);
  const after = await t.app.inject({ method: 'POST', url: '/auth/refresh', cookies: { rt: second } });
  assert.equal(after.statusCode, 401);
});

test('refresh without a cookie is 401', async () => {
  const res = await t.app.inject({ method: 'POST', url: '/auth/refresh' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'UNAUTHENTICATED');
});

test('login is rate limited per email', async () => {
  await signup();
  for (let i = 0; i < 5; i++) await login('demo@example.test', 'wrong-password-1');
  const sixth = await login('demo@example.test', 'wrong-password-1');
  assert.equal(sixth.statusCode, 429);
  assert.equal(sixth.json().error.code, 'RATE_LIMITED');
});

test('login is rate limited per IP across emails', async () => {
  const codes: number[] = [];
  for (let i = 0; i < 11; i++) codes.push((await login(`user${i}@example.test`, PASSWORD)).statusCode);
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(401));
  assert.equal(codes[10], 429);
});

test('signup mails a verification link that works once', async () => {
  const { accessToken } = (await signup()).json();
  assert.equal(t.mails.length, 1);
  assert.equal(t.mails[0]!.to, 'demo@example.test');
  const token = tokenFromMail(t.mails[0]);

  const ok = await t.app.inject({ method: 'POST', url: '/auth/verify-email', payload: { token } });
  assert.equal(ok.statusCode, 204);
  const me = await t.app.inject({ url: '/auth/me', headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(me.json().emailVerified, true);
  const again = await t.app.inject({ method: 'POST', url: '/auth/verify-email', payload: { token } });
  assert.equal(again.statusCode, 400);
  assert.equal(again.json().error.code, 'TOKEN_INVALID');
});

test('password reset: unknown email sends nothing, known email resets and ends sessions', async () => {
  const oldCookie = refreshCookie(await signup());
  t.mails.length = 0;

  const unknown = await t.app.inject({
    method: 'POST',
    url: '/auth/password-reset/request',
    payload: { email: 'nobody@example.test' },
  });
  assert.equal(unknown.statusCode, 204);
  assert.equal(t.mails.length, 0);

  const known = await t.app.inject({
    method: 'POST',
    url: '/auth/password-reset/request',
    payload: { email: 'demo@example.test' },
  });
  assert.equal(known.statusCode, 204);
  assert.equal(t.mails.length, 1);
  const token = tokenFromMail(t.mails[0]);

  const confirm = await t.app.inject({
    method: 'POST',
    url: '/auth/password-reset/confirm',
    payload: { token, password: 'brand-new-password' },
  });
  assert.equal(confirm.statusCode, 204);
  assert.equal((await login('demo@example.test', PASSWORD)).statusCode, 401);
  assert.equal((await login('demo@example.test', 'brand-new-password')).statusCode, 200);
  const stale = await t.app.inject({ method: 'POST', url: '/auth/refresh', cookies: { rt: oldCookie } });
  assert.equal(stale.statusCode, 401);

  const reuse = await t.app.inject({
    method: 'POST',
    url: '/auth/password-reset/confirm',
    payload: { token, password: 'another-password-1' },
  });
  assert.equal(reuse.json().error.code, 'TOKEN_INVALID');
});

test('a forged X-Forwarded-For header does not dodge the per-IP limit', async () => {
  const codes: number[] = [];
  for (let i = 0; i < 11; i++) {
    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-forwarded-for': `203.0.113.${i}` },
      payload: { email: `forged${i}@example.test`, password: PASSWORD },
    });
    codes.push(res.statusCode);
  }
  assert.equal(codes[10], 429);
});
