# saas-tenancy-starter

A backend starter for B2B SaaS where **every tenant gets its own PostgreSQL database**. Tenant databases are created automatically, migrated together and routed by subdomain. The rest is in place too: users who belong to many tenants, role-based permissions, email invitations, plans that switch features on and cap usage, rotating refresh tokens, and tests that prove one tenant can't see another's data.

Built with Node 24, TypeScript, Fastify 5, Drizzle ORM and postgres.js. Tests run against real Postgres.

## Why one database per tenant

| | Shared tables (`tenant_id` column) | Schema per tenant | **Database per tenant** |
|---|---|---|---|
| A missed `WHERE` leaks data | yes | if `search_path` is wrong | **no: other tenants aren't on the connection** |
| Back up or restore one tenant | hard | possible | **`pg_dump` one database** |
| Move a big tenant to its own server | hard | hard | **change `db_host`** |
| Cost per tenant | lowest | low | low on a shared server |

The cost is more connections and a migration step that touches every tenant. Both are handled here.

## Quick start

```bash
docker compose up -d postgres        # Postgres 17 on localhost:5432
npm ci
npm run keys:generate                # creates .env from .env.example with fresh Ed25519 keys
npm run migrate:central
npm run dev:seed                     # demo users and tenants, see below
npm run dev                          # http://localhost:3000, docs at /docs
```

Then try it:

```bash
TOKEN=$(curl -s localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"demo@example.test","password":"demo-password-123"}' | jq -r .accessToken)

curl -s localhost:3000/tenants -H "authorization: Bearer $TOKEN"
curl -s localhost:3000/api/projects -H "authorization: Bearer $TOKEN" -H 'x-tenant: tenant-a'
curl -s localhost:3000/api/projects -H "authorization: Bearer $TOKEN" -H 'x-tenant: tenant-b'
curl -s localhost:3000/api/projects/export -H "authorization: Bearer $TOKEN" -H 'x-tenant: tenant-a'   # pro: CSV
curl -s localhost:3000/api/projects/export -H "authorization: Bearer $TOKEN" -H 'x-tenant: tenant-b'   # free: 403
```

The seed creates these, all with the password `demo-password-123`:

| Account | tenant-a (pro plan) | tenant-b (free plan) |
|---|---|---|
| `demo@example.test` | owner | owner |
| `admin@example.test` | admin | – |
| `member@example.test` | member | – |

In a browser, `http://tenant-a.localhost:3000/api/projects` routes to tenant A by subdomain. The `X-Tenant` header only works when `TENANT_HEADER=true`, which is for local development and tests. Turn it off in production.

If something else already uses port 5432, run `POSTGRES_PORT=5433 docker compose up -d postgres` and point `DATABASE_URL` at 5433. To run the whole stack in Docker on other host ports: `POSTGRES_PORT=5433 API_PORT=3001 docker compose up -d`.

## How a request is routed

```mermaid
flowchart LR
  R[Request<br/>tenant-a.example.com] --> A{Valid access<br/>token?}
  A -- no --> N401[401 UNAUTHENTICATED]
  A -- yes --> S[Resolve slug<br/>Host or X-Tenant]
  S --> T{Tenant exists?}
  T -- no --> N404[404 TENANT_NOT_FOUND]
  T -- yes --> M{Member of<br/>this tenant?}
  M -- no --> N404
  M -- yes --> ST{Tenant<br/>active?}
  ST -- no --> N403[403 SUSPENDED / NOT_READY]
  ST -- yes --> P[Lease a pool] --> R2{Role has the<br/>permission?}
  R2 -- no --> F403[403 FORBIDDEN]
  R2 -- yes --> PL{Plan has the<br/>feature?}
  PL -- no --> FNA[403 FEATURE_NOT_AVAILABLE]
  PL -- yes --> DB[(Tenant A database)]
```

Login is checked first, and membership before status: non-members get the same 404 as a tenant that doesn't exist, even if it's suspended, so outsiders can't probe which slugs exist. Each request leases its tenant's pool, so a busy server closing idle pools never cuts off a request mid-way.

**The one rule for tenant code:** handlers touch tenant data only through `tenantDb(req)`. Look at [`src/example/`](src/example) for the pattern to copy. Its queries need no `tenant_id` filter, because the connection is already the right tenant's database. Each route also names what it needs:

