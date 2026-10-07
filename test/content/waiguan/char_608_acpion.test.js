// test/content/waiguan/char_608_acpion.test.js — 郁金香 外援 kit (server/sim/content/kits/waiguan/char_608_acpion.js).
// Every skill (normal Lv4 + elite Lv7, both tiers), both talents (SOL-X upgrade), module SOL-X + none, the cast rules,
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

const CHAR = 'char_608_acpion';
const ID5 = `chess_char_diy_5_${CHAR}_a`, ID6 = `chess_char_diy_6_${CHAR}_a`;
const ELITE5 = ID5.replace(/_a$/, '_b'), ELITE6 = ID6.replace(/_a$/, '_b');
const SOL_X = 'uniequip_002_acpion';
const S1 = 'skchr_acpion_1', S2 = 'skchr_acpion_2', S3 = 'skchr_acpion_3';
const REC = waiguanRecords(getData({ log: { warn() {}, error() {}, info() {} } }).waiguan);
const DS = new DataSource({ chess: REC }, getDefaultSource());
const rec = (id) => REC[id];
const skillOf = (id, sid) => rec(id).skills.find((s) => s.skillId === sid);
const raw = (id, moduleId = null) => DS.getChess(id, { moduleId }).raw;
const talOf = (id, i, moduleId = null) => raw(id, moduleId).talents.find((t) => t.index === i)?.bb ?? {};
const traitOf = (id, moduleId = null) => raw(id, moduleId).trait?.bb ?? {};
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e7, speed: 0, ...o });
const DEFS = {
  chess: { ...REC, test_guard_a: chessRec({ id: 'test_guard_a', profession: 'WARRIOR', skill: null, stats: { maxHp: 3000, atk: 1e6, def: 100, bat: 1 } }) },
  enemies: {
    enemy_dummy: dummy('enemy_dummy'),
    enemy_armor: dummy('enemy_armor', { def: 400 }),
    enemy_fly: dummy('enemy_fly', { motion: 'FLY' }),
    enemy_weak: enemyRec({ key: 'enemy_weak', hp: 1, speed: 0 }),
    // walks route 0 (row 9, right → left) into her block; harmless
    enemy_walker: enemyRec({ key: 'enemy_walker', hp: 1e7, speed: 1, atk: 0 }),
  },
};
const HOOKS = ['damaged', 'skillStart', 'skillEnd', 'attack', 'kill', 'deploy'];
const NO_DP = { dpInit: 0, dpPerSec: 0 };
const run = (o) => makeBattle({ defs: DEFS, seed: 7, timeLimit: 300, autoFinish: false, hooks: HOOKS, captureNoisy: true, ...o });
const U = (id, sid, row, col, o = {}) => ({ chessId: id, row, col, skillIndex: skillOf(id, sid).index, ...o });
const done = (h) => { checkInvariants(h.b); assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0])); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const has = (c, tag) => !!c.dmg?.tags?.includes(tag);
const dpOf = (h, p = 'p1') => h.b.getPlayer(p).dp;
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
const ALL = [ID5, ID6, ELITE5, ELITE6];
const modsOf = (id) => (id.endsWith('_b') ? [null, 'none', SOL_X] : [null]);
/** Physical damage of `a` against DEF `d` with `pen` of it ignored (damage.js mitigate). */
const phys = (a, d, pen = 0) => Math.max(a - d * (1 - pen), 0.05 * a);

test('郁金香: every skill of both tiers (normal + elite, every module) is hand-authored', () => {
  for (const id of [ID5, ID6]) {
    assert.equal(typeof WAIGUAN[id], 'function', `${id} registered`);
    for (const cid of [id, id.replace(/_a$/, '_b')]) {
      for (const s of rec(cid).skills) for (const moduleId of modsOf(cid)) {
        assert.equal(skillSpecSource(DS.getChess(cid, { skillIndex: s.index, moduleId }), WAIGUAN), 'skills', `${cid} ${s.skillId} ${moduleId}`);
      }
    }
  }
});

