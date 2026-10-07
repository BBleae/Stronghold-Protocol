// Unit tests for the in-match UI's pure logic (public/js/ui/gameLogic.js): placement mirror (canPlace),
// drop intents, bond sorting / tiers / members, countdown math, draft / 机变 normalisation, fields,
// shortcuts, settings, enemies preview, result normalisation.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  phaseMode, phaseBanner, isCombatPhase, isBossPhase, countdownState, phaseTotalSeconds, sortBonds, bondTier, nextThreshold,
  bondMembers, memberHeadCount, bannedPerBond, priceTone, mergeProgress, shopBlockReason, deploySets, indexPieces, placementContext, canPlace,
  boardTargets, dropIntent, normalizeDraft, normalizeSp, groupEnemies, factionTypes, snapHud, bossFrac, attackInterval, fmtNum,
  rangeGridBox, shortcutFor, sanitizeSettings, defaultQuality, DEFAULT_SETTINGS, normalizeResult, cycleField, fieldLabel, homeFieldId,
  activeBubbles, sortedPlayers, tileKey, prepCapsuleLabel, prepCamera, dropFailureReason, terrainInfo, bondStripFolded,
  selectVoiceKey, detailSelectVoice, createHudDelay, pickDrawn, drawnChanged, hudChanged, drawnOf, ownFieldGate, snapUnits,
} from '../../public/js/ui/gameLogic.js';
import { pairPlayers } from '../../server/match/finalAssault.js';
import { PHASE, GEO } from '../../shared/constants.js';
import { SP_CARDS_MAX } from '../../shared/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = (f) => JSON.parse(readFileSync(path.join(ROOT, 'data', f), 'utf8'));
const chess = load('chess.json');
const stages = load('stages.json');
const items = load('items.json');
const tokens = load('tokens.json');
const bonds = load('bonds.json');
const config = load('config.json');
const getChess = (id) => chess[id] || null;
const getItem = (id) => items[id] || null;
const getToken = (id) => tokens[id] || null;

const STAGE = stages.act2autochess_m01;
const MELEE = 'chess_char_1_02_a'; // 角峰
const RANGED = 'chess_char_1_01_a'; // 隐现
const EQUIP = 'chess_item_1_01_e_a';
const MAGIC = 'chess_item_6_01_m';

let uid = 0;
const piece = (id, extra = {}) => ({ uid: ++uid, kind: 'chess', id, golden: false, tier: chess[id]?.tier ?? 1, items: [], ...extra });
const item = (id) => ({ uid: ++uid, kind: 'item', id, golden: false, tier: 1 });

function privWith({ board = [], hand = [], temp = [], deployCap = 8, ready = false, loadout = null } = {}) {
  const h = new Array(GEO.HAND_SIZE).fill(null);
  hand.forEach((p, i) => { if (p) h[p.idx ?? i] = p.piece ?? p; });
  const t = new Array(GEO.TEMP_SIZE).fill(null);
  temp.forEach((p, i) => { t[i] = p; });
  return { alive: true, ready, funds: 10, board, hand: h, temp: t, deployCap, deployCount: board.filter((p) => p.kind === 'chess').length, canReady: !t.some(Boolean),
    loadout, shop: { level: 3, maxLevel: 6, upgradePrice: 8, refreshPrice: 1, freeRefreshes: 0, frozen: false, slots: [] } };
}
const ctxFor = (priv, editable = true) => placementContext({ priv, stage: STAGE, editable, getChess, getItem, getToken });

describe('phases', () => {
  test('phaseMode maps every phase', () => {
    assert.equal(phaseMode(null), 'loading');
    assert.equal(phaseMode(PHASE.INFO_CHECK), 'briefing');
    assert.equal(phaseMode(PHASE.BAND_DRAFT), 'draft');
    assert.equal(phaseMode(PHASE.BATTLE_CHECK), 'boot');
    for (const p of [PHASE.PREP, PHASE.SP_DRAFT, PHASE.ROUND_START]) assert.equal(phaseMode(p), 'prep');
    for (const p of [PHASE.COMBAT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]) assert.equal(phaseMode(p), 'combat');
    assert.equal(phaseMode(PHASE.SETTLE), 'settle');
    assert.equal(phaseMode(PHASE.RESULT), 'result');
    assert.equal(phaseMode('SOMETHING_NEW'), 'prep');
  });
  test('combat / boss predicates and banners', () => {
    assert.ok(isCombatPhase(PHASE.UNITE) && !isCombatPhase(PHASE.PREP));
    assert.ok(isBossPhase(PHASE.HIDDEN_CORE) && !isBossPhase(PHASE.COMBAT));
    assert.equal(phaseBanner(PHASE.UNITE, {}).title, '联防阶段');
    assert.equal(phaseBanner(PHASE.FINAL_ASSAULT, {}).title, '最终攻势');
    assert.equal(phaseBanner(PHASE.HIDDEN_CORE, {}).title, '隐秘核心');
    assert.equal(phaseBanner(PHASE.COMBAT, {}).title, '作战开始');
    assert.match(phaseBanner(PHASE.ROUND_START, { round: 7 }).title, /7/);
    assert.equal(phaseBanner(PHASE.SETTLE, {}), null);
    assert.equal(prepCapsuleLabel(PHASE.PREP), '休息一下');
  });
});

describe('countdown', () => {
  test('untimed phases show "--"', () => {
    assert.deepEqual(countdownState(0, Date.now()), { remain: null, warn: false, bars: 0, text: '--', frac: 0 });
    assert.equal(countdownState(null, 1000).text, '--');
    assert.equal(countdownState(NaN, 1000).remain, null);
  });
  test('ceil seconds, warn at ≤10, gauge bars from total', () => {
    const now = 1_000_000;
    const a = countdownState(now + 60_000, now, 60);
    assert.equal(a.remain, 60); assert.equal(a.bars, 5); assert.equal(a.warn, false); assert.equal(a.text, '60');
    const b = countdownState(now + 9_001, now, 60);
    assert.equal(b.remain, 10); assert.equal(b.warn, true); assert.equal(b.bars, 1); assert.equal(b.text, '10');
    const c = countdownState(now + 4_200, now, 60);
    assert.equal(c.text, '05');
    const d = countdownState(now - 5000, now, 60);
    assert.equal(d.remain, 0); assert.equal(d.bars, 0);
    assert.equal(countdownState(now + 30_000, now).bars, 5, 'no total ⇒ full gauge');
    assert.equal(countdownState(now + 2_000_000, now).text, '999', 'clamped to 3 digits');
  });
  test('phase totals from config', () => {
    assert.equal(phaseTotalSeconds({ phase: PHASE.INFO_CHECK }, config), config.timers.infoCheck);
    assert.equal(phaseTotalSeconds({ phase: PHASE.PREP, modeId: 'mode_multi_hard', round: 4 }, config), config.modes.mode_multi_hard.rounds['4'].prepTime);
    assert.equal(phaseTotalSeconds({ phase: PHASE.PREP, modeId: 'mode_single_hard', round: 4 }, config), null, 'solo prep untimed');
    assert.equal(phaseTotalSeconds({ phase: PHASE.SP_DRAFT, sp: { cards: [], picks: {} }, players: [] }, config), config.timers.spFirst);
    assert.equal(phaseTotalSeconds({ phase: PHASE.SP_DRAFT, sp: { cards: [{}, {}], picks: { a: 0 } }, players: [{ playerId: 'a' }] }, config), config.timers.spTurn);
    assert.equal(phaseTotalSeconds(null, config), null);
    // the strategy draft: one countdown, the turn's (m.public.draft.turnSeconds; user playtest #4 item 4)
    assert.equal(phaseTotalSeconds({ phase: PHASE.BAND_DRAFT, draft: { turnSeconds: 30 } }, config), 30);
    assert.equal(phaseTotalSeconds({ phase: PHASE.BAND_DRAFT }, config), config.timers.bandTurn);
  });
});

describe('bonds', () => {
  test('sortBonds: active, layers, count, tier, core, id', () => {
    const list = [
      { bondId: 'deputShip', active: false, layers: 50, count: 1, tier: 0 },
      { bondId: 'preciShip', active: true, layers: 3, count: 2, tier: 1 },
      { bondId: 'yanShip', active: true, layers: 3, count: 2, tier: 1 },
      { bondId: 'swiftShip', active: true, layers: 9, count: 2, tier: 1 },
      null, { nope: 1 },
    ];
    const sorted = sortBonds(list, (id) => bonds[id]).map((b) => b.bondId);
    assert.deepEqual(sorted, ['swiftShip', 'yanShip', 'preciShip', 'deputShip']);
    assert.deepEqual(sortBonds(undefined), []);
  });
  test('bondTier / nextThreshold incl. downward bonds', () => {
    assert.equal(bondTier(5, [3, 6, 9]), 1);
    assert.equal(bondTier(9, [3, 6, 9]), 3);
    assert.equal(bondTier(0, [2]), 0);
    assert.equal(bondTier(1, [1], 1), 1);
    assert.equal(bondTier(2, [1], 1), 0, '独行 inactive above maxCount');
    assert.equal(nextThreshold(4, [3, 6, 9]), 6);
    assert.equal(nextThreshold(9, [3, 6, 9]), null);
  });
  test('bondMembers marks on-board / owned / banned', () => {
    const b = bonds.deputShip;
    const [m1, m2, m3] = b.visibleMembers;
    const priv = privWith({ board: [{ ...piece(m1), row: 9, col: 3 }], hand: [piece(chess[m2].goldenId)] });
    const rows = bondMembers(b, priv, [m3], getChess);
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get(m1).onBoard, true);
    assert.equal(byId.get(m2).owned, true, 'golden in hand counts as owned base');
    assert.equal(byId.get(m2).onBoard, false);
    assert.equal(byId.get(m3).banned, true);
    assert.equal(byId.get(m2).inHand, true, 'a golden copy in the hand marks the base in hand');
    assert.equal(rows[0].id, m1, 'on-board first');
    assert.equal(rows.length, b.visibleMembers.length);
  });
  test('memberHeadCount: the hand counts only for a bond that counts the hand, once per row', () => {
    const rows = [
      { id: 'a', onBoard: true, inHand: true },
      { id: 'b', onBoard: false, inHand: true },
      { id: 'c', onBoard: false, inHand: false },
      null,
    ];
    assert.equal(memberHeadCount(rows, false), 1, 'board only');
    assert.equal(memberHeadCount(rows, true), 2, 'board or hand, one row once');
    assert.equal(memberHeadCount(null, true), 0);
    assert.equal(memberHeadCount(undefined), 0);
    const invest = bonds.investShip;
    assert.equal(invest.countsHand, true);
    const [m1, m2] = invest.visibleMembers;
    const priv = privWith({
      board: [{ ...piece(m1), row: 9, col: 3 }],
      hand: [piece(m2)],
      temp: [piece(invest.visibleMembers[2] || m2)],
    });
    const got = bondMembers(invest, priv, [], getChess);
    const byId = new Map(got.map((r) => [r.id, r]));
    assert.equal(byId.get(m1).onBoard, true);
    assert.equal(byId.get(m2).inHand, true);
    assert.equal(byId.get(m2).onBoard, false);
    if (invest.visibleMembers[2]) assert.equal(byId.get(invest.visibleMembers[2]).inHand, false, 'a temporary-slot copy is not in hand');
    assert.equal(memberHeadCount(got, true), 2, 'the board member and the hand member, not the temporary slot');
    assert.equal(memberHeadCount(got, false), 1, 'without countsHand the hand member is left out');
  });
  test('sortBonds puts a mode-off bond after every live bond', () => {
    const sorted = sortBonds([
      { bondId: 'investShip', off: true, active: false, layers: 99, count: 3, tier: 0 },
      { bondId: 'yanShip', active: true, layers: 1, count: 3, tier: 1 },
      { bondId: 'raidShip', off: true, layers: 0, count: 1 },
    ], (id) => bonds[id]).map((b) => b.bondId);
    assert.deepEqual(sorted, ['yanShip', 'investShip', 'raidShip']);
  });
  test('bannedPerBond counts banned visible members', () => {
    const b = bonds.deputShip;
    const per = bannedPerBond(Object.values(bonds), [b.visibleMembers[0], b.visibleMembers[1], 'nope']);
    assert.equal(per.get('deputShip'), 2);
    assert.equal(per.get('yanShip') >= 0, true);
  });
});

