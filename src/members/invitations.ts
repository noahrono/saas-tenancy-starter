import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { hashToken, randomToken } from '../auth/tokens.ts';
import type { CentralDb } from '../db/central/client.ts';
import { invitations, memberships, users, type InviteRole, type Role } from '../db/central/schema.ts';
import { AppError } from '../errors.ts';
import type { Mailer } from '../mailer/console.ts';
import { can } from '../permissions/permissions.ts';
import type { Tenant } from '../tenancy/provision.ts';
import { withTenantLock } from './lock.ts';
import { assertCanManage, currentActorRole, forbidden } from './service.ts';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface Invitation {
  id: string;
  email: string;
  role: InviteRole;
  invitedBy: string | null;
  expiresAt: Date;
}

const invitationColumns = {
  id: invitations.id,
  email: invitations.email,
  role: invitations.role,
  invitedBy: invitations.invitedBy,
  expiresAt: invitations.expiresAt,
};

const open = () => and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt));
const usable = () => and(open(), gt(invitations.expiresAt, sql`now()`));

export interface InviteDeps {
  central: CentralDb;
  mailer: Mailer;
  config: { baseDomain: string };
}

/**
 * Invites `email` to the tenant and emails them a single-use link. Re-inviting the same email
 * replaces the earlier link. The token only ever travels in the email.
 */
export async function createInvitation(
  deps: InviteDeps,
  input: { tenant: Tenant; actor: { userId: string; email: string; role: Role }; email: string; role: InviteRole },
): Promise<Invitation> {
  const { tenant, actor, role } = input;
  const email = input.email.trim().toLowerCase();
  const token = randomToken();

  const invitation = await withTenantLock(deps.central, tenant.id, async (tx) => {
    const actorRole = await currentActorRole(tx, tenant.id, actor);
    if (!can(actorRole, 'members:invite')) throw forbidden('members:invite');
    assertCanManage(actorRole, 'member', role);

    const [existing] = await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.tenantId, tenant.id), eq(users.email, email)));
    if (existing) throw new AppError('ALREADY_MEMBER', 409, `${email} is already a member of this tenant`);

    await tx
      .update(invitations)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(invitations.tenantId, tenant.id), eq(invitations.email, email), open()));

    const [row] = await tx
      .insert(invitations)
      .values({
        tenantId: tenant.id,
        email,
        role,
        tokenHash: hashToken(token),
        invitedBy: actor.userId,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      })
      .returning(invitationColumns);
    return row!;
  });

  const article = role === 'admin' ? 'an' : 'a';
  await deps.mailer.send({
    to: email,
    subject: `You're invited to ${tenant.name}`,
    text:
      `${actor.email} invited you to join ${tenant.name} as ${article} ${role}.\n` +
      `Accept the invitation: https://${deps.config.baseDomain}/invitations/accept?token=${token}\n` +
      `The link works once and expires in 7 days.`,
  });
  return invitation;
}

/** Invitations that can still be accepted, newest first. */
export function listInvitations(central: CentralDb, tenantId: string): Promise<Invitation[]> {
  return central.db
    .select(invitationColumns)
    .from(invitations)
    .where(and(eq(invitations.tenantId, tenantId), usable()))
    .orderBy(desc(invitations.createdAt), desc(invitations.id));
}

export async function revokeInvitation(central: CentralDb, tenantId: string, id: string): Promise<void> {
  const revoked = await withTenantLock(central, tenantId, (tx) =>
    tx
      .update(invitations)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(invitations.id, id), eq(invitations.tenantId, tenantId), open()))
      .returning({ id: invitations.id }),
  );
  if (revoked.length === 0) throw new AppError('NOT_FOUND', 404, 'No open invitation with that id in this tenant');
}
