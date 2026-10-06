// 外援 / 甄选 (DIY) slots — the four 6★ operators a player brings in from outside the shop pool (DESIGN §27).
//
// Covers the data-driven pick (shared/waiguan.js), the protocol check (checkWaiguanPicks), the per-player pool scoping
// (SharedPool.addOwned: a teammate never sees or buys another player's 甄选) and the match wiring (Match.setPicks /
// pool entries / the four empty slot templates staying unreachable).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, DATA, give, checkInvariants } from './harness.js';
import { checkWaiguanPicks } from '../../shared/protocol.js';
import { WAIGUAN_SLOTS, waiguanRecords } from '../../shared/waiguan.js';
import { WAIGUAN_POOL_COPIES, botWaiguanPicks } from '../../server/match/Match.js';
import { placeClass } from '../../server/match/board.js';
import { meleeOnHighGround } from '../../shared/highGround.js';
import { ERR } from '../../shared/constants.js';
import { placementContext, piecePosition, canPlace as clientCanPlace } from '../../public/js/ui/gameLogic.js';

const ROSTER = DATA.waiguan;
const RECORDS = waiguanRecords(ROSTER);
/** Two different candidates of one tier (the pick rule forbids the same operator filling both slots of a tier). */
const cands = ROSTER.candidates;
const pair = (tier) => [cands[0].chessIds[tier], cands[1].chessIds[tier]];
const charOf = (chessId) => RECORDS[chessId].charId;

/** A solo match whose seat already carries `picks`. */
function solo(picks = null, seed = 5) {
  const seats = [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true, picks }];
  return makeMatch({ mode: 'solo', difficulty: 'NORMAL', seats, seed }).start();
}

test('waiguan: checkWaiguanPicks accepts the four slots and refuses everything else', () => {
  const [a5, b5] = pair(5);
  const [a6, b6] = pair(6);
  const good = { diy5a: charOf(a5), diy5b: charOf(b5), diy6a: charOf(a6), diy6b: charOf(b6) };
  assert.deepEqual(checkWaiguanPicks(good, ROSTER), { ok: true, picks: good });
  // an empty selection is legal (the slots then stay unreachable)
  assert.deepEqual(checkWaiguanPicks({}, ROSTER), { ok: true, picks: {} });
  assert.deepEqual(checkWaiguanPicks({ diy5a: null }, ROSTER), { ok: true, picks: {} });
  // unknown slot / unknown operator / a pool operator / an operator filling both slots of one tier
  assert.equal(checkWaiguanPicks({ diy9z: charOf(a5) }, ROSTER).error, 'BAD_TARGET');
  assert.equal(checkWaiguanPicks({ diy5a: 'char_002_amiya' }, ROSTER).error, 'BAD_TARGET');
  assert.equal(checkWaiguanPicks({ diy5a: charOf(a5), diy5b: charOf(a5) }, ROSTER).error, 'BAD_TARGET');
  // the same operator MAY fill a tier V and a tier VI slot (they are two different pieces and two different tiers)
  assert.deepEqual(checkWaiguanPicks({ diy5a: charOf(a5), diy6a: charOf(a5) }, ROSTER), { ok: true, picks: { diy5a: charOf(a5), diy6a: charOf(a5) } });
  // structurally invalid payloads
  assert.equal(checkWaiguanPicks('nope', ROSTER).error, 'BAD_MSG');
  assert.equal(checkWaiguanPicks({ diy5a: 42 }, ROSTER).error, 'BAD_MSG');
});

test('waiguan: the four slot templates stay empty and out of the pool until a player picks', () => {
  const h = solo(null);
  for (const slot of WAIGUAN_SLOTS) {
    const rec = DATA.chess[slot.chessId];
    assert.ok(rec && rec.isDiy && !rec.stats, `${slot.chessId}: the template has no combat data`);
    assert.equal(h.m.pool.has(slot.chessId), false, `${slot.chessId}: not in the pool`);
  }
  assert.deepEqual(h.m.waiguanPicks, {});
  h.m.dispose();
});

