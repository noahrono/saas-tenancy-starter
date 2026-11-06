# Stage 1: Core Tenancy and Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A backend API in which each tenant gets its own Postgres database: provisioned automatically, migrated with the rest, routed by subdomain, behind password + JWT auth, and proven isolated by tests.

**Architecture:** Fastify app built by `buildApp(deps)` so the server and the tests share it. A central DB holds users, tenants, memberships and refresh tokens. Each tenant DB is created on the same Postgres server and reached only through a request-scoped `req.tenantDb` that a pool registry provides. One home-made migrator applies plain SQL migrations to the central DB and to every tenant DB.

**Tech Stack:** Node 24, TypeScript (ESM), Fastify 5, `fastify-type-provider-zod`, Zod, Drizzle ORM + `postgres` (postgres.js), drizzle-kit, `@node-rs/argon2`, `jose`, `lru-cache`, `@fastify/cookie`, `@fastify/rate-limit`, `@fastify/swagger`, `@fastify/swagger-ui`, `tsx`, ESLint + typescript-eslint, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-06-stage-1-core-tenancy-design.md`

## Global Constraints

- Node `>=24`. `"type": "module"`. Tests run with `node --test "test/**/*.test.ts"` (no build step). Use only erasable TypeScript syntax: no enums, no parameter properties, no namespaces.
- Relative imports use the `.ts` extension. tsconfig sets `allowImportingTsExtensions` and `rewriteRelativeImportExtensions`.
- Placeholders only: tenants `tenant-a` / `tenant-b`, emails `@example.test`, domains `example.com` / `localhost`. No real company names anywhere.
- Every error response is `{ "error": { "code", "message", "requestId", "details"? } }`, using only the codes listed in spec §11.
- Handlers never open tenant connections. Only `src/tenancy/` and `src/db/pool-registry.ts` do.
- Commits happen only with the user's go-ahead, authored as the user, with no `Co-Authored-By` line. Each PR below must leave typecheck, lint and tests green.
- Defaults are fixed by the spec: access token 15 min, refresh 30 days, tenant cache 60 s, membership cache 30 s, `TENANT_POOLS_MAX=100`, `TENANT_POOL_MAX=5`, `MIGRATE_CONCURRENCY=4`, rate limit 10/min/IP and 5/min/email, password length 10–128.

## Review Focus

1. **Host header with a port or mixed case** (`Tenant-A.localhost:3000`) should resolve to `tenant-a`. The test goes in Task 11.
2. **Two simultaneous `POST /tenants` with the same slug**: exactly one wins, and the other gets `409 SLUG_TAKEN` with no orphan database. The test goes in Task 10.
3. **Email case and whitespace** (`" Demo@Example.test "`) is the same account for signup and login. The test goes in Task 7.
4. **Concurrent `/auth/refresh` with the same token** (a double-click): at most one succeeds and the family isn't silently forked. The test goes in Task 6.
5. **A tenant's DB is dropped behind the app's back**: requests get `500 INTERNAL`, other tenants keep working, and the evicted pool doesn't crash the process. The test goes in Task 11.

## File Map

```
package.json, tsconfig.json, eslint.config.js, drizzle.central.config.ts, drizzle.tenant.config.ts
docker-compose.yml, .env.example, .github/workflows/ci.yml, README.md
src/config/index.ts            loadConfig()
src/errors.ts                  AppError + ErrorCode
src/app.ts                     buildApp()
src/server.ts                  start + graceful shutdown
src/plugins/errors.ts          error handler + not-found handler
src/plugins/docs.ts            swagger + swagger-ui
src/db/migrator.ts             migrate()
src/db/central/{schema,client}.ts + migrations/
src/db/tenant/schema.ts + migrations/
src/db/pool-registry.ts        PoolRegistry
src/auth/{passwords,tokens,guard,routes}.ts
src/mailer/console.ts
src/tenancy/{slug,provision,resolve,migrate-all}.ts
src/tenants/routes.ts
src/example/{routes,service}.ts
scripts/{migrate-central,migrate-tenants,tenant-create,tenant-retry,dev-seed,keys-generate}.ts
test/helpers/context.ts        createTestContext()
test/*.test.ts
```

---

## PR 1: Scaffold, config, app shell, CI

### Task 1: Project scaffold and config

**Files:**
- Create: `package.json`, `tsconfig.json`, `eslint.config.js`, `.gitignore`, `.nvmrc` (`24`), `LICENSE` (MIT, Kipkoech Noah, 2026), `.env.example`, `src/config/index.ts`, `src/errors.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces:
  - `interface Config { port: number; logLevel: string; databaseUrl: string; tenantDb: { host: string; port: number; user: string; password: string }; baseDomain: string; tenantHeader: boolean; jwt: { privateKeyPem: string; publicKeyPem: string }; tenantPoolsMax: number; tenantPoolMax: number; migrateConcurrency: number; cookieSecure: boolean }`
  - `loadConfig(env: Record<string, string | undefined>): Config`, which throws `Error` listing every invalid variable.
  - `type ErrorCode` = the union of the spec §11 codes. `class AppError extends Error { code: ErrorCode; statusCode: number; details?: unknown }` with constructor `(code, statusCode, message, details?)`.
- Scripts: `dev` (`tsx watch src/server.ts`), `start`, `test`, `typecheck` (`tsc --noEmit`), `lint` (`eslint .`), `db:generate:central`, `db:generate:tenant`, `migrate:central`, `migrate:tenants`, `tenant:create`, `tenant:retry`, `dev:seed`, `keys:generate`. Scripts run `.ts` files with `node` directly.

- [ ] **Step 1: Write failing tests** `loads defaults` (minimal env → `port === 3000`, `tenantPoolsMax === 100`, `tenantPoolMax === 5`, `migrateConcurrency === 4`, `tenantHeader === false`), `parses booleans and numbers` (`TENANT_HEADER=true`, `PORT=8080`), and `rejects missing and invalid vars` (no `DATABASE_URL` and `PORT=abc` → the thrown message contains both `DATABASE_URL` and `PORT`). JWT keys may be given PEM-inline with `\n` escapes, and are unescaped.
- [ ] **Step 2: Run** `npm test` and expect FAIL (the module isn't found).
- [ ] **Step 3: Implement** `loadConfig` with one Zod object over the env. `tenantDb.host` defaults to the host of `DATABASE_URL`, and `cookieSecure` defaults to `NODE_ENV === 'production'`. Write `.env.example` with every variable from spec §13, using local-dev values (`postgres://postgres:postgres@localhost:5432/central`, `BASE_DOMAIN=localhost`, `TENANT_HEADER=true`).
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and expect PASS.
- [ ] **Step 5: Commit** `chore: scaffold project with typed env config`

### Task 2: App shell, errors, health, docs

**Files:**
- Create: `src/app.ts`, `src/server.ts`, `src/plugins/errors.ts`, `src/plugins/docs.ts`
- Test: `test/app.test.ts`

**Interfaces:**
- Consumes: `Config`, `AppError`.
- Produces: `interface AppDeps { config: Config; central: CentralDb; pools: PoolRegistry; mailer: Mailer; tokens: TokenService }` (fields added by later tasks; in this task only `config` is required and the rest are optional). `buildApp(deps: AppDeps): Promise<FastifyInstance>`. Every request gets a `requestId` (`crypto.randomUUID()`, also returned in the `x-request-id` header). Logger redacts `req.headers.authorization`, `req.headers.cookie`, `*.password` and `*.token`.

- [ ] **Step 1: Write failing tests** using `app.inject`:
  - `GET /health → 200 { status: 'ok' }`
  - an unknown route → `404`, with body `error.code === 'NOT_FOUND'`. Add `NOT_FOUND` to `ErrorCode` and to spec §11's list in the README.
  - a test route throwing `new AppError('VALIDATION_FAILED', 400, 'x', [{ path: 'a' }])` → that status, code and details, plus a `requestId` matching the `x-request-id` header
  - a route throwing a plain `Error('secret detail')` → `500 INTERNAL`, and the body does not contain `secret detail`
  - Zod schema failure on a route → `400 VALIDATION_FAILED` with `details` per field
  - `GET /docs/json → 200` with `openapi` starting `3.`
- [ ] **Step 2: Run and expect FAIL.**
- [ ] **Step 3: Implement** `buildApp` using the Zod type provider (`validatorCompiler`, `serializerCompiler`). Register the error plugin and the docs plugin (at `/docs`). `server.ts` loads config, builds deps and listens. On `SIGTERM` / `SIGINT` it runs `app.close()`, then `pools.closeAll()` and `central.end()`.
- [ ] **Step 4: Run and expect PASS.**
- [ ] **Step 5: Commit** `feat: add app shell with error envelope, health and OpenAPI docs`

### Task 3: Docker Compose and CI

**Files:**
- Create: `docker-compose.yml`, `.github/workflows/ci.yml`, `test/helpers/context.ts`
- Test: (exercised by the CI run)

**Interfaces:**
- Produces (`test/helpers/context.ts`): `createTestContext(opts?: { withApp?: boolean }): Promise<TestContext>` where `TestContext = { config: Config; centralUrl: string; adminSql: postgres.Sql; app?: FastifyInstance; deps?: AppDeps; cleanup(): Promise<void> }`. It reads `TEST_DATABASE_ADMIN_URL` (default `postgres://postgres:postgres@localhost:5432/postgres`), creates `test_<8 random hex>`, and builds a config pointing at it with `TENANT_HEADER=true` and freshly generated Ed25519 keys. `cleanup()` drops every database whose name is in that DB's `tenants.db_name` (if the table exists), then drops the test DB. Task 5 adds central migrations and Task 7 adds the full app deps.

- [ ] **Step 1:** `docker-compose.yml` defines `postgres:17` (user/password `postgres`, port 5432, healthcheck `pg_isready`, volume `pgdata`) and `api` (node:24, `npm run dev`, depends on a healthy Postgres, `env_file: .env`, port 3000).
- [ ] **Step 2:** `ci.yml` runs on push and pull_request, on ubuntu-latest, with Node 24 and a `postgres:17` service on 5432 with a health check. It runs `npm ci`, `npm run typecheck`, `npm run lint`, then `npm test` with `TEST_DATABASE_ADMIN_URL` set.
- [ ] **Step 3:** Add a test `context creates and drops its database`: after `cleanup()`, `pg_database` has no row with that name.
- [ ] **Step 4: Run** `docker compose up -d postgres && npm test` and expect PASS.
- [ ] **Step 5: Commit** `ci: add docker compose and GitHub Actions with Postgres 17`

---

## PR 2: Migrator and central database

### Task 4: Migrator

**Files:**
- Create: `src/db/migrator.ts`
- Test: `test/migrator.test.ts`, fixtures in `test/fixtures/migrations-{ok,more,broken}/`

**Interfaces:**
- Produces: `migrate(sql: postgres.Sql, dir: string): Promise<{ applied: string[] }>`. Migration files are `*.sql` sorted by name. It creates `__migrations (id text primary key, checksum text not null, applied_at timestamptz not null default now())` if missing. It holds `pg_advisory_lock(727274)` for the whole run. Each file runs in its own transaction along with its `__migrations` insert. On a checksum mismatch it throws `AppError('MIGRATION_CHECKSUM_MISMATCH', 500, ...)` naming the file; add that code to `ErrorCode`. drizzle-kit `--> statement-breakpoint` markers are split and run in order.

- [ ] **Step 1: Write failing tests:**
  - `applies pending files in order` (`applied` deep-equals the file names)
  - `is a no-op when up to date` (`applied` is `[]`)
  - `applies only new files` (copy `ok` + `more` into a temp dir)
  - `rolls back a failing file and keeps earlier ones` (the `broken` fixture's second file has bad SQL; the first stays recorded and the second is absent)
  - `detects an edited migration` (edit an applied file → rejects with code `MIGRATION_CHECKSUM_MISMATCH`)
  - `serialises concurrent runs` (two parallel `migrate` calls on the same DB → the total of all `applied` arrays equals the file count, with no duplicate-key error)
- [ ] **Step 2: Run and expect FAIL.**
- [ ] **Step 3: Implement** `migrate`. The checksum is the SHA-256 hex of the file content with CRLF normalised to LF.
- [ ] **Step 4: Run and expect PASS.**
- [ ] **Step 5: Commit** `feat: add SQL migrator with checksums and advisory lock`

### Task 5: Central schema, client and readiness

**Files:**
- Create: `src/db/central/schema.ts`, `src/db/central/client.ts`, `src/db/central/migrations/0000_*.sql` (generated), `drizzle.central.config.ts`, `scripts/migrate-central.ts`
- Modify: `src/app.ts` (adds `/ready`), `test/helpers/context.ts` (runs central migrations)
- Test: `test/central.test.ts`

**Interfaces:**
- Produces:
  - Drizzle tables `users`, `tenants`, `memberships`, `refreshTokens`, `emailTokens` exactly as in spec §4. Status and role are `text` with a check constraint. Primary keys use `defaultRandom()` uuids.
  - `type CentralDb = { sql: postgres.Sql; db: PostgresJsDatabase<typeof schema>; end(): Promise<void> }`
  - `createCentralDb(url: string): CentralDb`
  - `CENTRAL_MIGRATIONS_DIR` (an absolute path from `import.meta.dirname`)
- [ ] **Step 1: Write failing tests:**
  - after the context migrates, `tenants`, `memberships`, `refresh_tokens` and `users` exist
  - `users.email` is unique
  - `memberships` rejects a duplicate `(user_id, tenant_id)`
  - `tenants.status` rejects `'deleted'`
  - `GET /ready → 200` while the DB is up, and `503` with code `INTERNAL` after `central.end()`
- [ ] **Step 2: Run and expect FAIL.**
- [ ] **Step 3: Implement** the schema, then run `npm run db:generate:central` to write the SQL. The client and script call `migrate(sql, CENTRAL_MIGRATIONS_DIR)`.
- [ ] **Step 4: Run and expect PASS.**
- [ ] **Step 5: Commit** `feat: add central database schema, migrations and readiness check`

---

## PR 3: Auth

### Task 6: Passwords and tokens

**Files:**
- Create: `src/auth/passwords.ts`, `src/auth/tokens.ts`
- Test: `test/passwords.test.ts`, `test/tokens.test.ts`

**Interfaces:**
- Produces:
  - `hashPassword(plain: string): Promise<string>` and `verifyPassword(hash: string, plain: string): Promise<boolean>`, both argon2id with `memoryCost: 19456, timeCost: 2, parallelism: 1`. Also `verifyAgainstDummy(plain): Promise<false>` for unknown emails.
  - `createTokenService(opts: { privateKeyPem: string; publicKeyPem: string; central: CentralDb; now?: () => Date }): TokenService`
  - `TokenService` has:
    - `signAccess(userId): Promise<string>`, using EdDSA, 15 min, with `sub` and `jti`
    - `verifyAccess(token): Promise<{ userId: string }>`, which throws `AppError('UNAUTHENTICATED', 401)`
    - `issueRefresh(userId, familyId?): Promise<{ token: string; expiresAt: Date }>`
    - `rotateRefresh(token): Promise<{ userId: string; token: string; expiresAt: Date }>`
    - `revokeFamily(token): Promise<void>`
  - Refresh tokens are 32 random bytes as base64url, stored as a SHA-256 hex. Rotation runs in one transaction using `SELECT … FOR UPDATE` on the token row.
- [ ] **Step 1: Write failing tests:**
  - hash then verify is true; the wrong password is false; the hash starts with `$argon2id$`
  - an access token verifies; a token signed with another key → `UNAUTHENTICATED`; with `now` set 16 min ahead → `UNAUTHENTICATED`
  - `rotateRefresh` returns a new token and the old one is revoked with `replaced_by` set
  - reusing the old token → `REFRESH_REUSED`, after which the new token also fails (`UNAUTHENTICATED`)
  - an expired refresh token (`now` 31 days ahead) → `UNAUTHENTICATED`
  - **Review Focus 4:** two parallel `rotateRefresh(sameToken)` → exactly one resolves and the other rejects (`REFRESH_REUSED`); the family has exactly one unrevoked token, or none
- [ ] **Step 2: Run and expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and expect PASS.**
- [ ] **Step 5: Commit** `feat: add argon2id passwords and rotating refresh tokens`

### Task 7: Auth routes, guard, rate limits and mailer stub

**Files:**
- Create: `src/auth/guard.ts`, `src/auth/routes.ts`, `src/mailer/console.ts`
- Modify: `src/app.ts`, `test/helpers/context.ts` (full deps when `withApp`)
- Test: `test/auth.test.ts`

**Interfaces:**
- Consumes: `TokenService`, `hashPassword` / `verifyPassword`, `CentralDb`.
- Produces:
  - `interface Mailer { send(msg: { to: string; subject: string; text: string }): Promise<void> }` and `consoleMailer(log)`
  - The `requireAuth` preHandler sets `req.user = { id: string; email: string }`
  - Routes exactly as in spec §7 for `/auth/*`. The refresh cookie is named `rt`, with `HttpOnly`, `SameSite=Strict`, `Path=/auth`, `Secure` only when `config.cookieSecure`, and `Max-Age` of 30 days.
  - `POST /auth/signup` also creates an `email_tokens` row (purpose `verify_email`, 24 h) and sends the link through the mailer. Login doesn't require verification.
  - `POST /auth/verify-email { token }` → `204`, sets `email_verified_at`.
  - `POST /auth/password-reset/request { email }` → always `204`. For a known email it creates a `reset_password` token (1 h) and mails the link.
  - `POST /auth/password-reset/confirm { token, password }` → `204`. It sets the new hash, marks the token used and revokes every refresh token for the user. A bad, used or expired token → `400 TOKEN_INVALID`.
  - Email tokens are 32 random bytes as base64url, stored as a SHA-256 hex, and single use.
- [ ] **Step 1: Write failing tests:**
  - signup returns `201` with `accessToken` and sets the `rt` cookie; a duplicate email → `409 EMAIL_TAKEN`
  - login with a wrong password and login with an unknown email give identical status and body (`401 INVALID_CREDENTIALS`)
  - `GET /auth/me` with a bearer token → the user; without one → `401 UNAUTHENTICATED`
  - refresh with the cookie → a new access token and a new cookie; logout → `204`, after which refresh → `401`
  - the 6th login for the same email within a minute → `429 RATE_LIMITED`
  - a password of 9 characters → `400 VALIDATION_FAILED`
  - signup calls `mailer.send` once with the user's email (use a recording mailer); posting the token from the mailed link to `/auth/verify-email` → `204`, and reusing it → `400 TOKEN_INVALID`
  - password reset: request for an unknown email → `204` with no mail sent; for a known one → mail sent; confirm → `204`, the old password fails, the new one works, the old refresh cookie → `401`; reusing the token → `400 TOKEN_INVALID`
  - **Review Focus 3:** signup with `" Demo@Example.test "`, then login with `demo@example.test`, succeeds; a second signup with `DEMO@example.test` → `EMAIL_TAKEN`
- [ ] **Step 2: Run and expect FAIL.**
- [ ] **Step 3: Implement.** Emails are trimmed and lowercased in the Zod schema. Rate limits use `@fastify/rate-limit` with `keyGenerator` per IP, plus a second per-email limiter on the login and signup routes.
- [ ] **Step 4: Run and expect PASS.**
- [ ] **Step 5: Commit** `feat: add signup, login, refresh, logout and me endpoints`

---

## PR 4: Tenancy

### Task 8: Slugs and tenant schema

**Files:**
- Create: `src/tenancy/slug.ts`, `src/db/tenant/schema.ts`, `src/db/tenant/migrations/0000_*.sql` (generated), `drizzle.tenant.config.ts`
- Test: `test/slug.test.ts`

**Interfaces:**
- Produces:
  - `RESERVED_SLUGS: ReadonlySet<string>`, exactly the spec §4 list
  - `validateSlug(input: string): string`, which returns the slug or throws `AppError('SLUG_INVALID' | 'SLUG_RESERVED', 400)`, using the regex in spec §4
  - `tenantDbName(tenantId: string): string`, returning `t_` + the uuid without hyphens
  - Tenant table `projects` per spec §4, and `TENANT_MIGRATIONS_DIR`
- [ ] **Step 1: Write failing tests:**
  - `tenant-a` and `abc` are valid
  - `ab`, `-abc`, `abc-`, `Tenant-A`, `a_b` and a 41-character slug → `SLUG_INVALID`
  - every reserved slug → `SLUG_RESERVED`
  - `tenantDbName('0f8fad5b-d9cb-469f-a165-70867728950e') === 't_0f8fad5bd9cb469fa16570867728950e'`
- [ ] **Step 2–4:** Run → FAIL → implement (generate the tenant SQL) → PASS.
- [ ] **Step 5: Commit** `feat: add slug rules and tenant database schema`

### Task 9: Pool registry

**Files:**
- Create: `src/db/pool-registry.ts`
- Test: `test/pool-registry.test.ts`

**Interfaces:**
- Produces: `type TenantDb = PostgresJsDatabase<typeof tenantSchema>` and `class PoolRegistry` with:
  - `constructor(opts: { host?: string; port: number; user: string; password: string; maxPools: number; poolMax: number; idleTimeoutSec?: number /* default 300 */; createClient?: (url: string, poolMax: number) => postgres.Sql })`
  - `get(t: { id: string; dbHost: string; dbName: string }): Promise<TenantDb>`
  - `evict(tenantId: string): Promise<void>`
  - `closeAll(): Promise<void>`
  - `readonly size: number`
- Built on `lru-cache` with `max: maxPools` and a `dispose` that calls `sql.end({ timeout: 5 })` without awaiting in the request path.
- [ ] **Step 1: Write failing tests** with a counting `createClient` against real tenant DBs made by `CREATE DATABASE`:
  - two `get` calls for the same tenant → one client
  - 10 concurrent `get` calls → one client
  - `maxPools: 2` with three tenants → `size === 2`, and the first client's `end` was called
  - `closeAll()` → every client ended and `size === 0`
  - the returned db can `select 1`
- [ ] **Step 2–4:** Run → FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat: add LRU tenant connection pool registry`