test('郁金香 S1 钻心 (DEFAULT kept): cast with the attack on an enemy in reach; +cost DP; that attack hits max_target for atk_scale', () => {
  for (const id of [ID6, ELITE6]) {
    const s = skillOf(id, S1), b = s.bb;
    assert.equal(s.trigger.rule, 'DEFAULT');
    // nothing in reach: SP full but no cast
    const idle = run({ flags: NO_DP, units: [U(id, S1, 10, 4, { carryState: { sp: 999 } })], enemies: [{ key: 'enemy_dummy', pos: [10, 7] }] });
    idle.run(3);
    assert.equal(idle.unit(id).skill.activations, 0);
    assert.equal(dpOf(idle), 0);
    done(idle);
    // three enemies on the tile in front
    const h = run({ flags: NO_DP, units: [U(id, S1, 10, 4, { carryState: { sp: 999 } })], enemies: [0, 1, 2].map(() => ({ key: 'enemy_dummy', pos: [10, 5] })) });
    const u = h.unit(id);
    assert.equal(u.skill.rule, 'DEFAULT');
    assert.ok(h.runUntil(() => h.hooksOf('attack').some((c) => c.attacker === u), 3));
    const cast = h.hooksOf('skillStart')[0], atk = h.hooksOf('attack').filter((c) => c.attacker === u);
    assert.equal(cast.reason, 'DEFAULT');
    assert.equal(cast.t, atk[0].t, 'cast right before that attack');
    assert.equal(dpOf(h), b.cost, 'DP at the cast');
    assert.ok(atk[0].isSkill && atk[0].targets.length === b.max_target, `${atk[0].targets.length} targets`);
    const hits = h.hooksOf('damaged').filter((c) => c.source === u && c.t === cast.t);
    assert.equal(hits.length, b.max_target);
    for (const c of hits) { assert.equal(c.type, 'phys'); assert.ok(near(c.amount, u.s.atk * b.atk_scale), `${c.amount}`); }
    h.run(3);
    const next = h.hooksOf('attack').filter((c) => c.attacker === u)[1];
    assert.ok(next && !next.isSkill && next.targets.length === 1, 'then a normal single-target attack');
    assert.equal(dpOf(h), b.cost, 'one grant per cast');
    done(h);
  }
});

test('郁金香 S2 迅瞬: ASPD +, def_penetrate of the DEF ignored; +cost DP every interval, trig_cnt times', () => {
  for (const id of [ID6, ELITE6]) {
    const s = skillOf(id, S2), b = s.bb;
    const h = run({ flags: NO_DP, units: [U(id, S2, 10, 4, { carryState: { sp: 999 } })], enemies: [{ key: 'enemy_armor', pos: [10, 5] }] });
    const u = h.unit(id);
    const log = dpLog(h, s.duration + 1);
    const t0 = h.hooksOf('skillStart')[0].t;
    assert.equal(log.length, b.trig_cnt);
    log.forEach(([t, d], k) => {
      assert.ok(near(d, b.cost));
      assert.ok(Math.abs(t - (t0 + TICK + (k + 1) * b.interval)) <= TICK + 1e-6, `grant ${k + 1} at ${t}`);
    });
    assert.ok(near(dpOf(h), b.trig_cnt * b.cost));
    const end = h.hooksOf('skillEnd')[0].t;
    assert.ok(near(end - t0, s.duration, 1e-3));
    const during = h.hooksOf('damaged').filter((c) => c.source === u && c.t >= t0 && c.t < end);
    assert.ok(during.length >= 3);
    for (const c of during) assert.ok(near(c.amount, phys(u.base.atk * (1 + talOf(id, 1).atk), 400, b.def_penetrate)), `${c.amount}`);
    const after = h.hooksOf('damaged').filter((c) => c.source === u && c.t > end);
    assert.ok(after.length && after.every((c) => near(c.amount, phys(u.s.atk, 400))), 'no DEF ignore after');
    done(h);
    // ASPD while it runs; a knock-out stops the DP
    const g = run({ flags: NO_DP, units: [U(id, S2, 10, 4, { carryState: { sp: 999 } })], enemies: [{ key: 'enemy_dummy', pos: [10, 5] }] });
    const v = g.unit(id);
    g.step(1);
    assert.ok(v.skill.active);
    assert.equal(v.s.aspd, 100 + b.attack_speed);
    g.run(3);
    g.b.kill(v);
    const got = dpOf(g);
    assert.equal(got, Math.floor((g.b.time - g.hooksOf('skillStart')[0].t - TICK) / b.interval + 1e-9) * b.cost);
    g.run(8);
    assert.equal(dpOf(g), got, 'nothing after the knock-out');
    done(g);
  }
});

