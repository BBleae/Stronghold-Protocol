// test/content/op_ela.test.js — the 自选 operator kit of 艾拉 (char_4123_ela, 6★ 陷阱师, a collab pick of this fork: the owner's
// decision of 2026-10-08; kit server/sim/content/kits/ops/op-ela.js) and of her trap 雷鸣地雷 (token_10033_ela_grzmot), fielded
// the production way (a DIY slot + its `diy` pick, simdata getDiy; her mines as the placed hand pieces of her player) in every
// form: tiers 5 / 6, normal (E2 Lv1, skill rank 4, no module) and elite (E2 Lv60, rank 7) with no module or TRP-D 社会期望背包
// at stage 1 (tier 5) / 3 (tier 6). Numbers from data/backups.json; the fidelity checklist of kits/README.md.
// Run: node --test test/content/op_ela.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { KITTED_CHARS, OPERATOR_KITS, KITS } from '../../server/sim/content/kits/index.js';
import { ELA_MARK, HIT_PHYS, HIT_ARTS, TRIGGER_RADIUS } from '../../server/sim/content/kits/ops/op-ela.js';
import { diyPool, validateDiyPicks, diyRecord } from '../../shared/diy.js';
import { positionClass } from '../../server/match/board.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../../data/${f}.json`, import.meta.url), 'utf8'));
const CHESS = load('chess');
const BACKUPS = load('backups');
const ELA = 'char_4123_ela';
const MINE = 'token_10033_ela_grzmot';
const FORMS = BACKUPS.units[ELA].forms;
const TOKREC = BACKUPS.tokens[MINE];
const SLOT = { 5: 'chess_char_5_diy1_a', 6: 'chess_char_6_diy1_a' };
const D = 'uniequip_002_ela';
const [S1, S2, S3] = ['skchr_ela_1', 'skchr_ela_2', 'skchr_ela_3'];
const statusOf = (tier, elite) => (elite ? (tier === 5 ? '2/60/7/1' : '2/60/7/3') : '2/1/4/0');
const formOf = (tier, elite) => FORMS[statusOf(tier, elite)];
const skillOf = (tier, elite, id) => formOf(tier, elite).skills.find((s) => s.skillId === id);
const modOf = (tier, mod) => (mod ? formOf(tier, true).modules.find((m) => m.uniEquipId === mod) : null);
const talentOf = (tier, elite, mod, i) => modOf(tier, mod)?.talentChanges.find((t) => t.talentIndex === i)?.bb ?? formOf(tier, elite).talents[i].bb;
/** The mine's variant of a form, with the pick's skill / module (getDiyToken). */
const tokOf = (tier, elite, skill, mod) => {
  let v = TOKREC.variants[`${ELA}@${statusOf(tier, elite)}`];
  if (v.bySkill?.[skill]) v = { ...v, ...v.bySkill[skill] };
  if (mod && v.byModule?.[mod]) v = { ...v, ...v.byModule[mod] };
  return v;
};
const approx = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e9, speed: 0, mass: 0, ...o });
const ENEMIES = {
  enemy_dummy: dummy('enemy_dummy'),
  enemy_fly: dummy('enemy_fly', { motion: 'FLY' }),
  enemy_armor: dummy('enemy_armor', { def: 600 }),
  enemy_stunproof: dummy('enemy_stunproof', { immunities: { stun: true } }),
  // ranged hitters (≤ 1 damage on her): physical and arts
  enemy_shooter: dummy('enemy_shooter', { atk: 1, bat: 0.5, range: 3 }),
  enemy_caster: dummy('enemy_caster', { atk: 1, bat: 0.5, range: 3, dmgType: 'arts' }),
};
const FORMS_ALL = [[5, false, null], [6, false, null], ...[5, 6].flatMap((t) => [null, D].map((m) => [t, true, m]))];
const label = ([tier, elite, mod]) => `T${tier} ${elite ? 'elite' : 'normal'} ${mod ?? 'none'}`;

