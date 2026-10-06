// test/render/interp.test.js — snapshot interpolation buffer: clock, lerp, spawn/die mid-buffer, teleports,
// extrapolation guard, rate estimation, event stamping, robustness against junk.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotBuffer, normalizeSnapshot, isCosmeticEvent, frameTime } from '../../public/js/render/interp.js';

const fxFormOf = (e) => (e && e[0] === 'fx' && e[4] && Object.hasOwn(e[4], 'form') ? e[4].form : undefined);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const snap = (t, units) => ({ fieldId: 'n:1', t, units, dp: 10, killed: 0, total: 5 });
const U = (id, x, y, hp = 100, anim = 0, flags = 0) => [id, x, y, hp, 100, 5, 10, flags, anim];

/** Feed snapshots every 0.1 game s at 2× (every 50 ms real) starting at real time 0. */
function feed(buf, frames, t0 = 0, realStep = 0.05, gameStep = 0.1) {
  frames.forEach((units, i) => buf.push(snap(t0 + i * gameStep, units), i * realStep));
  return (frames.length - 1) * realStep;
}

describe('normalizeSnapshot', () => {
  test('rejects junk, keeps valid tuples, fills defaults', () => {
    assert.equal(normalizeSnapshot(null), null);
    assert.equal(normalizeSnapshot({ t: 'x' }), null);
    assert.equal(normalizeSnapshot({ t: NaN, units: [] }), null);
    const s = normalizeSnapshot({ t: 1, units: [U(1, 2, 3), [2, NaN, 1], 'x', [3], [{}, 1, 1], [4, 1, 2, 'hp']] });
    assert.deepEqual([...s.units.keys()], [1, 4]);
    assert.deepEqual(s.units.get(4), [4, 1, 2, 0, 0, 0, 0, 0, 0]);
  });

  test('wire frames: game time comes from `gt` (the frame `t` is the message type)', () => {
    const wire = { t: 'b.snap', fieldId: 'n:a', gt: 12.5, units: [U(1, 2, 9)], killed: 1, total: 3 };
    assert.equal(frameTime(wire), 12.5);
    assert.equal(normalizeSnapshot(wire).t, 12.5);
    assert.equal(frameTime({ t: 3.5 }), 3.5, 'raw Battle snapshot / recording');
    assert.equal(frameTime({ t: 3.5, gt: 4 }), 4, 'gt wins');
    assert.ok(Number.isNaN(frameTime({ t: 'b.snap' })));
    assert.ok(Number.isNaN(frameTime({ t: 'b.ev', gt: Infinity })));
    assert.ok(Number.isNaN(frameTime(null)));
    assert.equal(normalizeSnapshot({ t: 'b.snap', units: [] }), null, 'a wire frame without gt is unusable');
    // a buffer fed wire frames and gt-stamped events delivers the events at their snapshot time
    const b = new SnapshotBuffer({ delay: 0.1, rate: 2 });
    for (let i = 0; i <= 10; i++) {
      b.pushEvents([['dmg', 1, 5, 'phys']], i * 0.05, frameTime({ t: 'b.ev', gt: i * 0.1 }));
      assert.equal(b.push({ t: 'b.snap', gt: i * 0.1, units: [U(1, i * 0.1, 10)] }, i * 0.05), true);
    }
    assert.ok(near(b.newestT, 1.0));
    const due = b.takeEvents(0.55);
    assert.equal(due.length, 6, 'events stamped 0.0 … 0.5 are due at 0.55');
  });
});

