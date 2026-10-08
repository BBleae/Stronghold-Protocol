// test/content/op_marcil.test.js — the 自选 operator kit of 玛露西尔 (char_4141_marcil, 6★ 扩散术师, a collab pick of this
// fork — tools/build-data.mjs FORK_INCLUDE_COLLAB_PICKS, the fork owner's decision of 2026-10-08; kit
// server/sim/content/kits/ops/op-marcil.js), fielded the production way (a DIY slot + its `diy` pick, simdata getDiy) in
// every form: tiers 5 / 6, normal (E2 Lv1, skill rank 4, no module) and elite (E2 Lv60, rank 7) with no module or SPC-Y
// “才女的藏书” at stage 1 (tier 5) / 3 (tier 6). Every number is read back from data/backups.json (the form of that slot
// status); the fidelity checklist of kits/README.md item by item: the 魔力 (her skill's SP bar), the 吟唱, every skill at
// ranks 4 / 7, both talents, the module, the casts (the data's DEFAULT / MARCILS2 rules), targeting and damage typing.
// Run: node --test test/content/op_marcil.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBattle, enemyRec, chessRec, flatStage, checkInvariants } from '../helpers/battleHarness.js';
import { KITTED_CHARS, OPERATOR_KITS, KITS } from '../../server/sim/content/kits/index.js';
import { diyPool, validateDiyPicks } from '../../shared/diy.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../../data/${f}.json`, import.meta.url), 'utf8'));
const CHESS = load('chess');
const BACKUPS = load('backups');
const ID = 'char_4141_marcil';
const FORMS = BACKUPS.units[ID].forms;
const SLOT = { 5: 'chess_char_5_diy1_a', 6: 'chess_char_6_diy1_a' };
const SPCY = 'uniequip_002_marcil';
const S1 = 'skchr_marcil_1', S2 = 'skchr_marcil_2', S3 = 'skchr_marcil_3';
const formOf = (tier, elite) => FORMS[elite ? (tier === 5 ? '2/60/7/1' : '2/60/7/3') : '2/1/4/0'];
const skillOf = (tier, elite, id) => formOf(tier, elite).skills.find((s) => s.skillId === id);
const modOf = (tier, mod) => (mod ? formOf(tier, true).modules.find((m) => m.uniEquipId === mod) : null);
/** Talent `i` of a form with its module's change (SPC-Y stage 3: 可靠的同伴 mana_init 40). */
const talentOf = (tier, elite, mod, i) => (mod ? modOf(tier, mod).talentChanges.find((c) => c.talentIndex === i) : null) ?? formOf(tier, elite).talents.find((c) => c.index === i);
const approx = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e9, speed: 0, mass: 0, ...o });
const ENEMIES = { enemy_dummy: dummy('enemy_dummy'), enemy_fly: dummy('enemy_fly', { motion: 'FLY' }) };
/** A plain melee ally with no skill (the S1 heal target); 莱欧斯小队 records for 可靠的同伴. */
const ALLY = chessRec({ id: 'test_marcil_ally_a', skill: null, stats: { maxHp: 10000, atk: 0, def: 0 } });
const LAIOS = ['char_4142_laios', 'char_4143_sensi', 'char_4144_chilc'];
const PARTY = Object.fromEntries(LAIOS.map((c, i) => [`test_laios${i}_a`, chessRec({ id: `test_laios${i}_a`, charId: c, skill: null, stats: { atk: 0 } })]));
/** Every 自选 form: [tier, elite, module]. */
const FORMS_ALL = [[5, false, null], [6, false, null], ...[5, 6].flatMap((t) => [null, SPCY].map((m) => [t, true, m]))];
const label = ([tier, elite, mod]) => `T${tier} ${elite ? 'elite' : 'normal'} ${mod ?? 'none'}`;

/** A battle with 玛露西尔 as uid 1 at (row, col) facing RIGHT, plus `others`. */
function field({ tier = 5, elite = false, mod = null, skill = 0, row = 10, col = 5, others = [], seed = 5, flags = {}, stage = null, setup = null, bonds = null } = {}) {
  const h = makeBattle({
    ...(bonds ? { bonds } : null),
    defs: { enemies: ENEMIES, chess: { [ALLY.chessId]: ALLY, ...PARTY } }, timeLimit: 900, autoFinish: false, seed,
    flags: { dpPerSec: 0, dpMax: 999, ...flags }, stage: stage ?? undefined,
    hooks: ['damaged', 'skillStart', 'skillEnd', 'statusApplied', 'heal', 'attack'], captureNoisy: true,
    units: [{ uid: 1, diy: { slot: SLOT[tier], charId: ID, skillIndex: skill, uniEquipId: mod }, elite, row, col }, ...others],
    setup,
  });
  h.step();
  return { h, u: h.unit(1) };
}
const hitsBy = (h, u) => h.hooksOf('damaged').filter((c) => c.source === u);
const statusBy = (h, u, key) => h.hooksOf('statusApplied').filter((c) => c.source === u && c.status === key);
const startsOf = (h, u) => h.hooksOf('skillStart').filter((c) => c.unit === u);
const endsOf = (h, u) => h.hooksOf('skillEnd').filter((c) => c.unit === u);
function done(h) {
  checkInvariants(h.b);
  assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
}
/** Her mana written the way the kit does (the bar; a full bar is its one charge). */
function setMana(u, v) {
  const sk = u.skill;
  if (v >= sk.spCost) { sk.charges = sk.maxCharges; sk.sp = sk.spCost; } else { sk.charges = 0; sk.sp = v; }
}
const chanting = (u) => !!u.mem.marcilChant;
/** The attack-type 'attack' hooks of hers that hit enemies (heals excluded). */
const attacksOn = (h, u) => h.hooksOf('attack').filter((c) => c.attacker === u && c.targets.some((t) => t.side === 'enemy'));

