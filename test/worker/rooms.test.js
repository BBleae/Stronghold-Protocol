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
function setup(code = 'ABCD') {
  let at = 1000;
  const rt = new RoomRuntime({ now: () => at });
  const ticket = rt.reserve(code);
  return { rt, ticket, advance(ms) { at += ms; }, now: () => at };
}
function connect(rt, ticket, token, name = 'Test') {
  const ws = new Socket();
  rt.connect(ws, { ip: '8.8.8.8', ticket });
  rt.message(ws, JSON.stringify({ t: 'hello', name, token, rid: 1 }));
  return ws;
}
const send = (rt, ws, msg) => rt.message(ws, JSON.stringify(msg));

test('only reservation owner can create; room code stays fixed; tokens cannot cross rooms', () => {
  const a = setup();
  const b = setup('EFGH');
  const stranger = connect(a.rt);
  send(a.rt, stranger, { t: 'room.create', mode: 'coop', difficulty: 'FUNNY', rid: 2 });
  assert.equal(stranger.take('error').code, 'NOT_HOST');
  assert.equal(a.rt.status(), null);
  const owner = connect(a.rt, a.ticket);
  const token = owner.take('welcome').token;
  assert.match(token, /^ABCD\.[0-9a-f]{32}$/);
  send(a.rt, owner, { t: 'room.create', mode: 'coop', difficulty: 'FUNNY', rid: 3 });
  assert.equal(owner.take('room.state').code, 'ABCD');
  assert.deepEqual(a.rt.status(), { code: 'ABCD', mode: 'coop', inMatch: false, full: false });
  const cross = connect(b.rt, b.ticket, token);
  assert.equal(cross.take('welcome').resumed, false);
  assert.notEqual(cross.take('welcome').playerId, owner.take('welcome').playerId);
  send(a.rt, stranger, { t: 'room.join', code: 'EFGH', rid: 4 });
  assert.equal(stranger.take('error').code, 'ROOM_NOT_FOUND');
});

test('lobby hibernation restores seats, sessions and original reservation capability', () => {
  const s = setup();
  const owner = connect(s.rt, s.ticket);
  const token = owner.take('welcome').token;
  const snapshot = s.rt.snapshot();
  const awake = new RoomRuntime({ snapshot, now: s.now });
  const resumed = connect(awake, undefined, token);
  assert.equal(resumed.take('welcome').resumed, true);
  send(awake, resumed, { t: 'room.create', mode: 'coop', difficulty: 'FUNNY', rid: 3 });
  assert.equal(resumed.take('room.state').code, 'ABCD');
  const guest = connect(awake);
  send(awake, guest, { t: 'room.join', code: 'ABCD', rid: 4 });
  send(awake, guest, { t: 'room.ready', ready: true, rid: 5 });
  const restored = new RoomRuntime({ snapshot: awake.snapshot(), now: s.now });
  const again = connect(restored, undefined, guest.take('welcome').token);
  assert.equal(again.take('welcome').resumed, true);
  const state = again.take('room.state');
  assert.equal(state.seats.filter(Boolean).length, 2);
  assert.equal(state.seats[1].ready, true);
  assert.equal(restored.network.heartbeatTimer, undefined);
  assert.equal(restored.lobby.graceTimers.size, 0);
});

test('disconnect grace and abandoned reservation expire by alarm without keeping JS timers alive', () => {
  const s = setup();
  const ws = connect(s.rt, s.ticket);
  send(s.rt, ws, { t: 'room.create', mode: 'coop', difficulty: 'FUNNY', rid: 2 });
  const token = ws.take('welcome').token;
  ws.close(1000, 'leave');
  assert.equal(s.rt.status().code, 'ABCD');
  s.advance(60_001);
  s.rt.sweep();
  assert.equal(s.rt.status(), null);
  const resumed = connect(s.rt, undefined, token);
  assert.equal(resumed.take('room.closed').reason, 'timeout');
  resumed.close(1000, 'leave');
  s.advance(600_001);
  s.rt.sweep();
  assert.equal(s.rt.isEmpty(), true);
  const unused = setup('JKLM');
  unused.advance(120_001);
  unused.rt.sweep();
  assert.equal(unused.rt.isEmpty(), true);
});