describe('shop', () => {
  test('priceTone: discount / markup / normal / free', () => {
    assert.equal(priceTone({ price: 2, basePrice: 3 }), 'discount');
    assert.equal(priceTone({ price: 4, basePrice: 3 }), 'premium');
    assert.equal(priceTone({ price: 3, basePrice: 3 }), 'gold');
    assert.equal(priceTone({ price: 0, basePrice: 3 }), 'discount');
    assert.equal(priceTone({ price: 3 }), 'gold');
    assert.equal(priceTone(null), 'gold');
  });
  test('mergeProgress counts normal copies on board, hand and temp', () => {
    const priv = privWith({ board: [{ ...piece(MELEE), row: 9, col: 3 }], hand: [piece(MELEE), piece(chess[MELEE].goldenId, { golden: true })], temp: [piece(MELEE)] });
    assert.deepEqual(mergeProgress(priv, MELEE, getChess), { copies: 3, need: 3 });
    assert.deepEqual(mergeProgress(privWith(), 'chess_char_2_11_a', getChess).need, chess.chess_char_2_11_a.upgradeNum);
  });
  test('shopBlockReason', () => {
    const priv = privWith();
    assert.equal(shopBlockReason('buy', { priv, editable: true, slot: { price: 3, sold: false } }), null);
    assert.equal(shopBlockReason('buy', { priv, editable: true, slot: { price: 30 } }), '资金不足');
    assert.equal(shopBlockReason('buy', { priv, editable: true, slot: { price: 1, sold: true } }), '已售出');
    assert.equal(shopBlockReason('buy', { priv: { ...priv, ready: true }, editable: false, slot: {} }), '已准备就绪，取消准备后才能操作');
    assert.equal(shopBlockReason('levelUp', { priv: { ...priv, shop: { ...priv.shop, level: 6 } }, editable: true }), '调度中心已达最高等级');
    assert.equal(shopBlockReason('refresh', { priv: { ...priv, funds: 0 }, editable: true }), '资金不足');
    assert.equal(shopBlockReason('refresh', { priv: { ...priv, funds: 0, shop: { ...priv.shop, refreshPrice: 0 } }, editable: true }), null, 'free refresh');
    assert.match(shopBlockReason('ready', { priv: { ...priv, canReady: false } }), /临时整备区/);
    assert.equal(shopBlockReason('ready', { priv }), null);
    assert.equal(shopBlockReason('buy', { priv: { ...priv, alive: false }, editable: true }), '你已被淘汰');
    assert.equal(shopBlockReason('buy', {}), '尚未就绪');
  });
});

