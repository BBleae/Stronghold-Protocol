// test/content/op_yato2.test.js — the 自选 operator kit of 麒麟R夜刀 (char_1029_yato2, 6★ 处决者, a collab pick of this fork:
// tools/build-data.mjs FORK_INCLUDE_COLLAB_PICKS; kit server/sim/content/kits/ops/op-yato2.js), fielded the production way
// (a DIY slot + its `diy` pick, simdata getDiy) in every form: tiers 5 / 6, normal (E2 Lv1, skill rank 4, no module) and
// elite (E2 Lv60, rank 7) with no module, EXE-X 训练用木桩 or EXE-Y 罗德岛制式双刀 at stage 1 (tier 5) / 3 (tier 6). Every
// number is read back from data/backups.json (the form of that slot status) — 乱舞's slash times from data/assets.json (the
// skeleton's Skill_2 OnAttack events); the fidelity checklist of kits/README.md item by item.
// Run: node --test test/content/op_yato2.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { KITTED_CHARS, OPERATOR_KITS, KITS } from '../../server/sim/content/kits/index.js';
import { S2_CLIP, S2_SLASHES, DASH_SPEED, DASH_RADIUS, TAG_KIRIN, TAG_DASH } from '../../server/sim/content/kits/ops/op-yato2.js';
import { diyPool, validateDiyPicks } from '../../shared/diy.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../../data/${f}.json`, import.meta.url), 'utf8'));
const CHESS = load('chess');
const BACKUPS = load('backups');
const ASSETS = load('assets');
const YATO2 = 'char_1029_yato2';
const FORMS = BACKUPS.units[YATO2].forms;
const SLOT = { 5: 'chess_char_5_diy1_a', 6: 'chess_char_6_diy1_a' };
const EX = 'uniequip_002_yato2', EY = 'uniequip_003_yato2';
const S1 = 'skchr_yato2_1', S2 = 'skchr_yato2_2', S3 = 'skchr_yato2_3';
const TEXAS = 'chess_char_1_08_a';
const FRAME = 1 / 30;
const formOf = (tier, elite) => FORMS[elite ? (tier === 5 ? '2/60/7/1' : '2/60/7/3') : '2/1/4/0'];
const skillOf = (tier, elite, id) => formOf(tier, elite).skills.find((s) => s.skillId === id);
const modOf = (tier, mod) => (mod ? formOf(tier, true).modules.find((m) => m.uniEquipId === mod) : null);
/** The talents a form fights with: the module's changes composed (index 0 / 1, −1 = hidden). */
const talentOf = (tier, elite, mod, i) => {
  const base = formOf(tier, elite).talents.find((t) => t.index === i)?.bb ?? {};
  const ch = (elite ? modOf(tier, mod)?.talentChanges ?? [] : []).find((t) => t.talentIndex === i)?.bb ?? {};
  return { ...base, ...ch };
};
const approx = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e9, speed: 0, mass: 0, ...o });
const ENEMIES = { enemy_dummy: dummy('enemy_dummy'), enemy_fly: dummy('enemy_fly', { motion: 'FLY' }) };
/** Every 自选 form: [tier, elite, module]. */
const FORMS_ALL = [[5, false, null], [6, false, null], ...[5, 6].flatMap((t) => [null, EX, EY].map((m) => [t, true, m]))];
const label = ([tier, elite, mod]) => `T${tier} ${elite ? 'elite' : 'normal'} ${mod ?? 'none'}`;
const isKirin = (c) => !!c.dmg?.tags?.includes(TAG_KIRIN);
const isDash = (c) => !!c.dmg?.tags?.includes(TAG_DASH);

