// test/content/waiguan/char_456_ash.test.js — 灰烬 外援 kit (server/sim/content/kits/waiguan/char_456_ash.js).
// Every skill (normal Lv4 + elite Lv7 of both tiers), both talents (the DP of 突击手 through the player's DP), each module
// choice ('none' included) with every skill, two copies of her and two players on one field, a smoke wave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, checkInvariants } from '../../helpers/battleHarness.js';
import { DataSource, getDefaultSource } from '../../../server/sim/simdata.js';
import { getData } from '../../../server/data.js';
import { waiguanRecords } from '../../../shared/waiguan.js';
import { skillSpecSource } from '../../../server/sim/content/index.js';
import { DOWN_STATE } from '../../../server/sim/constants.js';
import WAIGUAN from '../../../server/sim/content/kits/waiguan/index.js';

const CHAR = 'char_456_ash';
const ID5 = `chess_char_diy_5_${CHAR}_a`, ID6 = `chess_char_diy_6_${CHAR}_a`;
const ELITE5 = ID5.replace(/_a$/, '_b'), ELITE6 = ID6.replace(/_a$/, '_b');
const MAR_Y = 'uniequip_002_ash', MAR_X = 'uniequip_003_ash';
const S1 = 'skchr_ash_1', S2 = 'skchr_ash_2', S3 = 'skchr_ash_3';
const REC = waiguanRecords(getData({ log: { warn() {}, error() {}, info() {} } }).waiguan);
const DS = new DataSource({ chess: REC }, getDefaultSource());
const rec = (id) => REC[id];
const skillOf = (id, sid) => rec(id).skills.find((s) => s.skillId === sid);
/** Every (chess id, module) loadout: normal records with the default, elites with default / 'none' / each module. */
const LOADOUTS = [ID5, ID6, ELITE5, ELITE6].flatMap((id) => (id.endsWith('_b') ? [null, 'none', ...rec(id).modules.map((m) => m.uniEquipId)] : [null]).map((m) => [id, m]));
const raw = (id, moduleId = null) => DS.getChess(id, { skillIndex: 0, moduleId }).raw;
const talOf = (id, i, moduleId = null) => raw(id, moduleId).talents.find((t) => t.index === i)?.bb ?? {};
const flyMulOf = (id, moduleId = null) => raw(id, moduleId).trait?.bb?.atk_scale ?? 1;
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e7, speed: 0, ...o });
const DEFS = {
  chess: REC,
  enemies: {
    enemy_dummy: dummy('enemy_dummy'), enemy_armor: dummy('enemy_armor', { def: 300 }), enemy_fly: dummy('enemy_fly', { motion: 'FLY' }),
    enemy_nostun: dummy('enemy_nostun', { immunities: { stun: true } }), enemy_heavy: dummy('enemy_heavy', { mass: 5 }),
  },
};
const READY = { sp: 999 };
const HOOKS = ['damaged', 'skillStart', 'skillEnd', 'statusApplied', 'attack', 'deploy', 'spGain'];
const run = (o) => makeBattle({ defs: DEFS, seed: 7, timeLimit: 400, autoFinish: false, hooks: HOOKS, captureNoisy: true, ...o });
/** Operator entry with skill `sid` (board coords). She stands at (10, 3) facing right: range cols 3–6, rows 9–11. */
const U = (id, sid, row, col, o = {}) => ({ chessId: id, row, col, skillIndex: skillOf(id, sid).index, ...o });
const done = (h) => { checkInvariants(h.b); assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0])); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const phys = (a, def) => Math.max(a - def, 0.05 * a);
const hitsBy = (h, u, f = () => true) => h.hooksOf('damaged').filter((c) => c.source === u && f(c));
const tagged = (tag) => (c) => (c.dmg.tags ?? []).includes(tag);
const dp = (h, pid = 'p1') => h.b.getPlayer(pid).dp;

test('灰烬: every skill of both tiers (normal + elite, every module) is hand-authored', () => {
  for (const id of [ID5, ID6]) assert.equal(typeof WAIGUAN[id], 'function', `${id} registered`);
  for (const [id, moduleId] of LOADOUTS) for (const s of rec(id).skills) {
    assert.equal(skillSpecSource(DS.getChess(id, { skillIndex: s.index, moduleId }), WAIGUAN), 'skills', `${id} ${s.skillId} ${moduleId}`);
  }
});

