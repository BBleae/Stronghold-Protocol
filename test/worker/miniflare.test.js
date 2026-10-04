import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './helpers/world.js';

// The production Worker in workerd: rooms are isolated per code, a room evicted with its sockets open (hibernation)
// keeps serving them, and a running match survives a deployment (the runtime replaced, every socket closed).

test('real Workers runtime isolates rooms, keeps live sockets across hibernation, and resumes a match after a deployment',
  { timeout: 120_000 }, async (t) => {
    const world = await createWorld(t);
    for (const actor of ['a', 'b', 'c']) await world.seed(actor);
    const first = (await world.api('a', '/api/rooms', { method: 'POST' })).body;
    const second = (await world.api('c', '/api/rooms', { method: 'POST' })).body;
    assert.notEqual(first.code, second.code);
    assert.match(first.ticket, /^[0-9a-f]{32}$/);
    assert.equal((await world.api('a', `/api/rooms/${first.code}`)).status, 404, 'reserved, not created yet');

    const host = await world.player('a', first);
    assert.equal((await host.request('room.create', { mode: 'coop', difficulty: 'FUNNY' })).t, 'ok');
    const other = await world.player('c', second);
    assert.equal((await other.request('room.create', { mode: 'solo', difficulty: 'FUNNY' })).t, 'ok');
    const applications = `/api/rooms/${first.code}/applications`;
    const applied = await world.api('b', applications, { method: 'POST', body: { action: 'apply' } });
    const approved = await world.api('a', applications, { method: 'POST', body: { action: 'approve', id: applied.body.id } });
    const guest = await world.player('b', { code: first.code, ticket: approved.body.ticket });
    assert.equal((await guest.request('room.join', { code: first.code })).t, 'ok');
    assert.equal((await guest.request('room.ready', { ready: true })).t, 'ok');
    assert.equal(other.frames.filter((f) => f.t === 'room.state').at(-1).seats.filter(Boolean).length, 1, 'the other room is untouched');

    // Evicted with its sockets open: the platform answers idle pings, and the room wakes for the next message.
    await world.evict(first.code);
    guest.send({ t: 'ping', c: 0 });
    assert.deepEqual(await guest.wait('pong', (f) => f.c === 0), { t: 'pong', c: 0 });
    guest.send({ t: 'hello', name: 'Player b', token: guest.welcome.token, rid: 4 });
    const awake = await guest.wait('welcome', (f) => f.rid === 4);
    assert.equal(awake.playerId, guest.welcome.playerId);
    assert.equal(guest.frames.filter((f) => f.t === 'room.state').at(-1).seats[1].ready, true);

    assert.equal((await host.request('room.start')).t, 'ok');
    await host.wait('m.public', (f) => f.phase === 'INFO_CHECK');
    await guest.wait('m.private');
    const status = await world.api('a', `/api/rooms/${first.code}`);
    assert.deepEqual(status.body, { code: first.code, mode: 'coop', inMatch: true, full: false });

    // A dropped socket resumes the seat; so does one closed by a deployment.
    guest.ws.close(1000, 'drop');
    const resumed = await world.player('b', { code: first.code, token: guest.welcome.token });
    assert.equal(resumed.welcome.resumed, true);
    await resumed.wait('m.private');
    await world.restart();
    const redeployed = await world.player('b', { code: first.code, token: guest.welcome.token });
    assert.equal(redeployed.welcome.resumed, true);
    assert.equal(redeployed.welcome.playerId, guest.welcome.playerId);
    assert.equal((await redeployed.wait('m.public')).phase, 'INFO_CHECK');
    await redeployed.wait('m.private');
  });
