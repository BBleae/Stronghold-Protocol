// test/render/fxsustain-batching.test.js — the lifetime of a lasting unit-state effect (render/fxsustain.js _policy) must
// not depend on how the events happened to be batched: a render frame holds ~1 sim tick of a local battle, 3+ of a
// server one (one b.ev) and a whole hidden-tab / mid-battle catch-up; the same match must show the same auras in all of
// them (review of the upstream PR, point c: 29 % of one match's 暴露 reticles were missing). Also pins the 余 fire wall's
// single geometry (point f) and that every status hint of a SUSTAINED kind names a status the sim really has.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { installFakePixi, fakeViewCtx } from './fakepixi.js';
import { presetCamera } from '../../public/js/render/projection.js';
import { SUSTAINED } from '../../public/js/render/fxsustain.js';
import { STATUS } from '../../server/sim/buffs.js';

let fake, FX;
before(async () => { fake = installFakePixi(); FX = await import('../../public/js/render/fx.js'); });
after(() => fake.restore());
const cam = presetCamera('normal', { width: 1600, height: 900 });

/** A FxSystem + the app.js handleEvent semantics for spawn / skill / status / fx (a unit's statuses are set BEFORE fx.status). */
function rig() {
  const P = fake.P, ctx = fakeViewCtx(P), views = new Map();
  const fx = new FX.FxSystem({
    P, layers: ctx.layers, cam: () => cam, heightAt: () => 0, settings: { quality: 'high', damageNumbers: true }, timeScale: () => 2, loadLevel: () => 0,
    subProfOf: () => null, view: (id) => views.get(id) || null, screenSize: () => ({ width: 1600, height: 900 }), fieldTop: () => 120,
    fieldRect: () => ({ r0: 9, r1: 12, c0: 2, c1: 10 }),
  });
  const handle = (e) => {
    if (e[0] === 'spawn') views.set(e[1].id, { id: e[1].id, x: e[1].x, y: e[1].y, z: 0, hover: 0, _headTiles: 1.2, alive: true, destroyed: false, statuses: new Set(), info: e[1], dir: e[1].dir, onHit() {} });
    else if (e[0] === 'skill') { const v = views.get(e[1]); if (e[2]) v.statuses.add('skill'); else v.statuses.delete('skill'); fx.skill(v, !!e[2]); }
    else if (e[0] === 'status') { const v = views.get(e[1]); if (e[3]) v.statuses.add(e[2]); else v.statuses.delete(e[2]); fx.status(v, e[2], !!e[3], e[4] === 'late'); }
    else if (e[0] === 'fx') fx.simFx(e[1], Number(e[2]), Number(e[3]), e[4]);
  };
  /** one render frame = one batch */
  const frame = (evs = []) => { for (const e of evs) handle(e); for (let i = 0; i < 4; i++) fx.update(1 / 60); };
  const alive = () => [...fx.sustains].filter(([, S]) => !S.end).map(([k, S]) => `${k}(${S.until})`).sort();
  return { fx, views, frame, alive };
}
const OP = ['spawn', { id: 1, side: 'ally', kind: 'op', x: 5, y: 10, dir: 'RIGHT' }];
const EXPOSE = ['fx', 'expose', 5, 10, { id: 1 }];

test('a status-bound record is only refreshed by a later fx of the same kind, whatever else the batch holds', () => {
  // (a) a skill that starts in the batch of the refresh must not turn the record into a skill-bound one
  const r = rig();
  r.frame([OP]); r.frame([['status', 1, 'ab:exposed', 1], EXPOSE]);
  r.frame([['skill', 1, 1], EXPOSE]);
  assert.deepEqual(r.alive(), ['expose:1(status)']);
  r.frame([['status', 1, 'ab:exposed', 0]]);
  assert.deepEqual(r.alive(), [], 'ends with its status, not with the skill');
  // (b) an unrelated status lost in the batch of the refresh is not "a use"
  const r2 = rig();
  r2.frame([OP]); r2.frame([['status', 1, 'ab:exposed', 1], ['status', 1, 'other', 1], EXPOSE]);
  r2.frame([['status', 1, 'other', 0], EXPOSE]);
  assert.deepEqual(r2.alive(), ['expose:1(status)']);
});

