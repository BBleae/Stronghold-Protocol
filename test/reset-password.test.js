// tools/reset-password.mjs: the administrator's password reset client (the route: test/worker/password-accounts.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetPassword, generatePassword } from '../tools/reset-password.mjs';

const token = 't'.repeat(40);

test('the reset is one authorized POST; the Worker\'s refusal is the error', async () => {
  const requests = [];
  const fetchFn = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  };
  await resetPassword({ origin: 'https://stronghold.lunar.ag', username: 'Doctor_01', password: 'brand new pass', token, fetchFn });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://stronghold.lunar.ag/api/admin/accounts/password');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer ' + token);
  assert.deepEqual(JSON.parse(requests[0].init.body), { username: 'Doctor_01', password: 'brand new pass' });
  const refuse = (status, body) => async () => Response.json(body, { status });
  await assert.rejects(resetPassword({ origin: 'https://x.example', username: 'nobody', password: 'brand new pass', token,
    fetchFn: refuse(404, { error: 'ACCOUNT_NOT_FOUND' }) }), /ACCOUNT_NOT_FOUND/);
  await assert.rejects(resetPassword({ origin: 'https://x.example', username: 'a', password: 'brand new pass', token,
    fetchFn: async () => new Response('<html>', { status: 502 }) }), /HTTP 502/);
});

test('nothing is sent without HTTPS, a token, a username or a valid password', async () => {
  const fetchFn = async () => assert.fail('nothing may be sent');
  const base = { origin: 'https://x.example', username: 'a', password: 'brand new pass', token, fetchFn };
  await assert.rejects(resetPassword({ ...base, origin: 'http://x.example' }), /HTTPS/);
  await assert.rejects(resetPassword({ ...base, token: 'short' }), /SP_ACCOUNT_ADMIN_TOKEN/);
  await assert.rejects(resetPassword({ ...base, username: undefined }), /--username/);
  await assert.rejects(resetPassword({ ...base, password: 'short' }), /8-128/);
});

test('a generated password is 24 random URL-safe characters', () => {
  const first = generatePassword();
  assert.match(first, /^[A-Za-z0-9_-]{24}$/);
  assert.notEqual(generatePassword(), first);
});