test('玛露西尔 in every 自选 form: her operator kit (all three skills authored), the form\'s stats + SPC-Y attributes (DP −8), 3-6 range, ranged arts splash 1.1 that hits air, block 1, 2.9 s, 协防 bonds, no summon', () => {
  assert.equal(OPERATOR_KITS[ID], KITS[ID]);
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    for (const skill of [0, 1, 2]) {
      const { h, u } = field({ tier, elite, mod, skill });
      const form = formOf(tier, elite), m = elite ? modOf(tier, mod) : null;
      const sk = form.skills[skill];
      assert.deepEqual([u.def.charId, u.def.diyFor, u.skill.id, !!u.kit.generic, u.kit.skillSource], [ID, SLOT[tier], sk.skillId, false, 'skills'], label(f));
      assert.deepEqual([u.base.maxHp, u.base.atk, u.base.def, u.base.res, u.base.aspd, u.base.cost],
        [form.stats.maxHp + (m?.attr.maxHp ?? 0), form.stats.atk + (m?.attr.atk ?? 0), form.stats.def + (m?.attr.def ?? 0), 20, 100 + (m?.attr.aspd ?? 0), 32 + (m?.attr.cost ?? 0)], `${label(f)}: stats`);
      assert.deepEqual([u.s.blockCnt, u.profile.attack, u.profile.dmgType, u.profile.canHitFly, u.profile.groundOnly, u.profile.splashRadius, u.base.bat],
        [1, 'ranged', 'arts', true, false, 1.1, 2.9], `${label(f)}: 扩散术师`);
      assert.deepEqual(u.liveRangeGrid, form.rangeGrid, `${label(f)}: 3-6`);
      assert.deepEqual([u.def.bonds, u.def.raw.tokens], [['emptyShip'], []], `${label(f)}: bonds / no summon`);
      // every skill: a toggle cast by the kit, the bar = the carried skill's mana cap
      assert.deepEqual([u.skill.kind, u.skill.rule, u.skill.spCost, sk.bb.mana_max, sk.spType], ['toggle', 'NEVER', 80, 80, 'INCREASE_WITH_TIME'], `${label(f)}: the 魔力 bar`);
      assert.ok(!u.s.flags.camou && !u.s.flags.stealth && !u.s.flags.untargetable, `${label(f)}: ground enemies target her`);
      done(h);
    }
  }
  // E2 Lv1 1407 / 801 / 109, E2 Lv60 1671 / 898 / 123; SPC-Y cost −8, ATK +51 / +82, ASPD +5 / +7
  assert.deepEqual([FORMS['2/1/4/0'].stats.maxHp, FORMS['2/1/4/0'].stats.atk, FORMS['2/60/7/1'].stats.maxHp, FORMS['2/60/7/1'].stats.atk], [1407, 801, 1671, 898]);
  assert.deepEqual([modOf(5, SPCY).attr, modOf(6, SPCY).attr], [{ cost: -8, atk: 51, aspd: 5 }, { cost: -8, atk: 82, aspd: 7 }]);
  assert.equal(modOf(6, SPCY).traitOverride.moduleDesc, '部署费用减少');
});

test('a 自选 pick: 玛露西尔 is offered at tiers 5 and 6 (the fork\'s collab picks) and a roster with her and SPC-Y passes validateDiyPicks', () => {
  const data = { chess: CHESS, backups: BACKUPS };
  assert.ok(KITTED_CHARS.includes(ID));
  assert.ok(BACKUPS.diy.ownedPool.includes(ID));
  for (const t of [5, 6]) assert.ok(diyPool(t, { data, kitted: KITTED_CHARS }).includes(ID), `tier ${t}`);
  assert.deepEqual(validateDiyPicks({ [SLOT[6]]: { charId: ID, skillIndex: 2, uniEquipId: SPCY } }, { data, kitted: KITTED_CHARS }),
    { ok: true, picks: { [SLOT[6]]: { charId: ID, skillIndex: 2, uniEquipId: SPCY } } });
});

