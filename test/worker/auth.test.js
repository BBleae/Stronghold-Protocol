import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAuth, authenticate } from '../../worker/accounts/auth.js';
import { handleGithub } from '../../worker/accounts/github.js';
import { errorResponse } from '../../worker/http.js';

// The GitHub OAuth flow against stub Durable Objects. GitHub's credentials are known to be valid (another isolate
// checked them: the directory has the verdict); the check itself is test/worker/github-availability.test.js.
function setup({ secret = 'secret' } = {}) {
  const transactions = new Map(), sessions = new Map(), users = new Map(), verdicts = [];
  let now = 1000, githubCalls = 0;
  const directory = {
    async saveOAuth(hash, value) { transactions.set(hash, value); },
    async consumeOAuth(hash) { const v = transactions.get(hash); transactions.delete(hash); return v || null; },
    async resolveGithubUser(p) { const id = users.get(p.id)?.accountId || crypto.randomUUID();
      const user = {accountId: id, githubId: p.id, githubLogin: p.login, name: p.name || p.login, avatarUrl: p.avatarUrl}; users.set(p.id, user); return user; },
    async saveSession(hash, value) { sessions.set(hash, value); },
    async getSession(hash) { return sessions.get(hash) || null; },
    async revokeSession(hash) { sessions.delete(hash); },
    async providerStatus() { return {verdict: 'valid', expiresAt: Number.MAX_SAFE_INTEGER}; },
    async setProviderStatus(fingerprint, verdict) { verdicts.push(verdict); },
  };
  const account = { async applyGithubLogin(identity) { return {...identity, name: identity.name + '#0001'}; } };
  const env = {AUTH_ORIGIN: 'https://game.example', GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: secret,
    SITES: {idFromName: n => n, get: () => directory}, ACCOUNTS: {idFromName: n => n, get: () => account}};
  // tokenError: GitHub's answer to the login's code; checkAnswer: its answer to the credentials check's made-up code.
  let login = 'Alice', providerFailure = false, tokenError = null, checkAnswer = 'bad_verification_code';
  const deps = {now: () => now, fetch: async (url, init) => {
    githubCalls++;
    if (providerFailure) return new Response('upstream failed', {status: 502});
    if (String(url).includes('access_token')) {
      const body = new URLSearchParams(init.body);
      if (body.get('code') === 'stronghold-credentials-check') return Response.json({error: checkAnswer});
      assert.ok(body.get('code_verifier'));
      return Response.json(tokenError ? {error: tokenError} : {access_token: 'DO-NOT-EXPOSE', token_type: 'bearer'});
    }
    return Response.json({id: 42, login, avatar_url: 'https://avatars.githubusercontent.com/u/42'});
  }};
  const request = (path, init = {}) => new Request('https://game.example' + path, init);
  // As the Worker answers: a thrown error becomes its error response.
  const handle = (path, init) => (path.startsWith('/api/auth/github/') ? handleGithub : handleAuth)(request(path, init), env, deps)
    .catch((error) => errorResponse(error, {}));
  const begin = async () => {
    const r = await handle('/api/auth/github/start');
    const u = new URL(r.headers.get('location'));
    assert.equal(u.hostname, 'github.com'); assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    return {state: u.searchParams.get('state'), cookie: r.headers.get('set-cookie').split(';')[0]};
  };
  const finish = b => handle('/api/auth/github/callback?code=ok&state=' + b.state, {headers: {cookie: b.cookie}});
  return {env, deps, request, handle, begin, finish, sessions, verdicts, calls: () => githubCalls,
    rename: v => login = v, advance: ms => now += ms, failProvider: () => providerFailure = true, failToken: (error) => tokenError = error,
    answerCheck: (error) => checkAnswer = error};
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
  assert.equal(first.user, undefined, 'a session keeps no copy of the profile');
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
test('a login started from an invite returns to it; no other return path is accepted', async () => {
  const h = setup();
  const start = async (query) => {
    const r = await h.handle('/api/auth/github/start' + query);
    return {state: new URL(r.headers.get('location')).searchParams.get('state'), cookie: r.headers.get('set-cookie').split(';')[0]};
  };
  const invited = await h.finish(await start('?return=' + encodeURIComponent('/?room=ABCD')));
  assert.equal(invited.status, 303);
  assert.equal(invited.headers.get('location'), '/?room=ABCD');
  assert.equal((await h.finish(await start(''))).headers.get('location'), '/');
  for (const bad of ['https://evil.example/', '//evil.example', '/?room=ABCD&next=//evil.example', '/lobby', '/?room=abcd', '/?room=ABCDE']) {
    const r = await h.handle('/api/auth/github/start?return=' + encodeURIComponent(bad));
    assert.equal(r.status, 400, bad);
    assert.deepEqual(await r.json(), {error: 'BAD_RETURN_PATH'});
  }
});
test('a cancelled login goes back to the invite it started from, with the notice', async () => {
  const h = setup();
  const r = await h.handle('/api/auth/github/start?return=' + encodeURIComponent('/?room=ABCD'));
  const state = new URL(r.headers.get('location')).searchParams.get('state');
  const back = await h.handle('/api/auth/github/callback?error=access_denied&state=' + state,
    {headers: {cookie: r.headers.get('set-cookie').split(';')[0], Accept: 'text/html'}});
  assert.equal(back.status, 303);
  assert.equal(back.headers.get('location'), '/?room=ABCD&authError=OAUTH_EXPIRED_OR_DENIED');
  assert.equal(h.sessions.size, 0);
});
test('a login refused as if the credentials were invalid has them checked; invalid ones are recorded at once', async () => {
  for (const error of ['incorrect_client_credentials', 'redirect_uri_mismatch']) {
    const h = setup({secret: 'revoked-' + error});
    const b = await h.begin();
    h.failToken(error);
    h.answerCheck(error);
    const back = await h.handle('/api/auth/github/callback?code=ok&state=' + b.state, {headers: {cookie: b.cookie, Accept: 'text/html'}});
    assert.equal(back.headers.get('location'), '/?authError=GITHUB_UNAVAILABLE', error);
    assert.deepEqual(h.verdicts, ['invalid'], error);
    assert.equal(h.sessions.size, 0);
    // This isolate knows it too: the next login does not leave for GitHub.
    const again = await h.handle('/api/auth/github/start', {headers: {Accept: 'text/html'}});
    assert.equal(again.headers.get('location'), '/?authError=GITHUB_UNAVAILABLE', error);
  }
});
test('a code refused for its redirect URI does not hide GitHub from everyone: the credentials check decides', async () => {
  // A visitor brings a code issued for another redirect URI (GitHub's wildcard matching); the credentials are fine.
  const h = setup({secret: 'replayed-code'});
  const b = await h.begin();
  h.failToken('redirect_uri_mismatch');
  const back = await h.handle('/api/auth/github/callback?code=ok&state=' + b.state, {headers: {cookie: b.cookie, Accept: 'text/html'}});
  assert.equal(back.headers.get('location'), '/?authError=OAUTH_PROVIDER_FAILED');
  assert.deepEqual(h.verdicts, ['valid']);
  assert.equal(h.sessions.size, 0);
  const again = await h.handle('/api/auth/github/start', {headers: {Accept: 'text/html'}});
  assert.equal(new URL(again.headers.get('location')).hostname, 'github.com', 'GitHub sign-in is still offered');
});
test('GitHub routes are unavailable without a complete configuration', async () => {
  for (const [key, value] of [['GITHUB_CLIENT_ID', ''], ['GITHUB_CLIENT_SECRET', undefined], ['AUTH_ORIGIN', 'http://game.example'],
    ['AUTH_ORIGIN', 'https://game.example/'], ['AUTH_ORIGIN', 'https://Game.example']]) {
    const h = setup();
    h.env[key] = value;
    const r = await h.handle('/api/auth/github/start');
    assert.equal(r.status, 503, `${key}=${value}`);
    assert.deepEqual(await r.json(), {error: 'GITHUB_UNAVAILABLE'});
  }
});
