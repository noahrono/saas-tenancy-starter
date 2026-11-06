import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tenantSlugFromRequest } from '../src/tenancy/resolve.ts';
import { createTestContext, type TestContext } from './helpers/context.ts';
import { createTestApp, signupAndToken, type TestApp } from './helpers/app.ts';

describe('tenantSlugFromRequest', () => {
  const local = { baseDomain: 'localhost', tenantHeader: false };
  const prod = { baseDomain: 'example.com', tenantHeader: false };

  test('takes the first label under the base domain', () => {
    assert.equal(tenantSlugFromRequest('tenant-a.localhost', undefined, local), 'tenant-a');
    assert.equal(tenantSlugFromRequest('tenant-a.example.com', undefined, prod), 'tenant-a');
  });

  test('ignores port and case', () => {
    assert.equal(tenantSlugFromRequest('Tenant-A.localhost:3000', undefined, local), 'tenant-a');
  });

  test('the bare domain, api., deeper names and other domains are not tenants', () => {
    assert.equal(tenantSlugFromRequest('localhost:3000', undefined, local), null);
    assert.equal(tenantSlugFromRequest('api.example.com', undefined, prod), null);
    assert.equal(tenantSlugFromRequest('a.b.example.com', undefined, prod), null);
    assert.equal(tenantSlugFromRequest('tenant-a.other.test', undefined, prod), null);
    assert.equal(tenantSlugFromRequest('notexample.com', undefined, prod), null);
    assert.equal(tenantSlugFromRequest(undefined, undefined, prod), null);
  });

  test('the X-Tenant header wins only when enabled', () => {
    assert.equal(tenantSlugFromRequest('localhost', 'tenant-b', { ...local, tenantHeader: true }), 'tenant-b');
    assert.equal(tenantSlugFromRequest('tenant-a.localhost', 'Tenant-B', { ...local, tenantHeader: true }), 'tenant-b');
    assert.equal(tenantSlugFromRequest('localhost', 'tenant-b', local), null);
  });
});

describe('tenant routing', () => {
  let ctx: TestContext;
  let t: TestApp;
  let owner: string;
  let outsider: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    t = await createTestApp(ctx);
    owner = await signupAndToken(t, 'owner@example.test');
    outsider = await signupAndToken(t, 'outsider@example.test');
    for (const slug of ['tenant-a', 'tenant-b']) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/tenants',
        headers: { authorization: `Bearer ${owner}` },
        payload: { slug, name: slug },
      });
      assert.equal(res.statusCode, 201);
    }
  });
  afterEach(async () => {
    await t.close();
    await ctx.cleanup();
  });

  const list = (token: string, headers: Record<string, string>) =>
    t.app.inject({ url: '/api/projects', headers: { authorization: `Bearer ${token}`, ...headers } });

  test('members reach their tenant by subdomain and by header', async () => {
    assert.equal((await list(owner, { host: 'tenant-a.localhost:3000' })).statusCode, 200);
    assert.equal((await list(owner, { 'x-tenant': 'tenant-a' })).statusCode, 200);
  });

  test('tenant routes need a tenant and a login', async () => {
    assert.equal((await list(owner, {})).json().error.code, 'TENANT_NOT_FOUND');
    const anon = await t.app.inject({ url: '/api/projects', headers: { 'x-tenant': 'tenant-a' } });
    assert.equal(anon.statusCode, 401);
  });

  test('an outsider gets the same 404 as for a tenant that does not exist', async () => {
    const notMember = await list(outsider, { 'x-tenant': 'tenant-a' });
    const missing = await list(outsider, { 'x-tenant': 'no-such-tenant' });
    assert.equal(notMember.statusCode, 404);
    assert.equal(missing.statusCode, 404);
    assert.equal(notMember.json().error.code, 'TENANT_NOT_FOUND');
    assert.equal(notMember.json().error.message, missing.json().error.message);
  });

  test('suspended and unfinished tenants are blocked', async () => {
    await t.deps.central.sql`update tenants set status = 'suspended' where slug = 'tenant-a'`;
    await t.deps.central.sql`update tenants set status = 'provisioning' where slug = 'tenant-b'`;
    const a = await list(owner, { 'x-tenant': 'tenant-a' });
    const b = await list(owner, { 'x-tenant': 'tenant-b' });
    assert.equal(a.statusCode, 403);
    assert.equal(a.json().error.code, 'TENANT_SUSPENDED');
    assert.equal(b.statusCode, 403);
    assert.equal(b.json().error.code, 'TENANT_NOT_READY');
  });

  test('a tenant whose database vanished fails alone, without taking others down', async () => {
    const [row] = await t.deps.central.sql`select id, db_name from tenants where slug = 'tenant-a'`;
    assert.equal((await list(owner, { 'x-tenant': 'tenant-a' })).statusCode, 200);
    await t.deps.pools.evict(row!.id);
    await ctx.adminSql.unsafe(`drop database "${row!.db_name}" with (force)`);

    const broken = await list(owner, { 'x-tenant': 'tenant-a' });
    assert.equal(broken.statusCode, 500);
    assert.equal(broken.json().error.code, 'INTERNAL');
    assert.equal((await list(owner, { 'x-tenant': 'tenant-b' })).statusCode, 200);
    assert.equal((await t.app.inject('/health')).statusCode, 200);
  });
});
