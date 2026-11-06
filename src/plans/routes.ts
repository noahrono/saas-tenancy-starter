import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { CentralDb } from '../db/central/client.ts';
import { requirePermission } from '../permissions/guard.ts';
import type { TenantCache } from '../tenancy/cache.ts';
import { tenantDb } from '../tenancy/resolve.ts';
import { FEATURES, PLAN_IDS } from './plans.ts';
import { changePlan, planSummary } from './service.ts';

export interface PlanRouteDeps {
  central: CentralDb;
  cache: TenantCache;
  requireAuth: preHandlerAsyncHookHandler;
  requireTenant: preHandlerAsyncHookHandler;
}

const limits = z.object({ members: z.number().nullable(), projects: z.number().nullable() });
const summaryOut = z.object({
  plan: z.enum(PLAN_IDS),
  name: z.string(),
  features: z.array(z.enum(FEATURES)),
  limits,
  usage: z.object({ members: z.number(), projects: z.number() }),
});

export async function registerPlanRoutes(app: FastifyInstance, deps: PlanRouteDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const base = [deps.requireAuth, deps.requireTenant];
  const doc = {
    tags: ['plan'],
    security: [{ bearerAuth: [] }],
    headers: z.object({ 'x-tenant': z.string().optional() }),
  };

  r.get(
    '/tenant/plan',
    {
      preHandler: [...base, requirePermission('members:read')],
      schema: { ...doc, response: { 200: summaryOut } },
    },
    async (req) => planSummary(deps.central, req.tenant!, tenantDb(req)),
  );

  r.put(
    '/tenant/plan',
    {
      preHandler: [...base, requirePermission('tenant:plan')],
      schema: { ...doc, body: z.object({ plan: z.enum(PLAN_IDS) }), response: { 200: summaryOut } },
    },
    async (req) => {
      await changePlan(deps.central, deps.cache, req.tenant!.id, req.body.plan);
      return planSummary(deps.central, { ...req.tenant!, plan: req.body.plan }, tenantDb(req));
    },
  );
}