test('a kind that names its status binds only to it (an unrelated status gained in the same batch must not hold the record)', () => {
  const r = rig();
  r.frame([OP]); r.frame([['status', 1, 'blkkgt:slashes', 1], ['status', 1, 'ab:exposed', 1], EXPOSE]);
  r.frame([['status', 1, 'ab:exposed', 0]]);
  assert.deepEqual(r.alive(), [], 'gone with ab:exposed although blkkgt:slashes is still on');
});

test('a status gained and lost inside one batch (雷蛇 block used at once) leaves nothing behind, for any batch size', () => {
  const evs = [['skill', 1, 1], ['status', 1, 'liskam:block', 1], ['fx', 'shield', 5, 10, { id: 1 }], ['status', 1, 'liskam:block', 0], ['fx', 'shield', 5, 10, { id: 1 }]];
  const one = rig(); one.frame([OP]); one.frame(evs);
  assert.deepEqual(one.alive(), [], 'one batch');
  const per = rig(); per.frame([OP]); for (const e of evs) per.frame([e]);
  assert.deepEqual(per.alive(), [], 'one event per batch');
});

test('a status the fx came with ending in the same batch is a use; an unrelated one ending is not', () => {
  const r = rig();
  r.frame([OP, ['skill', 1, 1], ['status', 1, 'liskam:block', 1], ['fx', 'shield', 5, 10, { id: 1 }]]);
  assert.deepEqual(r.alive(), ['shield:1(status)']);
  r.frame([['status', 1, 'liskam:block', 0], ['fx', 'shield', 5, 10, { id: 1 }]]);
  assert.deepEqual(r.alive(), [], 'its own status ended and the fx went off again: used up');
});

test('state-aware revive: an expose / wanted / reveal fx while its status is on re-binds a lost record; ended with the status', () => {
  for (const [kind, status] of [['expose', 'ab:exposed'], ['wanted', 'lemuen:wanted'], ['reveal', 'reveal']]) {
    const r = rig();
    r.frame([OP, ['status', 1, status, 1]]);                       // (the status arrived without its fx: a hand-over, a hidden tab)
    assert.deepEqual(r.alive(), [], `${kind}: nothing drawn yet`);
    r.frame([['fx', kind, 5, 10, { id: 1 }]]);                     // the sim re-announces it (expose: on every re-application)
    assert.deepEqual(r.alive(), [`${kind}:1(status)`], `${kind}: revived`);
    r.frame([['status', 1, status, 0]]);
    assert.deepEqual(r.alive(), [], `${kind}: ends with ${status}`);
  }
  // no hinted status on the unit: a stray fx draws nothing lasting
  const r = rig();
  r.frame([OP, EXPOSE]);
  assert.deepEqual(r.alive(), []);
});

test('a skill that starts together with the refresh no longer replaces a live status record (the real sim sequence, one tick)', () => {
  // server/sim: at one tick 银灰-style ['skill', id, 1], the expose refresh fx and ['skill', id, 0] came in a single batch
  const r = rig();
  r.frame([OP, ['status', 1, 'ab:exposed', 1], EXPOSE]);
  r.frame([['skill', 1, 1], EXPOSE, EXPOSE, ['skill', 1, 0]]);
  assert.deepEqual(r.alive(), ['expose:1(status)']);
  for (let i = 0; i < 5; i++) r.frame([EXPOSE]);                    // every later refresh keeps it
  assert.deepEqual(r.alive(), ['expose:1(status)']);
});