test('魔力: a battle starts with the skill\'s mana_init + 可靠的同伴\'s (25; SPC-Y stage 3: 40), recovers none on the field, takes SP gifts up to the cap 80, and an SP-cost modifier never changes the cap', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    for (const skill of [0, 1, 2]) {
      const sk = formOf(tier, elite).skills[skill];
      const t1 = talentOf(tier, elite, mod, 1);
      const init = sk.bb.mana_init + t1.bb.mana_init;
      assert.equal(sk.initSp, sk.bb.mana_init, `${label(f)}: the skill's initSp is its mana_init`);
      const { h, u } = field({ tier, elite, mod, skill });
      approx(u.skill.sp, Math.min(80, init), `${label(f)} S${skill + 1}: ${sk.bb.mana_init} + ${t1.bb.mana_init}`);
      if (Math.min(80, init) < 80) {
        h.run(10);
        approx(u.skill.sp, init, `${label(f)} S${skill + 1}: no natural recovery`);
      }
      done(h);
    }
  }
  assert.deepEqual([talentOf(5, true, SPCY, 1).bb.mana_init, talentOf(6, true, SPCY, 1).bb.mana_init, talentOf(6, true, null, 1).bb.mana_init], [25, 40, 25]);
  {
    const { h, u } = field({ skill: 1 });
    u.skill.gainSp(30, 'talent');
    approx(u.skill.sp, 65, 'an SP gift adds to the mana');
    u.skill.gainSp(30, 'talent');
    assert.deepEqual([u.skill.sp, u.skill.charges], [80, 1], 'capped at 80 (a full bar)');
    // a buff above the base recovery still counts (only the natural 1 / s is gone)
    setMana(u, 10);
    h.b.addBuff(u, { key: 'test:sp', mods: { spRecoveryFlat: 0.5 } });
    h.run(4);
    approx(u.skill.sp, 12, 'base recovery removed, +0.5 / s kept', 1e-3);
    // the 盟约 that scales a skill's cost (spCostMul) is undone: PRTS 备注 "不受技力需求修改效果影响"
    u.skill.spCostMul = 0.7;
    h.step();
    assert.deepEqual([u.skill.spCostMul, u.skill.spCost], [1, 80]);
    done(h);
  }
});

test('the 魔力 cap ignores 绝技 tier 2 (elite SP cost ×0.7, written before the battle-start deployment): an elite starts with all her mana (80 / 65), not floor(80 × 0.7) = 56; her bar stays whole', () => {
  const SUNT = { suntShip: { count: 5, active: true, tier: 2, layers: 0 } };
  for (const [tier, mod, skill] of [[6, SPCY, 2], [6, SPCY, 0], [6, null, 2], [5, SPCY, 2]]) {
    const lbl = `T${tier} elite ${mod ?? 'none'} S${skill + 1}`;
    const plain = field({ tier, elite: true, mod, skill });
    const want = plain.u.skill.sp;
    assert.ok(want > 56, `${lbl}: starts above 56 (${want})`);
    const { h, u } = field({ tier, elite: true, mod, skill, bonds: SUNT });
    approx(u.skill.sp, want, `${lbl}: her mana with 绝技 tier 2`);
    assert.deepEqual([u.skill.spCost, u.skill.spCostMul, u.skill.charges], [80, 1, want >= 80 ? 1 : 0], `${lbl}: the cap and the bar`);
    approx(u.skill.spTotal, u.skill.sp, `${lbl}: what 联防 would carry = her mana`);
    u.skill.spCostMul = 0.5;
    assert.deepEqual([u.skill.spCost, u.skill.sp], [80, want], `${lbl}: a later write changes nothing either`);
    h.b.addBuff(u, { key: 'test:flat', mods: { spCostFlat: -10 } });
    h.step();
    assert.equal(u.skill.spCost, 80, `${lbl}: nor a flat change`);
    done(h);
    done(plain.h);
  }
});

test('建校以来第一才女: ATK +25 % (full potential) and splash 1.5 while her mana ≥ 1; ATK as is and the branch\'s 1.1 at 0', () => {
  for (const [tier, elite] of [[5, false], [6, true]]) {
    const t0 = formOf(tier, elite).talents[0].bb;
    assert.deepEqual([t0.atk, t0.sp, t0.interval, t0.mana_add], [0.25, 1, 1, 1]);
    // S3 picked with mana under its skill_cost_min_sp (8): no cast, plain attacks
    for (const mana of [5, 0]) {
      const { h, u } = field({ tier, elite, skill: 2 });
      setMana(u, mana);
      h.step(2);
      approx(u.s.atk, u.base.atk * (mana >= 1 ? 1 + t0.atk : 1), `T${tier} mana ${mana}: ATK`);
      const main = h.spawn('enemy_dummy', { pos: [10, 7] });
      const near = h.spawn('enemy_dummy', { pos: [10, 8.3] });   // 1.3 from the struck target, outside her range
      assert.ok(h.runUntil(() => hitsBy(h, u).some((c) => c.target === main), 4), `T${tier}: attacks`);
      h.run(0.2);
      const hits = hitsBy(h, u);
      assert.equal(hits.some((c) => c.target === near && c.dmg.isSplash), mana >= 1, `T${tier} mana ${mana}: the 1.3-away enemy is splashed only with mana`);
      for (const c of hits) assert.deepEqual([c.type, c.dmg.isAttack], ['arts', true]);
      assert.ok(!startsOf(h, u).length && !chanting(u), `T${tier}: below 8 mana S3 is never cast`);
      done(h);
    }
  }
});

