// 匹配 in account mode (DESIGN §28.2): worker/matchmaker.js MatchQueue — the Node queue's grouping rules
// (server/lobby.js queueTick, test/matchmaking.test.js) behind a polled Durable Object, plus the room hand-over: the host
// reports its room's code, the members get it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchQueue, Matchmaker, QUEUE } from '../../worker/matchmaker.js';
import { DEFAULT_SEATS } from '../../shared/constants.js';

const clock = () => {
  const c = { t: 1000 };
  c.now = () => c.t;
  return c;
};

test('two players of one difficulty form a group after the grace; the first is the host', () => {
  const c = clock();
  const q = new MatchQueue({ now: c.now });
  assert.equal(q.join('a', 'NORMAL').waiting, true);
  c.t += 500;
  const b = q.join('b', 'NORMAL');
  assert.deepEqual([b.waiting, b.count, b.minSeats, b.seats], [true, 2, QUEUE.minSeats, DEFAULT_SEATS]);
  c.t += QUEUE.graceMs - 1;
  assert.equal(q.join('a', 'NORMAL').waiting, true, 'the grace runs from the last arrival');
  c.t += 1;
  const host = q.join('a', 'NORMAL');
  assert.deepEqual(host, { waiting: false, matched: { role: 'host', difficulty: 'NORMAL', code: null, expect: 2, members: ['b'] } });
  const member = q.join('b', 'NORMAL');
  assert.equal(member.waiting, true, 'a member waits until the host opened the room');
  assert.equal(member.matched, undefined);
});

test('difficulties never mix; a full group of four starts at once', () => {
  const c = clock();
  const q = new MatchQueue({ now: c.now });
  for (const id of ['a', 'b', 'c']) q.join(id, 'NORMAL');
  q.join('x', 'HARD');
  assert.equal(q.status('a').waiting, true);
  q.join('d', 'NORMAL');
  for (const id of ['a', 'b', 'c', 'd']) assert.ok(q.groupOf.has(id), `${id} grouped at once (4 = DEFAULT_SEATS)`);
  assert.deepEqual(q.status('a').matched.members, ['b', 'c', 'd']);
  assert.equal(q.status('x').waiting, true);
  assert.equal(q.status('x').count, 1, 'the HARD player counts only HARD players');
  q.join('e', 'NORMAL');
  assert.equal(q.status('e').waiting, true, 'a fifth NORMAL player waits for the next group');
});

test('a lone player gets a room of its own after the timeout', () => {
  const c = clock();
  const q = new MatchQueue({ now: c.now });
  q.join('a', 'FUNNY');
  // the page polls every 1.5 s (a page that stops polling is dropped: below)
  for (let waited = 1000; waited < QUEUE.timeoutMs; waited += 1000) {
    c.t += 1000;
    assert.equal(q.join('a', 'FUNNY').waiting, true, `still waiting after ${waited} ms`);
  }
  c.t += 1000;
  assert.deepEqual(q.join('a', 'FUNNY').matched, { role: 'host', difficulty: 'FUNNY', code: null, expect: 1, members: [] });
});

test('the host reports its room; the members get the code; nobody else can report it', () => {
  const c = clock();
  const q = new MatchQueue({ now: c.now });
  q.join('a', 'NORMAL');
  q.join('b', 'NORMAL');
  c.t += QUEUE.graceMs;
  q.tick();
  assert.deepEqual(q.hosted('b', 'ABCD'), { error: 'BAD_TARGET' }, 'a member is not the host');
  assert.deepEqual(q.hosted('a', 'abc'), { error: 'BAD_TARGET' }, 'not a room code');
  assert.equal(q.hosted('a', 'ABCD').matched.code, 'ABCD');
  assert.deepEqual(q.hosted('a', 'WXYZ'), { error: 'BAD_TARGET' }, 'one room per group');
  assert.deepEqual(q.join('b', 'NORMAL'), { waiting: false, matched: { role: 'member', difficulty: 'NORMAL', code: 'ABCD' } });
  c.t += QUEUE.groupMs;
  assert.deepEqual(q.join('b', 'NORMAL').waiting, true, 'an expired group is gone: polling again queues anew');
});

test('a host that never opens its room is dropped; its members go back to the front, keeping their wait', () => {
  const c = clock();
  const q = new MatchQueue({ now: c.now });
  q.join('a', 'NORMAL');
  c.t += 100;
  q.join('b', 'NORMAL');
  c.t += QUEUE.graceMs;
  assert.equal(q.join('a', 'NORMAL').matched.role, 'host', 'the host is told, then goes quiet opening its room');
  // b and a later arrival keep polling while the host does not report
  for (let waited = 0; waited < QUEUE.hostMs; waited += 1000) {
    c.t += 1000;
    q.join('b', 'NORMAL');
    q.join('z', 'NORMAL');
    if (q.groupOf.get('b') !== q.groupOf.get('a')) break;
  }
  assert.equal(q.status('a').waiting, false, 'the silent host is not put back');
  assert.notEqual(q.groupOf.get('b'), q.groupOf.get('a'));
  const b = q.status('b');
  if (b.matched) assert.equal(b.matched.role, 'host', 'b, first in line again, hosts the next group (with z)');
  else assert.ok(b.waitedMs >= QUEUE.hostMs, 'b keeps its waiting time');
});

