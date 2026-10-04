import { ACCOUNT_LIMITS, AccountError } from '../../shared/account-protocol.js';
const SESSION_COOKIE = '__Host-sp_session', OAUTH_COOKIE = '__Host-sp_oauth';
export const directoryOf = env => env.SITES.get(env.SITES.idFromName('directory'));
export const accountOf = (env, id) => env.ACCOUNTS.get(env.ACCOUNTS.idFromName(id));
export const json = (body, status = 200) => Response.json(body, {status, headers: {'Cache-Control': 'no-store'}});
export function cookieValue(request, key) {
  return (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(key + '='))?.slice(key.length + 1) || null;
}
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
export async function hash(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
const cookie = (key, value, seconds) => key + '=' + value + '; Path=/; Max-Age=' + seconds + '; Secure; HttpOnly; SameSite=Lax';
// Where a login may return to: the lobby, or the invite link the player is applying with (/?room=CODE). The path is
// bound to the OAuth state server-side, so the callback never redirects anywhere a request parameter names.
const RETURN_PATH = /^\/(\?room=[A-Z]{4})?$/;
export function requireOrigin(request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) throw new AccountError('ORIGIN_MISMATCH', 403);
}
export function configured(env) { return !!(env.SITES && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.AUTH_ORIGIN); }
export async function authenticate(request, env, {now = Date.now} = {}) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!env.SITES || !token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const sessionId = await hash(token);
  const session = await directoryOf(env).getSession(sessionId);
  return session && session.expiresAt > now() ? {...session, sessionId} : null;
}
// Accounts created before display names were stored can keep their existing session.
// Only legacy profiles need this lookup; an upstream outage must not break /api/me.
async function refreshLegacyProfile(user, env, providerFetch) {
  if (!user || user.githubLogin || !env.ACCOUNTS || !/^\d{1,20}$/.test(user.githubId)) return user;
  try {
    const response = await providerFetch('https://api.github.com/user/' + user.githubId, {headers: {
      Accept: 'application/vnd.github+json', 'User-Agent': 'Stronghold-Protocol'}, signal: AbortSignal.timeout(5000)});
    if (!response.ok) return user;
    const profile = await response.json();
    if (!Number.isSafeInteger(profile.id) || String(profile.id) !== user.githubId || typeof profile.login !== 'string') return user;
    const avatarUrl = typeof profile.avatar_url === 'string' && /^https:\/\/avatars\.githubusercontent\.com\//.test(profile.avatar_url) ? profile.avatar_url : null;
    const updated = await directoryOf(env).resolveGithubUser({id: user.githubId, login: profile.login.slice(0, 80), name: profile.name, avatarUrl});
    if (updated.accountId !== user.accountId) return user;
    await accountOf(env, user.accountId).setProfile(updated);
    return updated;
  } catch { return user; }
}
export async function handleAuth(request, env, {now = Date.now, fetch: providerFetch = globalThis.fetch} = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/auth/') && url.pathname !== '/api/me') return null;
  let returnTo = '/';
  try {
    if (url.pathname === '/api/me') {
      if (request.method !== 'GET') return json({error: 'METHOD'}, 405);
      const session = await authenticate(request, env, {now});
      const storedUser = session ? (env.ACCOUNTS ? await accountOf(env, session.accountId).getProfile() : session.user) : null;
      const user = await refreshLegacyProfile(storedUser, env, providerFetch);
      return json({user, capabilities: {accounts: configured(env),accountSystem:!!env.ACCOUNTS},
        application:session && env.ACCOUNTS ? await accountOf(env,session.accountId).getApplication() : null,
        activeSeat: session && env.ACCOUNTS ? await accountOf(env, session.accountId).getActiveSeat() : null});
    }
    if (!configured(env)) return json({error: 'AUTH_UNAVAILABLE'}, 503);
    if (url.origin !== env.AUTH_ORIGIN) return json({error: 'INVALID_ORIGIN'}, 400);
    const directory = directoryOf(env);
    if (url.pathname === '/api/auth/logout') {
      if (request.method !== 'POST') return json({error: 'METHOD'}, 405);
      requireOrigin(request);
      const session = await authenticate(request, env, {now});
      if (session) await directory.revokeSession(session.sessionId);
      return new Response(null, {status: 204, headers: {'Set-Cookie': cookie(SESSION_COOKIE, '', 0), 'Cache-Control': 'no-store'}});
    }
    if (request.method !== 'GET') return json({error: 'METHOD'}, 405);
    const callback = env.AUTH_ORIGIN + '/api/auth/github/callback';
    if (url.pathname === '/api/auth/github/start') {
      const returnPath = url.searchParams.get('return') ?? '/';
      if (!RETURN_PATH.test(returnPath)) throw new AccountError('BAD_RETURN_PATH');
      const state = randomToken(), verifier = randomToken();
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      const challenge = btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
      await directory.saveOAuth(await hash(state), {verifier, returnTo: returnPath, expiresAt: now() + ACCOUNT_LIMITS.oauthMs});
      const dest = new URL('https://github.com/login/oauth/authorize');
      dest.search = new URLSearchParams({client_id: env.GITHUB_CLIENT_ID, redirect_uri: callback, state,
        code_challenge: challenge, code_challenge_method: 'S256'}).toString();
      return new Response(null, {status: 302, headers: {Location: dest.href, 'Cache-Control': 'no-store', 'Set-Cookie': cookie(OAUTH_COOKIE, state, 600)}});
    }
    if (url.pathname !== '/api/auth/github/callback') return json({error: 'NOT_FOUND'}, 404);
    const state = url.searchParams.get('state');
    if (!state || !/^[a-f0-9]{64}$/.test(state) || state !== cookieValue(request, OAUTH_COOKIE)) throw new AccountError('OAUTH_STATE');
    const transaction = await directory.consumeOAuth(await hash(state));
    returnTo = transaction?.returnTo ?? '/';
    if (!transaction || transaction.expiresAt <= now() || url.searchParams.has('error')) throw new AccountError('OAUTH_EXPIRED_OR_DENIED');
    const code = url.searchParams.get('code');
    if (!code || code.length > 1024) throw new AccountError('OAUTH_CODE');
    const tokens = await providerFetch('https://github.com/login/oauth/access_token', {method: 'POST',
      headers: {Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET,
        code, code_verifier: transaction.verifier, redirect_uri: callback}).toString(), signal: AbortSignal.timeout(10000)});
    if (!tokens.ok) throw new AccountError('OAUTH_PROVIDER_FAILED', 502);
    const token = await tokens.json();
    if (typeof token.access_token !== 'string' || !token.access_token) throw new AccountError('OAUTH_PROVIDER_FAILED', 502);
    const response = await providerFetch('https://api.github.com/user', {headers: {
      Authorization: 'Bearer ' + token.access_token, Accept: 'application/vnd.github+json', 'User-Agent': 'Stronghold-Protocol'},
      signal: AbortSignal.timeout(10000)});
    if (!response.ok) throw new AccountError('OAUTH_PROVIDER_FAILED', 502);
    const profile = await response.json();
    if (!Number.isSafeInteger(profile.id) || profile.id <= 0 || typeof profile.login !== 'string') throw new AccountError('OAUTH_PROVIDER_FAILED', 502);
    const avatarUrl = typeof profile.avatar_url === 'string' && /^https:\/\/avatars\.githubusercontent\.com\//.test(profile.avatar_url) ? profile.avatar_url : null;
    const user = await directory.resolveGithubUser({id: String(profile.id), login: profile.login.slice(0, 80), name: profile.name, avatarUrl});
    if (env.ACCOUNTS) await accountOf(env, user.accountId).setProfile(user);
    const sessionToken = randomToken();
    await directory.saveSession(await hash(sessionToken), {accountId: user.accountId, user, expiresAt: now() + ACCOUNT_LIMITS.sessionMs});
    const headers = new Headers({Location: returnTo, 'Cache-Control': 'no-store'});
    headers.append('Set-Cookie', cookie(SESSION_COOKIE, sessionToken, ACCOUNT_LIMITS.sessionMs / 1000));
    headers.append('Set-Cookie', cookie(OAUTH_COOKIE, '', 0));
    return new Response(null, {status: 303, headers});
  } catch (e) {
    if (url.pathname === '/api/auth/github/callback' && request.headers.get('Accept')?.includes('text/html')) {
      // Back where the login started (an invite stays), with the notice that it did not complete.
      const back = new URL(returnTo, url.origin);
      back.searchParams.set('authError', '1');
      return new Response(null, {status: 303, headers: {Location: back.pathname + back.search, 'Cache-Control': 'no-store',
        'Set-Cookie': cookie(OAUTH_COOKIE, '', 0)}});
    }
    return json({error: e instanceof AccountError ? e.code : 'AUTH_FAILED'}, e instanceof AccountError ? e.status : 502);
  }
}