test('魔力 off the field: leaving keeps the bar as mana, +1 per whole second away (cap 80), back on the bar at the redeploy; a knock-out after S3\'s 追加吟唱 loses it all', () => {
  {
    const { h, u } = field({ skill: 2 });
    setMana(u, 20);
    h.b.kill(u);
    assert.ok(!u.alive);
    h.run(10.5);
    assert.ok(h.b.redeploy(u, { free: true }), 'redeployed');
    approx(u.skill.sp, 30, '20 + 10 whole seconds');
    setMana(u, 75);
    h.b.retreat(u);
    h.run(10);
    assert.ok(h.b.redeploy(u, { free: true }));
    approx(u.skill.sp, 80, 'capped at the bar');
    assert.equal(u.skill.charges, 1);
    done(h);
  }
  {
    const { h, u } = field({ skill: 2 });
    h.spawn('enemy_dummy', { pos: [10, 7] });
    assert.ok(h.runUntil(() => u.mem.marcilS3?.phase === 'chain', 20), 'the explosions began');
    assert.ok(u.skill.sp > 8);
    h.b.kill(u);
    assert.ok(h.b.redeploy(u, { free: true }));
    assert.equal(u.skill.sp, 0, 'all mana lost');
    done(h);
  }
  {
    // knocked out during the 追加吟唱: the mana stays
    const { h, u } = field({ skill: 2 });
    h.spawn('enemy_dummy', { pos: [10, 7] });
    assert.ok(h.runUntil(() => u.skill.active && chanting(u), 8), 'the 追加吟唱');
    const left = u.skill.sp;
    h.b.kill(u);
    assert.ok(h.b.redeploy(u, { free: true }));
    approx(u.skill.sp, left, 'kept');
    done(h);
  }
});

test('吟唱: the cast replaces the attack, chant_duration s of no attack, aborted by 晕眩 / 沉默 (nothing spent, the skill not open); a MANUAL cast waits for the 3 s operation cooldown, AUTO S2 does not', () => {
  // S1: 1.5 s, no attack meanwhile
  {
    const { h, u } = field({ skill: 0 });
    h.run(3);
    assert.ok(!chanting(u) && !u.skill.active, 'no enemy: no cast');
    h.spawn('enemy_dummy', { pos: [10, 7] });
    assert.ok(h.runUntil(() => chanting(u), 1), 'the cast');
    const t0 = h.b.time;
    assert.ok(u.s.flags.disarm, 'no attack while chanting');
    assert.ok(h.runUntil(() => u.skill.active, 3));
    approx(h.b.time - t0, skillOf(5, false, S1).bb.chant_duration, '1.5 s', 0.03);
    assert.equal(attacksOn(h, u).length, 0, 'no attack before the skill opened');
    assert.ok(!u.s.flags.disarm);
    done(h);
  }
  // stunned while chanting: aborted, mana kept, no skillStart; cast again later
  for (const status of ['stun', 'silence']) {
    const { h, u } = field({ skill: 1 });
    h.spawn('enemy_dummy', { pos: [10, 7] });
    assert.ok(h.runUntil(() => chanting(u), 1), 'S2 chant');
    h.run(2);
    h.b.applyStatus(u, status, { duration: 1, force: true });
    h.step();
    assert.ok(!chanting(u) && !u.skill.active, `${status}: aborted`);
    assert.equal(startsOf(h, u).length, 0);
    approx(u.skill.sp, 35, `${status}: nothing spent`);
    assert.ok(h.runUntil(() => chanting(u), 4), `${status}: cast again`);
    done(h);
  }
  // the operation cooldown of the battle-start deployment (3 s): S1 / S3 wait, S2 (AUTO) does not
  for (const [skill, wait] of [[0, true], [1, false], [2, true]]) {
    const { h, u } = field({ skill, flags: { startOpCooldown: 3 } });
    h.spawn('enemy_dummy', { pos: [10, 7] });
    // (the basic strategy casts at an attack: the first one past the cooldown, 2.9 s apart)
    assert.ok(h.runUntil(() => chanting(u), 7), `S${skill + 1} cast`);
    assert.equal(h.b.time >= 3 - 1e-6, wait, `S${skill + 1}: cast at ${h.b.time.toFixed(2)}`);
    done(h);
  }
});

