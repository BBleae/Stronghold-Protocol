import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordedMatch, exportMatch, restoreMatch } from '../../server/match/checkpoint.js';
import { DATA } from './harness.js';

function fixture({ timerScale = 1, humans = 4 } = {}) {
  const clock = { now: 1000 };
  const options = {
    data: DATA, roomCode: 'SLICE', mode: 'coop', difficulty: 'NORMAL', seed: 17, matchNo: 1,
    clientCombat: true, botRehearsal: 3, timerScale, workSlice: { prepSteps: 1, simulationTicks: 32 },
    seats: Array.from({ length: humans }, (_, seat) => ({ seat, playerId: `p${seat}`, name: `Player ${seat}`, isBot: false, connected: true })),
    now: () => clock.now, send: () => true, broadcast() {}, onEnd() {},
  };
  const match = new RecordedMatch(options);
  match.start();
  for (const player of match.order) {
    match.handle(player.playerId, { t: 'g.autoplay', on: true });
    match.handle(player.playerId, { t: 'g.infoReady' });
    match.onDisconnect(player.playerId);
  }
  for (let n = 0; n < 1000 && match.phase !== 'PREP'; n++) {
    clock.now = match.sched.nextAt();
    assert.notEqual(clock.now, null);
    match.pump(clock.now, 1);
  }
  assert.equal(match.phase, 'PREP');
  if (humans > 1) assert.ok(match.deadline > clock.now, 'multiple human seats retain a timed prep even while autoplaying');
  else assert.equal(match.deadline, 0, 'single human prep remains untimed');
  return { match, clock, options };
}

function state(match) {
  return {
    checkpoint: exportMatch(match),
    private: match.order.map((p) => p.privateView()),
    timers: match.sched._q.filter((t) => !t.cancelled).map(({ id, at, seq, every }) => ({ id, at, seq, every })),
  };
}

test('one event shares its work allowance across both pumps while AI prep remains resumable', () => {
  const { match, clock, options } = fixture();
  let restored;
  try {
    clock.now = match.sched.now() + 10000;
    const budget = { remaining: 1 };
    match.pump(clock.now, 100, budget);
    assert.ok(match.order.some((p) => !p.ready), 'prep must yield before the bots finish their turn');
    assert.equal(budget.remaining, 0, 'the first pump consumes the shared work allowance');
    const before = match.order.map((p) => p.privateView());
    match.pump(clock.now + 1, 100, budget);
    assert.deepEqual(match.order.map((p) => p.privateView()), before, 'the second pump must not run another prep slice');
    restored = restoreMatch(exportMatch(match), options);
    assert.deepEqual(state(restored), state(match), 'deferred timers and partial generators survive recovery');
  } finally { match.dispose(); restored?.dispose(); }
});

test('exhausted work does not hide the prep deadline or allow an expired purchase', () => {
  const { match, clock, options } = fixture();
  let restored;
  try {
    clock.now = match.deadline + 1;
    match.pump(clock.now, 100, { remaining: 0 });
    assert.equal(match.phase, 'COMBAT', 'phase timers still run with no simulation allowance');
    assert.equal(match.handle('p0', { t: 'g.refresh' }).error, 'WRONG_PHASE');
    assert.ok(match.fields.some((f) => f.job && !f.job.done), 'headless battles must wait for a later event');
    restored = restoreMatch(exportMatch(match), options);
    assert.deepEqual(state(restored), state(match));
  } finally { match.dispose(); restored?.dispose(); }
});

for (const [label, opts, gap] of [['timed', {}, 25], ['scaled', { timerScale: 0.5 }, 13], ['untimed', { humans: 1 }, 25]]) {
test(`AI work leaves a room-wide gap from the ${label} event horizon and replays that gap`, () => {
  const { match, clock, options } = fixture(opts);
  let restored;
  try {
    // The scheduled timer is old: pacing from its original timestamp would collapse the rest to 1ms.
    clock.now = match.sched.now() + 10000;
    const first = { remaining: 1 };
    match.pump(clock.now, 100, first);
    assert.equal(first.remaining, 0);
    const before = state(match);
    const second = { remaining: 1 };
    match.pump(clock.now + gap - 1, 100, second);
    assert.equal(second.remaining, 1, 'another player event must not admit AI work inside the scaled gap');
    assert.deepEqual(state(match), before);
    restored = restoreMatch(exportMatch(match), options);
    clock.now += gap;
    const liveBudget = { remaining: 1 }, restoredBudget = { remaining: 1 };
    match.pump(clock.now, 100, liveBudget);
    restored.pump(clock.now, 100, restoredBudget);
    assert.equal(liveBudget.remaining, 0, 'the next AI slice becomes eligible after the gap');
    assert.deepEqual(restoredBudget, liveBudget);
    assert.deepEqual(state(restored), state(match));
  } finally { match.dispose(); restored?.dispose(); }
});
}

for (const timerScale of [1, 0.5]) {
test(`the final five scaled prep seconds remove voluntary gaps but retain the event cap (${timerScale})`, () => {
  const { match, clock, options } = fixture({ timerScale });
  let restored;
  try {
    clock.now = match.deadline - Math.round(5000 * timerScale) + 1;
    const first = { remaining: 1 };
    match.pump(clock.now, 100, first);
    assert.equal(first.remaining, 0);
    match.pump(++clock.now, 100, first);
    assert.equal(first.remaining, 0, 'one event still shares one allowance');
    restored = restoreMatch(exportMatch(match), options);
    const nextEvent = { remaining: 1 };
    match.pump(++clock.now, 100, nextEvent);
    assert.equal(nextEvent.remaining, 0, 'the next event can resume AI work before 25ms');
    restored.pump(clock.now, 100, { remaining: 1 });
    assert.deepEqual(state(restored), state(match));
  } finally { match.dispose(); restored?.dispose(); }
});
}

test('a checkpoint in a headless slice continues to the same battle result, timeline and RNG', () => {
  const { match, clock, options } = fixture();
  let restored;
  try {
    clock.now = match.deadline + 1;
    match.pump(clock.now, 100, { remaining: 0 });
    // Prep steps dropped by the deadline leave the work queue without an admission; the field jobs start at once.
    for (let n = 0; n < 12 && !match.fields.some((f) => f.job && f.battle.tickCount > 0); n++) {
      clock.now++;
      match.pump(clock.now, 100, { remaining: 1 });
    }
    const field = match.fields.find((f) => f.job && !f.job.done && f.battle.tickCount > 0);
    assert.ok(field, 'checkpoint is taken after partial computation, before its result exists');
    restored = restoreMatch(exportMatch(match), options);
    assert.deepEqual(state(restored), state(match));
    for (let n = 0; n < 10000 && match.fields.some((f) => f.job); n++) {
      clock.now++;
      match.pump(clock.now, 100, { remaining: 1 });
      restored.pump(clock.now, 100, { remaining: 1 });
    }
    assert.ok(match.fields.every((f) => !f.job));
    assert.ok(match.fields.every((f) => f.result));
    assert.deepEqual(match.fields.map((f) => ({ result: f.result, timeline: f.timeline })),
      restored.fields.map((f) => ({ result: f.result, timeline: f.timeline })));
    assert.deepEqual(state(restored), state(match));
    assert.equal(match.errorCount, 0);
    assert.equal(restored.errorCount, 0);
  } finally { match.dispose(); restored?.dispose(); }
});
