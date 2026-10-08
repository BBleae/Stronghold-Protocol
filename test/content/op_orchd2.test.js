// test/content/op_orchd2.test.js — the 自选 operator kit of 焰狐龙梓兰 (char_1048_orchd2, 6★ 重射手, a collab pick of this fork:
// tools/build-data.mjs FORK_INCLUDE_COLLAB_PICKS, the fork owner's decision of 2026-10-08; kit
// server/sim/content/kits/ops/op-orchd2.js), fielded the production way (a DIY slot + its `diy` pick, simdata getDiy) in
// every form: tiers 5 / 6, normal (E2 Lv1, skill rank 4, no module) and elite (E2 Lv60, rank 7) with no module or ARC-X
// “梓兰特制箭靶” at stage 1 (tier 5) / 3 (tier 6). Every number is read back from data/backups.json (the form of that slot
// status); the fidelity checklist of kits/README.md item by item.
// Run: node --test test/content/op_orchd2.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { KITTED_CHARS, OPERATOR_KITS, KITS } from '../../server/sim/content/kits/index.js';
import { POWER_KEY, WIREBUG_KEY, CHARGE_KEY, COMBO_TAG, VOLLEY_TAG, LAND_TAG, ARROW_TAG } from '../../server/sim/content/kits/ops/op-orchd2.js';
import { diyPool, validateDiyPicks } from '../../shared/diy.js';
import { DOWN_STATE } from '../../server/sim/constants.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../../data/${f}.json`, import.meta.url), 'utf8'));
const CHESS = load('chess');
const BACKUPS = load('backups');
const CHAR = 'char_1048_orchd2';
const FORMS = BACKUPS.units[CHAR].forms;
const SLOT = { 5: 'chess_char_5_diy1_a', 6: 'chess_char_6_diy1_a' };
const X = 'uniequip_002_orchd2';
const S1 = 'skchr_orchd2_1', S2 = 'skchr_orchd2_2', S3 = 'skchr_orchd2_3';
const SKILL_IDS = [S1, S2, S3];
/** The unit form of a slot (tier, normal / elite). */
const formOf = (tier, elite) => FORMS[elite ? (tier === 5 ? '2/60/7/1' : '2/60/7/3') : '2/1/4/0'];
const skillOf = (tier, elite, id) => formOf(tier, elite).skills.find((s) => s.skillId === id);
const modOf = (tier, elite, mod) => (elite && mod ? formOf(tier, true).modules.find((m) => m.uniEquipId === mod) : null);
/** Talent of DATA index `i` of a form with the module's changes merged in (the composed record's rule). */
const talOf = (tier, elite, mod, i) => {
  const base = formOf(tier, elite).talents.find((t) => t.index === i) ?? { bb: {}, bbStr: {} };
  const ch = (modOf(tier, elite, mod)?.talentChanges ?? []).find((t) => t.talentIndex === i);
  return { bb: { ...base.bb, ...(ch?.bb ?? {}) }, bbStr: { ...base.bbStr, ...(ch?.bbStr ?? {}) } };
};
const DS = (tier, elite) => talOf(tier, elite, null, 2).bb['attack@damage_scale'];
const POWER = (tier, elite) => talOf(tier, elite, null, 0).bb;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const approx = (a, b, msg, eps = 1e-6) => assert.ok(near(a, b, eps), `${msg}: ${a} vs ${b}`);
const phys = (a, def) => Math.max(a - def, 0.05 * a);
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e9, speed: 0, mass: 0, ...o });
const ENEMIES = {
  enemy_dummy: dummy('enemy_dummy'), enemy_armor: dummy('enemy_armor', { def: 300 }), enemy_heavy: dummy('enemy_heavy', { mass: 5 }),
  enemy_fly: dummy('enemy_fly', { motion: 'FLY' }), enemy_fly2: dummy('enemy_fly2', { motion: 'FLY' }), enemy_frail: dummy('enemy_frail', { hp: 10 }),
  enemy_far: dummy('enemy_far'),
};
/** Every 自选 form: [tier, elite, module]. */
const FORMS_ALL = [[5, false, null], [6, false, null], ...[5, 6].flatMap((t) => [null, X].map((m) => [t, true, m]))];
const label = ([tier, elite, mod]) => `T${tier} ${elite ? 'elite' : 'normal'} ${mod ?? 'none'}`;
const READY = { sp: 999 };
/**
 * S2's schedule from her clips (s from the cast): Skill_2_Begin 20 frames (Skill_2_Begin_First 45 at the first opening of a
 * deployment), Skill_2_Loop_k 25 with the volley at 5, Skill_2_End 30 with the landing at 7; the skill ends at its data
 * duration or the end of Skill_2_End, whichever comes later.
 */
const s2Plan = (first, duration) => {
  const begin = (first ? 45 : 20) / 30, loop = 25 / 30;
  return { volleys: [0, 1, 2].map((k) => begin + k * loop + 5 / 30), land: begin + 3 * loop + 7 / 30, end: Math.max(duration, begin + 3 * loop + 1) };
};

