// 外援 / 甄选 (DIY) slots — the four 6★ operators a player brings in from outside the shop pool (DESIGN §27).
//
// Covers the data-driven pick (shared/waiguan.js), the protocol check (checkWaiguanPicks), the per-player pool scoping
// (SharedPool.addOwned: a teammate never sees or buys another player's 甄选) and the match wiring (Match.setPicks /
// pool entries / the four empty slot templates staying unreachable).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, DATA, give, checkInvariants, legalTileFor } from './harness.js';
import { checkWaiguanPicks } from '../../shared/protocol.js';
import { WAIGUAN_SLOTS, waiguanRecords } from '../../shared/waiguan.js';
import { WAIGUAN_POOL_COPIES, botWaiguanPicks } from '../../server/match/Match.js';
import { placeClass } from '../../server/match/board.js';
import { meleeOnHighGround } from '../../shared/highGround.js';
import { ERR, PHASE } from '../../shared/constants.js';
import { placementContext, piecePosition, canPlace as clientCanPlace } from '../../public/js/ui/gameLogic.js';
import { RecordedMatch, exportMatch, restoreMatch } from '../../server/match/checkpoint.js';
import { DataSource, getDefaultSource } from '../../server/sim/simdata.js';
import { createRng } from '../../server/sim/rng.js';

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

test('waiguan: setPicks replaces a pick before the shop opens — the dropped pick leaves the pool, its copies come back', () => {
  const [a5, b5] = pair(5);
  const h = solo(null);
  const m = h.m;
  assert.equal(m.phase, PHASE.INFO_CHECK);
  assert.deepEqual(m.setPicks('p_0', { diy5a: charOf(a5) }), { ok: true });
  assert.equal(m.pool.left(a5, 'p_0'), WAIGUAN_POOL_COPIES[5]);
  // the elite record joins the match with the normal one, so the 外援 can merge like any pool chess
  assert.ok(m.gd.chess(a5.replace(/_a$/, '_b')), 'the elite record is in the match table');
  assert.equal(m.gd.goldenIdOf(a5), a5.replace(/_a$/, '_b'));
  // replacing the pick drops the old private entry: it must never show in the player's shop again
  assert.deepEqual(m.setPicks('p_0', { diy5a: charOf(b5) }), { ok: true });
  assert.equal(m.pool.has(a5, 'p_0'), false, 'the dropped pick left the pool');
  assert.equal(m.pool.left(b5, 'p_0'), WAIGUAN_POOL_COPIES[5]);
  // a pick bought into the hand and then dropped gives its copies back, the piece stays the player's
  const ps = h.ps('p_0');
  const piece = give(m, ps, b5);
  assert.equal(piece.poolCopies, 1);
  assert.equal(m.pool.left(b5, 'p_0'), WAIGUAN_POOL_COPIES[5] - 1, 'holding the piece took a copy');
  checkInvariants(m);
  assert.deepEqual(m.setPicks('p_0', {}), { ok: true });
  assert.equal(m.pool.has(b5, 'p_0'), false);
  assert.equal(piece.poolCopies, 0, 'the copies came back');
  assert.ok(ps.hand.includes(piece), 'the piece itself is untouched (it is the player\u2019s)');
  assert.deepEqual(m.waiguanPicks, {});
  // a bad selection changes nothing (resolved as a whole before anything is applied)
  assert.deepEqual(m.setPicks('p_0', { diy5a: charOf(a5) }), { ok: true });
  assert.equal(m.setPicks('p_0', { diy5a: charOf(b5), diy6a: 'char_nobody' }).error, 'BAD_TARGET');
  assert.deepEqual(m.waiguanPicks.p_0, { diy5a: charOf(a5) });
  assert.equal(m.pool.left(a5, 'p_0'), WAIGUAN_POOL_COPIES[5]);
  checkInvariants(m);
  m.dispose();
});

