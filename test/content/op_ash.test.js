// test/content/op_ash.test.js — the 自选 operator kit of 灰烬 (char_456_ash, 6★ 速射手; a collab pick of this fork — the fork
// owner's decision of 2026-10-08; kit server/sim/content/kits/ops/op-ash.js), fielded the production way (a DIY slot + its
// `diy` pick, simdata getDiy) in every form: tiers 5 / 6, normal (E2 Lv1, skill rank 4, no module) and elite (E2 Lv60, rank
// 7) with no module, MAR-Y 破墙榴弹战术收纳包 or MAR-X 刺针式合金爆破弹 at stage 1 (tier 5) / 3 (tier 6). Every number is read
// back from data/backups.json (the form of that slot status); the fidelity checklist of kits/README.md item by item.
// Run: node --test test/content/op_ash.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { KITTED_CHARS, OPERATOR_KITS, KITS } from '../../server/sim/content/kits/index.js';
import { diyPool, validateDiyPicks } from '../../shared/diy.js';
import { FLASH_RADIUS, PATH_RADIUS, PATH_TAG, BLAST_TAG, markKey } from '../../server/sim/content/kits/ops/op-ash.js';
import { PUSH_TILES } from '../../server/sim/constants.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../../data/${f}.json`, import.meta.url), 'utf8'));
const CHESS = load('chess');
const BACKUPS = load('backups');
const ASH = 'char_456_ash';
const FORMS = BACKUPS.units[ASH].forms;
const SLOT = { 5: 'chess_char_5_diy1_a', 6: 'chess_char_6_diy1_a' };
const MAR_Y = 'uniequip_002_ash', MAR_X = 'uniequip_003_ash';
const S1 = 'skchr_ash_1', S2 = 'skchr_ash_2', S3 = 'skchr_ash_3';
const statusOf = (tier, elite) => (elite ? (tier === 5 ? '2/60/7/1' : '2/60/7/3') : '2/1/4/0');
const formOf = (tier, elite) => FORMS[statusOf(tier, elite)];
const skillOf = (tier, elite, id) => formOf(tier, elite).skills.find((s) => s.skillId === id);
const modOf = (tier, mod) => (mod ? formOf(tier, true).modules.find((m) => m.uniEquipId === mod) : null);
/** A talent's blackboard of a form with a module (the module's talent change replaces the base talent). */
const talOf = (tier, elite, mod, index) => {
  const ch = elite ? modOf(tier, mod)?.talentChanges?.find((t) => t.talentIndex === index) : null;
  return ch?.bb ?? formOf(tier, elite).talents.find((t) => t.index === index).bb;
};
const approx = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
const phys = (a, def) => Math.max(a - def, 0.05 * a);
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e9, speed: 0, mass: 0, ...o });
const ENEMIES = {
  enemy_dummy: dummy('enemy_dummy'), enemy_armor: dummy('enemy_armor', { def: 300 }), // a flyer is a 静态刚体 like every air unit of the data (build-data STATIC_BODIES): no push moves it
  enemy_fly: { ...dummy('enemy_fly', { motion: 'FLY' }), staticBody: true },
  enemy_nostun: dummy('enemy_nostun', { immunities: { stun: true } }), enemy_heavy: dummy('enemy_heavy', { mass: 5 }),
  enemy_walk: enemyRec({ key: 'enemy_walk', hp: 1e9, speed: 0.5, mass: 0 }),
  enemy_m0: dummy('enemy_m0', { mass: 0 }), enemy_m1: dummy('enemy_m1', { mass: 1 }), enemy_m2: dummy('enemy_m2', { mass: 2 }),
};
/** Every 自选 form: [tier, elite, module]. */
const FORMS_ALL = [[5, false, null], [6, false, null], ...[5, 6].flatMap((t) => [null, MAR_Y, MAR_X].map((m) => [t, true, m]))];
const label = ([tier, elite, mod]) => `T${tier} ${elite ? 'elite' : 'normal'} ${mod ?? 'none'}`;
const HOOKS = ['damaged', 'skillStart', 'skillEnd', 'statusApplied', 'deploy', 'spGain', 'attack', 'death'];

/** 灰烬 as uid 1 at (row, col) facing `dir` (RIGHT), plus `others`; `setup` runs before the battle starts. */
function field({ tier = 5, elite = false, mod = null, skill = 0, row = 10, col = 3, dir, others = [], enemies = [], seed = 5, flags = {}, flat, setup, step = true } = {}) {
  const h = makeBattle({
    defs: { enemies: ENEMIES }, timeLimit: 900, autoFinish: false, seed, flat, setup,
    flags: { dpPerSec: 0, dpMax: 999, ...flags }, hooks: HOOKS, captureNoisy: true, enemies,
    units: [{ uid: 1, diy: { slot: SLOT[tier], charId: ASH, skillIndex: skill, uniEquipId: mod }, elite, row, col, ...(dir ? { dir } : null) }, ...others],
  });
  if (step) h.step();
  return { h, u: h.unit(1) };
}
const hitsBy = (h, u, f = () => true) => h.hooksOf('damaged').filter((c) => c.source === u && f(c));
const tagged = (tag) => (c) => (c.dmg?.tags ?? []).includes(tag);
const stunsBy = (h, u) => h.hooksOf('statusApplied').filter((c) => c.source === u && c.status === 'stun');
const dp = (h) => h.b.getPlayer('p1').dp;
function done(h) {
  checkInvariants(h.b);
  assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
}