test('郁金香 S3 只余芬芳 (SKILL_RANGE kept): any enemy on x-1, no attack needed; +cost DP; `times` slashes on its ground enemies', () => {
  for (const id of [ID6, ELITE6]) {
    const s = skillOf(id, S3), b = s.bb;
    assert.equal(s.trigger.rule, 'SKILL_RANGE');
    // (10,7) is off x-1 around (10,4): no cast
    const off = run({ flags: NO_DP, units: [U(id, S3, 10, 4, { carryState: { sp: 999 } })], enemies: [{ key: 'enemy_armor', pos: [10, 7] }] });
    off.run(3);
    assert.equal(off.unit(id).skill.activations, 0);
    done(off);
    // A (10,6) and B (11,3) on x-1 (out of her attack range), the flyer F (9,4) on it, Z (12,6) off it
    const h = run({ flags: NO_DP, units: [U(id, S3, 10, 4, { carryState: { sp: 999 } })],
      enemies: [{ key: 'enemy_armor', pos: [10, 6] }, { key: 'enemy_armor', pos: [11, 3] }, { key: 'enemy_fly', pos: [9, 4] }, { key: 'enemy_armor', pos: [12, 6] }] });
    const u = h.unit(id);
    assert.equal(u.skill.rule, 'SKILL_RANGE');
    h.step(1);
    const [A, B, F, Z] = h.b.enemies;
    assert.equal(u.skill.activations, 1, 'cast at once');
    assert.equal(h.hooksOf('skillStart')[0].reason, 'SKILL_RANGE');
    assert.equal(dpOf(h), b.cost);
    const sl = h.hooksOf('damaged').filter((c) => c.source === u && has(c, 'acpionSlash'));
    for (const e of [A, B]) {
      const mine = sl.filter((c) => c.target === e);
      assert.equal(mine.length, b.times, `${b.times} slashes`);
      for (const c of mine) {
        assert.equal(c.type, 'phys');
        assert.ok(c.dmg.isSkill && has(c, 'skill') && !c.dmg.isAttack, 'skill damage, not an attack');
        assert.ok(near(c.amount, phys(u.s.atk * b.atk_scale, 400, b.def_penetrate)), `${c.amount}`);
      }
    }
    assert.ok(!sl.some((c) => c.target === F || c.target === Z), 'no flyer, nothing off the range');
    assert.equal(h.hooksOf('attack').filter((c) => c.attacker === u).length, 0, 'not an attack');
    done(h);
    // a flyer alone on the range satisfies the strategy (it "sees" every enemy): DP, no damage
    const f = run({ flags: NO_DP, units: [U(id, S3, 10, 4, { carryState: { sp: 999 } })], enemies: [{ key: 'enemy_fly', pos: [10, 6] }] });
    f.step(1);
    assert.equal(f.unit(id).skill.activations, 1);
    assert.equal(dpOf(f), b.cost);
    assert.equal(f.hooksOf('damaged').filter((c) => has(c, 'acpionSlash')).length, 0);
    done(f);
  }
});

test('郁金香 T1 无垠之心: SP recovery +sp_recovery_per_sec from each deployment until the cnt-th cast (record per loadout)', () => {
  for (const [id, moduleId] of [[ID5, undefined], [ID6, undefined], [ELITE5, null], [ELITE6, null], [ELITE6, 'none']]) {
    const t0 = talOf(id, 0, moduleId);
    assert.equal(t0.cnt, 2);
    const h = run({ units: [U(id, S1, 10, 4, moduleId !== undefined ? { moduleId } : {})], enemies: [{ key: 'enemy_dummy', pos: [10, 5] }] });
    const u = h.unit(id), s = skillOf(id, S1);
    h.step(1);
    assert.ok(near(u.s.spRecovery, 1 + t0.sp_recovery_per_sec), `${id} ${moduleId}: ${u.s.spRecovery}`);
    // SP over 2 s: (1 + v) / s
    const sp0 = u.skill.sp;
    h.run(2);
    assert.ok(near(u.skill.sp - sp0, 2 * (1 + t0.sp_recovery_per_sec), 1e-3), `SP ${u.skill.sp - sp0}`);
    // first cast at (spCost − initSp) / (1 + v)
    assert.ok(h.runUntil(() => u.skill.activations === 1, 30));
    assert.ok(Math.abs(h.hooksOf('skillStart')[0].t - (s.spCost - s.initSp) / (1 + t0.sp_recovery_per_sec)) <= 1.2, 'waits for its attack');
    assert.ok(near(u.s.spRecovery, 1 + t0.sp_recovery_per_sec), 'kept after the first cast');
    u.skill.addCharge(1);
    assert.ok(h.runUntil(() => u.skill.activations === 2, 5));
    assert.equal(u.s.spRecovery, 1, 'gone at the second cast');
    h.b.retreat(u);
    assert.ok(h.b.redeploy(u));
    assert.ok(near(u.s.spRecovery, 1 + t0.sp_recovery_per_sec), 'back with the next deployment');
    // the count restarts with the deployment: it lasts two casts again
    u.skill.addCharge(1);
    assert.ok(h.runUntil(() => u.skill.activations === 3, 5));
    assert.ok(near(u.s.spRecovery, 1 + t0.sp_recovery_per_sec), 'one cast of this deployment: kept');
    u.skill.addCharge(1);
    assert.ok(h.runUntil(() => u.skill.activations === 4, 5));
    assert.equal(u.s.spRecovery, 1, 'gone at the second cast of this deployment');
    done(h);
  }
  assert.ok(talOf(ELITE6, 0).sp_recovery_per_sec > talOf(ELITE6, 0, 'none').sp_recovery_per_sec, 'SOL-X level 3 upgrades it');
});

