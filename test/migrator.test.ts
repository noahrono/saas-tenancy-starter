import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { migrate } from '../src/db/migrator.ts';
import { AppError } from '../src/errors.ts';
import { createTestContext, type TestContext } from './helpers/context.ts';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
let ctx: TestContext;
let sql: postgres.Sql;

beforeEach(async () => {
  ctx = await createTestContext({ migrateCentral: false });
  sql = postgres(ctx.centralUrl, { max: 4, onnotice: () => {} });
});
afterEach(async () => {
  await sql.end();
  await ctx.cleanup();
});

async function tempDirWith(...sources: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mig-'));
  for (const s of sources) await cp(path.join(FIXTURES, s), dir, { recursive: true });
  return dir;
}

async function applied(): Promise<string[]> {
  return (await sql<{ id: string }[]>`select id from __migrations order by id`).map((r) => r.id);
}

test('applies pending files in name order', async () => {
  const res = await migrate(sql, path.join(FIXTURES, 'migrations-ok'));
  assert.deepEqual(res.applied, ['0000_init.sql', '0001_add_color.sql']);
  const cols = await sql`select column_name from information_schema.columns where table_name = 'widgets' order by column_name`;
  assert.deepEqual(cols.map((c) => c.column_name), ['color', 'id', 'name']);
});

test('is a no-op when already up to date', async () => {
  const dir = path.join(FIXTURES, 'migrations-ok');
  await migrate(sql, dir);
  assert.deepEqual((await migrate(sql, dir)).applied, []);
});

test('applies only the new files', async () => {
  const dir = await tempDirWith('migrations-ok');
  await migrate(sql, dir);
  await cp(path.join(FIXTURES, 'migrations-more'), dir, { recursive: true });
  assert.deepEqual((await migrate(sql, dir)).applied, ['0002_add_size.sql']);
  assert.deepEqual(await applied(), (await readdir(dir)).sort());
});

test('rolls back a failing file and keeps the earlier ones', async () => {
  await assert.rejects(() => migrate(sql, path.join(FIXTURES, 'migrations-broken')));
  assert.deepEqual(await applied(), ['0000_init.sql']);
  const cols = await sql`select column_name from information_schema.columns where table_name = 'gadgets'`;
  assert.deepEqual(cols.map((c) => c.column_name), ['id'], 'first statement of the failing file was rolled back');
});

test('detects an edited migration', async () => {
  const dir = await tempDirWith('migrations-ok');
  await migrate(sql, dir);
  await appendFile(path.join(dir, '0000_init.sql'), '\n-- sneaky edit\n');
  await assert.rejects(
    () => migrate(sql, dir),
    (e: unknown) => e instanceof AppError && e.code === 'MIGRATION_CHECKSUM_MISMATCH' && e.message.includes('0000_init.sql'),
  );
});

test('line endings do not change the checksum', async () => {
  const dir = await tempDirWith('migrations-ok');
  await migrate(sql, dir);
  const file = path.join(dir, '0001_add_color.sql');
  await writeFile(file, 'alter table widgets add column color text;\r\n');
  assert.deepEqual((await migrate(sql, dir)).applied, []);
});

test('concurrent runs on one database are serialised', async () => {
  const dir = path.join(FIXTURES, 'migrations-ok');
  const other = postgres(ctx.centralUrl, { max: 2, onnotice: () => {} });
  try {
    const [a, b] = await Promise.all([migrate(sql, dir), migrate(other, dir)]);
    assert.equal(a.applied.length + b.applied.length, 2);
    assert.deepEqual(await applied(), ['0000_init.sql', '0001_add_color.sql']);
  } finally {
    await other.end();
  }
});
