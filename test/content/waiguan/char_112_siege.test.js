// test/content/waiguan/char_112_siege.test.js — 推进之王 外援 kit (server/sim/content/kits/waiguan/char_112_siege.js).
// Every skill (normal Lv4 + elite Lv7), the DP of each (the player's DP before / after, natural regen off), the trigger
// rules and their timing, both talents (万兽之王 incl. SOL-X's own extra, 粉碎 incl. SOL-Y's gift), every module of both
// tiers' elites × every skill, two copies, two players on one field, a smoke wave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, chessRec, checkInvariants } from '../../helpers/battleHarness.js';
import { DataSource, getDefaultSource } from '../../../server/sim/simdata.js';
import { getData } from '../../../server/data.js';
import { waiguanRecords } from '../../../shared/waiguan.js';
import { skillSpecSource } from '../../../server/sim/content/index.js';
import { TICK } from '../../../server/sim/constants.js';
import WAIGUAN from '../../../server/sim/content/kits/waiguan/index.js';

const CHAR = 'char_112_siege';
const ID5 = `chess_char_diy_5_${CHAR}_a`, ID6 = `chess_char_diy_6_${CHAR}_a`;
const ELITE5 = ID5.replace(/_a$/, '_b'), ELITE6 = ID6.replace(/_a$/, '_b');
const ELITES = [ELITE5, ELITE6];
const SOL_X = 'uniequip_002_siege', SOL_Y = 'uniequip_003_siege';
const S1 = 'skcom_charge_cost[3]', S2 = 'skchr_siege_2', S3 = 'skchr_siege_3';
const LORD = 'siege:lord', LORD_SELF = 'siege:lordSelf';
const REC = waiguanRecords(getData({ log: { warn() {}, error() {}, info() {} } }).waiguan);
const DS = new DataSource({ chess: REC }, getDefaultSource());
const rec = (id) => REC[id];
const skillOf = (id, sid) => rec(id).skills.find((s) => s.skillId === sid);
/** Loadout-resolved record (module `moduleId`) and its talent blackboard by data index. */
const raw = (id, moduleId = null) => DS.getChess(id, { moduleId }).raw;
const talOf = (id, i, moduleId = null) => raw(id, moduleId).talents.find((t) => t.index === i)?.bb ?? {};
/** Every hidden module part (data index −1) of a loadout, merged — SOL-Y has two: runtime_cost and the gift's sp. */
const hiddenOf = (id, m = null) => Object.assign({}, ...raw(id, m).talents.filter((t) => t.index === -1).map((t) => t.bb));
const typeOf = (id, m) => (raw(id, m ?? null).module?.active ? raw(id, m ?? null).module.type : null);
/** 万兽之王's 先锋 part (the no-module talent) and SOL-X's own extra (its talent part for index 0) of a loadout. */
const lordOf = (id) => (rec(id).talentsBase ?? rec(id).talents).find((t) => t.index === 0).bb;
const selfOf = (id, m) => (typeOf(id, m) === 'SOL-X' ? (rec(id).modules.find((x) => x.uniEquipId === raw(id, m ?? null).module.id).talentChanges.find((c) => c.talentIndex === 0)?.bb ?? {}) : {});
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e7, speed: 0, ...o });
const ally = (id, profession, skill = null) => chessRec({ id, profession, stats: { maxHp: 5000, atk: 100, def: 100 }, skill: skill ? { spCost: 50, initSp: 0, duration: 5 } : null });
const DEFS = {
  chess: {
    ...REC,
    test_van_a: ally('test_van_a', 'PIONEER'),
    test_vansk_a: ally('test_vansk_a', 'PIONEER', true),
    test_guard_a: ally('test_guard_a', 'WARRIOR'),
  },
  enemies: {
    enemy_dummy: dummy('enemy_dummy', { def: 100 }),
    enemy_fly: dummy('enemy_fly', { def: 100, motion: 'FLY' }),
    enemy_walker: enemyRec({ key: 'enemy_walker', hp: 1e7, speed: 1, atk: 0, def: 0 }),
  },
};
const READY = { sp: 999 };
const NO_DP = { dpPerSec: 0 };
const HOOKS = ['damaged', 'skillStart', 'skillEnd', 'attack', 'spGain', 'kill', 'death', 'statusApplied'];
/** Battle with the 外援 records + synthetic allies / enemies, natural DP regen off unless `flags` say otherwise. */
const run = (o) => makeBattle({ defs: DEFS, seed: 7, timeLimit: 300, autoFinish: false, hooks: HOOKS, captureNoisy: true, flags: NO_DP, ...o });
/** Operator entry with skill `sid` selected (board coords: row 9–12, col 2–10); `moduleId` only for an elite. */
const U = (id, sid, row, col, o = {}) => ({ chessId: id, row, col, skillIndex: skillOf(id, sid).index, ...o });
const done = (h) => { checkInvariants(h.b); assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0])); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const dp = (h, pid = 'p1') => h.b.getPlayer(pid).dp;
const phys = (a, d) => Math.max(a - d, 0.05 * a);
const ALL = [[ID5, undefined], [ID6, undefined], ...ELITES.flatMap((E) => [null, 'none', SOL_X, SOL_Y].map((m) => [E, m]))];
const opt = (m) => (m === undefined ? {} : { moduleId: m });
const talentSp = (h, u) => h.hooksOf('spGain').filter((c) => c.unit === u && c.reason === 'talent').map((c) => c.amount);
/** Step until `pred()`; returns the DP of `pid` right before the step that made it true. */
function dpBefore(h, pred, maxS = 30, pid = 'p1') {
  let prev = dp(h, pid);
  const lim = h.b.time + maxS;
  while (!pred() && h.b.time < lim) { prev = dp(h, pid); h.step(); }
  assert.ok(pred(), 'condition reached');
  return prev;
}