test('S1 才女的实力 (MANUAL, data DEFAULT): opens after its chant, ATK +55 % / +85 %, each attack spends 2 mana; with no enemy it heals the most injured ally for ATK (2 mana); closes below 2 and opens once per deployment', () => {
  for (const [tier, elite] of [[5, false], [6, true]]) {
    const sk = skillOf(tier, elite, S1);
    const t0 = formOf(tier, elite).talents[0].bb;
    assert.deepEqual([sk.skillType, sk.trigger.rule, sk.bb.atk, sk.bb.sp_cost, sk.bb.skill_cost_min_sp, sk.bb.chant_duration, sk.initSp, sk.spCost],
      ['MANUAL', 'DEFAULT', elite ? 0.85 : 0.55, 2, 2, 1.5, 25, 80], `T${tier}`);
    const { h, u } = field({ tier, elite, skill: 0, others: [{ uid: 2, chessId: ALLY.chessId, row: 10, col: 6 }] });
    const ally = h.unit(2);
    const e = h.spawn('enemy_dummy', { pos: [10, 7] });
    assert.ok(h.runUntil(() => u.skill.active, 3), `T${tier}: open`);
    assert.equal(startsOf(h, u)[0].reason, 'DEFAULT');
    approx(u.s.atk, u.base.atk * (1 + t0.atk + sk.bb.atk), `T${tier}: ATK +${sk.bb.atk * 100} % (+ the talent)`);
    const m0 = u.skill.sp, a0 = attacksOn(h, u).length;
    h.run(10);
    const n = attacksOn(h, u).length - a0;
    assert.ok(n >= 3, `T${tier}: ${n} attacks`);
    approx(u.skill.sp, m0 - 2 * n, `T${tier}: 2 mana per attack`);
    // no enemy any more: her attack heals the injured ally (ATK × 1), 2 mana each
    h.b.kill(e);
    ally.hp = ally.s.maxHp * 0.2;
    const h0 = h.hooksOf('heal').filter((c) => c.source === u).length, m1 = u.skill.sp;
    h.run(6.5);
    const heals = h.hooksOf('heal').filter((c) => c.source === u).slice(h0);
    assert.ok(heals.length >= 2, `T${tier}: ${heals.length} heals`);
    for (const c of heals) { assert.equal(c.target, ally); approx(c.amount, u.s.atk, `T${tier}: a heal of ATK`); }
    approx(u.skill.sp, m1 - 2 * heals.length, `T${tier}: 2 mana per heal`);
    // nobody to attack or heal: nothing spent
    ally.hp = ally.s.maxHp;
    const m2 = u.skill.sp;
    h.run(6);
    approx(u.skill.sp, m2, `T${tier}: idle`);
    // below 2 it closes, and stays closed in this deployment whatever her mana
    h.spawn('enemy_dummy', { pos: [10, 7] });
    setMana(u, 3);
    assert.ok(h.runUntil(() => !u.skill.active, 6), `T${tier}: closed`);
    assert.equal(endsOf(h, u).at(-1).reason, 'mana');
    approx(u.skill.sp, 1, `T${tier}: 1 left`);
    approx(u.s.atk, u.base.atk * (1 + t0.atk), `T${tier}: the talent still holds (1 mana)`);
    u.skill.gainSp(40, 'talent');
    h.run(8);
    assert.ok(!u.skill.active && !chanting(u), `T${tier}: once per deployment`);
    // a new deployment opens it again
    h.b.retreat(u);
    assert.ok(h.b.redeploy(u, { free: true }));
    assert.ok(h.runUntil(() => u.skill.active, 5), `T${tier}: opened again after a redeploy`);
    done(h);
  }
});

