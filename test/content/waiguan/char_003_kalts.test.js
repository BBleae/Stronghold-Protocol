// test/content/waiguan/char_003_kalts.test.js — 凯尔希 外援 kit (server/sim/content/kits/waiguan/char_003_kalts.js).
// Every skill (normal Lv4 + elite Lv7), both talents, every module choice, Mon3tr (placed piece: links, binding, return,
// 不毁重构), and a smoke wave per skill. Expected numbers come from the records (skill bb, token talents), never literals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, chessRec, checkInvariants } from '../../helpers/battleHarness.js';
import { DataSource, getDefaultSource } from '../../../server/sim/simdata.js';
import { getData } from '../../../server/data.js';
import { waiguanRecords } from '../../../shared/waiguan.js';
import { skillSpecSource } from '../../../server/sim/content/index.js';
import WAIGUAN from '../../../server/sim/content/kits/waiguan/index.js';
import { GameData } from '../../../server/match/gamedata.js';

const CHAR = 'char_003_kalts';
const ID5 = `chess_char_diy_5_${CHAR}_a`, ID6 = `chess_char_diy_6_${CHAR}_a`;
const ELITE5 = ID5.replace(/_a$/, '_b'), ELITE6 = ID6.replace(/_a$/, '_b');
const MON = 'token_10002_kalts_mon3tr';
const PHYX = 'uniequip_002_kalts', PHYY = 'uniequip_003_kalts', ISWA = 'uniequip_004_kalts';
const DATA = getData({ log: { warn() {}, error() {}, info() {} } });
const REC = waiguanRecords(DATA.waiguan);
const DS = new DataSource({ chess: REC }, getDefaultSource());
/** The hand pieces a player gets with a loadout (GameData.placeableTokens: token + count — KIT_CONVENTIONS 16). */
const GD = new GameData(DATA, 'mode_multi_normal', { chess: REC });
const PIECE_TILES = [[10, 6], [10, 7], [9, 6], [11, 7], [9, 7], [12, 6], [10, 8], [12, 7], [9, 8]];
const handPieces = (id, skillIndex) => GD.placeableTokens(id, { skillIndex }).flatMap(({ tokenId, count }) => Array.from({ length: count }, () => tokenId))
  .slice(0, PIECE_TILES.length).map((tokenId, i) => ({ uid: 10 + i, kind: 'token', tokenId, ownerUid: 1, row: PIECE_TILES[i][0], col: PIECE_TILES[i][1] }));
