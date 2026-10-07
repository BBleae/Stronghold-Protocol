import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattleRunner } from '../../public/js/battle/runner.js';
import { createStore, initialState } from '../../public/js/store.js';
import * as specMod from '../../server/sim/spec.js';
import { FakeBattle } from './fakeBattle.js';

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

// A step consumes measurable main-thread time, independently of game ticks. No real CPU load or timers.
function rig({ cost = 2, hidden = false, loading = false } = {}) {
  let time = 1000, seq = 0, release;
  const frames = new Map(), intervals = new Map(), battles = new Map(), sent = [];
  const doc = { hidden, addEventListener() {}, removeEventListener() {} };
  const gate = loading ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  const store = createStore({ ...initialState, match: { ...initialState.match, public: { phase: 'COMBAT' } } });
  const runner = createBattleRunner({
    store, doc, now: () => time,
    net: { on() {}, send(t, msg) { sent.push({ t, ...msg }); return true; },
      request(t, msg) { sent.push({ t, ...msg }); return Promise.resolve({ t: 'ok' }); } },
    raf(fn) { const id = ++seq; frames.set(id, fn); return id; }, caf: id => frames.delete(id),
    setInterval(fn) { const id = ++seq; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id),
    loadSim: async () => { await gate; return { ds: null, spec: { ...specMod,
      createBattleFromSpec(spec) {
        const b = new FakeBattle({ ...spec, timeLimit: 10000 });
        b.plan.duration = 10000;
        const step = b.step.bind(b);
        b.step = () => { time += cost; step(); };
        battles.set(spec.battleId, b);
        return b;
      },
    } }; },
  });
  return { runner, store, doc, frames, intervals, battles, sent,
    get time() { return time; }, release: () => release?.(),
    pause(paused) { store.patch('match', { public: { phase: 'COMBAT', paused } }); },
    start(id, extra = {}) {
      return runner.onStart({ battleId: id, fieldId: id, kind: 'normal', authoritative: true,
        watch: false, elapsed: 0, speed: 1,
        spec: { battleId: id, fieldId: id, kind: 'normal', players: [{ playerId: 'p1' }] }, ...extra });
    },
    async frame(ms = 0) {
      time += ms;
      const before = time, q = [...frames.values()]; frames.clear();
      for (const fn of q) fn(time);
      await settle();
      return time - before;
    },
    async pump(ms = 0) {
      time += ms;
      const before = time;
      for (const fn of [...intervals.values()]) fn();
      await settle();
      return time - before;
    },
  };
}

test('expensive preparation yields before catching up and its slices are measured', async () => {
  const r = rig();
  try {
    let done = false;
    const before = r.time;
    const pending = r.start('prep', { elapsed: 2 }).then(() => { done = true; });
    await settle();
    assert.ok(r.time - before <= 6, 'start must not synchronously consume a 600-tick catch-up');
    assert.equal(done, false);
    for (let i = 0; i < 100 && !done; i++) assert.ok(await r.frame() <= 6, 'one costly step may cross the soft deadline');
    assert.equal(done, true, 'yielded preparation eventually catches up');
    await pending;
    assert.ok(r.battles.get('prep').tickCount >= 52);
    const stats = r.runner.stats();
    assert.ok(stats.prepareMs > 0 && stats.maxPrepareMs > 0 && stats.maxFrameMs > 0);
  } finally { r.runner.dispose(); }
});

test('active authority, displayed replica and two preparations share one budget and all make progress', async () => {
  const r = rig({ cost: 6 }); // a single indivisible step is already over budget
  try {
    await r.start('authority');
    await r.start('replica', { authoritative: false, watch: true });
    let completed = 0;
    const first = r.start('prep1', { elapsed: 2 }).then(() => completed++);
    const second = r.start('prep2', { elapsed: 2 }).then(() => completed++);
    await settle();
    for (let i = 0; i < 12; i++) assert.ok(await r.frame(i === 0 ? 1000 : 0) <= 6, 'all tasks share the same batch deadline');
    for (const [id, b] of r.battles) assert.ok(b.tickCount > 0, `${id} is not starved by expensive siblings`);
    // Stop the older active clocks from growing the workload; pending work still has to converge.
    r.runner.onEnd({ battleId: 'authority', reason: 'forced' });
    r.runner.onEnd({ battleId: 'replica', reason: 'forced' });
    for (let i = 0; i < 500 && completed < 2; i++) assert.ok(await r.frame() <= 6);
    assert.equal(completed, 2, 'both preparations eventually commit');
    await Promise.all([first, second]);
  } finally { r.runner.dispose(); }
});

test('frozen cost clock still bounds the aggregate tick count of a batch', async () => {
  const r = rig({ cost: 0 });
  try {
    for (const id of ['a', 'b', 'c', 'd']) await r.start(id);
    await r.frame(100000);
    const total = [...r.battles.values()].reduce((n, b) => n + b.tickCount, 0);
    assert.ok(total > 0 && total <= 600, 'the batch has a finite tick ceiling even without elapsed wall time');
    await r.frame();
    for (const b of r.battles.values()) assert.ok(b.tickCount > 0, 'ceiling exhaustion rotates to remaining entries');
  } finally { r.runner.dispose(); }
});

