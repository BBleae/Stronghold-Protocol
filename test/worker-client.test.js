// RoomNet (public/js/room-net.js), the Workers account-mode transport, driven like the browser drives it: a fake
// WebSocket per room socket, a fake account API (fetch) and virtual timers. Assertions are on what the UI observes:
// statuses, events, promise outcomes and their texts, and the sockets that get opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomNet, roomFromToken, ENTER_TIMEOUT_MS, DRAIN_MS, APPLICATION_POLL_MS, QUEUE_POLL_MS } from '../public/js/room-net.js';
import { REQUEST_TIMEOUT_MS } from '../public/js/net.js';
import { installLoadoutSync } from '../public/js/ui/loadoutSync.js';
import { createStore } from '../public/js/store.js';
import { bannerVisible } from '../public/js/ui/connBanner.js';

const TICKET = 'a'.repeat(32);
const TOKEN = 'ABCD.' + 'b'.repeat(32);

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

function fakeTimers() {
  let now = 1_000_000;
  let seq = 0;
  const queue = new Map();
  const add = (fn, ms, every) => { const id = ++seq; queue.set(id, { at: now + Math.max(0, ms | 0), fn, every }); return id; };
  return {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, 0),
    clearTimeout: (id) => queue.delete(id),
    setInterval: (fn, ms) => add(fn, ms, Math.max(1, ms | 0)),
    clearInterval: (id) => queue.delete(id),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of queue) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        const [id, t] = next;
        now = t.at;
        if (t.every) t.at += t.every; else queue.delete(id);
        t.fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

function fakeSockets() {
  const sockets = [];
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closedWith = null; sockets.push(this); }
    send(data) { if (this.readyState !== 1) throw new Error('not open'); this.sent.push(JSON.parse(data)); }
    close(code) { this.readyState = 3; this.closedWith = code ?? 1000; }
    open() { this.readyState = 1; this.onopen?.(); }
    recv(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
    drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
    last(t) { return [...this.sent].reverse().find((m) => m.t === t); }
  }
  return { FakeWS, sockets, last: () => sockets.at(-1) };
}

/**
 * The account API: answers ([status, body], or a function returning a promise of one) are queued per "METHOD path";
 * anything else is recorded as unexpected.
 */
function fakeApi() {
  const queues = new Map();
  const calls = [];
  const unexpected = [];
  return {
    calls, unexpected,
    reply(key, ...answers) { queues.set(key, [...(queues.get(key) || []), ...answers]); },
    fetch: async (path, init = {}) => {
      const key = `${init.method || 'GET'} ${path}`;
      calls.push({ key, body: init.body ? JSON.parse(init.body) : undefined });
      const answer = queues.get(key)?.shift();
      if (!answer) {
        unexpected.push(key);
        return { status: 599, ok: false, json: async () => ({ error: 'UNEXPECTED' }) };
      }
      const [status, body] = typeof answer === 'function' ? await answer() : answer;
      return { status, ok: status < 400, json: async () => body };
    },
  };
}

function setup() {
  const timers = fakeTimers();
  const ws = fakeSockets();
  const api = fakeApi();
  const net = new RoomNet({ baseUrl: 'https://game.example', WebSocket: ws.FakeWS, timers, now: timers.now, random: () => 0.5, fetch: api.fetch });
  const events = [];
  net.on('status', (s) => events.push(['status', s.status]));
  net.on('room.closed', (msg) => events.push(['room.closed', msg.reason]));
  net.setName('博士'); // boot: the account's name; there is no room yet
  return { net, timers, ws, api, events };
}

/** Open the newest socket and answer its hello. */
async function welcome(h, { playerId = 'p1', resumed = false, token = TOKEN } = {}) {
  const sock = h.ws.last();
  sock.open();
  const hello = sock.last('hello');
  sock.recv({ t: 'welcome', rid: hello.rid, playerId, token, name: '博士', serverNow: h.timers.now(), resumed });
  await settle();
  return hello;
}

const ok = (sock, type) => sock.recv({ t: 'ok', rid: sock.last(type).rid });
const fail = (sock, type, code) => sock.recv({ t: 'error', rid: sock.last(type).rid, code });
const roomState = (sock, extra = {}) => sock.recv({ t: 'room.state', code: 'ABCD', mode: 'coop', seats: [{ playerId: 'p1' }], ...extra });
const closes = (h) => h.events.filter(([type]) => type === 'room.closed');
const statuses = (h) => h.events.filter(([type]) => type === 'status').map(([, status]) => status);

/** Create room ABCD (reservation, socket with the ticket, room.create). */
async function inRoom(h) {
  h.api.reply('POST /api/rooms', [201, { code: 'ABCD', ticket: TICKET, generation: 'g1' }]);
  const created = h.net.request('room.create', { mode: 'coop', difficulty: 'FUNNY' });
  await settle();
  await welcome(h);
  const sock = h.ws.last();
  roomState(sock);
  ok(sock, 'room.create');
  await created;
  return sock;
}