/** A battle with 麒麟R夜刀 as uid 1 at (row, col) facing RIGHT, plus `others`. */
function field({ tier = 5, elite = false, mod = null, skill = 0, row = 10, col = 4, others = [], seed = 5 } = {}) {
  const h = makeBattle({
    defs: { enemies: ENEMIES }, timeLimit: 900, autoFinish: false, seed,
    flags: { dpPerSec: 0, dpMax: 999 }, hooks: ['damaged', 'skillStart', 'skillEnd', 'statusApplied', 'death', 'deploy'], captureNoisy: true,
    units: [{ uid: 1, diy: { slot: SLOT[tier], charId: YATO2, skillIndex: skill, uniEquipId: mod }, elite, row, col }, ...others],
  });
  h.step();
  return { h, u: h.unit(1) };
}
function done(h) {
  checkInvariants(h.b);
  assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
}
/** Knock `u` out and bring it straight back on its tile (free): its deploy-time skill starts again now. */
function redeployNow(h, u) {
  h.b.kill(u, null);
  assert.ok(h.b.redeploy(u, { free: true }), `${u.name} redeployed`);
}
/** Her damage from now on: { t, c } of every `damaged` she deals. */
function record(h, u) {
  const out = [];
  h.b.on('damaged', (c) => { if (c.source === u) out.push({ t: h.b.time, c, atk: u.s.atk }); });
  return out;
}

test('麒麟R夜刀 in every 自选 form: her operator kit (all three skills authored), the form\'s stats + module attributes, 1-1, melee ground-only, 16 s redeploy, cost 8, 协防, no 特质; each skill a timed deployment skill (被动 ON_DEPLOY), running from the deployment', () => {
  assert.equal(OPERATOR_KITS[YATO2], KITS[YATO2]);
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    for (const skill of [0, 1, 2]) {
      const { h, u } = field({ tier, elite, mod, skill });
      const form = formOf(tier, elite), m = elite ? modOf(tier, mod) : null, rec = form.skills[skill];
      assert.deepEqual([u.def.charId, u.def.diyFor, u.skill.id, !!u.kit.generic, u.kit.skillSource], [YATO2, SLOT[tier], rec.skillId, false, 'skills'], label(f));
      assert.deepEqual([u.base.maxHp, u.base.atk, u.base.def, u.base.respawnTime, u.base.cost, u.base.blockCnt, u.base.bat],
        [form.stats.maxHp + (m?.attr.maxHp ?? 0), form.stats.atk + (m?.attr.atk ?? 0), form.stats.def + (m?.attr.def ?? 0), 16, 8, 1, 0.93], `${label(f)}: stats`);
      assert.deepEqual([u.profile.attack, u.profile.dmgType, u.profile.canHitFly], ['melee', 'phys', false], `${label(f)}: 处决者`);
      assert.deepEqual(u.liveRangeGrid, form.rangeGrid, `${label(f)}: 1-1`);
      assert.deepEqual([u.def.bonds, u.def.raw.garrisonIds], [['emptyShip'], []], `${label(f)}: bonds / 特质`);
      assert.deepEqual([rec.skillType, rec.spType, u.skill.kind, u.skill.rule, u.skill.active, u.skill.activations], ['PASSIVE', 'ON_DEPLOY', 'duration', 'NEVER', true, 1], `${label(f)}: S${skill + 1} from the deployment`);
      if (skill === 0) approx(u.skill.timeLeft, rec.duration - FRAME, `${label(f)}: S1 duration`);
      if (skill === 1) approx(u.skill.timeLeft, S2_CLIP - FRAME, `${label(f)}: S2 = its clip`);
      if (skill === 2) assert.equal(!!u.s.flags.invulnerable, true, `${label(f)}: S3 无敌 while it dashes`);
      done(h);
    }
  }
  // the numbers (zh_CN, full potential): E2 Lv1 1270 / 462 / 267, E2 Lv60 1508 / 545 / 301; EXE-X +96 / +36 / +20 →
  // +123 / +48 / +28, EXE-Y +135 / +23 → +200 / +50 HP / ATK
  assert.deepEqual([FORMS['2/1/4/0'].stats.maxHp, FORMS['2/1/4/0'].stats.atk, FORMS['2/60/7/1'].stats.maxHp, FORMS['2/60/7/1'].stats.atk], [1270, 462, 1508, 545]);
  assert.deepEqual([modOf(5, EX).attr, modOf(6, EX).attr, modOf(5, EY).attr, modOf(6, EY).attr],
    [{ maxHp: 96, atk: 36, def: 20 }, { maxHp: 123, atk: 48, def: 28 }, { maxHp: 135, atk: 23 }, { maxHp: 200, atk: 50 }]);
});