test('灰烬 T2 突击手: the battle-start deployment is free and spends the discount; +sp SP at it (every loadout)', () => {
  for (const [id, moduleId] of LOADOUTS) {
    const t1 = talOf(id, 1, moduleId);
    const h = run({ units: [U(id, S1, 10, 3, { moduleId })] });
    const u = h.unit(id);
    assert.equal(u.base.cost, rec(id).stats.cost + t1.runtime_cost, 'discounted before her first deployment');
    h.step(1);
    assert.ok(u.alive && u.deployed);
    assert.ok(near(dp(h), h.b.flags.dpInit + h.b.flags.dpPerSec * h.b.dt), `${id} ${moduleId}: nothing paid (${dp(h)})`);
    assert.equal(u.base.cost, rec(id).stats.cost, 'the full cost from then on');
    const gifts = h.hooksOf('spGain').filter((c) => c.unit === u && c.reason === 'talent');
    assert.deepEqual(gifts.map((c) => c.amount), [t1.sp], 'the SP gift');
    assert.ok(near(u.skill.sp, t1.sp + h.b.dt), `SP ${u.skill.sp}`);
    done(h);
  }
});

test('灰烬 T2: a first deployment that is paid costs cost + runtime_cost (−5 MAR-Y VI, −3 otherwise); a redeploy the full cost', () => {
  for (const [id, moduleId] of LOADOUTS) {
    const t1 = talOf(id, 1, moduleId), cost = rec(id).stats.cost;
    const h = run({ units: [U(id, S1, 10, 3, { moduleId })], setup: (b) => { b.allyUnits.find((x) => x.defId === id).deferDeploy = true; } });
    const u = h.unit(id);
    h.step(1);
    assert.ok(!u.alive, 'held off the battle-start deployment');
    h.b.getPlayer('p1').dp = 40;
    assert.ok(h.b.redeploy(u, { free: false }));
    assert.ok(near(dp(h), 40 - (cost + t1.runtime_cost)), `${id} ${moduleId}: paid ${40 - dp(h)}`);
    assert.equal(u.base.cost, cost);
    assert.equal(h.hooksOf('spGain').filter((c) => c.unit === u && c.reason === 'talent').length, 1, 'SP gift at it');
    h.b.kill(u);
    h.b.getPlayer('p1').dp = 40;
    assert.ok(h.b.redeploy(u, { free: false }));
    assert.ok(near(dp(h), 40 - cost), 'the second deployment costs the full cost');
    assert.equal(h.hooksOf('spGain').filter((c) => c.unit === u && c.reason === 'talent').length, 1, 'no SP gift at a redeploy');
    done(h);
  }
});

test('灰烬 T2: knocked out, she waits for her timer and the DP (WAIT_DP), then redeploys paying exactly her cost', () => {
  for (const id of [ID6, ELITE6, ELITE5]) {
    const h = run({ units: [U(id, S1, 10, 3)], flags: { dpPerSec: 0 } });
    const u = h.unit(id);
    h.step(1);
    h.b.kill(u);
    h.b.getPlayer('p1').dp = rec(id).stats.cost - 1;
    h.run(rec(id).stats.respawnTime + 1);
    assert.ok(!u.alive, 'still down');
    assert.ok(h.b.isDown(u));
    assert.equal(h.snapshot().down.find((x) => x[0] === u.id)[3], DOWN_STATE.WAIT_DP);
    h.b.addDp('p1', 1);
    h.step(1);
    assert.ok(u.alive && u.deployed, 'redeployed once the DP is there');
    assert.equal(dp(h), 0, 'paid exactly her cost');
    done(h);
  }
});

test('灰烬 T1 辅助装备: no flashbang at the battle start (no enemy yet); on a redeploy the flyer first, stun around it', () => {
  for (const [id, moduleId] of LOADOUTS) {
    const t0 = talOf(id, 0, moduleId);
    const h = run({ units: [U(id, S1, 10, 3, { moduleId })],
      enemies: [{ key: 'enemy_dummy', pos: [11, 6] }, { key: 'enemy_fly', pos: [10, 5], route: 2 }, { key: 'enemy_armor', pos: [9, 3] }] });
    const u = h.unit(id);
    h.run(1);
    assert.equal(h.hooksOf('statusApplied').filter((c) => c.source === u).length, 0, 'nothing at the battle start');
    h.b.kill(u);
    assert.ok(h.b.redeploy(u));
    const st = h.hooksOf('statusApplied').filter((c) => c.source === u && c.status === 'stun');
    assert.deepEqual(st.map((c) => c.target.defId).sort(), ['enemy_dummy', 'enemy_fly'], `${id} ${moduleId}: the flyer and the one 1.41 away`);
    const fly = h.enemy('enemy_fly'), burst = h.eventsOf('fx').filter((e) => e[1] === 'sunBurst');
    assert.equal(burst.length, 1);
    assert.deepEqual([burst[0][2], burst[0][3]], [fly.x, fly.y], 'thrown at the flyer (her attack selection: flyers first)');
    assert.ok(st.every((c) => near(c.duration, t0.stun)), `stun ${t0.stun} s`);
    done(h);
  }
});