test('waiguan: setPicks is accepted during the strategy draft (BAND_DRAFT) and refused once BATTLE_CHECK opens the shop', () => {
  const [a5] = pair(5);
  const [a6] = pair(6);
  const h = solo(null);
  const m = h.m;
  m.handle('p_0', { t: 'g.infoReady' });
  h.run(() => m.phase === PHASE.BAND_DRAFT);
  assert.equal(m.phase, PHASE.BAND_DRAFT);
  assert.deepEqual(m.setPicks('p_0', { diy5a: charOf(a5), diy6a: charOf(a6) }), { ok: true }, 'the draft still takes picks (DESIGN §27)');
  assert.equal(m.pool.left(a6, 'p_0'), WAIGUAN_POOL_COPIES[6]);
  assert.deepEqual(h.lastTo('p_0', 'm.private').picks, { diy5a: charOf(a5), diy6a: charOf(a6) }, 'm.private carries the match\u2019s own picks');
  m.handle('p_0', { t: 'g.band', bandId: 'band_bldsk' });
  h.run(() => m.phase !== PHASE.BAND_DRAFT);
  assert.equal(m.phase, PHASE.BATTLE_CHECK);
  const refused = m.setPicks('p_0', {});
  assert.equal(refused.error, 'WRONG_PHASE', 'locked from BATTLE_CHECK on');
  h.toPrep(1);
  assert.equal(m.setPicks('p_0', {}).error, 'WRONG_PHASE', 'and in every later phase');
  assert.deepEqual(m.waiguanPicks.p_0, { diy5a: charOf(a5), diy6a: charOf(a6) }, 'a refused change keeps the locked picks');
  m.dispose();
});

/** Refresh the shop `n` times (funds topped up), returning every chess id it showed. */
function refreshShop(h, ps, n) {
  const seen = [];
  for (let i = 0; i < n; i++) {
    ps.funds = 999;
    const res = h.m.handle(ps.playerId, { t: 'g.refresh' });
    assert.ok(res.ok, JSON.stringify(res));
    for (const s of ps.shop.slots) if (s && s.kind === 'chess') seen.push(s.id);
  }
  return seen;
}

test('waiguan: a solo player\u2019s own picks are offered by its shop (rolls, refreshes, round starts) and can be bought and merged', () => {
  const [a5, b5] = pair(5);
  const [a6, b6] = pair(6);
  const picks = { diy5a: charOf(a5), diy5b: charOf(b5), diy6a: charOf(a6), diy6b: charOf(b6) };
  const mine = new Set([a5, b5, a6, b6]);
  const h = solo(picks, 11);
  const m = h.m;
  h.toPrep(1);
  const ps = h.ps('p_0');
  ps.shop.level = 6;
  // the item slot and the chess slots read the same tier shares (pool.tierShares with the player's id): its own copies
  // are part of them at levels 5 and 6
  const shares = m.pool.tierShares(6, 'p_0');
  const shared = m.pool.tierShares(6);
  assert.ok(shares[5] > shared[5] && shares[6] > shared[6], 'the player\u2019s tier shares include its own tier V / VI copies');
  const seen = refreshShop(h, ps, 300);
  const diy = seen.filter((id) => DATA.waiguan && /^chess_char_diy_/.test(id));
  assert.ok(diy.length > 0, `300 refreshes at level 6 offered a 甄选 (${diy.length})`);
  for (const id of diy) assert.ok(mine.has(id), `${id} is one of the player\u2019s own picks`);
  for (const id of mine) assert.ok(diy.includes(id), `${id} was offered at least once`);
  // m.private names it (the browser renders what the server sends)
  const at = ps.shop.slots.findIndex((s) => s && s.kind === 'chess' && mine.has(s.id));
  if (at < 0) {
    // reroll until one shows
    for (let i = 0; i < 200 && !ps.shop.slots.some((s) => s && s.kind === 'chess' && mine.has(s.id)); i++) refreshShop(h, ps, 1);
  }
  const idx = ps.shop.slots.findIndex((s) => s && s.kind === 'chess' && mine.has(s.id));
  assert.ok(idx >= 0);
  const id = ps.shop.slots[idx].id;
  h.flushAll();
  assert.equal(h.lastTo('p_0', 'm.private').shop.slots[idx].id, id, 'the private view shows the 甄选 slot');
  // buy it: one copy of the player's own entry
  const left = m.pool.left(id, 'p_0');
  ps.funds = 999;
  assert.ok(m.handle('p_0', { t: 'g.buy', slot: idx }).ok);
  assert.equal(m.pool.left(id, 'p_0'), left - 1);
  assert.ok([...ps.hand, ...ps.temp].some((p) => p && p.id === id), 'the bought 外援 is in the hand');
  checkInvariants(m);
  // two more copies merge into the elite (the elite record exists, the merge reward follows)
  const before = ps.offers.length;
  give(m, ps, id);
  ps.acquireChess(id, { source: 'buy' });
  const elite = id.replace(/_a$/, '_b');
  assert.ok([...ps.board.values(), ...ps.hand, ...ps.temp].some((p) => p && p.id === elite), 'three copies became the 外援 elite');
  assert.equal(ps.offers.length, before + 1, 'the merge queued its reward offer');
  checkInvariants(m);
  // later round starts keep offering them (the round-start reroll is the same roll)
  ps.funds = 999;
  let fromRounds = 0;
  for (let r = 2; r <= 5; r++) {
    ps.lp = 1e6; // an empty board loses every round: keep the player alive for the shop checks
    h.toPrep(r);
    ps.shop.level = 6;
    fromRounds += refreshShop(h, ps, 60).filter((x) => mine.has(x)).length;
  }
  assert.ok(fromRounds > 0, 'the picks keep appearing in later rounds');
  checkInvariants(m);
  m.dispose();
});

