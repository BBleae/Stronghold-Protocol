// test/content/op_makoto.test.js — the 自选 operator kit of 结城理 (char_4217_makoto, 6★ 傀儡师, a collab pick of this
// fork; kit server/sim/content/kits/ops/op-makoto.js), fielded the production way (a DIY slot + its `diy` pick, simdata
// getDiy) in every form: tiers 5 / 6, normal (E2 Lv1, skill rank 4, no module) and elite (E2 Lv60, rank 7) with no module
// or PUM-Y “彼此的声音” at stage 1 (tier 5) / 3 (tier 6). Every number is read back from data/backups.json (the form of
// that slot status); the fidelity checklist of kits/README.md item by item.
// Run: node --test test/content/op_makoto.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { KITTED_CHARS, OPERATOR_KITS, KITS } from '../../server/sim/content/kits/index.js';
import { diyPool, validateDiyPicks } from '../../shared/diy.js';
import { DOLL_SWITCH } from '../../server/sim/professions.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../../data/${f}.json`, import.meta.url), 'utf8'));
const CHESS = load('chess');
const BACKUPS = load('backups');
const MAKOTO = 'char_4217_makoto';
const FORMS = BACKUPS.units[MAKOTO].forms;
const SLOT = { 5: 'chess_char_5_diy1_a', 6: 'chess_char_6_diy1_a' };
const PUMY = 'uniequip_002_makoto';
const S = ['skchr_makoto_1', 'skchr_makoto_2', 'skchr_makoto_3'];
/** The kit's timings (op-makoto.js): the S3 change, the 总攻击's hit. */
const CHANGE_TIME = 1.5, ALL_OUT_HIT = 0.3;
/** The switch back after the <替身>'s time: the <总攻击> form, Skill_AllOutAttack_Loop + _End (48 frames). */
const ALL_OUT_TIME = 1.6;

/** The unit form of a slot (tier, normal / elite). */
const formOf = (tier, elite) => FORMS[elite ? (tier === 5 ? '2/60/7/1' : '2/60/7/3') : '2/1/4/0'];
const modOf = (tier, elite, mod) => (elite && mod ? formOf(tier, true).modules.find((m) => m.uniEquipId === mod) : null);
const skillOf = (tier, elite, i) => formOf(tier, elite).skills[i];
/** The talents' blackboards of a form with its module's changes. */
function talentsOf(tier, elite, mod) {
  const t = formOf(tier, elite).talents.map((x) => x.bb);
  for (const c of modOf(tier, elite, mod)?.talentChanges ?? []) t[c.talentIndex] = c.bb;
  return t;
}
const traitOf = (tier, elite, mod) => modOf(tier, elite, mod)?.traitOverride?.bb ?? formOf(tier, elite).trait.bb;
function statsOf(tier, elite, mod) {
  const s = formOf(tier, elite).stats, a = modOf(tier, elite, mod)?.attr ?? {};
  return { maxHp: s.maxHp + (a.maxHp ?? 0), atk: s.atk + (a.atk ?? 0), def: s.def + (a.def ?? 0), bat: s.bat };
}
/** x-1: the <替身>'s range (the record's trait grid; also every skill's 技能范围). */
const X1 = formOf(5, false).trait.rangeGrid;
const approx = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e9, speed: 0, mass: 0, atk: 0, ...o });
const ENEMIES = {
  enemy_dummy: dummy('enemy_dummy'), enemy_fly: dummy('enemy_fly', { motion: 'FLY' }),
  enemy_tough: dummy('enemy_tough', { def: 2000 }), enemy_warded: dummy('enemy_warded', { res: 80 }),
  enemy_frail: dummy('enemy_frail', { res: 100 }), enemy_frail_fly: dummy('enemy_frail_fly', { res: 100, motion: 'FLY' }),
  enemy_fearless: dummy('enemy_fearless', { res: 100, immunities: { feared: true } }),
};
/** Every 自选 form: [tier, elite, module]. */
const FORMS_ALL = [[5, false, null], [6, false, null], [5, true, null], [5, true, PUMY], [6, true, null], [6, true, PUMY]];
const label = ([tier, elite, mod]) => `T${tier} ${elite ? 'elite' : 'normal'} ${mod ?? 'none'}`;

