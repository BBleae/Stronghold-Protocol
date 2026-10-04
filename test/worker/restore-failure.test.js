import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './helpers/world.js';

// A room whose running match cannot be restored after a restart (deployment, eviction) ends that match as
// interrupted: its players learn why, keep no seat, and can create or join rooms at once.

async function soloMatch(world, actor) {
  const route = (await world.api(actor, '/api/rooms', { method: 'POST' })).body;
  const player = await world.player(actor, route);
  assert.equal((await player.request('room.create', { mode: 'solo', difficulty: 'FUNNY' })).t, 'ok');
  assert.equal((await player.request('room.start')).t, 'ok');
  await player.wait('m.public');
  return { code: route.code, token: player.welcome.token };
}

async function coopMatch(world, host, guest) {
  const route = (await world.api(host, '/api/rooms', { method: 'POST' })).body;
  const a = await world.player(host, route);
  await a.request('room.create', { mode: 'coop', difficulty: 'FUNNY' });
  const applications = `/api/rooms/${route.code}/applications`;
  const applied = await world.api(guest, applications, { method: 'POST', body: { action: 'apply' } });
  assert.equal(applied.status, 201);
  const approved = await world.api(host, applications, { method: 'POST', body: { action: 'approve', id: applied.body.id } });
  assert.equal(approved.status, 200);
  const b = await world.player(guest, { code: route.code, ticket: approved.body.ticket });
  assert.equal((await b.request('room.join', { code: route.code })).t, 'ok');
  assert.equal((await b.request('room.ready', { ready: true })).t, 'ok');
  assert.equal((await a.request('room.start')).t, 'ok');
  await a.wait('m.public');
  return { code: route.code, tokens: { [host]: a.welcome.token, [guest]: b.welcome.token } };
}

// The structured log lines of one room (every Durable Object of the fixture shares one isolate and its log).
const logged = async (world, code, event) => (await world.room(code, 'logs')).filter((line) => line.event === event && line.room === code);

async function history(world, actor) {
  for (let i = 0; i < 100; i++) {
    const { body } = await world.api(actor, '/api/me/matches');
    if (body.items.length) return body.items;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('the interrupted match never reached the history');
}

test('a match that cannot be restored ends as interrupted and frees every seat', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  const accounts = {};
  for (const actor of ['a', 'b', 'c', 'd', 'e']) accounts[actor] = (await world.seed(actor)).accountId;

  // a + b: co-op on a rules version this deployment does not know (a Cloudflare rollback).
  const rollback = await coopMatch(world, 'a', 'b');
  await world.room(rollback.code, 'put', { key: 'test-rewrite', value: { checkpoint: { rulesVersion: 'f'.repeat(20) } } });
  // c: a previous restore attempt never finished (the CPU or memory limit reset the object mid-replay).
  const unfinished = await soloMatch(world, 'c');
  await world.room(unfinished.code, 'put', { key: 'restore-attempts', value: 1 });
  // d: the replay throws (the stored log lost a row).
  const broken = await soloMatch(world, 'd');
  await world.room(broken.code, 'sql', { query: 'DELETE FROM match_events WHERE seq=(SELECT MAX(seq) FROM match_events)' });
  // e: nothing wrong.
  const healthy = await soloMatch(world, 'e');

  await world.restart();

  // Players who reconnect resume their session and are told why the match ended.
  for (const [actor, code, token, reason] of [['a', rollback.code, rollback.tokens.a, 'rollback'], ['b', rollback.code, rollback.tokens.b, 'rollback'],
    ['c', unfinished.code, unfinished.token, 'restart'], ['d', broken.code, broken.token, 'restart']]) {
    const player = await world.player(actor, { code, token });
    assert.equal(player.welcome.resumed, true);
    assert.equal((await player.wait('room.closed')).reason, reason, actor);
    assert.equal(player.frames.some((f) => f.t === 'm.public'), false);
  }

  // Nobody keeps a seat: the account pointers clear and every player can create a room again.
  for (const actor of ['a', 'b', 'c', 'd']) {
    assert.deepEqual((await world.api(actor, '/api/me/active-match')).body, { activeSeat: null }, actor);
    assert.equal(await world.account(accounts[actor], 'getActiveSeat'), null, actor);
  }
  assert.equal((await world.api('b', '/api/rooms', { method: 'POST' })).status, 201);

  // The participants' history records the interruption.
  for (const actor of ['a', 'b']) {
    const [item] = await history(world, actor);
    assert.equal(item.status, 'interrupted');
    assert.equal(item.mode, 'coop');
  }
  assert.equal((await world.api('b', '/api/me/stats')).body.interrupted, 1);

  // The operator sees why, with the context to act on it.
  const [rollbackLog] = await logged(world, rollback.code, 'match_restore_failed');
  assert.equal(rollbackLog.level, 'error');
  assert.deepEqual({ ...rollbackLog, error: rollbackLog.error.message, events: typeof rollbackLog.events },
    { level: 'error', event: 'match_restore_failed', room: rollback.code, rulesVersion: 'f'.repeat(20), events: 'number',
      attempts: 1, reason: 'rollback', error: 'CHECKPOINT_VERSION' });
  assert.equal((await logged(world, unfinished.code, 'match_restore_failed'))[0].error.message, 'RESTORE_UNFINISHED');
  assert.equal((await logged(world, unfinished.code, 'match_restore_failed'))[0].attempts, 2);
  assert.equal((await logged(world, broken.code, 'match_restore_failed'))[0].error.message, 'INCOMPLETE_MATCH_LOG');

  // Storage keeps neither the checkpoint, its log nor the attempt counter.
  for (const { code } of [rollback, unfinished, broken]) {
    assert.equal((await world.room(code, 'snapshot')).matchCheckpoint, undefined);
    assert.deepEqual(await world.room(code, 'sql', { query: 'SELECT COUNT(*) AS rows FROM match_events' }), [{ rows: 0 }]);
    assert.equal(await world.room(code, 'get', { key: 'restore-attempts' }), null);
  }

  // A healthy restore stays counted until the restored room serves another event.
  assert.equal(await world.room(healthy.code, 'get', { key: 'restore-attempts' }), 1);
  const resumed = await world.player('e', { code: healthy.code, token: healthy.token });
  assert.equal(resumed.welcome.resumed, true);
  assert.equal((await resumed.wait('m.public')).phase, 'INFO_CHECK');
  assert.equal(await world.room(healthy.code, 'get', { key: 'restore-attempts' }), null);
  assert.equal((await logged(world, healthy.code, 'match_restored')).length, 1);
});
