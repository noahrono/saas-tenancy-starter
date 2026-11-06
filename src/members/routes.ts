import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { currentUser } from '../auth/guard.ts';
import type { CentralDb } from '../db/central/client.ts';
import { emailSchema } from '../auth/routes.ts';
import { INVITE_ROLES, ROLES } from '../db/central/schema.ts';
import type { Mailer } from '../mailer/console.ts';
import { requirePermission } from '../permissions/guard.ts';
import type { TenantCache } from '../tenancy/cache.ts';
import { createInvitation, listInvitations, revokeInvitation, type Invitation } from './invitations.ts';
import { changeRole, listMembers, removeMember, type Member } from './service.ts';

export interface MemberRouteDeps {
  central: CentralDb;
  cache: TenantCache;
  mailer: Mailer;
  config: { baseDomain: string };
  requireAuth: preHandlerAsyncHookHandler;
  requireTenant: preHandlerAsyncHookHandler;
}

const invitationOut = z.object({
  id: z.uuid(),
  email: z.string(),
  role: z.enum(INVITE_ROLES),
  invitedBy: z.uuid().nullable(),
  expiresAt: z.string(),
});
const invitationJson = (i: Invitation) => ({ ...i, expiresAt: i.expiresAt.toISOString() });
/** Every invitation sends an email, so sending is limited per IP. */
const INVITE_RATE_LIMIT = { max: 20, timeWindow: '1 minute' };

const memberOut = z.object({ userId: z.uuid(), email: z.string(), role: z.enum(ROLES), joinedAt: z.string() });
const toJson = (m: Member) => ({ ...m, joinedAt: m.joinedAt.toISOString() });
const tenantHeader = z.object({ 'x-tenant': z.string().optional() });
const userParams = z.object({ userId: z.uuid() });

function context(req: FastifyRequest) {
  return {
    tenantId: req.tenant!.id,
    actor: { userId: currentUser(req).id, role: req.membership!.role },
  };
}

export async function registerMemberRoutes(app: FastifyInstance, deps: MemberRouteDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const base = [deps.requireAuth, deps.requireTenant];
  const doc = { tags: ['members'], security: [{ bearerAuth: [] }], headers: tenantHeader };

  r.get(
    '/members',
    {
      preHandler: [...base, requirePermission('members:read')],
      schema: { ...doc, response: { 200: z.array(memberOut) } },
    },
    async (req) => (await listMembers(deps.central, req.tenant!.id)).map(toJson),
  );

  r.patch(
    '/members/:userId',
    {
      preHandler: [...base, requirePermission('members:update')],
      schema: { ...doc, params: userParams, body: z.object({ role: z.enum(ROLES) }), response: { 200: memberOut } },
    },
    async (req) =>
      toJson(
        await changeRole(deps.central, deps.cache, {
          ...context(req),
          targetUserId: req.params.userId,
          role: req.body.role,
        }),
      ),
  );

  // No permission guard: anyone may remove themselves (leave). Removing someone else needs
  // members:remove, which the service checks against the caller's current role.
  r.delete(
    '/members/:userId',
    { preHandler: base, schema: { ...doc, params: userParams, response: { 204: z.null() } } },
    async (req, reply) => {
      await removeMember(deps.central, deps.cache, { ...context(req), targetUserId: req.params.userId });
      reply.status(204);
      return null;
    },
  );

  r.post(
    '/members/invitations',
    {
      preHandler: [...base, requirePermission('members:invite')],
      config: { rateLimit: INVITE_RATE_LIMIT },
      schema: {
        ...doc,
        body: z.object({ email: emailSchema, role: z.enum(INVITE_ROLES) }),
        response: { 201: invitationOut },
      },
    },
    async (req, reply) => {
      const user = currentUser(req);
      const invitation = await createInvitation(deps, {
        tenant: req.tenant!,
        actor: { userId: user.id, email: user.email, role: req.membership!.role },
        email: req.body.email,
        role: req.body.role,
      });
      reply.status(201);
      return invitationJson(invitation);
    },
  );

  r.get(
    '/members/invitations',
    {
      preHandler: [...base, requirePermission('members:invite')],
      schema: { ...doc, response: { 200: z.array(invitationOut) } },
    },
    async (req) => (await listInvitations(deps.central, req.tenant!.id)).map(invitationJson),
  );

  r.delete(
    '/members/invitations/:id',
    {
      preHandler: [...base, requirePermission('members:invite')],
      schema: { ...doc, params: z.object({ id: z.uuid() }), response: { 204: z.null() } },
    },
    async (req, reply) => {
      await revokeInvitation(deps.central, req.tenant!.id, req.params.id);
      reply.status(204);
      return null;
    },
  );
}
