# Stage 2: Roles, Invitations and Plans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce role permissions on every tenant route, let tenants invite teammates by email, and gate features and usage by a per-tenant plan.

**Architecture:** Three new modules (`permissions/`, `members/`, `plans/`) plug into the stage 1 guard chain `requireAuth → requireTenant → requirePermission → requireFeature`. Membership and plan data live in the central database; one row lock on `tenants` per tenant serialises member changes and seat counting; project counting uses an advisory lock in the tenant database.

**Tech Stack:** Node 24, TypeScript (erasable syntax, `.ts` imports), Fastify 5 + fastify-type-provider-zod 7 + Zod 4, Drizzle ORM 0.45 + postgres.js, drizzle-kit, `node --test` against real Postgres.

**Spec:** `docs/superpowers/specs/2026-11-06-stage-2-roles-plans-design.md`

## Global Constraints

- Delivery is the spec's seven PRs, in order. Each PR: branch off an up-to-date `main`, commits, `git push -u origin <branch>`, `gh pr create`, CI green. **The user merges each PR**; start the next PR only after `git checkout main && git pull`.
- Commits, pushes and PRs only once the user has approved starting execution. Commits are authored as the user, with no co-author line.
- Every PR must pass `npm run typecheck`, `npm run lint` and `npm test` before it is pushed. Tests need `TEST_DATABASE_ADMIN_URL` (local: `.env.test`, Postgres on 5433).
- Tenant data only through `tenantDb(req)`; central changes to memberships and invitations only inside `withTenantLock`.
- Error responses use `AppError(code, status, message, details?)`; every new code is added to `ERROR_CODES` in `src/errors.ts`.
- Examples use `example.test` emails and generic tenant names only.
- Stage 1 tests must keep passing unchanged, except where a task names an edit.

## Review Focus

1. Self-escalation: an admin sending `PATCH /members/<own id> { role: 'owner' }` must get 403 — pinned in Task 4.
2. A removed member's very next request on the same instance must already be 404, not served from cache — pinned in Task 4.
3. Revoking an invitation id that belongs to another tenant must be 404 and leave it usable — pinned in Task 6.
4. An invitation sent to `Jane@Example.TEST` must be acceptable by the account `jane@example.test` — pinned in Task 7.
5. After `PUT /tenant/plan`, the same instance must apply the new plan on the next request (export unlocks immediately) — pinned in Task 9.

---

## PR 1 — `docs: stage 2 design and plan`

### Task 1: Open the design PR

**Files:** `docs/superpowers/specs/2026-11-06-stage-2-roles-plans-design.md`, `docs/superpowers/plans/2026-11-06-stage-2-roles-plans.md` (both exist, uncommitted)

- [ ] **Step 1:** `git checkout -b docs/stage-2-design`, add both files, commit `docs: stage 2 design and implementation plan (roles, invitations, plans)`.
- [ ] **Step 2:** Push and `gh pr create --title "docs: stage 2 design and plan" --body <summary of the spec's Decisions table and the 7-PR list>`.
- [ ] **Step 3:** `gh pr checks --watch` → Expected: CI `test` passes. Tell the user the PR is ready to merge; wait.

---

## PR 2 — `feat(permissions): role-based permissions` (branch `feat/permissions`)

### Task 2: Permission table

**Files:**
- Create: `src/permissions/permissions.ts`
- Test: `test/permissions.test.ts`

**Interfaces:**
- Produces: `PERMISSIONS` (tuple from the spec), `type Permission`, `ROLE_PERMISSIONS: Record<Role, readonly Permission[]>`, `can(role: Role, permission: Permission): boolean`, `ROLE_RANK: Record<Role, number>` = `{ member: 1, admin: 2, owner: 3 }`.

- [ ] **Step 1: Write the failing test**

```ts
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
  for (const p of PERMISSIONS) for (const r of ROLES) assert.equal(can(r, p), TABLE[p].includes(r), `${r} ${p}`);
});
test('ranks order member < admin < owner', () => {
  assert.ok(ROLE_RANK.member < ROLE_RANK.admin && ROLE_RANK.admin < ROLE_RANK.owner);
});
```

- [ ] **Step 2:** `node --env-file-if-exists=.env.test --test test/permissions.test.ts` → Expected: FAIL, cannot find module `src/permissions/permissions.ts`.
- [ ] **Step 3:** Implement `src/permissions/permissions.ts` with the names above.
- [ ] **Step 4:** Same command → Expected: PASS.
- [ ] **Step 5:** Commit `feat(permissions): role to permission table`.

