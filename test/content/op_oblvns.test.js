// test/content/op_oblvns.test.js — the 自选 operator kit of 丰川祥子 (char_4182_oblvns, 6★ 领主, a collab pick of this fork:
// tools/build-data.mjs FORK_INCLUDE_COLLAB_PICKS, the fork owner's decision of 2026-10-08; kit
// server/sim/content/kits/ops/op-oblvns.js), fielded the production way (a DIY slot + its `diy` pick, simdata getDiy) in every
// form: tiers 5 / 6, normal (E2 Lv1, skill rank 4, no module) and elite (E2 Lv60, rank 7) with no module or LOR-Y “无言的约定”
// at stage 1 (tier 5) / 3 (tier 6). Every number is read back from data/backups.json (the form of that slot status); the
// fidelity checklist of kits/README.md item by item.
// Run: node --test test/content/op_oblvns.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBattle, enemyRec, flatStage, checkInvariants } from '../helpers/battleHarness.js';
import { KITTED_CHARS, OPERATOR_KITS, KITS } from '../../server/sim/content/kits/index.js';
import { diyPool, validateDiyPicks } from '../../shared/diy.js';
import { oblvnsField, notesOf, NOTE, NOTE_FX, FEVER_MAX, FEVER_DURATION, PIANO_KEY, ASPD_KEY, LORY_KEY, SAVE_KEY } from '../../server/sim/content/kits/ops/op-oblvns.js';
import { COLS } from '../../server/sim/constants.js';
import { FX_KINDS } from '../../public/js/render/fx/kinds.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../../data/${f}.json`, import.meta.url), 'utf8'));
const CHESS = load('chess');
const BACKUPS = load('backups');
const OBL = 'char_4182_oblvns';
const FORMS = BACKUPS.units[OBL].forms;
const SLOT = { 5: 'chess_char_5_diy1_a', 6: 'chess_char_6_diy1_a' };
const SLOT2 = { 5: 'chess_char_5_diy2_a', 6: 'chess_char_6_diy2_a' };
const LORY = 'uniequip_002_oblvns';
const S1 = 'skchr_oblvns_1', S2 = 'skchr_oblvns_2', S3 = 'skchr_oblvns_3';
const formOf = (tier, elite) => FORMS[elite ? (tier === 5 ? '2/60/7/1' : '2/60/7/3') : '2/1/4/0'];
const skillOf = (tier, elite, id) => formOf(tier, elite).skills.find((s) => s.skillId === id);
const modOf = (tier, mod) => (mod ? formOf(tier, true).modules.find((m) => m.uniEquipId === mod) : null);
/** Talent `i`'s blackboard of a form with its module (the module's talent change merged over the base). */
const talentOf = (tier, elite, mod, i) => {
  const base = formOf(tier, elite).talents.find((t) => t.index === i).bb;
  const ch = elite && mod ? modOf(tier, mod).talentChanges.find((t) => t.talentIndex === i) : null;
  return { ...base, ...(ch?.bb ?? {}) };
};
/** LOR-Y stage 2+ "技能期间远程攻击不再降低攻击力" (the hidden talent part) — tier 6 elite with the module. */
const noCut = (tier, elite, mod) => !!(elite && mod && modOf(tier, mod).talentChanges.some((t) => t.talentIndex === -1));
const approx = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e9, speed: 0, mass: 0, ...o });
const ENEMIES = {
  enemy_dummy: dummy('enemy_dummy'),
  enemy_fly: dummy('enemy_fly', { motion: 'FLY' }),
  enemy_armor: dummy('enemy_armor', { def: 800 }),
  enemy_ward: dummy('enemy_ward', { res: 60 }),
  enemy_def: dummy('enemy_def', { def: 1000 }),
};
const FORMS_ALL = [[5, false, null], [6, false, null], [5, true, null], [5, true, LORY], [6, true, null], [6, true, LORY]];
const label = ([tier, elite, mod]) => `T${tier} ${elite ? 'elite' : 'normal'} ${mod ?? 'none'}`;

/** A battle with 丰川祥子 as uid 1 at (row, col) facing `dir` (RIGHT). `enemies` spawn before her first attack. */
function field({ tier = 5, elite = false, mod = null, skill = 2, row = 10, col = 5, dir = undefined, seed = 5, others = [], enemies = [], stage, setup } = {}) {
  const h = makeBattle({
    defs: { enemies: ENEMIES }, timeLimit: 900, autoFinish: false, seed, stage, setup, enemies,
    flags: { dpPerSec: 0, dpMax: 999 }, hooks: ['damaged', 'hit', 'skillStart', 'skillEnd', 'attack', 'death'], captureNoisy: true,
    units: [{ uid: 1, diy: { slot: SLOT[tier], charId: OBL, skillIndex: skill, uniEquipId: mod }, elite, row, col, ...(dir ? { dir } : {}) }, ...others],
  });
  h.step();
  return { h, u: h.unit(1) };
}
const from = (h, u, pred = () => true) => h.hooksOf('damaged').filter((c) => c.source === u && pred(c));
const tagged = (c, t) => (c.dmg?.tags || []).includes(t);
const notes = (h, u, pred = () => true) => oblvnsField(h.b).notes.filter((n) => n.owner === u && pred(n));
function done(h) {
  checkInvariants(h.b);
  assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
}

