// POST /api/queue — 匹配 (matchmaking, DESIGN §28.2) in account mode: the page polls its place in the queue
// (worker/matchmaker.js) every 1.5 s while it waits. Body `{ action: 'join'|'poll'|'leave'|'hosted', difficulty?, code? }`
// ('join' is the 匹配 click and starts over, 'poll' keeps the account's place); the answer is the account's queue status
// (`matched` once a group was formed). Only the game's own page, signed in; counted against QUEUE_LIMIT per network.
import { authenticate, json, requireOrigin } from '../accounts/auth.js';
import { AccountError } from '../../shared/account-protocol.js';
import { readJson } from '../http.js';
import { seatOf } from '../accounts/routes.js';

export const QUEUE_PATH = '/api/queue';

export async function handleQueueRoutes(request, env) {
  if (new URL(request.url).pathname !== QUEUE_PATH) return null;
  if (request.method !== 'POST') return json({ error: 'METHOD' }, 405);
  requireOrigin(request);
  const session = await authenticate(request, env);
  if (!session) return json({ error: 'LOGIN_REQUIRED' }, 401);
  if (!env.MATCHMAKER) throw new AccountError('NOT_FOUND', 404);
  const body = await readJson(request, 512);
  if (!body || typeof body !== 'object' || !['join', 'poll', 'leave', 'hosted'].includes(body.action)) throw new AccountError('BAD_MSG');
  // Entering the queue is refused from a seat in a live room, like applying to another room (worker/rooms/routes.js):
  // a reservation the account never used does not count (the group's host creates its room from the menu).
  if (body.action === 'join') {
    const seat = await seatOf(env, session.accountId);
    if (seat && !seat.reserved) throw new AccountError('ALREADY_SEATED', 409);
  }
  // The host reports only the room it sits in (it created it from the menu): never someone else's room, where the
  // group's members would otherwise apply.
  if (body.action === 'hosted') {
    const seat = await seatOf(env, session.accountId);
    if (!seat || seat.reserved || seat.activeSeat?.roomId !== body.code) throw new AccountError('BAD_TARGET');
  }
  const queue = env.MATCHMAKER.get(env.MATCHMAKER.idFromName('queue'));
  const response = await queue.fetch(new Request('https://queue.internal/_queue', {
    method: 'POST',
    headers: { 'X-Account-ID': session.accountId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: body.action, difficulty: body.difficulty, code: body.code }),
  }));
  const out = await response.json();
  if (out.error) throw new AccountError(out.error, response.status);
  return json(out);
}
