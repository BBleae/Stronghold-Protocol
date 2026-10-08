// 在线人数 (presence counters) in workerd, with the production bundle: rooms report to the presence board in the
// Matchmaker (worker/presence.js), the 匹配 queue's waiting pages count as online, GET /healthz carries the sums, and a
// room's sessions get them as the `presence` frame; a room that closes withdraws its report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './helpers/world.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `read` until `ok` holds (the reports go out in the background, after each event's commit). */
async function until(read, ok, label) {
  let last;
  for (let i = 0; i < 250; i++) {
    last = await read();
    if (ok(last)) return last;
    await sleep(20);
  }
  assert.fail(`${label}: ${JSON.stringify(last)}`);
}

test('rooms and the queue add up on the presence board; /healthz and the presence frame carry the sums', { timeout: 120_000 }, async (t) => {
  const world = await createWorld(t);
  for (const actor of ['a', 'b', 'c']) await world.seed(actor);
  assert.deepEqual(await world.presence(), { online: 0, inRoom: 0, rooms: 0, queued: 0 });

  // the host: one socket, then a seat
  const route = (await world.api('a', '/api/rooms', { method: 'POST' })).body;
  const host = await world.player('a', route);
  await until(world.presence, (p) => p.online === 1 && p.inRoom === 0, 'the host\'s socket');
  assert.equal((await host.request('room.create', { mode: 'coop', difficulty: 'FUNNY' })).t, 'ok');
  await until(world.presence, (p) => p.online === 1 && p.inRoom === 1 && p.rooms === 1, 'the host\'s seat');

  // a guest the host approved
  const applications = `/api/rooms/${route.code}/applications`;
  const applied = await world.api('b', applications, { method: 'POST', body: { action: 'apply' } });
  const approved = await world.api('a', applications, { method: 'POST', body: { action: 'approve', id: applied.body.id } });
  const guest = await world.player('b', { code: route.code, ticket: approved.body.ticket });
  assert.equal((await guest.request('room.join', { code: route.code })).t, 'ok');
  await until(world.presence, (p) => p.online === 2 && p.inRoom === 2, 'host and guest');
  // the room's sessions get the sums as the presence frame
  await host.wait('presence', (f) => f.online === 2 && f.inRoom === 2);

  // a page waiting in the 匹配 queue holds no socket: online, not in a room
  assert.equal((await world.api('c', '/api/queue', { method: 'POST', body: { action: 'join', difficulty: 'NORMAL' } })).status, 200);
  assert.deepEqual(await world.presence(), { online: 3, inRoom: 2, rooms: 1, queued: 1 });
  // /healthz: the same sums (its first read in this isolate goes past the cache to the board)
  const health = (await world.api('a', '/healthz')).body;
  assert.equal(health.ok, true);
  assert.deepEqual([health.online, health.inRoom], [3, 2]);
  await world.api('c', '/api/queue', { method: 'POST', body: { action: 'leave' } });
  assert.equal((await world.presence()).queued, 0);

  // down again: the guest leaves, then the host; the room closes and withdraws its report at once
  assert.equal((await guest.request('room.leave')).t, 'ok');
  guest.ws.close(1000, 'left');
  await until(world.presence, (p) => p.online === 1 && p.inRoom === 1, 'the guest left');
  assert.equal((await host.request('room.leave')).t, 'ok');
  host.ws.close(1000, 'left');
  await until(world.presence, (p) => p.online === 0 && p.inRoom === 0 && p.rooms === 0, 'the room closed');

  for (const socket of [host, guest]) {
    for (const frame of socket.frames.filter((f) => f.t === 'presence')) {
      assert.ok(Number.isInteger(frame.online) && Number.isInteger(frame.inRoom), `a frame carries numbers: ${JSON.stringify(frame)}`);
    }
  }
});