test('灰烬 in every 自选 form: her kit (all three skills authored), the form\'s stats + module attributes, 3-3, 速射手 (ranged physical, air first, MAR-X ×1.1 on flyers), blocks 1, 协防, the triggers (S1 at full SP, S2 basic, S3 on her 4-1); offered as a pick', () => {
  assert.equal(OPERATOR_KITS[ASH], KITS[ASH]);
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    for (const skill of [0, 1, 2]) {
      const { h, u } = field({ tier, elite, mod, skill });
      const form = formOf(tier, elite), m = elite ? modOf(tier, mod) : null;
      assert.deepEqual([u.def.charId, u.def.diyFor, u.skill.id, !!u.kit.generic, u.kit.skillSource], [ASH, SLOT[tier], form.skills[skill].skillId, false, 'skills'], label(f));
      assert.deepEqual([u.base.maxHp, u.base.atk, u.base.def, u.base.aspd],
        [form.stats.maxHp + (m?.attr.maxHp ?? 0), form.stats.atk + (m?.attr.atk ?? 0), form.stats.def + (m?.attr.def ?? 0), 100], `${label(f)}: stats`);
      assert.deepEqual([u.s.blockCnt, u.profile.attack, u.profile.dmgType, u.profile.canHitFly, u.profile.priority, u.profile.flyScale, u.base.bat],
        [1, 'ranged', 'phys', true, 'fly', mod === MAR_X ? 1.1 : 1, 1], `${label(f)}: 速射手`);
      assert.deepEqual(u.liveRangeGrid, form.rangeGrid, `${label(f)}: 3-3`);
      assert.deepEqual([u.def.bonds, u.def.raw.garrisonIds], [['emptyShip'], []], `${label(f)}: bonds / 特质`);
      assert.ok(!u.s.flags.liftoff && !u.s.flags.camou && !u.s.flags.stealth, `${label(f)}: ground enemies target her`);
      const rule = { [S1]: 'SP_FULL', [S2]: 'DEFAULT', [S3]: 'SKILL_RANGE' }[u.skill.id];
      assert.equal(u.skill.rule, rule, `${label(f)} ${u.skill.id}: trigger`);
      if (u.skill.id === S3) assert.deepEqual(u.skill.triggerGrid, [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]], `${label(f)}: S3 on her 4-1`);
      done(h);
    }
  }
  // the numbers of the forms (zh_CN, full potential: ATK +27, cost −2): E2 Lv1 1351 / 459 / 143, E2 Lv60 1575 / 527 / 160, cost 12
  assert.deepEqual([FORMS['2/1/4/0'].stats.maxHp, FORMS['2/1/4/0'].stats.atk, FORMS['2/60/7/1'].stats.atk, FORMS['2/60/7/3'].stats.cost], [1351, 459, 527, 12]);
  assert.deepEqual([modOf(5, MAR_Y).attr, modOf(6, MAR_Y).attr, modOf(5, MAR_X).attr, modOf(6, MAR_X).attr],
    [{ maxHp: 100, atk: 25 }, { maxHp: 200, atk: 40 }, { maxHp: 90, atk: 14, def: 12 }, { maxHp: 170, atk: 22, def: 19 }]);
  const data = { chess: CHESS, backups: BACKUPS };
  assert.ok(KITTED_CHARS.includes(ASH));
  for (const t of [5, 6]) assert.ok(diyPool(t, { data, kitted: KITTED_CHARS }).includes(ASH), `tier ${t}`);
  assert.deepEqual(validateDiyPicks({ [SLOT[6]]: { charId: ASH, skillIndex: 2, uniEquipId: MAR_X } }, { data, kitted: KITTED_CHARS }),
    { ok: true, picks: { [SLOT[6]]: { charId: ASH, skillIndex: 2, uniEquipId: MAR_X } } });
});

test('灰烬 T2 突击手: +20 SP at the battle-start deployment (free), the full cost from then on; no SP gift at a redeploy', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    const t1 = talOf(tier, elite, mod, 1), cost = formOf(tier, elite).stats.cost;
    assert.equal(t1.sp, 20, `${label(f)}: 20 SP at full potential`);
    assert.equal(t1.runtime_cost, tier === 6 && mod === MAR_Y ? -5 : -3, `${label(f)}: runtime_cost`);
    const { h, u } = field({ tier, elite, mod, skill: 1 });
    assert.ok(u.alive && u.deployed);
    approx(dp(h), h.b.flags.dpInit, `${label(f)}: nothing paid`);
    assert.equal(u.base.cost, cost, `${label(f)}: the full cost once deployed`);
    const gifts = () => h.hooksOf('spGain').filter((c) => c.unit === u && c.reason === 'talent');
    assert.deepEqual(gifts().map((c) => c.amount), [t1.sp], `${label(f)}: the SP gift`);
    approx(u.skill.sp, t1.sp + h.b.dt, `${label(f)}: SP`);
    h.b.kill(u);
    h.b.getPlayer('p1').dp = 40;
    assert.ok(h.b.redeploy(u, { free: false }));
    approx(dp(h), 40 - cost, `${label(f)}: a redeploy costs the full cost`);
    assert.equal(gifts().length, 1, `${label(f)}: no SP gift at a redeploy`);
    assert.equal(u.skill.sp, 0, `${label(f)}: SP from 0`);
    done(h);
  }
});

