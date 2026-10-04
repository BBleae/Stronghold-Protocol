// test/match/runner-unseen.test.js — what the runner hands the view after a span it did not render (public/js/battle/runner.js
// hold / keepsState / handOver; review of the animation / effects PR, point 8: a status that ended while the tab was
// hidden left its aura and icon up to the end of the battle). The backlog keeps the state-bearing events in order with
// their game time; on top of that: 影哨 placed / recalled are kept, a skill START is not (the snapshot's SKILL flag turns a
// running skill on — replayed, it flashed its activation and played its voice long after), a status that is on and a
// 影哨 event come marked late (the view makes the lasting look the status names, no stale one-shot).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattleRunner, keepsState, handOver, isSentryFx } from '../../public/js/battle/runner.js';
import { createStore, initialState } from '../../public/js/store.js';
import * as specMod from '../../server/sim/spec.js';
import { makeBattle } from '../helpers/battleHarness.js';

test('keepsState / handOver: state kinds, form fx and 影哨 are kept; a status that is on and a 影哨 event come marked late', () => {
  const sentry = ['fx', 'sentry', 6, 10, { id: 9 }], recall = ['fx', 'sentryRecall', 6, 10, { id: 9, tx: 5, ty: 10 }];
  for (const x of [['spawn', { id: 1 }], ['die', 1], ['deploy', 1], ['status', 1, 'a', 1], ['skill', 1, 0], ['leak', 2], sentry, recall]) assert.ok(keepsState(x), JSON.stringify(x));
  for (const x of [['atk', 1, 2, 'none'], ['dmg', 2, 5, 'phys'], ['heal', 1, 3], ['fx', 'burst', 1, 1, { id: 1 }], ['fx', 'sentry', 1, 1, null]]) assert.ok(!keepsState(x), JSON.stringify(x));
  assert.ok(isSentryFx(recall) && !isSentryFx(['fx', 'sentry', 1, 1, {}]));
  assert.deepEqual(handOver(['status', 1, 'lemuen:wanted', 1]), ['status', 1, 'lemuen:wanted', 1, 'late']);
  const off = ['status', 1, 'a', 0];
  assert.equal(handOver(off), off, 'an off is handed over as it is');
  const s = handOver(sentry);
  assert.deepEqual(s[4], { id: 9, late: true });
  assert.notEqual(s[4], sentry[4], 'a copy: the sim\'s tuple is untouched');
  const sk = ['skill', 1, 0];
  assert.equal(handOver(sk), sk);
});

const POS = [[10, 4], [10, 5], [10, 6], [10, 7], [11, 4], [11, 5], [11, 6], [11, 7], [9, 5], [12, 5]];
const TEAM = ['chess_char_6_03_a', 'chess_char_1_06_a', 'chess_char_4_17_a', 'chess_char_4_22_a', 'chess_char_4_25_a', 'chess_char_4_04_a', 'chess_char_6_02_a', 'chess_char_6_18_a', 'chess_char_6_16_a', 'chess_char_6_08_a'];
/** A real sim battle: ten operators against a stream of enemies (statuses, skills, spawns all through it). */
const makeHarness = () => makeBattle({
  units: TEAM.map((chessId, i) => ({ chessId, row: POS[i][0], col: POS[i][1] })),
  enemies: Array.from({ length: 40 }, (_, i) => ({ key: 'enemy_1402_tgshd_2', time: 2 + i * 1.5, route: i % 2 })),
  seed: 3, timeLimit: 120,
});

/** The real runner on that battle ('b1'; a second copy for 'b2') behind a fake net / manual clock / manual frames. */
async function rig() {
  const h = makeHarness(), h2 = makeHarness();
  let t = 1000;
  const frames = [], intervals = [];
  const doc = { hidden: false, addEventListener() {} };
  const net = {
    sent: [], handlers: new Map(),
    on(tt, fn) { if (!this.handlers.has(tt)) this.handlers.set(tt, new Set()); this.handlers.get(tt).add(fn); return () => this.handlers.get(tt).delete(fn); },
    emit(tt, m) { for (const fn of this.handlers.get(tt) || []) fn({ t: tt, ...m }); },
    send(tt, f) { this.sent.push({ ...f, t: tt }); return true; },
    request(tt, f) { this.sent.push({ ...f, t: tt }); return Promise.resolve({ t: 'ok' }); },
  };
  const store = createStore(initialState);
  const runner = createBattleRunner({
    net, store, doc, now: () => t, raf: (fn) => { frames.push(fn); return frames.length; }, caf: () => {},
    setInterval: (fn) => { intervals.push(fn); return intervals.length; }, clearInterval: () => {},
    loadSim: async () => ({ spec: { ...specMod, createBattleFromSpec: (spec) => (spec.battleId === 'b2' ? h2.b : h.b) }, ds: null }),
    logger: { error() {}, warn() {}, info() {}, debug() {} },
  });
  const feed = { snaps: [], evs: [], log: [] };
  runner.on('snap', (x) => { feed.snaps.push(x); feed.log.push(['snap', x.fieldId]); });
  runner.on('ev', (x) => { feed.evs.push(x); feed.log.push(['ev', x.fieldId]); });
  runner.on('field', (x) => { feed.log.push(['field', x.fieldId]); });
  const settle = async () => { for (let i = 0; i < 50; i++) { await new Promise((res) => setImmediate(res)); for (const fn of frames.splice(0)) fn(t); } };
  return {
    runner, h, doc, net, feed, settle,
    get t() { return t; },
    advance(ms, step = 1000 / 60) {
      const end = t + ms;
      while (t < end) {
        t = Math.min(end, t + step);
        if (doc.hidden) { for (const fn of intervals) fn(); continue; }
        for (const fn of frames.splice(0)) fn(t);
      }
    },
    /** b.start of 'b1' (authoritative) or 'b2' (a display replica), `elapsed` game s in */
    start(id = 'b1', o = {}) {
      const spec = { fieldId: id === 'b1' ? 'f1' : 'f2', kind: 'normal', players: [{ playerId: 'p1' }], battleId: id };
      net.emit('b.start', { battleId: id, fieldId: spec.fieldId, kind: 'normal', spec, authoritative: id === 'b1', speed: 2, elapsed: 0, ...o });
      return settle();
    },
    entry(id = 'b1') { return runner._entries.get(id); },
  };
}

