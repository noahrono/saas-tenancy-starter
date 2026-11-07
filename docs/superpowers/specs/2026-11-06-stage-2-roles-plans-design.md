# Stage 2: roles, invitations and plans — design

Status: approved in conversation 2026-11-06, written for review.
Builds on: [stage 1](2026-11-06-stage-1-core-tenancy-design.md).

## Goal

Make the role already stored on every membership mean something, let tenants bring in teammates, and let a tenant's plan switch features on and limit usage. Everything is enforced on the server. A person forking the starter should be able to add a permission, a feature or a limit by editing one file.

Success looks like:

- Every tenant route states the permission it needs, and a test proves each role gets exactly what the role table says.
- A tenant can never end up without an owner, even under concurrent requests.
- Someone without an account can be invited by email, sign up and land in the tenant.
- A free tenant can't add a 4th member or export projects; a pro tenant can; downgrading never deletes anything.
- Stage 1 behaviour is unchanged: non-members still get 404, tenants stay isolated.

## Decisions taken

| Question | Decision | Why |
|---|---|---|
| Roles | Three fixed roles (`owner`, `admin`, `member`) mapped to permissions in code | Simple, typed, testable. Routes check permissions, so custom roles could later replace the lookup without touching routes. |
| Joining a tenant | Email invitations with a single-use link, valid 7 days | Works for people who haven't signed up yet; reuses stage 1's token hashing and mailer. |
| Plans | Defined in code, one `plan` column per tenant | Plans change with the product and ship with code. Typed feature names fail the build on a typo. No operator UI is needed. |

## Data model (central database)

Migration `0001` adds:

**`invitations`**

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `tenant_id` | uuid not null | references `tenants`, on delete cascade |
| `email` | text not null | stored lower-cased and trimmed |
| `role` | text not null | check in (`admin`, `member`) — nobody is invited straight in as owner |
| `token_hash` | text not null unique | SHA-256 of the token, as for refresh and email tokens |
| `invited_by` | uuid | references `users`, on delete set null |
| `expires_at` | timestamptz not null | created + 7 days |
| `accepted_at` | timestamptz | |
| `revoked_at` | timestamptz | |
| `created_at` | timestamptz not null default now() | |

A partial unique index on `(tenant_id, email) where accepted_at is null and revoked_at is null` allows one open invitation per email per tenant. An invitation is **open** when it is neither accepted nor revoked; it is **usable** when it is open and `expires_at > now()`.

Migration `0002` adds **`tenants.plan`**: text not null default `'free'`, check in (`free`, `pro`, `business`). Existing tenants become `free`. `Tenant` (as returned by `findTenantBySlug` and cached in `TenantCache.bySlug`) gains `plan`.

`memberships` is unchanged.

## Modules

| Path | Responsibility |
|---|---|
| `src/permissions/permissions.ts` | `PERMISSIONS`, `ROLE_PERMISSIONS`, `can(role, permission)`, `ROLE_RANK` |
| `src/permissions/guard.ts` | `requirePermission(permission)` preHandler |
| `src/plans/plans.ts` | `PLAN_IDS`, `FEATURES`, `LIMITS`, `PLANS`, `hasFeature`, `limitFor`, `cheapestPlanWith` |
| `src/plans/guard.ts` | `requireFeature(feature)` preHandler |
| `src/plans/routes.ts`, `service.ts` | `GET`/`PUT /tenant/plan`, usage counts, `changePlan` |
| `src/members/routes.ts`, `service.ts` | list, change role, remove, leave |
| `src/members/invitations.ts` | create, list, revoke, accept |

Guards run in this order on tenant routes: `requireAuth` → `requireTenant` → `requirePermission` → `requireFeature`. So an outsider still gets stage 1's 404 before any 403, and a suspended tenant still gets its status error first.

## Permissions

```ts
export const PERMISSIONS = [
  'projects:read', 'projects:create', 'projects:delete',
  'members:read', 'members:invite', 'members:update', 'members:remove',
  'tenant:plan',
] as const;
```

| Permission | member | admin | owner |
|---|:-:|:-:|:-:|
| `projects:read`, `projects:create` | ✓ | ✓ | ✓ |
| `projects:delete` | | ✓ | ✓ |
| `members:read` | ✓ | ✓ | ✓ |
| `members:invite`, `members:update`, `members:remove` | | ✓ | ✓ |
| `tenant:plan` | | | ✓ |

`requirePermission(p)` reads `req.membership.role` (set by `requireTenant`) and throws `403 FORBIDDEN` with `details: { permission: p }` when `can(role, p)` is false.

The example routes are guarded: `GET /api/projects` → `projects:read`, `POST /api/projects` → `projects:create`, and a new `DELETE /api/projects/:id` → `projects:delete` (204, or `404 NOT_FOUND` if no such project in this tenant).

