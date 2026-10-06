// 匹配 (matchmaking queue) — a remake feature (DESIGN §28). Boots a real server in-process on a random port and drives
// several WebSocket clients through the queue: joining, the queue.status frames, the group being formed into a new 同盟
// room (queue.matched), the seats the group could not fill, the grace / timeout rules, leaving, disconnecting, the
// same-difficulty rule, and the healthz counter.
//
// The queue timings are overridden per server so a test never waits for the production constants.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { CODE_ALPHABET, LOBBY_DEFAULTS } from '../server/lobby.js';

const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{4}$`);

/**
 * Run `fn` against a FRESH server: the queue and the room registry are per server, so each test owns its state and one
 * test's rooms can never be picked up by the next test's group. The clients it opened are closed afterwards.
 */
async function withServer(over, fn) {
  const srv = await startServer({
    port: 0, host: '127.0.0.1', quiet: true,
    queueTickMs: 30, queueMinSeats: 2, queueGraceMs: 120, queueTimeoutMs: 900, queueSilentMs: 5000,
    ...over,
  });
  const ctx = { wsUrl: `ws://127.0.0.1:${srv.port}/ws`, httpUrl: `http://127.0.0.1:${srv.port}`, opened: [] };
  const player = async (name) => {
    const c = await TestClient.connect(ctx.wsUrl);
    const w = await c.hello(name);
    c.id = w.playerId;
    c.token = w.token;
    ctx.opened.push(c);
    return c;
  };
  try {
    return await fn(player, ctx);
  } finally {
    await Promise.all(ctx.opened.map((c) => c.terminate().catch(() => {})));
    await srv.close();
  }
}