/** A battle with 结城理 as uid 1 at (10, 5) facing RIGHT, plus `others`; `sp` = his starting SP (default: the data's). */
function field({ tier = 6, elite = true, mod = PUMY, skill = 0, sp, others = [], seed = 5 } = {}) {
  const h = makeBattle({
    defs: { enemies: ENEMIES }, timeLimit: 900, autoFinish: false, seed,
    flags: { dpPerSec: 0, dpMax: 999 }, captureNoisy: true,
    units: [{ uid: 1, diy: { slot: SLOT[tier], charId: MAKOTO, skillIndex: skill, uniEquipId: elite ? mod : null }, elite, row: 10, col: 5,
      ...(sp != null ? { carryState: { sp } } : null) }, ...others],
  });
  h.step();
  const u = h.unit(1);
  const lethal = () => h.b.dealDamage(null, u, { amount: 1e9, type: 'true' });
  const at = (pos, key = 'enemy_dummy') => h.spawn(key, { pos });
  return { h, u, lethal, at };
}
const formNow = (u) => u.mem.makoto?.form ?? null;
const hitsBy = (h, u, pred = () => true) => h.hooksOf('damaged').filter((c) => (c.source === u || c.credit === u) && pred(c));
const tagged = (tag) => (c) => (c.dmg?.tags || []).includes(tag);
function done(h) {
  checkInvariants(h.b);
  assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
}

test('结城理 in every 自选 form: his operator kit (all three skills authored), the form\'s stats + PUM-Y attributes, 1-1 range, blocks 2, melee physical ground-only, 拉特兰, no 特质', () => {
  assert.equal(OPERATOR_KITS[MAKOTO], KITS[MAKOTO]);
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    for (const skill of [0, 1, 2]) {
      const { h, u } = field({ tier, elite, mod, skill });
      const form = formOf(tier, elite), st = statsOf(tier, elite, mod);
      assert.deepEqual([u.def.charId, u.def.diyFor, u.skill.id, !!u.kit.generic, u.kit.skillSource], [MAKOTO, SLOT[tier], S[skill], false, 'skills'], label(f));
      assert.deepEqual([u.base.maxHp, u.base.atk, u.base.def, u.base.bat], [st.maxHp, st.atk, st.def, 1.2], `${label(f)}: stats`);
      assert.deepEqual([u.s.blockCnt, u.profile.attack, u.profile.dmgType, u.profile.canHitFly, u.profile.sub], [2, 'melee', 'phys', false, 'dollkeeper'], `${label(f)}: 傀儡师 本体`);
      assert.deepEqual(u.liveRangeGrid, form.rangeGrid, `${label(f)}: 1-1`);
      assert.deepEqual([u.def.bonds, u.def.raw.garrisonIds], [['lateranoShip'], []], `${label(f)}: bonds (subPower 拉特兰) / 特质`);
      done(h);
    }
  }
  // the numbers of the forms (zh_CN, full potential: ATK +34): E2 Lv1 2215 / 677 / 253, E2 Lv60 2606 / 771 / 287; PUM-Y
  // +200 / +18 / +18 → +304 / +34 / +34
  assert.deepEqual([FORMS['2/1/4/0'].stats.maxHp, FORMS['2/1/4/0'].stats.atk, FORMS['2/60/7/1'].stats.maxHp, FORMS['2/60/7/1'].stats.atk], [2215, 677, 2606, 771]);
  assert.deepEqual([modOf(5, true, PUMY).attr, modOf(6, true, PUMY).attr], [{ maxHp: 200, atk: 18, def: 18 }, { maxHp: 304, atk: 34, def: 34 }]);
});

test('a 自选 pick: 结城理 is offered at tiers 5 and 6 (he has a kit) and a roster with him passes validateDiyPicks', () => {
  const data = { chess: CHESS, backups: BACKUPS };
  assert.ok(KITTED_CHARS.includes(MAKOTO));
  for (const t of [5, 6]) assert.ok(diyPool(t, { data, kitted: KITTED_CHARS }).includes(MAKOTO), `tier ${t}`);
  assert.deepEqual(validateDiyPicks({ [SLOT[6]]: { charId: MAKOTO, skillIndex: 2, uniEquipId: PUMY } }, { data, kitted: KITTED_CHARS }),
    { ok: true, picks: { [SLOT[6]]: { charId: MAKOTO, skillIndex: 2, uniEquipId: PUMY } } });
});