test('灰烬 T2: a first deployment that is paid costs cost + runtime_cost (−5 MAR-Y tier 6, −3 otherwise) and brings the SP gift; the next one the full cost', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    const t1 = talOf(tier, elite, mod, 1), cost = formOf(tier, elite).stats.cost;
    const { h, u } = field({ tier, elite, mod, skill: 0, setup: (b) => { b.allyUnits.find((x) => x.uid === 1).deferDeploy = true; } });
    assert.ok(!u.alive, `${label(f)}: held off the battle-start deployment`);
    assert.equal(u.base.cost, cost + t1.runtime_cost, `${label(f)}: discounted in the waiting area`);
    h.b.getPlayer('p1').dp = 40;
    assert.ok(h.b.redeploy(u, { free: false }));
    approx(dp(h), 40 - (cost + t1.runtime_cost), `${label(f)}: paid ${40 - dp(h)}`);
    assert.equal(u.base.cost, cost, `${label(f)}: full cost after her first deployment`);
    assert.equal(h.hooksOf('spGain').filter((c) => c.unit === u && c.reason === 'talent').length, 1, 'SP gift at it');
    h.b.kill(u);
    h.b.getPlayer('p1').dp = 40;
    assert.ok(h.b.redeploy(u, { free: false }));
    approx(dp(h), 40 - cost, `${label(f)}: the second deployment costs the full cost`);
    done(h);
  }
});

test('灰烬 T1 辅助装备: none at the battle start (no enemy yet) nor with none in her range; on a redeploy the flyer first, 晕眩 stun s on it and every enemy within 1 tile (中点判定)', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    const t0 = talOf(tier, elite, mod, 0);
    assert.equal(t0.stun, tier === 6 && mod === MAR_X ? 6 : 4, `${label(f)}: stun`);
    // fly at (10, 5); ground at 1.0 (10, 6) and at 1.41 (11, 6) from it; one at (9, 5) is 1.0 away too
    const { h, u } = field({ tier, elite, mod, skill: 0,
      enemies: [{ key: 'enemy_fly', pos: [10, 5], route: 2 }, { key: 'enemy_dummy', pos: [10, 6] }, { key: 'enemy_armor', pos: [11, 6] }, { key: 'enemy_dummy', pos: [9, 5] }] });
    h.run(1);
    assert.equal(stunsBy(h, u).length, 0, `${label(f)}: nothing at the battle start`);
    h.b.kill(u);
    assert.ok(h.b.redeploy(u));
    const st = stunsBy(h, u);
    assert.deepEqual(st.map((c) => `${c.target.defId}@${c.target.tileR},${c.target.tileC}`).sort(),
      ['enemy_dummy@10,6', 'enemy_dummy@9,5', 'enemy_fly@10,5'], `${label(f)}: the flyer and the two 1.0 away, not the one 1.41 away`);
    assert.ok(st.every((c) => Math.abs(c.duration - t0.stun) < 1e-9), `${label(f)}: ${t0.stun} s`);
    const fx = h.eventsOf('fx').filter((e) => e[1] === 'sunBurst');
    assert.equal(fx.length, 1);
    done(h);
  }
  assert.equal(FLASH_RADIUS, 1);
  // an enemy outside her range only: no flash
  const { h, u } = field({ tier: 6, elite: true, mod: MAR_X, enemies: [{ key: 'enemy_dummy', pos: [10, 8] }] });
  h.run(0.5);
  h.b.kill(u);
  assert.ok(h.b.redeploy(u));
  assert.equal(stunsBy(h, u).length, 0, 'no selectable enemy in range: no flash (PRTS 备注)');
  assert.equal(h.eventsOf('fx').filter((e) => e[1] === 'sunBurst').length, 0);
  done(h);
});

test('灰烬 T1 + MAR-X (tier 6): her physical damage to the flashed enemies ×damage_scale for scale_duration s — a stun-immune one marked too; tier 5 MAR-X: no mark', () => {
  const t0 = talOf(6, true, MAR_X, 0);
  assert.deepEqual([t0.stun, t0.scale_duration, t0.damage_scale], [6, 6, 1.1]);
  const { h, u } = field({ tier: 6, elite: true, mod: MAR_X, skill: 0, enemies: [{ key: 'enemy_nostun', pos: [10, 5] }, { key: 'enemy_dummy', pos: [10, 6] }] });
  h.run(3);
  const A = u.s.atk;
  const before = hitsBy(h, u, (c) => c.dmg.isAttack);
  assert.ok(before.length >= 2 && before.every((c) => Math.abs(c.amount - A) < 1e-6), 'unmarked: ATK');
  h.b.kill(u);
  assert.ok(h.b.redeploy(u));
  const t = h.b.time;
  assert.deepEqual(stunsBy(h, u).map((c) => c.target.defId), ['enemy_dummy'], 'the stun-immune one is not stunned');
  const ns = h.enemy('enemy_nostun');
  assert.ok(ns.findBuff(markKey(u)), 'but marked (the mark is no status)');
  h.run(t0.scale_duration - 0.5);
  const during = hitsBy(h, u, (c) => c.dmg.isAttack && c.t > t);
  assert.ok(during.length >= 3 && during.every((c) => Math.abs(c.amount - A * 1.1) < 1e-6), 'marked: ×1.1');
  h.run(1);
  const n = hitsBy(h, u).length;
  h.run(2);
  assert.ok(hitsBy(h, u).slice(n).every((c) => Math.abs(c.amount - A) < 1e-6), 'the mark lapses after scale_duration');
  done(h);
  // tier 5 MAR-X (stage 1): no talent change, no mark
  const g = field({ tier: 5, elite: true, mod: MAR_X, skill: 0, enemies: [{ key: 'enemy_dummy', pos: [10, 5] }] });
  g.h.run(1);
  g.h.b.kill(g.u);
  g.h.b.redeploy(g.u);
  assert.equal(g.h.enemy('enemy_dummy').findBuff(markKey(g.u)), null);
  assert.equal(stunsBy(g.h, g.u)[0].duration, 4);
  done(g.h);
});