test('丰川祥子 in every 自选 form: her operator kit (all three skills authored), the form\'s stats + module attributes, 3-12, blocks 2, a 领主 hitting air, physical, no summons, the 协防 bond', () => {
  assert.equal(OPERATOR_KITS[OBL], KITS[OBL]);
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    for (const skill of [0, 1, 2]) {
      const { h, u } = field({ tier, elite, mod, skill });
      const form = formOf(tier, elite), m = elite ? modOf(tier, mod) : null;
      assert.deepEqual([u.def.charId, u.def.diyFor, u.skill.id, !!u.kit.generic, u.kit.skillSource], [OBL, SLOT[tier], form.skills[skill].skillId, false, 'skills'], label(f));
      assert.deepEqual([u.base.maxHp, u.base.atk, u.base.def, u.base.res, u.base.aspd], [form.stats.maxHp + (m?.attr.maxHp ?? 0), form.stats.atk + (m?.attr.atk ?? 0), form.stats.def, form.stats.res, 100 + (m?.attr.aspd ?? 0)], `${label(f)}: stats`);
      assert.deepEqual([u.s.blockCnt, u.profile.sub, u.profile.attack, u.profile.canHitFly, u.profile.dmgType, u.base.bat], [2, 'lord', 'ranged', true, 'phys', 1.3], `${label(f)}: 领主`);
      assert.deepEqual(u.liveRangeGrid, form.rangeGrid, `${label(f)}: 3-12`);
      assert.deepEqual([form.tokens, form.displayTokens, u.def.raw.tokens], [[], [], []], `${label(f)}: no summons`);
      assert.deepEqual([u.def.bonds, u.def.raw.garrisonIds], [['emptyShip'], []], `${label(f)}: bonds / 特质`);
      done(h);
    }
  }
  // the numbers of the forms (zh_CN): E2 Lv1 1624 / 613 / 352 / 10, E2 Lv60 1910 / 704 / 400 / 10; LOR-Y +180 / +38 / +5 → +300 / +63 / +7
  assert.deepEqual([FORMS['2/1/4/0'].stats.maxHp, FORMS['2/1/4/0'].stats.atk, FORMS['2/60/7/1'].stats.maxHp, FORMS['2/60/7/1'].stats.atk], [1624, 613, 1910, 704]);
  assert.deepEqual([modOf(5, LORY).attr, modOf(6, LORY).attr], [{ maxHp: 180, atk: 38, aspd: 5 }, { maxHp: 300, atk: 63, aspd: 7 }]);
});

test('a 自选 pick: 丰川祥子 is offered at tiers 5 and 6 (she has a kit) and a roster with her passes validateDiyPicks', () => {
  const data = { chess: CHESS, backups: BACKUPS };
  assert.ok(KITTED_CHARS.includes(OBL));
  for (const t of [5, 6]) assert.ok(diyPool(t, { data, kitted: KITTED_CHARS }).includes(OBL), `tier ${t}`);
  assert.deepEqual(validateDiyPicks({ [SLOT[6]]: { charId: OBL, skillIndex: 2, uniEquipId: LORY } }, { data, kitted: KITTED_CHARS }),
    { ok: true, picks: { [SLOT[6]]: { charId: OBL, skillIndex: 2, uniEquipId: LORY } } });
});

test('T1 颂乐音符 notes + trait 领主: each attack launches one note that flies (it lands later, physical, ATK × 0.8 unblocked); the engine\'s own shot lands nothing; air units are hit', () => {
  for (const [tier, elite, mod] of [[5, false, null], [6, true, LORY]]) {
    const { h, u } = field({ tier, elite, mod, skill: 2, enemies: [{ key: 'enemy_dummy', pos: [10, 7] }] });
    u.skill.sp = 0; // keep S3 off
    h.runUntil(() => h.hooksOf('attack').some((c) => c.attacker === u), 3);
    const a0 = h.hooksOf('attack').find((c) => c.attacker === u);
    assert.equal(notesOf(h.b, u), 1, `T${tier}: one note per attack`);
    const n0 = notes(h, u)[0];
    assert.deepEqual([n0.P, n0.type, n0.state, n0.target === a0.targets[0]], [NOTE.aimed, 'phys', 'free', true], `T${tier}: a talent note aimed at the target`);
    h.runUntil(() => from(h, u).length > 0, 5);
    const d0 = from(h, u)[0];
    assert.ok(d0.t - a0.t >= 0.4, `T${tier}: the note lands after its flight (${(d0.t - a0.t).toFixed(2)} s)`);
    assert.ok(tagged(d0, 'oblvns:note') && tagged(d0, 'oblvns:talent') && d0.dmg.isAttack && !d0.dmg.isSkill, `T${tier}: a note's damage`);
    approx(d0.amount, u.s.atk * 0.8, `T${tier}: ATK × 0.8 (no DEF)`);
    h.run(6);
    assert.ok(from(h, u).every((c) => tagged(c, 'oblvns:note')), `T${tier}: every damage instance is a note's`);
    // the client: her attack draws no shot (the notes are not there yet) and each note shows where it strikes
    const shots = h.eventsOf('atk').filter((e) => e[1] === u.id);
    assert.ok(shots.length && shots.every((e) => e[3] === 'none'), `T${tier}: no engine shot drawn`);
    const struck = h.eventsOf('fx').filter((e) => e[1] === NOTE_FX && e[4]?.src === u.id);
    assert.equal(struck.length, from(h, u).length, `T${tier}: one fx per note strike`);
    assert.ok(FX_KINDS[NOTE_FX], 'the client knows the fx');
    // a flyer
    h.b.kill(h.enemy('enemy_dummy'), null);
    const fly = h.spawn('enemy_fly', { pos: [11, 6] });
    assert.ok(h.runUntil(() => from(h, u, (c) => c.target === fly).length > 0, 6), `T${tier}: a flyer`);
    done(h);
  }
});

