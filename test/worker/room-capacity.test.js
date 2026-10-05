// Room capacity on the room Worker (owner's decision for 5–8 players, a remake extension): the host chooses 4–8 seats
// (room.create { capacity? } / room.setCapacity { capacity }); the socket limits follow the room's capacity (a 4-seat room
// keeps 16 sockets / 8 per network), approved applicants keep their seats, the capacity survives a snapshot, and a room
// saved before rooms had a capacity (4 seat slots) restores as a 4-seat room.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RoomRuntime, ROOM_LIMITS, socketLimits } from '../../worker/room-runtime.js';
import { DEFAULT_SEATS, MAX_SEATS } from '../../shared/constants.js';
import { BOT_NAMES } from '../../server/lobby.js';
import { createWorld } from './helpers/world.js';

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
let rid = 100;
function connect(rt, accountId, { ticket, token, ip = '8.8.8.8' } = {}) {
  const ws = new Socket();
  rt.connect(ws, { ip, ticket, accountId, name: accountId });
  rt.message(ws, JSON.stringify({ t: 'hello', name: accountId, token, rid: rid++ }));
  return ws;
}
const send = (rt, ws, msg) => { rt.pump(); rt.message(ws, JSON.stringify({ rid: rid++, ...msg })); rt.pump(); };
const reply = (ws) => ws.frames.filter((f) => f.t === 'ok' || f.t === 'error').at(-1);
// The host approves `accountId`'s application: its ticket joins the room.
function approve(rt, accountId) {
  const item = rt.applications.apply({ accountId, name: accountId });
  const room = rt.lobby.getRoom(rt.code);
  return rt.applications.decide('owner', item.id, 'approved', { hostId: 'owner', inMatch: !!room.match,
    freeSeats: room.seats.filter((x) => !x).length }).ticket;
}
function createRoom(s, fields = {}) {
  const owner = connect(s.rt, 'owner', { ticket: s.ticket });
  send(s.rt, owner, { t: 'room.create', mode: 'coop', difficulty: 'FUNNY', ...fields });
  assert.equal(reply(owner).t, 'ok', JSON.stringify(reply(owner)));
  return owner;
}
function join(s, accountId, ip) {
  const ws = connect(s.rt, accountId, { ticket: approve(s.rt, accountId), ip });
  send(s.rt, ws, { t: 'room.join', code: s.rt.code });
  assert.equal(reply(ws).t, 'ok', JSON.stringify(reply(ws)));
  return ws;
}

test('socket limits follow the room capacity: a 4-seat room keeps 16 / 8, strangers keep 11 / 3 in any room', () => {
  assert.deepEqual(socketLimits(DEFAULT_SEATS), { reserve: 5, sockets: ROOM_LIMITS.sockets, socketsPerIp: ROOM_LIMITS.socketsPerIp });
  assert.deepEqual(socketLimits(4), { reserve: 5, sockets: 16, socketsPerIp: 8 });
  assert.deepEqual(socketLimits(8), { reserve: 9, sockets: 20, socketsPerIp: 12 });
  for (let n = DEFAULT_SEATS; n <= MAX_SEATS; n++) {
    const l = socketLimits(n);
    assert.equal(l.reserve, n + 1, 'every player seat plus one reconnect overlap');
    assert.equal(l.sockets - l.reserve, 11);
    assert.equal(l.socketsPerIp - l.reserve, 3);
  }
  // a solo room and a room not created yet count as the default room
  assert.deepEqual(socketLimits(1), socketLimits(DEFAULT_SEATS));
  assert.deepEqual(socketLimits(0), socketLimits(DEFAULT_SEATS));
});

test('an 8-seat room: created with its capacity, filled to 8 members, a 9th is refused; the default stays 4', (t) => {
  const s = setup(t);
  const owner = createRoom(s, { capacity: MAX_SEATS });
  const state = owner.take('room.state');
  assert.equal(state.capacity, MAX_SEATS);
  assert.equal(state.seats.length, MAX_SEATS);
  for (let n = 1; n < MAX_SEATS; n++) join(s, `guest${n}`, `9.9.9.${n}`);
  assert.equal(s.rt.status().full, true);
  assert.equal(s.rt.lobby.getRoom('ABCD').seats.filter(Boolean).length, MAX_SEATS);
  assert.throws(() => approve(s.rt, 'late'), /ROOM_FULL/);

  const d = setup(t, 'EFGH');
  const host = createRoom(d);
  assert.equal(host.take('room.state').capacity, DEFAULT_SEATS);
  assert.equal(d.rt.lobby.getRoom('EFGH').seats.length, DEFAULT_SEATS);
});

test('eight members behind one network keep a reconnect overlap; strangers there still watch (3), 11 in all', (t) => {
  const s = setup(t);
  const owner = createRoom(s, { capacity: MAX_SEATS });
  for (let n = 1; n < MAX_SEATS; n++) send(s.rt, join(s, `guest${n}`, '8.8.8.8'), { t: 'room.ready', ready: true });
  assert.equal(s.rt.network.connectionCount, MAX_SEATS);
  // a member's replacement socket from the same network (a reload before the old socket closed) is admitted
  assert.equal(s.rt.admission('8.8.8.8', 'guest3'), null);
  send(s.rt, owner, { t: 'room.start' });
  assert.equal(reply(owner).t, 'ok', JSON.stringify(reply(owner)));
  // strangers on the members' network: 3, then 'spectators-per-address'
  for (let i = 0; i < 3; i++) {
    const viewer = connect(s.rt, `viewer${i}`);
    send(s.rt, viewer, { t: 'room.spectate' });
    assert.equal(viewer.take('room.state')?.spectating, true, `viewer ${i}`);
  }
  assert.equal(s.rt.admission('8.8.8.8', 'viewer9'), 'spectators-per-address');
  // strangers elsewhere: 11 in all
  for (let i = 3; i < 11; i++) {
    const viewer = connect(s.rt, `viewer${i}`, { ip: `9.1.1.${i}` });
    send(s.rt, viewer, { t: 'room.spectate' });
    assert.equal(viewer.take('room.state')?.spectating, true, `viewer ${i}`);
  }
  assert.equal(s.rt.admission('9.2.2.2', 'extra'), 'spectators-full');
  // the members' share stays free: a member reconnects
  const token = owner.take('welcome').token;
  owner.close(1000, 'drop');
  const back = connect(s.rt, 'owner', { token });
  assert.equal(back.take('welcome').resumed, true);
  assert.equal(back.take('room.state').capacity, MAX_SEATS);
});