test('灰烬 S1 支援射击 (AUTO, 持续时间无限): cast as soon as its SP is full — no enemy needed; ATK +atk, 2 hits per attack, until she leaves (every form)', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    const sk = skillOf(tier, elite, S1);
    assert.deepEqual([sk.skillType, sk.spCost, sk.bb.atk, sk.bb['attack@times']], ['AUTO', elite ? 49 : 52, elite ? 0.11 : 0.08, 2], label(f));
    const { h, u } = field({ tier, elite, mod, skill: 0 });
    const need = sk.spCost - u.skill.sp;
    h.run(need - 0.5);
    assert.equal(u.skill.activations, 0, `${label(f)}: not before its SP is full`);
    assert.ok(h.runUntil(() => u.skill.active, 1), `${label(f)}: cast at full SP, no enemy on the field`);
    assert.equal(u.skill.kind, 'toggle');
    approx(u.s.atk, u.base.atk * (1 + sk.bb.atk), `${label(f)}: ATK +${sk.bb.atk}`);
    h.spawn('enemy_dummy', { pos: [10, 5] });
    h.run(15);
    assert.ok(u.skill.active, 'still on');
    const per = new Map();
    for (const c of hitsBy(h, u, (x) => x.dmg.isAttack)) per.set(c.dmg.attackId, (per.get(c.dmg.attackId) ?? 0) + 1);
    assert.ok(per.size >= 10 && [...per.values()].every((n) => n === 2), `${label(f)}: 2 hits per attack (${[...per.values()]})`);
    h.b.kill(u);
    assert.ok(!u.skill.active && h.hooksOf('skillEnd').some((c) => c.unit === u && c.reason === 'death'), 'ends when she is knocked out');
    done(h);
  }
});

test('灰烬 S2 突击战术: the flashbang at the cast, 31 bullets, attack interval 1 − 0.8 s, ATK ×atk_scale (180 % / 210 %) before DEF against a 晕眩 enemy (every form)', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    const sk = skillOf(tier, elite, S2), sc = sk.bb['ash_s_2[atk_scale].atk_scale'], t0 = talOf(tier, elite, mod, 0);
    assert.deepEqual([sk.skillType, sk.durationType, sk.bb.base_attack_time, sc], ['MANUAL', 'AMMO', -0.8, elite ? 2.1 : 1.8], label(f));
    const { h, u } = field({ tier, elite, mod, skill: 1, enemies: [{ key: 'enemy_armor', pos: [10, 5] }] });
    const loaded = [];
    h.b.on('skillStart', (c) => { if (c.unit === u) loaded.push(c.skill.ammoLeft); });
    u.skill.gainSp(999);
    assert.ok(h.runUntil(() => u.skill.active, 3), `${label(f)}: cast with an enemy in range`);
    assert.deepEqual([loaded, u.skill.ammoMax], [[31], 31], '攻击装有31发子弹');
    approx(u.s.interval, 0.2 * 100 / u.s.aspd, `${label(f)}: interval (MAR-Y: its ASPD +8 with the ground enemy in range)`);
    const t = h.hooksOf('skillStart').find((c) => c.unit === u).t;
    const st = stunsBy(h, u);
    assert.ok(st.length === 1 && st[0].t === t && Math.abs(st[0].duration - t0.stun) < 1e-9, `${label(f)}: the flashbang at the cast`);
    assert.ok(h.runUntil(() => !u.skill.active, 20));
    const end = h.hooksOf('skillEnd').find((c) => c.unit === u);
    assert.equal(end.reason, 'ammo');
    assert.equal(h.hooksOf('attack').filter((c) => c.attacker === u && c.t >= t && c.t <= end.t).length, 31, 'ends with its 31st attack');
    const mark = t0.damage_scale ?? 1;
    const hits = hitsBy(h, u, (c) => c.dmg.isAttack && c.t > t && c.t < t + t0.stun - 0.05 && c.t <= end.t);
    assert.ok(hits.length >= 15, `${label(f)}: ${hits.length} hits on the stunned enemy`);
    for (const c of hits) approx(c.amount, phys(u.s.atk * sc, 300) * mark, `${label(f)}: ×${sc} before DEF, ×${mark} mark`);
    done(h);
  }
});