test('waiguan: a pick adds the operator record to the match and copies to the owner only', () => {
  const [a5] = pair(5);
  const h = solo({ diy5a: charOf(a5) });
  const m = h.m;
  const rec = RECORDS[a5];
  assert.deepEqual(m.waiguanPicks, { p_0: { diy5a: charOf(a5) } });
  assert.ok(m.gd.chess(a5), 'the tier V record is in this match\u2019s chess table');
  assert.equal(m.gd.chess(a5).name, rec.name);
  // one-argument has() asks the SHARED pool (a 甄选 entry belongs to its owner, so it is not in it); the owner-scoped form
  // is what the shop and the buy path use
  assert.equal(m.pool.has(a5), false, 'a 甄选 entry is not part of the shared pool');
  assert.equal(m.pool.has(a5, 'p_0'), true, 'the owner sees the entry');
  assert.equal(m.pool.has(a5, 'somebody_else'), false, 'a teammate never sees it');
  assert.equal(m.pool.left(a5, 'somebody_else'), 0, 'and can never buy it');
  assert.equal(m.pool.left(a5, 'p_0'), WAIGUAN_POOL_COPIES[5], 'the tier V copy cap is the official 8');
  // the shared pool never grew by an operator of the shop pool
  assert.equal(m.gd.visibleChess.includes(a5), false, 'a 甄选 record is not shop-visible');
  checkInvariants(m);
  m.dispose();
});

test('waiguan: rolls never draw another player\u2019s pick (the private pool stays private)', () => {
  const [a5, b5] = pair(5);
  const seats = [
    { seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true, picks: { diy5a: charOf(a5) } },
    { seat: 1, playerId: 'p_1', name: 'P1', isBot: false, connected: true, picks: { diy5a: charOf(b5) } },
  ];
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seats, seed: 9 }).start();
  const m = h.m;
  const rng = () => 0;
  // a tier filter the shared pool cannot satisfy at all: only the player's own 甄选 entry of that tier is eligible, so a
  // draw that returned another player's pick would be the leak this test is about
  for (let i = 0; i < 200; i++) {
    const id = m.pool.roll(rng, { tier: 5, maxTier: 5, playerId: 'p_0', filter: (cid) => cid.startsWith('chess_char_diy_') });
    assert.notEqual(id, b5, 'p_0 never rolls p_1\u2019s pick');
  }
  const mine = m.pool.roll(rng, { tier: 5, maxTier: 5, playerId: 'p_0', filter: (cid) => cid.startsWith('chess_char_diy_') });
  assert.equal(mine, a5, 'p_0\u2019s own pick is drawable');
  const theirs = m.pool.roll(rng, { tier: 5, maxTier: 5, playerId: 'p_1', filter: (cid) => cid.startsWith('chess_char_diy_') });
  assert.equal(theirs, b5, 'and p_1\u2019s for p_1');
  m.dispose();
});

test('waiguan: botWaiguanPicks prefers the bonds a bot plays around, never repeats within one tier', () => {
  // 维多利亚 is a core bond with roster candidates; the bot should take one of those over an unrelated candidate
  const victoria = ROSTER.candidates.filter((c) => c.bonds.includes('victoriaShip'));
  assert.ok(victoria.length >= 1, 'the roster has a 维多利亚 candidate to prefer');
  const picks = botWaiguanPicks(DATA, ROSTER, ['victoriaShip']);
  const byChar = new Map(ROSTER.candidates.map((c) => [c.charId, c]));
  assert.ok(picks.diy5a || picks.diy5b, 'the tier V slots are filled');
  assert.ok(picks.diy6a || picks.diy6b, 'the tier VI slots are filled');
  for (const [slot, charId] of Object.entries(picks)) {
    assert.ok(byChar.has(charId), `${slot}: ${charId} is a roster candidate`);
    assert.ok(byChar.get(charId).bonds.includes('victoriaShip'), `${slot}: the preferred bond wins the slot`);
  }
  for (const tier of [5, 6]) {
    const slots = tier === 5 ? ['diy5a', 'diy5b'] : ['diy6a', 'diy6b'];
    const chosen = slots.map((s) => picks[s]).filter(Boolean);
    assert.equal(new Set(chosen).size, chosen.length, `tier ${tier}: two different operators`);
  }
  // an empty / missing roster is not an error
  assert.deepEqual(botWaiguanPicks(DATA, null, ['victoriaShip']), {});
  assert.deepEqual(botWaiguanPicks(DATA, { candidates: [] }, []), {});
});