test('a page that went away is not waited for: a silent member leaves its group, a silent untold host ends it', () => {
  const c = clock();
  const q = new MatchQueue({ now: c.now });
  for (const id of ['a', 'b', 'c']) q.join(id, 'NORMAL');
  c.t += QUEUE.graceMs;
  assert.deepEqual(q.join('a', 'NORMAL').matched.members, ['b', 'c']);
  // b keeps polling, c's tab was closed
  for (let t = 0; t < QUEUE.silentMs; t += 1000) { c.t += 1000; q.join('b', 'NORMAL'); }
  assert.equal(q.hosted('a', 'ABCD').matched.expect, 2, 'only the live member is expected');
  assert.deepEqual(q.status('a').matched.members, ['b']);
  assert.deepEqual(q.status('c'), { waiting: false });

  const r = new MatchQueue({ now: c.now });
  r.join('x', 'HARD');
  r.join('y', 'HARD');
  // x's page went away before any answer told it to host
  for (let t = 0; t < QUEUE.silentMs; t += 1000) { c.t += 1000; r.join('y', 'HARD'); }
  assert.deepEqual(r.status('x'), { waiting: false });
  assert.equal(r.groupOf.size, 0, 'y waits for another player, not for x');
  assert.equal(r.status('y').waiting, true);
});

test('匹配 again starts over: an old group is left, a poll that crossed a leave does not queue again', () => {
  const c = clock();
  const q = new MatchQueue({ now: c.now });
  q.join('a', 'NORMAL');
  q.join('b', 'NORMAL');
  c.t += QUEUE.graceMs;
  q.tick();
  q.hosted('a', 'ABCD');
  assert.equal(q.join('b', 'NORMAL').matched.code, 'ABCD');
  // the room did not work out: b clicks 匹配 again, at another difficulty
  const again = q.join('b', 'HARD', { fresh: true });
  assert.deepEqual([again.waiting, again.difficulty, again.matched], [true, 'HARD', undefined]);
  assert.equal(q.join('a', 'NORMAL', { fresh: true }).waiting, true, 'the host too');
  assert.equal(q.groups.size, 0);

  q.leave('b');
  assert.deepEqual(q.join('b', 'HARD'), { waiting: false }, 'a poll sent before the leave');
  c.t += QUEUE.leftMs;
  assert.equal(q.join('b', 'HARD').waiting, true, 'later, a poll re-enters a place an evicted instance lost');
  q.leave('b');
  assert.equal(q.join('b', 'HARD', { fresh: true }).waiting, true, 'a click is never mistaken for a stale poll');
});

test('the grace runs per group: players of another difficulty never hold it back', () => {
  const c = clock();
  const q = new MatchQueue({ now: c.now });
  q.join('a', 'NORMAL');
  q.join('b', 'NORMAL');
  for (let t = 0; t < QUEUE.graceMs; t += 500) {
    c.t += 500;
    q.join('x', t % 1000 ? 'HARD' : 'FUNNY'); // somebody keeps arriving elsewhere
    q.join('a', 'NORMAL');
    q.join('b', 'NORMAL');
  }
  assert.equal(q.status('a').matched?.role, 'host');
});

test('leaving: from the queue, as a member, and as a host before its room exists', () => {
  const c = clock();
  const q = new MatchQueue({ now: c.now });
  q.join('a', 'NORMAL');
  assert.deepEqual(q.leave('a'), { waiting: false });
  assert.deepEqual(q.status('a'), { waiting: false });
  q.join('a', 'NORMAL', { fresh: true });
  q.join('b', 'NORMAL');
  q.join('c', 'NORMAL');
  c.t += QUEUE.graceMs;
  q.tick();
  q.leave('c');
  assert.equal(q.status('a').matched.expect, 2, 'a member who left is not expected');
  q.leave('a');
  assert.equal(q.status('b').waiting, true, 'the host left: b waits again');
  assert.equal(q.groups.size, 0);
});

test('a page that stops polling is dropped from the queue', () => {
  const c = clock();
  const q = new MatchQueue({ now: c.now });
  q.join('a', 'NORMAL');
  c.t += QUEUE.silentMs;
  q.join('b', 'NORMAL');
  assert.deepEqual(q.status('a'), { waiting: false });
  assert.equal(q.status('b').count, 1);
});

test('the Durable Object answers its route: the account header names the player; bad bodies are refused', async () => {
  const c = clock();
  const dobj = new Matchmaker(null, {}, { now: c.now });
  const call = (accountId, body) => dobj.fetch(new Request('https://queue.internal/_queue', {
    method: 'POST', headers: accountId ? { 'X-Account-ID': accountId } : {}, body: JSON.stringify(body) }));
  assert.equal((await call(null, { action: 'join', difficulty: 'NORMAL' })).status, 400);
  assert.equal((await call('a', { action: 'nope' })).status, 400);
  assert.equal((await call('a', { action: 'join', difficulty: 'IMPOSSIBLE' })).status, 400);
  const r = await call('a', { action: 'join', difficulty: 'NORMAL' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).waiting, true);
  assert.deepEqual(await (await call('a', { action: 'leave' })).json(), { waiting: false });
});

test('a host that leaves after reporting its room ends the group: members not yet handed the code wait again', () => {
  const c = clock();
  const q = new MatchQueue({ now: c.now });
  for (const id of ['a', 'b', 'c']) q.join(id, 'NORMAL');
  c.t += QUEUE.graceMs;
  q.tick();
  q.hosted('a', 'ABCD');
  assert.equal(q.join('b', 'NORMAL').matched.code, 'ABCD', 'b was handed the code (its page applies now)');
  q.leave('a'); // the host cancelled while reporting: its page leaves the room again
  assert.equal(q.join('c', 'NORMAL').waiting, true, 'c never got the code: back in the queue');
  assert.deepEqual(q.status('b'), { waiting: false }, 'b, already applying, is not queued again');
  assert.equal(q.groups.size, 0);
});