/** 艾拉 as uid 1 at (10, 4) facing RIGHT (3-3: rows 9–11, cols 4–7); `pieces` = the tiles of her placed mines (uids 2…). */
function field({ tier = 5, elite = false, mod = null, skill = 0, pieces = [], dp = 99, seed = 5, setup = null } = {}) {
  const units = [{ uid: 1, diy: { slot: SLOT[tier], charId: ELA, skillIndex: skill, uniEquipId: mod }, elite, row: 10, col: 4 }];
  pieces.forEach(([r, c], i) => units.push({ uid: 2 + i, kind: 'token', tokenId: MINE, ownerUid: 1, row: r, col: c }));
  const h = makeBattle({
    defs: { enemies: ENEMIES }, timeLimit: 900, autoFinish: false, seed,
    flags: { dpPerSec: 0, dpMax: 999, dpInit: dp }, hooks: ['damaged', 'skillStart', 'skillEnd', 'statusApplied', 'deploy', 'death'], captureNoisy: true,
    units, ...(setup ? { setup } : {}),
  });
  h.step();
  return { h, u: h.unit(1) };
}
const mines = (h) => h.b.allyUnits.filter((t) => t.kind === 'token' && t.defId === MINE);
const alive = (h) => mines(h).filter((t) => t.alive);
const piece = (h, uid) => mines(h).find((t) => t.uid === uid);
const E = (u) => u.trait.ela;
const statusesOn = (h, e) => h.hooksOf('statusApplied').filter((c) => c.target === e);
const herHits = (h, u, target = null) => h.hooksOf('damaged').filter((c) => c.source === u && (!target || c.target === target));
function done(h) {
  checkInvariants(h.b);
  assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
}

test('艾拉 in every 自选 form: her operator kit (all three skills authored), the form\'s stats + TRP-D attributes, 3-3, ranged physical arrows that hit air units, blocks 1, ground-targetable, 协防 bond, no 特质; S1 SP_FULL, S2 / S3 the data\'s DEFAULT; her mines placed, untargetable, blocking nothing, no attack, the token skill of the pick', () => {
  assert.equal(OPERATOR_KITS[ELA], KITS[ELA]);
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    for (const skill of [0, 1, 2]) {
      const { h, u } = field({ tier, elite, mod, skill, pieces: [[9, 6]] });
      const form = formOf(tier, elite), m = elite ? modOf(tier, mod) : null;
      assert.deepEqual([u.def.charId, u.def.diyFor, u.skill.id, !!u.kit.generic, u.kit.skillSource], [ELA, SLOT[tier], form.skills[skill].skillId, false, 'skills'], label(f));
      assert.deepEqual([u.base.maxHp, u.base.atk, u.base.def, u.base.cost], [form.stats.maxHp + (m?.attr.maxHp ?? 0), form.stats.atk + (m?.attr.atk ?? 0), form.stats.def + (m?.attr.def ?? 0), 10], `${label(f)}: stats`);
      assert.deepEqual([u.s.blockCnt, u.profile.attack, u.profile.dmgType, u.profile.canHitFly, u.profile.projectile, u.base.bat], [1, 'ranged', 'phys', true, 'arrow', 0.85], `${label(f)}: 陷阱师`);
      assert.deepEqual(u.liveRangeGrid, form.rangeGrid, `${label(f)}: 3-3`);
      assert.equal(form.skills[skill].trigger.rule, 'DEFAULT', `${label(f)}: data trigger`);
      assert.equal(u.skill.rule, skill === 0 ? 'SP_FULL' : 'DEFAULT', `${label(f)}: S1 acts on herself (SP_FULL), S2 / S3 the data's`);
      assert.deepEqual([u.def.bonds, u.def.raw.garrisonIds], [['emptyShip'], []], `${label(f)}: bonds / 特质`);
      assert.ok(!u.s.flags.liftoff && !u.s.flags.camou && !u.s.flags.stealth, `${label(f)}: ground enemies target her`);
      const t = piece(h, 2);
      const v = tokOf(tier, elite, skill, mod);
      assert.ok(t.alive && !t.kit.generic, `${label(f)}: the placed mine deployed with its kit`);
      assert.deepEqual([t.def.skill.id, `sktok_ela_${skill + 1}`, t.s.flags.untargetable, t.s.blockCnt, t.profile.noAttack, t.base.cost, t.base.respawnTime],
        [v.skill.skillId, v.skill.skillId, true, 0, true, 5, 5], `${label(f)}: the mine`);
      assert.deepEqual([E(u).stock, E(u).limit], [4, 4], `${label(f)}: stock cnt 4, limit 4`);
      done(h);
    }
  }
  // E2 Lv1 1145 / 503 / 141, E2 Lv60 1359 / 577 / 162; TRP-D +36 / +12 → +60 / +30
  assert.deepEqual([FORMS['2/1/4/0'].stats.atk, FORMS['2/60/7/1'].stats.atk, FORMS['2/60/7/3'].stats.def], [503, 577, 162]);
  assert.deepEqual([modOf(5, D).attr, modOf(6, D).attr], [{ atk: 36, def: 12 }, { atk: 60, def: 30 }]);
  // the mine card: cost 5, redeploy 5 s, deploy limit 4 (= 最多拥有4个) in every form and module
  for (const f of FORMS_ALL) {
    const v = tokOf(f[0], f[1], 0, f[2]);
    assert.deepEqual([v.stats.cost, v.stats.respawnTime, v.stats.deployLimit], [5, 5, 4], label(f));
  }
});

