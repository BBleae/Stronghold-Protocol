// test/content/waiguan/char_479_sleach.test.js — 琴柳 外援 kit (server/sim/content/kits/waiguan/char_479_sleach.js).
// Every skill (normal Lv4 + elite Lv7, both tiers), both talents (BEA-Y upgrade), both modules + none, the cast rules,
// DP amounts / timing through the player's DP, two copies and two players on one field, a smoke wave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, chessRec, checkInvariants } from '../../helpers/battleHarness.js';
import { DataSource, getDefaultSource } from '../../../server/sim/simdata.js';
import { getData } from '../../../server/data.js';
import { waiguanRecords } from '../../../shared/waiguan.js';
import { skillSpecSource } from '../../../server/sim/content/index.js';
import { TICK } from '../../../server/sim/constants.js';
import WAIGUAN from '../../../server/sim/content/kits/waiguan/index.js';

const CHAR = 'char_479_sleach';
const ID5 = `chess_char_diy_5_${CHAR}_a`, ID6 = `chess_char_diy_6_${CHAR}_a`;
const ELITE5 = ID5.replace(/_a$/, '_b'), ELITE6 = ID6.replace(/_a$/, '_b');
const BEA_X = 'uniequip_002_sleach', BEA_Y = 'uniequip_003_sleach';
const S1 = 'skcom_assist_cost[3]', S2 = 'skchr_sleach_2', S3 = 'skchr_sleach_3';
const REC = waiguanRecords(getData({ log: { warn() {}, error() {}, info() {} } }).waiguan);
const DS = new DataSource({ chess: REC }, getDefaultSource());
const rec = (id) => REC[id];
const skillOf = (id, sid) => rec(id).skills.find((s) => s.skillId === sid);
/** Loadout-resolved record (module `moduleId`: null = default, 'none', or an id). */
const raw = (id, moduleId = null) => DS.getChess(id, { moduleId }).raw;
const talOf = (id, i, moduleId = null) => raw(id, moduleId).talents.find((t) => t.index === i)?.bb ?? {};
const traitOf = (id, moduleId = null) => raw(id, moduleId).trait?.bb ?? {};
const hiddenCost = (id, moduleId = null) => raw(id, moduleId).talents.find((t) => t.hidden)?.bb?.cost ?? 0;
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e7, speed: 0, ...o });
const op = (id, profession, o = {}) => chessRec({ id, profession, skill: null, stats: { maxHp: 3000, atk: 1, def: 100, cost: 10, respawnTime: 2, ...o } });
const DEFS = {
  chess: { ...REC, test_guard_a: op('test_guard_a', 'WARRIOR'), test_sniper_a: op('test_sniper_a', 'SNIPER', { cost: 9 }) },
  enemies: {
    enemy_dummy: dummy('enemy_dummy'),
    enemy_fly: dummy('enemy_fly', { motion: 'FLY' }),
    // walks route 0 (row 9, right → left), harmless
    enemy_walker: enemyRec({ key: 'enemy_walker', hp: 1e7, speed: 1, atk: 0 }),
  },
};
const HOOKS = ['damaged', 'heal', 'skillStart', 'skillEnd', 'attack', 'statusApplied', 'deploy'];
const NO_DP = { dpInit: 0, dpPerSec: 0 };
const run = (o) => makeBattle({ defs: DEFS, seed: 7, timeLimit: 300, autoFinish: false, hooks: HOOKS, captureNoisy: true, ...o });
const U = (id, sid, row, col, o = {}) => ({ chessId: id, row, col, skillIndex: skillOf(id, sid).index, ...o });
const done = (h) => { checkInvariants(h.b); assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0])); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const has = (c, tag) => !!c.dmg?.tags?.includes(tag);
const dpOf = (h, p = 'p1') => h.b.getPlayer(p).dp;
const ids = (list) => list.map((x) => x.id).sort((a, b) => a - b);
/** Step `seconds`, logging every change of player `p`'s DP as [battle time after the step, delta]. */
function dpLog(h, seconds, p = 'p1') {
  const out = [];
  let last = dpOf(h, p);
  for (let i = 0, n = Math.round(seconds / TICK); i < n; i++) {
    h.step(1);
    const now = dpOf(h, p);
    if (Math.abs(now - last) > 1e-9) { out.push([h.b.time, now - last]); last = now; }
  }
  return out;
}
const ELITES = [ELITE5, ELITE6];
/** Normal chess and elite of both tiers. */
const ALL = [ID5, ID6, ELITE5, ELITE6];
/** Every module choice of an elite (default, none, each id); a normal chess: the default only. */
const modsOf = (id) => (id.endsWith('_b') ? [null, 'none', BEA_X, BEA_Y] : [null]);