test('郁金香 T2 浪潮之心: ATK +atk; +cost DP for every enemy she kills (attacks and skills), not for others\' kills', () => {
  for (const id of ALL) {
    const t1 = talOf(id, 1);
    const h = run({ flags: NO_DP, units: [U(id, S2, 10, 4, { ...(id.endsWith('_b') ? { moduleId: 'none' } : {}) }), { uid: 9, chessId: 'test_guard_a', row: 11, col: 6 }],
      enemies: [{ key: 'enemy_weak', pos: [10, 5] }, { key: 'enemy_weak', pos: [11, 7] }] });
    const u = h.unit(id), g = h.unit(9);
    h.step(1);
    assert.ok(near(u.s.atk, u.base.atk * (1 + t1.atk)), `${id} ATK ${u.s.atk}`);
    h.run(3);
    const kills = h.hooksOf('kill');
    assert.equal(kills.length, 2);
    assert.deepEqual(kills.map((c) => c.killer === u).sort(), [false, true], 'one kill each');
    assert.ok(kills.some((c) => c.killer === g));
    assert.equal(dpOf(h), t1.cost, 'DP for her kill only');
    done(h);
  }
  // S3 slash kills count too; two players: her player gets the DP
  const players = [
    { playerId: 'p1', seat: 0, side: 'L', colOffset: 0, bonds: {}, units: [{ uid: 1, kind: 'chess', chessId: ELITE6, skillIndex: skillOf(ELITE6, S3).index, row: 10, col: 9, carryState: { sp: 999 } }] },
    { playerId: 'p2', seat: 1, side: 'L', colOffset: 8, bonds: {}, units: [{ uid: 2, kind: 'chess', chessId: 'test_guard_a', row: 12, col: 6 }] },
  ];
  const h = run({ kind: 'unite', players, flags: NO_DP, enemies: [{ key: 'enemy_weak', pos: [10, 10] }, { key: 'enemy_weak', pos: [9, 9] }] });
  h.step(1);
  const u = h.unit(1);
  assert.equal(u.skill.activations, 1);
  assert.equal(h.hooksOf('kill').filter((c) => c.killer === u).length, 2);
  assert.equal(dpOf(h, 'p1'), skillOf(ELITE6, S3).bb.cost + 2 * talOf(ELITE6, 1).cost);
  assert.equal(dpOf(h, 'p2'), 0);
  done(h);
});

test('郁金香 module SOL-X: ATK / DEF +8 % while she blocks (both tiers\' module levels); none: never', () => {
  for (const E of [ELITE5, ELITE6]) for (const moduleId of [null, 'none']) {
    const tb = traitOf(E, moduleId), t1 = talOf(E, 1, moduleId);
    assert.equal((tb.atk ?? 0) > 0 && (tb.def ?? 0) > 0, moduleId === null, `${E} ${moduleId}`);
    const h = run({ units: [U(E, S3, 9, 4, { moduleId })], enemies: [{ key: 'enemy_walker', route: 0 }] });
    const u = h.unit(E);
    h.run(1);
    assert.equal(u.blocking.length, 0);
    assert.ok(near(u.s.atk, u.base.atk * (1 + t1.atk)) && near(u.s.def, u.base.def), `free: ${u.s.atk} ${u.s.def}`);
    assert.ok(h.runUntil(() => u.blocking.length > 0, 20), 'blocks the walker');
    h.step(1);
    assert.ok(near(u.s.atk, u.base.atk * (1 + t1.atk + (tb.atk ?? 0))), `blocking ATK ${u.s.atk}`);
    assert.ok(near(u.s.def, u.base.def * (1 + (tb.def ?? 0))), `blocking DEF ${u.s.def}`);
    done(h);
  }
});

