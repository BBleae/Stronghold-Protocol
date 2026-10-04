import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RoomRuntime } from '../../worker/room-runtime.js';
class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  frames = [];
  send(s) {
    this.frames.push(JSON.parse(s));
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  terminate() {
    this.close();
  }
}
// What the Durable Object does on wake: the room from its snapshot, then its running match.
function restore(snapshot, now) {
  const rt = new RoomRuntime({ snapshot, now });
  rt.restoreMatch(snapshot.matchCheckpoint);
  return rt;
}
test('account room snapshot restores an active match and accepts the original seat again', () => {
  const rt = new RoomRuntime({ now: () => 1000 });
  const ws = new Socket();
  rt.connect(ws, { accountId: 'alice', ticket: rt.reserve('ABCD', 'alice'), name: 'Alice' });
  const send = (r, s, t, extra = {}) => r.message(s, JSON.stringify({ t, ...extra }));
  send(rt, ws, 'hello', { name: 'Alice' });
  send(rt, ws, 'room.create', { mode: 'solo', difficulty: 'FUNNY' });
  send(rt, ws, 'room.start');
  const before = rt.lobby.getRoom('ABCD').match.publicView();
  const snapshot = JSON.parse(JSON.stringify(rt.snapshot()));
  const recovered = restore(snapshot, () => 1000);
  assert.ok(recovered.lobby.getRoom('ABCD')?.match, 'active match must not be discarded');
  assert.deepEqual(recovered.lobby.getRoom('ABCD').match.publicView(), before);
  const next = new Socket();
  recovered.connect(next, { accountId: 'alice', takeover: true, name: 'Alice' });
  send(recovered, next, 'hello', { name: 'Alice' });
  send(recovered, next, 'g.infoReady');
  recovered.pump(1000);
  assert.notEqual(recovered.lobby.getRoom('ABCD').match.phase, 'INFO_CHECK');
  rt.lobby.getRoom('ABCD').match.dispose();
  recovered.lobby.getRoom('ABCD').match.dispose();
  rt.network.close();
  recovered.network.close();
});

test('a cold restart reconciles missing sockets and resumes paused solo combat under server authority', () => {
  const rt = new RoomRuntime({ now: () => 1000 }),
    ws = new Socket();
  rt.connect(ws, { accountId: 'alice', ticket: rt.reserve('ABCD', 'alice'), name: 'Alice' });
  const send = (t, extra = {}) => rt.message(ws, JSON.stringify({ t, ...extra }));
  send('hello', { name: 'Alice' });
  send('room.create', { mode: 'solo', difficulty: 'FUNNY' });
  send('room.start');
  const match = rt.lobby.getRoom('ABCD').match,
    pid = [...rt.registry.all()][0].playerId;
  match.handle(pid, { t: 'g.infoReady' });
  match.pump(1000);
  match.handle(pid, { t: 'g.band', bandId: 'band_sarkazb' });
  for (let i = 0; i < 100 && match.phase !== 'PREP'; i++) match.pump(match.sched.nextAt(), 1);
  match.handle(pid, { t: 'g.ready', ready: true });
  for (let i = 0; i < 100 && match.phase !== 'COMBAT'; i++) match.pump(match.sched.nextAt(), 1);
  assert.equal(match.phase, 'COMBAT');
  match.handle(pid, { t: 'g.pause', on: true });
  assert.equal(match.paused, true);
  const recovered = restore(JSON.parse(JSON.stringify(rt.snapshot())), () => 2000);
  recovered.reconcileSockets();
  const restored = recovered.lobby.getRoom('ABCD').match;
  assert.equal(restored.players.get(pid).connected, false);
  assert.equal(restored.paused, false);
  assert.ok(restored.fields.every((f) => f.mode === 'server'));
  match.dispose();
  restored.dispose();
  rt.network.close();
  recovered.network.close();
});

// A socket lost with a restart: what the Durable Object does on wake after a deployment, which closes every socket.
function restart(rt, now) {
  const snapshot = JSON.parse(JSON.stringify(rt.snapshot()));
  const recovered = new RoomRuntime({ snapshot, now });
  if (snapshot.matchCheckpoint) recovered.restoreMatch(snapshot.matchCheckpoint);
  recovered.reconcileSockets();
  return recovered;
}
function soloRun(clock) {
  const rt = new RoomRuntime({ now: () => clock.at }),
    ws = new Socket();
  rt.connect(ws, { accountId: 'alice', ticket: rt.reserve('ABCD', 'alice'), name: 'Alice' });
  for (const msg of [
    { t: 'hello', name: 'Alice' },
    { t: 'room.create', mode: 'solo', difficulty: 'FUNNY' },
    { t: 'room.start' },
  ])
    rt.message(ws, JSON.stringify(msg));
  return { rt, ws, pid: [...rt.registry.all()][0].playerId, token: ws.frames.find((f) => f.t === 'welcome').token };
}