test('room.setCapacity: host only, in the lobby; approved applicants keep their seats', (t) => {
  const s = setup(t);
  const owner = createRoom(s, { capacity: 6 });
  const guest = join(s, 'guest', '9.9.9.1');
  send(s.rt, guest, { t: 'room.setCapacity', capacity: MAX_SEATS });
  assert.equal(reply(guest).code, 'NOT_HOST');
  // two members and two approved applicants: 4 seats are spoken for
  approve(s.rt, 'pending1');
  approve(s.rt, 'pending2');
  send(s.rt, owner, { t: 'room.setCapacity', capacity: DEFAULT_SEATS });
  assert.equal(reply(owner).t, 'ok', 'two members + two approvals fit in 4 seats');
  assert.equal(owner.take('room.state').capacity, DEFAULT_SEATS);
  send(s.rt, owner, { t: 'room.addBot' });
  assert.equal(reply(owner).code, 'ROOM_FULL', 'the approved applicants\' seats stay free');
  send(s.rt, owner, { t: 'room.setCapacity', capacity: 5 });
  assert.equal(reply(owner).t, 'ok');
  send(s.rt, owner, { t: 'room.addBot' });
  assert.equal(reply(owner).t, 'ok', 'the fifth seat is free for an AI teammate');
  assert.equal(owner.take('room.state').seats[2].name, BOT_NAMES[0]);
  send(s.rt, owner, { t: 'room.setCapacity', capacity: DEFAULT_SEATS });
  assert.deepEqual([reply(owner).code, reply(owner).detail], ['BAD_TARGET', 'approved applicants keep their seats']);
  assert.equal(s.rt.lobby.getRoom('ABCD').seats.length, 5);
  // in a match: refused
  send(s.rt, guest, { t: 'room.ready', ready: true });
  send(s.rt, owner, { t: 'room.start' });
  assert.equal(reply(owner).t, 'ok', JSON.stringify(reply(owner)));
  send(s.rt, owner, { t: 'room.setCapacity', capacity: MAX_SEATS });
  assert.equal(reply(owner).code, 'ROOM_STARTED');
});

test('the capacity survives a snapshot; a room saved before rooms had one (4 seat slots) restores as a 4-seat room', (t) => {
  const s = setup(t);
  const owner = createRoom(s, { capacity: 7 });
  const token = owner.take('welcome').token;
  const snapshot = s.rt.snapshot();
  assert.equal(snapshot.room.seats.length, 7);
  assert.equal(Object.hasOwn(snapshot.room, 'capacity'), false, 'the seat slots are the capacity');
  const restored = new RoomRuntime({ snapshot, now: s.now });
  t.after(() => restored.lobby.shutdown());
  const back = connect(restored, 'owner', { token });
  assert.equal(back.take('room.state').capacity, 7);
  assert.deepEqual(restored.socketLimits(), socketLimits(7));

  // an older snapshot: the same shape with 4 seat slots (every room had them)
  const old = setup(t, 'EFGH');
  const host = createRoom(old);
  const oldToken = host.take('welcome').token;
  const saved = structuredClone(old.rt.snapshot());
  assert.equal(saved.room.seats.length, 4);
  const woke = new RoomRuntime({ snapshot: saved, now: old.now });
  t.after(() => woke.lobby.shutdown());
  const again = connect(woke, 'owner', { token: oldToken });
  const st = again.take('room.state');
  assert.equal(st.capacity, DEFAULT_SEATS);
  assert.equal(st.seats.length, DEFAULT_SEATS);
  assert.deepEqual(woke.socketLimits(), { reserve: 5, sockets: 16, socketsPerIp: 8 });
  // the host may still grow it
  send(woke, again, { t: 'room.setCapacity', capacity: MAX_SEATS });
  assert.equal(reply(again).t, 'ok');
  assert.equal(again.take('room.state').seats.length, MAX_SEATS);
});

test('the public listing publishes the room capacity (x/8), and follows room.setCapacity', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  await world.seed('a');
  const route = (await world.api('a', '/api/rooms', { method: 'POST' })).body;
  const host = await world.player('a', route);
  assert.equal((await host.request('room.create', { mode: 'coop', difficulty: 'FUNNY', capacity: MAX_SEATS })).t, 'ok');
  const listed = async (pred) => {
    let items = [];
    for (let i = 0; i < 100 && !items.some(pred); i++) {
      items = (await world.api('a', '/api/rooms')).body.items;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return items.find(pred);
  };
  const big = await listed((room) => room.roomId === route.code);
  assert.deepEqual({ occupied: big.occupied, capacity: big.capacity }, { occupied: 1, capacity: MAX_SEATS });
  assert.equal((await host.request('room.setCapacity', { capacity: 5 })).t, 'ok');
  const resized = await listed((room) => room.roomId === route.code && room.capacity === 5);
  assert.equal(resized.capacity, 5);
});