test('the three skills (MANUAL, time SP, SKILL_RANGE on x-1): cast as soon as an enemy is inside x-1 (none in his 1-1 needed), never for one outside it; the cast ends in its frame and switches him to the <替身> at once (no lethal HP loss); 阻回 meanwhile', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    for (const skill of [0, 1, 2]) {
      const sk = skillOf(tier, elite, skill);
      const { h, u, at } = field({ tier, elite, mod, skill });
      assert.deepEqual([u.skill.kind, u.skill.rule, u.skill.spType, u.skill.manual, u.skill.spCost], ['instant', 'SKILL_RANGE', 'time', true, sk.spCost], `${label(f)} S${skill + 1}: data`);
      approx(u.skill.sp, sk.initSp + h.b.time, `${label(f)} S${skill + 1}: initial SP ${sk.initSp} (+1 / s)`);
      assert.deepEqual([sk.skillType, sk.durationType, sk.trigger.rawRule, sk.rangeId], ['MANUAL', 'NONE', 'DEFAULT', 'x-1'], `${label(f)} S${skill + 1}: official`);
      assert.deepEqual(u.skill.triggerGrid, X1, `${label(f)} S${skill + 1}: trigger grid = x-1`);
      at([10, 8]); // 3 tiles ahead: outside x-1
      h.run(sk.spCost - sk.initSp + 2);
      assert.ok(u.skill.ready && u.skill.activations === 0 && !u.trait.doll, `${label(f)} S${skill + 1}: ready, nobody inside x-1, no cast`);
      at([10, 7]); // 2 tiles ahead: inside x-1, outside his 1-1
      const fatals = h.hooksOf('fatal').length;
      assert.ok(h.runUntil(() => u.skill.activations === 1, 0.2), `${label(f)} S${skill + 1}: cast`);
      const s0 = h.hooksOf('skillStart').filter((c) => c.unit === u), s1 = h.hooksOf('skillEnd').filter((c) => c.unit === u);
      assert.deepEqual([s0.length, s1.length, s1[0]?.reason, s0[0]?.t === s1[0]?.t], [1, 1, 'instant', true], `${label(f)} S${skill + 1}: one cast, ended in its frame`);
      assert.ok(u.alive && u.trait.doll && u.form === ['orpheus', 'thanatos', 'thanatosR'][skill] && !u.skill.active, `${label(f)} S${skill + 1}: the <替身>`);
      assert.equal(h.hooksOf('fatal').length, fatals, `${label(f)} S${skill + 1}: a switch, not a lethal HP loss`);
      approx(u.hp, u.s.maxHp, `${label(f)} S${skill + 1}: full HP`);
      h.run(DOLL_SWITCH + 15);
      approx(u.skill.sp, 0, `${label(f)} S${skill + 1}: 阻回 — the SP waits`);
      assert.equal(hitsBy(h, u, (c) => c.dmg?.isAttack && c.type === 'phys').length, 0, `${label(f)} S${skill + 1}: no 本体 attack`);
      done(h);
    }
  }
});

test('T1 不羁之力 / PUM-Y as the <替身>: ATK +atk, HP +max_hp_t1 (+ the module trait\'s 20 %), interval +0.4 s, range x-1, block 0; 停顿 on x-1 (flyers too) for 8 / 10 s on the switch; the 本体 again after the switch back', () => {
  // the module numbers: stage 1 changes the trait only (+20 % 替身 HP), stage 3 also T1 (+100 % ATK, 10 s, +40 % HP)
  assert.deepEqual([talentsOf(5, true, PUMY)[0], talentsOf(6, true, PUMY)[0], traitOf(5, true, PUMY).max_hp, traitOf(6, true, PUMY).max_hp, traitOf(6, true, null).max_hp],
    [{ atk: 0.85, base_attack_time: 0.4, sluggish: 8, max_hp_t1: 0.35 }, { atk: 1, base_attack_time: 0.4, sluggish: 10, max_hp_t1: 0.4 }, 0.2, 0.2, undefined]);
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    const [t0] = talentsOf(tier, elite, mod);
    const tb = traitOf(tier, elite, mod), st = statsOf(tier, elite, mod);
    for (const skill of [0, 1, 2]) {
      const { h, u, at } = field({ tier, elite, mod, skill, sp: 999 });
      const near = at([10, 7]), fly = at([9, 6], 'enemy_fly'), far = at([10, 8]);
      assert.ok(h.runUntil(() => u.trait.doll, 0.2), `${label(f)} S${skill + 1}: cast`);
      const aspd = 100 + (skill === 2 ? skillOf(tier, elite, 2).bb['talent@attack_speed'] : 0);
      approx(u.s.atk, st.atk * (1 + t0.atk), `${label(f)} S${skill + 1}: ATK +${t0.atk * 100} %`);
      approx(u.s.maxHp, st.maxHp * (1 + t0.max_hp_t1 + (tb.max_hp ?? 0)), `${label(f)} S${skill + 1}: HP`);
      approx(u.hp, u.s.maxHp, `${label(f)} S${skill + 1}: at full HP`);
      approx(u.s.interval, (1.2 + t0.base_attack_time) * 100 / aspd, `${label(f)} S${skill + 1}: interval`);
      assert.deepEqual([u.s.blockCnt, u.liveRangeGrid, u.profile.dmgType], [0, X1, 'arts'], `${label(f)} S${skill + 1}: block 0, x-1, arts`);
      const slow = h.hooksOf('statusApplied').filter((c) => c.source === u && c.status === 'sluggish');
      assert.deepEqual(slow.map((c) => c.target).sort((a, b) => a.id - b.id), [near, fly].sort((a, b) => a.id - b.id), `${label(f)} S${skill + 1}: 停顿 on x-1, flyers too`);
      for (const c of slow) approx(c.duration, t0.sluggish, `${label(f)} S${skill + 1}: ${t0.sluggish} s`);
      assert.ok(!far.findBuff('sluggish'), `${label(f)} S${skill + 1}: nothing outside x-1`);
      // 静默: every switch; S1 / S2's personas hold it all along, <塔纳托斯·改> does not
      assert.ok(u.s.flags.silence, `${label(f)} S${skill + 1}: 静默 while switching`);
      h.run(DOLL_SWITCH + 0.1);
      assert.equal(!!u.s.flags.silence, skill !== 2, `${label(f)} S${skill + 1}: the persona's 静默`);
      const t0s = h.b.time;
      assert.ok(h.runUntil(() => !u.trait.doll, 20), `${label(f)} S${skill + 1}: the switch back`);
      approx(h.b.time - t0s, 20 - 0.1, `${label(f)} S${skill + 1}: after 1 + 20 s`, 0.05);
      assert.equal(u.form, null);
      assert.deepEqual([u.s.blockCnt, u.liveRangeGrid, u.profile.dmgType, u.profile.canHitFly, u.profile.maxTargets, u.profile.atkScale],
        [2, formOf(tier, elite).rangeGrid, 'phys', false, 1, undefined], `${label(f)} S${skill + 1}: the 本体's profile`);
      approx(u.s.atk, st.atk, `${label(f)} S${skill + 1}: the 本体's ATK`);
      approx(u.s.maxHp, st.maxHp, `${label(f)} S${skill + 1}: the 本体's HP`);
      approx(u.hp, u.s.maxHp, `${label(f)} S${skill + 1}: at full HP`);
      assert.ok(u.s.flags.silence, `${label(f)} S${skill + 1}: 静默 while switching back`);
      done(h);
    }
  }
});