describe('matchmaking queue (匹配)', () => {
  test('queue.join answers with queue.status; a lone player waits out the grace and is then matched alone', async () => {
    await withServer({}, async (player) => {
      const a = await player('MATCH-A');
      await a.request({ t: 'queue.join', difficulty: 'HARD' });
      const status = await a.waitFor('queue.status', (m) => m.waiting);
      assert.equal(status.difficulty, 'HARD');
      assert.equal(status.count, 1);
      assert.equal(status.seats, 4);
      assert.equal(status.minSeats, 2);
      assert.ok(status.waitedMs >= 0 && status.waitedMs < 5000);
      // Nobody else is waiting: no room before the grace, and the timeout then guarantees one (a lone player is never
      // stuck — the room is a normal 同盟 room they can fill with AI teammates).
      assert.equal(await a.expectNone('queue.matched', () => true, 60), undefined, 'not before the grace');
      const matched = await a.waitFor('queue.matched', () => true, 5000);
      assert.match(matched.code, CODE_RE);
      assert.equal(matched.difficulty, 'HARD');
      assert.equal(matched.seated, true, 'the creator is seated in the room it formed');
      const state = await a.waitFor('room.state', (s) => s.code === matched.code && s.seats.some((x) => x && x.playerId === a.id));
      assert.equal(state.mode, 'coop');
      assert.equal(state.difficulty, 'HARD');
      const seat = state.seats.find((s) => s && s.playerId === a.id);
      assert.ok(seat, 'the queued player holds a seat');
      // the ready flag arrives with the group's own broadcast (the room is created and seated first, then marked ready)
      const ready = await a.waitFor('room.state', (s) => s.code === matched.code && s.seats.some((x) => x && x.playerId === a.id && x.ready === true), 3000);
      assert.ok(ready, 'a matched player is ready');
      const out = await a.waitFor('queue.status', (m) => m.waiting === false, 3000);
      assert.equal(out.count, 0, 'and it is out of the queue');
    });
  });

  test('two players of one difficulty are grouped after the grace; both land in the same room, ready', async () => {
    await withServer({}, async (player) => {
      const a = await player('MATCH-B1');
      const b = await player('MATCH-B2');
      await a.request({ t: 'queue.join', difficulty: 'NORMAL' });
      await b.request({ t: 'queue.join', difficulty: 'NORMAL' });
      const [ma, mb] = await Promise.all([
        a.waitFor('queue.matched', () => true, 5000),
        b.waitFor('queue.matched', () => true, 5000),
      ]);
      assert.equal(ma.code, mb.code, 'one room for both');
      assert.equal(ma.difficulty, 'NORMAL');
      const sa = await a.waitFor('room.state', (s) => s.code === ma.code && s.seats.filter(Boolean).length === 2);
      const sb = await b.waitFor('room.state', (s) => s.code === ma.code && s.seats.filter(Boolean).length === 2);
      assert.deepEqual(sa.seats.filter(Boolean).map((s) => s.playerId).sort(), [a.id, b.id].sort(), 'both share the room');
      assert.equal(sa.hostId, a.id, 'the first queued player hosts');
      // every human of a matched room ends up ready (the group's own broadcast sets it)
      const ready = await b.waitFor('room.state', (s) => s.code === ma.code && s.seats.filter((x) => x && !x.isBot).every((x) => x.ready === true), 3000);
      assert.equal(ready.seats.filter((x) => x && !x.isBot).length, 2, 'both humans are ready');
      assert.equal(sa.inMatch, false, 'the queue does not start the match itself');
    });
  });

  test('the group is capped at 4 seats; the extra player keeps waiting (never silently dropped)', async () => {
    await withServer({}, async (player) => {
      const cs = [];
      for (let i = 0; i < 5; i++) cs.push(await player(`MATCH-C${i + 1}`));
      // join in order so the first four are certainly the oldest entries
      for (const c of cs) {
        await c.request({ t: 'queue.join', difficulty: 'ABYSS' });
        await delay(40);
      }
      const matched = await Promise.all(cs.slice(0, 4).map((c) => c.waitFor('queue.matched', () => true, 8000)));
      const codes = new Set(matched.map((m) => m.code));
      assert.equal(codes.size, 1, 'the first four form one room');
      assert.equal(matched.filter((m) => m.seated).length, 4, 'four players are seated');
      const fifth = cs[4];
      const st = await fifth.waitFor('queue.status', (m) => m.waiting, 3000);
      assert.ok(st.count >= 1, 'the fifth player is still in the queue (or waiting for the next group)');
    });
  });

  test('different difficulties are never mixed, and queue.leave stops the wait', async () => {
    // The grace / timeout of this suite are short (120 / 900 ms), so this test records what the two waiting sessions
    // actually saw instead of betting on one intermediate frame: the point is that HARD and FUNNY never share a group.
    await withServer({ queueTimeoutMs: 1200, queueGraceMs: 300, queueTickMs: 25 }, async (player) => {
      const a = await player('MATCH-D1');
      const b = await player('MATCH-D2');
      await a.request({ t: 'queue.join', difficulty: 'HARD' });
      await b.request({ t: 'queue.join', difficulty: 'FUNNY' });
      await delay(200); // both entries are certainly in by now
      const aFrames = a.inbox.filter((m) => m.t === 'queue.status' && m.waiting);
      const bFrames = b.inbox.filter((m) => m.t === 'queue.status' && m.waiting);
      assert.ok(aFrames.length && bFrames.length, 'both sessions are told they are waiting');
      for (const f of aFrames) assert.equal(f.difficulty, 'HARD', 'a only ever sees its own difficulty');
      for (const f of bFrames) assert.equal(f.difficulty, 'FUNNY');
      // at least one broadcast must have seen BOTH of them (the queue is shared), yet `count` stays per difficulty
      assert.ok(aFrames.some((f) => f.total === 2) || bFrames.some((f) => f.total === 2), `the queue reported both entries (${JSON.stringify(aFrames.at(-1))} / ${JSON.stringify(bFrames.at(-1))})`);
      assert.ok(aFrames.every((f) => f.count === 1), `only the same difficulty counts towards the group ${JSON.stringify(aFrames.at(-1))}`);
      // b leaves: it is answered at once, and a sees the queue shrink
      await b.request({ t: 'queue.leave' });
      const gone = await b.waitFor('queue.status', (m) => m.waiting === false, 3000);
      assert.equal(gone.count, 0);
      const shrunk = await a.waitFor('queue.status', (m) => m.waiting && m.total === 1, 3000);
      assert.equal(shrunk.count, 1);
      await a.request({ t: 'queue.leave' });
      const out = await a.waitFor('queue.status', (m) => m.waiting === false, 3000);
      assert.equal(out.count, 0);
    });
  });

  test('a waiting player that disconnects is dropped; the queue never seats an unreachable player', async () => {
    await withServer({}, async (player, ctx) => {
      const a = await player('MATCH-E1');
      const b = await player('MATCH-E2');
      await a.request({ t: 'queue.join', difficulty: 'NORMAL' });
      await b.request({ t: 'queue.join', difficulty: 'NORMAL' });
      await a.terminate();
      const status = await b.waitFor('queue.status', (m) => m.waiting && m.total === 1, 3000);
      assert.equal(status.count, 1, 'the dropped player is gone from the queue');
      const matched = await b.waitFor('queue.matched', () => true, 5000);
      assert.match(matched.code, CODE_RE);
      const state = await b.waitFor('room.state', (s) => s.code === matched.code);
      assert.deepEqual(state.seats.filter(Boolean).map((s) => s.playerId), [b.id], 'only the reachable player is seated');
      assert.equal(ctx.opened.length, 2);
    });
  });

  test('queue.join twice keeps one entry; creating a room by hand takes the session out of the queue', async () => {
    await withServer({}, async (player) => {
      const a = await player('MATCH-F');
      await a.request({ t: 'queue.join', difficulty: 'FUNNY' });
      await a.request({ t: 'queue.join', difficulty: 'FUNNY' });
      const status = await a.waitFor('queue.status', (m) => m.waiting);
      assert.equal(status.count, 1, 'no duplicate entry');
      await a.request({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY' });
      const gone = await a.waitFor('queue.status', (m) => m.waiting === false, 3000);
      assert.equal(gone.count, 0);
      await a.request({ t: 'room.leave' });
    });
  });

  test('healthz reports how many players are waiting', async () => {
    await withServer({}, async (player, ctx) => {
      const a = await player('MATCH-G');
      await a.request({ t: 'queue.join', difficulty: 'NORMAL' });
      await a.waitFor('queue.status', (m) => m.waiting);
      const body = await (await fetch(`${ctx.httpUrl}/healthz`)).json();
      assert.ok(Number.isInteger(body.queued) && body.queued >= 1, `healthz.queued ${JSON.stringify(body.queued)}`);
      await a.request({ t: 'queue.leave' });
      await delay(80);
      const after = await (await fetch(`${ctx.httpUrl}/healthz`)).json();
      assert.equal(after.queued, 0);
    });
  });

  test('queue.join is refused while a match runs (leave it first)', async () => {
    await withServer({}, async (player) => {
      const a = await player('MATCH-H');
      await a.request({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY' });
      await a.waitFor('room.state', (s) => s.hostId === a.id);
      await a.request({ t: 'room.start' });
      await a.waitFor('m.public', () => true, 5000);
      const r = await a.request({ t: 'queue.join', difficulty: 'FUNNY' });
      assert.equal(r.t, 'error', JSON.stringify(r));
      assert.equal(r.code, 'ROOM_STARTED');
    });
  });

  test('the queue timings default to the documented values', () => {
    assert.equal(LOBBY_DEFAULTS.queueMinSeats, 2);
    assert.equal(LOBBY_DEFAULTS.queueGraceMs, 3000);
    assert.equal(LOBBY_DEFAULTS.queueTimeoutMs, 20_000);
    assert.ok(LOBBY_DEFAULTS.queueSilentMs > LOBBY_DEFAULTS.queueTimeoutMs, 'a silent session outlives its own timeout');
  });
});