### Task 10: Provisioning, tenant routes and CLI

**Files:**
- Create: `src/tenancy/provision.ts`, `src/tenants/routes.ts`, `scripts/tenant-create.ts`, `scripts/tenant-retry.ts`
- Modify: `src/app.ts`
- Test: `test/provision.test.ts`, `test/tenants.test.ts`

**Interfaces:**
- Consumes: `CentralDb`, `migrate`, `TENANT_MIGRATIONS_DIR`, `validateSlug`, `tenantDbName`, `Config.tenantDb`.
- Produces:
  - `type Tenant = { id; slug; name; status: 'provisioning' | 'active' | 'suspended' | 'failed'; statusError: string | null; dbHost; dbName }`
  - `provisionTenant(ctx: { central: CentralDb; config: Config }, input: { slug: string; name: string; ownerUserId: string }, hooks?: { afterCreateDatabase?: () => Promise<void> }): Promise<Tenant>`
  - `retryProvision(ctx, slug: string): Promise<Tenant>`
  - Steps exactly as in spec §8. `CREATE DATABASE` runs on an admin connection to the server's `postgres` database (built from `config.tenantDb`), with the name quoted via `sql(dbName)`. Error code `42P04` (already exists) counts as success.
  - Routes `POST /tenants` → `201 { tenant, role: 'owner' }` and `GET /tenants` → `[{ tenant, role }]`, both behind `requireAuth`.