test('S1 <俄耳甫斯>: attack@atk_scale × ATK arts on one ground enemy, flyers never; an ally of x-1 at or below 50 % HP is healed for attack@heal_scale × ATK instead (the lowest ratio), one above it is not', () => {
  for (const [tier, elite, mod] of [[5, false, null], [6, true, PUMY]]) {
    const bb = skillOf(tier, elite, 0).bb;
    assert.deepEqual([bb['attack@atk_scale'], bb['attack@heal_scale']], elite ? [2.1, 0.5] : [1.5, 0.4]);
    const others = [{ uid: 2, chessId: 'chess_char_1_02_a', row: 9, col: 5 }, { uid: 3, chessId: 'chess_char_1_02_a', row: 11, col: 6 }];
    const { h, u, at } = field({ tier, elite, mod, skill: 0, sp: 999, others });
    const e1 = at([10, 7]), e2 = at([10, 6]), fly = at([9, 6], 'enemy_fly');
    assert.ok(h.runUntil(() => u.trait.doll, 0.2));
    h.run(DOLL_SWITCH + 4);
    const atk = hitsBy(h, u, (c) => c.dmg?.isAttack);
    assert.ok(atk.length >= 2, `T${tier}: ${atk.length} attacks`);
    const ids = new Set(atk.map((c) => c.dmg.attackId));
    assert.equal(ids.size, atk.length, `T${tier}: one target per attack`);
    for (const c of atk) {
      assert.ok(c.target === e1 || c.target === e2, `T${tier}: a ground enemy`);
      assert.equal(c.type, 'arts');
      approx(c.amount, u.s.atk * bb['attack@atk_scale'], `T${tier}: ${bb['attack@atk_scale'] * 100} % ATK arts`);
    }
    assert.equal(hitsBy(h, u, (c) => c.target === fly).length, 0, `T${tier}: no flyer`);
    // two allies of x-1 hurt: the one at 50 % (不高于) is healed, then attacks again; 51 % / 60 % are not healed
    const a2 = h.unit(2), a3 = h.unit(3);
    a2.hp = a2.s.maxHp * 0.6;
    a3.hp = a3.s.maxHp * 0.51;
    h.run(3.5);
    assert.equal(h.hooksOf('heal').filter((c) => c.source === u).length, 0, `T${tier}: nobody at or below 50 %`);
    a2.hp = a2.s.maxHp * 0.5;
    a3.hp = a3.s.maxHp * 0.45;
    const n0 = atk.length;
    assert.ok(h.runUntil(() => h.hooksOf('heal').some((c) => c.source === u), 2), `T${tier}: a heal`);
    const heal = h.hooksOf('heal').filter((c) => c.source === u);
    assert.equal(heal[0].target, a3, `T${tier}: the lowest ratio first`);
    approx(heal[0].amount, u.s.atk * bb['attack@heal_scale'], `T${tier}: ${bb['attack@heal_scale'] * 100} % ATK`);
    h.run(6);
    assert.ok(h.hooksOf('heal').filter((c) => c.source === u).some((c) => c.target === a2), `T${tier}: then the other one`);
    assert.ok(a2.hpRatio > 0.5 && a3.hpRatio > 0.5);
    assert.ok(hitsBy(h, u, (c) => c.dmg?.isAttack).length > n0, `T${tier}: attacks again once nobody is at or below 50 %`);
    done(h);
  }
});