test('推进之王: every skill of both tiers (normal + elite, every module) is hand-authored', () => {
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

test('推进之王: rules — S1 SP_FULL (record DEFAULT changed: AUTO DP skill), S2 / S3 DEFAULT kept; kinds and charges from the record', () => {
  for (const id of [ID5, ID6, ELITE5, ELITE6]) {
    assert.equal(skillOf(id, S1).trigger.rule, 'DEFAULT');
    const want = { [S1]: ['SP_FULL', 'instant', 1, false], [S2]: ['DEFAULT', 'charges', skillOf(id, S2).maxChargeTime, false], [S3]: ['DEFAULT', 'duration', 1, true] };
    for (const [sid, [rule, kind, charges, manual]] of Object.entries(want)) {
      const h = run({ units: [U(id, sid, 9, 4)] });
      h.step(1);
      const u = h.unit(id);
      assert.equal(u.kit.skillSource, 'skills');
      assert.equal(u.skill.rule, rule, `${id} ${sid}`);
      assert.equal(u.skill.kind, kind);
      assert.equal(u.skill.maxCharges, charges);
      assert.equal(u.skill.manual, manual);
      done(h);
    }
  }
  assert.deepEqual([skillOf(ID6, S2).maxChargeTime, skillOf(ELITE6, S2).maxChargeTime], [2, 3]);
});

test('推进之王 S1 冲锋号令·γ型: +cost DP the moment SP is full, no enemy needed; next cast one spCost later; capped at dpMax', () => {
  for (const id of [ID5, ID6, ELITE5, ELITE6]) {
    const s = skillOf(id, S1);
    const h = run({ units: [U(id, S1, 9, 4)] });
    const u = h.unit(id);
    const before = dpBefore(h, () => u.skill.activations === 1, 60);
    assert.equal(dp(h) - before, s.bb.cost, `${id}: +${s.bb.cost}`);
    const t1 = h.hooksOf('skillStart')[0].t;
    assert.ok(Math.abs(t1 - (s.spCost - s.initSp)) <= 2 * TICK, `${id}: cast when ready (${t1})`);
    const b2 = dpBefore(h, () => u.skill.activations === 2, 60);
    assert.equal(dp(h) - b2, s.bb.cost);
    assert.ok(Math.abs(h.hooksOf('skillStart')[1].t - t1 - s.spCost) <= 2 * TICK, 'one spCost of time SP later');
    assert.equal(h.b.enemies.length, 0, 'no enemy on the field');
    done(h);
  }
  const g = run({ units: [U(ID6, S1, 9, 4, { carryState: READY })], flags: { dpPerSec: 0, dpInit: 95 } });
  g.step(2);
  assert.equal(g.unit(ID6).skill.activations, 1);
  assert.equal(dp(g), g.b.flags.dpMax, 'capped');
  done(g);
});

test('推进之王 S2 跃空锤: the next attacks (one per charge, back to back) strike every ground enemy of the cross for atk_scale × ATK, +cost DP each', () => {
  for (const [id, m] of [[ID6, undefined], [ELITE6, 'none']]) {
    const s = skillOf(id, S2);
    // the cross from (10, 5) facing right: (10, 4..6), (9, 5), (11, 5); off it: (9, 6) and (10, 7); a flyer in front
    const h = run({ units: [U(id, S2, 10, 5, { carryState: READY, ...opt(m) })],
      enemies: [[10, 6], [10, 4], [9, 5], [11, 5], [9, 6], [10, 7]].map((pos) => ({ key: 'enemy_dummy', pos })).concat([{ key: 'enemy_fly', pos: [10, 6] }]) });
    h.step(1);
    const u = h.unit(id);
    const inCross = h.b.enemies.filter((e) => e.defId === 'enemy_dummy' && (Math.round(e.y) === 10 ? Math.abs(Math.round(e.x) - 5) <= 1 : Math.round(e.x) === 5));
    assert.equal(inCross.length, 4);
    const casts = h.hooksOf('skillStart');
    assert.equal(casts.length, 1, 'cast at her first attack');
    assert.equal(casts[0].reason, 'DEFAULT');
    assert.equal(dp(h) - h.b.flags.dpInit, s.bb.cost, '+cost on that attack');
    const atk1 = h.hooksOf('attack').find((c) => c.attacker === u);
    assert.equal(atk1.isSkill, true);
    assert.deepEqual(new Set(atk1.targets), new Set(inCross), 'every ground enemy of the cross — no flyer, nothing off it');
    const A = u.s.atk;
    const d1 = h.hooksOf('damaged').filter((c) => c.source === u && c.t === atk1.t);
    assert.equal(d1.length, 4);
    for (const c of d1) assert.ok(near(c.amount, phys(A * s.bb.atk_scale, 100)) && c.type === 'phys', `${c.amount}`);
    // the other charges: the next attacks, an attack interval apart (AUTO: no operation cooldown)
    let prev = dp(h);
    for (let k = 2; k <= s.maxChargeTime; k++) {
      prev = dpBefore(h, () => h.hooksOf('skillStart').length === k, 3);
      assert.equal(dp(h) - prev, s.bb.cost);
      assert.ok(Math.abs(h.hooksOf('skillStart')[k - 1].t - h.hooksOf('skillStart')[k - 2].t - u.s.interval) <= 2 * TICK, 'back to back');
    }
    assert.equal(u.skill.charges, 0);
    h.run(u.s.interval + 0.1);
    const plain = h.hooksOf('attack').filter((c) => c.attacker === u).at(-1);
    assert.equal(plain.isSkill, false);
    assert.equal(plain.targets.length, 1, 'then a normal attack');
    assert.equal(dp(h) - h.b.flags.dpInit, s.maxChargeTime * s.bb.cost, 'cost per charge, nothing on a normal attack');
    done(h);
  }
});

test('推进之王 S3 碎颅击: interval +base_attack_time, attacks at attack@atk_scale × ATK, each hit stuns attack@stun s with chance attack@buff_prob; no DP', () => {
  for (const [id, m] of [[ID6, undefined], [ELITE6, 'none']]) {
    const s = skillOf(id, S3), bb = s.bb;
    for (const roll of [true, false]) {
      const h = run({ units: [U(id, S3, 9, 4, { carryState: READY, ...opt(m) })], enemies: [{ key: 'enemy_dummy', pos: [9, 5] }] });
      const asked = [];
      h.b.rng.chance = (p) => { asked.push(p); return roll; };
      h.step(1);
      const u = h.unit(id), e = h.enemy('enemy_dummy');
      assert.ok(u.skill.active, 'DEFAULT: cast at her first attack');
      assert.ok(near(u.s.interval, u.base.bat + bb.base_attack_time), `interval ${u.s.interval}`);
      h.run(8);
      const atk = h.hooksOf('attack').filter((c) => c.attacker === u);
      assert.ok(atk.length >= 3 && atk.every((c) => c.isSkill));
      for (const c of h.hooksOf('damaged').filter((x) => x.source === u)) assert.ok(near(c.amount, phys(u.s.atk * bb['attack@atk_scale'], 100)));
      assert.deepEqual(asked, atk.map(() => bb['attack@buff_prob']), 'one roll per hit at attack@buff_prob');
      const st = h.hooksOf('statusApplied').filter((c) => c.source === u && c.status === 'stun');
      assert.equal(st.length, roll ? atk.length : 0);
      for (const c of st) { assert.equal(c.target, e); assert.ok(near(c.duration, bb['attack@stun'])); }
      assert.equal(dp(h), h.b.flags.dpInit, 'no DP');
      done(h);
    }
  }
});

test('推进之王 T1 万兽之王: every 先锋 operator of her player ATK/DEF +8 % (herself too, persist); SOL-X level 3: herself +8 % more; others not', () => {
  for (const [id, m] of ALL) {
    const lord = lordOf(id), self = selfOf(id, m);
    assert.equal(self.atk > 0, id === ELITE6 && (m === null || m === SOL_X), `${id} ${m}: SOL-X level 3 only`);
    const h = run({ units: [U(id, S1, 9, 4, opt(m)), { chessId: 'test_van_a', row: 10, col: 4 }, { chessId: 'test_guard_a', row: 11, col: 4 }] });
    h.step(1);
    const u = h.unit(id), van = h.unit('test_van_a'), guard = h.unit('test_guard_a');
    assert.ok(near(van.s.atk, van.base.atk * (1 + lord.atk)) && near(van.s.def, van.base.def * (1 + lord.def)), `${id} ${m}: 先锋`);
    assert.ok(guard.s.atk === guard.base.atk && guard.s.def === guard.base.def, 'not a 先锋');
    assert.ok(near(u.s.atk, u.base.atk * (1 + lord.atk + (self.atk ?? 0))), `${id} ${m}: herself ${u.s.atk}`);
    assert.ok(near(u.s.def, u.base.def * (1 + lord.def + (self.def ?? 0))));
    assert.equal(van.findBuff(LORD).persist, true);
    // whether she is on the field or not; kept through the 先锋's knock-out
    h.b.kill(u);
    h.b.kill(van);
    assert.ok(h.b.redeploy(van));
    assert.ok(near(van.s.atk, van.base.atk * (1 + lord.atk)));
    done(h);
  }
});

test('推进之王 T1: two copies — one 万兽之王 per 先锋; two players on one field — her player\'s 先锋 only', () => {
  const h = run({ units: [U(ID5, S1, 9, 4, { uid: 1, carryState: READY }), U(ELITE6, S1, 9, 6, { uid: 2, carryState: READY }), { chessId: 'test_van_a', row: 10, col: 4, uid: 3 }] });
  h.step(1);
  const van = h.unit(3), a = h.unit(1), b = h.unit(2);
  assert.equal(dp(h), h.b.flags.dpInit + skillOf(ID5, S1).bb.cost + skillOf(ELITE6, S1).bb.cost, 'both S1 casts: +cost each to the same player');
  for (const x of [van, a, b]) {
    assert.equal(x.buffs.filter((y) => y.key === LORD).length, 1, `${x.defId}: once`);
    assert.equal(x.findBuff(LORD).source, a, 'equal strength: the first copy\'s holds, never overwritten');
  }
  assert.ok(near(van.s.atk, van.base.atk * (1 + lordOf(ID5).atk)));
  assert.ok(near(b.s.atk, b.base.atk * (1 + lordOf(ELITE6).atk + selfOf(ELITE6, null).atk)), 'the SOL-X extra is her own');
  assert.ok(near(a.s.atk, a.base.atk * (1 + lordOf(ID5).atk)));
  done(h);
  // she plays for p2; p1's 先锋 shares the field
  const players = [
    { playerId: 'p1', seat: 0, side: 'L', colOffset: 0, bonds: {}, units: [{ uid: 3, kind: 'chess', chessId: 'test_van_a', row: 10, col: 4 }] },
    { playerId: 'p2', seat: 1, side: 'L', colOffset: 8, bonds: {}, units: [{ uid: 1, kind: 'chess', chessId: ID6, skillIndex: skillOf(ID6, S1).index, row: 9, col: 4, carryState: READY }, { uid: 2, kind: 'chess', chessId: 'test_van_a', row: 10, col: 4 }] },
  ];
  const g = run({ kind: 'unite', players });
  g.step(1);
  const mine = g.unit(2), theirs = g.unit(3);
  assert.equal(g.unit(1).ownerId, 'p2');
  assert.equal(theirs.ownerId, 'p1');
  assert.equal(dp(g, 'p2'), g.b.flags.dpInit + skillOf(ID6, S1).bb.cost, 'her S1: p2');
  assert.equal(dp(g, 'p1'), g.b.flags.dpInit, 'p1 untouched');
  assert.ok(mine.alive && theirs.alive && theirs.deployed);
  assert.ok(near(mine.s.atk, mine.base.atk * (1 + lordOf(ID6).atk)));
  assert.equal(theirs.s.atk, theirs.base.atk, 'a teammate\'s 先锋: not hers');
  assert.equal(theirs.findBuff(LORD), null);
  done(g);
});

test('推进之王 T2 粉碎: an enemy falling on her cross (her tile + the four around) gives her sp SP — any killer; not off it, not while S3 runs, not while she is off the field', () => {
  for (const [id, m] of [[ID6, undefined], [ELITE6, 'none'], [ELITE6, SOL_X], [ELITE5, SOL_Y]]) {
    const sp = talOf(id, 1, m ?? null).sp;
    const h = run({ units: [U(id, S1, 10, 5, opt(m)), { chessId: 'test_vansk_a', row: 12, col: 8 }],
      enemies: [[10, 6], [9, 5], [9, 6], [10, 7], [11, 5], [10, 4]].map((pos) => ({ key: 'enemy_dummy', pos })) });
    h.step(1);
    const u = h.unit(id), van = h.unit('test_vansk_a');
    const at = (r, c) => h.b.enemies.find((e) => e.alive && Math.round(e.y) === r && Math.round(e.x) === c);
    h.b.kill(at(10, 6), null);
    assert.deepEqual(talentSp(h, u), [sp], `${id} ${m}: front`);
    h.b.kill(at(9, 6), null);
    h.b.kill(at(10, 7), null);
    assert.deepEqual(talentSp(h, u), [sp], 'off the cross: nothing');
    h.b.dealDamage(van, at(9, 5), { amount: 1e8, type: 'true' });
    assert.deepEqual(talentSp(h, u), [sp, sp], 'killed by another unit');
    assert.deepEqual(talentSp(h, van), [], 'no gift without SOL-Y level 2+');
    h.b.kill(u);
    h.b.kill(at(11, 5), null);
    assert.deepEqual(talentSp(h, u), [sp, sp], 'not while she is off the field');
    done(h);
  }
  // while S3 runs the SP is lost (the engine's rule)
  const h = run({ units: [U(ID6, S3, 10, 5, { carryState: READY })], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }, { key: 'enemy_dummy', pos: [11, 5] }] });
  h.step(1);
  const u = h.unit(ID6);
  assert.ok(u.skill.active);
  h.b.kill(h.b.enemies.find((e) => Math.round(e.y) === 11), null);
  assert.deepEqual(talentSp(h, u), []);
  done(h);
});