- [ ] **Step 1: Write failing tests:**
  - `POST /tenants {slug:'tenant-a'}` → `201`, status `active`, the database exists and `projects` exists in it, and the membership role is `owner`
  - `GET /tenants` lists it with the role
  - a reserved slug → `400 SLUG_RESERVED`; a taken slug → `409 SLUG_TAKEN`
  - `afterCreateDatabase` throws → `failed` with `statusError` set; `retryProvision` → `active` and migrated
  - `retryProvision` on an `active` tenant → returns it unchanged
  - **Review Focus 2:** two parallel `provisionTenant` calls with the same slug → one fulfilled and one rejected `SLUG_TAKEN`; `pg_database` holds exactly one `t_*` database for that tenant
- [ ] **Step 2–4:** Run → FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat: provision tenant databases with resumable steps`

### Task 11: Tenant resolution and the example resource

**Files:**
- Create: `src/tenancy/resolve.ts`, `src/example/service.ts`, `src/example/routes.ts`
- Modify: `src/app.ts`
- Test: `test/resolve.test.ts`, `test/isolation.test.ts`

**Interfaces:**
- Consumes: `PoolRegistry`, `requireAuth`, `CentralDb`, `Config.baseDomain` / `tenantHeader`.
- Produces:
  - `tenantSlugFromRequest(host: string | undefined, header: string | undefined, cfg: { baseDomain: string; tenantHeader: boolean }): string | null`. It lowercases and strips the port, returns the first label when the host ends with `.${baseDomain}`, and returns `null` for the bare domain, `api.`, or anything else. When `tenantHeader` is on, the header wins.
  - A `requireTenant` preHandler, applied after `requireAuth`, that sets `req.tenant: Tenant`, `req.membership: { role }` and `req.tenantDb: TenantDb`. It uses LRU caches with a 60 s TTL for tenants and 30 s for memberships, cleared by `invalidateTenant(id)` (exported and called by provision on status changes).
  - `listProjects(db: TenantDb): Promise<Project[]>` and `createProject(db, { name, createdBy }): Promise<Project>`. Routes `GET` / `POST /api/projects` use `[requireAuth, requireTenant]`.
- [ ] **Step 1: Write failing tests:**
  - `tenantSlugFromRequest`:
    - `('tenant-a.localhost', _, base localhost)` → `'tenant-a'`
    - `('localhost:3000')` → `null`
    - `('api.example.com', base example.com)` → `null`
    - header `'tenant-b'` with `tenantHeader: true` → `'tenant-b'`; ignored when `false`
    - **Review Focus 1:** `('Tenant-A.localhost:3000')` → `'tenant-a'`
  - unknown slug → `404 TENANT_NOT_FOUND`; non-member → `404 TENANT_NOT_FOUND` (the same body)
  - tenant set to `suspended` → `403 TENANT_SUSPENDED`; `provisioning` → `403 TENANT_NOT_READY`
  - **Isolation:** a user in both A and B creates `alpha` in A; `GET` from B → `[]`; from A → `[alpha]`
  - **Review Focus 5:** drop tenant A's database out of band and call `pools.evict(A)`; then `GET` on A → `500 INTERNAL`, `GET` on B → `200`, and the process stays up
- [ ] **Step 2–4:** Run → FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat: route requests to tenant databases by subdomain`