test('灰烬 S2: ×atk_scale only on 晕眩 (not 冻结 / 浮空, not an unstunned one) and only while it runs; the next cast holds 30 bullets (PRTS "变为30/31"), a redeployment 31 again', () => {
  const sc = skillOf(6, true, S2).bb['ash_s_2[atk_scale].atk_scale'];
  const { h, u } = field({ tier: 6, elite: true, skill: 1, enemies: [{ key: 'enemy_nostun', pos: [10, 5] }] });
  const loaded = [];
  const starts = [];
  h.b.on('skillStart', (c) => { if (c.unit === u) { loaded.push([c.skill.ammoLeft, c.skill.ammoMax]); starts.push(h.b.time); } });
  u.skill.gainSp(999);
  assert.ok(h.runUntil(() => u.skill.active, 3));
  const e = h.enemy('enemy_nostun'), A = u.s.atk;
  const window = (status, dur, opts = {}) => {
    const t = h.b.time;
    assert.ok(h.b.applyStatus(e, status, { duration: dur, ...opts }), status);
    h.run(dur + 0.3);
    return hitsBy(h, u, (c) => c.dmg.isAttack && c.t > t + 0.05 && c.t < t + dur - 0.05);
  };
  const plain = hitsBy(h, u, (c) => c.dmg.isAttack);
  assert.ok(plain.length >= 1 && plain.every((c) => Math.abs(c.amount - A) < 1e-6), 'the flash did not stun it: ×1');
  const frozen = window('freeze', 1);
  assert.ok(frozen.length >= 3 && frozen.every((c) => Math.abs(c.amount - A) < 1e-6), '冻结: ×1');
  const lev = window('levitate', 1);
  assert.ok(lev.length >= 3 && lev.every((c) => Math.abs(c.amount - A) < 1e-6), '浮空: ×1');
  const stun = window('stun', 1, { force: true });
  assert.ok(u.skill.active && stun.length >= 3 && stun.every((c) => Math.abs(c.amount - A * sc) < 1e-6), `晕眩: ×${sc}`);
  assert.ok(h.runUntil(() => !u.skill.active, 10));
  h.run(0.5); // the magazine's last bullets land (they keep the bonus: next test)
  const after = window('stun', 2, { force: true });
  assert.ok(after.length >= 1 && after.every((c) => Math.abs(c.amount - A) < 1e-6), 'after the skill: ×1 on a stunned enemy');
  // the second cast of the deployment: one bullet short after a magazine that ran dry
  u.skill.gainSp(999);
  assert.ok(h.runUntil(() => u.skill.active, 3));
  assert.deepEqual(loaded, [[31, 31], [30, 31]], 'the second cast: 30 of 31');
  assert.ok(h.runUntil(() => !u.skill.active, 10));
  assert.equal(h.hooksOf('attack').filter((c) => c.attacker === u && c.t >= starts[1] - 1e-9).length, 30, '30 attacks');
  u.skill.gainSp(999);
  assert.ok(h.runUntil(() => u.skill.active, 3));
  assert.deepEqual(loaded[2], [30, 31], 'again 30 (not 29)');
  h.b.kill(u);
  assert.ok(h.b.redeploy(u));
  u.skill.gainSp(999);
  assert.ok(h.runUntil(() => u.skill.active, 3));
  assert.deepEqual(loaded[3], [31, 31], 'a new deployment: 31');
  done(h);
});

test('灰烬 S2: every bullet of the magazine carries ×atk_scale — the ones still flying when the 31st shot ends the skill included (settled at the launch)', () => {
  for (const [tier, elite, col] of [[6, true, 6], [5, false, 6], [6, true, 4]]) {
    const sc = skillOf(tier, elite, S2).bb['ash_s_2[atk_scale].atk_scale'];
    const { h, u } = field({ tier, elite, skill: 1, enemies: [{ key: 'enemy_nostun', pos: [10, col] }] });
    const e = h.enemy('enemy_nostun');
    const ids = [];
    h.b.on('attack', (c) => { if (c.attacker === u && u.skill.active) ids.push(c.attackId); });
    u.skill.gainSp(999);
    assert.ok(h.runUntil(() => u.skill.active, 3));
    h.b.applyStatus(e, 'stun', { duration: 60, force: true });
    const A = u.s.atk;
    assert.ok(h.runUntil(() => !u.skill.active, 20));
    const end = h.hooksOf('skillEnd').find((c) => c.unit === u);
    assert.equal(end.reason, 'ammo');
    h.run(1);
    assert.equal(ids.length, 31, `T${tier}: 31 bullets`);
    const hits = hitsBy(h, u, (c) => c.dmg.isAttack && ids.includes(c.dmg.attackId));
    assert.equal(hits.length, 31, `T${tier}: every bullet landed`);
    assert.ok(hits.some((c) => c.t > end.t), `T${tier} at ${col - 3} tiles: a bullet lands after the skill ended`);
    for (const c of hits) approx(c.amount, A * sc, `T${tier} bullet ${ids.indexOf(c.dmg.attackId) + 1} at t=${c.t.toFixed(3)} (end ${end.t.toFixed(3)})`);
    // her next attack, launched after the skill: ×1 on the same stunned enemy
    h.run(2);
    const later = hitsBy(h, u, (c) => c.dmg.isAttack && !ids.includes(c.dmg.attackId));
    assert.ok(later.length >= 1 && later.every((c) => Math.abs(c.amount - A) < 1e-6), `T${tier}: ×1 after the skill`);
    done(h);
  }
});

