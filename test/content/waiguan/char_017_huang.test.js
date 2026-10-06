// test/content/waiguan/char_017_huang.test.js — 煌 外援 kit (server/sim/content/kits/waiguan/char_017_huang.js).
// Every skill (normal Lv4 + elite Lv7), each talent (incl. the module upgrades), each module choice, a smoke wave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, checkInvariants, hashOf } from '../../helpers/battleHarness.js';
import { DataSource, getDefaultSource } from '../../../server/sim/simdata.js';
import { getData } from '../../../server/data.js';
import { waiguanRecords } from '../../../shared/waiguan.js';
import { skillSpecSource } from '../../../server/sim/content/index.js';
import { COLS } from '../../../server/sim/constants.js';
import WAIGUAN from '../../../server/sim/content/kits/waiguan/index.js';

const CHAR = 'char_017_huang';
const ID5 = `chess_char_diy_5_${CHAR}_a`, ID6 = `chess_char_diy_6_${CHAR}_a`;
const ELITE5 = ID5.replace(/_a$/, '_b'), ELITE6 = ID6.replace(/_a$/, '_b');
const CEN_X = 'uniequip_002_huang', CEN_Y = 'uniequip_003_huang';
/** Both tiers' elites: tier V uses module level 1 once stream D lands — every expectation is read from the record. */
const ELITES = [ELITE5, ELITE6];
const REC = waiguanRecords(getData({ log: { warn() {}, error() {}, info() {} } }).waiguan);
const DS = new DataSource({ chess: REC }, getDefaultSource());
const rec = (id) => REC[id];
const skillOf = (id, sid) => rec(id).skills.find((s) => s.skillId === sid);
/** Loadout-resolved talent blackboard (data index `i`) of `id` with module `moduleId`. */
const talOf = (id, i, moduleId = null) => DS.getChess(id, { skillIndex: 0, moduleId }).raw.talents.find((t) => t.index === i)?.bb ?? {};
/** Loadout-resolved trait blackboard. */
const traitOf = (id, moduleId = null) => DS.getChess(id, { skillIndex: 0, moduleId }).raw.trait?.bb ?? {};
/** 紧急除颤 stages of a loadout, read from the record as the kit reads them: talent 0, then the CEN-Y hidden part. */
const stagesOf = (id, moduleId = null) => {
  const t0 = talOf(id, 0, moduleId), hb = talOf(id, -1, moduleId), p = 'huang_e_003[lock].';
  const out = [{ thr: t0.hp_ratio, heal: t0['huang_t_1[heal].hp_ratio'], floor: t0['huang_t_1[lock].min_hp_ratio'], dur: t0['huang_t_1[lock].duration'] }];
  if (hb[`${p}check_hp_ratio`] > 0) out.push({ thr: hb[`${p}check_hp_ratio`], heal: hb[`${p}hp_ratio`], floor: hb[`${p}min_hp_ratio`], dur: hb[`${p}duration`] });
  return out;
};
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e7, speed: 0, ...o });
const DEFS = {
  chess: REC,
  enemies: {
    enemy_dummy: dummy('enemy_dummy'), enemy_armored: dummy('enemy_armored', { def: 300 }), enemy_weak: dummy('enemy_weak', { hp: 600 }),
    enemy_fly: dummy('enemy_fly', { motion: 'FLY' }),
  },
};
const READY = { sp: 999 };
const TANK = 'chess_char_1_02_a'; // 角峰 (pool 铁卫): blocks an enemy that is not hers
/** Every elite module choice of both tiers, plus the normal chess. */
const LOADOUTS = [[ID6, undefined], ...[ELITE5, ELITE6].flatMap((id) => [[id, null], [id, CEN_X], [id, 'none'], [id, CEN_Y]])];
const HOOKS = ['damaged', 'heal', 'skillStart', 'skillEnd', 'statusApplied', 'attack', 'deploy', 'fatal'];
/** Battle with the 外援 records + synthetic dummies; `captureNoisy` keeps the damaged / heal / attack contexts. */
const run = (o) => makeBattle({ defs: DEFS, seed: 7, timeLimit: 300, autoFinish: false, hooks: HOOKS, captureNoisy: true, ...o });
/** Operator entry with skill `sid` selected (board coords: row 9–12, col 2–10). */
const U = (id, sid, row, col, o = {}) => ({ chessId: id, row, col, skillIndex: skillOf(id, sid).index, ...o });
const done = (h) => { checkInvariants(h.b); assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0])); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const keyAt = (r, c) => r * COLS + c;
/** A source of synthetic damage far from her range (a dummy enemy at the far end of row 12). */
const SRC = { key: 'enemy_dummy', pos: [12, 9] };
const hurt = (h, u, amount, type = 'true') => h.b.dealDamage(h.enemies().find((e) => e.y === 12), u, { amount, type });

