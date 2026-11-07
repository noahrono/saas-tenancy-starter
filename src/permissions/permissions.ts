import type { Role } from '../db/central/schema.ts';

/** Everything a tenant route can require. Routes check permissions, never roles. */
export const PERMISSIONS = [
  'projects:read',
  'projects:create',
  'projects:delete',
  'members:read',
  'members:invite',
  'members:update',
  'members:remove',
  'tenant:plan',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const MEMBER: readonly Permission[] = ['projects:read', 'projects:create', 'members:read'];
const ADMIN: readonly Permission[] = [
  ...MEMBER,
  'projects:delete',
  'members:invite',
  'members:update',
  'members:remove',
];
const OWNER: readonly Permission[] = [...ADMIN, 'tenant:plan'];

/** What each role may do. To add a permission, add it to PERMISSIONS and to the roles that get it. */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = { member: MEMBER, admin: ADMIN, owner: OWNER };

/** Used to stop people acting on, or handing out, roles above their own. */
export const ROLE_RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