/** A battle with 焰狐龙梓兰 as uid 1 at (row, col) facing RIGHT (her 3-6: rows row±1, cols col…col+2). */
function field({ tier = 6, elite = true, mod = null, skill = 0, row = 10, col = 3, enemies = [], others = [], seed = 7, carry = null, flags = {}, setup = null, players = null, kind } = {}) {
  const h = makeBattle({
    defs: { enemies: ENEMIES }, timeLimit: 900, autoFinish: false, seed, kind, setup,
    flags: { dpPerSec: 0, dpMax: 999, ...flags }, hooks: ['damaged', 'skillStart', 'skillEnd', 'statusApplied', 'attack', 'deploy'], captureNoisy: true,
    enemies,
    ...(players ? { players } : { units: [{ uid: 1, diy: { slot: SLOT[tier], charId: CHAR, skillIndex: skill, uniEquipId: mod }, elite, row, col, ...(carry ? { carryState: carry } : null) }, ...others] }),
  });
  h.step();
  return { h, u: h.unit(1) };
}
/** A `setup` that records the battle time of every 龙之箭 launch (its 'strike' fx) into `list`. */
const launchesInto = (list) => (b) => {
  const fx = b.fx.bind(b);
  b.fx = (kind, p) => { if (kind === 'strike' && p?.kind === 'dragonArrow') list.push(b.time); return fx(kind, p); };
};
function done(h) {
  checkInvariants(h.b);
  assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
}
const hitsBy = (h, u, f = () => true) => h.hooksOf('damaged').filter((c) => c.source === u && f(c));
const tagged = (tag) => (c) => (c.dmg?.tags ?? []).includes(tag);
/** Her engine-attack hits (normal attacks and S1's cast) grouped by attack id, in attack order. */
function attacksOf(h, u, f = () => true) {
  const m = new Map();
  for (const c of hitsBy(h, u, (x) => x.dmg?.isAttack && !(x.dmg.tags ?? []).length && f(x))) {
    if (!m.has(c.dmg.attackId)) m.set(c.dmg.attackId, []);
    m.get(c.dmg.attackId).push(c);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

test('焰狐龙梓兰 in every 自选 form: her operator kit (all three skills authored), the stats + ARC-X attributes, the hidden respawn part, 3-6, ranged physical 3-hit attack, hits air, blocks 1, data triggers', () => {
  assert.equal(OPERATOR_KITS[CHAR], KITS[CHAR]);
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    const form = formOf(tier, elite), m = modOf(tier, elite, mod);
    for (const skill of [0, 1, 2]) {
      const { h, u } = field({ tier, elite, mod, skill });
      const s = form.skills[skill];
      assert.deepEqual([u.def.charId, u.def.diyFor, u.skill.id, !!u.kit.generic, u.kit.skillSource], [CHAR, SLOT[tier], s.skillId, false, 'skills'], label(f));
      assert.deepEqual([u.base.maxHp, u.base.atk, u.base.def, u.base.cost], [form.stats.maxHp + (m?.attr.maxHp ?? 0), form.stats.atk + (m?.attr.atk ?? 0), form.stats.def + (m?.attr.def ?? 0), form.stats.cost], `${label(f)}: stats`);
      // 翔虫机动 "再部署时间-15秒" (its hidden part 3; ARC-X stage 3: −18) on top of ARC-X's attribute respawn_time −25
      assert.equal(u.base.respawnTime, form.stats.respawnTime + (m?.attr.respawnTime ?? 0) + talOf(tier, elite, mod, 3).bb.respawn_time, `${label(f)}: redeploy time`);
      assert.deepEqual([u.s.blockCnt, u.profile.attack, u.profile.canHitFly, u.profile.dmgType, u.base.bat], [1, 'ranged', true, 'phys', 1.6], `${label(f)}: 重射手`);
      assert.deepEqual([u.profile.hits, u.profile.hitDmgMul, u.profile.atkScale], [3, DS(tier, elite), talOf(tier, elite, mod, 2).bb['attack@atk_scale']], `${label(f)}: 三连击 at 33.3 %`);
      assert.deepEqual(u.liveRangeGrid, form.rangeGrid, `${label(f)}: 3-6`);
      assert.ok(!u.s.flags.liftoff || skill === 1, `${label(f)}: ground enemies target her`);
      assert.deepEqual([u.skill.rule, u.skill.maxCharges, u.skill.spCost, u.skill.initSp], [s.trigger.rule, s.maxChargeTime, s.spCost, s.initSp], `${label(f)}: the data's trigger / charges / SP`);
      assert.equal(u.skill.kind, s.duration < 0 ? (s.maxChargeTime > 1 ? 'charges' : 'instant') : 'duration', `${label(f)}: kind`);
      done(h);
    }
  }
  // the data: S1 / S3 DEFAULT, S2 SKILL_RANGE on its own 4-4 (which does not contain her 3-6: no ACTIVE_RANGE)
  for (const e of [false, true]) assert.deepEqual(formOf(6, e).skills.map((s) => s.trigger.rule), ['DEFAULT', 'SKILL_RANGE', 'DEFAULT']);
  assert.deepEqual([modOf(5, true, X).attr, modOf(6, true, X).attr], [{ atk: 80, def: 10, respawnTime: -25 }, { atk: 120, def: 16, respawnTime: -25 }]);
  assert.deepEqual([FORMS['2/1/4/0'].stats.respawnTime, talOf(6, true, X, 3).bb.respawn_time, talOf(6, true, null, 3).bb.respawn_time], [66, -18, -15]);
});

test('a 自选 pick: 焰狐龙梓兰 is offered at tiers 5 and 6 (she has a kit) and a roster with her passes validateDiyPicks', () => {
  const data = { chess: CHESS, backups: BACKUPS };
  assert.ok(KITTED_CHARS.includes(CHAR));
  for (const t of [5, 6]) assert.ok(diyPool(t, { data, kitted: KITTED_CHARS }).includes(CHAR), `tier ${t}`);
  for (const [skillIndex, uniEquipId] of [[0, null], [1, X], [2, X]]) {
    assert.deepEqual(validateDiyPicks({ [SLOT[6]]: { charId: CHAR, skillIndex, uniEquipId } }, { data, kitted: KITTED_CHARS }),
      { ok: true, picks: { [SLOT[6]]: { charId: CHAR, skillIndex, uniEquipId } } });
  }
});

test('her attack: 三连击 — 3 physical hits on her target, each attack@atk_scale × ATK then ×damage_scale (after DEF) — every form', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    const ds = DS(tier, elite);
    assert.ok(near(ds, 0.333));
    const { h, u } = field({ tier, elite, mod, skill: 2, enemies: [{ key: 'enemy_armor', pos: [10, 5] }] });
    h.run(4);
    assert.equal(u.skill.activations, 0, `${label(f)}: no skill yet (S3 not charged)`);
    const atks = attacksOf(h, u);
    assert.ok(atks.length >= 2, `${label(f)}: ${atks.length} attacks`);
    for (const a of atks) {
      assert.equal(a.length, 3, `${label(f)}: three hits`);
      for (const c of a) {
        assert.ok(!c.dmg.isSkill && c.type === 'phys', `${label(f)}: a plain physical hit`);
        approx(c.amount, phys(u.s.atk * talOf(tier, elite, mod, 2).bb['attack@atk_scale'], 300) * ds, `${label(f)}: hit`);
      }
    }
    done(h);
  }
});

test('S1 刚射: 4 arrows at atk_scale_1, then 刚连射 on a spare charge: 5 arrows at atk_scale_2, each stun_prob of 晕眩 stun s; two charges spent — every form', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    const sk = skillOf(tier, elite, S1), bb = sk.bb, ds = DS(tier, elite), pw = POWER(tier, elite).power_attack_scale;
    const { h, u } = field({ tier, elite, mod, skill: 0, carry: READY, enemies: [{ key: 'enemy_armor', pos: [10, 5] }] });
    const rolls = [];
    h.b.rng.chance = (p) => { rolls.push(p); return true; };
    assert.ok(h.runUntil(() => hitsBy(h, u, tagged(COMBO_TAG)).length > 0, 3), `${label(f)}: casts and combos`);
    h.run(0.2);
    const first = hitsBy(h, u, (c) => c.dmg.isSkill && c.dmg.isAttack && !(c.dmg.tags ?? []).length);
    const combo = hitsBy(h, u, tagged(COMBO_TAG));
    const launch = h.hooksOf('attack').find((c) => c.attacker === u && c.isSkill);
    approx(combo[0].t - launch.t, 35 / 30, `${label(f)}: 刚连射 leaves 1.167 s after the 4 arrows (Skill_1_End_2's two OnAttack)`, 0.03);
    assert.notEqual(combo[0].dmg.attackId, first[0].dmg.attackId, 'its own volley');
    const A = u.s.atk;
    assert.equal(first.length, 4, `${label(f)}: 发射4支`);
    assert.ok(first.every((c) => c.dmg.isSkill && near(c.amount, phys(A * bb.atk_scale_1 * pw, 300) * ds)), `${label(f)}: first arrows ${first[0].amount}`);
    assert.equal(combo.length, 5, `${label(f)}: 刚连射 5 arrows`);
    assert.ok(combo.every((c) => near(c.amount, phys(A * bb.atk_scale_2 * pw, 300) * ds)), `${label(f)}: 刚连射 arrows ${combo[0].amount}`);
    const st = h.hooksOf('statusApplied').filter((c) => c.source === u && c.status === 'stun');
    assert.equal(st.length, 5, `${label(f)}: a stun roll per 刚连射 arrow`);
    assert.ok(st.every((c) => near(c.duration, bb.stun)) && rolls.length === 5 && rolls.every((p) => p === bb.stun_prob));
    assert.equal(u.skill.charges, sk.maxChargeTime - 2, `${label(f)}: two charges spent`);
    const vfx = h.eventsOf('fx').filter((e) => e[1] === 'volley');
    assert.equal(vfx.length, 1);
    assert.deepEqual(vfx[0][4].targets, [combo[0].target.id], 'the 刚连射 fx names its target');
    done(h);
  }
  // no roll succeeds ⇒ no stun
  const { h, u } = field({ skill: 0, carry: READY, enemies: [{ key: 'enemy_dummy', pos: [10, 5] }] });
  h.b.rng.chance = () => false;
  assert.ok(h.runUntil(() => hitsBy(h, u, tagged(COMBO_TAG)).length === 5, 3));
  assert.equal(h.hooksOf('statusApplied').filter((c) => c.source === u).length, 0);
  done(h);
});

