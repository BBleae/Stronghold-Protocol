// The own-field HUD values follow the DRAWN picture, not the sim tick (review point 7). A real battle runs in the browser
// runner (fake clock / frames); its 'snap' and 'state' feeds go through the HUD queue exactly like game.js wires them
// (createHudDelay, the render engine's 0.5 s look-ahead as the lag). Property: every value the screen receives is the
// value that was published 500 ms earlier — kills with their frame, leaks / done with theirs, the done flag never ahead
// of the final n/n — and a solo pause holds the queue with the frozen picture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattleRunner } from '../../public/js/battle/runner.js';
import { createStore, initialState } from '../../public/js/store.js';
import * as specMod from '../../server/sim/spec.js';
import { DataSource } from '../../server/sim/simdata.js';
import { PHASE } from '../../shared/constants.js';
import { createHudDelay, snapHud, snapUnits, pickDrawn, drawnOf, ownFieldGate } from '../../public/js/ui/gameLogic.js';
import { DATA, makeMatch } from './harness.js';

const DS = new DataSource(DATA, null);
const LAG = 500;          // the engine's look-ahead in real ms (render/app.js renderLag() once it has built up)
const STEP = 1000 / 60;

function realStart(seed = 7301, round = 2, { weaken = false } = {}) {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 1, seed, captureFrames: false, clientCombat: true, clients: false });
  h.autoHumans();
  h.m.start();
  h.run(() => h.m.phase === PHASE.COMBAT && h.m.round === 1);
  h.run(() => h.m.phase === PHASE.COMBAT && h.m.round === round, { maxSteps: 3e6 });
  const msg = h.lastTo('p_0', 'b.start');
  h.m.dispose();
  // a board of one operator lets enemies through: leaks whatever the balance of the release (the auto boards of these early
  // rounds win cleanly since 0.1.2)
  if (weaken && msg) msg.spec = { ...msg.spec, players: msg.spec.players.map((p) => ({ ...p, units: (p.units || []).slice(0, 1) })) };
  return msg;
}

/** The runner on a manual clock + the HUD queue on the same clock, fed like game.js feeds it. */
function rig(start) {
  let t = 1000;
  const frames = [];
  const handlers = new Map();
  const net = {
    on(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); return () => handlers.get(type).delete(fn); },
    emit(type, msg) { for (const fn of handlers.get(type) || []) fn({ t: type, ...msg }); },
    send() { return true; },
    request() { return Promise.resolve({ t: 'ok' }); },
  };
  const store = createStore(initialState);
  const runner = createBattleRunner({
    net, store, doc: { hidden: false, addEventListener() {} }, now: () => t,
    raf: (fn) => { frames.push(fn); return frames.length; }, caf() {}, setInterval: () => 1, clearInterval() {},
    loadSim: async () => ({ spec: specMod, ds: DS }), logger: { error() {}, warn() {}, info() {}, debug() {} },
  });
  const timers = new Map();
  let seq = 0;
  const rec = { pushes: { hud: [], battle: [], units: [] }, released: [], snaps: [], states: [] };
  const queue = createHudDelay({
    field: () => start.fieldId, now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    onHud: (h) => rec.released.push({ at: t, ch: 'hud', v: h }),
    onBattle: (b) => rec.released.push({ at: t, ch: 'battle', v: b }),
    onUnits: (u) => rec.released.push({ at: t, ch: 'units', v: u }),
  });
  runner.on('snap', (s) => {
    const h = snapHud(s), u = snapUnits(s);
    rec.snaps.push(s);
    rec.pushes.hud.push({ at: t, v: h });
    rec.pushes.units.push({ at: t, v: u });
    queue.push(s.fieldId, h, LAG, { units: u });
  });
  runner.on('state', (s) => {
    rec.states.push(s);
    const b = pickDrawn(s);
    if (!b) return;
    rec.pushes.battle.push({ at: t, v: b });
    queue.pushBattle(b.fieldId, b, LAG);
  });
  const pump = () => {
    for (;;) {
      let next = null;
      for (const [id, x] of timers) if (x.at <= t && (!next || x.at < next[1].at)) next = [id, x];
      if (!next) break;
      timers.delete(next[0]);
      next[1].fn();
    }
  };
  const r = {
    runner, net, store, queue, rec, timers,
    get t() { return t; },
    /** one animation frame of the runner, then the queue's due timers */
    frame() { t += STEP; const q = frames.splice(0); for (const fn of q) fn(t); pump(); },
    async settle() { for (let i = 0; i < 50; i++) { await new Promise((res) => setImmediate(res)); const q = frames.splice(0); for (const fn of q) fn(t); pump(); } },
  };
  return r;
}

