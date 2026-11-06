// Usage: npm run tenant:retry -- <slug>
import { loadConfig } from '../src/config/index.ts';
import { createCentralDb } from '../src/db/central/client.ts';
import { retryProvision } from '../src/tenancy/provision.ts';

const [slug] = process.argv.slice(2);
if (!slug) {
  console.error('Usage: npm run tenant:retry -- <slug>');
  process.exit(2);
}

const config = loadConfig(process.env);
const central = createCentralDb(config.databaseUrl, 2);
try {
  const tenant = await retryProvision({ central, config }, slug);
  console.log(`Tenant ${tenant.slug} is ${tenant.status}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await central.end();
}
