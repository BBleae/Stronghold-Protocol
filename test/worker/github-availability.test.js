// GitHub sign-in is offered (/api/me capabilities.github) only while it can work: configured, and its credentials not
// known to be invalid. The check exchanges a made-up code at GitHub (mocked here) and is kept per configuration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountHarness } from './helpers/account-harness.js';

const source = `
export { SiteDirectory as TestObject } from './worker/accounts/directory.js';
export { AccountDurableObject } from './worker/accounts/account.js';
import { handleAccountRoutes } from './worker/accounts/routes.js';
export default {async fetch(req, env) {
  const { config, answer, at } = await req.json();
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(Object.fromEntries(new URLSearchParams(String(init.body))));
    if (answer === 'network') throw new TypeError('network connection lost');
    return Response.json(answer === 'html' ? {} : { error: answer }, { status: answer === 'html' ? 500 : 200 });
  };
  const response = await handleAccountRoutes(new Request('https://game.example/api/me'), { ...env, ...config },
    { fetch, now: () => at ?? Date.now() });
  return Response.json({ capabilities: (await response.json()).capabilities, calls });
}};
`;

test('GitHub sign-in is offered only when configured and not known to be invalid, checked once per verdict', { timeout: 60000 }, async (t) => {
  const h = await createAccountHarness(source, { durableObjects: {
    SITES: { className: 'TestObject', useSQLite: true }, ACCOUNTS: { className: 'AccountDurableObject', useSQLite: true } } });
  t.after(() => h.dispose());
  const config = (secret) => ({ AUTH_ORIGIN: 'https://game.example', GITHUB_CLIENT_ID: 'Ov23li-client', GITHUB_CLIENT_SECRET: secret });
  const me = async (config, answer, at) => (await h.fetch({ config, answer, at })).json();
  const now = Date.now();
  const minutes = (n) => now + n * 60_000;

  // Not configured (or AUTH_ORIGIN not a bare https origin): no GitHub, nobody asked; passwords always.
  for (const partial of [{}, { ...config('s'), GITHUB_CLIENT_SECRET: '' }, { ...config('s'), AUTH_ORIGIN: 'https://game.example/path' },
    { ...config('s'), AUTH_ORIGIN: 'http://game.example' }]) {
    assert.deepEqual(await me(partial, 'bad_verification_code'), { capabilities: { password: true, github: false }, calls: [] });
  }

  // Valid: offered, and nobody asks again for 24 hours, in this isolate or another (the directory keeps the verdict).
  const valid = await me(config('valid'), 'bad_verification_code', now);
  assert.deepEqual(valid.capabilities, { password: true, github: true });
  assert.deepEqual(valid.calls, [{ client_id: 'Ov23li-client', client_secret: 'valid', code: 'stronghold-credentials-check',
    redirect_uri: 'https://game.example/api/auth/github/callback' }]);
  assert.deepEqual((await me(config('valid'), 'incorrect_client_credentials', minutes(60))).calls, []);
  await h.restart();
  assert.deepEqual(await me(config('valid'), 'incorrect_client_credentials', minutes(23 * 60)),
    { capabilities: { password: true, github: true }, calls: [] });
  assert.equal((await me(config('valid'), 'bad_verification_code', minutes(24 * 60 + 1))).calls.length, 1, 'checked again after a day');

  // Invalid credentials or callback: not offered, checked again after an hour.
  for (const error of ['incorrect_client_credentials', 'redirect_uri_mismatch']) {
    assert.deepEqual(await me(config(error), error, now), { capabilities: { password: true, github: false }, calls: [config(error)]
      .map((c) => ({ client_id: c.GITHUB_CLIENT_ID, client_secret: c.GITHUB_CLIENT_SECRET, code: 'stronghold-credentials-check',
        redirect_uri: 'https://game.example/api/auth/github/callback' })) });
    assert.deepEqual(await me(config(error), 'bad_verification_code', minutes(59)), { capabilities: { password: true, github: false }, calls: [] });
    assert.deepEqual((await me(config(error), 'bad_verification_code', minutes(61))).capabilities.github, true, 'fixed credentials are found');
  }

  // GitHub unreachable or answering anything else: still offered, checked again after five minutes.
  for (const answer of ['network', 'html', 'unsupported_grant_type']) {
    assert.equal((await me(config(answer), answer, now)).capabilities.github, true, answer);
    assert.deepEqual((await me(config(answer), 'incorrect_client_credentials', minutes(4))).calls, [], answer);
    assert.equal((await me(config(answer), 'incorrect_client_credentials', minutes(6))).capabilities.github, false, answer);
  }

  // A new secret is a new configuration: checked at once.
  assert.equal((await me(config('rotated'), 'incorrect_client_credentials', now)).capabilities.github, false);
});
