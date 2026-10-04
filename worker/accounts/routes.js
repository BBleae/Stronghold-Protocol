import { authenticate, accountOf, directoryOf, json, requireOrigin, usernameKey } from './auth.js';
import { AccountError, validPassword } from '../../shared/account-protocol.js';
import { validatePreferencePatch } from '../../public/js/preferenceSchema.js';
import { readJson, networkKey, within } from '../http.js';
import { githubEnabled } from './github.js';
import { parseNickname } from './names.js';
import { hashPassword, verifyPassword } from './passwords.js';

async function preferenceBody(request) {
  const body = await readJson(request, 65536, 'INVALID_PREFERENCES');
  if (Object.keys(body).some(k => !['accountId','patch','initialize'].includes(k))
    || (body.initialize !== undefined && typeof body.initialize !== 'boolean')) throw new AccountError('INVALID_PREFERENCES');
  validatePreferencePatch(body.patch);
  return body;
}
export async function clearStaleApplication(env,accountId) {
  const account=accountOf(env,accountId),pending=await account.getApplication();
  if(!pending)return;
  const response=await env.ROOMS.get(env.ROOMS.idFromName(pending.roomId)).fetch(new Request('https://room.internal/_applications',{headers:{'X-Account-ID':accountId}}));
  if(response.status===404){await account.clearApplication(pending.roomId,pending.id);return;}
  if(!response.ok)throw new Error('APPLICATION_UNAVAILABLE');
  const body=await response.json();
  if(!body.items.some(x=>x.id===pending.id && ['pending','approved'].includes(x.status)))await account.clearApplication(pending.roomId,pending.id);
}

// Seats. An account points at the seat it holds (activeSeat: room code, room generation, claim id); the room is the
// truth about it. A pointer its room no longer confirms (the room ended, its reservation expired, an approval
// lapsed, a restore interrupted the match) is released by whoever reads it next, so it never blocks the account.

/**
 * The account's seat as its room confirms it, or null. GET reads it: { activeSeat, status, reserved }, and the
 * reservation's ticket when `reserved`. POST (resume) hands out a ticket to connect with, a takeover ticket for a seat
 * (stored by the room for 30 s): { code, generation, ticket, join, reserved }. `reserved`: the seat is a reservation
 * the account has not used yet (no room.create).
 */
export async function seatOf(env, accountId, method = 'GET') {
  const account = accountOf(env, accountId);
  const seat = await account.getActiveSeat();
  if (!seat) return null;
  const room = env.ROOMS.get(env.ROOMS.idFromName(seat.roomId));
  const response = await room.fetch(new Request('https://room.internal/_account', {
    method, headers: { 'X-Account-ID': accountId, 'X-Room-Generation': seat.roomGeneration } }));
  if (response.status === 404) {
    await account.releaseSeat({ claimId: seat.claimId });
    return null;
  }
  if (!response.ok) throw new Error(`room ${seat.roomId} answered ${response.status} for a seat`);
  return response.json();
}

/**
 * The account gives up its seat if it is a reservation it never used (a create that failed before room.create):
 * the room drops the reservation and the pointer is released. Resolves false when the seat is a real one (or became
 * one meanwhile).
 */
export async function giveUpReservation(env, accountId) {
  const account = accountOf(env, accountId);
  const seat = await account.getActiveSeat();
  if (!seat) return true;
  const room = env.ROOMS.get(env.ROOMS.idFromName(seat.roomId));
  const response = await room.fetch(new Request('https://room.internal/_account', {
    method: 'DELETE', headers: { 'X-Account-ID': accountId, 'X-Room-Generation': seat.roomGeneration } }));
  if (response.status === 409) return false;
  if (!response.ok && response.status !== 404) throw new Error(`room ${seat.roomId} answered ${response.status} to a reservation given up`);
  await account.releaseSeat({ claimId: seat.claimId });
  return true;
}

const METHODS = { '/api/me': 'GET', '/api/me/active-match': 'GET', '/api/me/resume': 'POST', '/api/me/preferences': ['GET', 'POST'],
  '/api/me/nickname': 'POST', '/api/me/password': 'POST' };

/**
 * The signed-in account's routes. GET /api/me: its profile (null when signed out), the sign-in methods offered
 * (password always, GitHub when it can work: worker/accounts/github.js), its join application and seat. Its seat
 * (GET /api/me/active-match, POST /api/me/resume) and preferences. POST /api/me/nickname {nickname}: its 博士代号 →
 * { user }. POST /api/me/password {current, password} (password accounts): a new password; the account's other
 * sessions end. A password check counts as a login attempt (RATE_LIMITED).
 */
export async function handleAccountRoutes(request, env, deps = {}) {
  const path = new URL(request.url).pathname;
  if (!Object.hasOwn(METHODS, path)) return null;
  if (![METHODS[path]].flat().includes(request.method)) return json({ error: 'METHOD' }, 405);
  if (request.method === 'POST') requireOrigin(request);
  const session = await authenticate(request, env);
  const account = session && accountOf(env, session.accountId);
  if (path === '/api/me') {
    const [user, application, activeSeat, github] = await Promise.all([account?.getProfile() ?? null,
      account?.getApplication() ?? null, account?.getActiveSeat() ?? null, githubEnabled(env, deps)]);
    return json({ user, capabilities: { password: true, github }, application, activeSeat });
  }
  if (!session) return json({ error: 'LOGIN_REQUIRED' }, 401);
  if (path === '/api/me/preferences') {
    if (request.method === 'GET') return json({accountId:session.accountId,preferences:await account.getPreferences()});
    const body = await preferenceBody(request);
    // A tab left open under another account must not write using its replacement session cookie.
    if (body.accountId !== session.accountId) return json({error:'ACCOUNT_CHANGED'},409);
    return json({accountId:session.accountId,preferences:await account.savePreferences(body.patch,body.initialize === true)});
  }
  if (path === '/api/me/nickname') {
    const body = await readJson(request, 4096);
    return json({ user: await account.rename(parseNickname(body.nickname)) });
  }
  if (path === '/api/me/password') {
    const { current, password } = await readJson(request, 4096);
    if (typeof current !== 'string') throw new AccountError('BAD_MSG');
    if (!validPassword(password)) throw new AccountError('INVALID_PASSWORD');
    const profile = await account.getProfile();
    if (profile.provider !== 'password') throw new AccountError('NO_PASSWORD', 409);
    if (!(await within(env.LOGIN_LIMIT, networkKey(request))) || !(await within(env.USERNAME_LIMIT, usernameKey(request, profile.username)))) {
      throw new AccountError('RATE_LIMITED', 429);
    }
    const directory = directoryOf(env);
    if (!(await verifyPassword(current, await directory.passwordOf(session.accountId)))) throw new AccountError('WRONG_PASSWORD', 403);
    await directory.changePassword(session.accountId, await hashPassword(password), session.sessionId);
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }
  return json((await seatOf(env, session.accountId, request.method)) ?? { activeSeat: null });
}