test('灰烬 T1 + MAR-X (tier VI): 6 s stun, and her physical damage to those enemies ×damage_scale for scale_duration s', () => {
  const t0 = talOf(ELITE6, 0, MAR_X);
  assert.ok(t0.damage_scale > 1 && t0.scale_duration > 0);
  const h = run({ units: [U(ELITE6, S1, 10, 3, { moduleId: MAR_X })], enemies: [{ key: 'enemy_dummy', pos: [10, 5] }, { key: 'enemy_nostun', pos: [10, 6] }] });
  const u = h.unit(ELITE6);
  h.run(3);
  const before = hitsBy(h, u, (c) => c.dmg.isAttack);
  assert.ok(before.length >= 2 && before.every((c) => near(c.amount, u.s.atk)), 'unmarked: ATK');
  h.b.kill(u);
  assert.ok(h.b.redeploy(u));
  const t = h.b.time;
  const marked = h.hooksOf('statusApplied').filter((c) => c.source === u && c.status === 'stun').map((c) => c.target.defId);
  assert.deepEqual(marked, ['enemy_dummy'], 'the stun-immune one is not stunned');
  const nostun = h.enemy('enemy_nostun');
  assert.ok(nostun.findBuff(`ash:flash:${u.id}`), 'but marked (the mark is not a status)');
  h.run(t0.scale_duration - 0.5);
  const during = hitsBy(h, u, (c) => c.dmg.isAttack && c.t > t);
  assert.ok(during.length >= 3 && during.every((c) => near(c.amount, u.s.atk * t0.damage_scale)), `marked: ×${t0.damage_scale}`);
  h.run(1);
  const n = hitsBy(h, u).length;
  h.run(2);
  assert.ok(hitsBy(h, u).slice(n).every((c) => near(c.amount, u.s.atk)), 'the mark lapses after scale_duration');
  // tier V MAR-X (module level 1): no talent change — no mark
  const g = run({ units: [U(ELITE5, S1, 10, 3, { moduleId: MAR_X })], enemies: [{ key: 'enemy_dummy', pos: [10, 5] }] });
  const v = g.unit(ELITE5);
  g.run(1);
  g.b.kill(v);
  g.b.redeploy(v);
  assert.equal(g.enemy('enemy_dummy').findBuff(`ash:flash:${v.id}`), null);
  assert.ok(near(g.hooksOf('statusApplied').find((c) => c.source === v).duration, talOf(ELITE5, 0, MAR_X).stun));
  done(h);
  done(g);
});

test('灰烬 S1 支援射击 (AUTO, DEFAULT): ATK +atk and 2 hits per attack, for good (until she leaves) — every loadout', () => {
  for (const [id, moduleId] of LOADOUTS) {
    const bb = skillOf(id, S1).bb;
    const h = run({ units: [U(id, S1, 10, 3, { moduleId, carryState: READY })], enemies: [{ key: 'enemy_dummy', pos: [10, 5] }] });
    const u = h.unit(id);
    assert.ok(h.runUntil(() => u.skill.active, 3), 'casts at the first attack');
    assert.equal(u.skill.rule, 'DEFAULT');
    assert.equal(u.skill.kind, 'toggle');
    assert.equal(u.skill.manual, false, 'AUTO: no operation cooldown');
    assert.ok(near(u.s.atk, u.base.atk * (1 + bb.atk)), `ATK +${bb.atk}`);
    h.run(20);
    assert.ok(u.skill.active, 'still on');
    const byAttack = new Map();
    for (const c of hitsBy(h, u, (x) => x.dmg.isAttack)) byAttack.set(c.dmg.attackId, (byAttack.get(c.dmg.attackId) ?? 0) + 1);
    assert.ok(byAttack.size >= 15 && [...byAttack.values()].every((n) => n === bb['attack@times']), `${bb['attack@times']} hits per attack`);
    h.b.kill(u);
    assert.ok(!u.skill.active && h.hooksOf('skillEnd').some((c) => c.unit === u && c.reason === 'death'), 'ends when she is knocked out');
    done(h);
  }
});

