// Denied work waits in the room's work queue behind one gate timer (review 2026-10-07 item 4): eight paced AI chains
// no longer re-arm eight timers — eight logged events — per admitted slice. The queue is replayed by a restore like
// any timer, and a paced prep entry never blocks the simulation work queued behind it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordedMatch, exportMatch, restoreMatch } from '../../server/match/checkpoint.js';
import { DATA, makeMatch } from './harness.js';
import { roomEvents } from './roomEvents.js';

/** 8 human seats on autoplay, all disconnected: eight AI prep chains, paced (nobody waits on them). */
function fixture() {
  const clock = { now: 1000 };
  const options = {
    data: DATA, roomCode: 'ROWS', mode: 'coop', difficulty: 'NORMAL', seed: 17, matchNo: 1, clientCombat: true, verify: 'off',
    seats: Array.from({ length: 8 }, (_, seat) => ({ seat, playerId: `p${seat}`, name: `P${seat}`, isBot: false, connected: true })),
    now: () => clock.now, send: () => true, broadcast() {}, onEnd() {},
  };
  const match = new RecordedMatch(options);
  match.start();
  for (const player of match.order) {
    match.handle(player.playerId, { t: 'g.autoplay', on: true });
    match.handle(player.playerId, { t: 'g.infoReady' });
    match.onDisconnect(player.playerId);
  }
  return { match, clock, options };
}

const queueState = (match) => (match._workQueue?.entries ?? []).map(({ at, kind }) => ({ at, kind }));
const timers = (match) => match.sched._q.filter((t) => !t.cancelled).map(({ id, at, seq }) => ({ id, at, seq }));

test('eight paced AI chains log about one event per admitted slice, not one per waiting chain', () => {
  const { match, clock } = fixture();
  try {
    const prep = [];
    let admitted = 0;
    const defer = match.deferWork;
    match.deferWork = (...args) => { const delay = defer(...args); if (delay === 0) admitted++; return delay; };
    const room = roomEvents(match, clock, {
      humans: [],
      onEvent: ({ rows, phase }) => { if (phase === 'PREP') prep.push({ rows, admitted }); admitted = 0; },
    });
    assert.ok(room.runUntil(() => room.rounds[1]?.prepEnd != null), 'round 1 prep is played');
    const busy = prep.filter((e) => e.admitted > 0);
    assert.ok(busy.length > 100, `the AI prep spans many events (${busy.length})`);
    const rows = prep.reduce((sum, e) => sum + e.rows, 0);
    const slices = prep.reduce((sum, e) => sum + e.admitted, 0);
    assert.ok(busy.every((e) => e.admitted === 1), 'nobody waits on the AI: still one slice per event');
    assert.ok(prep.every((e) => e.rows <= 2), `at most two logged events per room event (max ${Math.max(...prep.map((e) => e.rows))})`);
    assert.ok(rows <= slices * 1.2, `${rows} logged events for ${slices} admitted slices`);
    assert.equal(match.errorCount, 0);
  } finally { match.dispose(); }
});

test('the work queue and its gate survive a restore at any event of an AI prep', () => {
  const { match, clock, options } = fixture();
  const restores = [];
  let mostWaiting = 0;
  try {
    const room = roomEvents(match, clock, { humans: [] });
    assert.ok(room.runUntil(() => match.phase === 'PREP'));
    // room events (both pumps share the allowance); every restored copy follows the live room from its restore on
    for (let n = 0; n < 280; n++) {
      clock.now = Math.max(clock.now, match.sched.nextAt() ?? clock.now);
      const live = { remaining: 1 };
      match.pump(clock.now, 100, live);
      match.pump(clock.now, 100, live);
      for (const restored of restores) {
        const again = { remaining: 1 };
        restored.pump(clock.now, 100, again);
        restored.pump(clock.now, 100, again);
        assert.deepEqual(again, live, 'the same admissions from the same allowance');
        assert.deepEqual(queueState(restored), queueState(match));
      }
      if (match.phase !== 'PREP') continue;
      const waiting = queueState(match);
      mostWaiting = Math.max(mostWaiting, waiting.length);
      assert.ok(timers(match).length <= 3, 'one gate timer for all queued work (+ the prep deadline, the view throttle)');
      if (n % 40 !== 7) continue;
      const restored = restoreMatch(exportMatch(match), options);
      restores.push(restored);
      assert.deepEqual(queueState(restored), waiting);
      assert.deepEqual(timers(restored), timers(match));
    }
    assert.ok(restores.length >= 4, `${restores.length} restores mid-prep`);
    assert.equal(mostWaiting, 8, 'all eight chains waited at once');
    for (const restored of restores) assert.deepEqual(exportMatch(restored), exportMatch(match));
  } finally { match.dispose(); for (const r of restores) r.dispose(); }
});

test('a paced prep entry at the head of the work queue does not hold the simulation queued behind it', () => {
  let prepOpen = false;
  const h = makeMatch({ workSlice: { prepSteps: 1, simulationTicks: 128 },
    deferWork: (kind) => (kind === 'prep' && !prepOpen ? 25 : 0) });
  try {
    const calls = [];
    h.m.laterWork(0, () => calls.push('prep'), 'prep');
    h.m.laterWork(5, () => calls.push('simulation'));
    h.sched.advance(5);
    assert.deepEqual(calls, ['simulation'], 'the simulation slice runs while the prep entry waits for its gap');
    prepOpen = true;
    h.sched.advance(25);
    assert.deepEqual(calls, ['simulation', 'prep']);
    assert.equal(h.m.errorCount, 0);
  } finally { h.m.dispose(); }
});

test('cancelling queued work removes its gate; a stale entry is dropped without taking an admission', () => {
  let admissions = 0;
  const h = makeMatch({ workSlice: { prepSteps: 1, simulationTicks: 128 },
    deferWork: () => { admissions++; return 0; } });
  try {
    const before = h.sched.pending();
    const token = h.m.laterWork(50, () => assert.fail('cancelled work ran'));
    assert.equal(h.sched.pending(), before + 1, 'one gate');
    h.m.cancel(token);
    assert.equal(h.sched.pending(), before, 'no gate left for cancelled work');
    let alive = true;
    const calls = [];
    h.m.laterWork(10, () => calls.push('stale'), 'prep', () => alive);
    h.m.laterWork(10, () => calls.push('live'), 'prep');
    alive = false;
    h.sched.advance(10);
    assert.deepEqual(calls, ['live']);
    assert.equal(admissions, 1, 'the stale entry took no admission');
  } finally { h.m.dispose(); }
});
