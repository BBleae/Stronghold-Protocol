// test/render/fxsustain.test.js — skill-long effects (render/fx.js SUSTAINED). User report: 余's S3 灶里乾坤 fire wall
// showed for ~2 s of a 41 s skill; the official wall burns for the whole skill on the tile edge in front of him, across
// the field. The sim emits fx 'firewall' once at the skill's start (server/sim/content/kits/tier6.js); the renderer holds
// it until the caster's skill ends ('skill' off → fx.skill(view, false)), it dies, or the view clears. Same for the
// skill-long fields (tide, healField, coldWind, snow) centred on their caster.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePixi, fakeViewCtx } from './fakepixi.js';
import { presetCamera } from '../../public/js/render/projection.js';

let fake, FX;
before(async () => {
  fake = installFakePixi();
  FX = await import('../../public/js/render/fx.js');
});
after(() => fake.restore());

const DT = 1 / 60;
const cam = presetCamera('normal', { width: 1600, height: 900 });
const unit = (id, x, y, o = {}) => ({ id, x, y, z: 0, hover: 0, _headTiles: 1.2, alive: true, destroyed: false, statuses: new Set(['skill']), info: { defId: 'x' }, onHit() {}, ...o });

function makeFx(views) {
  const P = fake.P;
  const ctx = fakeViewCtx(P);
  const map = new Map(views.map((v) => [v.id, v]));
  const fx = new FX.FxSystem({
    P, layers: ctx.layers, cam: () => cam, heightAt: () => 0, settings: { quality: 'high', damageNumbers: true },
    timeScale: () => 2, loadLevel: () => 0, subProfOf: () => null, view: (id) => map.get(id) || null,
    screenSize: () => ({ width: 1600, height: 900 }), fieldTop: () => 120, fieldRect: () => ({ r0: 9, r1: 12, c0: 2, c1: 10 }),
  });
  return fx;
}
const run = (fx, seconds) => { for (let t = 0; t < seconds - 1e-9; t += DT) fx.update(DT); };

describe('余 S3 灶里乾坤: the fire wall burns for the whole skill', () => {
  test('the line: 0.5 tile in front of him, across the field, perpendicular to his direction', () => {
    assert.deepEqual(FX.wallLine(5, 10, 'col', 'RIGHT'), { axis: 'col', at: 5.5, fixed: 5 });
    assert.deepEqual(FX.wallLine(5, 10, 'col', 'LEFT'), { axis: 'col', at: 4.5, fixed: 5 });
    assert.deepEqual(FX.wallLine(5, 10, 'row', 'UP'), { axis: 'row', at: 10.5, fixed: 10 });
  });

  test('held while the skill runs (well past the old 2 s flash), gone after skill off', () => {
    const yu = unit(7, 5, 10, { dir: 'RIGHT' });
    const fx = makeFx([yu]);
    fx.simFx('firewall', 5, 10, { x: 5, y: 10, id: 7, dir: 'RIGHT', axis: 'col' });
    const S = fx.sustains.get('firewall:7');
    assert.ok(S, 'registered');
    assert.deepEqual(S.span, [9, 12], 'across the field rows');
    run(fx, 15);
    assert.ok(fx.sustains.has('firewall:7') && S.a === 1, '15 s later still burning at full strength');
    assert.ok(fx.counts.particles > 0, 'flames rise along it');
    fx.skill(yu, false);
    run(fx, 0.6);
    assert.equal(fx.sustains.size, 0, 'skill off: faded out');
  });

  test('ends when the caster dies or the view clears; a re-cast refreshes the same wall', () => {
    const yu = unit(7, 5, 10, { dir: 'RIGHT' });
    const fx = makeFx([yu]);
    fx.simFx('firewall', 5, 10, { x: 5, y: 10, id: 7, dir: 'RIGHT', axis: 'col' });
    fx.simFx('firewall', 5, 10, { x: 5, y: 10, id: 7, dir: 'RIGHT', axis: 'col' });
    assert.equal(fx.sustains.size, 1);
    fx.death(yu);
    run(fx, 0.6);
    assert.equal(fx.sustains.size, 0);
    fx.simFx('firewall', 5, 10, { x: 5, y: 10, id: 7, dir: 'RIGHT', axis: 'col' });
    fx.clear();
    assert.equal(fx.sustains.size, 0);
  });

  test('no skill running (a talent / a stray event): only the one-shot look', () => {
    const yu = unit(7, 5, 10, { statuses: new Set() });
    const fx = makeFx([yu]);
    fx.simFx('firewall', 5, 10, { x: 5, y: 10, id: 7, dir: 'RIGHT', axis: 'col' });
    assert.equal(fx.sustains.size, 0);
  });
});