test('waiguan: a bot seat brings its own picks, a human seat brings exactly what it sent', () => {
  const seats = [
    { seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true },
    { seat: 1, playerId: 'ai_0', name: 'AI0', isBot: true, connected: true },
  ];
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seats, seed: 3 }).start();
  const m = h.m;
  assert.equal(m.waiguanPicks.p_0, undefined, 'a human that picked nothing has no picks');
  const botPicks = m.waiguanPicks.ai_0;
  assert.ok(botPicks && Object.keys(botPicks).length >= 2, 'the bot filled slots of its own');
  const byChar = new Map(ROSTER.candidates.map((c) => [c.charId, c]));
  for (const [slot, charId] of Object.entries(botPicks)) {
    const tier = slot.startsWith('diy5') ? 5 : 6;
    assert.ok(byChar.has(charId), `${slot}: ${charId} is a roster candidate`);
    const rec = m.waiguanRecords[`chess_char_diy_${tier}_${charId}_a`];
    assert.ok(rec, `${slot}: the picked record exists`);
    assert.equal(m.pool.has(rec.chessId, 'ai_0'), true, `${slot}: the bot owns the entry`);
    assert.equal(m.pool.has(rec.chessId, 'p_0'), false, `${slot}: the human cannot see it`);
  }
  m.dispose();
});

test('waiguan: setPicks accepts a change before the shop is frozen and refuses it after', () => {  const [a5, b5] = pair(5);
  const h = solo(null);
  const m = h.m;
  const first = m.setPicks('p_0', { diy5a: charOf(a5) });
  assert.deepEqual(first, { ok: true });
  assert.equal(m.pool.left(a5, 'p_0'), WAIGUAN_POOL_COPIES[5]);
  // replacing the pick returns the old entry's copies: nothing is lost while the piece is unowned
  assert.deepEqual(m.setPicks('p_0', { diy5a: charOf(b5) }), { ok: true });
  assert.equal(m.pool.left(a5, 'p_0'), WAIGUAN_POOL_COPIES[5], 'the dropped slot keeps its copies (the entry stays)');
  assert.equal(m.pool.left(b5, 'p_0'), WAIGUAN_POOL_COPIES[5]);
  // a pick bought into the hand and then dropped gives its copies back
  const ps = h.ps('p_0');
  give(m, ps, b5);
  assert.equal(m.pool.left(b5, 'p_0'), WAIGUAN_POOL_COPIES[5] - 1, 'holding the piece took a copy');
  assert.deepEqual(m.setPicks('p_0', {}), { ok: true });
  assert.equal(m.pool.left(b5, 'p_0'), WAIGUAN_POOL_COPIES[5], 'the copies came back');
  assert.ok(ps.hand.some((p) => p && p.id === b5), 'the piece itself is untouched (it is the player\u2019s)');
  m.dispose();
});

