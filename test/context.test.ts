import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from './helpers/context.ts';

test('test context creates its own database and drops it on cleanup', async () => {
  const ctx = await createTestContext();
  const name = new URL(ctx.centralUrl).pathname.slice(1);
  assert.match(name, /^test_[0-9a-f]{8}$/);

  const before = await ctx.adminSql`select 1 from pg_database where datname = ${name}`;
  assert.equal(before.length, 1);

  const admin = ctx.adminSql;
  await ctx.cleanup({ keepAdmin: true });
  const after = await admin`select 1 from pg_database where datname = ${name}`;
  assert.equal(after.length, 0);
  await admin.end();
});

test('refuses to run without TEST_DATABASE_ADMIN_URL instead of guessing a server', async () => {
  const saved = process.env.TEST_DATABASE_ADMIN_URL;
  delete process.env.TEST_DATABASE_ADMIN_URL;
  try {
    await assert.rejects(() => createTestContext(), /TEST_DATABASE_ADMIN_URL/);
  } finally {
    process.env.TEST_DATABASE_ADMIN_URL = saved;
  }
});
