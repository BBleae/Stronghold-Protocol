// 在线人数 (presence counters) on the Cloudflare deployment (worker/presence.js): the board the rooms report to (sums,
// replacement, withdrawal, the lease that drops a silent room), the 匹配 queue's waiting pages counted as online, the
// board's route in the Matchmaker, the room's report job (counts up and down, renewal, a failed report, the `presence`
// frame), and GET /healthz reading the sums through its short cache (isolate copy, Cache API, STATUS_LIMIT, a failing or
// slow board).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import worker, { RoomDurableObject } from '../../worker/index.js';
import { Matchmaker, MatchQueue, QUEUE } from '../../worker/matchmaker.js';
import { RoomRuntime } from '../../worker/room-runtime.js';
import { PRESENCE, PRESENCE_PATH, PresenceBoard, healthPresence, presenceCacheState, readBoard, resetPresenceCache }
  from '../../worker/presence.js';

const clock = (t = 1_000_000) => {
  const c = { t };
  c.now = () => c.t;
  return c;
};

// A MATCHMAKER binding whose single instance is `dobj` (a real Matchmaker), with its requests counted.
function binding(dobj) {
  const b = { calls: [], idFromName: (name) => name };
  b.get = (id) => ({ fetch: async (request) => {
    b.calls.push({ id, method: request.method, path: new URL(request.url).pathname });
    return dobj.fetch(request);
  } });
  return b;
}

test('the board sums the rooms\' reports; a report replaces the room\'s last one, zeros withdraw it', () => {
  const c = clock();
  const board = new PresenceBoard({ now: c.now });
  assert.deepEqual(board.totals(), { online: 0, inRoom: 0, rooms: 0 });
  assert.equal(board.report({ roomId: 'ABCD', online: 2, inRoom: 2 }), true);
  assert.equal(board.report({ roomId: 'EFGH', online: 3, inRoom: 1 }), true);
  assert.deepEqual(board.totals(), { online: 5, inRoom: 3, rooms: 2 });
  // up and down
  board.report({ roomId: 'ABCD', online: 4, inRoom: 3 });
  assert.deepEqual(board.totals(), { online: 7, inRoom: 4, rooms: 2 });
  board.report({ roomId: 'EFGH', online: 1, inRoom: 0 });
  assert.deepEqual(board.totals(), { online: 5, inRoom: 3, rooms: 2 });
  // a seat kept for a dropped player: in a room, not online
  board.report({ roomId: 'EFGH', online: 0, inRoom: 1 });
  assert.deepEqual(board.totals(), { online: 4, inRoom: 4, rooms: 2 });
  board.report({ roomId: 'EFGH', online: 0, inRoom: 0 });
  assert.deepEqual(board.totals(), { online: 4, inRoom: 3, rooms: 1 }, 'zeros withdraw the room');
  // malformed reports change nothing
  for (const bad of [{}, { roomId: 'abcd', online: 1, inRoom: 1 }, { roomId: 'ABCDE', online: 1, inRoom: 1 },
    { roomId: 'ABCD', online: -1, inRoom: 0 }, { roomId: 'ABCD', online: 1.5, inRoom: 0 }, { roomId: 'ABCD', online: '1', inRoom: 0 },
    { roomId: 'ABCD', online: 1, inRoom: 1e9 }]) {
    assert.equal(board.report(bad), false, JSON.stringify(bad));
  }
  assert.deepEqual(board.totals(), { online: 4, inRoom: 3, rooms: 1 });
});

test('a room that stops reporting drops out when its lease lapses; a renewal keeps it', () => {
  const c = clock();
  const board = new PresenceBoard({ now: c.now });
  board.report({ roomId: 'ABCD', online: 2, inRoom: 2 });
  board.report({ roomId: 'EFGH', online: 1, inRoom: 1 });
  c.t += PRESENCE.refreshMs;
  board.report({ roomId: 'ABCD', online: 2, inRoom: 2 }); // renewed: its login checks woke it
  c.t += PRESENCE.leaseMs - PRESENCE.refreshMs - 1;
  assert.deepEqual(board.totals(), { online: 3, inRoom: 3, rooms: 2 }, 'still within EFGH\'s lease');
  c.t += 1;
  assert.deepEqual(board.totals(), { online: 2, inRoom: 2, rooms: 1 }, 'EFGH (evicted, crashed) dropped out');
  c.t += PRESENCE.refreshMs;
  assert.deepEqual(board.totals(), { online: 0, inRoom: 0, rooms: 0 });
  // the lease outlasts the forced renewal: a room that someone is connected to never drops out between renewals
  assert.ok(PRESENCE.leaseMs > PRESENCE.forceMs && PRESENCE.forceMs > PRESENCE.refreshMs);
});

