// test/content/waiguan/char_197_poca.test.js — 早露 外援 kit (server/sim/content/kits/waiguan/char_197_poca.js).
// The 攻城手 trait (heaviest first), every skill (normal Lv4 + elite Lv7), each talent (incl. the module upgrades), each
// module choice, a smoke wave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, checkInvariants, hashOf } from '../../helpers/battleHarness.js';
import { DataSource, getDefaultSource } from '../../../server/sim/simdata.js';
import { getData } from '../../../server/data.js';
import { waiguanRecords } from '../../../shared/waiguan.js';
import { skillSpecSource } from '../../../server/sim/content/index.js';
import { COLS } from '../../../server/sim/constants.js';
import WAIGUAN from '../../../server/sim/content/kits/waiguan/index.js';

const CHAR = 'char_197_poca';
const ID5 = `chess_char_diy_5_${CHAR}_a`, ID6 = `chess_char_diy_6_${CHAR}_a`;
const ELITE5 = ID5.replace(/_a$/, '_b'), ELITE6 = ID6.replace(/_a$/, '_b');
const SIE_X = 'uniequip_002_poca', SIE_Y = 'uniequip_003_poca';
/** Both tiers' elites: tier V uses module level 1 once stream D lands — every expectation is read from the record. */
const ELITES = [ELITE5, ELITE6];
const GUMMY = 'chess_char_1_10_a', OTHER = 'chess_char_2_06_a'; // 古米 (乌萨斯学生自治团, pool) and a non-member
const REC = waiguanRecords(getData({ log: { warn() {}, error() {}, info() {} } }).waiguan);
const DS = new DataSource({ chess: REC }, getDefaultSource());
const rec = (id) => REC[id];
const skillOf = (id, sid) => rec(id).skills.find((s) => s.skillId === sid);
/** Loadout-resolved record of `id` with module `moduleId` (talents, trait). */
const raw = (id, moduleId = null) => DS.getChess(id, { skillIndex: 0, moduleId }).raw;
const talOf = (id, i, moduleId = null) => raw(id, moduleId).talents.find((t) => t.index === i)?.bb ?? {};
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e7, speed: 0, ...o });
const DEFS = {
  chess: REC,
  enemies: {
    enemy_m1: dummy('enemy_m1', { mass: 1 }), enemy_m2: dummy('enemy_m2', { mass: 2 }), enemy_m3: dummy('enemy_m3', { mass: 3 }),
    enemy_m4: dummy('enemy_m4', { mass: 4 }), enemy_m5: dummy('enemy_m5', { mass: 5 }),
    enemy_armor2: dummy('enemy_armor2', { mass: 2, def: 500 }), enemy_armor3: dummy('enemy_armor3', { mass: 3, def: 500 }),
    enemy_fly5: dummy('enemy_fly5', { mass: 5, motion: 'FLY' }),
  },
};
const READY = { sp: 999 };
const HOOKS = ['damaged', 'heal', 'skillStart', 'skillEnd', 'statusApplied', 'attack', 'deploy'];
const run = (o) => makeBattle({ defs: DEFS, seed: 7, timeLimit: 300, autoFinish: false, hooks: HOOKS, captureNoisy: true, ...o });
/** Operator entry with skill `sid` selected (board coords: row 9–12, col 2–10). She stands at (10, 3): range cols 5–7. */
const U = (id, sid, row, col, o = {}) => ({ chessId: id, row, col, skillIndex: skillOf(id, sid).index, ...o });
const done = (h) => { checkInvariants(h.b); assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0])); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const hitsBy = (h, u, f = () => true) => h.hooksOf('damaged').filter((c) => c.source === u && f(c));
const S1 = 'skcom_atk_up[3]', S2 = 'skchr_poca_2', S3 = 'skchr_poca_3';

test('早露: every skill of both tiers (normal + elite, every module) is hand-authored', () => {
  for (const id of [ID5, ID6]) {
    assert.equal(typeof WAIGUAN[id], 'function', `${id} registered`);
    for (const cid of [id, id.replace(/_a$/, '_b')]) {
      const mods = [null, 'none', ...(rec(cid).modules ?? []).map((m) => m.uniEquipId)];
      for (const s of rec(cid).skills) for (const moduleId of cid.endsWith('_b') ? mods : [null]) {
        assert.equal(skillSpecSource(DS.getChess(cid, { skillIndex: s.index, moduleId }), WAIGUAN), 'skills', `${cid} ${s.skillId} ${moduleId}`);
      }
    }
  }
});