test('trait 领主 per note: a note launched while she blocks is a melee note (100 % ATK) — also on another enemy once the blocked one is gone', () => {
  for (const [tier, elite, mod] of [[5, false, null], [5, true, LORY]]) {
    const { h, u } = field({ tier, elite, mod, skill: 2, enemies: [{ key: 'enemy_dummy', pos: [10, 5] }] });
    u.skill.sp = 0;
    const e = h.enemy('enemy_dummy');
    assert.ok(h.runUntil(() => e.blockedBy === u, 1), `T${tier}: she blocks it`);
    h.runUntil(() => from(h, u, (c) => c.target === e).length >= 2, 8);
    for (const c of from(h, u, (c) => c.target === e)) approx(c.amount, u.s.atk, `T${tier}: blocked ⇒ 100 %`);
    // an attack while blocking, then the blocked enemy dies: its note finds the enemy ahead and still deals 100 %
    const b = h.spawn('enemy_dummy', { pos: [10, 7] });
    const n0 = h.hooksOf('attack').filter((c) => c.attacker === u).length;
    h.runUntil(() => h.hooksOf('attack').filter((c) => c.attacker === u).length > n0, 3);
    h.b.kill(e, null);
    const last = Math.max(...notes(h, u).map((n) => n.attackId));
    const mine = notes(h, u, (n) => n.attackId === last);
    assert.equal(mine.length, 1, `T${tier}: the note of that attack`);
    assert.equal(mine[0].target, e, `T${tier}: launched at the blocked enemy`);
    h.runUntil(() => from(h, u, (c) => c.target === b && c.dmg.attackId === mine[0].attackId).length > 0, 4);
    approx(from(h, u, (c) => c.target === b && c.dmg.attackId === mine[0].attackId)[0].amount, u.s.atk, `T${tier}: still 100 % on another enemy`);
    // unblocked from then on: 80 %
    h.runUntil(() => from(h, u, (c) => c.target === b && c.dmg.attackId > mine[0].attackId).length > 0, 4);
    approx(from(h, u, (c) => c.target === b && c.dmg.attackId > mine[0].attackId)[0].amount, u.s.atk * 0.8, `T${tier}: unblocked ⇒ 80 %`);
    done(h);
  }
});

test('T1 notes when she leaves the field: the free ones vanish at once; a tracking one still lands (hers — no gauge, no penetration)', () => {
  const { h, u } = field({ tier: 6, elite: true, skill: 2, enemies: [{ key: 'enemy_armor', pos: [10, 8] }] });
  u.skill.sp = 0;
  h.runUntil(() => notes(h, u, (n) => n.state === 'track').length > 0 && notes(h, u, (n) => n.state === 'free').length > 0, 6);
  const tracking = notes(h, u, (n) => n.state === 'track');
  const F = oblvnsField(h.b).fever;
  const v0 = F.value;
  h.b.kill(u, null);
  h.step();
  assert.ok(notes(h, u).every((n) => n.state === 'track'), 'only the tracking notes are left');
  h.runUntil(() => notes(h, u).length === 0, 4);
  const late = from(h, u, (c) => tracking.some((n) => n.attackId === c.dmg.attackId));
  assert.ok(late.length >= 1, 'a tracking note landed after she left');
  const hit = h.hooksOf('hit').filter((c) => c.source === u && c.t > u.deathAt);
  assert.ok(hit.length >= 1 && hit.every((c) => c.dmg.defIgnorePct === 0), 'no penetration while she is away');
  assert.equal(F.value, v0, 'no Fever while she is away');
  done(h);
});

test('T1 持续攻击: with nothing in range she attacks on (attack SP), the notes drift forward and vanish 1 s after leaving her range; none — no attack — when the tile ahead is impassable', () => {
  const { h, u } = field({ tier: 5, skill: 2 });
  const sp0 = u.skill.sp, n0 = u.stats.attacks;
  h.run(6);
  assert.ok(u.stats.attacks - n0 >= 5, `she attacks with no target (${u.stats.attacks - n0})`);
  assert.equal(u.skill.sp - sp0, u.stats.attacks - n0, 'attack SP for each');
  assert.equal(h.hooksOf('attack').filter((c) => c.attacker === u).length, 0, 'no `attack` event: nothing attacked');
  const live = notes(h, u);
  assert.ok(live.length >= 1 && live.length <= 4, `a few notes in flight (${live.length})`);
  for (const n of live) assert.ok(n.state === 'free' && n.P === NOTE.free && n.x > u.x, 'drifting forward');
  // her range ends 3.5 tiles ahead: at 1.3 tiles/s a note leaves it within ~2.7 s and is gone `delay` (1) s later
  const maxAge = 3.5 / NOTE.free.freeSpeed + 1 + 0.1;
  assert.ok(live.every((n) => n.age < maxAge), `none older than its range + 1 s (${Math.max(...live.map((n) => n.age)).toFixed(2)} s)`);
  done(h);
  // the tile ahead impassable (NONE): inside the rect (an X tile) — and off the rect (facing UP from the top row)
  const X = flatStage({ rows: { 10: '##hrrrrrXrfrrrrrrrf##' } });
  for (const o of [{ stage: X, row: 10, col: 7 }, { row: 12, col: 5, dir: 'UP' }]) {
    const t = field({ tier: 5, skill: 2, ...o });
    t.h.run(5);
    assert.deepEqual([t.u.stats.attacks, notesOf(t.h.b, t.u)], [0, 0], `no attack facing an impassable tile (${o.dir ?? 'X'})`);
    done(t.h);
  }
});