describe('placement mirror (canPlace)', () => {
  test('deploySets uses stage deployTiles, derived legend as fallback', () => {
    const d = deploySets(STAGE);
    assert.ok(d.melee.has('9,3') && d.ranged.has('9,3'));
    assert.ok(!d.melee.has('10,4') && d.ranged.has('10,4'), 'high ground: ranged only');
    assert.ok(!d.ranged.has('9,2'), 'objective not deployable');
    const { deployTiles, ...noDt } = STAGE; // eslint-disable-line no-unused-vars
    const d2 = deploySets(noDt);
    assert.deepEqual([...d2.melee].sort(), [...d.melee].sort());
    assert.deepEqual([...d2.ranged].sort(), [...d.ranged].sort());
    assert.equal(deploySets(null).melee.size, 0);
  });
  test('melee vs ranged tiles', () => {
    const m = piece(MELEE);
    const r = piece(RANGED);
    const ctx = ctxFor(privWith({ hand: [m, r] }));
    assert.equal(canPlace(ctx, m.uid, { area: 'board', row: 9, col: 3 }).ok, true);
    assert.equal(canPlace(ctx, m.uid, { area: 'board', row: 10, col: 4 }).ok, false, 'melee on high ground');
    assert.equal(canPlace(ctx, r.uid, { area: 'board', row: 10, col: 4 }).ok, true);
    assert.equal(canPlace(ctx, r.uid, { area: 'board', row: 9, col: 3 }).ok, true, 'ranged may use melee tiles');
    assert.equal(canPlace(ctx, m.uid, { area: 'board', row: 9, col: 2 }).ok, false, 'objective');
    assert.equal(canPlace(ctx, m.uid, { area: 'board', row: 9, col: 10 }).ok, false, 'gate');
    assert.equal(canPlace(ctx, m.uid, { area: 'board', row: 9, col: 12 }).ok, false, 'outside own field');
    assert.equal(canPlace(ctx, m.uid, { area: 'board', row: 7, col: 3 }).ok, false, 'hand row is not board');
    assert.equal(canPlace(ctx, m.uid, { area: 'board', row: 9.5, col: 3 }).ok, false, 'non-integer');
    assert.equal(canPlace(ctx, 99999, { area: 'board', row: 9, col: 3 }).ok, false, 'unknown uid');
    assert.equal(canPlace(ctx, m.uid, null).ok, false);
    assert.equal(canPlace(ctx, m.uid, { area: 'temp', idx: 0 }).ok, false, 'no temp target');
  });
  test('every trait holder (歌蕾蒂娅, 崖心, 见行者, normal and elite) lights the 高台 whatever the module; a plain melee stays on the ground', () => {
    const holders = ['chess_char_4_12_a', 'chess_char_4_12_b', 'chess_char_2_03_a', 'chess_char_2_03_b', 'chess_char_3_07_a', 'chess_char_3_07_b'].map((id) => piece(id));
    const m = piece(MELEE);
    const every = STAGE.deployTiles.normal.melee.length + STAGE.deployTiles.normal.rangedOnly.length;
    // the module does not matter: the default, HOK-Y, HOK-X and none on 歌蕾蒂娅; 崖心's HOK-X; none on 见行者
    for (const loadout of [null, { chess_char_4_12_a: { module: 'uniequip_003_glady' } }, { chess_char_4_12_a: { module: 'uniequip_002_glady' } },
      { chess_char_4_12_a: { module: 'none' }, chess_char_2_03_a: { module: 'none' }, chess_char_3_07_a: { module: 'none' } }]) {
      const ctx = ctxFor(privWith({ hand: [...holders, m], loadout }));
      for (const p of holders) {
        for (const [row, col] of [[10, 4], [11, 4], [12, 4], [9, 3]]) assert.equal(canPlace(ctx, p.uid, { area: 'board', row, col }).ok, true, `${p.id} on ${row},${col} (${JSON.stringify(loadout)})`);
        assert.equal(boardTargets(ctx, p.uid).legal.length, every, `${p.id}: every deploy tile lit`);
      }
      assert.deepEqual(canPlace(ctx, m.uid, { area: 'board', row: 10, col: 4 }), { ok: false, code: 'BAD_TILE', reason: '近战单位只能部署在地面' }, '角峰');
      assert.equal(canPlace(ctx, m.uid, { area: 'board', row: 9, col: 3 }).ok, true, '角峰 on the ground');
    }
  });
  test('not editable ⇒ nothing is legal', () => {
    const m = piece(MELEE);
    assert.equal(canPlace(ctxFor(privWith({ hand: [m] }), false), m.uid, { area: 'board', row: 9, col: 3 }).code, 'WRONG_PHASE');
    assert.equal(canPlace(null, m.uid, { area: 'board', row: 9, col: 3 }).ok, false);
  });
  test('deploy cap counts chess on board only; swap keeps count', () => {
    const board = [];
    const tiles = [[9, 3], [9, 4], [9, 5], [9, 7], [9, 8], [9, 9], [10, 5], [10, 7]];
    for (const [row, col] of tiles) board.push({ ...piece(MELEE), row, col });
    // the 狼群's owner: 伺夜 facing UP on (9,4) — her range (rows 9–12 × cols 3–5) covers the tiles tried below
    // ("只能部署在召唤者攻击范围内", player report #9 after 0.1.0)
    board[1] = { ...piece('chess_char_3_19_a'), row: 9, col: 4, dir: 'UP' };
    const extra = piece(MELEE);
    const ctx = ctxFor(privWith({ board, hand: [extra] }));
    const full = canPlace(ctx, extra.uid, { area: 'board', row: 11, col: 5 });
    assert.equal(full.ok, false); assert.equal(full.code, 'BOARD_FULL');
    assert.deepEqual(canPlace(ctx, extra.uid, { area: 'board', row: 9, col: 3 }), { ok: true, action: 'swap' }, 'swap with a deployed unit');
    const onBoard = board[0];
    assert.equal(canPlace(ctx, onBoard.uid, { area: 'board', row: 11, col: 5 }).ok, true, 'moving on the board never hits the cap');
    // tokens don't use deploy slots
    const tok = { uid: ++uid, kind: 'token', id: 'token_10028_vigil_wolf', count: 1, ownerUid: board[1].uid };
    const ctx2 = ctxFor(privWith({ board, hand: [tok] }));
    assert.equal(canPlace(ctx2, tok.uid, { area: 'board', row: 11, col: 5 }).ok, true);
    assert.equal(canPlace(ctx2, tok.uid, { area: 'board', row: 10, col: 4 }).ok, false, 'MELEE token not on high ground');
    assert.equal(canPlace(ctx2, tok.uid, { area: 'board', row: 9, col: 3 }).code, 'BAD_TILE', 'a hand token never swaps into an occupied tile');
    const orphan = { uid: ++uid, kind: 'token', id: 'token_10028_vigil_wolf', count: 1, ownerUid: 777777 };
    const ctx3 = ctxFor(privWith({ board, hand: [orphan] }));
    assert.equal(canPlace(ctx3, orphan.uid, { area: 'board', row: 11, col: 5 }).code, 'BAD_TARGET', 'summoner must be deployed');
    // a hand chess swapping with a board token takes a deploy slot (cap applies)
    const bTok = { uid: ++uid, kind: 'token', id: 'token_10028_vigil_wolf', count: 1, ownerUid: board[1].uid, row: 11, col: 5 };
    const ctx4 = ctxFor(privWith({ board: [...board, bTok], hand: [extra] }));
    assert.equal(canPlace(ctx4, extra.uid, { area: 'board', row: 11, col: 5 }).code, 'BOARD_FULL');
  });
  test('board→board swap requires both positions to be legal', () => {
    const m = { ...piece(MELEE), row: 9, col: 3 };
    const r = { ...piece(RANGED), row: 10, col: 4 };
    const ctx = ctxFor(privWith({ board: [m, r] }));
    assert.equal(canPlace(ctx, r.uid, { area: 'board', row: 9, col: 3 }).ok, false, 'the melee unit cannot go to the high tile');
    assert.equal(canPlace(ctx, m.uid, { area: 'board', row: 10, col: 4 }).ok, false);
    // its own tile: legal — the direction wheel re-orients it in place (research 09 §1.2)
    assert.deepEqual(canPlace(ctx, m.uid, { area: 'board', row: 9, col: 3 }), { ok: true, action: 'orient' });
    assert.deepEqual(dropIntent(ctx, m.uid, { area: 'board', row: 9, col: 3 }), { t: 'g.move', fields: { uid: m.uid, to: { area: 'board', row: 9, col: 3 } } });
  });
  test('hand targets: move, swap, same slot, board unit vs hand item', () => {
    const b = { ...piece(RANGED), row: 10, col: 4 };
    const h0 = piece(MELEE);
    const it = item(EQUIP);
    const ctx = ctxFor(privWith({ board: [b], hand: [{ idx: 0, piece: h0 }, { idx: 1, piece: it }] }));
    assert.deepEqual(canPlace(ctx, b.uid, { area: 'hand', idx: 5 }), { ok: true, action: 'move' });
    assert.equal(canPlace(ctx, b.uid, { area: 'hand', idx: 0 }).ok, false, 'melee hand unit cannot take the high tile');
    assert.deepEqual(canPlace(ctx, b.uid, { area: 'hand', idx: 1 }), { ok: true, action: 'move' }, 'withdrawn onto an item slot: the server uses another free slot');
    assert.deepEqual(canPlace(ctx, h0.uid, { area: 'hand', idx: 1 }), { ok: true, action: 'swap' }, 'hand ↔ hand swap with an item');
    assert.equal(canPlace(ctx, h0.uid, { area: 'hand', idx: 0 }).code, 'ALREADY');
    assert.equal(canPlace(ctx, h0.uid, { area: 'hand', idx: 10 }).ok, false);
    assert.equal(canPlace(ctx, h0.uid, { area: 'hand', idx: -1 }).ok, false);
  });
  test('items: equip on chess (board or hand), arts on tiles, not on tokens', () => {
    const b = { ...piece(MELEE), row: 9, col: 3 };
    const hChess = piece(RANGED);
    const tok = { uid: ++uid, kind: 'token', id: 'token_10028_vigil_wolf', count: 1, row: 9, col: 4 };
    const eq = item(EQUIP);
    const art = item(MAGIC);
    const ctx = ctxFor(privWith({ board: [b, tok], hand: [{ idx: 0, piece: hChess }, { idx: 1, piece: eq }, { idx: 2, piece: art }] }));
    assert.deepEqual(canPlace(ctx, eq.uid, { area: 'board', row: 9, col: 3 }), { ok: true, action: 'equip' });
    assert.deepEqual(canPlace(ctx, eq.uid, { area: 'hand', idx: 0 }), { ok: true, action: 'equip' });
    assert.equal(canPlace(ctx, eq.uid, { area: 'board', row: 9, col: 4 }).ok, false, 'tokens cannot carry items');
    assert.equal(canPlace(ctx, eq.uid, { area: 'board', row: 9, col: 5 }).ok, false, 'empty tile');
    assert.deepEqual(canPlace(ctx, eq.uid, { area: 'hand', idx: 7 }), { ok: true, action: 'move' }, 'rearranging the hand');
    assert.deepEqual(canPlace(ctx, art.uid, { area: 'board', row: 11, col: 6 }), { ok: true, action: 'art' });
    assert.equal(canPlace(ctx, art.uid, { area: 'hand', idx: 0 }).ok, false, 'arts are not equipped');
    assert.deepEqual(canPlace(ctx, art.uid, { area: 'hand', idx: 1 }), { ok: true, action: 'swap' }, 'item ↔ item swap in the hand');
  });
  test('boardTargets lists legal tiles for highlighting', () => {
    const m = piece(MELEE);
    const r = piece(RANGED);
    const ctx = ctxFor(privWith({ hand: [m, r] }));
    const lm = boardTargets(ctx, m.uid).legal.map(([a, b]) => tileKey(a, b));
    const lr = boardTargets(ctx, r.uid).legal.map(([a, b]) => tileKey(a, b));
    assert.equal(lm.length, STAGE.deployTiles.normal.melee.length);
    assert.equal(lr.length, STAGE.deployTiles.normal.melee.length + STAGE.deployTiles.normal.rangedOnly.length);
    assert.ok(!lm.includes('10,4') && lr.includes('10,4'));
    assert.deepEqual(boardTargets(ctx, 424242), { legal: [], illegal: [] });
  });
  test('dropIntent builds protocol-valid g.* messages', async () => {
    const { validateC2S } = await import('../../shared/protocol.js');
    // two OTHER items equipped (an identical copy would merge with the incoming one instead: no replacement — see
    // test/ui/leftovers.test.js)
    const b = { ...piece(MELEE), row: 9, col: 3, items: [{ uid: 900, id: 'chess_item_1_02_e_a' }, { uid: 901, id: 'chess_item_1_05_e_a' }] };
    const h = piece(RANGED);
    const eq = item(EQUIP);
    const art = item(MAGIC);
    const ctx = ctxFor(privWith({ board: [b], hand: [{ idx: 0, piece: h }, { idx: 1, piece: eq }, { idx: 2, piece: art }] }));
    const mv = dropIntent(ctx, h.uid, { area: 'board', row: 10, col: 4 });
    assert.deepEqual(mv, { t: 'g.move', fields: { uid: h.uid, to: { area: 'board', row: 10, col: 4 } } });
    const back = dropIntent(ctx, b.uid, { area: 'hand', idx: 6 });
    assert.deepEqual(back.fields.to, { area: 'hand', idx: 6 });
    const eqI = dropIntent(ctx, eq.uid, { area: 'board', row: 9, col: 3 });
    assert.equal(eqI.t, 'g.equip'); assert.equal(eqI.confirmReplace, true, '2 items equipped ⇒ confirm');
    const eqH = dropIntent(ctx, eq.uid, { area: 'hand', idx: 0 });
    assert.equal(eqH.confirmReplace, false);
    const consumable = Object.values(items).find((x) => x.itemType === 'EQUIP' && String(x.kind).startsWith('consume_on_equip'));
    const cons = item(consumable.id);
    const ctxC = ctxFor(privWith({ board: [b], hand: [{ idx: 3, piece: cons }] }));
    assert.equal(dropIntent(ctxC, cons.uid, { area: 'board', row: 9, col: 3 }).confirmReplace, false, 'consumed on equip: nothing is replaced');
    const ar = dropIntent(ctx, art.uid, { area: 'board', row: 12, col: 6 });
    assert.deepEqual(ar, { t: 'g.art', fields: { itemUid: art.uid, row: 12, col: 6 } });
    for (const i of [mv, back, eqI, eqH, ar]) assert.equal(validateC2S({ t: i.t, ...i.fields }), null, i.t);
    assert.equal(dropIntent(ctx, h.uid, { area: 'board', row: 9, col: 2 }), null);
    assert.equal(dropIntent(ctx, h.uid, { area: 'outside', clientX: 1, clientY: 1 }), null);
  });
  test('indexPieces tolerates junk', () => {
    const m = indexPieces({ board: [null, { uid: 'x' }, { uid: 5, row: 9, col: 3, kind: 'chess' }], hand: 'nope', temp: [undefined] });
    assert.equal(m.size, 1);
    assert.equal(indexPieces(null).size, 0);
  });
});