test('room tokens only select a valid room and opaque 128-bit token', () => {
  assert.equal(roomFromToken('ABCD.' + 'a'.repeat(32)), 'ABCD');
  for (const token of [null, 'a'.repeat(32), 'ABCD.bad', '../x.' + 'a'.repeat(32), 'AAAA.' + 'z'.repeat(32)]) {
    assert.equal(roomFromToken(token), null);
  }
});

test('the account lobby is a menu: no socket, room requests and leaves settle at once', async () => {
  const h = setup();
  assert.equal(h.net.status, 'menu');
  assert.equal(h.ws.sockets.length, 0);
  // no timer advances: nothing waits for a request timeout
  await assert.rejects(h.net.request('room.loadout', { entries: {} }), { code: 'NOT_IN_ROOM', message: '你不在房间中' });
  await assert.rejects(h.net.request('g.leave'), { code: 'NOT_IN_ROOM' });
  await assert.rejects(h.net.request('room.leave'), { code: 'NOT_IN_ROOM' });
  assert.equal(h.net.status, 'menu');
  assert.equal(bannerVisible({ status: 'menu', everOnline: true }, true, false), false, 'the menu shows no connection banner');
  assert.deepEqual(h.api.calls, []);
});

test('a loadout edit in the lobby waits for the next room instead of cycling through timeouts', async () => {
  const h = setup();
  const target = createStore({ entries: {}, open: false, from: null, sel: null, filters: {}, sync: 'idle' });
  const sync = installLoadoutSync({ net: h.net, timers: h.timers, target, getChessReady: async () => ({}), lookupChess: () => null });
  target.set({ entries: { chess_char_1_01_a: { skill: 0 } } });
  await h.timers.advance(60_000);
  assert.equal(target.get().sync, 'idle');
  assert.equal(h.ws.sockets.length, 0);
  sync.dispose();
});

test('create reserves a room, opens its socket with the ticket and creates the room in it', async () => {
  const h = setup();
  const sock = await inRoom(h);
  assert.equal(sock.url, `wss://game.example/ws?room=ABCD&ticket=${TICKET}`);
  assert.equal(sock.last('hello').token, undefined, 'a new room starts a new session');
  const create = sock.last('room.create');
  assert.deepEqual({ mode: create.mode, difficulty: create.difficulty }, { mode: 'coop', difficulty: 'FUNNY' });
  assert.equal(h.net.status, 'online');
  assert.equal(h.net.room.code, 'ABCD');
  assert.deepEqual(h.api.unexpected, []);
});

test('a connection that fails before it opens is retried while creating', async () => {
  const h = setup();
  h.api.reply('POST /api/rooms', [201, { code: 'ABCD', ticket: TICKET, generation: 'g1' }]);
  const created = h.net.request('room.create', { mode: 'solo', difficulty: 'FUNNY' });
  await settle();
  h.ws.last().drop(1006); // the network failed before the socket opened
  await settle();
  assert.equal(h.net.status, 'reconnecting');
  await h.timers.advance(500);
  assert.equal(h.ws.sockets.length, 2);
  assert.equal(h.ws.last().url, `wss://game.example/ws?room=ABCD&ticket=${TICKET}`);
  await welcome(h);
  roomState(h.ws.last());
  ok(h.ws.last(), 'room.create');
  await created;
  assert.equal(h.net.status, 'online');
  assert.deepEqual(h.api.unexpected, []);
});

test('a create that fails after reserving returns to the menu, and the next create finishes that reservation', async () => {
  const h = setup();
  h.api.reply('POST /api/rooms', [201, { code: 'ABCD', ticket: TICKET, generation: 'g1' }]);
  const failed = assert.rejects(h.net.request('room.create', { mode: 'coop', difficulty: 'FUNNY' }),
    { code: 'TIMEOUT', message: '请求超时，请重试' });
  await settle();
  await welcome(h);
  const first = h.ws.last();
  await h.timers.advance(REQUEST_TIMEOUT_MS); // room.create is never answered
  await failed;
  assert.equal(h.net.status, 'menu');
  assert.equal(first.closedWith, 1000, 'the socket that held the reservation is closed');
  await h.timers.advance(60_000);
  assert.equal(h.ws.sockets.length, 1, 'no reconnect from the menu');
  // the Worker answers the account's own unused reservation: finishing it is what the player asks for
  h.api.reply('POST /api/rooms', [200, { code: 'ABCD', ticket: TICKET, generation: 'g1' }]);
  const again = h.net.request('room.create', { mode: 'solo', difficulty: 'HARD' });
  await settle();
  assert.equal(h.ws.last().url, `wss://game.example/ws?room=ABCD&ticket=${TICKET}`);
  await welcome(h);
  assert.equal(h.ws.last().last('room.create').mode, 'solo');
  roomState(h.ws.last());
  ok(h.ws.last(), 'room.create');
  await again;
  assert.equal(h.net.status, 'online');
  assert.deepEqual(h.api.unexpected, []);
});

