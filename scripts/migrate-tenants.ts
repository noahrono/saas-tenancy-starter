import { loadConfig } from '../src/config/index.ts';
import { createCentralDb } from '../src/db/central/client.ts';
import { migrateAllTenants } from '../src/tenancy/migrate-all.ts';

const config = loadConfig(process.env);
const central = createCentralDb(config.databaseUrl, 2);
try {
  const { migrated, upToDate, failed } = await migrateAllTenants({ central, config });
  console.log(`Migrated: ${migrated.length}  Up to date: ${upToDate.length}  Failed: ${failed.length}`);
  for (const slug of migrated) console.log(`  migrated   ${slug}`);
  for (const { slug, error } of failed) console.log(`  FAILED     ${slug}: ${error}`);
  if (failed.length > 0) process.exitCode = 1;
} finally {
  await central.end();
}