test('a 自选 pick: 麒麟R夜刀 is offered at tiers 5 and 6 (she has a kit) and a roster with her passes validateDiyPicks', () => {
  const data = { chess: CHESS, backups: BACKUPS };
  assert.ok(KITTED_CHARS.includes(YATO2));
  assert.ok(BACKUPS.diy.ownedPool.includes(YATO2));
  for (const t of [5, 6]) assert.ok(diyPool(t, { data, kitted: KITTED_CHARS }).includes(YATO2), `tier ${t}`);
  assert.deepEqual(validateDiyPicks({ [SLOT[6]]: { charId: YATO2, skillIndex: 2, uniEquipId: EY } }, { data, kitted: KITTED_CHARS }),
    { ok: true, picks: { [SLOT[6]]: { charId: YATO2, skillIndex: 2, uniEquipId: EY } } });
});

test('S1 鬼人化 (被动, 20 s from each deployment): ASPD +45 / +70; attacks are double hits; per target every third attack is the six-hit — 4 hits, then 2 in the next attack, which counts for no target; single hits once it is over', () => {
  for (const [tier, elite, mod] of [[5, false, null], [6, true, EX]]) {
    const sk = skillOf(tier, elite, S1);
    assert.deepEqual([sk.duration, sk.bb.attack_speed], [20, elite ? 70 : 45]);
    assert.match(sk.desc, /二连击/);
    assert.match(sk.desc, /第三次攻击变为六连击/);
    const { h, u } = field({ tier, elite, mod, skill: 0 });
    assert.equal(u.s.aspd, 100 + sk.bb.attack_speed, 'ASPD');
    const a = h.spawn('enemy_dummy', { pos: [10, 5] });
    const out = record(h, u);
    h.run(8);
    const attacks = new Map();
    for (const { t, c } of out) if (c.dmg.isAttack) { const x = attacks.get(c.dmg.attackId) ?? { t, n: 0 }; x.n++; attacks.set(c.dmg.attackId, x); }
    const seq = [...attacks.values()];
    assert.deepEqual(seq.slice(0, 8).map((x) => x.n), [2, 2, 4, 2, 2, 2, 4, 2], 'one target: 2, 2, 4 + 2, …');
    // one attack interval apart (bat 0.93 at ASPD 100 + attack_speed; the attack loop runs on whole frames), the 2-hit tail too
    for (let i = 1; i < 8; i++) assert.ok(Math.abs(seq[i].t - seq[i - 1].t - u.s.interval) <= FRAME + 1e-9, `attack ${i + 1}: one interval later`);
    assert.ok(out.filter(({ c }) => c.dmg.isAttack).every(({ c }) => c.target === a && c.type === 'phys' && !c.dmg.isSkill), 'normal physical attacks');
    // over after 20 s: single hits
    h.run(12.1);
    assert.equal(u.skill.active, false);
    const n0 = out.length;
    h.run(3);
    const after = new Map();
    for (const { c } of out.slice(n0)) if (c.dmg.isAttack) after.set(c.dmg.attackId, (after.get(c.dmg.attackId) ?? 0) + 1);
    assert.ok(after.size >= 3 && [...after.values()].every((n) => n === 1), 'single hits after');
    done(h);
  }
  // per target: her attacks alternate A, B (a hook before hers picks); A's third is her 5th attack, its tail the 6th (on
  // B, uncounted), B's third her 8th
  {
    const { h, u } = field({ tier: 5, skill: 0 });
    const a = h.spawn('enemy_dummy', { pos: [10, 5] }), b = h.spawn('enemy_dummy', { pos: [10, 5] });
    let k = 0;
    h.b.on('beforeAttack', (c) => { if (c.attacker === u) c.targets = [k++ % 2 === 0 ? a : b]; });
    const out = record(h, u);
    h.run(7);
    const attacks = new Map();
    for (const { c } of out) if (c.dmg.isAttack) attacks.set(c.dmg.attackId, (attacks.get(c.dmg.attackId) ?? 0) + 1);
    assert.deepEqual([...attacks.values()].slice(0, 9), [2, 2, 2, 2, 4, 2, 2, 4, 2], 'counted per target');
    done(h);
  }
  // a redeployment starts it again (and the count)
  {
    const { h, u } = field({ tier: 5, skill: 0 });
    h.run(21);
    assert.equal(u.skill.active, false);
    redeployNow(h, u);
    assert.deepEqual([u.skill.active, u.skill.activations], [true, 2], 'again at a redeployment');
    done(h);
  }
});