test('waiguan: a player\u2019s tier shares (item slot, odds) are what its chess rolls draw — own picks included, a teammate\u2019s not', () => {
  const [a5] = pair(5);
  const [a6, b6] = pair(6);
  const seats = [
    { seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true, picks: { diy5a: charOf(a5), diy6a: charOf(a6) } },
    { seat: 1, playerId: 'p_1', name: 'P1', isBot: false, connected: true, picks: { diy6a: charOf(b6) } },
  ];
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seats, seed: 41 }).start();
  const m = h.m;
  const rng = createRng(99);
  for (const pid of ['p_0', 'p_1']) {
    const shares = m.pool.tierShares(6, pid);
    const n = 40000;
    const seen = {};
    for (let i = 0; i < n; i++) { const t = m.gd.tierOf(m.pool.roll(rng, { maxTier: 6, playerId: pid })); seen[t] = (seen[t] || 0) + 1; }
    for (const t of Object.keys(shares)) assert.ok(Math.abs(seen[t] / n - shares[t]) < 0.01, `${pid} tier ${t}: rolled ${seen[t] / n} vs share ${shares[t]}`);
  }
  // the two players' shares differ by exactly their own copies
  const copies = (pid, t) => [...m.pool.entriesFor(pid)].filter(([, e]) => e.tier === t).reduce((a, [, e]) => a + e.left, 0);
  assert.equal(copies('p_0', 5) - copies('p_1', 5), WAIGUAN_POOL_COPIES[5]);
  assert.equal(copies('p_0', 6) - copies('p_1', 6), 0, 'one tier VI pick each');
  m.dispose();
});

test('waiguan: merge reward offers and effect grants draw from the player\u2019s own picks', () => {
  const [a5] = pair(5);
  const [a6] = pair(6);
  const h = solo({ diy5a: charOf(a5), diy6a: charOf(a6) }, 13);
  const m = h.m;
  h.toPrep(1);
  const ps = h.ps('p_0');
  ps.shop.level = 5; // offers at min(level + 1, 6) = tier VI
  const offered = new Set();
  for (let i = 0; i < 400; i++) {
    const o = ps.pushRewardOffer('merge');
    for (const s of o.slots) offered.add(s.id);
    ps.offers.length = 0;
  }
  assert.ok(offered.has(a6), 'the tier VI pick is offered by the promotion reward');
  ps.shop.level = 4; // tier V offers
  for (let i = 0; i < 400; i++) { for (const s of ps.pushRewardOffer('merge').slots) offered.add(s.id); ps.offers.length = 0; }
  assert.ok(offered.has(a5), 'the tier V pick is offered by the promotion reward');
  // a random grant of an effect (ctx.rollChess) and a choices.json pool roll: the player's own pool too
  let rolled = 0;
  for (let i = 0; i < 400; i++) if (m.pool.roll(m.rngMeta, { tier: 6, playerId: 'p_0' }) === a6) rolled++;
  assert.ok(rolled > 0);
  checkInvariants(m);
  m.dispose();
});