describe('SnapshotBuffer', () => {
  test('render clock trails the newest snapshot by delay × rate', () => {
    const b = new SnapshotBuffer({ delay: 0.1, rate: 2 });
    const frames = [];
    for (let i = 0; i <= 20; i++) frames.push([U(1, i * 0.1, 10)]);
    const now = feed(b, frames);
    b.update(now);
    assert.ok(near(b.rate, 2, 0.05), `rate ${b.rate}`);
    assert.ok(near(b.renderT, b.newestT - 0.2, 0.03), `renderT ${b.renderT} newest ${b.newestT}`);
    // steady state: snapshots keep arriving every 50 ms real, frames every 16 ms → stays ~0.2 game s behind
    let t = 2, real = now;
    for (let i = 0; i < 60; i++) {
      real += 0.05; t += 0.1;
      b.push(snap(t, [U(1, t, 10)]), real);
      for (let f = 1; f <= 3; f++) b.update(real + f * 0.0166);
    }
    const lag = b.newestT - b.renderT;
    assert.ok(lag > 0.05 && lag < 0.25, `steady lag ${lag} (renderT ${b.renderT} newest ${b.newestT})`);
  });

  test('the stream stops (battle over, replay paused): the buffered frames play out at normal speed to the newest', () => {
    // review of the upstream PR: with the target fixed at newest − delay × rate the clock settled ~rate/6 short of the
    // newest snapshot when snapshots stopped, so the final kill's atk / dmg / die never played (nor their sounds)
    const b = new SnapshotBuffer({ delay: 0.5, rate: 2 });
    let real = 0, t = 0;
    for (let i = 0; i < 120; i++) {   // 6 s real at 20 Hz, 2 game s per real s
      t = i * 0.1; real = i * 0.05;
      b.pushEvents([['dmg', 1, 5, 'phys']], real, t);
      b.push(snap(t, [U(1, t, 10)]), real);
      for (let f = 1; f <= 3; f++) b.update(real + f * 0.0166);
    }
    const lag = b.newestT - b.renderT;
    assert.ok(lag > 0.85 && lag < 1.05, `steady: ~delay × rate behind (${lag})`);
    b.pushEvents([['die', 9, 'kill']], real, t);   // the final kill, on the last frame
    const t0 = b.renderT;
    let r = real + 0.05;
    for (let k = 0; k < 15; k++, r += 1 / 60) b.update(r);   // 0.25 s real after the last frame
    assert.ok(near(b.renderT - t0, 0.5, 0.12), `plays on at normal speed (${b.renderT - t0} game s in 0.25 s)`);
    for (let k = 0; k < 60; k++, r += 1 / 60) b.update(r);
    assert.equal(b.renderT, b.newestT, 'reaches the newest snapshot and holds it');
    const due = b.takeEvents(b.renderT);
    assert.ok(due.some((e) => e[0] === 'die'), 'the last events are delivered');
    for (let k = 0; k < 120; k++, r += 1 / 60) b.update(r);
    assert.equal(b.renderT, b.newestT, 'no extrapolation once the stream has stopped');
  });

  test('lerps positions / hp between bracketing snapshots; flags & anim from the older one', () => {
    const b = new SnapshotBuffer();
    b.push(snap(1.0, [U(1, 0, 10, 100, 1, 0)]), 0);
    b.push(snap(1.1, [U(1, 1, 10.5, 50, 2, 16)]), 0.05);
    const out = b.sample(1.05);
    const s = out.get(1);
    assert.ok(near(s.x, 0.5) && near(s.y, 10.25) && near(s.hp, 75));
    assert.equal(s.anim, 1);
    assert.equal(s.flags, 0);
    assert.ok(near(s.vx, 10) && near(s.vy, 5));
    const s2 = b.sample(1.1).get(1);
    assert.equal(s2.anim, 2);
    assert.equal(s2.flags, 16);
  });

  test('spawn mid-buffer appears only once renderT reaches it; die mid-buffer holds then disappears', () => {
    const b = new SnapshotBuffer();
    b.push(snap(0, [U(1, 0, 10), U(2, 5, 10)]), 0);
    b.push(snap(0.1, [U(1, 1, 10), U(3, 9, 12)]), 0.05);
    let out = b.sample(0.05);
    assert.ok(out.has(1) && out.has(2), 'dying unit still shown before the newer snapshot');
    assert.ok(!out.has(3), 'spawned unit not shown early');
    assert.ok(near(out.get(2).x, 5), 'holds last position');
    out = b.sample(0.1, out);
    assert.ok(out.has(3) && !out.has(2), 'sample map reused and pruned');
  });

  test('teleports (> teleport tiles between snapshots) snap instead of sliding', () => {
    const b = new SnapshotBuffer({ teleport: 2 });
    b.push(snap(0, [U(1, 0, 10)]), 0);
    b.push(snap(0.1, [U(1, 8, 10)]), 0.05);
    assert.equal(b.sample(0.05).get(1).x, 0);
    assert.equal(b.sample(0.1).get(1).x, 8);
  });

  test('extrapolation guard: never more than maxExtrapolate past the newest; then freezes', () => {
    const b = new SnapshotBuffer({ delay: 0.1, rate: 2, maxExtrapolate: 0.1 });
    const frames = [];
    for (let i = 0; i <= 10; i++) frames.push([U(1, i * 0.1, 10)]); // 1 tile/s game
    const now = feed(b, frames);
    b.update(now);
    for (let k = 1; k <= 200; k++) b.update(now + k * 0.02); // stream stalls for 4 s
    assert.ok(b.renderT <= b.newestT + 0.1 * b.rate + 1e-9, `renderT ${b.renderT}`);
    const s = b.sample();
    assert.ok(s.get(1).x <= 1.0 + 0.2 + 1e-6 && s.get(1).x >= 1.0, `extrapolated x ${s.get(1).x}`);
  });

  test('large lag snaps the clock; a stream restart (t jumps back) resets the buffer', () => {
    const b = new SnapshotBuffer({ delay: 0.1, rate: 2, snapAfter: 0.5 });
    b.push(snap(0, [U(1, 0, 10)]), 0);
    b.update(0);
    b.push(snap(30, [U(1, 3, 10)]), 0.1); // server jumped ahead
    b.update(0.11);
    assert.ok(b.renderT > 29, `snapped to ${b.renderT}`);
    b.pushEvents([['dmg', 1, 5, 'phys']], 0.12);
    assert.ok(b.push(snap(0.5, [U(9, 1, 1)]), 0.2), 'accepted after reset');
    assert.equal(b.size, 1);
    assert.equal(b.events.length, 0, 'old events dropped on restart');
  });

  test('duplicate / out-of-order / junk snapshots are ignored', () => {
    const b = new SnapshotBuffer();
    assert.ok(b.push(snap(1, [U(1, 0, 0)]), 0));
    assert.ok(!b.push(snap(1, [U(1, 9, 9)]), 0.01));
    assert.ok(!b.push(snap(0.9, [U(1, 9, 9)]), 0.02));
    assert.ok(!b.push({ t: 'no' }, 0.03));
    assert.ok(!b.push(null, 0.03));
    assert.equal(b.size, 1);
    assert.equal(b.sample(1).get(1).x, 0);
  });

  test('rate estimation follows the stream (1× and 4×) within clamps', () => {
    for (const rate of [1, 4]) {
      const b = new SnapshotBuffer({ rate: 2 });
      for (let i = 0; i < 80; i++) b.push(snap(i * 0.1, [U(1, 0, 0)]), i * 0.1 / rate);
      assert.ok(near(b.rate, rate, 0.1), `estimated ${b.rate} for ${rate}`);
    }
  });

  test('old snapshots are trimmed even without frames (hidden tab); events queue is bounded', () => {
    const b = new SnapshotBuffer({ keep: 1 });
    for (let i = 0; i < 200; i++) {
      b.push(snap(i * 0.1, [U(1, i, 0)]), i * 0.05);
      b.pushEvents([['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['die', i]], i * 0.05);
    }
    assert.ok(b.size < 40, `size ${b.size}`);
    assert.ok(b.events.length <= 6000, `events ${b.events.length}`);
    assert.equal(b.events.filter((e) => e.ev[0] === 'die').length, 200, 'state events never shed');
    b.update(10);
    const s = b.sample();
    assert.ok(s.get(1), 'sample available');
  });

  test('events: stamped inside the latest interval, delivered in order when renderT passes', () => {
    const b = new SnapshotBuffer({ delay: 0.1, rate: 2 });
    b.push(snap(0, [U(1, 0, 0)]), 0);
    b.push(snap(0.1, [U(1, 0, 0)]), 0.05);
    b.pushEvents([['atk', 1, 2, 'arrow'], ['dmg', 2, 50, 'phys'], 'junk', [5]], 0.05);
    b.push(snap(0.2, [U(1, 0, 0)]), 0.1);
    b.pushEvents([['die', 2]], 0.1);
    assert.equal(b.events.length, 3);
    assert.deepEqual(b.takeEvents(0.0), []);
    const first = b.takeEvents(0.06);
    assert.deepEqual(first.map((e) => e[0]), ['atk', 'dmg']);
    assert.deepEqual(b.takeEvents(0.2).map((e) => e[0]), ['die']);
    // server-provided stamp
    b.pushEvents([['skill', 1, 1]], 0.2, 0.15);
    b.pushEvents([['skill', 1, 0]], 0.2, 5);
    assert.deepEqual(b.takeEvents(0.16).map((e) => e[2]), [1]);
  });

  test('takeEvents can drop stale cosmetic events but keeps state events', () => {
    const b = new SnapshotBuffer();
    b.pushEvents([['dmg', 1, 5, 'phys'], ['die', 1], ['fx', 'burst', 1, 1, {}], ['spawn', { id: 3 }]], 0, 1);
    const out = b.takeEvents(10, [], 5);
    assert.deepEqual(out.map((e) => e[0]), ['die', 'spawn']);
    assert.ok(isCosmeticEvent(['atk']) && !isCosmeticEvent(['leak']) && !isCosmeticEvent(null));
    b.pushEvents([['leak', 4]], 0, 50);
    assert.deepEqual(b.flushEvents().map((e) => e[0]), ['leak']);
  });

  test('an enemy\'s form fx is state (player report #5 after 0.1.0): it survives the stale drop and the full-queue shed, a plain fx does not', () => {
    const form = (id, f) => ['fx', 'phase', 1, 1, { id, kind: f, form: f, dur: 2 }];
    assert.ok(!isCosmeticEvent(form(3, 'translator_youling')), 'a form fx is never cosmetic');
    assert.ok(!isCosmeticEvent(['fx', 'revive', 1, 1, { id: 3, form: null }]), 'back to the base clips (form null) too');
    assert.ok(isCosmeticEvent(['fx', 'phase', 1, 1, { id: 3, kind: 'artsBarrier' }]), 'a barrier phase stays cosmetic');
    // a 1 s stall at 2×: the render clock jumps past the 1.5 game s window
    const b = new SnapshotBuffer();
    b.pushEvents([['dmg', 3, 5, 'phys'], form(3, 'translator_youling'), ['fx', 'burst', 1, 1, {}]], 0, 1);
    const late = new Map();
    const out = b.takeEvents(10, [], 10 - 1.5, late);
    assert.deepEqual(out.map((e) => e[4]?.form ?? e[0]), ['translator_youling'], 'only the form fx is handed out');
    assert.ok(Math.abs(late.get(out[0]) - 9) < 1e-9, 'with its lateness (game s)');
    // replayed without a stamp right after a reset (screens/game.js early buffer: stamped 0)
    const r = new SnapshotBuffer();
    r.pushEvents([form(4, 'husk'), ['fx', 'ember', 1, 1, { r: 1 }]], 0);
    assert.deepEqual(r.takeEvents(30, [], 28.5).map(fxFormOf), ['husk']);
    // a hidden-tab flood: the shed keeps it
    const q = new SnapshotBuffer();
    q.pushEvents([form(5, 'reborn')], 0, 0.5);
    for (let i = 0; i < 70; i++) q.pushEvents(Array.from({ length: 100 }, () => ['fx', 'burst', 1, 1, {}]), 0, 1 + i * 0.01);
    assert.ok(q.events.length <= 6000, `bounded (${q.events.length})`);
    assert.equal(q.events.filter((e) => e.ev[4]?.form === 'reborn').length, 1, 'never shed');
  });

  test('the end of a lasting fx (影哨 recalled, a channel ended) is never dropped as stale; a stale lasting START is, like a hit spark', () => {
    // review of the review fixes: a timed start replayed long after (a hidden server-run tab, a long stall) drew an
    // effect that had ended — it starts from now. Lost, an END would leave its record drawn for good
    const ends = [['fx', 'sentryRecall', 4, 10, { id: 3 }], ['fx', 'beam', 1, 1, { from: 4, to: 5, kind: 'deathEyeEnd' }]];
    const starts = [['fx', 'firewall', 5, 10, { id: 1, axis: 'col' }], ['fx', 'taunt', 6, 10, { id: 2 }], ['fx', 'tornado', 6, 10, { id: 2, duration: 8 }], ['fx', 'beam', 1, 1, { from: 4, to: 5, kind: 'deathEye', dur: 6 }]];
    const oneShots = [['fx', 'burst', 1, 1, {}], ['fx', 'beam', 1, 1, { from: 4, to: 5, kind: 'enemyShot' }], ['fx', 'telegraph', 1, 1, { kind: 'boom' }], ['dmg', 1, 5, 'phys'], ['heal', 1, 3], ['atk', 1, 2, 'none']];
    for (const e of ends) assert.ok(!isCosmeticEvent(e), `${e[1]} ${e[4].kind || ''} is not cosmetic`);
    for (const e of [...starts, ...oneShots]) assert.ok(isCosmeticEvent(e), `${e[0]}:${e[1]} is`);
    const b = new SnapshotBuffer({ delay: 0.5, rate: 2 });
    b.pushEvents([['spawn', { id: 1 }], ['status', 1, 'ab:exposed', 1], ...starts, ...ends, ...oneShots], 0, 1);
    const out = b.takeEvents(60, [], 58.5);
    assert.deepEqual(out.map((e) => e[0] + (e[0] === 'fx' ? `:${e[1]}` : '')), ['spawn', 'status', 'fx:sentryRecall', 'fx:beam']);
  });

  test('a field entered mid-battle: the early buffer stamped with the snapshot\'s game time is delivered by the render clock, lasting fx included', () => {
    // screens/game.js: view.pushEvents({ ev: early, gt: earlySnap.gt, quiet: true }) before pushSnapshot(earlySnap) (quiet: drawn, not heard — heard-events.test.js)
    const early = [['spawn', { id: 1 }], ['status', 1, 'ab:exposed', 1], ['skill', 1, 1], ['fx', 'firewall', 6, 10, { id: 1, axis: 'col' }], ['fx', 'taunt', 6, 10, { id: 2 }]];   // (the buffer holds state events and lasting fx only)
    const b = new SnapshotBuffer({ delay: 0.5, rate: 2 });
    b.pushEvents(early, 0, 85.1);
    b.push(snap(85.0, [U(1, 5, 10)]), 0.01);
    b.push(snap(85.1, [U(1, 5, 10)]), 0.02);
    const names = (evs) => evs.map((e) => e[0] + (e[0] === 'fx' ? `:${e[1]}` : ''));
    assert.deepEqual(names(b.takeEvents(b.renderT, [], b.renderT - 1.5)), [], 'not before the render clock reaches the stamp');
    assert.deepEqual(names(b.takeEvents(85.1, [], 85.1 - 1.5)), ['spawn', 'status', 'skill', 'fx:firewall', 'fx:taunt'], 'then in order');
  });

  test('sample before any snapshot / with NaN time is empty; update before snapshots is NaN', () => {
    const b = new SnapshotBuffer();
    assert.ok(Number.isNaN(b.update(1)));
    assert.equal(b.sample().size, 0);
    b.push(snap(2, [U(1, 1, 1)]), 1);
    assert.equal(b.sample(NaN).size, 0);
    assert.equal(b.sample(0).get(1).x, 1, 'time before the oldest clamps to the oldest');
  });

  test('no NaN anywhere through a noisy stream', () => {
    const b = new SnapshotBuffer();
    let now = 0, t = 0;
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const out = new Map();
    for (let i = 0; i < 500; i++) {
      now += 0.03 + rnd() * 0.05;
      if (rnd() < 0.8) { t += 0.1; b.push(snap(t, [U(1, rnd() * 20, rnd() * 18, rnd() * 100), U(2 + (i % 5), 3, 3)]), now); }
      b.update(now);
      b.sample(undefined, out);
      for (const s of out.values()) for (const k of ['x', 'y', 'hp', 'sp', 'vx', 'vy']) assert.ok(Number.isFinite(s[k]), k);
    }
  });
});

describe('SnapshotBuffer: solo pause, arrival log, look-ahead in game seconds', () => {
  /** A live feed like the local runner's: a frame every 1/60 real s, game time at `rate` × real; returns renderT per frame
   *  (`.lags`: newest − renderT per frame). */
  function live(b, st, secs, rate = 2) {
    const out = [];
    out.lags = [];
    for (let i = 0; i < Math.round(secs * 60); i++) {
      st.real += 1 / 60; st.gt += rate / 60;
      b.push(snap(st.gt, [U(1, st.gt, 10)]), st.real);
      out.push(b.update(st.real));
      out.lags.push(b.newestT - out[i]);
    }
    return out;
  }
  const EPS = 1e-6;   // the steering overshoots the newest frame by a hair, the cap takes it back
  const monotonic = (rts, from) => rts.every((r, i) => r >= (i ? rts[i - 1] : from) - EPS);

  test('setPaused: a pause is not a stream stall — the clock stands still, resumes at normal speed, no step back', () => {
    // review of the upstream PR, point 6: a stall's first snapshot pulled the clock back by the look-ahead and eased in
    const b = new SnapshotBuffer({ lookAhead: 1, rate: 2 });
    const st = { real: 0, gt: 0 };
    live(b, st, 6);
    const rt = b.renderT;
    assert.ok(near(b.newestT - rt, 1, 0.1), `look-ahead before the pause ${b.newestT - rt}`);
    assert.equal(b.setPaused(true, st.real), true);
    assert.ok(b.paused);
    for (let k = 0; k < 180; k++) { st.real += 1 / 60; assert.equal(b.update(st.real), rt, 'renderT does not move for 3 s'); }
    st.gt += 0.01;
    assert.equal(b.push(snap(st.gt, [U(1, st.gt, 10)]), st.real), true, 'a frame pushed while paused is accepted');
    assert.equal(b.update(st.real), rt);
    b.setPaused(false, st.real);
    const rts = live(b, st, 1.2);
    assert.ok(monotonic(rts, rt), 'renderT never steps back across the resume');
    const speed = (rts[rts.length - 1] - rts[35]) / ((rts.length - 36) / 60);   // from 0.6 s after the resume on
    assert.ok(near(speed, 2, 0.2), `back to normal speed (${speed} game s per s)`);
    assert.ok(near(rts[0] - rt, 2 / 60, 0.03), `the first frame after the resume is a normal one (${rts[0] - rt})`);
    assert.ok(near(b.rate, 2, 0.1), `the pause does not drag the rate estimate (${b.rate})`);
    assert.ok(near(b.newestT - b.renderT, 1, 0.1), `look-ahead after the pause ${b.newestT - b.renderT}`);
  });

  test('setPaused: survives reset(), is idempotent, and a pause call that comes late (React effect) still never steps back', () => {
    const b = new SnapshotBuffer({ lookAhead: 1, rate: 2 });
    assert.equal(b.setPaused(false, 1), false, 'resume without a pause is a no-op');
    b.setPaused(true, 2); b.setPaused(true, 5);
    b.reset();
    assert.ok(b.paused, 'a new battle entered while paused starts paused');
    b.push(snap(10, [U(1, 0, 0)]), 6); b.push(snap(10.1, [U(1, 0, 0)]), 6.05);
    const rt = b.update(7);
    assert.equal(b.update(9), rt, 'still frozen');
    b.setPaused(false, 9);   // paused since 2 s: the 7 s in between are not counted
    assert.ok(!b.paused);
    const after = b.update(9.016);
    assert.ok(after >= rt && after - rt < 0.1, `continues from where it stood (${rt} → ${after})`);
    // the sim stops 100 ms before the view hears of the pause and restarts 100 ms before the resume: no step back
    const c = new SnapshotBuffer({ lookAhead: 1, rate: 2 });
    const st = { real: 0, gt: 0 };
    live(c, st, 6);
    let prev = c.renderT;
    const step = (secs, push) => {
      for (let k = 0; k < Math.round(secs * 60); k++) {
        st.real += 1 / 60;
        if (push) { st.gt += 2 / 60; c.push(snap(st.gt, [U(1, st.gt, 10)]), st.real); }
        const r = c.update(st.real);
        assert.ok(r >= prev - EPS, `step back ${prev} → ${r}`);
        prev = r;
      }
    };
    step(0.1, false); c.setPaused(true, st.real); step(3, false); step(0.1, true); c.setPaused(false, st.real); step(2, true);
    assert.ok(near(c.newestT - c.renderT, 1, 0.15), `look-ahead after ${c.newestT - c.renderT}`);
  });

  test('an implicit stall (no setPaused: a network gap, a replay paused) never runs the clock backwards', () => {
    for (const gap of [0.3, 0.6, 1, 3]) {
      const b = new SnapshotBuffer({ lookAhead: 1, rate: 2 });
      const st = { real: 0, gt: 0 };
      live(b, st, 6);
      let prev = b.renderT;
      for (let k = 0; k < Math.round(gap * 60); k++) { st.real += 1 / 60; const r = b.update(st.real); assert.ok(r >= prev - EPS, `gap ${gap}: stalled step back`); prev = r; }
      if (gap >= 0.6) assert.equal(prev, b.newestT, 'a long stall is played out up to the newest frame');
      assert.ok(monotonic(live(b, st, 2), prev), `gap ${gap}: the first frames after the stall do not step back`);
    }
  });

  test('network jitter never stops the clock (the steering clamp only holds it where it stands; no hold hysteresis)', () => {
    for (const jit of [0.12, 0.2]) {
      let seed = 777;
      const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
      const arr = [];
      for (let k = 0; k < 20 * 30; k++) arr.push({ at: k / 20 + (rnd() - 0.5) * 2 * jit + 0.05, gt: (k + 1) * 0.1 });   // 20 Hz, 2 game s per s
      arr.sort((a, c) => a.at - c.at);
      const b = new SnapshotBuffer({ lookAhead: 1, rate: 2 });
      let ai = 0, prev = NaN, stopped = 0, back = 0;
      for (let i = 0; i < 60 * 30; i++) {
        const t = i / 60;
        while (ai < arr.length && arr[ai].at <= t) { b.push(snap(arr[ai].gt, [U(1, 0, 0)]), arr[ai].at); ai++; }
        const r = b.update(t);
        if (t > 3 && Number.isFinite(prev)) { if (r < prev - EPS) back++; if ((r - prev) * 60 < 0.05) stopped++; }
        prev = r;
      }
      assert.equal(back, 0, `±${jit * 1000} ms jitter: no step back`);
      assert.equal(stopped, 0, `±${jit * 1000} ms jitter: ${stopped} frames with the clock stopped`);
    }
  });

  test('a gap or a catch-up burst does not enter the rate window (the runner\'s 8 game s per frame pinned rate at its clamp)', () => {
    const b = new SnapshotBuffer({ lookAhead: 1, rate: 2, maxRate: 8 });
    const st = { real: 0, gt: 0 };
    live(b, st, 3);
    // a hidden display replica returns: 5 frames, each 8 game s (240 ticks) ahead
    for (let k = 0; k < 5; k++) { st.real += 1 / 60; st.gt += 8; b.push(snap(st.gt, [U(1, st.gt, 10)]), st.real); b.update(st.real); }
    assert.ok(near(b.rate, 2, 0.1), `rate after the burst ${b.rate}`);
    const rts = live(b, st, 2);
    assert.ok(near(b.rate, 2, 0.1), `rate after 2 s of live frames ${b.rate}`);
    assert.ok(near(rts.lags[rts.lags.length - 1], 1, 0.1), `look-ahead ${rts.lags[rts.lags.length - 1]}`);
    // a 3 s stall in the stream is not a game speed either
    st.real += 3;
    live(b, st, 1);
    assert.ok(near(b.rate, 2, 0.1), `rate after a 3 s gap ${b.rate}`);
  });

  test('lookAhead is in GAME seconds (wins over delay): lag 1 game s at 0.5× / 1× / 2× / 4×, delayReal = lag / rate', () => {
    for (const rate of [0.5, 1, 2, 4]) {
      const b = new SnapshotBuffer({ lookAhead: 1, rate, maxRate: Math.max(8, rate * 1.5), delay: 0.5 });
      const st = { real: 0, gt: 0 };
      const rts = live(b, st, 8, rate);
      for (const lag of rts.lags.slice(-30)) assert.ok(near(lag, 1, 0.2), `${rate}×: lag ${lag}`);
      assert.ok(near(b.rate, rate, 0.1 * rate), `${rate}×: rate ${b.rate}`);
      assert.ok(near(b.lag, 1, 1e-9), 'lag getter');
      assert.ok(near(b.delayReal, 1 / b.rate, 1e-9) && near(b.delayReal, 1 / rate, 0.15 / rate), `${rate}×: delayReal ${b.delayReal}`);
    }
    // the legacy real-second delay still works: lag = delay × rate
    const old = new SnapshotBuffer({ delay: 0.5, rate: 2 });
    assert.ok(near(old.lag, 1, 1e-9) && old.delayReal === 0.5);
    // a speed change while running (the replay's 1× → 4× → 0.5×) keeps the look-ahead in range and never rewinds noticeably
    const b = new SnapshotBuffer({ lookAhead: 1, rate: 1, maxRate: 8 });
    const st = { real: 0, gt: 0 };
    let all = live(b, st, 4, 1);
    all = all.concat(live(b, st, 4, 4), live(b, st, 6, 0.5));
    let back = 0;
    all.forEach((r, i) => { if (i && r < all[i - 1] - EPS) back += all[i - 1] - r; });
    assert.ok(back <= 0.1, `rewound ${back} game s in total`);
    assert.ok(near(b.newestT - b.renderT, 1, 0.3), `look-ahead at 0.5× ${b.newestT - b.renderT}`);
  });

  test('play-out pin (144 Hz display, a fixed game step per frame): the clock trails by ~lag during the feed and reaches the newest frame once it stops', () => {
    // browser tests (downelem, unitedown, elembar, forms) push 1/30 game s per animation frame and wait for
    // renderT >= newestT before they read what is drawn: that needs the play-out to the newest, exactly
    for (const opts of [{ lookAhead: 1 }, { delay: 0.5 }]) {
      const b = new SnapshotBuffer({ ...opts, rate: 2, maxRate: 8 });
      let real = 0, t = 0;
      for (let i = 0; i < 144 * 6; i++) {
        real += 0.0069; t += 1 / 30;
        b.push(snap(t, [U(1, t, 10)]), real);
        b.update(real);
        if (i > 144 * 3) assert.ok(Math.abs(b.newestT - b.renderT - b.lag) <= 0.2 * b.lag + 1e-9, `${JSON.stringify(opts)}: ${b.newestT - b.renderT} behind, lag ${b.lag} (rate ${b.rate})`);
      }
      assert.ok(b.rate > 4, `the test feed runs at ${b.rate} game s per s`);
      const stop = real, wait = b.delayReal + 6 * 0.0069;
      for (; real <= stop + wait; real += 0.0069) b.update(real);
      assert.equal(b.renderT, b.newestT, `${JSON.stringify(opts)}: played out to the newest frame ${wait.toFixed(3)} s after the feed stopped`);
    }
  });
});