/** The latest push of a channel published at or before `t` (its value is what the screen must show at t + LAG). */
const latestPush = (list, t) => { let v = null; for (const p of list) if (p.at <= t) v = p; return v; };

// round 2: leaks (LP −N) and a timeout leak at the end; round 4: a clean win whose last kill falls in the final 0.5 s (the
// capsule used to read 7/8 under a 作战结束 pill: the done flag came with the sim tick, the n/n with the drawn frame)
for (const { round, leaks } of [{ round: 2, leaks: true }, { round: 4, leaks: false }]) {
  test(`real battle (round ${round}): every released value is the one published 0.5 s earlier; the done flag arrives with the final n/n`, async () => {
    const start = realStart(7301, round, { weaken: leaks });
    assert.ok(start && start.authoritative);
    const r = rig(start);
    r.net.emit('b.start', start);
    await r.settle();
    const e = r.runner._entries.get(start.battleId);
    for (let i = 0; i < 60 * 200 && !(e.done && r.queue.size === 0); i++) r.frame();
    assert.ok(e.done, 'the battle finished');
    assert.equal(r.queue.size, 0, 'the queue drained');
    assert.equal(r.timers.size, 0, 'no timer left');

    const { rec } = r;
    assert.ok(rec.released.length > 200, 'a frame\'s worth of releases per frame');
    for (const ch of ['hud', 'battle', 'units']) {
      const rel = rec.released.filter((x) => x.ch === ch);
      assert.ok(rel.length > 0, `${ch} released`);
      for (const x of rel) {
        const p = latestPush(rec.pushes[ch], x.at - LAG);
        assert.ok(p, `${ch} at ${x.at}: something was published ≥ 0.5 s before`);
        assert.deepEqual(x.v, p.v, `${ch} at ${x.at} is the value of ${LAG} ms earlier`);
        assert.ok(x.at - (p.at + LAG) < STEP + 1, `${ch} at ${x.at} is not late (due ${p.at + LAG})`);
      }
    }

    // the done flag: published at the sim's finish, shown with the final frame's n/n 0.5 s later
    const doneAt = rec.pushes.battle.find((p) => p.v.done);
    assert.ok(doneAt, 'the runner published done');
    const doneRel = rec.released.find((x) => x.ch === 'battle' && x.v.done);
    assert.ok(doneRel && doneRel.at - doneAt.at >= LAG && doneRel.at - doneAt.at < LAG + STEP + 1, `done released ${doneRel && doneRel.at - doneAt.at} ms after the sim published it`);
    const final = snapHud(rec.snaps.at(-1));
    const hudAtDone = rec.released.filter((x) => x.ch === 'hud' && x.at <= doneRel.at).at(-1).v;
    assert.deepEqual(hudAtDone, final, 'the capsule already shows the final snapshot\'s kills when the pill appears');
    // what the undelayed state showed: at the sim's done instant the picture (and the capsule) were still 0.5 s back
    const hudAtSimDone = rec.released.filter((x) => x.ch === 'hud' && x.at <= doneAt.at).at(-1).v;
    if (round === 4) assert.notDeepEqual([hudAtSimDone.killed, hudAtSimDone.total], [final.killed, final.total], `non-vacuous: the sim-clock flag would have met ${hudAtSimDone.killed}/${hudAtSimDone.total}, not ${final.killed}/${final.total}`);

    // the leak count (LP −N): each count appears 0.5 s after the sim counted it, in order
    const fid = start.fieldId;
    const seqOf = (list) => { const out = []; for (const x of list) { const n = (x.v.leaks || {})[fid]; if (n !== undefined && n !== out.at(-1)?.n) out.push({ at: x.at, n }); } return out; };
    const pushedLeaks = seqOf(rec.pushes.battle);
    const shownLeaks = seqOf(rec.released.filter((x) => x.ch === 'battle'));
    if (leaks) assert.ok(pushedLeaks.length >= 3, `the round has leaks (${pushedLeaks.map((x) => x.n)})`);
    assert.deepEqual(shownLeaks.map((x) => x.n), pushedLeaks.map((x) => x.n), 'the same counts, the same order');
    shownLeaks.forEach((x, i) => assert.ok(x.at - pushedLeaks[i].at >= LAG && x.at - pushedLeaks[i].at < LAG + STEP + 1, `leak count ${x.n} shown ${x.at - pushedLeaks[i].at} ms after the sim counted it`));
  });
}