test('create while the account is seated in a live room explains what to do', async () => {
  const h = setup();
  h.api.reply('POST /api/rooms', [409, { error: 'ALREADY_SEATED' }]);
  await assert.rejects(h.net.request('room.create', { mode: 'coop', difficulty: 'FUNNY' }),
    { code: 'ALREADY_SEATED', message: '你已有一个房间，请先继续对局或离开' });
  assert.equal(h.net.status, 'menu');
  assert.equal(h.ws.sockets.length, 0);
  assert.deepEqual(h.api.unexpected, []);
});

test('one way into a room at a time', async () => {
  const h = setup();
  h.api.reply('POST /api/rooms', [201, { code: 'ABCD', ticket: TICKET, generation: 'g1' }]);
  const created = h.net.request('room.create', { mode: 'coop', difficulty: 'FUNNY' });
  await assert.rejects(h.net.enter({ kind: 'spectate', code: 'WXYZ' }), { code: 'BUSY', message: '正在进入房间，请稍候' });
  await settle();
  await welcome(h);
  roomState(h.ws.last());
  ok(h.ws.last(), 'room.create');
  await created;
  await assert.rejects(h.net.request('room.join', { code: 'WXYZ' }), { code: 'ALREADY_IN_ROOM', message: '请先离开当前房间' });
  assert.equal(h.net.status, 'online', 'a refused intent leaves the room alone');
});

test('joining by code is an application; the approval enters the room and ends the application', async () => {
  const h = setup();
  const seen = [];
  h.net.on('application', (a) => seen.push(a && a.status));
  h.api.reply('POST /api/rooms/ABCD/applications', [201, { id: 'app1', status: 'pending', expiresAt: 0 }]);
  const reply = await h.net.request('room.join', { code: 'ABCD' });
  assert.equal(reply.application.status, 'pending');
  assert.equal(h.net.status, 'menu', 'no socket before the host decides');
  assert.equal(h.ws.sockets.length, 0);
  h.api.reply('GET /api/rooms/ABCD/applications', [200, { items: [{ id: 'app1', status: 'pending' }] }],
    [200, { items: [{ id: 'app1', status: 'approved', ticket: TICKET }] }]);
  await h.timers.advance(APPLICATION_POLL_MS * 2);
  assert.equal(h.ws.last().url, `wss://game.example/ws?room=ABCD&ticket=${TICKET}`);
  await welcome(h);
  assert.equal(h.ws.last().last('room.join').code, 'ABCD');
  roomState(h.ws.last());
  ok(h.ws.last(), 'room.join');
  await settle();
  assert.equal(h.net.status, 'online');
  assert.equal(h.net.application, null);
  assert.deepEqual(seen, ['pending', 'pending', 'joining', null]);
  assert.deepEqual(h.api.unexpected, []);
});

test('a join that fails after the approval stays visible with its reason; a retry uses the approval again', async () => {
  const h = setup();
  h.net.watchApplication({ code: 'ABCD', id: 'app1', status: 'pending' }); // boot: /api/me reported it
  h.api.reply('GET /api/rooms/ABCD/applications', [200, { items: [{ id: 'app1', status: 'approved', ticket: TICKET }] }]);
  await h.timers.advance(APPLICATION_POLL_MS);
  await welcome(h);
  fail(h.ws.last(), 'room.join', 'ROOM_FULL');
  await settle();
  assert.equal(h.net.application.status, 'failed');
  assert.equal(h.net.application.error.message, '房间已满');
  assert.equal(h.net.status, 'menu');
  h.api.reply('GET /api/rooms/ABCD/applications', [200, { items: [{ id: 'app1', status: 'approved', ticket: TICKET }] }]);
  h.net.retryApplication();
  await settle();
  await welcome(h);
  roomState(h.ws.last());
  ok(h.ws.last(), 'room.join');
  await settle();
  assert.equal(h.net.status, 'online');
  assert.equal(h.net.application, null);
  assert.deepEqual(h.api.unexpected, []);
});

test('the application ends visibly when the host rejects it; entering elsewhere waits for a pending one', async () => {
  const h = setup();
  h.net.watchApplication({ code: 'ABCD', id: 'app1', status: 'pending' });
  await assert.rejects(h.net.request('room.create', { mode: 'coop', difficulty: 'FUNNY' }),
    { code: 'APPLICATION_PENDING', message: '已有一个加入申请，请先取消或等待处理' });
  h.api.reply('GET /api/rooms/ABCD/applications', [200, { items: [{ id: 'app1', status: 'rejected' }] }]);
  await h.timers.advance(APPLICATION_POLL_MS);
  assert.equal(h.net.application.status, 'rejected');
  await h.timers.advance(APPLICATION_POLL_MS * 5);
  assert.equal(h.api.calls.filter((c) => c.key === 'GET /api/rooms/ABCD/applications').length, 1, 'no polling after the decision');
  assert.deepEqual(h.api.unexpected, []);
});