test('replaying a whole history as ONE batch (hidden tab / mid-battle entry) gives the live stream\'s records', () => {
  // the sim emits a status and the fx that goes with it in the same tick: one array per tick
  const ticks = [[OP], [['status', 1, 'inspire:hp', 1]], [['status', 1, 'ab:exposed', 1], EXPOSE], [EXPOSE], [['status', 1, 'ab:exposed', 0]],
    [['status', 1, 'ab:exposed', 1], EXPOSE], [['skill', 1, 1], ['fx', 'truesilver', 5, 10, { id: 1 }]], [EXPOSE]];
  const live = rig(); for (const t of ticks) live.frame(t);
  const replay = rig(); replay.frame(ticks.flat());
  assert.deepEqual(live.alive(), ['expose:1(status)', 'truesilver:1(skill)'], 'the live stream');
  assert.deepEqual(replay.alive(), live.alive());
  // and both end together (the skill, then the exposure)
  for (const R of [live, replay]) { R.frame([['skill', 1, 0]]); assert.deepEqual(R.alive(), ['expose:1(status)']); R.frame([['status', 1, 'ab:exposed', 0]]); assert.deepEqual(R.alive(), []); }
});

test('the same history grouped into batches of 1 / 2 / 3 / 6 ticks (any phase) leaves the same records', () => {
  const OP2 = ['spawn', { id: 2, side: 'ally', kind: 'op', x: 6, y: 10, dir: 'RIGHT' }];
  const ticks = [
    [OP, OP2], [], [['status', 1, 'ab:exposed', 1], EXPOSE], [], [],
    [['skill', 2, 1], ['fx', 'truesilver', 6, 10, { id: 2 }]], [], [['status', 2, 'vendla:taunt', 1], ['fx', 'taunt', 6, 10, { id: 2 }]],
    [], [EXPOSE], [], [['status', 1, 'liskam:block', 1], ['fx', 'shield', 5, 10, { id: 1 }]], [], [],
    [['status', 1, 'ab:exposed', 0]], [], [['skill', 2, 0]], [['status', 1, 'ab:exposed', 1], EXPOSE], [], [],
    [['status', 2, 'vendla:taunt', 0]], [EXPOSE], [], [['status', 1, 'liskam:block', 0]], [], [],
    [['skill', 1, 1], EXPOSE, ['skill', 1, 0]], [], [['status', 2, 'y:blip', 1], ['status', 2, 'y:blip', 0], ['status', 1, 'z:other', 1]], [EXPOSE], [['status', 1, 'z:other', 0]], [EXPOSE], [], [],
  ];
  const run = (n, phase) => {
    const r = rig();
    const sizes = []; if (phase) sizes.push(phase);
    for (let i = phase; i < ticks.length; i += n) sizes.push(Math.min(n, ticks.length - i));
    let at = 0;
    for (const sz of sizes) { r.frame(ticks.slice(at, at + sz).flat()); at += sz; }
    return r.alive();
  };
  const want = run(1, 0);
  assert.deepEqual(want, ['expose:1(status)'], 'the per-tick (local battle) result');
  for (const n of [2, 3, 6]) for (let phase = 0; phase < Math.min(n, 3); phase++) assert.deepEqual(run(n, phase), want, `${n} ticks per batch, phase ${phase}`);
  assert.deepEqual(run(ticks.length, 0), want, 'all at once');
});

test('Sustains._aura: a status gained before an fx belongs to that fx, not to a later fx of the same batch (bOn.delete)', () => {
  // one status gained, two different aura kinds announced after it: only the first binds to it; the second has neither
  // a status, a duration nor a skill start of its own → a one-off. Pinned because a future kit that emits two aura kinds
  // after ONE status-on would lose the second bind (the static scan of the sim finds none today).
  const r = rig();
  r.frame([OP, ['status', 1, 'x:buff', 1], ['fx', 'shield', 5, 10, { id: 1 }], ['fx', 'taunt', 5, 10, { id: 1 }]]);
  assert.deepEqual(r.alive(), ['shield:1(status)']);
  const r2 = rig();
  r2.frame([OP, ['status', 1, 'x:buff', 1], ['fx', 'taunt', 5, 10, { id: 1 }], ['fx', 'shield', 5, 10, { id: 1 }]]);
  assert.deepEqual(r2.alive(), ['taunt:1(status)']);
  // another unit's status in the same batch is not touched
  const r3 = rig();
  r3.frame([OP, ['spawn', { id: 2, side: 'ally', kind: 'op', x: 6, y: 10, dir: 'RIGHT' }], ['status', 1, 'a', 1], ['status', 2, 'b', 1], ['fx', 'shield', 5, 10, { id: 1 }], ['fx', 'shield', 6, 10, { id: 2 }]]);
  assert.deepEqual(r3.alive(), ['shield:1(status)', 'shield:2(status)']);
});

