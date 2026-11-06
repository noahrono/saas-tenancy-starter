import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { currentUser } from '../auth/guard.ts';
import { AppError } from '../errors.ts';
import { requirePermission } from '../permissions/guard.ts';
import { requireFeature } from '../plans/guard.ts';
import { tenantDb } from '../tenancy/resolve.ts';
import { toCsv } from './csv.ts';
import { createProject, deleteProject, listProjects, type Project } from './service.ts';

const projectOut = z.object({ id: z.uuid(), name: z.string(), createdBy: z.uuid(), createdAt: z.string() });
const toJson = (p: Project) => ({ ...p, createdAt: p.createdAt.toISOString() });

/**
 * The pattern to copy for any tenant-scoped resource: guard with requireAuth, requireTenant
 * and the permission the route needs, and only ever touch data through `tenantDb(req)`.
 */
export async function registerExampleRoutes(
  app: FastifyInstance,
  guards: { requireAuth: preHandlerAsyncHookHandler; requireTenant: preHandlerAsyncHookHandler },
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const base = [guards.requireAuth, guards.requireTenant];
  const tenantHeader = z.object({ 'x-tenant': z.string().optional() });

  r.get(
    '/api/projects',
    {
      preHandler: [...base, requirePermission('projects:read')],
      schema: {
        tags: ['projects'],
        security: [{ bearerAuth: [] }],
        headers: tenantHeader,
        response: { 200: z.array(projectOut) },
      },
    },
    async (req) => (await listProjects(tenantDb(req))).map(toJson),
  );

  // A plan-gated feature: the pattern for anything only some plans include.
  r.get(
    '/api/projects/export',
    {
      preHandler: [...base, requirePermission('projects:read'), requireFeature('projects:export')],
      schema: {
        tags: ['projects'],
        security: [{ bearerAuth: [] }],
        headers: tenantHeader,
        description: 'Download every project as CSV. Needs a plan with the projects:export feature.',
      },
    },
    async (req, reply) => {
      const rows = (await listProjects(tenantDb(req))).map((p) => [
        p.id,
        p.name,
        p.createdBy,
        p.createdAt.toISOString(),
      ]);
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="projects.csv"');
      return toCsv([['id', 'name', 'createdBy', 'createdAt'], ...rows]);
    },
  );

  r.post(
    '/api/projects',
    {
      preHandler: [...base, requirePermission('projects:create')],
      schema: {
        tags: ['projects'],
        security: [{ bearerAuth: [] }],
        headers: tenantHeader,
        body: z.object({ name: z.string().trim().min(1).max(200) }),
        response: { 201: projectOut },
      },
    },
    async (req, reply) => {
      const project = await createProject(
        tenantDb(req),
        { name: req.body.name, createdBy: currentUser(req).id },
        { plan: req.tenant!.plan },
      );
      reply.status(201);
      return toJson(project);
    },
  );

  r.delete(
    '/api/projects/:id',
    {
      preHandler: [...base, requirePermission('projects:delete')],
      schema: {
        tags: ['projects'],
        security: [{ bearerAuth: [] }],
        headers: tenantHeader,
        params: z.object({ id: z.uuid() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      if (!(await deleteProject(tenantDb(req), req.params.id))) {
        throw new AppError('NOT_FOUND', 404, 'Project not found');
      }
      reply.status(204);
      return null;
    },
  );
}