test('煌: every skill of both tiers (normal + elite, every module) is hand-authored', () => {
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

test('煌 S1 强力击·γ型: the next attack ×atk_scale on every blocked enemy; recast every 4th attack (attack SP, cost 3)', () => {
  const cases = [[ID6, undefined], ...ELITES.flatMap((id) => [[id, null], [id, 'none'], [id, CEN_Y]])];
  for (const [id, moduleId] of cases) {
    const bb = skillOf(id, 'skchr_huang_1').bb, sc = traitOf(id, moduleId).atk_scale ?? 1; // CEN-X trait: blocked ×atk_scale
    const h = run({ units: [U(id, 'skchr_huang_1', 10, 4, { carryState: READY, moduleId })], enemies: [0, 1, 2].map(() => ({ key: 'enemy_dummy', pos: [10, 4] })) });
    const u = h.unit(id);
    assert.ok(h.runUntil(() => u.skill.activations > 0, 5), 'casts');
    assert.equal(u.skill.rule, 'DEFAULT');
    assert.equal(u.blocking.length, 3, 'blocks the three dummies');
    const first = h.hooksOf('damaged').filter((c) => c.source === u && c.dmg.isSkill);
    assert.equal(first.length, 3, 'the skill attack hits every blocked enemy');
    for (const c of first) assert.ok(near(c.amount, u.s.atk * bb.atk_scale * sc), `${id} ${moduleId}: ${c.amount} vs ${u.s.atk} × ${bb.atk_scale} × ${sc}`);
    h.run(12);
    const flags = h.hooksOf('attack').filter((c) => c.attacker === u).map((c) => c.isSkill);
    assert.deepEqual(flags.slice(0, 9), [true, false, false, false, true, false, false, false, true]);
    done(h);
  }
});

test('煌 S2 链锯延伸模块: an endless toggle — ATK +atk, DEF +def, range 2-2 (Lv4 / Lv7, every module)', () => {
  for (const [id, moduleId] of LOADOUTS) {
    const bb = skillOf(id, 'skchr_huang_2').bb;
    const h = run({ units: [U(id, 'skchr_huang_2', 10, 4, { carryState: READY, moduleId })],
      enemies: [{ key: 'enemy_weak', pos: [10, 5] }, { key: 'enemy_dummy', pos: [10, 6] }] });
    const u = h.unit(id);
    assert.ok(h.runUntil(() => u.skill.active, 5), 'casts on the enemy in front (DEFAULT)');
    assert.equal(u.baseRangeKeys.includes(keyAt(10, 6)), false, 'two tiles ahead is out of her own range');
    assert.equal(u.skill.kind, 'toggle');
    assert.ok(near(u.s.atk, u.base.atk * (1 + bb.atk)) && near(u.s.def, u.base.def * (1 + bb.def)), 'ATK / DEF up');
    assert.ok(u.rangeKeySet.has(keyAt(10, 6)), 'the skill range reaches two tiles ahead');
    h.run(120);
    assert.ok(u.skill.active, 'still on after 2 minutes (持续时间无限)');
    const far = h.enemies().find((e) => e.x === 6);
    assert.ok(h.hooksOf('damaged').some((c) => c.source === u && c.target === far), 'the enemy two tiles ahead is attacked');
    done(h);
  }
});

test('煌 S3 沸腾爆裂: ATK/DEF in 1 s steps, cuts every enemy in range, end: −25 % max HP then a blast on her range (every loadout)', () => {
  for (const [id, moduleId] of LOADOUTS) {
    const sk = skillOf(id, 'skchr_huang_3'), bb = sk.bb;
    const h = run({ units: [U(id, 'skchr_huang_3', 10, 4, { carryState: READY, moduleId })],
      enemies: [{ key: 'enemy_dummy', pos: [10, 5] }, { key: 'enemy_dummy', pos: [10, 5] }, { key: 'enemy_dummy', pos: [10, 6] }] });
    const u = h.unit(id);
    assert.ok(h.runUntil(() => u.skill.active, 5), 'casts');
    assert.equal(u.skill.rule, 'DEFAULT');
    // the bonus after k whole seconds: +atk × k / duration (1 s steps), constant inside a step
    const at = (x) => {
      h.runUntil(() => sk.duration - u.skill.timeLeft >= x, 20);
      const k = Math.floor(sk.duration - u.skill.timeLeft + 1e-6);
      assert.ok(near(u.s.atk, u.base.atk * (1 + (bb.atk * k) / sk.duration)) && near(u.s.def, u.base.def * (1 + (bb.def * k) / sk.duration)), `${id} ${moduleId} step ${k}`);
      return [k, u.s.atk];
    };
    const steps = [0.5, 4.2, 4.8, 9.5].map(at);
    assert.deepEqual(steps.map((x) => x[0]), [0, 4, 4, 9]);
    assert.ok(steps[0][1] === u.base.atk && steps[1][1] === steps[2][1] && steps[3][1] > steps[2][1], 'a step per second, flat in between');
    const skillAtk = h.hooksOf('attack').filter((c) => c.attacker === u && c.isSkill);
    assert.ok(skillAtk.length > 0 && skillAtk.every((c) => c.targets.length === 2), 'each attack cuts both unblocked enemies in front');
    const maxHp = u.s.maxHp;
    h.runUntil(() => !u.skill.active, 20);
    const self = h.hooksOf('damaged').filter((c) => c.target === u && c.dmg.tags.includes('huangS3Self'));
    assert.equal(self.length, 1);
    assert.ok(near(self[0].amount, maxHp * bb.hp_ratio), 'loses hp_ratio × max HP');
    const blast = h.hooksOf('damaged').filter((c) => c.source === u && c.dmg.tags.includes('huangS3Blast'));
    assert.equal(blast.length, 2, 'the blast hits the two enemies of her range, not the one two tiles ahead');
    for (const c of blast) assert.ok(near(c.amount, u.base.atk * (1 + bb.atk) * bb.damage_by_atk_scale), `the last step's ATK: ${c.amount}`);
    assert.ok(near(u.s.atk, u.base.atk), 'the ramp ends with the skill');
    done(h);
  }
});

test('煌 S3 blast: flyers and the enemies she blocks are hit; the fx flashes exactly the tiles of the area', () => {
  for (const id of [ID6, ELITE5]) {
    const h = run({ units: [U(id, 'skchr_huang_3', 10, 4, { carryState: READY })],
      enemies: [{ key: 'enemy_dummy', pos: [10, 4] }, { key: 'enemy_fly', pos: [10, 5], route: 2 }, { key: 'enemy_armored', pos: [10, 5] }, { key: 'enemy_weak', pos: [10, 6] }] });
    const u = h.unit(id);
    assert.ok(h.runUntil(() => u.skill.active, 5));
    assert.equal(h.enemy('enemy_dummy').blockedBy, u, 'she blocks the dummy on her tile');
    assert.ok(h.enemy('enemy_fly').isFlying);
    h.runUntil(() => !u.skill.active, 20);
    const blast = h.hooksOf('damaged').filter((c) => c.source === u && c.dmg.tags.includes('huangS3Blast'));
    assert.deepEqual(blast.map((c) => c.target.defId).sort(), ['enemy_armored', 'enemy_dummy', 'enemy_fly'], 'blocked + flyer + the front tile, not two tiles ahead');
    const fx = h.eventsOf('fx').filter((e) => e[1] === 'explode' && e[4]?.id === u.id);
    assert.equal(fx.length, 1);
    const tiles = new Set(fx[0][4].tiles.map(([r, c]) => keyAt(r, c)));
    assert.equal(fx[0][4].r, undefined, 'a tile area, not a disc');
    for (const c of blast) assert.ok(tiles.has(keyAt(Math.round(c.target.y), Math.round(c.target.x))), `${c.target.defId} on a flashed tile`);
    assert.deepEqual([...tiles].sort(), [...new Set([keyAt(10, 4), keyAt(10, 5)])].sort());
    done(h);
  }
});

test('煌 S3 ended by a knock-out or a retreat: no HP loss, no blast', () => {
  const [g] = stagesOf(ID6);
  for (const how of ['retreat', 'killed']) {
    const h = run({ units: [U(ID6, 'skchr_huang_3', 10, 4, { carryState: READY })], enemies: [{ key: 'enemy_dummy', pos: [10, 5] }, SRC] });
    const u = h.unit(ID6);
    assert.ok(h.runUntil(() => u.skill.active, 5));
    h.run(0.5);
    if (how === 'retreat') h.b.retreat(u);
    else {
      hurt(h, u, u.s.maxHp * 10); // 紧急除颤 saves her once (its 不死) …
      assert.ok(u.alive);
      h.run(g.dur + 0.5);
      assert.ok(u.skill.active, 'still in the skill');
      hurt(h, u, u.s.maxHp * 10); // … then she falls
    }
    assert.equal(u.alive, false);
    assert.equal(h.hooksOf('skillEnd').find((c) => c.unit === u)?.reason, 'death');
    assert.equal(h.hooksOf('damaged').filter((c) => c.dmg.tags.includes('huangS3Self') || c.dmg.tags.includes('huangS3Blast')).length, 0, how);
    assert.equal(u.findBuff('huang:s3'), null);
    done(h);
  }
});

test('煌 S3: the end-of-skill loss is never lethal (and 紧急除颤 fires on it)', () => {
  const h = run({ units: [U(ID6, 'skchr_huang_3', 10, 4, { carryState: READY })], enemies: [{ key: 'enemy_dummy', pos: [10, 5] }] });
  const u = h.unit(ID6);
  const [g] = stagesOf(ID6);
  assert.ok(h.runUntil(() => u.skill.active && u.skill.timeLeft < 0.1, 20));
  u.hp = u.s.maxHp * g.thr * 0.8;
  h.runUntil(() => !u.skill.active, 2);
  assert.ok(u.alive);
  assert.ok(near(u.hp, 1 + u.s.maxHp * g.heal), `1 HP left, then the talent heal: ${u.hp}`);
  done(h);
});

test('煌 T1 紧急除颤: once at ≤ 25 % — heal 50 %, 6 s at ≥ 50 %; a lethal hit before it is survived; re-armed per deployment', () => {
  const [g] = stagesOf(ID6);
  const h2 = run({ units: [U(ID6, 'skchr_huang_1', 10, 4)], enemies: [SRC] });
  const v = h2.unit(ID6);
  h2.run(0.5);
  hurt(h2, v, v.s.maxHp * 10);
  assert.ok(v.alive && near(v.hp, 1 + v.s.maxHp * g.heal), 'a lethal hit leaves 1 HP and fires the talent');
  assert.ok(h2.eventsOf('fx').some((e) => e[1] === 'emergency'));
  h2.run(g.dur + 1);
  h2.b.retreat(v);
  assert.ok(h2.b.redeploy(v, { free: true }));
  hurt(h2, v, v.s.maxHp * (1 - g.thr + 0.05));
  assert.ok(near(v.hp, v.s.maxHp * (g.thr - 0.05 + g.heal)), 'fires again in the next deployment');
  done(h2);
});

/**
 * Walk every 紧急除颤 stage of a loadout: no stage just above its threshold; below it (the last stage of several by a
 * lethal hit: its 不死) the heal; inside the lock a huge hit leaves the floor; after the lock the next stage; when all
 * are spent a lethal hit kills.
 */
function walkStages(id, moduleId) {
  const st = stagesOf(id, moduleId);
  const h = run({ units: [U(id, 'skchr_huang_1', 10, 4, { moduleId })], enemies: [SRC] });
  const u = h.unit(id);
  h.run(0.5);
  const M = u.s.maxHp;
  st.forEach((g, i) => {
    hurt(h, u, u.hp - M * (g.thr + 0.02));
    assert.ok(near(u.hp, M * (g.thr + 0.02)), `${id} ${moduleId} stage ${i}: nothing above ${g.thr}`);
    if (i > 0 && i === st.length - 1) {
      hurt(h, u, M * 10);
      assert.ok(u.alive && near(u.hp, 1 + M * g.heal), `stage ${i}: a lethal hit is survived (不死) and heals`);
    } else {
      hurt(h, u, M * 0.04);
      assert.ok(near(u.hp, Math.min(M, M * (g.thr - 0.02 + g.heal))), `stage ${i}: heals at ≤ ${g.thr}`);
    }
    h.run(g.dur - 0.5);
    const before = u.hp;
    hurt(h, u, M * 10);
    assert.ok(u.alive && near(u.hp, Math.min(M * g.floor, before)), `stage ${i}: the ${g.dur} s lock holds ${g.floor}`);
    h.run(1);
  });
  hurt(h, u, M * 10);
  assert.equal(u.alive, false, `${id} ${moduleId}: every stage spent`);
  done(h);
  return st.length;
}

test('煌 T1 紧急除颤 on both tiers\' elites and every module (CEN-Y: a first stage at ≤ 50 %, then ≤ 25 %)', () => {
  assert.equal(walkStages(ID6, undefined), 1);
  for (const id of ELITES) {
    for (const m of [null, 'none']) assert.equal(walkStages(id, m), 1);
    const n = walkStages(id, CEN_Y);
    assert.equal(n, talOf(id, -1, CEN_Y)['huang_e_003[lock].check_hp_ratio'] > 0 ? 2 : 1);
  }
});

test('煌 module CEN-Y trait / hidden part: −damage_resistance physical taken and DEF −def_penetrate_fixed for her hits above hp_ratio', () => {
  for (const id of ELITES) {
    const tb = traitOf(id, CEN_Y), hb = talOf(id, -1, CEN_Y);
    const h = run({ units: [U(id, 'skchr_huang_1', 10, 4, { moduleId: CEN_Y })], enemies: [SRC] });
    const u = h.unit(id);
    h.run(0.5);
    const phys = (amount) => {
      h.b.dealDamage(h.enemies().find((e) => e.y === 12), u, { amount, type: 'phys' });
      return h.hooksOf('damaged').filter((c) => c.target === u && c.type === 'phys').at(-1).amount;
    };
    assert.ok(near(phys(500), (500 - u.s.def) * (1 - (tb.damage_resistance ?? 0))), `${id}: above hp_ratio`);
    if (tb.hp_ratio > 0) {
      u.hp = u.s.maxHp * tb.hp_ratio;
      assert.ok(near(phys(500), 500 - u.s.def), `${id}: at hp_ratio, no cut`);
    }
    done(h);
    const hit = (moduleId, hpRatio = 1) => {
      const g = run({ units: [U(id, 'skchr_huang_2', 10, 4, { moduleId })], enemies: [{ key: 'enemy_armored', pos: [10, 4] }] });
      const w = g.unit(id);
      g.step(1);
      w.hp = w.s.maxHp * hpRatio; // (no damage event: 紧急除颤 stays armed)
      const mine = () => g.hooksOf('damaged').filter((x) => x.source === w);
      const n = mine().length;
      g.runUntil(() => mine().length > n, 5);
      const c = mine().at(-1);
      done(g);
      return c.amount - w.s.atk * (traitOf(id, moduleId).atk_scale ?? 1);
    };
    assert.ok(near(hit(CEN_Y), -(300 - (hb.def_penetrate_fixed ?? 0))), `${id} CEN-Y: DEF 300 − def_penetrate_fixed`);
    assert.ok(near(hit(CEN_Y, (hb.hp_ratio ?? 0.5) * 0.8), -300), `${id} CEN-Y below hp_ratio: full DEF`);
    assert.ok(near(hit('none'), -300), `${id} none: full DEF`);
  }
});

test('煌 module CEN-X: ATK ×atk_scale against a blocked enemy — blocked by anyone (a pool tank during S3) — else ×1', () => {
  for (const id of ELITES) for (const moduleId of [null, 'none', CEN_Y]) {
    const want = traitOf(id, moduleId).atk_scale ?? 1;
    const h = run({ units: [U(id, 'skchr_huang_3', 10, 4, { carryState: READY, moduleId }), { chessId: TANK, row: 10, col: 5 }], enemies: [{ key: 'enemy_dummy', pos: [10, 5] }] });
    const u = h.unit(id);
    assert.ok(h.runUntil(() => u.skill.active, 5));
    assert.equal(h.enemy('enemy_dummy').blockedBy, h.unit(TANK), 'the tank blocks it');
    h.step(1);
    const c = h.hooksOf('damaged').find((x) => x.source === u && x.dmg.isAttack);
    assert.ok(c && near(c.amount, u.s.atk * want), `${id} ${moduleId}: ${c?.amount} vs ${u.s.atk} × ${want}`);
    done(h);
  }
});

test('煌 module CEN-X: ATK ×atk_scale against the enemies she blocks; other modules: ×1; unblocked: ×1', () => {
  for (const id of ELITES) {
    for (const moduleId of [null, CEN_X, 'none', CEN_Y]) {
      const want = traitOf(id, moduleId).atk_scale ?? 1;
      const h = run({ units: [U(id, 'skchr_huang_2', 10, 4, { moduleId })], enemies: [{ key: 'enemy_dummy', pos: [10, 4] }] });
      const u = h.unit(id);
      h.runUntil(() => h.hooksOf('damaged').some((c) => c.source === u), 5);
      const c = h.hooksOf('damaged').find((x) => x.source === u);
      assert.ok(near(c.amount, u.s.atk * want), `${id} ${moduleId}: blocked ${c.amount}`);
      done(h);
    }
    const def = rec(id).modules?.find((m) => m.uniEquipId === rec(id).module?.id);
    assert.equal(traitOf(id, null).atk_scale ?? 1, def?.traitOverride?.bb?.atk_scale ?? 1, `${id}: the default module's trait`);
    // an unblocked enemy in front (S3 cuts it): no bonus
    const h = run({ units: [U(id, 'skchr_huang_3', 10, 4, { carryState: READY })], enemies: [{ key: 'enemy_dummy', pos: [10, 5] }] });
    const u = h.unit(id);
    h.runUntil(() => h.hooksOf('damaged').some((c) => c.source === u && c.dmg.isAttack), 5);
    const c = h.hooksOf('damaged').find((x) => x.source === u && x.dmg.isAttack);
    assert.equal(c.target.blockedBy, null);
    assert.ok(near(c.amount, u.s.atk), 'unblocked: ×1');
    done(h);
  }
});

test('煌 T2 严酷训练: 抵抗 after 15 s on the field; CEN-X adds ATK +6 % at 30 s and ASPD +12 at 45 s', () => {
  const TIMES = [14.9, 15.1, 29.9, 30.1, 44.9, 45.1];
  const seen = (id, moduleId) => {
    const h = run({ units: [U(id, 'skchr_huang_1', 10, 4, { moduleId })] });
    const u = h.unit(id);
    const out = TIMES.map((t) => { h.runUntil(() => h.b.time >= t, 60); return { resist: h.b.resistOf(u), atk: Math.round((u.s.atk / u.base.atk) * 1e6) / 1e6, aspd: u.s.aspd }; });
    done(h);
    return out;
  };
  /** What the record says: 抵抗 at `interval`, ATK / ASPD at their own intervals when the loadout has them. */
  const want = (id, moduleId) => {
    const t1 = talOf(id, 1, moduleId);
    const res = -t1.one_minus_status_resistance, ai = t1['huang_t_2[e_002_atk].interval'], si = t1['huang_t_2[e_002_atk_speed].interval'];
    return TIMES.map((t) => ({
      resist: t >= t1.interval ? res : 0,
      atk: Math.round((1 + (ai > 0 && t >= ai ? t1['huang_t_2[e_002_atk].atk'] : 0)) * 1e6) / 1e6,
      aspd: 100 + (si > 0 && t >= si ? t1['huang_t_2[e_002_atk_speed].attack_speed'] : 0),
    }));
  };
  for (const [id, m] of [[ID6, undefined], ...ELITES.flatMap((id) => [[id, null], [id, 'none'], [id, CEN_Y]])]) {
    assert.deepEqual(seen(id, m), want(id, m), `${id} ${m}`);
  }
  assert.ok(talOf(ELITE6, 1)['huang_t_2[e_002_atk].atk'] > 0, 'the T6 elite default module (CEN-X) carries the ATK / ASPD steps');
});

test('煌 T2 严酷训练: a knock-out drops the steps, the next deployment counts them again (CEN-X past 45 s)', () => {
  for (const id of ELITES) {
    const t1 = talOf(id, 1);
    const atk = t1['huang_t_2[e_002_atk].atk'] ?? 0, as = t1['huang_t_2[e_002_atk_speed].attack_speed'] ?? 0;
    const res = -t1.one_minus_status_resistance;
    const h = run({ units: [U(id, 'skchr_huang_1', 10, 4)] });
    const u = h.unit(id);
    const look = () => [h.b.resistOf(u), Math.round((u.s.atk / u.base.atk) * 1e6) / 1e6, u.s.aspd];
    h.run(46);
    assert.deepEqual(look(), [res, Math.round((1 + atk) * 1e6) / 1e6, 100 + as], `${id}: every step after 45 s`);
    h.b.retreat(u);
    assert.ok(h.b.redeploy(u, { free: true }));
    const t0 = h.b.time;
    assert.deepEqual(look(), [0, 1, 100], 'all gone with the knock-out');
    const after = (x) => { h.runUntil(() => h.b.time - t0 >= x, 60); return look(); };
    assert.deepEqual(after(t1.interval - 0.1), [0, 1, 100]);
    assert.deepEqual(after(t1.interval + 0.1)[0], res, '抵抗 again after interval s');
    if (atk) assert.equal(after(t1['huang_t_2[e_002_atk].interval'] + 0.1)[1], Math.round((1 + atk) * 1e6) / 1e6);
    if (as) assert.equal(after(t1['huang_t_2[e_002_atk_speed].interval'] + 0.1)[2], 100 + as);
    done(h);
  }
});

test('煌: every skill × module survives a real wave without content errors and casts', () => {
  const cases = [];
  for (const id of [ID5, ID6, ...ELITES]) for (const s of rec(id).skills) cases.push([id, s.skillId, null]);
  for (const id of ELITES) for (const s of rec(id).skills) for (const m of ['none', CEN_Y]) cases.push([id, s.skillId, m]);
  for (const [id, sid, moduleId] of cases) {
    const h = makeBattle({ defs: DEFS, seed: 3, timeLimit: 60,
      units: [U(id, sid, 10, 4, { carryState: READY, moduleId }), { chessId: 'chess_char_2_06_a', row: 10, col: 6 }],
      enemies: [{ key: 'enemy_1007_slime', count: 8, interval: 1.5 }, { key: 'enemy_1007_slime', route: 1, count: 8, interval: 1.5, time: 3 }] });
    h.runToEnd(90);
    done(h);
    const u = h.b.allyUnits.find((x) => x.defId === id);
    assert.equal(u.kit.skillSource, 'skills');
    assert.ok(u.skill.activations > 0, `${id} ${sid} ${moduleId} casts`);
  }
});

test('煌: same seed ⇒ same battle (no randomness outside battle.rng)', () => {
  const once = () => {
    const h = makeBattle({ defs: DEFS, seed: 11, timeLimit: 60,
      units: [U(ELITE6, 'skchr_huang_3', 10, 4, { moduleId: CEN_Y }), { chessId: 'chess_char_2_06_a', row: 11, col: 5 }],
      enemies: [{ key: 'enemy_1007_slime', count: 10, interval: 1 }, { key: 'enemy_1007_slime', route: 1, count: 10, interval: 1, time: 2 }] });
    h.runToEnd(90);
    done(h);
    return hashOf(h.result());
  };
  assert.equal(once(), once());
});