describe('drafts', () => {
  const players = [{ playerId: 'a', seat: 0 }, { playerId: 'b', seat: 1 }, { playerId: 'c', seat: 2 }];
  test('normalizeDraft: index or id turn, object or array picks', () => {
    const d1 = normalizeDraft({ order: ['c', 'a', 'b'], turn: 1, picks: { c: 'band_x' } }, players);
    assert.equal(d1.turnPid, 'a'); assert.equal(d1.picks.get('c'), 'band_x'); assert.equal(d1.done, false);
    const d2 = normalizeDraft({ order: ['c', 'a'], turn: 'c', picks: ['band_y', null] }, players);
    assert.equal(d2.turnPid, 'c'); assert.equal(d2.picks.get('c'), 'band_y'); assert.equal(d2.picks.has('a'), false);
    const d3 = normalizeDraft({ picks: [{ playerId: 'a', bandId: 'z' }], skipsLeft: { a: 0 } }, players);
    assert.deepEqual(d3.order, ['a', 'b', 'c']); assert.equal(d3.picks.get('a'), 'z'); assert.equal(d3.skipsLeft.get('a'), 0);
    const d4 = normalizeDraft(null, []);
    assert.equal(d4.turnPid, null); assert.equal(d4.done, false);
    assert.equal(normalizeDraft({ order: ['a'], turn: 5 }).turnPid, null, 'out-of-range index');
    assert.equal(normalizeDraft({ order: ['a'], picks: { a: 'q' } }).done, true);
  });
  test('normalizeSp: picks map, array, takenBy; turn', () => {
    const sp = normalizeSp({ family: 'bounty', cards: ['e1', { effectId: 'e2' }, { itemId: 'i3', takenBy: 'c' }, 7], turn: 'a', picks: { b: 0 } }, players);
    assert.equal(sp.cards.length, 4);
    assert.equal(sp.cards[0].id, 'e1');
    assert.equal(sp.cards[0].takenBy, 'b');
    assert.equal(sp.cards[2].takenBy, 'c');
    assert.equal(sp.pickOf.get('c'), 2);
    assert.equal(sp.turnPid, 'a');
    assert.equal(sp.pickedCount, 2);
    const sp2 = normalizeSp({ cards: [{}, {}], order: ['b', 'a'], turn: 0, picks: [{ playerId: 'b', idx: 1 }, { playerId: 'x', idx: 9 }] }, players);
    assert.equal(sp2.turnPid, 'b'); assert.equal(sp2.cards[1].takenBy, 'b'); assert.equal(sp2.pickOf.has('x'), false);
    assert.equal(normalizeSp(null), null);
    // at most the server's most cards: co-op max(6, alive + 2) — 6 for 1–4 players, 10 for 8 (shared/protocol.js)
    assert.equal(normalizeSp({ cards: new Array(SP_CARDS_MAX + 3).fill({}) }).cards.length, SP_CARDS_MAX, 'at most SP_CARDS_MAX cards');
  });
});

describe('fields, players, emotes', () => {
  const pub = {
    players: [{ playerId: 'p2', seat: 1, name: 'B' }, { playerId: 'p1', seat: 0, name: 'A', fieldId: 'n:p1' }, null],
    fields: [{ fieldId: 'n:p1', kind: 'normal', players: ['p1'], live: true }, { fieldId: 'n:p2', kind: 'normal', players: ['p2'], live: true },
      { fieldId: 'u', kind: 'unite', players: ['p2'], live: false }],
  };
  test('sortedPlayers by seat, junk dropped', () => {
    assert.deepEqual(sortedPlayers(pub).map((p) => p.playerId), ['p1', 'p2']);
    assert.deepEqual(sortedPlayers(null), []);
  });
  test('cycleField wraps over live fields only', () => {
    assert.equal(cycleField(pub.fields, 'n:p1', 1), 'n:p2');
    assert.equal(cycleField(pub.fields, 'n:p2', 1), 'n:p1');
    assert.equal(cycleField(pub.fields, 'n:p1', -1), 'n:p2');
    assert.equal(cycleField(pub.fields, 'zzz', 1), 'n:p1');
    assert.equal(cycleField([], 'n:p1', 1), null);
  });
  test('fieldLabel / homeFieldId', () => {
    assert.equal(fieldLabel(pub.fields[0], pub, 'p1'), '自己');
    assert.equal(fieldLabel(pub.fields[1], pub, 'p1'), 'B');
    assert.equal(fieldLabel({ fieldId: 'b1', kind: 'boss', players: ['p1', 'p2'] }, pub, 'p1'), '全景');
    assert.equal(fieldLabel({ fieldId: 'b2', kind: 'boss', players: ['p2'] }, pub, 'p1'), 'B');
    assert.equal(fieldLabel({ fieldId: 'u', kind: 'unite', players: ['p2'] }, pub, 'p1'), '联防阵地');
    assert.equal(homeFieldId(pub, 'p1'), 'n:p1');
    assert.equal(homeFieldId({ ...pub, fields: [{ fieldId: 'b1', kind: 'boss', players: ['p1'], live: true }] }, 'p1'), 'b1');
    assert.equal(homeFieldId({}, 'zz'), 'n:zz');
  });
  test('activeBubbles keeps the newest emote per player within ttl', () => {
    const now = 10_000;
    const m = activeBubbles([{ seq: 1, playerId: 'a', id: 'hello', at: 8_000 }, { seq: 2, playerId: 'a', id: 'thanks', at: 9_000 },
      { seq: 3, playerId: 'b', id: 'wow', at: 5_000 }, null], now, 3000);
    assert.equal(m.get('a').id, 'thanks'); assert.equal(m.has('b'), false);
    assert.equal(activeBubbles(undefined, now).size, 0);
  });
});

describe('enemies, HUD, stats', () => {
  const enemies = { e1: { name: '甲', rank: 'NORMAL', stats: { motion: 'WALK' } }, e2: { name: '乙', rank: 'ELITE', acTypes: ['FLY'], stats: { motion: 'FLY' } }, e3: { name: '丙', rank: 'BOSS' } };
  test('groupEnemies merges and orders boss → bounty → elite → normal', () => {
    const rows = groupEnemies([{ enemyKey: 'e1', count: 3 }, { enemyKey: 'e1', count: 2 }, { enemyKey: 'e2', count: 1 }, { enemyKey: 'e3', count: 1, tag: 'boss' },
      { enemyKey: 'e1', count: 1, tag: 'bounty' }, { bogus: 1 }, null], (k) => enemies[k]);
    assert.deepEqual(rows.map((r) => `${r.enemyKey}:${r.tag}:${r.count}`), ['e3:boss:1', 'e1:bounty:1', 'e2:null:1', 'e1:null:5']);
    assert.equal(rows[2].fly, true); assert.deepEqual(rows[2].acTypes, ['FLY']);
    assert.equal(groupEnemies([{ enemyKey: 'x', count: -4 }])[0].count, 1);
  });
  test('factionTypes accepts strings and objects', () => {
    assert.deepEqual(factionTypes(['FLY', { type: 'TIMES' }, { id: 'SPECIAL' }, 'FLY', 3, null]), ['FLY', 'TIMES', 'SPECIAL']);
  });
  test('snapHud / bossFrac', () => {
    assert.deepEqual(snapHud({ killed: 3, total: 9, dp: 20 }), { killed: 3, total: 9, dp: 20, boss: null });
    assert.deepEqual(snapHud({ boss: { hp: 50, max: 200 } }).boss, { hp: 50, max: 200 });
    assert.equal(snapHud(null), null);
    assert.equal(bossFrac({ hp: 50, max: 200 }), 0.25);
    assert.equal(bossFrac({ hp: 500, max: 200 }), 1);
    assert.equal(bossFrac({ hp: 5, max: 0 }), null);
    assert.equal(bossFrac(null), null);
  });
  test('attackInterval, fmtNum, rangeGridBox', () => {
    assert.equal(attackInterval(1, 100), 1);
    assert.equal(attackInterval(1.2, 120), 1);
    assert.equal(attackInterval(0, 100), null);
    assert.equal(attackInterval(1, 0), 1, 'bad aspd falls back to 100');
    assert.equal(fmtNum(12345), '12,345');
    assert.equal(fmtNum(2_310_000), '231万');
    assert.equal(fmtNum(150_000), '15.0万');
    assert.equal(fmtNum('x'), '—');
    const box = rangeGridBox([[1, 0], [0, 1], [-1, 2]]);
    assert.equal(box.rows, 3); assert.equal(box.cols, 3); assert.ok(box.cells.has('0,1'));
    const mir = rangeGridBox([[0, 2]], true);
    assert.ok(mir.cells.has('0,-2'));
    assert.equal(rangeGridBox(null).cells.size, 0);
  });
});