test('S1: 刚连射 finds another target when hers died; none ⇒ no 刚连射 and its charge, taken at the cast, comes back (PRTS 备注); one charge ⇒ the 4 arrows only', () => {
  // her target (blocked on her tile) dies on the first arrow: 刚连射 goes to the next enemy of her range
  const { h, u } = field({ skill: 0, carry: READY, enemies: [{ key: 'enemy_frail', pos: [10, 3] }, { key: 'enemy_dummy', pos: [10, 5] }] });
  assert.ok(h.runUntil(() => hitsBy(h, u, tagged(COMBO_TAG)).length === 5, 3));
  assert.ok(!h.enemy('enemy_frail').alive);
  assert.ok(hitsBy(h, u, tagged(COMBO_TAG)).every((c) => c.target === h.enemy('enemy_dummy')), 'retargeted');
  assert.equal(u.skill.charges, u.skill.maxCharges - 2);
  done(h);
  // nobody left: no 刚连射; its charge, taken at the cast, comes back ("返还与1次充能等额的技力")
  const left = [];
  const g = field({ skill: 0, carry: READY, enemies: [{ key: 'enemy_frail', pos: [10, 4] }], setup: (b) => b.on('skillStart', (c) => left.push(c.skill.charges)) });
  assert.ok(g.h.runUntil(() => !g.h.enemy('enemy_frail').alive, 3));
  assert.deepEqual(left, [g.u.skill.maxCharges - 2], 'the cast took two charges');
  g.h.run(1.5);
  assert.equal(g.u.skill.activations, 1);
  assert.equal(hitsBy(g.h, g.u, tagged(COMBO_TAG)).length, 0, 'no 刚连射 without a target');
  assert.equal(g.u.skill.charges, g.u.skill.maxCharges - 1, 'the second charge came back');
  done(g.h);
  // exactly one charge (T6 normal: initSp = cost; the elites from carry = one cost)
  for (const [tier, elite, carry] of [[6, false, null], [6, true, { sp: skillOf(6, true, S1).spCost }], [5, true, { sp: skillOf(5, true, S1).spCost }]]) {
    const left = [];
    const { h: k, u: v } = field({ tier, elite, skill: 0, carry, enemies: [{ key: 'enemy_heavy', pos: [10, 5] }], setup: (b) => b.on('skillStart', (c) => left.push(c.skill.charges)) });
    assert.ok(k.runUntil(() => v.skill.activations === 1 && !v.skill.pending, 3));
    assert.deepEqual(left, [0], `T${tier}: the cast took her only charge`);
    k.run(0.5);
    assert.equal(hitsBy(k, v, tagged(COMBO_TAG)).length, 0, 'no 刚连射');
    assert.equal(attacksOf(k, v)[0].length, 4);
    assert.equal(v.skill.charges, 0);
    done(k);
  }
});

test('S1: 刚连射 is settled at the cast (PRTS 备注 "若在已有2次充能所需技力的情况下触发技能…会消耗2次充能所需的技力"): SP that refills while the 4 arrows fly brings none; a target killed while they fly does not stop it', () => {
  // one cost short of two at the cast (charges 1 + 4.95 / 5): the cast takes the charge, nothing is left for 刚连射 — the
  // 0.05 SP that refills while the arrows fly changes nothing
  const sp = skillOf(6, true, S1).spCost;
  const left = [];
  const { h, u } = field({ skill: 0, carry: { sp: 2 * sp - 0.05 }, enemies: [{ key: 'enemy_heavy', pos: [10, 5] }], setup: (b) => b.on('skillStart', (c) => left.push([c.skill.charges, c.skill.sp])) });
  assert.ok(h.runUntil(() => u.skill.activations === 1 && !u.skill.pending, 3));
  h.run(1.5);
  assert.equal(left[0][0], 0, 'the cast took her only full charge');
  assert.ok(left[0][1] < sp, `SP towards the next one: ${left[0][1]}`);
  assert.equal(hitsBy(h, u, tagged(COMBO_TAG)).length, 0, 'no 刚连射');
  assert.ok(u.skill.charges >= 1, 'the SP that refilled is a charge of her own');
  done(h);
  // two charges at the cast; her target is killed by someone else while the 4 arrows fly: 刚连射 still leaves, at the
  // next enemy of her attack selection
  const killed = [];
  const g = field({ skill: 0, carry: READY, enemies: [{ key: 'enemy_dummy', pos: [10, 5] }, { key: 'enemy_heavy', pos: [9, 5] }],
    setup: (b) => b.on('attack', (c) => {
      if (c.attacker !== b.allyUnits.find((x) => x.uid === 1) || !c.isSkill || killed.length) return;
      const t = c.targets[0];
      killed.push(t);
      b.after(0.02, () => b.kill(t));
    }) });
  assert.ok(g.h.runUntil(() => hitsBy(g.h, g.u, tagged(COMBO_TAG)).length === 5, 3), '刚连射 after all');
  assert.equal(killed.length, 1);
  assert.equal(hitsBy(g.h, g.u, (c) => c.dmg.isSkill && c.target === killed[0]).length, 0, 'the 4 arrows found no target');
  const other = g.h.b.enemies.find((e) => e !== killed[0]);
  assert.ok(other && other.alive);
  assert.ok(hitsBy(g.h, g.u, tagged(COMBO_TAG)).every((c) => c.target === other), 'at the next enemy');
  assert.equal(g.u.skill.charges, g.u.skill.maxCharges - 2, 'two charges spent');
  done(g.h);
});

