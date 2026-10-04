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

  // A room that ended is gone for everyone but the accounts that still have a session there (to resume it, or to
  // learn why it closed).
  await world.seed('b');
  assert.equal((await host.request('room.leave')).t, 'ok');
  assert.deepEqual(await refusal('b', route.code), { code: 4004, reason: 'no such room' });
  const own = await world.player('a', { code: route.code, token: host.welcome.token });
  assert.equal(own.welcome.resumed, true);
});