test('余 fire wall: ONE geometry — the held line on the tile edge in front of him; no tile column / disc one-shot on his own tile', () => {
  const r = rig();
  const flashes = [], zones = [];
  const tf = r.fx.tileFlash.bind(r.fx), zn = r.fx.zone.bind(r.fx);
  r.fx.tileFlash = (...a) => { flashes.push(a[0]); return tf(...a); };
  r.fx.zone = (...a) => { zones.push(a); return zn(...a); };
  r.frame([OP, ['skill', 1, 1], ['fx', 'firewall', 5, 10, { id: 1, dir: 'RIGHT', axis: 'col', x: 5, y: 10 }]]);
  assert.deepEqual(r.fx.sustains.get('firewall:1').line, { axis: 'col', at: 5.5, fixed: 5 });
  assert.equal(flashes.length, 0, 'no one-shot tile flash of the column through his tile');
  assert.equal(zones.length, 0, 'no one-shot disc on him');
  // a refresh (a re-cast) is the same wall and still no one-shot
  r.frame([['fx', 'firewall', 5, 10, { id: 1, dir: 'RIGHT', axis: 'col', x: 5, y: 10 }]]);
  assert.equal(flashes.length + zones.length, 0);
});

test('余 fire wall without a held record (his skill is not on / unknown unit): the one-shot tile column is the fallback', () => {
  const r = rig();
  const flashes = [];
  const tf = r.fx.tileFlash.bind(r.fx);
  r.fx.tileFlash = (...a) => { flashes.push(a[0]); return tf(...a); };
  r.frame([OP, ['fx', 'firewall', 5, 10, { id: 1, dir: 'RIGHT', axis: 'col', x: 5, y: 10 }]]);   // a stray event: no skill running
  assert.equal(r.fx.sustains.size, 0);
  assert.equal(flashes.length, 1, 'flashed');
  r.frame([['fx', 'firewall', 5, 10, { id: 99, dir: 'RIGHT', axis: 'col', x: 5, y: 10 }]]);       // no such unit
  assert.equal(flashes.length, 2);
});

test('魔王\'s mote in a long frame: bound to its own status, not to one the unit gained a few ticks earlier (review of the review fixes)', () => {
  // the sim: inspire on at tick 10 (no aura of its own), cetsyr:mote on + fx mote at tick 15 — one frame of 6+ ticks
  const r = rig();
  r.frame([OP]);
  r.frame([['status', 1, 'inspire', 1], ['status', 1, 'cetsyr:mote', 1], ['fx', 'mote', 5, 10, { id: 1 }]]);
  assert.deepEqual([...r.fx.sustains.get('mote:1').bind], ['cetsyr:mote']);
  r.frame([['status', 1, 'cetsyr:mote', 0]]);
  assert.deepEqual(r.alive(), [], 'ends with the mote, while inspire is still on');
  // the talent's per-caster key is under the same prefix
  const r2 = rig();
  r2.frame([OP]);
  r2.frame([['status', 1, 'inspire', 1], ['status', 1, 'cetsyr:mote:7', 1], ['fx', 'mote', 5, 10, { id: 1 }]]);
  assert.deepEqual([...r2.fx.sustains.get('mote:1').bind], ['cetsyr:mote:7']);
  // an unhinted dynamic key still binds as before (no hinted status gained or on)
  const r3 = rig();
  r3.frame([OP]);
  r3.frame([['status', 1, 'kit:taunt:3', 1], ['fx', 'taunt', 5, 10, { id: 1 }]]);
  assert.deepEqual([...r3.fx.sustains.get('taunt:1').bind], ['kit:taunt:3']);
});

