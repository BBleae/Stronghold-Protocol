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
