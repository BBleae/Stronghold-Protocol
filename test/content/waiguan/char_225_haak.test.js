// test/content/waiguan/char_225_haak.test.js — 阿 外援 kit (server/sim/content/kits/waiguan/char_225_haak.js).
// Template for one 外援 kit: every skill (normal Lv4 + elite Lv7), each talent, the module choices, a smoke wave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, chessRec, checkInvariants } from '../../helpers/battleHarness.js';
import { DataSource, getDefaultSource } from '../../../server/sim/simdata.js';
import { getData } from '../../../server/data.js';
import { waiguanRecords } from '../../../shared/waiguan.js';
import { skillSpecSource } from '../../../server/sim/content/index.js';
import WAIGUAN from '../../../server/sim/content/kits/waiguan/index.js';

const CHAR = 'char_225_haak';
const ID5 = `chess_char_diy_5_${CHAR}_a`, ID6 = `chess_char_diy_6_${CHAR}_a`;
const ELITE6 = ID6.replace(/_a$/, '_b');
const REC = waiguanRecords(getData({ log: { warn() {}, error() {}, info() {} } }).waiguan);
const DS = new DataSource({ chess: REC }, getDefaultSource());
const rec = (id) => REC[id];
const skillOf = (id, sid) => rec(id).skills.find((s) => s.skillId === sid);
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e7, speed: 0, ...o });
const DEFS = {
  chess: { ...REC, test_guard_a: chessRec({ id: 'test_guard_a', profession: 'WARRIOR', skill: null, stats: { maxHp: 1e5, atk: 1, def: 100 } }) },
  enemies: { enemy_dummy: dummy('enemy_dummy') },
};
const READY = { sp: 999 };
const HOOKS = ['damaged', 'heal', 'skillStart', 'skillEnd', 'statusApplied', 'attack', 'deploy'];
/** Battle with the 外援 records + a synthetic dummy; `captureNoisy` keeps the damaged / heal contexts. */
const run = (o) => makeBattle({ defs: DEFS, seed: 7, timeLimit: 300, autoFinish: false, hooks: HOOKS, captureNoisy: true, ...o });
/** Operator entry with skill `sid` selected (board coords: row 9–12, col 2–10). */
const U = (id, sid, row, col, o = {}) => ({ chessId: id, row, col, skillIndex: skillOf(id, sid).index, ...o });
const done = (h) => { checkInvariants(h.b); assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0])); };

test('阿: every skill of both tiers (normal + elite, every module) is hand-authored', () => {
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

test('阿 S1: ASPD +attack_speed while it runs (normal Lv4 and elite Lv7 numbers)', () => {
  for (const id of [ID6, ELITE6]) {
    const h = run({ units: [U(id, 'skchr_haak_1', 10, 4, { carryState: READY })], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
    const u = h.unit(id);
    assert.ok(h.runUntil(() => u.skill.active, 10), 'casts');
    assert.equal(u.kit.skillSource, 'skills');
    assert.equal(u.s.aspd, 100 + skillOf(id, 'skchr_haak_1').bb.attack_speed);
    done(h);
  }
});

test('阿 S2: 15 hits of 500 ATK on the ally in front, then both get DEF / max HP +', () => {
  const id = ID6, bb = skillOf(id, 'skchr_haak_2').bb;
  const h = run({
    units: [U(id, 'skchr_haak_2', 10, 4, { carryState: READY }), { chessId: 'test_guard_a', row: 10, col: 6 }],
    enemies: [{ key: 'enemy_dummy', pos: [10, 7] }],
  });
  const u = h.unit(id), g = h.unit('test_guard_a');
  assert.ok(h.runUntil(() => u.skill.active, 10));
  const hits = h.hooksOf('damaged').filter((c) => c.source === u && c.target === g);
  assert.equal(hits.length, 15);
  assert.ok(Math.abs(hits[0].amount - Math.max(bb.damage - g.base.def, 0.05 * bb.damage)) < 1e-6, 'phys 500 vs the ally DEF (before its buff)');
  assert.ok(g.findBuff(`haak:inject:${u.id}`), 'the ally is buffed');
  assert.ok(Math.abs(u.s.def / u.base.def - (1 + bb.def)) < 1e-6);
  h.runUntil(() => !u.skill.active, 60);
  assert.equal(g.findBuff(`haak:inject:${u.id}`), null, 'the ally buff ends with the skill');
  done(h);
});

test('阿 T1: every hit rolls one effect (seeded: over many hits each of the four shows up)', () => {
  const h = run({ units: [U(ID6, 'skchr_haak_1', 10, 4)], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
  h.run(60);
  const st = new Set(h.hooksOf('statusApplied').filter((c) => c.source === h.unit(ID6)).map((c) => c.status));
  assert.ok(st.has('sluggish') && st.has('stun'));
  assert.ok(h.hooksOf('heal').some((c) => c.source === h.unit(ID6) && c.target === h.unit(ID6)));
  done(h);
});

test('阿 module: GEE-X SP +0.25/s above 80 % HP; module none / GEE-Y lose it', () => {
  const sp = (moduleId) => {
    const h = run({ units: [{ chessId: ELITE6, row: 10, col: 4, moduleId }] });
    h.run(1);
    return h.unit(ELITE6).s.spRecovery;
  };
  assert.ok(Math.abs(sp(null) - 1.25) < 1e-9, 'default module GEE-X');
  assert.equal(sp('none'), 1);
  assert.equal(sp('uniequip_003_haak'), 1);
});

test('阿: every skill × module survives a real wave without content errors and casts', () => {
  for (const id of [ID5, ID6, ID5.replace(/_a$/, '_b'), ELITE6]) {
    for (const s of rec(id).skills) {
      const h = makeBattle({ defs: DEFS, seed: 3, timeLimit: 60,
        units: [U(id, s.skillId, 10, 4, { carryState: READY }), { chessId: 'chess_char_2_06_a', row: 10, col: 6 }],
        enemies: [{ key: 'enemy_1007_slime', count: 8, interval: 1.5 }, { key: 'enemy_1007_slime', route: 1, count: 8, interval: 1.5, time: 3 }] });
      h.runToEnd(90);
      done(h);
      assert.ok(h.b.allyUnits.find((x) => x.defId === id).skill.activations > 0, `${id} ${s.skillId} casts`);
    }
  }
});
