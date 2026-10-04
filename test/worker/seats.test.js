import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './helpers/world.js';

// An account's seat is a pointer its room confirms. A pointer the room no longer confirms never blocks the account,
// and a create whose reservation was never used goes on with that reservation.

test('room creation goes on with an unused reservation and is never blocked by a stale seat', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  const accounts = {};
  for (const actor of ['a', 'b', 'c']) accounts[actor] = (await world.seed(actor)).accountId;

  // a: the first connect after the reservation failed; creating again returns the same reservation.
  const first = await world.api('a', '/api/rooms', { method: 'POST' });
  assert.equal(first.status, 201);
  const again = await world.api('a', '/api/rooms', { method: 'POST' });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, first.body);
  const host = await world.player('a', again.body);
  assert.equal((await host.request('room.create', { mode: 'coop', difficulty: 'FUNNY' })).t, 'ok');
  assert.equal((await host.wait('room.state')).seats[0].playerId, host.welcome.playerId);
  // A seat in a live room still blocks a second room.
  assert.deepEqual(await world.api('a', '/api/rooms', { method: 'POST' }), { status: 409, body: { error: 'ALREADY_SEATED' } });

  // b: left its room; the pointer it still holds is released by the next create.
  const left = (await world.api('b', '/api/rooms', { method: 'POST' })).body;
  const player = await world.player('b', left);
  await player.request('room.create', { mode: 'solo', difficulty: 'FUNNY' });
  assert.equal((await player.request('room.leave')).t, 'ok');
  assert.equal((await world.account(accounts.b, 'getActiveSeat')).roomId, left.code, 'the pointer outlives the room');
  const created = await world.api('b', '/api/rooms', { method: 'POST' });
  assert.equal(created.status, 201);
  assert.equal((await world.account(accounts.b, 'getActiveSeat')).roomId, created.body.code);

  // c: same stale pointer, then an application elsewhere.
  const stale = (await world.api('c', '/api/rooms', { method: 'POST' })).body;
  const leaver = await world.player('c', stale);
  await leaver.request('room.create', { mode: 'solo', difficulty: 'FUNNY' });
  await leaver.request('room.leave');
  const applied = await world.api('c', `/api/rooms/${first.body.code}/applications`, { method: 'POST', body: { action: 'apply' } });
  assert.equal(applied.status, 201);
  assert.equal(await world.account(accounts.c, 'getActiveSeat'), null);
});

test('an approval ends with its room: the applicant is never left seated', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  const guest = (await world.seed('b')).accountId;
  await world.seed('a');
  const route = (await world.api('a', '/api/rooms', { method: 'POST' })).body;
  const host = await world.player('a', route);
  await host.request('room.create', { mode: 'coop', difficulty: 'FUNNY' });
  const applied = await world.api('b', `/api/rooms/${route.code}/applications`, { method: 'POST', body: { action: 'apply' } });
  const approved = await world.api('a', `/api/rooms/${route.code}/applications`, { method: 'POST', body: { action: 'approve', id: applied.body.id } });
  assert.equal(approved.body.status, 'approved');
  assert.equal((await world.api('b', '/api/me/active-match')).body.activeSeat.roomId, route.code);

  // The host leaves before the guest joins: the room is gone, and with it the approval.
  assert.equal((await host.request('room.leave')).t, 'ok');
  const listed = await world.api('b', `/api/rooms/${route.code}/applications`);
  assert.equal(listed.status, 404);
  assert.deepEqual((await world.api('b', '/api/me/active-match')).body, { activeSeat: null });
  assert.equal(await world.account(guest, 'getActiveSeat'), null, 'the read released the pointer');
  assert.equal((await world.api('b', '/api/rooms', { method: 'POST' })).status, 201);
});

test('a create that failed does not block applying elsewhere: applying gives the reservation up', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  await world.seed('a');
  const guest = (await world.seed('b')).accountId;
  const failed = (await world.api('b', '/api/rooms', { method: 'POST' })).body; // never connected
  const route = (await world.api('a', '/api/rooms', { method: 'POST' })).body;
  const host = await world.player('a', route);
  await host.request('room.create', { mode: 'coop', difficulty: 'FUNNY' });

  const applied = await world.api('b', `/api/rooms/${route.code}/applications`, { method: 'POST', body: { action: 'apply' } });
  assert.equal(applied.status, 201);
  assert.equal(await world.account(guest, 'getActiveSeat'), null);
  assert.equal((await world.room(failed.code, 'snapshot'))?.reservation ?? null, null, 'the reservation is gone from its room');
  const approved = await world.api('a', `/api/rooms/${route.code}/applications`, { method: 'POST', body: { action: 'approve', id: applied.body.id } });
  assert.equal(approved.status, 200);
  assert.equal((await world.account(guest, 'getActiveSeat')).roomId, route.code);
});

test('approving an applicant who took a seat elsewhere ends the application and tells the host', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  await world.seed('a');
  await world.seed('b');
  const route = (await world.api('a', '/api/rooms', { method: 'POST' })).body;
  const host = await world.player('a', route);
  await host.request('room.create', { mode: 'coop', difficulty: 'FUNNY' });
  const applications = `/api/rooms/${route.code}/applications`;
  const applied = await world.api('b', applications, { method: 'POST', body: { action: 'apply' } });
  // Meanwhile the applicant creates a room of its own.
  const own = (await world.api('b', '/api/rooms', { method: 'POST' })).body;
  const player = await world.player('b', own);
  assert.equal((await player.request('room.create', { mode: 'solo', difficulty: 'FUNNY' })).t, 'ok');

  const approved = await world.api('a', applications, { method: 'POST', body: { action: 'approve', id: applied.body.id } });
  assert.deepEqual(approved, { status: 409, body: { error: 'APPLICANT_BUSY' } });
  const seen = await world.api('b', applications);
  assert.equal(seen.body.items.find((item) => item.id === applied.body.id).status, 'expired');
});

test('a takeover gives the seat a new token: the device it replaced cannot take the seat back', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  await world.seed('a');
  const route = (await world.api('a', '/api/rooms', { method: 'POST' })).body;
  const first = await world.player('a', route);
  await first.request('room.create', { mode: 'solo', difficulty: 'FUNNY' });
  await first.request('room.start');
  const old = first.welcome.token;

  // 继续对局 on a second device.
  const resume = (await world.api('a', '/api/me/resume', { method: 'POST' })).body;
  const second = await world.player('a', { code: resume.code, ticket: resume.ticket });
  assert.equal(second.welcome.resumed, true);
  assert.equal(second.welcome.playerId, first.welcome.playerId);
  assert.notEqual(second.welcome.token, old);
  assert.deepEqual(await first.waitClosed(), { code: 4001, reason: 'session replaced' });

  // The first device wakes up and reconnects with the token it had: it is told it was replaced.
  const stale = await world.socket('a', { code: route.code });
  stale.send({ t: 'hello', name: 'Player a', token: old });
  assert.deepEqual(await stale.waitClosed(), { code: 4001, reason: 'session replaced' });
  assert.equal(stale.frames.some((f) => f.t === 'welcome'), false);
  assert.equal(second.closed, null, 'the device that took over keeps the seat');
  const again = await world.player('a', { code: route.code, token: second.welcome.token });
  assert.equal(again.welcome.resumed, true);
});