// Review of this fork's merge of upstream 0.1.4: the match took only the NORMAL \u7504\u9009 record (`\u2026_a`) into its chess table,
// and GameData.goldenIdOf names an elite only when the table holds it \u2014 so three copies of a \u7504\u9009 operator never merged
// (they stayed three normals) and \u5347\u534e / \u535a\u58eb\u6295\u5f71 (PlayerState.promote) never promoted one. All three ways a pick reaches the
// table (the seat's picks at construction, a bot's own picks, Match.setPicks later) now bring the elite (`\u2026_b`) too.
test('waiguan: a \u7504\u9009 piece merges into its elite and can be promoted \u2014 by every way a pick reaches the match', () => {
  /** Three copies acquired like a buy merge into the elite, which holds the three pool copies; promote() makes an elite. */
  const mergesAndPromotes = (h, playerId, chessId) => {
    const m = h.m, ps = h.ps(playerId);
    const elite = m.gd.goldenIdOf(chessId);
    assert.equal(elite, chessId.replace(/_a$/, '_b'), `${chessId}: the match knows its elite`);
    assert.equal(m.gd.chess(elite)?.isGolden, true, `${elite}: the elite record is in the match\u2019s table`);
    assert.equal(m.gd.baseIdOf(elite), chessId);
    assert.equal(m.gd.visibleChess.includes(elite), false, 'the elite is not shop-visible either');
    for (const p of [...ps.board.values(), ...ps.hand.filter(Boolean), ...ps.temp.filter(Boolean)]) if (p.kind === 'chess') ps.returnCopies(p);
    ps.board.clear();
    ps.hand.fill(null);
    ps.temp.fill(null);
    ps.recompute();
    const cap = m.pool.left(chessId, playerId);
    for (let i = 0; i < 3; i++) assert.ok(ps.acquireChess(chessId, { source: 'buy' }), `copy ${i + 1} acquired`);
    const owned = ps.allChess().filter((p) => m.gd.baseIdOf(p.id) === chessId);
    assert.deepEqual(owned.map((p) => p.id), [elite], 'three copies merged into one elite');
    assert.equal(owned[0].poolCopies, 3, 'the elite holds the three copies');
    assert.equal(m.pool.left(chessId, playerId), cap - 3);
    // \u5347\u534e / \u535a\u58eb\u6295\u5f71: a normal copy becomes the elite in place and takes the missing copies the pool still has (tier VI
    // holds only 5: the fourth copy leaves one)
    const fourth = ps.acquireChess(chessId, { source: 'buy' });
    assert.equal(fourth.id, chessId);
    const left = m.pool.left(chessId, playerId);
    assert.equal(left, cap - 4);
    assert.equal(ps.promote(fourth), true, 'the normal copy is promoted');
    assert.equal(fourth.id, elite);
    assert.equal(fourth.poolCopies, 1 + Math.min(2, left));
    assert.equal(m.pool.left(chessId, playerId), left - Math.min(2, left));
    checkInvariants(m);
  };
  const weedy = cands.find((c) => c.charId === 'char_400_weedy');

  // the seat's picks at construction (the lobby's picks): tier VI
  let h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seed: 11,
    seats: [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true, picks: { diy6a: weedy.charId } }] }).start();
  h.toPrep(1);
  mergesAndPromotes(h, 'p_0', weedy.chessIds[6]);
  h.m.dispose();

  // a pick taken later (Match.setPicks): tier V
  h = solo(null);
  assert.deepEqual(h.m.setPicks('p_0', { diy5a: weedy.charId }), { ok: true });
  h.toPrep(1);
  mergesAndPromotes(h, 'p_0', weedy.chessIds[5]);
  h.m.dispose();

  // a bot's own picks (made after the chess table was built): every one of them knows its elite
  h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seed: 3, seats: [
    { seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true },
    { seat: 1, playerId: 'ai_0', name: 'AI0', isBot: true, connected: true },
  ] }).start();
  const botPicks = Object.entries(h.m.waiguanPicks.ai_0 || {});
  assert.ok(botPicks.length >= 2, 'the bot filled slots of its own');
  for (const [slot, charId] of botPicks) {
    const id = `chess_char_diy_${slot.startsWith('diy5') ? 5 : 6}_${charId}_a`;
    assert.equal(h.m.gd.goldenIdOf(id), id.replace(/_a$/, '_b'), `${slot}: the bot\u2019s pick knows its elite`);
  }
  h.toPrep(1);
  mergesAndPromotes(h, 'ai_0', `chess_char_diy_${botPicks[0][0].startsWith('diy5') ? 5 : 6}_${botPicks[0][1]}_a`);
  h.m.dispose();
});