test('早露 trait 攻城手: attacks the heaviest enemy first (the engine order alone would pick the nearest to the goal)', () => {
  for (const id of [ID6, ...ELITES]) {
    const h = run({ units: [U(id, S1, 10, 3)], enemies: [{ key: 'enemy_m1', pos: [10, 5] }, { key: 'enemy_m4', pos: [10, 7] }, { key: 'enemy_m2', pos: [11, 6] }] });
    const u = h.unit(id);
    h.run(8);
    const [light, heavy] = [h.enemy('enemy_m1'), h.enemy('enemy_m4')];
    assert.ok(h.b.remainingDistance(light) < h.b.remainingDistance(heavy), 'the light one is nearer to the goal');
    const shots = hitsBy(h, u, (c) => c.dmg.isAttack);
    assert.ok(shots.length >= 2 && shots.every((c) => c.target === heavy), `every attack on the heaviest (${shots.map((c) => c.target.defId)})`);
    done(h);
  }
});

test('早露 trait: the enemy she blocks comes first (attacks and S2), flyers count, equal weights keep the engine order', () => {
  for (const id of [ID6, ...ELITES]) {
    const enemies = [{ key: 'enemy_m1', pos: [10, 3] }, { key: 'enemy_m3', pos: [10, 5] }, { key: 'enemy_m4', pos: [10, 6] }, { key: 'enemy_fly5', pos: [10, 7], route: 2 }];
    const a = run({ units: [U(id, S1, 10, 3)], enemies });
    a.run(6);
    const u = a.unit(id);
    assert.equal(a.enemy('enemy_m1').blockedBy, u, 'she blocks the light one on her tile');
    const shots = a.hooksOf('attack').filter((c) => c.attacker === u);
    assert.ok(shots.length >= 2 && shots.every((c) => c.targets.length === 1 && c.targets[0].defId === 'enemy_m1'), 'blocked first');
    done(a);
    const b = run({ units: [U(id, S2, 10, 3, { carryState: READY })], enemies });
    b.run(6);
    const v = b.unit(id);
    assert.ok(v.skill.active);
    const two = b.hooksOf('attack').filter((c) => c.attacker === v);
    assert.ok(two.length >= 2 && two.every((c) => c.targets.map((t) => t.defId).join() === 'enemy_m1,enemy_fly5'), 'S2: the blocked one, then the heaviest (a flyer)');
    done(b);
  }
  // equal weights: the engine's order (least remaining path first)
  const h = run({ units: [U(ID6, S1, 10, 3)], enemies: [{ key: 'enemy_m3', pos: [10, 7] }, { key: 'enemy_m3', pos: [10, 5] }, { key: 'enemy_m1', pos: [10, 6] }] });
  h.run(6);
  const u = h.unit(ID6);
  const shots = hitsBy(h, u, (c) => c.dmg.isAttack);
  assert.ok(shots.length >= 2 && shots.every((c) => c.target.defId === 'enemy_m3' && c.target.x === 5), 'the mass-3 enemy nearer the goal');
  done(h);
});

test('早露 S1 攻击力强化·γ型: ATK +atk (Lv4 and Lv7 numbers)', () => {
  for (const id of [ID6, ...ELITES]) {
    const h = run({ units: [U(id, S1, 10, 3, { carryState: READY })], enemies: [{ key: 'enemy_m1', pos: [10, 6] }] });
    const u = h.unit(id);
    assert.ok(h.runUntil(() => u.skill.active, 5), 'casts (DEFAULT)');
    assert.equal(u.skill.rule, 'DEFAULT');
    assert.ok(near(u.s.atk, u.base.atk * (1 + skillOf(id, S1).bb.atk + talOf(id, 1).atk)), 'skill + 学生楷模 (she is a member)');
    done(h);
  }
});

