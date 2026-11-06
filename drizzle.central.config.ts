import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/central/schema.ts',
  out: './src/db/central/migrations',
  migrations: { prefix: 'index' },
});