describe('keyboard & settings', () => {
  test('shortcutFor', () => {
    assert.equal(shortcutFor({ key: 'r', code: 'KeyR' }), 'refresh');
    assert.equal(shortcutFor({ key: 'F', code: 'KeyF' }), 'freeze');
    assert.equal(shortcutFor({ key: 'd' }), 'levelUp');
    assert.equal(shortcutFor({ key: 'q', code: 'KeyQ' }), 'retreat');
    assert.equal(shortcutFor({ key: 'Q' }), 'retreat');
    assert.equal(shortcutFor({ code: 'KeyX' }), 'sell');
    assert.equal(shortcutFor({ key: 'X' }), 'sell');
    for (const key of ['q', 'x']) {
      assert.equal(shortcutFor({ key, repeat: true }), null);
      assert.equal(shortcutFor({ key, ctrlKey: true }), null);
      assert.equal(shortcutFor({ key, metaKey: true }), null);
      assert.equal(shortcutFor({ key, altKey: true }), null);
      for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
        assert.equal(shortcutFor({ key, target: { tagName } }), null);
      }
      assert.equal(shortcutFor({ key, target: { isContentEditable: true } }), null);
    }
    assert.equal(shortcutFor({ key: ' ', code: 'Space' }), 'ready');
    assert.equal(shortcutFor({ key: 'Escape' }), 'escape');
    assert.equal(shortcutFor({ key: 'r', ctrlKey: true }), null);
    assert.equal(shortcutFor({ key: 'r', repeat: true }), null);
    assert.equal(shortcutFor({ key: 'Escape', repeat: true }), 'escape');
    assert.equal(shortcutFor({ key: 'r', target: { tagName: 'input' } }), null);
    assert.equal(shortcutFor({ key: ' ', code: 'Space', target: { tagName: 'BUTTON' } }), 'ready', 'space readies even with a HUD button focused');
    assert.equal(shortcutFor({ key: ' ', code: 'Space', target: { tagName: 'TEXTAREA' } }), null);
    assert.equal(shortcutFor({ key: 'd', target: { tagName: 'DIV', isContentEditable: true } }), null);
    assert.equal(shortcutFor({ key: 'z' }), null);
    assert.equal(shortcutFor(null), null);
  });
  test('sanitizeSettings', () => {
    assert.deepEqual(sanitizeSettings(null), { ...DEFAULT_SETTINGS });
    assert.deepEqual(sanitizeSettings({ bgm: 3, sfx: -1, voice: 2, voiceLang: 'fr', muted: 'yes', damageNumbers: false, quality: 'ultra' }),
      { bgm: 1, sfx: 0, voice: 1, voiceLang: 'cn', muted: false, damageNumbers: false, quality: 'high' });
    assert.equal(sanitizeSettings({ voiceLang: 'jp' }).voiceLang, 'jp');
    assert.equal(sanitizeSettings({ voiceLang: 'off' }).voiceLang, 'off');
    assert.equal(sanitizeSettings({ voiceLang: 'en' }).voiceLang, 'en', 'the EN / KR dubs (DESIGN §21.30)');
    assert.equal(sanitizeSettings({ voiceLang: 'kr' }).voiceLang, 'kr');
    assert.equal(sanitizeSettings({ bgm: 0.5 }).voice, DEFAULT_SETTINGS.voice, 'a saved profile without `voice` gets the default');
    assert.equal(sanitizeSettings({ bgm: 0.333 }).bgm, 0.33);
    assert.equal(sanitizeSettings({ quality: 'low' }).quality, 'low');
  });
  test('phone audit P6: a phone starts on 中, only when no quality was chosen — a saved one always wins', () => {
    assert.equal(defaultQuality(false), 'high', 'desktop / tablet keep 高');
    assert.equal(defaultQuality(true), 'medium');
    assert.equal(DEFAULT_SETTINGS.quality, 'high', 'the shared default is untouched');
    assert.equal(sanitizeSettings(null, defaultQuality(true)).quality, 'medium', 'first run on a phone');
    assert.equal(sanitizeSettings({ bgm: 0.5 }, defaultQuality(true)).quality, 'medium', 'settings saved without a quality');
    assert.equal(sanitizeSettings({ quality: 'ultra' }, defaultQuality(true)).quality, 'medium', 'an unknown value is no choice');
    for (const q of ['high', 'medium', 'low']) assert.equal(sanitizeSettings({ quality: q }, defaultQuality(true)).quality, q, `saved ${q} wins on a phone`);
    assert.equal(sanitizeSettings(null).quality, 'high', 'no fallback given: unchanged behaviour');
    assert.deepEqual({ ...sanitizeSettings(null, 'medium'), quality: 'high' }, { ...DEFAULT_SETTINGS }, 'only the quality differs');
  });
});

describe('result', () => {
  test('normalizeResult fills from m.public and sorts by seat', () => {
    const pub = { lastRound: 14, difficulty: 'HARD', players: [{ playerId: 'b', seat: 1, name: 'B', lp: 4, bandId: 'band_x' }, { playerId: 'a', seat: 0, name: 'A' }] };
    const r = normalizeResult({ victory: true, roundsPassed: 14, players: [{ playerId: 'b', title: 'comment_2', lineup: [{ id: 'c1' }], stats: { kills: 3 } }, { playerId: 'a', title: { id: 'comment_1', name: '卫戍之星' } }, null] }, pub);
    assert.equal(r.victory, true);
    assert.deepEqual(r.players.map((p) => p.playerId), ['a', 'b']);
    assert.equal(r.players[1].bandId, 'band_x');
    assert.equal(r.players[1].lp, 4);
    assert.deepEqual(r.players[1].title, { id: 'comment_2' });
    assert.equal(r.players[0].title.name, '卫戍之星');
    assert.equal(r.difficulty, 'HARD');
    const empty = normalizeResult(null, null);
    assert.equal(empty.victory, false); assert.deepEqual(empty.players, []); assert.equal(empty.lastRound, 14);
    assert.equal(normalizeResult({ players: [{ playerId: 'x', roundsPassed: 9 }] }, null).roundsPassed, 9);
  });
});

describe('prepCamera (research 09 §1.2: the Final Assault prep on the own half of the boss field)', () => {
  const pl = (id, seat, alive = true) => ({ playerId: id, seat, alive });
  const pub = (round, players) => ({ round, bossRound: 14, hiddenRound: 15, players });
  test('normal rounds: the own board', () => {
    const c = prepCamera(pub(6, [pl('a', 0), pl('b', 1)]), 'b');
    assert.deepEqual(c, { kind: 'prep', opts: { rect: { ...GEO.NORMAL_RECT }, side: 'L' } });
    assert.equal(prepCamera(null, 'a').kind, 'prep');
    assert.equal(prepCamera({ round: 14, bossRound: null, hiddenRound: null, players: [] }, 'a').kind, 'prep');
  });
  test('boss / hidden round prep: bossPrep on the side of the server pairing (alive players by seat, two by two)', () => {
    const players = [pl('d', 3), pl('a', 0), pl('c', 2), pl('b', 1)];
    for (const round of [14, 15]) {
      const sides = Object.fromEntries(players.map((p) => [p.playerId, prepCamera(pub(round, players), p.playerId)]));
      assert.deepEqual(Object.fromEntries(Object.entries(sides).map(([k, v]) => [k, `${v.kind}:${v.opts.side}`])),
        { a: 'bossPrep:L', b: 'bossPrep:R', c: 'bossPrep:L', d: 'bossPrep:R' });
    }
    // somebody left (eliminated): the pairs close up exactly like the server's (Match._quit re-plans the boss waves)
    const left = [pl('a', 0), pl('b', 1, false), pl('c', 2), pl('d', 3)];
    const groups = pairPlayers(left.filter((p) => p.alive).map((p) => ({ ...p })));
    for (const g of groups) g.forEach((p, j) => assert.equal(prepCamera(pub(14, left), p.playerId).opts.side, j === 1 ? 'R' : 'L', p.playerId));
    assert.equal(prepCamera(pub(14, left), 'c').opts.side, 'R', 'c moves up to the right half');
    assert.equal(prepCamera(pub(14, left), 'b').kind, 'prep', 'an eliminated player has no half');
    // solo / a lone last player: the left half
    assert.deepEqual(prepCamera(pub(14, [pl('a', 0)]), 'a'), { kind: 'bossPrep', opts: { side: 'L' } });
  });
});

// user playtest #4 item 1: a dragged item drops on the tile under the pointer (render/drag.js) and goes to the unit on
// that tile — the highlighted tile; nothing is retargeted to a sprite drawn over another tile any more
describe('equipment dropped on a tile goes to the unit on it', () => {
  test('the operator on the drop tile (board or bench), not the one whose head is drawn there; an empty tile says why', () => {
    const front = { ...piece(RANGED), row: 9, col: 3 }, behind = { ...piece(RANGED), row: 10, col: 3 };
    const onBench = piece(RANGED);
    const eq = item(EQUIP), art = item(MAGIC);
    const ctx = ctxFor(privWith({ board: [front, behind], hand: [{ idx: 0, piece: eq }, { idx: 1, piece: art }, { idx: 4, piece: onBench }] }));
    assert.deepEqual(dropIntent(ctx, eq.uid, { area: 'board', row: 9, col: 3 }).fields, { itemUid: eq.uid, targetUid: front.uid });
    assert.deepEqual(dropIntent(ctx, eq.uid, { area: 'board', row: 10, col: 3 }).fields, { itemUid: eq.uid, targetUid: behind.uid });
    assert.deepEqual(dropIntent(ctx, eq.uid, { area: 'hand', idx: 4 }).fields, { itemUid: eq.uid, targetUid: onBench.uid }, 'a bench operator');
    // the empty tile behind `behind` (where its head is drawn) takes nothing — and the release says why
    assert.equal(dropIntent(ctx, eq.uid, { area: 'board', row: 11, col: 3 }), null);
    assert.equal(dropFailureReason(ctx, eq.uid, { row: 11, col: 3, area: 'board' }), '请将装备拖拽至干员身上');
    // an Art is used on the tile under the pointer itself
    assert.deepEqual(dropIntent(ctx, art.uid, { area: 'board', row: 11, col: 3 }), { t: 'g.art', fields: { itemUid: art.uid, row: 11, col: 3 } });
  });
});