for (const loading of [false, true]) test(`pause freezes preparation ${loading ? 'before engine loading' : 'between slices'} and resume excludes paused time`, async () => {
  const r = rig({ loading });
  try {
    let done = false;
    const pending = r.start('prep', { elapsed: 2 }).then(() => { done = true; });
    await settle();
    if (!loading) await r.frame();
    r.pause(true);
    const ticks = r.battles.get('prep')?.tickCount || 0;
    r.release(); await settle();
    await r.frame(60000);
    r.doc.hidden = true; await r.pump();
    assert.equal(r.battles.get('prep').tickCount, ticks, 'neither RAF nor pump may step while paused');
    r.pause(false);
    for (let i = 0; i < 100 && !done; i++) await r.pump();
    assert.equal(done, true, 'resume must not add the paused minute to the catch-up target');
    await pending;
    assert.ok(r.battles.get('prep').tickCount < 100);
  } finally { r.runner.dispose(); }
});

test('hidden pump bounds and completes a display preparation without an authoritative active entry', async () => {
  const r = rig({ hidden: true });
  try {
    let done = false;
    const pending = r.start('watch', { authoritative: false, watch: true, elapsed: 2 }).then(() => { done = true; });
    await settle();
    assert.equal(r.frames.size, 0);
    assert.ok(r.intervals.size > 0, 'the hidden preparation needs the shared pump');
    for (let i = 0; i < 100 && !done; i++) assert.ok(await r.pump() <= 66, 'hidden work has its own soft allowance plus one step');
    assert.equal(done, true);
    await pending;
    assert.equal(r.intervals.size, 0, 'finished display preparation releases the background pump');
    assert.ok(r.runner.stats().maxPumpMs > 0);
  } finally { r.runner.dispose(); }
});

test('forced end commits a paused preparation once, and clear settles cancelled preparation once', async () => {
  const r = rig();
  try {
    let completed = 0, ownDone = 0;
    r.runner.on('ownDone', () => ownDone++);
    const pending = r.start('ended', { elapsed: 2 }).then(() => completed++);
    await settle(); await r.frame(); r.pause(true);
    r.runner.onEnd({ battleId: 'ended', reason: 'forced' });
    r.runner.onEnd({ battleId: 'ended', reason: 'forced' });
    await settle();
    assert.equal(completed, 1, 'finished preparation commits even without another unpaused frame');
    assert.equal(r.runner._entries.get('ended')?.done, true);
    assert.equal(ownDone, 1);
    assert.equal(r.sent.filter(m => m.t === 'b.result').length, 1);
    await pending;
    const cancelled = r.start('cancelled', { elapsed: 2 }).then(() => completed++);
    await settle(); r.runner.clear(); r.runner.clear(); await settle();
    assert.equal(completed, 2);
    await cancelled;
    await r.frame(1000); r.doc.hidden = true; await r.pump();
    assert.equal(r.runner._entries.size, 0);
    assert.equal(r.frames.size, 0);
    assert.equal(r.intervals.size, 0);
  } finally { r.runner.dispose(); }
});

for (const loading of [true, false]) test(`a repeated authoritative start updates elapsed while ${loading ? 'loading the engine' : 'preparing'}`, async () => {
  const r = rig({ cost: 0, loading });
  try {
    const first = r.start('same', { elapsed: loading ? 0 : 2 });
    await settle();
    const latest = loading ? 2 : 4;
    const second = r.start('same', { elapsed: latest });
    r.release(); await settle(); await r.frame();
    await Promise.all([first, second]);
    assert.equal(r.runner.stats().battles, 1, 'the existing preparation still owns the only Battle');
    assert.equal(r.battles.get('same').tickCount, latest * 30, 'the latest start clock is retained even without authority promotion');
  } finally { r.runner.dispose(); }
});

for (const cost of [0.5, 1]) for (const interval of [250, 1000]) {
  test(`hidden ${interval}ms cadence catches up and sustains 2x combat at ${cost}ms per tick`, async () => {
    const r = rig({ hidden: true, cost });
    try {
      let complete = false;
      const started = r.time;
      const pending = r.start('hidden', { elapsed: 2, speed: 2 }).then(() => { complete = true; });
      await settle();
      let pumps = 0;
      const lag = () => Math.floor((2 + (r.time - started) * 2 / 1000) * 30 + 1e-9) - r.battles.get('hidden').tickCount;
      const next = async () => {
        // setInterval cadence is measured between callback starts, not a full interval after each callback ends.
        const dt = await r.pump(Math.max(0, started + (++pumps) * interval - r.time));
        assert.ok(dt <= 64 + cost, 'background work still yields at its shared soft deadline');
        assert.equal(r.intervals.size, 1, 'no extra timers or accelerated wakeups');
      };
      for (let i = 0; i < 40 && !complete; i++) await next();
      assert.equal(complete, true, `preparation must converge while its clock keeps advancing (lag=${lag()} ticks)`);
      await pending;
      for (let i = 0; i < 40; i++) {
        await next();
        // Preserve the existing active-entry normal/catch-up threshold (4 * 8 ticks); it may sawtooth within it.
        assert.ok(lag() <= 32, `steady-state lag must stay bounded instead of increasing each pump (lag=${lag()})`);
      }
      assert.ok(r.sent.filter(m => m.t === 'b.progress').length > 2, 'authority continues reporting actual stepped progress');
      r.pause(true);
      const before = r.battles.get('hidden').tickCount;
      await r.pump(10000);
      assert.equal(r.battles.get('hidden').tickCount, before, 'the larger hidden allowance does not bypass pause');
    } finally { r.runner.dispose(); }
  });
}