test('S1: "充能至最大层数时自动释放一次" — at full charges it casts inside the operation cooldown (left unchanged); its guards', () => {
  const full = (sk) => { sk.charges = sk.maxCharges; sk.sp = sk.spCost; };
  for (const [tier, elite] of [[6, false], [6, true]]) {
    const { h, u } = field({ tier, elite, skill: 0, carry: READY, enemies: [{ key: 'enemy_heavy', pos: [10, 5] }] });
    const sk = u.skill;
    assert.ok(h.runUntil(() => sk.activations === 1 && !sk.pending, 3));
    h.step(1);
    assert.ok(sk.opCooling, 'the 3 s operation cooldown runs');
    const ready = sk.opReadyAt;
    sk.charges = sk.maxCharges - 1;
    sk.sp = 0;
    h.step(3);
    assert.equal(sk.activations, 1, 'not full: waits for the cooldown');
    h.b.applyStatus(u, 'silence', { duration: 0.5 });
    full(sk);
    h.step(3);
    assert.equal(sk.activations, 1, 'silenced: no cast');
    assert.ok(h.runUntil(() => sk.activations === 2, 1), 'full: casts once the silence is over');
    assert.ok(sk.opCooling, 'inside the cooldown');
    assert.equal(h.hooksOf('skillStart').filter((c) => c.unit === u).at(-1).reason, 'auto');
    assert.equal(sk.opReadyAt, ready, 'the skill\'s own release is no operation: the cooldown is not restarted');
    assert.ok(sk.pending, 'it takes her next attack');
    full(sk);
    h.step(1);
    assert.equal(sk.activations, 2, 'no second cast while one is pending');
    done(h);
    // nobody to shoot: no cast
    const g = field({ tier, elite, skill: 0, carry: READY, enemies: [{ key: 'enemy_heavy', pos: [10, 5] }] });
    assert.ok(g.h.runUntil(() => g.u.skill.activations === 1 && !g.u.skill.pending, 3));
    g.h.b.kill(g.h.enemy('enemy_heavy'));
    full(g.u.skill);
    g.h.step(10);
    assert.ok(g.u.skill.opCooling);
    assert.equal(g.u.skill.activations, 1, 'no enemy in her attack selection');
    done(g.h);
  }
});

test('S2 飞翔瞪射: free cast at every deployment; 起飞; volleys 3 / 4 / 5 on the 4-4 (flyers too); the landing on the 1-3; no attack in flight — every form', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    const sk = skillOf(tier, elite, S2), bb = sk.bb, ds = DS(tier, elite), pw = POWER(tier, elite).power_attack_scale;
    assert.ok(/分别射出3、4、5支/.test(sk.desc));
    const spAtEnd = [];
    const { h, u } = field({ tier, elite, mod, skill: 1, setup: (b) => b.on('skillEnd', (c) => spAtEnd.push(c.skill.sp)),
      enemies: [{ key: 'enemy_dummy', pos: [10, 5] }, { key: 'enemy_armor', pos: [10, 7] }, { key: 'enemy_heavy', pos: [10, 8] }, { key: 'enemy_fly', pos: [9, 6], route: 2 },
        { key: 'enemy_fly2', pos: [11, 4], route: 3 }, { key: 'enemy_far', pos: [10, 4] }] });
    const start = h.hooksOf('skillStart').filter((c) => c.unit === u);
    assert.equal(start.length, 1);
    assert.equal(start[0].reason, 'deploy');
    assert.equal(u.skill.charges, 0, 'no charge spent');
    assert.equal(u.skill.sp, sk.initSp, 'no SP spent');
    assert.ok(u.s.flags.liftoff && u.s.flags.blockFly, '起飞');
    assert.equal(u.mem.orchd2.left, POWER(tier, elite).power_attack_count, '强击瓶专家 opened by the free cast');
    const plan = s2Plan(true, sk.duration); // the free deploy cast is the deployment's first opening
    h.run(plan.end + 0.2);
    assert.ok(!u.skill.active && !u.s.flags.liftoff, 'lands');
    assert.deepEqual(spAtEnd, [sk.initSp], 'no SP gained while it ran');
    const t0 = start[0].t;
    const A = u.s.atk, [d, a, hv, fl, fl2, far] = ['enemy_dummy', 'enemy_armor', 'enemy_heavy', 'enemy_fly', 'enemy_fly2', 'enemy_far'].map((k) => h.enemy(k));
    const vol = hitsBy(h, u, tagged(VOLLEY_TAG));
    for (const [k, n] of [[0, 3], [1, 4], [2, 5]]) {
      const at = vol.filter((c) => Math.abs(c.t - (t0 + plan.volleys[k])) <= 0.04);
      for (const e of [d, a, fl]) assert.equal(at.filter((c) => c.target === e).length, n, `${label(f)}: volley ${k + 1}: ${n} arrows`);
    }
    assert.equal(vol.length, 36, `${label(f)}: nobody off the 4-4`);
    assert.ok(vol.filter((c) => c.target === d).every((c) => near(c.amount, A * bb['attack@atk_scale_loop'] * pw * ds)), `${label(f)}: loop × 强击瓶 × damage_scale`);
    assert.ok(vol.filter((c) => c.target === a).every((c) => near(c.amount, phys(A * bb['attack@atk_scale_loop'] * pw, 300) * ds)));
    const land = hitsBy(h, u, tagged(LAND_TAG));
    assert.deepEqual(land.map((c) => c.target).sort((x, y) => x.id - y.id), [fl2, far].sort((x, y) => x.id - y.id), `${label(f)}: landing on the 1-3 only, a flyer too`);
    assert.ok(land.every((c) => near(c.amount, A * bb['attack@atk_scale_end'] * pw) && Math.abs(c.t - (t0 + plan.land)) <= 0.04), `${label(f)}: ${land[0].amount} at the landing`);
    const te = h.hooksOf('skillEnd').find((c) => c.unit === u).t;
    assert.ok(Math.abs(te - t0 - plan.end) <= 0.04, `${label(f)}: ends at ${te - t0}`);
    assert.equal(h.hooksOf('attack').filter((c) => c.attacker === u && c.t < te).length, 0, 'no normal attack in flight');
    assert.equal(hitsBy(h, u, (c) => c.target === hv).length, 0);
    const after = h.hooksOf('attack').filter((c) => c.attacker === u).length;
    assert.equal(u.mem.orchd2.left, POWER(tier, elite).power_attack_count - 4 - after, 'three volleys and the landing: four rounds (then her attacks)');
    h.b.kill(u);
    assert.ok(h.b.redeploy(u));
    const again = h.hooksOf('skillStart').filter((c) => c.unit === u);
    assert.equal(again.length, 2);
    assert.equal(again[1].reason, 'deploy', 'again at the redeploy');
    done(h);
  }
});