test('the 匹配 queue\'s waiting pages count as online until they go silent or are handed their room', () => {
  const c = clock();
  const q = new MatchQueue({ now: c.now });
  assert.equal(q.waiting(), 0);
  q.join('a', 'NORMAL');
  q.join('b', 'HARD');
  assert.equal(q.waiting(), 2);
  c.t += QUEUE.silentMs - 1;
  q.join('a', 'NORMAL');
  c.t += 1;
  assert.equal(q.waiting(), 1, 'b stopped polling');
  // a group: its members wait for the host's room; a member handed the code leaves for the room (its socket counts there)
  q.join('b', 'NORMAL', { fresh: true });
  c.t += QUEUE.graceMs;
  q.tick();
  assert.equal(q.waiting(), 2, 'the formed group still waits here');
  q.join('a', 'NORMAL');
  q.hosted('a', 'ABCD');
  assert.equal(q.waiting(), 1, 'the host reported its room: it is in it');
  q.join('b', 'NORMAL');
  assert.equal(q.status('b').matched.code, 'ABCD');
  assert.equal(q.waiting(), 0, 'b was handed the code');
  q.join('c', 'HARD');
  assert.equal(q.waiting(), 1);
  q.leave('c');
  assert.equal(q.waiting(), 0);
});

test('the Matchmaker answers the board\'s route: rooms report, /healthz reads; online includes the queue', async () => {
  const c = clock();
  const dobj = new Matchmaker(null, {}, { now: c.now });
  const call = (method, body) => dobj.fetch(new Request('https://queue.internal' + PRESENCE_PATH,
    { method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }));
  assert.deepEqual(await (await call('GET')).json(), { online: 0, inRoom: 0, rooms: 0, queued: 0 });
  const reported = await call('POST', { roomId: 'ABCD', online: 3, inRoom: 2 });
  assert.equal(reported.status, 200);
  assert.deepEqual(await reported.json(), { online: 3, inRoom: 2, rooms: 1, queued: 0 }, 'a report answers the sums');
  // a page waiting in the queue (it polls; no socket) is online, not in a room
  await dobj.fetch(new Request('https://queue.internal/_queue', { method: 'POST', headers: { 'X-Account-ID': 'q' },
    body: JSON.stringify({ action: 'join', difficulty: 'NORMAL' }) }));
  assert.deepEqual(await (await call('GET')).json(), { online: 4, inRoom: 2, rooms: 1, queued: 1 });
  assert.equal((await call('POST', { roomId: 'nope', online: 1, inRoom: 1 })).status, 400);
  assert.equal((await call('POST', '{')).status, 400);
  assert.equal((await call('PUT', {})).status, 405);
  // the queue's own route is unchanged: no account, no answer
  const queue = await dobj.fetch(new Request('https://queue.internal/_queue', { method: 'POST', body: '{}' }));
  assert.equal(queue.status, 400);
});

// --- the room's report job (RoomDurableObject.publishPresence) ---

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  frames = [];
  send(data) { this.frames.push(JSON.parse(data)); }
  close(code, reason) { this.closed = { code, reason }; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(1008, 'terminated'); }
  take(type) { return this.frames.filter((f) => f.t === type).at(-1); }
}

