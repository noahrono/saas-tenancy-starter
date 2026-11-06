import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTokenService, type TokenService } from '../src/auth/tokens.ts';
import { createCentralDb, type CentralDb } from '../src/db/central/client.ts';
import { AppError } from '../src/errors.ts';
import { createTestContext, testKeys, type TestContext } from './helpers/context.ts';

let ctx: TestContext;
let central: CentralDb;
let clock: Date;
let tokens: TokenService;
let userId: string;

const code = (c: string) => (e: unknown) => e instanceof AppError && e.code === c;

beforeEach(async () => {
  ctx = await createTestContext();
  central = createCentralDb(ctx.centralUrl);
  clock = new Date('2026-03-01T00:00:00Z');
  tokens = createTokenService({ ...ctx.config.jwt, central, now: () => clock });
  const [u] = await central.sql`insert into users (email, password_hash) values ('demo@example.test', 'h') returning id`;
  userId = u!.id;
});
afterEach(async () => {
  await central.end();
  await ctx.cleanup();
});

test('access tokens verify and carry the user id', async () => {
  const token = await tokens.signAccess(userId);
  assert.deepEqual(await tokens.verifyAccess(token), { userId });
});

test('access tokens from another key are rejected', async () => {
  const other = createTokenService({ ...testKeys(), central });
  const token = await other.signAccess(userId);
  await assert.rejects(() => tokens.verifyAccess(token), code('UNAUTHENTICATED'));
});

test('access tokens expire after 15 minutes', async () => {
  const token = await tokens.signAccess(userId);
  clock = new Date(clock.getTime() + 14 * 60_000);
  await tokens.verifyAccess(token);
  clock = new Date(clock.getTime() + 2 * 60_000);
  await assert.rejects(() => tokens.verifyAccess(token), code('UNAUTHENTICATED'));
});

test('garbage access tokens are rejected', async () => {
  await assert.rejects(() => tokens.verifyAccess('not.a.jwt'), code('UNAUTHENTICATED'));
});

test('rotating a refresh token revokes it and links the replacement', async () => {
  const first = await tokens.issueRefresh(userId);
  assert.equal(first.expiresAt.getTime(), clock.getTime() + 30 * 24 * 3600_000);
  const second = await tokens.rotateRefresh(first.token);
  assert.equal(second.userId, userId);
  assert.notEqual(second.token, first.token);

  const rows = await central.sql`select revoked_at, replaced_by, family_id from refresh_tokens order by created_at, id`;
  assert.equal(rows.length, 2);
  const revoked = rows.filter((r) => r.revoked_at !== null);
  assert.equal(revoked.length, 1);
  assert.ok(revoked[0]!.replaced_by);
  assert.equal(rows[0]!.family_id, rows[1]!.family_id);
});

test('tokens are stored hashed, never in plain text', async () => {
  const { token } = await tokens.issueRefresh(userId);
  const rows = await central.sql`select token_hash from refresh_tokens`;
  assert.notEqual(rows[0]!.token_hash, token);
  assert.match(rows[0]!.token_hash, /^[0-9a-f]{64}$/);
});

test('reusing a rotated refresh token after the grace window revokes the whole family', async () => {
  const first = await tokens.issueRefresh(userId);
  const second = await tokens.rotateRefresh(first.token);
  clock = new Date(clock.getTime() + 31_000);
  await assert.rejects(() => tokens.rotateRefresh(first.token), code('REFRESH_REUSED'));
  await assert.rejects(() => tokens.rotateRefresh(second.token), code('UNAUTHENTICATED'));
});

test('expired and unknown refresh tokens are rejected', async () => {
  const { token } = await tokens.issueRefresh(userId);
  clock = new Date(clock.getTime() + 31 * 24 * 3600_000);
  await assert.rejects(() => tokens.rotateRefresh(token), code('UNAUTHENTICATED'));
  await assert.rejects(() => tokens.rotateRefresh('made-up-token'), code('UNAUTHENTICATED'));
});

test('revokeFamily ends the session', async () => {
  const { token } = await tokens.issueRefresh(userId);
  await tokens.revokeFamily(token);
  await assert.rejects(() => tokens.rotateRefresh(token), code('UNAUTHENTICATED'));
});

test('reuse within the grace window is refused without ending the session', async () => {
  const first = await tokens.issueRefresh(userId);
  const second = await tokens.rotateRefresh(first.token);
  clock = new Date(clock.getTime() + 5_000);
  await assert.rejects(() => tokens.rotateRefresh(first.token), code('UNAUTHENTICATED'));
  const third = await tokens.rotateRefresh(second.token);
  assert.equal(third.userId, userId);
});

test('a double-submitted refresh keeps the user signed in', async () => {
  const { token } = await tokens.issueRefresh(userId);
  const results = await Promise.allSettled([tokens.rotateRefresh(token), tokens.rotateRefresh(token)]);
  const ok = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ token: string }>[];
  const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 1);
  assert.ok(code('UNAUTHENTICATED')(failed[0]!.reason));
  const next = await tokens.rotateRefresh(ok[0]!.value.token);
  assert.equal(next.userId, userId);
});