test('早露 S2 分裂射击: ATK +atk, two targets per attack — the two heaviest (Lv4 and Lv7)', () => {
  for (const id of [ID6, ...ELITES]) {
    const bb = skillOf(id, S2).bb;
    const h = run({ units: [U(id, S2, 10, 3, { carryState: READY })],
      enemies: [{ key: 'enemy_m1', pos: [10, 5] }, { key: 'enemy_m3', pos: [10, 6] }, { key: 'enemy_m5', pos: [10, 7] }, { key: 'enemy_m2', pos: [11, 5] }] });
    const u = h.unit(id);
    assert.ok(h.runUntil(() => u.skill.active, 5));
    assert.ok(near(u.s.atk, u.base.atk * (1 + bb.atk + talOf(id, 1).atk)));
    h.run(8);
    const shots = h.hooksOf('attack').filter((c) => c.attacker === u);
    assert.ok(shots.length >= 2);
    for (const c of shots) assert.deepEqual(c.targets.map((t) => t.defId).sort(), ['enemy_m3', 'enemy_m5'], `${bb['attack@max_target']} heaviest`);
    done(h);
  }
});

test('早露 S3 雪崩击: the 3 heaviest are bound and hit once per second (6 / 7 hits), no normal attack meanwhile', () => {
  for (const [id, moduleId] of [[ID6, undefined], ...ELITES.map((e) => [e, 'none'])]) {
    const sk = skillOf(id, S3), bb = sk.bb;
    const h = run({ units: [U(id, S3, 10, 3, { carryState: READY, moduleId })],
      enemies: [{ key: 'enemy_m1', pos: [10, 5] }, { key: 'enemy_m2', pos: [10, 6] }, { key: 'enemy_m4', pos: [10, 7] }, { key: 'enemy_m5', pos: [11, 6] }] });
    const u = h.unit(id);
    assert.ok(h.runUntil(() => u.skill.active, 5));
    assert.ok(near(u.s.atk, u.base.atk * (1 + bb.atk + talOf(id, 1, moduleId).atk)), 'ATK +atk');
    const atkDuring = u.s.atk;
    h.runUntil(() => !u.skill.active, 20);
    const t0 = h.hooksOf('skillStart').find((c) => c.unit === u).t, t1 = h.hooksOf('skillEnd').find((c) => c.unit === u).t;
    assert.ok(Math.abs(t1 - t0 - bb.hit_duration) < 0.05, 'lasts hit_duration');
    const bound = h.hooksOf('statusApplied').filter((c) => c.source === u && c.status === 'bind').map((c) => c.target.defId).sort();
    assert.deepEqual(bound, ['enemy_m2', 'enemy_m4', 'enemy_m5'], `${bb.max_target} heaviest harpooned`);
    for (const key of ['enemy_m2', 'enemy_m4', 'enemy_m5']) {
      const hits = hitsBy(h, u, (c) => c.target.defId === key && c.dmg.tags.includes('pocaS3'));
      assert.equal(hits.length, Math.round(bb.hit_duration / bb.hit_interval), `${key}: one hit per second`);
      for (let i = 1; i < hits.length; i++) assert.ok(Math.abs(hits[i].t - hits[i - 1].t - bb.hit_interval) < 0.05);
      assert.ok(hits.every((c) => near(c.amount, atkDuring)), 'ATK physical (DEF 0)');
      const b = h.enemy(key).findBuff('bind');
      assert.ok(!b || b.source !== u, 'the bind ends with the skill');
    }
    assert.equal(hitsBy(h, u, (c) => c.target.defId === 'enemy_m1').length, 0, 'the lightest is left alone');
    assert.equal(h.hooksOf('attack').filter((c) => c.attacker === u && !c.isSkill && c.t >= t0 && c.t < t1).length, 0, 'no normal attack');
    done(h);
  }
});

test('早露 S3: the harpoons skip the blocked-first step — the 3 heaviest even while she blocks a light enemy (flyers count)', () => {
  for (const id of [ID6, ...ELITES]) {
    const h = run({ units: [U(id, S3, 10, 3, { carryState: READY })],
      enemies: [{ key: 'enemy_m1', pos: [10, 3] }, { key: 'enemy_m3', pos: [10, 5] }, { key: 'enemy_m4', pos: [10, 6] }, { key: 'enemy_fly5', pos: [10, 7], route: 2 }] });
    const u = h.unit(id);
    assert.ok(h.runUntil(() => u.skill.active, 5));
    assert.equal(h.enemy('enemy_m1').blockedBy, u);
    const bound = h.hooksOf('statusApplied').filter((c) => c.source === u && c.status === 'bind').map((c) => c.target.defId).sort();
    assert.deepEqual(bound, ['enemy_fly5', 'enemy_m3', 'enemy_m4']);
    const first = hitsBy(h, u, (c) => c.dmg.tags.includes('pocaS3'));
    const t0 = h.hooksOf('skillStart').find((c) => c.unit === u).t;
    assert.equal(first.length, 3, 'one harpoon hit each at the cast');
    assert.ok(first.every((c) => c.t === t0), 'the first hits land with the harpoons (the cast)');
    done(h);
  }
});

