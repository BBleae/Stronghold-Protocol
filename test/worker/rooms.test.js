import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RoomRuntime } from '../../worker/room-runtime.js';
import { RoomDurableObject } from '../../worker/index.js';

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  frames = [];
  send(data) { this.frames.push(JSON.parse(data)); }
  close(code, reason) { this.closed = { code, reason }; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(1008, 'terminated'); }
  take(type) { return this.frames.filter((f) => f.t === type).at(-1); }
}
// A room reserved for the account 'owner'.
function setup(t, code = 'ABCD') {
  let at = 1000;
  const rt = new RoomRuntime({ now: () => at });
  t.after(() => rt.lobby.shutdown());
  const ticket = rt.reserve(code, 'owner');
  return { rt, ticket, advance(ms) { at += ms; }, now: () => at };
}
function connect(rt, accountId, { ticket, token, ip = '8.8.8.8' } = {}) {
  const ws = new Socket();
  rt.connect(ws, { ip, ticket, accountId });
  rt.message(ws, JSON.stringify({ t: 'hello', name: accountId, token, rid: 1 }));
  return ws;
}
const send = (rt, ws, msg) => rt.message(ws, JSON.stringify(msg));
// The host approves `accountId`'s application: its ticket joins the room.
function approve(rt, accountId) {
  const item = rt.applications.apply({ accountId, name: accountId });
  const room = rt.lobby.getRoom(rt.code);
  return rt.applications.decide('owner', item.id, 'approved', { hostId: 'owner', inMatch: !!room.match,
    freeSeats: room.seats.filter((x) => !x).length }).ticket;
}

test('only the reservation owner creates; the room code stays fixed; a token never crosses rooms', (t) => {
  const a = setup(t);
  const b = setup(t, 'EFGH');
  const stranger = connect(a.rt, 'stranger');
  send(a.rt, stranger, { t: 'room.create', mode: 'coop', difficulty: 'FUNNY', rid: 2 });
  assert.equal(stranger.take('error').code, 'NOT_HOST');
  assert.equal(a.rt.status(), null);
  const stolen = connect(a.rt, 'stranger', { ticket: a.ticket });
  send(a.rt, stolen, { t: 'room.create', mode: 'coop', difficulty: 'FUNNY', rid: 2 });
  assert.equal(stolen.take('error').code, 'NOT_HOST', 'the ticket is the owner account\'s');
  const owner = connect(a.rt, 'owner', { ticket: a.ticket });
  const token = owner.take('welcome').token;
  assert.match(token, /^ABCD\.[0-9a-f]{32}$/);
  send(a.rt, owner, { t: 'room.create', mode: 'coop', difficulty: 'FUNNY', rid: 3 });
  assert.equal(owner.take('room.state').code, 'ABCD');
  assert.deepEqual(a.rt.status(), { code: 'ABCD', mode: 'coop', inMatch: false, full: false });
  const cross = connect(b.rt, 'owner', { ticket: b.ticket, token });
  assert.equal(cross.take('welcome').resumed, false);
  assert.notEqual(cross.take('welcome').playerId, owner.take('welcome').playerId);
});

test('lobby hibernation restores seats, sessions and the reservation\'s capability', (t) => {
  const s = setup(t);
  const owner = connect(s.rt, 'owner', { ticket: s.ticket });
  const token = owner.take('welcome').token;
  const awake = new RoomRuntime({ snapshot: s.rt.snapshot(), now: s.now });
  t.after(() => awake.lobby.shutdown());
  const resumed = connect(awake, 'owner', { token });
  assert.equal(resumed.take('welcome').resumed, true);
  // the page resuming a session that has no room yet is told so; creating again finishes the reservation
  assert.equal(resumed.take('room.closed').reason, 'unfinished');
  send(awake, resumed, { t: 'room.create', mode: 'coop', difficulty: 'FUNNY', rid: 3 });
  assert.equal(resumed.take('room.state').code, 'ABCD');
  const guest = connect(awake, 'guest', { ticket: approve(awake, 'guest') });
  send(awake, guest, { t: 'room.join', code: 'ABCD', rid: 4 });
  send(awake, guest, { t: 'room.ready', ready: true, rid: 5 });
  const restored = new RoomRuntime({ snapshot: awake.snapshot(), now: s.now });
  t.after(() => restored.lobby.shutdown());
  const again = connect(restored, 'guest', { token: guest.take('welcome').token });
  assert.equal(again.take('welcome').resumed, true);
  const state = again.take('room.state');
  assert.equal(state.seats.filter(Boolean).length, 2);
  assert.equal(state.seats[1].ready, true);
  assert.equal(restored.network.heartbeatTimer, undefined);
  assert.equal(restored.lobby.graceTimers.size, 0);
});