test('S2 乱舞 (被动, the 3.433 s Skill_2 clip from each deployment): 16 slashes at its OnAttack events, each at 116 % / 130 % ATK on every ground enemy of her 1-1 and the one she blocks; T1 ×talent_scale; no normal attacks; taunt +1; 晕眩 / 冻结 / 沉睡 immune — all until it ends', () => {
  // the clip and its events, as the asset tools read them off the skeleton
  const spine = ASSETS.chars[YATO2].spine.front;
  assert.equal(spine.animations.Skill_2, S2_CLIP);
  assert.deepEqual(spine.hits.Skill_2, [...S2_SLASHES]);
  assert.equal(spine.anims.skills['1'].loop, 'Skill_2');
  for (const [tier, elite, mod] of [[5, false, null], [6, true, EY]]) {
    const sk = skillOf(tier, elite, S2), t0 = talentOf(tier, elite, mod, 0), hidden = talentOf(tier, elite, mod, -1);
    /** 术法充盈 (EXE-Y stage 3) on her i-th arts instance of this deployment. */
    const arcane = (i) => 1 + (hidden.damage_up ?? 0) * Math.min(i, hidden.max_stack_cnt ?? 0);
    assert.deepEqual([sk.duration, sk.bb.atk_scale, sk.bb.talent_scale, sk.bb.talent_scale_display, sk.bb.taunt_level], [-1, elite ? 1.3 : 1.16, elite ? 2.73 : 2.088, elite ? 2.1 : 1.8, 1]);
    assert.match(sk.desc, /16次斩击/);
    approx(sk.bb.talent_scale, sk.bb.talent_scale_display * sk.bb.atk_scale, 'talent_scale = the text\'s × the 攻击倍率 (PRTS 备注)');
    const { h, u } = field({ tier, elite, mod, skill: 1 });
    const front = h.spawn('enemy_dummy', { pos: [10, 5] }), own = h.spawn('enemy_dummy', { pos: [10, 4] });
    const fly = h.spawn('enemy_fly', { pos: [10, 5] }), far = h.spawn('enemy_dummy', { pos: [10, 6] }), side = h.spawn('enemy_dummy', { pos: [11, 5] });
    h.step();
    redeployNow(h, u);
    const T = h.b.time;
    const out = record(h, u);
    h.run(1);
    assert.equal(u.s.taunt, sk.bb.taunt_level, 'taunt +1');
    for (const st of ['stun', 'freeze', 'sleep']) assert.equal(h.b.applyStatus(u, st, { duration: 2, source: front }), false, `${st} immune`);
    h.run(2.5);
    assert.equal(u.skill.active, false, 'over after the clip');
    // the slashes are the skill's attacks (isSkill); her normal attacks come back only once the clip is over
    const inWindow = out.filter(({ c }) => c.dmg.isAttack && c.dmg.isSkill);
    const last = T + S2_SLASHES[S2_SLASHES.length - 1] + FRAME;
    assert.ok(inWindow.every(({ t }) => t < last), 'slashes within the clip');
    assert.ok(out.filter(({ c }) => c.dmg.isAttack && !c.dmg.isSkill).every(({ t }) => t >= T + S2_CLIP - FRAME - 1e-9), 'no normal attack during the clip');
    const times = [...new Set(inWindow.map(({ t }) => +t.toFixed(6)))];
    assert.deepEqual(times, S2_SLASHES.map((s) => +(T + Math.round(s * 30) * FRAME).toFixed(6)), '16 slashes on the clip\'s frames');
    for (const x of times) {
      const at = inWindow.filter(({ t }) => +t.toFixed(6) === x);
      assert.deepEqual(at.map(({ c }) => c.target).sort((p, q) => p.id - q.id), [front, own].sort((p, q) => p.id - q.id), 'her 1-1 (front tile, her own) — no flyer, nothing 2 tiles ahead or beside');
      for (const { c, atk } of at) {
        approx(c.amount, atk * sk.bb.atk_scale, `${sk.bb.atk_scale * 100} % ATK`);
        assert.deepEqual([c.type, c.dmg.isSkill], ['phys', true]);
      }
    }
    const bolts = out.filter(({ c, t }) => isKirin(c) && t < last);
    assert.equal(bolts.length, 32, 'T1 after each slash on each enemy');
    bolts.forEach(({ c, atk }, i) => approx(c.amount, atk * t0['attack@atk_scale_1'] * sk.bb.talent_scale * arcane(i), `T1 ×${sk.bb.talent_scale} (bolt ${i + 1})`));
    assert.ok(!out.some(({ c }) => [fly, far, side].includes(c.target)), 'untouched');
    // after: normal single attacks, T1 ×1, taunt back, no immunity
    const after = new Map();
    for (const { c } of out) if (c.dmg.isAttack && !c.dmg.isSkill) after.set(c.dmg.attackId, (after.get(c.dmg.attackId) ?? 0) + 1);
    assert.ok(after.size >= 1 && [...after.values()].every((n) => n === 1), 'single-hit attacks again');
    const bolt = out.find(({ c, t }) => t >= last && isKirin(c));
    approx(bolt.c.amount, bolt.atk * t0['attack@atk_scale_1'] * arcane(out.filter(({ c }) => isKirin(c)).indexOf(bolt)), 'T1 ×1 after');
    assert.equal(u.s.taunt, 0, 'taunt back');
    assert.equal(h.b.applyStatus(u, 'stun', { duration: 1, source: front }), true, 'stun lands after');
    done(h);
  }
});

