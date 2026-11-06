import type { AppDeps } from './app.ts';
import { createTokenService } from './auth/tokens.ts';
import type { Config } from './config/index.ts';
import { createCentralDb } from './db/central/client.ts';
import { PoolRegistry } from './db/pool-registry.ts';
import { TenantCache } from './tenancy/cache.ts';
import { consoleMailer, type Mailer } from './mailer/console.ts';

export interface RuntimeDeps extends Required<AppDeps> {
  /** Closes every connection the deps opened. */
  close(): Promise<void>;
}

const stdoutLog = { info: (obj: unknown, msg?: string) => console.log(msg ?? '', obj) };

/** Wires the real dependencies from config. Tests can swap the mailer. */
export function createDeps(config: Config, overrides: { mailer?: Mailer } = {}): RuntimeDeps {
  const central = createCentralDb(config.databaseUrl);
  const tokens = createTokenService({ ...config.jwt, central });
  const mailer = overrides.mailer ?? consoleMailer(stdoutLog);
  const pools = new PoolRegistry({
    port: config.tenantDb.port,
    user: config.tenantDb.user,
    password: config.tenantDb.password,
    maxPools: config.tenantPoolsMax,
    poolMax: config.tenantPoolMax,
  });
  return {
    config,
    central,
    tokens,
    mailer,
    pools,
    cache: new TenantCache(),
    async close() {
      await pools.closeAll();
      await central.end();
    },
  };
}
