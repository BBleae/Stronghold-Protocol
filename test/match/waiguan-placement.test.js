// 高台 for the 外援 placement modules (owner's decision 2026-10-06, 外援 requirements §6; shared/highGround.js).
//
// The module texts grant the ranged tile explicitly, unlike the branch trait 「可以放置于远程位」 sganggs's rule distrusts:
//   * elite 帕拉斯 (char_485_pallas, MELEE 教官) carrying INS-Y (uniequip_003_pallas): "可以额外部署在远程位";
//   * elite 艾拉 (char_4123_ela) carrying TRP-D (uniequip_002_ela, her default): "自身可以额外部署在近战位，陷阱可以额外
//     部署在远程位". 艾拉 herself is RANGED (any deployable tile already), so the widening is her trap's
//     (token_10033_ela_grzmot, a MELEE hand summon).
// Checked on the server (g.move legality, swaps, invariants, battle input), on the client's mirror (drag highlights) and on
// the shared helper. The match does not merge a pick's ELITE record into its chess table on this branch yet (stream F),
// so the tests add it themselves (`gd.addChess`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legalTiles, placeClass, piecePlaceClass, positionClass, summonPlaceClass, tileKey } from '../../server/match/board.js';
import {
  meleeOnHighGround, summonOnHighGround, GLADIIA_HOK_Y, PALLAS_CHAR_ID, PALLAS_INS_Y, ELA_CHAR_ID, ELA_TRP_D, ELA_TRAP_TOKEN_ID,
} from '../../shared/highGround.js';
import { waiguanRecords } from '../../shared/waiguan.js';
import { ERR } from '../../shared/constants.js';
import { DATA, makeMatch, give } from './harness.js';
import { collectViolations } from '../../server/match/invariants.js';
import { placementContext, canPlace as clientCanPlace, boardTargets } from '../../public/js/ui/gameLogic.js';

const RECORDS = waiguanRecords(DATA.waiguan);
const ALL_CHESS = { ...DATA.chess, ...RECORDS };
const id = (tier, charId, golden) => `chess_char_diy_${tier}_${charId}_${golden ? 'b' : 'a'}`;
const PALLAS_INS_X = 'uniequip_002_pallas';
const HIGH_STAGE = 'act2autochess_m01';
const HIGH = ['10,4', '11,4', '12,4']; // 战场#01(下半)'s ranged-only (高台) tiles
const rc = (k) => k.split(',').map(Number);
const board = (r, c) => ({ area: 'board', row: r, col: c });

/** A solo match on the 高台 stage whose seat picked 帕拉斯 (tier V and VI) and 艾拉 (tier V and VI), elites merged in. */
function prep(seed = 11) {
  const picks = { diy5a: PALLAS_CHAR_ID, diy5b: ELA_CHAR_ID, diy6a: PALLAS_CHAR_ID, diy6b: ELA_CHAR_ID };
  const seats = [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true, picks }];
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seats, seed }).start();
  // the elite records (Match merges only the normal records on this branch; stream F adds the elites)
  for (const tier of [5, 6]) for (const c of [PALLAS_CHAR_ID, ELA_CHAR_ID]) if (!h.m.gd.chess(id(tier, c, true))) h.m.gd.addChess(RECORDS[id(tier, c, true)]);
  h.toPrep(1);
  h.setStage(HIGH_STAGE);
  const ps = h.ps('p_0');
  for (const p of [...ps.board.values(), ...ps.hand.filter(Boolean)]) if (p.kind === 'chess') ps.returnCopies(p);
  ps.board.clear();
  ps.hand.fill(null);
  ps.recompute();
  return { h, m: h.m, ps };
}
/** The engine invariants (server/match/invariants.js), board legality and the owner's private pool entries included. */
function checkInvariants(m) {
  const v = collectViolations(m);
  assert.deepEqual(v, [], `invariants violated:\n  ${v.join('\n  ')}`);
}
const move = (m, uid, to, dir) => m.handle('p_0', { t: 'g.move', uid, to, ...(dir ? { dir } : {}) });
const toHand = (m, ps, p) => move(m, p.uid, { area: 'hand', idx: ps.hand.findIndex((x) => x == null) });
const stackOf = (ps, owner) => [...ps.hand, ...ps.temp].find((p) => p && p.kind === 'token' && p.ownerUid === owner.uid) ?? null;
const clientCtx = (m, ps) => placementContext({
  priv: ps.privateView(), stage: m.stage, editable: true,
  getChess: (x) => m.gd.chess(x), getToken: (x) => DATA.tokens[x] ?? null, getItem: (x) => DATA.items[x] ?? null,
});