test('S2 召唤使魔 (AUTO, data MARCILS2): 11 s chant, 35 mana, ATK +55 % / +70 % and 停顿 0.5 s on every victim; with ≥ 35 left the strategy closes it into its second use — another chant and 35 —: ASPD +35 / +45, range +1, the struck target 晕眩 0.5 s', () => {
  for (const [tier, elite] of [[5, false], [6, true]]) {
    const sk = skillOf(tier, elite, S2);
    const t0 = formOf(tier, elite).talents[0].bb;
    assert.deepEqual([sk.skillType, sk.trigger.rule, sk.bb.atk, sk.bb.attack_speed, sk.bb['attack@sluggish'], sk.bb['attack@stun'], sk.bb.sp_cost, sk.bb.skill_cost_min_sp, sk.bb.chant_duration, sk.initSp],
      ['AUTO', 'MARCILS2', elite ? 0.7 : 0.55, elite ? 45 : 35, 0.5, 0.5, 35, 35, 11, 10], `T${tier}`);
    assert.match(sk.desc, /攻击距离\+1/);
    // first use only (35 mana: 0 left)
    {
      const { h, u } = field({ tier, elite, skill: 1 });
      approx(u.skill.sp, 35, `T${tier}: 10 + 25`);
      const a = h.spawn('enemy_dummy', { pos: [10, 7] }), b = h.spawn('enemy_dummy', { pos: [10, 7.8] });
      assert.ok(h.runUntil(() => chanting(u), 1));
      const t0c = h.b.time;
      assert.ok(h.runUntil(() => u.skill.active, 12));
      approx(h.b.time - t0c, 11, `T${tier}: 11 s chant`, 0.01);
      assert.equal(attacksOn(h, u).length, 0, `T${tier}: no attack while chanting`);
      assert.equal(u.skill.sp, 0, `T${tier}: 35 spent`);
      h.step();
      approx(u.s.atk, u.base.atk * (1 + sk.bb.atk), `T${tier}: ATK +${sk.bb.atk * 100} % (no mana: no talent)`);
      const s0 = statusBy(h, u, 'sluggish').length;
      h.run(8);
      const slow = statusBy(h, u, 'sluggish').slice(s0);
      assert.ok(slow.some((c) => c.target === a) && slow.some((c) => c.target === b), `T${tier}: the struck target and the splashed one`);
      for (const c of slow) approx(c.duration, 0.5, `T${tier}: 0.5 s`);
      assert.equal(statusBy(h, u, 'stun').length, 0, `T${tier}: no stun on the first use`);
      assert.ok(u.skill.active && !chanting(u) && endsOf(h, u).length === 0, `T${tier}: unlimited, never closed`);
      done(h);
    }
    // with 80: the second use
    {
      const { h, u } = field({ tier, elite, skill: 1 });
      u.skill.gainSp(80, 'talent');
      const a = h.spawn('enemy_dummy', { pos: [10, 7] });
      const far = h.spawn('enemy_dummy', { pos: [11, 8] });   // on the +1 range only
      assert.ok(h.runUntil(() => u.skill.active, 12), `T${tier}: first use`);
      approx(u.skill.sp, 45, `T${tier}: 80 − 35`);
      const t1 = h.b.time;
      assert.ok(!u.rangeKeys.includes(11 * 21 + 8), `T${tier}: base range`);
      assert.ok(h.runUntil(() => endsOf(h, u).length > 0, 5), `T${tier}: closed by the strategy`);
      assert.equal(endsOf(h, u)[0].reason, 'recast');
      approx(h.b.time - t1, 3, `T${tier}: after the 3 s operation cooldown`, 0.05);
      assert.ok(chanting(u) && !u.skill.active, `T${tier}: a new chant`);
      assert.ok(h.runUntil(() => u.skill.active, 12), `T${tier}: second use`);
      assert.equal(startsOf(h, u)[1].reason, 'MARCILS2');
      h.step();
      approx(u.skill.sp, 10, `T${tier}: another 35`);
      approx(u.s.atk, u.base.atk * (1 + t0.atk + sk.bb.atk), `T${tier}: ATK (+ the talent: 10 mana left)`);
      assert.equal(u.s.aspd, u.base.aspd + sk.bb.attack_speed, `T${tier}: ASPD +${sk.bb.attack_speed}`);
      assert.ok(u.rangeKeys.includes(11 * 21 + 8), `T${tier}: range +1`);
      const st0 = statusBy(h, u, 'stun').length;
      h.run(9);
      const stuns = statusBy(h, u, 'stun').slice(st0);
      assert.ok(stuns.length >= 2 && stuns.every((c) => Math.abs(c.duration - 0.5) < 1e-9), `T${tier}: 晕眩 0.5 s`);
      assert.ok(hitsBy(h, u).some((c) => c.target === far), `T${tier}: the +1 tile is attacked`);
      assert.ok(statusBy(h, u, 'sluggish').length > stuns.length, `T${tier}: 停顿 on every victim still`);
      assert.equal(startsOf(h, u).length, 2, `T${tier}: the second use is never closed`);
      // a new deployment counts its uses anew: S2 opens as a first use again
      h.b.retreat(u);
      assert.ok(h.b.redeploy(u, { free: true }));
      setMana(u, 80);
      assert.ok(h.runUntil(() => u.skill.active, 13));
      assert.equal(startsOf(h, u).at(-1).reason, 'DEFAULT');
      assert.equal(u.s.aspd, u.base.aspd, `T${tier}: the first use's familiar`);
      void a;
      done(h);
    }
  }
});