test('a 自选 pick (the owner\'s decision of 2026-10-08): 艾拉 is an owned 6★ offered at tiers 5 and 6 (she has a kit) and a roster with her passes validateDiyPicks', () => {
  const data = { chess: CHESS, backups: BACKUPS };
  assert.ok(BACKUPS.diy.ownedPool.includes(ELA));
  assert.ok(KITTED_CHARS.includes(ELA));
  for (const t of [5, 6]) assert.ok(diyPool(t, { data, kitted: KITTED_CHARS }).includes(ELA), `tier ${t}`);
  assert.deepEqual(validateDiyPicks({ [SLOT[6]]: { charId: ELA, skillIndex: 2, uniEquipId: D } }, { data, kitted: KITTED_CHARS }),
    { ok: true, picks: { [SLOT[6]]: { charId: ELA, skillIndex: 2, uniEquipId: D } } });
});

test('T1 雷鸣地雷: a selectable ground enemy within 1.35 sets a mine off (a flyer never; √2 is too far) — the token skill of the pick on every selectable ground enemy within 1.7 (no air unit), the "受到雷鸣地雷效果影响" mark for its longest status, then the mine withdraws', () => {
  assert.equal(TRIGGER_RADIUS, 1.35);
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    for (const skill of [0, 1, 2]) {
      const tag = `${label(f)} S${skill + 1}`;
      const tb = tokOf(tier, elite, skill, mod).skill.bb;
      assert.equal(tb.projectile_range, 1.7, tag);
      const { h } = field({ tier, elite, mod, skill, pieces: [[9, 6]] });
      const t = piece(h, 2);
      const fl = h.spawn('enemy_fly', { pos: [9, 6] });
      const diag = h.spawn('enemy_dummy', { pos: [10, 7] });   // √2 ≈ 1.41 from the mine
      h.run(0.5);
      assert.ok(t.alive, `${tag}: neither a flyer on it nor a ground enemy at √2 sets it off`);
      const near = h.spawn('enemy_dummy', { pos: [9, 7] });    // 1.0
      const far = h.spawn('enemy_dummy', { pos: [11, 6] });    // 2.0: outside 1.7
      h.step();
      assert.ok(!t.alive && !t.removed, `${tag}: spent, still its tile's piece`);
      assert.ok(h.eventsOf('fx').some((x) => x[1] === 'explode' && x[4]?.consumed === true && x[4]?.id === t.id), `${tag}: consumed`);
      const st = (e) => statusesOn(h, e).map((c) => [c.status, c.duration]);
      let want, mark;
      if (skill === 0) {
        want = [['sluggish', tb.sluggish]];
        mark = Math.max(tb.sluggish, tb.duration);
        assert.deepEqual([tb.sluggish, tb.duration, tb.damage_hitrate_physical, tb.damage_hitrate_magical], elite ? [9, 9, -0.3, -0.3] : [8, 8, -0.2, -0.2], tag);
        for (const e of [near, diag]) {
          assert.deepEqual([e.findBuff(HIT_PHYS)?.data.value, e.findBuff(HIT_ARTS)?.data.value], [-tb.damage_hitrate_physical, -tb.damage_hitrate_magical], `${tag}: 命中率`);
          approx(e.findBuff(HIT_PHYS).timeLeft, tb.duration, `${tag}: 命中率 duration`, 0.02);
        }
      } else if (skill === 1) {
        want = [['stun', tb.stun]];
        mark = tb.stun;
        assert.equal(tb.stun, 4, tag);
      } else {
        want = [['sluggish', tb.sluggish], ['fragile', tb['weak[limit]']]];
        mark = Math.max(tb.sluggish, tb['weak[limit]']);
        assert.deepEqual([tb.sluggish, tb['weak[limit]'], tb.damage_scale], [6, 6, elite ? 1.25 : 1.2], tag);
        for (const e of [near, diag]) approx(e.findBuff('fragile').data.value, tb.damage_scale - 1, `${tag}: 脆弱`);
      }
      for (const e of [near, diag]) {
        assert.deepEqual(st(e), want, `${tag}: the effect`);
        approx(e.findBuff(ELA_MARK).timeLeft, mark, `${tag}: marked`, 0.02);
      }
      for (const e of [far, fl]) assert.ok(!statusesOn(h, e).length && !e.findBuff(ELA_MARK), `${tag}: none outside 1.7 / on an air unit`);
      done(h);
    }
  }
});

test('S2\'s mine stun is refused by a stun-immune enemy, which still counts as "受到雷鸣地雷效果影响" [ASSUMED]', () => {
  const { h } = field({ skill: 1, pieces: [[9, 6]] });
  const e = h.spawn('enemy_stunproof', { pos: [9, 7] });
  h.step();
  assert.ok(!e.s.flags.stun && e.findBuff(ELA_MARK));
  done(h);
});