test('郁金香 matrix: both tiers × every module (none included) × every skill — DP of the cast from the record', () => {
  for (const id of ALL) for (const moduleId of modsOf(id)) for (const sid of [S1, S2, S3]) {
    const s = skillOf(id, sid), b = s.bb;
    const want = sid === S2 ? b.trig_cnt * b.cost : b.cost;
    const h = run({ flags: NO_DP, units: [U(id, sid, 10, 4, { carryState: { sp: 999 }, ...(id.endsWith('_b') ? { moduleId } : {}) })], enemies: [{ key: 'enemy_dummy', pos: [10, 5] }] });
    const u = h.unit(id);
    h.step(2);
    const tag = `${id} ${moduleId} ${sid}`;
    assert.equal(u.skill.activations, 1, tag);
    assert.ok(h.runUntil(() => !u.skill.active, 15));
    h.step(1);
    assert.ok(near(dpOf(h), want), `${tag}: DP ${dpOf(h)} ≠ ${want}`);
    const t1 = talOf(id, 1, id.endsWith('_b') ? moduleId : null);
    assert.ok(near(u.s.atk, u.base.atk * (1 + t1.atk)), `${tag} ATK`);
    done(h);
  }
});

test('郁金香 two copies: each casts and grants its own DP (S2 twice the total); two players: each to her own player', () => {
  const b = skillOf(ELITE6, S2).bb;
  const h = run({ flags: NO_DP, units: [U(ELITE6, S2, 10, 4, { carryState: { sp: 999 }, uid: 1 }), U(ID6, S2, 11, 4, { carryState: { sp: 999 }, uid: 2 })],
    enemies: [{ key: 'enemy_dummy', pos: [10, 5] }, { key: 'enemy_dummy', pos: [11, 5] }] });
  h.run(skillOf(ELITE6, S2).duration + 1);
  assert.ok(near(dpOf(h), b.trig_cnt * b.cost + skillOf(ID6, S2).bb.trig_cnt * skillOf(ID6, S2).bb.cost));
  for (const i of [1, 2]) assert.equal(h.unit(i).buffs.filter((x) => x.key === 'acpion:tide').length, 1);
  done(h);
  const players = ['p1', 'p2'].map((playerId, seat) => ({ playerId, seat, side: 'L', colOffset: seat * 8, bonds: {},
    units: [{ uid: seat + 1, kind: 'chess', chessId: seat ? ID6 : ELITE6, skillIndex: skillOf(ELITE6, S1).index, row: 10, col: 4, carryState: { sp: 999 } }] }));
  const k = run({ kind: 'unite', players, flags: NO_DP, enemies: [{ key: 'enemy_dummy', pos: [10, 5] }] });
  k.run(2);
  assert.equal(k.unit(1).skill.activations, 1);
  assert.equal(k.unit(2).skill.activations, 0, 'nothing in reach of p2\'s');
  assert.equal(dpOf(k, 'p1'), skillOf(ELITE6, S1).bb.cost);
  assert.equal(dpOf(k, 'p2'), 0);
  done(k);
});

test('郁金香: every skill × tier survives a real wave without content errors and casts', () => {
  for (const id of ALL) for (const s of rec(id).skills) {
    const h = makeBattle({ defs: DEFS, seed: 3, timeLimit: 60,
      units: [U(id, s.skillId, 10, 4, { carryState: { sp: 999 } }), { chessId: 'chess_char_2_06_a', row: 10, col: 6 }],
      enemies: [{ key: 'enemy_1007_slime', count: 8, interval: 1.5 }, { key: 'enemy_1007_slime', route: 1, count: 8, interval: 1.5, time: 3 }] });
    h.runToEnd(90);
    done(h);
    assert.ok(h.b.allyUnits.find((x) => x.defId === id).skill.activations > 0, `${id} ${s.skillId} casts`);
  }
});
