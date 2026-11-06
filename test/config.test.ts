import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/index.ts';

const minimal = {
  DATABASE_URL: 'postgres://postgres:postgres@db.internal:5432/central',
  TENANT_DB_USER: 'postgres',
  TENANT_DB_PASSWORD: 'postgres',
  JWT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
  JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\\nxyz\\n-----END PUBLIC KEY-----',
};

test('loads defaults', () => {
  const c = loadConfig(minimal);
  assert.equal(c.port, 3000);
  assert.equal(c.tenantPoolsMax, 100);
  assert.equal(c.tenantPoolMax, 5);
  assert.equal(c.migrateConcurrency, 4);
  assert.equal(c.tenantHeader, false);
  assert.equal(c.baseDomain, 'localhost');
  assert.equal(c.cookieSecure, false);
});

test('tenant DB host and port default to the central database server', () => {
  const c = loadConfig(minimal);
  assert.equal(c.tenantDb.host, 'db.internal');
  assert.equal(c.tenantDb.port, 5432);
});

test('parses booleans and numbers', () => {
  const c = loadConfig({ ...minimal, TENANT_HEADER: 'true', PORT: '8080', TENANT_DB_HOST: 'other', TENANT_DB_PORT: '6543' });
  assert.equal(c.tenantHeader, true);
  assert.equal(c.port, 8080);
  assert.equal(c.tenantDb.host, 'other');
  assert.equal(c.tenantDb.port, 6543);
});

test('unescapes PEM keys given on one line', () => {
  const c = loadConfig(minimal);
  assert.equal(c.jwt.privateKeyPem, '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');
  assert.ok(c.jwt.publicKeyPem.includes('\nxyz\n'));
});

test('secure cookies by default in production', () => {
  assert.equal(loadConfig({ ...minimal, NODE_ENV: 'production' }).cookieSecure, true);
});

test('rejects missing and invalid vars, naming each one', () => {
  const { DATABASE_URL: _drop, ...rest } = minimal;
  assert.throws(
    () => loadConfig({ ...rest, PORT: 'abc' }),
    (err: Error) => err.message.includes('DATABASE_URL') && err.message.includes('PORT'),
  );
});

test('trustProxy is off by default and accepts a hop count or address list', () => {
  assert.equal(loadConfig(minimal).trustProxy, false);
  assert.equal(loadConfig({ ...minimal, TRUST_PROXY: '1' }).trustProxy, 1);
  assert.equal(loadConfig({ ...minimal, TRUST_PROXY: 'true' }).trustProxy, true);
  assert.equal(loadConfig({ ...minimal, TRUST_PROXY: '10.0.0.0/8,127.0.0.1' }).trustProxy, '10.0.0.0/8,127.0.0.1');
});