test('琴柳: every skill of both tiers (normal + elite, every module) is hand-authored', () => {
  for (const id of [ID5, ID6]) {
    assert.equal(typeof WAIGUAN[id], 'function', `${id} registered`);
    for (const cid of [id, id.replace(/_a$/, '_b')]) {
      for (const s of rec(cid).skills) for (const moduleId of modsOf(cid)) {
        assert.equal(skillSpecSource(DS.getChess(cid, { skillIndex: s.index, moduleId }), WAIGUAN), 'skills', `${cid} ${s.skillId} ${moduleId}`);
      }
    }
  }
});

test('琴柳 triggers: 执旗手 SP_FULL kept for S1 / S2 — cast the tick SP fills, no enemy needed', () => {
  for (const id of ALL) for (const sid of [S1, S2]) {
    const s = skillOf(id, sid);
    assert.equal(s.trigger.rule, 'SP_FULL');
    const h = run({ units: [U(id, sid, 10, 4)] });
    const u = h.unit(id);
    assert.equal(u.skill.rule, 'SP_FULL');
    assert.ok(h.runUntil(() => u.skill.active, s.spCost + 2), `${id} ${sid} casts`);
    const t = h.hooksOf('skillStart')[0];
    assert.equal(t.reason, 'SP_FULL');
    assert.ok(Math.abs(t.t - (s.spCost - s.initSp)) <= TICK + 1e-6, `${id} ${sid} at ${t.t} (SP ${s.initSp} → ${s.spCost})`);
    done(h);
  }
});

test('琴柳 S3 trigger: SP_FULL gated by a ground enemy on its 2-1 range (flyers / enemies off the range do not count)', () => {
  for (const id of [ID6, ELITE6]) {
    const s = skillOf(id, S3);
    assert.equal(s.trigger.rule, 'SP_FULL', 'the record keeps the 执旗手 row');
    // (10,4) facing right: 2-1 = (12,4) (11,4) (11,5) (10,4) (10,5) (10,6) (9,4) (9,5) (8,4)
    const h = run({ units: [U(id, S3, 10, 4, { carryState: { sp: 999 } })], enemies: [{ key: 'enemy_fly', pos: [10, 5] }, { key: 'enemy_dummy', pos: [10, 7] }, { key: 'enemy_dummy', pos: [11, 6] }] });
    const u = h.unit(id);
    assert.equal(u.skill.rule, 'NEVER', 'cast by the kit');
    h.run(5);
    assert.ok(u.skill.ready && !u.skill.active && u.skill.activations === 0, 'a flyer on the range and ground enemies off it: no cast');
    h.spawn('enemy_dummy', { pos: [9, 5] });
    const t0 = h.b.time;
    h.step(1);
    assert.ok(u.skill.active, 'cast the tick a ground enemy is on the range');
    assert.equal(h.hooksOf('skillStart')[0].t, t0);
    assert.equal(h.hooksOf('skillStart')[0].reason, 'SP_FULL');
    done(h);
  }
  // the automatic-operation cooldown of the battle-start deployment holds the kit's cast too (and S1's SP_FULL)
  for (const sid of [S1, S3]) {
    const h = run({ flags: { startOpCooldown: 3 }, units: [U(ELITE6, sid, 10, 4, { carryState: { sp: 999 } })], enemies: [{ key: 'enemy_dummy', pos: [10, 5] }] });
    const u = h.unit(ELITE6);
    assert.ok(h.runUntil(() => u.skill.active, 5));
    assert.ok(Math.abs(h.hooksOf('skillStart')[0].t - 3) <= TICK + 1e-6, `${sid} at ${h.hooksOf('skillStart')[0].t}`);
    done(h);
  }
});

test('琴柳 S1 支援号令·γ型: +cost DP every interval, value in all, no attack; normal + elite numbers', () => {
  for (const id of [ID6, ELITE6]) {
    const s = skillOf(id, S1), b = s.bb;
    const h = run({ flags: NO_DP, units: [U(id, S1, 10, 4, { carryState: { sp: 999 } })], enemies: [{ key: 'enemy_dummy', pos: [10, 5] }] });
    const u = h.unit(id);
    const log = dpLog(h, s.duration + 1);
    const t0 = h.hooksOf('skillStart')[0].t;
    assert.equal(log.length, b.value / b.cost);
    log.forEach(([t, d], k) => {
      assert.ok(near(d, b.cost), `grant ${k}: ${d}`);
      assert.ok(Math.abs(t - (t0 + TICK + (k + 1) * b.interval)) <= TICK + 1e-6, `grant ${k + 1} at ${t}`);
    });
    assert.ok(near(dpOf(h), b.value), `total ${dpOf(h)}`);
    assert.ok(near(h.hooksOf('skillEnd')[0].t - t0, s.duration, 1e-3), 'ends after its duration');
    assert.equal(h.hooksOf('attack').filter((c) => c.attacker === u && c.t >= t0 && c.t < t0 + s.duration).length, 0, 'stops attacking');
    assert.ok(h.hooksOf('attack').some((c) => c.attacker === u && c.t >= t0 + s.duration - 1e-6), 'attacks again after');
    done(h);
  }
});

