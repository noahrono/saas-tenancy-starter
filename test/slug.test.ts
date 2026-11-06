import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESERVED_SLUGS, tenantDbName, validateSlug } from '../src/tenancy/slug.ts';
import { AppError } from '../src/errors.ts';

const code = (c: string) => (e: unknown) => e instanceof AppError && e.code === c && e.statusCode === 400;

test('valid slugs pass through', () => {
  for (const s of ['tenant-a', 'abc', 'a1b', 'team-42-x', 'x'.repeat(40)]) assert.equal(validateSlug(s), s);
});

test('malformed slugs are rejected', () => {
  for (const s of ['ab', '-abc', 'abc-', 'Tenant-A', 'a_b', 'a.b', 'a b', '', 'x'.repeat(41)]) {
    assert.throws(() => validateSlug(s), code('SLUG_INVALID'), `slug "${s}"`);
  }
});

test('reserved slugs are rejected', () => {
  assert.deepEqual(
    [...RESERVED_SLUGS].sort(),
    ['admin', 'api', 'app', 'auth', 'docs', 'mail', 'static', 'status', 'www'],
  );
  for (const s of RESERVED_SLUGS) assert.throws(() => validateSlug(s), code('SLUG_RESERVED'), s);
});

test('tenant database names come from the tenant id, never the slug', () => {
  assert.equal(tenantDbName('0f8fad5b-d9cb-469f-a165-70867728950e'), 't_0f8fad5bd9cb469fa16570867728950e');
  assert.throws(() => tenantDbName('robert"; drop database x; --'));
});
