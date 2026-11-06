import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { buildApp } from '../src/app.ts';
import { AppError } from '../src/errors.ts';
import { loadConfig } from '../src/config/index.ts';

const config = loadConfig({
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5433/unused',
  TENANT_DB_USER: 'postgres',
  TENANT_DB_PASSWORD: 'postgres',
  JWT_PRIVATE_KEY: 'x',
  JWT_PUBLIC_KEY: 'y',
  LOG_LEVEL: 'silent',
});

async function appWithTestRoutes() {
  const app = await buildApp({ config });
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/test/app-error', () => {
    throw new AppError('VALIDATION_FAILED', 400, 'bad thing', [{ path: 'a' }]);
  });
  r.get('/test/crash', () => {
    throw new Error('secret detail');
  });
  r.post('/test/validate', { schema: { body: z.object({ name: z.string().min(3) }) } }, (req) => req.body);
  return app;
}

test('GET /health returns ok', async () => {
  const app = await appWithTestRoutes();
  const res = await app.inject('/health');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
});

test('unknown routes use the error envelope', async () => {
  const app = await appWithTestRoutes();
  const res = await app.inject('/nope');
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, 'NOT_FOUND');
  assert.equal(res.json().error.requestId, res.headers['x-request-id']);
});

test('AppError keeps its status, code and details, plus the request id', async () => {
  const app = await appWithTestRoutes();
  const res = await app.inject('/test/app-error');
  assert.equal(res.statusCode, 400);
  const { error } = res.json();
  assert.equal(error.code, 'VALIDATION_FAILED');
  assert.equal(error.message, 'bad thing');
  assert.deepEqual(error.details, [{ path: 'a' }]);
  assert.match(error.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(error.requestId, res.headers['x-request-id']);
});

test('unexpected errors become a generic 500 without leaking details', async () => {
  const app = await appWithTestRoutes();
  const res = await app.inject('/test/crash');
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error.code, 'INTERNAL');
  assert.equal(res.body.includes('secret detail'), false);
});

test('schema validation failures become 400 VALIDATION_FAILED with field details', async () => {
  const app = await appWithTestRoutes();
  const res = await app.inject({ method: 'POST', url: '/test/validate', payload: { name: 'ab' } });
  assert.equal(res.statusCode, 400);
  const { error } = res.json();
  assert.equal(error.code, 'VALIDATION_FAILED');
  assert.ok(Array.isArray(error.details));
  assert.deepEqual(error.details[0].path, ['name']);
});

test('OpenAPI document is served at /docs/json', async () => {
  const app = await appWithTestRoutes();
  const res = await app.inject('/docs/json');
  assert.equal(res.statusCode, 200);
  assert.match(res.json().openapi, /^3\./);
});
