import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattleRunner, CATCHUP_TICKS, FRAME_WORK_MS, LOADING_WORK_MS, HIDDEN_WORK_MS, PREPARE_FLOOR, FRAME_STALL_MS, ticksPerFrameCap }
  from '../../public/js/battle/runner.js';
import { createStore, initialState } from '../../public/js/store.js';
import * as specMod from '../../server/sim/spec.js';
import { FakeBattle } from './fakeBattle.js';

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

// A step consumes measurable main-thread time, independently of game ticks. No real CPU load or timers.
function rig({ cost = 2, hidden = false, loading = false } = {}) {
  let time = 1000, seq = 0, release;
  const frames = new Map(), intervals = new Map(), battles = new Map(), sent = [], starts = new Map();
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
      const msg = { battleId: id, fieldId: id, kind: 'normal', authoritative: true,
        watch: false, elapsed: 0, speed: 1,
        spec: { battleId: id, fieldId: id, kind: 'normal', players: [{ playerId: 'p1' }] }, ...extra };
      starts.set(id, { at: time, elapsed: msg.elapsed, speed: msg.speed });
      return runner.onStart(msg);
    },
    /** Ticks battle `id` is behind its clock at `at` (the runner's targetTick from the start's elapsed and speed). */
    lag(id, at = time) {
      const s = starts.get(id);
      return Math.floor((s.elapsed + ((at - s.at) / 1000) * s.speed) * 30 + 1e-9) - (battles.get(id)?.tickCount ?? 0);
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
    /** A display refreshing every `interval` ms: each call runs the next frame on that grid (an overrun skips vsyncs). */
    vsync(interval) {
      const origin = time;
      let k = 0;
      return () => {
        k = Math.max(k + 1, Math.ceil((time - origin) / interval - 1e-9));
        return this.frame(Math.max(0, origin + k * interval - time));
      };
    },
  };
}

test('expensive preparation yields before catching up and its slices are measured', async () => {
  const cost = 2;
  const r = rig({ cost });
  try {
    let done = false;
    const before = r.time;
    const pending = r.start('prep', { elapsed: 2 }).then(() => { done = true; });
    await settle();
    assert.ok(r.time - before <= 6, 'start must not synchronously consume a 600-tick catch-up');
    assert.equal(done, false);
    for (let i = 0; i < 100 && !done; i++) {
      // nothing on screen: the loading budget, the floor (twice the one tick its clock grows in such a frame) and the
      // costly step that crosses the deadline
      assert.ok(await r.frame() <= LOADING_WORK_MS + (PREPARE_FLOOR + 1) * cost, 'one costly step may cross the soft deadline');
    }
    assert.equal(done, true, 'yielded preparation eventually catches up');
    await pending;
    assert.ok(r.battles.get('prep').tickCount >= 52);
    const stats = r.runner.stats();
    assert.ok(stats.prepareMs > 0 && stats.maxPrepareMs > 0 && stats.maxFrameMs > 0);
  } finally { r.runner.dispose(); }
});