describe('operator voice (选中干员, DESIGN §21.30)', () => {
  // a battle unit's detail card as screens/game.js builds it: the target ({ kind: 'unit', unit }) and ui/detailPanel.js
  // resolveDetail's answer ({ type: 'chess', chess, unitId, … })
  // (`inBattle`: screens/game.js pieceClick opened it in a battle phase)
  const unit = (id, defId, o = {}, inBattle = true) => ({ kind: 'unit', unit: { id, defId, side: 'ally', ...o }, unitId: id, uid: o.uid ?? null, inBattle });
  const card = (target) => ({ type: 'chess', chess: chess[target.unit.defId], piece: null, unitId: target.unit.id, unitItems: null });
  const A = 'chess_char_1_01_a';
  const B = 'chess_char_1_01_b';

  test('selectVoiceKey: the field on screen and the unit id', () => {
    assert.equal(selectVoiceKey('n:p_0', 7), 'n:p_0:7');
    assert.equal(selectVoiceKey('u:1', 12), 'u:1:12');
    assert.equal(selectVoiceKey(null, 7), ':7');
    assert.equal(selectVoiceKey(undefined, 7), ':7');
    assert.notEqual(selectVoiceKey('n:p_0', 7), selectVoiceKey('n:p_1', 7), 'the same unit id on another field is another unit');
  });

  test('detailSelectVoice: an operator of the battle on screen, in a battle phase only — the key the tap uses', () => {
    const t = unit(7, A);
    const want = { charId: chess[A].charId, key: 'n:p_0:7' };
    for (const phase of [PHASE.COMBAT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]) {
      assert.deepEqual(detailSelectVoice({ phase, fieldId: 'n:p_0', target: t, resolved: card(t) }), want, phase);
    }
    // the tap (screens/game.js pieceClick) asks with selectVoiceKey(field on screen, unit.id): the same key, so
    // audio.voice drops the card's repeat and one tap says one line
    assert.equal(detailSelectVoice({ phase: PHASE.COMBAT, fieldId: 'n:p_0', target: t, resolved: card(t) }).key, selectVoiceKey('n:p_0', t.unit.id));
    // the 整备期, 结算, the result screen, no match: silent
    for (const phase of [PHASE.PREP, PHASE.ROUND_START, PHASE.SP_DRAFT, PHASE.SETTLE, PHASE.RESULT, PHASE.INFO_CHECK, null, undefined]) {
      assert.equal(detailSelectVoice({ phase, fieldId: 'n:p_0', target: t, resolved: card(t) }), null, String(phase));
    }
  });

  test('detailSelectVoice: battle units that resolved to a chess record only; an elite shares its charId', () => {
    const t = unit(7, A);
    const ok = (o) => detailSelectVoice({ phase: PHASE.COMBAT, fieldId: 'n:p_0', target: t, resolved: card(t), ...o });
    // a teammate's / 联防 / spectated field's operator speaks too (no owner check): the key names that field
    const mate = unit(3, A, { ownerId: 'p_1' });
    assert.deepEqual(detailSelectVoice({ phase: PHASE.UNITE, fieldId: 'u:1', target: mate, resolved: card(mate) }), { charId: chess[A].charId, key: 'u:1:3' });
    // an elite (`_b`) record: the same operator, the same voice
    const elite = unit(9, B);
    assert.equal(chess[B].charId, chess[A].charId);
    assert.deepEqual(detailSelectVoice({ phase: PHASE.COMBAT, fieldId: 'n:p_0', target: elite, resolved: card(elite) }), { charId: chess[A].charId, key: 'n:p_0:9' });
    // a bench / board piece's card, a shop card, a bond member's card: never
    assert.equal(ok({ target: { kind: 'piece', uid: 4 } }), null, 'a piece card');
    assert.equal(ok({ target: { kind: 'chess', id: A } }), null, 'a shop / bond-member card');
    assert.equal(ok({ target: null }), null);
    // a summon, an enemy, an item: no operator line
    assert.equal(ok({ resolved: { type: 'token', token: { id: 'token_x' }, unitId: 7 } }), null, 'a summon');
    assert.equal(ok({ resolved: { type: 'enemy', enemy: { key: 'enemy_x' }, unitId: 7 } }), null, 'an enemy');
    assert.equal(ok({ resolved: null }), null);
    // no unit id (nothing to key it on) or no charId: silent
    assert.equal(ok({ resolved: { ...card(t), unitId: undefined } }), null);
    assert.equal(ok({ resolved: { ...card(t), unitId: null } }), null);
    assert.equal(ok({ resolved: { ...card(t), chess: { ...chess[A], charId: undefined } } }), null);
    assert.equal(ok({ resolved: { ...card(t), chess: null } }), null);
    assert.equal(detailSelectVoice(), null);
    // key stability: the same unit gives the same key render after render; another unit or field another key
    assert.equal(ok().key, ok().key);
    assert.notEqual(ok().key, detailSelectVoice({ phase: PHASE.COMBAT, fieldId: 'n:p_0', target: elite, resolved: card(elite) }).key);
    assert.notEqual(ok().key, ok({ fieldId: 'n:p_1' }).key);
    assert.equal(ok({ fieldId: null }).key, ':7');
  });

  test('detailSelectVoice: a card opened outside a battle phase stays silent when the battle starts under it; a prep scouting board piece never speaks', () => {
    // a unit card opened in the 整备期 on a teammate's / spectated scouted board (Match._scoutUnits: id = the piece's uid,
    // `area` board / hand / temp) is kept open into the battle (screens/game.js closes only chess / item cards then):
    // the render that brings COMBAT must not make it say 选中干员 with no tap
    for (const area of ['board', 'hand', 'temp']) {
      const prep = unit(41, A, { area, uid: 41, ownerId: 'mate' }, false);
      for (const phase of [PHASE.PREP, PHASE.COMBAT, PHASE.FINAL_ASSAULT]) {
        assert.equal(detailSelectVoice({ phase, fieldId: 'n:mate', target: prep, resolved: card(prep) }), null, `${area} ${phase}`);
      }
      // tapped in a battle phase while that board is still on screen (before the battle's field arrives): still no
      // battle unit
      const tapped = unit(41, A, { area, uid: 41, ownerId: 'mate' }, true);
      assert.equal(detailSelectVoice({ phase: PHASE.COMBAT, fieldId: 'n:mate', target: tapped, resolved: card(tapped) }), null, `${area} tapped`);
    }
    // a battle unit's card opened in the 整备期 (the battle's field came before m.public named the phase) stays silent
    // too; opened — or retargeted — in the battle it speaks
    const early = unit(7, A, {}, false);
    assert.equal(detailSelectVoice({ phase: PHASE.COMBAT, fieldId: 'n:p_0', target: early, resolved: card(early) }), null, 'opened in prep');
    const { inBattle, ...noFlag } = unit(7, A);
    assert.equal(inBattle, true);
    assert.equal(detailSelectVoice({ phase: PHASE.COMBAT, fieldId: 'n:p_0', target: noFlag, resolved: card(noFlag) }), null, 'no flag: not opened by a battle tap');
    assert.deepEqual(detailSelectVoice({ phase: PHASE.COMBAT, fieldId: 'n:p_0', target: unit(7, A), resolved: card(unit(7, A)) }),
      { charId: chess[A].charId, key: 'n:p_0:7' });
  });
});

describe('createHudDelay: own-field HUD values follow the drawn battle (render 0.5 s behind its frames)', () => {
  // fake clock + timers: what game.js does with performance.now / setTimeout
  const harness = (field = () => 'n:P1') => {
    let t = 0, seq = 0;
    const timers = new Map();
    const shown = [];      // hud releases: [time, hud]
    const battles = [];    // battle slice releases: [time, slice]
    const units = [];      // unit tuple releases: [time, Map]
    const order = [];      // channel order of the releases
    const d = createHudDelay({
      onHud: (h) => { shown.push([t, h]); order.push('hud'); },
      onBattle: (b) => { battles.push([t, b]); order.push('battle'); },
      onUnits: (u) => { units.push([t, u]); order.push('units'); },
      field, now: () => t,
      setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: t + ms }); return id; },
      clearTimer: (id) => { timers.delete(id); },
    });
    const advance = (ms) => {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, x] of timers) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    };
    return { d, timers, shown, battles, units, order, advance };
  };

  test('a whole battle of 20 Hz frames keeps one timer; each frame is shown 0.5 s after it arrived', () => {
    const { d, timers, shown, advance } = harness();
    let most = 0;
    for (let i = 0; i < 1200; i++) {   // 60 s of frames
      d.push('n:P1', { killed: i }, 500);
      most = Math.max(most, timers.size);
      advance(50);
    }
    assert.equal(most, 1, 'never more than one pending timer (it used to arm one more per frame)');
    assert.ok(shown.length >= 1150);
    for (const [at, h] of shown.slice(0, 50)) assert.ok(at >= h.killed * 50 + 500 && at < h.killed * 50 + 550, `frame ${h.killed} shown at ${at}`);
    advance(600);
    assert.equal(shown.at(-1)[1].killed, 1199);
    assert.equal(timers.size, 0, 'idle once drained');
  });

  test('a watch switch drops the previous field\'s queued numbers', () => {
    let cur = 'n:P1';
    const { d, shown, advance } = harness(() => cur);
    for (let i = 0; i < 10; i++) { d.push('n:P1', { field: 'P1', i }, 500); advance(50); }
    cur = 'n:P2';
    d.push('n:P2', { field: 'P2', i: 0 }, 500);
    advance(1000);
    assert.ok(shown.every(([at, h]) => h.field === 'P2' || at < 500 + 50 * 10), 'nothing of P1 after the switch');
    assert.equal(shown.at(-1)[1].field, 'P2');
  });

  test('dispose clears the timer and the queue', () => {
    const { d, timers, shown, battles, advance } = harness();
    d.push('n:P1', { killed: 1 }, 500);
    d.pushBattle('n:P1', { done: true }, 500);
    d.dispose();
    advance(1000);
    assert.equal(timers.size, 0);
    assert.equal(shown.length, 0);
    assert.equal(battles.length, 0);
    assert.equal(d.size, 0);
  });

  test('everything due is released together, in order: later values override, patches merge (it used to keep only the last)', () => {
    const { d, shown, battles, order, advance } = harness();
    // five entries due in the same drain: the capsule and the DP of different frames both survive
    d.push('n:P1', { killed: 1, total: 8 }, 500);
    d.push('n:P1', { dp: 7 }, 500);
    d.push('n:P1', { killed: 2 }, 500);
    d.pushBattle('n:P1', { leaks: { 'n:P1': 1 }, done: false }, 500);
    d.pushBattle('n:P1', { done: true }, 500);
    advance(499);
    assert.equal(shown.length + battles.length, 0, 'nothing before the lag');
    advance(1);
    assert.deepEqual(shown.map(([, h]) => h), [{ killed: 2, total: 8, dp: 7 }], 'one release: merged in order, the later killed wins');
    assert.deepEqual(battles.map(([, b]) => b), [{ leaks: { 'n:P1': 1 }, done: true }], 'the battle slices merge too');
    assert.deepEqual(order, ['hud', 'battle'], 'the capsule before the slice (the screen flushes the capsule with the slice)');
  });

  test('regression: the 作战结束 flag is released together with the final frame\'s n/n, never before it', () => {
    const { d, shown, battles, units, order, advance } = harness();
    const u7 = new Map([[1, [1, 0, 0, 5, 10]]]), u8 = new Map([[1, [1, 0, 0, 0, 10]]]);
    d.push('n:P1', { killed: 7, total: 8 }, 500, { units: u7 });
    advance(1000);                                   // 7/8 drawn; the last enemy is still walking
    d.push('n:P1', { killed: 8, total: 8 }, 500, { units: u8 });   // the finishing frame ...
    d.pushBattle('n:P1', { done: true, leaks: {} }, 500);          // ... then the sim's done publish (same task)
    advance(499);
    assert.equal(shown.at(-1)[1].killed, 7, 'still 7/8 on screen, and no flag yet');
    assert.equal(battles.length, 0);
    advance(1);
    assert.equal(shown.at(-1)[1].killed, 8);
    assert.equal(battles.at(-1)[1].done, true);
    assert.equal(units.at(-1)[1], u8, 'the unit card\'s HP follows the same frame');
    assert.deepEqual(order.slice(-3), ['units', 'hud', 'battle']);
    assert.equal(shown.at(-1)[0], battles.at(-1)[0], 'same instant');
  });

  test('a slice of another field is dropped at release (watch switch); an entry with nothing in it is not queued', () => {
    let cur = 'n:P1';
    const { d, battles, shown, advance } = harness(() => cur);
    d.pushBattle('n:P1', { fieldId: 'n:P1', done: true }, 500);
    d.push('n:P1', null, 500);
    d.push('n:P1', null, 500, {});
    assert.equal(d.size, 1);
    cur = 'n:P2';
    d.pushBattle('n:P2', { fieldId: 'n:P2', done: false }, 500);
    advance(1000);
    assert.deepEqual(battles.map(([, b]) => b.fieldId), ['n:P2']);
    assert.equal(shown.length, 0);
  });

  test('clear() drops what is queued (a field entered again restarts at once) and the queue keeps working', () => {
    const { d, timers, shown, battles, advance } = harness();
    d.push('n:P1', { killed: 3 }, 500);
    d.pushBattle('n:P1', { done: false }, 500);
    d.clear();
    advance(1000);
    assert.equal(shown.length + battles.length, 0);
    assert.equal(timers.size, 0);
    d.push('n:P1', { killed: 4 }, 100);
    advance(100);
    assert.equal(shown.at(-1)[1].killed, 4);
  });

  test('the queue stays bounded (cap): the oldest entries go first, the newest survive', () => {
    const got = [];
    const small = createHudDelay({ onHud: (h) => got.push(h.i), field: () => 'n:P1', now: () => 0, setTimer: () => 1, clearTimer: () => {}, cap: 3 });
    for (let i = 0; i < 10; i++) small.push('n:P1', { i }, 500);
    assert.equal(small.size, 3);
  });

  test('setPaused (solo pause): nothing is released while paused; on resume the rest of the lag is waited out', () => {
    const { d, timers, shown, battles, advance } = harness();
    d.push('n:P1', { killed: 1 }, 500);               // due at 500
    d.pushBattle('n:P1', { done: true }, 500);
    advance(200);                                      // 300 ms of lag left
    d.setPaused(true);
    assert.equal(timers.size, 0, 'no timer runs while paused');
    advance(5000);
    assert.equal(shown.length + battles.length, 0, 'the frozen picture shows no new number');
    d.setPaused(true);                                 // idempotent
    d.setPaused(false);                                // t = 5200: 300 ms to go (not "5000 ms overdue")
    advance(299);
    assert.equal(shown.length + battles.length, 0);
    advance(1);
    assert.equal(shown.length, 1);
    assert.equal(battles.length, 1);
    assert.equal(shown[0][0], 5500);
    d.setPaused(false);                                // resuming a running queue is a no-op
  });

  test('setPaused: a value pushed during the pause waits the full lag after the resume; later pauses add up', () => {
    const { d, timers, shown, advance } = harness();
    d.setPaused(true);
    d.push('n:P1', { killed: 1 }, 500);                // the runner's last publish of the pause moment
    advance(2000);
    assert.equal(shown.length, 0);
    d.setPaused(false);                                // resumed at t = 2000
    advance(499);
    assert.equal(shown.length, 0);
    advance(1);
    assert.equal(shown[0][0], 2500);
    d.push('n:P1', { killed: 2 }, 500);                // due at 3000
    advance(100);
    d.setPaused(true);                                 // t = 2600, 400 ms left
    advance(1000);
    d.setPaused(false);                                // t = 3600
    advance(399);
    assert.equal(shown.length, 1);
    advance(1);
    assert.deepEqual(shown.map(([at, h]) => [at, h.killed]), [[2500, 1], [4000, 2]]);
    assert.equal(timers.size, 0);
  });

  test('dispose while paused leaves no timer and no queue', () => {
    const { d, timers, shown, advance } = harness();
    d.push('n:P1', { killed: 1 }, 500);
    d.setPaused(true);
    d.dispose();
    d.setPaused(false);
    advance(2000);
    assert.equal(timers.size, 0);
    assert.equal(shown.length, 0);
    assert.equal(d.size, 0);
  });
});