test('外援 高台 data: 帕拉斯 MELEE with INS-Y "可以额外部署在远程位"; 艾拉 RANGED with TRP-D (default), her trap MELEE', () => {
  for (const tier of [5, 6]) {
    const p = RECORDS[id(tier, PALLAS_CHAR_ID, true)];
    assert.equal(p.position, 'MELEE');
    const y = p.modules.find((m) => m.uniEquipId === PALLAS_INS_Y);
    assert.equal(y.typeName, 'INS-Y');
    assert.equal(y.isDefault, false, 'INS-Y is not her default');
    assert.match(y.traitOverride.moduleDesc, /可以额外部署在远程位/);
    assert.equal(p.modules.find((m) => m.isDefault).uniEquipId, PALLAS_INS_X);
    const e = RECORDS[id(tier, ELA_CHAR_ID, true)];
    assert.equal(e.position, 'RANGED', '艾拉 herself already stands on any deployable tile');
    const d = e.modules.find((m) => m.uniEquipId === ELA_TRP_D);
    assert.equal(d.typeName, 'TRP-D');
    assert.equal(d.isDefault, true);
    assert.match(d.traitOverride.moduleDesc, /陷阱可以额外部署在远程位/);
    assert.deepEqual(e.tokens, [ELA_TRAP_TOKEN_ID]);
  }
  const trap = DATA.tokens[ELA_TRAP_TOKEN_ID];
  assert.equal(trap.position, 'MELEE');
  assert.equal(trap.placeable, true, 'a hand piece');
  // these two are the only modules of the reachable chess (pool + 外援) whose text grants the ranged tile — the branch
  // trait 「可以放置于远程位」 (钩索师 / 推击手: 歌蕾蒂娅, 崖心, 见行者, 温蒂) is the line sganggs's rule does not read
  const granting = new Set();
  for (const c of Object.values(ALL_CHESS)) for (const m of c.modules || []) if (/额外部署在远程位/.test(JSON.stringify(m.traitOverride || {}))) granting.add(m.uniEquipId);
  assert.deepEqual([...granting].sort(), [ELA_TRP_D, PALLAS_INS_Y].sort());
});

test('shared/highGround.js: the module-granted exceptions, on the elite carrying that module only', () => {
  const pal = (tier, golden) => RECORDS[id(tier, PALLAS_CHAR_ID, golden)];
  const ela = (tier, golden) => RECORDS[id(tier, ELA_CHAR_ID, golden)];
  const trap = DATA.tokens[ELA_TRAP_TOKEN_ID];
  for (const tier of [5, 6]) {
    assert.equal(meleeOnHighGround(pal(tier, true), PALLAS_INS_Y), true, `tier ${tier} elite + INS-Y`);
    for (const mod of [PALLAS_INS_X, 'none', null, undefined, GLADIIA_HOK_Y]) assert.equal(meleeOnHighGround(pal(tier, true), mod), false, `elite + ${mod}`);
    assert.equal(meleeOnHighGround(pal(tier, false), PALLAS_INS_Y), false, 'a normal record');
    assert.equal(positionClass(pal(tier, true), PALLAS_INS_Y), 'all');
    assert.equal(positionClass(pal(tier, true), PALLAS_INS_X), 'melee');
    assert.equal(summonOnHighGround(trap, ela(tier, true), ELA_TRP_D), true, `tier ${tier} elite 艾拉 + TRP-D`);
    for (const mod of ['none', null, PALLAS_INS_Y]) assert.equal(summonOnHighGround(trap, ela(tier, true), mod), false, `elite 艾拉 + ${mod}`);
    assert.equal(summonOnHighGround(trap, ela(tier, false), ELA_TRP_D), false, 'normal 艾拉');
    assert.equal(summonOnHighGround(DATA.tokens.token_10028_vigil_wolf, ela(tier, true), ELA_TRP_D), false, 'another summon');
    assert.equal(summonOnHighGround(trap, pal(tier, true), ELA_TRP_D), false, 'another owner');
    assert.equal(summonOnHighGround(trap, null, ELA_TRP_D), false, 'no owner');
    assert.equal(meleeOnHighGround(ela(tier, true), ELA_TRP_D), false, '艾拉 herself is not a melee widening (she is RANGED)');
    assert.equal(positionClass(ela(tier, true), ELA_TRP_D), 'ranged');
  }
  // sganggs's rule is unchanged
  assert.equal(meleeOnHighGround(DATA.chess.chess_char_4_12_b, GLADIIA_HOK_Y), true);
  assert.equal(meleeOnHighGround(DATA.chess.chess_char_4_12_a, GLADIIA_HOK_Y), false);
  assert.equal(meleeOnHighGround(DATA.chess.chess_char_4_12_b, 'uniequip_002_glady'), false);
  assert.equal(meleeOnHighGround(DATA.chess.chess_char_2_03_b, GLADIIA_HOK_Y), false);
  // summonPlaceClass: the trap's own position without the grant
  const ps = { loadoutFor: () => ({ moduleId: ELA_TRP_D }) };
  assert.equal(summonPlaceClass(ps, trap, ela(5, true)), 'all');
  assert.equal(summonPlaceClass({ loadoutFor: () => ({ moduleId: 'none' }) }, trap, ela(5, true)), 'melee');
  assert.equal(summonPlaceClass(ps, trap, null), 'melee');
});