test('real battle: a solo pause holds the queue with the frozen picture; on resume the pending values follow with their original spacing', async () => {
  const start = realStart(7301);
  const r = rig(start);
  r.net.emit('b.start', start);
  await r.settle();
  const e = r.runner._entries.get(start.battleId);
  for (let i = 0; i < 60 * 10; i++) r.frame();           // 10 real s into the battle
  const tp = r.t;
  const before = r.rec.released.length;
  // the pause flag stops the runner's clocks and (game.js's own effect) the queue's, at the same moment
  r.store.patch('match', { public: { phase: PHASE.COMBAT, paused: true } });
  r.queue.setPaused(true);
  const pending = r.rec.pushes.hud.filter((p) => p.at + LAG > tp);   // frames pushed < 0.5 s ago: still to be shown
  assert.ok(pending.length >= 20, `about 0.5 s of frames are still queued (${pending.length})`);
  const ticks = e.battle.tickCount;
  for (let i = 0; i < 60 * 3; i++) r.frame();             // 3 s of paused frames
  assert.equal(e.battle.tickCount, ticks, 'the sim is frozen');
  assert.equal(r.rec.released.length, before, 'nothing is released while paused: the numbers do not run ahead of the frozen picture');
  const tr = r.t;
  r.store.patch('match', { public: { phase: PHASE.COMBAT, paused: false } });
  r.queue.setPaused(false);
  for (let i = 0; i < 60; i++) r.frame();
  const rel = r.rec.released.filter((x) => x.ch === 'hud' && x.at > tp);
  assert.equal(rel[0].at >= tr, true, 'nothing before the resume');
  // the first frames queued before the pause are shown on schedule: their remaining lag after the resume
  const first = pending[0];
  const expect = tr + (first.at + LAG - tp);
  assert.ok(Math.abs(rel[0].at - expect) < STEP * 2, `first pending frame shown at resume + ${rel[0].at - tr} ms (expected ${expect - tr})`);
  assert.deepEqual(rel[0].v, first.v);
  r.runner.dispose();
});

test('the entry frame is drawn at once: a replica entered mid-battle already has its leaks at show(), so the drawn slice is seeded, not queued', async () => {
  const start = realStart(7307);
  const spec = JSON.parse(JSON.stringify(start.spec));
  for (const p of spec.players) p.units = [];                       // an empty board leaks
  const r = rig(start);
  r.net.emit('b.start', { ...start, spec, authoritative: false, watch: false, elapsed: 40 });
  await r.settle();
  const seed = pickDrawn(r.runner.state());                         // what game.js reads at enter
  assert.ok(seed, 'a battle on screen');
  assert.ok(Object.values(seed.leaks).some((n) => n > 0), 'the entry frame already counts leaks');
  assert.equal(drawnOf(r.runner.state(), seed), seed);
  assert.equal(ownFieldGate(r.runner.state(), seed, start.fieldId).onScreen, true);
  assert.equal(ownFieldGate(r.runner.state(), null, start.fieldId).drawnDone, false, 'not done at elapsed 40');
  r.runner.dispose();
});

test('the runner\'s state listeners get null when it clears / is disposed: ignored by the drawn slice', async () => {
  const start = realStart(7301);
  const r = rig(start);
  r.net.emit('b.start', start);
  await r.settle();
  const before = r.rec.pushes.battle.length;
  assert.ok(before > 0);
  r.runner.dispose();
  assert.equal(r.rec.states.at(-1), null, 'cleared: state(null)');
  assert.equal(r.rec.pushes.battle.length, before, 'null is not queued');
  assert.equal(pickDrawn(null), null);
});