## Managing members

All routes are tenant routes (subdomain or `X-Tenant`).

| Route | Permission | Result |
|---|---|---|
| `GET /members` | `members:read` | `[{ userId, email, role, joinedAt }]`, owners first, then by join date |
| `PATCH /members/:userId { role }` | `members:update` | the updated member |
| `DELETE /members/:userId` | `members:remove`, or none when `:userId` is the caller (leaving) | 204 |

**Rank rule.** `ROLE_RANK = { member: 1, admin: 2, owner: 3 }`. A caller who is not an owner can only act on members whose current role ranks no higher than their own, and can only assign roles that rank no higher than their own. In practice: admins manage members and admins, owners manage everyone, and only an owner can make someone an owner (so co-owners are possible; ownership is transferred by promoting someone and then leaving). A rank violation is `403 FORBIDDEN`.

**Last owner rule.** Demoting or removing the tenant's only owner, or that owner leaving, is `409 LAST_OWNER`.

**Concurrency.** Every membership change, invitation and acceptance runs in one central transaction that first takes `select … from tenants where id = $1 for update`. This one lock per tenant serialises the owner count check and the member-limit check, so two owners demoting each other at the same moment can't both succeed, and two invitations can't both take the last seat.

A target who isn't a member of this tenant is `404 NOT_FOUND`. Changing a role to the role it already has is a no-op that returns 200.

**Cache.** After a role change or removal the service deletes `memberships` cache key `${tenantId}:${userId}` on this instance. Other instances catch up within the existing 30-second membership TTL; the README already documents this, and the trade-off section is updated to say a removed member can keep access for up to 30 seconds on other instances.

## Invitations

| Route | Permission | Result |
|---|---|---|
| `POST /members/invitations { email, role }` | `members:invite` | 201 `{ id, email, role, invitedBy, expiresAt }` |
| `GET /members/invitations` | `members:invite` | usable invitations, newest first |
| `DELETE /members/invitations/:id` | `members:invite` | 204; `404 NOT_FOUND` if not open in this tenant |
| `POST /invitations/accept { token }` | logged in only (not a tenant route) | 200 `{ tenant: { id, slug, name }, role }` |

**Creating.** `role` is `admin` or `member` (validation rejects `owner`), and the rank rule applies (an admin may invite admins). The email is lower-cased and trimmed. In one transaction holding the tenant lock:

1. If a user with that email is already a member: `409 ALREADY_MEMBER`.
2. Any open invitation for the same email in this tenant is revoked (re-inviting replaces the old link).
3. The member limit is checked (see Plans).
4. The invitation is inserted with a fresh 32-byte token; only its hash is stored.

After commit the mailer sends one email: subject `You're invited to <tenant name>`, text naming the inviter's email and the role, and the link `https://<BASE_DOMAIN>/invitations/accept?token=<token>`. The token is never returned by the API. `POST /members/invitations` is rate limited to 20 per minute per IP, since every call sends an email.

**Accepting.** The caller signs in, or signs up through the normal `POST /auth/signup`, then sends the token. In one transaction holding the tenant lock:

1. The token must match a usable invitation, else `400 INVITATION_INVALID` (unknown, expired, accepted or revoked all look the same).
2. The caller's email must equal the invitation's email (case-insensitive), else `403 INVITATION_EMAIL_MISMATCH`. The invitation stays usable, so the right person can still accept it.
3. The tenant must be `active`, else the stage 1 status errors (`TENANT_NOT_READY` / `TENANT_SUSPENDED`).
4. If the caller is already a member, the invitation is marked accepted and their existing role is returned unchanged.
5. Otherwise the member limit is checked again (a downgrade may have happened since the invite) and a membership is inserted with the invitation's role.
6. The invitation is marked accepted. Because the link reached their inbox, the user's `email_verified_at` is set if it was empty.

## Plans

```ts
export const PLAN_IDS = ['free', 'pro', 'business'] as const;
export const FEATURES = ['projects:export'] as const;
export const LIMITS = ['members', 'projects'] as const;

export const PLANS = {
  free:     { name: 'Free',     features: [],                  limits: { members: 3,    projects: 10 } },
  pro:      { name: 'Pro',      features: ['projects:export'], limits: { members: 20,   projects: 1000 } },
  business: { name: 'Business', features: ['projects:export'], limits: { members: null, projects: null } },
} satisfies Record<PlanId, PlanDefinition>;
```

`null` means unlimited. `cheapestPlanWith(feature)` returns the first plan in `PLAN_IDS` order that has the feature.

