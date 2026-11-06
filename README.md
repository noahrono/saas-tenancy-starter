# saas-tenancy-starter

A backend starter for B2B SaaS where **every tenant gets its own PostgreSQL database**. Tenant databases are created automatically, migrated together and routed by subdomain. The rest is in place too: users who belong to many tenants, rotating refresh tokens, and tests that prove one tenant can't see another's data.

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
npm run dev:seed                     # demo@example.test / demo-password-123, tenants tenant-a and tenant-b
npm run dev                          # http://localhost:3000, docs at /docs
```

Then try it:

```bash
TOKEN=$(curl -s localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"demo@example.test","password":"demo-password-123"}' | jq -r .accessToken)

curl -s localhost:3000/tenants -H "authorization: Bearer $TOKEN"
curl -s localhost:3000/api/projects -H "authorization: Bearer $TOKEN" -H 'x-tenant: tenant-a'
curl -s localhost:3000/api/projects -H "authorization: Bearer $TOKEN" -H 'x-tenant: tenant-b'
```

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
  ST -- yes --> P[Lease a pool] --> DB[(Tenant A database)]
```

Login is checked first, and membership before status: non-members get the same 404 as a tenant that doesn't exist, even if it's suspended, so outsiders can't probe which slugs exist. Each request leases its tenant's pool, so a busy server closing idle pools never cuts off a request mid-way.

**The one rule for tenant code:** handlers touch tenant data only through `tenantDb(req)`. Look at [`src/example/`](src/example) for the pattern to copy. Its queries need no `tenant_id` filter, because the connection is already the right tenant's database.

## Layout

```
src/
  app.ts, server.ts, deps.ts   app builder, entry point, dependency wiring
  config/                      env validation (fails fast)
  db/central/                  users, tenants, memberships, sessions
  db/tenant/                   the schema every tenant database gets
  db/migrator.ts               applies SQL migrations to one database
  db/pool-registry.ts          one connection pool per tenant, LRU-capped
  tenancy/                     slugs, provisioning, request routing, migrate-all
  auth/                        passwords, tokens, auth routes, guard
  tenants/                     create and list tenants
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
- **Emails:** verification and password-reset emails go through `mailer/console.ts`, which logs them. Swap in a real provider by implementing `Mailer`.

## Endpoints

| Method & path | Auth | |
|---|---|---|
| `POST /auth/signup` · `/auth/login` | – | Access token in the body, refresh token in a cookie |
| `POST /auth/refresh` · `/auth/logout` | cookie | Rotate, or end the session |
| `GET /auth/me` | bearer | The current user |
| `POST /auth/verify-email` | – | `{ token }` from the emailed link |
| `POST /auth/password-reset/request` · `/confirm` | – | Reset flow. Confirming ends every session. |
| `POST /tenants` · `GET /tenants` | bearer | Create a tenant · list my tenants and roles |
| `GET` · `POST /api/projects` | bearer + tenant | Example tenant-scoped resource |
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
| `NOT_FOUND` | 404 | No such route |
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
- **The tenant and membership caches last up to 60 and 30 seconds** on other instances after a change. Suspending a tenant takes effect within a minute everywhere.

## Roadmap

1. **Core tenancy and auth** (this release)
2. Role-based permissions, and plan-based feature gating
3. Google OAuth, and TOTP two-factor
4. Tenant-scoped WebSockets
5. Production Docker image, and CI/CD to AWS ECS

## License

MIT
