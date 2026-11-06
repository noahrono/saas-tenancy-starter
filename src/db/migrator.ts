import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type postgres from 'postgres';
import { AppError } from '../errors.ts';

/** Fixed advisory-lock key shared by every migration run, so two runs on one database queue up. */
const LOCK_KEY = 727274;
const BREAKPOINT = '--> statement-breakpoint';

interface MigrationFile {
  id: string;
  checksum: string;
  statements: string[];
}

async function readMigrations(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (id) => {
      const text = (await readFile(path.join(dir, id), 'utf8')).replace(/\r\n/g, '\n');
      return {
        id,
        checksum: createHash('sha256').update(text).digest('hex'),
        statements: text
          .split(BREAKPOINT)
          .map((s) => s.trim())
          .filter(Boolean),
      };
    }),
  );
}

/**
 * Applies every `.sql` file in `dir` that this database hasn't applied yet, in name order.
 * Each file runs in its own transaction together with its `__migrations` record.
 * An already-applied file whose content changed stops the run.
 */
export async function migrate(sql: postgres.Sql, dir: string): Promise<{ applied: string[] }> {
  const files = await readMigrations(dir);
  const conn = await sql.reserve();
  const applied: string[] = [];
  try {
    await conn`select pg_advisory_lock(${LOCK_KEY})`;
    try {
      await conn.unsafe(`create table if not exists __migrations (
        id text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`);
      const done = new Map(
        (await conn<{ id: string; checksum: string }[]>`select id, checksum from __migrations`).map((r) => [r.id, r.checksum]),
      );

      for (const file of files) {
        const existing = done.get(file.id);
        if (existing !== undefined) {
          if (existing !== file.checksum) {
            throw new AppError(
              'MIGRATION_CHECKSUM_MISMATCH',
              500,
              `Migration ${file.id} was changed after it was applied`,
            );
          }
          continue;
        }
        await conn.unsafe('begin');
        try {
          for (const statement of file.statements) await conn.unsafe(statement);
          await conn`insert into __migrations (id, checksum) values (${file.id}, ${file.checksum})`;
          await conn.unsafe('commit');
        } catch (err) {
          await conn.unsafe('rollback');
          throw err;
        }
        applied.push(file.id);
      }
    } finally {
      await conn`select pg_advisory_unlock(${LOCK_KEY})`;
    }
  } finally {
    conn.release();
  }
  return { applied };
}
