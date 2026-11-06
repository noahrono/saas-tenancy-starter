# Stage 1: Core tenancy and auth — design

Date: 2026-11-06 · Status: draft for review · Repo: `saas-tenancy-starter`

## 1. Purpose

An open-source, backend-only starter for B2B SaaS where **every customer company (tenant) gets its own PostgreSQL database**. It is meant to be cloned by developers starting a SaaS, and to show production-grade tenancy, auth and DevOps practice.

Success for stage 1:
- `docker compose up` gives a running API with Swagger docs. `npm run dev:seed` creates two demo tenants.
- CI runs typecheck, lint and integration tests against real Postgres on every PR, and they pass.
- An automated test proves tenant A's data is never visible from tenant B.
- The README explains the architecture and its trade-offs well enough to trust and build on.

Constraints:
- Written from scratch, with no code or wording from any employer's codebase.
- Examples, seed data and docs use neutral placeholders only (`tenant-a`, `tenant-b`, `example.com`, `example.test`). No real company names.
- Built incrementally through PRs. Every PR keeps CI green.

### Overall roadmap (each stage gets its own design)

| Stage | Scope |
|---|---|
| **1 (this doc)** | DB-per-tenant provisioning, migrations, subdomain routing, password + JWT auth |
| 2 | Role-based permissions, plan → feature gating |
| 3 | Google OAuth, TOTP MFA |
| 4 | Tenant-scoped WebSockets |
| 5 | Docker image, GitHub Actions CD, AWS ECS deploy |

## 2. Decisions

| Topic | Decision | Why |
|---|---|---|
| Scope | Backend API only, with OpenAPI docs | Focus on tenancy, auth and DevOps |
| Framework | Fastify 5 | Typed, fast, schema validation and OpenAPI built in |
| DB access | Drizzle ORM + `postgres.js` | Typed queries, plain SQL migrations that are easy to run per tenant |
| Validation | Zod (env + request bodies), converted to JSON Schema for Fastify | One source of truth for types and docs |
| Users ↔ tenants | Global users, many-to-many memberships with a role per tenant | One login across tenants, like Slack or GitHub orgs |
| Tenancy model | Central DB + one database per tenant on the same Postgres server; each tenant row stores `db_host` + `db_name` | True isolation, easy local setup, a path to move a tenant to its own server later |
| Tests | `node:test` against real Postgres (Docker), no DB mocks | Isolation and migrations must be proven for real |
| Runtime | Node 24 LTS, TypeScript, ESM | Current LTS |

