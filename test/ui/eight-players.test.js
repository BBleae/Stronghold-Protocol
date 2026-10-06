// Rooms of 5–8 players (a remake extension; the official room has 4 seats) — the browser client's part, pure helpers
// and pure views (no browser): seat colours for 8 seats with P1–P4 unchanged (ui/components.js SEAT_HUES / seatHue,
// shared by AvatarFrame and PlayerAvatar), the compact team panel above 4 players (ui/teamPanel.js teamCompact), the
// 机变 draft of up to 10 cards (gameLogic normalizeSp → shared/protocol.js SP_CARDS_MAX; ui/choiceOverlay.js
// spGridLayout: 4 × 2 / 5 × 2 above 6 cards, a dense pick order above 4 players) and its shorter later turns (m.public
// sp.turnSeconds → phaseTotalSeconds), the dense strategy-draft order (screens/bandDraft.js draftOrderDense), the ticker
// queue and the battle cache sized to the room (ui/ticker.js tickerQueueMax, battle/runner.js runnerCacheMax), the
// runner's b.progress maps bounded by RESULT_LIMITS.players, and the Final Assault prep half for P5–P8 (gameLogic
// prepCamera against the server's pairPlayers). With 1–4 players every one of them is what it was.
// The browser layouts at 640×360 / 844×390 / 1920×1080 are test/ui/eight-players.e2e.test.js (SP_E2E=1).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

