import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, type Role } from '../src/db/central/schema.ts';
import { PERMISSIONS, ROLE_RANK, can, type Permission } from '../src/permissions/permissions.ts';

// The role table from the stage 2 spec. Changing who can do what should change this test too.
const TABLE: Record<Permission, Role[]> = {
  'projects:read': ['member', 'admin', 'owner'],
  'projects:create': ['member', 'admin', 'owner'],
  'projects:delete': ['admin', 'owner'],
  'members:read': ['member', 'admin', 'owner'],
  'members:invite': ['admin', 'owner'],
  'members:update': ['admin', 'owner'],
  'members:remove': ['admin', 'owner'],
  'tenant:plan': ['owner'],
};

test('every role has exactly the permissions in the spec table', () => {
  for (const p of PERMISSIONS) {
    for (const r of ROLES) assert.equal(can(r, p), TABLE[p].includes(r), `${r} ${p}`);
  }
});

test('ranks order member < admin < owner', () => {
  assert.ok(ROLE_RANK.member < ROLE_RANK.admin && ROLE_RANK.admin < ROLE_RANK.owner);
});
