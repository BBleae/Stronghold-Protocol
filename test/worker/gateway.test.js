// The node-protocol gateway at runtime level: a Node client's own handshake (hello without
// a room code, in-band room.create/join/ready/start) against the lobby DO's engine — the
// exact message flow the APK's embedded client sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LobbyRuntime, GATEWAY_LIMITS } from '../../worker/lobby-gateway.js';

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  frames = [];
  send(data) { this.frames.push(JSON.parse(data)); }
  close(code, reason) { this.closed = { code, reason }; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(1008, 'terminated'); }
  take(type) { return this.frames.filter((f) => f.t === type).at(-1); }
}

function setup() {
  let at = 1000;
  const rt = new LobbyRuntime({ now: () => at });
  return { rt, advance(ms) { at += ms; }, now: () => at };
}
function join(rt, name, ip = '8.8.8.8') {
  const ws = new Socket();
  rt.connect(ws, { ip });
  rt.message(ws, JSON.stringify({ t: 'hello', name, rid: 1 }));
  return ws;
}
const send = (rt, ws, msg, rid) => rt.message(ws, JSON.stringify({ ...msg, rid: rid ?? ++send.seq }));
send.seq = 1;

test('a Node client names itself in hello, creates a room and starts a match over one socket', async (t) => {
  const { rt, advance } = setup();
  t.after(() => rt.lobby.shutdown());
  const host = join(rt, '博士A');
  const welcome = host.take('welcome');
  assert.ok(welcome, 'welcome answers the hello');
  assert.equal(welcome.name, '博士A');
  assert.match(welcome.token, /^[0-9a-f]{32}$/, 'the node token shape (no room prefix)');
  assert.equal(welcome.version, 1);
  send(rt, host, { t: 'room.create', mode: 'coop', difficulty: 'FUNNY' });
  const state = host.take('room.state');
  assert.equal(state.inMatch, false);
  assert.equal(rt.lobby.stats().rooms, 1);

  const guest = join(rt, '博士B', '9.9.9.9');
  send(rt, guest, { t: 'room.join', code: state.code });
  assert.ok(guest.take('room.state'), 'the joiner sees the room');
  send(rt, host, { t: 'room.ready', ready: true });
  send(rt, guest, { t: 'room.ready', ready: true });
  send(rt, host, { t: 'room.start' });
  const started = host.take('room.state');
  assert.equal(started.inMatch, true, 'the lobby started a match');
  assert.ok(host.frames.some((f) => f.t === 'm.public'), 'the match broadcasts to the host');
  assert.ok(guest.frames.some((f) => f.t === 'm.public'), '…and to the guest');

  // The snapshot carries everything a wake needs back.
  const snapshot = rt.snapshot();
  assert.equal(snapshot.rooms.length, 1);
  assert.equal(snapshot.sessions.length, 2);
  assert.ok(snapshot.rooms[0].matchCheckpoint, 'the running match persists a checkpoint');
  // A room that goes away (host leaves the match… too slow for this test) — instead check
  // that a restored runtime from the snapshot keeps the room and its seat map intact.
  const revived = new LobbyRuntime({ snapshot, now: () => Date.now() });
  t.after(() => revived.lobby.shutdown());
  assert.equal(revived.lobby.getRoom(state.code).seats.filter(Boolean).length, 2);
  advance(0);
});

test('a wrong protocol version is refused at hello; a socket that never says hello times out', (t) => {
  const { rt, advance } = setup();
  t.after(() => rt.lobby.shutdown());
  const wrong = new Socket();
  rt.connect(wrong, { ip: '8.8.8.8' });
  rt.message(wrong, JSON.stringify({ t: 'hello', name: 'x', version: 99, rid: 1 }));
  assert.equal(wrong.take('error').code, 'BAD_MSG');
  assert.equal(wrong.take('welcome'), undefined);
  const quiet = new Socket();
  rt.connect(quiet, { ip: '8.8.8.8' }); // never says hello
  advance(GATEWAY_LIMITS.helloTimeoutMs + 1);
  rt.sweep();
  assert.equal(quiet.closed?.code, 4002, 'hello timeout');
});

test('connection limits: a flooding network is refused past the per-address cap', (t) => {
  const { rt } = setup();
  t.after(() => rt.lobby.shutdown());
  const sockets = [];
  let refused = 0;
  for (let i = 0; i <= GATEWAY_LIMITS.socketsPerAddr; i++) {
    const ws = new Socket();
    rt.connect(ws, { ip: '7.7.7.7' });
    if (ws.closed) refused++;
    sockets.push(ws);
  }
  assert.equal(refused, 1, 'the socketsPerAddr-th socket is refused with a close');
  assert.equal(sockets.at(-1).closed.code, 1013, 'try again later');
});