test('灰烬 S3 攻坚榴弹 (every form): cast at once with an enemy on her 4-1; the grenade hits each enemy on its way (230 % / 260 %), bursts on the 4th tile ahead (330 % / 360 %) on the enemies standing there at the cast, then pushes them 中等 / 较大', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    const bb = skillOf(tier, elite, S3).bb;
    assert.deepEqual([bb.atk_scale, bb.force, bb.not_hitwall_scale, bb.hitwall_scale, bb.range_radius],
      elite ? [2.6, 2, 3.6, 7.2, 1.5] : [2.3, 1, 3.3, 6.6, 1.5], label(f));
    // weight 0 both: the one on the burst tile (10, 7) and one 2 tiles short of it (10, 5)
    const { h, u } = field({ tier, elite, mod, skill: 2, enemies: [{ key: 'enemy_armor', pos: [10, 7] }, { key: 'enemy_dummy', pos: [10, 5] }] });
    assert.ok(h.runUntil(() => u.skill.activations > 0, 8), `${label(f)}: SKILL_RANGE cast (SP ${u.skill.sp})`);
    const far = h.enemy('enemy_armor'), near5 = h.enemy('enemy_dummy'), A = u.s.atk;
    const path = hitsBy(h, u, tagged(PATH_TAG)), blast = hitsBy(h, u, tagged(BLAST_TAG));
    assert.deepEqual(path.map((c) => c.target), [near5, far], `${label(f)}: the path, in the order the grenade reaches them`);
    approx(path[1].amount, phys(A * bb.atk_scale, 300), `${label(f)}: path`);
    approx(path[0].amount, A * bb.atk_scale, `${label(f)}: path (no DEF)`);
    assert.deepEqual([path[0].dmg.type, path[0].dmg.isSkill, path[0].dmg.isAttack], ['phys', true, false]);
    assert.equal(h.eventsOf('fx').filter((x) => x[1] === 'explode').length, 1);
    // the burst at (10, 7) takes the enemy standing on it, not the one 2 tiles short that the push carries towards it
    assert.deepEqual(blast.map((c) => c.target), [far], `${label(f)}: burst victims where they stood at the cast`);
    approx(blast[0].amount, phys(A * bb.not_hitwall_scale, 300), `${label(f)}: burst`);
    approx(far.x, 7 + PUSH_TILES[bb.force], `${label(f)}: pushed ${PUSH_TILES[bb.force]} tiles (weight 0) after the burst`, 1e-3);
    approx(near5.x, 5 + PUSH_TILES[bb.force], `${label(f)}: pushed ${PUSH_TILES[bb.force]} tiles (weight 0)`, 1e-3);
    done(h);
  }
});

test('灰烬 S3: an enemy on the burst tile takes the burst whatever its weight and the push (the flight takes no time — every push comes after the burst)', () => {
  for (const [tier, elite] of [[5, false], [6, true]]) {
    const bb = skillOf(tier, elite, S3).bb;
    for (const mass of [0, 1, 2]) {
      const key = `enemy_m${mass}`;
      const { h, u } = field({ tier, elite, skill: 2, enemies: [{ key, pos: [10, 7] }] });
      assert.ok(h.runUntil(() => u.skill.activations > 0, 8), `T${tier} weight ${mass}: cast`);
      const e = h.enemy(key);
      assert.equal(hitsBy(h, u, tagged(PATH_TAG)).length, 1, `T${tier} weight ${mass}: path`);
      const blast = hitsBy(h, u, tagged(BLAST_TAG));
      assert.equal(blast.length, 1, `T${tier} weight ${mass}: burst although pushed to x=${e.x}`);
      approx(blast[0].amount, u.s.atk * bb.not_hitwall_scale, `T${tier} weight ${mass}: ×${bb.not_hitwall_scale}`);
      // (weight 2 at 中等 force moves 0.44; every other case carries it beyond the 1.5 radius before the burst could see it)
      assert.ok(e.x > 7 + (tier === 5 && mass === 2 ? 0.4 : 1.5), `T${tier} weight ${mass}: pushed after the burst (x=${e.x})`);
      done(h);
    }
  }
});

test('灰烬 S3: the burst lands on the centre of the 4th tile ahead; the path takes enemies within 1.2 of the flight (her row and the next ones), not behind her; MAR-X ×1.1 on flyers', () => {
  for (const mod of [null, MAR_X]) {
    const bb = skillOf(6, true, S3).bb;
    const { h, u } = field({ tier: 6, elite: true, mod, skill: 2,
      enemies: [{ key: 'enemy_heavy', pos: [10, 6] }, { key: 'enemy_heavy', pos: [9, 4] }, { key: 'enemy_heavy', pos: [11, 9] }, { key: 'enemy_heavy', pos: [10, 2] },
        { key: 'enemy_heavy', pos: [12, 5] }, { key: 'enemy_fly', pos: [9, 7], route: 2 }, { key: 'enemy_heavy', pos: [10, 9] }] });
    const start = new Map(h.b.enemies.map((e) => [e, `${e.defId}@${e.tileR},${e.tileC}`]));
    assert.ok(h.runUntil(() => u.skill.activations > 0, 8));
    const A = u.s.atk, fm = mod === MAR_X ? 1.1 : 1;
    const where = (c) => start.get(c.target);
    const path = hitsBy(h, u, tagged(PATH_TAG));
    // (10, 6), (9, 4), the flyer (9, 7) are within 1.2 of the segment (10, 3)–(10, 7); (11, 9): 2.24 from its end;
    // (10, 2): behind her; (12, 5): 2 rows away; (10, 9): 2 past the end
    assert.deepEqual(path.map(where).sort(), ['enemy_fly@9,7', 'enemy_heavy@10,6', 'enemy_heavy@9,4'], 'path victims');
    const fly = path.find((c) => c.target.defId === 'enemy_fly');
    approx(fly.amount, A * bb.atk_scale * fm, `flyer ×${fm}`);
    for (const c of path.filter((x) => x !== fly)) approx(c.amount, A * bb.atk_scale, 'ground ×1');
    const fx = h.eventsOf('fx').find((x) => x[1] === 'explode');
    assert.deepEqual([fx[2], fx[3]], [7, 10], 'burst on the 4th tile ahead');
    const blast = hitsBy(h, u, tagged(BLAST_TAG));
    assert.deepEqual(blast.map(where).sort(), ['enemy_fly@9,7', 'enemy_heavy@10,6'], 'burst: 中点判定 1.5 around (10, 7), (10, 9) 2.0 away is not');
    approx(blast.find((c) => c.target.defId === 'enemy_fly').amount, A * bb.not_hitwall_scale * fm, `burst flyer ×${fm}`);
    done(h);
  }
  assert.equal(PATH_RADIUS, 1.2);
});

