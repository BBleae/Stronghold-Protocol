// test/content/waiguan/_lib_summons.test.js — unit tests of the summon helpers of server/sim/content/kits/waiguan/_lib.js
// (summonsOf, linkSummonBuff, hitAllBlocked, returningSummons), on a synthetic owner with inline token defs and an
// injected kit, so they hold whatever operator uses them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec, enemyRec, checkInvariants } from '../../helpers/battleHarness.js';
import { summonsOf, linkSummonBuff, hitAllBlocked, returningSummons } from '../../../server/sim/content/kits/waiguan/_lib.js';

const OWNER = 'lib_owner_a';
const TOK = { name: 'lib token', profession: 'TOKEN', position: 'MELEE', dmgType: 'phys', attackKind: 'melee', projectile: 'none', canHitFly: false,
  rangeGrid: [[0, 0], [0, 1]], stats: { maxHp: 1000, atk: 100, def: 0, res: 0, cost: 5, blockCnt: 2, bat: 1, aspd: 100, respawnTime: 3, spRecovery: 1, hpRecoveryPerSec: 0, moveSpeed: 1, tauntLevel: 0, massLevel: 0 } };
const DEFS = {
  chess: {
    [OWNER]: chessRec({ id: OWNER, profession: 'SUPPORT', stats: { atk: 1, maxHp: 5000, cost: 10, respawnTime: 20 }, rangeGrid: [[0, 0]],
      skill: { skillId: 'sk_lib', duration: 5, spCost: 1, initSp: 0, trigger: { rule: 'SP_FULL' } } }),
    lib_other_a: chessRec({ id: 'lib_other_a', profession: 'SUPPORT', stats: { atk: 1 }, rangeGrid: [[0, 0]], skill: null }),
  },
  enemies: { enemy_dummy: enemyRec({ key: 'enemy_dummy', hp: 1e7, speed: 0 }) },
};
/** A battle with the owner (uid 1, kit `install`), its token pieces and optional extras. */
function run({ install = () => {}, tokens = [], units = [], enemies = [], sp = 0 } = {}) {
  return makeBattle({
    defs: DEFS, seed: 1, timeLimit: 300, autoFinish: false, hooks: ['damaged', 'death', 'deploy'], captureNoisy: true, enemies,
    kits: { [OWNER]: () => ({ skill: { kind: 'duration' }, install }) },
    units: [{ uid: 1, chessId: OWNER, row: 10, col: 3, carryState: { sp } },
      ...tokens.map(([tokenId, row, col, owner = 1], i) => ({ uid: 10 + i, kind: 'token', tokenId, ownerUid: owner, row, col, def: TOK })),
      ...units],
  });
}
const done = (h) => { checkInvariants(h.b); assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0])); };

test('_lib summonsOf: live summons of one owner, by token id, `all` keeps the ones off the field', () => {
  const h = run({ tokens: [['lib_a', 10, 5], ['lib_a', 11, 5], ['lib_b', 12, 5], ['lib_a', 9, 6, 2]], units: [{ uid: 2, chessId: 'lib_other_a', row: 9, col: 3 }] });
  h.run(0.2);
  const o = h.unit(1);
  assert.deepEqual(summonsOf(h.b, o).map((t) => t.uid), [10, 11, 12], 'board order, not another owner\'s');
  assert.deepEqual(summonsOf(h.b, o, 'lib_a').map((t) => t.uid), [10, 11]);
  h.b.kill(h.unit(10));
  assert.deepEqual(summonsOf(h.b, o, 'lib_a').map((t) => t.uid), [11], 'live only');
  assert.deepEqual(summonsOf(h.b, o, ['lib_a', 'lib_b'], { all: true }).map((t) => t.uid), [10, 11, 12], 'all');
  assert.deepEqual(summonsOf(h.b, h.unit(2)).map((t) => t.uid), [13]);
  done(h);
});

test('_lib linkSummonBuff: picked summons carry the buff while the timed skill runs, also one deployed meanwhile', () => {
  const h = run({
    sp: 999, tokens: [['lib_a', 10, 5], ['lib_b', 11, 5]],
    install: (b, u) => linkSummonBuff(b, u, 'lib:link', (t) => t.defId === 'lib_a', () => ({ mods: { atkPct: 0.5 } })),
  });
  const o = h.unit(1), a = h.unit(10), bt = h.unit(11);
  h.run(0.1);
  assert.ok(o.skill.active, 'cast (SP_FULL)');
  assert.equal(a.findBuff('lib:link')?.source, o);
  assert.equal(a.s.atk, a.base.atk * 1.5);
  assert.equal(bt.findBuff('lib:link'), null, 'not picked');
  h.b.kill(a);
  a.removed = false;
  assert.ok(h.b.redeploy(a), 'redeployed while the skill runs');
  assert.ok(a.findBuff('lib:link'), 'gets it at its deployment');
  h.runUntil(() => !o.skill.active, 10);
  assert.equal(a.findBuff('lib:link'), null, 'removed at the end');
  h.b.kill(a);
  a.removed = false;
  h.b.redeploy(a);
  assert.equal(a.findBuff('lib:link'), null, 'none after the skill');
  done(h);
});