### Task 3: `requirePermission` and guarded project routes

**Files:**
- Create: `src/permissions/guard.ts`
- Modify: `src/errors.ts` (add `FORBIDDEN`), `src/example/routes.ts`, `src/example/service.ts`, `test/helpers/app.ts`
- Test: `test/permissions-routes.test.ts`

**Interfaces:**
- Consumes: `can`, `Permission` (Task 2); `req.membership` (stage 1 `requireTenant`).
- Produces: `requirePermission(permission: Permission): preHandlerAsyncHookHandler` — throws `AppError('FORBIDDEN', 403, 'Your role does not allow this', { permission })`. `deleteProject(db: TenantDb, id: string): Promise<boolean>`. Test helper `addMember(t: TestApp, slug: string, email: string, role: Role): Promise<string>` — signs up `email`, inserts the membership with SQL via `t.deps.central.sql`, returns the new user's access token. Test helper `createTenant(t: TestApp, token: string, slug: string): Promise<void>` wrapping `POST /tenants`.

- [ ] **Step 1: Write the failing test** — one owner creates `tenant-a`; `addMember` adds an admin, a member, and an outsider is signed up without membership. Assert, for each of `GET /api/projects`, `POST /api/projects`, `DELETE /api/projects/:id`:

```ts
const EXPECT = {
  'GET /api/projects':        { owner: 200, admin: 200, member: 200, outsider: 404 },
  'POST /api/projects':       { owner: 201, admin: 201, member: 201, outsider: 404 },
  'DELETE /api/projects/:id': { owner: 204, admin: 204, member: 403, outsider: 404 },
};
```
(each DELETE targets a freshly created project). Plus: a member's 403 body is `{ error: { code: 'FORBIDDEN', details: { permission: 'projects:delete' } } }`; `DELETE` of an unknown uuid as owner is 404 `NOT_FOUND`.
- [ ] **Step 2:** Run the file → Expected: FAIL (DELETE route missing → 404 for everyone).
- [ ] **Step 3:** Implement the guard, add `FORBIDDEN` to `ERROR_CODES`, add `preHandler: [...base, requirePermission(...)]` to the three routes, add the DELETE route (`params: z.object({ id: z.uuid() })`, 204) and `deleteProject`.
- [ ] **Step 4:** Run the file, then `npm test` → Expected: all PASS (stage 1 tests unchanged).
- [ ] **Step 5:** Commit `feat(permissions): requirePermission guard on project routes, DELETE /api/projects/:id`. Push, open PR `feat(permissions): role-based permissions`, CI green, hand to the user.

---

## PR 3 — `feat(members): list, change role, remove and leave` (branch `feat/members`)

### Task 4: Members service and routes

**Files:**
- Create: `src/members/lock.ts`, `src/members/service.ts`, `src/members/routes.ts`
- Modify: `src/errors.ts` (add `LAST_OWNER`), `src/app.ts` (register `registerMemberRoutes` next to the example routes)
- Test: `test/members.test.ts`

**Interfaces:**
- Consumes: `ROLE_RANK`, `requirePermission` (PR 2); `TenantCache.memberships` (stage 1).
- Produces:
  - `type CentralTx` (the Drizzle transaction type of `central.db.transaction`) and `withTenantLock<T>(central: CentralDb, tenantId: string, fn: (tx: CentralTx) => Promise<T>): Promise<T>` — opens a transaction, runs `select id from tenants where id = $1 for update`, then `fn`.
  - `listMembers(central, tenantId): Promise<Member[]>` with `Member = { userId: string; email: string; role: Role; joinedAt: Date }`, owners first then by `joinedAt`.
  - `changeRole(central, cache, { tenantId, actor: { userId, role }, targetUserId, role }): Promise<Member>`
  - `removeMember(central, cache, { tenantId, actor: { userId, role }, targetUserId }): Promise<void>`
  - `assertCanManage(actorRole: Role, targetRole: Role, newRole?: Role): void` — throws `FORBIDDEN` per the spec's rank rule (owners pass everything; others need `ROLE_RANK[target] <= ROLE_RANK[actor]` and `ROLE_RANK[newRole] <= ROLE_RANK[actor]`).
  - Routes: `GET /members` (`members:read`), `PATCH /members/:userId` (`members:update`), `DELETE /members/:userId` (`members:remove`, skipped when `:userId` is the caller — check inside the handler, not with the guard).