test('T1 持续攻击 is seen: each attack with no target sends the client an \'atk\' event with no target (her swing and its sound)', () => {
  const { h, u } = field({ tier: 5, skill: 2 });
  const n0 = u.stats.attacks, e0 = h.eventsOf('atk').length;
  h.run(6);
  const mine = h.eventsOf('atk').slice(e0).filter((e) => e[1] === u.id);
  assert.ok(u.stats.attacks - n0 >= 5);
  assert.equal(mine.length, u.stats.attacks - n0, 'one per attack');
  assert.ok(mine.every((e) => e[2] == null && e[3] === 'none'), 'no target, no shot');
  done(h);
});

test('T1 notes choose their target at every update, before their minimum free time (PRTS "不存在追踪目标时：选择…最近的可选目标…随后若…已经过最短自由移动时间：切换至【追踪移动】"): a target-less S1 fan locks an enemy it passes within 1.0 at 0.2 s and tracks it from 0.6 s', () => {
  const { h, u } = field({ tier: 5, skill: 0 });
  // no enemy: her 持续攻击 fills both charges, the auto-release makes the next one a target-less fan
  assert.ok(h.runUntil(() => notes(h, u, (n) => n.P === NOTE.s1).length > 0, 40), 'a fan with no target');
  const fan = notes(h, u, (n) => n.P === NOTE.s1);
  assert.ok(fan.every((n) => n.target == null && n.age < 0.05));
  // an enemy 0.6 behind her: within 1.0 of the notes at their 0.2 s update (≈0.93), beyond it by 0.6 s (≈1.6)
  const e = h.spawn('enemy_dummy', { pos: [u.tileR, u.tileC - 1] });
  e.x = u.x - 0.6;
  e.y = u.y;
  h.run(0.25);
  assert.ok(fan.every((n) => n.target === e && n.state === 'free'), 'locked at the 0.2 s update, still free');
  h.run(3);
  const s1 = from(h, u, (c) => c.target === e && tagged(c, 'oblvns:s1'));
  assert.equal(s1.length, fan.length, `every fan note tracked it from 0.6 s and struck (${s1.length} of ${fan.length})`);
  done(h);
});

test('T1 penetration: every damage instance of hers ignores n × 3 % DEF / 2 % RES (n = her notes existing, the hitting one included, ≤ 10); LOR-Y stage 3: 5 % / 2.5 %, ≤ 12', () => {
  for (const [tier, elite, mod] of [[5, false, null], [6, true, LORY]]) {
    const t0 = talentOf(tier, elite, mod, 0);
    assert.deepEqual([t0.def_penetrate_ratio, t0.magic_resist_penetrate_ratio, t0.max_cnt], mod ? [0.05, 0.025, 12] : [0.03, 0.02, 10], `T${tier}: data`);
    const seen = [];
    const { h, u } = field({
      tier, elite, mod, skill: 1, enemies: [{ key: 'enemy_armor', pos: [10, 8] }],
      setup: (b) => b.on('hit', (c) => { if (c.source && c.source.def?.charId === OBL) seen.push({ n: notesOf(b, c.source), def: c.dmg.defIgnorePct, res: c.dmg.resIgnorePct }); }, { priority: -500 }),
    });
    // ASPD +400: many notes in flight at once (the cap binds)
    h.b.addBuff(u, { key: 'test:aspd', mods: { aspd: 400 } });
    h.run(12);
    assert.ok(seen.length >= 10, `T${tier}: hits (${seen.length})`);
    for (const s of seen) {
      const n = Math.min(s.n, t0.max_cnt);
      approx(s.def, n * t0.def_penetrate_ratio, `T${tier}: DEF ignored with ${s.n} notes`);
      approx(s.res, n * t0.magic_resist_penetrate_ratio, `T${tier}: RES ignored with ${s.n} notes`);
    }
    assert.ok(seen.some((s) => s.n > t0.max_cnt), `T${tier}: the cap binds (max ${Math.max(...seen.map((s) => s.n))} notes)`);
    done(h);
  }
});

test('T2 毋畏遗忘 Fever gauge: +3 for each damage instance of hers, up to 450; a full gauge alone starts nothing', () => {
  for (const [tier, elite] of [[5, false], [6, true]]) {
    const t1 = talentOf(tier, elite, null, 1);
    assert.deepEqual([t1.cnt, t1.attack_speed, t1.enable], [3, 16, 1], `T${tier}: data`);
    const { h, u } = field({ tier, elite, skill: 2, enemies: [{ key: 'enemy_dummy', pos: [10, 7] }] });
    u.skill.sp = 0;
    h.run(10);
    const hits = h.hooksOf('hit').filter((c) => c.source === u).length;
    assert.ok(hits >= 5, `T${tier}: hits`);
    assert.equal(oblvnsField(h.b).fever.value, Math.min(FEVER_MAX, hits * t1.cnt), `T${tier}: +3 per instance`);
    oblvnsField(h.b).fever.value = FEVER_MAX - 1;
    h.run(4);
    assert.equal(oblvnsField(h.b).fever.value, FEVER_MAX, `T${tier}: capped at 450`);
    assert.equal(oblvnsField(h.b).fever.active, false, `T${tier}: a full gauge alone starts nothing`);
    done(h);
  }
});