test('a status handed over after a hidden span (marked late) makes the look its unreplayed fx made: wanted is announced once only', () => {
  const r = rig();
  r.frame([OP]);
  r.frame([['status', 1, 'lemuen:wanted', 1, 'late'], ['status', 1, 'inspire', 1, 'late']]);
  assert.deepEqual(r.alive(), ['wanted:1(status)']);
  r.frame([['status', 1, 'lemuen:wanted', 0]]);
  assert.deepEqual(r.alive(), []);
  // not late (the sim's own status event, its fx follows or never comes): no record from the status alone
  const r2 = rig();
  r2.frame([OP]);
  r2.frame([['status', 1, 'reveal', 1]]);
  assert.deepEqual(r2.alive(), []);
});

test('影哨 handed over late: its record only — no summon pillar, no recall streak', () => {
  const r = rig();
  r.frame([OP]);
  const parts = () => r.fx.counts.particles + r.fx.counts.rings;
  const p0 = parts();
  r.frame([['fx', 'sentry', 7, 10, { id: 1, x: 7, y: 10, late: true }]]);
  assert.deepEqual(r.alive(), ['sentry:1(manual)']);
  assert.equal(parts(), p0, 'no one-shot look');
  r.frame([['fx', 'sentryRecall', 7, 10, { id: 1, tx: 5, ty: 10, late: true }]]);
  assert.deepEqual(r.alive(), []);
  assert.equal(parts(), p0, 'no recall streak');
});

test('a retained older rules version\'s 影哨 recall (a plain beam to 伊内丝) ends the held sentry', () => {
  const r = rig();
  r.frame([OP]);
  r.frame([['fx', 'sentry', 7, 10, { id: 1, x: 7, y: 10 }]]);
  assert.deepEqual(r.alive(), ['sentry:1(manual)']);
  r.frame([['fx', 'beam', 7, 10, { x: 7, y: 10, tx: 5, ty: 10, id: 1 }]]);
  assert.deepEqual(r.alive(), []);
  // an ordinary beam (from / to) is not taken for it
  r.frame([['fx', 'sentry', 7, 10, { id: 1, x: 7, y: 10 }], ['fx', 'beam', 7, 10, { from: 1, to: 2, tx: 5, ty: 10, id: 1 }]]);
  assert.deepEqual(r.alive(), ['sentry:1(manual)']);
});

test('every status hint of a SUSTAINED kind names a status the sim has (so a rename cannot rot it)', () => {
  const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : []; });
  const src = walk('server/sim').map((p) => readFileSync(p, 'utf8')).join('\n');
  const hinted = Object.entries(SUSTAINED).filter(([, s]) => s.status);
  const list = hinted.flatMap(([k, s]) => (Array.isArray(s.status) ? s.status : [s.status]).map((h) => `${k}:${h}`)).sort();
  assert.deepEqual(list, ['bloodBattle:horn:bloodBattle', 'buff:talent:angel_bless_ally', 'catShield:cathy:shield', 'devour:billro:s3atk', 'ember:ab:ember', 'ember:reed2:fireball',
    'expose:ab:exposed', 'mote:cetsyr:mote', 'overload:horn:overload', 'overload:rockr:overload', 'reveal:reveal', 'shell:billro:s1guard', 'shield:gravel:rats', 'shield:rmixer:shield',
    'shield:talent:archet_shield', 'taunt:vendla:taunt', 'undying:nearl2:stand', 'wanted:lemuen:wanted'], 'the hinted kinds (add a new one to this list on purpose)');
  for (const [kind, spec] of hinted) {
    for (const h of Array.isArray(spec.status) ? spec.status : [spec.status]) {
      // the status exists: a catalogue STATUS (applyStatus), a buff key the sim adds, or a key prefix (`h:…`)
      const known = Object.hasOwn(STATUS, h) || src.includes(`'${h}'`) || src.includes(`\`${h}:`);
      assert.ok(known, `${kind}: status '${h}' is in server/sim (buffs.js STATUS, a buff key or a key prefix)`);
    }
    // ... and the sim emits the fx of that kind
    assert.ok(new RegExp(`fx\\(\\s*'${kind}'`).test(src), `${kind}: the sim emits fx '${kind}'`);
  }
});