test('S2 <塔纳托斯>: up to 3 / 4 ground enemies at 160 % / 220 % ATK arts, each hit 35 % for 恐惧 1.5 s; flyers are not attacked', () => {
  for (const [tier, elite, mod] of [[5, false, null], [6, true, PUMY]]) {
    const bb = skillOf(tier, elite, 1).bb;
    assert.deepEqual([bb['attack@max_target'], bb['attack@atk_scale'], bb['attack@prob'], bb['attack@fear']], elite ? [4, 2.2, 0.35, 1.5] : [3, 1.6, 0.35, 1.5]);
    const { h, u, at } = field({ tier, elite, mod, skill: 1, sp: 999, seed: 9 });
    const ground = [[10, 6], [10, 7], [9, 6], [11, 6], [9, 5]].map((p) => at(p));
    const fly = at([11, 5], 'enemy_fly');
    assert.ok(h.runUntil(() => u.trait.doll, 0.2));
    h.run(DOLL_SWITCH + 19.9);
    const hits = hitsBy(h, u, (c) => c.dmg?.isAttack);
    const byAttack = new Map();
    for (const c of hits) byAttack.set(c.dmg.attackId, (byAttack.get(c.dmg.attackId) ?? 0) + 1);
    assert.ok(byAttack.size >= 10, `T${tier}: ${byAttack.size} attacks`);
    for (const n of byAttack.values()) assert.equal(n, bb['attack@max_target'], `T${tier}: ${bb['attack@max_target']} targets per attack`);
    for (const c of hits) {
      assert.ok(ground.includes(c.target) && c.type === 'arts', `T${tier}: ground enemies, arts`);
      approx(c.amount, u.s.atk * bb['attack@atk_scale'], `T${tier}: ${bb['attack@atk_scale'] * 100} % ATK`);
    }
    assert.equal(hitsBy(h, u, (c) => c.target === fly).length, 0, `T${tier}: no flyer`);
    const fears = h.hooksOf('statusApplied').filter((c) => c.source === u && c.status === 'fear');
    const r = fears.length / hits.length;
    assert.ok(r > 0.22 && r < 0.48, `T${tier}: ${fears.length} / ${hits.length} 恐惧 ≈ 35 %`);
    for (const c of fears) approx(c.duration, bb['attack@fear'], `T${tier}: 1.5 s`);
    done(h);
  }
});

test('S2 恐惧斩杀: a feared enemy of x-1 (flyers too) at or below 230 % / 250 % of his ATK takes 9999999 无来源 true damage and falls; not above it, not unfeared, not outside x-1; one that survives it is never tried again', () => {
  for (const [tier, elite, mod] of [[5, false, null], [6, true, PUMY]]) {
    const bb = skillOf(tier, elite, 1).bb;
    assert.deepEqual([bb['attack@kill_atk_scale'], bb['attack@kill_damage']], [elite ? 2.5 : 2.3, 9999999]);
    const { h, u, at } = field({ tier, elite, mod, skill: 1, sp: 999 });
    const low = at([10, 7], 'enemy_frail'), high = at([9, 6], 'enemy_frail'), fly = at([11, 6], 'enemy_frail_fly');
    const far = at([10, 8], 'enemy_frail'), fearless = at([9, 5], 'enemy_fearless'), barrier = at([11, 5], 'enemy_frail');
    assert.ok(h.runUntil(() => u.trait.doll, 0.2));
    h.run(DOLL_SWITCH + 0.05);
    const cap = bb['attack@kill_atk_scale'] * u.s.atk;
    for (const e of [low, fly, far, fearless, barrier]) e.hp = cap - 1;
    high.hp = cap + 2000;   // (its own attacks take 5 % through RES 100: never below the cap here)
    h.b.addBuff(barrier, { key: 'test:barrier', shield: 1e8 });
    for (const e of [low, high, fly, far, fearless, barrier]) h.b.applyStatus(e, 'fear', { duration: 30 });
    assert.ok(!fearless.s.flags.fear, '恐惧-immune');
    h.run(0.25);
    const ex = hitsBy(h, u, tagged('makoto:execute'));
    assert.deepEqual(ex.map((c) => c.target).sort((a, b) => a.id - b.id), [low, fly, barrier].sort((a, b) => a.id - b.id), `T${tier}: the feared ones of x-1 at or below the cap`);
    for (const c of ex) assert.deepEqual([c.type, c.source, c.credit, c.dmg.sourceless], ['true', null, u, true], `T${tier}: 无来源 true, credited to him`);
    assert.ok(!low.alive && !fly.alive, `T${tier}: they fall`);
    assert.ok(high.alive && far.alive && fearless.alive && barrier.alive, `T${tier}: the others stand`);
    h.run(5);
    assert.equal(hitsBy(h, u, (c) => c.target === barrier && tagged('makoto:execute')(c)).length, 1, `T${tier}: the survivor is not tried again`);
    done(h);
  }
});

