import { LRUCache } from 'lru-cache';
import type { Role } from '../db/central/schema.ts';
import type { Tenant } from './provision.ts';

export const TENANT_CACHE_TTL_MS = 60_000;
export const MEMBERSHIP_CACHE_TTL_MS = 30_000;

/** Short-lived caches for tenant lookups by slug and membership checks. One per app instance. */
export class TenantCache {
  readonly bySlug = new LRUCache<string, Tenant>({ max: 10_000, ttl: TENANT_CACHE_TTL_MS });
  /** Key `${tenantId}:${userId}`. `null` caches "not a member". */
  readonly memberships = new LRUCache<string, { role: Role } | { role: null }>({
    max: 50_000,
    ttl: MEMBERSHIP_CACHE_TTL_MS,
  });

  /** Drops a tenant's cached record and memberships after its status or members change. */
  invalidateTenant(tenantId: string): void {
    for (const [slug, t] of this.bySlug.entries()) if (t.id === tenantId) this.bySlug.delete(slug);
    for (const key of this.memberships.keys()) if (key.startsWith(`${tenantId}:`)) this.memberships.delete(key);
  }
}