test('S2: the volleys and the landing follow her clips (PRTS 备注 "跟随动画"): the deploy cast (Skill_2_Begin_First) at 1.667 / 2.5 / 3.333 s, landing 4.233 s, over at 5.0 s; a later cast at 0.833 / 1.667 / 2.5 s, landing 3.4 s, over at its 4.2 s; airborne until the landing', () => {
  const sk = skillOf(6, true, S2);
  assert.equal(sk.duration, 4.2);
  const { h, u } = field({ skill: 1, carry: { sp: sk.spCost }, enemies: [{ key: 'enemy_dummy', pos: [10, 5] }, { key: 'enemy_far', pos: [10, 4] }] });
  const ground = []; // (time, liftoff) while the skill runs
  h.b.on('tick', () => { if (u.skill.active) ground.push([h.b.time, !!u.s.flags.liftoff]); });
  const casts = () => h.hooksOf('skillStart').filter((c) => c.unit === u);
  for (const [i, first] of [[0, true], [1, false]]) {
    if (i) assert.ok(h.runUntil(() => casts().length === 2, 10), 'a SKILL_RANGE cast');
    const t0 = casts()[i].t, plan = s2Plan(first, sk.duration);
    assert.ok(h.runUntil(() => h.hooksOf('skillEnd').filter((c) => c.unit === u).length > i, 8));
    const te = h.hooksOf('skillEnd').filter((c) => c.unit === u)[i].t;
    approx(te - t0, plan.end, `cast ${i + 1}: over`, 0.01);
    const vol = hitsBy(h, u, (c) => tagged(VOLLEY_TAG)(c) && c.t >= t0 && c.t <= te && c.target === h.enemy('enemy_dummy'));
    const times = [...new Set(vol.map((c) => c.t))];
    assert.equal(times.length, 3, `cast ${i + 1}: three volleys`);
    times.forEach((t, k) => approx(t - t0, plan.volleys[k], `cast ${i + 1}: volley ${k + 1}`, 0.01));
    const land = hitsBy(h, u, (c) => tagged(LAND_TAG)(c) && c.t >= t0 && c.t <= te);
    assert.equal(land.length, 1, `cast ${i + 1}: the landing`);
    approx(land[0].t - t0, plan.land, `cast ${i + 1}: landing`, 0.01);
    const air = ground.filter(([t]) => t > t0 + 0.05 && t < te - 1e-9);
    assert.ok(air.filter(([t]) => t < t0 + plan.land - 0.05).every(([, l]) => l), `cast ${i + 1}: airborne until the landing`);
    assert.ok(air.filter(([t]) => t > t0 + plan.land + 0.05).every(([, l]) => !l), `cast ${i + 1}: on the ground after it`);
    assert.equal(h.hooksOf('attack').filter((c) => c.attacker === u && c.t > t0 && c.t < te).length, 0, `cast ${i + 1}: no attack while the skill plays`);
  }
  done(h);
});

test('S2: SKILL_RANGE casts a charge once an enemy is on the 4-4; the take-off lets the ground enemy she blocks walk on', () => {
  for (const [tier, elite] of [[6, false], [5, true], [6, true]]) {
    const sk = skillOf(tier, elite, S2);
    const { h, u } = field({ tier, elite, skill: 1, carry: READY, enemies: [{ key: 'enemy_dummy', pos: [10, 3] }, { key: 'enemy_heavy', pos: [9, 6], time: 6 }] });
    h.run(5.5);
    const e = h.enemy('enemy_dummy');
    assert.equal(u.skill.activations, 1, 'only the free cast: nobody on the 4-4');
    assert.equal(u.skill.rule, 'SKILL_RANGE');
    assert.equal(u.skill.charges, sk.maxChargeTime);
    assert.ok(e.blockedBy === u && u.blocking.includes(e), 'landed: she blocks the one on her tile');
    assert.ok(h.runUntil(() => u.skill.activations === 2, 1), 'an enemy entered the 4-4');
    assert.equal(h.hooksOf('skillStart').filter((c) => c.unit === u).at(-1).reason, 'SKILL_RANGE');
    assert.equal(u.skill.charges, sk.maxChargeTime - 1);
    assert.ok(e.blockedBy !== u && !u.blocking.length, 'released at the take-off');
    h.run(1);
    assert.ok(u.skill.active && !u.blocking.length, 'none blocked in flight');
    done(h);
  }
});

test('S2 ended early (knock-out / stop): no more volleys, no landing', () => {
  for (const end of ['death', 'stopped']) {
    const { h, u } = field({ skill: 1, enemies: [{ key: 'enemy_dummy', pos: [10, 5] }, { key: 'enemy_armor', pos: [10, 7] }, { key: 'enemy_far', pos: [10, 4] }] });
    assert.ok(h.runUntil(() => hitsBy(h, u, tagged(VOLLEY_TAG)).length > 0, 3), 'the first volley');
    h.step(1);
    const n = hitsBy(h, u, tagged(VOLLEY_TAG)).length;
    assert.equal(n, 6, '3 arrows × 2 enemies');
    if (end === 'death') h.b.kill(u); else u.skill.stop();
    assert.equal(h.hooksOf('skillEnd').filter((c) => c.unit === u).at(-1).reason, end);
    h.run(5);
    assert.equal(hitsBy(h, u, tagged(VOLLEY_TAG)).length, n, `${end}: no more volleys`);
    assert.equal(hitsBy(h, u, tagged(LAND_TAG)).length, 0, `${end}: no landing`);
    assert.ok(!u.s.flags.liftoff);
    done(h);
  }
});

