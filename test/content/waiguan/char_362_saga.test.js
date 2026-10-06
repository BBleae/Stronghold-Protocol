// test/content/waiguan/char_362_saga.test.js — 嵯峨 外援 kit (server/sim/content/kits/waiguan/char_362_saga.js).
// Every skill (normal Lv4 + elite Lv7), the DP of each (the player's DP before / after, natural regen off), the trigger
// rules and their timing, both talents (劝善's 重伤 in full, 清明), every module of both tiers' elites × every skill,
// two copies, two players on one field, a smoke wave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, chessRec, checkInvariants } from '../../helpers/battleHarness.js';
import { DataSource, getDefaultSource } from '../../../server/sim/simdata.js';
import { getData } from '../../../server/data.js';
import { waiguanRecords } from '../../../shared/waiguan.js';
import { skillSpecSource } from '../../../server/sim/content/index.js';
import { AUTO_OP_COOLDOWN, COLS, TICK } from '../../../server/sim/constants.js';
import { flatStage } from '../../helpers/battleHarness.js';
import { SharedBossPool } from '../../../server/match/finalAssault.js';
import WAIGUAN from '../../../server/sim/content/kits/waiguan/index.js';

const CHAR = 'char_362_saga';
const ID5 = `chess_char_diy_5_${CHAR}_a`, ID6 = `chess_char_diy_6_${CHAR}_a`;
const ELITE5 = ID5.replace(/_a$/, '_b'), ELITE6 = ID6.replace(/_a$/, '_b');
const ELITES = [ELITE5, ELITE6];
const SOL_Y = 'uniequip_002_saga', SOL_X = 'uniequip_003_saga';
const S1 = 'skcom_charge_cost[3]', S2 = 'skchr_saga_2', S3 = 'skchr_saga_3';
const CRIPPLE = 'saga:cripple';
const REC = waiguanRecords(getData({ log: { warn() {}, error() {}, info() {} } }).waiguan);
const DS = new DataSource({ chess: REC }, getDefaultSource());
const rec = (id) => REC[id];
const skillOf = (id, sid) => rec(id).skills.find((s) => s.skillId === sid);
/** Loadout-resolved record (module `moduleId`) and its talent blackboard by data index. */
const raw = (id, moduleId = null) => DS.getChess(id, { moduleId }).raw;
const talOf = (id, i, moduleId = null) => raw(id, moduleId).talents.find((t) => t.index === i)?.bb ?? {};
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e7, speed: 0, ...o });
const DEFS = {
  chess: {
    ...REC,
    // an ally with a time-SP skill (spCost 50): the 击杀者 of the 重伤 rule
    test_guard_a: chessRec({ id: 'test_guard_a', profession: 'WARRIOR', stats: { maxHp: 1e5, atk: 1, def: 100 }, skill: { spCost: 50, initSp: 0, duration: 5 } }),
  },
  enemies: {
    enemy_dummy: dummy('enemy_dummy', { def: 100 }),
    enemy_soft: dummy('enemy_soft', { hp: 500, def: 0 }),
    enemy_mid: dummy('enemy_mid', { hp: 900, def: 0 }),
    enemy_taunt: dummy('enemy_taunt', { def: 100, taunt: 1 }),
    enemy_fly: dummy('enemy_fly', { def: 100, motion: 'FLY', taunt: 2 }),
    // walks route 0 (row 9, right → left) into her block; hits for 200 every 2 s
    enemy_brute: enemyRec({ key: 'enemy_brute', hp: 1e7, speed: 1, atk: 200, def: 0 }),
    enemy_walker: enemyRec({ key: 'enemy_walker', hp: 1e7, speed: 1, atk: 0, def: 0 }),
  },
};
const READY = { sp: 999 };
const NO_DP = { dpPerSec: 0 };
const HOOKS = ['damaged', 'skillStart', 'skillEnd', 'attack', 'spGain', 'kill', 'death', 'heal'];
/** Battle with the 外援 records + synthetic allies / enemies, natural DP regen off unless `flags` say otherwise. */
const run = (o) => makeBattle({ defs: DEFS, seed: 7, timeLimit: 300, autoFinish: false, hooks: HOOKS, captureNoisy: true, flags: NO_DP, ...o });
/** Operator entry with skill `sid` selected (board coords: row 9–12, col 2–10); `moduleId` only for an elite. */
const U = (id, sid, row, col, o = {}) => ({ chessId: id, row, col, skillIndex: skillOf(id, sid).index, ...o });
const done = (h) => { checkInvariants(h.b); assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0])); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const has = (c, tag) => !!c.dmg?.tags?.includes(tag);
const dp = (h, pid = 'p1') => h.b.getPlayer(pid).dp;
const phys = (a, d) => Math.max(a - d, 0.05 * a);
const talentSp = (h, u) => h.hooksOf('spGain').filter((c) => c.unit === u && c.reason === 'talent').map((c) => c.amount);
/** Every (record, module) of the operator: both tiers' normal chess, both elites with every module incl. 'none'. */
const ALL = [[ID5, undefined], [ID6, undefined], ...ELITES.flatMap((E) => [null, 'none', SOL_Y, SOL_X].map((m) => [E, m]))];
const opt = (m) => (m === undefined ? {} : { moduleId: m });
const typeOf = (id, m) => raw(id, m ?? null).module?.active ? raw(id, m ?? null).module.type : null;
/** Step until `pred()`; returns the DP of `pid` right before the step that made it true. */
function dpBefore(h, pred, maxS = 30, pid = 'p1') {
  let prev = dp(h, pid);
  const lim = h.b.time + maxS;
  while (!pred() && h.b.time < lim) { prev = dp(h, pid); h.step(); }
  assert.ok(pred(), 'condition reached');
  return prev;
}