test('S3 空中回旋乱舞 (被动, at each deployment): a dash from her tile forward at 8 tiles/s; each frame a 230 % / 260 % ATK physical slash on every enemy within 0.51 (air too); every landed hit +0.3 tile from 2 up to 5, never past the field; T1 ×atk_scale; 无敌, no attacks, hard-control immune and 1/1000 statuses while it runs', () => {
  for (const [tier, elite, mod] of [[5, false, null], [6, true, EX]]) {
    const sk = skillOf(tier, elite, S3), t0 = talentOf(tier, elite, mod, 0);
    assert.deepEqual([sk.duration, sk.bb.atk_scale, sk.bb.min_dist, sk.bb.max_dist, sk.bb.dist_unit, sk.bb.dist_interval], [-1, elite ? 2.6 : 2.3, 2, 5, 0.3, 0.2]);
    assert.match(sk.desc, /可以攻击空中单位/);
    assert.deepEqual([DASH_SPEED, DASH_RADIUS], [8, 0.51]);
    const step = DASH_SPEED * FRAME;   // 0.267 tile a frame
    // (a) nothing in front: 2 tiles — frames at 0, 0.267 … 1.867, 2 ⇒ the 9th frame ends it
    {
      const { h, u } = field({ tier, elite, mod, skill: 2 });
      assert.ok(h.runUntil(() => !u.skill.active, 1));
      approx(h.b.time, (Math.ceil(2 / step) + 1) * FRAME, '2 tiles', 1e-9);
      done(h);
    }
    // (b) one ground enemy 2 tiles ahead: within 0.51 at 1.6, 1.867, 2.133, 2.4 ⇒ 4 hits ⇒ the dash runs to 3.2; one 3 tiles
    // ahead is then hit as well (2.667 … 3.467 ⇒ 4 more: 4.4 — one 5 tiles ahead stays 0.6 beyond); one a row aside never;
    // the dash's talent bolts ×atk_scale; 无敌 and status rules while it runs
    {
      const { h, u } = field({ tier, elite, mod, skill: 2 });
      const a = h.spawn('enemy_dummy', { pos: [10, 6] }), b = h.spawn('enemy_dummy', { pos: [10, 7] });
      const side = h.spawn('enemy_dummy', { pos: [11, 5] }), far = h.spawn('enemy_dummy', { pos: [10, 9] });
      h.step();
      redeployNow(h, u);
      const T = h.b.time;
      const out = record(h, u);
      assert.equal(u.s.flags.invulnerable, true, '无敌');
      assert.equal(h.b.dealDamage(a, u, { amount: 500, type: 'true', canDodge: false }), 0, 'takes no damage');
      assert.equal(h.b.applyStatus(u, 'stun', { duration: 2, source: a }), false, 'stun immune');
      assert.equal(h.b.applyStatus(u, 'bind', { duration: 2, source: a }), true);
      approx(h.hooksOf('statusApplied').filter((c) => c.target === u && c.status === 'bind').slice(-1)[0].duration, 0.002, 'bind ×1/1000');
      assert.ok(h.runUntil(() => !u.skill.active, 2));
      const slashOn = (e) => out.filter(({ c }) => c.target === e && isDash(c));
      assert.deepEqual([slashOn(a).length, slashOn(b).length, slashOn(side).length, slashOn(far).length], [4, 4, 0, 0], 'hits a / b / aside / far');
      const reach = sk.bb.min_dist + sk.bb.dist_unit * 8;   // 4.4
      approx(h.b.time - T, (Math.ceil(reach / step - 1e-9) + 1) * FRAME, 'the dash ran to 4.4', 1e-9);
      for (const { c, atk } of out.filter(({ c }) => isDash(c))) {
        approx(c.amount, atk * sk.bb.atk_scale, `${sk.bb.atk_scale * 100} % ATK`);
        assert.deepEqual([c.type, c.dmg.isSkill, c.dmg.isAttack], ['phys', true, false]);
      }
      const bolts = out.filter(({ c }) => isKirin(c));
      assert.equal(bolts.length, 8, 'a T1 bolt per landed slash');
      for (const { c, atk } of bolts) approx(c.amount, atk * t0['attack@atk_scale_1'] * sk.bb.atk_scale, `T1 ×${sk.bb.atk_scale}`);
      assert.ok(!out.some(({ c }) => c.dmg.isAttack), 'no normal attack while it runs');
      // over: hurt again, no immunity, attacks again
      assert.equal(!!u.s.flags.invulnerable, false);
      assert.ok(h.b.dealDamage(a, u, { amount: 50, type: 'true', canDodge: false }) > 0, 'takes damage after');
      done(h);
    }
    // (c) air units: a flyer over the tile ahead is slashed (0.533 … 1.333 ⇒ 4 hits, the dash runs to 3.2); her normal attack
    // stays ground-only (the flyer is never attacked once the dash is over)
    {
      const { h, u } = field({ tier, elite, mod, skill: 2 });
      const fly = h.spawn('enemy_fly', { pos: [10, 5] });
      h.step();
      redeployNow(h, u);
      const T = h.b.time;
      const out = record(h, u);
      assert.ok(h.runUntil(() => !u.skill.active, 2));
      assert.equal(out.filter(({ c }) => c.target === fly && isDash(c)).length, 4, 'the flyer is slashed');
      approx(h.b.time - T, (Math.ceil((sk.bb.min_dist + 4 * sk.bb.dist_unit) / step - 1e-9) + 1) * FRAME, 'the dash ran to 3.2', 1e-9);
      h.run(3);
      assert.ok(!out.some(({ c }) => c.dmg.isAttack), 'no normal attack on the flyer');
      done(h);
    }
    // (d) the enemy 3 tiles ahead alone: out of the 2-tile dash's reach (1 tile past its end > 0.51)
    {
      const { h, u } = field({ tier, elite, mod, skill: 2 });
      const b = h.spawn('enemy_dummy', { pos: [10, 7] });
      h.step();
      redeployNow(h, u);
      const out = record(h, u);
      assert.ok(h.runUntil(() => !u.skill.active, 2));
      assert.equal(out.filter(({ c }) => c.target === b && isDash(c)).length, 0, 'not reached');
      done(h);
    }
    // (e) the 5-tile cap: a crowd ahead pushes it to 5, never further (the enemy 6 tiles ahead is never hit)
    {
      const { h, u } = field({ tier, elite, mod, skill: 2 });
      const crowd = [5, 6, 7, 8, 9].map((c) => h.spawn('enemy_dummy', { pos: [10, c] }));
      const six = h.spawn('enemy_dummy', { pos: [10, 10] });
      h.step();
      redeployNow(h, u);
      const T = h.b.time;
      const out = record(h, u);
      assert.ok(h.runUntil(() => !u.skill.active, 2));
      assert.ok(crowd.every((e) => out.some(({ c }) => c.target === e && isDash(c))), 'the crowd is hit');
      assert.equal(out.filter(({ c }) => c.target === six && isDash(c)).length, 0, '6 tiles ahead: past max_dist');
      approx(h.b.time - T, (Math.ceil(sk.bb.max_dist / step - 1e-9) + 1) * FRAME, 'the dash ran to 5', 1e-9);
      done(h);
    }
    // (f) the field's edge: from column 9 facing right only 1 tile is left (the rect's last column 10)
    {
      const { h, u } = field({ tier, elite, mod, skill: 2, col: 9 });
      assert.equal(h.b.rect.c1, 10);
      const e = h.spawn('enemy_dummy', { pos: [10, 10] });
      h.step();
      redeployNow(h, u);
      const T = h.b.time;
      const out = record(h, u);
      assert.ok(h.runUntil(() => !u.skill.active, 2));
      // frames at 0, 0.267, 0.533, 0.8, 1 — within 0.51 of the enemy at 0.533, 0.8, 1: 3 hits, the dash stays at 1
      assert.equal(out.filter(({ c }) => c.target === e && isDash(c)).length, 3, 'hits up to the edge');
      approx(h.b.time - T, (Math.ceil(1 / step - 1e-9) + 1) * FRAME, 'stopped at the edge', 1e-9);
      done(h);
    }
  }
});