```ts
preHandler: [requireAuth, requireTenant, requirePermission('projects:read'), requireFeature('projects:export')]
```

## Layout

```
src/
  app.ts, server.ts, deps.ts   app builder, entry point, dependency wiring
  config/                      env validation (fails fast)
  db/central/                  users, tenants, memberships, invitations, sessions
  db/tenant/                   the schema every tenant database gets
  db/migrator.ts               applies SQL migrations to one database
  db/pool-registry.ts          one connection pool per tenant, LRU-capped
  tenancy/                     slugs, provisioning, request routing, migrate-all
  auth/                        passwords, tokens, auth routes, guard
  tenants/                     create and list tenants
  permissions/                 the role → permission table and its guard
  members/                     members, roles, invitations, the per-tenant lock
  plans/                       plan definitions, feature guard, limits, plan routes
  example/                     a tenant-scoped resource to copy
scripts/                       CLI commands below
test/                          integration tests against real Postgres
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start with reload |
| `npm test` | All tests. Each test file gets its own throwaway databases. Needs `TEST_DATABASE_ADMIN_URL` (put it in a git-ignored `.env.test`, e.g. `TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres`). There is deliberately no default, so tests never create databases on a server you didn't name. |
| `npm run typecheck` / `npm run lint` | Types and lint |
| `npm run migrate:central` | Migrate the central database |
| `npm run migrate:tenants` | Migrate every active, failed or suspended tenant, 4 at a time. Exits 1 if any fail. |
| `npm run tenant:create -- <slug> "<name>" <owner-email>` | Create a tenant from the command line |
| `npm run tenant:retry -- <slug>` | Resume a tenant whose setup failed |
| `npm run db:generate:central` / `db:generate:tenant` | Generate a migration after changing a schema |
| `npm run keys:generate` | Write JWT keys into `.env` (never overwrites existing keys) |
| `npm run dev:seed` | Demo user and tenants. Safe to repeat. |

## Tenants

**Creating a tenant** (`POST /tenants {slug, name}`) does four things, and each step is safe to repeat:

1. Records the tenant as `provisioning`, with the caller as `owner`, in one transaction.
2. Runs `CREATE DATABASE t_<uuid>`. The name comes from the generated id, never from user input.
3. Runs the tenant migrations.
4. Marks it `active`.

If step 2 or 3 fails, the tenant becomes `failed` and the API returns `TENANT_PROVISION_FAILED`. `npm run tenant:retry -- <slug>` picks up from there.

**Limits:** a user can own `MAX_TENANTS_PER_USER` tenants (default 10), and `POST /tenants` allows 10 requests a minute per IP, because each one creates a real database.

**Slugs** are 3 to 40 characters of lowercase letters, numbers and inner hyphens. These are reserved: `www`, `api`, `app`, `admin`, `auth`, `static`, `mail`, `docs`, `status`.

**Migrations** are plain SQL files generated by drizzle-kit. Each database records what it has applied in `__migrations`, with a checksum, so an edited migration is caught. A Postgres advisory lock stops two deploys from migrating the same database at once. Deploy order: `migrate:central`, then `migrate:tenants`, then roll out the app.

## Auth

- **Passwords:** argon2id. A wrong password and an unknown email return the same response, with similar timing.
- **Access token:** an EdDSA (Ed25519) JWT that lasts 15 minutes. It holds the user only, so one login works across all of a user's tenants.
- **Refresh token:** lasts 30 days, in an `HttpOnly; SameSite=Strict` cookie scoped to `/auth`. Only its hash is stored. Every refresh replaces it. If an old, already-rotated token is presented more than 30 seconds after it was rotated, the whole session is revoked. Within those 30 seconds (two tabs, a double click) it's simply refused, and the user stays signed in.
- **Rate limits:** 10 per minute per IP and 5 per minute per email, on signup, login and password-reset requests. Behind a load balancer, set `TRUST_PROXY` to its hop count (e.g. `1`) so the limits see real client IPs. Leave it unset otherwise: trusting `X-Forwarded-For` from anyone lets clients fake their IP.
- **Access tokens can't be revoked early.** After logout or a password reset, an access token already issued keeps working until it expires, at most 15 minutes.
- **Emails:** verification, password-reset and invitation emails go through `mailer/console.ts`, which logs them. Swap in a real provider by implementing `Mailer`.

## Roles and permissions

Every membership has one of three roles. Routes never check roles directly: each one names a permission, and [`src/permissions/permissions.ts`](src/permissions/permissions.ts) says which roles have it.

| Permission | member | admin | owner |
|---|:-:|:-:|:-:|
| `projects:read`, `projects:create` | ✓ | ✓ | ✓ |
| `projects:delete` | | ✓ | ✓ |
| `members:read` | ✓ | ✓ | ✓ |
| `members:invite`, `members:update`, `members:remove` | | ✓ | ✓ |
| `tenant:plan` | | | ✓ |

A missing permission is `403 FORBIDDEN`, with the permission in `details`. To add one, add it to `PERMISSIONS` and to the roles that get it, then put `requirePermission('...')` on the route. A test checks every role against this table.

## Members and invitations

- **Who manages whom:** admins manage members and other admins, but can't touch owners or make anyone an owner. Only an owner can make someone an owner, so a tenant can have several. To hand a tenant over, make the new person an owner and then leave.
- **Never ownerless:** demoting or removing the only owner, or that owner leaving, is `409 LAST_OWNER`. Anyone can leave with `DELETE /members/<their own id>`.
- **Inviting:** `POST /members/invitations { email, role }` emails a single-use link that works for 7 days. The role is `admin` or `member`. The person can already have an account or sign up from the link. Inviting the same email again replaces the old link.
- **Accepting:** `POST /invitations/accept { token }`, signed in as the invited email. Accepting also marks that email as verified.
- **Race-safe:** every change to a tenant's members or invitations runs under one row lock on that tenant, so "last owner" and "last free seat" checks can't race. The caller's role is re-read under that lock, so a just-demoted admin can't act on a stale role.

## Plans

Plans are defined in [`src/plans/plans.ts`](src/plans/plans.ts), and each tenant has one (`free` by default).

| | free | pro | business |
|---|:-:|:-:|:-:|
| Members (including open invitations) | 3 | 20 | unlimited |
| Projects | 10 | 1,000 | unlimited |
| `projects:export` (CSV download) | | ✓ | ✓ |

- **Features:** a route guarded with `requireFeature('projects:export')` returns `403 FEATURE_NOT_AVAILABLE` on plans without it. The `details` include `requiredPlan`, so an app can show the right upgrade button.
- **Limits:** checked when something is added. Going over is `403 PLAN_LIMIT_REACHED` with `{ limit, max, plan }`.
- **Changing plan:** the owner changes it with `PUT /tenant/plan { plan }`. That calls `changePlan()`, which is also the function a billing integration would call after a payment.
- **Downgrading** is always allowed. Nothing is deleted, but nothing more can be added until usage is back under the limits.

## Endpoints

| Method & path | Auth | |
|---|---|---|
| `POST /auth/signup` · `/auth/login` | – | Access token in the body, refresh token in a cookie |
| `POST /auth/refresh` · `/auth/logout` | cookie | Rotate, or end the session |
| `GET /auth/me` | bearer | The current user |
| `POST /auth/verify-email` | – | `{ token }` from the emailed link |
| `POST /auth/password-reset/request` · `/confirm` | – | Reset flow. Confirming ends every session. |
| `POST /tenants` · `GET /tenants` | bearer | Create a tenant · list my tenants and roles |
| `GET` · `POST /api/projects` · `DELETE /api/projects/:id` | bearer + tenant | Example tenant-scoped resource |
| `GET /api/projects/export` | bearer + tenant | CSV download, a plan-gated feature (pro and up) |
| `GET /members` | bearer + tenant | Members and their roles |
| `PATCH /members/:userId` · `DELETE /members/:userId` | bearer + tenant | Change a role · remove a member, or leave |
| `POST` · `GET /members/invitations` · `DELETE /members/invitations/:id` | bearer + tenant | Invite by email · list open invitations · revoke one |
| `POST /invitations/accept` | bearer | `{ token }` from the invitation email |
| `GET` · `PUT /tenant/plan` | bearer + tenant | The plan, its limits and usage · change it (owners) |
| `GET /health` · `/ready` | – | Liveness · readiness (central DB reachable) |
| `GET /docs` | – | Swagger UI, generated from the route schemas |

## Errors

Every error has the same shape:

```json
{ "error": { "code": "TENANT_NOT_FOUND", "message": "Tenant not found", "requestId": "…" } }
```

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Bad input. `details` lists the fields. |
| `UNAUTHENTICATED` | 401 | Missing, invalid or expired token or session |
| `INVALID_CREDENTIALS` | 401 | Wrong email or password |
| `FORBIDDEN` | 403 | Your role doesn't allow this. `details.permission` names what's missing. |
| `LAST_OWNER` | 409 | The tenant would be left without an owner |
| `ALREADY_MEMBER` | 409 | That person is already a member |
| `INVITATION_INVALID` | 400 | Invitation link invalid, expired, used or revoked |
| `INVITATION_EMAIL_MISMATCH` | 403 | Signed in as a different email than the one invited |
| `FEATURE_NOT_AVAILABLE` | 403 | The tenant's plan doesn't include this. `details.requiredPlan` says which does. |
| `PLAN_LIMIT_REACHED` | 403 | The tenant's plan limit is reached |
| `REFRESH_REUSED` | 401 | An old refresh token was replayed. The session was revoked. |
| `TOKEN_INVALID` | 400 | Email link invalid, used or expired |
| `EMAIL_TAKEN` | 409 | An account with this email exists |
| `RATE_LIMITED` | 429 | Too many requests |
| `TENANT_NOT_FOUND` | 404 | No such tenant, or you're not a member |
| `TENANT_NOT_READY` | 403 | Tenant still being set up, or setup failed |
| `TENANT_SUSPENDED` | 403 | Tenant suspended |
| `SLUG_INVALID` / `SLUG_RESERVED` | 400 | Slug rules |
| `SLUG_TAKEN` | 409 | Slug in use |
| `TENANT_PROVISION_FAILED` | 500 | Database setup failed. Retry with `tenant:retry`. |
| `TENANT_LIMIT_REACHED` | 403 | You already own the maximum number of tenants |
| `MIGRATION_CHECKSUM_MISMATCH` | 500 | An applied migration file was edited |
| `NOT_FOUND` | 404 | No such route, or no such member, invitation or project |
| `INTERNAL` | 500/503 | Unexpected error. Details go to the logs only. |

## Sizing connections

Each tenant pool holds up to `TENANT_POOL_MAX` connections (default 5), and up to `TENANT_POOLS_MAX` pools stay open (default 100). The least recently used pool closes when a new one is needed. Keep this under Postgres's `max_connections`, per app instance:

```
instances × (TENANT_POOLS_MAX × TENANT_POOL_MAX + 10 central) < max_connections
```

With the defaults that's 510 connections per instance, more than a default Postgres allows (100). For more than a few instances, lower the numbers or put PgBouncer in front.

## Trade-offs to know

- **No foreign keys across databases.** `projects.created_by` stores a central user id, but Postgres can't enforce it. Treat user ids in tenant data as references to check in code.
- **Per-email rate limits are per instance.** They're kept in memory. With several replicas, move them to Redis. They also mean five bad attempts on someone's email lock that email out for a minute.
- **Suspended tenants are still migrated.** Suspension blocks access, not schema changes, so a reactivated tenant runs on the current schema.
- **Provisioning is synchronous.** Creating a database takes about a second. A job queue is a good next step if that grows.
- **The tenant and membership caches last up to 60 and 30 seconds** on other instances after a change. The instance that makes a change clears its own cache at once. On other instances, a removed or demoted member keeps their old access for up to 30 seconds, and a plan change or suspension takes up to a minute to apply. Decisions about owners and seat limits always read the database under a lock, so they're never affected.
- **Invitations are rate limited per IP, not per tenant.** 20 a minute per IP, because each one sends an email.

## Roadmap

1. **Core tenancy and auth** (done)
2. **Role-based permissions, invitations, and plan-based feature gating** (this release)
3. Google OAuth, and TOTP two-factor
4. Tenant-scoped WebSockets
5. Production Docker image, and CI/CD to AWS ECS

## License

MIT
