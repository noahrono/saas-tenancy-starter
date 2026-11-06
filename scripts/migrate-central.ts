import { loadConfig } from '../src/config/index.ts';
import { CENTRAL_MIGRATIONS_DIR, createCentralDb } from '../src/db/central/client.ts';
import { migrate } from '../src/db/migrator.ts';

const config = loadConfig(process.env);
const central = createCentralDb(config.databaseUrl, 1);
try {
  const { applied } = await migrate(central.sql, CENTRAL_MIGRATIONS_DIR);
  console.log(applied.length ? `Applied ${applied.length}: ${applied.join(', ')}` : 'Central database is up to date');
} finally {
  await central.end();
}