test('S3 <塔纳托斯·改>: ASPD +30 / +45, up to 3 / 4 enemies — flyers too — at 170 % / 200 % ATK 弱点伤害: arts on high DEF, physical on high RES, arts on a tie', () => {
  for (const [tier, elite, mod] of [[5, false, null], [6, true, PUMY]]) {
    const bb = skillOf(tier, elite, 2).bb;
    assert.deepEqual([bb['talent@attack_speed'], bb['attack@max_target'], bb['attack@atk_scale']], elite ? [45, 4, 2] : [30, 3, 1.7]);
    const { h, u, at } = field({ tier, elite, mod, skill: 2, sp: 999 });
    const tough = at([10, 7], 'enemy_tough'), warded = at([9, 6], 'enemy_warded'), plain = at([11, 6]);
    const fly = elite ? at([9, 5], 'enemy_fly') : null;   // as many enemies as it strikes at once
    const all = elite ? [tough, warded, plain, fly] : [tough, warded, plain];
    assert.ok(h.runUntil(() => u.trait.doll, 0.2));
    approx(u.s.aspd, 100 + bb['talent@attack_speed'], `T${tier}: ASPD`);
    h.run(DOLL_SWITCH + 10);
    const hits = hitsBy(h, u, (c) => c.dmg?.isAttack);
    const byAttack = new Map();
    for (const c of hits) byAttack.set(c.dmg.attackId, (byAttack.get(c.dmg.attackId) ?? 0) + 1);
    assert.ok(byAttack.size >= 5, `T${tier}: ${byAttack.size} attacks`);
    for (const n of byAttack.values()) assert.equal(n, all.length, `T${tier}: ${all.length} targets per attack`);
    const A = u.s.atk * bb['attack@atk_scale'];
    for (const c of hits) {
      const want = c.target === warded ? 'phys' : 'arts';
      assert.equal(c.type, want, `T${tier}: ${c.target.defId} takes ${want}`);
      approx(c.amount, A, `T${tier}: ${bb['attack@atk_scale'] * 100} % ATK, unmitigated by the type it picked`);
    }
    if (elite) assert.ok(hits.some((c) => c.target === fly), `T${tier}: the flyer`);
    done(h);
  }
});