test('灰烬 S3: from low ground into a 高台 it bursts at once on that tile edge for hitwall_scale; at the field\'s edge on that edge for not_hitwall_scale; facing left it flies left', () => {
  const rows = { 10: '##hrrrhrrrfrrrrrrrf##' }; // (10, 6) is high ground: the grenade from (10, 3) crashes on its edge x = 5.5
  for (const [tier, elite] of [[5, false], [6, true]]) {
    const bb = skillOf(tier, elite, S3).bb;
    const { h, u } = field({ tier, elite, skill: 2, flat: { rows }, enemies: [{ key: 'enemy_heavy', pos: [10, 4] }, { key: 'enemy_heavy', pos: [9, 5] }, { key: 'enemy_heavy', pos: [9, 7] }] });
    assert.ok(h.runUntil(() => u.skill.activations > 0, 8));
    const A = u.s.atk;
    const fx = h.eventsOf('fx').find((x) => x[1] === 'explode');
    assert.deepEqual([fx[2], fx[3]], [5.5, 10], `T${tier}: on the edge of the 高台`);
    const blast = hitsBy(h, u, tagged(BLAST_TAG));
    assert.deepEqual(blast.map((c) => `${c.target.tileR},${c.target.tileC}`).sort(), ['10,4', '9,5'], `T${tier}: 1.5 around (10, 5.5) — (9, 7) is 1.8 away`);
    for (const c of blast) approx(c.amount, A * bb.hitwall_scale, `T${tier}: ×${bb.hitwall_scale}`);
    done(h);
  }
  // facing left from (10, 8): the grenade flies towards −x, the push too; low ground all the way ⇒ the 4th tile (10, 4)
  const bb = skillOf(6, true, S3).bb;
  const { h, u } = field({ tier: 6, elite: true, skill: 2, col: 8, dir: 'LEFT', enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
  assert.equal(u.dir, 'LEFT');
  assert.ok(h.runUntil(() => u.skill.activations > 0, 8));
  const e = h.enemy('enemy_dummy');
  approx(e.x, 6 - PUSH_TILES[bb.force], 'pushed towards −x', 1e-3);
  const fx = h.eventsOf('fx').find((x) => x[1] === 'explode');
  assert.deepEqual([fx[2], fx[3]], [4, 10], 'burst 4 tiles to her left');
  done(h);
  // low ground up to the field's edge (col 0): from (10, 2) facing left the 3rd tile ahead is out of the rect ⇒ the edge x = −0.5
  const g = field({ tier: 6, elite: true, skill: 2, col: 2, dir: 'LEFT', flat: { rows: { 10: 'rrrrrrrrrrfrrrrrrrf##' } }, enemies: [{ key: 'enemy_dummy', pos: [10, 1] }] });
  assert.equal(g.h.b.rect.c0, 0);
  assert.ok(g.h.runUntil(() => g.u.skill.activations > 0, 8));
  const fx2 = g.h.eventsOf('fx').find((x) => x[1] === 'explode');
  assert.deepEqual([fx2[2], fx2[3]], [-0.5, 10], 'on the field edge');
  const b2 = hitsBy(g.h, g.u, tagged(BLAST_TAG));
  assert.equal(b2.length, 1);
  approx(b2[0].amount, g.u.s.atk * bb.not_hitwall_scale, 'not_hitwall_scale at the edge');
  done(g.h);
});

test('灰烬 S3: the 高台 rows around the field are 高台 too — facing DOWN from row 10 / UP from row 11 the grenade crashes on the edge of the field for hitwall_scale (flat stage and 战场#01); LOW ground beyond the rect stays the end of the field', () => {
  const bb = skillOf(6, true, S3).bb;
  const cases = [
    // [stage, row, col, dir, enemy, burst (x, y), crash]
    ['flat', 10, 4, 'DOWN', [9, 4], [4, 8.5], true],
    ['flat', 11, 4, 'UP', [12, 4], [4, 12.5], true],
    ['act1autochess_m01', 10, 4, 'DOWN', [9, 4], [4, 8.5], true],
    ['act1autochess_m01', 11, 4, 'UP', [12, 4], [4, 12.5], true],
    // (10, 10) tile_forbidden HIGH inside the rect of 战场#01: the same crash
    ['act1autochess_m01', 10, 8, 'RIGHT', [10, 9], [9.5, 10], true],
    // row 9 of the flat stage: (9, 11) is LOW road beyond the rect's right edge ⇒ the field's end, not a 高台
    ['flat', 9, 8, 'RIGHT', [9, 9], [10.5, 9], false],
  ];
  for (const [stageId, row, col, dir, pos, [bx, by], crash] of cases) {
    const lbl = `${stageId} (${row}, ${col}) ${dir}`;
    const g = makeBattle({
      defs: { enemies: ENEMIES }, timeLimit: 900, autoFinish: false, seed: 5, stageId, flags: { dpPerSec: 0, dpMax: 999 }, hooks: HOOKS, captureNoisy: true,
      enemies: [{ key: 'enemy_heavy', pos }],
      units: [{ uid: 1, diy: { slot: SLOT[6], charId: ASH, skillIndex: 2, uniEquipId: null }, elite: true, row, col, dir }],
    });
    g.step();
    const a = g.unit(1);
    assert.equal(a.dir, dir, lbl);
    assert.ok(g.runUntil(() => a.skill.activations > 0, 8), `${lbl}: cast`);
    const fx = g.eventsOf('fx').find((x) => x[1] === 'explode');
    assert.deepEqual([fx[2], fx[3]], [bx, by], `${lbl}: burst point`);
    const blast = hitsBy(g, a, tagged(BLAST_TAG));
    assert.equal(blast.length, 1, `${lbl}: the enemy next to it`);
    approx(blast[0].amount, a.s.atk * (crash ? bb.hitwall_scale : bb.not_hitwall_scale), `${lbl}: ×${crash ? bb.hitwall_scale : bb.not_hitwall_scale}`);
    done(g);
  }
});

test('灰烬 S3: SKILL_RANGE needs an enemy on her 4-1 (in range off the line: no cast); 2 casts per deployment, then no SP until she is deployed again', () => {
  const off = field({ tier: 6, elite: true, skill: 2, enemies: [{ key: 'enemy_heavy', pos: [9, 5] }] });
  off.h.run(10);
  assert.equal(off.u.skill.activations, 0, 'an enemy in her range but off the line: no cast');
  done(off.h);
  for (const [tier, elite] of [[5, false], [6, true]]) {
    const sk = skillOf(tier, elite, S3);
    const { h, u } = field({ tier, elite, skill: 2, enemies: [{ key: 'enemy_heavy', pos: [10, 5] }] });
    h.run(sk.spCost * 2 + 5);
    assert.equal(u.skill.activations, 2, `T${tier}: 每次部署只能释放2次`);
    h.run(sk.spCost * 2);
    assert.deepEqual([u.skill.activations, u.skill.sp], [2, 0], `T${tier}: no SP once spent`);
    h.b.kill(u);
    assert.ok(h.b.redeploy(u));
    h.run(sk.spCost + 1);
    assert.equal(u.skill.activations, 3, `T${tier}: the count restarts with the deployment`);
    done(h);
  }
});

test('灰烬 MAR-Y: ASPD +attack_speed exactly while a ground enemy stands in her range (both stages); no other loadout', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    const v = elite && mod === MAR_Y ? modOf(tier, MAR_Y).talentChanges.find((t) => t.talentIndex === -1).bb.attack_speed : 0;
    if (elite && mod === MAR_Y) assert.equal(v, 8);
    const { h, u } = field({ tier, elite, mod, skill: 2, enemies: [{ key: 'enemy_fly', pos: [10, 5], route: 2 }, { key: 'enemy_dummy', pos: [11, 9], time: 2 }] });
    h.run(1.5);
    assert.equal(u.s.aspd, 100, `${label(f)}: a flyer only`);
    h.run(1);
    assert.equal(u.s.aspd, 100, `${label(f)}: a ground enemy out of her range`);
    h.b.kill(h.enemy('enemy_dummy'));
    h.spawn('enemy_dummy', { pos: [11, 6] });
    h.step(2);
    assert.equal(u.s.aspd, 100 + v, `${label(f)}: ground enemy in range (+${v})`);
    for (const e of h.b.enemies) if (e.defId === 'enemy_dummy') h.b.kill(e);
    h.step(2);
    assert.equal(u.s.aspd, 100, `${label(f)}: gone with it`);
    done(h);
  }
});