Inside the lock: load the target's membership (missing → `404 NOT_FOUND`), apply `assertCanManage` (not for self-leave), count owners; if the change would leave 0 owners → `409 LAST_OWNER`. After commit, `cache.memberships.delete(\`${tenantId}:${targetUserId}\`)`.

- [ ] **Step 1: Write the failing tests** (`test/members.test.ts`):
  - `GET /members` as a member lists owner first with `{ userId, email, role, joinedAt }`.
  - admin promotes member → admin: 200; admin demotes an admin → member: 200.
  - admin → `PATCH` owner to member: 403; admin promotes anyone to owner: 403; **admin promotes self to owner: 403** (Review Focus 1); admin removes owner: 403.
  - owner promotes member → owner: 200, then two owners exist.
  - only owner demotes self / removes self / is removed: each 409 `LAST_OWNER`.
  - two owners send `PATCH` demoting each other in parallel (`Promise.all`): exactly one 200 and one 409; afterwards exactly one owner.
  - member leaves (`DELETE /members/<own id>`): 204; **their next `GET /api/projects` is 404 `TENANT_NOT_FOUND`** (Review Focus 2 — they had made a request before removal, so the cache was warm).
  - `PATCH`/`DELETE` of a user who isn't a member: 404 `NOT_FOUND`; setting the same role: 200, unchanged.
- [ ] **Step 2:** Run the file → Expected: FAIL (routes missing, 404).
- [ ] **Step 3:** Implement the files above and add `LAST_OWNER`.
- [ ] **Step 4:** Run the file, then `npm test` → Expected: all PASS.
- [ ] **Step 5:** Commit `feat(members): list, change role, remove and leave with owner safety`. Push, open PR, CI green, hand to the user.

---

## PR 4 — `feat(invitations): invite by email` (branch `feat/invitations`)

### Task 5: `invitations` table

**Files:**
- Modify: `src/db/central/schema.ts`
- Create (generated): `src/db/central/migrations/0001_invitations.sql` and its `meta/` updates
- Test: `test/central.test.ts` (extend)

**Interfaces:**
- Produces: Drizzle table `invitations` with the spec's columns (`id, tenantId, email, role, tokenHash, invitedBy, expiresAt, acceptedAt, revokedAt, createdAt`), `INVITE_ROLES = ['admin', 'member'] as const`, check `invitations_role_check`, unique `token_hash`, partial unique index `invitations_open_idx` on `(tenant_id, email) where accepted_at is null and revoked_at is null`.

- [ ] **Step 1: Write the failing test** in `test/central.test.ts`: after migrating, inserting two open invitations for the same `(tenant, email)` fails with Postgres code `23505`; inserting a second one after setting `revoked_at` on the first succeeds; `role = 'owner'` fails with `23514`.
- [ ] **Step 2:** Run → Expected: FAIL, relation `invitations` does not exist.
- [ ] **Step 3:** Add the table to the schema, run `npm run db:generate:central -- --name invitations`, check the SQL contains the partial index's `WHERE`.
- [ ] **Step 4:** Run, then `npm test` → Expected: PASS.
- [ ] **Step 5:** Commit `feat(invitations): invitations table`.

### Task 6: Create, list and revoke invitations

**Files:**
- Create: `src/members/invitations.ts`
- Modify: `src/members/routes.ts`, `src/errors.ts` (add `ALREADY_MEMBER`), `src/app.ts` (pass `mailer` and `config` to member routes)
- Test: `test/invitations.test.ts`

**Interfaces:**
- Consumes: `withTenantLock`, `assertCanManage` (Task 4); `randomToken`, `hashToken` (`src/auth/tokens.ts`); `Mailer`.
- Produces:
  - `INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000`
  - `createInvitation(deps: { central; mailer; config }, { tenant: Tenant, actor: { userId, email, role }, email, role }): Promise<Invitation>` — `Invitation = { id, email, role, invitedBy: string | null, expiresAt: Date }`. Steps exactly as the spec's "Creating" list, minus the limit check (PR 6). Mail sent after commit: subject `You're invited to ${tenant.name}`, text includes the inviter's email, the role and `https://${config.baseDomain}/invitations/accept?token=${token}`.
  - `listInvitations(central, tenantId): Promise<Invitation[]>` — usable only, newest first.
  - `revokeInvitation(central, tenantId, id): Promise<void>` — open invitation in this tenant, else `404 NOT_FOUND`.
  - Routes: `POST /members/invitations` (`members:invite`, `config: { rateLimit: { max: 20, timeWindow: '1 minute' } }`, body `{ email: <same email schema as auth>, role: z.enum(INVITE_ROLES) }`, 201), `GET /members/invitations`, `DELETE /members/invitations/:id` (204).