Rejected: schema-per-tenant (weaker isolation, a single `search_path` mistake leaks data, tenants can't be moved alone); server-per-tenant (cost and local-dev pain); Express + Sequelize (dated for a new starter, weaker types); NestJS (heavier, per-request DB switching is harder to keep clean).

## 3. Structure

```
src/
  app.ts                 builds the Fastify app without listening (used by server.ts and tests)
  server.ts              starts the server, handles graceful shutdown
  config/                env parsing with Zod; the process exits on invalid config
  db/
    central/             schema.ts, client.ts, migrations/
    tenant/              schema.ts, migrations/
    migrator.ts          applies a migrations folder to one database (checksums, advisory lock)
    pool-registry.ts     per-tenant connection pools
  tenancy/
    resolve.ts           Host/X-Tenant → tenant → membership → req.tenant, req.tenantDb
    provision.ts         create, resume and retry tenant provisioning
    migrate-all.ts       migrate all tenant DBs with bounded concurrency
    slug.ts              slug validation and reserved list
  auth/
    passwords.ts         argon2id hash and verify
    tokens.ts            access JWT sign/verify, refresh token issue/rotate/revoke
    guard.ts             Fastify preHandler that requires a valid access token
    routes.ts            /auth/*
  tenants/routes.ts      /tenants
  example/               projects: routes.ts, service.ts (the tenant-scoped pattern to copy)
  mailer/console.ts      logs emails instead of sending (stub)
  plugins/               error handler, request IDs, rate limiting, OpenAPI
scripts/                 migrate-central, migrate-tenants, tenant-create, tenant-retry, dev-seed
test/                    integration tests and helpers
```

Rules:
- **Handlers reach tenant data only through `req.tenantDb`.** Only the tenancy layer opens tenant connections.
- **Membership is checked before any tenant data is touched.**
- Feature folders talk to each other only through exported functions, never through each other's tables.

## 4. Data model

### Central database

**users**: `id uuid pk`, `email text unique` (stored lowercased), `password_hash text`, `email_verified_at timestamptz null`, `created_at timestamptz`.

**tenants**: `id uuid pk`, `slug text unique`, `name text`, `status text` (`provisioning` | `active` | `suspended` | `failed`), `status_error text null`, `db_host text`, `db_name text unique`, `created_at`, `updated_at`.

**memberships**: `user_id → users`, `tenant_id → tenants`, `role text` (`owner` | `admin` | `member`), `created_at`; primary key `(user_id, tenant_id)`.

**refresh_tokens**: `id uuid pk`, `user_id → users`, `family_id uuid`, `token_hash text unique` (SHA-256), `expires_at`, `revoked_at null`, `replaced_by uuid null`, `created_at`.

**email_tokens**: `id uuid pk`, `user_id → users`, `purpose text` (`verify_email` | `reset_password`), `token_hash text unique` (SHA-256), `expires_at`, `used_at null`, `created_at`.

Notes:
- Roles are stored now. Stage 1 enforces only owner (in tests) and member. Full permissions come in stage 2.
- No per-tenant DB credentials are stored. The app uses one service role from env (`DATABASE_URL` for central, `TENANT_DB_USER` / `TENANT_DB_PASSWORD` for tenants). `db_host` and `db_name` record where a tenant lives.

### Tenant database (identical in every tenant)

**__migrations**: `id text pk` (file name), `checksum text`, `applied_at`.

**projects** (example resource): `id uuid pk`, `name text`, `created_by uuid` (a user id from central, not a foreign key), `created_at`.

There are no foreign keys across databases. Postgres can't enforce one across two databases. The README explains this trade-off.

### Naming and safety

- Slug: `^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$` (3–40 characters, no leading or trailing hyphen). Reserved: `www`, `api`, `app`, `admin`, `auth`, `static`, `mail`, `docs`, `status`.
- `db_name` = `t_` + the tenant uuid without hyphens. It is generated, never built from what the user typed, and quoted as an identifier in `CREATE DATABASE`.

## 5. Request flow

For a tenant route, e.g. `GET https://tenant-a.example.com/api/projects`:

1. **Resolve the tenant.** Take the slug from the first label of `Host` under `BASE_DOMAIN`. If `TENANT_HEADER=true`, the `X-Tenant` header takes precedence (local dev and tests). Look the slug up in central, with an LRU cache of 60 s TTL that is cleared when a tenant's status changes in this process.
   - Unknown slug → `404 TENANT_NOT_FOUND`.
   - `provisioning` or `failed` → `403 TENANT_NOT_READY`. `suspended` → `403 TENANT_SUSPENDED`.
2. **Authenticate.** A valid `Authorization: Bearer` access token is required, otherwise `401 UNAUTHENTICATED`.
3. **Check membership.** Cached for 30 s. A non-member gets `404 TENANT_NOT_FOUND`, which avoids leaking that the tenant exists.
4. **Attach** `req.tenant`, `req.membership` and `req.tenantDb` (a Drizzle instance on the tenant's pool), then run the handler.

Non-tenant routes (`/auth/*`, `/tenants`, `/health`, `/ready`, `/docs`) run on the bare `BASE_DOMAIN` or `api.` subdomain and skip steps 1, 3 and 4.

## 6. Auth

- **Passwords:** argon2id (`@node-rs/argon2`) at OWASP-recommended parameters. Minimum length 10, maximum 128. Failed logins answer `401 INVALID_CREDENTIALS` whether or not the email exists, and run a dummy hash for unknown emails to keep timing similar.
- **Access token:** a JWT signed with EdDSA (Ed25519 via `jose`), lasting 15 minutes. Claims: `sub` (user id), `iat`, `exp`, `jti`. No tenant claim, so one token works across all of a user's tenants.
- **Refresh token:** 32 random bytes as base64url, lasting 30 days. It is sent as cookie `rt` (`HttpOnly; Secure; SameSite=Strict; Path=/auth`). Only its SHA-256 is stored.
  - **Rotation:** each `/auth/refresh` revokes the presented token, issues a new one in the same `family_id` and sets `replaced_by`.
  - **Reuse detection:** if a revoked token is presented, every token in its family is revoked and the answer is `401 REFRESH_REUSED`.
  - **Logout** revokes the current family.
- **Rate limits** (`@fastify/rate-limit`): login and signup at 10 per minute per IP and 5 per minute per email. Over the limit, the answer is `429 RATE_LIMITED`.
- **Email verification and password reset** are stubbed: tokens are created and the link is logged by `mailer/console.ts`. Verification is not required to log in during stage 1.

## 7. Endpoints (stage 1)

| Method & path | Auth | Description |
|---|---|---|
| `POST /auth/signup` | – | `{ email, password }` → `201` user; sets the refresh cookie and returns an access token |
| `POST /auth/login` | – | `{ email, password }` → access token + refresh cookie |
| `POST /auth/refresh` | cookie | Rotates the refresh token → new access token |
| `POST /auth/logout` | cookie | Revokes the family → `204` |
| `GET /auth/me` | bearer | The current user |
| `POST /auth/verify-email` | – | `{ token }` → `204`, marks the email verified |
| `POST /auth/password-reset/request` | – | `{ email }` → always `204`; mails a reset link if the email exists |
| `POST /auth/password-reset/confirm` | – | `{ token, password }` → `204`, sets the password and revokes all sessions |
| `POST /tenants` | bearer | `{ slug, name }` → provisions the tenant; the caller becomes owner → `201` |
| `GET /tenants` | bearer | My tenants with my role in each |
| `GET /api/projects` | bearer + tenant | List this tenant's projects |
| `POST /api/projects` | bearer + tenant | `{ name }` → `201` |
| `GET /health` | – | Liveness: process is up |
| `GET /ready` | – | Readiness: central DB reachable |
| `GET /docs` | – | Swagger UI and OpenAPI JSON |

## 8. Provisioning

`provisionTenant({ slug, name, ownerUserId })`, used by `POST /tenants` and `npm run tenant:create`:

1. In one central transaction, insert `tenants` (status `provisioning`, generated `db_name`, `db_host` = `TENANT_DB_HOST`) and an `owner` membership. A unique-slug violation → `409 SLUG_TAKEN`.
2. `CREATE DATABASE`. An "already exists" error is treated as success.
3. Run tenant migrations on the new database.
4. Set status `active`.

If step 2 or 3 fails, the status becomes `failed` with `status_error`, and the API answers `500 TENANT_PROVISION_FAILED` with the slug. `npm run tenant:retry <slug>` resumes from step 2. Every step is idempotent. Provisioning is synchronous in stage 1. A background job queue is a documented future improvement and is not built.

## 9. Migrations

- SQL files are generated by drizzle-kit into `src/db/central/migrations` and `src/db/tenant/migrations`. They are applied by our own `migrator.ts`, not drizzle-kit's runner, so the same code handles central and every tenant.
- **migrator.ts** for one database: take `pg_advisory_lock` (a fixed key) → read `__migrations` → for each file not yet applied, run it in a transaction and insert its id + checksum → release the lock. A checksum mismatch on an applied file → stop with `MIGRATION_CHECKSUM_MISMATCH`.
- `npm run migrate:central` migrates the central DB.
- `npm run migrate:tenants` migrates every tenant with status `active`, `failed` or `suspended` (suspension blocks access, not schema changes; amended after review), `MIGRATE_CONCURRENCY` (default 4) at a time. It prints a summary (migrated / up to date / failed with errors) and exits `1` if any failed. A tenant that was `failed` and now succeeds becomes `active`.

## 10. Connection pools

`PoolRegistry.get(tenant)` returns a Drizzle instance for the tenant:
- One `postgres.js` client per tenant, with `max` = `TENANT_POOL_MAX` (default 5) and `idle_timeout`.
- An LRU of at most `TENANT_POOLS_MAX` (default 100) clients. On eviction, the client is ended after its in-flight queries finish.
- Concurrent `get` calls for the same tenant share one creation promise.
- `closeAll()` runs on `SIGTERM` / `SIGINT` after Fastify stops accepting requests.
- The README documents the sizing rule: `TENANT_POOLS_MAX × TENANT_POOL_MAX + central pool < max_connections`.

## 11. Errors and logging

- Every error response looks like `{ "error": { "code": "...", "message": "...", "requestId": "...", "details"?: [...] } }`.
- Validation errors return `400 VALIDATION_FAILED` with field details. Unknown errors return `500 INTERNAL` with a generic message; the detail goes only to logs.
- Error codes are documented in the README: `VALIDATION_FAILED`, `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `EMAIL_TAKEN`, `REFRESH_REUSED`, `RATE_LIMITED`, `TENANT_NOT_FOUND`, `TENANT_NOT_READY`, `TENANT_SUSPENDED`, `SLUG_INVALID`, `SLUG_RESERVED`, `SLUG_TAKEN`, `TENANT_PROVISION_FAILED`, `TOKEN_INVALID`, `NOT_FOUND`, `MIGRATION_CHECKSUM_MISMATCH`, `INTERNAL`.
- Logging uses pino JSON logs with `requestId`, `tenantId` and `userId`. `authorization`, `cookie`, `password` and `token` fields are redacted.

## 12. Testing

- `node:test` with the TypeScript test files run directly by Node 24.
- A helper creates a uniquely named central database per test file, runs central migrations, builds the app with `TENANT_HEADER=true`, and drops the central DB plus any tenant DBs it created afterwards.
- Required scenarios:
  1. Signup, login, `me`, refresh and logout. A duplicate email returns `EMAIL_TAKEN`. A wrong password and an unknown email give identical responses.
  2. Refresh rotation; reusing an old refresh token revokes the family (`REFRESH_REUSED`) and the newest token stops working.
  3. `POST /tenants` → tenant `active`, its DB exists and is migrated, and the creator is owner.
  4. Provisioning fails after `CREATE DATABASE` (injected fault) → `failed`; then `retry` → `active`.
  5. Slug rules: invalid, reserved and taken slugs.
  6. **Isolation:** a user in both A and B creates a project in A; listing from B returns none, and listing from A returns it.
  7. A non-member gets `404` on a tenant. Suspended and provisioning tenants are blocked.
  8. `migrate:tenants` over three tenants with a new migration: all are migrated. A tenant with a deliberately broken DB is reported as failed, and the exit code is 1.
  9. The pool registry evicts beyond its limit, concurrent gets share one client, and `closeAll` ends everything.
- CI (GitHub Actions): Node 24, a Postgres 17 service container, then `npm ci`, typecheck, lint (ESLint + typescript-eslint) and tests, on every push and PR.

## 13. Developer setup

- `docker-compose.yml` runs Postgres 17 and the API (`tsx watch`), both configured with env from `.env`.
- `.env.example` documents every variable: `DATABASE_URL`, `TENANT_DB_HOST`, `TENANT_DB_USER`, `TENANT_DB_PASSWORD`, `BASE_DOMAIN`, `TENANT_HEADER`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `TENANT_POOLS_MAX`, `TENANT_POOL_MAX`, `MIGRATE_CONCURRENCY`, `PORT`, `LOG_LEVEL`.
- `npm run keys:generate` writes an Ed25519 key pair for local use.
- `npm run dev:seed` creates `demo@example.test` with tenants `tenant-a` and `tenant-b`, plus one project each.

## 14. Out of scope for stage 1

Role-based permissions and plans, OAuth, MFA, WebSockets, the production Docker image and ECS deploy, background jobs, real email sending, billing, a frontend, and moving tenants between servers (the data model allows it; no tooling yet).