test('T1 双雷剑麒麟: every landed hit of hers adds 20 % ATK arts (EXE-Y stage 3: 25 %), no 受击回复, not dodged on its own; EXE-Y stage 3 术法充盈: +5 % arts damage per arts instance dealt, up to 50 % after 10, lost when she leaves the field', () => {
  for (const f of [[5, false, null], [5, true, EY], [6, true, EY]]) {
    const [tier, elite, mod] = f;
    const t0 = talentOf(tier, elite, mod, 0), hidden = talentOf(tier, elite, mod, -1);
    const y3 = tier === 6 && mod === EY;
    assert.deepEqual([t0['attack@atk_scale_1'], hidden.damage_up ?? 0, hidden.max_stack_cnt ?? 0], y3 ? [0.25, 0.05, 10] : [0.2, 0, 0], label(f));
    const { h, u } = field({ tier, elite, mod, skill: 0 });
    h.spawn('enemy_dummy', { pos: [10, 5] });
    const out = record(h, u);
    h.run(10);
    const hits = out.filter(({ c }) => c.dmg.isAttack), bolts = out.filter(({ c }) => isKirin(c));
    assert.ok(hits.length >= 20, `${label(f)}: ${hits.length} hits`);
    assert.equal(bolts.length, hits.length, `${label(f)}: one bolt per hit`);
    bolts.forEach(({ c, atk }, i) => {
      assert.deepEqual([c.type, c.dmg.noSp, c.dmg.canDodge, c.dmg.isAttack, c.dmg.isSkill], ['arts', true, false, false, false], `${label(f)}: arts, no 受击回复`);
      approx(c.amount, atk * t0['attack@atk_scale_1'] * (y3 ? 1 + 0.05 * Math.min(i, 10) : 1), `${label(f)}: bolt ${i + 1}`);
    });
    if (y3) {
      // she leaves the field and comes back: 术法充盈 starts over
      h.b.players[0].dp = 99;
      redeployNow(h, u);
      const n0 = out.length;
      h.run(3);
      const again = out.slice(n0).filter(({ c }) => isKirin(c));
      approx(again[0].c.amount, again[0].atk * 0.25, `${label(f)}: 术法充盈 gone`);
    }
    done(h);
  }
  // a dodged hit brings no bolt
  {
    const { h, u } = field({ tier: 5, skill: 0 });
    const e = h.spawn('enemy_dummy', { pos: [10, 5] });
    h.b.addBuff(e, { key: 'test:dodge', mods: { dodgePhys: 1 } });
    const out = record(h, u);
    h.run(4);
    assert.equal(out.length, 0, 'every hit dodged: no damage, no bolt');
    done(h);
  }
});

