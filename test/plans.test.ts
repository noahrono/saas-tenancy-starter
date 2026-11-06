import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCentralDb } from '../src/db/central/client.ts';
import { PLANS, cheapestPlanWith, hasFeature, limitFor } from '../src/plans/plans.ts';
import { findTenantBySlug, provisionTenant } from '../src/tenancy/provision.ts';
import { createTestContext } from './helpers/context.ts';

test('the plans match the stage 2 spec', () => {
  assert.deepEqual(PLANS, {
    free: { name: 'Free', features: [], limits: { members: 3, projects: 10 } },
    pro: { name: 'Pro', features: ['projects:export'], limits: { members: 20, projects: 1000 } },
    business: { name: 'Business', features: ['projects:export'], limits: { members: null, projects: null } },
  });
});

test('features, limits and the cheapest plan with a feature', () => {
  assert.equal(hasFeature('free', 'projects:export'), false);
  assert.equal(hasFeature('pro', 'projects:export'), true);
  assert.equal(limitFor('free', 'members'), 3);
  assert.equal(limitFor('business', 'members'), null);
  assert.equal(cheapestPlanWith('projects:export'), 'pro');
});

test('new tenants start on free, and only known plans can be stored', async () => {
  const ctx = await createTestContext();
  const central = createCentralDb(ctx.centralUrl);
  try {
    const [u] = await central.sql`insert into users (email, password_hash) values ('owner@example.test', 'h') returning id`;
    await provisionTenant({ central, config: ctx.config }, { slug: 'tenant-a', name: 'Tenant A', ownerUserId: u!.id });
    assert.equal((await findTenantBySlug(central, 'tenant-a'))?.plan, 'free');
    const err = await central.sql`update tenants set plan = 'gold' where slug = 'tenant-a'`.then(
      () => null,
      (e: { code?: string }) => e,
    );
    assert.equal(err?.code, '23514');
  } finally {
    await central.end();
    await ctx.cleanup();
  }
});