test('早露 S3 harpoon hits take T1 (DEF ignore), SIE-X (×atk_scale, extra hit) and SIE-Y (distance)', () => {
  const DEF = 500;
  for (const id of ELITES) for (const moduleId of [null, SIE_Y, 'none']) {
    const t0 = talOf(id, 0, moduleId), tb = raw(id, moduleId).trait.bb, bb = skillOf(id, S3).bb;
    const sc = t0.atk_scale ?? 1, ex = t0.extra_atk_scale ?? 0;
    const dm = tb.damage_scale > 0 ? 1 + tb.damage_scale * Math.min(1, Math.max(0, (3 - tb.min_dist) / (tb.max_dist - tb.min_dist))) : 1;
    const h = run({ units: [U(id, S3, 10, 3, { carryState: READY, moduleId })], enemies: [{ key: 'enemy_armor3', pos: [10, 6] }] });
    const u = h.unit(id);
    assert.ok(h.runUntil(() => u.skill.active, 5));
    const atk = u.s.atk;
    h.runUntil(() => !u.skill.active, 20);
    const hits = hitsBy(h, u, (c) => c.dmg.tags.includes('pocaS3')), extra = hitsBy(h, u, (c) => c.dmg.tags.includes('pocaExtra'));
    assert.equal(hits.length, Math.round(bb.hit_duration / bb.hit_interval));
    assert.ok(hits.every((c) => near(c.amount, (atk * sc - DEF * (1 - t0.def_penetrate)) * dm)), `${id} ${moduleId}: ${hits[0].amount}`);
    assert.equal(extra.length, ex > 0 ? hits.length : 0, `${id} ${moduleId}: an extra hit per harpoon hit (SIE-X)`);
    if (ex > 0) assert.ok(extra.every((c) => near(c.amount, (atk * ex - DEF) * dm)));
    done(h);
  }
});

test('早露 module SIE-Y: the distance bonus clamps — none below min_dist (a blocked enemy), +damage_scale beyond max_dist', () => {
  for (const id of ELITES) {
    const tb = raw(id, SIE_Y).trait.bb;
    if (!(tb.damage_scale > 0)) continue;
    // below min_dist: the enemy on her tile (blocked first)
    const a = run({ units: [U(id, S1, 10, 3, { moduleId: SIE_Y })], enemies: [{ key: 'enemy_m1', pos: [10, 3] }] });
    const u = a.unit(id);
    a.runUntil(() => hitsBy(a, u).length > 0, 5);
    assert.ok(near(hitsBy(a, u)[0].amount, u.s.atk), `${id}: distance 0 ⇒ ×1`);
    done(a);
    // beyond max_dist: a tile 6 columns ahead, made targetable (Battle.setExtraRange)
    const b = run({ units: [U(id, S1, 10, 3, { moduleId: SIE_Y })], enemies: [{ key: 'enemy_m1', pos: [10, 9] }] });
    const v = b.unit(id);
    b.step(1);
    b.b.setExtraRange(v, [10 * COLS + 9]);
    b.runUntil(() => hitsBy(b, v).length > 0, 8);
    assert.ok(6 > tb.max_dist && near(hitsBy(b, v)[0].amount, v.s.atk * (1 + tb.damage_scale)), `${id}: distance 6 ⇒ ×(1 + damage_scale)`);
    done(b);
  }
});

