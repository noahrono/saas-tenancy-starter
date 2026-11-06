import { loadConfig } from './config/index.ts';
import { createDeps } from './deps.ts';
import { buildApp } from './app.ts';

const config = loadConfig(process.env);
const deps = createDeps(config);
const app = await buildApp(deps);

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await deps.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: config.port });
