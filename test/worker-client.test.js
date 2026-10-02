import { test } from 'node:test';
import assert from 'node:assert/strict';

test('room tokens only select a valid room and opaque 128-bit token', async () => {
  const { roomFromToken } = await import('../public/js/room-net.js');
  assert.equal(roomFromToken('ABCD.' + 'a'.repeat(32)), 'ABCD');
  for (const token of [null, 'a'.repeat(32), 'ABCD.bad', '../x.' + 'a'.repeat(32), 'AAAA.' + 'z'.repeat(32)]) {
    assert.equal(roomFromToken(token), null);
  }
});

test('closing during room allocation never opens a late WebSocket', async () => {
  const { RoomNet } = await import('../public/js/room-net.js');
  let resolveAllocation;
  let opens = 0;
  const net = new RoomNet({
    baseUrl: 'https://game.example', getToken: () => null,
    fetch: () => new Promise(resolve => { resolveAllocation = resolve; }),
    WebSocket: class { constructor() { opens++; } },
  });
  net.connect();
  net.close();
  resolveAllocation(Response.json({ code: 'ABCD', ticket: 'a'.repeat(32) }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opens, 0);
  assert.equal(net.status, 'closed');
});

test('resumed clients route directly to their existing room without allocating', async () => {
  const { RoomNet } = await import('../public/js/room-net.js');
  let opened;
  const net = new RoomNet({
    baseUrl: 'https://game.example', getToken: () => 'WXYZ.' + 'b'.repeat(32),
    fetch: () => { throw new Error('must not allocate'); },
    WebSocket: class { constructor(url) { opened = url; this.readyState = 0; } close() {} },
  });
  net.connect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened, 'wss://game.example/ws?room=WXYZ');
  net.close();
});

test('an expired room token falls back to a new room instead of retrying the vanished object forever', async () => {
  const { RoomNet } = await import('../public/js/room-net.js');
  const urls = [];
  let first;
  const net = new RoomNet({
    baseUrl: 'https://game.example', getToken: () => 'ABCD.' + 'b'.repeat(32),
    fetch: async url => url.endsWith('/ABCD')
      ? Response.json({ error: 'ROOM_NOT_FOUND' }, { status: 404 })
      : Response.json({ code: 'WXYZ', ticket: 'c'.repeat(32) }),
    WebSocket: class {
      constructor(url) { urls.push(url); this.readyState = 0; first ||= this; }
      close() {}
    },
  });
  try {
    net.connect();
    first.readyState = 3;
    first.onclose({ code: 1006 });
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.equal(new URL(urls.at(-1)).searchParams.get('room'), 'WXYZ');
  } finally { net.close(); }
});

test('abandoning a match clears room routing state even when the following room.leave reports NOT_IN_ROOM', async () => {
  const { RoomNet } = await import('../public/js/room-net.js');
  const net = new RoomNet();
  net.name = '玩家'; net.status = 'online'; net.room = { code: 'ABCD' };
  net.ws = { readyState: 1, close() {}, send(raw) {
    const msg = JSON.parse(raw);
    queueMicrotask(() => net._onMessage(JSON.stringify(msg.t === 'g.leave'
      ? { t: 'ok', rid: msg.rid }
      : { t: 'error', rid: msg.rid, code: 'NOT_IN_ROOM' })));
  } };
  try {
    await net.request('g.leave');
    assert.equal(net.room, null);
    net.room = { code: 'ABCD' }; // A delayed UI leave must also clear stale local membership.
    await assert.rejects(net.request('room.leave'), { code: 'NOT_IN_ROOM' });
    assert.equal(net.room, null);
  } finally { net.close(); }
});

test('idle heartbeats allow platform auto-response without corrupting the game clock', async () => {
  const { RoomNet } = await import('../public/js/room-net.js');
  let now = 10000;
  const sent = [];
  const net = new RoomNet({ now: () => now });
  net.status = 'online';
  net.ws = { readyState: 1, close() {}, send(raw) { sent.push(JSON.parse(raw)); } };
  try {
    net._sendPing();
    assert.equal(sent.at(-1).c, 10000);
    now += 100;
    net._onPong({ t: 'pong', c: 10000, s: 10200 });
    const offset = net.clockOffset;
    assert.equal(net.clockSynced, true);
    net._sendPing();
    assert.deepEqual(sent.at(-1), { t: 'ping', c: 0 });
    now += 100;
    net._onPong({ t: 'pong', c: 0 });
    assert.equal(net.ping, 100);
    assert.equal(net.clockOffset, offset);
    net.room = { inMatch: true };
    net._sendPing();
    assert.equal(sent.at(-1).c, now);
  } finally { net.close(); }
});