test('T2 鬼人强化状态: ATK +16 % while her skill runs and 10 s after it (EXE-X stage 3: +18 %, and +5 % more while it runs only)', () => {
  for (const f of [[5, false, null], [5, true, EX], [6, true, EX]]) {
    const [tier, elite, mod] = f;
    const t1 = talentOf(tier, elite, mod, 1);
    const x3 = tier === 6 && mod === EX;
    assert.deepEqual([t1.atk, t1.duration, t1['yato2_e_002[atk].atk'] ?? 0], x3 ? [0.18, 10, 0.05] : [0.16, 10, 0], label(f));
    const { h, u } = field({ tier, elite, mod, skill: 0 });
    approx(u.s.atk, u.base.atk * (1 + t1.atk + (x3 ? 0.05 : 0)), `${label(f)}: while S1 runs`);
    h.run(20);
    assert.equal(u.skill.active, false);
    approx(u.s.atk, u.base.atk * (1 + t1.atk), `${label(f)}: after it`);
    h.run(9.8);
    approx(u.s.atk, u.base.atk * (1 + t1.atk), `${label(f)}: still 10 s after`);
    h.run(0.3);
    approx(u.s.atk, u.base.atk, `${label(f)}: gone`);
    done(h);
  }
  // S2's short window: 3.433 + 10 s
  {
    const { h, u } = field({ tier: 5, skill: 1 });
    h.run(13.2);
    approx(u.s.atk, u.base.atk * 1.16, 'S2 + 10 s');
    h.run(0.4);
    approx(u.s.atk, u.base.atk, 'gone');
    done(h);
  }
});

