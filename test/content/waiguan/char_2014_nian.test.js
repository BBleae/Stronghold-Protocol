// test/content/waiguan/char_2014_nian.test.js — 年 外援 kit (server/sim/content/kits/waiguan/char_2014_nian.js).
// Every skill (normal Lv4 + elite Lv7), each talent (incl. the elite upgrades), each module choice, a smoke wave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, chessRec, checkInvariants } from '../../helpers/battleHarness.js';
import { DataSource, getDefaultSource } from '../../../server/sim/simdata.js';
import { getData } from '../../../server/data.js';
import { waiguanRecords } from '../../../shared/waiguan.js';
import { skillSpecSource } from '../../../server/sim/content/index.js';
import WAIGUAN from '../../../server/sim/content/kits/waiguan/index.js';

const CHAR = 'char_2014_nian';
const ID5 = `chess_char_diy_5_${CHAR}_a`, ID6 = `chess_char_diy_6_${CHAR}_a`;
const ELITE5 = ID5.replace(/_a$/, '_b'), ELITE6 = ID6.replace(/_a$/, '_b');
/** Both tiers' elites: tier V will carry module level 1 (REQUIREMENTS §7) — expectations come from each record. */
const ELITES = [ELITE5, ELITE6];
const PRO_X = 'uniequip_002_nian', PRO_Y = 'uniequip_003_nian';
const REC = waiguanRecords(getData({ log: { warn() {}, error() {}, info() {} } }).waiguan);
const DS = new DataSource({ chess: REC }, getDefaultSource());
const rec = (id) => REC[id];
const skillOf = (id, sid) => rec(id).skills.find((s) => s.skillId === sid);
/** Talent blackboard of the loadout-resolved record (module `moduleId`), by data index. */
const talOf = (id, i, moduleId = null) => DS.getChess(id, { moduleId }).raw.talents.find((t) => t.index === i)?.bb ?? {};
const traitOf = (id, moduleId = null) => DS.getChess(id, { moduleId }).traitBb ?? {};
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e7, speed: 0, ...o });
const ally = (id, profession) => chessRec({ id, profession, skill: null, stats: { maxHp: 3000, atk: 1, def: 100, blockCnt: 2 } });
const DEFS = {
  chess: { ...REC, test_tank_a: ally('test_tank_a', 'TANK'), test_guard_a: ally('test_guard_a', 'WARRIOR') },
  enemies: {
    enemy_dummy: dummy('enemy_dummy'),
    // a ranged attacker that targets her from (9, 8): 400 ATK ⇒ 5 % floor (20) through her DEF
    enemy_shooter: dummy('enemy_shooter', { range: 6, atk: 400 }),
    // walks route 0 (row 9, right → left) into her block; deals nothing
    enemy_walker: enemyRec({ key: 'enemy_walker', hp: 1e7, speed: 1, atk: 0 }),
  },
};
const HOOKS = ['damaged', 'skillStart', 'skillEnd', 'attack', 'spGain', 'statusApplied'];
/** Battle with the 外援 records + synthetic allies / enemies; `captureNoisy` keeps the damaged / attack / spGain contexts. */
const run = (o) => makeBattle({ defs: DEFS, seed: 7, timeLimit: 300, autoFinish: false, hooks: HOOKS, captureNoisy: true, ...o });
/** Operator entry with skill `sid` selected (board coords: row 9–12, col 2–10); `moduleId` only for the elite. */
const U = (id, sid, row, col, o = {}) => ({ chessId: id, row, col, skillIndex: skillOf(id, sid).index, ...o });
const done = (h) => { checkInvariants(h.b); assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0])); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const has = (c, tag) => !!c.dmg?.tags?.includes(tag);
/** An enemy hit on `u` (TAKE_DAMAGE): 1 phys from the first living enemy. */
const poke = (h, u) => h.b.dealDamage(h.b.enemies.find((e) => e.alive), u, { amount: 1, type: 'phys', isAttack: true });
/** Elite without module (the skill numbers alone) and the normal chess. */
const LEVELS = [[ID6, {}], [ELITE6, { moduleId: 'none' }]];