test('S1 眩目阻滞\'s 命中率 cut: an affected enemy\'s attacks miss whole with |damage_hitrate_*| (physical and arts), one roll per attack; none before or after the effect', () => {
  for (const f of [[5, false, null], [6, true, D]]) {
    const [tier, elite, mod] = f;
    const cut = -tokOf(tier, elite, 0, mod).skill.bb.damage_hitrate_physical;
    const dur = tokOf(tier, elite, 0, mod).skill.bb.duration;
    for (const key of ['enemy_shooter', 'enemy_caster']) {
      const { h, u } = field({ tier, elite, mod, skill: 0, pieces: [[10, 6]], seed: 3 });
      // five hitters within 1.7 of the mine and 3 of her
      const hs = [[10, 7], [9, 7], [11, 7], [9, 6], [11, 6]].map(([r, c]) => h.spawn(key, { pos: [r, c] }));
      h.step();
      assert.ok(hs.every((e) => e.findBuff(key === 'enemy_caster' ? HIT_ARTS : HIT_PHYS)), `${label(f)} ${key}: every hitter cut`);
      const t0 = h.b.time;
      const fx0 = h.eventsOf('fx').length, d0 = h.hooksOf('damaged').length;
      h.run(dur - 0.5);
      const misses = h.eventsOf('fx').slice(fx0).filter((x) => x[1] === 'dodge' && x[4]?.id === u.id).length;
      const hits = h.hooksOf('damaged').slice(d0).filter((c) => c.target === u && hs.includes(c.source)).length;
      const n = misses + hits;
      assert.ok(n > 60, `${label(f)} ${key}: ${n} attacks`);
      assert.ok(Math.abs(misses / n - cut) < 0.12, `${label(f)} ${key}: ${misses} / ${n} missed ≈ ${cut}`);
      // the mine is back (5 s) and goes off again: wait until the cut is gone for good — stop the returns first
      E(u).stock = 0;
      h.runUntil(() => hs.every((e) => !e.findBuff(HIT_PHYS) && !e.findBuff(HIT_ARTS)), 30);
      h.run(0.5); // (a shot started under the cut may still be flying: it is judged by its start — next test)
      const fx1 = h.eventsOf('fx').length;
      h.run(3);
      assert.equal(h.eventsOf('fx').slice(fx1).filter((x) => x[1] === 'dodge' && x[4]?.id === u.id).length, 0, `${label(f)} ${key}: no miss without the cut`);
      assert.ok(h.b.time - t0 > dur);
      done(h);
    }
  }
});

test('S1 眩目阻滞\'s 命中率 is the one the enemy holds when it starts the attack (PRTS 命中率 "开始攻击时会进行一次命中判定"): a cut that reaches it while its shot flies spares that shot; one that lapses meanwhile still makes it miss', () => {
  const always = (b) => { const r = b.rng; b.rng = Object.assign(() => 0, r); }; // every roll misses while a cut applies
  // (A) the shooter's first cut lands while its shot flies: that shot hits, its next one (started under the cut) misses
  {
    const shots = [];
    const { h, u } = field({ skill: 0, pieces: [[9, 6]], seed: 3, setup: (b) => b.on('attack', (c) => { if (c.attacker.side === 'enemy') shots.push([b.time, c.attackId]); }) });
    always(h.b);
    const sh = h.spawn('enemy_shooter', { pos: [10, 7] }); // √2 from the mine: out of its 1.35 trigger, inside its 1.7 effect
    assert.ok(h.runUntil(() => shots.length === 1, 5), 'its first shot');
    assert.ok(!sh.findBuff(HIT_PHYS), 'no cut as it starts');
    h.spawn('enemy_dummy', { pos: [9, 5] }); // sets the mine off while the shot flies
    h.step();
    assert.ok(sh.findBuff(HIT_PHYS), 'cut while its shot flies');
    assert.ok(h.runUntil(() => shots.length === 2, 3), 'its second shot');
    h.run(0.6);
    const landed = h.hooksOf('damaged').filter((c) => c.source === sh && c.target === u).map((c) => c.dmg.attackId);
    assert.ok(landed.includes(shots[0][1]), 'the shot started without the cut hits');
    assert.ok(!landed.includes(shots[1][1]), 'the one started under it misses');
    done(h);
  }
  // (B) the cut lapses while the shot flies: started under it, the shot still misses
  {
    const shots = [];
    const { h, u } = field({ skill: 0, seed: 3, setup: (b) => b.on('attack', (c) => {
      if (c.attacker.side !== 'enemy') return;
      shots.push(c.attackId);
      const cut = c.attacker.findBuff(HIT_PHYS);
      if (cut && shots.length === 1) cut.timeLeft = 0.05; // gone before the shot lands (≈0.3 s)
    }) });
    always(h.b);
    const sh = h.spawn('enemy_shooter', { pos: [10, 7] });
    h.b.applyStrongest(sh, HIT_PHYS, { duration: 30, value: 0.2, mods: () => null, source: u });
    assert.ok(h.runUntil(() => shots.length === 1, 5));
    h.run(0.15);
    assert.ok(!sh.findBuff(HIT_PHYS), 'the cut lapsed while the shot flies');
    h.run(1.5);
    const landed = h.hooksOf('damaged').filter((c) => c.source === sh && c.target === u).map((c) => c.dmg.attackId);
    assert.ok(!landed.includes(shots[0]), 'started under the cut: it misses');
    assert.ok(landed.some((id) => id !== shots[0]), 'a later shot hits');
    done(h);
  }
});

