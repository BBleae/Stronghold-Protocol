import { authenticate, accountOf, directoryOf, json, requireOrigin } from '../accounts/auth.js';
import { AccountError } from '../../shared/account-protocol.js';
import { clearStaleApplication, giveUpReservation, seatOf } from '../accounts/routes.js';
import { errorResponse, readJson, accountKey, within, tooMany } from '../http.js';
import { logWarn, errorFields } from '../log.js';
// The application states that hold something on the applicant's account: its application record, and once approved
// its seat (worker/accounts/account.js). An application in any other state holds neither.
const LIVE = ['pending', 'approved'];
export async function handleLobbyRoutes(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/api/rooms' && request.method === 'GET') {
    const cursor = url.searchParams.get('cursor') || '';
    return json(await directoryOf(env).listRooms({ cursor, limit: Number(url.searchParams.get('limit') || 20) }));
  }
  const match = /^\/api\/rooms\/([A-Z]{4})\/(applications|visibility)$/.exec(url.pathname);
  if (!match) return null;
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'METHOD' }, 405);
  if (request.method === 'POST') requireOrigin(request);
  const session = await authenticate(request, env);
  if (!session) return json({ error: 'LOGIN_REQUIRED' }, 401);
  // Applying, cancelling and deciding count against the account too: a stranger who changes networks is still one.
  if (request.method === 'POST' && !(await within(env.APPLICATION_LIMIT, accountKey(session.accountId))))
    return tooMany();
  const body = request.method === 'POST' ? await readJson(request, 2048) : null;
  const headers = { 'X-Account-ID': session.accountId, 'Content-Type': 'application/json' };
  if (body?.action === 'apply') {
    // A seat in a live room blocks applying elsewhere; a reservation the account never used (a create that failed)
    // does not: applying gives it up.
    const seat = await seatOf(env, session.accountId);
    const free = !seat || (seat.reserved && (await giveUpReservation(env, session.accountId)));
    if (!free) return json({ error: 'ALREADY_SEATED' }, 409);
    await clearStaleApplication(env, session.accountId);
    // The host sees the application under the account's display name, read here (not in the room's critical section).
    headers['X-Account-Name'] = encodeURIComponent((await accountOf(env, session.accountId).getProfile()).name);
  }
  const room = env.ROOMS.get(env.ROOMS.idFromName(match[1]));
  return room.fetch(
    new Request('https://room.internal/_' + match[2], {
      method: request.method,
      headers,
      body: body && JSON.stringify(body),
    }),
  );
}
export async function roomApplications(rt, request, env) {
  const accountId = request.headers.get('X-Account-ID'),
    room = rt.lobby.getRoom(rt.code);
  if (!room || room.mode !== 'coop') return json({ error: 'ROOM_NOT_FOUND' }, 404);
  const host = rt.registry.byId(room.hostId)?.accountId,
    queue = rt.applications;
  const account = accountOf(env, accountId);
  const path = new URL(request.url).pathname;
  // An account call that only tidies up after the room has decided. What it would remove blocks nothing if it stays:
  // whoever reads it next drops it (clearStaleApplication an application record the room no longer lists as pending
  // or approved, seatOf a seat the room does not confirm). So a failure is logged, and the room's answer stands.
  const tidy = async (action, op, call) => {
    try {
      await call();
    } catch (error) {
      logWarn('application_cleanup_failed', { room: rt.code, action, op, error: errorFields(error) });
    }
  };
  try {
    if (path === '/_visibility') {
      if (accountId !== host) throw new AccountError('NOT_HOST', 403);
      if (request.method === 'POST') {
        const body = await request.json();
        if (typeof body.public !== 'boolean') throw new AccountError('BAD_MSG');
        rt.publicRoom = body.public;
        if (!body.public) queue.invalidate();
      }
      return json({ public: rt.publicRoom });
    }
    if (request.method === 'GET') {
      const items = queue.list(accountId === host ? null : accountId).map((item) => {
        const value = { ...item };
        if (item.accountId !== accountId) delete value.ticket;
        return value;
      });
      return json({ items, host: accountId === host, public: rt.publicRoom });
    }
    const body = await request.json();
    if (body.action === 'apply') {
      if (room.match) throw new AccountError('ROOM_STARTED', 409);
      if (room.seats.filter((x) => !x).length <= queue.reservedCount()) throw new AccountError('ROOM_FULL', 409);
      const claimed = await account.claimApplication({ roomId: rt.code, expiresAt: Date.now() + 120000 });
      if (!claimed.ok) throw new AccountError(claimed.error, 409);
      let item;
      try {
        item = queue.apply({ accountId, name: decodeURIComponent(request.headers.get('X-Account-Name') ?? '') });
        const linked = await account.claimApplication({ roomId: rt.code, id: item.id, expiresAt: item.expiresAt });
        if (!linked.ok) throw new AccountError(linked.error, 409);
        return json(item, 201);
      } catch (e) {
        // The room's item ends before the account's record is cleared (a call that can fail too): a pending item
        // without its record could still be approved after the account applied elsewhere, and the record is what
        // limits an account to one application at a time.
        if (item?.status === 'pending') queue.drop(item.id);
        await account.clearApplication(rt.code);
        throw e;
      }
    }
    if (body.action === 'cancel') {
      const live = queue.list(accountId).some((x) => x.id === body.id && LIVE.includes(x.status));
      const item = queue.cancel(accountId, body.id);
      // An application that already ended (expired, rejected, dropped, cancelled; room.start ends every one, so this
      // is all a running match has) has nothing to give back: what it may have left on the account is dropped by its
      // next reader (as for tidy), so no account is called from inside the room's critical section.
      if (!live) return json(item);
      await account.releaseSeat({ claimId: item.id });
      await account.clearApplication(rt.code);
      return json(item);
    }
    if (body.action !== 'approve' && body.action !== 'reject') throw new AccountError('BAD_MSG');
    if (accountId !== host) throw new AccountError('NOT_HOST', 403);
    const item = queue.list().find((x) => x.id === body.id);
    if (!item || item.status !== 'pending') throw new AccountError('APPLICATION_EXPIRED', 409);
    const applicant = accountOf(env, item.accountId);
    if (body.action === 'approve') {
      // A plain claim: validating a stale seat would call another room from inside this room's critical section.
      // The applicant's seat was validated when they applied (handleLobbyRoutes).
      const claim = await applicant.claimSeat({
        claimId: item.id,
        seat: { roomId: rt.code, roomGeneration: rt.generation, matchId: null, seatId: null },
      });
      if (!claim.ok) {
        // The applicant took a seat elsewhere since applying: the application is over, and the host is told why.
        queue.drop(item.id);
        throw new AccountError('APPLICANT_BUSY', 409);
      }
      let approved;
      try {
        approved = queue.decide(accountId, item.id, 'approved', {
          hostId: host,
          inMatch: !!room.match,
          freeSeats: room.seats.filter((x) => !x).length,
        });
      } catch (e) {
        // Nothing was approved (ROOM_FULL…): the application stays pending, for the host to approve again once a seat
        // is free, and the claim is given back. A claim left behind is not one the room confirms (seatOf releases it).
        await tidy('approve', 'releaseSeat', () => applicant.releaseSeat({ claimId: item.id }));
        throw e;
      }
      // The ticket is issued and the account's seat already points here (claimSeat came first), so the account
      // cannot take a seat elsewhere while the approval holds: what is left to clear is only its application record.
      await tidy('approve', 'clearApplication', () => applicant.clearApplication(rt.code));
      return json(approved);
    }
    const rejected = queue.decide(accountId, item.id, 'rejected', { hostId: host, inMatch: !!room.match });
    await tidy('reject', 'clearApplication', () => applicant.clearApplication(rt.code));
    return json(rejected);
  } catch (error) {
    // Inside the room's critical section: an error thrown from here would reset the room, so it becomes the answer.
    return errorResponse(error, { room: rt.code, path });
  }
}