- [ ] **Step 1: Write the failing tests:**
  - owner invites `new@example.test` as member: 201 without any token field; exactly one mail to `new@example.test`, subject `You're invited to tenant-a`, text contains the owner's email, `member` and `token=`.
  - admin invites an admin: 201; admin invites `role: 'owner'`: 400 `VALIDATION_FAILED`; member invites: 403.
  - inviting an existing member's email: 409 `ALREADY_MEMBER`.
  - re-inviting the same email: the first token no longer matches a usable row (query `invitations` by `token_hash`: `revoked_at` set); `GET /members/invitations` lists one.
  - revoke: 204, then gone from the list; revoking again: 404.
  - **revoking tenant-a's invitation id while addressing tenant-b (caller owns both): 404, and it is still listed in tenant-a** (Review Focus 3).
  - the 21st invite within a minute from one IP: 429 `RATE_LIMITED`.
- [ ] **Step 2:** Run → Expected: FAIL (routes missing).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, then `npm test` → Expected: all PASS.
- [ ] **Step 5:** Commit `feat(invitations): create, list and revoke invitations`.

### Task 7: Accept an invitation

**Files:**
- Modify: `src/members/invitations.ts`, `src/members/routes.ts` (register `POST /invitations/accept` with `requireAuth` only), `src/errors.ts` (add `INVITATION_INVALID`, `INVITATION_EMAIL_MISMATCH`)
- Test: `test/invitations.test.ts` (extend)

**Interfaces:**
- Produces: `acceptInvitation(deps: { central; cache }, { token: string, user: { id, email } }): Promise<{ tenant: { id, slug, name }, role: Role }>` — the spec's "Accepting" steps 1–6 minus the limit check (PR 6), inside `withTenantLock` on the invitation's tenant. Clears `cache.memberships` for `${tenantId}:${userId}` after commit.

- [ ] **Step 1: Write the failing tests:**
  - existing user (signed up before the invite) accepts: 200 `{ tenant: { slug: 'tenant-a' }, role: 'member' }`; then `GET /api/projects` as them on tenant-a: 200.
  - new user: invite first, then sign up with that email and accept: 200; `users.email_verified_at` is now set.
  - **invite `Jane@Example.TEST`, sign up `jane@example.test`, accept: 200** (Review Focus 4).
  - accepting twice: second is 400 `INVITATION_INVALID`; revoked token: 400; unknown token: 400; expired (`update invitations set expires_at = now() - interval '1 second'`): 400.
  - wrong account: 403 `INVITATION_EMAIL_MISMATCH`, then the right account accepts the same token: 200.
  - already a member (owner invites an existing admin by inserting the row directly, bypassing `ALREADY_MEMBER`): accept returns 200 with role `admin`, unchanged.
  - suspended tenant (`update tenants set status = 'suspended'`, clear `t.deps.cache`): 403 `TENANT_SUSPENDED`.
  - no bearer token: 401.
- [ ] **Step 2:** Run → Expected: FAIL (404 on `/invitations/accept`).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, then `npm test` → Expected: all PASS.
- [ ] **Step 5:** Commit `feat(invitations): accept an invitation`. Push, open PR `feat(invitations): invite by email`, CI green, hand to the user.

---

## PR 5 — `feat(plans): plans and feature gating` (branch `feat/plans`)

### Task 8: Plan column and plan definitions

**Files:**
- Modify: `src/db/central/schema.ts` (`PLAN_IDS` import, `plan` column, check `tenants_plan_check`), `src/tenancy/provision.ts` (`Tenant.plan`, `tenantColumns.plan`)
- Create: `src/plans/plans.ts`; generated `src/db/central/migrations/0002_tenant_plan.sql`
- Test: `test/plans.test.ts`

**Interfaces:**
- Produces: `PLAN_IDS`, `FEATURES`, `LIMITS`, `type PlanId`, `type Feature`, `type Limit`, `interface PlanDefinition { name: string; features: readonly Feature[]; limits: Record<Limit, number | null> }`, `PLANS` (values exactly as the spec), `hasFeature(plan: PlanId, f: Feature): boolean`, `limitFor(plan: PlanId, l: Limit): number | null`, `cheapestPlanWith(f: Feature): PlanId`. `Tenant` gains `plan: PlanId`. `plans.ts` must not import from `db/`, so `schema.ts` can import `PLAN_IDS` from it.

