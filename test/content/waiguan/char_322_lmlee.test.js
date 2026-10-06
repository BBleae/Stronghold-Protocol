// test/content/waiguan/char_322_lmlee.test.js — 老鲤 外援 kit (server/sim/content/kits/waiguan/char_322_lmlee.js).
// The trait's DP payments with 有备无患 (amounts, timing per deployment, the charge, the 部署费用下限 of 可露希尔), 和气生财,
// every skill (normal Lv4 + elite Lv7), both tiers' elites × every module × every skill, two copies, two players.
// Expected numbers come from the records — never literals; DP is read from the player's pool (natural regen frozen).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, chessRec, checkInvariants } from '../../helpers/battleHarness.js';
import { DataSource, getDefaultSource } from '../../../server/sim/simdata.js';
import { getData } from '../../../server/data.js';
import { waiguanRecords } from '../../../shared/waiguan.js';
import { skillSpecSource } from '../../../server/sim/content/index.js';
import WAIGUAN from '../../../server/sim/content/kits/waiguan/index.js';
import { COLS } from '../../../server/sim/constants.js';

const CHAR = 'char_322_lmlee';
const ID5 = `chess_char_diy_5_${CHAR}_a`, ID6 = `chess_char_diy_6_${CHAR}_a`;
const EL5 = ID5.replace(/_a$/, '_b'), EL6 = ID6.replace(/_a$/, '_b');
const S1 = 'skchr_lmlee_1', S2 = 'skchr_lmlee_2', S3 = 'skchr_lmlee_3';
const MERX = 'uniequip_002_lmlee', MERY = 'uniequip_003_lmlee';
const CLOSUR = 'chess_char_diy_6_char_4228_closur_b';
const DATA = getData({ log: { warn() {}, error() {}, info() {} } });
const REC = waiguanRecords(DATA.waiguan);
const DS = new DataSource({ chess: REC }, getDefaultSource());
const rec = (id) => REC[id];
const skillOf = (id, sid) => rec(id).skills.find((s) => s.skillId === sid);
const sbb = (id, sid) => skillOf(id, sid).bb;
const loadout = (id, moduleId = null) => DS.getChess(id, { moduleId }).raw;
const talOf = (id, i, moduleId = null) => loadout(id, moduleId).talents.find((t) => t.index === i)?.bb ?? {};
const traitOf = (id, moduleId = null) => loadout(id, moduleId).trait.bb;
const merYOf = (id, moduleId = null) => (loadout(id, moduleId).module?.type === 'MER-Y' ? loadout(id, moduleId).talents.find((t) => t.index === -1).bb : null);
/** The trait's two payments of a loadout: base |cost|, 有备无患 |extra_cost|, the interval, the charge's stun. */
const payOf = (id, moduleId = null) => ({
  base: Math.abs(traitOf(id, moduleId).cost), extra: Math.abs(talOf(id, 1, moduleId).extra_cost), iv: traitOf(id, moduleId).interval, stun: talOf(id, 1, moduleId).stun,
});
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e7, speed: 0, ...o });
const DEFS = {
  chess: { ...REC, test_guard_a: chessRec({ id: 'test_guard_a', profession: 'WARRIOR', skill: null, stats: { maxHp: 1e5, atk: 1, def: 0, blockCnt: 1, cost: 10, respawnTime: 5 } }) },
  enemies: {
    enemy_dummy: dummy('enemy_dummy'), enemy_hitter: dummy('enemy_hitter', { atk: 400 }), enemy_shooter: dummy('enemy_shooter', { atk: 400, range: 9 }),
    enemy_flyer: dummy('enemy_flyer', { motion: 'FLY' }), enemy_res0: dummy('enemy_res0', { res: 0, def: 0 }),
  },
};
const HOOKS = ['damaged', 'hit', 'skillStart', 'skillEnd', 'death', 'deploy', 'statusApplied', 'merchantPay', 'attack'];
const run = (o) => makeBattle({ defs: DEFS, seed: 7, timeLimit: 400, autoFinish: false, hooks: HOOKS, captureNoisy: true, ...o });
const L = (id, sid, row, col, o = {}) => ({ uid: 1, chessId: id, row, col, skillIndex: skillOf(id, sid).index, ...o });
const READY = { sp: 999 };
const FROZEN_DP = (dp) => ({ dpInit: dp, dpPerSec: 0 });
const close = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≉ ${b}`);
const done = (h) => { checkInvariants(h.b); assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0])); };
const dpOf = (h, pid = 'p1') => h.b.getPlayer(pid).dp;
/** Run `seconds`, recording every DP change of player `pid` (time, delta) beyond the natural regen. */
function dpLog(h, seconds, pid = 'p1') {
  const out = [];
  let last = dpOf(h, pid);
  const end = h.b.time + seconds;
  while (h.b.time < end - 1e-9) {
    h.step(1);
    const now = dpOf(h, pid), d = now - last - h.b.flags.dpPerSec * h.b.dt;
    if (Math.abs(d) > 1e-6) out.push({ t: h.b.time, d });
    last = now;
  }
  return out;
}
const LOADOUTS = [[ID5, null], [ID6, null], [EL5, null], [EL6, null], [EL6, 'none'], [EL5, MERY], [EL6, MERY], [EL6, MERX]];

test('老鲤: every skill of both tiers (normal + elite, every module) is hand-authored', () => {
  for (const id of [ID5, ID6]) {
    assert.equal(typeof WAIGUAN[id], 'function', `${id} registered`);
    for (const cid of [id, id.replace(/_a$/, '_b')]) {
      const mods = cid.endsWith('_b') ? [null, 'none', ...(rec(cid).modules ?? []).map((m) => m.uniEquipId)] : [null];
      for (const s of rec(cid).skills) for (const moduleId of mods) {
        assert.equal(skillSpecSource(DS.getChess(cid, { skillIndex: s.index, moduleId }), WAIGUAN), 'skills', `${cid} ${s.skillId} ${moduleId}`);
      }
    }
  }
});

test('老鲤 trait + 有备无患: every interval from his deployment — |extra_cost| for the charge when the DP has it, then |cost|; short ⇒ withdrawn', () => {
  for (const [id, moduleId] of LOADOUTS) {
    const p = payOf(id, moduleId);
    assert.ok(p.extra > p.base && p.iv > 0, `${id} ${moduleId}`);
    const h = run({ units: [L(id, S1, 10, 4, { moduleId })], flags: FROZEN_DP(p.extra + 2 * p.base + 0.5) });
    const u = h.unit(1);
    h.step(1);
    const t0 = h.hooksOf('deploy').find((c) => c.unit === u).t;
    const log = dpLog(h, 4 * p.iv + 0.2);
    const tag = `${id} ${moduleId}`;
    assert.deepEqual(log.map((x) => +x.d.toFixed(9)), [-p.extra, -p.base, -p.base], `${tag} payments`);
    log.forEach((x, i) => close(x.t - t0, (i + 1) * p.iv, h.TICK + 1e-6, `${tag} payment ${i}`));
    assert.deepEqual(h.hooksOf('merchantPay').map((c) => c.cost), [p.extra, p.base, p.base, p.base], `${tag} merchantPay (the 4th cannot be paid)`);
    const d = h.hooksOf('death').find((c) => c.unit === u);
    assert.ok(d && d.reason === 'merchant', 'withdrawn when short');
    close(d.t - t0, 4 * p.iv, h.TICK + 1e-6);
    assert.equal(u.findBuff('lmlee:bounce'), null, 'the charge leaves with him');
    // back (DP for his cost): the count starts again from that deployment, the charge first
    h.b.getPlayer('p1').dp = u.base.cost + p.extra;
    assert.ok(h.runUntil(() => u.alive, u.base.respawnTime + 2));
    const t1 = h.b.time;
    const l2 = dpLog(h, p.iv + 0.1);
    assert.equal(l2.length, 1);
    close(l2[0].d, -p.extra, 1e-9, `${tag} charge again`);
    close(l2[0].t - t1, p.iv, h.TICK + 1e-6, `${tag} from the redeployment`);
    assert.ok(u.findBuff('lmlee:bounce'));
    done(h);
  }
  // DP short of the extra: the plain cost, no charge
  const p = payOf(ID6);
  const h = run({ units: [L(ID6, S1, 10, 4)], flags: FROZEN_DP(p.extra - 0.5) });
  const log = dpLog(h, p.iv + 0.2);
  assert.deepEqual(log.map((x) => +x.d.toFixed(9)), [-p.base]);
  assert.equal(h.unit(1).findBuff('lmlee:bounce'), null);
  done(h);
});

test('老鲤 有备无患: the charge cancels the next 晕眩 / 冻结 and stuns an enemy source `stun` s; used up either way; cold untouched', () => {
  for (const [id, moduleId] of [[ID6, null], [EL6, null], [EL5, null]]) {
    const p = payOf(id, moduleId);
    const h = run({ units: [L(id, S1, 10, 4, { moduleId })], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }], flags: FROZEN_DP(99) });
    const u = h.unit(1);
    h.run(p.iv + 0.1);
    const e = h.enemies()[0];
    assert.ok(u.findBuff('lmlee:bounce'), 'charged');
    assert.equal(h.b.applyStatus(u, 'stun', { duration: 5, source: e }), false, 'stun cancelled');
    assert.ok(!u.s.flags.stun);
    assert.ok(e.s.flags.stun, 'the source is stunned');
    close(e.findBuff('stun').timeLeft, p.stun, 1e-9, `${id} ${moduleId} stun`);
    assert.equal(u.findBuff('lmlee:bounce'), null, 'used up');
    assert.equal(h.b.applyStatus(u, 'stun', { duration: 1, source: e }), true, 'the next one lands');
    h.run(1.1);
    // a new charge (paid at the next payment while none is held) — a freeze from no enemy: cancelled, nobody stunned
    h.runUntil(() => !!u.findBuff('lmlee:bounce'), p.iv + 0.2);
    assert.ok(u.findBuff('lmlee:bounce'));
    assert.equal(h.b.applyStatus(u, 'freeze', { duration: 3 }), false, 'freeze cancelled');
    assert.equal(u.findBuff('lmlee:bounce'), null);
    h.runUntil(() => !!u.findBuff('lmlee:bounce'), p.iv + 0.2);
    assert.equal(h.b.applyStatus(u, 'cold', { duration: 3, source: e }), true, 'cold is no 晕眩 / 冻结');
    assert.ok(u.findBuff('lmlee:bounce'), 'kept');
    done(h);
  }
});

test('老鲤 MER-Y: ATK +atk per trait payment up to max_stack_cnt, lost when he leaves; MER-X / none / normal: none', () => {
  for (const [id, moduleId] of LOADOUTS) {
    const p = payOf(id, moduleId), m = merYOf(id, moduleId);
    const h = run({ units: [L(id, S1, 10, 4, { moduleId })], flags: FROZEN_DP(99) });
    const u = h.unit(1);
    h.run(p.iv + 0.1);
    const tag = `${id} ${moduleId}`;
    if (!m) {
      h.run(4 * p.iv);
      assert.equal(u.s.atk, u.base.atk, `${tag}: no stacks`);
      done(h);
      continue;
    }
    close(u.s.atk, u.base.atk * (1 + m.atk), 1e-6, `${tag} 1 payment`);
    h.run((m.max_stack_cnt + 1) * p.iv);
    close(u.s.atk, u.base.atk * (1 + m.atk * m.max_stack_cnt), 1e-6, `${tag} capped`);
    h.b.kill(u);
    h.b.getPlayer('p1').dp = 99;
    assert.ok(h.runUntil(() => u.alive, u.base.respawnTime + 2));
    assert.equal(u.s.atk, u.base.atk, 'lost when he left');
    done(h);
  }
});

test('老鲤 + 可露希尔 极限调度 (her player): the trait\'s |cost| may go into the lowered floor — never the 有备无患 extra', () => {
  const p = payOf(ID6), floor = Math.abs(loadout(CLOSUR).talents.find((t) => t.index === 1).bb.cost);
  // DP 1: pays |cost| twice into the floor (1 − cost, then − cost more ≥ −floor), withdrawn at the third
  // (her S3: no DP of hers before ~20 s)
  const h = run({ units: [L(ID6, S1, 10, 4), { uid: 2, chessId: CLOSUR, row: 12, col: 3, skillIndex: 2 }], flags: FROZEN_DP(1) });
  const u = h.unit(1);
  assert.ok(1 - 2 * p.base >= -floor && 1 - 3 * p.base < -floor, 'the setting holds for these records');
  h.run(p.iv + 0.1);
  assert.ok(u.alive && dpOf(h) === 0, 'paid into the floor');
  assert.equal(u.findBuff('lmlee:bounce'), null, 'no extra into the floor');
  h.run(p.iv);
  assert.ok(u.alive, 'the second one too');
  h.run(p.iv);
  assert.equal(u.alive, false, 'beyond the floor');
  assert.equal(h.hooksOf('death').find((c) => c.unit === u).reason, 'merchant');
  // the debt (2 × |cost| − 1 = the floor here) is paid by the DP gained afterwards
  const debt = 2 * p.base - 1;
  h.b.flags.dpPerSec = 1;
  const t0 = h.b.time;
  h.runUntil(() => h.b.time >= t0 + debt - 0.3, debt);
  assert.equal(dpOf(h), 0, 'still in debt');
  h.runUntil(() => h.b.time >= t0 + debt + 0.5, 1);
  close(dpOf(h), 0.5, 2 * h.TICK, 'paid');
  assert.equal(h.unit(2).skill.activations, 0);
  done(h);
  // without her: withdrawn at once
  const g = run({ units: [L(ID6, S1, 10, 4)], flags: FROZEN_DP(1) });
  g.run(p.iv + 0.1);
  assert.equal(g.unit(1).alive, false);
  done(g);
});

test('老鲤 T1 和气生财: while he blocks, ASPD +[self] and the blocked enemy [enemy]; ×2 with exactly cnt enemies on his 3×3; per module', () => {
  for (const [id, moduleId] of LOADOUTS) {
    const t0 = talOf(id, 0, moduleId);
    const self = t0['lmlee_t_1[self].attack_speed'], foe = t0['lmlee_t_1[enemy].attack_speed'];
    const tag = `${id} ${moduleId}`;
    // alone on his tile: blocked, the only enemy around ⇒ ×2
    const h = run({ units: [L(id, S1, 10, 4, { moduleId })], enemies: [{ key: 'enemy_dummy', pos: [10, 4] }], flags: FROZEN_DP(99) });
    const u = h.unit(1);
    h.run(0.2);
    const e = h.enemies()[0];
    assert.equal(e.blockedBy, u);
    assert.equal(t0.cnt, 1);
    assert.equal(u.s.aspd, u.base.aspd + 2 * self, `${tag} self ×2`);
    assert.equal(e.s.aspd, e.base.aspd + 2 * foe, `${tag} enemy ×2`);
    // a second enemy on his 3×3 (not blocked: his block is 1) ⇒ ×1
    h.spawn('enemy_dummy', { pos: [10, 5] });
    h.step(1);
    assert.equal(u.s.aspd, u.base.aspd + self, `${tag} self ×1`);
    assert.equal(e.s.aspd, e.base.aspd + foe, `${tag} enemy ×1`);
    // nothing blocked ⇒ none (the enemy left: knocked out)
    h.b.kill(e);
    h.step(1);
    assert.equal(u.s.aspd, u.base.aspd, `${tag} not blocking`);
    done(h);
  }
});

test('老鲤 S1: DEFAULT (AUTO) — cast at his first attack, ATK +atk and 法术闪避 +prob for good (toggle), until he leaves', () => {
  for (const id of [ID6, EL6]) {
    const bb = sbb(id, S1);
    assert.equal(skillOf(id, S1).trigger.rule, 'DEFAULT');
    const h = run({ units: [L(id, S1, 10, 4, { carryState: READY })], flags: FROZEN_DP(99) });
    const u = h.unit(1);
    h.run(2);
    assert.equal(u.skill.rule, 'DEFAULT');
    assert.equal(u.skill.active, false, 'no enemy: no cast');
    h.spawn('enemy_dummy', { pos: [10, 5] });
    assert.ok(h.runUntil(() => u.skill.active, 2));
    assert.equal(h.hooksOf('skillStart')[0].reason, 'DEFAULT');
    close(u.s.atk, u.base.atk * (1 + bb.atk), 1e-6, 'ATK');
    close(u.s.dodgeArts, bb.prob, 1e-12, '法术闪避');
    h.run(60);
    assert.ok(u.skill.active, '持续时间无限');
    h.b.kill(u);
    assert.equal(u.skill.active, false);
    done(h);
  }
});

test('老鲤 S2: passive ASPD +attack_speed; cast at an attack, the target is marked (taunt), then blasts default + factor × our hits', () => {
  for (const id of [ID6, EL6]) {
    const bb = sbb(id, S2);
    const h = run({ units: [L(id, S2, 10, 4, { carryState: READY }), { uid: 2, chessId: 'test_guard_a', row: 11, col: 6 }], enemies: [], flags: FROZEN_DP(99) });
    const u = h.unit(1);
    h.step(1);
    assert.equal(u.s.aspd, u.base.aspd + bb.attack_speed, '被动效果 before any cast');
    assert.equal(u.skill.rule, 'DEFAULT');
    const e = h.spawn('enemy_res0', { pos: [10, 5] });
    const near = h.spawn('enemy_res0', { pos: [11, 5] }), far = h.spawn('enemy_res0', { pos: [12, 8] });
    assert.ok(h.runUntil(() => u.skill.activations > 0, 3));
    const tc = h.hooksOf('skillStart')[0].t;
    const mark = e.findBuff(`lmlee:paper:${u.id}`);
    assert.ok(mark, 'the attack target is marked');
    assert.equal(e.s.taunt, e.base.tauntLevel + bb.taunt_level, '更易受我方攻击');
    const blastOf = () => h.hooksOf('damaged').filter((c) => c.dmg.tags.includes('lmleePaper'));
    h.runUntil(() => blastOf().length > 0, bb.paper_duration + 1);
    const bl = blastOf();
    close(h.b.time - tc, bb.paper_duration, 2 * h.TICK, 'after paper_duration');
    const stacks = h.hooksOf('damaged').filter((c) => c.target === e && c.amount > 0 && c.source?.side === 'ally' && !c.dmg.tags.includes('lmleePaper') && c.t >= tc).length;
    assert.ok(stacks > 0 && stacks < bb.max_stack_cnt);
    const amount = u.s.atk * (bb.default_atk_scale + bb.factor_atk_scale * stacks);
    for (const v of [e, near]) close(bl.find((c) => c.target === v).amount, amount, 1e-6, `${id} blast on ${v === e ? 'the target' : 'its neighbour'} (${stacks} hits)`);
    assert.ok(!bl.some((c) => c.target === far), 'not far away');
    assert.ok(bl.every((c) => c.type === 'arts' && c.source === u));
    assert.equal(e.findBuff(`lmlee:paper:${u.id}`), null, 'mark gone');
    assert.equal(e.s.taunt, e.base.tauntLevel);
    done(h);
  }
});

test('老鲤 S2: blasts early at max_stack_cnt hits or when the target falls; none when he leaves first', () => {
  const id = EL6, bb = sbb(id, S2);
  const mk = () => {
    const h = run({ units: [L(id, S2, 10, 4, { carryState: READY }), { uid: 2, chessId: 'test_guard_a', row: 12, col: 6 }], flags: FROZEN_DP(99) });
    h.step(1);
    const e = h.spawn('enemy_res0', { pos: [10, 5] }), n = h.spawn('enemy_res0', { pos: [10, 6] });
    const u = h.unit(1);
    assert.ok(h.runUntil(() => u.skill.activations > 0, 3));
    return { h, u, e, n, g: h.unit(2) };
  };
  const blastOf = (h) => h.hooksOf('damaged').filter((c) => c.dmg.tags.includes('lmleePaper'));
  {
    const { h, u, e, g } = mk();
    const before = h.hooksOf('damaged').filter((c) => c.target === e && c.amount > 0 && c.source?.side === 'ally').length;
    for (let i = before; i < bb.max_stack_cnt + 3; i++) h.b.dealDamage(g, e, { amount: 1, type: 'true', tags: ['test'] });
    h.step(2);
    const bl = blastOf(h);
    assert.ok(bl.length > 0, 'early at the cap');
    close(bl.find((c) => c.target === e).amount, u.s.atk * (bb.default_atk_scale + bb.factor_atk_scale * bb.max_stack_cnt), 1e-6, 'capped stacks');
    done(h);
  }
  {
    const { h, e, n } = mk();
    h.step(3);
    h.b.kill(e);
    h.step(2);
    const bl = blastOf(h);
    assert.ok(bl.some((c) => c.target === n), 'early when the target falls: around where it fell');
    done(h);
  }
  {
    const { h, u, e } = mk();
    h.b.kill(u);
    h.run(bb.paper_duration + 1);
    assert.equal(blastOf(h).length, 0, 'no blast without him');
    assert.equal(e.findBuff(`lmlee:paper:${u.id}`), null);
    done(h);
  }
});

test('老鲤 S3: range 3×3, ATK / DEF +, taunt +; pushes the other ground enemies of his range at each attack; evades prob of the damage from outside his range', () => {
  for (const id of [ID6, EL6]) {
    const bb = sbb(id, S3);
    const h = run({ units: [L(id, S3, 10, 4, { carryState: READY })], enemies: [{ key: 'enemy_hitter', pos: [10, 4] }], flags: FROZEN_DP(99) });
    const u = h.unit(1);
    assert.ok(h.runUntil(() => u.skill.active, 2), 'cast at an attack');
    assert.equal(u.skill.rule, 'DEFAULT');
    close(u.s.atk, u.base.atk * (1 + bb.atk), 1e-6);
    close(u.s.def, u.base.def * (1 + bb.def), 1e-6);
    assert.equal(u.s.taunt, u.base.tauntLevel + bb.taunt_level);
    assert.equal(u.rangeKeys.length, skillOf(id, S3).rangeGrid.length);
    assert.ok(u.rangeKeys.includes(10 * COLS + 3), 'the tile behind him is in range');
    const e0 = h.enemies()[0];
    // pushes: a ground enemy of his range that is not the target moves away; a flyer stays
    const g = h.spawn('enemy_dummy', { pos: [9, 5] }), f = h.spawn('enemy_flyer', { pos: [11, 5] });
    const g0 = { x: g.x, y: g.y }, f0 = { x: f.x, y: f.y };
    const n0 = h.hooksOf('attack').filter((c) => c.attacker === u).length;
    h.runUntil(() => h.hooksOf('attack').filter((c) => c.attacker === u).length > n0, 3);
    const target = h.hooksOf('attack').filter((c) => c.attacker === u).at(-1).targets[0];
    h.step(10);
    if (target !== g) assert.ok(Math.hypot(g.x - u.x, g.y - u.y) > Math.hypot(g0.x - u.x, g0.y - u.y) + 0.05, `${id} pushed away`);
    assert.deepEqual([f.x, f.y], [f0.x, f0.y], 'a flyer is not pushed');
    // evade: none from the blocked attacker (inside), about prob from a shooter outside
    const shooter = h.spawn('enemy_shooter', { pos: [12, 9] });
    h.run(40);
    const hits = (s) => h.hooksOf('hit').filter((c) => c.target === u && c.source === s);
    const inside = hits(e0), outside = hits(shooter);
    assert.ok(inside.length > 5 && inside.every((c) => !c.dmg.cancel), 'never evades an attacker inside his range');
    const rate = outside.filter((c) => c.dmg.cancel).length / outside.length;
    assert.ok(outside.length >= 15 && Math.abs(rate - bb.prob) < 0.25, `${id} evade rate ${rate} (${outside.length})`);
    done(h);
  }
  // without S3 nothing is evaded
  const h = run({ units: [L(ID6, S1, 10, 4)], enemies: [{ key: 'enemy_shooter', pos: [12, 9] }], flags: FROZEN_DP(99) });
  h.run(20);
  assert.ok(h.hooksOf('hit').filter((c) => c.target === h.unit(1)).every((c) => !c.dmg.cancel));
  done(h);
});

test('老鲤 modules × skills (both tiers\' elites): casts, the payments and MER-Y stacks of the loadout', () => {
  for (const id of [EL5, EL6]) for (const moduleId of [null, 'none', MERX, MERY]) for (const sid of [S1, S2, S3]) {
    const p = payOf(id, moduleId), m = merYOf(id, moduleId), tag = `${id} ${moduleId} ${sid}`;
    const h = run({ units: [L(id, sid, 10, 4, { carryState: READY, moduleId })], enemies: [{ key: 'enemy_dummy', pos: [10, 5] }], flags: FROZEN_DP(p.extra + p.base + 0.5) });
    const u = h.unit(1);
    const log = dpLog(h, 2 * p.iv + 0.2);
    assert.equal(u.kit.skillSource, 'skills', tag);
    assert.ok(u.skill.activations > 0, `${tag} casts`);
    assert.deepEqual(log.map((x) => +x.d.toFixed(9)), [-p.extra, -p.base], `${tag} payments`);
    const extraAtk = (sid === S1 ? sbb(id, S1).atk : sid === S3 ? sbb(id, S3).atk : 0) + (m ? 2 * m.atk : 0);
    close(u.s.atk, u.base.atk * (1 + extraAtk), 1e-6, `${tag} ATK`);
    done(h);
  }
});

test('老鲤: two copies pay from the pool each (their own charge); two players: his own player\'s DP only', () => {
  const pa = payOf(ID5), pb = payOf(EL6);
  const h = run({ units: [L(ID5, S1, 10, 4), { ...L(EL6, S1, 12, 4), uid: 2 }], flags: FROZEN_DP(50) });
  const log = dpLog(h, Math.max(pa.iv, pb.iv) + 0.2);
  const total = log.reduce((s, x) => s + x.d, 0);
  close(total, -(pa.extra + pb.extra), 1e-9, 'both charged');
  assert.ok(h.unit(1).findBuff('lmlee:bounce') && h.unit(2).findBuff('lmlee:bounce'));
  done(h);
  const players = [
    { playerId: 'p1', seat: 0, side: 'L', colOffset: 0, bonds: {}, units: [{ ...L(ID6, S1, 10, 4), kind: 'chess' }] },
    { playerId: 'p2', seat: 1, side: 'L', colOffset: 0, bonds: {}, units: [{ uid: 5, kind: 'chess', chessId: 'test_guard_a', row: 12, col: 6 }] },
  ];
  const g = run({ kind: 'unite', players, flags: FROZEN_DP(20) });
  const p = payOf(ID6);
  g.run(p.iv + 0.1);
  close(dpOf(g, 'p1'), 20 - p.extra, 1e-9, 'his player pays');
  close(dpOf(g, 'p2'), 20, 1e-9, 'not the teammate');
  done(g);
});

test('老鲤: every skill × tier survives a real wave without content errors and casts', () => {
  for (const id of [ID5, ID6, EL5, EL6]) for (const s of rec(id).skills) {
    const h = makeBattle({ defs: DEFS, seed: 3, timeLimit: 60,
      units: [{ chessId: id, row: 10, col: 4, skillIndex: s.index, carryState: READY }, { chessId: 'chess_char_2_06_a', row: 10, col: 6 }],
      enemies: [{ key: 'enemy_1007_slime', count: 8, interval: 1.5 }, { key: 'enemy_1007_slime', route: 1, count: 8, interval: 1.5, time: 3 }] });
    h.runToEnd(90);
    done(h);
    assert.ok(h.b.allyUnits.find((x) => x.defId === id).skill.activations > 0, `${id} ${s.skillId} casts`);
  }
});