test('继续对局 takes the seat over with a resume ticket; an ended match is explained', async () => {
  const h = setup();
  h.api.reply('POST /api/me/resume', [200, { code: 'ABCD', ticket: TICKET, join: false, reserved: false }]);
  const resumed = h.net.enter({ kind: 'resume', mode: 'coop', difficulty: 'FUNNY' });
  await settle();
  assert.equal(h.ws.last().url, `wss://game.example/ws?room=ABCD&ticket=${TICKET}`);
  await welcome(h, { resumed: true });
  roomState(h.ws.last(), { inMatch: true });
  await resumed;
  assert.equal(h.net.status, 'online');
  assert.equal(h.net.room.inMatch, true);

  const ended = setup();
  ended.api.reply('POST /api/me/resume', [200, { activeSeat: null }]);
  await assert.rejects(ended.net.enter({ kind: 'resume', mode: 'coop', difficulty: 'FUNNY' }),
    { code: 'NO_ACTIVE_MATCH', message: '对局已结束或恢复时间已过' });
  assert.equal(ended.net.status, 'menu');
});

test('继续对局 on a create that never finished creates the room with the lobby choice', async () => {
  const h = setup();
  h.api.reply('POST /api/me/resume', [200, { code: 'ABCD', ticket: TICKET, join: false, reserved: true }]);
  const resumed = h.net.enter({ kind: 'resume', mode: 'solo', difficulty: 'HARD' });
  await settle();
  await welcome(h);
  const create = h.ws.last().last('room.create');
  assert.deepEqual({ mode: create.mode, difficulty: create.difficulty }, { mode: 'solo', difficulty: 'HARD' });
  roomState(h.ws.last(), { mode: 'solo' });
  ok(h.ws.last(), 'room.create');
  await resumed;
  assert.equal(h.net.status, 'online');
});

test('a resumed seat whose session the room no longer has is not entered', async () => {
  const h = setup();
  h.api.reply('POST /api/me/resume', [200, { code: 'ABCD', ticket: TICKET, join: false, reserved: false }]);
  const resumed = h.net.enter({ kind: 'resume', mode: 'coop', difficulty: 'FUNNY' });
  const failed = assert.rejects(resumed, { code: 'NO_ACTIVE_MATCH' });
  await settle();
  await welcome(h, { resumed: false });
  await failed;
  assert.equal(h.net.status, 'menu');
  assert.equal(h.ws.last().closedWith, 1000);
});

test('a reload resumes the tab\'s seat with its saved token, only while the account is seated there', async () => {
  const h = setup();
  const restored = h.net.restore(TOKEN, { roomId: 'ABCD' });
  assert.equal(h.net.status, 'connecting', 'the boot shows the room being resumed, never the menu');
  assert.equal(h.ws.last().url, 'wss://game.example/ws?room=ABCD', 'no ticket: the token proves the seat');
  const hello = await welcome(h, { resumed: true });
  assert.equal(hello.token, TOKEN);
  roomState(h.ws.last(), { inMatch: true });
  await restored;
  assert.equal(h.net.status, 'online');
  assert.deepEqual(h.api.calls, []);

  const other = setup();
  await other.net.restore(TOKEN, { roomId: 'WXYZ' });
  await other.net.restore(null, { roomId: 'ABCD' });
  assert.equal(other.ws.sockets.length, 0);
  assert.deepEqual(other.api.calls, []);

  const ended = setup(); // /api/me still listed the seat, but the room no longer has this account's session
  const failed = assert.rejects(ended.net.restore(TOKEN, { roomId: 'ABCD' }),
    { code: 'NO_ACTIVE_MATCH', message: '对局已结束或恢复时间已过' });
  await welcome(ended, { playerId: 'p9', resumed: false });
  await failed;
  assert.equal(ended.ws.last().closedWith, 1000);
  assert.equal(ended.net.status, 'menu');
});

test('spectating opens a socket without a ticket; the end of the match closes it', async () => {
  const h = setup();
  const watching = h.net.enter({ kind: 'spectate', code: 'WXYZ' });
  await settle();
  assert.equal(h.ws.last().url, 'wss://game.example/ws?room=WXYZ');
  await welcome(h);
  roomState(h.ws.last(), { code: 'WXYZ', spectating: true, inMatch: true });
  ok(h.ws.last(), 'room.spectate');
  await watching;
  assert.equal(h.net.status, 'online');
  const delivered = [];
  for (const t of ['room.closed', 'm.public', 'm.result']) h.net.on(t, (msg) => delivered.push(t + (msg.local ? ' (local)' : '')));
  const socket = h.ws.last();
  socket.recv({ t: 'room.closed', reason: 'ended', result: true });
  assert.equal(h.net.status, 'menu');
  // the match's final view and result follow the room.closed; the server then closes the socket (4004)
  socket.recv({ t: 'm.public', phase: 'RESULT' });
  socket.recv({ t: 'm.result', victory: false });
  socket.drop(4004);
  assert.deepEqual(delivered, ['room.closed', 'm.public', 'm.result'], 'no second room.closed for the closing socket');
  assert.equal(h.net.status, 'menu');
  await h.timers.advance(60_000);
  assert.equal(h.ws.sockets.length, 1, 'never reconnects');
});

