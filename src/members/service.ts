import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { CentralDb } from '../db/central/client.ts';
import { memberships, users, type Role } from '../db/central/schema.ts';
import { AppError } from '../errors.ts';
import { ROLE_RANK, can, type Permission } from '../permissions/permissions.ts';
import type { TenantCache } from '../tenancy/cache.ts';
import { withTenantLock, type CentralTx } from './lock.ts';

export interface Member {
  userId: string;
  email: string;
  role: Role;
  joinedAt: Date;
}

interface Actor {
  userId: string;
  role: Role;
}

const forbidden = (permission?: Permission) =>
  new AppError('FORBIDDEN', 403, 'Your role does not allow this', permission ? { permission } : undefined);
const notAMember = () => new AppError('NOT_FOUND', 404, 'That person is not a member of this tenant');

/**
 * The rank rule: owners may do anything; anyone else may only act on people ranked no higher
 * than themselves, and only hand out roles ranked no higher than their own.
 */
export function assertCanManage(actorRole: Role, targetRole: Role, newRole?: Role): void {
  if (actorRole === 'owner') return;
  const rank = ROLE_RANK[actorRole];
  if (ROLE_RANK[targetRole] > rank || (newRole && ROLE_RANK[newRole] > rank)) throw forbidden();
}

const memberColumns = {
  userId: memberships.userId,
  email: users.email,
  role: memberships.role,
  joinedAt: memberships.createdAt,
};

export function listMembers(central: CentralDb, tenantId: string): Promise<Member[]> {
  return central.db
    .select(memberColumns)
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.tenantId, tenantId))
    .orderBy(sql`case when ${memberships.role} = 'owner' then 0 else 1 end`, asc(memberships.createdAt));
}

async function findMember(tx: CentralTx, tenantId: string, userId: string): Promise<Member | undefined> {
  const [row] = await tx
    .select(memberColumns)
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));
  return row;
}

async function ownerCount(tx: CentralTx, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, 'owner')));
  return row?.n ?? 0;
}

/**
 * The caller's role as it is now, read under the lock. The role on the request can be up to
 * 30 seconds old (membership cache), and a decision about owners must not rest on that.
 */
async function currentActorRole(tx: CentralTx, tenantId: string, actor: Actor): Promise<Role> {
  const me = await findMember(tx, tenantId, actor.userId);
  if (!me) throw new AppError('TENANT_NOT_FOUND', 404, 'Tenant not found');
  return me.role;
}

const forget = (cache: TenantCache, tenantId: string, userId: string) =>
  cache.memberships.delete(`${tenantId}:${userId}`);

export async function changeRole(
  central: CentralDb,
  cache: TenantCache,
  input: { tenantId: string; actor: Actor; targetUserId: string; role: Role },
): Promise<Member> {
  const { tenantId, targetUserId, role } = input;
  const updated = await withTenantLock(central, tenantId, async (tx) => {
    const actorRole = await currentActorRole(tx, tenantId, input.actor);
    if (!can(actorRole, 'members:update')) throw forbidden('members:update');
    const target = await findMember(tx, tenantId, targetUserId);
    if (!target) throw notAMember();
    if (target.role === role) return target;
    assertCanManage(actorRole, target.role, role);
    if (target.role === 'owner' && (await ownerCount(tx, tenantId)) === 1) {
      throw new AppError('LAST_OWNER', 409, 'A tenant needs at least one owner. Make someone else an owner first.');
    }
    await tx
      .update(memberships)
      .set({ role })
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, targetUserId)));
    return { ...target, role };
  });
  forget(cache, tenantId, targetUserId);
  return updated;
}

/** Removes a member, or lets a member leave when `targetUserId` is the caller. */
export async function removeMember(
  central: CentralDb,
  cache: TenantCache,
  input: { tenantId: string; actor: Actor; targetUserId: string },
): Promise<void> {
  const { tenantId, targetUserId } = input;
  const leaving = targetUserId === input.actor.userId;
  await withTenantLock(central, tenantId, async (tx) => {
    const actorRole = await currentActorRole(tx, tenantId, input.actor);
    const target = leaving ? { role: actorRole } : await findMember(tx, tenantId, targetUserId);
    if (!target) {
      if (!can(actorRole, 'members:remove')) throw forbidden('members:remove');
      throw notAMember();
    }
    if (!leaving) {
      if (!can(actorRole, 'members:remove')) throw forbidden('members:remove');
      assertCanManage(actorRole, target.role);
    }
    if (target.role === 'owner' && (await ownerCount(tx, tenantId)) === 1) {
      throw new AppError('LAST_OWNER', 409, 'A tenant needs at least one owner. Make someone else an owner first.');
    }
    await tx.delete(memberships).where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, targetUserId)));
  });
  forget(cache, tenantId, targetUserId);
}
