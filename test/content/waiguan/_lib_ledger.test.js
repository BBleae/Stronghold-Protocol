// test/content/waiguan/_lib_ledger.test.js — unit tests of the 部署费用下限 ledger helpers of
// server/sim/content/kits/waiguan/_lib.js (dpLedger, spendDp), shared by 可露希尔 (char_4228_closur.js: the floor and the
// repayment) and 老鲤 (char_322_lmlee.js: his trait pays into the floor). Two players on one field, DP regen frozen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, checkInvariants } from '../../helpers/battleHarness.js';
import { dpLedger, spendDp } from '../../../server/sim/content/kits/waiguan/_lib.js';

const player = (playerId, seat) => ({ playerId, seat, side: 'L', colOffset: 0, bonds: {}, units: [] });
const run = (dp = 7) => makeBattle({ kind: 'unite', seed: 1, timeLimit: 60, autoFinish: false, players: [player('p1', 0), player('p2', 1)], flags: { dpInit: dp, dpPerSec: 0 } });
const dpOf = (h, pid) => h.b.getPlayer(pid).dp;

test('_lib dpLedger: one ledger per battle (floor / debt maps by player id), never shared between battles', () => {
  const a = run(), b = run();
  const L = dpLedger(a.b);
  assert.ok(L.floor instanceof Map && L.debt instanceof Map);
  assert.equal(dpLedger(a.b), L, 'the same object for the same battle');
  L.floor.set('p1', 5);
  L.debt.set('p1', 2);
  assert.equal(dpLedger(a.b).floor.get('p1'), 5);
  const M = dpLedger(b.b);
  assert.notEqual(M, L);
  assert.equal(M.floor.size + M.debt.size, 0, 'another battle starts empty');
});

test('_lib spendDp: from the pool first, the rest owed as debt of that player only; nothing for n ≤ 0 or an unknown player', () => {
  const h = run(7);
  h.step(1);
  const L = dpLedger(h.b);
  assert.deepEqual(spendDp(h.b, 'p1', 3), { fromDp: 3, owed: 0 });
  assert.equal(dpOf(h, 'p1'), 4);
  assert.equal(L.debt.has('p1'), false, 'no debt while the pool pays');
  assert.deepEqual(spendDp(h.b, 'p1', 6), { fromDp: 4, owed: 2 });
  assert.equal(dpOf(h, 'p1'), 0);
  assert.equal(L.debt.get('p1'), 2);
  assert.deepEqual(spendDp(h.b, 'p1', 1.5), { fromDp: 0, owed: 1.5 });
  assert.equal(L.debt.get('p1'), 3.5, 'debts add up');
  assert.equal(dpOf(h, 'p2'), 7, 'the other player\'s pool is untouched');
  assert.equal(L.debt.has('p2'), false);
  for (const n of [0, -2, NaN]) assert.deepEqual(spendDp(h.b, 'p2', n), { fromDp: 0, owed: 0 }, `n = ${n}`);
  assert.deepEqual(spendDp(h.b, 'nobody', 5), { fromDp: 0, owed: 0 });
  assert.equal(dpOf(h, 'p2'), 7);
  assert.deepEqual([...L.debt.keys()], ['p1']);
  checkInvariants(h.b);
});