test('Fever with S1: full, the next 技能策略 cast starts it — 20 s, gauge emptied and not filling; every attack is a free fan (charges untouched); the full-charge auto-release starts none', () => {
  for (const [tier, elite] of [[5, false], [6, true]]) {
    const { h, u } = field({ tier, elite, skill: 0, enemies: [{ key: 'enemy_dummy', pos: [10, 7] }] });
    const F = oblvnsField(h.b).fever;
    F.value = FEVER_MAX;
    assert.ok(h.runUntil(() => F.active, 8), `T${tier}: Fever`);
    const t0 = h.b.time;
    approx(F.until, t0 + FEVER_DURATION, `T${tier}: 20 s`, 0.002);
    assert.equal(h.hooksOf('skillStart').filter((c) => c.unit === u)[0].reason, 'DEFAULT', `T${tier}: started by the 技能策略 cast`);
    const ch = u.skill.charges, sp = u.skill.sp, atk0 = u.stats.attacks;
    h.run(10);
    const fans = h.hooksOf('skillStart').filter((c) => c.unit === u && c.reason === 'oblvnsFever' && c.t > t0);
    assert.ok(fans.length >= 7 && Math.abs(fans.length - (u.stats.attacks - atk0)) <= 1, `T${tier}: a fan every attack (${fans.length} / ${u.stats.attacks - atk0})`);
    assert.deepEqual([u.skill.charges, u.skill.sp, F.value], [ch, sp, 0], `T${tier}: free, no SP, no gauge`);
    if (elite) { // no S3 running: a lethal blow during the Fever knocks her out
      h.b.dealDamage(h.enemy('enemy_dummy'), u, { amount: 1e9, type: 'true' });
      assert.ok(!u.alive && u.removeReason === 'killed', `T${tier}: no 不撤退 without S3`);
      h.b.redeploy(u);
    }
    h.runUntil(() => !F.active, 12);
    approx(h.b.time, t0 + FEVER_DURATION, `T${tier}: ends after 20 s`, 0.01);
    assert.ok(!u.skill.pending, `T${tier}: no Fever cast left behind`);
    h.run(3);
    assert.ok(F.value > 0, `T${tier}: the gauge fills again`);
    done(h);
  }
  // no enemy: the charges fill up and release by themselves — no Fever even on a full gauge
  const { h, u } = field({ tier: 5, skill: 0 });
  oblvnsField(h.b).fever.value = FEVER_MAX;
  assert.ok(h.runUntil(() => h.hooksOf('skillStart').some((c) => c.unit === u), 15), 'auto-release');
  const s = h.hooksOf('skillStart').find((c) => c.unit === u);
  assert.equal(s.reason, 'oblvnsAutoRelease');
  h.run(1.5);
  assert.equal(notes(h, u, (n) => n.P === NOTE.s1).length, 8, 'its fan flies free');
  assert.equal(oblvnsField(h.b).fever.active, false, 'no Fever');
  done(h);
});

test('S1 新月的苏醒 (MANUAL, attack SP, 2 charges, data DEFAULT): the cast attack plays 8 arts notes in a ±13.125° fan, left to right 65 % … 4 % (80 % … 4 %) × ATK, × 0.8 unblocked (stage 3: not in a skill)', () => {
  for (const [tier, elite, mod] of [[5, false, null], [5, true, LORY], [6, true, LORY]]) {
    const sk = skillOf(tier, elite, S1);
    const { h, u } = field({ tier, elite, mod, skill: 0, enemies: [{ key: 'enemy_dummy', pos: [10, 7] }] });
    assert.deepEqual([u.skill.rule, u.skill.kind, u.skill.maxCharges, u.skill.spCost, u.skill.spType, sk.initSp], ['DEFAULT', 'charges', 2, 4, 'attack', 0], `T${tier}`);
    const scales = [sk.bb.atk_scale, ...[2, 3, 4, 5, 6, 7, 8].map((i) => sk.bb[`atk_scale_${i}`])];
    assert.deepEqual(scales, elite ? [0.8, 0.73, 0.6, 0.47, 0.33, 0.27, 0.13, 0.04] : [0.65, 0.6, 0.49, 0.38, 0.27, 0.22, 0.11, 0.04], `T${tier}: data`);
    let fan = null;
    h.b.on('attack', (c) => { if (c.attacker === u && c.isSkill) fan = notes(h, u, (n) => n.P === NOTE.s1).map((n) => ({ ...n })); }, { priority: -2000 });
    assert.ok(h.runUntil(() => fan, 10), `T${tier}: cast`);
    assert.equal(fan.length, 8);
    const deg = fan.map((n) => Math.round(Math.atan2(n.dy, n.dx) * 180 / Math.PI * 1000) / 1000);
    assert.deepEqual(deg, [13.125, 9.375, 5.625, 1.875, -1.875, -5.625, -9.375, -13.125], `T${tier}: the fan, left to right`);
    const lord = noCut(tier, elite, mod) ? 1 : 0.8;
    fan.forEach((n, i) => approx(n.amount, u.s.atk * scales[i] * lord, `T${tier}: note ${i + 1}`));
    assert.ok(fan.every((n) => n.type === 'arts' && n.isSkill && n.target === h.enemy('enemy_dummy')), `T${tier}: arts, tracking the target`);
    assert.ok(h.runUntil(() => from(h, u, (c) => tagged(c, 'oblvns:s1')).length === 8, 3), `T${tier}: all 8 land`);
    for (const c of from(h, u, (c) => tagged(c, 'oblvns:s1'))) assert.equal(c.type, 'arts');
    done(h);
  }
});

