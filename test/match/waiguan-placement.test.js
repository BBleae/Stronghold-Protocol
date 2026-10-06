// No module widens a 外援's placement (owner's decision 2026-10-06, DESIGN §27 "Placement modules"): PRTS 卫戍协议/帮助
// §战斗部署 — deploy effects do not apply to this mode's placement, "携带Y模组的教官仍无法部署至高台位". Elite 帕拉斯 with
// INS-Y and 艾拉's trap under TRP-D (module texts "可以额外部署在远程位") stay on the ground; only §23.35's 歌蕾蒂娅 HOK-Y does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA } from './harness.js';
import { waiguanRecords } from '../../shared/waiguan.js';
import { meleeOnHighGround } from '../../shared/highGround.js';
import { positionClass } from '../../server/match/board.js';

const REC = waiguanRecords(DATA.waiguan);
const TOK = DATA.tokens.tokens || DATA.tokens;

test('外援 placement: elite 帕拉斯 with INS-Y stays off the 高台 at both tiers', () => {
  for (const tier of [5, 6]) {
    const rec = REC[`chess_char_diy_${tier}_char_485_pallas_b`];
    assert.ok(rec, `tier ${tier} elite 帕拉斯 exists`);
    assert.ok((rec.modules || []).some((m) => m.uniEquipId === 'uniequip_003_pallas'), 'INS-Y is one of her module choices');
    assert.equal(meleeOnHighGround(rec, 'uniequip_003_pallas'), false);
    assert.equal(positionClass(rec, 'uniequip_003_pallas'), 'melee');
  }
});

test('外援 placement: 艾拉\'s trap is a ground piece whatever her module', () => {
  const trap = TOK.token_10033_ela_grzmot;
  assert.ok(trap, 'the trap token exists');
  assert.equal(positionClass(trap, 'uniequip_002_ela'), 'melee');
});