test('S3 龙之箭: 蓄力 3 s (+20 frames at the first opening of a deployment) with no attack, the arrow 3 frames into Skill_3_End; along her facing: phys then arts at every step on the line, one push per enemy, flyers too — every form', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    const sk = skillOf(tier, elite, S3), bb = sk.bb, pw = POWER(tier, elite).power_attack_scale;
    assert.ok(/蓄力3秒/.test(sk.desc) && sk.duration < 0, 'no duration in the data');
    const launches = [];
    const { h, u } = field({ tier, elite, mod, skill: 2, carry: READY, setup: launchesInto(launches),
      enemies: [{ key: 'enemy_dummy', pos: [10, 5] }, { key: 'enemy_far', pos: [11, 5] }, { key: 'enemy_armor', pos: [10, 8] }, { key: 'enemy_fly', pos: [10, 7], route: 2 }, { key: 'enemy_heavy', pos: [9, 6] }] });
    assert.ok(h.runUntil(() => u.skill.activations === 1, 3));
    assert.equal(u.skill.rule, 'DEFAULT');
    assert.equal(u.skill.maxCharges, sk.maxChargeTime);
    const ts = h.hooksOf('skillStart').find((c) => c.unit === u).t, A = u.s.atk;
    assert.ok(u.findBuff(CHARGE_KEY) && u.s.flags.disarm, 'charging');
    const [d, off, a, fl] = ['enemy_dummy', 'enemy_far', 'enemy_armor', 'enemy_fly'].map((k) => h.enemy(k));
    const x0 = { d: d.x, a: a.x, fl: fl.x };
    assert.ok(h.runUntil(() => launches.length >= 1, 5));
    const te = launches[0];
    approx(te - ts, 3 + 20 / 30 + 3 / 30, `${label(f)}: the first opening's charge, then 3 frames`, 0.02);
    assert.equal(h.hooksOf('attack').filter((c) => c.attacker === u && c.t >= ts && c.t < te).length, 0, 'no attack while charging (the cast\'s own attack dropped)');
    assert.equal(h.hooksOf('skillStart').filter((c) => c.unit === u && c.t < te).length, 1, 'no other cast while charging');
    assert.ok(u.findBuff(CHARGE_KEY) && u.skill.activations === 1, 'Skill_3_End still plays');
    h.run(1.5);
    const arrow = hitsBy(h, u, tagged(ARROW_TAG));
    for (const [e, def] of [[d, 0], [a, 300], [fl, 0]]) {
      const mine = arrow.filter((c) => c.target === e);
      const p = mine.filter((c) => c.type === 'phys'), m = mine.filter((c) => c.type === 'arts');
      assert.ok(p.length >= 4 && p.length === m.length, `${label(f)}: ${p.length} steps reach ${e.defId}`);
      for (let i = 0; i < mine.length; i += 2) assert.deepEqual([mine[i].type, mine[i + 1].type], ['phys', 'arts'], 'physical first, then arts');
      assert.ok(p.every((c) => near(c.amount, phys(A * bb.atk_scale * pw, def))), `${label(f)}: phys ${p[0].amount}`);
      assert.ok(m.every((c) => near(c.amount, A * bb.atk_scale_magic * pw)), `${label(f)}: arts ${m[0].amount}`);
    }
    assert.equal(arrow.filter((c) => c.target === off || c.target === h.enemy('enemy_heavy')).length, 0, 'a row off the line: missed');
    for (const [e, x] of [[d, x0.d], [a, x0.a], [fl, x0.fl]]) {
      approx(e.x, Math.min(x + h.b.pushDistance(e, bb.force), h.b.rect.c1 + 0.4), `${label(f)}: ${e.defId} pushed once along her facing`, 0.05);
    }
    assert.deepEqual([d.y, a.y, fl.y], [10, 10, 10], 'a straight push');
    // the next opening of this deployment: 3 s
    assert.ok(h.runUntil(() => u.skill.activations === 2, 30));
    const t2 = h.hooksOf('skillStart').filter((c) => c.unit === u)[1].t;
    assert.ok(h.runUntil(() => launches.length >= 2, 5));
    approx(launches[1] - t2, 3 + 3 / 30, `${label(f)}: later openings`, 0.02);
    done(h);
  }
});

test('S3: Skill_3_End (1.233 s from the end of the charge, PRTS "随后约3帧（0.1秒）后产生弹道") holds her: her next attack / her second charge only once it is over', () => {
  for (const [tier, elite] of [[6, false], [6, true]]) {
    const launches = [];
    const sk = skillOf(tier, elite, S3);
    const { h, u } = field({ tier, elite, skill: 2, carry: READY, setup: launchesInto(launches), enemies: [{ key: 'enemy_heavy', pos: [10, 5] }] });
    assert.ok(h.runUntil(() => launches.length >= 1, 6));
    const ts = h.hooksOf('skillStart').find((c) => c.unit === u).t, free = ts + 3 + 20 / 30 + 37 / 30;
    assert.ok(h.runUntil(() => h.hooksOf('attack').some((c) => c.attacker === u && c.t > ts) || u.skill.activations > 1, 6));
    const next = Math.min(...h.hooksOf('attack').filter((c) => c.attacker === u && c.t > ts).map((c) => c.t), ...h.hooksOf('skillStart').filter((c) => c.unit === u).slice(1).map((c) => c.t));
    approx(next, free, `T${tier} ${elite ? 'elite' : 'normal'}: she acts again at the end of Skill_3_End`, 0.04);
    assert.equal(u.skill.activations > 1, sk.maxChargeTime > 1, 'a second charge casts at once then (elite: 2 charges)');
    done(h);
  }
});

test('S3: the arrow flies from her 弹道受击点, 0.2323 tile north of her (PRTS 备注): an enemy 0.4 south of her row is missed, one 0.6 north of it is hit and pushed', () => {
  const launches = [];
  const { h, u } = field({ skill: 2, carry: { sp: skillOf(6, true, S3).spCost }, setup: launchesInto(launches),
    enemies: [{ key: 'enemy_dummy', pos: [10, 5] }, { key: 'enemy_heavy', pos: [10, 7] }, { key: 'enemy_far', pos: [10, 8] }] });
  const south = h.enemy('enemy_heavy'), north = h.enemy('enemy_far');
  south.y = 9.6;
  north.y = 10.6;
  assert.ok(h.runUntil(() => launches.length === 1, 6));
  h.run(1.5);
  assert.equal(hitsBy(h, u, (c) => tagged(ARROW_TAG)(c) && c.target === south).length, 0, '0.4 south: 0.63 from the line, missed');
  assert.ok(hitsBy(h, u, (c) => tagged(ARROW_TAG)(c) && c.target === north).length >= 2, '0.6 north: 0.37 from the line, hit');
  assert.ok(hitsBy(h, u, (c) => tagged(ARROW_TAG)(c) && c.target === h.enemy('enemy_dummy')).length >= 2, 'her own row: 0.23 from it, hit');
  done(h);
});

test('S3: its SP recovers from the cast on (no duration); the arrow flies on when she is knocked out after the launch; a knock-out while charging fires nothing, a 【移动】 keeps the charge', () => {
  const one = { sp: skillOf(6, true, S3).spCost };
  const launches = [];
  const { h, u } = field({ skill: 2, carry: one, setup: launchesInto(launches), enemies: [{ key: 'enemy_dummy', pos: [10, 5] }] });
  assert.ok(h.runUntil(() => u.skill.activations === 1, 3));
  assert.ok(!u.skill.active && u.skill.sp < 0.1, 'the cast spent its SP');
  assert.ok(h.runUntil(() => launches.length === 1, 5));
  approx(u.skill.sp, (launches[0] - h.hooksOf('skillStart')[0].t) * u.s.spRecovery, 'SP recovered while charging', 0.03);
  h.b.kill(u);
  h.run(1);
  assert.ok(hitsBy(h, u, tagged(ARROW_TAG)).length >= 8, 'hits after her knock-out');
  done(h);
  const g = field({ skill: 2, carry: one, enemies: [{ key: 'enemy_dummy', pos: [10, 5] }] });
  assert.ok(g.h.runUntil(() => g.u.skill.activations === 1, 3));
  g.h.run(1);
  g.h.b.kill(g.u);
  g.h.run(5);
  assert.equal(hitsBy(g.h, g.u, tagged(ARROW_TAG)).length, 0, 'no arrow');
  assert.ok(g.h.b.redeploy(g.u));
  g.h.run(5);
  assert.equal(hitsBy(g.h, g.u, tagged(ARROW_TAG)).length, 0, 'none after her redeploy either');
  done(g.h);
  const launched = [];
  const m = field({ skill: 2, carry: one, setup: launchesInto(launched), enemies: [{ key: 'enemy_dummy', pos: [10, 5] }] });
  assert.ok(m.h.runUntil(() => m.u.skill.activations === 1, 3));
  m.h.run(1);
  assert.ok(m.h.b.moveRedeploy(m.u, 10, 4));
  assert.ok(m.h.runUntil(() => launched.length === 1, 4), 'fired after the move');
  done(m.h);
});