/** The events of a reference run of the same battle, by tick: ref[n] = what tick n emitted (ref[0] unused). */
function referenceTicks(n) {
  const h = makeHarness();
  const out = [null];
  for (let i = 0; i < n; i++) { h.b.step(); out.push(h.b.drainEvents()); }
  return out;
}

test('hidden tab: the first frames back hand over the state events of the hidden span — no one-shots, no skill starts, statuses that are on marked late', async () => {
  const r = await rig();
  await r.start();
  r.advance(20000);                                   // 20 real s = 40 game s on screen
  const e = r.entry();
  const hideTick = e.battle.tickCount;
  const nSnaps = r.feed.snaps.length, nEvs = r.feed.evs.length;
  r.doc.hidden = true;
  r.advance(20000, 250);                              // 20 real s hidden: the 250 ms pump keeps the battle on its clock
  const returnTick = e.battle.tickCount;
  assert.ok(returnTick - hideTick >= 1100, `pumped while hidden (${returnTick - hideTick} ticks)`);
  assert.equal(r.feed.snaps.length, nSnaps, 'no snapshot while hidden');
  assert.equal(r.feed.evs.length, nEvs, 'no event batch while hidden');
  r.doc.hidden = false;
  r.advance(100);
  const firstSnap = r.feed.snaps[nSnaps];
  assert.ok(firstSnap, 'the first frame back');
  // the batches before the first snapshot back: the backlog (each with its own game time, before the snapshot's)
  const back = r.feed.evs.slice(nEvs).filter((b) => b.gt < firstSnap.gt - 1e-9).flatMap((b) => b.ev);
  const win = referenceTicks(returnTick).slice(hideTick + 1, returnTick + 1).flat();
  assert.ok(back.length > 0 && win.length > back.length, `a backlog (${back.length} of ${win.length} events)`);
  assert.ok(back.every((x) => keepsState(x)), 'no stale one-shot (atk / dmg / heal / other fx)');
  assert.ok(back.every((x) => x[0] !== 'skill' || !x[2]), 'no skill START (its activation flash / voice)');
  assert.ok(back.every((x) => x[0] !== 'status' || (x[3] ? x[4] === 'late' : x.length === 4)), 'a status that is on is marked late');
  const lastOf = (list) => { const m = new Map(); for (const x of list) if (x[0] === 'status') m.set(`${x[1]}|${x[2]}`, !!x[3]); return m; };
  assert.deepEqual([...lastOf(back)].sort(), [...lastOf(win)].sort(), 'the view ends with the sim\'s last status of every (unit, key)');
  assert.ok([...lastOf(win).values()].some((on) => !on), 'some status ended in the dark (what used to leave a stuck aura)');
  r.runner.dispose();
});

test('影哨 placed / recalled while hidden reach the view marked late (a recall must end what the view still draws); other fx do not', async () => {
  const r = await rig();
  await r.start();
  r.advance(2000);
  const nEvs = r.feed.evs.length;
  r.doc.hidden = true;
  const sentry = (id) => r.h.b.fx('sentry', { x: 6, y: 10, id });
  const recall = (id) => r.h.b.fx('sentryRecall', { x: 6, y: 10, tx: 5, ty: 10, id });
  sentry(901); r.advance(1000, 250);
  recall(901); sentry(902); r.advance(1000, 250);
  r.h.b.fx('burst', { x: 3, y: 3, id: 901 });
  r.advance(1000, 250);
  assert.equal(r.feed.evs.length, nEvs);
  r.doc.hidden = false;
  r.advance(100);
  const fx = r.feed.evs.slice(nEvs).flatMap((b) => b.ev).filter((x) => x[0] === 'fx' && x[4]?.late);
  assert.deepEqual(fx.map((x) => `${x[1]}:${x[4].id}`), ['sentry:901', 'sentryRecall:901', 'sentry:902'], 'in order, marked late; no burst');
  r.runner.dispose();
});

