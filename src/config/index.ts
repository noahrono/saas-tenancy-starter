import { z } from 'zod';

export interface Config {
  nodeEnv: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  tenantDb: { host: string; port: number; user: string; password: string };
  baseDomain: string;
  tenantHeader: boolean;
  jwt: { privateKeyPem: string; publicKeyPem: string };
  tenantPoolsMax: number;
  tenantPoolMax: number;
  migrateConcurrency: number;
  cookieSecure: boolean;
  /** Fastify trustProxy: false (default), true, a hop count, or a comma-separated list of proxy addresses/CIDRs. */
  trustProxy: boolean | number | string;
  maxTenantsPerUser: number;
}

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');
const int = (def: number) => z.coerce.number().int().positive().default(def);
const pem = z
  .string()
  .min(1)
  .transform((v) => v.replace(/\\n/g, '\n'));

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: int(3000),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  TENANT_DB_HOST: z.string().min(1).optional(),
  TENANT_DB_PORT: z.coerce.number().int().positive().optional(),
  TENANT_DB_USER: z.string().min(1),
  TENANT_DB_PASSWORD: z.string(),
  BASE_DOMAIN: z.string().min(1).default('localhost'),
  TENANT_HEADER: bool.default(false),
  JWT_PRIVATE_KEY: pem,
  JWT_PUBLIC_KEY: pem,
  TENANT_POOLS_MAX: int(100),
  TENANT_POOL_MAX: int(5),
  MIGRATE_CONCURRENCY: int(4),
  COOKIE_SECURE: bool.optional(),
  TRUST_PROXY: z.string().min(1).optional(),
  MAX_TENANTS_PER_USER: int(10),
});

function parseTrustProxy(v: string | undefined): boolean | number | string {
  if (v === undefined || v === 'false') return false;
  if (v === 'true') return true;
  if (/^[0-9]+$/.test(v)) return Number(v);
  return v;
}

/** Parses and validates the environment. Throws one error naming every bad variable. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  const e = parsed.data;
  const central = new URL(e.DATABASE_URL);
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    tenantDb: {
      host: e.TENANT_DB_HOST ?? central.hostname,
      port: e.TENANT_DB_PORT ?? (Number(central.port) || 5432),
      user: e.TENANT_DB_USER,
      password: e.TENANT_DB_PASSWORD,
    },
    baseDomain: e.BASE_DOMAIN.toLowerCase(),
    tenantHeader: e.TENANT_HEADER,
    jwt: { privateKeyPem: e.JWT_PRIVATE_KEY, publicKeyPem: e.JWT_PUBLIC_KEY },
    tenantPoolsMax: e.TENANT_POOLS_MAX,
    tenantPoolMax: e.TENANT_POOL_MAX,
    migrateConcurrency: e.MIGRATE_CONCURRENCY,
    cookieSecure: e.COOKIE_SECURE ?? e.NODE_ENV === 'production',
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    maxTenantsPerUser: e.MAX_TENANTS_PER_USER,
  };
}
