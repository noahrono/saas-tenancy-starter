import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../src/auth/passwords.ts';

test('hashes with argon2id and verifies', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.ok(hash.startsWith('$argon2id$'));
  assert.equal(await verifyPassword(hash, 'correct horse battery'), true);
  assert.equal(await verifyPassword(hash, 'wrong password!'), false);
});

test('the same password hashes differently each time', async () => {
  assert.notEqual(await hashPassword('same-password'), await hashPassword('same-password'));
});

test('a malformed hash verifies as false instead of throwing', async () => {
  assert.equal(await verifyPassword('not-a-hash', 'whatever123'), false);
});

test('dummy verification always fails', async () => {
  assert.equal(await verifyAgainstDummy('anything-at-all'), false);
});