test('推进之王 module SOL-Y (level 3): 粉碎 +sp from the module; one random OTHER 先锋 operator of her player on the field +1 SP (battle RNG); level 1: neither', () => {
  const sp = talOf(ELITE6, 1, SOL_Y).sp, gift = hiddenOf(ELITE6, SOL_Y).sp;
  assert.ok(sp > talOf(ELITE6, 1, 'none').sp && gift > 0);
  // one other 先锋 (and a guard, a teammate-free field): it always gets the gift
  const h = run({ units: [U(ELITE6, S1, 10, 5, { moduleId: SOL_Y }), { chessId: 'test_vansk_a', row: 12, col: 8, uid: 7 }, { chessId: 'test_guard_a', row: 12, col: 7, uid: 8 }],
    enemies: [{ key: 'enemy_dummy', pos: [10, 6] }, { key: 'enemy_dummy', pos: [11, 5] }] });
  h.step(1);
  const u = h.unit(ELITE6), van = h.unit(7);
  const draws = [];
  const pick = h.b.rng.pick;
  h.b.rng.pick = (arr) => { draws.push(arr.length); return pick(arr); };
  h.b.kill(h.b.enemies[0], null);
  assert.deepEqual(talentSp(h, u), [sp], 'herself: the module\'s sp, no gift');
  assert.deepEqual(talentSp(h, van), [gift], 'the other 先锋');
  assert.deepEqual(draws, [], 'no draw with one candidate');
  assert.deepEqual(talentSp(h, h.unit(8)), []);
  done(h);
  // two other 先锋: exactly one gets it, drawn among the two
  const g = run({ units: [U(ELITE6, S1, 10, 5, { moduleId: SOL_Y }), { chessId: 'test_vansk_a', row: 12, col: 8, uid: 7 }, { chessId: 'test_vansk_a', row: 12, col: 9, uid: 8 }],
    enemies: [{ key: 'enemy_dummy', pos: [10, 6] }, { key: 'enemy_dummy', pos: [11, 5] }] });
  g.step(1);
  const gd = [];
  const gp = g.b.rng.pick;
  g.b.rng.pick = (arr) => { gd.push(arr.map((x) => x.uid)); return gp(arr); };
  g.b.kill(g.b.enemies[0], null);
  assert.deepEqual(gd, [[7, 8]]);
  assert.equal(talentSp(g, g.unit(7)).length + talentSp(g, g.unit(8)).length, 1);
  done(g);
  // tier V (module level 1): base sp, no gift
  const k = run({ units: [U(ELITE5, S1, 10, 5, { moduleId: SOL_Y }), { chessId: 'test_vansk_a', row: 12, col: 8, uid: 7 }], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
  k.step(1);
  k.b.kill(k.b.enemies[0], null);
  assert.deepEqual(talentSp(k, k.unit(ELITE5)), [talOf(ELITE5, 1, SOL_Y).sp]);
  assert.equal(talOf(ELITE5, 1, SOL_Y).sp, talOf(ID5, 1).sp);
  assert.deepEqual(talentSp(k, k.unit(7)), []);
  done(k);
});

test('推进之王 module SOL-Y gift: her player\'s 先锋 only (two players on one field); not one off the field', () => {
  const gift = hiddenOf(ELITE6, SOL_Y).sp;
  const players = [
    { playerId: 'p1', seat: 0, side: 'L', colOffset: 0, bonds: {}, units: [{ uid: 1, kind: 'chess', chessId: ELITE6, moduleId: SOL_Y, skillIndex: 0, row: 10, col: 5 }, { uid: 2, kind: 'chess', chessId: 'test_vansk_a', row: 12, col: 3 }] },
    { playerId: 'p2', seat: 1, side: 'L', colOffset: 8, bonds: {}, units: [{ uid: 3, kind: 'chess', chessId: 'test_vansk_a', row: 12, col: 3 }] },
  ];
  const h = run({ kind: 'unite', players, enemies: [{ key: 'enemy_dummy', pos: [10, 6] }, { key: 'enemy_dummy', pos: [11, 5] }] });
  h.step(1);
  const mine = h.unit(2), theirs = h.unit(3);
  assert.ok(theirs.alive && theirs.deployed && theirs.ownerId === 'p2');
  h.b.kill(h.b.enemies[0], null);
  assert.deepEqual(talentSp(h, mine), [gift]);
  assert.deepEqual(talentSp(h, theirs), [], 'a teammate\'s 先锋 is not hers');
  h.b.kill(mine);
  h.b.kill(h.b.enemies.find((e) => e.alive), null);
  assert.deepEqual(talentSp(h, theirs), [], 'still not with hers off the field');
  assert.deepEqual(talentSp(h, mine), [gift]);
  done(h);
});

test('推进之王 module SOL-X: ATK/DEF + while blocking (both tiers); none / SOL-Y: nothing', () => {
  for (const E of ELITES) for (const moduleId of [null, 'none', SOL_X, SOL_Y]) {
    const tb = raw(E, moduleId).trait.bb ?? {};
    const on = typeOf(E, moduleId) === 'SOL-X';
    assert.equal(tb.atk > 0, on, `${E} ${moduleId}`);
    const h = run({ units: [U(E, S1, 9, 4, { moduleId })], enemies: [{ key: 'enemy_walker', route: 0 }] });
    const u = h.unit(E);
    h.step(2);
    const free = u.s.atk, freeDef = u.s.def;
    assert.ok(h.runUntil(() => u.blocking.length > 0, 20));
    h.step(1);
    assert.ok(near(u.s.atk, free + u.base.atk * (on ? tb.atk : 0)), `${E} ${moduleId} ATK ${u.s.atk}`);
    assert.ok(near(u.s.def, freeDef + u.base.def * (on ? tb.def : 0)));
    done(h);
  }
});

test('推进之王 module SOL-Y "首次部署时部署费用-4": the initial deployment is free; a redeploy pays the full cost', () => {
  for (const E of ELITES) for (const moduleId of [SOL_Y, 'none', null]) {
    assert.equal(hiddenOf(E, moduleId).runtime_cost ?? 0, moduleId === SOL_Y ? -4 : 0);
    const h = run({ units: [U(E, S1, 9, 4, { moduleId })], flags: { dpPerSec: 0, dpInit: 50 } });
    const u = h.unit(E);
    h.step(1);
    assert.equal(dp(h), 50, 'the initial deployment costs nothing');
    h.b.kill(u);
    assert.ok(h.b.redeploy(u, { free: false }));
    assert.equal(dp(h), 50 - rec(E).stats.cost, `${E} ${moduleId}: the full cost`);
    done(h);
  }
});

test('推进之王: both tiers × every module (incl. none) × every skill — DP, rule, module trait, 万兽之王 self part, 粉碎 sp of that loadout', () => {
  for (const [id, m] of ALL) for (const s of rec(id).skills) {
    const tag = `${id} ${m} ${s.skillId}`;
    const t = typeOf(id, m);
    const h = run({ units: [U(id, s.skillId, 9, 4, { carryState: READY, ...opt(m) })], enemies: [{ key: 'enemy_walker', route: 0 }, { key: 'enemy_dummy', pos: [9, 5], time: 0.1 }] });
    const u = h.unit(id);
    assert.equal(u.kit.skillSource, 'skills', tag);
    const before = dpBefore(h, () => u.skill.activations === 1, 20);
    assert.equal(u.skill.rule, s.skillId === S1 ? 'SP_FULL' : 'DEFAULT', tag);
    assert.equal(dp(h) - before, s.skillId === S3 ? 0 : s.bb.cost, `${tag}: DP`);
    assert.ok(h.runUntil(() => u.blocking.length > 0, 20), tag);
    h.step(1);
    assert.equal(!!u.findBuff('siege:solX'), t === 'SOL-X', `${tag}: SOL-X trait`);
    assert.equal(!!u.findBuff(LORD_SELF), (selfOf(id, m).atk ?? 0) > 0, `${tag}: own extra`);
    assert.equal(!!u.findBuff(LORD), true);
    if (u.skill.active && u.skill.isTimed) h.runUntil(() => !u.skill.active, s.duration + 1);
    const n0 = talentSp(h, u).length;
    h.b.kill(h.enemy('enemy_dummy'), null);
    assert.deepEqual(talentSp(h, u).slice(n0), [talOf(id, 1, m ?? null).sp], `${tag}: 粉碎`);
    done(h);
  }
});

test('推进之王: every skill × tier × module survives a real wave without content errors and casts', () => {
  for (const [id, m] of ALL) for (const s of rec(id).skills) {
    const h = makeBattle({ defs: DEFS, seed: 3, timeLimit: 60,
      units: [U(id, s.skillId, 9, 4, { carryState: READY, ...opt(m) }), { chessId: 'chess_char_2_06_a', row: 10, col: 6 }],
      enemies: [{ key: 'enemy_1007_slime', count: 8, interval: 1.5 }, { key: 'enemy_1007_slime', route: 1, count: 8, interval: 1.5, time: 3 }] });
    h.runToEnd(90);
    done(h);
    assert.ok(h.b.allyUnits.find((x) => x.defId === id).skill.activations > 0, `${id} ${m} ${s.skillId} casts`);
  }
});
