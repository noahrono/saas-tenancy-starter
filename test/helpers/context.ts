import { generateKeyPairSync, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { loadConfig, type Config } from '../../src/config/index.ts';
import { migrate } from '../../src/db/migrator.ts';
import { CENTRAL_MIGRATIONS_DIR } from '../../src/db/central/client.ts';


export interface TestContext {
  config: Config;
  centralUrl: string;
  adminSql: postgres.Sql;
  /** Drops every tenant database recorded in this context's central DB, then the central DB itself. */
  cleanup(opts?: { keepAdmin?: boolean }): Promise<void>;
}

export function testKeys(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** Creates a throwaway central database on the test Postgres server and a config pointing at it. */
export async function createTestContext(
  opts: { env?: Record<string, string>; migrateCentral?: boolean } = {},
): Promise<TestContext> {
  // No default on purpose: guessing localhost:5432 could create and drop databases on
  // whatever Postgres happens to be there. Set it in .env.test (local) or the CI env.
  const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;
  if (!ADMIN_URL) {
    throw new Error('Set TEST_DATABASE_ADMIN_URL (e.g. in .env.test) to a Postgres server the tests may create databases on');
  }
  const adminSql = postgres(ADMIN_URL, { max: 2, onnotice: () => {} });
  const name = `test_${randomBytes(4).toString('hex')}`;
  await adminSql.unsafe(`create database "${name}"`);

  const admin = new URL(ADMIN_URL);
  const centralUrl = new URL(ADMIN_URL);
  centralUrl.pathname = `/${name}`;
  const keys = testKeys();

  if (opts.migrateCentral !== false) {
    const migrator = postgres(centralUrl.toString(), { max: 1, onnotice: () => {} });
    try {
      await migrate(migrator, CENTRAL_MIGRATIONS_DIR);
    } finally {
      await migrator.end();
    }
  }

  const config = loadConfig({
    DATABASE_URL: centralUrl.toString(),
    TENANT_DB_USER: decodeURIComponent(admin.username),
    TENANT_DB_PASSWORD: decodeURIComponent(admin.password),
    TENANT_HEADER: 'true',
    LOG_LEVEL: 'silent',
    JWT_PRIVATE_KEY: keys.privateKeyPem,
    JWT_PUBLIC_KEY: keys.publicKeyPem,
    ...opts.env,
  });

  async function cleanup(opts: { keepAdmin?: boolean } = {}) {
    const central = postgres(centralUrl.toString(), { max: 1, onnotice: () => {} });
    try {
      const exists = await central`select to_regclass('public.tenants') as t`;
      if (exists[0]?.t) {
        const rows = await central<{ db_name: string }[]>`select db_name from tenants`;
        for (const { db_name } of rows) {
          await adminSql.unsafe(`drop database if exists "${db_name}" with (force)`);
        }
      }
    } finally {
      await central.end();
    }
    await adminSql.unsafe(`drop database if exists "${name}" with (force)`);
    if (!opts.keepAdmin) await adminSql.end();
  }

  return { config, centralUrl: centralUrl.toString(), adminSql, cleanup };
}