test('T1 强击瓶专家: from her first skill opening of a deployment the next 50 rounds (attacks, the arrow) ×1.2 ATK scale, then ×1; a redeploy closes it until the next opening', () => {
  for (const [tier, elite] of [[6, false], [6, true]]) {
    const t0 = POWER(tier, elite), ds = DS(tier, elite);
    const ends = [];
    const { h, u } = field({ tier, elite, skill: 2, setup: launchesInto(ends), enemies: [{ key: 'enemy_heavy', pos: [10, 5] }] });
    h.run(120);
    const A = u.s.atk;
    const starts = h.hooksOf('skillStart').filter((c) => c.unit === u).map((c) => c.t);
    assert.ok(starts.length >= 2 && ends.length >= 2);
    // the rounds after the opening, in order: her attacks (`attack` hook) and the arrows (their launch)
    // (the attacks launched in the last 0.5 s may still be in flight)
    const atkTimes = h.hooksOf('attack').filter((c) => c.attacker === u && c.t < h.b.time - 0.5).map((c) => c.t);
    const atks = attacksOf(h, u).slice(0, atkTimes.length);
    assert.equal(atks.length, atkTimes.length, 'every attack landed');
    // (an attack in the tick the charge ends comes after the arrow)
    const rounds = [...atkTimes.map((t, i) => ({ t, atk: atks[i] })), ...ends.map((t) => ({ t, arrow: true }))].filter((r) => r.t > starts[0])
      .sort((x, y) => x.t - y.t || (x.arrow ? 0 : 1) - (y.arrow ? 0 : 1));
    assert.ok(rounds.length > t0.power_attack_count + 3, `${rounds.length} rounds`);
    assert.ok(atks.filter((_, i) => atkTimes[i] < starts[0]).flat().every((c) => near(c.amount, A * ds)), 'before her first opening: ×1');
    rounds.forEach((r, i) => {
      const scale = i < t0.power_attack_count ? t0.power_attack_scale : 1;
      if (r.atk) assert.ok(r.atk.every((c) => near(c.amount, A * scale * ds)), `round ${i}: ×${scale}`);
      else {
        const hit = hitsBy(h, u, (c) => tagged(ARROW_TAG)(c) && c.type === 'phys' && c.t >= r.t && c.t < r.t + 1)[0];
        assert.ok(hit && near(hit.amount, A * skillOf(tier, elite, S3).bb.atk_scale * scale), `arrow round ${i}: ×${scale}`);
      }
    });
    assert.ok(!u.findBuff(POWER_KEY), 'the window closed');
    h.b.kill(u);
    assert.ok(h.b.redeploy(u));
    const back = h.b.time, A2 = u.s.atk; // (翔虫机动's ATK on this redeploy)
    h.run(3);
    const again = attacksOf(h, u, (c) => c.t > back + 0.3);
    assert.ok(again.length >= 1 && again.flat().every((c) => near(c.amount, A2 * ds)), 'redeployed: closed until her next opening');
    done(h);
    // knocked out with the window still open: the redeploy closes it (what was left is lost)
    const g = field({ tier, elite, skill: 2, carry: { sp: skillOf(tier, elite, S3).spCost }, enemies: [{ key: 'enemy_heavy', pos: [10, 5] }] });
    assert.ok(g.h.runUntil(() => g.u.skill.activations === 1, 15));
    g.h.run(8);
    assert.ok(g.u.findBuff(POWER_KEY) && g.u.mem.orchd2.left > 0, 'open');
    assert.ok(attacksOf(g.h, g.u).at(-1).every((c) => near(c.amount, g.u.s.atk * t0.power_attack_scale * ds)), 'powered');
    g.h.b.kill(g.u);
    assert.ok(g.h.b.redeploy(g.u));
    assert.ok(!g.u.findBuff(POWER_KEY) && g.u.mem.orchd2.left === 0, 'closed by the redeploy');
    done(g.h);
  }
});

test('T1: the arrows of an attack keep the 强击瓶 multiplier of their launch ("于弹道脱手前…生效"), whatever the window does while they fly', () => {
  const t0 = POWER(6, true), ds = DS(6, true);
  const { h, u } = field({ skill: 2, carry: { sp: 0 }, enemies: [{ key: 'enemy_heavy', pos: [10, 5] }] });
  const ids = new Map();   // attack ordinal (1 = her first) → its attackId
  let n = h.hooksOf('attack').filter((c) => c.attacker === u).length;
  const powerOn = () => h.b.addBuff(u, { key: POWER_KEY, mods: { atkScaleMul: t0.power_attack_scale }, source: u, tags: ['talent'] });
  // attack 3 is the window's last round (one left, the buff on as it leaves)
  h.b.on('beforeAttack', (c) => { if (c.attacker === u && n + 1 === 3) { u.mem.orchd2.left = 1; powerOn(); } });
  h.b.on('attack', (c) => {
    if (c.attacker !== u) return;
    ids.set(++n, c.attackId);
    if (n === 2) powerOn();                          // launched outside the window: it opens while they fly
    if (n === 3) h.b.removeBuff(u, POWER_KEY);       // the last powered round: the window closes while they fly
  }, { priority: -100 });
  assert.ok(h.runUntil(() => n >= 4, 10));
  h.run(1);
  assert.equal(u.skill.activations ?? 0, 0, 'no skill meanwhile');
  const A = u.s.atk;
  const by = new Map(attacksOf(h, u).map((a) => [a[0].dmg.attackId, a]));
  const amounts = (k) => (by.get(ids.get(k)) ?? []).map((c) => c.amount);
  assert.ok(amounts(2).length && amounts(2).every((x) => near(x, A * ds)), `launched before the opening: ×1 (${amounts(2)})`);
  assert.ok(amounts(3).length && amounts(3).every((x) => near(x, A * t0.power_attack_scale * ds)), `the last powered round: ×${t0.power_attack_scale} (${amounts(3)})`);
  assert.ok(amounts(4).length && amounts(4).every((x) => near(x, A * ds)), `the next round: ×1 (${amounts(4)})`);
  done(h);
});

test('T1: a 【移动】 keeps the open window (no exit)', () => {
  const { h, u } = field({ skill: 2, carry: { sp: skillOf(6, true, S3).spCost }, enemies: [{ key: 'enemy_heavy', pos: [10, 5] }] });
  assert.ok(h.runUntil(() => u.skill.activations === 1, 6));
  h.run(8);
  const left = u.mem.orchd2.left;
  assert.ok(left > 0 && left < POWER(6, true).power_attack_count, `window open (${left} left)`);
  assert.ok(h.b.moveRedeploy(u, 10, 4));
  assert.equal(u.mem.orchd2.left, left, 'kept');
  assert.ok(u.findBuff(POWER_KEY));
  const t = h.b.time;
  h.run(4);
  const after = attacksOf(h, u, (c) => c.t > t + 0.3);
  assert.ok(after.length >= 2 && after.flat().every((c) => near(c.amount, u.s.atk * POWER(6, true).power_attack_scale * DS(6, true))), 'still powered after the move');
  done(h);
});

