// Usage: npm run tenant:create -- <slug> "<name>" <owner-email>
import { loadConfig } from '../src/config/index.ts';
import { createCentralDb } from '../src/db/central/client.ts';
import { provisionTenant } from '../src/tenancy/provision.ts';

const [slug, name, ownerEmail] = process.argv.slice(2);
if (!slug || !name || !ownerEmail) {
  console.error('Usage: npm run tenant:create -- <slug> "<name>" <owner-email>');
  process.exit(2);
}

const config = loadConfig(process.env);
const central = createCentralDb(config.databaseUrl, 2);
try {
  const [owner] = await central.sql<{ id: string }[]>`select id from users where email = ${ownerEmail.trim().toLowerCase()}`;
  if (!owner) throw new Error(`No user with email ${ownerEmail}. Sign up first.`);
  const tenant = await provisionTenant({ central, config }, { slug, name, ownerUserId: owner.id });
  console.log(`Created tenant ${tenant.slug} (${tenant.status}) in database ${tenant.dbName}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await central.end();
}
