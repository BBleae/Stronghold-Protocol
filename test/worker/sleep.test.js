import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './helpers/world.js';

// A room writes only what changed. A match stays in memory while someone is connected to it; nobody connected, it
// sleeps until its next deadline (waking a sleeping match costs a full restore).

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a running match writes on change only and sleeps once its player has gone', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  await world.seed('a');
  const route = (await world.api('a', '/api/rooms', { method: 'POST' })).body;
  const player = await world.player('a', route);
  await player.request('room.create', { mode: 'solo', difficulty: 'FUNNY' });
  await player.request('room.start');
  assert.equal((await player.wait('m.public')).phase, 'INFO_CHECK');

  // The briefing has no timer, but its player is connected: the room stays in memory (a timer at most a minute away).
  const { timerAt } = await world.room(route.code, 'timer');
  assert.ok(timerAt > Date.now() && timerAt <= Date.now() + 60_000, `in-memory timer (${timerAt - Date.now()} ms)`);
  // Pings keep the socket alive without writing anything: nothing changed.
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
  await sleep(300);
  assert.equal((await world.room(route.code, 'timer')).timerAt, null, 'nothing keeps the room in memory');
  const alarm = await world.room(route.code, 'alarm');
  assert.ok(alarm > Date.now() + 23 * 3600_000, `the room wakes at the resume deadline, not before (${alarm - Date.now()} ms)`);

  // Wherever it slept, the player resumes the same run.
  await world.restart();
  const resumed = await world.player('a', { code: route.code, token: player.welcome.token });
  assert.equal(resumed.welcome.resumed, true);
  assert.equal((await resumed.wait('m.public')).phase, 'BAND_DRAFT');
});

test('a listed match nobody is connected to sleeps through its lobby lease; the next wake lists it again', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  await world.seed('a');
  const route = (await world.api('a', '/api/rooms', { method: 'POST' })).body;
  const player = await world.player('a', route);
  // A public co-op match with a lone human: its briefing has no timer (Match soloUntimed).
  await player.request('room.create', { mode: 'coop', difficulty: 'FUNNY' });
  await player.request('room.start');
  assert.equal((await player.wait('m.public')).phase, 'INFO_CHECK');
  // The lobby's listing of the room, once it shows `connectedHumans`.
  const listed = async (connectedHumans) => {
    for (let i = 0; i < 50; i++) {
      const room = (await world.api('a', '/api/rooms')).body.items.find((item) => item.roomId === route.code);
      if (room?.connectedHumans === connectedHumans) return room;
      await sleep(100);
    }
    assert.fail(`not listed with ${connectedHumans} connected`);
  };
  assert.equal((await listed(1)).inMatch, true);

  // The player's tab closes: the room may sleep. It wakes when the player's reconnect window ends, not to refresh
  // its listing (every 20 s while it stays in memory).
  const closedAt = Date.now();
  player.ws.close(1000, 'gone');
  await listed(0);
  // The disconnect's last step (the match's throttled public view) runs first.
  let timer;
  for (let i = 0; i < 50 && (timer = await world.room(route.code, 'timer')).timerAt != null; i++) await sleep(100);
  assert.equal(timer.timerAt, null);
  const alarm = await world.room(route.code, 'alarm');
  assert.ok(alarm > Date.now() + 9 * 60_000, `the room wakes at the end of the reconnect window (${alarm - Date.now()} ms)`);

  // The platform evicts it, and nothing wakes it (the log lines are read through another room).
  const restores = async () => (await world.room('WXYZ', 'logs'))
    .filter((line) => line.event === 'match_restored' && line.room === route.code).length;
  await world.evict(route.code);
  await sleep(closedAt + 25_000 - Date.now());
  assert.equal(await restores(), 0, 'not restored for a lease refresh');

  // The player comes back: the match is restored, and its wake publishes the listing again.
  const back = await world.player('a', { code: route.code, token: player.welcome.token });
  assert.equal(back.welcome.resumed, true);
  assert.equal((await back.wait('m.public')).phase, 'INFO_CHECK');
  assert.equal(await restores(), 1);
  assert.equal((await listed(1)).inMatch, true);
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
    await sleep(50);
  }
  assert.deepEqual(listed.map((room) => room.roomId), [route.code]);
  // The directory hides a listing a minute after its last refresh.
  const alarm = await world.room(route.code, 'alarm');
  assert.ok(alarm - Date.now() <= 20_000, `refresh within 20 s (${alarm - Date.now()} ms)`);

  assert.equal((await world.api('a', `/api/rooms/${route.code}/visibility`, { method: 'POST', body: { public: false } })).status, 200);
  for (let i = 0; i < 100 && listed.length; i++) {
    listed = (await world.api('a', '/api/rooms')).body.items;
    await sleep(50);
  }
  assert.deepEqual(listed, []);
});