test('running fields keep their clock past the shared budget while two preparations converge behind them, authority first', async () => {
  const cost = 2, cap = ticksPerFrameCap(2);
  const r = rig({ cost });
  try {
    await r.start('authority', { speed: 2 });
    await r.start('replica', { authoritative: false, watch: true, speed: 2 }); // on screen; the authority runs off screen
    const committed = [];
    const first = r.start('prep1', { elapsed: 20, speed: 2 }).then(() => committed.push('prep1'));
    const second = r.start('prep2', { authoritative: false, watch: true, elapsed: 20, speed: 2 }).then(() => committed.push('prep2'));
    await settle();
    const next = r.vsync(1000 / 60);
    for (let i = 0; i < 600 && committed.length < 2; i++) {
      const dt = await next();
      // the two fields' shares (≤ 2 ticks each in a frame of ≤ 2 vsyncs), the floors (twice that), the budget, one step
      assert.ok(dt <= (2 * 2 + 2 * PREPARE_FLOOR * 2) * cost + FRAME_WORK_MS + cost, `frame ${i}: ${dt} ms`);
      for (const id of ['authority', 'replica']) assert.ok(r.lag(id) <= cap, `frame ${i}: ${id} keeps its clock (lag ${r.lag(id)})`);
    }
    assert.deepEqual(committed, ['prep1', 'prep2'], 'both preparations commit within 10 s, the authoritative one first');
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
  const cost = 2;
  const r = rig({ hidden: true, cost });
  try {
    let done = false;
    const pending = r.start('watch', { authoritative: false, watch: true, elapsed: 2 }).then(() => { done = true; });
    await settle();
    assert.equal(r.frames.size, 0);
    assert.ok(r.intervals.size > 0, 'the hidden preparation needs the shared pump');
    for (let i = 0; i < 100 && !done; i++) {
      // its own soft allowance, the floor (twice the ≤ 3 ticks its clock grows in a pump this long) and one step
      assert.ok(await r.pump() <= HIDDEN_WORK_MS + (1 + PREPARE_FLOOR * 3) * cost, 'hidden work has its own soft allowance');
    }
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

// Review of the worker scheduling change, item 3a: at a throttled 1 Hz pump the shared 64 ms budget kept an authority
// from its clock from 1.085 ms per tick on (lag 123 / 2043 / 3363 / 5284 ticks after 120 s at 1.1 / 1.5 / 2 / 4 ms).
for (const cost of [0.5, 1, 1.1, 1.5, 2, 4]) for (const interval of [250, 1000]) {
  test(`hidden ${interval}ms cadence catches up and sustains 2x combat at ${cost}ms per tick`, async () => {
    const r = rig({ hidden: true, cost });
    try {
      let complete = false;
      const started = r.time;
      // an authoritative b.start while hidden (a reconnect / handover): prepared by the pump alone
      const pending = r.start('hidden', { elapsed: 2, speed: 2 }).then(() => { complete = true; });
      await settle();
      let pumps = 0;
      const next = async () => {
        // setInterval cadence is measured between callback starts, not a full interval after each callback ends.
        const wait = Math.max(0, started + (++pumps) * interval - r.time);
        const behind = r.lag('hidden', r.time + wait);
        const dt = await r.pump(wait);
        // the share (as before the budget: ≤ CATCHUP_TICKS per pump, never cut), then the soft allowance and one step
        assert.ok(dt <= Math.min(behind, CATCHUP_TICKS) * cost + HIDDEN_WORK_MS + cost, `pump ${pumps}: ${dt} ms`);
        assert.equal(r.intervals.size, 1, 'no extra timers or accelerated wakeups');
      };
      for (let i = 0; i < 40 && !complete; i++) await next();
      assert.equal(complete, true, `preparation must converge while its clock keeps advancing (lag=${r.lag('hidden')} ticks)`);
      await pending;
      const lags = [];
      for (let i = 0; i < 60000 / interval; i++) { await next(); lags.push(r.lag('hidden')); }
      // 1 Hz: what its clock moved during the pump itself (≤ 18 ticks at 4 ms); 4 Hz: the normal / catch-up threshold of
      // an active entry (4 · 8 ticks), which it may sawtooth within
      const bound = interval === 1000 ? 18 : 32;
      assert.ok(Math.max(...lags) <= bound, `steady-state lag stays bounded (max ${Math.max(...lags)} > ${bound})`);
      const half = lags.length / 2;
      assert.ok(Math.max(...lags.slice(half)) <= Math.max(...lags.slice(0, half)), 'and does not grow over the minute');
      assert.ok(r.sent.filter(m => m.t === 'b.progress').length > 2, 'authority continues reporting actual stepped progress');
      r.pause(true);
      const before = r.battles.get('hidden').tickCount;
      await r.pump(10000);
      assert.equal(r.battles.get('hidden').tickCount, before, 'the larger hidden allowance does not bypass pause');
    } finally { r.runner.dispose(); }
  });
}

// Item 3c: at 12 fps and 1 ms per tick a 4 ms budget gave the field on screen 4 of its 5 ticks per frame (724 ticks
// behind after a minute; before the budget ≤ 4).
test('the field on screen keeps its clock at 12 fps and 1 ms per tick, each frame within its per-frame cap', async () => {
  const cost = 1, cap = ticksPerFrameCap(2);
  const r = rig({ cost });
  try {
    await r.start('own', { speed: 2 });
    const next = r.vsync(1000 / 12);
    for (let i = 0; i < 12 * 60; i++) {
      assert.ok(await next() <= cap * cost, `frame ${i}: as before the budget, a running field steps at most cap·c`);
      assert.ok(r.lag('own') <= cap, `frame ${i}: lag ${r.lag('own')}`);
    }
  } finally { r.runner.dispose(); }
});

// Item 3d: two running battles at 30 fps fell behind from 1.34 ms per tick on.
test('two running fields both keep their clock at 30 fps and 2 ms per tick', async () => {
  const cost = 2, cap = ticksPerFrameCap(2);
  const r = rig({ cost });
  try {
    await r.start('own', { speed: 2 });
    await r.start('watched', { authoritative: false, watch: true, speed: 2 }); // on screen, the authority off screen
    assert.equal(r.runner.state().battleId, 'watched');
    const next = r.vsync(1000 / 30);
    const lags = [];
    for (let i = 0; i < 30 * 60; i++) {
      assert.ok(await next() <= 2 * cap * cost, `frame ${i}: within the two fields' caps`);
      lags.push(Math.max(r.lag('own'), r.lag('watched')));
    }
    assert.ok(Math.max(...lags) <= cap, `neither falls behind (max lag ${Math.max(...lags)})`);
  } finally { r.runner.dispose(); }
});

// Item 3d: the rotation sacrificed whichever battle was inserted later — the authority, behind a replica shown first.
test('after a stall the authority catches up ahead of the display replica on screen', async () => {
  const cost = 1, cap = ticksPerFrameCap(2);
  const r = rig({ cost });
  try {
    await r.start('watched', { authoritative: false, watch: true, speed: 2 });
    await r.start('own', { speed: 2 });
    await r.start('watched', { authoritative: false, watch: true, speed: 2 }); // back to the replica: inserted first
    assert.equal(r.runner.state().battleId, 'watched');
    await r.frame(3000); // a 3 s stall: both 180 ticks behind
    const next = r.vsync(1000 / 30);
    let ownAt = null, watchedAt = null;
    for (let i = 0; i < 300 && watchedAt == null; i++) {
      // both shares, then the budget for what no field on screen plays at its pace (a fast-forward), then one step
      assert.ok(await next() <= 2 * cap * cost + LOADING_WORK_MS + cost, `frame ${i}`);
      if (ownAt == null && r.lag('own') <= cap) ownAt = i;
      if (watchedAt == null && r.lag('watched') <= cap) watchedAt = i;
    }
    assert.ok(ownAt != null && watchedAt != null, 'both catch up');
    assert.ok(ownAt < watchedAt, `the authority first (frame ${ownAt}, the replica frame ${watchedAt})`);
  } finally { r.runner.dispose(); }
});

// Item 3b: a lone preparation of 80 game seconds took 2.04 s at 60 Hz and 0.2 ms per tick (before the budget 0.55 s).
test('a lone preparation of an 80 s field at 60 Hz and 0.2 ms per tick is on screen within 1 s', async () => {
  const cost = 0.2;
  const r = rig({ cost });
  try {
    let doneAt = null;
    const started = r.time;
    const pending = r.start('reload', { authoritative: false, watch: true, elapsed: 80, speed: 2 }).then(() => { doneAt = r.time; });
    await settle();
    const next = r.vsync(1000 / 60);
    // nothing on screen: the loading budget, the floor (twice the ≤ 1 tick its clock grows per frame) and one step
    for (let i = 0; i < 600 && doneAt == null; i++) assert.ok(await next() <= LOADING_WORK_MS + (PREPARE_FLOOR + 1) * cost + 1e-9);
    await pending;
    assert.ok(doneAt != null && doneAt - started <= 1000, `shown after ${doneAt - started} ms`);
    assert.equal(r.runner.state().battleId, 'reload');
  } finally { r.runner.dispose(); }
});

// Item 3b: with an older field still running on screen, a preparation never converged at 30 fps from 1 ms per tick.
test('a preparation converges at 30 fps and 1 ms per tick while the old field keeps running on screen', async () => {
  const cost = 1, cap = ticksPerFrameCap(2);
  const r = rig({ cost });
  try {
    await r.start('old', { authoritative: false, watch: true, speed: 2 });
    let doneAt = null;
    const started = r.time;
    const pending = r.start('new', { authoritative: false, watch: true, elapsed: 80, speed: 2 }).then(() => { doneAt = r.time; });
    await settle();
    assert.equal(r.runner.state().battleId, 'old', 'the old field stays on screen while the new one loads');
    const next = r.vsync(1000 / 30);
    for (let i = 0; i < 30 * 30 && doneAt == null; i++) {
      // the old field's share, the floor (twice the ≤ 3 ticks a frame of ≤ 2 vsyncs grows), the budget, one step
      assert.ok(await next() <= cap * cost + PREPARE_FLOOR * 3 * cost + FRAME_WORK_MS + cost, `frame ${i}`);
      assert.ok(r.lag('old') <= cap, `frame ${i}: the old field keeps its clock (lag ${r.lag('old')})`);
    }
    await pending;
    assert.ok(doneAt != null && doneAt - started <= 20000, `shown after ${doneAt == null ? '> 30 s' : `${doneAt - started} ms`}`);
    assert.equal(r.runner.state().battleId, 'new');
  } finally { r.runner.dispose(); }
});

// A visible page that gets no animation frames (an occluded window, an embedded web view that stops drawing without
// setting document.hidden) left the authority to the server's deadline: the interval pump only ran for hidden tabs.
test('a visible page whose frames stall keeps the authority on its clock through the interval pump', async () => {
  const cost = 0.5, cap = ticksPerFrameCap(2);
  const r = rig({ cost });
  try {
    const pending = r.start('stall', { speed: 2 });
    const next = r.vsync(1000 / 60);
    for (let i = 0; i < 120 && r.runner.state().battleId !== 'stall'; i++) await next();
    await pending;
    for (let i = 0; i < 60; i++) await next();
    assert.ok(r.lag('stall') <= cap, `on its clock while frames run (lag ${r.lag('stall')})`);
    // frames stop: within FRAME_STALL_MS the pending frame still owns the work, after it the pump takes over
    const stalledAt = r.time;
    let pumps = 0;
    const lags = [];
    while (r.time - stalledAt < 60000) {
      await r.pump(Math.max(0, stalledAt + (++pumps) * 250 - r.time));
      if (r.time - stalledAt >= FRAME_STALL_MS + 250) lags.push(r.lag('stall'));
    }
    assert.ok(Math.max(...lags) <= 32, `bounded while frames stall (max lag ${Math.max(...lags)})`);
    assert.ok(Math.min(...lags) >= 0, 'never ahead of its clock');
    assert.ok(r.sent.filter(m => m.t === 'b.progress').length > 30, 'the authority keeps reporting');
    // frames come back: the next one plays on from the pump's progress, without stepping past the clock
    await r.frame(1000 / 60);
    assert.ok(r.lag('stall') >= 0 && r.lag('stall') <= cap, `back on its clock (lag ${r.lag('stall')})`);
  } finally { r.runner.dispose(); }
});
