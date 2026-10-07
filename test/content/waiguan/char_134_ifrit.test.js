// test/content/waiguan/char_134_ifrit.test.js — 伊芙利特 外援 kit (server/sim/content/kits/waiguan/char_134_ifrit.js).
// Every skill (normal Lv4 + elite Lv7), each talent (incl. the elite upgrades), each module choice, a smoke wave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, checkInvariants } from '../../helpers/battleHarness.js';
import { DataSource, getDefaultSource } from '../../../server/sim/simdata.js';
import { getData } from '../../../server/data.js';
import { waiguanRecords } from '../../../shared/waiguan.js';
import { skillSpecSource } from '../../../server/sim/content/index.js';
import WAIGUAN from '../../../server/sim/content/kits/waiguan/index.js';

const CHAR = 'char_134_ifrit';
const ID5 = `chess_char_diy_5_${CHAR}_a`, ID6 = `chess_char_diy_6_${CHAR}_a`;
const ELITE5 = ID5.replace(/_a$/, '_b'), ELITE6 = ID6.replace(/_a$/, '_b');
/** Both tiers' elites: tier V will carry module level 1 (REQUIREMENTS §7) — expectations come from each record. */
const ELITES = [ELITE5, ELITE6];
const BLA_X = 'uniequip_002_ifrit', BLA_D = 'uniequip_003_ifrit';
const REC = waiguanRecords(getData({ log: { warn() {}, error() {}, info() {} } }).waiguan);
const DS = new DataSource({ chess: REC }, getDefaultSource());
const rec = (id) => REC[id];
const skillOf = (id, sid) => rec(id).skills.find((s) => s.skillId === sid);
/** Talent blackboard of the loadout-resolved elite record (module `moduleId`), by data index. */
const talOf = (id, i, moduleId = null) => DS.getChess(id, { moduleId }).raw.talents.find((t) => t.index === i)?.bb ?? {};
const traitOf = (id, moduleId = null) => DS.getChess(id, { moduleId }).traitBb ?? {};
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e7, speed: 0, ...o });
const DEFS = {
  chess: REC,
  enemies: {
    enemy_dummy: dummy('enemy_dummy'),
    enemy_armored: dummy('enemy_armored', { def: 300 }),
    enemy_res: dummy('enemy_res', { res: 30 }),
    enemy_fly: dummy('enemy_fly', { motion: 'FLY' }),
    enemy_fly_res: dummy('enemy_fly_res', { motion: 'FLY', res: 30 }),
  },
};
const READY = { sp: 999 };
const HOOKS = ['damaged', 'skillStart', 'skillEnd', 'attack', 'spGain', 'elementBurst'];
/** Battle with the 外援 records + synthetic dummies; `captureNoisy` keeps the damaged / attack / spGain contexts. */
const run = (o) => makeBattle({ defs: DEFS, seed: 7, timeLimit: 300, autoFinish: false, hooks: HOOKS, captureNoisy: true, ...o });
/** Operator entry with skill `sid` selected (board coords: row 9–12, col 2–10). Her range: her tile and 5 ahead. */
const U = (id, sid, row, col, o = {}) => ({ chessId: id, row, col, skillIndex: skillOf(id, sid).index, ...o });
const done = (h) => { checkInvariants(h.b); assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0])); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const has = (c, tag) => !!c.dmg?.tags?.includes(tag);