test('灰烬 S2 突击战术: flashbang at the cast, 31 bullets, BAT −0.8 s, ATK ×atk_scale against 晕眩 only — every loadout', () => {
  for (const [id, moduleId] of LOADOUTS) {
    const sk = skillOf(id, S2), sc = sk.bb['ash_s_2[atk_scale].atk_scale'], t0 = talOf(id, 0, moduleId);
    const h = run({ units: [U(id, S2, 10, 3, { moduleId, carryState: READY })], enemies: [{ key: 'enemy_armor', pos: [10, 5] }] });
    const u = h.unit(id);
    assert.ok(h.runUntil(() => u.skill.active, 3));
    assert.equal(u.skill.rule, 'DEFAULT');
    assert.equal(u.skill.ammoMax, 31, '攻击装有31发子弹');
    assert.ok(near(u.s.bat, u.base.bat + sk.bb.base_attack_time), `BAT ${u.s.bat}`);
    const t = h.hooksOf('skillStart').find((c) => c.unit === u).t;
    const st = h.hooksOf('statusApplied').find((c) => c.source === u && c.status === 'stun');
    assert.ok(st && st.t === t && near(st.duration, t0.stun), 'the flashbang at the cast');
    h.runUntil(() => !u.skill.active, 20);
    const shots = h.hooksOf('attack').filter((c) => c.attacker === u && c.t >= t && c.t <= h.hooksOf('skillEnd').find((e) => e.unit === u).t);
    assert.equal(shots.length, 31, 'the skill ends with its 31st attack');
    const hits = hitsBy(h, u, (c) => c.dmg.isAttack && c.t <= t + t0.stun - 0.1);
    const mark = t0.damage_scale ?? 1; // MAR-X (tier VI): the flashbang's mark on top
    assert.ok(hits.length >= 10 && hits.every((c) => near(c.amount, phys(u.s.atk * sc, 300) * mark)), `${id} ${moduleId}: ATK ×${sc} (before DEF) ×${mark} vs the stunned one`);
    done(h);
  }
  // not stunned (immune): ×1
  const h = run({ units: [U(ELITE6, S2, 10, 3, { carryState: READY })], enemies: [{ key: 'enemy_nostun', pos: [10, 5] }] });
  const u = h.unit(ELITE6);
  h.runUntil(() => u.skill.active, 3);
  h.run(3);
  const hits = hitsBy(h, u, (c) => c.dmg.isAttack);
  assert.ok(hits.length >= 10 && hits.every((c) => near(c.amount, u.s.atk)), 'no ×atk_scale on an enemy that is not stunned');
  done(h);
});

test('灰烬 S2: ×atk_scale only on 晕眩 (not 冻结 / 浮空) and only while the 31 bullets last', () => {
  const sc = skillOf(ELITE6, S2).bb['ash_s_2[atk_scale].atk_scale'];
  const h = run({ units: [U(ELITE6, S2, 10, 3, { carryState: READY })], enemies: [{ key: 'enemy_nostun', pos: [10, 5] }] });
  const u = h.unit(ELITE6);
  assert.ok(h.runUntil(() => u.skill.active, 3));
  const e = h.enemy('enemy_nostun'), A = u.s.atk;
  const window = (status, dur, opts = {}) => {
    const t = h.b.time;
    assert.ok(h.b.applyStatus(e, status, { duration: dur, ...opts }), status);
    h.run(dur + 0.3);
    return hitsBy(h, u, (c) => c.dmg.isAttack && c.t > t + 0.05 && c.t < t + dur - 0.05);
  };
  const frozen = window('freeze', 1);
  assert.ok(frozen.length >= 3 && frozen.every((c) => near(c.amount, A)), '冻结: ×1');
  const lev = window('levitate', 1);
  assert.ok(lev.length >= 3 && lev.every((c) => near(c.amount, A)), '浮空: ×1');
  const stun = window('stun', 1, { force: true });
  assert.ok(u.skill.active && stun.length >= 3 && stun.every((c) => near(c.amount, A * sc)), `晕眩: ×${sc}`);
  assert.ok(h.runUntil(() => !u.skill.active, 10));
  assert.equal(h.hooksOf('skillEnd').find((c) => c.unit === u).reason, 'ammo', 'the 31 bullets are spent');
  const after = window('stun', 3, { force: true });
  assert.ok(after.length >= 2 && after.every((c) => near(c.amount, A)), 'after the skill: ×1 on a stunned enemy');
  done(h);
});