describe('skill-long fields', () => {
  test('浊心斯卡蒂 tide / 白面鸮 healField / 灵知 coldWind / 银灰 snow on the caster last until its skill ends', () => {
    for (const kind of ['tide', 'healField', 'coldWind', 'snow']) {
      const op = unit(3, 6, 10);
      const fx = makeFx([op]);
      fx.simFx(kind, 6, 10, { x: 6, y: 10, id: 3 });
      run(fx, 10);
      const S = fx.sustains.get(`${kind}:3`);
      assert.ok(S && S.disc.alpha > 0.1, `${kind}: shown 10 s later`);
      fx.skill(op, false);
      run(fx, 0.6);
      assert.equal(fx.sustains.size, 0, `${kind}: gone after skill off`);
    }
  });

  test('a field event away from the caster (a heal on a target) is not held', () => {
    const op = unit(3, 6, 10);
    const fx = makeFx([op]);
    fx.simFx('healField', 9, 11, { x: 9, y: 11, id: 3 });
    assert.equal(fx.sustains.size, 0);
  });
});

// ---- FX audit follow-up: every lasting sim fx is held until its own end signal (render/fxsustain.js) -------------

const op = (id, x, y, o = {}) => unit(id, x, y, { statuses: new Set(), ...o });
/** What render/app.js does for ['skill', id, on] / ['status', id, key, on]. */
const skillEv = (fx, v, on) => { if (on) v.statuses.add('skill'); else v.statuses.delete('skill'); fx.skill(v, on); };
const statusEv = (fx, v, key, on) => { if (on) v.statuses.add(key); else v.statuses.delete(key); fx.status(v, key, on); };

