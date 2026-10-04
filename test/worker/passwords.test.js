// Password hashes (worker/accounts/passwords.js) and the login's use of them (worker/accounts/auth.js), against stub
// Durable Objects: the parameters, the dummy derivation for an unknown username, and a hash made again under new
// parameters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, outdated, PBKDF2_ITERATIONS } from '../../worker/accounts/passwords.js';
import { handleAuth } from '../../worker/accounts/auth.js';
import { errorResponse } from '../../worker/http.js';

test('a password is stored as PBKDF2-SHA256 with its parameters, never above the Workers limit of 100,000 iterations', async () => {
  assert.ok(PBKDF2_ITERATIONS <= 100_000);
  const stored = await hashPassword('correct horse');
  assert.deepEqual(Object.keys(stored).sort(), ['alg', 'hash', 'iterations', 'salt']);
  assert.equal(stored.alg, 'pbkdf2-sha256');
  assert.equal(stored.iterations, PBKDF2_ITERATIONS);
  assert.equal(Buffer.from(stored.salt, 'base64url').length, 16);
  assert.equal(Buffer.from(stored.hash, 'base64url').length, 32);
  assert.notEqual((await hashPassword('correct horse')).salt, stored.salt, 'a random salt per hash');
  assert.equal(await verifyPassword('correct horse', stored), true);
  assert.equal(await verifyPassword('correct horsf', stored), false);
  assert.equal(await verifyPassword('correct horse', null), false, 'an unknown username never matches');
  assert.equal(outdated(stored), false);
  assert.equal(outdated({ ...stored, iterations: 50_000 }), true);
});

function login({ users = {} } = {}) {
  const updated = [];
  const directory = {
    async localUser(username) { return users[username.toLowerCase()] ?? null; },
    async updatePassword(accountId, password) { updated.push({ accountId, password }); },
    async saveSession() {},
  };
  const account = { async getProfile() { return { accountId: 'a', name: '晴猫#0001' }; } };
  const unlimited = { limit: async () => ({ success: true }) };
  const env = { SITES: { idFromName: (n) => n, get: () => directory }, ACCOUNTS: { idFromName: (n) => n, get: () => account },
    LOGIN_LIMIT: unlimited, USERNAME_LIMIT: unlimited };
  const attempt = (username, password) => handleAuth(new Request('https://game.example/api/auth/login', { method: 'POST',
    headers: { Origin: 'https://game.example' }, body: JSON.stringify({ username, password }) }), env).catch((error) => errorResponse(error, {}));
  return { attempt, updated };
}

test('an unknown username costs a derivation like a wrong password, and gets the same answer', async (t) => {
  const stored = await hashPassword('correct horse');
  const { attempt } = login({ users: { doctor: { accountId: 'a', username: 'Doctor', password: stored } } });
  const derive = t.mock.method(crypto.subtle, 'deriveBits');
  const answers = [];
  for (const [username, password] of [['Doctor', 'wrong horse'], ['nobody', 'wrong horse'], ['bad name!', 'wrong horse']]) {
    const before = derive.mock.callCount();
    const response = await attempt(username, password);
    answers.push([response.status, await response.json()]);
    assert.equal(derive.mock.callCount() - before, 1, `${username}: one derivation`);
    assert.equal(derive.mock.calls.at(-1).arguments[0].iterations, PBKDF2_ITERATIONS);
  }
  assert.deepEqual(answers, Array(3).fill([401, { error: 'BAD_CREDENTIALS' }]));
});

test('a login stores its password again when the hash was made under other parameters', async () => {
  const old = await hashPassword('correct horse');
  // As if made with fewer iterations: the same derivation, other parameters on record.
  const weak = { ...old, iterations: 1000 };
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('correct horse'), 'PBKDF2', false, ['deriveBits']);
  weak.hash = Buffer.from(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: Buffer.from(old.salt, 'base64url'),
    iterations: 1000 }, key, 256)).toString('base64url');
  const { attempt, updated } = login({ users: { doctor: { accountId: 'a', username: 'Doctor', password: weak } } });
  assert.equal((await attempt('doctor', 'correct horse')).status, 200);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].password.iterations, PBKDF2_ITERATIONS);
  assert.equal(await verifyPassword('correct horse', updated[0].password), true);
  const current = login({ users: { doctor: { accountId: 'a', username: 'Doctor', password: old } } });
  assert.equal((await current.attempt('doctor', 'correct horse')).status, 200);
  assert.equal(current.updated.length, 0, 'a current hash stays');
});
