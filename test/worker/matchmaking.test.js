// 匹配 in the production Worker (DESIGN §28.2), in workerd: two signed-in accounts queue over POST /api/queue, the
// group's host opens a room the normal way and reports it, the member gets the code and joins through a join
// application the host approves — the same requests the lobby page makes (public/js/room-net.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './helpers/world.js';
import { QUEUE } from '../../worker/matchmaker.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('matchmaking in the Worker: queue, host opens and reports its room, the member is approved in', { timeout: 120_000 }, async (t) => {
  const world = await createWorld(t);
  for (const actor of ['a', 'b']) await world.seed(actor);
  const queue = (actor, body) => world.api(actor, '/api/queue', { method: 'POST', body });

  assert.equal((await queue('a', { action: 'nope' })).status, 400);
  assert.equal((await queue('a', { action: 'join', difficulty: 'IMPOSSIBLE' })).status, 400);
  const a1 = await queue('a', { action: 'join', difficulty: 'NORMAL' });
  assert.equal(a1.status, 200);
  assert.equal(a1.body.waiting, true);
  const b1 = await queue('b', { action: 'join', difficulty: 'NORMAL' });
  assert.deepEqual([b1.body.waiting, b1.body.count], [true, 2]);

  await sleep(QUEUE.graceMs + 200);
  const host = (await queue('a', { action: 'poll', difficulty: 'NORMAL' })).body;
  assert.equal(host.matched.role, 'host');
  assert.equal(host.matched.code, null);
  assert.equal(host.matched.expect, 2);
  assert.equal(host.matched.members.length, 1);
  const memberId = host.matched.members[0];
  assert.equal((await queue('b', { action: 'poll', difficulty: 'NORMAL' })).body.waiting, true, 'the member waits for the room');

  // the host opens the room as any player does, then reports it
  const reserved = (await world.api('a', '/api/rooms', { method: 'POST' })).body;
  const hostPlayer = await world.player('a', reserved);
  assert.equal((await hostPlayer.request('room.create', { mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  assert.equal((await queue('b', { action: 'hosted', code: reserved.code })).status, 400, 'only the host reports');
  const other = reserved.code === 'ZZZZ' ? 'YYYY' : 'ZZZZ';
  assert.equal((await queue('a', { action: 'hosted', code: other })).status, 400, 'only the room the host sits in');
  assert.equal((await queue('a', { action: 'hosted', code: reserved.code })).body.matched.code, reserved.code);

  const member = (await queue('b', { action: 'poll', difficulty: 'NORMAL' })).body;
  assert.deepEqual(member, { waiting: false, matched: { role: 'member', difficulty: 'NORMAL', code: reserved.code } });

  // the member applies like an invite; the host approves exactly its group's account
  const applications = `/api/rooms/${reserved.code}/applications`;
  const applied = await world.api('b', applications, { method: 'POST', body: { action: 'apply' } });
  assert.equal(applied.status, 201);
  const listed = (await world.api('a', applications)).body.items;
  const item = listed.find((x) => x.accountId === memberId && x.status === 'pending');
  assert.ok(item, 'the host sees the matched account applying');
  const approved = await world.api('a', applications, { method: 'POST', body: { action: 'approve', id: item.id } });
  const guest = await world.player('b', { code: reserved.code, ticket: approved.body.ticket });
  assert.equal((await guest.request('room.join', { code: reserved.code })).t, 'ok');
  assert.equal((await guest.request('room.ready', { ready: true })).t, 'ok');
  const seats = hostPlayer.frames.filter((f) => f.t === 'room.state').at(-1).seats.filter(Boolean);
  assert.equal(seats.length, 2);

  // a seat in a live room keeps its account out of the queue (as it does from applying elsewhere)
  assert.equal((await queue('a', { action: 'join', difficulty: 'NORMAL' })).status, 409);
  assert.equal((await queue('b', { action: 'leave' })).body.waiting, false);
});
