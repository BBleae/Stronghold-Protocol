// 凛御银灰 (chess_char_5_14) S1 周旋的谋略 cuts the redeploy cost of a waiting operator — a fork rule (393a3c82, kept
// through the 0.2.x merge in kits/ops/chess_char_5_14-svash2.js): the cut is kept as its own delta (`mem.svashCut`) and
// given back additively when the operator deploys, so another effect's cut on the same waiting operator (野鬃's 前锋
// discount, 琴柳's 精神感召 — kits/ops/chess_char_1_19-wildmn.js, op-sleach.js — each giving its own cut back when it
// ends) is never lost or doubled. Upstream restores the cost recorded before his cut, which wipes a later cut and, once
// that effect gives its cut back, leaves the operator dearer than its base cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, chessRec, checkInvariants } from '../helpers/battleHarness.js';
import { getDefaultSource } from '../../server/sim/simdata.js';

const ds = getDefaultSource();
const skillIndex = (id, skillId) => ds.rawChess(id).skills.find((s) => s.skillId === skillId).index;
const ally = (id, o = {}) => chessRec({ id, skill: null, ...o, stats: { maxHp: 10000, atk: 0, def: 0, blockCnt: 0, respawnTime: 5, ...(o.stats || {}) } });

test('凛御银灰 S1: his redeploy-cost cut and another effect\'s cut on the same waiting op compose (each gives back its own)', () => {
  for (const id of ['chess_char_5_14_a', 'chess_char_5_14_b']) {
    const h = makeBattle({
      seed: 7, autoFinish: false, timeLimit: 400,
      defs: { chess: { t_guard: ally('t_guard', { profession: 'WARRIOR', stats: { cost: 20, respawnTime: 999 } }) }, enemies: { enemy_dummy: enemyRec({ key: 'enemy_dummy', hp: 1e7, speed: 0 }) } },
      units: [{ chessId: id, skillIndex: skillIndex(id, 'skchr_svash2_1'), row: 10, col: 4 }, { chessId: 't_guard', row: 12, col: 3 }],
      enemies: [{ key: 'enemy_dummy', pos: [10, 5] }], flags: { dpPerSec: 0 },
    }).step();
    const u = h.unit(id), g = h.unit('t_guard');
    const cut = u.def.skill.bb['svash2_s_1[deck].cost'];
    assert.ok(cut > 0, 'S1 cuts the cost');
    h.b.dealDamage(null, g, { amount: 1e9, type: 'true' });
    u.skill.gainSp(1000);
    assert.ok(h.runUntil(() => u.skill.activations > 0, 15), `${id}: S1 cast`);
    assert.equal(g.base.cost, 20 - cut, 'his cut');
    // another effect cuts the same waiting op by 3 and gives it back on that op's deployment (野鬃's way)
    g.base.cost -= 3;
    h.b.on('deploy', (c) => { if (c.unit === g) g.base.cost += 3; });
    assert.equal(g.base.cost, 17 - cut);
    h.b.redeploy(g);
    assert.equal(g.base.cost, 20, `${id}: both cuts given back, no more`);
    checkInvariants(h.b);
    assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
  }
});