test('S2 满月的舞会 (MANUAL, attack SP, data DEFAULT, 切换类): 钢琴 from deployment — ATK +60 % / +75 %, phys notes passing through (the enemy behind is hit too, each once) — then one switch per deployment to 风琴: ASPD +80 / +110, arts notes; a redeploy starts on 钢琴 again', () => {
  for (const [tier, elite, mod] of [[5, false, null], [6, true, LORY]]) {
    const sk = skillOf(tier, elite, S2);
    const { h, u } = field({ tier, elite, mod, skill: 1, enemies: [{ key: 'enemy_dummy', pos: [10, 7] }, { key: 'enemy_dummy', pos: [10, 8] }] });
    assert.deepEqual([u.skill.rule, u.skill.kind, u.skill.spCost, sk.bb['attack@atk'], sk.bb['attack@attack_speed'], sk.bb['attack@passby_delay']],
      ['DEFAULT', 'toggle', 5, elite ? 0.75 : 0.6, elite ? 110 : 80, 0.5], `T${tier}: data`);
    const aspd0 = u.s.aspd;
    approx(u.s.atk, u.base.atk * (1 + sk.bb['attack@atk']), `T${tier}: 钢琴 ATK`);
    const [a, b] = h.b.enemies;
    h.runUntil(() => from(h, u, (c) => tagged(c, 'oblvns:piano') && c.target === b).length > 0, 4);
    const piano = from(h, u, (c) => tagged(c, 'oblvns:piano'));
    assert.ok(piano.some((c) => c.target === a) && piano.some((c) => c.target === b), `T${tier}: the note passes through to the enemy behind`);
    assert.ok(piano.every((c) => c.type === 'phys'), `T${tier}: physical`);
    // with S2 the stage-3 module counts her as in a skill: no 80 % (PRTS 备注); else × 0.8 (DEF 0)
    for (const c of piano) approx(c.amount, u.s.atk * (noCut(tier, elite, mod) ? 1 : 0.8), `T${tier}: 钢琴 amount`);
    const byNote = new Map();
    for (const c of piano) { const k = `${c.dmg.attackId}:${c.target.id}`; byNote.set(k, (byNote.get(k) ?? 0) + 1); }
    assert.ok([...byNote.values()].every((v) => v === 1), `T${tier}: each enemy once per note`);
    assert.ok(h.runUntil(() => u.skill.active, 8), `T${tier}: the switch`);
    assert.equal(u.findBuff(PIANO_KEY), null, `T${tier}: 钢琴 off`);
    approx(u.s.atk, u.base.atk, `T${tier}: ATK back`);
    assert.equal(u.s.aspd, aspd0 + sk.bb['attack@attack_speed'], `T${tier}: 风琴 ASPD`);
    const t1 = h.b.time;
    h.run(20);
    assert.equal(u.skill.activations, 1, `T${tier}: switched once per deployment`);
    const organ = from(h, u, (c) => c.t > t1 + 3);
    assert.ok(organ.length > 5 && organ.every((c) => tagged(c, 'oblvns:organ') && c.type === 'arts'), `T${tier}: 风琴 notes, arts`);
    // knocked out and redeployed: 钢琴 again
    h.b.kill(u, null);
    h.b.redeploy(u);
    assert.ok(u.alive && !u.skill.active && u.findBuff(PIANO_KEY), `T${tier}: 钢琴 again`);
    done(h);
  }
});

test('Fever with S2: a cast on a full gauge only starts it (PRTS 备注 "可以触发Fever时，触发技能将仅触发Fever，不进行技能形态切换"): she stays on 钢琴 and plays its 二连击; no Fever cast of the 切换类 skill, no switch meanwhile; the switch to 风琴 comes with a later cast', () => {
  const sk2 = skillOf(6, true, S2);
  const { h, u } = field({ tier: 6, elite: true, mod: LORY, skill: 1, enemies: [{ key: 'enemy_dummy', pos: [10, 7] }] });
  const F = oblvnsField(h.b).fever;
  F.value = FEVER_MAX;
  const aspd0 = u.s.aspd;
  assert.ok(h.runUntil(() => F.active, 8), 'the cast starts the Fever');
  const casts = () => h.hooksOf('skillStart').filter((c) => c.unit === u);
  assert.equal(casts().length, 1);
  assert.ok(!u.skill.active, 'no switch: the cast ended at once');
  assert.equal(h.hooksOf('skillEnd').filter((c) => c.unit === u).at(-1)?.reason, 'fever');
  assert.ok(u.findBuff(PIANO_KEY), '钢琴 stays');
  approx(u.s.atk, u.base.atk * (1 + sk2.bb['attack@atk']), '钢琴 ATK');
  assert.equal(u.s.aspd, aspd0, 'no 风琴 ASPD');
  // every attack meanwhile plays two 钢琴 notes (physical) on its target
  for (let k = 0; k < 3; k++) {
    const n0 = u.stats.attacks;
    h.runUntil(() => u.stats.attacks > n0, 2);
    const last = Math.max(...notes(h, u).map((n) => n.attackId));
    assert.equal(notes(h, u, (n) => n.attackId === last && n.P === NOTE.piano && n.type === 'phys').length, 2, 'two 钢琴 notes per attack');
  }
  assert.ok(u.skill.opReadyAt >= F.until - 1e-9, 'no switch by hand during the Fever');
  assert.equal(casts().length, 1, 'no Fever cast of a 切换类 skill');
  h.runUntil(() => !F.active, 25);
  assert.ok(h.runUntil(() => u.skill.active, 10), 'a later cast: the switch');
  assert.ok(!F.active && casts().length === 2);
  assert.equal(u.findBuff(PIANO_KEY), null, '风琴 now');
  const n1 = u.stats.attacks;
  h.runUntil(() => u.stats.attacks > n1, 2);
  const after = Math.max(...oblvnsField(h.b).notes.map((n) => n.attackId));
  assert.equal(notes(h, u, (n) => n.attackId === after && n.P === NOTE.organ).length, 1, 'one 风琴 note per attack after the Fever');
  done(h);
});