// A room's Durable Object reduced to its presence job: the real RoomRuntime (fake sockets), the real Matchmaker behind
// MATCHMAKER, background jobs collected (settle() waits for them), an event that just runs.
function roomWorld(t, { code = 'ABCD', fail = () => false } = {}) {
  const c = clock(Date.now());
  const rt = new RoomRuntime({ now: c.now });
  t.after(() => rt.lobby.shutdown());
  const ticket = rt.reserve(code, 'owner');
  const dobj = new Matchmaker(null, {}, { now: c.now });
  const env = { MATCHMAKER: binding(dobj) };
  const inner = env.MATCHMAKER.get;
  env.MATCHMAKER.get = (id) => {
    const stub = inner(id);
    return { fetch: async (request) => { if (fail()) throw new Error('board unavailable (test)'); return stub.fetch(request); } };
  };
  const jobs = [];
  const room = {
    runtime: rt, env, presence: { busy: false, failures: 0, retryAt: 0, key: null, at: 0 },
    ctx: { waitUntil: (promise) => jobs.push(promise) },
    event: async (handle) => handle(),
  };
  const publish = () => RoomDurableObject.prototype.publishPresence.call(room);
  const due = () => RoomDurableObject.prototype.presenceDue.call(room);
  // one event's end: the job runs, its report (if any) is answered
  const commit = async () => {
    publish();
    while (jobs.length) await jobs.shift();
  };
  const connect = (accountId, opts = {}) => {
    const ws = new Socket();
    rt.connect(ws, { ip: '8.8.8.8', accountId, name: accountId, ...opts });
    rt.message(ws, JSON.stringify({ t: 'hello', name: accountId, rid: 1 }));
    return ws;
  };
  const board = async () => (await dobj.fetch(new Request('https://queue.internal' + PRESENCE_PATH))).json();
  const reports = () => env.MATCHMAKER.calls.filter((x) => x.method === 'POST').length;
  return { c, rt, ticket, room, commit, connect, board, reports, due, dobj };
}