test('EXE-X 训练用木桩: the refund has no effect (no retreat in battle); EXE-Y 罗德岛制式双刀: ATK +10 % while no allied operator stands on the 4 tiles beside her (stages 1 and 3); EXE-Y stage 3: her first leave of the field redeploys with no timer', () => {
  {
    const { h, u } = field({ tier: 6, elite: true, mod: EX, skill: 1 });
    assert.deepEqual(u.def.traitBb, { withdraw_cost_recover_ratio: 0.8 });
    h.b.players[0].dp = 3;
    h.b.retreat(u);
    h.step();
    assert.equal(h.b.players[0].dp, 3, 'no refund');
    done(h);
  }
  for (const f of [[5, true, EY], [6, true, EY], [6, true, EX]]) {
    const [tier, elite, mod] = f;
    const { h, u } = field({ tier, elite, mod, skill: 1, others: [{ uid: 2, chessId: TEXAS, row: 12, col: 7 }] });
    const texas = h.unit(2);
    assert.equal(!!u.findBuff('trait:yato2:lonely'), mod === EY, `${label(f)}: alone`);
    h.run(14);   // S2 and T2 over
    if (mod === EY) approx(u.s.atk, u.base.atk * 1.1, `${label(f)}: ATK +10 %`);
    assert.ok(h.b.relocate(texas, 11, 5));
    h.step();
    assert.equal(!!u.findBuff('trait:yato2:lonely'), mod === EY, `${label(f)}: a diagonal neighbour does not count`);
    assert.ok(h.b.relocate(texas, 10, 5));
    h.step();
    assert.equal(u.findBuff('trait:yato2:lonely'), null, `${label(f)}: an operator beside her`);
    approx(u.s.atk, u.base.atk, `${label(f)}: no bonus`);
    done(h);
  }
  // 首次撤退再部署时间为0 (stage 3 only): the first knock-out comes back at once (DP paid), the second after 16 s
  for (const f of [[6, true, EY], [5, true, EY]]) {
    const [tier, elite, mod] = f;
    const y3 = tier === 6;
    assert.equal(talentOf(tier, elite, mod, -1).respawn_time, y3 ? 0 : undefined, label(f));
    const { h, u } = field({ tier, elite, mod, skill: 0 });
    h.b.players[0].dp = 50;
    h.b.kill(u, null);
    approx(u.respawnAt - u.deathAt, y3 ? 0 : 16, `${label(f)}: first leave`);
    h.step();
    assert.equal(u.alive, y3, `${label(f)}: back at once`);
    assert.equal(h.b.players[0].dp, y3 ? 42 : 50, `${label(f)}: the cost is paid`);
    if (y3) {
      assert.deepEqual([u.skill.active, u.skill.activations], [true, 2], 'S1 runs again');
      h.b.kill(u, null);
      approx(u.respawnAt - u.deathAt, 16, 'the second leave: 16 s');
    }
    done(h);
  }
});
