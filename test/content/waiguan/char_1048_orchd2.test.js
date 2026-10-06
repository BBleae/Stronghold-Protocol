// test/content/waiguan/char_1048_orchd2.test.js — 焰狐龙梓兰 外援 kit (server/sim/content/kits/waiguan/char_1048_orchd2.js).
// Her 3-arrow attack, every skill (normal Lv4 + elite Lv7 of both tiers), both talents (翔虫机动's redeploy time / cost
// through the player's DP), each module choice ('none' included) with every skill, two copies of her and two players on
// one field, a smoke wave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, checkInvariants } from '../../helpers/battleHarness.js';
import { DataSource, getDefaultSource } from '../../../server/sim/simdata.js';
import { getData } from '../../../server/data.js';
import { waiguanRecords } from '../../../shared/waiguan.js';
import { skillSpecSource } from '../../../server/sim/content/index.js';
import { DOWN_STATE } from '../../../server/sim/constants.js';
import WAIGUAN from '../../../server/sim/content/kits/waiguan/index.js';

const CHAR = 'char_1048_orchd2';
const ID5 = `chess_char_diy_5_${CHAR}_a`, ID6 = `chess_char_diy_6_${CHAR}_a`;
const ELITE5 = ID5.replace(/_a$/, '_b'), ELITE6 = ID6.replace(/_a$/, '_b');
const ARC_X = 'uniequip_002_orchd2';
const S1 = 'skchr_orchd2_1', S2 = 'skchr_orchd2_2', S3 = 'skchr_orchd2_3';
const REC = waiguanRecords(getData({ log: { warn() {}, error() {}, info() {} } }).waiguan);
const DS = new DataSource({ chess: REC }, getDefaultSource());
const rec = (id) => REC[id];
const skillOf = (id, sid) => rec(id).skills.find((s) => s.skillId === sid);
/** Every (chess id, module) loadout: normal records with the default, elites with default / 'none' / each module. */
const LOADOUTS = [ID5, ID6, ELITE5, ELITE6].flatMap((id) => (id.endsWith('_b') ? [null, 'none', ...rec(id).modules.map((m) => m.uniEquipId)] : [null]).map((m) => [id, m]));
const raw = (id, moduleId = null) => DS.getChess(id, { skillIndex: 0, moduleId }).raw;
const talOf = (id, i, moduleId = null) => raw(id, moduleId).talents.find((t) => t.index === i)?.bb ?? {};
const dsOf = (id) => talOf(id, 2)['attack@damage_scale'];
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e7, speed: 0, ...o });
const DEFS = {
  chess: REC,
  enemies: {
    enemy_dummy: dummy('enemy_dummy'), enemy_armor: dummy('enemy_armor', { def: 300 }), enemy_heavy: dummy('enemy_heavy', { mass: 5 }),
    enemy_fly: dummy('enemy_fly', { motion: 'FLY' }), enemy_fly2: dummy('enemy_fly2', { motion: 'FLY' }), enemy_frail: dummy('enemy_frail', { hp: 10 }),
  },
};
const READY = { sp: 999 };
const HOOKS = ['damaged', 'skillStart', 'skillEnd', 'statusApplied', 'attack', 'deploy'];
const run = (o) => makeBattle({ defs: DEFS, seed: 7, timeLimit: 400, autoFinish: false, hooks: HOOKS, captureNoisy: true, ...o });
/** Operator entry with skill `sid` (board coords). She stands at (10, 3) facing right: range cols 3–5, rows 9–11. */
const U = (id, sid, row, col, o = {}) => ({ chessId: id, row, col, skillIndex: skillOf(id, sid).index, ...o });
const done = (h) => { checkInvariants(h.b); assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0])); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const phys = (a, def) => Math.max(a - def, 0.05 * a);
const hitsBy = (h, u, f = () => true) => h.hooksOf('damaged').filter((c) => c.source === u && f(c));
const tagged = (tag) => (c) => (c.dmg.tags ?? []).includes(tag);
const dp = (h, pid = 'p1') => h.b.getPlayer(pid).dp;
/** Her normal-attack hits grouped by attack id, in attack order. */
function attacksOf(h, u, f = () => true) {
  const m = new Map();
  for (const c of hitsBy(h, u, (x) => x.dmg.isAttack && !(x.dmg.tags ?? []).length && f(x))) {
    if (!m.has(c.dmg.attackId)) m.set(c.dmg.attackId, []);
    m.get(c.dmg.attackId).push(c);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

test('焰狐龙梓兰: every skill of both tiers (normal + elite, every module) is hand-authored', () => {
  for (const id of [ID5, ID6]) assert.equal(typeof WAIGUAN[id], 'function', `${id} registered`);
  for (const [id, moduleId] of LOADOUTS) for (const s of rec(id).skills) {
    assert.equal(skillSpecSource(DS.getChess(id, { skillIndex: s.index, moduleId }), WAIGUAN), 'skills', `${id} ${s.skillId} ${moduleId}`);
  }
});

test('焰狐龙梓兰 attack: 3 arrows per normal attack, each damage_scale of a hit (after DEF) — every loadout', () => {
  for (const [id, moduleId] of LOADOUTS) {
    const ds = dsOf(id);
    assert.ok(ds > 0 && Math.round(1 / ds) === 3);
    const h = run({ units: [U(id, S3, 10, 3, { moduleId })], enemies: [{ key: 'enemy_armor', pos: [10, 5] }] });
    const u = h.unit(id);
    h.run(4);
    assert.equal(u.skill.activations, 0, 'no skill yet (S3 not charged)');
    const atks = attacksOf(h, u);
    assert.ok(atks.length >= 2, `${atks.length} attacks`);
    for (const a of atks) {
      assert.equal(a.length, 3, 'three arrows');
      for (const c of a) assert.ok(near(c.amount, phys(u.s.atk, 300) * ds), `${id} ${moduleId}: ${c.amount}`);
    }
    done(h);
  }
});

test('焰狐龙梓兰 S1 刚射: 4 arrows (atk_scale_1), then 刚连射 on a spare charge (atk_scale_2, stun_prob of 2 s each) — every loadout', () => {
  for (const [id, moduleId] of LOADOUTS) {
    const sk = skillOf(id, S1), bb = sk.bb, ds = dsOf(id), pw = talOf(id, 0, moduleId).power_attack_scale;
    const h = run({ units: [U(id, S1, 10, 3, { moduleId, carryState: READY })], enemies: [{ key: 'enemy_armor', pos: [10, 5] }] });
    const u = h.unit(id);
    const rolls = [];
    h.b.rng.chance = (p) => { rolls.push(p); return true; };
    assert.ok(h.runUntil(() => hitsBy(h, u, tagged('orchd2Combo')).length > 0, 3), 'casts and combos');
    h.run(0.2);
    assert.equal(u.skill.rule, 'DEFAULT');
    assert.equal(u.skill.maxCharges, sk.maxChargeTime);
    const id1 = hitsBy(h, u, tagged('orchd2Combo'))[0].dmg.attackId;
    const first = hitsBy(h, u, (c) => c.dmg.attackId === id1 && !c.dmg.tags.length);
    const combo = hitsBy(h, u, tagged('orchd2Combo'));
    const A = u.s.atk;
    assert.equal(first.length, 4, '发射4支');
    assert.ok(first.every((c) => near(c.amount, phys(A * bb.atk_scale_1 * pw, 300) * ds)), `first arrows ${first[0].amount}`);
    assert.equal(combo.length, 5, '刚连射 5 arrows');
    assert.ok(combo.every((c) => near(c.amount, phys(A * bb.atk_scale_2 * pw, 300) * ds)), `combo arrows ${combo[0].amount}`);
    const st = h.hooksOf('statusApplied').filter((c) => c.source === u && c.status === 'stun');
    assert.equal(st.length, 5, 'a stun roll per 刚连射 arrow');
    assert.ok(st.every((c) => near(c.duration, bb.stun)) && rolls.length === 5 && rolls.every((p) => p === bb.stun_prob));
    assert.equal(u.skill.charges, sk.maxChargeTime - 2, 'two charges spent');
    const vfx = h.eventsOf('fx').filter((e) => e[1] === 'volley');
    assert.equal(vfx.length, 1);
    assert.deepEqual(vfx[0][4].targets, [combo[0].target.id], 'the 刚连射 fx names its target (render/fx.js volley reads `targets`)');
    done(h);
  }
  // no roll succeeds ⇒ no stun; a target dead after the first arrows ⇒ no 刚连射, the charge stays
  const h = run({ units: [U(ELITE6, S1, 10, 3, { carryState: READY })], enemies: [{ key: 'enemy_dummy', pos: [10, 5] }] });
  const u = h.unit(ELITE6);
  h.b.rng.chance = () => false;
  h.runUntil(() => hitsBy(h, u, tagged('orchd2Combo')).length === 5, 3);
  assert.equal(h.hooksOf('statusApplied').filter((c) => c.source === u).length, 0);
  done(h);
  const g = run({ units: [U(ELITE6, S1, 10, 3, { carryState: READY })], enemies: [{ key: 'enemy_frail', pos: [10, 5] }] });
  const v = g.unit(ELITE6);
  g.runUntil(() => g.enemy('enemy_frail') && !g.enemy('enemy_frail').alive, 3);
  g.run(0.2);
  assert.equal(v.skill.activations, 1);
  assert.equal(hitsBy(g, v, tagged('orchd2Combo')).length, 0, 'no 刚连射 on a dead target');
  assert.equal(v.skill.charges, v.skill.maxCharges - 1, 'only the cast\'s charge is spent');
  done(g);
});

test('焰狐龙梓兰 S1: "充能至最大层数时自动释放一次" — at full charges it casts during the operation cooldown (left unchanged); its guards', () => {
  const full = (sk) => { sk.charges = sk.maxCharges; sk.sp = sk.spCost; };
  for (const id of [ID6, ELITE6]) {
    const h = run({ units: [U(id, S1, 10, 3, { carryState: READY })], enemies: [{ key: 'enemy_heavy', pos: [10, 5] }] });
    const u = h.unit(id), sk = u.skill;
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
    h.run(0.6);
    assert.ok(sk.opCooling);
    assert.equal(sk.activations, 2, 'full: casts once the silence is over, inside the cooldown');
    assert.equal(h.hooksOf('skillStart').filter((c) => c.unit === u).at(-1).reason, 'auto');
    assert.equal(sk.opReadyAt, ready, 'the skill\'s own cast is no operation: the cooldown is not restarted');
    assert.ok(sk.pending, 'waits for her next attack');
    full(sk);
    h.step(3);
    assert.equal(sk.activations, 2, 'no second cast while one is pending');
    done(h);
    // nobody to shoot: no cast
    const g = run({ units: [U(id, S1, 10, 3, { carryState: READY })], enemies: [{ key: 'enemy_heavy', pos: [10, 5] }] });
    const v = g.unit(id);
    assert.ok(g.runUntil(() => v.skill.activations === 1 && !v.skill.pending, 3));
    g.b.kill(g.enemy('enemy_heavy'));
    full(v.skill);
    g.step(10);
    assert.ok(v.skill.opCooling);
    assert.equal(v.skill.activations, 1, 'no enemy in her attack selection');
    done(g);
  }
});

test('焰狐龙梓兰 S1 with exactly one charge: the 4 arrows only, no 刚连射', () => {
  for (const [id, carryState] of [[ID6, undefined], [ELITE6, { sp: skillOf(ELITE6, S1).spCost }], [ELITE5, { sp: skillOf(ELITE5, S1).spCost }]]) {
    const left = [];
    const h = run({ units: [U(id, S1, 10, 3, { carryState })], enemies: [{ key: 'enemy_heavy', pos: [10, 5] }],
      setup: (b) => b.on('skillStart', (c) => left.push(c.skill.charges)) });
    const u = h.unit(id);
    assert.ok(h.runUntil(() => u.skill.activations === 1 && !u.skill.pending, 3));
    assert.deepEqual(left, [0], 'the cast took her only charge');
    h.run(0.5);
    assert.equal(hitsBy(h, u, tagged('orchd2Combo')).length, 0, 'no 刚连射');
    const first = attacksOf(h, u)[0];
    assert.equal(first.length, 4);
    assert.equal(u.skill.charges, 0);
    done(h);
  }
});

test('焰狐龙梓兰 S2 飞翔瞪射: free cast at every deployment; 起飞; volleys 3/4/5 arrows on the skill grid; landing on her grid', () => {
  for (const [id, moduleId] of LOADOUTS) {
    const sk = skillOf(id, S2), bb = sk.bb, ds = dsOf(id), pw = talOf(id, 0, moduleId).power_attack_scale;
    const h = run({ units: [U(id, S2, 10, 3, { moduleId })],
      enemies: [{ key: 'enemy_dummy', pos: [10, 5] }, { key: 'enemy_armor', pos: [10, 7] }, { key: 'enemy_heavy', pos: [10, 8] }, { key: 'enemy_fly', pos: [9, 6], route: 2 },
        { key: 'enemy_fly2', pos: [11, 4], route: 3 }] });
    const u = h.unit(id);
    h.step(1);
    const start = h.hooksOf('skillStart').filter((c) => c.unit === u);
    assert.equal(start.length, 1);
    assert.equal(start[0].reason, 'deploy');
    assert.equal(u.skill.charges, 0, 'no charge spent');
    assert.equal(u.skill.sp, sk.initSp, 'no SP spent (and none gained while it runs)');
    assert.ok(u.s.flags.liftoff && u.s.flags.blockFly, '起飞');
    h.run(sk.duration + 0.2);
    assert.ok(!u.skill.active && !u.s.flags.liftoff, 'lands');
    const t0 = start[0].t, step = sk.duration / 4;
    const A = u.s.atk, [d, a, hv] = [h.enemy('enemy_dummy'), h.enemy('enemy_armor'), h.enemy('enemy_heavy')];
    const vol = hitsBy(h, u, tagged('orchd2Volley'));
    for (const [k, n] of [[1, 3], [2, 4], [3, 5]]) {
      const at = vol.filter((c) => Math.abs(c.t - (t0 + k * step)) <= 0.07);
      assert.equal(at.filter((c) => c.target === d).length, n, `volley ${k}: ${n} arrows`);
      assert.equal(at.filter((c) => c.target === a).length, n);
    }
    assert.equal(vol.filter((c) => c.target === h.enemy('enemy_fly')).length, 12, 'a flyer on the grid too');
    assert.equal(vol.length, 36, 'nothing else, nobody off the grid');
    assert.ok(vol.filter((c) => c.target === d).every((c) => near(c.amount, A * bb['attack@atk_scale_loop'] * pw * ds)), 'loop scale × T1 × damage_scale');
    assert.ok(vol.filter((c) => c.target === a).every((c) => near(c.amount, phys(A * bb['attack@atk_scale_loop'] * pw, 300) * ds)));
    const land = hitsBy(h, u, tagged('orchd2Landing'));
    assert.deepEqual(land.map((c) => c.target.defId).sort(), ['enemy_dummy', 'enemy_fly2'], 'landing: her own grid only, flyers too');
    assert.ok(near(land[0].amount, A * bb['attack@atk_scale_end']) && Math.abs(land[0].t - (t0 + sk.duration)) <= 0.07, 'at the end');
    const te = h.hooksOf('skillEnd').find((c) => c.unit === u).t;
    assert.ok(Math.abs(te - t0 - sk.duration) <= 0.05);
    assert.equal(h.hooksOf('attack').filter((c) => c.attacker === u && c.t < te).length, 0, 'no normal attack in flight');
    assert.equal(hv.stats.taken ?? 0, 0);
    h.b.kill(u);
    assert.ok(h.b.redeploy(u));
    const again = h.hooksOf('skillStart').filter((c) => c.unit === u);
    assert.equal(again.length, 2);
    assert.equal(again[1].reason, 'deploy', 'again at the redeploy');
    done(h);
  }
});

test('焰狐龙梓兰 S2: SKILL_RANGE casts a charge once an enemy is on the skill grid', () => {
  for (const id of [ID6, ELITE5, ELITE6]) {
    const sk = skillOf(id, S2);
    const h = run({ units: [U(id, S2, 10, 3, { carryState: READY })], enemies: [{ key: 'enemy_heavy', pos: [9, 6], time: 6 }] });
    const u = h.unit(id);
    h.run(5.5);
    assert.equal(u.skill.activations, 1, 'only the free cast: nobody on the grid');
    assert.equal(u.skill.rule, 'SKILL_RANGE');
    assert.equal(u.skill.charges, sk.maxChargeTime);
    h.run(0.5 + 2 * h.b.dt);
    assert.equal(u.skill.activations, 2, 'an enemy entered the grid');
    assert.equal(h.hooksOf('skillStart').filter((c) => c.unit === u).at(-1).reason, 'SKILL_RANGE');
    assert.equal(u.skill.charges, sk.maxChargeTime - 1);
    done(h);
  }
});

test('焰狐龙梓兰 S2: take-off releases the ground enemies she blocks; no new ground block in flight', () => {
  for (const id of [ID6, ELITE6]) {
    const h = run({ units: [U(id, S2, 10, 3, { carryState: READY })], enemies: [{ key: 'enemy_dummy', pos: [10, 3] }, { key: 'enemy_heavy', pos: [10, 6], time: 6 }] });
    const u = h.unit(id);
    h.run(5.5);
    const e = h.enemy('enemy_dummy');
    assert.equal(u.skill.activations, 1);
    assert.ok(e.blockedBy === u && u.blocking.includes(e), 'landed: she blocks the one on her tile');
    assert.ok(h.runUntil(() => u.skill.activations === 2, 2), 'an enemy enters the skill grid: S2 again');
    assert.ok(e.blockedBy !== u && !u.blocking.length, 'released at the take-off');
    h.run(1);
    assert.ok(u.skill.active && !u.blocking.length, 'none blocked in flight');
    done(h);
  }
});

test('焰狐龙梓兰 S2 ended early (knock-out / stop): no more volleys, no landing', () => {
  for (const end of ['death', 'stopped']) {
    const h = run({ units: [U(ELITE6, S2, 10, 3)], enemies: [{ key: 'enemy_dummy', pos: [10, 5] }, { key: 'enemy_armor', pos: [10, 7] }] });
    const u = h.unit(ELITE6);
    assert.ok(h.runUntil(() => hitsBy(h, u, tagged('orchd2Volley')).length > 0, 3), 'the first volley');
    h.step(1);
    const n = hitsBy(h, u, tagged('orchd2Volley')).length;
    assert.equal(n, 6, '3 arrows × 2 enemies');
    if (end === 'death') h.b.kill(u); else u.skill.stop();
    assert.equal(h.hooksOf('skillEnd').filter((c) => c.unit === u).at(-1).reason, end);
    h.run(5);
    assert.equal(hitsBy(h, u, tagged('orchd2Volley')).length, n, `${end}: no more volleys`);
    assert.equal(hitsBy(h, u, tagged('orchd2Landing')).length, 0, `${end}: no landing`);
    assert.ok(!u.s.flags.liftoff);
    done(h);
  }
});

test('焰狐龙梓兰 S3 龙之箭: charge 3 s (no attack), then the arrow: 5 hits on an enemy it passes (phys + arts), pushes after — every loadout', () => {
  for (const [id, moduleId] of LOADOUTS) {
    const sk = skillOf(id, S3), bb = sk.bb;
    const h = run({ units: [U(id, S3, 10, 3, { moduleId, carryState: READY })],
      enemies: [{ key: 'enemy_dummy', pos: [10, 5] }, { key: 'enemy_heavy', pos: [11, 5] }, { key: 'enemy_armor', pos: [10, 8] }, { key: 'enemy_fly', pos: [10, 7], route: 2 }] });
    const u = h.unit(id);
    assert.ok(h.runUntil(() => u.skill.active, 3));
    assert.equal(u.skill.rule, 'DEFAULT');
    assert.equal(u.skill.maxCharges, sk.maxChargeTime);
    const t0 = h.b.time, A = u.s.atk;
    const [d, hv, a] = [h.enemy('enemy_dummy'), h.enemy('enemy_heavy'), h.enemy('enemy_armor')];
    const x0 = { d: d.x, a: a.x };
    h.run(3 + 0.1);
    const arrow = hitsBy(h, u, tagged('orchd2DragonArrow'));
    assert.ok(arrow.length && arrow.every((c) => Math.abs(c.t - (t0 + 3)) <= 0.05), 'released after 蓄力3秒');
    const [ts, te] = [h.hooksOf('skillStart'), h.hooksOf('skillEnd')].map((l) => l.find((c) => c.unit === u).t);
    assert.ok(Math.abs(te - ts - 3) <= 0.05, `charge ${te - ts} s`);
    assert.equal(h.hooksOf('attack').filter((c) => c.attacker === u && c.t >= ts && c.t < te).length, 0, 'no attack while charging');
    for (const [e, def] of [[d, 0], [a, 300]]) {
      const p = arrow.filter((c) => c.target === e && c.type === 'phys'), m = arrow.filter((c) => c.target === e && c.type === 'arts');
      assert.equal(p.length, 5, `${id} ${moduleId}: five pulses reach it`);
      assert.equal(m.length, 5);
      assert.ok(p.every((c) => near(c.amount, phys(A * bb.atk_scale, def))) && m.every((c) => near(c.amount, A * bb.atk_scale_magic)));
    }
    assert.equal(arrow.filter((c) => c.target === hv).length, 0, 'a tile off the line: missed');
    assert.equal(arrow.filter((c) => c.target === h.enemy('enemy_fly')).length, 10, 'a flyer on the line: hit');
    const beams = h.eventsOf('fx').filter((e) => e[1] === 'beam').map((e) => e[4]);
    assert.ok(beams.every((x) => x.from === u.id && x.kind === 'dragonArrow'), 'shooter → target beams');
    assert.deepEqual(beams.map((x) => x.to).sort(), [d.id, a.id, h.enemy('enemy_fly').id].sort(), 'one per enemy it passed');
    assert.ok(near(d.x, x0.d + h.b.pushDistance(d, bb.force), 1e-3) && near(a.x, x0.a + h.b.pushDistance(a, bb.force), 1e-3), 'pushed along her facing');
    done(h);
  }
});

test('焰狐龙梓兰 T1 强击瓶专家: from her first skill of a deployment, the next 50 attacks ×1.15; a redeploy closes it until the next skill', () => {
  for (const id of [ID6, ELITE6]) {
    const t0 = talOf(id, 0), ds = dsOf(id);
    const h = run({ units: [U(id, S3, 10, 3)], enemies: [{ key: 'enemy_heavy', pos: [10, 5] }] });
    const u = h.unit(id);
    h.run(110);
    const A = u.s.atk;
    const t1 = h.hooksOf('skillStart').find((c) => c.unit === u).t;
    const atks = attacksOf(h, u);
    const pre = atks.filter((a) => a[0].t < t1), post = atks.filter((a) => a[0].t > t1);
    assert.ok(pre.length >= 2 && pre.flat().every((c) => near(c.amount, A * ds)), 'before her first skill: ×1');
    assert.ok(post.length > t0.power_attack_count + 3, `${post.length} attacks after`);
    assert.ok(post.slice(0, t0.power_attack_count).flat().every((c) => near(c.amount, A * t0.power_attack_scale * ds)), 'the next 50: ×1.15');
    assert.ok(post.slice(t0.power_attack_count).flat().every((c) => near(c.amount, A * ds)), 'then ×1 (the later casts do not reopen it)');
    assert.ok(h.hooksOf('skillStart').filter((c) => c.unit === u).length >= 2);
    h.b.kill(u);
    assert.ok(h.b.redeploy(u));
    const back = h.b.time, A2 = u.s.atk; // (翔虫机动's ATK on this redeploy)
    h.run(3);
    const again = attacksOf(h, u, (c) => c.t > back + 0.5);
    assert.ok(again.length >= 1 && again.flat().every((c) => near(c.amount, A2 * ds)), 'redeployed: closed until her next skill');
    assert.ok(h.runUntil(() => h.hooksOf('skillStart').filter((c) => c.unit === u).at(-1).t > back, 15), 'her next skill');
    const t2 = h.hooksOf('skillStart').filter((c) => c.unit === u).at(-1).t;
    h.run(10);
    const reopened = attacksOf(h, u, (c) => c.t > t2 + 3.2);
    assert.ok(reopened.length >= 3 && reopened.flat().every((c) => near(c.amount, A2 * t0.power_attack_scale * ds)), 'reopened by the first skill of this deployment');
    done(h);
    // knocked out with the window still open: the redeploy closes it (what was left is lost)
    const g = run({ units: [U(id, S3, 10, 3)], enemies: [{ key: 'enemy_heavy', pos: [10, 5] }] });
    const v = g.unit(id);
    assert.ok(g.runUntil(() => v.skill.activations === 1 && !v.skill.active, 15));
    g.run(5);
    assert.ok(attacksOf(g, v).at(-1).every((c) => near(c.amount, v.s.atk * t0.power_attack_scale * ds)), 'open');
    g.b.kill(v);
    assert.ok(g.b.redeploy(v));
    const b2 = g.b.time;
    g.run(3);
    const after = attacksOf(g, v, (c) => c.t > b2 + 0.5);
    assert.ok(after.length >= 1 && after.flat().every((c) => near(c.amount, v.s.atk * ds)), 'closed by the redeploy');
    done(g);
  }
});

test('焰狐龙梓兰 T1: a 【移动】 keeps the open window (no exit: the buff stays)', () => {
  for (const id of [ID6, ELITE6]) {
    const t0 = talOf(id, 0), ds = dsOf(id);
    const h = run({ units: [U(id, S3, 10, 3, { carryState: { sp: skillOf(id, S3).spCost } })], enemies: [{ key: 'enemy_heavy', pos: [10, 5] }] });
    const u = h.unit(id);
    assert.ok(h.runUntil(() => u.skill.activations === 1 && !u.skill.active, 6));
    h.run(4);
    const left = u.mem.orchd2.left;
    assert.ok(attacksOf(h, u).length >= 2 && left > 0 && left < t0.power_attack_count, `window open (${left} left)`);
    assert.ok(h.b.moveRedeploy(u, 10, 4));
    assert.equal(u.mem.orchd2.left, left, 'kept');
    const t = h.b.time;
    h.run(4);
    const after = attacksOf(h, u, (c) => c.t > t + 0.3);
    assert.ok(after.length >= 2 && after.flat().every((c) => near(c.amount, u.s.atk * t0.power_attack_scale * ds)), 'still powered after the move');
    done(h);
  }
});

test('焰狐龙梓兰 T2 翔虫机动: redeploy time −respawn_time (once), each redeploy costs her cost (never raised), WAIT_DP — every loadout', () => {
  for (const [id, moduleId] of LOADOUTS) {
    const r = raw(id, moduleId), cost = r.stats.cost;
    const wait = Math.max(0, r.stats.respawnTime + talOf(id, 3, moduleId).respawn_time);
    const h = run({ units: [U(id, S3, 10, 3, { moduleId })], flags: { dpPerSec: 0 } });
    const u = h.unit(id);
    h.step(1);
    for (let i = 0; i < 2; i++) {
      h.b.kill(u);
      assert.ok(near(u.respawnAt - u.deathAt, wait), `${id} ${moduleId}: ${u.respawnAt - u.deathAt} s (${wait})`);
      h.b.getPlayer('p1').dp = 50;
      h.run(wait - 0.1);
      assert.ok(!u.alive, 'still counting');
      h.run(0.2);
      assert.ok(u.alive, `redeployed after ${wait} s`);
      assert.equal(dp(h), 50 - cost, `redeploy #${i + 1} costs ${cost} (不提高部署费用)`);
    }
    h.b.kill(u);
    h.b.getPlayer('p1').dp = cost - 1;
    h.run(wait + 0.5);
    assert.ok(h.b.isDown(u));
    assert.equal(h.snapshot().down.find((x) => x[0] === u.id)[3], DOWN_STATE.WAIT_DP);
    h.b.addDp('p1', 1);
    h.step(1);
    assert.ok(u.alive && dp(h) === 0, 'redeploys once the DP is there, paying all of it');
    done(h);
  }
});

test('焰狐龙梓兰 T2: ATK +atk for atk_duration s on a redeploy near her exit tile (x-1 / x-2 by module level); not at the start or after a move', () => {
  for (const [id, moduleId] of LOADOUTS) {
    const t1 = talOf(id, 1, moduleId), range = raw(id, moduleId).talents.find((t) => t.index === 1).bbStr.ignore_build_type_target_range;
    const h = run({ units: [U(id, S3, 10, 3, { moduleId })] });
    const u = h.unit(id);
    h.step(1);
    assert.equal(u.findBuff('orchd2:wirebug'), null, 'nothing at the battle start');
    h.b.kill(u);
    assert.ok(h.b.redeploy(u));
    const b = u.findBuff('orchd2:wirebug');
    assert.ok(b && b.mods.atkPct === t1.atk && near(b.timeLeft, t1.atk_duration), `${id} ${moduleId}: +${t1.atk} for ${t1.atk_duration} s`);
    assert.ok(near(u.s.atk, u.base.atk * (1 + t1.atk)));
    h.run(t1.atk_duration + 0.1);
    assert.equal(u.findBuff('orchd2:wirebug'), null, 'lapses');
    // a retreat is an exit too (the marker is left where she stood): her automatic redeploy on that tile gets it
    h.b.retreat(u);
    h.b.getPlayer('p1').dp = 99;
    h.run(u.respawnAt - h.b.time + 0.1);
    assert.ok(u.alive && u.findBuff('orchd2:wirebug'), 'after a retreat');
    h.b.removeBuff(u, 'orchd2:wirebug');
    // a tile (+1 row, +2 cols) away: inside x-2 (ARC-X level 3), outside x-1
    h.b.kill(u);
    assert.ok(h.b.redeploy(u, { tile: [11, 5] }));
    assert.equal(!!u.findBuff('orchd2:wirebug'), range === 'x-2', `${range}`);
    // 【移动】: no exit, no marker
    h.b.kill(u);
    assert.ok(h.b.redeploy(u, { tile: [11, 5] }));
    assert.ok(h.b.moveRedeploy(u, 11, 3));
    assert.ok(u.findBuff('orchd2:wirebug'), 'the redeploy\'s buff stays');
    h.b.removeBuff(u, 'orchd2:wirebug');
    assert.ok(h.b.moveRedeploy(u, 10, 3));
    assert.equal(u.findBuff('orchd2:wirebug'), null, 'a move gives none');
    done(h);
  }
});

test('焰狐龙梓兰: two copies keep their own redeploy times and buffs; two players on one field pay their own DP', () => {
  const h = run({ units: [U(ELITE6, S3, 10, 3, { uid: 1 }), U(ELITE5, S3, 11, 3, { uid: 2 })], flags: { dpPerSec: 0 } });
  const a = h.unit(1), b = h.unit(2);
  h.step(1);
  h.b.kill(a);
  h.b.kill(b);
  assert.ok(near(a.respawnAt - a.deathAt, rec(ELITE6).stats.respawnTime + talOf(ELITE6, 3).respawn_time));
  assert.ok(near(b.respawnAt - b.deathAt, rec(ELITE5).stats.respawnTime + talOf(ELITE5, 3).respawn_time));
  assert.ok(h.b.redeploy(a));
  assert.ok(a.findBuff('orchd2:wirebug') && !b.findBuff('orchd2:wirebug'), 'only the one redeployed');
  assert.equal(a.findBuff('orchd2:wirebug').mods.atkPct, talOf(ELITE6, 1).atk);
  assert.ok(h.b.redeploy(b));
  assert.equal(b.findBuff('orchd2:wirebug').mods.atkPct, talOf(ELITE5, 1).atk, 'each its own module level');
  done(h);
  const players = [
    { playerId: 'p1', seat: 0, side: 'L', colOffset: 0, bonds: {}, units: [{ uid: 1, kind: 'chess', chessId: ELITE6, skillIndex: 2, row: 10, col: 3 }] },
    { playerId: 'p2', seat: 1, side: 'L', colOffset: 8, bonds: {}, units: [{ uid: 2, kind: 'chess', chessId: ID6, skillIndex: 2, row: 10, col: 3 }] },
  ];
  const g = run({ kind: 'unite', players, flags: { dpPerSec: 0 } });
  g.step(1);
  const p2 = g.unit(2);
  g.b.kill(p2);
  g.b.getPlayer('p1').dp = 40;
  g.b.getPlayer('p2').dp = 40;
  g.run(p2.respawnAt - g.b.time + 0.1);
  assert.ok(p2.alive, 'p2\'s 焰狐龙梓兰 redeployed');
  assert.equal(g.b.getPlayer('p2').dp, 40 - rec(ID6).stats.cost, 'p2 pays');
  assert.equal(g.b.getPlayer('p1').dp, 40, 'p1 untouched');
  done(g);
});

test('焰狐龙梓兰: every skill × tier survives a real wave and casts', () => {
  for (const id of [ID5, ID6, ELITE5, ELITE6]) for (const s of rec(id).skills) {
    const h = makeBattle({ defs: DEFS, seed: 3, timeLimit: 60,
      units: [U(id, s.skillId, 10, 4, { carryState: READY }), { chessId: 'chess_char_2_06_a', row: 10, col: 6 }],
      enemies: [{ key: 'enemy_1007_slime', count: 8, interval: 1.5 }, { key: 'enemy_1007_slime', route: 1, count: 8, interval: 1.5, time: 3 }] });
    h.runToEnd(90);
    done(h);
    assert.ok(h.b.allyUnits.find((x) => x.defId === id).skill.activations > 0, `${id} ${s.skillId} casts`);
  }
});