test('the mines in this mode: placed pieces deploy with the board, free and spending no stock; a spent one comes back on its tile once the card is ready (5 s after the last mine deployment), a mine is in stock and its 5 DP are paid — never on a ground enemy (an air unit does not count), past the limit or while she is off the field', () => {
  for (const f of [[5, false, null], [6, true, D]]) {
    const [tier, elite, mod] = f;
    const { h, u } = field({ tier, elite, mod, skill: 1, pieces: [[9, 6], [9, 8]], dp: 0 });
    assert.equal(alive(h).length, 2, `${label(f)}: both deployed at the start`);
    assert.equal(E(u).stock, 4, `${label(f)}: no stock spent at the start`);
    const p = piece(h, 2);
    const e = h.spawn('enemy_dummy', { pos: [9, 6] });
    h.step();
    assert.ok(!p.alive && !p.removed, `${label(f)}: spent`);
    h.run(6);
    assert.ok(!p.alive, `${label(f)}: not on a ground enemy (and no DP)`);
    h.b.kill(e, null);
    h.spawn('enemy_fly', { pos: [9, 6] });
    h.run(2);
    assert.ok(!p.alive, `${label(f)}: no DP yet`);
    h.b.players[0].dp = 10;
    h.run(0.3);
    assert.ok(p.alive && p.tileR === 9 && p.tileC === 6, `${label(f)}: back on its tile (an air unit on it does not count)`);
    approx(h.b.players[0].dp, 5, `${label(f)}: paid 5 DP`);
    assert.equal(E(u).stock, 3, `${label(f)}: one mine spent`);
    // the card's redeploy time: a second spent piece waits 5 s from that deployment
    const q = piece(h, 3);
    const ready = E(u).readyAt;
    approx(ready - h.b.time, 5, `${label(f)}: the card's cooldown from that deployment`, 0.06);
    const e2 = h.spawn('enemy_dummy', { pos: [10, 8] });
    h.step();
    assert.ok(!q.alive, `${label(f)}: the second went off (1.0 away)`);
    h.b.kill(e2, null);
    h.b.players[0].dp = 99;
    h.runUntil(() => q.alive, 10);
    assert.ok(q.alive && h.b.time + 1e-9 >= ready, `${label(f)}: after the card's 5 s`);
    assert.equal(E(u).stock, 2);
    // no stock: no return
    E(u).stock = 0;
    const e3 = h.spawn('enemy_dummy', { pos: [9, 7] });
    h.step();
    assert.ok(!p.alive && !q.alive, `${label(f)}: both went off`);
    h.b.kill(e3, null);
    h.run(8);
    assert.ok(!p.alive && !q.alive, `${label(f)}: no mine in stock`);
    E(u).stock = 4;
    h.run(0.3);
    assert.equal(alive(h).length, 1, `${label(f)}: one at once (the card is long ready)`);
    h.run(4.5);
    assert.equal(alive(h).length, 1, `${label(f)}: one per card cooldown`);
    h.run(0.5);
    assert.equal(alive(h).length, 2, `${label(f)}: then the other`);
    // her mines leave with her; the pieces wait while she is off the field, her redeploy refills the stock
    h.b.retreat(u);
    assert.equal(alive(h).length, 0, `${label(f)}: her mines leave with her`);
    h.run(8);
    assert.equal(alive(h).length, 0, `${label(f)}: not while she is off the field`);
    h.b.redeploy(u, { free: true });
    assert.equal(E(u).stock, 4, `${label(f)}: the stock refilled at her deployment`);
    h.runUntil(() => alive(h).length === 2, 20);
    assert.equal(alive(h).length, 2, `${label(f)}: both back`);
    done(h);
  }
});