**Features.** `requireFeature(f)` reads `req.tenant.plan` and throws `403 FEATURE_NOT_AVAILABLE` with `details: { feature, plan, requiredPlan }`. The gated example is `GET /api/projects/export` (`projects:read` + `projects:export`), which returns `text/csv` with a header row `id,name,createdBy,createdAt`. Fields are quoted when they contain a comma, quote or newline, and any field starting with `=`, `+`, `-` or `@` is prefixed with `'` so spreadsheets don't run it as a formula.

**Limits.** Checked only when something is added, never retroactively:

- **members** counts memberships plus usable invitations. Checked when inviting (the invitation being replaced doesn't count) and when accepting (the invitation being accepted counts once, not twice), under the tenant lock.
- **projects** counts rows in the tenant's `projects` table. Checked in `POST /api/projects` inside a tenant-database transaction that first takes `pg_advisory_xact_lock` with a fixed key, so parallel creates can't overshoot.

Going over is `403 PLAN_LIMIT_REACHED` with `details: { limit, max, plan }`.

**Changing plan.**

| Route | Permission | Result |
|---|---|---|
| `GET /tenant/plan` | `members:read` (any member) | `{ plan, name, features, limits, usage: { members, projects } }` |
| `PUT /tenant/plan { plan }` | `tenant:plan` | the same shape, after the change |

`changePlan(central, tenantId, plan)` is the single function a future billing integration would call. Downgrading is allowed even when usage is over the new limits: nothing is deleted, and adding more is refused until usage is back under. The changing instance calls `cache.invalidateTenant(tenantId)`; other instances see the new plan within the existing 60-second tenant TTL.

## Errors added

| Code | Status | Meaning |
|---|---|---|
| `FORBIDDEN` | 403 | Your role doesn't allow this |
| `LAST_OWNER` | 409 | The tenant would be left without an owner |
| `ALREADY_MEMBER` | 409 | That person is already a member |
| `INVITATION_INVALID` | 400 | Invitation link invalid, expired, used or revoked |
| `INVITATION_EMAIL_MISMATCH` | 403 | Signed in as a different email than the one invited |
| `FEATURE_NOT_AVAILABLE` | 403 | The tenant's plan doesn't include this feature |
| `PLAN_LIMIT_REACHED` | 403 | The tenant's plan limit is reached |

## Seed data

`npm run dev:seed` adds `admin@example.test` and `member@example.test` (same demo password) to tenant-a with those roles, sets tenant-a to `pro` and leaves tenant-b on `free`, so every role and both plan behaviours can be tried in Swagger UI.

## Testing

Integration tests against real Postgres, one throwaway set of databases per test file, as in stage 1.

- **Permission matrix:** every protected route called as owner, admin, member and outsider, asserting the exact status from the role table.
- **Rank and owner safety:** admin can't promote to owner, change an owner or remove an owner; owner can; last owner can't be demoted, removed or leave; two owners demoting each other in parallel leaves exactly one owner.
- **Invitations:** existing user accepts; new user signs up then accepts; expired, accepted, revoked and unknown tokens; wrong email (and the right email still works afterwards); re-invite revokes the old link; inviting an existing member; accepting when already a member; the email's content and link.
- **Plans:** export allowed on pro and refused on free with `requiredPlan: 'pro'`; the 3rd member allowed and the 4th refused on free; parallel invites racing for the last seat; parallel project creates at the edge; downgrade while over the limit keeps data and blocks additions; plan change visible immediately on the same instance.
- **CSV:** commas, quotes, newlines and formula-looking names are escaped.
- **Stage 1 still holds:** isolation and outsider-404 tests are unchanged and pass.

## Delivery: seven PRs

Each PR has its own branch, a description, and passing CI before it is merged; each leaves the app working.

1. `docs: stage 2 design and plan`
2. `feat(permissions): role-based permissions` — permissions module, guard, `FORBIDDEN`, guarded example routes, `DELETE /api/projects/:id`
3. `feat(members): list, change role, remove and leave` — rank and last-owner rules, tenant lock, cache clearing
4. `feat(invitations): invite by email` — migration `0001`, create/list/revoke/accept, email
5. `feat(plans): plans and feature gating` — migration `0002`, `plans.ts`, `GET`/`PUT /tenant/plan`, `requireFeature`, CSV export
6. `feat(plans): enforce plan limits` — member and project limits, locks, downgrade behaviour
7. `docs: roles, invitations and plans` — README tables, endpoints, errors, trade-offs, seed data, roadmap

PR 4 ships invitations without the member-limit steps; PR 6 adds them to both inviting and accepting.

## Out of scope

Billing and payments, custom roles, an audit log, an invitation preview endpoint, a dedicated ownership-transfer endpoint, a real email provider, and cross-instance cache invalidation. Each is a natural follow-up; none is needed for the stage 2 goal.
