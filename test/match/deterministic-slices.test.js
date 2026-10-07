import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { TICK } from '../../server/sim/constants.js';
import { HeadlessJob, runHeadless } from '../../server/match/fields.js';
import { createBattleFromSpec, resultDigest } from '../../server/sim/spec.js';
import { createRehearsal, planLayout, REHEARSAL_VARIANTS, LAYOUT_PARAMS } from '../../server/match/bot.js';
import { FakeBattle } from './fakeBattle.js';
import { makeMatch, checkInvariants } from './harness.js';

test('work admission defers a callback without hiding ordinary timers, and cancellation reaches it in the work queue', () => {
  let available = false;
  const h = makeMatch({ workSlice: { prepSteps: 4, simulationTicks: 512 }, deferWork: () => available ? 0 : 10 });
  try {
    const calls = [];
    assert.equal(typeof h.m.laterWork, 'function');
    const work = h.m.laterWork(0, () => calls.push('work'));
    h.m.later(5, () => calls.push('deadline'));
    h.sched.advance(5);
    assert.deepEqual(calls, ['deadline'], 'ordinary timers pass a deferred work callback');
    h.m.cancel(work);
    available = true;
    h.sched.advance(10);
    assert.deepEqual(calls, ['deadline'], 'cancel reaches the postponed work');
    h.m.laterWork(0, () => calls.push('next'));
    h.sched.advance(0);
    assert.deepEqual(calls, ['deadline', 'next']);
  } finally { h.m.dispose(); }
});

test('prep admission can hold AI decisions without holding simulation work and receives the phase deadline', () => {
  let allowPrep = false;
  const deadlines = [];
  const h = makeMatch({ humans: 2, bots: 1, fake: true,
    workSlice: { prepSteps: 1, simulationTicks: 512 },
    deferWork: (kind, deadline) => {
      if (!kind.startsWith('prep')) return 0; // 'prep' and an arrangement's 'prepArrange'
      deadlines.push(deadline);
      return allowPrep ? 0 : 25;
    },
  }).start();
  try {
    h.toPrep();
    const bot = h.ps('ai_0');
    const before = bot.privateView();
    let simulated = false;
    h.m.laterWork(0, () => { simulated = true; });
    h.sched.advance(1000);
    assert.equal(simulated, true, 'simulation work is admitted while preparation is held');
    assert.equal(bot.ready, false, 'the host can postpone the initial preparation and its decisions');
    assert.deepEqual(bot.privateView(), before);
    assert.ok(deadlines.length > 0 && deadlines.every((deadline) => deadline === h.m.deadline && deadline > h.sched.now()));
    allowPrep = true;
    assert.ok(h.run(() => bot.ready), 'the same preparation completes when admitted');
    checkInvariants(h.m);
  } finally { h.m.dispose(); }
});

test('matches without fixed budgets do not consult recorded-host work admission', () => {
  const h = makeMatch({ deferWork: () => { throw new Error('unexpected work admission'); } });
  try {
    const calls = [];
    h.m.laterWork(0, () => calls.push('prep'), 'prep');
    h.m.laterWork(0, () => calls.push('simulation'));
    h.sched.advance(0);
    assert.deepEqual(calls, ['prep', 'simulation']);
    assert.equal(h.m.errorCount, 0);
  } finally { h.m.dispose(); }
});

test('fixed headless ticks stop exactly at the budget and finish on the last tick', () => {
  FakeBattle.reset();
  FakeBattle.script = () => ({ duration: 7 * TICK });
  const battle = () => new FakeBattle({ kind: 'normal', fieldId: 'fixed', players: [{ playerId: 'p' }] });
  const whole = runHeadless(battle(), { players: ['p'] });
  const job = new HeadlessJob(battle(), { players: ['p'] });
  assert.equal(typeof job.runTicks, 'function', 'deterministic jobs expose a tick budget');
  assert.equal(job.runTicks(3), false);
  assert.equal(job.battle.tickCount, 3);
  assert.equal(job.output(), null, 'partial computation is not a completed result');
  assert.equal(job.runTicks(3), false);
  assert.equal(job.battle.tickCount, 6);
  assert.equal(job.runTicks(1), true, 'no extra callback is needed to finalize a finished tick');
  assert.equal(job.battle.tickCount, 7);
  assert.deepEqual(job.output().result, whole.result);
  assert.deepEqual(job.output().timeline, whole.timeline);
  assert.equal(job.runTicks(3), true);
  assert.equal(job.battle.tickCount, 7, 'completed jobs do not step again');
});

