import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { LRUCache } from 'lru-cache';
import type { TenantDb } from './tenant/client.ts';
import * as tenantSchema from './tenant/schema.ts';

export interface TenantLocation {
  id: string;
  dbHost: string;
  dbName: string;
}

export interface PoolRegistryOptions {
  port: number;
  user: string;
  password: string;
  /** Most tenant pools kept open at once; the least recently used one is closed beyond this. */
  maxPools: number;
  /** Connections per tenant pool. */
  poolMax: number;
  /** Seconds before an idle connection inside a pool is closed. Defaults to 300. */
  idleTimeoutSec?: number;
  createClient?: (url: string, poolMax: number) => postgres.Sql;
}

interface Entry {
  sql: postgres.Sql;
  db: TenantDb;
  /** Requests currently using this pool. */
  leases: number;
  /** Dropped from the LRU; close as soon as no request holds it. */
  evicted: boolean;
}

export interface PoolLease {
  db: TenantDb;
  /** Call once the request is done. Safe to call more than once. */
  release(): void;
}

/** Hands out one Drizzle instance per tenant database, backed by a capped LRU of connection pools. */
export class PoolRegistry {
  private readonly opts: PoolRegistryOptions;
  private readonly pools: LRUCache<string, Entry>;
  private readonly closing = new Set<Promise<void>>();

  constructor(opts: PoolRegistryOptions) {
    this.opts = opts;
    this.pools = new LRUCache<string, Entry>({
      max: opts.maxPools,
      dispose: (entry) => {
        entry.evicted = true;
        if (entry.leases === 0) this.end(entry);
      },
    });
  }

  get size(): number {
    return this.pools.size;
  }

  /** A tenant's database for short-lived work outside a request (scripts, seeding). */
  async get(tenant: TenantLocation): Promise<TenantDb> {
    return this.entry(tenant).db;
  }

  /**
   * A tenant's database for one request. While leased, the pool is never closed, even if
   * the LRU drops it to make room for another tenant: it closes when the last lease is released.
   */
  async acquire(tenant: TenantLocation): Promise<PoolLease> {
    const entry = this.entry(tenant);
    entry.leases++;
    let released = false;
    return {
      db: entry.db,
      release: () => {
        if (released) return;
        released = true;
        entry.leases--;
        if (entry.evicted && entry.leases === 0) this.end(entry);
      },
    };
  }

  private entry(tenant: TenantLocation): Entry {
    const existing = this.pools.get(tenant.id);
    if (existing) return existing;

    const url = new URL('postgres://placeholder');
    url.hostname = tenant.dbHost;
    url.port = String(this.opts.port);
    url.username = encodeURIComponent(this.opts.user);
    url.password = encodeURIComponent(this.opts.password);
    url.pathname = `/${tenant.dbName}`;

    const sql = this.opts.createClient
      ? this.opts.createClient(url.toString(), this.opts.poolMax)
      : postgres(url.toString(), {
          max: this.opts.poolMax,
          idle_timeout: this.opts.idleTimeoutSec ?? 300,
          onnotice: () => {},
        });
    const entry: Entry = { sql, db: drizzle(sql, { schema: tenantSchema }), leases: 0, evicted: false };
    this.pools.set(tenant.id, entry);
    return entry;
  }

  /** Closes one tenant's pool, e.g. after its database was dropped or moved. */
  async evict(tenantId: string): Promise<void> {
    this.pools.delete(tenantId);
    await this.drain();
  }

  async closeAll(): Promise<void> {
    this.pools.clear();
    await this.drain();
  }

  private end(entry: Entry): void {
    const p = entry.sql
      .end({ timeout: 5 })
      .catch(() => {})
      .finally(() => this.closing.delete(p));
    this.closing.add(p);
  }

  private async drain(): Promise<void> {
    await Promise.all([...this.closing]);
  }
}
