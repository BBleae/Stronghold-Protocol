import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './helpers/world.js';

// A refused WebSocket upgrade is a socket that closes at once with a code the page can read (worker/close-codes.js):
// a browser never sees the HTTP status of a refused upgrade.

test('refused upgrades close with a code: login invalid 4003, room gone 4004, too many connections 1013', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  await world.seed('a');
  await world.seed('x', 1); // its session expires at once
  const route = (await world.api('a', '/api/rooms', { method: 'POST' })).body;
  const host = await world.player('a', route);
  await host.request('room.create', { mode: 'coop', difficulty: 'FUNNY' });

  const refusal = async (actor, code) => {
    const socket = await world.socket(actor, { code });
    assert.equal(socket.status, 101);
    return socket.waitClosed();
  };
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await refusal('z', route.code), { code: 4003, reason: 'login required' }, 'never logged in');
  assert.deepEqual(await refusal('x', route.code), { code: 4003, reason: 'login required' }, 'session expired');
  assert.deepEqual(await refusal('a', 'IIII'), { code: 4004, reason: 'no such room' }, 'not a room code');
  assert.deepEqual(await refusal('a', 'WXYZ'), { code: 4004, reason: 'no such room' }, 'no room with this code');

  // The room admits 8 sockets per network; the next one is told to come back later.
  const open = [];
  for (let i = 0; i < 7; i++) open.push(await world.socket('a', { code: route.code }));
  assert.ok(open.every((socket) => socket.status === 101 && !socket.closed));
  assert.deepEqual(await refusal('a', route.code), { code: 1013, reason: 'connection limit (per-address)' });
  for (const socket of open) socket.ws.close(1000);

  // A room that ended is gone, for the member who left it too: nothing is left to resume.
  await world.seed('b');
  assert.equal((await host.request('room.leave')).t, 'ok');
  assert.deepEqual(await refusal('b', route.code), { code: 4004, reason: 'no such room' });
  assert.deepEqual(await refusal('a', route.code), { code: 4004, reason: 'no such room' });
});

test('a spectator whose match ended is told so before its socket closes with 4004', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  await world.seed('a');
  await world.seed('b');
  const route = (await world.api('a', '/api/rooms', { method: 'POST' })).body;
  const host = await world.player('a', route);
  await host.request('room.create', { mode: 'coop', difficulty: 'FUNNY' });
  assert.equal((await host.request('room.start')).t, 'ok');
  const viewer = await world.player('b', { code: route.code });
  assert.equal((await viewer.request('room.spectate')).t, 'ok');
  assert.equal((await viewer.wait('room.state')).spectating, true);

  // The only player leaves: the match ends (abandoned, no result), the spectator's watch with it. What the room sent
  // in that event arrives before the close.
  assert.equal((await host.request('g.leave')).t, 'ok');
  assert.deepEqual(await viewer.waitClosed(), { code: 4004, reason: 'match ended' });
  assert.equal(viewer.frames.at(-1).t, 'room.closed');
  assert.equal(viewer.frames.at(-1).reason, 'ended');
});

test('once a match ended, its spectators have nothing left in the room but its end to collect, with two sockets at most', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  for (const actor of ['a', 'b', 'c']) await world.seed(actor);
  const route = (await world.api('a', '/api/rooms', { method: 'POST' })).body;
  const host = await world.player('a', route);
  await host.request('room.create', { mode: 'coop', difficulty: 'FUNNY' });
  assert.equal((await host.request('room.start')).t, 'ok');
  // b watches until the end; c watched, and is offline when the match ends.
  const watching = await world.player('b', { code: route.code, ip: '10.0.0.1' });
  assert.equal((await watching.request('room.spectate')).t, 'ok');
  const away = await world.player('c', { code: route.code, ip: '10.0.0.2' });
  assert.equal((await away.request('room.spectate')).t, 'ok');
  away.ws.close(1000);
  await away.waitClosed();
  assert.equal((await host.request('g.leave')).t, 'ok');
  assert.deepEqual(await watching.waitClosed(), { code: 4004, reason: 'match ended' });

  const socket = async (actor, ip) => {
    const opened = await world.socket(actor, { code: route.code, ip });
    assert.equal(opened.status, 101);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return opened;
  };
  // b saw the end: nothing is left for it here.
  assert.deepEqual(await (await socket('b', '10.0.0.1')).waitClosed(), { code: 4004, reason: 'no such room' });
  // c has the end to collect: it may connect, with a stranger's two sockets at most.
  const first = await socket('c', '10.0.0.2');
  const second = await socket('c', '10.0.0.3');
  assert.equal(first.closed, null);
  assert.equal(second.closed, null);
  assert.deepEqual(await (await socket('c', '10.0.0.4')).waitClosed(), { code: 1013, reason: 'connection limit (spectators-per-account)' });
  first.send({ t: 'hello', name: 'Player c', token: away.welcome.token });
  assert.equal((await first.wait('room.closed')).reason, 'ended');
  // Collected: nothing is left for c either.
  second.ws.close(1000);
  assert.deepEqual(await (await socket('c', '10.0.0.3')).waitClosed(), { code: 4004, reason: 'no such room' });
});

test('strangers may only watch a running public match, with few sockets and few connections', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  for (const actor of ['a', 'b', 'c']) await world.seed(actor);
  const route = (await world.api('a', '/api/rooms', { method: 'POST' })).body;
  const host = await world.player('a', route);
  await host.request('room.create', { mode: 'coop', difficulty: 'FUNNY' });

  // A waiting room has nothing for a stranger (joining is an application).
  assert.deepEqual(await (await world.socket('b', { code: route.code })).waitClosed(), { code: 4004, reason: 'no such room' });
  assert.equal((await host.request('room.start')).t, 'ok');

  // A running public match may be watched. An account has one session in a room (a second socket that says hello
  // takes it over), so two sockets per account are enough: the one watching and its replacement.
  const viewer = await world.player('b', { code: route.code, ip: '10.0.0.1' });
  assert.equal((await viewer.request('room.spectate')).t, 'ok');
  const replacement = await world.socket('b', { code: route.code, ip: '10.0.0.2' });
  assert.equal(replacement.status, 101);
  const third = await world.socket('b', { code: route.code, ip: '10.0.0.3' });
  assert.deepEqual(await third.waitClosed(), { code: 1013, reason: 'connection limit (spectators-per-account)' });
  // Connections count per account, wherever they come from: 40 a minute.
  let refused = null;
  for (let i = 0; i < 45 && !refused; i++) {
    const socket = await world.socket('c', { code: 'WXYZ', ip: `10.1.${i}.1` });
    const closed = await socket.waitClosed();
    if (closed.code === 1013) refused = { attempt: i + 1, ...closed };
  }
  assert.deepEqual(refused, { attempt: 41, code: 1013, reason: 'too many connections' });
});