test('a room the server ended without closing its socket is closed by the client after the drain window', async () => {
  const h = setup();
  await inRoom(h);
  const socket = h.ws.last();
  socket.recv({ t: 'room.closed', reason: 'kicked' });
  assert.equal(h.net.status, 'menu');
  assert.equal(socket.closedWith, null, 'still open for the final frames');
  await h.timers.advance(DRAIN_MS);
  assert.equal(socket.closedWith, 1000);
  assert.equal(h.ws.sockets.length, 1);
});

test('spectating a room that is gone fails at once (close 4004)', async () => {
  const h = setup();
  const watching = h.net.enter({ kind: 'spectate', code: 'ZZZZ' });
  await settle();
  h.ws.last().open();
  h.ws.last().drop(4004);
  await assert.rejects(watching, { code: 'ROOM_GONE', message: '房间已关闭或已过期' });
  assert.equal(h.net.status, 'menu');
  assert.deepEqual(h.api.unexpected, []);
});

test('entering gives up after ENTER_TIMEOUT_MS when the room never answers', async () => {
  const h = setup();
  const failed = assert.rejects(h.net.enter({ kind: 'spectate', code: 'WXYZ' }), { code: 'TIMEOUT' });
  await settle();
  h.ws.last().open(); // hello sent, never answered
  await h.timers.advance(ENTER_TIMEOUT_MS);
  await failed;
  assert.equal(h.net.status, 'menu');
});

test('a room that vanished while reconnecting returns to the menu and says so', async () => {
  const h = setup();
  await inRoom(h);
  h.ws.last().drop(1006); // laptop sleeps
  await settle();
  assert.equal(h.net.status, 'reconnecting');
  await h.timers.advance(500);
  h.ws.last().open();
  h.ws.last().drop(4004); // the room's object is empty now: the Worker refuses with 4004
  await settle();
  assert.deepEqual(closes(h), [['room.closed', 'expired']]);
  assert.equal(h.net.status, 'menu');
  await h.timers.advance(10 * 60_000);
  assert.equal(h.ws.sockets.length, 2, 'never retried');
  assert.deepEqual(h.api.unexpected, []);
});

test('close 4004 in a room returns to the menu with room.closed', async () => {
  const h = setup();
  await inRoom(h);
  h.ws.last().drop(4004);
  assert.deepEqual(closes(h), [['room.closed', 'expired']]);
  assert.equal(h.net.status, 'menu');
});

test('an invalid login stops reconnecting and asks to log in again (close 4003)', async () => {
  {
    const h = setup();
    await inRoom(h);
    h.ws.last().drop(4003);
    const snap = h.net.snapshot();
    assert.equal(snap.status, 'closed');
    assert.deepEqual(snap.lastError, { code: 'LOGIN_REQUIRED', text: '登录已失效，请重新登录' });
    const sockets = h.ws.sockets.length;
    h.net.retryNow(); // the browser's 'online' event
    await h.timers.advance(10 * 60_000);
    assert.equal(h.ws.sockets.length, sockets, 'no reconnect attempts');
    assert.equal(h.net.room.code, 'ABCD', 'the seat is kept for after a new login');
    await assert.rejects(h.net.request('room.ready', { ready: true }),
      { code: 'LOGIN_REQUIRED', message: '登录已失效，请重新登录' }, 'room requests fail at once, saying why');
    assert.deepEqual(h.api.unexpected, []);
  }
});

test('leaving while the login is invalid leaves the room and still asks to log in again', async () => {
  for (const when of ['the room answers the leave with 4003', 'the leave comes after 4003']) {
    const h = setup();
    await inRoom(h);
    let leave;
    if (when === 'the room answers the leave with 4003') {
      // idle in a waiting room the login expired: the room checks it with the next message, 离开
      leave = h.net.request('room.leave');
      h.ws.last().drop(4003);
    } else {
      h.ws.last().drop(4003);
      leave = h.net.request('room.leave');
    }
    await assert.rejects(leave, { code: 'LOGIN_REQUIRED', message: '登录已失效，请重新登录' });
    const snap = h.net.snapshot();
    assert.equal(snap.status, 'closed', when);
    assert.deepEqual(snap.lastError, { code: 'LOGIN_REQUIRED', text: '登录已失效，请重新登录' });
    assert.equal(bannerVisible({ ...snap, everOnline: true }, true, false), true, 'the banner offers 重新登录');
    // out of the room by way of the menu, where the tab forgets the room's token (main.js), then lost again
    assert.deepEqual(statuses(h).slice(-2), ['menu', 'closed'], when);
    const sockets = h.ws.sockets.length;
    h.net.retryNow();
    await h.timers.advance(10 * 60_000);
    assert.equal(h.ws.sockets.length, sockets, 'no reconnect attempts');
    assert.deepEqual(closes(h), []);
    assert.deepEqual(h.api.unexpected, []);
  }
});

