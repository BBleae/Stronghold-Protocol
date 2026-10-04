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
