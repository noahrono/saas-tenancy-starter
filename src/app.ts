import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { makeRequireAuth } from './auth/guard.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import type { TokenService } from './auth/tokens.ts';
import type { Config } from './config/index.ts';
import type { CentralDb } from './db/central/client.ts';
import type { PoolRegistry } from './db/pool-registry.ts';
import { AppError } from './errors.ts';
import type { Mailer } from './mailer/console.ts';
import { registerDocs } from './plugins/docs.ts';
import { registerErrorHandling } from './plugins/errors.ts';
import { TenantCache } from './tenancy/cache.ts';
import { makeRequireTenant } from './tenancy/resolve.ts';
import { registerTenantRoutes } from './tenants/routes.ts';
import { registerExampleRoutes } from './example/routes.ts';

export interface AppDeps {
  config: Config;
  central?: CentralDb;
  tokens?: TokenService;
  mailer?: Mailer;
  pools?: PoolRegistry;
  cache?: TenantCache;
}

/** Builds the Fastify app without listening, so the server and the tests share it. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.config.logLevel,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token', '*.refreshToken'],
        censor: '[redacted]',
      },
    },
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    // Fastify accepts a boolean, hop count or address list; its overloads just can't take the union.
    trustProxy: deps.config.trustProxy as boolean,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });
  // Hand the tenant pool lease back once the response is out, or the client went away.
  app.addHook('onResponse', async (req) => req.releaseTenantDb?.());
  app.addHook('onRequestAbort', async (req) => req.releaseTenantDb?.());

  registerErrorHandling(app);
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => new AppError('RATE_LIMITED', 429, 'Too many requests, try again in a minute'),
  });
  await registerDocs(app);

  app.get('/health', { schema: { hide: true } }, async () => ({ status: 'ok' }));

  app.get('/ready', { schema: { hide: true } }, async () => {
    try {
      if (!deps.central) throw new Error('central database not configured');
      await deps.central.sql`select 1`;
    } catch (err) {
      app.log.warn({ err }, 'readiness check failed');
      throw new AppError('INTERNAL', 503, 'Central database is not reachable');
    }
    return { status: 'ready' };
  });

  const { central, tokens, mailer } = deps;
  if (central && tokens && mailer) {
    await registerAuthRoutes(app, { config: deps.config, central, tokens, mailer });
    const requireAuth = makeRequireAuth(tokens, central);
    const cache = deps.cache ?? new TenantCache();
    await registerTenantRoutes(app, { config: deps.config, central, cache, requireAuth });
    if (deps.pools) {
      const requireTenant = makeRequireTenant({ central, pools: deps.pools, cache, config: deps.config });
      await registerExampleRoutes(app, { requireAuth, requireTenant });
    }
  }

  return app;
}