test('琴柳 S1: a knock-out ends the drip (no rest); the DP cap holds', () => {
  const s = skillOf(ELITE6, S1), b = s.bb;
  const h = run({ flags: NO_DP, units: [U(ELITE6, S1, 10, 4, { carryState: { sp: 999 } })] });
  const u = h.unit(ELITE6);
  h.step(1);
  const t0 = h.hooksOf('skillStart')[0].t;
  h.run(3);
  h.b.kill(u);
  const got = dpOf(h);
  assert.equal(got, Math.floor((h.b.time - t0 - TICK) / b.interval + 1e-9) * b.cost);
  h.run(8);
  assert.equal(dpOf(h), got, 'nothing after the knock-out');
  assert.equal(h.hooksOf('skillEnd')[0].reason, 'death');
  done(h);
  const g = run({ flags: { dpInit: 95, dpPerSec: 0, dpMax: 99 }, units: [U(ELITE6, S1, 10, 4, { carryState: { sp: 999 } })] });
  g.run(s.duration + 1);
  assert.equal(dpOf(g), 99, 'capped at dpMax');
  done(g);
});

test('琴柳 S2 信仰传承: DP drip (value in all, by the natural end); the flag on the weakest operator of x-1: DEF +, heal per s', () => {
  for (const id of [ID6, ELITE6]) {
    const s = skillOf(id, S2), b = s.bb;
    // her (10,4); A (10,6) 50 % and B (9,4) 80 % on x-1; C (10,7) 30 % off it; E (11,3) next to her only
    const h = run({ flags: NO_DP, units: [U(id, S2, 10, 4, { uid: 1 }), { uid: 2, chessId: 'test_guard_a', row: 10, col: 6 },
      { uid: 3, chessId: 'test_guard_a', row: 9, col: 4 }, { uid: 4, chessId: 'test_guard_a', row: 10, col: 7 }, { uid: 5, chessId: 'test_guard_a', row: 11, col: 3 }] });
    const [u, A, B, C, E] = [1, 2, 3, 4, 5].map((i) => h.unit(i));
    h.step(1);
    A.hp = A.s.maxHp * 0.5; B.hp = B.s.maxHp * 0.8; C.hp = C.s.maxHp * 0.3;
    const vAlly = talOf(id, 0)['sleach_t_1[ally].attack_speed'];
    h.run(0.5);
    assert.ok(u.s.aspd === 100 + vAlly && E.s.aspd === 100 + vAlly && A.s.aspd === 100 && C.s.aspd === 100, 'the flag on her first');
    u.skill.addCharge(1);
    const log = dpLog(h, 0.5);
    assert.ok(u.skill.active);
    const t0 = h.hooksOf('skillStart')[0].t;
    assert.equal(u.findBuff('sleach:faith'), null);
    assert.equal(A.findBuff('sleach:faith').source, u, 'A: the lowest HP ratio on the skill range');
    assert.ok(near(A.s.def, A.base.def * (1 + b.def)) && B.s.def === B.base.def && C.s.def === C.base.def);
    // the flag (and its aura) moved to A's tile: A and C (on its 3×3) get the ASPD, she and E lost it
    assert.ok(A.s.aspd === 100 + vAlly && C.s.aspd === 100 + vAlly && u.s.aspd === 100 && E.s.aspd === 100, `aura moved ${u.s.aspd}`);
    log.push(...dpLog(h, s.duration + 1));
    const heals = h.hooksOf('heal').filter((c) => c.source === u);
    assert.equal(heals.length, Math.floor(s.duration), 'one heal per second');
    heals.forEach((c, k) => {
      assert.equal(c.target, A);
      assert.ok(near(c.amount, u.s.atk * b.atk_to_hp_recovery_ratio), `heal ${c.amount}`);
      assert.ok(Math.abs(c.t - (t0 + k + 1)) <= TICK + 1e-6, `heal ${k + 1} at ${c.t}`);
    });
    const per = b['sleach_s_2[cost].cost'], iv = b['sleach_s_2[cost].interval'];
    assert.equal(log.length, b.value / per);
    log.forEach(([t, d], k) => { assert.ok(near(d, per)); assert.ok(Math.abs(t - (t0 + TICK + (k + 1) * iv)) <= TICK + 1e-6, `grant ${k + 1} at ${t}`); });
    assert.ok(near(dpOf(h), b.value), `total ${dpOf(h)}`);
    assert.ok(!u.skill.active && A.findBuff('sleach:faith') === null && A.s.def === A.base.def, 'gone with the skill');
    assert.ok(u.s.aspd === 100 + vAlly && E.s.aspd === 100 + vAlly && A.s.aspd === 100, 'the flag back on her');
    assert.equal(h.hooksOf('attack').filter((c) => c.attacker === u && c.t >= t0 && c.t < t0 + s.duration).length, 0);
    done(h);
  }
  // nobody hurt: the nearest — herself (her own tile, the flag stays with her)
  const h = run({ units: [U(ELITE6, S2, 10, 4, { carryState: { sp: 999 } }), { chessId: 'test_guard_a', row: 10, col: 5 }] });
  const u = h.unit(ELITE6);
  h.step(2);
  assert.equal(u.findBuff('sleach:faith')?.source, u);
  assert.ok(near(u.s.def, u.base.def * (1 + skillOf(ELITE6, S2).bb.def)));
  done(h);
});

