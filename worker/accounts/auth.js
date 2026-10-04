// Logins. An account signs in with its username and password, or with GitHub (worker/accounts/github.js) where that
// is available; either way the browser gets a session cookie. A session is { accountId, expiresAt } (sessions saved
// before kept a copy of the profile, `user`: it is never read — what shows an account reads its profile).

import { ACCOUNT_LIMITS, AccountError, USERNAME_PATTERN, validPassword } from '../../shared/account-protocol.js';
import { readJson, networkKey, within } from '../http.js';
import { hashPassword, verifyPassword, outdated } from './passwords.js';
import { parseNickname } from './names.js';

const SESSION_COOKIE = '__Host-sp_session';
export const directoryOf = env => env.SITES.get(env.SITES.idFromName('directory'));
export const accountOf = (env, id) => env.ACCOUNTS.get(env.ACCOUNTS.idFromName(id));
export const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
export function cookieValue(request, key) {
  return (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(key + '='))?.slice(key.length + 1) || null;
}
export const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
export async function hash(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
export const cookie = (key, value, seconds) => key + '=' + value + '; Path=/; Max-Age=' + seconds + '; Secure; HttpOnly; SameSite=Lax';
export function requireOrigin(request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) throw new AccountError('ORIGIN_MISMATCH', 403);
}

/** Whether an administrator request carries `secret` (≥ 32 characters) as its bearer token; compared by digest. */
export async function bearerAuthorized(request, secret) {
  const supplied = request.headers.get('Authorization')?.replace(/^Bearer /, '');
  return !!secret && secret.length >= 32 && !!supplied && await hash(supplied) === await hash(secret);
}

export async function authenticate(request, env, {now = Date.now} = {}) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!env.SITES || !token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const sessionId = await hash(token);
  const session = await directoryOf(env).getSession(sessionId);
  return session && session.expiresAt > now() ? {...session, sessionId} : null;
}

/** A new login session of `accountId`: the Set-Cookie header that gives it to the browser. */
export async function startSession(env, accountId, now = Date.now) {
  const token = randomToken();
  await directoryOf(env).saveSession(await hash(token), { accountId, expiresAt: now() + ACCOUNT_LIMITS.sessionMs });
  return cookie(SESSION_COOKIE, token, ACCOUNT_LIMITS.sessionMs / 1000);
}

/**
 * The rate limit key of a username's login attempts (any case) from the client's network. Each network counts its
 * own attempts: a stranger's guesses never use up those of the player, so nobody can lock a player out.
 */
export const usernameKey = (request, username) => 'username:' + username.toLowerCase() + '@' + networkKey(request);

/**
 * POST /api/auth/register {username, password, nickname} and /api/auth/login {username, password}: the account's
 * profile ({ user }) and a session cookie. POST /api/auth/logout. Credential attempts count against their own limits
 * (wrangler.jsonc ratelimits): registrations and logins per network, and logins of one username per network
 * (RATE_LIMITED).
 */
export async function handleAuth(request, env, { now = Date.now } = {}) {
  const url = new URL(request.url);
  if (!['/api/auth/register', '/api/auth/login', '/api/auth/logout'].includes(url.pathname)) return null;
  if (request.method !== 'POST') return json({ error: 'METHOD' }, 405);
  requireOrigin(request);
  const directory = directoryOf(env);
  if (url.pathname === '/api/auth/logout') {
    const session = await authenticate(request, env, { now });
    if (session) await directory.revokeSession(session.sessionId);
    return new Response(null, { status: 204, headers: { 'Set-Cookie': cookie(SESSION_COOKIE, '', 0), 'Cache-Control': 'no-store' } });
  }
  if (url.pathname === '/api/auth/register') {
    if (!(await within(env.REGISTER_LIMIT, networkKey(request)))) throw new AccountError('RATE_LIMITED', 429);
    const body = await readJson(request, 4096);
    if (typeof body.username !== 'string' || !USERNAME_PATTERN.test(body.username)) throw new AccountError('INVALID_USERNAME');
    if (!validPassword(body.password)) throw new AccountError('INVALID_PASSWORD');
    const nickname = parseNickname(body.nickname);
    const accountId = crypto.randomUUID();
    const user = await accountOf(env, accountId).register({ accountId, username: body.username, password: await hashPassword(body.password), nickname });
    return json({ user }, 201, { 'Set-Cookie': await startSession(env, accountId, now) });
  }
  if (!(await within(env.LOGIN_LIMIT, networkKey(request)))) throw new AccountError('RATE_LIMITED', 429);
  const { username, password } = await readJson(request, 4096);
  if (typeof username !== 'string' || typeof password !== 'string') throw new AccountError('BAD_MSG');
  const wellFormed = USERNAME_PATTERN.test(username);
  if (wellFormed && !(await within(env.USERNAME_LIMIT, usernameKey(request, username)))) throw new AccountError('RATE_LIMITED', 429);
  // An unknown username is answered like a wrong password, and as late: its check derives a hash all the same.
  const user = wellFormed ? await directory.localUser(username) : null;
  if (!(await verifyPassword(password, user?.password ?? null))) throw new AccountError('BAD_CREDENTIALS', 401);
  if (outdated(user.password)) await directory.updatePassword(user.accountId, await hashPassword(password));
  const profile = await accountOf(env, user.accountId).getProfile();
  return json({ user: profile }, 200, { 'Set-Cookie': await startSession(env, user.accountId, now) });
}