describe('the drawn battle slice (pickDrawn / drawnOf / ownFieldGate): own-field values follow the picture, the server joins afterwards', () => {
  const sim = (o = {}) => ({
    battleId: 'b1', fieldId: 'n:p_0', kind: 'normal', authoritative: true, watch: false, done: false, own: true, members: ['p_0'], loading: false,
    speed: 2, paused: false, leaks: { 'n:p_0': 2 }, uniteLeft: null, bondLayers: { p_0: { x: 1 } }, ...o,
  });

  test('pickDrawn keeps the HUD values and the gates\' identity; nothing for no battle on screen (null, still loading)', () => {
    assert.deepEqual(pickDrawn(sim()), {
      battleId: 'b1', fieldId: 'n:p_0', kind: 'normal', own: true, watch: false, done: false,
      leaks: { 'n:p_0': 2 }, uniteLeft: null, bondLayers: { p_0: { x: 1 } },
    });
    assert.equal(pickDrawn(null), null, 'the runner publishes null when cleared / disposed');
    assert.equal(pickDrawn(undefined), null);
    assert.equal(pickDrawn({ loading: true, battleId: 'b2', fieldId: 'n:p_0', kind: 'normal', leaks: {}, uniteLeft: null, bondLayers: {} }), null, 'a battle that is still loading is not drawn yet');
    assert.equal(pickDrawn(sim({ fieldId: '' })), null);
    assert.deepEqual(pickDrawn(sim({ leaks: null })).leaks, {}, 'missing maps normalise');
    assert.equal(pickDrawn(sim({ done: true })).done, true);
  });

  test('drawnChanged / hudChanged: what makes the capsule flush at once (DP alone keeps the throttle)', () => {
    const a = pickDrawn(sim());
    assert.equal(drawnChanged(a, pickDrawn(sim())), false, 'same values');
    assert.equal(drawnChanged(a, pickDrawn(sim({ leaks: { 'n:p_0': 3 } }))), true);
    assert.equal(drawnChanged(a, pickDrawn(sim({ done: true }))), true);
    assert.equal(drawnChanged(a, pickDrawn(sim({ bondLayers: { p_0: { x: 2 } } }))), true);
    assert.equal(drawnChanged(a, pickDrawn(sim({ uniteLeft: { p_0: 2 } }))), true);
    assert.equal(drawnChanged(null, a), true);
    assert.equal(drawnChanged(a, a), false);
    assert.equal(hudChanged({ killed: 1, total: 8, dp: 5 }, { killed: 1, total: 8, dp: 6 }), false, 'DP alone');
    assert.equal(hudChanged({ killed: 1, total: 8, dp: 5 }, { killed: 2, total: 8, dp: 5 }), true);
    assert.equal(hudChanged({ killed: 1, total: 8 }, { killed: 1, total: 9 }), true);
    assert.equal(hudChanged(null, { killed: 0, total: 8 }), true);
  });

  test('drawnOf: the released slice of this battle, else the live state (entry frame / not entered yet / another battle)', () => {
    const live = sim({ leaks: { 'n:p_0': 5 }, done: true });
    const old = pickDrawn(sim());
    assert.equal(drawnOf(live, old), old, 'the drawn picture lags the sim: its older slice is what shows');
    assert.equal(drawnOf(live, null), live, 'not seeded / entered yet: the live state (the entry frame is drawn at once)');
    assert.equal(drawnOf(live, { ...old, battleId: 'b0' }), live, 'a slice of the previous battle is never shown');
    assert.equal(drawnOf(live, { ...old, fieldId: 'n:p_1' }), live);
    assert.equal(drawnOf(null, old), null, 'the runner cleared');
  });

  test('ownFieldGate: the pill follows the drawn picture, the pause gate the sim, the server only after the own picture finished', () => {
    const own = 'n:p_0';
    // the sim finished, the drawn picture still shows the last enemy: no pill, no server numbers, but the sim gate is open
    const g1 = ownFieldGate(sim({ done: true }), pickDrawn(sim()), own);
    assert.deepEqual(g1, { onScreen: true, simDone: true, drawnDone: false, serverOk: false });
    // the drawn done slice released
    const g2 = ownFieldGate(sim({ done: true }), pickDrawn(sim({ done: true })), own);
    assert.deepEqual(g2, { onScreen: true, simDone: true, drawnDone: true, serverOk: true });
    // freshly entered (no slice yet): the live state is the drawn one
    assert.equal(ownFieldGate(sim({ done: true }), null, own).drawnDone, true);
    assert.equal(ownFieldGate(sim(), null, own).drawnDone, false);
    // watching a teammate / a 联防 field / nothing: the own picture is not on screen, the server's relayed numbers apply
    for (const s of [sim({ watch: true, own: false, fieldId: 'n:p_1' }), sim({ fieldId: 'u:1', kind: 'unite' }), null]) {
      assert.deepEqual(ownFieldGate(s, null, own), { onScreen: false, simDone: false, drawnDone: false, serverOk: true });
    }
    assert.equal(ownFieldGate(sim({ watch: true }), null, own).onScreen, false, 'a watched field is never "own"');
  });

  test('own leaks / uniteRemaining through the gate (the selectors game.js applies)', async () => {
    const { ownLeaks, uniteRemaining } = await import('../../public/js/ui/hud.js');
    const own = 'n:p_0';
    // the sim already counts 3 leaks, the drawn slice 2 (the third enemy is still outside the gate), the server relays 3
    const simNow = sim({ leaks: { [own]: 3 } });
    const slice = pickDrawn(sim({ leaks: { [own]: 2 } }));
    const g = ownFieldGate(simNow, slice, own);
    const drawnLocal = drawnOf(simNow, slice).leaks[own];
    assert.equal(drawnLocal, 2);
    assert.equal(ownLeaks(drawnLocal, g.serverOk ? 3 : undefined), 2, 'the server\'s 3 is ahead of the picture: ignored while the own picture runs');
    // after the picture finished the server can only confirm (or correct)
    const fin = sim({ leaks: { [own]: 3 }, done: true });
    const g2 = ownFieldGate(fin, pickDrawn(fin), own);
    assert.equal(ownLeaks(drawnOf(fin, pickDrawn(fin)).leaks[own], g2.serverOk ? 4 : undefined), 4, 'a server-corrected count shows once the picture ended');
    // watching a teammate: the own replica is not drawn, the server's count carries on
    const g3 = ownFieldGate(sim({ watch: true, own: false, fieldId: 'n:p_1' }), null, own);
    assert.equal(ownLeaks(1, g3.serverOk ? 4 : undefined), 4);
    // 联防: the replica's per-leaker count (teammates' rows too) is the drawn slice's
    const unite = sim({ fieldId: 'u:1', kind: 'unite', uniteLeft: { p_1: 4 } });
    const dr = drawnOf(unite, pickDrawn(sim({ fieldId: 'u:1', kind: 'unite', uniteLeft: { p_1: 5 } })));
    assert.equal(dr.uniteLeft.p_1, 5, 'the drawn count, not the sim\'s');
    assert.equal(uniteRemaining(dr.uniteLeft.p_1, ownFieldGate(unite, null, own).serverOk ? 9 : undefined), 5, 'the local replica wins over the relayed count');
  });

  test('snapUnits: the snapshot\'s unit tuples by id', () => {
    const t1 = [1, 0, 0, 5, 10], t2 = [2, 1, 1, 7, 7];
    const mp = snapUnits({ units: [t1, t2, null, 'x'] });
    assert.equal(mp.size, 2);
    assert.equal(mp.get(2), t2);
    assert.equal(snapUnits(null).size, 0);
    assert.equal(snapUnits({}).size, 0);
  });
});

