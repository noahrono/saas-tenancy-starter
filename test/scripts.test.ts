import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
};

test('every command that needs config loads .env, so the README quick start works', () => {
  const needsEnv = ['dev', 'start', 'migrate:central', 'migrate:tenants', 'tenant:create', 'tenant:retry', 'dev:seed'];
  for (const name of needsEnv) {
    assert.match(pkg.scripts[name] ?? '', /--env-file-if-exists=\.env(\s|$)/, `${name} does not load .env`);
  }
});