test('a 影哨 inside a catch-up frame is kept among its state events (the other fx are not), marked late', async () => {
  const r = await rig();
  await r.start();
  r.advance(1000);
  const nEvs = r.feed.evs.length;
  r.doc.hidden = true;
  r.advance(30000, 15000);
  r.doc.hidden = false;
  r.h.b.fx('sentry', { x: 6, y: 10, id: 905 });
  r.h.b.fx('burst', { x: 3, y: 3, id: 905 });
  r.advance(20);
  const fx = r.feed.evs.slice(nEvs).flatMap((b) => b.ev).filter((x) => x[0] === 'fx' && (x[4]?.id === 905));
  assert.deepEqual(fx.map((x) => [x[1], !!x[4].late]), [['sentry', true]], 'the catch-up frame filters fx down to the 影哨');
  r.runner.dispose();
});

test('end to end (real runner → real FxSystem): after a hidden stretch no status-bound record or status icon outlives its status', async () => {
  const { installFakePixi, fakeViewCtx } = await import('../render/fakepixi.js');
  const { presetCamera } = await import('../../public/js/render/projection.js');
  const fake = installFakePixi();
  try {
    const FX = await import('../../public/js/render/fx.js');
    const r = await rig();
    const views = new Map();
    const P = fake.P, ctx = fakeViewCtx(P);
    const cam = presetCamera('normal', { width: 1600, height: 900 });
    const fx = new FX.FxSystem({
      P, layers: ctx.layers, cam: () => cam, heightAt: () => 0, settings: { quality: 'high', damageNumbers: true }, timeScale: () => 2, loadLevel: () => 0,
      subProfOf: () => null, view: (id) => views.get(id) || null, screenSize: () => ({ width: 1600, height: 900 }), fieldTop: () => 120, fieldRect: () => ({ r0: 9, r1: 12, c0: 2, c1: 10 }),
    });
    // render/app.js handleEvent for the state-bearing kinds (a status reaches the unit before fx.status)
    const handle = (e) => {
      if (e[0] === 'spawn') { if (!views.has(e[1].id)) views.set(e[1].id, { id: e[1].id, x: e[1].x, y: e[1].y, z: 0, hover: 0, _headTiles: 1.2, alive: true, destroyed: false, statuses: new Set(), info: e[1], dir: e[1].dir, onHit() {} }); }
      else if (e[0] === 'skill') { const v = views.get(e[1]); if (v) { if (e[2]) v.statuses.add('skill'); else v.statuses.delete('skill'); fx.skill(v, !!e[2]); } }
      else if (e[0] === 'status') { const v = views.get(e[1]); if (v) { if (e[3]) v.statuses.add(e[2]); else v.statuses.delete(e[2]); fx.status(v, e[2], !!e[3], e[4] === 'late'); } }
      else if (e[0] === 'die') { const v = views.get(e[1]); if (v && v.alive) { v.alive = false; fx.death(v); } }
      else if (e[0] === 'fx') fx.simFx(e[1], Number(e[2]), Number(e[3]), e[4]);
    };
    r.runner.on('ev', (m) => { for (const e of m.ev) handle(e); });
    r.runner.on('snap', () => { for (let i = 0; i < 4; i++) fx.update(1 / 60); });

    await r.start();
    r.advance(10000);
    r.doc.hidden = true;
    r.advance(30000, 250);                             // 60 game s unseen
    r.doc.hidden = false;
    r.advance(2000);
    const e = r.entry();
    // the truth: the last status event of every (unit, key) of the whole battle so far
    const truth = new Map();
    for (const ev of referenceTicks(e.battle.tickCount).slice(1).flat()) if (ev[0] === 'status') truth.set(`${ev[1]}|${ev[2]}`, !!ev[3]);
    const alive = (id) => !!e.battle.unitById(id)?.alive;
    const staleIcons = [], stuckRecords = [];
    for (const [id, v] of views) {
      if (!alive(id)) continue;
      for (const k of v.statuses) if (k !== 'skill' && truth.get(`${id}|${k}`) !== true) staleIcons.push(`${id}:${k}`);
      for (const [k, on] of truth) if (on && k.startsWith(`${id}|`) && !v.statuses.has(k.slice(String(id).length + 1))) staleIcons.push(`missing ${k}`);
    }
    for (const [name, S] of fx.sustains) {
      if (S.end || S.until !== 'status' || !alive(S.anchor)) continue;
      if (![...S.bind].some((k) => truth.get(`${S.anchor}|${k}`) === true)) stuckRecords.push(`${name}[${[...S.bind]}]`);
    }
    assert.deepEqual(staleIcons, [], 'every live unit\'s status set equals the sim\'s');
    assert.deepEqual(stuckRecords, [], 'no status-bound record whose statuses are all off');
    assert.ok([...truth.values()].some((on) => !on), 'the battle did end statuses (not a vacuous check)');
    r.runner.dispose();
  } finally { fake.restore(); }
});