test('waiguan: co-op — a teammate never sees, rolls, is offered or drains another player\u2019s picks; the same operator may be picked by both', () => {
  const [a5, b5] = pair(5);
  const [a6] = pair(6);
  const seats = [
    { seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true, picks: { diy5a: charOf(a5), diy6a: charOf(a6) } },
    { seat: 1, playerId: 'p_1', name: 'P1', isBot: false, connected: true, picks: { diy5a: charOf(b5), diy6a: charOf(a6) } },
  ];
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seats, seed: 21 }).start();
  const m = h.m;
  // both picked the same tier VI operator: each has a private pool of it (one entry per owner)
  assert.equal(m.pool.left(a6, 'p_0'), WAIGUAN_POOL_COPIES[6]);
  assert.equal(m.pool.left(a6, 'p_1'), WAIGUAN_POOL_COPIES[6]);
  h.toPrep(1);
  const p0 = h.ps('p_0');
  const p1 = h.ps('p_1');
  for (const ps of [p0, p1]) ps.shop.level = 6;
  const seen0 = refreshShop(h, p0, 300);
  const seen1 = refreshShop(h, p1, 300);
  assert.ok(seen0.includes(a5), 'p_0 is offered its own tier V pick');
  assert.ok(!seen0.includes(b5), 'p_0 is never offered p_1\u2019s pick');
  assert.ok(seen1.includes(b5), 'p_1 is offered its own tier V pick');
  assert.ok(!seen1.includes(a5), 'p_1 is never offered p_0\u2019s pick');
  // reward offers
  p1.shop.level = 4;
  for (let i = 0; i < 300; i++) {
    for (const s of p1.pushRewardOffer('merge').slots) assert.notEqual(s.id, a5, 'p_0\u2019s pick is never p_1\u2019s reward');
    p1.offers.length = 0;
  }
  // nothing in p_1's own frames names p_0's private pick
  h.flushAll();
  const p1Frames = JSON.stringify(h.allTo('p_1', 'm.private'));
  assert.ok(!p1Frames.includes(a5), 'p_1\u2019s private frames never name p_0\u2019s pick');
  assert.ok(!JSON.stringify(h.bc.filter((x) => x.t === 'm.public')).includes(a5), 'nor does the public view');
  // a teammate given p_0's 外援 (信标's gift, an effect grant) receives the piece holding NO copy of p_0's pool
  const left = m.pool.left(a5, 'p_0');
  const gift = p1.acquireChess(a5, { source: 'gift' });
  assert.ok(gift, 'the gift arrives');
  assert.equal(gift.poolCopies, 0, 'it holds no copy of p_0\u2019s private pool');
  assert.equal(m.pool.left(a5, 'p_0'), left, 'p_0\u2019s pool is untouched');
  checkInvariants(m);
  // the invariants catch a leak: a teammate's shop slot naming p_0's pick
  p1.shop.slots[0] = { kind: 'chess', id: a5, basePrice: m.gd.chessPrice(a5), frozen: false, sold: false };
  assert.throws(() => checkInvariants(m), /another player's 甄选/);
  m.dispose();
});

test('waiguan: a checkpoint export → restore keeps picks set during INFO_CHECK and BAND_DRAFT (the event log records setPicks)', () => {
  const [a5, b5] = pair(5);
  const [a6] = pair(6);
  let clock = 1000;
  const deps = {
    mode: 'coop', difficulty: 'NORMAL', roomCode: 'WGCP', seed: 23, matchNo: 1, data: DATA, botRehearsal: 0,
    seats: [
      { seat: 0, playerId: 'p0', name: 'Alice', isBot: false, connected: true },
      { seat: 1, playerId: 'p1', name: 'Bob', isBot: false, connected: true, picks: { diy5a: charOf(b5) } },
      { seat: 2, playerId: 'ai0', name: 'AI', isBot: true, connected: true },
    ],
    now: () => clock, send() { return true; }, broadcast() {}, onEnd() {}, clientCombat: false,
  };
  const m = new RecordedMatch(deps);
  m.start();
  assert.deepEqual(m.setPicks('p0', { diy5a: charOf(a5) }), { ok: true }, 'INFO_CHECK');
  for (const id of ['p0', 'p1']) m.handle(id, { t: 'g.infoReady' });
  for (let i = 0; i < 1000 && m.phase !== PHASE.BAND_DRAFT; i++) { clock = m.sched.nextAt() ?? clock; m.pump(clock, 1); }
  assert.equal(m.phase, PHASE.BAND_DRAFT);
  assert.deepEqual(m.setPicks('p0', { diy5a: charOf(a5), diy6a: charOf(a6) }), { ok: true }, 'BAND_DRAFT');
  assert.deepEqual(m.setPicks('p1', {}), { ok: true }, 'a cleared selection is recorded too');
  assert.ok(m.recording.events.some((e) => e.kind === 'setPicks'), 'setPicks is in the event log');
  for (const id of ['p0', 'p1']) m.handle(id, { t: 'g.autoplay', on: true });
  for (let i = 0; i < 5000 && !(m.phase === PHASE.PREP && m.round === 2); i++) { clock = m.sched.nextAt() ?? clock; m.pump(clock, 1); }
  assert.equal(m.phase, PHASE.PREP);
  const checkpoint = JSON.parse(JSON.stringify(exportMatch(m)));
  assert.deepEqual(checkpoint.picks.p0, { diy5a: charOf(a5), diy6a: charOf(a6) });
  const restored = restoreMatch(checkpoint, deps);
  assert.deepEqual(restored.waiguanPicks, m.waiguanPicks, 'the picks survive the restore');
  assert.deepEqual([...restored.pool.ownedBy('p0').keys()], [...m.pool.ownedBy('p0').keys()]);
  assert.equal(restored.pool.ownedBy('p1').size, 0, 'the cleared selection stays cleared');
  for (const id of ['p0', 'p1']) {
    assert.deepEqual(restored.players.get(id).shop.slots, m.players.get(id).shop.slots, `${id}: the same shop`);
    assert.deepEqual(restored.players.get(id).privateView(), m.players.get(id).privateView(), `${id}: the same private state`);
  }
  // a log that lost the setPicks events no longer restores silently into another pool
  const lost = structuredClone(checkpoint);
  lost.events = lost.events.filter((e) => e.kind !== 'setPicks');
  assert.throws(() => restoreMatch(lost, deps), /CHECKPOINT_STATE_DIVERGED|CHECKPOINT_TIMER_DIVERGED/);
  m.dispose();
  restored.dispose();
});

