import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { hashToken, randomToken } from '../auth/tokens.ts';
import type { CentralDb } from '../db/central/client.ts';
import { invitations, memberships, tenants, users, type InviteRole, type Role } from '../db/central/schema.ts';
import { AppError } from '../errors.ts';
import type { Mailer } from '../mailer/console.ts';
import { can } from '../permissions/permissions.ts';
import { assertWithinLimit, lockedPlan, memberUsage } from '../plans/service.ts';
import type { TenantCache } from '../tenancy/cache.ts';
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

    const seatsAfter = (await memberUsage(tx, tenant.id, { excludeEmail: email })) + 1;
    assertWithinLimit(await lockedPlan(tx, tenant.id), 'members', seatsAfter);

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

export interface AcceptedInvitation {
  tenant: { id: string; slug: string; name: string };
  role: Role;
}

const invalid = () => new AppError('INVITATION_INVALID', 400, 'This invitation link is invalid, used, revoked or expired');

/**
 * Accepts an invitation for the signed-in user. The token must be usable and the user's email
 * must be the invited one. Because the link reached their inbox, their email counts as verified.
 */
export async function acceptInvitation(
  deps: { central: CentralDb; cache: TenantCache },
  input: { token: string; user: { id: string; email: string } },
): Promise<AcceptedInvitation> {
  const tokenHash = hashToken(input.token);
  const [found] = await deps.central.db
    .select({ tenantId: invitations.tenantId })
    .from(invitations)
    .where(and(eq(invitations.tokenHash, tokenHash), usable()));
  if (!found) throw invalid();

  const accepted = await withTenantLock(deps.central, found.tenantId, async (tx) => {
    // Read again under the lock: a parallel accept or revoke may have just used it.
    const [inv] = await tx
      .select({ id: invitations.id, email: invitations.email, role: invitations.role })
      .from(invitations)
      .where(and(eq(invitations.tokenHash, tokenHash), usable()));
    if (!inv) throw invalid();
    if (inv.email !== input.user.email.toLowerCase()) {
      throw new AppError('INVITATION_EMAIL_MISMATCH', 403, 'This invitation was sent to a different email address');
    }

    const [tenant] = await tx
      .select({ id: tenants.id, slug: tenants.slug, name: tenants.name, status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, found.tenantId));
    if (tenant!.status === 'suspended') throw new AppError('TENANT_SUSPENDED', 403, 'This tenant is suspended');
    if (tenant!.status !== 'active') throw new AppError('TENANT_NOT_READY', 403, 'This tenant is still being set up');

    const [existing] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenant!.id), eq(memberships.userId, input.user.id)));
    const role = existing?.role ?? inv.role;
    if (!existing) {
      // A downgrade since the invitation was sent may have left no seat for it.
      const seatsAfter = (await memberUsage(tx, tenant!.id, { excludeInvitationId: inv.id })) + 1;
      assertWithinLimit(await lockedPlan(tx, tenant!.id), 'members', seatsAfter);
      await tx.insert(memberships).values({ tenantId: tenant!.id, userId: input.user.id, role });
    }

    await tx.update(invitations).set({ acceptedAt: sql`now()` }).where(eq(invitations.id, inv.id));
    await tx
      .update(users)
      .set({ emailVerifiedAt: sql`now()` })
      .where(and(eq(users.id, input.user.id), isNull(users.emailVerifiedAt)));
    return { tenant: { id: tenant!.id, slug: tenant!.slug, name: tenant!.name }, role };
  });

  deps.cache.memberships.delete(`${accepted.tenant.id}:${input.user.id}`);
  return accepted;
}