test('the gateway speaks the lobby rules: room codes are the node alphabet, tokens resume', (t) => {
  const { rt } = setup();
  t.after(() => rt.lobby.shutdown());
  const host = join(rt, '房主');
  const token = host.take('welcome').token;
  send(rt, host, { t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
  const code = host.take('room.state').code;
  assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/, 'the node CODE_ALPHABET');
  // A dropped socket resumes the same session with its token, and lands back in the room.
  host.close(1006, 'drop');
  const back = new Socket();
  rt.connect(back, { ip: '8.8.8.8' });
  rt.message(back, JSON.stringify({ t: 'hello', name: '房主', token, rid: 1 }));
  const resumed = back.take('welcome');
  assert.equal(resumed.resumed, true);
  assert.ok(back.take('room.state'), 'the room state follows the resumed hello');
});

test('a session that does not return after a wake disconnects like its socket closed (no eternal 100 ms alarm)', (t) => {
  // The review blocker: a session saved connected whose socket did not survive the restart
  // must run Lobby.onDisconnect (seat disconnect / grace / match onDisconnect) at the wake.
  // Without it isExpired never sees a disconnectedAt, nextAlarm clamps to now+100 forever,
  // and the room's seat never frees (the object wakes and commits every 100 ms).
  const { rt } = setup();
  t.after(() => rt.lobby.shutdown());
  const host = join(rt, '房主');
  send(rt, host, { t: 'room.create', mode: 'coop', difficulty: 'FUNNY' });
  const room = rt.lobby.getRoom(host.take('room.state').code);
  const code = room.code;
  const snapshot = rt.snapshot();

  // Wake from the snapshot with NO sockets (a deployment closed them all), like load() does.
  // One mutable clock for the whole wake (registry, network and lobby all capture it).
  let at2 = Date.now();
  const revived = new LobbyRuntime({ snapshot, now: () => at2 });
  t.after(() => revived.lobby.shutdown());
  revived.reconcileSockets();
  const session = revived.registry.byId(host.take('welcome').playerId);
  assert.equal(session.connected, false);
  assert.notEqual(session.disconnectedAt, null, 'the wake marked the session disconnected');
  const revivedRoom = revived.lobby.getRoom(code);
  assert.equal(revivedRoom.seatOf(session.playerId).connected, false, 'the seat shows disconnected (grace started)');
  const next = revived.nextAlarm();
  assert.ok(next > at2 + 1000, `the next wake is a real deadline, not now+100 (got +${next - at2} ms)`);

  // The client that never comes back expires with the window; the empty room clears.
  at2 += revived.registry.reconnectWindowMs + 1000;
  revived.sweep();
  assert.ok(!revived.registry.byId(session.playerId), 'the session expired after its window');
  assert.equal(revived.lobby.rooms.size, 0, 'the empty room is gone');
});

test('a spectator takes a seat, rides the snapshot, and its grace expires like a player seat', (t) => {
  const { rt, advance } = setup();
  t.after(() => rt.lobby.shutdown());
  const host = join(rt, '房主');
  send(rt, host, { t: 'room.create', mode: 'coop', difficulty: 'FUNNY' });
  const code = host.take('room.state').code;
  const watcher = join(rt, '观众', '9.9.9.9');
  send(rt, watcher, { t: 'room.spectate', code });
  assert.ok(watcher.frames.some((f) => f.t === 'ok'), 'spectate answers ok');
  const room = rt.lobby.getRoom(code);
  assert.equal(room.spectators.length, 1, 'one spectator seat taken');

  // The snapshot carries it; a wake restores the seat.
  const snapshot = rt.snapshot();
  assert.deepEqual(snapshot.rooms[0].spectators.map((s) => s.name), ['观众']);
  const revived = new LobbyRuntime({ snapshot, now: () => Date.now() });
  t.after(() => revived.lobby.shutdown());
  assert.equal(revived.lobby.getRoom(code).spectators.length, 1);

  // The disconnected spectator starts its grace (upstream v0.1.3 calls startGrace for spectator
  // seats) and expires through the GatewayLobby deadline map.
  watcher.close(1006, 'drop');
  rt.sweep();
  const spectatorId = room.spectators[0].playerId;
  assert.ok(rt.lobby.deadlines.has(spectatorId), 'the spectator got a lobby grace deadline');
  advance(rt.lobby.opts.lobbyGraceMs + 1);
  rt.lobby.expireGrace();
  assert.equal(room.spectators.length, 0, 'the spectator seat is freed after the grace');
});