test('waiguan: bots pick valid candidates — never a pick whose every bond is switched off this match — and each bot owns its entries', () => {
  const byChar = new Map(ROSTER.candidates.map((c) => [c.charId, c]));
  let checked = 0;
  for (const difficulty of ['FUNNY', 'HARD']) {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const h = makeMatch({ mode: 'coop', difficulty, humans: 1, bots: 3, seed });
      const m = h.m;
      // the real ban lists: the draw's (Match.disabledBonds) and the mode's (GameData.modeInactiveBonds)
      const off = new Set([...m.disabledBonds, ...m.gd.modeInactiveBonds]);
      assert.ok(off.size > 0, `${difficulty}/${seed}: the match switches bonds off`);
      // the bot aims at the bonds that are live in THIS match (neither drawn off nor mode-inactive) and skips a candidate
      // whose every bond is off — the inputs Match feeds botWaiguanPicks (it once read two fields that do not exist)
      const live = m.gd.bondIds.filter((b) => !off.has(b));
      const allow = (charId) => { const bonds = byChar.get(charId).bonds; return bonds.length === 0 || bonds.some((b) => !off.has(b)); };
      const expected = botWaiguanPicks(m.gd, ROSTER, live, allow);
      for (const bot of ['ai_0', 'ai_1', 'ai_2']) {
        const picks = m.waiguanPicks[bot];
        assert.deepEqual(picks, expected, `${difficulty}/${seed} ${bot}: picked around the live bonds`);
        assert.ok(picks && Object.keys(picks).length >= 2, `${difficulty}/${seed} ${bot}: picks made`);
        assert.ok(checkWaiguanPicks(picks, ROSTER).ok, `${difficulty}/${seed} ${bot}: ${JSON.stringify(picks)} passes the room's check`);
        for (const [slot, charId] of Object.entries(picks)) {
          const bonds = byChar.get(charId).bonds;
          assert.ok(bonds.length === 0 || bonds.some((b) => !off.has(b)), `${difficulty}/${seed} ${bot} ${slot}: ${charId} (${bonds}) has a live bond`);
          const rec = m.waiguanRecords[`chess_char_diy_${slot.startsWith('diy5') ? 5 : 6}_${charId}_a`];
          // every bot owns its own entries, also when bots picked the same operators (one entry per owner)
          assert.equal(m.pool.left(rec.chessId, bot), WAIGUAN_POOL_COPIES[rec.tier], `${bot}: owns ${rec.chessId}`);
          assert.equal(m.pool.has(rec.chessId, 'p_0'), false);
          checked++;
        }
      }
      checkInvariants(m);
      m.dispose();
    }
  }
  assert.ok(checked > 0);
});