describe('unit states: held by the status they came with, their duration or their skill', () => {
  test('刺玫 S2 taunt on the protégé: bound to vendla:taunt, gone when it ends', () => {
    const vendla = op(1, 5, 10), p = op(2, 6, 10);
    const fx = makeFx([vendla, p]);
    skillEv(fx, vendla, true);
    statusEv(fx, p, 'vendla:taunt', true);
    fx.simFx('taunt', 6, 10, { x: 6, y: 10, id: 2 });
    const S = fx.sustains.get('taunt:2');
    assert.ok(S && S.until === 'status' && S.bind.has('vendla:taunt'));
    run(fx, 12);
    assert.ok(fx.sustains.has('taunt:2') && S.a === 1, 'still shown 12 s later');
    statusEv(fx, p, 'vendla:taunt', false);
    run(fx, 0.6);
    assert.equal(fx.sustains.size, 0);
  });

  test('银灰 S3 真银斩 at the skill start: held for the skill (a new batch does not bind an old status)', () => {
    const sv = op(3, 5, 10);
    const fx = makeFx([sv]);
    statusEv(fx, sv, 'some:old', true);
    run(fx, 0.1);                                   // (another frame: that status is not this fx's)
    skillEv(fx, sv, true);
    fx.simFx('truesilver', 5, 10, { x: 5, y: 10, id: 3 });
    const S = fx.sustains.get('truesilver:3');
    assert.equal(S.until, 'skill');
    run(fx, 20);
    assert.equal(S.a, 1, '20 s into a 23 s skill');
    assert.ok(S.dec && S.glow, 'its hex ring and glow');
    skillEv(fx, sv, false);
    run(fx, 0.6);
    assert.equal(fx.sustains.size, 0);
  });

  test('an fx in the middle of a skill is a one-off unless its kind is `mid` (号角 S2 过载)', () => {
    const u = op(4, 5, 10);
    const fx = makeFx([u]);
    skillEv(fx, u, true);
    run(fx, 1);
    fx.simFx('buff', 5, 10, { x: 5, y: 10, id: 4, kind: 'ammo' });
    assert.equal(fx.sustains.size, 0, 'an ammo refill is not a state');
    fx.simFx('overload', 5, 10, { x: 5, y: 10, id: 4 });
    assert.equal(fx.sustains.get('overload:4')?.until, 'skill');
  });

  test('an instant skill (skill on → fx → off in one batch) only flashes', () => {
    const u = op(5, 5, 10);
    const fx = makeFx([u]);
    skillEv(fx, u, true);
    fx.simFx('bloodBattle', 5, 10, { x: 5, y: 10, id: 5 });
    skillEv(fx, u, false);
    run(fx, 0.6);
    assert.equal(fx.sustains.size, 0);
  });

  test('a status lost in the same batch marks a use: 雷蛇 S1 block consumed → no shield, the running one ends', () => {
    const u = op(6, 5, 10);
    const fx = makeFx([u]);
    skillEv(fx, u, true);
    statusEv(fx, u, 'liskam:block', true);
    fx.simFx('shield', 5, 10, { x: 5, y: 10, id: 6 });
    run(fx, 3);
    assert.equal(fx.sustains.get('shield:6')?.a, 1);
    statusEv(fx, u, 'liskam:block', false);
    fx.simFx('shield', 5, 10, { x: 5, y: 10, id: 6 });
    run(fx, 0.6);
    assert.equal(fx.sustains.size, 0);
  });

  test('items: 锤 undying for its duration (8 game s = 4 s at ×2)', () => {
    const u = op(7, 5, 10);
    const fx = makeFx([u]);
    fx.simFx('undying', 5, 10, { x: 5, y: 10, id: 7, duration: 8 });
    run(fx, 3.5);
    assert.ok(fx.sustains.has('undying:7'));
    run(fx, 1);
    assert.equal(fx.sustains.size, 0);
  });

  test('焰影苇草 S2: three fireballs circle each carrier until its fireball buff ends', () => {
    const reed = op(8, 5, 10), a = op(9, 6, 10);
    const fx = makeFx([reed, a]);
    skillEv(fx, reed, true);
    statusEv(fx, a, 'reed2:fireball:8', true);
    fx.simFx('ember', 6, 10, { x: 6, y: 10, id: 9, src: 8, n: 3 });
    const S = fx.sustains.get('ember:9');
    assert.equal(S.orb.length, 3);
    run(fx, 1);
    assert.ok(S.orb[0].sp.alpha > 0.2);
    statusEv(fx, a, 'reed2:fireball:8', false);
    run(fx, 0.6);
    assert.equal(fx.sustains.size, 0);
  });

  test('death ends what the unit holds', () => {
    const u = op(10, 5, 10);
    const fx = makeFx([u]);
    skillEv(fx, u, true);
    fx.simFx('overclock', 5, 10, { x: 5, y: 10, id: 10 });
    u.alive = false;
    run(fx, 0.6);
    assert.equal(fx.sustains.size, 0);
  });
});