test('fixed headless slices preserve real battle results and timeline samples', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 1, bots: 1, seed: 9322, captureFrames: false, clientCombat: true });
  try {
    h.autoHumans();
    let spec = null;
    h.onSend.push((pid, msg) => { if (!spec && msg.t === 'b.start' && msg.authoritative) spec = msg.spec; });
    h.m.start();
    h.run(() => spec != null);
    const battle = () => createBattleFromSpec(spec, h.m.ds, { recordEvents: false, quiet: true });
    const whole = runHeadless(battle(), { players: ['p_0'] });
    for (const budget of [127, 512]) {
      const job = new HeadlessJob(battle(), { players: ['p_0'] });
      assert.equal(typeof job.runTicks, 'function');
      let slices = 0;
      while (!job.done && slices < 10000) {
        const before = job.battle.tickCount;
        job.runTicks(budget);
        assert.ok(job.battle.tickCount - before <= budget, `at most ${budget} ticks per call`);
        slices++;
      }
      assert.ok(job.done && slices > 1);
      assert.equal(resultDigest(job.output().result).hash, resultDigest(whole.result).hash);
      assert.deepEqual(job.output().timeline, whole.timeline);
    }
  } finally { h.m.dispose(); }
});

test('fixed rehearsal ticks span candidates without changing the winning layout or the live board', () => {
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seed: 4, botRehearsal: 3,
    seats: [{ seat: 0, playerId: 'ai_0', name: 'AI', isBot: true, connected: true }] }).start();
  const m = h.m;
  try {
    h.run(() => m.phase === PHASE.PREP && m.round === 3);
    const ps = m.order[0];
    const chosen = ps.allChess().slice(0, ps.deployCap);
    const plans = REHEARSAL_VARIANTS.map((v) => planLayout(m, ps, chosen, { ...LAYOUT_PARAMS, ...v }));
    const board = () => JSON.stringify([...ps.board].map(([tile, p]) => [tile, p.uid, p.dir]));
    const beforeBoard = board();
    const whole = createRehearsal(m, ps, chosen, plans);
    assert.ok(whole, 'the fixture contains distinct candidate layouts');
    whole.run();
    let ticks = 0;
    const newBattle = m.newBattle.bind(m);
    m.newBattle = (opts) => {
      const b = newBattle(opts);
      const step = b.step.bind(b);
      b.step = () => { ticks++; return step(); };
      return b;
    };
    for (const budget of [127, 512]) {
      const job = createRehearsal(m, ps, chosen, plans);
      assert.equal(typeof job.runTicks, 'function');
      let slices = 0;
      while (!job.done && slices < 10000) {
        const before = ticks;
        job.runTicks(budget);
        assert.ok(ticks - before <= budget, 'the budget is shared across candidate boundaries');
        assert.equal(board(), beforeBoard, 'a suspended rehearsal never exposes its candidate board');
        slices++;
      }
      assert.ok(job.done && slices > 1);
      assert.equal(job.best, whole.best, 'identical winner, including the tie-break order');
    }
    checkInvariants(m);
  } finally { m.dispose(); }
});

// The rehearsal candidates of a prep differ (FakeBattle script): the first leaks 2, the second 1, the third none, so
// which plan wins depends on how many of them were rehearsed to the end.
const REHEARSAL_LEAKS = [2, 1, 0];
const rehearsalScript = () => {
  const seen = new Map();
  return (b) => {
    if (!String(b.fieldId).startsWith('r:')) return null;
    const key = `${b.fieldId}:${b.round}`;
    const i = seen.get(key) ?? 0;
    seen.set(key, i + 1);
    return { leaks: { [b.fieldId.slice(2)]: REHEARSAL_LEAKS[i % REHEARSAL_LEAKS.length] } };
  };
};
/** Ticks of one rehearsal candidate: FakeBattle's default 8 s. */
const CANDIDATE_TICKS = Math.round(8 / TICK);