test('waiguan: every battle data source resolves the 外援 records (tier V / VI, normal and elite)', () => {
  const ids = [];
  for (const c of ROSTER.candidates.slice(0, 5)) for (const t of [5, 6]) ids.push(c.chessIds[t], c.chessIds[t].replace(/_a$/, '_b'));
  // a source built from the game data (Match.dataSourceFor, the Worker's replay / recovery engines, the browser runner)
  const ds = new DataSource({ chess: DATA.chess, enemies: DATA.enemies, tokens: DATA.tokens, stages: DATA.stages, waves: DATA.waves, waiguan: DATA.waiguan });
  for (const id of ids) {
    const d = ds.getChess(id);
    assert.ok(d && d.id === id, `${id} resolves`);
    assert.equal(d.raw.isDiy, true);
  }
  assert.equal(ds.getChess(ids[0]).raw.tier, 5);
  assert.equal(ds.getChess(ids[2]).raw.tier, 6);
  // a Match's own source (normal, 联防, verification and spec battles) is built the same way
  const h = solo(null);
  for (const id of ids) assert.ok(h.m.ds.getChess(id), `${id}: Match.ds`);
  h.m.dispose();
  // without waiguan.json a source knows none of them; the default source is the shop pool's (tests / tools — the 外援
  // kits are covered by test/content/waiguan/), so it does not either
  assert.equal(new DataSource({ chess: DATA.chess }).getChess(ids[0]), null);
  assert.equal(getDefaultSource().getChess(ids[0]), null);
});

/** Run a solo match to the end of round 1's combat with `chessId` deployed; returns the battle results it produced. */
function battleWith(picks, chessId, seed = 31) {
  const h = solo(picks, seed);
  const m = h.m;
  const results = [];
  for (const k of ['newBattle', '_specBattle']) {
    const orig = m[k].bind(m);
    m[k] = (...a) => { const b = orig(...a); results.push(b); return b; };
  }
  h.toPrep(1, { ready: false });
  const ps = h.ps('p_0');
  for (const k of [...ps.board.keys()]) ps.board.delete(k);
  const at = legalTileFor(m, ps, chessId);
  assert.ok(at, `a legal tile for ${chessId}`);
  give(m, ps, chessId, 'board', at);
  checkInvariants(m);
  h.drive(() => m.phase === PHASE.SETTLE || (m.phase === PHASE.PREP && m.round === 2));
  return { h, m, battles: results };
}

test('waiguan: a deployed 外援 fights in a real server battle (it is on the field and acts)', () => {
  // 艾雅法拉 (caster): a plain damage dealer; 凯尔希: the case of the report (zero ally units before the fix)
  for (const [charId, tier] of [['char_180_amgoat', 6], ['char_003_kalts', 6], ['char_180_amgoat', 5]]) {
    const cand = ROSTER.candidates.find((c) => c.charId === charId);
    assert.ok(cand, `${charId} is a candidate`);
    const id = cand.chessIds[tier];
    const { h, m, battles } = battleWith({ [tier === 5 ? 'diy5a' : 'diy6a']: charId }, id);
    const units = battles.flatMap((b) => (b.result()?.perPlayer?.p_0?.unitStats || []).filter((u) => u.defId === id));
    assert.ok(units.length >= 1, `${id}: the 外援 is a unit of the battle`);
    const u = units[0];
    if (charId === 'char_180_amgoat') assert.ok(u.dmg > 0 && u.attacks > 0, `${id}: it attacks and deals damage (${JSON.stringify(u)})`);
    else assert.ok(u.dmg > 0 || u.heal > 0 || u.attacks > 0 || battles.some((b) => (b.result()?.perPlayer?.p_0?.unitStats || []).some((x) => x.kind === 'token' && x.dmg > 0)), `${id}: it acts (${JSON.stringify(u)})`);
    assert.equal(m.errorCount, 0, `${id}: no engine error`);
    assert.deepEqual(h.logs.error, []);
    m.dispose();
  }
});

// The match once took only the NORMAL 甄选 record (`…_a`) into its chess table, and GameData.goldenIdOf names an elite
// only when the table holds it — so three copies of a 甄选 operator never merged (they stayed three normals) and 升华 /
// 博士投影 (PlayerState.promote) never promoted one (fixed by PR #19's 524fb56, and the same way in this fork's merge of
// upstream 0.1.4: waiguanRecordFor → `records` = the normal record and its `goldenRecord`). The tests above cover the
// setPicks path and a bought merge; this one covers all three ways a pick reaches the table (the seat's picks at
// construction, a bot's own picks, Match.setPicks later) and the promotion as well.
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
    // 升华 / 博士投影: a normal copy becomes the elite in place and takes the missing copies the pool still has (tier VI
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