test('年: every skill of both tiers (normal + elite, every module) is hand-authored', () => {
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

test('年: every skill keeps the 重装 TAKE_DAMAGE rule — cast at the first hit, one a 护盾 layer absorbs included', () => {
  for (const id of [ID6, ELITE6]) for (const s of rec(id).skills) {
    const h = run({ units: [U(id, s.skillId, 9, 4, { carryState: { sp: 999 } })], enemies: [{ key: 'enemy_shooter', pos: [9, 8] }] });
    const u = h.unit(id);
    assert.equal(u.skill.rule, 'TAKE_DAMAGE');
    assert.equal(u.skill.kind, 'duration');
    assert.ok(h.runUntil(() => u.skill.active, 5), `${s.skillId} casts`);
    const first = h.hooksOf('damaged').find((c) => c.target === u);
    assert.equal(first.amount, 0, 'the first hit is absorbed by a layer');
    assert.equal(h.hooksOf('skillStart')[0].t, first.t, 'cast on that hit');
    assert.equal(h.hooksOf('skillStart')[0].reason, 'TAKE_DAMAGE');
    done(h);
  }
});

test('年 S1 锡灼: DEF +def, ATK +atk, normal attacks deal arts damage (normal Lv4 and elite Lv7 numbers)', () => {
  for (const [id, o] of LEVELS) {
    const bb = skillOf(id, 'skchr_nian_1').bb;
    const h = run({ units: [U(id, 'skchr_nian_1', 9, 4, { carryState: { sp: 999 }, ...o })], enemies: [{ key: 'enemy_dummy', pos: [9, 5] }] });
    const u = h.unit(id);
    h.run(1.5);
    assert.ok(h.hooksOf('damaged').some((c) => c.source === u && c.dmg.isAttack && c.type === 'phys'), 'phys before the skill');
    poke(h, u);
    assert.ok(u.skill.active);
    assert.ok(near(u.s.def, u.base.def * (1 + bb.def)) && near(u.s.atk, u.base.atk * (1 + bb.atk)));
    const t0 = h.b.time;
    h.run(5);
    const atk = h.hooksOf('damaged').filter((c) => c.source === u && c.dmg.isAttack && c.t >= t0);
    assert.ok(atk.length >= 2);
    for (const c of atk) { assert.equal(c.type, 'arts'); assert.ok(near(c.amount, u.s.atk)); }
    done(h);
  }
});

test('年 S2 铜印: no attack; DEF +def, block +block_cnt; every enemy attack on her: atk_scale × ATK arts back + silence', () => {
  for (const [id, o] of LEVELS) {
    const bb = skillOf(id, 'skchr_nian_2').bb;
    const h = run({ units: [U(id, 'skchr_nian_2', 9, 4, { carryState: { sp: 999 }, ...o })], enemies: [{ key: 'enemy_shooter', pos: [9, 8] }, { key: 'enemy_dummy', pos: [9, 5] }] });
    const u = h.unit(id);
    assert.ok(h.runUntil(() => u.skill.active, 5));
    const shooter = h.enemy('enemy_shooter');
    assert.ok(near(u.s.def, u.base.def * (1 + bb.def)));
    assert.equal(u.s.blockCnt, u.base.blockCnt + bb.block_cnt);
    const t0 = h.hooksOf('skillStart')[0].t;
    h.run(12);
    assert.equal(h.hooksOf('attack').filter((c) => c.attacker === u && c.t >= t0).length, 0, 'stops attacking');
    const hits = h.hooksOf('damaged').filter((c) => c.target === u && c.source === shooter && c.dmg.isAttack && c.t > t0);
    const counters = h.hooksOf('damaged').filter((c) => c.source === u && has(c, 'nianCounter'));
    assert.ok(hits.length >= 4);
    assert.equal(counters.length, hits.length, 'one counter per attack taken (the casting hit aside)');
    for (const c of counters) { assert.equal(c.target, shooter); assert.equal(c.type, 'arts'); assert.ok(near(c.amount, u.s.atk * bb.atk_scale)); }
    const sil = h.hooksOf('statusApplied').filter((c) => c.source === u && c.status === 'silence');
    assert.equal(sil.length, hits.length);
    assert.ok(sil.every((c) => c.target === shooter && near(c.duration, bb.silence)));
    done(h);
  }
});

test('年 S3 铁御: ATK +self.atk; the other operators on x-2 DEF +ally.def, block +1, 抵抗 — for the skill only', () => {
  for (const [id, o] of LEVELS) {
    const s = skillOf(id, 'skchr_nian_3'), bb = s.bb;
    const h = run({ units: [U(id, 'skchr_nian_3', 9, 4, { carryState: { sp: 999 }, ...o }), { chessId: 'test_tank_a', row: 10, col: 4 },
      { chessId: 'test_guard_a', row: 11, col: 5 }, { chessId: 'test_guard_a', row: 12, col: 8 }], enemies: [{ key: 'enemy_dummy', pos: [9, 9] }] });
    const u = h.unit(id), tank = h.unit('test_tank_a');
    const [near1, far] = h.b.allyUnits.filter((a) => a.defId === 'test_guard_a');
    h.run(0.5);
    const blk = u.s.blockCnt, def = u.s.def;
    poke(h, u);
    h.run(0.5);
    assert.ok(u.skill.active);
    assert.ok(near(u.s.atk, u.base.atk * (1 + bb['nian_s_3[self].atk'])));
    assert.ok(u.s.blockCnt === blk && near(u.s.def, def), 'her own DEF / block unchanged');
    for (const a of [tank, near1]) {
      assert.ok(near(a.s.def, a.base.def * (1 + bb['nian_s_3[ally].def'])), `${a.defId} DEF ${a.s.def}`);
      assert.equal(a.s.blockCnt, a.base.blockCnt + bb['nian_s_3[ally].block_cnt']);
      assert.equal(h.b.resistOf(a), -bb.one_minus_status_resistance, '抵抗');
    }
    h.b.applyStatus(tank, 'stun', { duration: 2 });
    assert.ok(near(tank.findBuff('stun').timeLeft, 2 * (1 + bb.one_minus_status_resistance)), 'a stun lasts half as long');
    assert.ok(far.s.def === far.base.def && far.s.blockCnt === far.base.blockCnt && h.b.resistOf(far) === 0, 'off the skill range');
    assert.ok(h.runUntil(() => !u.skill.active, s.duration + 1));
    h.step(1);
    for (const a of [tank, near1]) assert.ok(a.s.def === a.base.def && a.s.blockCnt === a.base.blockCnt && h.b.resistOf(a) === 0, 'gone with the skill');
    done(h);
  }
});

test('年 T1 积甲成山: every 重装 of her team max HP +max_hp (PRO-Y +21 %), others not; two copies: the strongest once', () => {
  for (const [id, moduleId] of [[ID6, undefined], [ELITE6, null], [ELITE6, PRO_Y]]) {
    const hp = talOf(id, 0, moduleId).max_hp;
    const h = run({ units: [U(id, 'skchr_nian_1', 9, 4, moduleId !== undefined ? { moduleId } : {}), { chessId: 'test_tank_a', row: 10, col: 4 }, { chessId: 'test_guard_a', row: 11, col: 4 }] });
    h.run(1);
    const tank = h.unit('test_tank_a'), guard = h.unit('test_guard_a');
    assert.ok(near(tank.s.maxHp, tank.base.maxHp * (1 + hp)), `${id} ${moduleId}: tank ${tank.s.maxHp}`);
    assert.equal(guard.s.maxHp, guard.base.maxHp);
    assert.equal(tank.hp, tank.s.maxHp, 'deployed at full HP');
    done(h);
  }
  assert.ok(talOf(ELITE6, 0, PRO_Y).max_hp > talOf(ID6, 0).max_hp);
  const h = run({ units: [U(ID6, 'skchr_nian_1', 9, 4), U(ELITE6, 'skchr_nian_1', 9, 6, { uid: 2, moduleId: PRO_Y }), { chessId: 'test_tank_a', row: 10, col: 4 }] });
  h.run(1);
  const tank = h.unit('test_tank_a');
  assert.equal(tank.buffs.filter((b) => b.key === 'nian:armor').length, 1);
  assert.ok(near(tank.s.maxHp, tank.base.maxHp * (1 + talOf(ELITE6, 0, PRO_Y).max_hp)));
  done(h);
});

test('年 T2 干明可鉴: `times` 护盾 layers per deployment; PRO-X: each broken layer ATK/DEF +7 % (≤ 3) and +3 SP', () => {
  for (const [id, moduleId] of [[ID6, undefined], [ELITE6, 'none'], [ELITE6, null], [ELITE5, null]]) {
    const t1 = talOf(id, 1, moduleId);
    const h = run({ units: [U(id, 'skchr_nian_3', 9, 4, moduleId !== undefined ? { moduleId } : {})], enemies: [{ key: 'enemy_shooter', pos: [9, 8] }] });
    const u = h.unit(id);
    h.step(1);
    assert.equal(u.findBuff('nian:shield').shieldHits, t1.times);
    h.run(7);
    const hits = h.hooksOf('damaged').filter((c) => c.target === u);
    assert.deepEqual(hits.slice(0, t1.times + 1).map((c) => c.amount > 0), [...Array(t1.times).fill(false), true], 'layers absorb whole hits');
    assert.equal(u.findBuff('nian:shield'), null);
    const temper = u.findBuff('nian:temper');
    const gains = h.hooksOf('spGain').filter((c) => c.unit === u && c.reason === 'talent').map((c) => c.amount);
    if (t1.sp) {
      assert.equal(temper.stacks, Math.min(t1.times, t1.max_stack_cnt));
      assert.ok(near(u.s.atk, u.base.atk * (1 + t1.atk * temper.stacks)) && near(u.s.def, u.base.def * (1 + t1.def * temper.stacks)));
      assert.deepEqual(gains, Array(t1.times).fill(t1.sp));
    } else {
      assert.equal(temper, null, `${moduleId}: no upgrade`);
      assert.deepEqual(gains, []);
    }
    // every deployment: fresh layers, the stacks gone
    h.b.retreat(u);
    assert.ok(h.b.redeploy(u));
    assert.equal(u.findBuff('nian:shield').shieldHits, t1.times);
    assert.equal(u.findBuff('nian:temper'), null);
    done(h);
  }
});

test('年 module PRO-X: DEF +def while blocking; module none / PRO-Y: no such bonus', () => {
  for (const E of ELITES) for (const moduleId of [null, 'none', PRO_Y]) {
    const bd = traitOf(E, moduleId).def ?? 0;
    assert.equal(bd > 0, moduleId === null, `${E} ${moduleId}`);
    const h = run({ units: [U(E, 'skchr_nian_3', 9, 4, { moduleId })], enemies: [{ key: 'enemy_walker', route: 0 }] });
    const u = h.unit(E);
    const defNow = () => u.base.def * (1 + (u.blocking.length ? bd : 0) + num(u.findBuff('nian:temper')?.stacks) * num(talOf(E, 1, moduleId).def));
    h.run(1);
    assert.equal(u.blocking.length, 0);
    assert.ok(near(u.s.def, defNow()), `${moduleId} free ${u.s.def}`);
    assert.ok(h.runUntil(() => u.blocking.length > 0, 20), 'blocks the walker');
    h.step(1);
    assert.ok(near(u.s.def, defNow()), `${moduleId} blocking ${u.s.def}`);
    done(h);
  }
});

test('年 module PRO-Y: blocks 4; per 重装 on the field (≤ 3, herself included) max HP and healing taken +4 %', () => {
  for (const E of ELITES) {
    const tb = traitOf(E, PRO_Y);
    const t0 = talOf(E, 0, PRO_Y).max_hp;
    // the per-重装 part sits in the module's trait part from level 2 on (level 1: a display-only trait, nothing)
    const on = tb.heal_scale_addition > 0;
    for (const tanks of [0, 1, 3]) {
      const units = [U(E, 'skchr_nian_1', 9, 4, { moduleId: PRO_Y })];
      for (let i = 0; i < tanks; i++) units.push({ chessId: 'test_tank_a', row: 10 + (i % 3), col: 3 + Math.floor(i / 3) });
      const h = run({ units });
      h.run(1);
      const u = h.unit(E);
      const n = on ? Math.min(tb.max_stack_cnt, 1 + tanks) : 0;
      assert.equal(u.s.blockCnt, 4);
      assert.ok(near(u.s.healingTakenMul, on ? Math.min(tb.heal_scale_max_value, tb.heal_scale + tb.heal_scale_addition * n) : 1), `${E} ${tanks}: ${u.s.healingTakenMul}`);
      assert.ok(near(u.s.maxHp, u.base.maxHp * (1 + t0 + (on ? tb.max_hp * n : 0))), `${E} ${tanks}: HP ${u.s.maxHp}`);
      done(h);
    }
  }
  for (const moduleId of [null, 'none']) {
    const h = run({ units: [U(ELITE6, 'skchr_nian_1', 9, 4, { moduleId }), { chessId: 'test_tank_a', row: 10, col: 4 }] });
    h.run(1);
    const u = h.unit(ELITE6);
    assert.equal(u.s.blockCnt, 3);
    assert.equal(u.s.healingTakenMul, 1);
    done(h);
  }
});

test('年 S2: the counter answers attacks only, with her current ATK, tagged counter, never dodged', () => {
  for (const [id, o] of LEVELS) {
    const bb = skillOf(id, 'skchr_nian_2').bb;
    const h = run({ units: [U(id, 'skchr_nian_2', 9, 4, { carryState: { sp: 999 }, ...o })], enemies: [{ key: 'enemy_shooter', pos: [9, 8] }] });
    const u = h.unit(id);
    assert.ok(h.runUntil(() => u.skill.active, 5));
    const sh = h.enemy('enemy_shooter');
    h.b.addBuff(sh, { key: 'test:dodge', mods: { dodgeArts: 1 } }); // dodges every dodgeable arts damage
    const counters = () => h.hooksOf('damaged').filter((c) => c.source === u && has(c, 'nianCounter'));
    const n0 = counters().length;
    h.b.dealDamage(sh, u, { amount: 500, type: 'arts' }); // a damage that is not an attack
    assert.equal(counters().length, n0, 'no counter on a non-attack damage');
    h.b.addBuff(u, { key: 'test:atk', mods: { atkPct: 1 } });
    const t0 = h.b.time;
    h.run(6);
    const later = counters().filter((c) => c.t >= t0);
    assert.ok(later.length >= 2);
    for (const c of later) {
      assert.ok(near(c.amount, u.s.atk * bb.atk_scale), `the ATK of the moment: ${c.amount}`);
      assert.ok(has(c, 'counter') && c.dmg.canDodge === false);
    }
    done(h);
  }
});

test('年 S3: operators only (a summon in range is not buffed); two 年: the stronger ally part holds without flicker', () => {
  // 3_19 (pool) and its placed wolf piece at (10, 5), inside her x-2; a 重装 at (10, 4) as the control
  const h = run({ units: [U(ID6, 'skchr_nian_3', 9, 4, { carryState: { sp: 999 }, uid: 1 }), { chessId: 'chess_char_3_19_a', row: 12, col: 3, uid: 2 },
    { kind: 'token', tokenId: 'token_10028_vigil_wolf', ownerUid: 2, row: 10, col: 5, uid: 3 }, { chessId: 'test_tank_a', row: 10, col: 4, uid: 4 }],
  enemies: [{ key: 'enemy_dummy', pos: [9, 9] }] });
  h.step(1);
  const u = h.unit(1), wolf = h.unit(3), tank = h.unit(4);
  assert.ok(wolf && wolf.kind === 'token' && wolf.alive && wolf.deployed, 'the wolf stands in her range');
  const wolfDef = wolf.s.def, wolfBlk = wolf.s.blockCnt;
  poke(h, u);
  h.run(0.6);
  assert.ok(u.skill.active && tank.findBuff('nian:ironGuard'));
  assert.ok(!wolf.findBuff('nian:ironGuard') && wolf.s.def === wolfDef && wolf.s.blockCnt === wolfBlk && h.b.resistOf(wolf) === 0, 'a summon is no 干员');
  done(h);
  // two 年 (Lv4 0.4 and Lv7 0.5), the 重装 at (10, 5) on both skill ranges; the weaker one casts last
  const g = run({ units: [U(ID6, 'skchr_nian_3', 9, 4, { carryState: { sp: 999 }, uid: 1 }), U(ELITE6, 'skchr_nian_3', 9, 6, { carryState: { sp: 999 }, moduleId: 'none', uid: 2 }),
    { chessId: 'test_tank_a', row: 10, col: 5, uid: 3 }], enemies: [{ key: 'enemy_dummy', pos: [9, 9] }] });
  g.step(1);
  const [lo, hi, t] = [g.unit(1), g.unit(2), g.unit(3)];
  poke(g, hi);
  g.step(3);
  poke(g, lo);
  assert.ok(lo.skill.active && hi.skill.active);
  const strong = skillOf(ELITE6, 'skchr_nian_3').bb['nian_s_3[ally].def'];
  for (let i = 0; i < 60; i++) {
    g.step(1);
    assert.ok(near(t.s.def, t.base.def * (1 + strong)), `step ${i}: DEF ${t.s.def}`);
    assert.equal(t.findBuff('nian:ironGuard').source, hi);
  }
  done(g);
});

test('年 T1: her player only (two players on a 联防 field), kept through a knock-out; PRO-Y counts her player\'s 重装 only', () => {
  const players = [
    { playerId: 'p1', seat: 0, side: 'L', colOffset: 0, bonds: {}, units: [
      { uid: 1, kind: 'chess', chessId: ELITE6, moduleId: PRO_Y, skillIndex: 0, row: 9, col: 4 }, { uid: 2, kind: 'chess', chessId: 'test_tank_a', row: 10, col: 4 }] },
    { playerId: 'p2', seat: 1, side: 'L', colOffset: 8, bonds: {}, units: [
      { uid: 3, kind: 'chess', chessId: 'test_tank_a', row: 10, col: 4 }, { uid: 4, kind: 'chess', chessId: 'test_tank_a', row: 11, col: 4 }] },
  ];
  const h = run({ kind: 'unite', players });
  h.run(1);
  const u = h.unit(1), mine = h.unit(2), theirs = [h.unit(3), h.unit(4)];
  assert.ok([u, mine, ...theirs].every((x) => x.alive && x.deployed));
  const hp = talOf(ELITE6, 0, PRO_Y).max_hp, tb = traitOf(ELITE6, PRO_Y);
  assert.ok(near(mine.s.maxHp, mine.base.maxHp * (1 + hp)));
  for (const x of theirs) assert.equal(x.s.maxHp, x.base.maxHp, 'a teammate\'s 重装: not hers');
  const n = 2; // herself + her own 重装 (the teammate's two do not count)
  assert.ok(near(u.s.healingTakenMul, tb.heal_scale + tb.heal_scale_addition * n), `${u.s.healingTakenMul}`);
  h.b.kill(mine);
  assert.ok(!mine.alive);
  assert.ok(h.b.redeploy(mine));
  assert.ok(near(mine.s.maxHp, mine.base.maxHp * (1 + hp)) && mine.hp === mine.s.maxHp, 'persists through the knock-out');
  done(h);
});

test('年 PRO-X × S2 / S3: the skill, the blocking DEF and the layer stacks add up', () => {
  const t1 = talOf(ELITE6, 1), tb = traitOf(ELITE6);
  const s2 = skillOf(ELITE6, 'skchr_nian_2').bb, s3 = skillOf(ELITE6, 'skchr_nian_3').bb;
  const h = run({ units: [U(ELITE6, 'skchr_nian_2', 9, 4, { carryState: { sp: 999 } })], enemies: [{ key: 'enemy_walker', route: 0 }] });
  const u = h.unit(ELITE6);
  assert.ok(h.runUntil(() => u.blocking.length > 0, 20));
  poke(h, u);
  poke(h, u);
  h.step(1);
  assert.ok(u.skill.active);
  const k = u.findBuff('nian:temper').stacks;
  assert.ok(k >= 2);
  assert.ok(near(u.s.def, u.base.def * (1 + s2.def + tb.def + t1.def * k)), `S2 DEF ${u.s.def}`);
  assert.ok(near(u.s.atk, u.base.atk * (1 + t1.atk * k)));
  assert.equal(u.s.blockCnt, u.base.blockCnt + s2.block_cnt);
  done(h);
  const g = run({ units: [U(ELITE6, 'skchr_nian_3', 9, 4, { carryState: { sp: 999 } })], enemies: [{ key: 'enemy_dummy', pos: [9, 9] }] });
  const v = g.unit(ELITE6);
  g.step(1);
  for (let i = 0; i < 3; i++) poke(g, v);
  g.step(1);
  assert.ok(v.skill.active && v.findBuff('nian:temper').stacks === 3);
  assert.ok(near(v.s.atk, v.base.atk * (1 + s3['nian_s_3[self].atk'] + t1.atk * 3)), `S3 ATK ${v.s.atk}`);
  assert.ok(near(v.s.def, v.base.def * (1 + t1.def * 3)), 'not blocking: no trait DEF');
  done(g);
});

test('年: every skill × tier survives a real wave without content errors and casts', () => {
  for (const id of [ID5, ID6, ID5.replace(/_a$/, '_b'), ELITE6]) {
    for (const s of rec(id).skills) {
      const h = makeBattle({ defs: DEFS, seed: 3, timeLimit: 60,
        units: [U(id, s.skillId, 9, 4, { carryState: { sp: 999 } }), { chessId: 'chess_char_2_06_a', row: 10, col: 6 }],
        enemies: [{ key: 'enemy_1007_slime', count: 8, interval: 1.5 }, { key: 'enemy_1007_slime', route: 1, count: 8, interval: 1.5, time: 3 }] });
      h.runToEnd(90);
      done(h);
      assert.ok(h.b.allyUnits.find((x) => x.defId === id).skill.activations > 0, `${id} ${s.skillId} casts`);
    }
  }
});

function num(v, d = 0) { return typeof v === 'number' && Number.isFinite(v) ? v : d; }
