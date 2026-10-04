// GitHub accounts and their display names (昵称#NNNN): the nickname follows the GitHub name unless the player chose
// one, the discriminator stays when it can, and accounts stored before display names get theirs when next read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountHarness } from './helpers/account-harness.js';

const source = `
import { SiteDirectory } from './worker/accounts/directory.js';
export { AccountDurableObject } from './worker/accounts/account.js';
import { handleGithub } from './worker/accounts/github.js';
import { handleAccountRoutes } from './worker/accounts/routes.js';
import { hash } from './worker/accounts/auth.js';
export class TestObject extends SiteDirectory {
  exec(query, ...params) { return this.sql.exec(query, ...params).toArray(); }
}
export default {async fetch(req, env) {
  const { path, method = 'GET', cookie, body, profile, legacy, exec } = await req.json();
  const site = env.SITES.get(env.SITES.idFromName('directory'));
  if (exec) return Response.json(await site.exec(...exec));
  if (legacy) {
    // An account stored before display names: its GitHub user, the profile its login stored then, and a session.
    const { accountId } = await site.resolveGithubUser({ id: legacy.githubId, login: legacy.githubLogin ?? 'login' + legacy.githubId,
      name: legacy.name, avatarUrl: legacy.avatarUrl });
    await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(accountId)).setProfile({ accountId, ...legacy });
    const token = crypto.randomUUID().replaceAll('-', '').padEnd(64, '0');
    await site.saveSession(await hash(token), { accountId, expiresAt: Date.now() + 600000 });
    return Response.json({ cookie: '__Host-sp_session=' + token, accountId });
  }
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('access_token')) {
      const code = new URLSearchParams(String(init.body)).get('code');
      return Response.json(code === 'stronghold-credentials-check' ? { error: 'bad_verification_code' } : { access_token: 'fixture-token' });
    }
    return Response.json(profile);
  };
  const request = new Request('https://game.example' + path, { method, body: body && JSON.stringify(body),
    headers: { Origin: 'https://game.example', ...(cookie ? { cookie } : {}) } });
  const handler = path.startsWith('/api/auth/github/') ? handleGithub : handleAccountRoutes;
  const response = await handler(request, { ...env, AUTH_ORIGIN: 'https://game.example', GITHUB_CLIENT_ID: 'fixture',
    GITHUB_CLIENT_SECRET: 'fixture' }, { fetch });
  response.headers.set('X-Test-Github-Calls', JSON.stringify(calls));
  return response;
}};
`;

async function harness(t) {
  const h = await createAccountHarness(source, { durableObjects: {
    SITES: { className: 'TestObject', useSQLite: true }, ACCOUNTS: { className: 'AccountDurableObject', useSQLite: true } } });
  t.after(() => h.dispose());
  const request = (body) => h.request('https://test.example/', { method: 'POST', body: JSON.stringify(body), redirect: 'manual' });
  return {
    restart: () => h.restart(),
    exec: async (...exec) => (await request({ exec })).json(),
    /** An account stored before display names (`profile` without accountId): { cookie, accountId }. */
    legacy: async (profile) => (await request({ legacy: profile })).json(),
    /** A GitHub login of the GitHub user `profile` (GitHub's /user answer); resolves with the session cookie. */
    async login(profile) {
      const start = await request({ path: '/api/auth/github/start' });
      assert.equal(start.status, 302);
      const state = new URL(start.headers.get('location')).searchParams.get('state');
      const done = await request({ path: '/api/auth/github/callback?code=fixture&state=' + state,
        cookie: start.headers.get('set-cookie').split(';')[0], profile });
      assert.equal(done.status, 303);
      return done.headers.get('set-cookie').split(';')[0];
    },
    /** GET /api/me: { user, calls } (calls: the requests that left for GitHub). */
    async me(cookie) {
      const response = await request({ path: '/api/me', cookie });
      return { ...(await response.json()), calls: JSON.parse(response.headers.get('X-Test-Github-Calls')) };
    },
    rename: async (cookie, nickname) => (await request({ path: '/api/me/nickname', method: 'POST', cookie, body: { nickname } })).json(),
  };
}

const avatar = 'https://avatars.githubusercontent.com/u/42?v=4';