test('_lib hitAllBlocked: while test(attacker) holds, an attack strikes every enemy it blocks', () => {
  let on = true;
  const h = run({ tokens: [['lib_a', 10, 6]], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }, { key: 'enemy_dummy', pos: [10, 6] }],
    install: (b, u) => hitAllBlocked(b, u, (x) => x.kind === 'token' && x.ownerUnit === u && on) });
  const t = h.unit(10);
  h.run(3);
  assert.equal(t.blocking.length, 2);
  const per = (from) => { const m = new Map(); for (const c of h.hooksOf('damaged')) if (c.source === t && c.dmg.isAttack && c.t >= from) m.set(c.dmg.attackId, (m.get(c.dmg.attackId) ?? 0) + 1); return [...m.values()]; };
  assert.ok(per(0).length > 1 && per(0).every((n) => n === 2), 'both per attack');
  on = false;
  const t1 = h.b.time;
  h.run(3);
  assert.ok(per(t1).length > 1 && per(t1).every((n) => n === 1), 'one per attack once off');
  done(h);
});

test('_lib returningSummons: back on its tile after its redeploy time paying its cost; reasons, ready, onLeave / onBack, owner down, free', () => {
  let ready = true, back = 0, left = [];
  const h = run({ tokens: [['lib_a', 10, 5], ['lib_b', 11, 5]],
    install: (b, u) => returningSummons(b, u, { pick: (t) => t.defId === 'lib_a', reasons: ['killed', 'retreat'], ready: () => ready, onLeave: (t, r) => { left.push(r); return r !== 'retreat'; }, onBack: () => back++ }) });
  const o = h.unit(1), a = h.unit(10), bt = h.unit(11), ps = h.b.getPlayer('p1');
  h.run(1);
  // killed ⇒ back after base.respawnTime, paying base.cost
  h.b.kill(a);
  const t0 = h.b.time, dp0 = ps.dp;
  assert.equal(a.removed, false, 'kept as a piece');
  assert.ok(h.runUntil(() => a.alive, a.base.respawnTime + 1));
  assert.ok(h.b.time - t0 >= a.base.respawnTime - 1e-9 && h.b.time - t0 <= a.base.respawnTime + 0.3);
  assert.ok(Math.abs(ps.dp - (dp0 + (h.b.time - t0) - a.base.cost)) < 1e-6, 'paid');
  assert.deepEqual([left, back], [['killed'], 1]);
  // not picked ⇒ the engine removes it for good
  h.b.kill(bt);
  assert.equal(bt.removed, true);
  // onLeave answers false ⇒ it stays off for good
  h.b.retreat(a, { reason: 'retreat' });
  assert.deepEqual(left, ['killed', 'retreat']);
  assert.equal(a.removed, true, 'removed by the engine');
  h.run(a.base.respawnTime + 1);
  assert.equal(a.alive, false);
  assert.equal(back, 1);
  done(h);
  // a reason off the list ⇒ stays off; onLeave is not asked
  const h1 = run({ tokens: [['lib_a', 10, 5]], install: (b, u) => returningSummons(b, u, { pick: () => true, onLeave: () => { throw new Error('asked'); } }) });
  h1.run(1);
  h1.b.retreat(h1.unit(10), { reason: 'retreat' });
  h1.run(h1.unit(10).base.respawnTime + 1);
  assert.equal(h1.unit(10).alive, false);
  done(h1);
  // ready() holds it back; the owner off the field holds it back
  const h2 = run({ tokens: [['lib_a', 10, 5]], install: (b, u) => returningSummons(b, u, { pick: () => true, reasons: ['killed', 'retreat'], ready: () => ready }) });
  const o2 = h2.unit(1), a2 = h2.unit(10);
  h2.run(1);
  ready = false;
  h2.b.retreat(a2, { reason: 'retreat' });
  h2.run(a2.base.respawnTime + 1);
  assert.equal(a2.alive, false, 'held by ready()');
  ready = true;
  assert.ok(h2.runUntil(() => a2.alive, 0.5), 'back once ready');
  h2.b.kill(a2);
  h2.b.kill(o2);
  h2.run(a2.base.respawnTime + 1);
  assert.equal(a2.alive, false, 'not while the owner is down');
  assert.ok(h2.runUntil(() => o2.alive, o2.base.respawnTime + 20));
  assert.ok(h2.runUntil(() => a2.alive, 0.5), 'back once the owner stands');
  done(h2);
  // free + a custom delay
  const h3 = run({ tokens: [['lib_a', 10, 5]], install: (b, u) => returningSummons(b, u, { pick: () => true, free: true, delay: () => 1 }) });
  const a3 = h3.unit(10), ps3 = h3.b.getPlayer('p1');
  h3.run(1);
  h3.b.kill(a3);
  const t3 = h3.b.time, dp3 = ps3.dp;
  assert.ok(h3.runUntil(() => a3.alive, 2));
  assert.ok(h3.b.time - t3 <= 1.3);
  assert.ok(Math.abs(ps3.dp - (dp3 + (h3.b.time - t3))) < 1e-6, 'free');
  done(h3);
  void o;
});