test('T2 翔虫机动: redeploy time −respawn_time (once), every redeploy costs her cost (never raised), WAIT_DP — every form', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    const form = formOf(tier, elite), cost = form.stats.cost;
    const wait = form.stats.respawnTime + (modOf(tier, elite, mod)?.attr.respawnTime ?? 0) + talOf(tier, elite, mod, 3).bb.respawn_time;
    const { h, u } = field({ tier, elite, mod, skill: 2 });
    for (let i = 0; i < 2; i++) {
      h.b.kill(u);
      approx(u.respawnAt - u.deathAt, wait, `${label(f)}: redeploy time`);
      h.b.getPlayer('p1').dp = 50;
      h.run(wait - 0.1);
      assert.ok(!u.alive, 'still counting');
      h.run(0.2);
      assert.ok(u.alive, `redeployed after ${wait} s`);
      assert.equal(h.b.getPlayer('p1').dp, 50 - cost, `${label(f)}: redeploy #${i + 1} costs ${cost} (不提高部署费用)`);
    }
    h.b.kill(u);
    h.b.getPlayer('p1').dp = cost - 1;
    h.run(wait + 0.5);
    assert.ok(h.b.isDown(u));
    assert.equal(h.snapshot().down.find((x) => x[0] === u.id)[3], DOWN_STATE.WAIT_DP);
    h.b.addDp('p1', 1);
    h.step(1);
    assert.ok(u.alive && h.b.getPlayer('p1').dp === 0, 'redeploys once the DP is there');
    done(h);
  }
});

test('T2: ATK +atk for atk_duration s on a deployment near the tile she left (x-1; ARC-X stage 3: x-2); none at the battle start or after a 【移动】 — every form', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    const t1 = talOf(tier, elite, mod, 1), range = t1.bbStr.ignore_build_type_target_range;
    assert.equal(range, tier === 6 && mod ? 'x-2' : 'x-1', label(f));
    const { h, u } = field({ tier, elite, mod, skill: 2 });
    assert.equal(u.findBuff(WIREBUG_KEY), null, 'nothing at the battle start');
    h.b.kill(u);
    assert.ok(h.b.redeploy(u));
    const b = u.findBuff(WIREBUG_KEY);
    assert.ok(b && b.mods.atkPct === t1.bb.atk && near(b.timeLeft, t1.bb.atk_duration), `${label(f)}: +${t1.bb.atk} for ${t1.bb.atk_duration} s`);
    approx(u.s.atk, u.base.atk * (1 + t1.bb.atk), `${label(f)}: ATK`);
    h.run(t1.bb.atk_duration + 0.1);
    assert.equal(u.findBuff(WIREBUG_KEY), null, 'lapses');
    // a retreat is an exit too: her automatic redeploy where she lies gets it
    h.b.retreat(u);
    h.b.getPlayer('p1').dp = 99;
    h.run(u.respawnAt - h.b.time + 0.1);
    assert.ok(u.alive && u.findBuff(WIREBUG_KEY), 'after a retreat');
    h.b.removeBuff(u, WIREBUG_KEY);
    // a tile (+1 row, +2 cols) away: inside x-2, outside x-1
    h.b.kill(u);
    assert.ok(h.b.redeploy(u, { tile: [11, 5] }));
    assert.equal(!!u.findBuff(WIREBUG_KEY), range === 'x-2', `${label(f)}: ${range}`);
    h.b.removeBuff(u, WIREBUG_KEY);
    // 【移动】: no exit, no marker
    assert.ok(h.b.moveRedeploy(u, 11, 3));
    assert.equal(u.findBuff(WIREBUG_KEY), null, 'a move gives none');
    done(h);
  }
});

test('two copies (two players on one field): their own redeploy times, 翔虫机动 buffs and DP', () => {
  const slot = (tier) => BACKUPS.diy.slots[SLOT[tier]];
  const players = [
    { playerId: 'p1', seat: 0, side: 'L', colOffset: 0, bonds: {}, units: [{ uid: 1, kind: 'chess', chessId: slot(6).goldenId, diy: { charId: CHAR, skillIndex: 2, uniEquipId: X }, row: 10, col: 3 }] },
    { playerId: 'p2', seat: 1, side: 'L', colOffset: 8, bonds: {}, units: [{ uid: 2, kind: 'chess', chessId: SLOT[5], diy: { charId: CHAR, skillIndex: 2, uniEquipId: null }, row: 10, col: 3 }] },
  ];
  const { h } = field({ players, kind: 'unite' });
  const a = h.unit(1), b = h.unit(2);
  assert.deepEqual([a.ownerId, b.ownerId], ['p1', 'p2']);
  h.b.kill(a);
  h.b.kill(b);
  approx(a.respawnAt - a.deathAt, 66 - 25 - 18, 'p1: T6 elite ARC-X');
  approx(b.respawnAt - b.deathAt, 66 - 15, 'p2: T5 normal');
  h.b.getPlayer('p1').dp = 40;
  h.b.getPlayer('p2').dp = 40;
  h.run(a.respawnAt - h.b.time + 0.1);
  assert.ok(a.alive && !b.alive, 'p1\'s copy back first');
  assert.equal(a.findBuff(WIREBUG_KEY).mods.atkPct, talOf(6, true, X, 1).bb.atk);
  assert.deepEqual([h.b.getPlayer('p1').dp, h.b.getPlayer('p2').dp], [40 - formOf(6, true).stats.cost, 40], 'p1 pays');
  h.run(b.respawnAt - h.b.time + 0.1);
  assert.ok(b.alive);
  assert.equal(b.findBuff(WIREBUG_KEY).mods.atkPct, talOf(5, false, null, 1).bb.atk, 'its own form');
  assert.equal(h.b.getPlayer('p2').dp, 40 - formOf(5, false).stats.cost, 'p2 pays');
  done(h);
});

test('every form × skill survives a real wave and casts', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    for (const skill of [0, 1, 2]) {
      const h = makeBattle({ seed: 3, timeLimit: 60,
        units: [{ uid: 1, diy: { slot: SLOT[tier], charId: CHAR, skillIndex: skill, uniEquipId: mod }, elite, row: 10, col: 4, carryState: READY }, { chessId: 'chess_char_2_06_a', row: 10, col: 6 }],
        enemies: [{ key: 'enemy_1007_slime', count: 8, interval: 1.5 }, { key: 'enemy_1007_slime', route: 1, count: 8, interval: 1.5, time: 3 }] });
      h.runToEnd(90);
      done(h);
      assert.ok(h.unit(1).skill.activations > 0, `${label(f)} ${SKILL_IDS[skill]} casts`);
    }
  }
});