test('伊芙利特: every skill of both tiers (normal + elite, every module) is hand-authored', () => {
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

test('伊芙利特: triggers and kinds — the data rules kept (S1/S3 MANUAL DEFAULT, S2 AUTO DEFAULT), S2 charges from data', () => {
  for (const id of [ID6, ELITE6]) {
    const h = run({ units: [U(id, 'skchr_ifrit_1', 10, 4), U(id, 'skchr_ifrit_2', 11, 4, { uid: 2 }), U(id, 'skchr_ifrit_3', 12, 4, { uid: 3 })] });
    const [s1, s2, s3] = [1, 2, 3].map((uid) => h.unit(uid).skill);
    assert.deepEqual([s1.rule, s2.rule, s3.rule], ['DEFAULT', 'DEFAULT', 'DEFAULT']);
    assert.deepEqual([s1.kind, s2.kind, s3.kind], ['duration', 'charges', 'duration']);
    assert.equal(s2.maxCharges, skillOf(id, 'skchr_ifrit_2').maxChargeTime, 'charges: 2 (Lv4) / 3 (Lv7)');
    assert.deepEqual([s1.manual, s2.manual, s3.manual], [true, false, true]);
    done(h);
  }
});

test('伊芙利特 S1 狂热: ATK +atk, ASPD +attack_speed while it runs (normal Lv4 and elite Lv7 numbers)', () => {
  for (const id of [ID6, ELITE6]) {
    const bb = skillOf(id, 'skchr_ifrit_1').bb;
    const h = run({ units: [U(id, 'skchr_ifrit_1', 10, 4, { carryState: READY })], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
    const u = h.unit(id);
    assert.ok(h.runUntil(() => u.skill.active, 10), 'casts at its first attack (DEFAULT)');
    assert.equal(u.kit.skillSource, 'skills');
    assert.ok(near(u.s.atk, u.base.atk * (1 + bb.atk)));
    assert.equal(u.s.aspd, u.base.aspd + bb.attack_speed);
    done(h);
  }
});

test('伊芙利特 S2 炎爆: maxChargeTime empowered attacks of ×atk_scale on every enemy struck; DEF cut + 3 burn ticks each', () => {
  for (const [id, moduleId] of [[ID6, undefined], [ELITE6, 'none']]) { // elite without BLA-X: no distance bonus in the numbers
    const s = skillOf(id, 'skchr_ifrit_2'), bb = s.bb;
    const h = run({ units: [U(id, 'skchr_ifrit_2', 10, 4, { carryState: READY, ...(moduleId ? { moduleId } : {}) })],
      enemies: [{ key: 'enemy_armored', pos: [10, 6] }, { key: 'enemy_fly', pos: [10, 7] }] });
    const u = h.unit(id);
    assert.ok(h.runUntil(() => h.hooksOf('attack').filter((c) => c.attacker === u).length >= 1, 5));
    const ground = h.enemy('enemy_armored'), fly = h.enemy('enemy_fly');
    // the first attack: both enemies take atk × atk_scale arts (RES 0), both carry the DEF cut and burn
    const first = h.hooksOf('damaged').filter((c) => c.source === u && c.dmg.isAttack);
    assert.equal(first.length, 2);
    for (const c of first) {
      assert.equal(c.type, 'arts');
      assert.ok(c.dmg.isSkill);
      assert.ok(near(c.amount, u.s.atk * bb.atk_scale), `${c.target.defId}: ${c.amount}`);
    }
    assert.ok(near(ground.s.def, 300 + bb.def), `DEF ${ground.s.def}`);
    assert.ok(ground.findBuff(`ifrit:burn:${u.id}`) && fly.findBuff(`ifrit:burn:${u.id}`), 'both burn (the flyer too)');
    // the first maxChargeTime attacks are skill attacks (an AUTO skill: no operation cooldown between charges)
    const n = s.maxChargeTime;
    assert.ok(h.runUntil(() => h.hooksOf('attack').filter((c) => c.attacker === u).length >= n, 15));
    assert.deepEqual(h.hooksOf('attack').filter((c) => c.attacker === u).slice(0, n).map((c) => c.isSkill), Array(n).fill(true));
    done(h);
  }
  // burn: one tick per second for `duration` (3.01 s ⇒ 3), burn.atk_scale × ATK arts; the DEF cut lapses with it
  const bb = skillOf(ID6, 'skchr_ifrit_2').bb;
  const h = run({ units: [U(ID6, 'skchr_ifrit_2', 10, 4, { carryState: { sp: skillOf(ID6, 'skchr_ifrit_2').spCost } })], enemies: [{ key: 'enemy_armored', pos: [10, 6] }] });
  const u = h.unit(ID6);
  assert.ok(h.runUntil(() => u.skill.activations === 1, 5));
  const e = h.enemy('enemy_armored');
  const t0 = h.b.time;
  h.run(bb.duration + 0.2);
  const ticks = h.hooksOf('damaged').filter((c) => c.source === u && has(c, 'ifritBurn'));
  assert.equal(ticks.length, 3);
  for (const c of ticks) { assert.equal(c.type, 'arts'); assert.ok(near(c.amount, u.s.atk * bb['burn.atk_scale'])); }
  assert.deepEqual(ticks.map((c) => Math.round(c.t - t0)), [1, 2, 3]);
  assert.equal(e.findBuff(`ifrit:burn:${u.id}`), null);
  assert.equal(e.s.def, 300, 'DEF back after `duration`');
  done(h);
});

test('伊芙利特 S3 灼地: no attacks; per second ATK × atk_scale arts + RES cut on ground enemies only; 2 % max HP 流失 / s', () => {
  for (const id of [ID6, ELITE6]) {
    const s = skillOf(id, 'skchr_ifrit_3'), bb = s.bb;
    const mr = talOf(id, 0).magic_resistance;
    const h = run({ units: [U(id, 'skchr_ifrit_3', 10, 4, { carryState: READY, ...(id === ELITE6 ? { moduleId: 'none' } : {}) })],
      enemies: [{ key: 'enemy_res', pos: [10, 6] }, { key: 'enemy_fly', pos: [10, 7] }] });
    const u = h.unit(id);
    assert.ok(h.runUntil(() => u.skill.active, 5), 'casts at its first attack (DEFAULT)');
    const e = h.enemy('enemy_res'), fly = h.enemy('enemy_fly');
    const tStart = h.b.time, maxHp = u.s.maxHp;
    h.run(1.5);
    assert.ok(near(e.s.res, (30 + bb.magic_resistance) * (1 + mr)), `RES (30 ${bb.magic_resistance}) × ${1 + mr}: ${e.s.res}`);
    assert.ok(h.runUntil(() => !u.skill.active, s.duration + 1));
    const end = h.b.time;
    assert.ok(near(end - tStart, s.duration, 0.01), 'runs its duration');
    const ticks = h.hooksOf('damaged').filter((c) => c.source === u && has(c, 'ifritScorch') && c.target === e);
    assert.equal(ticks.length, Math.round(s.duration), 'one tick per second');
    for (const c of ticks.slice(2)) assert.ok(near(c.amount, u.s.atk * bb.atk_scale * (1 - e.s.res / 100)), `tick ${c.amount}`);
    assert.equal(h.hooksOf('damaged').filter((c) => c.source === u && c.target === fly && has(c, 'ifritScorch')).length, 0, 'ground only');
    const t0 = h.hooksOf('skillStart').find((c) => c.unit === u).t, t1 = h.hooksOf('skillEnd').find((c) => c.unit === u).t;
    assert.equal(h.hooksOf('attack').filter((c) => c.attacker === u && c.t >= t0 && c.t < t1).length, 0, 'no normal attack while it runs');
    const loss = h.hooksOf('damaged').filter((c) => c.target === u && has(c, 'ifritScorch'));
    assert.equal(loss.length, Math.round(s.duration));
    for (const c of loss) assert.ok(near(c.amount, maxHp * bb.hp_ratio));
    assert.ok(near(u.hp, maxHp * (1 - bb.hp_ratio * Math.round(s.duration))), `HP ${u.hp}`);
    h.run(2);
    assert.ok(near(e.s.res, 30 * (1 + mr)), 'the S3 RES cut lapses after the skill');
    assert.ok(h.hooksOf('attack').some((c) => c.attacker === u && c.t >= t1), 'attacks again once it ends');
    done(h);
  }
});

test('伊芙利特 T1 精神融解: enemies on her range RES ×(1 + magic_resistance); not off her range; strongest of two copies', () => {
  const mr = talOf(ID6, 0).magic_resistance;
  // both copies cover (10, 8): the normal from (10, 4), the elite from (10, 3)
  const h = run({ units: [U(ID6, 'skchr_ifrit_1', 10, 4), U(ELITE6, 'skchr_ifrit_1', 10, 3, { uid: 2 })],
    enemies: [{ key: 'enemy_res', pos: [10, 8] }, { key: 'enemy_res', pos: [12, 8] }, { key: 'enemy_fly_res', pos: [10, 6] }] });
  h.run(1);
  const [inRange, off] = h.b.enemies.filter((e) => e.defId === 'enemy_res');
  assert.ok(near(inRange.s.res, 30 * (1 + mr)), `in range ${inRange.s.res}`);
  assert.ok(near(h.enemy('enemy_fly_res').s.res, 30 * (1 + mr)), 'a flyer on her range too');
  assert.equal(off.s.res, 30, 'off both ranges');
  assert.equal(inRange.buffs.filter((b) => b.key === 'ifrit:meltdown').length, 1, 'one instance (同名效果取最高)');
  done(h);
});

test('伊芙利特 T2 莱茵回路: +sp SP every interval s; elite BLA-X: a prob roll for +dice sp at each interval; none without it', () => {
  const sp = (id, moduleId, forced) => {
    const calls = [];
    const h = run({ units: [U(id, 'skchr_ifrit_1', 10, 4, { carryState: { sp: 0 }, ...(moduleId !== undefined ? { moduleId } : {}) })],
      setup: forced == null ? undefined : (b) => { b.rng.chance = (p) => { calls.push(p); return forced; }; } });
    h.run(19);
    const u = h.unit(id);
    return { gains: h.hooksOf('spGain').filter((c) => c.unit === u && c.reason === 'talent').map((c) => [Math.round(c.t), c.amount]), calls };
  };
  const t = talOf(ID6, 1);
  assert.deepEqual(sp(ID6).gains, [[6, t.sp], [12, t.sp], [18, t.sp]]);
  for (const E of ELITES) {
    const te = talOf(E, 1);
    const dice = te['ifrit_e_002[dice_sp].sp'], prob = te['ifrit_e_002[dice_sp].prob'];
    const base = [[6, te.sp], [12, te.sp], [18, te.sp]];
    const hit = sp(E, null, true);
    if (dice > 0 && prob > 0) { // BLA-X with its talent upgrade (level ≥ 2)
      assert.deepEqual(hit.gains, [[6, te.sp], [6, dice], [12, te.sp], [12, dice], [18, te.sp], [18, dice]], E);
      assert.deepEqual(hit.calls, [prob, prob, prob]);
      assert.deepEqual(sp(E, null, false).gains, base);
    } else { // a module level without the upgrade: no roll at all
      assert.deepEqual(hit.gains, base, E);
      assert.deepEqual(hit.calls, []);
    }
    const none = sp(E, 'none', true);
    assert.deepEqual(none.gains, base);
    assert.deepEqual(none.calls, [], 'no dice without BLA-X');
    assert.deepEqual(sp(E, BLA_D, true).calls, [], 'no dice with BLA-D');
  }
});

test('伊芙利特 module BLA-X: attack damage ×(1 + damage_scale × distance share); module none / BLA-D: flat', () => {
  const dmgBy = (E, moduleId) => {
    const h = run({ units: [U(E, 'skchr_ifrit_1', 10, 4, moduleId !== undefined ? { moduleId } : {})],
      enemies: [{ key: 'enemy_dummy', pos: [10, 4] }, { key: 'enemy_dummy', pos: [10, 6] }, { key: 'enemy_dummy', pos: [10, 9] }] });
    const u = h.unit(E);
    assert.ok(h.runUntil(() => h.hooksOf('attack').some((c) => c.attacker === u), 5));
    const first = h.hooksOf('damaged').filter((c) => c.source === u && c.dmg.isAttack && c.type === 'arts');
    done(h);
    return { u, dist: first.map((c) => [Math.round(c.target.x - u.x), c.amount]).sort((a, b) => a[0] - b[0]) };
  };
  for (const E of ELITES) {
    const tb = traitOf(E);
    assert.ok(tb.damage_scale > 0, `${E}: BLA-X trait part`);
    const x = dmgBy(E, null);
    for (const [d, amount] of x.dist) {
      const share = Math.max(0, Math.min(1, (d - tb.min_dist) / (tb.max_dist - tb.min_dist)));
      assert.ok(near(amount, x.u.s.atk * (1 + tb.damage_scale * share)), `${E} d=${d}: ${amount}`);
    }
    assert.deepEqual(x.dist.map(([d]) => d), [0, 2, 5]);
    for (const m of ['none', BLA_D]) {
      const y = dmgBy(E, m);
      for (const [, amount] of y.dist) assert.ok(near(amount, y.u.s.atk), `${E} ${m}: ${amount}`);
    }
  }
});

test('伊芙利特 module BLA-D: arts damage adds ep_damage_ratio of it as 灼燃损伤; an attack on a burst target adds 元素伤害', () => {
  for (const E of ELITES) {
  const tb = traitOf(E, BLA_D), el = talOf(E, -1, BLA_D).element_atk_scale ?? 0;
  assert.ok(tb.ep_damage_ratio > 0, `${E}: BLA-D trait part`);
  const h = run({ units: [U(E, 'skchr_ifrit_1', 10, 4, { moduleId: BLA_D })], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
  const u = h.unit(E);
  assert.ok(h.runUntil(() => h.hooksOf('attack').some((c) => c.attacker === u), 5));
  const e = h.enemy('enemy_dummy');
  const hit = h.hooksOf('damaged').find((c) => c.source === u && c.type === 'arts');
  const fill = h.hooksOf('damaged').find((c) => c.source === u && c.type === 'element');
  assert.ok(near(fill.amount, hit.amount * tb.ep_damage_ratio), `fill ${fill.amount} of ${hit.amount}`);
  assert.equal(fill.dmg.element, 'burn');
  assert.ok(has(fill, 'ifritBlaD'));
  assert.equal(h.hooksOf('damaged').filter((c) => c.source === u && has(c, 'ifritMelt')).length, 0, 'no bonus outside a burst');
  // one hit short of the gauge: the next attack bursts it (no bonus on that hit), the attacks during the burst add 元素伤害
  e.elem.burn = e.gaugeMax - 1;
  assert.ok(h.runUntil(() => h.hooksOf('elementBurst').length > 0, 10), 'bursts');
  const tBurst = h.hooksOf('elementBurst')[0].t;
  h.run(5);
  const atks = h.hooksOf('attack').filter((c) => c.attacker === u && c.t > tBurst + 1e-6).length;
  const bonus = h.hooksOf('damaged').filter((c) => c.source === u && has(c, 'ifritMelt'));
  assert.ok(atks >= 1, 'attacks during the burst');
  // the talent upgrade (hidden part element_atk_scale) exists from module level 2 on: none at level 1
  assert.equal(bonus.length, el > 0 ? atks : 0, `${E}: ${bonus.length} bonus / ${atks} attacks`);
  for (const c of bonus) { assert.equal(c.type, 'elemental'); assert.ok(near(c.amount, u.s.atk * el)); }
  done(h);
  // the default module (BLA-X) fills no gauge
  const g = run({ units: [U(E, 'skchr_ifrit_1', 10, 4)], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
  g.run(6);
  assert.equal(g.enemy('enemy_dummy').elem.burn, 0);
  done(g);
  }
});

test('伊芙利特 T2: counted from each deployment (retreat 10 s, redeploy 11 s ⇒ 17 / 23 / 29 s); none while S1 runs, no dice roll then', () => {
  const t = talOf(ID6, 1);
  const h = run({ units: [U(ID6, 'skchr_ifrit_1', 10, 4, { carryState: { sp: 0 } })] });
  const u = h.unit(ID6);
  h.run(10);
  h.b.retreat(u);
  h.run(1);
  assert.ok(h.b.redeploy(u), 'redeploys at 11 s');
  h.run(19);
  assert.deepEqual(h.hooksOf('spGain').filter((c) => c.unit === u && c.reason === 'talent').map((c) => [Math.round(c.t), c.amount]),
    [[6, t.sp], [17, t.sp], [23, t.sp], [29, t.sp]]);
  done(h);
  for (const id of [ID6, ...ELITES]) {
    const te = talOf(id, 1), calls = [];
    const g = run({ units: [U(id, 'skchr_ifrit_1', 10, 4, { carryState: READY })], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }],
      setup: (b) => { b.rng.chance = (p) => { calls.push(b.time); return true; }; } });
    const v = g.unit(id);
    g.run(25);
    const t0 = g.hooksOf('skillStart').find((c) => c.unit === v).t, t1 = g.hooksOf('skillEnd').find((c) => c.unit === v).t;
    const gains = g.hooksOf('spGain').filter((c) => c.unit === v && c.reason === 'talent');
    assert.ok(t0 < 1 && t1 > 19, 'S1 runs 0–20 s');
    assert.ok(gains.length >= 1 && gains.every((c) => c.t > t1), `${id}: no talent SP while S1 runs`);
    assert.ok(calls.every((x) => x > t1), `${id}: no dice roll while S1 runs`);
    assert.equal(calls.length, te['ifrit_e_002[dice_sp].prob'] > 0 ? 1 : 0, 'one roll, at 24 s');
    done(g);
  }
});

test('伊芙利特 S3: the cast tick lands before its RES cut, the next one after it (BLA-X does not scale the ticks)', () => {
  for (const id of [ID6, ...ELITES]) { // elites with their default module BLA-X: the target stands 4 tiles away (×1.1 on attacks)
    const s = skillOf(id, 'skchr_ifrit_3'), bb = s.bb, mr = talOf(id, 0).magic_resistance;
    // SP 2 short: the cast comes at her next attack, once 精神融解 holds the target
    const h = run({ units: [U(id, 'skchr_ifrit_3', 10, 4, { carryState: { sp: s.spCost - 2 } })], enemies: [{ key: 'enemy_res', pos: [10, 8] }] });
    const u = h.unit(id);
    assert.ok(h.runUntil(() => u.skill.active, 10));
    assert.ok(h.b.time > 1, 'cast after the aura applied');
    h.run(1.5);
    const e = h.enemy('enemy_res');
    const ticks = h.hooksOf('damaged').filter((c) => c.source === u && c.target === e && has(c, 'ifritScorch'));
    assert.equal(ticks.length, 2);
    assert.ok(near(ticks[0].amount, u.s.atk * bb.atk_scale * (1 - (30 * (1 + mr)) / 100)), `tick 0 ${ticks[0].amount}`);
    assert.ok(near(ticks[1].amount, u.s.atk * bb.atk_scale * (1 - ((30 + bb.magic_resistance) * (1 + mr)) / 100)), `tick 1 ${ticks[1].amount}`);
    done(h);
  }
});

test('伊芙利特 S2: a re-hit keeps the burn cadence, runs `duration` again and burns with the ATK of the new hit', () => {
  const bb = skillOf(ID6, 'skchr_ifrit_2').bb;
  const h = run({ units: [U(ID6, 'skchr_ifrit_2', 10, 4, { carryState: READY })], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
  const u = h.unit(ID6);
  const atks = () => h.hooksOf('attack').filter((c) => c.attacker === u);
  assert.ok(h.runUntil(() => atks().length >= 1, 5));
  const t0 = atks()[0].t, atk0 = u.s.atk;
  h.b.addBuff(u, { key: 'test:atk', mods: { atkPct: 1 } });
  assert.ok(h.runUntil(() => atks().length >= 2, 5));
  const t1 = atks()[1].t, atk1 = u.s.atk;
  assert.ok(atks()[1].isSkill && t1 - t0 < bb.duration, 'the second charge re-hits within the burn');
  h.run(bb.duration + 0.5);
  const e = h.enemy('enemy_dummy');
  const ticks = h.hooksOf('damaged').filter((c) => c.source === u && has(c, 'ifritBurn'));
  assert.deepEqual(ticks.map((c) => Math.round(c.t - t0)), [1, 2, 3, 4, 5], 'one per second from the first hit, until t1 + duration');
  assert.ok(ticks.every((c) => c.t < t1 + bb.duration));
  for (const c of ticks) assert.ok(near(c.amount, (c.t < t1 ? atk0 : atk1) * bb['burn.atk_scale']), `${(c.t - t0).toFixed(2)}: ${c.amount}`);
  assert.equal(e.findBuff(`ifrit:burn:${u.id}`), null);
  done(h);
});

test('伊芙利特 S2 灼烧 / S3 灼地 ticks are DoT: tagged dot, never dodged', () => {
  for (const sid of ['skchr_ifrit_2', 'skchr_ifrit_3']) {
    const s = skillOf(ID6, sid);
    const h = run({ units: [U(ID6, sid, 10, 4, { carryState: { sp: s.spCost } })], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
    const u = h.unit(ID6);
    assert.ok(h.runUntil(() => u.skill.activations === 1, 5));
    h.b.addBuff(h.enemy('enemy_dummy'), { key: 'test:dodge', mods: { dodgeArts: 1 } }); // dodges every dodgeable arts damage from now on
    const t0 = h.b.time;
    h.run(3.5);
    const ticks = h.hooksOf('damaged').filter((c) => c.source === u && c.target.side === 'enemy' && c.t >= t0 && has(c, sid === 'skchr_ifrit_2' ? 'ifritBurn' : 'ifritScorch'));
    assert.equal(ticks.length, 3, sid);
    assert.ok(ticks.every((c) => c.amount > 0 && has(c, 'dot') && c.dmg.canDodge === false));
    done(h);
  }
});

test('伊芙利特 BLA-X × S2: the distance bonus scales the empowered attack, not its 灼烧 ticks', () => {
  for (const E of ELITES) {
    const s = skillOf(E, 'skchr_ifrit_2'), bb = s.bb, tb = traitOf(E);
    const h = run({ units: [U(E, 'skchr_ifrit_2', 10, 4, { carryState: { sp: s.spCost } })], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
    const u = h.unit(E);
    assert.ok(h.runUntil(() => u.skill.activations === 1, 5));
    h.run(3.5);
    const hit = h.hooksOf('damaged').find((c) => c.source === u && c.dmg.isAttack && c.dmg.isSkill);
    const share = (2 - tb.min_dist) / (tb.max_dist - tb.min_dist);
    assert.ok(near(hit.amount, u.s.atk * bb.atk_scale * (1 + tb.damage_scale * share)), `hit ${hit.amount}`);
    const ticks = h.hooksOf('damaged').filter((c) => c.source === u && has(c, 'ifritBurn'));
    assert.equal(ticks.length, 3);
    for (const c of ticks) assert.ok(near(c.amount, u.s.atk * bb['burn.atk_scale']), `tick ${c.amount}`);
    done(h);
  }
});

test('伊芙利特 BLA-D × S2 / S3: every arts damage fills (hit, 灼烧, 灼地); the burst bonus needs an attack on a target with HP left', () => {
  for (const E of ELITES) {
    const ep = traitOf(E, BLA_D).ep_damage_ratio, el = talOf(E, -1, BLA_D).element_atk_scale ?? 0;
    // S2: the hit and every burn tick
    const s2 = skillOf(E, 'skchr_ifrit_2');
    const h = run({ units: [U(E, 'skchr_ifrit_2', 10, 4, { carryState: { sp: s2.spCost }, moduleId: BLA_D })], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
    const u = h.unit(E);
    assert.ok(h.runUntil(() => u.skill.activations === 1, 5));
    h.run(3.5);
    const arts = h.hooksOf('damaged').filter((c) => c.source === u && c.type === 'arts');
    const fills = h.hooksOf('damaged').filter((c) => c.source === u && has(c, 'ifritBlaD'));
    assert.ok(arts.some((c) => has(c, 'ifritBurn')) && arts.some((c) => c.dmg.isSkill && c.dmg.isAttack));
    assert.equal(fills.length, arts.length);
    fills.forEach((f, i) => assert.ok(near(f.amount, arts[i].amount * ep), `fill ${i}`));
    done(h);
    // S3: its ticks fill; during a burst they add no 元素伤害 (not an attack)
    const g = run({ units: [U(E, 'skchr_ifrit_3', 10, 4, { carryState: READY, moduleId: BLA_D })], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
    const v = g.unit(E);
    assert.ok(g.runUntil(() => v.skill.active, 5));
    g.run(1.5);
    const e = g.enemy('enemy_dummy');
    const t3 = g.hooksOf('damaged').filter((c) => c.source === v && c.target === e && has(c, 'ifritScorch')); // (not her 流失)
    const f3 = g.hooksOf('damaged').filter((c) => c.source === v && has(c, 'ifritBlaD'));
    assert.ok(t3.length === 2 && f3.length === 2 && f3.every((f, i) => near(f.amount, t3[i].amount * ep)));
    e.elem.burn = e.gaugeMax - 1;
    assert.ok(g.runUntil(() => g.hooksOf('elementBurst').length > 0, 3), 'a tick bursts it');
    g.run(3);
    assert.ok(v.skill.active && e.findBuff('burnBurst'));
    assert.equal(g.hooksOf('damaged').filter((c) => c.source === v && has(c, 'ifritMelt')).length, 0, 'no bonus on S3 ticks');
    done(g);
    if (!(el > 0)) continue;
    // a killing attack on a burst target adds nothing (no 元素伤害 on a target without HP)
    const k = run({ units: [U(E, 'skchr_ifrit_1', 10, 4, { moduleId: BLA_D })], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
    const w = k.unit(E);
    k.step(1);
    const d = k.enemy('enemy_dummy');
    d.elem.burn = d.gaugeMax - 1;
    assert.ok(k.runUntil(() => d.findBuff('burnBurst'), 5));
    assert.ok(k.runUntil(() => k.hooksOf('damaged').some((c) => c.source === w && has(c, 'ifritMelt')), 5), 'a bonus while it lives');
    d.hp = 1;
    assert.ok(k.runUntil(() => !d.alive, 5));
    const tk = k.hooksOf('damaged').filter((c) => c.source === w && c.target === d && c.dmg.isAttack).at(-1).t;
    assert.equal(k.hooksOf('damaged').filter((c) => c.source === w && has(c, 'ifritMelt') && c.t >= tk).length, 0, 'none on the killing attack');
    done(k);
  }
});

test('伊芙利特: every skill × tier survives a real wave without content errors and casts', () => {
  for (const id of [ID5, ID6, ID5.replace(/_a$/, '_b'), ELITE6]) {
    for (const s of rec(id).skills) {
      const h = makeBattle({ defs: DEFS, seed: 3, timeLimit: 60,
        units: [U(id, s.skillId, 10, 4, { carryState: READY }), { chessId: 'chess_char_2_06_a', row: 10, col: 6 }],
        enemies: [{ key: 'enemy_1007_slime', count: 8, interval: 1.5 }, { key: 'enemy_1007_slime', route: 1, count: 8, interval: 1.5, time: 3 }] });
      h.runToEnd(90);
      done(h);
      assert.ok(h.b.allyUnits.find((x) => x.defId === id).skill.activations > 0, `${id} ${s.skillId} casts`);
    }
  }
});