test('早露 T1 深入骨髓: vs 重量 ≥ value her damage ignores def_penetrate DEF; SIE-X adds ATK ×atk_scale and an extra hit', () => {
  const dealt = (id, moduleId, key) => {
    const h = run({ units: [U(id, S1, 10, 3, { moduleId })], enemies: [{ key, pos: [10, 6] }] });
    const u = h.unit(id);
    h.runUntil(() => hitsBy(h, u, (c) => c.dmg.isAttack).length > 0, 5);
    h.step(1);
    const main = hitsBy(h, u, (c) => c.dmg.isAttack)[0], extra = hitsBy(h, u, (c) => c.dmg.tags.includes('pocaExtra'));
    const atk = u.s.atk;
    done(h);
    return { main: main.amount, extra: extra.map((c) => c.amount), atk };
  };
  const DEF = 500; // enemy_armor2 / enemy_armor3
  for (const [id, moduleId] of [[ID6, undefined], ...ELITES.flatMap((e) => [[e, null], [e, SIE_X], [e, 'none'], [e, SIE_Y]])]) {
    const t0 = talOf(id, 0, moduleId);
    assert.ok(t0.value <= 3 && t0.value > 2, 'the dummies straddle the weight threshold');
    const sc = t0.atk_scale ?? 1, ex = t0.extra_atk_scale ?? 0;
    // SIE-Y's distance trait at the probe's distance 3 (×1 for the other loadouts)
    const tb = raw(id, moduleId).trait.bb;
    const dm = tb.damage_scale > 0 ? 1 + tb.damage_scale * Math.min(1, Math.max(0, (3 - tb.min_dist) / (tb.max_dist - tb.min_dist))) : 1;
    const hv = dealt(id, moduleId, 'enemy_armor3'), lt = dealt(id, moduleId, 'enemy_armor2');
    assert.ok(near(hv.main, (hv.atk * sc - DEF * (1 - t0.def_penetrate)) * dm), `${id} ${moduleId} heavy ${hv.main}`);
    assert.deepEqual(hv.extra.length, ex > 0 ? 1 : 0, `${id} ${moduleId}: extra hit`);
    if (ex > 0) assert.ok(near(hv.extra[0], (hv.atk * ex - DEF) * dm), `extra hit (no DEF ignore, no ×atk_scale): ${hv.extra[0]}`);
    assert.ok(near(lt.main, (lt.atk - DEF) * dm) && lt.extra.length === 0, `${id} ${moduleId} light: nothing`);
  }
  assert.ok(talOf(ELITE6, 0, SIE_X).extra_atk_scale > 0 && talOf(ELITE6, 0, SIE_X).atk_scale > 1, 'T6 SIE-X carries both parts');
});

test('早露 T2 学生楷模: every 【乌萨斯学生自治团】 operator ATK +atk; SIE-Y: per member in skill +init_atk (max max_atk)', () => {
  const t1 = talOf(ID6, 1);
  const h = run({ units: [U(ID6, S1, 10, 3), { chessId: GUMMY, row: 9, col: 4 }, { chessId: OTHER, row: 11, col: 4 }] });
  h.step(1);
  const g = h.unit(GUMMY), o = h.unit(OTHER), u = h.unit(ID6);
  assert.ok(near(g.s.atk, g.base.atk * (1 + t1.atk)) && near(u.s.atk, u.base.atk * (1 + t1.atk)), '古米 and herself');
  assert.equal(o.findBuff('poca:model'), null, 'not a member');
  done(h);

  // SIE-Y: two copies of her (T5 + T6 elites) cast S1 together: the base bonus once (the strongest), and +init_atk × 2
  const ty = Math.max(...ELITES.map((e) => talOf(e, 1, SIE_Y).atk));
  const per = Math.max(...ELITES.map((e) => talOf(e, -1, SIE_Y).init_atk ?? 0)), max = Math.max(...ELITES.map((e) => talOf(e, -1, SIE_Y).max_atk ?? 0));
  const k = run({
    units: [U(ELITE6, S1, 10, 3, { moduleId: SIE_Y, carryState: READY }), U(ELITE5, S1, 11, 3, { moduleId: SIE_Y, carryState: READY }), { chessId: GUMMY, row: 9, col: 4 }],
    enemies: [{ key: 'enemy_m1', pos: [10, 6] }],
  });
  const a = k.unit(ELITE6), b = k.unit(ELITE5), gm = k.unit(GUMMY);
  assert.ok(k.runUntil(() => a.skill.active && b.skill.active, 5));
  const want = (n) => ty + Math.min(max, per * n);
  assert.ok(near(gm.s.atk, gm.base.atk * (1 + want(2))), `古米 with both in skill: ${gm.s.atk / gm.base.atk}`);
  assert.ok(near(a.s.atk, a.base.atk * (1 + skillOf(ELITE6, S1).bb.atk + want(2))));
  k.runUntil(() => !a.skill.active && !b.skill.active, 40);
  assert.ok(near(gm.s.atk, gm.base.atk * (1 + want(0))), 'the bonus leaves with the skills');
  done(k);
  assert.ok(talOf(ELITE6, -1, SIE_Y).init_atk > 0, 'T6 SIE-Y carries the per-skill part');

  // the default module SIE-X (both tiers): the base +atk only
  for (const id of ELITES) {
    const x = run({ units: [U(id, S1, 10, 3, { carryState: READY }), { chessId: GUMMY, row: 9, col: 4 }], enemies: [{ key: 'enemy_m1', pos: [10, 6] }] });
    x.runUntil(() => x.unit(id).skill.active, 5);
    const gx = x.unit(GUMMY);
    assert.ok(near(gx.s.atk, gx.base.atk * (1 + talOf(id, 1).atk)) && !gx.findBuff('poca:studentSkill'));
    done(x);
  }
});

