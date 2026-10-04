import { authenticate, accountOf, json, requireOrigin } from './auth.js';
import { AccountError } from '../../shared/account-protocol.js';
import { validatePreferencePatch } from '../../public/js/preferenceSchema.js';
import { readJson } from '../http.js';

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
 * The account's seat as its room confirms it, or null. GET answers { activeSeat, status, reserved }; POST (resume)
 * also hands out a ticket to connect with: { code, generation, ticket, join, reserved }. `reserved`: the seat is a
 * reservation the account has not used yet (no room.create).
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

export async function handleAccountRoutes(request, env) {
  const path = new URL(request.url).pathname;
  if (!['/api/me/active-match','/api/me/resume','/api/me/preferences'].includes(path)) return null;
  const preferences = path === '/api/me/preferences';
  if (preferences ? !['GET','POST'].includes(request.method) : request.method !== (path.endsWith('/resume') ? 'POST' : 'GET')) return json({error:'METHOD'},405);
  if (request.method === 'POST') requireOrigin(request);
  const session = await authenticate(request,env);
  if (!session) return json({error:'LOGIN_REQUIRED'},401);
  const account = accountOf(env,session.accountId);
  if (preferences) {
    if (request.method === 'GET') return json({accountId:session.accountId,preferences:await account.getPreferences()});
    const body = await preferenceBody(request);
    // A tab left open under another account must not write using its replacement session cookie.
    if (body.accountId !== session.accountId) return json({error:'ACCOUNT_CHANGED'},409);
    return json({accountId:session.accountId,preferences:await account.savePreferences(body.patch,body.initialize === true)});
  }
  return json((await seatOf(env, session.accountId, request.method)) ?? { activeSeat: null });
}