test('灰烬: two copies keep their own marks and cast counts', () => {
  const t0 = talOf(6, true, MAR_X, 0);
  const { h, u: a } = field({ tier: 6, elite: true, mod: MAR_X, skill: 0, enemies: [{ key: 'enemy_dummy', pos: [10, 5] }],
    others: [{ uid: 2, diy: { slot: 'chess_char_6_diy2_a', charId: ASH, skillIndex: 0, uniEquipId: MAR_X }, elite: true, row: 11, col: 3 }] });
  const b = h.unit(2);
  h.run(1);
  h.b.kill(a);
  assert.ok(h.b.redeploy(a));
  const e = h.enemy('enemy_dummy');
  assert.ok(e.findBuff(markKey(a)) && !e.findBuff(markKey(b)), 'only the copy that threw it marks');
  const t = h.b.time;
  h.run(3);
  const [ha, hb] = [hitsBy(h, a, (c) => c.t > t && c.dmg.isAttack), hitsBy(h, b, (c) => c.t > t && c.dmg.isAttack)];
  assert.ok(ha.length >= 2 && ha.every((c) => Math.abs(c.amount - a.s.atk * t0.damage_scale) < 1e-6), 'copy A ×damage_scale');
  assert.ok(hb.length >= 2 && hb.every((c) => Math.abs(c.amount - b.s.atk) < 1e-6), 'copy B (the same MAR-X, its own mark only) unchanged');
  done(h);
});

test('灰烬: every form × skill survives a real wave and casts', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    for (const skill of [0, 1, 2]) {
      const h = makeBattle({ seed: 3, timeLimit: 90,
        units: [{ uid: 1, diy: { slot: SLOT[tier], charId: ASH, skillIndex: skill, uniEquipId: mod }, elite, row: 9, col: 4, carryState: { sp: 999 } }, { chessId: 'chess_char_2_06_a', row: 9, col: 6 }],
        enemies: [{ key: 'enemy_1007_slime', count: 8, interval: 1.5 }, { key: 'enemy_1007_slime', route: 1, count: 8, interval: 1.5, time: 3 }] });
      h.runToEnd(120);
      done(h);
      assert.ok(h.unit(1).skill.activations > 0, `${label(f)} skill ${skill} casts`);
    }
  }
});