test('琴柳 S3 光辉旗帜: +cost DP at once; impact on the 3×3 of a ground enemy, then 停顿 + 脆弱 there for the skill', () => {
  for (const id of [ID6, ELITE6]) {
    const s = skillOf(id, S3), b = s.bb;
    assert.ok(near(b.damage_scale - 1, b['debuff.damage_scale']));
    // G (10,6) on the 2-1 range = the target; H (11,7) and the flyer F (9,6) on G's 3×3; Z (12,9) away
    const h = run({ flags: NO_DP, units: [U(id, S3, 10, 4, { carryState: { sp: 999 } })],
      enemies: [{ key: 'enemy_dummy', pos: [10, 6] }, { key: 'enemy_dummy', pos: [11, 7] }, { key: 'enemy_fly', pos: [9, 6] }, { key: 'enemy_dummy', pos: [12, 9] }] });
    const u = h.unit(id);
    h.step(1);
    const [G, H, F, Z] = h.b.enemies;
    assert.ok(u.skill.active, 'cast in the first tick: G stands on the 2-1 range');
    assert.equal(dpOf(h), b.cost, 'DP at the cast');
    const t0 = h.hooksOf('skillStart')[0].t;
    const imp = h.hooksOf('damaged').filter((c) => c.source === u && has(c, 'sleachBanner'));
    assert.deepEqual(ids(imp.map((c) => c.target)), ids([G, H, F]), 'the 3×3 around G, the flyer too, not Z');
    for (const c of imp) { assert.equal(c.type, 'phys'); assert.ok(near(c.amount, u.s.atk * b.atk_scale), `impact ${c.amount} (before the 脆弱)`); }
    const stun = h.hooksOf('statusApplied').filter((c) => c.source === u && c.status === 'stun');
    assert.deepEqual(ids(stun.map((c) => c.target)), ids([G, H, F]));
    assert.ok(stun.every((c) => c.duration === b.stun));
    const vFoe = talOf(id, 0)['sleach_t_1[enemy].attack_speed'];
    h.run(1);
    for (const e of [G, H, F]) {
      assert.ok(e.findBuff('sluggish') && near(e.s.dmgTakenMul, b.damage_scale) && e.s.aspd === 100 + vFoe, `field on ${e.id}`);
    }
    assert.ok(!Z.findBuff('sluggish') && Z.s.dmgTakenMul === 1 && Z.s.aspd === 100);
    assert.ok(h.runUntil(() => !u.skill.active, s.duration + 1));
    assert.ok(near(h.hooksOf('skillEnd')[0].t - t0, s.duration, 1e-3));
    assert.equal(dpOf(h), b.cost, 'no more DP');
    h.run(0.5);
    for (const e of [G, H, F]) assert.ok(!e.findBuff('sluggish') && e.s.dmgTakenMul === 1 && e.s.aspd === 100, 'the flag came back');
    assert.equal(h.hooksOf('attack').filter((c) => c.attacker === u && c.t >= t0 && c.t < t0 + s.duration).length, 0);
    done(h);
  }
});