test('外援 高台 g.move: elite 帕拉斯 + INS-Y on a 高台 at both tiers; INS-X, no module, a normal 帕拉斯 → BAD_TILE', () => {
  const { m, ps } = prep();
  assert.deepEqual([...ps.deployMap()].filter(([, cls]) => cls === 'ranged').map(([k]) => k).sort(), HIGH);
  // rows: chess id, the module set on its tier's loadout key (null = default), expect 高台
  const rows = [
    [id(6, PALLAS_CHAR_ID, true), PALLAS_INS_Y, true],
    [id(5, PALLAS_CHAR_ID, true), PALLAS_INS_Y, true],
    [id(6, PALLAS_CHAR_ID, true), null, false],
    [id(6, PALLAS_CHAR_ID, true), PALLAS_INS_X, false],
    [id(5, PALLAS_CHAR_ID, true), 'none', false],
    [id(6, PALLAS_CHAR_ID, false), PALLAS_INS_Y, false],
  ];
  const owned = new Map();
  for (const [chessId, module, allowHigh] of rows) {
    const base = chessId.replace(/_b$/, '_a');
    // the loadout key is the normal id for both records; a module applies to the elite only
    if (module) assert.equal(ps.setLoadout({ [base]: { module } }), true, `${base} ${module}`);
    else ps.setLoadout({});
    let p = owned.get(chessId);
    if (!p) { p = give(m, ps, chessId); owned.set(chessId, p); }
    for (const k of HIGH) {
      const [r, c] = rc(k);
      const res = move(m, p.uid, board(r, c), 'DOWN');
      if (allowHigh) {
        assert.deepEqual(res, { ok: true }, `${chessId} ${module} → ${k}`);
        assert.equal(ps.board.get(k), p);
        assert.equal(piecePlaceClass(ps, p), 'all');
        checkInvariants(m);
        assert.deepEqual(toHand(m, ps, p), { ok: true });
      } else {
        assert.equal(res.error, ERR.BAD_TILE, `${chessId} ${module || 'default'} → ${k}`);
      }
    }
    assert.deepEqual(move(m, p.uid, board(9, 3)), { ok: true }, `${chessId}: the ground stays legal`);
    assert.equal(placeClass(ps, m.gd.chess(chessId)) === 'all', allowHigh, chessId);
    assert.deepEqual(toHand(m, ps, p), { ok: true });
    ps.setLoadout({});
  }
  // the tier V and tier VI loadout keys are independent: INS-Y on tier V leaves the tier VI elite ground-only
  assert.equal(ps.setLoadout({ [id(5, PALLAS_CHAR_ID, false)]: { module: PALLAS_INS_Y } }), true);
  assert.equal(placeClass(ps, m.gd.chess(id(5, PALLAS_CHAR_ID, true))), 'all');
  assert.equal(placeClass(ps, m.gd.chess(id(6, PALLAS_CHAR_ID, true))), 'melee');
  // battle input: fielded on the 高台 with her module
  const p6 = owned.get(id(5, PALLAS_CHAR_ID, true));
  assert.deepEqual(move(m, p6.uid, board(10, 4), 'DOWN'), { ok: true });
  const u = ps.battleInput().units.find((x) => x.uid === p6.uid);
  assert.deepEqual([u.row, u.col, u.dir, u.moduleId], [10, 4, 'DOWN', PALLAS_INS_Y]);
  checkInvariants(m);
  m.dispose();
});

