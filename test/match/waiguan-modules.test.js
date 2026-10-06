// A 外援 elite fights with the module its player chose, at its slot's 模组 level (tier V 1, tier VI 3; DESIGN §27).
//
// The match end (PlayerState.setLoadout → battleInput moduleId) and the battle end (simdata DataSource.getChess /
// getToken with the unit's loadout, a sandbox Battle). The match merges a pick's normal and elite records and the battle
// DataSource resolves every 外援 record (DESIGN §27); the tests still add the records when missing (`gd.addChess`, a
// DataSource / makeBattle `defs` over data/waiguan.json) so they pin the module path on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA, makeMatch } from './harness.js';
import { waiguanRecords } from '../../shared/waiguan.js';
import { DataSource } from '../../server/sim/simdata.js';
import { makeBattle } from '../helpers/battleHarness.js';

const RECORDS = waiguanRecords(DATA.waiguan);
const HAAK = (tier, golden = false) => `chess_char_diy_${tier}_char_225_haak_${golden ? 'b' : 'a'}`;
const GEE_X = 'uniequip_002_haak';
const GEE_Y = 'uniequip_003_haak';

// 阿 E2 Lv60 base 1897 HP / 663 ATK / aspd 100 / 再部署 70 s; GEE-X level 1 +135/+37, level 3 +240/+57; GEE-Y level 1
// +43 ATK +3 aspd −15 s, level 3 +75 ATK +5 aspd −15 s (official battle_equip_table)
const EXPECT = {
  5: { [GEE_X]: [2032, 700, 100, 70], [GEE_Y]: [1897, 706, 103, 55], none: [1897, 663, 100, 70] },
  6: { [GEE_X]: [2137, 720, 100, 70], [GEE_Y]: [1897, 738, 105, 55], none: [1897, 663, 100, 70] },
};
const statsOf = (s) => [s.maxHp, s.atk, s.aspd, s.respawnTime];

test('外援 modules, match: the chosen module reaches the battle input of a tier V elite (independent of tier VI)', () => {
  const picks = { diy5a: 'char_225_haak', diy6a: 'char_225_haak' };
  const seats = [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true, picks }];
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seats, seed: 3 }).start();
  const { m } = h;
  for (const tier of [5, 6]) if (!m.gd.chess(HAAK(tier, true))) m.gd.addChess(RECORDS[HAAK(tier, true)]);
  const ps = h.ps('p_0');
  assert.equal(ps.setLoadout({ [HAAK(5)]: { module: GEE_Y }, [HAAK(6)]: { module: 'none' } }), true);
  assert.deepEqual(ps.loadoutFor(m.gd.chess(HAAK(5, true))), { skillIndex: 0, moduleId: GEE_Y });
  assert.deepEqual(ps.loadoutFor(m.gd.chess(HAAK(6, true))), { skillIndex: 0, moduleId: 'none' });
  assert.deepEqual(ps.loadoutFor(m.gd.chess(HAAK(5))), { skillIndex: 0, moduleId: null }, 'a normal piece has no module');
  assert.equal(ps.setLoadout({ [HAAK(5)]: { module: 'uniequip_002_ling' } }), false, 'another operator\'s module is refused');
  assert.equal(ps.setLoadout({ [HAAK(5)]: { module: GEE_Y } }), true);
  h.toPrep(1);
  const p5 = ps.newPiece('chess', HAAK(5, true), { poolCopies: 0 });
  const p6 = ps.newPiece('chess', HAAK(6, true), { poolCopies: 0 });
  ps.board.set('9,5', p5);
  ps.board.set('9,7', p6);
  ps.recompute();
  const units = ps.battleInput().units;
  assert.equal(units.find((u) => u.uid === p5.uid).moduleId, GEE_Y);
  assert.equal(units.find((u) => u.uid === p6.uid).moduleId, GEE_X, 'tier VI keeps its default');
  m.dispose();
});

test('外援 modules, simdata: getChess applies the chosen module\'s stats / trait / talents at the slot\'s level', () => {
  const ds = new DataSource({ ...DATA, chess: { ...DATA.chess, ...RECORDS } }, null);
  for (const tier of [5, 6]) {
    for (const [moduleId, want] of Object.entries(EXPECT[tier])) {
      const d = ds.getChess(HAAK(tier, true), moduleId === GEE_X ? null : { moduleId });
      assert.deepEqual(statsOf(d.stats), want, `T${tier} ${moduleId}: stats`);
      const mod = d.raw.module;
      assert.equal(mod.level, tier === 5 ? 1 : 3, `T${tier} ${moduleId}: module level`);
      assert.equal(mod.active, moduleId !== 'none');
      assert.equal(mod.id, moduleId === 'none' ? null : moduleId);
      // trait: the module's override, or the base trait without one
      const rec = RECORDS[HAAK(tier, true)];
      const m = rec.modules.find((x) => x.uniEquipId === moduleId);
      assert.deepEqual(d.raw.trait, m ? (m.traitOverride || rec.traitBase) : rec.traitBase, `T${tier} ${moduleId}: trait`);
    }
    // GEE-X's talent upgrade (talent 0's second effect `prob`) arrives at level 2+; its hidden SP part at every level
    const gx = ds.getChess(HAAK(tier, true)).raw;
    assert.equal(gx.talents.find((t) => t.index === 0).bb.prob, tier === 5 ? undefined : 0.3, `T${tier}: talent 0 prob`);
    assert.deepEqual(gx.talents.filter((t) => t.index === -1).map((t) => t.bb), [{ sp_recovery_per_sec: 0.25 }]);
    const none = ds.getChess(HAAK(tier, true), { moduleId: 'none' }).raw;
    assert.ok(!none.talents.some((t) => t.fromModule), `T${tier} none: no module talent part`);
  }
  // a summon follows its owner's module and tier: 令's 魂 (SUM-Y adds −3 cost at level 1, + HP / ATK at level 3)
  const soul = (tier, lo) => statsOf(ds.getToken('token_10020_ling_soul1', `chess_char_diy_${tier}_char_2023_ling_b`, lo).stats).slice(0, 2)
    .concat(ds.getToken('token_10020_ling_soul1', `chess_char_diy_${tier}_char_2023_ling_b`, lo).stats.cost);
  assert.deepEqual(soul(5, null), [2407, 529, 9]);
  assert.deepEqual(soul(6, null), [2557, 574, 9]);
  assert.deepEqual(soul(5, { moduleId: 'none' }), [2407, 529, 12]);
  assert.deepEqual(soul(6, { moduleId: 'none' }), [2407, 529, 12]);
});

test('外援 modules, battle: a unit\'s moduleId gives it that module\'s stats at its tier; 阿\'s kit runs at both tiers', () => {
  for (const tier of [5, 6]) {
    for (const [moduleId, want] of Object.entries(EXPECT[tier])) {
      const id = HAAK(tier, true);
      const h = makeBattle({
        defs: { chess: { [id]: RECORDS[id] } },
        units: [{ uid: 1, chessId: id, row: 10, col: 5, ...(moduleId === GEE_X ? {} : { moduleId }) }],
        enemies: [{ key: 'enemy_1422_lrsldr', route: 0, time: 1 }], timeLimit: 30, autoFinish: false,
      });
      h.run(5);
      const u = h.unit(1);
      assert.deepEqual([Math.round(u.s.maxHp), Math.round(u.s.atk), u.s.aspd], want.slice(0, 3), `T${tier} ${moduleId}`);
      assert.equal(u.def.raw.module.level, tier === 5 ? 1 : 3);
      assert.deepEqual(h.battle.errors, [], `T${tier} ${moduleId}: content errors`);
    }
  }
});