test('Match dedicated prep ticks preserve decisions and cancel safely when the phase ends', () => {
  const run = (workSlice) => {
    const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 12, fake: true, botRehearsal: 3, script: rehearsalScript(), workSlice }).start();
    const m = h.m;
    try {
      h.toPrep(3);
      const bot = h.ps('ai_0');
      const ticks = new Map();
      const newBattle = m.newBattle.bind(m);
      m.newBattle = (opts) => {
        const b = newBattle(opts);
        if (String(opts.fieldId).startsWith('r:')) {
          const step = b.step.bind(b);
          b.step = () => { ticks.set(h.sched.executed, (ticks.get(h.sched.executed) || 0) + 1); return step(); };
        }
        return b;
      };
      h.run(() => bot.ready);
      assert.ok(ticks.size > 0);
      if (workSlice) {
        const limit = Number.isInteger(workSlice.prepSimulationTicks) && workSlice.prepSimulationTicks > 0
          ? workSlice.prepSimulationTicks : workSlice.simulationTicks;
        assert.ok(Math.max(...ticks.values()) <= limit, 'rehearsal uses its own budget when supplied');
      }
      const state = { board: [...bot.board].map(([k, p]) => [k, p.id, p.dir]), hand: bot.hand.map((p) => p?.id ?? null),
        funds: bot.funds, rng: m.rngBots.state() };
      assert.equal(m.errorCount, 0);
      checkInvariants(m);
      return state;
    } finally { m.dispose(); }
  };
  const original = run(undefined);
  assert.deepEqual(run({ prepSteps: 4, simulationTicks: 64 }), original);
  assert.deepEqual(run({ prepSteps: 4, simulationTicks: 512, prepSimulationTicks: 128 }), original);
  assert.deepEqual(run({ prepSteps: 4, simulationTicks: 64, prepSimulationTicks: 0 }), original);
  const tiny = { prepSteps: 1, simulationTicks: 512, prepSimulationTicks: 4 };
  const { rng: _rng, ...uncut } = run(tiny);

  // The deadline finds the prep mid-rehearsal (after its first 4-tick slice): it finishes the started job — the
  // rehearsal only within workSlice.deadlineRehearsalTicks — and nothing of it runs after PREP.
  const cutAt = (deadlineRehearsalTicks) => {
    const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 12, fake: true, botRehearsal: 3, script: rehearsalScript(),
      workSlice: deadlineRehearsalTicks == null ? tiny : { ...tiny, deadlineRehearsalTicks } }).start();
    try {
      h.toPrep(3);
      const bot = h.ps('ai_0');
      let ticks = 0;
      const newBattle = h.m.newBattle.bind(h.m);
      h.m.newBattle = (opts) => {
        const b = newBattle(opts);
        if (String(opts.fieldId).startsWith('r:')) { const step = b.step.bind(b); b.step = () => { ticks++; return step(); }; }
        return b;
      };
      h.run(() => ticks > 0);
      assert.equal(bot.ready, false);
      const job = bot._botPrep.job;
      assert.ok(job && !job.done && job.ticks === ticks, 'the deadline comes mid-rehearsal');
      const before = ticks;
      let atDeadline = null;
      const endPrep = h.m.endPrep.bind(h.m);
      h.m.endPrep = () => {
        atDeadline = { board: [...bot.board].map(([k, p]) => [k, p.id, p.dir]), hand: bot.hand.map((p) => p?.id ?? null), funds: bot.funds };
        return endPrep();
      };
      h.m.prepDeadline();
      const budget = h.m.workSlice.deadlineRehearsalTicks;
      assert.ok(ticks - before <= budget, `the deadline ran ${ticks - before} rehearsal ticks (budget ${budget})`);
      assert.equal(job.done || job.cut, true, 'the rehearsal is finished or cut');
      if (job.cut) assert.equal(ticks - before, budget, 'the rehearsal is cut only when the budget runs out');
      // the seat fights on the plan it chose: every operator of it on its tile
      assert.ok([...job.best].every(([uid, k]) => bot.board.get(k)?.uid === uid), 'the board is the chosen plan');
      const after = ticks;
      h.run(() => h.m.phase === PHASE.SETTLE);
      assert.equal(ticks, after, 'no rehearsal slice runs after PREP');
      assert.equal(h.m.errorCount, 0);
      checkInvariants(h.m);
      return { atDeadline, ran: ticks - before, before, done: job.done, cut: job.cut, best: job.plans.indexOf(job.best), candidates: job.plans.length };
    } finally { h.m.dispose(); }
  };
  // the default budget covers this rehearsal: the fight gets the board of the uncut prep, the last candidate's plan
  const whole = cutAt(null);
  assert.ok(whole.done && whole.ran > 0, 'the deadline ran the rest of the rehearsal');
  assert.equal(whole.candidates, 3);
  assert.equal(whole.best, 2, 'the uncut rehearsal picks the candidate without leaks');
  assert.deepEqual(whole.atDeadline, uncut, 'the fight gets the board of the uncut prep');
  // none: no candidate finished — the default plan (the board the economy left)
  const none = cutAt(0);
  assert.ok(none.cut && none.ran === 0 && none.best === 0);
  assert.notDeepEqual(none.atDeadline.board, uncut.board, 'the cut prep fights another plan');
  // the budget runs out in the last candidate: the better of the two finished ones
  const two = cutAt(2 * CANDIDATE_TICKS + CANDIDATE_TICKS / 2 - whole.before);
  assert.ok(two.cut && two.ran === 2 * CANDIDATE_TICKS + CANDIDATE_TICKS / 2 - whole.before);
  assert.equal(two.best, 1, 'the best candidate rehearsed to the end');
  assert.notDeepEqual(two.atDeadline.board, none.atDeadline.board);
  assert.notDeepEqual(two.atDeadline.board, uncut.board);
  // the budget ends exactly with the second candidate: it counts as rehearsed
  const exact = cutAt(2 * CANDIDATE_TICKS - whole.before);
  assert.ok(exact.cut && exact.best === 1);
  assert.deepEqual(exact.atDeadline, two.atDeadline);
});