test('灰烬 S3 攻坚榴弹: path hit + push, burst at the line end (not_hitwall_scale), every loadout', () => {
  for (const [id, moduleId] of LOADOUTS) {
    const bb = skillOf(id, S3).bb;
    const h = run({ units: [U(id, S3, 10, 3, { moduleId, carryState: READY })], enemies: [{ key: 'enemy_armor', pos: [10, 5] }] });
    const u = h.unit(id);
    assert.ok(h.runUntil(() => u.skill.activations > 0, 2), 'SKILL_RANGE: casts at once');
    assert.equal(u.skill.rule, 'SKILL_RANGE');
    const e = h.enemy('enemy_armor');
    const path = hitsBy(h, u, tagged('ashGrenadePath')), blast = hitsBy(h, u, tagged('ashGrenadeBlast'));
    const A = u.s.atk;
    assert.equal(path.length, 1);
    assert.ok(near(path[0].amount, phys(A * bb.atk_scale, 300)), `path ${path[0].amount}`);
    const moved = h.b.pushDistance(e, bb.force);
    assert.ok(near(e.x, 5 + moved, 1e-3), `pushed ${e.x - 5} (official ${moved})`);
    assert.equal(blast.length, e.x <= 7 + bb.range_radius ? 1 : 0);
    assert.ok(near(blast[0].amount, phys(A * bb.not_hitwall_scale, 300)), `burst ${blast[0].amount}`);
    done(h);
  }
});

test('灰烬 S3: from low ground into a 高台 it bursts at once for hitwall_scale; MAR-X ×1.1 on a flyer', () => {
  const rows = { 10: '##hrrrhrrrfrrrrrrrf##' }; // (10, 6) is high ground: the grenade from (10, 3) crashes there
  for (const id of [ID6, ELITE6]) {
    const bb = skillOf(id, S3).bb;
    const h = run({ flat: { rows }, units: [U(id, S3, 10, 3, { carryState: READY })],
      enemies: [{ key: 'enemy_armor', pos: [10, 4] }, { key: 'enemy_dummy', pos: [9, 4] }, { key: 'enemy_heavy', pos: [9, 7] }] });
    const u = h.unit(id);
    h.runUntil(() => u.skill.activations > 0, 2);
    const A = u.s.atk;
    const blast = hitsBy(h, u, tagged('ashGrenadeBlast'));
    assert.equal(h.hooksOf('damaged').filter(tagged('ashGrenadePath')).length, 1, 'path: only the one on the line');
    assert.deepEqual(blast.map((c) => c.target.defId).sort(), ['enemy_armor', 'enemy_dummy'], 'burst around (10, 5), the last low tile');
    for (const c of blast) assert.ok(near(c.amount, phys(A * bb.hitwall_scale, c.target.s.def)), `crash ×${bb.hitwall_scale}`);
    done(h);
    // fired from high ground ((10, 2)) it crosses into the low ground first: no crash at its start, burst at the line end
    const g = run({ units: [U(id, S3, 10, 2, { carryState: READY })], enemies: [{ key: 'enemy_heavy', pos: [10, 6] }] });
    const v = g.unit(id);
    g.runUntil(() => v.skill.activations > 0, 2);
    const b2 = hitsBy(g, v, tagged('ashGrenadeBlast'));
    assert.equal(b2.length, 1);
    assert.ok(near(b2[0].amount, v.s.atk * bb.not_hitwall_scale), 'not_hitwall_scale');
    done(g);
  }
  const bb = skillOf(ELITE6, S3).bb;
  const h = run({ units: [U(ELITE6, S3, 10, 3, { moduleId: MAR_X, carryState: READY })], enemies: [{ key: 'enemy_fly', pos: [10, 5], route: 2 }] });
  const u = h.unit(ELITE6);
  h.runUntil(() => u.skill.activations > 0, 2);
  const fm = flyMulOf(ELITE6, MAR_X);
  assert.ok(fm > 1);
  const path = hitsBy(h, u, tagged('ashGrenadePath'));
  assert.ok(near(path[0].amount, u.s.atk * bb.atk_scale * fm), 'MAR-X fly ×atk_scale on her own skill damage');
  done(h);
});

