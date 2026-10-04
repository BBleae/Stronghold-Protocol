// Prep scouting (前往查看 in prep, a public spectator's prep view — Match.prepFieldMeta): the bench and temp operators
// travel with the board (issue #7), and in a boss round the scouted view is the pair's boss field with both halves and
// the leader's spawn tile, never the leader in the pen (issue #9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE, GEO } from '../../shared/constants.js';
import { hasGeneratedData } from '../../server/sim/simdata.js';
import { DATA, makeMatch, legalTileFor } from './harness.js';

const REAL = { skip: !hasGeneratedData() };
const wire = (msg) => JSON.parse(JSON.stringify(msg));
const plain = () => Object.values(DATA.chess).filter((c) => !c.isGolden && c.visible && !c.isHidden && !c.isDiy).map((c) => c.chessId);

function reset(ps) {
  ps.board.clear();
  ps.hand.fill(null);
  ps.temp.fill(null);
}

test('a normal round\'s scouting board carries the bench and temp operators on rows 7 / 8 (items stay out)', REAL, () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 7 }).start();
  const m = h.m;
  h.toPrep(1);
  const p1 = h.ps('p_1');
  reset(p1);
  const [a, b, c] = plain();
  const onBoard = p1.newPiece('chess', a);
  p1.board.set('10,3', onBoard);
  const bench = p1.newPiece('chess', b);
  p1.hand[2] = bench;
  const temp = p1.newPiece('chess', c);
  p1.temp[1] = temp;
  const itemId = Object.keys(DATA.items)[0];
  p1.hand[4] = p1.newPiece('item', itemId);
  assert.equal(m.phase, PHASE.PREP);
  assert.deepEqual(m.handle('p_0', { t: 'g.watch', fieldId: 'n:p_1' }), { ok: true });
  const meta = wire(h.lastTo('p_0', 'm.field'));
  assert.equal(meta.kind, 'normal');
  const by = new Map(meta.units.map((u) => [u.uid, u]));
  assert.equal(by.size, 3, 'board + bench + temp operators, no item');
  assert.deepEqual([by.get(onBoard.uid).area, by.get(onBoard.uid).y, by.get(onBoard.uid).x], ['board', 10, 3]);
  assert.deepEqual([by.get(bench.uid).area, by.get(bench.uid).y, by.get(bench.uid).x, by.get(bench.uid).dir], ['hand', GEO.HAND_ROW, 2, 'RIGHT']);
  assert.deepEqual([by.get(temp.uid).area, by.get(temp.uid).y, by.get(temp.uid).x], ['temp', GEO.TEMP_ROW, GEO.TEMP_C0 + 1]);
});

test('a boss round\'s scouting board is the pair\'s boss field: both halves mapped, the leader at its spawn tile', REAL, () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, seed: 52, fake: true }).start();
  const m = h.m;
  h.drive(() => m.phase === PHASE.PREP && m.round === m.gd.bossRound);
  const p0 = h.ps('p_0');
  const p1 = h.ps('p_1');
  reset(p0);
  reset(p1);
  const [a, b] = plain();
  const left = p0.newPiece('chess', a);
  left.dir = 'RIGHT';
  p0.board.set('11,4', left);
  const right = p1.newPiece('chess', b);
  right.dir = 'RIGHT';
  p1.board.set('10,3', right);
  const bench = p1.newPiece('chess', a);
  p1.hand[1] = bench;

  assert.deepEqual(m.handle('p_0', { t: 'g.watch', fieldId: 'n:p_1' }), { ok: true });
  const meta = wire(h.lastTo('p_0', 'm.field'));
  assert.equal(meta.kind, 'boss');
  assert.equal(meta.prep, true);
  assert.deepEqual(meta.rect, GEO.BOSS_RECT);
  assert.deepEqual(meta.players, ['p_0', 'p_1']);
  assert.deepEqual(meta.sides, { p_0: 'L', p_1: 'R' });
  const by = new Map(meta.units.map((u) => [u.uid, u]));
  // finalAssault.js bossFieldPlacement: rows ≥ 7 shift −7; the right half mirrored col c → 20 − c, RIGHT ↔ LEFT
  assert.deepEqual([by.get(left.uid).y, by.get(left.uid).x, by.get(left.uid).dir, by.get(left.uid).ownerId], [4, 4, 'RIGHT', 'p_0']);
  assert.deepEqual([by.get(right.uid).y, by.get(right.uid).x, by.get(right.uid).dir, by.get(right.uid).ownerId], [3, 17, 'LEFT', 'p_1']);
  assert.deepEqual([by.get(bench.uid).area, by.get(bench.uid).y, by.get(bench.uid).x], ['hand', 0, 19]);

  const leaders = meta.nextEnemies.filter((e) => e.boss);
  assert.equal(leaders.length, 1, 'the leader is listed once');
  assert.ok(Array.isArray(leaders[0].start) && leaders[0].start.length === 2, 'with its spawn tile');
  const [r, c] = leaders[0].start;
  assert.ok(r >= GEO.BOSS_RECT.r0 && r <= GEO.BOSS_RECT.r1 && c >= GEO.BOSS_RECT.c0 && c <= GEO.BOSS_RECT.c1, 'on the boss field');
  assert.ok(meta.nextEnemies.filter((e) => !e.boss).every((e) => !('start' in e)), 'only the leader carries a tile');

  // a change on the other half is a change of this view too (Match._prepScoutSig covers the group)
  const before = h.allTo('p_0', 'm.field').length;
  const [tr, tc] = legalTileFor(m, p0, a, new Set(['11,4']));
  assert.deepEqual(m.handle('p_0', { t: 'g.move', uid: left.uid, to: { area: 'board', row: tr, col: tc }, dir: 'RIGHT' }), { ok: true });
  const views = h.allTo('p_0', 'm.field');
  assert.equal(views.length, before + 1, 'one new view of n:p_1');
  const moved = wire(views.at(-1)).units.find((u) => u.uid === left.uid);
  assert.equal(views.at(-1).fieldId, 'n:p_1');
  assert.deepEqual([moved.y, moved.x], [tr - 7, tc], 'the left half\'s piece where it moved');
});