- [ ] **Step 1: Write the failing tests:** `PLANS` deep-equals the spec's table; `hasFeature('free','projects:export') === false`, `'pro'` true; `limitFor('business','members') === null`; `cheapestPlanWith('projects:export') === 'pro'`; a newly provisioned tenant's `findTenantBySlug(...).plan === 'free'`; `update tenants set plan = 'gold'` fails with `23514`.
- [ ] **Step 2:** Run → Expected: FAIL (module missing).
- [ ] **Step 3:** Implement; `npm run db:generate:central -- --name tenant_plan` (column `not null default 'free'`).
- [ ] **Step 4:** Run, then `npm test` → Expected: all PASS.
- [ ] **Step 5:** Commit `feat(plans): plan column and plan definitions`.

### Task 9: Feature gate, plan routes and CSV export

**Files:**
- Create: `src/plans/guard.ts`, `src/plans/service.ts`, `src/plans/routes.ts`, `src/example/csv.ts`
- Modify: `src/errors.ts` (add `FEATURE_NOT_AVAILABLE`), `src/example/routes.ts`, `src/app.ts`
- Test: `test/plan-routes.test.ts`, `test/csv.test.ts`

**Interfaces:**
- Consumes: `hasFeature`, `cheapestPlanWith`, `PLANS` (Task 8); `req.tenant`.
- Produces:
  - `requireFeature(f: Feature): preHandlerAsyncHookHandler` — `AppError('FEATURE_NOT_AVAILABLE', 403, \`Your plan doesn't include ${f}\`, { feature: f, plan, requiredPlan })`.
  - `changePlan(central: CentralDb, cache: TenantCache, tenantId: string, plan: PlanId): Promise<void>` — updates `plan` and `updated_at`, then `cache.invalidateTenant(tenantId)`.
  - `planSummary(central, tenant: Tenant, db: TenantDb): Promise<PlanSummary>` with `PlanSummary = { plan, name, features, limits, usage: { members: number; projects: number } }`; in this PR `usage.members` counts memberships only (PR 6 adds usable invitations).
  - Routes `GET /tenant/plan` (`members:read`), `PUT /tenant/plan` (`tenant:plan`, body `{ plan: z.enum(PLAN_IDS) }`), `GET /api/projects/export` (`projects:read` + `requireFeature('projects:export')`, `content-type: text/csv; charset=utf-8`).
  - `toCsv(rows: readonly (readonly string[])[]): string` — rows joined with `\r\n`, trailing `\r\n`; a field is quoted (inner `"` doubled) when it contains `,`, `"`, `\r` or `\n`; a field starting with `=`, `+`, `-` or `@` gets a leading `'` before any quoting.

- [ ] **Step 1: Write the failing tests:**
  - `test/csv.test.ts`: `toCsv([['a,b','say "hi"','line\nbreak','=SUM(A1)','plain']])` equals `"a,b","say ""hi""","line\nbreak",'=SUM(A1),plain\r\n` (as a JS string literal in the test).
  - free tenant: export 403 with `details { feature: 'projects:export', plan: 'free', requiredPlan: 'pro' }`.
  - owner `PUT /tenant/plan { plan: 'pro' }`: 200 with `limits.members === 20`; **the very next export request is 200**, body's first line `id,name,createdBy,createdAt` (Review Focus 5).
  - admin `PUT /tenant/plan`: 403 `FORBIDDEN`; member `GET /tenant/plan`: 200 with `usage.projects` equal to the number of projects; `PUT { plan: 'gold' }`: 400.
- [ ] **Step 2:** Run → Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, then `npm test` → Expected: all PASS.
- [ ] **Step 5:** Commit `feat(plans): feature gating, plan routes and CSV export`. Push, open PR `feat(plans): plans and feature gating`, CI green, hand to the user.

---

## PR 6 — `feat(plans): enforce plan limits` (branch `feat/plan-limits`)

### Task 10: Member limit

**Files:**
- Modify: `src/members/invitations.ts`, `src/plans/service.ts`, `src/errors.ts` (add `PLAN_LIMIT_REACHED`)
- Test: `test/plan-limits.test.ts`

