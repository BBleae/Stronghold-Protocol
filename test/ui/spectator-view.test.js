// Spectator / teammate views (issues #6, #8, #9): the strategy tag beside an avatar that is not the band icon, the range
// of a field unit whose card is open, and the boss round's leader drawn on the boss field instead of in the pen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitRange } from '../../public/js/ui/facing.js';
import { bandTagShown } from '../../public/js/ui/teamPanel.js';
import { leaderShown, penShown } from '../../public/js/render/app.js';

const GRID = [[0, 0], [0, 1]];
const lookups = {
  getChess: (id) => (id === 'chess_x' ? { chessId: 'chess_x', rangeGrid: GRID } : null),
  getToken: (id) => (id === 'token_x' ? { rangeGrid: [[0, 0]] } : null),
  getItem: () => null,
};

test('unitRange: an ally operator / summon on a tile shows its grid facing its dir', () => {
  assert.deepEqual(unitRange({ side: 'ally', kind: 'op', defId: 'chess_x', x: 3, y: 10, dir: 'UP' }, lookups),
    { grid: GRID, row: 10, col: 3, dir: 'UP' });
  // no dir: the facing decides (legacy UnitInfo)
  assert.equal(unitRange({ side: 'ally', kind: 'op', defId: 'chess_x', x: 3, y: 10, facing: -1 }, lookups).dir, 'LEFT');
  assert.deepEqual(unitRange({ side: 'ally', kind: 'token', defId: 'token_x', x: 1, y: 2, dir: 'RIGHT' }, lookups).grid, [[0, 0]]);
  // board pieces of a scouting board; the bench / temp pieces and enemies have none
  assert.ok(unitRange({ side: 'ally', kind: 'op', defId: 'chess_x', x: 3, y: 10, area: 'board' }, lookups));
  assert.equal(unitRange({ side: 'ally', kind: 'op', defId: 'chess_x', x: 2, y: 7, area: 'hand' }, lookups), null);
  assert.equal(unitRange({ side: 'ally', kind: 'op', defId: 'chess_x', x: 5, y: 8, area: 'temp' }, lookups), null);
  assert.equal(unitRange({ side: 'enemy', kind: 'enemy', defId: 'chess_x', x: 3, y: 10 }, lookups), null);
  assert.equal(unitRange({ side: 'ally', kind: 'op', defId: 'unknown', x: 3, y: 10 }, lookups), null);
  assert.equal(unitRange(null, lookups), null);
});

test('bandTagShown: only when the avatar is not already the band icon', () => {
  assert.equal(bandTagShown({ bandId: 'band_amiya', avatarUrl: 'https://a/1.png' }, null), true);
  assert.equal(bandTagShown({ bandId: 'band_amiya' }, 'https://a/1.png'), true, 'the room seat\'s picture');
  assert.equal(bandTagShown({ bandId: 'band_amiya', isBot: true }, null), true, 'an AI shows its portrait');
  assert.equal(bandTagShown({ bandId: 'band_amiya' }, null), false, 'no picture: the avatar is the band icon');
  assert.equal(bandTagShown({ bandId: null, avatarUrl: 'https://a/1.png' }, null), false, 'no strategy yet');
});

test('the leader is drawn with the boss field cameras, the pen figures only with the pen camera', () => {
  for (const k of ['boss', 'hidden', 'bossPrep']) assert.equal(leaderShown(k), true, k);
  for (const k of ['prep', 'normal', 'unite', 'pen']) assert.equal(leaderShown(k), false, k);
  assert.equal(leaderShown('pen', 'bossPrep'), true, 'kept while the camera flies away');
  assert.equal(penShown('bossPrep'), false);
});