test('same-room capacity and 64 KiB frame limit are enforced through the existing protocol', () => {
  const s = setup();
  const owner = connect(s.rt, s.ticket);
  send(s.rt, owner, { t: 'room.create', mode: 'coop', difficulty: 'FUNNY', rid: 2 });
  for (let n = 0; n < 4; n++) {
    const guest = connect(s.rt);
    send(s.rt, guest, { t: 'room.join', code: 'ABCD', rid: n + 3 });
    if (n === 3) assert.equal(guest.take('error').code, 'ROOM_FULL');
  }
  assert.equal(s.rt.status().full, true);
  s.rt.message(owner, 'x'.repeat(65_537));
  assert.equal(owner.closed.code, 1009);
});

test('active matches resume ordinary disconnects; restoring only persisted metadata explicitly resets them', () => {
  const s = setup();
  const owner = connect(s.rt, s.ticket);
  send(s.rt, owner, { t: 'room.create', mode: 'solo', difficulty: 'FUNNY', rid: 2 });
  send(s.rt, owner, { t: 'room.start', rid: 3 });
  assert.equal(s.rt.status().inMatch, true);
  assert.equal(owner.take('m.public').phase, 'INFO_CHECK');
  const token = owner.take('welcome').token;
  owner.close(1000, 'drop');
  const resumed = connect(s.rt, undefined, token);
  assert.equal(resumed.take('welcome').resumed, true);
  assert.ok(resumed.take('m.private'));
  const restarted = new RoomRuntime({ snapshot: s.rt.snapshot(), now: s.now });
  const fresh = connect(restarted, undefined, token);
  assert.equal(fresh.take('welcome').resumed, false);
  assert.equal(fresh.take('room.closed').reason, 'restart');
  assert.equal(restarted.status(), null);
  s.rt.lobby.shutdown();
});

test('a disconnected solo match keeps its existing 24-hour resume window when platform alarms sweep it', () => {
  const s = setup();
  const owner = connect(s.rt, s.ticket);
  send(s.rt, owner, { t: 'room.create', mode: 'solo', difficulty: 'FUNNY', rid: 2 });
  send(s.rt, owner, { t: 'room.start', rid: 3 });
  const token = owner.take('welcome').token;
  owner.close(1000, 'drop');
  s.advance(600_001);
  s.rt.sweep();
  assert.equal(s.rt.status().inMatch, true);
  const resumed = connect(s.rt, undefined, token);
  assert.equal(resumed.take('welcome').resumed, true);
  resumed.close(1000, 'drop');
  s.advance(86_400_001);
  s.rt.sweep();
  assert.equal(s.rt.status(), null);
  assert.equal(s.rt.registry.size, 0);
  s.rt.lobby.shutdown();
});

test('per-IP sockets and idle session churn remain bounded', () => {
  const s = setup();
  const sockets = Array.from({ length: 9 }, () => connect(s.rt));
  assert.equal(sockets[8].closed.code, 1013);
  assert.equal(s.rt.network.connectionCount, 8);
  for (const ws of sockets) ws.close(1000, 'done');
  for (let i = 0; i < 50; i++) connect(s.rt).close(1000, 'churn');
  assert.equal(s.rt.registry.size, 32);
});

test('platform automatic heartbeats keep hibernating sessions alive when the idle alarm runs', () => {
  const s = setup();
  const ws = connect(s.rt, s.ticket);
  s.advance(90_001);
  RoomDurableObject.prototype.refreshAutoResponses.call({ runtime: s.rt,
    sockets: new Map([[{}, ws]]), ctx: { getWebSocketAutoResponseTimestamp: () => new Date(s.now() - 1000) } });
  s.rt.sweep();
  assert.equal(ws.readyState, 1);
  assert.equal(s.rt.network.connectionCount, 1);
});