test('灰烬 S3: the line reaches 4 tiles ahead (trigger and path); the burst takes flyers, ×1.1 on them under MAR-X', () => {
  const far = run({ units: [U(ELITE6, S3, 10, 3, { carryState: READY })], enemies: [{ key: 'enemy_heavy', pos: [10, 8] }] });
  far.run(3);
  assert.equal(far.unit(ELITE6).skill.activations, 0, '5 tiles ahead: outside the line');
  done(far);
  for (const moduleId of [null, MAR_X]) {
    const bb = skillOf(ELITE6, S3).bb;
    const h = run({ units: [U(ELITE6, S3, 10, 3, { moduleId, carryState: READY })],
      enemies: [{ key: 'enemy_heavy', pos: [10, 6] }, { key: 'enemy_heavy', pos: [10, 7] }, { key: 'enemy_heavy', pos: [10, 8] }, { key: 'enemy_fly', pos: [9, 7], route: 2 }] });
    const u = h.unit(ELITE6);
    assert.ok(h.runUntil(() => u.skill.activations > 0, 2));
    const A = u.s.atk, fm = flyMulOf(ELITE6, moduleId);
    const path = hitsBy(h, u, tagged('ashGrenadePath')).map((c) => c.target.x).sort();
    assert.deepEqual(path, [6, 7], 'path: 3 and 4 tiles ahead, not 5');
    const blast = hitsBy(h, u, tagged('ashGrenadeBlast'));
    assert.equal(blast.length, 4, 'burst at (10, 7): the three heavies and the flyer');
    const fly = blast.find((c) => c.target.defId === 'enemy_fly');
    assert.ok(near(fly.amount, A * bb.not_hitwall_scale * fm), `flyer ×${fm}`);
    assert.ok(blast.filter((c) => c !== fly).every((c) => near(c.amount, A * bb.not_hitwall_scale)), 'ground ×1');
    done(h);
  }
});