test('an invalid login met from the lobby asks to log in again; a later try works once logged in again', async () => {
  const h = setup();
  h.api.reply('POST /api/rooms', [401, { error: 'LOGIN_REQUIRED' }]);
  await assert.rejects(h.net.request('room.create', { mode: 'coop', difficulty: 'FUNNY' }),
    { code: 'LOGIN_REQUIRED', message: '登录已失效，请重新登录' });
  const snap = h.net.snapshot();
  assert.equal(snap.status, 'closed');
  assert.deepEqual(snap.lastError, { code: 'LOGIN_REQUIRED', text: '登录已失效，请重新登录' });
  assert.equal(bannerVisible({ ...snap, everOnline: false }, true, false), true, 'the banner offers 重新登录');
  await inRoom(h); // logged in again in another tab: the session cookie works again
  assert.equal(h.net.status, 'online');
  assert.deepEqual(h.api.unexpected, []);
});

test('a join application stops being checked when the login became invalid', async () => {
  const h = setup();
  h.net.watchApplication({ code: 'ABCD', id: 'app1', status: 'pending' });
  h.api.reply('GET /api/rooms/ABCD/applications', [401, { error: 'LOGIN_REQUIRED' }]);
  await h.timers.advance(APPLICATION_POLL_MS);
  assert.equal(h.net.status, 'closed');
  assert.equal(h.net.snapshot().lastError.code, 'LOGIN_REQUIRED');
  assert.equal(h.net.application.error.message, '登录已失效，请重新登录');
  await h.timers.advance(APPLICATION_POLL_MS * 5);
  assert.equal(h.api.calls.length, 1, 'no more checks');
  assert.deepEqual(h.api.unexpected, []);
});

test('a transient refusal is retried and the seat resumes with its token', async () => {
  const h = setup();
  await inRoom(h);
  h.ws.last().drop(1006);
  await h.timers.advance(500);
  h.api.reply('GET /api/me/active-match', [200, { activeSeat: { roomId: 'ABCD', roomGeneration: 'g1' }, status: { inMatch: false } }]);
  h.ws.last().drop(1006); // e.g. a rate limit or a Worker restart
  await settle();
  assert.equal(h.net.status, 'reconnecting');
  await h.timers.advance(1000);
  const hello = await welcome(h, { resumed: true });
  assert.equal(hello.token, TOKEN, 'the session token of the last welcome');
  assert.equal(h.net.status, 'online');
  assert.deepEqual(closes(h), []);
  assert.deepEqual(h.api.unexpected, []);
});

test('a reconnect that finds a new session ends the room: the seat expired while away', async () => {
  const h = setup();
  await inRoom(h);
  h.ws.last().drop(1006);
  await h.timers.advance(500);
  await welcome(h, { playerId: 'p2' });
  assert.deepEqual(closes(h), [['room.closed', 'timeout']]);
  assert.equal(h.net.status, 'menu');
});

test('a takeover from another page or device returns this one to the menu', async () => {
  const h = setup();
  await inRoom(h);
  h.ws.last().drop(4001);
  assert.deepEqual(closes(h), [['room.closed', 'replaced']]);
  assert.equal(h.net.status, 'menu');
  await h.timers.advance(60_000);
  assert.equal(h.ws.sockets.length, 1);
});

test('leaving returns to the menu even when the server no longer had the seat; a refused g.leave stays', async () => {
  const h = setup();
  const sock = await inRoom(h);
  const quit = h.net.request('g.leave');
  fail(sock, 'g.leave', 'WRONG_PHASE'); // no running match: quitMatch goes on with room.leave
  await assert.rejects(quit, { code: 'WRONG_PHASE' });
  assert.equal(h.net.status, 'online');
  const leave = h.net.request('room.leave');
  fail(sock, 'room.leave', 'NOT_IN_ROOM');
  await assert.rejects(leave, { code: 'NOT_IN_ROOM' });
  assert.equal(h.net.status, 'menu');
  assert.equal(sock.closedWith, 1000);
  assert.deepEqual(statuses(h).slice(-2), ['online', 'menu']);
});

test('quitting a match (g.leave confirmed) returns to the menu, and the following room.leave settles at once', async () => {
  const h = setup();
  const sock = await inRoom(h);
  const quit = h.net.request('g.leave');
  ok(sock, 'g.leave');
  await quit;
  assert.equal(h.net.status, 'menu');
  await assert.rejects(h.net.request('room.leave'), { code: 'NOT_IN_ROOM' });
});