test('早露 module SIE-Y: damage grows with the distance (up to +damage_scale at max_dist); other modules: none', () => {
  const first = (id, moduleId, col) => {
    const h = run({ units: [U(id, S1, 10, 3, { moduleId })], enemies: [{ key: 'enemy_m1', pos: [10, col] }] });
    const u = h.unit(id);
    h.runUntil(() => hitsBy(h, u).length > 0, 5);
    const c = hitsBy(h, u)[0];
    done(h);
    return c.amount / u.s.atk;
  };
  for (const id of ELITES) for (const moduleId of [null, SIE_X, 'none', SIE_Y]) {
    const tb = raw(id, moduleId).trait.bb;
    for (const col of [5, 7]) {
      const t = tb.damage_scale > 0 ? Math.min(1, Math.max(0, (col - 3 - tb.min_dist) / (tb.max_dist - tb.min_dist))) : 0;
      assert.ok(near(first(id, moduleId, col), 1 + (tb.damage_scale ?? 0) * t), `${id} ${moduleId} distance ${col - 3}`);
    }
  }
  assert.ok(raw(ELITE6, SIE_Y).trait.bb.damage_scale > 0, 'T6 SIE-Y carries the distance trait');
});

test('早露: every skill × module survives a real wave without content errors and casts', () => {
  const cases = [];
  for (const id of [ID5, ID6, ...ELITES]) for (const s of rec(id).skills) cases.push([id, s.skillId, null]);
  for (const id of ELITES) for (const s of rec(id).skills) for (const m of ['none', SIE_Y]) cases.push([id, s.skillId, m]);
  for (const [id, sid, moduleId] of cases) {
    const h = makeBattle({ defs: DEFS, seed: 3, timeLimit: 60,
      units: [U(id, sid, 10, 3, { carryState: READY, moduleId }), { chessId: GUMMY, row: 10, col: 6 }],
      enemies: [{ key: 'enemy_1007_slime', count: 8, interval: 1.5 }, { key: 'enemy_1007_slime', route: 1, count: 8, interval: 1.5, time: 3 }] });
    h.runToEnd(90);
    done(h);
    const u = h.b.allyUnits.find((x) => x.defId === id);
    assert.equal(u.kit.skillSource, 'skills');
    assert.ok(u.skill.activations > 0, `${id} ${sid} ${moduleId} casts`);
  }
});

test('早露: same seed ⇒ same battle (no randomness outside battle.rng)', () => {
  const once = () => {
    const h = makeBattle({ defs: DEFS, seed: 11, timeLimit: 60,
      units: [U(ELITE6, 'skchr_poca_3', 10, 3, { moduleId: SIE_X }), { chessId: 'chess_char_2_06_a', row: 11, col: 5 }],
      enemies: [{ key: 'enemy_1007_slime', count: 10, interval: 1 }, { key: 'enemy_1007_slime', route: 1, count: 10, interval: 1, time: 2 }] });
    h.runToEnd(90);
    done(h);
    return hashOf(h.result());
  };
  assert.equal(once(), once());
});