test('S3 残月的余响 (MANUAL, attack SP, 25 s, data ACTIVE_RANGE on 3-21): cast with an enemy only on the 3-21; range 3-21 meanwhile; each attack: 2 phys notes on the highest-RES enemy, 2 arts on the highest-DEF one, 155 % / 180 % × ATK (× 0.8; stage 3 in a skill: not)', () => {
  for (const [tier, elite, mod] of [[5, false, null], [5, true, LORY], [6, true, LORY]]) {
    const sk = skillOf(tier, elite, S3);
    const { h, u } = field({ tier, elite, mod, skill: 2 });
    assert.deepEqual([u.skill.rule, u.skill.kind, sk.duration, sk.spCost, sk.initSp, sk.rangeId, sk.bb['attack@atk_scale']],
      ['ACTIVE_RANGE', 'duration', 25, elite ? 46 : 47, elite ? 30 : 28, '3-21', elite ? 1.8 : 1.55], `T${tier}: data`);
    u.skill.gainSp(999);
    h.run(0.5);
    assert.equal(u.skill.activations, 0, `T${tier}: nobody in range`);
    // (12,5): on the 3-21 (two rows up), not on her 3-12
    const w = h.spawn('enemy_ward', { pos: [12, 5] });
    assert.ok(h.runUntil(() => u.skill.active, 1), `T${tier}: cast`);
    assert.deepEqual(u.liveRangeGrid, sk.rangeGrid, `T${tier}: 3-21`);
    const d = h.spawn('enemy_def', { pos: [10, 7] });
    h.spawn('enemy_dummy', { pos: [10, 6] });
    const t0 = h.b.time;
    h.run(8);
    const hits = from(h, u, (c) => c.t > t0 + 2.5);
    const lord = noCut(tier, elite, mod) ? 1 : 0.8;
    assert.ok(hits.length >= 8, `T${tier}: hits (${hits.length})`);
    for (const c of hits) {
      if (tagged(c, 'oblvns:piano')) assert.deepEqual([c.target, c.type], [w, 'phys'], `T${tier}: 钢琴 → highest RES`);
      else if (tagged(c, 'oblvns:organ')) assert.deepEqual([c.target, c.type], [d, 'arts'], `T${tier}: 风琴 → highest DEF`);
      else assert.fail(`T${tier}: a non-S3 note ${c.dmg.tags}`);
    }
    // (钢琴 on DEF 0, 风琴 on RES 0: the notes' own amounts)
    for (const c of hits) approx(c.amount, u.s.atk * sk.bb['attack@atk_scale'] * lord, `T${tier}: ${c.dmg.tags[1]} amount`);
    const last = Math.max(...oblvnsField(h.b).notes.filter((n) => n.owner === u).map((n) => n.attackId));
    assert.deepEqual(notes(h, u, (n) => n.attackId === last).map((n) => n.type).sort(), ['arts', 'arts', 'phys', 'phys'], `T${tier}: 4 notes per attack`);
    h.runUntil(() => !u.skill.active, 20);
    approx(h.b.time - h.hooksOf('skillStart').find((c) => c.unit === u).t, 25, `T${tier}: 25 s`, 0.01);
    assert.deepEqual(u.liveRangeGrid, formOf(tier, elite).rangeGrid, `T${tier}: back to 3-12`);
    done(h);
  }
});

test('Fever with S3: the cast that starts it is paused through the Fever and then runs its 25 s; a lethal blow meanwhile keeps her up (不撤退) until the Fever ends, then she leaves the field; without a Fever she falls', () => {
  const { h, u } = field({ tier: 6, elite: true, mod: LORY, skill: 2, enemies: [{ key: 'enemy_dummy', pos: [10, 7] }] });
  const F = oblvnsField(h.b).fever;
  F.value = FEVER_MAX;
  u.skill.gainSp(999);
  assert.ok(h.runUntil(() => u.skill.active, 2), 'cast');
  assert.ok(F.active, 'Fever');
  const t0 = h.b.time;
  h.run(10);
  approx(u.skill.timeLeft, 25, 'paused', 0.05);
  const e = h.enemy('enemy_dummy');
  h.b.dealDamage(e, u, { amount: 1e9, type: 'true' });
  assert.ok(u.alive && u.hp >= 1 && u.findBuff(SAVE_KEY), '不撤退');
  h.b.dealDamage(e, u, { amount: 1e9, type: 'true' });
  assert.ok(u.alive, 'held through further blows');
  h.runUntil(() => !F.active, 12);
  approx(h.b.time, t0 + FEVER_DURATION, 'the Fever ends', 0.05);
  h.step();
  assert.ok(!u.alive && u.removeReason === 'retreat', 'then she leaves the field');
  done(h);
  // a Fever with nobody saved: the paused S3 runs its 25 s after it
  const t = field({ tier: 6, elite: true, mod: LORY, skill: 2, enemies: [{ key: 'enemy_dummy', pos: [10, 7] }] });
  oblvnsField(t.h.b).fever.value = FEVER_MAX;
  t.u.skill.gainSp(999);
  t.h.runUntil(() => t.u.skill.active, 2);
  const c0 = t.h.b.time;
  t.h.runUntil(() => !t.u.skill.active, 60);
  approx(t.h.b.time - c0, FEVER_DURATION + 25, 'Fever + 25 s', 0.1);
  done(t.h);
  // no Fever: a lethal blow knocks her out while S3 runs
  const n = field({ tier: 6, elite: true, mod: LORY, skill: 2, enemies: [{ key: 'enemy_dummy', pos: [10, 7] }] });
  n.u.skill.gainSp(999);
  n.h.runUntil(() => n.u.skill.active, 2);
  n.h.b.dealDamage(n.h.enemy('enemy_dummy'), n.u, { amount: 1e9, type: 'true' });
  assert.ok(!n.u.alive && n.u.removeReason === 'killed', 'no Fever, no save');
  done(n.h);
});