test('idle heartbeats allow platform auto-response without corrupting the game clock', async () => {
  const h = setup();
  const sock = await inRoom(h);
  const first = sock.last('ping');
  assert.ok(first.c > 0, 'the welcome ping measures the clock');
  sock.recv({ t: 'pong', c: first.c, s: first.c + 200 });
  const offset = h.net.clockOffset;
  assert.equal(h.net.clockSynced, true);
  await h.timers.advance(4000);
  assert.deepEqual(sock.last('ping'), { t: 'ping', c: 0 }, 'outside a match: the auto-response pair');
  await h.timers.advance(100);
  sock.recv({ t: 'pong', c: 0 });
  assert.equal(h.net.ping, 100);
  assert.equal(h.net.clockOffset, offset);
  roomState(sock, { inMatch: true });
  await h.timers.advance(4000);
  assert.ok(sock.last('ping').c > first.c, 'in a match pings reach the room with a timestamp');
});

// ---- 匹配 (matchmaking) over the account API (DESIGN §28.2) ----------------------------------------------------------

const queueEvents = (h) => {
  const seen = [];
  h.net.on('queue.status', (m) => seen.push(['status', m.waiting, m.count ?? null]));
  h.net.on('queue.matched', (m) => seen.push(['matched', m.code, m.seated, m.expect]));
  return seen;
};

test('matchmaking from the menu: join polls the queue and reports it; leaving stops polling and tells the queue', async () => {
  const h = setup();
  const seen = queueEvents(h);
  h.api.reply('POST /api/queue', [200, { waiting: true, difficulty: 'NORMAL', count: 1, total: 1, waitedMs: 0 }],
    [200, { waiting: true, difficulty: 'NORMAL', count: 2, total: 2, waitedMs: 1500 }],
    [200, { waiting: false }]);
  await h.net.request('queue.join', { difficulty: 'NORMAL' });
  await h.timers.advance(QUEUE_POLL_MS);
  assert.deepEqual(h.api.calls.map((c) => c.body), [{ action: 'join', difficulty: 'NORMAL' }, { action: 'poll', difficulty: 'NORMAL' }]);
  await h.net.request('queue.leave');
  await h.timers.advance(QUEUE_POLL_MS * 3);
  assert.deepEqual(h.api.calls.map((c) => c.body.action), ['join', 'poll', 'leave'], 'no poll after leaving');
  assert.deepEqual(seen, [['status', true, 1], ['status', true, 2], ['status', false, 0]]);
  assert.equal(h.ws.sockets.length, 0, 'waiting needs no socket');
  assert.deepEqual(h.api.unexpected, []);
});

test('matched as the host: the page opens the room, reports it, and approves its group\'s applications only', async () => {
  const h = setup();
  const seen = queueEvents(h);
  h.api.reply('POST /api/queue', [200, { waiting: true, difficulty: 'HARD', count: 2, total: 2, waitedMs: 0 }],
    [200, { waiting: false, matched: { role: 'host', difficulty: 'HARD', code: null, expect: 2, members: ['acc-b'] } }],
    [200, { waiting: false, matched: { role: 'host', difficulty: 'HARD', code: 'ABCD', expect: 2, members: ['acc-b'] } }]);
  h.api.reply('POST /api/rooms', [201, { code: 'ABCD', ticket: TICKET, generation: 'g1' }]);
  await h.net.request('queue.join', { difficulty: 'HARD' });
  await h.timers.advance(QUEUE_POLL_MS);
  await welcome(h);
  const sock = h.ws.last();
  assert.deepEqual({ mode: sock.last('room.create').mode, difficulty: sock.last('room.create').difficulty }, { mode: 'coop', difficulty: 'HARD' });
  h.api.reply('GET /api/rooms/ABCD/applications', [200, { items: [
    { id: 'x1', accountId: 'acc-stranger', status: 'pending' },
    { id: 'b1', accountId: 'acc-b', status: 'pending' },
  ] }]);
  h.api.reply('POST /api/rooms/ABCD/applications', [200, { id: 'b1', status: 'approved' }]);
  roomState(sock);
  ok(sock, 'room.create');
  await settle();
  await settle();
  const hostedCall = h.api.calls.find((c) => c.body?.action === 'hosted');
  assert.deepEqual(hostedCall.body, { action: 'hosted', code: 'ABCD' });
  assert.deepEqual(seen.at(-1), ['matched', 'ABCD', true, 2]);
  await h.timers.advance(QUEUE_POLL_MS);
  const approvals = h.api.calls.filter((c) => c.key === 'POST /api/rooms/ABCD/applications').map((c) => c.body);
  assert.deepEqual(approvals, [{ action: 'approve', id: 'b1' }], 'the stranger is not approved');
  await h.timers.advance(QUEUE_POLL_MS * 10);
  assert.equal(h.api.calls.filter((c) => c.key === 'GET /api/rooms/ABCD/applications').length, 1, 'the group is complete: no more checks');
  assert.deepEqual(h.api.unexpected, []);
});