test('S1 眩目阻滞 主动 "立即获得一个陷阱": +1 to her stock as soon as the SP is full (no enemy needed: SP_FULL); 阻回 while the stock is full (4, from her deployment) — S2 / S3 have no 阻回', () => {
  for (const f of [[5, false, null], [6, true, D]]) {
    const [tier, elite, mod] = f;
    const sk = skillOf(tier, elite, S1);
    assert.deepEqual([sk.skillType, sk.spCost, sk.initSp], ['AUTO', elite ? 21 : 24, 0], label(f));
    const { h, u } = field({ tier, elite, mod, skill: 0 });
    assert.ok(u.findBuff('talent:ela:full') && u.s.flags.noSp, `${label(f)}: 阻回 from her deployment (stock 4 = limit)`);
    h.run(sk.spCost + 2);
    assert.deepEqual([u.skill.activations, u.skill.sp], [0, 0], `${label(f)}: no SP, no cast while full`);
    E(u).stock = 2;
    h.step();
    assert.ok(!u.s.flags.noSp, `${label(f)}: SP again below the limit`);
    assert.ok(h.runUntil(() => u.skill.activations === 1, sk.spCost + 1), `${label(f)}: cast at full SP`);
    assert.equal(E(u).stock, 3, `${label(f)}: +1`);
    h.runUntil(() => u.skill.activations === 2, sk.spCost + 1);
    assert.equal(E(u).stock, 4, `${label(f)}: full`);
    h.step();
    assert.ok(u.s.flags.noSp, `${label(f)}: 阻回`);
    done(h);
  }
  for (const skill of [1, 2]) {
    const { u, h } = field({ skill });
    assert.ok(!u.findBuff('talent:ela:full') && !u.s.flags.noSp, `S${skill + 1}: no 阻回`);
    done(h);
  }
});

test('S2 震荡坚守: DEF +200 % / +250 %, range 3-6, attacks splash physical damage within 1.1 around the target and ignore 350 / 500 DEF, 20 s; +1 mine at its end', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    const sk = skillOf(tier, elite, S2);
    assert.deepEqual([sk.skillType, sk.spType, sk.duration, sk.bb.def, sk.bb.def_penetrate_fixed, sk.bb['attack@projectile_range'], sk.rangeId],
      ['MANUAL', 'INCREASE_WHEN_ATTACK', 20, elite ? 2.5 : 2, elite ? 500 : 350, 1.1, '3-6'], label(f));
    const { h, u } = field({ tier, elite, mod, skill: 1 });
    const a = h.spawn('enemy_armor', { pos: [10, 6] });     // DEF 600, the one enemy in 3-6
    const sp = h.spawn('enemy_armor', { pos: [10, 7] });    // 1.0 from it, outside 3-6
    const out = h.spawn('enemy_armor', { pos: [11, 7] });   // √2 from it: no splash
    const fl = h.spawn('enemy_fly', { pos: [10, 7] });      // 1.0 from it
    const def0 = u.s.def;
    assert.ok(h.runUntil(() => u.skill.active, 120), `${label(f)}: cast (attack SP)`);
    const cast = h.b.time;
    approx(u.s.def, def0 * (1 + sk.bb.def), `${label(f)}: DEF`);
    assert.deepEqual(u.liveRangeGrid, sk.rangeGrid, `${label(f)}: 3-6`);
    const d0 = h.hooksOf('damaged').length;
    h.run(5);
    const hits = h.hooksOf('damaged').slice(d0).filter((c) => c.source === u);
    const atk = u.s.atk, crit = talentOf(tier, elite, mod, 1).atk_scale;
    const ok = (amt, A) => [A, A * crit].some((x) => Math.abs(amt - Math.max(x - (600 - sk.bb.def_penetrate_fixed), 0.05 * x)) < 1e-6);
    const onA = hits.filter((c) => c.target === a), onSp = hits.filter((c) => c.target === sp);
    assert.ok(onA.length >= 3 && onSp.length >= 3, `${label(f)}: main + splash`);
    for (const c of [...onA, ...onSp]) assert.ok(ok(c.amount, atk), `${label(f)}: ${c.amount} = ATK (×${crit}) − (600 − ${sk.bb.def_penetrate_fixed})`);
    assert.ok(onSp.every((c) => c.dmg.isSplash && c.type === 'phys'), `${label(f)}: physical splash`);
    assert.ok(hits.some((c) => c.target === fl), `${label(f)}: the splash reaches an air unit (she hits air)`);
    assert.ok(!hits.some((c) => c.target === out), `${label(f)}: not beyond 1.1`);
    E(u).stock = 2;
    assert.ok(h.runUntil(() => !u.skill.active, 20), `${label(f)}: ends`);
    approx(h.b.time - cast, 20, `${label(f)}: 20 s`, 0.01);
    assert.equal(h.hooksOf('skillEnd').find((c) => c.unit === u)?.reason, 'duration');
    assert.equal(E(u).stock, 3, `${label(f)}: +1 mine at its end`);
    assert.deepEqual(u.liveRangeGrid, formOf(tier, elite).rangeGrid, `${label(f)}: 3-3 again`);
    approx(u.s.def, def0, `${label(f)}: DEF back`);
    done(h);
  }
});

