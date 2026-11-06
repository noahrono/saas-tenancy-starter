import { loadConfig } from '../src/config/index.ts';
import { createDeps } from '../src/deps.ts';
import { DEMO_EMAIL, DEMO_PASSWORD, seed } from '../src/dev/seed.ts';

const deps = createDeps(loadConfig(process.env));
try {
  await seed(deps);
  console.log(`Seeded. Sign in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}, tenants: tenant-a, tenant-b`);
} finally {
  await deps.close();
}