test('S3: a lethal hit on <塔纳托斯·改> calls <俄耳甫斯·改> (the change: 1.5 s, 不死 / 无敌, statuses cleared, full HP, no 停顿); then no attack, 静默, blocks 2, operators of x-1 dodge 30 % / 35 %, delayed heals of 25 % / 30 % ATK on up to 3 / 4 allies every second; a lethal hit on it knocks him out', () => {
  for (const [tier, elite, mod] of [[5, false, null], [6, true, PUMY]]) {
    const bb = skillOf(tier, elite, 2).bb;
    assert.deepEqual([bb['attack@prob'], bb['attack@heal_scale'], bb['attack@max_target_heal'], bb['attack@interval'], bb['attack@block_cnt']], elite ? [0.35, 0.3, 4, 1, 2] : [0.3, 0.25, 3, 1, 2]);
    const others = [[9, 5], [11, 5], [10, 4], [9, 4], [11, 4]].map(([row, col], i) => ({ uid: 2 + i, chessId: 'chess_char_1_02_a', row, col }));
    const { h, u, at, lethal } = field({ tier, elite, mod, skill: 2, sp: 999, others });
    const allies = [2, 3, 4, 5, 6].map((id) => h.unit(id));
    at([10, 7]);
    assert.ok(h.runUntil(() => u.trait.doll, 0.2));
    h.run(DOLL_SWITCH + 2);
    assert.equal(formNow(u), 'thanatosR');
    const slow0 = h.hooksOf('statusApplied').filter((c) => c.source === u && c.status === 'sluggish').length;
    h.b.applyStatus(u, 'slow', { duration: 30, value: 0.3, force: true });
    assert.ok(u.findBuff('slow'), 'a status on him');
    u.hp = u.s.maxHp * 0.3;
    const tL = h.b.time;
    lethal();
    assert.ok(u.alive && u.trait.doll && u.trait.dollSwitching && formNow(u) === 'change', `T${tier}: <俄耳甫斯·改> is called, not a knock-out`);
    assert.ok(!u.findBuff('slow'), `T${tier}: statuses cleared`);
    approx(u.hp, u.s.maxHp, `T${tier}: full HP`);
    lethal();
    assert.ok(u.alive && u.s.flags.invulnerable, `T${tier}: 无敌 / 不死 while changing`);
    assert.ok(h.runUntil(() => formNow(u) === 'orpheusR', CHANGE_TIME + 0.1), `T${tier}: <俄耳甫斯·改>`);
    approx(h.b.time - tL, CHANGE_TIME, `T${tier}: a ${CHANGE_TIME} s change`, 0.05);
    assert.equal(h.hooksOf('statusApplied').filter((c) => c.source === u && c.status === 'sluggish').length, slow0, `T${tier}: no 停顿 between two <替身>`);
    approx(u.hp, u.s.maxHp, `T${tier}: full HP after it`);
    assert.deepEqual([u.s.blockCnt, !!u.s.flags.silence, u.profile.noAttack, u.trait.doll, u.form], [2, true, true, true, 'orpheusR'], `T${tier}: blocks 2, 静默, no attack, still the <替身>`);
    h.run(0.3);
    for (const a of [u, ...allies]) {
      approx(a.s.dodgePhys, bb['attack@prob'], `T${tier}: physical dodge of ${a.uid}`);
      approx(a.s.dodgeArts, bb['attack@prob'], `T${tier}: arts dodge of ${a.uid}`);
    }
    const n0 = hitsBy(h, u, (c) => c.dmg?.isAttack).length;
    allies.forEach((a, i) => { a.hp = a.s.maxHp * (0.2 + 0.1 * i); });
    const tH = h.b.time;
    h.run(2.5);
    assert.equal(hitsBy(h, u, (c) => c.dmg?.isAttack).length, n0, `T${tier}: no normal attack`);
    const heals = h.hooksOf('heal').filter((c) => c.source === u && c.t > tH);
    const byT = new Map();
    for (const c of heals) byT.set(c.t.toFixed(2), [...(byT.get(c.t.toFixed(2)) ?? []), c.target]);
    assert.ok(byT.size >= 2, `T${tier}: a heal every second`);
    for (const ts of byT.values()) assert.ok(ts.length <= bb['attack@max_target_heal'], `T${tier}: up to ${bb['attack@max_target_heal']} at once`);
    assert.deepEqual([...byT.values()][0], allies.slice(0, bb['attack@max_target_heal']), `T${tier}: the lowest ratios first`);
    for (const c of heals) approx(c.amount, u.s.atk * bb['attack@heal_scale'], `T${tier}: ${bb['attack@heal_scale'] * 100} % ATK`);
    const ts = [...byT.keys()].map(Number);
    approx(ts[1] - ts[0], bb['attack@interval'], `T${tier}: every second`, 0.05);
    lethal();
    assert.ok(!u.alive, `T${tier}: a lethal hit on <俄耳甫斯·改> knocks him out`);
    h.step();
    assert.deepEqual([formNow(u), u.profile.dmgType, u.profile.noAttack, u.rangeGrid], [null, 'phys', false, formOf(tier, elite).rangeGrid], `T${tier}: the 本体 for the redeploy`);
    assert.ok(h.b.redeploy(u, { free: true }));
    assert.deepEqual([u.s.blockCnt, u.trait.doll, !!u.s.flags.silence, u.liveRangeGrid], [2, false, false, formOf(tier, elite).rangeGrid], `T${tier}: redeployed as the 本体`);
    done(h);
  }
});

test('S3: the automation presses the skill in <塔纳托斯·改> only when it is charged — a lethal hit taken with a full skill, an enemy inside x-1 ⇒ <俄耳甫斯·改> once the switch is over; uncharged, <塔纳托斯·改> fights its 20 s', () => {
  {
    const { h, u, at, lethal } = field({ skill: 2, sp: 999 });
    at([10, 9]);
    h.run(0.5);
    assert.ok(u.skill.ready && u.skill.activations === 0, 'charged, nobody inside x-1');
    const tL = h.b.time;
    lethal();
    assert.equal(formNow(u), 'thanatosR');
    at([10, 7]);
    assert.ok(h.runUntil(() => u.skill.activations === 1, DOLL_SWITCH + 0.2), 'cast');
    assert.ok(h.b.time - tL >= DOLL_SWITCH - 0.04, 'not while switching (静默)');
    assert.deepEqual([formNow(u), u.skill.charges], ['change', 0], 'the change to <俄耳甫斯·改>; the charge spent');
    assert.ok(h.runUntil(() => formNow(u) === 'orpheusR', CHANGE_TIME + 0.1));
    done(h);
  }
  {
    const { h, u, at } = field({ skill: 2 });
    at([10, 7]);
    assert.ok(h.runUntil(() => u.trait.doll, 10), 'cast from its SP');
    h.run(DOLL_SWITCH + 19.9);
    assert.deepEqual([formNow(u), u.skill.activations], ['thanatosR', 1], 'no second cast');
    h.run(0.2);
    assert.ok(!u.trait.doll && formNow(u) === null, 'back to the 本体');
    done(h);
  }
});