describe('links, channels and virtual units', () => {
  test('溯光星源 S3: the linked targets are chained while her skill runs; a dead target drops out', () => {
    const halo = op(1, 3, 10), e1 = op(11, 7, 10), e2 = op(12, 8, 10), e3 = op(13, 8, 11);
    const fx = makeFx([halo, e1, e2, e3]);
    skillEv(fx, halo, true);
    fx.simFx('link', 7, 10, { x: 7, y: 10, id: 1, ids: [11, 12, 13], chain: true });
    const S = fx.sustains.get('link:1');
    assert.deepEqual(S.pairs, [[11, 12], [12, 13]]);
    run(fx, 10);
    e3.alive = false;
    run(fx, 0.1);
    assert.deepEqual(S.pairs, [[11, 12]]);
    skillEv(fx, halo, false);
    run(fx, 0.6);
    assert.equal(fx.sustains.size, 0);
  });

  test('迷迭香: the talent pair lasts the battle; 远牙 S2: from her to each ally whose blocked enemies she reaches', () => {
    const ros = op(1, 3, 10), cast = op(2, 4, 12), far = op(3, 2, 9), blk = op(4, 8, 10);
    const fx = makeFx([ros, cast, far, blk]);
    fx.simFx('link', 4, 12, { x: 4, y: 12, id: 2, src: 1 });
    run(fx, 60);
    assert.deepEqual(fx.sustains.get('link:1')?.pairs, [[1, 2]]);
    skillEv(fx, far, true);
    fx.simFx('link', 2, 9, { x: 2, y: 9, id: 3, ids: [4] });
    assert.deepEqual(fx.sustains.get('link:3')?.pairs, [[3, 4]]);
  });

  test('溯光星源 S2 (instant): the pull link is a short beam, not held', () => {
    const halo = op(1, 3, 10), e1 = op(11, 7, 10), e2 = op(12, 8, 10);
    const fx = makeFx([halo, e1, e2]);
    fx.simFx('link', 8, 10, { x: 8, y: 10, id: 1, ids: [11, 12], chain: true });
    assert.equal(fx.sustains.size, 0);
    assert.equal(fx.beamList.length, 1);
  });

  test('死亡之眼: the channelled beam lasts its dur and ends when the target dies', () => {
    const eye = op(20, 2, 12, { isEnemy: true }), t = op(5, 5, 10);
    const fx = makeFx([eye, t]);
    fx.simFx('beam', 2, 12, { x: 2, y: 12, from: 20, to: 5, kind: 'deathEye', dur: 6 });
    run(fx, 2.5);
    assert.ok(fx.sustains.has('beam:20:5'), '2.5 s of a 3 s (6 game s) channel');
    t.alive = false;
    run(fx, 0.6);
    assert.equal(fx.sustains.size, 0);
  });

  test('boss 盲信之誓: the from/to line is drawn and held while its ticks come; gone when they stop', () => {
    const boss = op(20, 2, 12, { isEnemy: true }), spring = op(21, 6, 12, { isEnemy: true });
    const fx = makeFx([boss, spring]);
    for (let k = 0; k < 6; k++) { fx.simFx('link', 2, 12, { x: 2, y: 12, from: 20, to: 21, kind: 'faithLink', dur: 1 }); run(fx, 0.5); }
    const S = fx.sustains.get('link:20:21');
    assert.ok(S && S.a === 1 && S.pairs.length === 1, 'held across the 1 game s ticks (review of the upstream PR: it was not drawn at all)');
    run(fx, 1.2);
    assert.equal(fx.sustains.size, 0, 'no more ticks: gone');
  });

  test('死亡之眼 interrupted (deathEyeEnd): the channelled beam ends at once', () => {
    const eye = op(20, 2, 12, { isEnemy: true }), t = op(5, 5, 10);
    const fx = makeFx([eye, t]);
    fx.simFx('beam', 2, 12, { x: 2, y: 12, from: 20, to: 5, kind: 'deathEye', dur: 8 });
    run(fx, 1);
    fx.simFx('beam', 2, 12, { x: 2, y: 12, from: 20, to: 5, kind: 'deathEyeEnd' });
    run(fx, 0.6);
    assert.equal(fx.sustains.size, 0);
  });

  test('荒芜拉普兰德 S3: three drones fly between their samples — no summon pillar per sample', () => {
    const w = op(30, 3, 10), e = op(40, 9, 10, { isEnemy: true });
    const fx = makeFx([w, e]);
    skillEv(fx, w, true);
    fx.simFx('drones', 3, 10, { x: 3, y: 10, id: 30, n: 3, v: 1 });
    const S = fx.sustains.get('drones:30');
    assert.equal(S.list.length, 3);
    run(fx, 1);
    const before = fx.counts.particles;
    for (let i = 0; i < 3; i++) fx.simFx('drone', 4, 10, { x: 4, y: 10, id: 30, i, to: 40, v: 1 });
    assert.equal(fx.counts.particles, before, 'a sample draws nothing by itself');
    run(fx, 1);
    for (const d of S.list) assert.ok(d.x > 4.2, 'chasing its target past the sample');
    skillEv(fx, w, false);
    run(fx, 1);
    assert.equal(fx.sustains.size, 0);
  });

  test('魔王: motes orbit her; a touch hides one until it is back; S2 reweave raises the count for the skill', () => {
    const m = op(50, 5, 10), a = op(51, 6, 10);
    const fx = makeFx([m, a]);
    fx.simFx('motes', 5, 10, { x: 5, y: 10, id: 50, n: 3, r: 1.15, spd: 30 });
    const S = fx.sustains.get('motes:50');
    run(fx, 0.5);
    assert.equal(S.orb.length, 3);
    statusEv(fx, a, 'cetsyr:mote', true);
    fx.simFx('mote', 6, 10, { x: 6, y: 10, id: 51, src: 50, k: 1, cd: 6 });
    run(fx, 0.1);
    assert.equal(S.orb[1].sp.alpha, 0, 'slot 1 gone for its 6 game s');
    assert.ok(fx.sustains.has('mote:51'), 'the touched ally carries one');
    run(fx, 3.3);
    assert.ok(S.orb[1].sp.alpha > 0, 'back');
    skillEv(fx, m, true);
    fx.simFx('reweave', 5, 10, { x: 5, y: 10, id: 50, n: 6 });
    assert.equal(S.orb.length, 6);
    skillEv(fx, m, false);
    assert.equal(S.orb.length, 3);
  });

  test('伊内丝: the 影哨 stays where she left until it is recalled', () => {
    const ines = op(60, 4, 10);
    const fx = makeFx([ines]);
    ines.alive = false;
    fx.simFx('sentry', 4, 10, { x: 4, y: 10, id: 60 });
    run(fx, 30);
    assert.equal(fx.sustains.get('sentry:60')?.a, 1);
    fx.simFx('sentryRecall', 4, 10, { x: 4, y: 10, tx: 6, ty: 10, id: 60 });
    run(fx, 0.6);
    assert.equal(fx.sustains.size, 0);
  });

  test('圣聆初雪: the snowy tiles follow the sim list and go with her', () => {
    const sb = op(70, 4, 10);
    const fx = makeFx([sb]);
    fx.simFx('snowTiles', 4, 10, { x: 4, y: 10, id: 70, tiles: [[10, 5, 1], [10, 6, 2]] });
    const S = fx.sustains.get('snowTiles:70');
    assert.equal(S.tiles.length, 2);
    fx.simFx('snowTiles', 4, 10, { x: 4, y: 10, id: 70, tiles: [[10, 6, 2]] });
    assert.equal(S.tiles.length, 1);
    fx.simFx('snow', 4, 10, { x: 4, y: 10, id: 70, tiles: 1 });
    assert.ok(!fx.sustains.has('snow:70'), 'her snow is tiles, never a disc');
    sb.alive = false;
    run(fx, 0.6);
    assert.equal(fx.sustains.size, 0);
  });
});