test('S3 “博萨克风暴”: ATK +45 % / +60 %, base attack time −0.35 s, 40 bullets, the enemies "受到雷鸣地雷效果影响" first; +2 mines at its end', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    const sk = skillOf(tier, elite, S3);
    assert.deepEqual([sk.skillType, sk.durationType, sk.bb.atk, sk.bb.base_attack_time, sk.bb['attack@trigger_time'], sk.bb.cnt], ['MANUAL', 'AMMO', elite ? 0.6 : 0.45, -0.35, 40, 2], label(f));
    const { h, u } = field({ tier, elite, mod, skill: 2 });
    const first = h.spawn('enemy_dummy', { pos: [9, 5] });
    const atk0 = u.s.atk;
    assert.ok(h.runUntil(() => u.skill.active, 60), `${label(f)}: cast`);
    approx(u.s.atk, atk0 * (1 + sk.bb.atk), `${label(f)}: ATK`, 1e-6);
    approx(u.s.interval, 0.85 - 0.35, `${label(f)}: interval`);
    assert.equal(u.skill.ammoMax, 40);
    const tgt = h.spawn('enemy_dummy', { pos: [11, 7] });
    h.b.addBuff(tgt, { key: ELA_MARK, duration: 999 });
    h.run(0.6);   // (an arrow already in flight)
    const d0 = h.hooksOf('damaged').length;
    h.run(3);
    const hits = h.hooksOf('damaged').slice(d0).filter((c) => c.source === u);
    assert.ok(hits.length >= 4 && hits.every((c) => c.target === tgt), `${label(f)}: the marked enemy first (${hits.map((c) => c.target.id)})`);
    h.b.removeBuff(tgt, ELA_MARK);
    h.run(0.6);
    const d1 = h.hooksOf('damaged').length;
    h.run(2);
    assert.ok(h.hooksOf('damaged').slice(d1).some((c) => c.source === u && c.target === first), `${label(f)}: the usual order without the mark`);
    E(u).stock = 1;
    assert.ok(h.runUntil(() => !u.skill.active, 40), `${label(f)}: the bullets run out`);
    assert.equal(h.hooksOf('skillEnd').find((c) => c.unit === u)?.reason, 'ammo');
    assert.equal(E(u).stock, 3, `${label(f)}: +2 mines`);
    approx(u.s.interval, 0.85, `${label(f)}: interval back`);
    done(h);
  }
});

test('T2 “正中靶心”: an attack deals ATK × atk_scale with prob (30 % / 160 %; TRP-D stage 3: 50 % / 180 %), always on an enemy "受到雷鸣地雷效果影响"', () => {
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    const t1 = talentOf(tier, elite, mod, 1);
    assert.deepEqual([t1.prob, t1.atk_scale], tier === 6 && mod === D ? [0.5, 1.8] : [0.3, 1.6], label(f));
    const { h, u } = field({ tier, elite, mod, skill: 0, seed: 7 });   // S1 with a full stock: 阻回, no cast
    const e = h.spawn('enemy_dummy', { pos: [10, 6] });
    h.run(120);
    const hits = herHits(h, u, e);
    const atk = u.s.atk;
    let crits = 0;
    for (const c of hits) {
      if (Math.abs(c.amount - atk * t1.atk_scale) < 1e-6) crits++;
      else approx(c.amount, atk, `${label(f)}: a plain hit`);
    }
    assert.ok(hits.length > 120, `${label(f)}: ${hits.length} attacks`);
    assert.ok(Math.abs(crits / hits.length - t1.prob) < 0.1, `${label(f)}: ${crits} / ${hits.length} ≈ ${t1.prob}`);
    // marked: every attack
    h.b.addBuff(e, { key: ELA_MARK, duration: 999 });
    const d0 = h.hooksOf('damaged').length;
    h.run(10);
    const marked = h.hooksOf('damaged').slice(d0).filter((c) => c.source === u && c.target === e);
    assert.ok(marked.length >= 10 && marked.every((c) => Math.abs(c.amount - atk * t1.atk_scale) < 1e-6), `${label(f)}: always on a marked enemy`);
    done(h);
  }
});