// the browser data store reads the real data files from disk
globalThis.fetch = async (url) => {
  const name = String(url).split('/').pop();
  try {
    const body = readFileSync(path.join(ROOT, 'data', name), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  } catch {
    return { ok: false, status: 404, json: async () => ({}) };
  }
};

const { MAX_SEATS, PHASE } = await import('../../shared/constants.js');
const { SP_CARDS_MAX, RESULT_LIMITS } = await import('../../shared/protocol.js');
const { SEAT_HUES, seatHue } = await import('../../public/js/ui/components.js');
const { teamCompact, TEAM_FULL_ROWS } = await import('../../public/js/ui/teamPanel.js');
const { normalizeSp, phaseTotalSeconds, prepCamera } = await import('../../public/js/ui/gameLogic.js');
const { ChoiceView, spGridLayout, spOrderDense, cardPickable, SP_GRID_CARDS } = await import('../../public/js/ui/choiceOverlay.js');
const { tickerQueueMax, enqueueTickerLines } = await import('../../public/js/ui/ticker.js');
const { runnerCacheMax } = await import('../../public/js/battle/runner.js');
const { draftOrderDense } = await import('../../public/js/screens/bandDraft.js');
const { progressDense } = await import('../../public/js/ui/combatHud.js');
const { pairPlayers } = await import('../../server/match/finalAssault.js');
const { data } = await import('../../public/js/data.js');

await data.loadAll('items', 'effects', 'choices', 'assets', 'chess', 'bonds');

/** Every vnode of a preact tree (htm output), depth first. */
function* walk(v) {
  if (Array.isArray(v)) { for (const x of v) yield* walk(x); return; }
  if (!v || typeof v !== 'object') return;
  yield v;
  yield* walk(v.props?.children);
}
const hasClass = (v, c) => typeof v?.props?.class === 'string' && v.props.class.split(/\s+/).includes(c);
const byClass = (nodes, c) => nodes.filter((n) => hasClass(n, c));

/** n players p0…p(n−1) in seats 0…n−1. */
const team = (n) => Array.from({ length: n }, (_, i) => ({ playerId: `p${i}`, seat: i, name: `博士${i + 1}`, alive: true }));

describe('seat colours: one hue per seat of the largest room, P1–P4 unchanged', () => {
  test('SEAT_HUES has MAX_SEATS distinct hues and starts with the 4-seat room\'s four', () => {
    assert.equal(SEAT_HUES.length, MAX_SEATS);
    assert.deepEqual(SEAT_HUES.slice(0, 4), [162, 196, 38, 280], 'mint, cyan, amber, violet as in the official room');
    assert.equal(new Set(SEAT_HUES).size, SEAT_HUES.length, 'P5–P8 never repeat a colour');
    // well apart from each other on the wheel (≥ 25°), so two seats never read as one colour
    for (let i = 0; i < SEAT_HUES.length; i++) {
      for (let j = i + 1; j < SEAT_HUES.length; j++) {
        const d = Math.abs(SEAT_HUES[i] - SEAT_HUES[j]);
        assert.ok(Math.min(d, 360 - d) >= 25, `P${i + 1} / P${j + 1}: ${SEAT_HUES[i]}° vs ${SEAT_HUES[j]}°`);
      }
    }
  });
  test('seatHue: seats 0–3 give exactly the old % 4 palette; 4–7 their own hue; missing seat = P1', () => {
    const old = (seat) => [162, 196, 38, 280][((seat | 0) % 4 + 4) % 4];
    for (let s = 0; s < 4; s++) assert.equal(seatHue(s), old(s), `seat ${s}`);
    assert.deepEqual([4, 5, 6, 7].map(seatHue), SEAT_HUES.slice(4));
    for (let s = 4; s < 8; s++) assert.ok(!SEAT_HUES.slice(0, 4).includes(seatHue(s)), `P${s + 1} differs from P1–P4`);
    assert.equal(seatHue(undefined), 162);
    assert.equal(seatHue(null), 162);
    assert.equal(seatHue(8), seatHue(0), 'wraps past the palette');
  });
  test('AvatarFrame and PlayerAvatar share the one palette (no duplicated 4-hue literal)', () => {
    const comp = read('public/js/ui/components.js');
    const game = read('public/js/ui/gameComponents.js');
    assert.match(comp, /const hue = seatHue\(seat\);/);
    assert.match(game, /const hue = seatHue\(player\?\.seat\);/);
    for (const src of [comp, game]) assert.doesNotMatch(src, /\[162, 196, 38, 280\]/, 'the old literal');
  });
});

describe('team panel: compact rows only above 4 players', () => {
  test('teamCompact', () => {
    assert.equal(TEAM_FULL_ROWS, 4);
    for (let n = 0; n <= 4; n++) assert.equal(teamCompact(n), false, `${n} players: the official panel`);
    for (let n = 5; n <= MAX_SEATS; n++) assert.equal(teamCompact(n), true, `${n} players`);
  });
  test('TeamPanel applies it; the CSS exists only under .team--compact; touch areas never cover the next row', () => {
    const src = read('public/js/ui/teamPanel.js');
    assert.match(src, /compact = compact \|\| teamCompact\(players\.length\);/);
    assert.match(src, /class=\$\{cx\('team', compact && 'team--compact'\)\}/);
    const css = read('public/css/screens/game.css');
    assert.match(css, /\.team--compact \.pavatar \{ --pa: \.6rem; \}/);
    assert.match(css, /@media \(max-height: 431\.98px\) \{\s*\.team--compact \{ gap: \.05rem; \}\s*\.team--compact \.pavatar \{ --pa: \.48rem; \}/);
    // 前往查看 / 返回战场 sit beside a compact row (never push the rows below into the corner buttons)
    assert.match(css, /\.team--compact \.team__ob, \.team--compact \.team__back \{\s*position: absolute; left: calc\(100% \+ \.06rem\)/);
    assert.match(read('public/css/devices.css'), /\.sp-coarse \.team--compact \.team__btn::before \{ height: calc\(100% \+ \.05rem\); \}/);
  });
});

describe('机变 draft of a larger room: up to 10 cards, wide grid, dense order', () => {
  test('SP_CARDS_MAX = max(6, MAX_SEATS + 2) — the server\'s most cards (co-op max(6, alive + 2))', () => {
    assert.equal(SP_CARDS_MAX, Math.max(6, MAX_SEATS + 2));
    assert.ok(SP_CARDS_MAX >= 10, '8 players → 10 cards');
  });
  test('normalizeSp keeps every card up to SP_CARDS_MAX (it used to drop the 7th on); picks of cards 7–10 count', () => {
    const cards = Array.from({ length: SP_CARDS_MAX }, (_, i) => ({ itemId: `x${i}` }));
    const players = team(8);
    const sp = normalizeSp({ family: 'supply', cards, order: players.map((p) => p.playerId), turn: 'p7', picks: { p0: 9, p1: 6 } }, players);
    assert.equal(sp.cards.length, SP_CARDS_MAX);
    assert.deepEqual(sp.cards.map((c) => c.idx), [...Array(SP_CARDS_MAX).keys()]);
    assert.equal(sp.cards[9].takenBy, 'p0');
    assert.equal(sp.cards[6].takenBy, 'p1');
    assert.equal(sp.pickOf.get('p0'), 9);
    assert.equal(cardPickable(sp, sp.cards[8], { myId: 'p7', solo: false }), true, 'the 9th card is pickable');
    assert.equal(cardPickable(sp, sp.cards[9], { myId: 'p7', solo: false }), false, 'the 10th is taken');
    // more than the most the server sends: cut there (the server never sends it)
    assert.equal(normalizeSp({ cards: [...cards, { itemId: 'extra' }] }, players).cards.length, SP_CARDS_MAX);
    // the official 6 / solo 3 as before
    assert.equal(normalizeSp({ cards: cards.slice(0, 6) }, players).cards.length, 6);
    assert.equal(normalizeSp({ cards: cards.slice(0, 3) }, players).cards.length, 3);
  });
  test('spGridLayout: solo row of 3, the official 3 × 2 up to 6, then ceil(n / 2) × 2', () => {
    assert.equal(SP_GRID_CARDS, 6);
    for (const n of [0, 1, 2, 3]) assert.deepEqual(spGridLayout(n), { cls: 'spov__grid--3', cols: null }, `${n}`);
    for (const n of [4, 5, 6]) assert.deepEqual(spGridLayout(n), { cls: null, cols: null }, `${n}`);
    assert.deepEqual(spGridLayout(7), { cls: 'spov__grid--wide', cols: 4 });
    assert.deepEqual(spGridLayout(8), { cls: 'spov__grid--wide', cols: 4 });
    assert.deepEqual(spGridLayout(9), { cls: 'spov__grid--wide', cols: 5 });
    assert.deepEqual(spGridLayout(10), { cls: 'spov__grid--wide', cols: 5 });
    for (let n = 0; n <= 4; n++) assert.equal(spOrderDense(n), false);
    for (let n = 5; n <= 8; n++) assert.equal(spOrderDense(n), true);
  });

  const supply = data.list('items').filter((i) => !i.isGolden && i.itemType === 'EQUIP' && !i.shopExcluded).map((i) => ({ itemId: i.id }));
  const view = (n, nCards, picks = {}) => {
    const players = team(n);
    const order = players.map((p) => p.playerId);
    const sp = normalizeSp({ family: 'supply', cards: supply.slice(0, nCards), order, turn: order[Object.keys(picks).length], picks }, players);
    return [...walk(ChoiceView({ pub: { players, deadline: 0 }, sp, myId: 'p1', solo: false }))];
  };
  test('ChoiceView, 4 players / 6 cards: the official markup (no modifier, no style, no tooltips on the order)', () => {
    const nodes = view(4, 6, { p0: 2 });
    const grid = byClass(nodes, 'spov__grid')[0];
    assert.equal(grid.props.class, 'spov__grid');
    assert.equal(grid.props.style, undefined);
    const order = byClass(nodes, 'spov__order')[0];
    assert.equal(order.props.class, 'spov__order');
    assert.ok(byClass(nodes, 'spov__who').every((n) => n.props.title === undefined));
    assert.equal(byClass(nodes, 'spcard').length, 6);
    // solo's row of 3 as before
    const players = team(1);
    const sp = normalizeSp({ family: 'supply', cards: supply.slice(0, 3), order: ['p0'], turn: 'p0', picks: {} }, players);
    const solo = [...walk(ChoiceView({ pub: { players, deadline: 0 }, sp, myId: 'p0', solo: true }))];
    assert.equal(byClass(solo, 'spov__grid')[0].props.class, 'spov__grid spov__grid--3');
  });
  test('ChoiceView, 8 players / 10 cards: a 5 × 2 grid of 10 cards keyed by index, a dense order of 8 with names as tooltips', () => {
    const nodes = view(8, 10, { p0: 9 });
    const grid = byClass(nodes, 'spov__grid')[0];
    assert.equal(grid.props.class, 'spov__grid spov__grid--wide');
    assert.equal(grid.props.style, '--sp-cols:5');
    const cards = byClass(nodes, 'spcard');
    assert.deepEqual(cards.map((c) => c.key), [...Array(10).keys()]);
    assert.ok(hasClass(cards[9], 'is-taken'), 'the 10th card taken by P1');
    assert.ok(hasClass(cards[8], 'is-pickable'), 'P2 (my turn) may pick the 9th');
    const order = byClass(nodes, 'spov__order')[0];
    assert.equal(order.props.class, 'spov__order spov__order--dense');
    const who = byClass(nodes, 'spov__who');
    assert.equal(who.length, 8);
    assert.deepEqual(who.map((w) => w.props.title), team(8).map((p) => p.name));
    // 7 cards (5 players): 4 × 2
    assert.equal(byClass(view(5, 7), 'spov__grid')[0].props.style, '--sp-cols:4');
  });
  test('the wide grid\'s CSS: columns from --sp-cols, the text scrolls in the card, same text size as the 3 × 2 grid', () => {
    const css = read('public/css/screens/game-panels.css');
    assert.match(css, /\.spov__grid--wide \{ grid-template-columns: repeat\(var\(--sp-cols, 5\), minmax\(0, 1fr\)\);/);
    assert.match(css, /\.spov__grid--wide \.spcard__desc \{\s*flex: 1 1 auto; min-height: 0; display: block; overflow-x: hidden; overflow-y: auto;/);
    assert.doesNotMatch(css, /\.spov__grid--wide \.spcard__desc \{[^}]*font-size/, 'never a smaller text than the official cards');
    assert.match(css, /\.spov__order--dense \{ flex-wrap: wrap;/);
  });
  test('a later pick of a larger room lasts what the server says (sp.turnSeconds); 1–4 players keep the config timers', () => {
    const config = { timers: { spFirst: 30, spTurn: 16 } };
    const players = team(4);
    const pub = (sp) => ({ phase: PHASE.SP_DRAFT, players, sp });
    assert.equal(phaseTotalSeconds(pub({ cards: [{}, {}], picks: {} }), config), 30, 'first pick');
    assert.equal(phaseTotalSeconds(pub({ cards: [{}, {}], order: ['p0', 'p1'], picks: { p0: 0 } }), config), 16, 'a later pick');
    assert.equal(phaseTotalSeconds({ phase: PHASE.SP_DRAFT, players: team(8), sp: { cards: [{}, {}], order: ['p0', 'p1'], picks: { p0: 0 }, turnSeconds: 12 } }, config), 12);
    assert.equal(phaseTotalSeconds({ phase: PHASE.SP_DRAFT, players: team(8), sp: { cards: [{}], picks: {}, turnSeconds: 30 } }, config), 30);
    // the strategy draft already reads its turn's length (20 s turns in a room of more than 4 seats)
    assert.equal(phaseTotalSeconds({ phase: PHASE.BAND_DRAFT, draft: { turnSeconds: 20 } }, config), 20);
  });
});

describe('strategy draft, briefing, result, combat HUD: denser blocks only above 4 players', () => {
  test('the teammates\' progress pills are dense for 4–7 teammates only', () => {
    for (let n = 0; n <= 3; n++) assert.equal(progressDense(n), false, `${n} teammates`);
    for (let n = 4; n <= 7; n++) assert.equal(progressDense(n), true, `${n} teammates`);
    assert.match(read('public/css/screens/game.css'), /\.chud__progress--dense \.chud__prog b \{ max-width: \.9rem; \}/);
  });
  test('draftOrderDense; the briefing\'s pips; the result cards\' stagger continues to P8', () => {
    for (let n = 1; n <= 4; n++) assert.equal(draftOrderDense(n), false);
    for (let n = 5; n <= 8; n++) assert.equal(draftOrderDense(n), true);
    assert.match(read('public/js/screens/bandDraft.js'), /class=\$\{cx\('draft-order', draftOrderDense\(solo \? 1 : draft\.order\.length\) && 'draft-order--dense'\)\}/);
    assert.match(read('public/css/screens/draft.css'), /\.draft-order--dense \.dorder \.pavatar \{ --pa: \.46rem; \}/);
    assert.match(read('public/js/screens/briefing.js'), /cx\('brief-ready__pips', players\.length > 4 && 'brief-ready__pips--dense'\)/);
    assert.match(read('public/css/screens/result.css'), /\.rcard:nth-child\(9\) \{ animation-delay: 560ms; \}/);
  });
  test('the room bar: the difficulty labels never wrap; the ready icons are smaller above 4 humans only', () => {
    // 8 humans at 640×360 once squeezed the host's pickers until 标准 / 险境 / 绝境 / 终极 broke onto two lines (the layout
    // itself: test/ui/eight-players.e2e.test.js, SP_E2E=1)
    const css = read('public/css/screens/room.css');
    const opt = css.match(/\n\.dpick__opt \{([^}]*)\}/)[1];
    assert.match(opt, /white-space: nowrap;/);
    assert.match(opt, /flex: none;/);
    assert.match(css, /\.ready-count__icons\.is-many \.icon \{ width: \.2rem; height: \.2rem; \}/);
    assert.match(read('public/js/screens/room.js'), /class=\$\{`ready-count__icons\$\{facts\.humans\.length > DEFAULT_SEATS \? ' is-many' : ''\}`\}/);
  });
});

describe('ticker queue and battle cache sized to the room', () => {
  test('tickerQueueMax: 4 for 1–4 players, one per player above', () => {
    for (const n of [undefined, null, 0, 1, 2, 3, 4]) assert.equal(tickerQueueMax(n), 4, String(n));
    assert.equal(tickerQueueMax(5), 5);
    assert.equal(tickerQueueMax(8), 8);
  });
  test('8 players\' BOSS_HIT milestones of one boss round all keep a place (4 used to drop half of them)', () => {
    let id = 0;
    const lines = team(8).map((p) => ({ id: ++id, type: 'BOSS_HIT', playerId: p.playerId, round: 14, priority: 30, text: `${p.name}博士对敌方领袖造成的伤害超过20%!` }));
    assert.equal(enqueueTickerLines([], null, lines).queue.length, 4, 'the 4-player queue');
    const r = enqueueTickerLines([], null, lines, tickerQueueMax(8));
    assert.deepEqual(r.queue.map((t) => t.playerId), team(8).map((p) => p.playerId));
    assert.match(read('public/js/ui/ticker.js'), /enqueueTickerLines\(queue\.current, cur, fresh, tickerQueueMax\(playerCount\)\)/);
  });
  test('runnerCacheMax: one round of the room (4 for 1–4 players)', () => {
    for (const n of [undefined, 0, 1, 4]) assert.equal(runnerCacheMax(n), 4, String(n));
    assert.equal(runnerCacheMax(6), 6);
    assert.equal(runnerCacheMax(8), 8);
  });
  test('the runner bounds b.progress `by` / `left` by RESULT_LIMITS.players (MAX_SEATS), never a literal 4', () => {
    assert.equal(RESULT_LIMITS.players, MAX_SEATS);
    const src = read('public/js/battle/runner.js');
    assert.doesNotMatch(src, /\.slice\(0, 4\)/);
    assert.match(src, /Object\.keys\(pool\.byPlayer\)\.slice\(0, RESULT_LIMITS\.players\)/);
    assert.match(src, /Object\.entries\(p\.left\)\.slice\(0, RESULT_LIMITS\.players\)/);
  });
});

describe('Final Assault prep of P5–P8: the half of the server\'s seat pairs (b1..b4, an odd last player alone)', () => {
  const pub = (players) => ({ round: 14, bossRound: 14, hiddenRound: 15, players });
  for (const n of [5, 6, 7, 8]) {
    test(`${n} players`, () => {
      const players = team(n).reverse(); // m.public order is not the seat order
      const groups = pairPlayers(players.map((p) => ({ ...p })));
      assert.equal(groups.length, Math.ceil(n / 2));
      for (const g of groups) {
        g.forEach((p, j) => assert.deepEqual(prepCamera(pub(players), p.playerId), { kind: 'bossPrep', opts: { side: j === 1 ? 'R' : 'L' } }, `${p.playerId}`));
      }
      if (n % 2) assert.equal(prepCamera(pub(players), `p${n - 1}`).opts.side, 'L', 'the lone last player: the left half');
    });
  }
  test('an eliminated P3 of 8: the pairs close up like the server\'s', () => {
    const players = team(8).map((p) => (p.seat === 2 ? { ...p, alive: false } : p));
    const groups = pairPlayers(players.filter((p) => p.alive).map((p) => ({ ...p })));
    for (const g of groups) g.forEach((p, j) => assert.equal(prepCamera(pub(players), p.playerId).opts.side, j === 1 ? 'R' : 'L', p.playerId));
    assert.equal(prepCamera(pub(players), 'p7').opts.side, 'L', 'P8 is the lone last player');
  });
});

describe('boss overtime of 5–8 players: the DOT warning follows m.public.overtimeDrainPerSec (floored like the server)', () => {
  test('the server\'s rate when sent, else the config\'s; the running total floored to whole LP', async () => {
    const { overtimeDrainPerSec, overtimeState } = await import('../../public/js/ui/matchStatus.js');
    const { GameData } = await import('../../server/match/gamedata.js');
    const { loadData } = await import('../../server/data.js');
    const config = { bossOvertimeDrainPerSec: 1 };
    assert.equal(overtimeDrainPerSec(config), 1);
    assert.equal(overtimeDrainPerSec(config, { phase: 'FINAL_ASSAULT' }), 1, '1–4 players: no overtimeDrainPerSec, the config holds');
    assert.equal(overtimeDrainPerSec(config, { overtimeDrainPerSec: 1.75 }), 1.75);
    const T0 = 1_000_000;
    const fa = { phase: 'FINAL_ASSAULT', overtimeAt: T0, deadline: T0 - 30_000, overtimeDrainPerSec: 1.25 };
    const gd = new GameData(loadData(), 'mode_multi_normal');
    for (const secs of [0, 1, 2, 3, 4, 5, 9, 37]) {
      const ot = overtimeState(fa, T0 + secs * 1000 + 400, { perSec: overtimeDrainPerSec(config, fa) });
      // the server's drain at the same moment (bossOvertimeDue on the field clock: game s = real s × combatTimeScale)
      const gt = (gd.bossOvertimeAfterReal + secs + 0.4) * gd.combatTimeScale;
      assert.equal(ot.lost, gd.bossOvertimeDue(gt, 5), `${secs} s`);
      assert.equal(ot.perSec, 1.25);
    }
    // 1–4: an integer rate keeps the old product
    assert.deepEqual(overtimeState({ ...fa, overtimeDrainPerSec: undefined }, T0 + 7_400, { perSec: 1 }), { state: 'drain', secs: 7, lost: 7, perSec: 1 });
  });
  test('the per-second "−N" tick shows the whole LP each second really took (5–7 alive), never the fractional rate', async () => {
    const { overtimeDrainPerSec, overtimeState, overtimeTick } = await import('../../public/js/ui/matchStatus.js');
    const { OvertimeWarning } = await import('../../public/js/ui/hud.js');
    const { GameData } = await import('../../server/match/gamedata.js');
    const { loadData } = await import('../../server/data.js');
    const gd = new GameData(loadData(), 'mode_multi_normal');
    const T0 = 1_000_000;
    const tickText = (ot) => {
      const nodes = byClass([...walk(OvertimeWarning({ ot }))], 'otwarn__tick');
      assert.ok(nodes.length <= 1);
      return nodes.length ? [nodes[0].props.children].flat().join('') : null;
    };
    for (const alive of [5, 6, 7, 8]) {
      const fa = { phase: 'FINAL_ASSAULT', overtimeAt: T0, deadline: T0 - 30_000, overtimeDrainPerSec: gd.bossOvertimeDrainFor(alive) };
      const perSec = overtimeDrainPerSec({ bossOvertimeDrainPerSec: 1 }, fa);
      const serverLost = (secs) => gd.bossOvertimeDue((gd.bossOvertimeAfterReal + secs + 0.4) * gd.combatTimeScale, alive);
      for (let secs = 0; secs <= 12; secs++) {
        const ot = overtimeState(fa, T0 + secs * 1000 + 400, { perSec });
        const tick = overtimeTick(ot);
        if (Number.isInteger(perSec)) {
          assert.equal(tick, perSec, `${alive} alive: a whole rate ticks its rate (as 1–4 players)`);
        } else if (secs === 0) {
          assert.equal(tick, null, `${alive} alive: nothing taken yet at second 0`);
        } else {
          assert.equal(tick, serverLost(secs) - serverLost(secs - 1), `${alive} alive, ${secs} s: the server's step`);
          assert.ok(Number.isInteger(tick) && tick >= 1);
        }
        assert.equal(tickText(ot), tick == null ? null : `−${tick}`);
      }
    }
    // 5 alive (1.25 LP/s): 1, 1, 1, 2, … — the LP tower's real drops
    const fa5 = { phase: 'FINAL_ASSAULT', overtimeAt: T0, overtimeDrainPerSec: 1.25 };
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((s) => overtimeTick(overtimeState(fa5, T0 + s * 1000 + 10, { perSec: 1.25 }))), [1, 1, 1, 2, 1, 1, 1, 2]);
    // 1–4 players (the config's whole rate): the tick shows the rate every second, second 0 included, as before
    const fa4 = { phase: 'FINAL_ASSAULT', overtimeAt: T0 };
    for (const [secs, rate] of [[0, 1], [3, 1], [7, 2]]) {
      const ot = overtimeState(fa4, T0 + secs * 1000 + 10, { perSec: rate });
      assert.equal(overtimeTick(ot), rate);
      assert.equal(tickText(ot), `−${rate}`);
    }
    assert.equal(overtimeTick(overtimeState(fa4, T0 - 5_000)), null, 'pending: no tick');
    assert.equal(overtimeTick(null), null);
  });
  test('the HUD passes m.public to overtimeDrainPerSec', () => {
    assert.match(read('public/js/ui/hud.js'), /overtimeDrainPerSec\(config, pub\)/);
  });
});

describe('replays with several 联防 fields: the round\'s 联防 buttons are numbered (screens/replay.js replayBattleLabel)', () => {
  test('联防 1 / 联防 2 only when a round holds more than one 联防 battle', async () => {
    const { replayBattleLabel } = await import('../../public/js/screens/replay.js');
    const battles = [
      { round: 3, kind: 'normal', fieldId: 'n:p_0', players: ['p_0'] },
      { round: 3, kind: 'unite', fieldId: 'u', players: ['p_1', 'p_2'] },
      { round: 3, kind: 'unite', fieldId: 'u2', players: ['p_3'] },
      { round: 4, kind: 'unite', fieldId: 'u', players: ['p_1'] },
      { round: 14, kind: 'boss', fieldId: 'b3', players: ['p_4', 'p_5'] },
    ];
    const name = (id) => id.replace('p_', 'P');
    assert.deepEqual(battles.map((b) => replayBattleLabel(b, battles, name)), [
      '第 3 回合 · P0',
      '第 3 回合 · 联防 1 · P1 / P2',
      '第 3 回合 · 联防 2 · P3',
      '第 4 回合 · P1',
      '第 14 回合 · P4 / P5',
    ]);
  });
});