const rec = (id) => REC[id];
const skillOf = (id, sid) => rec(id).skills.find((s) => s.skillId === sid);
const sbb = (id, sid) => skillOf(id, sid).bb;
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e7, speed: 0, ...o });
const DEFS = {
  chess: { ...REC, test_guard_a: chessRec({ id: 'test_guard_a', profession: 'WARRIOR', skill: null, stats: { maxHp: 1e4, atk: 1, def: 0 } }) },
  enemies: { enemy_dummy: dummy('enemy_dummy'), enemy_weak: dummy('enemy_weak', { hp: 50 }), enemy_hitter: dummy('enemy_hitter', { atk: 3000 }) },
};
const HOOKS = ['damaged', 'heal', 'skillStart', 'skillEnd', 'statusApplied', 'death', 'deploy', 'kill'];
const run = (o) => makeBattle({ defs: DEFS, seed: 7, timeLimit: 300, autoFinish: false, hooks: HOOKS, captureNoisy: true, ...o });
/** 凯尔希 (uid 1) with skill `sid` at board (row, col), facing right. */
const K = (id, sid, row, col, o = {}) => ({ uid: 1, chessId: id, row, col, skillIndex: skillOf(id, sid).index, ...o });
/** Her Mon3tr piece (uid 2). */
const M = (row, col, o = {}) => ({ uid: 2, kind: 'token', tokenId: MON, ownerUid: 1, row, col, ...o });
/** Injured (50 %) with a full SP bar: the basic strategy casts at her first heal. */
const HURT_READY = { hpPct: 0.5, sp: 999 };
const close = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} ≉ ${b}`);
const done = (h) => { checkInvariants(h.b); assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0])); };
/** 不毁重构 numbers of the Mon3tr token variant for an owner chess / module (the token talent with `value`). */
const rebuildNums = (ownerId, moduleId = null) => {
  const tdef = DS.getToken(MON, ownerId, DS.getChess(ownerId, { moduleId }).loadout);
  return tdef.talents.find((t) => t.bb && t.bb.value > 0);
};
const num = (v) => (Number.isFinite(v) ? v : 0);
/** The loadout-resolved record of an elite with module `moduleId` (null = default, 'none'). */
const loadout = (id, moduleId) => DS.getChess(id, { moduleId }).raw;
/** Talent-1 (data index 0, named part) blackboard of the loadout. */
const talent0Of = (id, moduleId) => loadout(id, moduleId).talents.find((t) => t.index === 0 && !t.hidden)?.bb ?? {};

test('凯尔希: every skill of both tiers (normal + elite, every module) is hand-authored', () => {
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

test('凯尔希 S1: herself DEF +def and physical dodge +prob, Mon3tr DEF +attack@def; the data DEFAULT (heal) trigger', () => {
  for (const id of [ID6, ELITE6]) {
    const bb = sbb(id, 'skchr_kalts_1');
    const h = run({ units: [K(id, 'skchr_kalts_1', 10, 4, { carryState: HURT_READY }), M(10, 6)] });
    const u = h.unit(1), m = h.unit(2);
    assert.ok(h.runUntil(() => u.skill.active, 5), `${id} casts at her first heal`);
    assert.equal(u.skill.rule, 'DEFAULT');
    assert.equal(u.kit.skillSource, 'skills');
    close(u.s.def, u.base.def * (1 + bb.def), 1e-6, 'her DEF');
    close(u.s.dodgePhys, bb.prob, 1e-9, 'physical dodge');
    close(m.s.def, m.base.def * (1 + bb['attack@def']), 1e-6, 'Mon3tr DEF');
    // a Mon3tr back while the skill still runs gets it too (its redeploy time is shorter than the skill)
    assert.ok(m.base.respawnTime < skillOf(id, 'skchr_kalts_1').duration);
    h.b.kill(m);
    assert.ok(h.runUntil(() => m.alive, m.base.respawnTime + 1), 'Mon3tr back');
    assert.ok(u.skill.active);
    close(m.s.def, m.base.def * (1 + bb['attack@def']), 1e-6, 'Mon3tr DEF after its return');
    h.runUntil(() => !u.skill.active, 60);
    close(m.s.def, m.base.def, 1e-6, 'Mon3tr DEF back after the skill');
    done(h);
  }
  // not bound to Mon3tr: it casts without one
  const h = run({ units: [K(ID6, 'skchr_kalts_1', 10, 4, { carryState: HURT_READY })] });
  assert.ok(h.runUntil(() => h.unit(1).skill.active, 5), 'S1 casts with no Mon3tr on the field');
  done(h);
});

test('凯尔希 S2: her ASPD +attack_speed, Mon3tr ATK +attack@atk and it strikes every enemy it blocks', () => {
  for (const id of [ID6, ELITE6]) {
    const bb = sbb(id, 'skchr_kalts_2');
    const h = run({
      units: [K(id, 'skchr_kalts_2', 10, 4, { carryState: HURT_READY }), M(10, 6)],
      enemies: [{ key: 'enemy_dummy', pos: [10, 6] }, { key: 'enemy_dummy', pos: [10, 6] }],
    });
    const u = h.unit(1), m = h.unit(2);
    assert.ok(h.runUntil(() => u.skill.active, 5), 'casts');
    assert.equal(u.skill.rule, 'DEFAULT', 'the record trigger');
    assert.equal(h.hooksOf('skillStart')[0].reason, 'DEFAULT');
    assert.equal(u.s.aspd, 100 + bb.attack_speed);
    close(m.s.atk, m.base.atk * (1 + bb['attack@atk']), 1e-6, 'Mon3tr ATK');
    assert.equal(m.blocking.length, 2);
    h.run(6);
    const byAttack = new Map();
    for (const c of h.hooksOf('damaged')) if (c.source === m && c.dmg.isAttack && c.t >= h.hooksOf('skillStart')[0].t) byAttack.set(c.dmg.attackId, (byAttack.get(c.dmg.attackId) ?? 0) + 1);
    assert.ok(byAttack.size > 0 && [...byAttack.values()].every((n) => n === 2), 'each Mon3tr attack hits both blocked enemies');
    done(h);
  }
  // without S2 Mon3tr strikes one blocked enemy per attack
  const h = run({ units: [K(ID6, 'skchr_kalts_1', 10, 4), M(10, 6)], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }, { key: 'enemy_dummy', pos: [10, 6] }] });
  h.run(6);
  const ids = new Set(h.hooksOf('damaged').filter((c) => c.source === h.unit(2) && c.dmg.isAttack).map((c) => c.dmg.attackId));
  assert.equal(ids.size, h.hooksOf('damaged').filter((c) => c.source === h.unit(2) && c.dmg.isAttack).length);
  done(h);
});

test('凯尔希 S2/S3 "该技能与Mon3tr绑定" (kalts_s_2_3[sp_cond]): no Mon3tr ⇒ skill ends, SP 0 and no recovery; back ⇒ charges from 0', () => {
  for (const id of [ID6, ELITE6]) for (const sid of ['skchr_kalts_2', 'skchr_kalts_3']) {
    // never placed: the full bar of the carry is cleared and never refills
    const alone = run({ units: [K(id, sid, 10, 4, { carryState: HURT_READY })] });
    alone.run(10);
    const a = alone.unit(1);
    assert.equal(a.skill.activations, 0, `${id} ${sid}: never without Mon3tr`);
    assert.deepEqual([a.skill.sp, a.skill.charges], [0, 0], 'SP held at 0');
    done(alone);
    // S1 is not bound: its SP recovers without Mon3tr
    const s1 = run({ units: [K(id, 'skchr_kalts_1', 10, 4)] });
    s1.run(2);
    assert.ok(s1.unit(1).skill.sp > skillOf(id, 'skchr_kalts_1').initSp, 'S1 recovers SP');
    done(s1);
    const h = run({ units: [K(id, sid, 10, 4, { carryState: HURT_READY }), M(10, 6)] });
    const u = h.unit(1), m = h.unit(2);
    assert.ok(h.runUntil(() => u.skill.active, 5), `${sid}: casts with Mon3tr`);
    h.run(1);
    h.b.kill(m);
    assert.equal(u.skill.active, false, 'ended with Mon3tr');
    assert.equal(h.hooksOf('skillEnd').at(-1).reason, 'summonLeft');
    assert.deepEqual([u.skill.sp, u.skill.charges], [0, 0], 'SP cleared');
    h.run(m.base.respawnTime - 2);
    assert.equal(m.alive, false);
    assert.deepEqual([u.skill.sp, u.skill.charges], [0, 0], 'no SP recovery while Mon3tr is gone');
    assert.equal(u.skill.activations, 1);
    assert.ok(h.runUntil(() => m.alive, 3), 'Mon3tr back');
    const tBack = h.b.time;
    h.run(4);
    close(u.skill.sp, (h.b.time - tBack) * u.s.spRecovery, 2 * h.TICK, 'charges from 0 once it is back');
    assert.equal(u.skill.charges, 0);
    done(h);
  }
});

test('凯尔希 S3: Mon3tr DEF +attack@def, ATK +attack@atk falling to 0, true damage; no kill ⇒ it loses attack@hp_ratio HP', () => {
  for (const id of [ID6, ELITE6]) {
    const bb = sbb(id, 'skchr_kalts_3'), dur = skillOf(id, 'skchr_kalts_3').duration;
    const h = run({ units: [K(id, 'skchr_kalts_3', 10, 4, { carryState: HURT_READY }), M(10, 6)], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
    const u = h.unit(1), m = h.unit(2);
    assert.ok(h.runUntil(() => u.skill.active, 5), 'casts');
    assert.equal(u.skill.rule, 'DEFAULT');
    close(m.s.def, m.base.def * (1 + bb['attack@def']), 1e-6, 'Mon3tr DEF');
    const t0 = h.hooksOf('skillStart')[0].t;
    // kalts_s_3[ratio_atk] RemainingRatioToAttributeModifier, re-read once per second (KIT_CONVENTIONS 11)
    const bonus = () => m.s.atk / m.base.atk - 1;
    h.step(1);
    close(bonus(), bb['attack@atk'], 1e-9, 'full bonus at the start');
    h.runUntil(() => h.b.time - t0 >= 0.5, 1);
    close(bonus(), bb['attack@atk'], 1e-9, 'unchanged within the first second');
    const k = Math.floor(dur / 2);
    h.runUntil(() => h.b.time - t0 >= k + 0.5, dur);
    close(bonus(), bb['attack@atk'] * (1 - k / dur), 1e-9, `after ${k} s: × (1 − ${k}/${dur})`);
    h.runUntil(() => h.b.time - t0 >= dur - 0.5, dur);
    close(bonus(), bb['attack@atk'] * (1 - Math.floor(dur - 0.5) / dur), 1e-9, 'last second');
    const hits = h.hooksOf('damaged').filter((c) => c.source === m && c.dmg.isAttack && c.t >= t0);
    assert.ok(hits.length > 0 && hits.every((c) => c.type === 'true'), 'Mon3tr attacks deal true damage');
    const hp = m.hp;
    assert.ok(h.runUntil(() => !u.skill.active, dur), 'ends');
    const loss = h.hooksOf('damaged').find((c) => c.target === m && c.dmg.tags.includes('kaltsMeltdown'));
    assert.ok(loss, 'HP loss at the end');
    close(loss.amount, m.s.maxHp * bb['attack@hp_ratio'], 1e-6, 'loss = hp_ratio × max HP');
    assert.ok(m.hp < hp, 'Mon3tr lost HP');
    h.run(3);
    assert.ok(h.hooksOf('damaged').filter((c) => c.source === m && c.dmg.isAttack && c.t > h.hooksOf('skillEnd')[0].t).every((c) => c.type === 'phys'), 'physical again after the skill');
    done(h);
  }
  // a kill by Mon3tr during the skill ⇒ no loss
  const h = run({ units: [K(ID6, 'skchr_kalts_3', 10, 4, { carryState: HURT_READY }), M(10, 6)], enemies: [{ key: 'enemy_weak', pos: [10, 6] }] });
  const u = h.unit(1), m = h.unit(2);
  assert.ok(h.runUntil(() => u.skill.active, 5));
  assert.ok(h.runUntil(() => !u.skill.active, 30));
  assert.ok(h.hooksOf('kill').some((c) => c.killer === m), 'Mon3tr killed during the skill');
  assert.equal(h.hooksOf('damaged').filter((c) => c.target === m && c.dmg.tags.includes('kaltsMeltdown')).length, 0, 'no loss');
  done(h);
  // she is knocked out during the skill (no kill yet): Mon3tr is withdrawn, no loss, no 不毁重构
  const ko = run({ units: [K(ID6, 'skchr_kalts_3', 10, 4, { carryState: HURT_READY }), M(10, 6)], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
  const ku = ko.unit(1), km = ko.unit(2);
  assert.ok(ko.runUntil(() => ku.skill.active, 5));
  ko.run(3);
  ko.b.kill(ku);
  assert.equal(ko.hooksOf('skillEnd').at(-1).reason, 'death');
  assert.equal(km.alive, false, 'Mon3tr withdrawn with her');
  assert.equal(ko.hooksOf('damaged').filter((c) => c.dmg.tags.includes('kaltsMeltdown') || c.dmg.tags.includes('kaltsRebuild')).length, 0, 'no loss, no burst');
  done(ko);
});

test('凯尔希 T1: Mon3tr DEF 0 outside her range (kalts_t_1[token_def_down]); PHY-Y in-range ASPD / DEF bonus', () => {
  // (10,4) facing right: her range reaches 4 columns ahead
  const inR = run({ units: [K(ID6, 'skchr_kalts_1', 10, 4), M(10, 8)] });
  inR.run(1);
  close(inR.unit(2).s.def, inR.unit(2).base.def, 1e-6, 'in range: own DEF');
  const out = run({ units: [K(ID6, 'skchr_kalts_1', 10, 4), M(10, 9)] });
  out.run(1);
  assert.equal(out.unit(2).s.def, 0, 'out of range: DEF 0');
  done(inR); done(out);
  // elite talent-1 bonus of each module choice, from the record (both tiers: tier V elites carry their own module level):
  // PHY-Y in range ASPD +attack_speed, DEF +def; PHY-X / ISW-A / 'none' carry 0
  assert.ok(talent0Of(ELITE6, PHYY).attack_speed > 0, 'tier VI PHY-Y data');
  for (const id of [ELITE5, ELITE6]) {
    const at = (moduleId, col) => { const h = run({ units: [K(id, 'skchr_kalts_1', 10, 4, { moduleId }), M(10, col)] }); h.run(1); done(h); return h.unit(2); };
    for (const moduleId of [null, 'none', ...(rec(id).modules ?? []).map((m) => m.uniEquipId)]) {
      const y = talent0Of(id, moduleId);
      const m = at(moduleId, 6);
      assert.equal(m.s.aspd, 100 + num(y.attack_speed), `${id} ${moduleId} ASPD`);
      close(m.s.def, m.base.def * (1 + num(y.def)), 1e-6, `${id} ${moduleId} DEF`);
      assert.equal(at(moduleId, 9).s.def, 0, `${id} ${moduleId}: out of range DEF 0`);
    }
  }
});

test('凯尔希 T1: "优先治疗自身和Mon3tr" — Mon3tr before a lower-HP ally', () => {
  const h = run({
    units: [K(ID6, 'skchr_kalts_1', 10, 4), M(10, 6), { uid: 3, chessId: 'test_guard_a', row: 10, col: 5, carryState: { hpPct: 0.2 } }],
    // Mon3tr deploys at 80 % HP (before her first heal)
    setup: (b) => b.on('deploy', (c) => { if (c.unit.kind === 'token') c.unit.hp = c.unit.s.maxHp * 0.8; }),
  });
  const m = h.unit(2), g = h.unit(3);
  h.runUntil(() => h.hooksOf('heal').some((c) => c.source === h.unit(1)), 10);
  const first = h.hooksOf('heal').find((c) => c.source === h.unit(1));
  assert.equal(first.target, m, 'Mon3tr first although the guard is at 20 %');
  m.hp = m.s.maxHp;
  h.runUntil(() => h.hooksOf('heal').filter((c) => c.source === h.unit(1)).length >= 2, 10);
  assert.equal(h.hooksOf('heal').filter((c) => c.source === h.unit(1))[1].target, g, 'then the guard');
  done(h);
});

test('凯尔希 T1: Mon3tr comes back on its tile after its redeploy time, paying its DP cost, only while she stands', () => {
  for (const id of [ID6, ELITE6]) {
    const h = run({ units: [K(id, 'skchr_kalts_1', 10, 4), M(10, 6)] });
    const m = h.unit(2);
    h.run(1);
    h.b.kill(m);
    const dpAt = h.b.getPlayer('p1').dp, t0 = h.b.time;
    assert.ok(h.runUntil(() => m.alive, m.base.respawnTime + 1), 'back');
    assert.ok(h.b.time - t0 >= m.base.respawnTime - 1e-6 && h.b.time - t0 <= m.base.respawnTime + 0.3, `after its redeploy time (${h.b.time - t0})`);
    assert.deepEqual([m.tileR, m.tileC], [m.homeR, m.homeC]);
    close(h.b.getPlayer('p1').dp, dpAt + (h.b.time - t0) - m.base.cost, 1e-6, 'paid its cost');
    assert.equal(m.hp, m.s.maxHp);
    done(h);
  }
  // not while she is down: back only after her own return
  const h = run({ units: [K(ID6, 'skchr_kalts_1', 10, 4), M(10, 6)] });
  const u = h.unit(1), m = h.unit(2);
  h.run(1);
  h.b.kill(m);
  h.b.kill(u);
  h.run(m.base.respawnTime + 2);
  assert.equal(m.alive, false, 'waits for her');
  assert.ok(h.runUntil(() => u.alive, u.base.respawnTime + 30), 'she redeploys');
  assert.ok(h.runUntil(() => m.alive, 2), 'then Mon3tr');
  done(h);
});

test('凯尔希 T1 (kalts_t_withdraw_token): she leaves the field ⇒ her Mon3tr is withdrawn (no 不毁重构) and returns after she stands', () => {
  for (const id of [ID6, ELITE6]) {
    const h = run({ units: [K(id, 'skchr_kalts_1', 10, 4), M(10, 6)], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
    const u = h.unit(1), m = h.unit(2);
    h.run(1);
    h.b.kill(u);
    assert.equal(m.alive, false, 'withdrawn with her');
    assert.equal(h.hooksOf('death').find((c) => c.unit === m).reason, 'retreat', 'a withdrawal, not a knock-out');
    assert.equal(h.hooksOf('damaged').filter((c) => c.dmg.tags.includes('kaltsRebuild')).length, 0, 'no 不毁重构');
    assert.equal(m.removed, false, 'still a board piece');
    h.run(m.base.respawnTime + 2);
    assert.equal(m.alive, false, 'not while she is down');
    assert.ok(h.runUntil(() => u.alive, u.base.respawnTime + 20), 'she redeploys');
    const tBack = h.b.time;
    assert.ok(h.runUntil(() => m.alive, 1), 'then Mon3tr (its own timer is long over)');
    assert.ok(h.b.time - tBack <= 0.3);
    assert.deepEqual([m.tileR, m.tileC], [m.homeR, m.homeC]);
    done(h);
  }
});

test('凯尔希 T1: a DP shortage delays Mon3tr\'s return until the player has its cost', () => {
  const h = run({ units: [K(ID6, 'skchr_kalts_1', 10, 4), M(10, 6)] });
  const m = h.unit(2), ps = h.b.getPlayer('p1');
  h.run(1);
  h.b.kill(m);
  const due = h.b.time + m.base.respawnTime;
  h.runUntil(() => h.b.time >= due - 0.5, 30);
  ps.dp = 0;
  h.runUntil(() => h.b.time >= due + 1, 5);
  assert.equal(m.alive, false, 'its timer is over, the DP is not');
  const ready = h.b.time + (m.base.cost - ps.dp) / h.b.flags.dpPerSec;
  assert.ok(h.runUntil(() => m.alive, m.base.cost + 2), 'back');
  close(h.b.time, ready, 0.3, 'as soon as the player has its cost');
  assert.ok(ps.dp < 0.5, 'paid it');
  done(h);
});

test('凯尔希: two copies (two owners) each drive only their own Mon3tr', () => {
  const sid = 'skchr_kalts_3', si = skillOf(ID6, sid).index;
  const h = run({
    units: [
      { uid: 1, chessId: ID6, row: 10, col: 4, skillIndex: si, carryState: HURT_READY }, { uid: 2, kind: 'token', tokenId: MON, ownerUid: 1, row: 10, col: 6 },
      { uid: 4, chessId: ID6, row: 12, col: 4, skillIndex: si, carryState: HURT_READY }, { uid: 5, kind: 'token', tokenId: MON, ownerUid: 4, row: 12, col: 6 },
    ],
    enemies: [{ key: 'enemy_dummy', pos: [10, 6] }, { key: 'enemy_dummy', pos: [12, 6] }],
  });
  const A = h.unit(1), B = h.unit(4), mA = h.unit(2), mB = h.unit(5);
  assert.ok(h.runUntil(() => A.skill.active && B.skill.active, 10));
  assert.ok(mA.findBuff('kalts:s3')?.source === A && mB.findBuff('kalts:s3')?.source === B, 'each owner buffs her own');
  h.b.kill(mA);
  assert.equal(A.skill.active, false, "A's skill ends with her Mon3tr");
  assert.deepEqual([A.skill.sp, A.skill.charges], [0, 0]);
  assert.ok(B.skill.active && mB.findBuff('kalts:s3'), "B's skill and buff run on");
  h.run(2);
  assert.ok(B.skill.active);
  assert.equal(A.skill.sp, 0, "A's SP held while B's Mon3tr stands");
  h.b.kill(B);
  assert.equal(mB.alive, false, "B's Mon3tr withdrawn with B");
  assert.equal(mA.alive, false);
  assert.ok(A.alive, 'A stands');
  assert.ok(h.runUntil(() => mA.alive, mA.base.respawnTime + 1), "A's Mon3tr back on its own timer");
  assert.equal(mB.alive, false, "B's waits for B");
  done(h);
});

test('凯尔希 T2 不毁重构: Mon3tr knocked out ⇒ its 3×3 stunned + true damage (token talent numbers per tier / module)', () => {
  for (const [id, moduleId] of [[ID6, null], [ELITE6, null], [ELITE6, 'none'], [ELITE6, PHYY], [ELITE5, null]]) {
    const n = rebuildNums(id, moduleId);
    const h = run({
      units: [K(id, 'skchr_kalts_1', 10, 4, { moduleId }), M(10, 6)],
      enemies: [{ key: 'enemy_dummy', pos: [10, 6] }, { key: 'enemy_dummy', pos: [11, 7] }, { key: 'enemy_dummy', pos: [10, 8] }],
    });
    h.run(0.5);
    const m = h.unit(2);
    const [a, b, far] = h.b.enemies;
    h.b.kill(m);
    for (const e of [a, b]) {
      const st = h.hooksOf('statusApplied').find((c) => c.target === e && c.status === 'stun');
      assert.ok(st && st.duration === n.bb.stun, `${id} ${moduleId}: stun ${n.bb.stun}`);
      const d = h.hooksOf('damaged').find((c) => c.target === e && c.dmg.tags.includes('kaltsRebuild'));
      assert.ok(d && d.type === 'true' && d.amount === n.bb.value, `${id} ${moduleId}: ${n.bb.value} true`);
    }
    assert.equal(h.hooksOf('damaged').filter((c) => c.target === far && c.dmg.tags.includes('kaltsRebuild')).length, 0, 'outside the 3×3: nothing');
    done(h);
  }
  assert.deepEqual([rebuildNums(ID6).bb.stun, rebuildNums(ID6).bb.value], [3, 1200], 'normal data');
  assert.ok(rebuildNums(ELITE6).bb.value > rebuildNums(ELITE6, 'none').bb.value, 'PHY-X upgrades it');
});

test('凯尔希 T2 + PHY-X: also the first time per deployment Mon3tr falls below hp_ratio (when the token data has it)', () => {
  assert.ok(rebuildNums(ELITE6).bb.hp_ratio > 0, 'tier VI PHY-X data');
  for (const id of [ELITE5, ELITE6]) {
    for (const moduleId of [null, 'none', ...(rec(id).modules ?? []).map((m) => m.uniEquipId)]) {
      const thr = num(rebuildNums(id, moduleId).bb.hp_ratio);
      const h = run({ units: [K(id, 'skchr_kalts_1', 10, 4, { moduleId }), M(10, 6)], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
      h.run(0.5);
      const m = h.unit(2), e = h.b.enemies[0];
      const bursts = () => h.hooksOf('damaged').filter((c) => c.dmg.tags.includes('kaltsRebuild')).length;
      if (thr > 0) {
        h.b.dealDamage(e, m, { amount: m.s.maxHp * (1 - thr) * 0.5, type: 'true' });
        assert.equal(bursts(), 0, `${id} ${moduleId}: above the threshold: nothing`);
      }
      h.b.dealDamage(e, m, { amount: m.s.maxHp * (thr > 0 ? 1 - thr / 2 : 0.8) - (m.s.maxHp - m.hp), type: 'true' });
      assert.equal(bursts(), thr > 0 ? 1 : 0, `${id} ${moduleId}: below ${thr}`);
      m.hp = m.s.maxHp;
      h.b.dealDamage(e, m, { amount: m.s.maxHp * 0.8, type: 'true' });
      assert.equal(bursts(), thr > 0 ? 1 : 0, `${id} ${moduleId}: only the first time of the deployment`);
      done(h);
    }
  }
});

test('凯尔希 modules: PHY-X heal ×heal_scale below hp_ratio, PHY-Y ×heal_scale on ground units, ISW-A / none nothing', () => {
  for (const id of [ELITE5, ELITE6]) {
    const healOf = (moduleId, hpPct) => {
      const h = run({ units: [K(id, 'skchr_kalts_1', 10, 4, { moduleId }), { uid: 3, chessId: 'test_guard_a', row: 10, col: 5, carryState: { hpPct } }] });
      const u = h.unit(1);
      h.runUntil(() => h.hooksOf('heal').some((c) => c.source === u), 10);
      const c = h.hooksOf('heal').find((x) => x.source === u);
      done(h);
      return c.amount / u.s.atk;
    };
    const tx = loadout(id, PHYX).trait.bb, ty = loadout(id, PHYY).trait.bb;
    const thr = num(tx.hp_ratio) || 0.5;
    close(healOf(null, thr - 0.1), tx.heal_scale ?? 1, 1e-9, `${id} PHY-X below hp_ratio`);
    close(healOf(null, thr + 0.1), 1, 1e-9, `${id} PHY-X above hp_ratio`);
    close(healOf(PHYY, 0.9), ty.heal_scale ?? 1, 1e-9, `${id} PHY-Y ground ally`);
    close(healOf(ISWA, 0.2), 1, 1e-9, `${id} ISW-A: 集成战略-only`);
    close(healOf('none', 0.2), 1, 1e-9, `${id} module none`);
  }
  assert.ok(loadout(ELITE6, PHYX).trait.bb.heal_scale > 1 && loadout(ELITE6, PHYY).trait.bb.heal_scale > 1, 'tier VI data');
  // the normal chess has no module
  const h = run({ units: [K(ID6, 'skchr_kalts_1', 10, 4), { uid: 3, chessId: 'test_guard_a', row: 10, col: 5, carryState: { hpPct: 0.2 } }] });
  h.runUntil(() => h.hooksOf('heal').some((c) => c.source === h.unit(1)), 10);
  close(h.hooksOf('heal').find((c) => c.source === h.unit(1)).amount / h.unit(1).s.atk, 1, 1e-9, 'normal: no module');
});

test('凯尔希: every skill × tier (with her hand pieces placed: GameData.placeableTokens) survives a real wave without content errors and casts', () => {
  for (const id of [ID5, ID6, ELITE5, ELITE6]) {
    for (const s of rec(id).skills) {
      const h = makeBattle({ defs: DEFS, seed: 3, timeLimit: 60,
        units: [K(id, s.skillId, 10, 4, { carryState: { sp: 999 } }), ...handPieces(id, s.index), { uid: 3, chessId: 'chess_char_2_06_a', row: 11, col: 5 }],
        enemies: [{ key: 'enemy_1007_slime', count: 8, interval: 1.5 }, { key: 'enemy_1007_slime', route: 1, count: 8, interval: 1.5, time: 3 }] });
      h.runToEnd(90);
      done(h);
      assert.ok(h.unit(1).skill.activations > 0, `${id} ${s.skillId} casts`);
    }
  }
});