// GitHub issue #184 「建议加入对于特殊地形的单击信息提示」: tapping a special terrain tile explains it — in the stage's own
// numbers (the same bb / special parameters the sim runs on), while an ordinary tile says nothing at all.
describe('special terrain tip', () => {
  /** The first (row, col) of `glyph` in a real stage of data/stages.json. */
  const at = (stageId, glyph) => {
    const st = stages[stageId];
    for (let row = 0; row < st.rows.length; row++) {
      const col = st.rows[row].indexOf(glyph);
      if (col >= 0) return { st, row, col };
    }
    throw new Error(`no ${glyph} in ${stageId}`);
  };

  test('each terrain of the mode, with the numbers of the stage it stands on', () => {
    // 活性源石 (战场#04): the official tile parameters (damage 70/s, +20% ATK, +20 ASPD, 300 s)
    const inf = at('act1autochess_m04', 'i');
    const tip = terrainInfo(inf.st, inf.row, inf.col);
    assert.equal(tip.key, 'infection');
    assert.equal(tip.name, '活性源石');
    assert.equal(tip.tag, '特殊地形');
    assert.deepEqual([tip.row, tip.col], [inf.row, inf.col]);
    assert.match(tip.lines[0], /每秒受到 70 点真实伤害/, 'damage from the stage\'s own bb');
    assert.match(tip.lines[1], /攻击力 \+20%、攻击速度 \+20/);
    assert.match(tip.lines[2], /300 秒/);
    assert.deepEqual(tip.facts, ['可部署', '地面单位可通过']);
    // 沼泽 (战场#06): one 陷入沼泽 layer a second, −5% ASPD (−5% move for enemies), 2 layers at 重量 ≥ 3, 10 at most
    const mire = terrainInfo(...(() => { const g = at('act2autochess_m02', 'm'); return [g.st, g.row, g.col]; })());
    assert.equal(mire.name, '沼泽');
    assert.ok(mire.lines.some((l) => /攻击速度 −5%/.test(l) && /移动速度 −5%/.test(l)));
    assert.ok(mire.lines.some((l) => /重量 ≥ 3 的敌人一次获得 2 层/.test(l)));
    assert.ok(mire.lines.some((l) => /最多 10 层/.test(l)));
    // 排气格栅 (战场#07): the 隐匿-like rule and its limit — the enemy it blocks still hits it (review on #185)
    const smog = at('act2autochess_m03', 'g');
    const smogTip = terrainInfo(smog.st, smog.row, smog.col);
    assert.equal(smogTip.name, '排气格栅');
    assert.match(smogTip.lines[0], /不会被敌方的远程攻击选中（效果相当于隐匿）/);
    assert.match(smogTip.lines[1], /挡住敌人的干员仍会被它攻击到/);
    // 深水区 (战场#05): drowning numbers, and 拒绝部署 although the level's own buildableType is ALL (grid.js)
    const sea = at('act1autochess_m05', 'd');
    const seaTip = terrainInfo(sea.st, sea.row, sea.col);
    assert.equal(seaTip.name, '深水区');
    assert.ok(seaTip.lines.some((l) => /每秒受到 40 点伤害/.test(l)));
    assert.ok(seaTip.lines.some((l) => /攻击速度 −60%/.test(l) && /移动速度 ×0.6/.test(l)));
    // …and what that damage IS: sourceless, and not 环境伤害 (devices.js tickDeepsea; review on #185)
    assert.ok(seaTip.lines.some((l) => /无来源伤害/.test(l) && /不归类为环境伤害/.test(l)));
    assert.ok(seaTip.lines.some((l) => /拒绝部署/.test(l)));
    assert.ok(seaTip.facts.includes('不可部署'));
    // the gates and teleports every stage carries (tile_start / tile_end / tile_telin / tile_telout)
    for (const [glyph, name] of [['S', '红门'], ['E', '蓝门'], ['I', '传送入口'], ['O', '传送出口']]) {
      const g = at('act1autochess_m04', glyph);
      const t = terrainInfo(g.st, g.row, g.col);
      assert.equal(t.name, name, glyph);
      assert.ok(t.lines.length >= 1);
    }
  });

  test('an ordinary tile says nothing (the press keeps its other meanings); nonsense input is safe', () => {
    const st = stages['act1autochess_m04'];
    const inf = at('act1autochess_m04', 'i');
    assert.ok(terrainInfo(inf.st, inf.row, inf.col), 'the stage does carry one tile that answers');
    // every non-special glyph the stage uses: the bench, the blocked rows, road / floor, the fence, the separator…
    for (const glyph of ['a', 'A', '#', 'X', 'r', 'f', 'b', 'h', 'p']) {
      let found = null;
      for (let row = 0; row < st.rows.length && !found; row++) {
        const col = st.rows[row].indexOf(glyph);
        if (col >= 0) found = { row, col };
      }
      if (!found) continue;                       // a glyph this stage does not use says nothing to test
      assert.equal(terrainInfo(st, found.row, found.col), null, glyph);
    }
    assert.equal(terrainInfo(inf.st, -1, inf.col), null);
    assert.equal(terrainInfo(inf.st, inf.st.rows.length, 0), null);
    assert.equal(terrainInfo(inf.st, inf.row, 999), null);
    assert.equal(terrainInfo(inf.st, 1.5, 2), null);
    assert.equal(terrainInfo(inf.st, '3', 2), null);
    assert.equal(terrainInfo(null, 0, 0), null);
    assert.equal(terrainInfo(undefined, 0, 0), null);
    assert.equal(terrainInfo({}, 0, 0), null);
    // a stage without the tile legend (or without that glyph) explains nothing rather than guessing
    assert.equal(terrainInfo({ rows: ['i'] }, 0, 0), null);
    assert.equal(terrainInfo({ rows: ['i'], tiles: {} }, 0, 0), null);
    assert.equal(terrainInfo({ rows: ['i'], tiles: { i: null } }, 0, 0), null);
    // …and a legend entry the mode never gave a tip (its own ordinary floor) is not a tip either
    assert.equal(terrainInfo({ rows: ['z'], tiles: { z: { tileKey: 'tile_floor', special: null } } }, 0, 0), null);
  });

  test('the facts come from the tile\'s own legend entry; missing terrain parameters never crash', () => {
    const stage = {
      rows: ['ih'],
      tiles: {
        i: { tileKey: 'tile_infection', height: 'LOW', buildable: 'RANGED', groundPassable: false, special: 'infection' },
        h: { tileKey: 'tile_smog', height: 'HIGH', buildable: 'NONE', groundPassable: false, special: 'smog' },
      },
      special: {},
    };
    assert.deepEqual(terrainInfo(stage, 0, 0).facts, ['仅远程位可部署', '只有空中单位能通过']);
    assert.deepEqual(terrainInfo(stage, 0, 1).facts, ['不可部署', '高台', '只有空中单位能通过']);
    // a stage whose `special` is missing: the mechanism is still explained, just without the stage's numbers
    const bare = { rows: ['ih'], tiles: stage.tiles };
    assert.deepEqual(terrainInfo(bare, 0, 0).lines, ['在其上的我方单位与经过的敌方单位持续受到伤害']);
    assert.deepEqual(terrainInfo(bare, 0, 1).lines, ['站在排气格栅上的干员不会被敌方的远程攻击选中（效果相当于隐匿）', '但挡住敌人的干员仍会被它攻击到']);
    // 沼泽 without its parameters falls back to the official template numbers
    const mire = { rows: ['m'], tiles: { m: { tileKey: 'tile_mire', height: 'LOW', buildable: 'ALL', groundPassable: true, special: 'mire' } } };
    assert.match(terrainInfo(mire, 0, 0).lines[0], /每 1 秒获得 1 层/);
    assert.match(terrainInfo(mire, 0, 0).lines[2], /最多 10 层/);
  });
});

test('bondStripFolded: a phone folds the bond strip at the start of each 休整期 (DESIGN §26.1)', () => {
  assert.equal(bondStripFolded(PHASE.PREP, true), true);
  assert.equal(bondStripFolded(PHASE.COMBAT, true), null, "the fight keeps the player's choice (issue #142)");
  assert.equal(bondStripFolded(PHASE.UNITE, true), null);
  assert.equal(bondStripFolded(PHASE.SETTLE, true), null, "other phases keep the player's choice");
  assert.equal(bondStripFolded(PHASE.PREP, false), null, 'a desktop / tablet never changes it');
  assert.equal(bondStripFolded(PHASE.COMBAT, false), null);
});