test('外援 高台 g.move: 艾拉\'s trap on a 高台 when its owner is elite 艾拉 + TRP-D (her default); otherwise the ground only', () => {
  const { m, ps } = prep();
  for (const tier of [5, 6]) {
    ps.setLoadout({});
    const ela = give(m, ps, id(tier, ELA_CHAR_ID, true));
    assert.deepEqual(move(m, ela.uid, board(9, 5)), { ok: true }, `tier ${tier} 艾拉 on the ground`);
    assert.deepEqual(move(m, ela.uid, board(12, 4)), { ok: true }, '…and on a 高台 (she is RANGED)');
    const trap = stackOf(ps, ela);
    assert.ok(trap && trap.id === ELA_TRAP_TOKEN_ID, 'placing her sends her trap stack to the hand');
    assert.equal(piecePlaceClass(ps, trap), 'all', 'default TRP-D');
    assert.deepEqual(move(m, trap.uid, board(10, 4)), { ok: true }, 'the trap on a 高台');
    const placed = ps.board.get('10,4');
    assert.equal(placed.id, ELA_TRAP_TOKEN_ID);
    checkInvariants(m);
    const u = ps.battleInput().units.find((x) => x.kind === 'token' && x.uid === placed.uid);
    assert.deepEqual([u.tokenId, u.row, u.col, u.ownerUid], [ELA_TRAP_TOKEN_ID, 10, 4, ela.uid]);
    // the ground stays legal for it
    assert.deepEqual(move(m, placed.uid, board(9, 3)), { ok: true });
    // the client lights the same tiles as the server
    const ctx = clientCtx(m, ps);
    const t = ps.board.get('9,3');
    const lit = boardTargets(ctx, t.uid).legal.map(([r, c]) => tileKey(r, c)).sort();
    // every deploy tile: the free ones, its own (re-orientation) and 艾拉's (a swap with its owner, who is RANGED)
    assert.deepEqual(lit, legalTiles(ps.deployMap(), piecePlaceClass(ps, t)).map(([r, c]) => tileKey(r, c)).sort(), 'client highlights = the server\'s legal tiles');
    assert.ok(HIGH.filter((k) => k !== '12,4').every((k) => lit.includes(k)), 'the 高台 lit');
    // no module: the trap is ground-only again (and a piece already up there would fail the invariants)
    assert.equal(ps.setLoadout({ [id(tier, ELA_CHAR_ID, false)]: { module: 'none' } }), true);
    assert.equal(piecePlaceClass(ps, t), 'melee');
    assert.equal(move(m, t.uid, board(11, 4)).error, ERR.BAD_TILE, 'no module → BAD_TILE');
    assert.equal(clientCanPlace(clientCtx(m, ps), t.uid, board(11, 4)).ok, false, 'the client refuses it too');
    assert.deepEqual(move(m, t.uid, board(9, 4)), { ok: true }, 'the ground');
    checkInvariants(m);
    // clean up for the next tier
    assert.deepEqual(toHand(m, ps, ela), { ok: true });
    ps.returnCopies(ela);
    ps.hand[ps.hand.indexOf(ela)] = null;
    ps.setLoadout({});
    ps.recompute();
  }
  // a NORMAL 艾拉's trap stays on the ground (no module on a normal record)
  const normal = give(m, ps, id(5, ELA_CHAR_ID, false));
  assert.deepEqual(move(m, normal.uid, board(9, 5)), { ok: true });
  const trap = stackOf(ps, normal);
  assert.ok(trap);
  assert.equal(piecePlaceClass(ps, trap), 'melee');
  assert.equal(move(m, trap.uid, board(10, 4)).error, ERR.BAD_TILE);
  assert.equal(clientCanPlace(clientCtx(m, ps), trap.uid, board(10, 4)).ok, false);
  assert.deepEqual(move(m, trap.uid, board(9, 3)), { ok: true });
  checkInvariants(m);
  m.dispose();
});

test('外援 高台 client: 帕拉斯\'s drag highlights follow the loadout (INS-Y lights the 高台, INS-X does not)', () => {
  const { m, ps } = prep();
  const p6 = give(m, ps, id(6, PALLAS_CHAR_ID, true));
  for (const [module, high] of [[PALLAS_INS_Y, true], [null, false], ['none', false]]) {
    if (module) ps.setLoadout({ [id(6, PALLAS_CHAR_ID, false)]: { module } });
    else ps.setLoadout({});
    const ctx = clientCtx(m, ps);
    const lit = boardTargets(ctx, p6.uid).legal.map(([r, c]) => tileKey(r, c)).sort();
    assert.deepEqual(lit, legalTiles(ps.deployMap(), placeClass(ps, m.gd.chess(p6.id))).map(([r, c]) => tileKey(r, c)).sort(), `${module}: highlights = the server`);
    for (const k of HIGH) {
      const res = clientCanPlace(ctx, p6.uid, board(...rc(k)));
      assert.equal(res.ok, high, `${module} → ${k}`);
      if (!high) assert.equal(res.reason, '近战单位只能部署在地面');
    }
  }
  m.dispose();
});
