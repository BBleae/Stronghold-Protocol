import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAuth, authenticate } from '../../worker/accounts/auth.js';

function setup() {
  const transactions = new Map(), sessions = new Map(), users = new Map();
  let now = 1000, githubCalls = 0;
  const directory = {
    async saveOAuth(hash, value) { transactions.set(hash, value); },
    async consumeOAuth(hash) { const v = transactions.get(hash); transactions.delete(hash); return v || null; },
    async resolveGithubUser(p) { const id = users.get(p.id)?.accountId || crypto.randomUUID();
      const user = {accountId: id, githubId: p.id, name: p.login, avatarUrl: p.avatarUrl}; users.set(p.id, user); return user; },
    async saveSession(hash, value) { sessions.set(hash, value); },
    async getSession(hash) { return sessions.get(hash) || null; },
    async revokeSession(hash) { sessions.delete(hash); },
  };
  const env = {AUTH_ORIGIN: 'https://game.example', GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret',
    SITES: {idFromName: n => n, get: () => directory}};
  let login = 'Alice', providerFailure = false;
  const deps = {now: () => now, fetch: async (url, init) => {
    githubCalls++;
    if (providerFailure) return new Response('upstream failed', {status: 502});
    if (String(url).includes('access_token')) {
      assert.ok(new URLSearchParams(init.body).get('code_verifier'));
      return Response.json({access_token: 'DO-NOT-EXPOSE', token_type: 'bearer'});
    }
    return Response.json({id: 42, login, avatar_url: 'https://avatars.githubusercontent.com/u/42'});
  }};
  const request = (path, init = {}) => new Request(env.AUTH_ORIGIN + path, init);
  const handle = (path, init) => handleAuth(request(path, init), env, deps);
  const begin = async () => {
    const r = await handle('/api/auth/github/start');
    const u = new URL(r.headers.get('location'));
    assert.equal(u.hostname, 'github.com'); assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    return {state: u.searchParams.get('state'), cookie: r.headers.get('set-cookie').split(';')[0]};
  };
  const finish = b => handle('/api/auth/github/callback?code=ok&state=' + b.state, {headers: {cookie: b.cookie}});
  return {env, deps, request, handle, begin, finish, sessions, calls: () => githubCalls,
    rename: v => login = v, advance: ms => now += ms, failProvider: () => providerFailure = true};
}
test('OAuth ties state to the browser, uses PKCE, creates private revocable sessions and stable identity', async () => {
  const h = setup(), b = await h.begin();
  assert.equal((await h.handle('/api/auth/github/callback?code=ok&state=' + b.state)).status, 400);
  const done = await h.finish(b);
  assert.equal(done.status, 303);
  const cookie = done.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/);
  assert.ok(!cookie.includes('DO-NOT-EXPOSE'));
  const headers = {cookie: cookie.split(';')[0]};
  const first = await authenticate(h.request('/api/me', {headers}), h.env, h.deps);
  assert.ok(first.accountId);
  assert.equal((await h.finish(b)).status, 400);
  h.rename('名字 changed');
  const secondLogin = await h.finish(await h.begin());
  const second = await authenticate(h.request('/api/me', {headers: {cookie: secondLogin.headers.get('set-cookie').split(';')[0]}}), h.env, h.deps);
  assert.equal(second.accountId, first.accountId);
  assert.equal((await h.handle('/api/auth/logout', {method: 'POST', headers})).status, 403);
  assert.equal((await h.handle('/api/auth/logout', {method: 'POST', headers: {...headers, Origin: h.env.AUTH_ORIGIN}})).status, 204);
  assert.equal(await authenticate(h.request('/api/me', {headers}), h.env, h.deps), null);
});
test('expired, cancelled and failed OAuth do not create accounts or leak upstream errors', async () => {
  const h = setup(); const b = await h.begin(); h.advance(600001);
  assert.equal((await h.finish(b)).status, 400); assert.equal(h.calls(), 0);
  const c = await h.begin();
  assert.equal((await h.handle('/api/auth/github/callback?error=access_denied&state=' + c.state, {headers:{cookie:c.cookie}})).status, 400);
  h.failProvider(); const response = await h.finish(await h.begin());
  assert.equal(response.status, 502); assert.equal(h.sessions.size, 0);
  assert.ok(!(await response.text()).includes('upstream failed'));
});