**Interfaces:**
- Produces: `memberUsage(tx: CentralTx, tenantId: string, opts?: { excludeEmail?: string; excludeInvitationId?: string }): Promise<number>` = memberships + usable invitations, minus the excluded open invitation. `assertWithinLimit(plan: PlanId, limit: Limit, usedAfter: number): void` — throws `AppError('PLAN_LIMIT_REACHED', 403, \`Your ${plan} plan allows ${max} ${limit}\`, { limit, max, plan })` when `max !== null && usedAfter > max`. `planSummary.usage.members` switches to `memberUsage`.
- Inviting: `assertWithinLimit(plan, 'members', memberUsage(tx, id, { excludeEmail: email }) + 1)` before insert. Accepting (when not already a member): `assertWithinLimit(plan, 'members', memberUsage(tx, id, { excludeInvitationId }) + 1)`. Read `plan` from the locked `tenants` row, not the cache.

- [ ] **Step 1: Write the failing tests** (free tenant, owner only):
  - 2 invitations: 201, 201; 3rd: 403 `PLAN_LIMIT_REACHED` `{ limit: 'members', max: 3, plan: 'free' }`.
  - re-inviting one of the 2 pending emails: 201 (replaced, not counted twice).
  - accepting a pending invitation at exactly 3: 200.
  - two parallel invites racing for the last seat: one 201, one 403.
  - downgrade: on pro with 5 members, `PUT plan free` → 200, all 5 still listed, a new invite is 403; a pending invitation from before the downgrade fails to accept with 403.
  - `GET /tenant/plan` `usage.members` counts usable invitations.
- [ ] **Step 2:** Run → Expected: FAIL (3rd invite returns 201).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, then `npm test` → Expected: all PASS.
- [ ] **Step 5:** Commit `feat(plans): member limit on invite and accept`.

### Task 11: Project limit

**Files:**
- Modify: `src/example/service.ts`, `src/example/routes.ts`
- Test: `test/plan-limits.test.ts` (extend)

**Interfaces:**
- Produces: `PROJECT_LIMIT_LOCK_KEY = 727275`; `createProject(db: TenantDb, input: { name; createdBy }, opts?: { plan: PlanId }): Promise<Project>` — when `opts` is given, runs in a tenant-DB transaction: `select pg_advisory_xact_lock(727275)`, count projects, `assertWithinLimit(plan, 'projects', count + 1)`, insert. The seed keeps calling it without `opts`. The route passes `{ plan: req.tenant.plan }`.

- [ ] **Step 1: Write the failing tests:** free tenant with 9 projects (insert via `createProject` without opts): the 10th `POST` is 201, the 11th is 403 `{ limit: 'projects', max: 10 }`; on a fresh free tenant with 9 projects, two parallel `POST`s give exactly one 201 and one 403; business tenant: 11th is 201.
- [ ] **Step 2:** Run → Expected: FAIL (11th is 201).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, then `npm test` → Expected: all PASS.
- [ ] **Step 5:** Commit `feat(plans): project limit`. Push, open PR `feat(plans): enforce plan limits`, CI green, hand to the user.

---

## PR 7 — `docs: roles, invitations and plans` (branch `docs/stage-2`)

### Task 12: Seed data and README

**Files:**
- Modify: `src/dev/seed.ts`, `test/seed.test.ts`, `README.md`

**Interfaces:**
- Produces: `DEMO_ADMIN_EMAIL = 'admin@example.test'`, `DEMO_MEMBER_EMAIL = 'member@example.test'` (password `DEMO_PASSWORD`), both in tenant-a with those roles; tenant-a on `pro`, tenant-b on `free`. Still safe to run repeatedly.

- [ ] **Step 1: Write the failing test** in `test/seed.test.ts`: after seeding twice, tenant-a has exactly 3 memberships with roles owner/admin/member and plan `pro`; tenant-b plan `free`; the member's `DELETE /api/projects/:id` on tenant-a is 403.
- [ ] **Step 2:** Run → Expected: FAIL.
- [ ] **Step 3:** Implement the seed; use `on conflict do nothing` for memberships and `changePlan` for plans.
- [ ] **Step 4:** Update `README.md`: a "Roles" section with the permission table; a "Members and invitations" section; a "Plans" section with the plans table and the downgrade rule; the new endpoints in the Endpoints table; the seven new codes in the Errors table; a trade-off line that a removed member can keep access for up to 30 s and a plan change takes up to 60 s on other instances; quick start mentions the admin and member demo accounts; roadmap item 2 marked done.
- [ ] **Step 5:** `npm run typecheck && npm run lint && npm test` → Expected: all PASS. Commit `docs: roles, invitations and plans`. Push, open PR, CI green, hand to the user.
