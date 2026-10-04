import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './helpers/world.js';

// A socket keeps the login it was opened with: the Worker validates the session at the upgrade, the room checks its
// expiry locally and asks the directory again only when a check is due (once a minute), in the background. No message
// waits on the directory; a logout closes the sockets of that login with 4003 at the next check.

async function lobby(world, actor) {
  const route = (await world.api(actor, '/api/rooms', { method: 'POST' })).body;
  const player = await world.player(actor, route);
  assert.equal((await player.request('room.create', { mode: 'coop', difficulty: 'FUNNY' })).t, 'ok');
  return { route, player };
}

test('messages never wait on the directory; a logout closes the socket at the next check', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  await world.seed('a');
  const { route, player } = await lobby(world, 'a');

  const before = await world.lookups();
  for (let i = 0; i < 6; i++) {
    assert.equal((await player.request('room.ready', { ready: i % 2 === 0 })).t, 'ok');
    player.send({ t: 'ping', c: i + 1 });
    await player.wait('pong', (f) => f.c === i + 1);
  }
  assert.equal(await world.lookups(), before, 'no session lookup for 12 messages');

  // The player logs out elsewhere: messages still go through until the login is checked again.
  await world.logout('a');
  assert.equal((await player.request('room.ready', { ready: false })).t, 'ok');
  await world.room(route.code, 'logins-due');
  assert.deepEqual(await player.waitClosed(), { code: 4003, reason: 'login required' });

  // The seat waits for the player: logged in again, they resume it.
  await world.seed('a');
  const back = await world.player('a', { code: route.code, token: player.welcome.token });
  assert.equal(back.welcome.resumed, true);
  assert.equal((await back.wait('room.state')).seats[0].playerId, player.welcome.playerId);
});

test('a socket whose login expired closes at its next message', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  const seeded = Date.now();
  await world.seed('a', 4000);
  const { player } = await lobby(world, 'a');
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, seeded + 4100 - Date.now())));
  player.send({ t: 'ping', c: 1 });
  assert.deepEqual(await player.waitClosed(), { code: 4003, reason: 'login expired' });
});

test('a room woken from hibernation keeps its sockets without asking the directory', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  await world.seed('a');
  const { route, player } = await lobby(world, 'a');
  const before = await world.lookups();
  await world.evict(route.code);
  assert.equal((await player.request('room.ready', { ready: true })).t, 'ok');
  assert.equal((await player.wait('room.state', (f) => f.seats[0].ready)).seats[0].playerId, player.welcome.playerId);
  assert.equal(await world.lookups(), before);
});
