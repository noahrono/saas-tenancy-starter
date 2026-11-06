import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/tenant/schema.ts',
  out: './src/db/tenant/migrations',
  migrations: { prefix: 'index' },
});