test('琴柳 two copies: S2 on one operator — the stronger DEF only, healed by its holder only; S3 fields — 脆弱 not stacked', () => {
  const lo = skillOf(ID6, S2).bb, hi = skillOf(ELITE6, S2).bb;
  assert.ok(hi.def > lo.def);
  // the guard (10,5) is the only hurt operator on both x-1 ranges; the weaker 琴柳 casts first
  const h = run({ units: [U(ID6, S2, 10, 4, { uid: 1 }), U(ELITE6, S2, 10, 6, { uid: 2, dir: 'LEFT' }), { uid: 3, chessId: 'test_guard_a', row: 10, col: 5 }] });
  h.step(1);
  const [a, b, g] = [1, 2, 3].map((i) => h.unit(i));
  g.hp = g.s.maxHp * 0.5;
  a.skill.addCharge(1);
  h.step(10);
  b.skill.addCharge(1);
  h.step(1);
  assert.ok(a.skill.active && b.skill.active);
  const t1 = h.b.time;
  for (let i = 0; i < 90; i++) {
    h.step(1);
    assert.ok(near(g.s.def, g.base.def * (1 + hi.def)), `step ${i}: DEF ${g.s.def}`);
    assert.equal(g.findBuff('sleach:faith').source, b);
  }
  const heals = h.hooksOf('heal').filter((c) => c.target === g && c.t >= t1);
  assert.ok(heals.length >= 2 && heals.every((c) => c.source === b), 'only the holder heals');
  done(h);
  // two equal 琴柳: the first holder keeps it — one heal per second, never two
  const e = run({ units: [U(ELITE6, S2, 10, 4, { uid: 1 }), U(ELITE6, S2, 10, 6, { uid: 2, dir: 'LEFT' }), { uid: 3, chessId: 'test_guard_a', row: 10, col: 5 }] });
  e.step(1);
  const [p, q, x] = [1, 2, 3].map((i) => e.unit(i));
  x.hp = x.s.maxHp * 0.2;
  p.skill.addCharge(1);
  e.step(7);
  q.skill.addCharge(1);
  e.step(1);
  assert.ok(p.skill.active && q.skill.active);
  const t2 = e.b.time;
  e.run(8);
  const hs = e.hooksOf('heal').filter((c) => c.target === x && c.t >= t2);
  assert.ok(hs.length >= 7 && hs.length <= 8 && hs.every((c) => c.source === p), `${hs.map((c) => c.source.id)}`);
  assert.equal(x.findBuff('sleach:faith').source, p);
  done(e);
  // two S3 fields on one enemy: 脆弱 is "同名效果取最高"
  const k = run({ units: [U(ID6, S3, 10, 4, { carryState: { sp: 999 } }), U(ELITE6, S3, 10, 8, { carryState: { sp: 999 }, dir: 'LEFT' })], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
  k.run(1);
  assert.ok(k.b.allyUnits.every((x) => x.skill.active));
  assert.ok(near(k.b.enemies[0].s.dmgTakenMul, skillOf(ELITE6, S3).bb.damage_scale), `${k.b.enemies[0].s.dmgTakenMul}`);
  done(k);
});

test('琴柳 T1 不退之旗: operators / enemies on the 3×3 around her ASPD ± (record values per loadout); two copies: the stronger', () => {
  for (const [id, moduleId] of [[ID5, undefined], [ID6, undefined], [ELITE5, null], [ELITE6, null], [ELITE6, 'none'], [ELITE6, BEA_Y]]) {
    const t0 = talOf(id, 0, moduleId);
    const vA = t0['sleach_t_1[ally].attack_speed'], vE = t0['sleach_t_1[enemy].attack_speed'];
    assert.ok(vA > 0 && vE < 0);
    const h = run({ units: [U(id, S1, 10, 4, moduleId !== undefined ? { moduleId } : {}), { uid: 2, chessId: 'test_guard_a', row: 9, col: 5 }, { uid: 3, chessId: 'test_guard_a', row: 10, col: 6 }],
      enemies: [{ key: 'enemy_dummy', pos: [11, 3] }, { key: 'enemy_dummy', pos: [10, 7] }] });
    h.run(1);
    const u = h.unit(id), [eIn, eOut] = h.b.enemies;
    assert.equal(u.s.aspd, 100 + vA, `${id} ${moduleId}: herself`);
    assert.equal(h.unit(2).s.aspd, 100 + vA);
    assert.equal(h.unit(3).s.aspd, 100, 'off the 3×3');
    assert.equal(eIn.s.aspd, 100 + vE);
    assert.equal(eOut.s.aspd, 100);
    done(h);
  }
  assert.ok(talOf(ELITE6, 0)['sleach_t_1[ally].attack_speed'] > talOf(ID6, 0)['sleach_t_1[ally].attack_speed']);
  // two 琴柳 (10 and 13): the guard / the enemy between them get the stronger one only, every tick
  const h = run({ units: [U(ID6, S1, 10, 3, { uid: 1 }), U(ELITE6, S1, 10, 5, { uid: 2 }), { uid: 3, chessId: 'test_guard_a', row: 10, col: 4 }],
    enemies: [{ key: 'enemy_dummy', pos: [9, 4] }] });
  h.run(0.5);
  const g = h.unit(3), e = h.b.enemies[0];
  const vA = talOf(ELITE6, 0)['sleach_t_1[ally].attack_speed'], vE = talOf(ELITE6, 0)['sleach_t_1[enemy].attack_speed'];
  for (let i = 0; i < 60; i++) {
    h.step(1);
    assert.equal(g.s.aspd, 100 + vA, `step ${i}: ${g.s.aspd}`);
    assert.equal(e.s.aspd, 100 + vE);
  }
  assert.equal(g.buffs.filter((x) => x.key === 'sleach:flag').length, 1);
  done(h);
});

test('琴柳 T2 精神感召: deployed last, the next redeploy of her player costs value less (once); BEA-Y: +cost DP if ground', () => {
  for (const [id, moduleId] of [[ID6, undefined], [ELITE6, null], [ELITE6, 'none'], [ELITE6, BEA_Y], [ELITE5, BEA_Y]]) {
    const cut = -talOf(id, 1, moduleId).value, bonus = moduleId === BEA_Y ? hiddenCost(id, moduleId) : 0;
    assert.equal(cut, 2);
    // the guards (col 3) deploy before her (col 6): her cut waits for the first redeploy
    const h = run({ flags: { dpInit: 50, dpPerSec: 0 }, units: [U(id, S1, 10, 6, moduleId !== undefined ? { moduleId, uid: 1 } : { uid: 1 }),
      { uid: 2, chessId: 'test_guard_a', row: 10, col: 3 }, { uid: 3, chessId: 'test_guard_a', row: 11, col: 3 }] });
    h.step(1);
    assert.equal(dpOf(h), 50, 'the battle-start deployments do not touch it (she came last)');
    const [g1, g2] = [h.unit(2), h.unit(3)];
    h.b.kill(g1);
    h.b.kill(g2);
    assert.equal(g1.base.cost, 10 - cut, 'a waiting operator of hers costs less');
    assert.ok(h.runUntil(() => g1.alive && g2.alive, 5));
    // the first one redeployed pays 10 − cut (+ bonus DP when BEA-Y), the second the full 10
    assert.equal(dpOf(h), 50 - (10 - cut) + bonus - 10, `${id} ${moduleId}: ${dpOf(h)}`);
    assert.ok(g1.base.cost === 10 && g2.base.cost === 10, 'costs restored');
    h.b.kill(g1);
    assert.equal(g1.base.cost, 10, 'used up');
    assert.ok(h.runUntil(() => g1.alive, 5));
    assert.equal(dpOf(h), 50 - (10 - cut) + bonus - 20);
    done(h);
  }
  assert.equal(hiddenCost(ELITE5, BEA_Y), 0, 'tier V BEA-Y (level 1) has no DP part');
  assert.ok(hiddenCost(ELITE6, BEA_Y) > 0);
});

test('琴柳 T2: the operator deployed right after her consumes it (battle start); BEA-Y only for a ground one; gone when she leaves', () => {
  const bonus = hiddenCost(ELITE6, BEA_Y);
  // her (10,3) then the guard (10,5): the guard's free battle-start deployment used it up (+bonus DP for a ground one)
  for (const [next, gain] of [['test_guard_a', bonus], ['test_sniper_a', 0]]) {
    const h = run({ flags: { dpInit: 50, dpPerSec: 0 }, units: [U(ELITE6, S1, 10, 3, { moduleId: BEA_Y, uid: 1 }), { uid: 2, chessId: next, row: 10, col: 5 }, { uid: 3, chessId: 'test_guard_a', row: 10, col: 6 }] });
    h.step(1);
    assert.equal(dpOf(h), 50 + gain, `${next}: ${dpOf(h)}`);
    const g = h.unit(3);
    h.b.kill(g);
    assert.equal(g.base.cost, 10);
    assert.ok(h.runUntil(() => g.alive, 5));
    assert.equal(dpOf(h), 50 + gain - 10);
    done(h);
  }
  // she leaves the field before anyone else deploys: the cut ends with her
  const h = run({ flags: { dpInit: 50, dpPerSec: 0 }, units: [U(ELITE6, S1, 10, 6, { moduleId: BEA_Y, uid: 1 }), { uid: 2, chessId: 'test_guard_a', row: 10, col: 3 }] });
  h.step(1);
  const [u, g] = [h.unit(1), h.unit(2)];
  h.b.kill(g);
  assert.equal(g.base.cost, 8);
  h.b.kill(u);
  assert.equal(g.base.cost, 10, 'restored when she is knocked out');
  assert.ok(h.runUntil(() => g.alive, 5));
  assert.equal(dpOf(h), 40);
  done(h);
});

test('琴柳 T2 two copies: one cut at a time (−value, never doubled); two players: only her player\'s operators', () => {
  // A (10,3) arms, the guard (10,4) consumes it at the start, B (10,6) arms: the guard's redeploy costs 8, not 6
  const h = run({ flags: { dpInit: 50, dpPerSec: 0 }, units: [U(ID6, S1, 10, 3, { uid: 1 }), { uid: 2, chessId: 'test_guard_a', row: 10, col: 4 }, U(ELITE6, S1, 10, 6, { uid: 3 })] });
  h.step(1);
  const g = h.unit(2);
  h.b.kill(g);
  assert.equal(g.base.cost, 8);
  assert.ok(h.runUntil(() => g.alive, 5));
  assert.equal(dpOf(h), 42);
  done(h);
  // the later copy's own handler runs first at its deployment (listed first): it consumes the earlier cut and arms its
  // own, which the other copy's handler must leave alone — the guard (10,2), deployed before both, still gets it
  const k2 = run({ flags: { dpInit: 50, dpPerSec: 0 }, units: [U(ELITE6, S1, 10, 6, { uid: 1 }), U(ID6, S1, 10, 3, { uid: 2 }), { uid: 3, chessId: 'test_guard_a', row: 10, col: 2 }] });
  k2.step(1);
  const g2 = k2.unit(3);
  k2.b.kill(g2);
  assert.equal(g2.base.cost, 8, 'the last-deployed copy\'s cut stands');
  assert.ok(k2.runUntil(() => g2.alive, 5));
  assert.equal(dpOf(k2), 42);
  done(k2);
  // two players on one field: p1 her (BEA-Y, deployed last) + a guard; p2 a guard
  const players = [
    { playerId: 'p1', seat: 0, side: 'L', colOffset: 0, bonds: {}, units: [
      { uid: 1, kind: 'chess', chessId: ELITE6, moduleId: BEA_Y, skillIndex: skillOf(ELITE6, S1).index, row: 10, col: 6 }, { uid: 2, kind: 'chess', chessId: 'test_guard_a', row: 10, col: 3 }] },
    { playerId: 'p2', seat: 1, side: 'L', colOffset: 8, bonds: {}, units: [{ uid: 3, kind: 'chess', chessId: 'test_guard_a', row: 10, col: 3 }] },
  ];
  const k = run({ kind: 'unite', players, flags: { dpInit: 50, dpPerSec: 0 } });
  k.step(1);
  const [mine, theirs] = [k.unit(2), k.unit(3)];
  k.b.kill(theirs);
  assert.equal(theirs.base.cost, 10, 'a teammate\'s operator: no cut');
  k.b.kill(mine);
  assert.equal(mine.base.cost, 8);
  assert.ok(k.runUntil(() => mine.alive && theirs.alive, 5));
  assert.equal(dpOf(k, 'p2'), 40, 'p2 pays in full, gains nothing');
  assert.equal(dpOf(k, 'p1'), 50 - 8 + hiddenCost(ELITE6, BEA_Y));
  done(k);
});

test('琴柳 two players: skill DP goes to her player; the flag aura is positional (a teammate\'s operator next to her too)', () => {
  const players = [
    { playerId: 'p1', seat: 0, side: 'L', colOffset: 0, bonds: {}, units: [
      { uid: 1, kind: 'chess', chessId: ELITE6, skillIndex: skillOf(ELITE6, S1).index, row: 10, col: 10, carryState: { sp: 999 } }] },
    { playerId: 'p2', seat: 1, side: 'L', colOffset: 8, bonds: {}, units: [{ uid: 2, kind: 'chess', chessId: 'test_guard_a', row: 10, col: 3 }] },
  ];
  const h = run({ kind: 'unite', players, flags: NO_DP });
  h.run(skillOf(ELITE6, S1).duration + 1);
  const u = h.unit(1), g = h.unit(2);
  assert.equal(g.tileC, u.tileC + 1, 'neighbours across the players\' halves');
  assert.equal(dpOf(h, 'p1'), skillOf(ELITE6, S1).bb.value);
  assert.equal(dpOf(h, 'p2'), 0);
  assert.equal(g.s.aspd, 100 + talOf(ELITE6, 0)['sleach_t_1[ally].attack_speed']);
  done(h);
});

test('琴柳 module BEA-X: the operator in front block +block_cnt while a skill runs (she blocks 0); none / BEA-Y: no', () => {
  for (const E of ELITES) for (const moduleId of [null, 'none', BEA_Y]) {
    const bc = traitOf(E, moduleId).block_cnt ?? 0;
    assert.equal(bc > 0, moduleId === null, `${E} ${moduleId}`);
    const h = run({ units: [U(E, S1, 10, 4, { moduleId, carryState: { sp: 999 }, uid: 1 }), { uid: 2, chessId: 'test_guard_a', row: 10, col: 5 }, { uid: 3, chessId: 'test_guard_a', row: 10, col: 3 }] });
    const [u, front, back] = [1, 2, 3].map((i) => h.unit(i));
    h.step(1);
    assert.ok(u.skill.active);
    assert.equal(u.s.blockCnt, 0, 'bearer trait: block 0');
    assert.equal(front.s.blockCnt, front.base.blockCnt + bc);
    assert.equal(back.s.blockCnt, back.base.blockCnt);
    h.run(3);
    assert.equal(front.s.blockCnt, front.base.blockCnt + bc, 'held through the skill');
    assert.ok(h.runUntil(() => !u.skill.active, 10));
    h.step(1);
    assert.equal(front.s.blockCnt, front.base.blockCnt, 'gone at its end');
    assert.equal(u.s.blockCnt, u.base.blockCnt);
    done(h);
  }
  // two 琴柳 facing one operator: +block_cnt once
  const h = run({ units: [U(ELITE6, S1, 10, 4, { carryState: { sp: 999 }, uid: 1 }), U(ELITE6, S1, 10, 6, { carryState: { sp: 999 }, uid: 2, dir: 'LEFT' }), { uid: 3, chessId: 'test_guard_a', row: 10, col: 5 }] });
  h.step(1);
  const g = h.unit(3);
  assert.ok(h.unit(1).skill.active && h.unit(2).skill.active);
  for (let i = 0; i < 30; i++) { h.step(1); assert.equal(g.s.blockCnt, g.base.blockCnt + traitOf(ELITE6).block_cnt); }
  done(h);
});

test('琴柳 module BEA-Y: 迷彩 while a skill runs; none / BEA-X: never', () => {
  for (const E of ELITES) for (const moduleId of [null, 'none', BEA_Y]) for (const sid of [S1, S2, S3]) {
    const h = run({ units: [U(E, sid, 10, 4, { moduleId, carryState: { sp: 999 } })], enemies: [{ key: 'enemy_dummy', pos: [10, 5] }] });
    const u = h.unit(E);
    h.step(1);
    assert.ok(u.skill.active, `${E} ${moduleId} ${sid}`);
    assert.equal(!!u.s.flags.camou, moduleId === BEA_Y);
    assert.ok(h.runUntil(() => !u.skill.active, 20));
    assert.equal(!!u.s.flags.camou, false);
    done(h);
  }
});

test('琴柳 matrix: both tiers × every module (none included) × every skill — DP, trait part and flag value from the record', () => {
  for (const id of ALL) for (const moduleId of modsOf(id)) for (const sid of [S1, S2, S3]) {
    const s = skillOf(id, sid), b = s.bb;
    const type = id.endsWith('_b') ? (moduleId === 'none' ? null : moduleId === BEA_Y ? 'BEA-Y' : 'BEA-X') : null;
    // the skill's DP, + BEA-Y's: the ground guard (10,5) is the operator deployed right after her at the battle start
    const want = (sid === S3 ? b.cost : b.value) + (type === 'BEA-Y' ? hiddenCost(id, moduleId) : 0);
    const h = run({ flags: NO_DP, units: [U(id, sid, 10, 4, { carryState: { sp: 999 }, ...(id.endsWith('_b') ? { moduleId } : {}) }), { uid: 9, chessId: 'test_guard_a', row: 10, col: 5 }],
      enemies: [{ key: 'enemy_dummy', pos: [9, 5] }] });
    const u = h.unit(id), g = h.unit(9);
    h.step(2);
    const tag = `${id} ${moduleId} ${sid}`;
    assert.ok(u.skill.active, tag);
    assert.equal(g.s.blockCnt, g.base.blockCnt + (type === 'BEA-X' ? traitOf(id, moduleId).block_cnt : 0), `${tag} front block`);
    assert.equal(!!u.s.flags.camou, type === 'BEA-Y', `${tag} camou`);
    assert.ok(h.runUntil(() => !u.skill.active, s.duration + 1));
    h.step(1);
    assert.ok(near(dpOf(h), want), `${tag}: DP ${dpOf(h)} ≠ ${want}`);
    h.run(0.5);
    assert.equal(u.s.aspd, 100 + talOf(id, 0, id.endsWith('_b') ? moduleId : null)['sleach_t_1[ally].attack_speed'], `${tag} flag`);
    done(h);
  }
});

test('琴柳: every skill × tier survives a real wave without content errors and casts', () => {
  for (const id of ALL) for (const s of rec(id).skills) {
    const h = makeBattle({ defs: DEFS, seed: 3, timeLimit: 60,
      units: [U(id, s.skillId, 10, 4, { carryState: { sp: 999 } }), { chessId: 'chess_char_2_06_a', row: 10, col: 6 }],
      enemies: [{ key: 'enemy_1007_slime', count: 8, interval: 1.5 }, { key: 'enemy_1007_slime', route: 1, count: 8, interval: 1.5, time: 3 }] });
    h.runToEnd(90);
    done(h);
    assert.ok(h.b.allyUnits.find((x) => x.defId === id).skill.activations > 0, `${id} ${s.skillId} casts`);
  }
});
