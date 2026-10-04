// Names in rooms (production Worker, Miniflare): a session is named after its account's display name (昵称#NNNN, up
// to 17 characters, never cut) whatever name its client claims — in the room, the public lobby and join applications.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './helpers/world.js';

async function listing(world, code) {
  for (let i = 0; i < 100; i++) {
    const room = (await world.api('c', '/api/rooms')).body.items.find((item) => item.roomId === code);
    if (room) return room;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`room ${code} is not listed`);
}

test('rooms, the lobby and applications name accounts by their profile, never by the name a client sends', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  const host = await world.seed('a');
  const guest = await world.seed('b');
  await world.seed('c');
  assert.match(host.name, /^Player a#\d{4}$/);
  const { code, ticket } = (await world.api('a', '/api/rooms', { method: 'POST' })).body;
  const a = await world.player('a', { code, ticket, name: 'Mallory' });
  assert.equal(a.welcome.name, host.name);
  assert.equal((await a.request('room.create', { mode: 'coop', difficulty: 'FUNNY' })).t, 'ok');
  assert.equal((await a.wait('room.state', (s) => s.seats?.[0])).seats[0].name, host.name);
  assert.equal((await listing(world, code)).hostName, host.name);

  const applied = await world.api('b', `/api/rooms/${code}/applications`, { method: 'POST', body: { action: 'apply' } });
  assert.equal(applied.status, 201);
  assert.equal(applied.body.name, guest.name);
  const pending = (await world.api('a', `/api/rooms/${code}/applications`)).body.items;
  assert.deepEqual(pending.map((item) => item.name), [guest.name], 'the host sees the applicant\'s display name');
  assert.equal((await world.api('a', `/api/rooms/${code}/applications`, { method: 'POST', body: { action: 'approve', id: applied.body.id } })).status, 200);
  const approval = (await world.api('b', `/api/rooms/${code}/applications`)).body.items[0];
  const b = await world.player('b', { code, ticket: approval.ticket, name: 'Player a' });
  assert.equal(b.welcome.name, guest.name);
  assert.equal((await b.request('room.join', { code })).t, 'ok');
  const seats = (await a.wait('room.state', (s) => s.seats?.[1])).seats;
  assert.deepEqual(seats.filter(Boolean).map((seat) => seat.name), [host.name, guest.name]);
});

test('a 17-character display name is never cut, and a new nickname is the name of the next connection', { timeout: 120000 }, async (t) => {
  const world = await createWorld(t);
  const registered = await world.api('z', '/api/auth/register', { method: 'POST', cookie: '',
    body: { username: 'longname', password: 'long enough', nickname: '十二个字的博士代号测试名' } });
  const { session, body: { user } } = registered;
  assert.equal([...user.name].length, 17);
  const { code, ticket } = (await world.api('z', '/api/rooms', { method: 'POST', cookie: session })).body;
  const first = await world.player('z', { session, code, ticket, name: '短' });
  assert.equal(first.welcome.name, user.name);
  assert.equal((await first.request('room.create', { mode: 'coop', difficulty: 'FUNNY' })).t, 'ok');
  assert.equal((await first.wait('room.state', (s) => s.seats?.[0])).seats[0].name, user.name);
  assert.equal((await listing(world, code)).hostName, user.name);

  const renamed = (await world.api('z', '/api/me/nickname', { method: 'POST', cookie: session, body: { nickname: '新代号' } })).body.user;
  first.ws.close(1000, 'reload');
  await first.waitClosed();
  const again = await world.player('z', { session, code, token: first.welcome.token });
  assert.equal(again.welcome.resumed, true);
  assert.equal(again.welcome.name, renamed.name);
  assert.equal((await again.wait('room.state', (s) => s.seats?.[0]?.name === renamed.name)).seats[0].name, renamed.name);
});