test('disconnect grace and an abandoned reservation expire by the alarm, without JS timers', (t) => {
  const s = setup(t);
  const ws = connect(s.rt, 'owner', { ticket: s.ticket });
  send(s.rt, ws, { t: 'room.create', mode: 'coop', difficulty: 'FUNNY', rid: 2 });
  const token = ws.take('welcome').token;
  ws.close(1000, 'leave');
  assert.equal(s.rt.status().code, 'ABCD');
  s.advance(60_001);
  s.rt.sweep();
  assert.equal(s.rt.status(), null);
  const resumed = connect(s.rt, 'owner', { token });
  assert.equal(resumed.take('room.closed').reason, 'timeout');
  resumed.close(1000, 'leave');
  s.advance(600_001);
  s.rt.sweep();
  assert.equal(s.rt.isEmpty(), true);
  const unused = setup(t, 'JKLM');
  unused.advance(120_001);
  unused.rt.sweep();
  assert.equal(unused.rt.isEmpty(), true);
});

test('seats are limited to the room and frames to 64 KiB', (t) => {
  const s = setup(t);
  const owner = connect(s.rt, 'owner', { ticket: s.ticket });
  send(s.rt, owner, { t: 'room.create', mode: 'coop', difficulty: 'FUNNY', rid: 2 });
  for (let n = 0; n < 3; n++) {
    const guest = connect(s.rt, `guest${n}`, { ticket: approve(s.rt, `guest${n}`), ip: `9.9.9.${n}` });
    send(s.rt, guest, { t: 'room.join', code: 'ABCD', rid: n + 3 });
  }
  assert.equal(s.rt.status().full, true);
  assert.throws(() => approve(s.rt, 'late'), /ROOM_FULL/);
  s.rt.message(owner, 'x'.repeat(65_537));
  assert.equal(owner.closed.code, 1009);
});

test('an active match resumes an ordinary disconnect', (t) => {
  const s = setup(t);
  const owner = connect(s.rt, 'owner', { ticket: s.ticket });
  send(s.rt, owner, { t: 'room.create', mode: 'solo', difficulty: 'FUNNY', rid: 2 });
  send(s.rt, owner, { t: 'room.start', rid: 3 });
  assert.equal(s.rt.status().inMatch, true);
  assert.equal(owner.take('m.public').phase, 'INFO_CHECK');
  const token = owner.take('welcome').token;
  owner.close(1000, 'drop');
  const resumed = connect(s.rt, 'owner', { token });
  assert.equal(resumed.take('welcome').resumed, true);
  assert.ok(resumed.take('m.private'));
});

test('a disconnected solo match keeps its 24-hour resume window when the alarm sweeps it', (t) => {
  const s = setup(t);
  const owner = connect(s.rt, 'owner', { ticket: s.ticket });
  send(s.rt, owner, { t: 'room.create', mode: 'solo', difficulty: 'FUNNY', rid: 2 });
  send(s.rt, owner, { t: 'room.start', rid: 3 });
  const token = owner.take('welcome').token;
  owner.close(1000, 'drop');
  s.advance(600_001);
  s.rt.sweep();
  assert.equal(s.rt.status().inMatch, true);
  const resumed = connect(s.rt, 'owner', { token });
  assert.equal(resumed.take('welcome').resumed, true);
  resumed.close(1000, 'drop');
  s.advance(86_400_001);
  s.rt.sweep();
  assert.equal(s.rt.status(), null);
  assert.equal(s.rt.registry.size, 0);
});

test('sockets per network and idle sessions stay bounded', (t) => {
  const s = setup(t);
  // A member's network has 8 sockets (a stranger's 3: test/worker/spectators.test.js).
  const sockets = Array.from({ length: 9 }, () => {
    const ws = new Socket();
    s.rt.connect(ws, { ip: '8.8.8.8', accountId: 'owner' });
    return ws;
  });
  assert.equal(sockets[8].closed.code, 1013);
  assert.equal(s.rt.network.connectionCount, 8);
  for (const ws of sockets) ws.close(1000, 'done');
  for (let i = 0; i < 50; i++) connect(s.rt, `churn${i}`).close(1000, 'churn');
  assert.equal(s.rt.registry.size, 32);
});

test('platform automatic heartbeats keep hibernating sessions alive when the idle alarm runs', (t) => {
  const s = setup(t);
  const ws = connect(s.rt, 'owner', { ticket: s.ticket });
  s.advance(90_001);
  RoomDurableObject.prototype.refreshAutoResponses.call({ runtime: s.rt,
    sockets: new Map([[{}, ws]]), ctx: { getWebSocketAutoResponseTimestamp: () => new Date(s.now() - 1000) } });
  s.rt.sweep();
  assert.equal(ws.readyState, 1);
  assert.equal(s.rt.network.connectionCount, 1);
});