test('T2 毋畏遗忘: operators on her attack range — herself included — ASPD +16; one outside does not', () => {
  for (const [tier, elite] of [[5, false], [6, true]]) {
    const t1 = talentOf(tier, elite, null, 1);
    const { h, u } = field({ tier, elite, skill: 2, others: [{ uid: 2, chessId: 'chess_char_1_02_a', row: 10, col: 6 }, { uid: 3, chessId: 'chess_char_1_02_a', row: 10, col: 9 }] });
    h.run(0.5);
    const near = h.unit(2), far = h.unit(3);
    assert.ok(u.rangeKeySet.has(10 * COLS + 6) && !u.rangeKeySet.has(10 * COLS + 9), `T${tier}: (10,6) in her range, (10,9) not`);
    assert.equal(near.findBuff(ASPD_KEY)?.mods.aspd, t1.attack_speed, `T${tier}: in range`);
    assert.equal(u.findBuff(ASPD_KEY)?.mods.aspd, t1.attack_speed, `T${tier}: herself`);
    assert.equal(far.findBuff(ASPD_KEY), null, `T${tier}: outside`);
    done(h);
  }
});

test('T2 毋畏遗忘: another Ave Mujica member whose range overlaps hers extends her range (and hers its); apart, nothing', () => {
  const two = (col2) => makeBattle({
    defs: { enemies: ENEMIES }, timeLimit: 60, autoFinish: false, seed: 3, hooks: ['hit'], captureNoisy: true,
    units: [
      { uid: 1, diy: { slot: SLOT[5], charId: OBL, skillIndex: 2 }, row: 10, col: 3 },
      { uid: 2, diy: { slot: SLOT2[6], charId: OBL, skillIndex: 2 }, row: 10, col: col2 },
    ],
  });
  const h = two(5);
  h.run(0.5);
  const a = h.unit(1), b = h.unit(2);
  assert.ok(a.rangeKeySet.has(10 * COLS + 8), 'b\'s far tile on a\'s range');
  assert.ok(b.rangeKeySet.has(10 * COLS + 3) && b.rangeKeySet.has(11 * COLS + 3), 'a\'s tiles on b\'s range');
  // one field: one Fever gauge both fill
  assert.deepEqual(oblvnsField(h.b).providers, [a, b]);
  h.spawn('enemy_dummy', { pos: [10, 6] });
  h.run(6);
  const hits = h.hooksOf('hit').filter((c) => c.source === a || c.source === b);
  assert.ok(hits.some((c) => c.source === a) && hits.some((c) => c.source === b), 'both hit');
  assert.equal(oblvnsField(h.b).fever.value, Math.min(FEVER_MAX, 3 * hits.length), 'a shared gauge');
  checkInvariants(h.b);
  const g = two(9);   // a: cols 3–6, b: cols 9–… — no overlap
  g.run(0.5);
  assert.ok(!g.unit(1).rangeKeySet.has(10 * COLS + 9) && !g.unit(1).extraRangeKeys, 'apart: no extension');
  checkInvariants(g.b);
});

test('LOR-Y 无言的约定 trait: ASPD +12 while two or more enemies stand on her skill-off range (3-12; S3\'s extra tiles do not count); without the module none', () => {
  for (const [tier, mod] of [[5, LORY], [6, LORY], [6, null]]) {
    const { h, u } = field({ tier, elite: true, mod, skill: 2 });
    u.skill.sp = 0;
    h.spawn('enemy_dummy', { pos: [10, 7] });
    h.run(0.3);
    assert.equal(u.findBuff(LORY_KEY), null, `T${tier} ${mod}: one enemy`);
    const e2 = h.spawn('enemy_dummy', { pos: [12, 5] });   // 3-21 only
    h.run(0.3);
    assert.equal(u.findBuff(LORY_KEY), null, `T${tier} ${mod}: not on the 3-12`);
    h.b.kill(e2, null);
    h.spawn('enemy_dummy', { pos: [11, 6] });
    h.run(0.3);
    assert.equal(u.findBuff(LORY_KEY)?.mods.aspd ?? null, mod ? 12 : null, `T${tier} ${mod}: two enemies`);
    done(h);
  }
});

test('every form × skill against walking enemies (ground and air): she fights, no content error, invariants hold', () => {
  for (const f of FORMS_ALL) {
    for (const skill of [0, 1, 2]) {
      const [tier, elite, mod] = f;
      const enemies = [0, 1, 2, 3].flatMap((route) => [{ key: route >= 2 ? 'enemy_fly' : 'enemy_dummy', time: 1 + route, route }]);
      const h = makeBattle({
        defs: { enemies: { enemy_dummy: enemyRec({ key: 'enemy_dummy', hp: 6000, speed: 0.6, def: 200, res: 20 }), enemy_fly: enemyRec({ key: 'enemy_fly', hp: 4000, speed: 0.8, motion: 'FLY' }) } },
        timeLimit: 120, seed: 11, enemies,
        units: [{ uid: 1, diy: { slot: SLOT[tier], charId: OBL, skillIndex: skill, uniEquipId: mod }, elite, row: 10, col: 5 }],
      });
      h.runToEnd(120);
      const u = h.unit(1);
      assert.ok(u.stats.dmg > 0, `${label(f)} S${skill + 1}: deals damage`);
      done(h);
    }
  }
});