describe('enemy auras, winds, timing and shapes', () => {
  test('嵌合体 aura held for its life; 隐形庇护 for its duration — not a warning flash', () => {
    const c = op(80, 6, 10, { isEnemy: true }), s = op(81, 8, 10, { isEnemy: true });
    const fx = makeFx([c, s]);
    fx.simFx('telegraph', 6, 10, { x: 6, y: 10, r: 1, kind: 'chimera', id: 80 });
    fx.simFx('telegraph', 8, 10, { x: 8, y: 10, r: 2, kind: 'invisShield', id: 81, duration: 6 });
    assert.equal(fx.zones.length, 0, 'no warning ring');
    run(fx, 2.5);
    assert.ok(fx.sustains.has('enemyAura:chimera:80') && fx.sustains.has('enemyAura:invisShield:81'));
    run(fx, 1);
    assert.ok(!fx.sustains.has('enemyAura:invisShield:81'), '6 game s = 3 s');
    assert.ok(fx.sustains.has('enemyAura:chimera:80'));
    c.alive = false;
    run(fx, 0.6);
    assert.equal(fx.sustains.size, 0);
  });

  test('歌蕾蒂娅 S3 tornado turns for its duration', () => {
    const g = op(90, 4, 10);
    const fx = makeFx([g]);
    fx.simFx('tornado', 8, 10, { x: 8, y: 10, id: 90, r: 1.5, duration: 8 });
    run(fx, 3.5);
    assert.equal(fx.sustains.get('tornado:90')?.a, 1);
    run(fx, 1);
    assert.equal(fx.sustains.size, 0);
  });

  test('the wind stops with its caster (歌蕾蒂娅 dies mid-tornado)', () => {
    const g = op(90, 4, 10);
    const fx = makeFx([g]);
    fx.simFx('tornado', 8, 10, { x: 8, y: 10, id: 90, r: 1.5, duration: 20 });
    run(fx, 1);
    g.alive = false;
    fx.death(g);
    run(fx, 0.6);
    assert.equal(fx.sustains.size, 0);
  });

  test('灵知 S3 cold wind: her field, no full-screen tint; the Kjerag gust keeps it', () => {
    const gn = op(91, 5, 10);
    const fx = makeFx([gn]);
    skillEv(fx, gn, true);
    fx.simFx('coldWind', 5, 10, { x: 5, y: 10, id: 91 });
    assert.equal(fx.tintT, 0);
    assert.ok(fx.sustains.has('coldWind:91'));
    fx.simFx('coldWind', 6, 10, { x: 6, y: 10, playerId: 1, n: 3, duration: 4 });
    assert.ok(fx.tintT > 0);
  });

  test('boss 崩坍: a warning first, the rocks land `dur` later', () => {
    const t = op(92, 5, 10);
    const fx = makeFx([t]);
    fx.simFx('rockfall', 5, 10, { x: 5, y: 10, id: 92, dur: 1 });
    assert.equal(fx.timers.length, 1);
    assert.ok(fx.zones.some((z) => z.warn));
    const rings = fx.counts.rings;
    run(fx, 0.45);
    assert.equal(fx.timers.length, 1, 'not yet (1 game s = 0.5 s)');
    run(fx, 0.1);
    assert.equal(fx.timers.length, 0);
    assert.ok(fx.counts.rings > 0 && fx.counts.rings >= rings - 2, 'the explosion');
  });

  test('a skill area given as tiles flashes those tiles; 莫斯提马 S2 lights her range for 5 game s', () => {
    const u = op(93, 5, 10);
    const fx = makeFx([u]);
    const range = [[9, 5], [10, 5], [11, 5], [10, 6], [10, 7]];
    fx.simFx('explosion', 5, 10, { x: 5, y: 10, id: 93, tiles: range });
    assert.deepEqual(fx.tileFlashes.at(-1).tiles, range);
    fx.simFx('zone', 5, 10, { x: 5, y: 10, id: 93, duration: 5, tiles: range });
    const z = fx.tileFlashes.at(-1);
    assert.ok(z.hold && Math.abs(z.dur - 2.5) < 1e-9);
  });

  test('boss 冰凌 lights its whole column; 十字 telegraphs are a plus', () => {
    const fx = makeFx([]);
    fx.simFx('column', 6, 3, { x: 6, y: 3, c: 6, id: 99 });
    assert.deepEqual(fx.tileFlashes.at(-1).tiles.map(([r]) => r), [9, 10, 11, 12]);
    assert.ok(fx.tileFlashes.at(-1).tiles.every(([, c]) => c === 6));
    assert.equal(FX.tilesAround(5, 5, 2, 'plus').length, 9);
    assert.equal(FX.tilesAround(5, 5, 2, 'disc').length, 13);
  });
});