test('a room reports its sockets and its people when they change, and withdraws once both are zero', async (t) => {
  const w = roomWorld(t);
  await w.commit();
  assert.equal(w.reports(), 0, 'an empty room has nothing to report');
  const owner = w.connect('owner', { ticket: w.ticket });
  await w.commit();
  assert.deepEqual(await w.board(), { online: 1, inRoom: 0, rooms: 1, queued: 0 }, 'a socket, no room yet');
  w.rt.message(owner, JSON.stringify({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY', rid: 2 }));
  await w.commit();
  assert.deepEqual(await w.board(), { online: 1, inRoom: 1, rooms: 1, queued: 0 }, 'the host holds a seat');
  const before = w.reports();
  await w.commit();
  assert.equal(w.reports(), before, 'unchanged numbers are not reported again before the renewal');
  // the room's sessions get the site-wide sums as the presence frame, with numbers only
  assert.deepEqual(owner.take('presence'), { t: 'presence', online: 1, inRoom: 1 });
  // a guest the host approved joins: both numbers go up
  const item = w.rt.applications.apply({ accountId: 'guest', name: 'guest' });
  const { ticket } = w.rt.applications.decide('owner', item.id, 'approved', { hostId: 'owner', inMatch: false, freeSeats: 3 });
  const guest = w.connect('guest', { ticket });
  w.rt.message(guest, JSON.stringify({ t: 'room.join', code: 'ABCD', rid: 2 }));
  await w.commit();
  assert.deepEqual(await w.board(), { online: 2, inRoom: 2, rooms: 1, queued: 0 });
  assert.deepEqual(owner.take('presence'), { t: 'presence', online: 2, inRoom: 2 }, 'the change reaches the room');
  // the guest leaves: down again
  w.rt.message(guest, JSON.stringify({ t: 'room.leave', rid: 3 }));
  guest.close(1000, 'left');
  w.rt.disconnect(guest);
  await w.commit();
  assert.deepEqual(await w.board(), { online: 1, inRoom: 1, rooms: 1, queued: 0 });
  // the host leaves too: the room is gone, its report withdrawn at once
  w.rt.message(owner, JSON.stringify({ t: 'room.leave', rid: 4 }));
  owner.close(1000, 'left');
  w.rt.disconnect(owner);
  await w.commit();
  assert.deepEqual(await w.board(), { online: 0, inRoom: 0, rooms: 0, queued: 0 });
  assert.equal(w.room.presence.key, null);
  for (const ws of [owner, guest]) {
    for (const frame of ws.frames.filter((f) => f.t === 'presence')) {
      assert.ok(Number.isInteger(frame.online) && Number.isInteger(frame.inRoom), `numbers only: ${JSON.stringify(frame)}`);
    }
  }
});

test('a room renews its report at its first event after refreshMs; it is woken for it only while someone is connected', async (t) => {
  const w = roomWorld(t);
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  let at = realNow();
  Date.now = () => at;
  const owner = w.connect('owner', { ticket: w.ticket });
  w.rt.message(owner, JSON.stringify({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY', rid: 2 }));
  await w.commit();
  const reported = w.reports();
  const since = w.room.presence.at;
  assert.equal(w.due(), since + PRESENCE.forceMs, 'woken for the renewal at the latest forceMs after');
  at = since + PRESENCE.refreshMs - 1;
  await w.commit();
  assert.equal(w.reports(), reported, 'not yet');
  at = since + PRESENCE.refreshMs;
  await w.commit();
  assert.equal(w.reports(), reported + 1, 'renewed at the first event refreshMs after the last report');
  // nobody connected (the host dropped; its seat is kept for the lobby grace): reported once, never woken for it
  owner.close(1006, 'drop');
  w.rt.disconnect(owner);
  await w.commit();
  assert.deepEqual(await w.board(), { online: 0, inRoom: 1, rooms: 1, queued: 0 });
  assert.equal(w.due(), Infinity, 'a room nobody is connected to is never woken for its report');
});

test('a failed report is retried after a backoff while someone is connected; a failed withdrawal is left to the lease', async (t) => {
  let failing = true;
  const w = roomWorld(t, { fail: () => failing });
  const warn = t.mock.method(console, 'warn', () => {});
  const owner = w.connect('owner', { ticket: w.ticket });
  await w.commit();
  assert.equal(w.room.presence.failures, 1);
  assert.equal(w.room.presence.key, null, 'the board holds nothing for the room yet');
  const retryAt = w.room.presence.retryAt;
  assert.ok(retryAt > Date.now() && retryAt <= Date.now() + PRESENCE.refreshMs, 'the backoff never exceeds refreshMs');
  assert.equal(w.due(), retryAt, 'the room is woken for the retry');
  assert.ok(warn.mock.calls.some((call) => call.arguments[0]?.event === 'presence_report_failed'));
  await w.commit();
  assert.equal(w.room.presence.failures, 1, 'nothing is retried before its backoff');
  failing = false;
  w.room.presence.retryAt = 0;
  await w.commit();
  assert.deepEqual(await w.board(), { online: 1, inRoom: 0, rooms: 1, queued: 0 });
  assert.equal(w.room.presence.failures, 0);
  // the withdrawal fails: not retried (the board's lease forgets the room)
  failing = true;
  owner.close(1000, 'gone');
  w.rt.disconnect(owner);
  await w.commit();
  assert.deepEqual([w.room.presence.failures, w.room.presence.key, w.due()], [0, null, Infinity]);
});

// --- GET /healthz: the sums through the short cache ---

// A board answering `sums`, its reads counted; `delay` (ms) or `fail` make it slow or failing.
function fakeBoard(sums = { online: 3, inRoom: 2 }) {
  const b = { sums, reads: 0, fail: false, delay: 0, idFromName: (name) => name };
  b.get = () => ({ fetch: async () => {
    b.reads++;
    if (b.delay) await new Promise((resolve) => setTimeout(resolve, b.delay));
    if (b.fail) throw new Error('board unavailable (test)');
    return Response.json({ ...b.sums, rooms: 1, queued: 0 });
  } });
  return b;
}
// A Cache API cache in memory (match / put by URL; max-age is not modelled: entries carry their own `at`).
function fakeCache() {
  const entries = new Map();
  return { entries, async match(key) { return entries.get(key.url)?.clone(); }, async put(key, response) { entries.set(key.url, response.clone()); } };
}
const request = (ip = '8.8.8.8') => new Request('https://game.example/healthz', { headers: { 'CF-Connecting-IP': ip } });

test('/healthz reads the board at most once per cacheMs per isolate, and concurrent requests share one read', async () => {
  const c = clock();
  const board = fakeBoard();
  const env = { MATCHMAKER: board };
  const state = presenceCacheState();
  const read = () => healthPresence(request(), env, { now: c.now, cache: null, state });
  assert.deepEqual(await read(), { online: 3, inRoom: 2 });
  board.sums = { online: 5, inRoom: 4 };
  c.t += PRESENCE.cacheMs - 1;
  assert.deepEqual(await read(), { online: 3, inRoom: 2 }, 'the isolate\'s copy');
  assert.equal(board.reads, 1);
  c.t += 1;
  assert.deepEqual(await read(), { online: 5, inRoom: 4 }, 'read again once the copy is cacheMs old');
  // counts go down as well
  board.sums = { online: 1, inRoom: 0 };
  c.t += PRESENCE.cacheMs;
  const all = await Promise.all(Array.from({ length: 20 }, read));
  assert.ok(all.every((p) => p.online === 1 && p.inRoom === 0));
  assert.equal(board.reads, 3, 'twenty concurrent requests, one read');
});

test('/healthz shares its read with the other isolates of the location through the Cache API', async () => {
  const c = clock();
  const board = fakeBoard();
  const env = { MATCHMAKER: board };
  const cache = fakeCache();
  assert.deepEqual(await healthPresence(request(), env, { now: c.now, cache, state: presenceCacheState() }), { online: 3, inRoom: 2 });
  c.t += 1000;
  // another isolate: its own copy is empty, the location's cache answers
  assert.deepEqual(await healthPresence(request(), env, { now: c.now, cache, state: presenceCacheState() }), { online: 3, inRoom: 2 });
  assert.equal(board.reads, 1);
  // the location's copy is as old as the read it holds: past cacheMs, a fresh read
  c.t += PRESENCE.cacheMs;
  board.sums = { online: 0, inRoom: 0 };
  assert.deepEqual(await healthPresence(request(), env, { now: c.now, cache, state: presenceCacheState() }), { online: 0, inRoom: 0 });
  assert.equal(board.reads, 2);
});

test('/healthz counts a board read against STATUS_LIMIT; a network over it gets the last sums, never the board', async () => {
  const c = clock();
  const board = fakeBoard();
  const counted = [];
  let allow = true;
  const env = { MATCHMAKER: board, STATUS_LIMIT: { limit: async ({ key }) => { counted.push(key); return { success: allow }; } } };
  const state = presenceCacheState();
  const read = (ip) => healthPresence(request(ip), env, { now: c.now, cache: null, state });
  assert.deepEqual(await read('8.8.8.8'), { online: 3, inRoom: 2 });
  assert.deepEqual(await read('8.8.8.8'), { online: 3, inRoom: 2 });
  assert.deepEqual(counted, ['net:8.8.8.8'], 'only the read past the cache counts');
  allow = false;
  board.sums = { online: 9, inRoom: 9 };
  c.t += PRESENCE.cacheMs;
  assert.deepEqual(await read('9.9.9.9'), { online: 3, inRoom: 2 }, 'over its limit: the last sums');
  assert.equal(board.reads, 1, 'the board was not read');
  // nothing read within staleMs: unknown
  const empty = presenceCacheState();
  assert.deepEqual(await healthPresence(request('9.9.9.9'), env, { now: c.now, cache: null, state: empty }), { online: null, inRoom: null });
  // a limit binding that throws leaves the counters unknown; the health answer itself never fails on them
  const broken = { MATCHMAKER: board, STATUS_LIMIT: { limit: async () => { throw new Error('binding down (test)'); } } };
  assert.deepEqual(await healthPresence(request(), broken, { now: c.now, cache: null, state: presenceCacheState() }), { online: null, inRoom: null });
  resetPresenceCache();
  const health = await worker.fetch(request(), broken);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json().then((h) => [h.ok, h.online, h.inRoom]), [true, null, null]);
  resetPresenceCache();
});

test('/healthz: a network over its limit never keeps the board from another network — its refusal is no attempt, and a request that joined its read reads the board itself', async () => {
  const c = clock();
  const board = fakeBoard();
  const env = { MATCHMAKER: board, STATUS_LIMIT: { limit: async ({ key }) => ({ success: key !== 'net:1.1.1.1' }) } };
  const state = presenceCacheState();
  const read = (ip) => healthPresence(request(ip), env, { now: c.now, cache: null, state });
  assert.deepEqual(await read('8.8.8.8'), { online: 3, inRoom: 2 });
  // 1.1.1.1 (over its limit: a NAT of many lobby pages) polls every second and is the first past each cacheMs; 8.8.8.8
  // polls every 10 s, just after it
  const seen = [];
  for (let s = 1; s <= 120; s++) {
    c.t += 1000;
    if (s === 30) board.sums = { online: 7, inRoom: 5 };
    assert.deepEqual(await read('1.1.1.1'), staleSums(state, c.t), `${s} s: the over-limit network gets the last sums at most`);
    if (s % 10 === 0) seen.push([s, await read('8.8.8.8')]);
  }
  assert.ok(seen.every(([, v]) => v.online != null), `never unknown for 8.8.8.8: ${JSON.stringify(seen)}`);
  assert.ok(seen.filter(([s]) => s >= 40).every(([, v]) => v.online === 7), 'the board\'s new sums reach it');
  assert.ok(board.reads >= 10, `the board is read for it (${board.reads})`);
  // the two at once: 8.8.8.8 joins the read 1.1.1.1 started, which its limit refuses — it reads the board itself
  c.t += PRESENCE.cacheMs;
  board.sums = { online: 9, inRoom: 9 };
  const [over, ok] = await Promise.all([read('1.1.1.1'), read('8.8.8.8')]);
  assert.deepEqual([over, ok], [{ online: 7, inRoom: 5 }, { online: 9, inRoom: 9 }]);
});
const staleSums = (state, t) => (state.value && t - state.at < PRESENCE.staleMs ? state.value : { online: null, inRoom: null });

test('/healthz: a read in flight that never settles (its request was cancelled with its I/O) holds no request past timeoutMs + graceMs, and the next one reads afresh; the read runs under the request\'s waitUntil', async () => {
  const c = clock();
  const board = fakeBoard();
  const env = { MATCHMAKER: board };
  const state = presenceCacheState();
  let hang = true;
  const cache = { async match() { if (hang) return new Promise(() => {}); return undefined; }, async put() {} };
  const opts = { now: c.now, cache, state, timeoutMs: 20, graceMs: 30 };
  const bounded = (p) => Promise.race([p, new Promise((resolve) => setTimeout(() => resolve('hung'), 1000))]);
  // the starting request's read is stuck (cancelled): its waiters give up after 50 ms with the last sums (none: unknown)
  const first = healthPresence(request(), env, opts);
  const second = healthPresence(request(), env, opts);
  assert.deepEqual(await bounded(first), { online: null, inRoom: null });
  assert.deepEqual(await bounded(second), { online: null, inRoom: null });
  // a later request (past the bound) drops the stuck read and reads afresh
  hang = false;
  c.t += 100;
  assert.deepEqual(await bounded(healthPresence(request(), env, opts)), { online: 3, inRoom: 2 });
  assert.equal(board.reads, 1);
  // GET /healthz hands the read to the request's waitUntil
  resetPresenceCache();
  const kept = [];
  const res = await worker.fetch(request(), env, { waitUntil: (p) => kept.push(p), passThroughOnException() {} });
  assert.equal(res.status, 200);
  assert.equal(kept.length, 1, 'the read is kept alive by the request that started it');
  await Promise.all(kept);
  resetPresenceCache();
});

test('/healthz leaves the counters unknown when the board fails or is slow, and does not retry it within cacheMs', async () => {
  const c = clock();
  const board = fakeBoard();
  const env = { MATCHMAKER: board };
  const state = presenceCacheState();
  const read = (o = {}) => healthPresence(request(), env, { now: c.now, cache: null, state, timeoutMs: 50, ...o });
  assert.deepEqual(await read(), { online: 3, inRoom: 2 });
  board.fail = true;
  c.t += PRESENCE.cacheMs;
  assert.deepEqual(await read(), { online: 3, inRoom: 2 }, 'a failing board: the last sums while they are under staleMs old');
  assert.equal(board.reads, 2);
  c.t += 1;
  await read();
  assert.equal(board.reads, 2, 'a failed read is not tried again sooner than cacheMs');
  c.t += PRESENCE.staleMs;
  assert.deepEqual(await read(), { online: null, inRoom: null }, 'nothing read for staleMs: unknown');
  // a board that does not answer in time
  board.fail = false;
  board.delay = 500;
  c.t += PRESENCE.cacheMs;
  assert.deepEqual(await read(), { online: null, inRoom: null });
  // no board bound at all
  assert.deepEqual(await healthPresence(request(), {}, { now: c.now, cache: null, state: presenceCacheState() }), { online: null, inRoom: null });
  // readBoard never throws
  assert.equal(await readBoard({ MATCHMAKER: { idFromName: () => 'x', get: () => { throw new Error('no stub'); } } }), null);
});

test('GET /healthz carries numeric online / inRoom from the board (and null without one)', async () => {
  resetPresenceCache();
  const dobj = new Matchmaker(null, {});
  const env = { MATCHMAKER: binding(dobj), STATUS_LIMIT: { limit: async () => ({ success: true }) } };
  await dobj.fetch(new Request('https://queue.internal' + PRESENCE_PATH, { method: 'POST',
    body: JSON.stringify({ roomId: 'ABCD', online: 2, inRoom: 1 }) }));
  const health = await (await worker.fetch(request(), env)).json();
  assert.equal(health.ok, true);
  assert.equal(health.runtime, 'cloudflare');
  assert.deepEqual([health.online, health.inRoom], [2, 1]);
  resetPresenceCache();
  const bare = await (await worker.fetch(request(), {})).json();
  assert.deepEqual([bare.ok, bare.online, bare.inRoom], [true, null, null]);
  resetPresenceCache();
});
