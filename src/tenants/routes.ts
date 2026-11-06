import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { currentUser } from '../auth/guard.ts';
import { memberships, tenants, ROLES, TENANT_STATUSES } from '../db/central/schema.ts';
import { provisionTenant, type ProvisionDeps } from '../tenancy/provision.ts';

const tenantOut = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  status: z.enum(TENANT_STATUSES),
});
const membershipOut = z.object({ tenant: tenantOut, role: z.enum(ROLES) });

export async function registerTenantRoutes(
  app: FastifyInstance,
  deps: ProvisionDeps & { requireAuth: preHandlerAsyncHookHandler },
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/tenants',
    {
      preHandler: deps.requireAuth,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['tenants'],
        security: [{ bearerAuth: [] }],
        body: z.object({ slug: z.string(), name: z.string().trim().min(1).max(100) }),
        response: { 201: membershipOut },
      },
    },
    async (req, reply) => {
      const user = currentUser(req);
      const tenant = await provisionTenant(deps, {
        slug: req.body.slug,
        name: req.body.name,
        ownerUserId: user.id,
        maxOwned: deps.config.maxTenantsPerUser,
      });
      reply.status(201);
      return { tenant, role: 'owner' as const };
    },
  );

  r.get(
    '/tenants',
    {
      preHandler: deps.requireAuth,
      schema: { tags: ['tenants'], security: [{ bearerAuth: [] }], response: { 200: z.array(membershipOut) } },
    },
    async (req) => {
      const user = currentUser(req);
      const rows = await deps.central.db
        .select({
          id: tenants.id,
          slug: tenants.slug,
          name: tenants.name,
          status: tenants.status,
          role: memberships.role,
        })
        .from(memberships)
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(eq(memberships.userId, user.id))
        .orderBy(asc(tenants.slug));
      return rows.map(({ role, ...tenant }) => ({ tenant, role }));
    },
  );
}