test('灰烬 S3: the push follows her facing (facing left: towards −x)', () => {
  const bb = skillOf(ELITE6, S3).bb;
  const h = run({ units: [U(ELITE6, S3, 10, 8, { dir: 'LEFT', carryState: READY })], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
  const u = h.unit(ELITE6);
  assert.equal(u.dir, 'LEFT');
  assert.ok(h.runUntil(() => u.skill.activations > 0, 2));
  const e = h.enemy('enemy_dummy');
  assert.ok(near(e.x, 6 - h.b.pushDistance(e, bb.force), 1e-3) && near(e.y, 10), `pushed to x=${e.x}`);
  const blast = hitsBy(h, u, tagged('ashGrenadeBlast'));
  assert.equal(h.eventsOf('fx').find((x) => x[1] === 'explode')[2], 4, 'burst at the line end, 4 tiles to her left');
  assert.equal(blast.length, 1);
  done(h);
});

test('灰烬 S3: SKILL_RANGE needs an enemy on her line; 2 casts per deployment, then no SP until the next one', () => {
  const off = run({ units: [U(ELITE6, S3, 10, 3, { carryState: READY })], enemies: [{ key: 'enemy_heavy', pos: [9, 5] }] });
  off.run(5);
  assert.equal(off.unit(ELITE6).skill.activations, 0, 'an enemy in her range but off the line: no cast');
  done(off);
  for (const id of [ID6, ELITE5, ELITE6]) {
    const sk = skillOf(id, S3);
    const h = run({ units: [U(id, S3, 10, 3, { carryState: READY })], enemies: [{ key: 'enemy_heavy', pos: [10, 5] }] });
    const u = h.unit(id);
    h.run(sk.spCost + 5);
    assert.equal(u.skill.activations, 2, '每次部署只能释放2次');
    h.run(sk.spCost * 2);
    assert.equal(u.skill.activations, 2);
    assert.equal(u.skill.sp, 0, 'no SP once spent');
    h.b.kill(u);
    assert.ok(h.b.redeploy(u));
    h.run(sk.spCost + 1);
    assert.equal(u.skill.activations, 3, 'the count restarts with the deployment');
    done(h);
  }
});

test('灰烬 MAR-Y: ASPD +attack_speed exactly while a ground enemy stands in her range (both tiers); no other loadout', () => {
  for (const [id, moduleId] of LOADOUTS) {
    const r = raw(id, moduleId);
    const v = r.module?.active && r.module.type === 'MAR-Y' ? talOf(id, -1, moduleId).attack_speed : 0;
    const h = run({ units: [U(id, S3, 10, 3, { moduleId })], enemies: [{ key: 'enemy_fly', pos: [10, 5], route: 2 }, { key: 'enemy_dummy', pos: [10, 6], time: 2 }] });
    const u = h.unit(id);
    h.run(1.5);
    assert.equal(u.s.aspd, 100, `${id} ${moduleId}: a flyer only`);
    h.run(1);
    assert.equal(u.s.aspd, 100 + v, `${id} ${moduleId}: ground enemy in range (+${v})`);
    h.b.kill(h.enemy('enemy_dummy'));
    h.step(2);
    assert.equal(u.s.aspd, 100, 'gone with it');
    done(h);
  }
});

test('灰烬: two copies keep their own discount, marks and casts; two players on one field pay their own DP', () => {
  const t0 = talOf(ELITE6, 0, MAR_X);
  const h = run({
    units: [U(ELITE6, S1, 10, 3, { uid: 1, moduleId: MAR_X }), U(ELITE6, S1, 11, 3, { uid: 2, moduleId: MAR_X })],
    enemies: [{ key: 'enemy_dummy', pos: [10, 5] }],
  });
  const a = h.unit(1), b = h.unit(2);
  h.run(1);
  h.b.kill(a);
  assert.ok(h.b.redeploy(a));
  const e = h.enemy('enemy_dummy');
  assert.ok(e.findBuff(`ash:flash:${a.id}`) && !e.findBuff(`ash:flash:${b.id}`), 'only the copy that threw it marks');
  const t = h.b.time;
  h.run(3);
  const [ha, hb] = [hitsBy(h, a, (c) => c.t > t), hitsBy(h, b, (c) => c.t > t)];
  assert.ok(ha.length >= 2 && ha.every((c) => near(c.amount, a.s.atk * t0.damage_scale)), 'copy A ×damage_scale');
  assert.ok(hb.length >= 2 && hb.every((c) => near(c.amount, b.s.atk)), 'copy B (the same MAR-X, its own mark only) unchanged');
  done(h);
  // two players: each 灰烬 is paid by her own player
  const players = [
    { playerId: 'p1', seat: 0, side: 'L', colOffset: 0, bonds: {}, units: [{ uid: 1, kind: 'chess', chessId: ELITE6, skillIndex: 0, row: 10, col: 3 }] },
    { playerId: 'p2', seat: 1, side: 'L', colOffset: 8, bonds: {}, units: [{ uid: 2, kind: 'chess', chessId: ID5, skillIndex: 0, row: 10, col: 3 }] },
  ];
  const g = run({ kind: 'unite', players, flags: { dpPerSec: 0 } });
  g.step(1);
  const p1 = g.unit(1), p2 = g.unit(2);
  assert.equal(p1.base.cost, rec(ELITE6).stats.cost);
  g.b.kill(p2);
  g.b.getPlayer('p1').dp = 30;
  g.b.getPlayer('p2').dp = 30;
  assert.ok(g.b.redeploy(p2, { free: false }));
  assert.equal(g.b.getPlayer('p2').dp, 30 - rec(ID5).stats.cost, 'p2 pays her full cost');
  assert.equal(g.b.getPlayer('p1').dp, 30, 'p1 untouched');
  assert.equal(g.hooksOf('spGain').filter((c) => c.reason === 'talent').length, 2, 'one SP gift each, at the battle start');
  done(g);
});

test('灰烬: every skill × tier survives a real wave and casts', () => {
  for (const id of [ID5, ID6, ELITE5, ELITE6]) for (const s of rec(id).skills) {
    const h = makeBattle({ defs: DEFS, seed: 3, timeLimit: 60,
      units: [U(id, s.skillId, 10, 4, { carryState: READY }), { chessId: 'chess_char_2_06_a', row: 10, col: 6 }],
      enemies: [{ key: 'enemy_1007_slime', count: 8, interval: 1.5 }, { key: 'enemy_1007_slime', route: 1, count: 8, interval: 1.5, time: 3 }] });
    h.runToEnd(90);
    done(h);
    assert.ok(h.b.allyUnits.find((x) => x.defId === id).skill.activations > 0, `${id} ${s.skillId} casts`);
  }
});