test('matched as a member: the page is handed the room code (main.js joins it like an invite)', async () => {
  const h = setup();
  const seen = queueEvents(h);
  h.api.reply('POST /api/queue', [200, { waiting: true, difficulty: 'NORMAL', count: 2, total: 2, waitedMs: 0 }],
    [200, { waiting: false, matched: { role: 'member', difficulty: 'NORMAL', code: 'WXYZ' } }]);
  await h.net.request('queue.join', { difficulty: 'NORMAL' });
  await h.timers.advance(QUEUE_POLL_MS);
  assert.deepEqual(seen, [['status', true, 2], ['status', false, 0], ['matched', 'WXYZ', true, 0]]);
  assert.equal(h.ws.sockets.length, 0, 'the member opens no room of its own');
  await h.timers.advance(QUEUE_POLL_MS * 4);
  assert.equal(h.api.calls.length, 2, 'matched: no more polls');
  assert.deepEqual(h.api.unexpected, []);
});

test('a page already in a room cannot queue', async () => {
  const h = setup();
  await inRoom(h);
  await assert.rejects(h.net.request('queue.join', { difficulty: 'NORMAL' }), { code: 'ALREADY_IN_ROOM' });
});

test('a cancel while the matched host opens its room: the page leaves that room again and never reports it', async () => {
  const h = setup();
  h.api.reply('POST /api/queue', [200, { waiting: true, difficulty: 'NORMAL', count: 2, total: 2, waitedMs: 0 }],
    [200, { waiting: false, matched: { role: 'host', difficulty: 'NORMAL', code: null, expect: 2, members: ['acc-b'] } }],
    [200, { waiting: false }]);
  h.api.reply('POST /api/rooms', [201, { code: 'ABCD', ticket: TICKET, generation: 'g1' }]);
  await h.net.request('queue.join', { difficulty: 'NORMAL' });
  await h.timers.advance(QUEUE_POLL_MS);
  await welcome(h);
  const sock = h.ws.last();
  await h.net.request('queue.leave'); // the player clicks cancel while room.create is on its way
  roomState(sock);
  ok(sock, 'room.create');
  await settle();
  await settle();
  assert.ok(sock.last('room.leave'), 'the room opened for the group is left again');
  assert.deepEqual(h.api.calls.filter((c) => c.key === 'POST /api/queue').map((c) => c.body.action), ['join', 'poll', 'leave'], 'no hosted report');
  assert.deepEqual(h.api.unexpected, []);
});

test('entering a room another way leaves the queue; an invalid login met queueing asks to log in again', async () => {
  const h = setup();
  h.api.reply('POST /api/queue', [200, { waiting: true, difficulty: 'NORMAL', count: 1, total: 1, waitedMs: 0 }],
    [200, { waiting: false }], [401, { error: 'LOGIN_REQUIRED' }]);
  h.api.reply('POST /api/rooms/WXYZ/applications', [201, { id: 'app1', status: 'pending' }]);
  await h.net.request('queue.join', { difficulty: 'NORMAL' });
  await h.net.request('room.join', { code: 'WXYZ' }); // an application to a public room
  await h.timers.advance(QUEUE_POLL_MS * 1.5);
  assert.deepEqual(h.api.calls.filter((c) => c.key === 'POST /api/queue').map((c) => c.body.action), ['join', 'leave']);
  await h.net.cancelApplication().catch(() => {}); // (no reply needed: the next try is refused before any request)
  h.net.watchApplication(null);
  await assert.rejects(h.net.request('queue.join', { difficulty: 'NORMAL' }), { code: 'LOGIN_REQUIRED' });
  assert.equal(h.net.snapshot().lastError.code, 'LOGIN_REQUIRED', 'the 重新登录 banner shows');
});

test('a matched group whose room could not be reported tells the player why', async () => {
  const h = setup();
  const errors = [];
  h.net.on('queue.status', (m) => { if (m.error) errors.push(m.error); });
  h.api.reply('POST /api/queue', [200, { waiting: false, matched: { role: 'host', difficulty: 'NORMAL', code: null, expect: 2, members: ['acc-b'] } }],
    [400, { error: 'BAD_TARGET' }], [200, { waiting: false }]);
  h.api.reply('POST /api/rooms', [201, { code: 'ABCD', ticket: TICKET, generation: 'g1' }]);
  void h.net.request('queue.join', { difficulty: 'NORMAL' });
  await settle();
  await welcome(h);
  const sock = h.ws.last();
  roomState(sock);
  ok(sock, 'room.create');
  await settle();
  await settle();
  await settle();
  assert.deepEqual(errors, ['BAD_TARGET']);
  assert.deepEqual(h.api.calls.filter((c) => c.key === 'POST /api/queue').map((c) => c.body.action), ['join', 'hosted', 'leave']);
  assert.equal(h.net.state, 'room', 'the room it did open stays the player\'s');
});