test('S1 / S2: a charged skill is not cast as the <替身> (静默) nor during the switch back (特性备注 "切换期间额外持有静默"); it is cast once he is the 本体', () => {
  for (const skill of [0, 1]) {
    const { h, u, at, lethal } = field({ skill, sp: 999 });
    at([10, 9]);
    h.run(0.5);
    const tL = h.b.time;
    lethal();
    assert.ok(u.trait.doll && u.skill.ready);
    at([10, 7]);
    assert.ok(h.runUntil(() => u.skill.activations === 1, DOLL_SWITCH + 20 + ALL_OUT_TIME + 0.2), `S${skill + 1}: cast`);
    assert.ok(h.b.time - tL >= DOLL_SWITCH + 20 + ALL_OUT_TIME - 0.04, `S${skill + 1}: cast at ${(h.b.time - tL).toFixed(2)} s, once the switch back (the <总攻击>) is over`);
    assert.ok(u.trait.doll && formNow(u) === (skill ? 'thanatos' : 'orpheus'), `S${skill + 1}: the <替身> again`);
    done(h);
  }
});

test('T2 S.E.E.S.队长: when the <替身>\'s time is up, every enemy of x-1 (flyers too) takes 450 % of the 本体\'s ATK true damage, once; nothing when the <替身> is knocked out', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    const [, t1] = talentsOf(tier, elite, mod);
    assert.equal(t1.atk_scale, 4.5, 'full potential');
    const { h, u, at } = field({ tier, elite, mod, skill: 0, sp: 999 });
    const near = at([10, 7]), fly = at([9, 6], 'enemy_fly'), far = at([10, 8]);
    assert.ok(h.runUntil(() => u.trait.doll, 0.2));
    assert.ok(h.runUntil(() => !u.trait.doll, DOLL_SWITCH + 20.1));
    const tB = h.b.time;
    assert.equal(hitsBy(h, u, tagged('makoto:allOut')).length, 0, `${label(f)}: not yet`);
    h.run(ALL_OUT_HIT + 0.05);
    const ao = hitsBy(h, u, tagged('makoto:allOut'));
    assert.deepEqual(ao.map((c) => c.target).sort((a, b) => a.id - b.id), [near, fly].sort((a, b) => a.id - b.id), `${label(f)}: x-1, flyers too`);
    for (const c of ao) {
      assert.equal(c.type, 'true');
      approx(c.amount, statsOf(tier, elite, mod).atk * t1.atk_scale, `${label(f)}: 450 % of the 本体's ATK`);
      approx(c.t - tB, ALL_OUT_HIT, `${label(f)}: its hit`, 0.05);
    }
    assert.ok(u.s.flags.invulnerable && u.trait.dollSwitching, `${label(f)}: inside the switch back (无敌)`);
    assert.ok(!hitsBy(h, u, (c) => c.target === far).length);
    // the <总攻击> form is the switch back (PRTS "<总攻击>期间…无敌、静默"): its clips, 1.6 s — not the engine's 1 s
    h.run(1.3 - (ALL_OUT_HIT + 0.05));
    assert.ok(u.s.flags.invulnerable && u.s.flags.silence && u.trait.dollSwitching, `${label(f)}: 1.3 s in: still the <总攻击> (无敌, 静默)`);
    assert.ok(h.runUntil(() => !u.trait.dollSwitching, 1));
    approx(h.b.time - tB, ALL_OUT_TIME, `${label(f)}: the 本体 is back after the <总攻击>'s clips`, 0.03);
    h.step();
    assert.ok(!u.s.flags.invulnerable && !u.s.flags.silence, `${label(f)}: then hittable, no 静默`);
    done(h);
  }
  const { h, u, at, lethal } = field({ skill: 0, sp: 999 });
  at([10, 7]);
  assert.ok(h.runUntil(() => u.trait.doll, 0.2));
  h.run(DOLL_SWITCH + 1);
  lethal();
  assert.ok(!u.alive, 'the <替身> knocked out');
  h.run(25);
  assert.equal(hitsBy(h, u, tagged('makoto:allOut')).length, 0, 'no 总攻击');
  done(h);
});