test('T1 "撤退时以自身为中心触发一次雷鸣地雷效果": whenever she leaves the field (withdrawn or knocked out), the mine effect of her pick goes off once around her (1.7, ground only)', () => {
  for (const [skill, how] of [[0, 'retreat'], [1, 'kill'], [2, 'retreat']]) {
    const f = [6, true, D];
    const tb = tokOf(6, true, skill, D).skill.bb;
    const { h, u } = field({ tier: 6, elite: true, mod: D, skill, pieces: [[12, 8]] });
    const near = h.spawn('enemy_dummy', { pos: [11, 5] });  // √2 from her
    const far = h.spawn('enemy_dummy', { pos: [10, 6] });   // 2.0
    const fl = h.spawn('enemy_fly', { pos: [10, 5] });
    h.step();
    assert.ok(!statusesOn(h, near).length, `${label(f)} S${skill + 1}: nothing before`);
    if (how === 'kill') h.b.kill(u, null); else h.b.retreat(u);
    h.step();
    const want = skill === 0 ? [['sluggish', tb.sluggish]] : skill === 1 ? [['stun', tb.stun]] : [['sluggish', tb.sluggish], ['fragile', tb['weak[limit]']]];
    assert.deepEqual(statusesOn(h, near).map((c) => [c.status, c.duration]), want, `${label(f)} S${skill + 1}: ${how}`);
    assert.ok(near.findBuff(ELA_MARK), 'marked');
    assert.ok(!statusesOn(h, far).length && !statusesOn(h, fl).length, `${label(f)} S${skill + 1}: 1.7, ground only`);
    assert.equal(alive(h).length, 0, 'her mines left with her');
    done(h);
  }
});

test('TRP-D 社会期望背包: ATK / DEF in the stats, stage 3 updates 正中靶心; its deployment part (自身…近战位，陷阱…远程位) is a 部署效果 卫戍协议 switches off — she (RANGED) stands on melee and ranged tiles anyway, her mine stays a melee piece', () => {
  const m5 = modOf(5, D), m6 = modOf(6, D);
  assert.equal(m5.traitOverride.moduleDesc, '自身可以额外部署在近战位，陷阱可以额外部署在远程位');
  assert.deepEqual(m5.talentChanges.map((t) => [t.talentIndex, t.bb]), [[2, { buildable_type: 3 }]]);
  assert.deepEqual(m6.talentChanges.map((t) => [t.talentIndex, t.bb]), [[1, { prob: 0.5, atk_scale: 1.8 }], [2, { buildable_type: 3 }]]);
  const data = { chess: CHESS, backups: BACKUPS };
  for (const [tier, mod] of [[5, null], [6, D]]) {
    const rec = diyRecord(SLOT[tier], { charId: ELA, skillIndex: 0, uniEquipId: mod }, { elite: true, data });
    assert.equal(positionClass(rec), 'ranged', `T${tier} ${mod}: any deployable tile`);
  }
  assert.equal(positionClass(TOKREC), 'melee', 'the mine: melee tiles');
});

test('a mixed wave (walkers on the stage route, flyers) in every form × skill: she casts, her mines go off and come back, no content error', () => {
  const enemies = { walker: enemyRec({ key: 'walker', hp: 4000, atk: 250, speed: 1, bat: 1.5 }), flyer: enemyRec({ key: 'flyer', hp: 2000, atk: 150, speed: 1.2, motion: 'FLY', range: 1.5 }) };
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    for (const skill of [0, 1, 2]) {
      const units = [{ uid: 1, diy: { slot: SLOT[tier], charId: ELA, skillIndex: skill, uniEquipId: mod }, elite, row: 10, col: 4 }];
      [[9, 5], [11, 5], [9, 7], [11, 7]].forEach(([r, c], i) => units.push({ uid: 2 + i, kind: 'token', tokenId: MINE, ownerUid: 1, row: r, col: c }));
      const h = makeBattle({ defs: { enemies }, timeLimit: 200, autoFinish: false, seed: 9, flags: { dpPerSec: 1, dpMax: 99, dpInit: 20 }, units, hooks: ['deploy', 'death'] });
      h.step();
      const u = h.unit(1);
      const routes = Math.max(1, h.b.stage?.routes?.length ?? 1);
      for (let i = 0; i < 12; i++) h.b.after(i * 4, () => { h.b.spawnEnemy(i % 4 === 3 ? 'flyer' : 'walker', { routeIndex: i % routes }); });
      h.run(90);
      const tag = `${label(f)} S${skill + 1}`;
      assert.ok(u.alive && u.skill.activations >= 1 && u.stats.kills > 0, `${tag}: fights and casts`);
      assert.ok(h.hooksOf('death').some((c) => c.unit.defId === MINE), `${tag}: mines went off`);
      assert.ok(h.hooksOf('deploy').filter((c) => c.unit.defId === MINE).length > 4, `${tag}: and came back`);
      done(h);
    }
  }
});