test('Match fixed headless slices cover normal and unite fields, leaving no simulation inside combat launch', () => {
  const seats = [0, 1].map((i) => ({ seat: i, playerId: `ai_${i}`, name: `AI${i}`, isBot: true, connected: true }));
  const h = makeMatch({ mode: 'coop', seats, seed: 30, fake: true, clientCombat: true,
    workSlice: { prepSteps: 4, simulationTicks: 512, prepSimulationTicks: 128 },
    script: (b) => ({ duration: 20, leaks: b.kind === 'normal' ? { ai_0: 1 } : {} }) });
  const m = h.m;
  try {
    const ticks = new Map();
    const kinds = new Set();
    const specBattle = m._specBattle.bind(m);
    m._specBattle = (spec, opts) => {
      const b = specBattle(spec, opts);
      kinds.add(b.kind);
      const step = b.step.bind(b);
      b.step = () => { ticks.set(h.sched.executed, (ticks.get(h.sched.executed) || 0) + 1); return step(); };
      return b;
    };
    m.start();
    h.run(() => m.phase === PHASE.COMBAT);
    assert.ok(m.fields.every((f) => f.mode === 'server' && f.job && !f.result));
    assert.equal(ticks.size, 0, 'launch only creates jobs');
    h.run(() => m.phase === PHASE.SETTLE);
    assert.deepEqual([...kinds].sort(), ['normal', 'unite']);
    assert.ok(ticks.size > 2);
    assert.equal(Math.max(...ticks.values()), 512, 'normal and unite simulations retain the larger combat budget');
    assert.equal(m.errorCount, 0);
    checkInvariants(m);
  } finally { m.dispose(); }
});
