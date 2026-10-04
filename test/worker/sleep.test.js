import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './helpers/world.js';

// A room writes only what changed, and a match nobody is connected to sleeps until its next deadline.

test('a running match writes on change only and sleeps once its player has gone', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  await world.seed('a');
  const route = (await world.api('a', '/api/rooms', { method: 'POST' })).body;
  const player = await world.player('a', route);
  await player.request('room.create', { mode: 'solo', difficulty: 'FUNNY' });
  await player.request('room.start');
  assert.equal((await player.wait('m.public')).phase, 'INFO_CHECK');

  // Pings keep the socket alive without writing anything: the briefing has no timer and nothing changed.
  const before = await world.room(route.code, 'writes');
  for (let i = 0; i < 5; i++) {
    player.send({ t: 'ping', c: i + 1 });
    await player.wait('pong', (f) => f.c === i + 1);
  }
  assert.deepEqual(await world.room(route.code, 'writes'), before);
  // A change is written.
  assert.equal((await player.request('g.infoReady')).t, 'ok');
  assert.ok((await world.room(route.code, 'writes')).transactions > before.transactions);

  // The player leaves the untimed band draft: nothing is due until the solo run's 24-hour resume window ends.
  await player.wait('m.public', (f) => f.phase === 'BAND_DRAFT');
  player.ws.close(1000, 'gone');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const alarm = await world.room(route.code, 'alarm');
  assert.ok(alarm > Date.now() + 23 * 3600_000, `the room wakes at the resume deadline, not before (${alarm - Date.now()} ms)`);

  // Wherever it slept, the player resumes the same run.
  await world.restart();
  const resumed = await world.player('a', { code: route.code, token: player.welcome.token });
  assert.equal(resumed.welcome.resumed, true);
  assert.equal((await resumed.wait('m.public')).phase, 'BAND_DRAFT');
});

test('a room the public lobby shows wakes to refresh its listing; made private, it leaves the lobby at once', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  await world.seed('a');
  const route = (await world.api('a', '/api/rooms', { method: 'POST' })).body;
  const host = await world.player('a', route);
  await host.request('room.create', { mode: 'coop', difficulty: 'FUNNY' });
  let listed = [];
  for (let i = 0; i < 100 && !listed.length; i++) {
    listed = (await world.api('a', '/api/rooms')).body.items;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(listed.map((room) => room.roomId), [route.code]);
  // The directory hides a listing a minute after its last refresh.
  const alarm = await world.room(route.code, 'alarm');
  assert.ok(alarm - Date.now() <= 20_000, `refresh within 20 s (${alarm - Date.now()} ms)`);

  assert.equal((await world.api('a', `/api/rooms/${route.code}/visibility`, { method: 'POST', body: { public: false } })).status, 200);
  for (let i = 0; i < 100 && listed.length; i++) {
    listed = (await world.api('a', '/api/rooms')).body.items;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(listed, []);
});
