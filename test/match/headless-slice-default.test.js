// A recorded match runs a server-side normal / 联防 battle (HeadlessJob) in 128-tick slices like the boss pacer's (review
// 2026-10-07 item 5: a 512-tick 联防 slice took up to ~97 ms late in an 8-bot match). The slice is a recorded option:
// a match that started with 512 keeps it through a restore.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordedMatch, exportMatch, restoreMatch } from '../../server/match/checkpoint.js';
import { DATA } from './harness.js';
import { resultDigest } from '../../server/sim/spec.js';
import { roomEvents } from './roomEvents.js';

function fixture(workSlice) {
  const clock = { now: 1000 };
  const options = {
    data: DATA, roomCode: 'TICKS', mode: 'coop', difficulty: 'NORMAL', seed: 23, matchNo: 1, clientCombat: true, verify: 'off',
    botRehearsal: 0, workSlice,
    seats: Array.from({ length: 4 }, (_, seat) => ({ seat, playerId: `a${seat}`, name: `A${seat}`, isBot: true, connected: true })),
    now: () => clock.now, send: () => true, broadcast() {}, onEnd() {},
  };
  const match = new RecordedMatch(options);
  // field ticks stepped per room event (rehearsals are off)
  const counter = { ticks: 0 };
  const specBattle = match._specBattle.bind(match);
  match._specBattle = (spec, opts) => {
    const battle = specBattle(spec, opts);
    const step = battle.step.bind(battle);
    battle.step = () => { counter.ticks++; return step(); };
    return battle;
  };
  match.start();
  return { match, clock, options, counter };
}

for (const [label, workSlice, ticks] of [['default', undefined, 128], ['recorded 512', { simulationTicks: 512 }, 512]]) {
  test(`headless battles step in ${ticks}-tick slices, one per room event (${label}), and a restore keeps the slice`, () => {
    const { match, clock, options, counter } = fixture(workSlice);
    let restored;
    try {
      assert.equal(match.workSlice.simulationTicks, ticks);
      assert.equal(match.recording.options.workSlice.simulationTicks, ticks);
      const perEvent = [];
      const room = roomEvents(match, clock, {
        humans: [],
        onEvent: () => { if (counter.ticks) perEvent.push(counter.ticks); counter.ticks = 0; },
      });
      assert.ok(room.runUntil(() => match.phase === 'COMBAT' && perEvent.length >= 3), 'the combat simulations run');
      assert.ok(perEvent.every((n) => n <= ticks), `≤ ${ticks} field ticks per event (max ${Math.max(...perEvent)})`);
      assert.equal(Math.max(...perEvent), ticks);
      restored = restoreMatch(exportMatch(match), options);
      assert.equal(restored.workSlice.simulationTicks, ticks, 'the recorded slice, not the current default');
      for (let n = 0; n < 50; n++) {
        clock.now = match.sched.nextAt() ?? clock.now;
        const live = { remaining: 1 }, again = { remaining: 1 };
        match.pump(clock.now, 100, live);
        restored.pump(clock.now, 100, again);
        assert.deepEqual(again, live);
      }
      assert.deepEqual(exportMatch(restored), exportMatch(match));
      assert.equal(match.errorCount, 0);
    } finally { match.dispose(); restored?.dispose(); }
  });
}

test('the slice length changes no battle result and no later decision', () => {
  const run = (workSlice) => {
    const { match, clock } = fixture(workSlice);
    try {
      const results = [];
      const fieldDone = match._fieldDone.bind(match);
      match._fieldDone = (field) => {
        if (!field.done && field.result) results.push(`${match.round}:${field.kind}:${resultDigest(field.result).hash}`);
        return fieldDone(field);
      };
      const room = roomEvents(match, clock, { humans: [] });
      assert.ok(room.runUntil(() => match.phase === 'PREP' && match.round === 4), 'three rounds of combat');
      assert.equal(match.errorCount, 0);
      return {
        results: results.sort(),
        rng: exportMatch(match).rng,
        players: match.order.map((p) => ({ lp: p.lp, funds: p.funds, board: [...p.board].map(([k, q]) => [k, q.id, q.dir ?? null]) })),
      };
    } finally { match.dispose(); }
  };
  const short = run(undefined);
  assert.ok(short.results.length >= 12, `${short.results.length} headless results`);
  assert.deepEqual(run({ simulationTicks: 512 }), short);
});