test('a socket lost with a restart disconnects as a closing one does: a solo run keeps its 24-hour resume window', (t) => {
  const clock = { at: 1000 };
  const { rt, pid, token } = soloRun(clock);
  t.after(() => rt.lobby.shutdown());
  const recovered = restart(rt, () => clock.at);
  t.after(() => recovered.lobby.shutdown());
  assert.equal(recovered.lobby.getRoom('ABCD').match.players.get(pid).connected, false);
  clock.at += 600_001;
  recovered.sweep();
  assert.equal(recovered.hasAccount('alice'), true, 'not the ordinary ten minutes');
  assert.equal(recovered.status()?.inMatch, true);
  const back = new Socket();
  recovered.connect(back, { accountId: 'alice', name: 'Alice' });
  recovered.message(back, JSON.stringify({ t: 'hello', name: 'Alice', token }));
  assert.equal(back.frames.find((f) => f.t === 'welcome').playerId, pid);
  assert.equal(recovered.lobby.getRoom('ABCD').match.players.get(pid).connected, true);
  back.close();
  clock.at += 86_400_001;
  recovered.sweep();
  assert.equal(recovered.status(), null, 'the 24 hours still end');
});

test('a socket lost with a restart after its solo run ended gets the ordinary resume window', (t) => {
  const clock = { at: 1000 };
  const { rt, ws } = soloRun(clock);
  t.after(() => rt.lobby.shutdown());
  ws.close();
  ws.readyState = 1; // a drop during the run gives the session the solo window...
  const back = new Socket();
  rt.connect(back, { accountId: 'alice', name: 'Alice' });
  rt.message(
    back,
    JSON.stringify({ t: 'hello', name: 'Alice', token: ws.frames.find((f) => f.t === 'welcome').token }),
  );
  rt.pump();
  rt.lobby.getRoom('ABCD').match.finish({ victory: false, reason: 'defeat' });
  rt.pump();
  const recovered = restart(rt, () => clock.at);
  t.after(() => recovered.lobby.shutdown());
  const session = [...recovered.registry.all()][0];
  assert.equal(session.resumeWindowMs, null, '...which ends with the run');
  clock.at += 600_001;
  recovered.sweep();
  assert.equal(recovered.registry.size, 0);
  assert.equal(recovered.isEmpty(), true);
});

test('a lobby seat whose socket was lost with a restart gets the lobby grace from the restart', (t) => {
  const clock = { at: 1000 };
  const rt = new RoomRuntime({ now: () => clock.at });
  t.after(() => rt.lobby.shutdown());
  const host = new Socket();
  rt.connect(host, { accountId: 'host', ticket: rt.reserve('ABCD', 'host'), name: 'Host' });
  for (const msg of [
    { t: 'hello', name: 'Host' },
    { t: 'room.create', mode: 'coop', difficulty: 'FUNNY' },
  ])
    rt.message(host, JSON.stringify(msg));
  clock.at += 30_000;
  const recovered = restart(rt, () => clock.at);
  t.after(() => recovered.lobby.shutdown());
  assert.equal(recovered.lobby.getRoom('ABCD').seats[0].connected, false);
  clock.at += 59_000;
  recovered.sweep();
  assert.ok(recovered.lobby.getRoom('ABCD'), 'the grace runs from the restart, not from the last save');
  clock.at += 1_001;
  recovered.sweep();
  assert.equal(recovered.lobby.getRoom('ABCD'), null);
});

test('reusing an empty room code creates a new archive generation', () => {
  let now = 1000;
  const rt = new RoomRuntime({ now: () => now });
  rt.reserve('ABCD', 'alice');
  const first = rt.generation;
  now += 120001;
  rt.sweep();
  assert.equal(rt.isEmpty(), true);
  assert.ok(rt.reserve('ABCD', 'bob'));
  assert.notEqual(rt.generation, first);
});