test('S3 爆破魔法 (MANUAL, data DEFAULT): 5 s chant, 10 s 追加吟唱, then an explosion every 0.45 s for 8 mana each until under 8 (the rest goes too) — 310 % / 340 % ATK arts on x-1 two tiles ahead, air too', () => {
  for (const [tier, elite, mod] of [[5, false, null], [6, true, SPCY]]) {
    const sk = skillOf(tier, elite, S3);
    const t0 = formOf(tier, elite).talents[0].bb;
    assert.deepEqual([sk.skillType, sk.trigger.rule, sk.bb.atk_scale, sk.bb.chant_duration, sk.bb.extra_chant_duration, sk.bb.sp_cost_extra, sk.bb.skill_cost_min_sp, sk.bb.interval, sk.bb.stun, sk.bb.trig_cnt],
      ['MANUAL', 'DEFAULT', elite ? 3.4 : 3.1, 5, 10, 8, 8, 0.45, 3, 49], `T${tier}`);
    const { h, u } = field({ tier, elite, mod, skill: 2 });
    const mana = u.skill.sp;
    const n = Math.floor(mana / 8);
    assert.equal(n, elite ? 10 : 8, `T${tier}: ${mana} mana`);
    // her range: (10,7); the x-1 around (10,7): (10,9), (9,8) — a flyer —, (12,7); outside it: (11,9)
    const inside = [h.spawn('enemy_dummy', { pos: [10, 7] }), h.spawn('enemy_dummy', { pos: [10, 9] }), h.spawn('enemy_fly', { pos: [9, 8] }), h.spawn('enemy_dummy', { pos: [12, 7] })];
    const outside = h.spawn('enemy_dummy', { pos: [11, 9] });
    assert.ok(h.runUntil(() => chanting(u), 1), `T${tier}: cast`);
    const tc = h.b.time;
    assert.ok(h.runUntil(() => u.skill.active, 6));
    approx(h.b.time - tc, 5, `T${tier}: 5 s chant`, 0.01);
    assert.ok(chanting(u) && u.s.flags.disarm, `T${tier}: the 追加吟唱`);
    approx(u.skill.sp, mana, `T${tier}: nothing spent yet`);
    assert.ok(h.runUntil(() => !u.skill.active, 20), `T${tier}: done`);
    assert.equal(endsOf(h, u)[0].reason, 'done');
    const blasts = hitsBy(h, u).filter((c) => c.dmg.tags.includes('marcil:s3'));
    const first = blasts[0].t;
    approx(first - tc, 15, `T${tier}: the first explosion after 5 + 10 s`, 0.01);
    const tEnd = endsOf(h, u)[0].t;
    assert.equal(attacksOn(h, u).filter((c) => c.t < tEnd).length, 0, `T${tier}: no attack from the cast to the end`);
    for (const e of inside) {
      const on = blasts.filter((c) => c.target === e);
      assert.equal(on.length, n, `T${tier}: ${e.defId} at ${e.y},${e.x}: ${n} explosions`);
      on.forEach((c, i) => approx(c.t - first, i * 0.45, `T${tier}: 0.45 s apart`, 0.04));
      for (const c of on) {
        assert.deepEqual([c.type, c.dmg.isSkill, !!c.dmg.isAttack], ['arts', true, false]);
        approx(c.amount, u.base.atk * (1 + t0.atk) * sk.bb.atk_scale, `T${tier}: ${sk.bb.atk_scale * 100} % ATK`);
      }
    }
    assert.ok(!blasts.some((c) => c.target === outside), `T${tier}: x-1 only`);
    assert.equal(u.skill.sp, 0, `T${tier}: the rest of her mana goes too`);
    approx(u.s.atk, u.base.atk, `T${tier}: no mana, no talent`);
    // no 高台 on the flat field's blast: nobody stunned
    assert.equal(statusBy(h, u, 'stun').length, 0);
    // she attacks again afterwards; with no mana S3 is not cast again
    h.run(6);
    assert.ok(attacksOn(h, u).length > 0 && !chanting(u));
    done(h);
  }
});