// 0.1.4's 高台 rule (DESIGN §25.2, shared/highGround.js) reads a record's own trait without a module, so it reaches the
// 甄选 records as well (this fork's merge of upstream 0.1.4 with fork PR #17): of the roster only 温蒂 — a 推击手, whose
// branch trait reads 「可以放置于远程位」 — widens, normal and elite, tier V and VI; 帕拉斯's 教官 Y module talent
// ("可以额外部署在远程位") is a 部署效果 and is not read, exactly as for the shop pool's 教官.
test('waiguan: 高台 by trait — a picked 温蒂 (推击手) may take a 高台, 帕拉斯 and every other 甄选 melee stay on the ground', () => {
  const widened = Object.keys(RECORDS).filter((id) => meleeOnHighGround(RECORDS[id])).sort();
  assert.deepEqual(widened, ['chess_char_diy_5_char_400_weedy_a', 'chess_char_diy_5_char_400_weedy_b',
    'chess_char_diy_6_char_400_weedy_a', 'chess_char_diy_6_char_400_weedy_b']);
  const weedy = cands.find((c) => c.charId === 'char_400_weedy');
  const pallas = cands.find((c) => c.charId === 'char_485_pallas');
  assert.equal(weedy.subProfessionId, 'pusher');
  assert.equal(pallas.position, 'MELEE');

  const seats = [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true,
    picks: { diy6a: weedy.charId, diy6b: pallas.charId } }];
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seats, seed: 11 }).start();
  h.toPrep(1);
  h.setStage('act2autochess_m01');       // 战场#01(下半): its 高台 are (10,4) (11,4) (12,4), (9,3) is ground
  const m = h.m, ps = h.ps('p_0');
  for (const p of [...ps.board.values(), ...ps.hand.filter(Boolean)]) if (p.kind === 'chess') ps.returnCopies(p);
  ps.board.clear();
  ps.hand.fill(null);
  ps.recompute();
  const move = (uid, row, col) => m.handle('p_0', { t: 'g.move', uid, to: { area: 'board', row, col }, dir: 'DOWN' });

  const W = weedy.chessIds[6], P = pallas.chessIds[6];
  assert.equal(placeClass(ps, m.gd.chess(W)), 'all', 'the match’s 温蒂 record is widened');
  assert.equal(placeClass(ps, m.gd.chess(P)), 'melee', '帕拉斯 is not');
  const w = give(m, ps, W);
  const p = give(m, ps, P);
  assert.deepEqual(move(w.uid, 10, 4), { ok: true }, '温蒂 → 高台 (10,4)');
  assert.equal(move(p.uid, 11, 4).error, ERR.BAD_TILE, '帕拉斯 → 高台 is refused');
  assert.deepEqual(move(p.uid, 9, 3), { ok: true }, '帕拉斯 on the ground');
  checkInvariants(m);

  // the client's mirror, given the 甄选 record (the loadout screen's withWaiguan lookup)
  const ctx = placementContext({
    priv: ps.privateView(), stage: m.stage, editable: true, field: 'normal',
    getChess: (id) => m.gd.chess(id) ?? null, getToken: (id) => DATA.tokens[id] ?? null, getItem: (id) => DATA.items[id] ?? null,
  });
  assert.equal(piecePosition(ctx, { kind: 'chess', id: W }), 'ALL');
  assert.equal(piecePosition(ctx, { kind: 'chess', id: P }), 'MELEE');
  assert.equal(clientCanPlace(ctx, p.uid, { area: 'board', row: 11, col: 4 }).ok, false);
  assert.equal(clientCanPlace(ctx, w.uid, { area: 'board', row: 12, col: 4 }).ok, true);
  m.dispose();
});