---

## PR 5: Operations and docs

### Task 12: Migrate all tenants

**Files:**
- Create: `src/tenancy/migrate-all.ts`, `scripts/migrate-tenants.ts`
- Test: `test/migrate-all.test.ts`

**Interfaces:**
- Produces: `migrateAllTenants(ctx: { central: CentralDb; config: Config }, opts?: { concurrency?: number; dir?: string }): Promise<{ migrated: string[]; upToDate: string[]; failed: { slug: string; error: string }[] }>`. It covers tenants with status `active` or `failed`, uses a simple worker pool of `concurrency` (default `config.migrateConcurrency`), and moves a `failed` tenant that now succeeds to `active`. The script prints the summary and exits `1` if `failed.length > 0`.
- [ ] **Step 1: Write failing tests** (pass `dir` as a temp copy of the tenant migrations plus one extra file):
  - three active tenants → all three in `migrated`; a second run → all in `upToDate`
  - a tenant whose database was dropped → appears in `failed` with an error message, while the other two still migrate
  - a `failed` tenant that migrates OK → becomes `active`
  - running the script with a broken tenant → exit code `1` (spawn `node scripts/migrate-tenants.ts` with the test env)
- [ ] **Step 2–4:** Run → FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat: migrate every tenant database with a failure report`

### Task 13: Seed, keys and README

**Files:**
- Create: `scripts/dev-seed.ts`, `scripts/keys-generate.ts`, `README.md`
- Test: `test/seed.test.ts`

**Interfaces:**
- Consumes: `provisionTenant`, `hashPassword`, `createProject`, `PoolRegistry`.
- Produces:
  - `seed(ctx): Promise<void>`. It's idempotent and creates `demo@example.test` (password `demo-password-123`), tenants `tenant-a` and `tenant-b` with demo as owner, and one project in each (`Tenant A project`, `Tenant B project`).
  - `keys:generate` writes `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY` (Ed25519 PEM, `\n`-escaped) into `.env`, creating it from `.env.example` if missing and never overwriting existing keys.
- [ ] **Step 1: Write failing tests:** running `seed` twice → exactly 1 user, 2 tenants and 1 project per tenant; logging in as demo and listing tenants → both, as owner.
- [ ] **Step 2–4:** Run → FAIL → implement → PASS.
- [ ] **Step 5: Write the README:**
  - what it is and why database-per-tenant
  - a quick start (`docker compose up -d postgres`, `npm ci`, `npm run keys:generate`, `npm run migrate:central`, `npm run dev:seed`, `npm run dev`, then `curl -H 'X-Tenant: tenant-a' …` and `/docs`)
  - an architecture diagram (Mermaid: request → resolve → guard → membership → pool → tenant DB)
  - the error-code table from spec §11 plus `NOT_FOUND` and `MIGRATION_CHECKSUM_MISMATCH`
  - pool sizing maths, and the no-cross-database-foreign-key trade-off
  - the roadmap for stages 2–5
- [ ] **Step 6: Run** `npm run typecheck && npm run lint && npm test` and expect everything to PASS.
- [ ] **Step 7: Commit** `docs: add README, dev seed and key generation`