test('a GitHub account goes by its GitHub name with a discriminator, which a new GitHub name keeps when it can', { timeout: 60000 }, async (t) => {
  const h = await harness(t);
  const cookie = await h.login({ id: 42, login: 'BBleae', name: '  晴猫  ', avatar_url: avatar });
  const { user } = await h.me(cookie);
  assert.match(user.discriminator, /^\d{4}$/);
  assert.deepEqual(user, { accountId: user.accountId, provider: 'github', githubId: '42', githubLogin: 'BBleae', nickname: '晴猫',
    nicknameSource: 'github', discriminator: user.discriminator, name: '晴猫#' + user.discriminator, avatarUrl: avatar });
  await h.restart();
  assert.deepEqual((await h.me(cookie)).user, user, 'the profile persists across a restart');

  await h.login({ id: 42, login: 'renamed-handle', name: '新的名字', avatar_url: avatar + '&s=96' });
  const renamed = (await h.me(cookie)).user;
  assert.equal(renamed.accountId, user.accountId, 'a new GitHub name is the same account');
  assert.equal(renamed.name, '新的名字#' + user.discriminator, 'the discriminator is free under the new name: it stays');
  assert.equal(renamed.githubLogin, 'renamed-handle');
  assert.equal(renamed.avatarUrl, avatar + '&s=96');
  assert.deepEqual(await h.exec('SELECT name_key, disc FROM display_names WHERE account_id=?', user.accountId),
    [{ name_key: '新的名字', disc: user.discriminator }], 'the former name is free again');

  // Another account holds the discriminator under the next name: a new one is allocated.
  await h.exec('INSERT INTO display_names VALUES (?,?,?)', 'taken', user.discriminator, 'someone-else');
  await h.login({ id: 42, login: 'BBleae', name: 'Taken', avatar_url: avatar });
  const moved = (await h.me(cookie)).user;
  assert.equal(moved.nickname, 'Taken');
  assert.notEqual(moved.discriminator, user.discriminator);
  assert.equal(moved.name, 'Taken#' + moved.discriminator);

  for (const name of [null, undefined, '', '   ', 123, '###']) {
    await h.login({ id: 42, login: 'BBleae', name, avatar_url: avatar });
    assert.equal((await h.me(cookie)).user.nickname, 'BBleae', `GitHub name ${JSON.stringify(name)}: the login`);
  }
  await h.login({ id: 42, login: 'BBleae', name: '猫'.repeat(90), avatar_url: avatar });
  assert.equal((await h.me(cookie)).user.nickname, '猫'.repeat(12), 'a long GitHub name is cut to 12 characters');
  await h.login({ id: 42, login: 'BBleae', name: 'C#  Fan ＃1', avatar_url: avatar });
  assert.equal((await h.me(cookie)).user.nickname, 'C Fan 1', 'number signs are removed');
});

test('a GitHub account stored before display names gets its nickname and discriminator when it is next read', { timeout: 60000 }, async (t) => {
  const h = await harness(t);
  // Profiles of both earlier shapes: with the login (and the GitHub name), and with neither but the name.
  const { cookie, accountId } = await h.legacy({ githubId: '7', githubLogin: 'BBleae', name: '晴猫', avatarUrl: avatar });
  const first = await h.me(cookie);
  assert.match(first.user.name, /^晴猫#\d{4}$/);
  assert.equal(first.user.nickname, '晴猫');
  assert.equal(first.user.nicknameSource, 'github');
  assert.equal(first.user.provider, 'github');
  assert.equal(first.user.githubLogin, 'BBleae');
  assert.deepEqual(first.calls, ['https://github.com/login/oauth/access_token'], 'GitHub is asked about the credentials only, not the user');
  await h.restart();
  assert.deepEqual((await h.me(cookie)).user, first.user, 'allocated once, then stored');
  assert.deepEqual(await h.exec('SELECT name_key, disc FROM display_names WHERE account_id=?', accountId),
    [{ name_key: '晴猫', disc: first.user.discriminator }]);

  const older = await h.legacy({ githubId: '8', name: 'Old#Name', avatarUrl: null });
  assert.match((await h.me(older.cookie)).user.name, /^OldName#\d{4}$/);

  // Its next GitHub login keeps it.
  const login = await h.login({ id: 7, login: 'BBleae', name: '晴猫', avatar_url: avatar });
  assert.equal((await h.me(login)).user.name, first.user.name);
});

test('a nickname the player chose survives GitHub logins', { timeout: 60000 }, async (t) => {
  const h = await harness(t);
  const cookie = await h.login({ id: 42, login: 'BBleae', name: '晴猫', avatar_url: avatar });
  const before = (await h.me(cookie)).user;
  const { user } = await h.rename(cookie, '自选代号');
  assert.equal(user.nicknameSource, 'user');
  assert.equal(user.name, '自选代号#' + before.discriminator);
  await h.login({ id: 42, login: 'BBleae', name: 'GitHub Changed', avatar_url: avatar });
  const after = (await h.me(cookie)).user;
  assert.equal(after.name, '自选代号#' + before.discriminator);
  assert.equal(after.nicknameSource, 'user');
});
