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
  await world.seed('a', 4000);
  // Read after the seed returns: the Worker set the expiry from its own clock somewhere during the seed (several
  // object calls, a second or more under a loaded test run), so a time read before it could run ahead of the expiry
  // and the ping below arrive while the login is still valid.
  const seeded = Date.now();
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

test('a failed login check is logged once, closes nothing, and is retried after its backoff', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  await world.seed('a');
  // A solo room: no lobby listing to refresh, so the room's next wake is the retry.
  const route = (await world.api('a', '/api/rooms', { method: 'POST' })).body;
  const player = await world.player('a', route);
  assert.equal((await player.request('room.create', { mode: 'solo', difficulty: 'FUNNY' })).t, 'ok');

  await world.failDirectory('getSession');
  await world.room(route.code, 'logins-due');
  const failures = async () => (await world.room(route.code, 'logs'))
    .filter((line) => line.event === 'login_check_failed' && line.room === route.code);
  let lines = [];
  for (let i = 0; i < 100 && !lines.length; i++) {
    lines = await failures();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const [line] = lines;
  assert.deepEqual({ level: line.level, sessions: line.sessions, attempts: line.attempts }, { level: 'warn', sessions: 1, attempts: 1 });
  assert.ok(line.retryAt - Date.now() > 20_000 && line.retryAt - Date.now() <= 30_000, 'first retry after 30 s');

  // Messages in the meantime neither ask the directory again nor close the socket. The room wakes for the retry (an
  // alarm armed earlier, here the socket's hello timeout, wakes it first and re-arms).
  const lookups = await world.lookups();
  for (let i = 0; i < 3; i++) {
    player.send({ t: 'ping', c: i + 1 });
    await player.wait('pong', (f) => f.c === i + 1);
  }
  assert.equal(await world.lookups(), lookups);
  assert.equal((await failures()).length, 1);
  assert.equal(player.closed, null);
  const alarm = await world.room(route.code, 'alarm');
  assert.ok(alarm > Date.now() && alarm <= line.retryAt, `alarm ${alarm - line.retryAt} ms from the retry`);

  // The directory is back, and the player logged out meanwhile: the retry closes the socket.
  await world.failDirectory('getSession', false);
  await world.logout('a');
  await world.room(route.code, 'retries-due');
  assert.deepEqual(await player.waitClosed(), { code: 4003, reason: 'login required' });
});