test('嵯峨: every skill of both tiers (normal + elite, every module) is hand-authored', () => {
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

test('嵯峨: rules — S1 SP_FULL (record DEFAULT changed: AUTO DP skill), S2 SKILL_RANGE and S3 DEFAULT kept; kinds and charges from the record', () => {
  for (const id of [ID5, ID6, ELITE5, ELITE6]) {
    assert.equal(skillOf(id, S1).trigger.rule, 'DEFAULT');
    const want = { [S1]: ['SP_FULL', 'instant', 1, false], [S2]: ['SKILL_RANGE', 'charges', skillOf(id, S2).maxChargeTime, true], [S3]: ['DEFAULT', 'duration', 1, true] };
    for (const [sid, [rule, kind, charges, manual]] of Object.entries(want)) {
      const h = run({ units: [U(id, sid, 9, 4)] });
      h.step(1);
      const u = h.unit(id);
      assert.equal(u.kit.skillSource, 'skills');
      assert.equal(u.skill.rule, rule, `${id} ${sid}`);
      assert.equal(u.skill.kind, kind);
      assert.equal(u.skill.maxCharges, charges);
      assert.equal(u.skill.manual, manual);
      assert.equal(u.skill.spCost, skillOf(id, sid).spCost);
      done(h);
    }
  }
  assert.equal(skillOf(ELITE6, S2).maxChargeTime, 2);
});

test('嵯峨 S1 冲锋号令·γ型: +cost DP the moment SP is full, no enemy needed; next cast one spCost later; capped at dpMax', () => {
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

test('嵯峨 S2 除恶: SKILL_RANGE — no cast without an enemy on the cross; a flyer alone casts (+cost DP) but takes nothing; charges 3 s apart', () => {
  for (const id of [ID6, ELITE6]) {
    const s = skillOf(id, S2);
    const h = run({ units: [U(id, S2, 10, 5, { carryState: READY, moduleId: id === ELITE6 ? 'none' : undefined })], enemies: [{ key: 'enemy_fly', pos: [9, 5], time: 4 }] });
    const u = h.unit(id);
    h.run(3.9);
    assert.equal(u.skill.charges, s.maxChargeTime);
    assert.equal(u.skill.activations, 0, 'nothing on its range: no cast');
    assert.equal(dp(h), h.b.flags.dpInit);
    const before = dpBefore(h, () => u.skill.activations === 1, 2);
    assert.equal(dp(h) - before, s.bb.cost, '+cost DP');
    const t1 = h.hooksOf('skillStart')[0].t;
    assert.ok(Math.abs(t1 - 4) <= 2 * TICK, `cast as the flyer appears (${t1})`);
    assert.equal(h.hooksOf('skillStart')[0].reason, 'SKILL_RANGE');
    const b2 = dpBefore(h, () => u.skill.activations === 2, 5);
    assert.equal(dp(h) - b2, s.bb.cost);
    assert.ok(Math.abs(h.hooksOf('skillStart')[1].t - t1 - AUTO_OP_COOLDOWN) <= 2 * TICK, 'the second charge 3 s later');
    assert.equal(h.hooksOf('damaged').filter((c) => c.source === u && has(c, 'sagaS2')).length, 0, 'a flyer is no 地面敌人');
    done(h);
  }
});

test('嵯峨 S2 除恶: ≤ 6 ground enemies of the cross, atk_scale × ATK physical, the skill\'s own pick (not the one she blocks first)', () => {
  for (const id of [ID6, ELITE6]) {
    const s = skillOf(id, S2);
    // the cross from (10, 5) facing right: (10, 3..7), (9..12, 5). Six taunted dummies, the flyer (taunt 2), and a plain
    // one on her own tile (she blocks it): the skill takes the taunted six; blocked-first would take the plain one
    const tiles = [[10, 6], [10, 7], [9, 5], [11, 5], [12, 5], [10, 4]];
    const h = run({ units: [U(id, S2, 10, 5, { carryState: { sp: s.spCost - 0.5 }, moduleId: id === ELITE6 ? 'none' : undefined })],
      enemies: [...tiles.map((pos) => ({ key: 'enemy_taunt', pos })), { key: 'enemy_fly', pos: [10, 3] }, { key: 'enemy_dummy', pos: [10, 5] }, { key: 'enemy_dummy', pos: [10, 8] }] });
    const u = h.unit(id);
    h.step(3);
    const plain = h.b.enemies.find((e) => e.defId === 'enemy_dummy' && Math.round(e.x) === 5);
    const outside = h.b.enemies.find((e) => e.defId === 'enemy_dummy' && Math.round(e.x) === 8);
    const fly = h.enemy('enemy_fly');
    assert.equal(u.skill.activations, 0);
    assert.equal(plain.blockedBy, u, 'she blocks the plain one');
    assert.equal(h.b.enemies.filter((e) => e.defId === 'enemy_taunt').every((e) => e.s.taunt === 1), true);
    assert.ok(h.runUntil(() => u.skill.activations === 1, 2));
    const hits = h.hooksOf('damaged').filter((c) => c.source === u && has(c, 'sagaS2'));
    assert.equal(hits.length, 6, 'six targets');
    assert.deepEqual(new Set(hits.map((c) => c.target.defId)), new Set(['enemy_taunt']), 'the taunted six — not the blocked plain one, not the flyer');
    assert.ok(!hits.some((c) => c.target === plain || c.target === fly || c.target === outside));
    const A = u.s.atk;
    for (const c of hits) {
      assert.equal(c.type, 'phys');
      assert.equal(c.dmg.isSkill, true);
      assert.equal(c.dmg.isAttack, false);
      assert.ok(near(c.amount, phys(A * s.bb.atk_scale, 100)), `${c.amount}`);
    }
    assert.ok(hits.every((c) => c.target.alive && !c.target.findBuff(CRIPPLE)), 'no execution of an enemy that is not 重伤');
    done(h);
  }
});

test('嵯峨 S2: a lethal hit is held at 1 HP and 重伤s, then she executes it (killer: her, +sp SP); an already 重伤 enemy too', () => {
  for (const id of [ID6, ELITE6]) {
    const s = skillOf(id, S2), sp = talOf(id, 0).sp;
    const h = run({ units: [U(id, S2, 10, 5, { carryState: READY, moduleId: id === ELITE6 ? 'none' : undefined })], enemies: [{ key: 'enemy_soft', pos: [10, 6] }] });
    const u = h.unit(id);
    h.step(1);
    assert.equal(u.skill.activations, 1, 'cast at the first step: the enemy is on the cross');
    const k = h.hooksOf('kill').find((c) => c.victim.defId === 'enemy_soft');
    const e = k.victim;
    assert.ok(u.s.atk * s.bb.atk_scale > e.s.maxHp, 'the S2 hit is lethal');
    assert.equal(e.alive, false);
    assert.equal(h.hooksOf('damaged').filter((c) => c.target === e && c.source === u && has(c, 'sagaS2')).length, 1);
    assert.equal(k.killer, u, 'executed by her');
    assert.ok(Math.abs(k.t - h.hooksOf('skillStart')[0].t) < 1e-9, 'in the same step');
    const gain = h.hooksOf('spGain').filter((c) => c.unit === u && c.reason === 'talent');
    assert.deepEqual(gain.map((c) => c.amount), [sp], 'the 击杀者 gains sp');
    done(h);
  }
  // crippled by her normal attacks first (S2 not ready), executed by the next S2 charge
  const s = skillOf(ID6, S2);
  // S2 ready 4 s in (its 重伤 timer would kill a target crippled long before)
  const h = run({ units: [U(ID6, S2, 10, 5, { carryState: { sp: s.spCost - 4 } })], enemies: [{ key: 'enemy_mid', pos: [10, 6] }] });
  h.step(1);
  const u = h.unit(ID6), e = h.enemy('enemy_mid');
  assert.ok(h.runUntil(() => e.findBuff(CRIPPLE), 6), '重伤 by her attacks');
  assert.equal(e.hp, 1);
  assert.equal(u.skill.activations, 0);
  assert.ok(h.runUntil(() => u.skill.activations === 1, 5));
  assert.equal(e.alive, false);
  assert.equal(h.hooksOf('kill').find((c) => c.victim === e).killer, u);
  done(h);
});

test('嵯峨 S3 怒目: ATK +atk, interval +base_attack_time, range +1, every blocked enemy; < hp_ratio: one more 1 × ATK hit', () => {
  for (const id of [ID6, ELITE6]) {
    const s = skillOf(id, S3), bb = s.bb;
    // two dummies on her tile: both blocked
    const h = run({ units: [U(id, S3, 9, 4, { carryState: { sp: s.spCost - 0.3 }, moduleId: id === ELITE6 ? 'none' : undefined })], enemies: [{ key: 'enemy_dummy', pos: [9, 4] }, { key: 'enemy_dummy', pos: [9, 4] }] });
    const u = h.unit(id);
    h.step(1);
    assert.equal(u.skill.active, false);
    assert.equal(u.rangeKeys.length, 2, 'her 1-1 range before the skill');
    assert.ok(near(u.s.interval, u.base.bat));
    const [a, b] = h.b.enemies;
    a.hp = 0.4 * a.s.maxHp; // below hp_ratio: the follow-up hit
    b.hp = (bb['attack@hp_ratio'] + 0.02) * b.s.maxHp; // just above it after the hit: none
    assert.ok(h.runUntil(() => u.skill.active, 3));
    const t0 = h.hooksOf('skillStart')[0].t;
    assert.ok(t0 > 0.3 && h.hooksOf('attack').some((c) => c.attacker === u && c.isSkill && c.t === t0), 'DEFAULT: cast at her next attack once ready');
    assert.ok(near(u.s.atk, u.base.atk * (1 + bb.atk)));
    assert.ok(near(u.s.interval, u.base.bat + bb.base_attack_time), `interval ${u.s.interval}`);
    assert.equal(u.rangeKeys.length, 2 + bb.ability_range_forward_extend);
    assert.ok(u.rangeKeySet.has(9 * COLS + 6), 'two tiles ahead');
    h.run(0.1);
    const first = h.hooksOf('attack').find((c) => c.attacker === u && c.isSkill && c.t === t0);
    assert.equal(first.targets.length, 2, 'every blocked enemy');
    const dmg = h.hooksOf('damaged').filter((c) => c.source === u && c.t === first.t);
    const A = u.s.atk;
    const main = dmg.filter((c) => !has(c, 'sagaS3Extra'));
    assert.equal(main.length, 2);
    for (const c of main) assert.ok(near(c.amount, phys(A, 100)));
    const extra = dmg.filter((c) => has(c, 'sagaS3Extra'));
    assert.equal(extra.length, 1, 'one follow-up');
    assert.equal(extra[0].target, a, 'on the one below hp_ratio');
    assert.ok(near(extra[0].amount, phys(A, 100)) && extra[0].type === 'phys' && extra[0].dmg.isAttack === true);
    assert.ok(b.hpRatio > bb['attack@hp_ratio']);
    done(h);
  }
});

test('嵯峨 S3: DEFAULT waits while only 重伤 enemies are in reach (she does not attack them); every blocked enemy but the 重伤 one', () => {
  const s = skillOf(ID6, S3);
  // ready 3 s in; the soft dummy is 重伤 by her second attack before that
  const h = run({ units: [U(ID6, S3, 9, 4, { carryState: { sp: s.spCost - 3 } })], enemies: [{ key: 'enemy_soft', pos: [9, 5] }, { key: 'enemy_dummy', pos: [9, 5], time: 8 }] });
  h.step(1);
  const u = h.unit(ID6), soft = h.enemy('enemy_soft');
  assert.ok(h.runUntil(() => soft.findBuff(CRIPPLE), 3));
  assert.ok(h.runUntil(() => u.skill.ready, 3));
  h.run(7.5 - h.b.time);
  assert.equal(u.skill.activations, 0, 'no cast on a 重伤 target');
  assert.ok(h.runUntil(() => u.skill.active, 2), 'cast once a target she may attack is there');
  assert.ok(Math.abs(h.hooksOf('skillStart')[0].t - 8) <= 2 * TICK);
  done(h);
  // two blocked dummies, one 重伤 by her own (never lethal) damage: the S3 attack takes the other only
  const g = run({ units: [U(ID6, S3, 9, 4, { carryState: { sp: s.spCost - 0.3 } })], enemies: [{ key: 'enemy_dummy', pos: [9, 4] }, { key: 'enemy_dummy', pos: [9, 4] }] });
  g.step(1);
  const v = g.unit(ID6);
  const [a, b] = g.b.enemies;
  assert.ok(a.blockedBy === v && b.blockedBy === v);
  g.b.dealDamage(v, a, { amount: 1e8, type: 'true' });
  assert.ok(a.alive && a.hp === 1 && a.findBuff(CRIPPLE));
  assert.ok(g.runUntil(() => v.skill.active, 3));
  g.run(3);
  const atk = g.hooksOf('attack').filter((c) => c.attacker === v && c.isSkill);
  assert.ok(atk.length >= 2);
  assert.ok(atk.every((c) => c.targets.length === 1 && c.targets[0] === b), 'the 重伤 one is left out');
  done(g);
});

test('嵯峨 S3: +cost DP every interval s from the cast, value in all, nothing after; a knock-out ends it with no remainder', () => {
  for (const id of [ID6, ELITE6]) {
    const s = skillOf(id, S3), bb = s.bb;
    const h = run({ units: [U(id, S3, 9, 4, { carryState: READY, moduleId: id === ELITE6 ? 'none' : undefined })], enemies: [{ key: 'enemy_dummy', pos: [9, 5] }] });
    const u = h.unit(id);
    const base = dpBefore(h, () => u.skill.active, 3);
    assert.equal(dp(h), base, 'nothing at the cast');
    const t0 = h.hooksOf('skillStart')[0].t;
    const gains = [];
    let last = dp(h);
    while (u.skill.active && h.b.time < t0 + s.duration + 2) {
      h.step();
      if (dp(h) !== last) { gains.push([h.b.time - TICK - t0, dp(h) - last]); last = dp(h); }
    }
    assert.equal(gains.length, bb.value / bb.cost, `${gains.length} pulses`);
    gains.forEach(([t, n], i) => {
      assert.equal(n, bb.cost);
      assert.ok(Math.abs(t - bb.interval * (i + 1)) <= 1.5 * TICK, `pulse ${i + 1} at ${t}`);
    });
    assert.equal(dp(h) - base, bb.value, 'value in all');
    assert.equal(h.hooksOf('skillEnd')[0].reason, 'duration');
    h.run(3);
    assert.equal(dp(h) - base, bb.value, 'nothing after the skill');
    done(h);
  }
  const s = skillOf(ID6, S3);
  const h = run({ units: [U(ID6, S3, 9, 4, { carryState: READY })], enemies: [{ key: 'enemy_dummy', pos: [9, 5] }] });
  const u = h.unit(ID6);
  const base = dpBefore(h, () => u.skill.active, 3);
  h.run(5.5);
  assert.equal(dp(h) - base, 5 * s.bb.cost);
  h.b.kill(u);
  h.run(1);
  assert.equal(h.hooksOf('skillEnd')[0].reason, 'death');
  assert.equal(dp(h) - base, 5 * s.bb.cost, 'no remainder after a knock-out');
  done(h);
});

test('嵯峨 T1 劝善: her lethal hit leaves 1 HP and 重伤 (禁疗, no attacks, speed ×(1+move_speed)); she stops attacking it; it dies `interval` s later with no killer', () => {
  for (const [id, m] of [[ID5, undefined], [ID6, undefined], [ELITE6, 'none']]) {
    const t0 = talOf(id, 0, m ?? null);
    const h = run({ units: [U(id, S1, 9, 4, opt(m))], enemies: [{ key: 'enemy_soft', pos: [9, 5] }] });
    h.step(1);
    const u = h.unit(id), e = h.enemy('enemy_soft');
    assert.ok(h.runUntil(() => e.findBuff(CRIPPLE), 5));
    const at = h.b.time;
    assert.equal(e.alive, true);
    assert.equal(e.hp, 1, 'held at 1 HP');
    const cr = e.findBuff(CRIPPLE);
    assert.equal(cr.source, u);
    assert.ok(near(cr.timeLeft, t0.interval, 1e-3) || near(cr.timeLeft + TICK, t0.interval, 1e-3));
    assert.equal(e.s.flags.healFree, true);
    assert.equal(e.s.flags.disarm, true);
    assert.ok(near(e.s.moveSpeed, e.base.moveSpeed * (1 + t0.move_speed)));
    assert.equal(h.b.heal(u, e, 100), 0, '禁疗');
    const atk0 = h.hooksOf('attack').filter((c) => c.attacker === u).length;
    h.run(t0.interval - 1);
    assert.equal(h.hooksOf('attack').filter((c) => c.attacker === u).length, atk0, 'no attack on a 重伤 enemy');
    assert.equal(e.alive, true);
    const killed = h.b.killed;
    assert.ok(h.runUntil(() => !e.alive, 2));
    assert.ok(Math.abs(h.b.time - at - t0.interval) <= 2 * TICK, 'dies interval s later');
    const k = h.hooksOf('kill').find((c) => c.victim === e);
    assert.equal(k.killer, null, 'no killer');
    assert.equal(h.hooksOf('death').find((c) => c.unit === e).reason, 'killed');
    assert.equal(h.b.killed, killed + 1, 'counts as a kill');
    assert.equal(h.hooksOf('spGain').filter((c) => c.reason === 'talent').length, 0);
    done(h);
  }
});

test('嵯峨 T1: she attacks the other enemy; the 重伤 one cannot attack; the 击杀者 of a 重伤 enemy gains sp SP (not of a plain one)', () => {
  const sp = talOf(ID6, 0).sp;
  // the brute walks into her block and hits her for 200; a plain dummy stands in front
  const h = run({ units: [U(ID6, S1, 9, 4), { chessId: 'test_guard_a', row: 11, col: 4, uid: 9 }], enemies: [{ key: 'enemy_brute', route: 0 }, { key: 'enemy_dummy', pos: [9, 5], time: 0.5 }] });
  h.step(1);
  const u = h.unit(ID6), guard = h.unit(9);
  assert.ok(h.runUntil(() => h.enemy('enemy_brute').blockedBy === u, 20));
  const brute = h.enemy('enemy_brute'), plain = h.enemy('enemy_dummy');
  assert.ok(h.runUntil(() => h.hooksOf('damaged').some((c) => c.source === brute && c.target === u), 5), 'the brute hits her');
  brute.hp = 1; // her next hit is lethal
  assert.ok(h.runUntil(() => brute.findBuff(CRIPPLE), 3));
  assert.ok(near(brute.s.moveSpeed, brute.base.moveSpeed * (1 + talOf(ID6, 0).move_speed)), `重伤 speed ${brute.s.moveSpeed}`);
  assert.ok(brute.base.moveSpeed > 0);
  const t = h.b.time;
  h.run(6);
  assert.equal(h.hooksOf('damaged').filter((c) => c.source === brute && c.t > t).length, 0, '重伤: no more attacks');
  const after = h.hooksOf('attack').filter((c) => c.attacker === u && c.t > t);
  assert.ok(after.length >= 3, 'she keeps attacking');
  assert.ok(after.every((c) => c.targets.length === 1 && c.targets[0] === plain), 'the plain one only');
  // the 击杀者 rule: a 重伤 enemy killed by the guard → +sp; a plain one → nothing
  h.b.dealDamage(guard, brute, { amount: 1e3, type: 'true' });
  assert.equal(brute.alive, false);
  assert.deepEqual(h.hooksOf('spGain').filter((c) => c.unit === guard && c.reason === 'talent').map((c) => c.amount), [sp]);
  assert.deepEqual(talentSp(h, u), [], 'the 击杀者 alone (ModifySp MAIN_TARGET): not her');
  h.b.dealDamage(guard, plain, { amount: 1e8, type: 'true' });
  assert.equal(plain.alive, false);
  assert.equal(h.hooksOf('spGain').filter((c) => c.unit === guard && c.reason === 'talent').length, 1, 'no SP for a plain kill');
  done(h);
});

test('嵯峨 T1: two copies share one 重伤 per enemy, neither attacks it, its 击杀者 gains sp once; two players: a teammate\'s killer gains it, DP stays per player', () => {
  const sp = talOf(ID6, 0).sp;
  const h = run({ units: [U(ID5, S1, 9, 4, { uid: 1, carryState: READY }), U(ID6, S1, 10, 4, { uid: 2, carryState: READY }), { chessId: 'test_guard_a', row: 12, col: 4, uid: 9 }],
    enemies: [{ key: 'enemy_soft', pos: [9, 5] }, { key: 'enemy_soft', pos: [10, 5] }] });
  h.step(1);
  const a = h.unit(1), b = h.unit(2), guard = h.unit(9);
  assert.equal(dp(h), h.b.flags.dpInit + skillOf(ID5, S1).bb.cost + skillOf(ID6, S1).bb.cost, 'both S1 casts: +cost each to the same player');
  const [ea, eb] = h.b.enemies;
  assert.ok(h.runUntil(() => ea.findBuff(CRIPPLE) && eb.findBuff(CRIPPLE), 6));
  assert.equal(ea.findBuff(CRIPPLE).source, a);
  assert.equal(eb.findBuff(CRIPPLE).source, b);
  assert.equal(ea.buffs.filter((x) => x.key === CRIPPLE).length, 1);
  // neither attacks a 重伤 enemy any more
  const n0 = h.hooksOf('attack').filter((c) => c.attacker === a || c.attacker === b).length;
  h.run(3);
  assert.equal(h.hooksOf('attack').filter((c) => c.attacker === a || c.attacker === b).length, n0);
  h.b.dealDamage(guard, ea, { amount: 10, type: 'true' });
  assert.deepEqual(h.hooksOf('spGain').filter((c) => c.unit === guard && c.reason === 'talent').map((c) => c.amount), [sp], 'once');
  assert.deepEqual([...talentSp(h, a), ...talentSp(h, b)], [], 'neither 嵯峨');
  done(h);
  // two players on one field: P2's 嵯峨 cripples, P1's guard kills it and gains the SP; P2's S1 DP goes to p2 only
  const players = [
    { playerId: 'p1', seat: 0, side: 'L', colOffset: 0, bonds: {}, units: [{ uid: 2, kind: 'chess', chessId: 'test_guard_a', row: 12, col: 4 }] },
    { playerId: 'p2', seat: 1, side: 'L', colOffset: 8, bonds: {}, units: [{ uid: 1, kind: 'chess', chessId: ID6, skillIndex: skillOf(ID6, S1).index, row: 9, col: 3, carryState: READY }] },
  ];
  const g = run({ kind: 'unite', players, enemies: [{ key: 'enemy_soft', pos: [9, 12] }] });
  const s1 = skillOf(ID6, S1);
  g.step(2);
  assert.equal(g.unit(1).ownerId, 'p2');
  assert.ok(g.unit(1).alive && g.unit(1).deployed);
  assert.equal(dp(g, 'p2'), g.b.flags.dpInit + s1.bb.cost, 'p2 (hers) +cost');
  assert.equal(dp(g, 'p1'), g.b.flags.dpInit, 'p1 untouched');
  const v = g.enemy('enemy_soft');
  assert.ok(g.runUntil(() => v.findBuff(CRIPPLE), 6));
  assert.equal(v.findBuff(CRIPPLE).source, g.unit(1));
  const t2 = g.unit(2);
  assert.equal(t2.ownerId, 'p1');
  g.b.dealDamage(t2, v, { amount: 10, type: 'true' });
  assert.deepEqual(g.hooksOf('spGain').filter((c) => c.unit === t2 && c.reason === 'talent').map((c) => c.amount), [sp]);
  assert.deepEqual(talentSp(g, g.unit(1)), [], 'a teammate\'s kill of her 重伤 enemy gives her nothing');
  done(g);
});

test('嵯峨 T1: the 击杀者 SP is lost while its timed skill runs; a 重伤 enemy keeps 1 HP under her later hits', () => {
  const h = run({ units: [U(ID6, S2, 10, 5, { carryState: { sp: 0 } }), { chessId: 'test_guard_a', row: 12, col: 4, uid: 9, carryState: READY }], enemies: [{ key: 'enemy_soft', pos: [10, 6] }] });
  h.step(1);
  const u = h.unit(ID6), guard = h.unit(9), e = h.enemy('enemy_soft');
  assert.ok(h.runUntil(() => e.findBuff(CRIPPLE), 5));
  const cr = e.findBuff(CRIPPLE);
  h.run(1);
  const left = cr.timeLeft;
  h.b.dealDamage(u, e, { amount: 1e5, type: 'true' });
  assert.equal(e.alive, true);
  assert.equal(e.hp, 1, 'her damage is never lethal');
  assert.equal(e.findBuff(CRIPPLE), cr, 'the same 重伤: not re-applied');
  assert.equal(cr.timeLeft, left, 'its timer runs on');
  assert.ok(guard.skill.activate('test'));
  h.b.dealDamage(guard, e, { amount: 10, type: 'true' });
  assert.equal(e.alive, false);
  assert.equal(h.hooksOf('spGain').filter((c) => c.unit === guard && c.reason === 'talent').length, 0);
  done(h);
});

test('嵯峨 T1: the re-pick keeps the attack\'s target count (2+ plain enemies in reach); blocking only a 重伤 enemy she holds — DEFAULT does not cast', () => {
  // a 重伤 dummy she blocks (her tile) — blocked-first would take it — and two plain ones in front: one target per attack
  const h = run({ units: [U(ID6, S1, 9, 4)], enemies: [{ key: 'enemy_dummy', pos: [9, 4] }, { key: 'enemy_dummy', pos: [9, 5] }, { key: 'enemy_dummy', pos: [9, 5] }] });
  h.step(1);
  const u = h.unit(ID6);
  const [held, p1, p2] = h.b.enemies;
  assert.equal(held.blockedBy, u);
  h.b.dealDamage(u, held, { amount: 1e8, type: 'true' });
  assert.ok(held.findBuff(CRIPPLE) && held.hp === 1);
  const t = h.b.time;
  h.run(6);
  const atk = h.hooksOf('attack').filter((c) => c.attacker === u && c.t >= t);
  assert.ok(atk.length >= 4);
  assert.ok(atk.every((c) => c.targets.length === 1 && (c.targets[0] === p1 || c.targets[0] === p2)), 'one plain target each');
  done(h);
  // S3 ready 2 s in, the only enemy is a 重伤 one she blocks: no attack, no cast
  const s = skillOf(ID6, S3);
  const g = run({ units: [U(ID6, S3, 9, 4, { carryState: { sp: s.spCost - 2 } })], enemies: [{ key: 'enemy_dummy', pos: [9, 4] }, { key: 'enemy_dummy', pos: [9, 5], time: 6 }] });
  g.step(1);
  const v = g.unit(ID6), only = g.b.enemies[0];
  assert.equal(only.blockedBy, v);
  g.b.dealDamage(v, only, { amount: 1e8, type: 'true' });
  const t2 = g.b.time;
  g.run(5.9 - g.b.time);
  assert.ok(v.skill.ready && v.blocking.includes(only));
  assert.equal(g.hooksOf('attack').filter((c) => c.attacker === v && c.t > t2).length, 0, 'no attack');
  assert.equal(v.skill.activations, 0, 'DEFAULT does not cast on a 重伤 enemy she blocks');
  assert.ok(g.runUntil(() => v.skill.active, 1), 'cast once a plain one comes');
  done(g);
});

test('嵯峨 thresholds: the S3 follow-up needs HP below hp_ratio (exactly at it: none); 清明 needs HP below hp_ratio (exactly 40 %: none); 清明 gives no arts dodge', () => {
  const s = skillOf(ID6, S3), lt = s.bb['attack@hp_ratio'];
  const h = run({ units: [U(ID6, S3, 9, 4, { carryState: READY })], enemies: [{ key: 'enemy_dummy', pos: [9, 4] }, { key: 'enemy_dummy', pos: [9, 4] }] });
  h.step(1);
  const u = h.unit(ID6);
  const [at, below] = h.b.enemies;
  // right after each S3 main hit (the follow-up is checked next), put the targets at / just under the threshold
  h.b.on('damaged', (c) => {
    if (c.source !== u || !c.dmg.isAttack || c.dmg.tags?.includes('sagaS3Extra')) return;
    if (c.target === at) at.hp = at.s.maxHp * lt;
    if (c.target === below) below.hp = below.s.maxHp * lt - 1;
  }, { priority: 1000 });
  assert.ok(h.runUntil(() => u.skill.active, 2));
  h.run(5);
  const mainHits = h.hooksOf('damaged').filter((c) => c.source === u && c.dmg.isAttack && !has(c, 'sagaS3Extra') && c.target === at);
  const extra = h.hooksOf('damaged').filter((c) => c.source === u && has(c, 'sagaS3Extra'));
  assert.ok(mainHits.length >= 3 && extra.length >= 2);
  assert.ok(extra.every((c) => c.target === below), 'exactly at hp_ratio: no follow-up (LT)');
  assert.equal(at.s.maxHp * lt / at.s.maxHp, lt);
  done(h);
  for (const [id, m] of [[ID6, undefined], [ELITE6, null]]) {
    const t1 = talOf(id, 1, m ?? null);
    const g = run({ units: [U(id, S1, 9, 4, opt(m))], enemies: [{ key: 'enemy_dummy', pos: [9, 8] }] });
    g.step(1);
    const v = g.unit(id), e = g.enemy('enemy_dummy');
    let setTo = null;
    g.b.on('damaged', (c) => { if (c.target === v && setTo != null) v.hp = setTo; }, { priority: 1000 });
    setTo = v.s.maxHp * t1.hp_ratio;
    g.b.dealDamage(e, v, { amount: 1, type: 'true' });
    assert.equal(v.hpRatio, t1.hp_ratio, 'exactly hp_ratio');
    assert.equal(v.findBuff('saga:clarity'), null, '"低于": not at it');
    setTo = v.s.maxHp * t1.hp_ratio - 0.5;
    g.b.dealDamage(e, v, { amount: 1, type: 'true' });
    assert.ok(v.findBuff('saga:clarity'), 'below it');
    assert.ok(near(v.s.dodgePhys, t1.prob));
    assert.equal(v.s.dodgeArts, 0, 'physical dodge only');
    done(g);
  }
});

test('嵯峨 T1: a leader on a shared boss HP pool is not held at 1 HP (no fatal step for a pool — documented); an ordinary enemy of that field is', () => {
  const defs = { chess: DEFS.chess, enemies: { ...DEFS.enemies,
    enemy_bossx: { ...enemyRec({ key: 'enemy_bossx', hp: 600000, speed: 0, dmgType: 'none' }), rank: 'BOSS', hitArea: { w: 4.95, h: 2.95, dx: 0, dy: 1 } } } };
  const pool = new SharedBossPool(3600);
  const h = makeBattle({ defs, kind: 'boss', stage: flatStage(), sharedBoss: pool, autoFinish: false, seed: 3, flags: NO_DP, hooks: HOOKS, captureNoisy: true,
    units: [U(ID6, S1, 10, 6)],
    enemies: [{ key: 'enemy_bossx', pos: [3, 10], route: { motion: 'WALK', start: [3, 10], end: [3, 10], checkpoints: [] }, tag: 'boss' }, { key: 'enemy_soft', pos: [10, 8] }] });
  h.step(1);
  const u = h.unit(ID6);
  const boss = h.b.enemies.find((e) => e.isBoss), add = h.enemy('enemy_soft');
  assert.ok(boss.bossPool === pool);
  h.b.dealDamage(u, add, { amount: 1e7, type: 'true' });
  assert.ok(add.alive && add.hp === 1 && add.findBuff(CRIPPLE), 'an ordinary enemy: held, 重伤');
  h.b.dealDamage(u, boss, { amount: 5000, type: 'true' });
  assert.equal(pool.hp, 0);
  assert.equal(boss.alive, false, 'the pooled leader dies');
  assert.equal(boss.findBuff(CRIPPLE), null);
  assert.equal(h.hooksOf('kill').find((c) => c.victim === boss).killer, u);
  checkInvariants(h.b);
});

test('嵯峨 T1: a record without a positive 重伤 interval holds nobody at 1 HP (no endless 重伤, no literal fallback)', () => {
  const noTimer = structuredClone(rec(ID6));
  delete noTimer.talents.find((t) => t.index === 0).bb.interval;
  const h = makeBattle({ defs: { ...DEFS, chess: { ...DEFS.chess, [ID6]: noTimer } }, seed: 7, timeLimit: 60, autoFinish: false, hooks: HOOKS, captureNoisy: true, flags: NO_DP,
    units: [U(ID6, S1, 9, 4)], enemies: [{ key: 'enemy_soft', pos: [9, 5] }] });
  h.step(1);
  const u = h.unit(ID6), e = h.enemy('enemy_soft');
  assert.equal(u.kit.skillSource, 'skills');
  h.b.dealDamage(u, e, { amount: 1e7, type: 'true' });
  assert.equal(e.alive, false, 'her lethal damage kills');
  assert.equal(h.hooksOf('kill').find((c) => c.victim === e).killer, u);
  done(h);
});

test('嵯峨 T2 清明: once per deployment below hp_ratio — physical dodge prob and HP regen ratio × max HP for duration s; re-armed by a redeploy', () => {
  for (const [id, m] of [[ID6, undefined], [ELITE6, null], [ELITE6, 'none'], [ELITE6, SOL_X], [ELITE5, null]]) {
    const t1 = talOf(id, 1, m ?? null);
    const h = run({ units: [U(id, S1, 9, 4, opt(m))], enemies: [{ key: 'enemy_dummy', pos: [9, 8] }] });
    h.step(1);
    const u = h.unit(id), e = h.enemy('enemy_dummy');
    h.b.dealDamage(e, u, { amount: u.s.maxHp * (1 - t1.hp_ratio) - 5, type: 'true' });
    assert.ok(u.hpRatio >= t1.hp_ratio);
    assert.equal(u.findBuff('saga:clarity'), null, 'not below yet');
    h.b.dealDamage(e, u, { amount: 10, type: 'true' });
    const b = u.findBuff('saga:clarity');
    assert.ok(b, `${id} ${m}`);
    assert.equal(b.timeLeft, t1.duration);
    assert.ok(near(u.s.dodgePhys, t1.prob));
    assert.ok(near(u.s.hpRegen, t1.hp_recovery_per_sec_by_max_hp_ratio * u.s.maxHp));
    const hp0 = u.hp;
    h.run(2);
    assert.ok(near(u.hp - hp0, 2 * t1.hp_recovery_per_sec_by_max_hp_ratio * u.s.maxHp, 0.02), `regen ${u.hp - hp0}`);
    h.run(t1.duration - 2 + 0.1);
    assert.equal(u.findBuff('saga:clarity'), null, 'over after duration s');
    assert.equal(u.s.dodgePhys, 0);
    // "仅一次": a second fall below in the same deployment does nothing
    h.b.heal(u, u, u.s.maxHp, { self: true });
    h.b.dealDamage(e, u, { amount: u.s.maxHp * (1 - t1.hp_ratio) + 5, type: 'true' });
    assert.ok(u.hpRatio < t1.hp_ratio);
    assert.equal(u.findBuff('saga:clarity'), null, 'once per deployment');
    h.b.retreat(u);
    assert.ok(h.b.redeploy(u));
    h.b.dealDamage(e, u, { amount: u.s.maxHp * (1 - t1.hp_ratio) + 5, type: 'true' });
    assert.ok(u.findBuff('saga:clarity'), 're-armed by the redeploy');
    done(h);
  }
  assert.ok(talOf(ELITE6, 1).hp_recovery_per_sec_by_max_hp_ratio > talOf(ELITE6, 1, 'none').hp_recovery_per_sec_by_max_hp_ratio, 'SOL-Y level 3 raises it');
  assert.equal(talOf(ELITE5, 1).duration, talOf(ID5, 1).duration, 'tier V SOL-Y (level 1): base numbers');
});

test('嵯峨 module SOL-X: ATK/DEF + while blocking (both tiers); none / SOL-Y: nothing', () => {
  for (const E of ELITES) for (const moduleId of [null, 'none', SOL_Y, SOL_X]) {
    const tb = raw(E, moduleId).trait.bb ?? {};
    const on = typeOf(E, moduleId) === 'SOL-X';
    assert.equal(tb.atk > 0, on, `${E} ${moduleId}`);
    const h = run({ units: [U(E, S1, 9, 4, { moduleId })], enemies: [{ key: 'enemy_walker', route: 0 }] });
    const u = h.unit(E);
    h.step(2);
    assert.ok(near(u.s.atk, u.base.atk) && near(u.s.def, u.base.def), 'free');
    assert.ok(h.runUntil(() => u.blocking.length > 0, 20));
    h.step(1);
    assert.ok(near(u.s.atk, u.base.atk * (1 + (on ? tb.atk : 0))), `${E} ${moduleId} ATK ${u.s.atk}`);
    assert.ok(near(u.s.def, u.base.def * (1 + (on ? tb.def : 0))));
    done(h);
  }
});

test('嵯峨 module SOL-X (level 3): her damage on an enemy at ≤ hp_ratio HP ×damage_scale — attacks and S2; tier V (level 1), none, SOL-Y: ×1', () => {
  for (const E of ELITES) for (const moduleId of [null, 'none', SOL_Y, SOL_X]) {
    const hb = typeOf(E, moduleId) === 'SOL-X' ? talOf(E, -1, moduleId) : {};
    const scale = hb.damage_scale ?? 1;
    assert.equal(scale > 1, E === ELITE6 && moduleId === SOL_X, `${E} ${moduleId}`);
    const h = run({ units: [U(E, S1, 9, 4, { moduleId })], enemies: [{ key: 'enemy_dummy', pos: [9, 8] }] });
    h.step(1);
    const u = h.unit(E), e = h.enemy('enemy_dummy');
    e.hp = e.s.maxHp * 0.6;
    assert.equal(h.b.dealDamage(u, e, { amount: 1000, type: 'true' }), 1000, 'above: ×1');
    e.hp = e.s.maxHp * (hb.hp_ratio ?? 0.5);
    assert.ok(near(h.b.dealDamage(u, e, { amount: 1000, type: 'true' }), 1000 * scale), 'at hp_ratio: ×damage_scale');
    done(h);
  }
  // S2's skill damage too
  const s = skillOf(ELITE6, S2), hb = talOf(ELITE6, -1, SOL_X);
  const h = run({ units: [U(ELITE6, S2, 10, 5, { moduleId: SOL_X, carryState: { sp: s.spCost - 0.5 } })], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
  h.step(1);
  const u = h.unit(ELITE6), e = h.enemy('enemy_dummy');
  e.hp = e.s.maxHp * 0.3;
  assert.ok(h.runUntil(() => u.skill.activations === 1, 2));
  const c = h.hooksOf('damaged').find((x) => x.source === u && has(x, 'sagaS2'));
  assert.ok(near(c.amount, phys(u.s.atk * s.bb.atk_scale, 100) * hb.damage_scale), `${c.amount}`);
  done(h);
});

test('嵯峨 module SOL-Y "首次部署时部署费用-4": the initial deployment is free; a redeploy pays the full cost', () => {
  for (const E of ELITES) for (const moduleId of [null, SOL_Y, 'none']) {
    assert.equal(talOf(E, -1, moduleId).runtime_cost ?? 0, moduleId === 'none' ? 0 : -4);
    const h = run({ units: [U(E, S1, 9, 4, { moduleId })], flags: { dpPerSec: 0, dpInit: 50 } });
    const u = h.unit(E);
    h.step(1);
    assert.ok(u.alive && u.deployed);
    assert.equal(dp(h), 50, 'the initial deployment costs nothing');
    h.b.kill(u);
    assert.ok(h.b.redeploy(u, { free: false }));
    assert.equal(dp(h), 50 - rec(E).stats.cost, `${E} ${moduleId}: the full cost`);
    assert.equal(u.base.cost, rec(E).stats.cost);
    done(h);
  }
});

test('嵯峨: both tiers × every module (incl. none) × every skill — DP, rule, module trait / damage scale, 清明 numbers of that loadout', () => {
  for (const [id, m] of ALL) for (const s of rec(id).skills) {
    const tag = `${id} ${m} ${s.skillId}`;
    const t = typeOf(id, m);
    const h = run({ units: [U(id, s.skillId, 9, 4, { carryState: READY, ...opt(m) })], enemies: [{ key: 'enemy_walker', route: 0 }, { key: 'enemy_dummy', pos: [9, 6], time: 0.1 }] });
    const u = h.unit(id);
    assert.equal(u.kit.skillSource, 'skills', tag);
    const before = dpBefore(h, () => u.skill.activations === 1, 20);
    const rule = { [S1]: 'SP_FULL', [S2]: 'SKILL_RANGE', [S3]: 'DEFAULT' }[s.skillId];
    assert.equal(u.skill.rule, rule, tag);
    if (s.skillId !== S3) assert.equal(dp(h) - before, s.bb.cost, `${tag}: +cost`);
    else {
      h.runUntil(() => !u.skill.active, s.duration + 1);
      assert.equal(dp(h) - before, s.bb.value, `${tag}: +value over the skill`);
    }
    // SOL-X trait while she blocks the walker
    assert.ok(h.runUntil(() => u.blocking.length > 0, 20), tag);
    h.step(1);
    assert.equal(!!u.findBuff('saga:solX'), t === 'SOL-X', `${tag}: SOL-X trait`);
    // SOL-X hidden part (level 3 only)
    const e = h.enemy('enemy_dummy');
    e.hp = e.s.maxHp * 0.4;
    const sc = t === 'SOL-X' ? talOf(id, -1, m).damage_scale ?? 1 : 1;
    assert.ok(near(h.b.dealDamage(u, e, { amount: 1000, type: 'true' }), 1000 * sc), `${tag}: damage scale`);
    // 清明 with this loadout's numbers
    const t1 = talOf(id, 1, m ?? null);
    h.b.dealDamage(e, u, { amount: u.hp - u.s.maxHp * t1.hp_ratio + 1, type: 'true' });
    assert.ok(near(u.s.dodgePhys, t1.prob) && near(u.findBuff('saga:clarity').timeLeft, t1.duration), `${tag}: 清明`);
    done(h);
  }
});

test('嵯峨: every skill × tier × module survives a real wave without content errors and casts', () => {
  for (const [id, m] of ALL) for (const s of rec(id).skills) {
    const h = makeBattle({ defs: DEFS, seed: 3, timeLimit: 60,
      units: [U(id, s.skillId, 9, 4, { carryState: READY, ...opt(m) }), { chessId: 'chess_char_2_06_a', row: 10, col: 6 }],
      enemies: [{ key: 'enemy_1007_slime', count: 8, interval: 1.5 }, { key: 'enemy_1007_slime', route: 1, count: 8, interval: 1.5, time: 3 }] });
    h.runToEnd(90);
    done(h);
    assert.ok(h.b.allyUnits.find((x) => x.defId === id).skill.activations > 0, `${id} ${m} ${s.skillId} casts`);
  }
});