test('S3: a 高台 on the blast breaks and stuns the enemies of its x-4 for 3 s; the centre shifts into the field at its edge; a stopped (interrupted) 追加吟唱 makes one explosion for 8; an interrupted chant none', () => {
  // a '#' block (HIGH) at (11,6): on the x-1 around (10,5); its 3×3 holds (12,7), which the blast does not reach
  {
    const rows = flatStage().rows.slice();
    rows[11] = rows[11].slice(0, 6) + '#' + rows[11].slice(7);
    const { h, u } = field({ skill: 2, col: 3, stage: { ...flatStage(), rows } });
    assert.equal(h.b.grid.tile(11, 6).height, 'HIGH');
    const hit = h.spawn('enemy_dummy', { pos: [10, 4] }), debris = h.spawn('enemy_dummy', { pos: [12, 7] }), away = h.spawn('enemy_dummy', { pos: [9, 8] });
    assert.ok(h.runUntil(() => endsOf(h, u).length > 0, 25), 'done');
    const blasts = hitsBy(h, u).filter((c) => c.dmg.tags.includes('marcil:s3'));
    assert.ok(blasts.some((c) => c.target === hit) && !blasts.some((c) => c.target === debris) && !blasts.some((c) => c.target === away));
    const stuns = statusBy(h, u, 'stun');
    assert.equal(stuns.filter((c) => c.target === debris).length, 8, 'stunned at every explosion');
    assert.ok(stuns.every((c) => c.target === debris && Math.abs(c.duration - 3) < 1e-9), '3 s, the debris area only');
    done(h);
  }
  // at the field's right edge (col 10): the centre (10,11) shifts to (10,10), so (10,8) is on the blast
  {
    const { h, u } = field({ skill: 2, col: 9 });
    h.spawn('enemy_dummy', { pos: [10, 10] });
    const back = h.spawn('enemy_dummy', { pos: [10, 8] });
    assert.ok(h.runUntil(() => endsOf(h, u).length > 0, 25));
    assert.equal(hitsBy(h, u).filter((c) => c.target === back && c.dmg.tags.includes('marcil:s3')).length, 8, 'the shifted blast');
    done(h);
  }
  // stunned in the 追加吟唱: one explosion, 8 mana, the skill ends
  {
    const { h, u } = field({ skill: 2 });
    const e = h.spawn('enemy_dummy', { pos: [10, 7] });
    assert.ok(h.runUntil(() => u.skill.active, 7));
    h.run(3);
    h.b.applyStatus(u, 'stun', { duration: 1, force: true });
    h.step();
    assert.ok(!u.skill.active, 'ended');
    assert.equal(endsOf(h, u)[0].reason, 'stopped');
    assert.equal(hitsBy(h, u).filter((c) => c.target === e && c.dmg.tags.includes('marcil:s3')).length, 1, 'one explosion');
    approx(u.skill.sp, 65 - 8, '8 spent');
    done(h);
  }
  // stunned in the first chant: nothing at all
  {
    const { h, u } = field({ skill: 2 });
    h.spawn('enemy_dummy', { pos: [10, 7] });
    assert.ok(h.runUntil(() => chanting(u), 1));
    h.run(2);
    h.b.applyStatus(u, 'stun', { duration: 1, force: true });
    h.step();
    assert.ok(!chanting(u) && !u.skill.active && startsOf(h, u).length === 0);
    approx(u.skill.sp, 65, 'nothing spent');
    done(h);
  }
});

test('可靠的同伴: four different 【莱欧斯小队】 operators in her squad ⇒ each ASPD +25, DEF +35 % for the battle; three are not enough (none of the others is in this mode\'s data: synthetic records)', () => {
  const t1 = formOf(6, true).talents[1].bb;
  assert.deepEqual([t1.attack_speed, t1.def], [25, 0.35]);
  const party = LAIOS.map((c, i) => ({ uid: 2 + i, chessId: `test_laios${i}_a`, row: 12, col: 3 + i }));
  {
    const { h, u } = field({ tier: 6, elite: true, others: party });
    for (const x of [u, h.unit(2), h.unit(3), h.unit(4)]) {
      assert.equal(x.s.aspd, x.base.aspd + 25, `${x.def.charId}: ASPD`);
      approx(x.s.def, x.base.def * 1.35, `${x.def.charId}: DEF`);
    }
    done(h);
  }
  {
    const { h, u } = field({ tier: 6, elite: true, others: party.slice(0, 2) });
    for (const x of [u, h.unit(2), h.unit(3)]) assert.equal(x.s.aspd, x.base.aspd, `${x.def.charId}: no bonus with three`);
    done(h);
  }
});

test('a 【移动】 (moveRedeploy) is no new deployment for her: a 追加吟唱 runs on into its explosions, S2\'s first use still counts', () => {
  {
    const { h, u } = field({ skill: 2 });
    const e = h.spawn('enemy_dummy', { pos: [10, 7] });
    assert.ok(h.runUntil(() => u.skill.active && chanting(u), 7), 'the 追加吟唱');
    assert.ok(h.b.moveRedeploy(u, 11, 5), 'moved');
    assert.ok(chanting(u) && u.skill.active, 'still chanting');
    assert.ok(h.runUntil(() => !u.skill.active, 20));
    assert.equal(endsOf(h, u)[0].reason, 'done');
    assert.equal(hitsBy(h, u).filter((c) => c.target === e && c.dmg.tags.includes('marcil:s3')).length, 8, 'the blast from (11,5): (11,7) ± x-1 holds (10,7)');
    done(h);
  }
  {
    const { h, u } = field({ skill: 1 });
    u.skill.gainSp(80, 'talent');
    h.spawn('enemy_dummy', { pos: [10, 7] });
    assert.ok(h.runUntil(() => u.skill.active, 12), 'first use');
    assert.ok(h.b.moveRedeploy(u, 11, 5));
    assert.ok(h.runUntil(() => startsOf(h, u).length === 2, 16), 'the second use after the move');
    assert.equal(startsOf(h, u)[1].reason, 'MARCILS2');
    done(h);
  }
});
