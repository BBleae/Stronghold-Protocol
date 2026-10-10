// Spectator / teammate views (issues #6, #9): the strategy tag beside an avatar that is not the band icon and the boss
// round's leader drawn on the boss field instead of in the pen. (The range of a field unit whose card is open, issue #8,
// is upstream's screens/game/range.js inspectRange since the 0.2.3 merge: test/ui files of upstream cover it.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bandTagShown } from '../../public/js/ui/teamPanel.js';
import { leaderShown, penShown, renderInfo } from '../../public/js/render/app.js';

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

test('renderInfo keeps UnitInfo `area` (a scouted bench / temp operator has no range: screens/game/range.js inspectRange)', () => {
  // the click payload's unit is the render info (pieceClick: infos.get(id) || v.info), not the raw m.field UnitInfo
  const base = { id: 7, uid: 7, side: 'ally', kind: 'op', defId: 'chess_x', x: 2, y: 0, dir: 'RIGHT' };
  assert.equal(renderInfo({ ...base, area: 'hand' }).area, 'hand');
  assert.equal(renderInfo({ ...base, area: 'temp' }).area, 'temp');
  assert.equal(renderInfo(base).area, undefined, 'a battle unit has no area');
});
