import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { currentUser } from '../auth/guard.ts';
import { tenantDb } from '../tenancy/resolve.ts';
import { createProject, listProjects, type Project } from './service.ts';

const projectOut = z.object({ id: z.uuid(), name: z.string(), createdBy: z.uuid(), createdAt: z.string() });
const toJson = (p: Project) => ({ ...p, createdAt: p.createdAt.toISOString() });

/**
 * The pattern to copy for any tenant-scoped resource: guard with requireAuth then
 * requireTenant, and only ever touch data through `tenantDb(req)`.
 */
export async function registerExampleRoutes(
  app: FastifyInstance,
  guards: { requireAuth: preHandlerAsyncHookHandler; requireTenant: preHandlerAsyncHookHandler },
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const preHandler = [guards.requireAuth, guards.requireTenant];
  const tenantHeader = z.object({ 'x-tenant': z.string().optional() });

  r.get(
    '/api/projects',
    {
      preHandler,
      schema: {
        tags: ['projects'],
        security: [{ bearerAuth: [] }],
        headers: tenantHeader,
        response: { 200: z.array(projectOut) },
      },
    },
    async (req) => (await listProjects(tenantDb(req))).map(toJson),
  );

  r.post(
    '/api/projects',
    {
      preHandler,
      schema: {
        tags: ['projects'],
        security: [{ bearerAuth: [] }],
        headers: tenantHeader,
        body: z.object({ name: z.string().trim().min(1).max(200) }),
        response: { 201: projectOut },
      },
    },
    async (req, reply) => {
      const project = await createProject(tenantDb(req), { name: req.body.name, createdBy: currentUser(req).id });
      reply.status(201);
      return toJson(project);
    },
  );
}
