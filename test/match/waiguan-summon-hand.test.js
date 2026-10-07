// 外援 summons in the hand (stream C): a placeable summon goes to the hand at its deploy limit — the phase's
// maxDeployCount PLUS the summon's own hidden talent `max_deploy_count` ("TOKEN数+N"; tools/build-data.mjs bakes it
// into the variant `stats.deployLimit`, PRTS 卫戍协议/帮助 "根据召唤物部署数量上限（非初始持有量），发送等量召唤物至
// 手牌区"), of the owner's selected skill and module (GameData.placeableTokens). This is the deploy CAP, not the
// per-battle stock of a consumable summon (REQUIREMENTS §5, content/genericSummons.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameData } from '../../server/match/gamedata.js';
import { resolveLoadout } from '../../shared/protocol.js';
import { DATA } from './harness.js';
import { WG, wgId, noWaiguan } from '../helpers/waiguan.js';

const gd = noWaiguan ? null : new GameData(DATA, 'mode_multi_normal');
if (gd) for (const rec of Object.values(WG)) gd.addChess(rec);
const getChess = (id) => WG[id] ?? DATA.chess[id] ?? null;
/** The loadout a player gets for `chessId` (picks: { skill, module } or none ⇒ the defaults). */
const lo = (chessId, pick = null) => {
  const rec = getChess(chessId);
  return resolveLoadout(pick ? { [rec.baseId || rec.chessId]: pick } : null, rec, getChess);
};
const hand = (chessId, pick = null) => Object.fromEntries(gd.placeableTokens(chessId, lo(chessId, pick)).map((x) => [x.tokenId, x.count]));
const MDC = (v) => Math.max(0, ...(v?.talents || []).map((t) => (typeof t.bb?.max_deploy_count === 'number' ? t.bb.max_deploy_count : 0)));

test('令: three souls of the selected skill\'s kind (1 + max_deploy_count 2); elite with SUM-Y four, without a module three', { skip: noWaiguan }, () => {
  const a = wgId('char_2023_ling'), b = wgId('char_2023_ling', { elite: true });
  assert.deepEqual(hand(a, { skill: 0 }), { token_10020_ling_soul1: 3 });
  assert.deepEqual(hand(a, { skill: 1 }), { token_10020_ling_soul2: 3 });
  assert.deepEqual(hand(a, { skill: 2 }), { token_10020_ling_soul3: 3 }, 'S3: three 弦惊, so the merge can happen');
  const opt = lo(b);
  assert.ok(opt.moduleId, 'the elite has a default module');
  assert.deepEqual(hand(b, { skill: 2, module: opt.moduleId }), { token_10020_ling_soul3: 4 }, 'SUM-Y: "最多同时部署4个"');
  assert.deepEqual(hand(b, { skill: 0, module: 'none' }), { token_10020_ling_soul1: 3 });
});

test('every summon with a hidden max_deploy_count: hand count = the record\'s deploy limit, which holds the bonus', { skip: noWaiguan }, () => {
  const seen = [];
  for (const [tid, t] of Object.entries(DATA.tokens)) {
    if (t.placeable !== true) continue;
    for (const [owner, v] of Object.entries(t.variants || {})) {
      const bonus = MDC(v);
      if (!(bonus > 0) || !getChess(owner)) continue;
      // the skill that makes it (bySkill holds the non-default choices; default sources first)
      const rec = getChess(owner);
      const skills = (rec.skills || []).map((s) => s.index);
      const si = (v.sources || []).some((s) => s === 'talent' || s === 'skill') ? null : skills.find((i) => (v.bySkill?.[i]?.sources || []).includes('skill'));
      const got = hand(owner, si == null ? null : { skill: si });
      assert.equal(got[tid], Math.min(9, v.stats.deployLimit), `${t.name} @${owner}`);
      assert.ok(v.stats.deployLimit >= 1 + bonus, `${t.name} @${owner}: deployLimit ${v.stats.deployLimit} holds max_deploy_count ${bonus}`);
      seen.push(`${tid}@${owner}`);
    }
  }
  // 夜莺 幻影, 麦哲伦's three drones, 令's three souls, 白铁's three piles (tier V + VI, normal + elite)
  assert.ok(seen.length >= 40, `${seen.length} owner variants checked`);
  // pinned (tier VI, normal): 夜莺 3 幻影, 麦哲伦 3 drones, 白铁 2 piles, 望 6 棋子 (max_deploy_count 0: its limit only)
  assert.deepEqual(hand(wgId('char_179_cgbird')), { token_10003_cgbird_bird: 3 });
  assert.deepEqual(hand(wgId('char_248_mgllan'), { skill: 0 }), { token_10005_mgllan_drone1: 3 });
  assert.deepEqual(hand(wgId('char_4072_ironmn'), { skill: 2 }), { token_10027_ironmn_pile3: 2 });
  assert.deepEqual(hand(wgId('char_2027_wang')), { token_10064_wang_stone1: 6 });
  // a module raising it (麦哲伦's module talent restates max_deploy_count 3): the module's own record value
  const mb = wgId('char_248_mgllan', { elite: true });
  const mod = lo(mb).moduleId;
  const v = DATA.tokens.token_10005_mgllan_drone1.variants[mb];
  const want = mod && v.byModule?.[mod] ? v.byModule[mod].stats.deployLimit : v.stats.deployLimit;
  assert.equal(hand(mb, { skill: 0, module: mod })[`token_10005_mgllan_drone1`], Math.min(9, want));
  assert.equal(hand(mb, { skill: 0, module: 'none' }).token_10005_mgllan_drone1, 3);
});

test('pool summoners keep their hand counts (no pool summon has a hidden max_deploy_count)', () => {
  const pool = new GameData(DATA, 'mode_multi_normal');
  for (const [tid, t] of Object.entries(DATA.tokens)) {
    for (const [owner, v] of Object.entries(t.variants || {})) {
      if (!DATA.chess[owner]) continue;
      assert.equal(MDC(v), 0, `${t.name} @${owner}`);
    }
    if (t.placeable !== true) continue;
    for (const owner of Object.keys(t.variants || {}).filter((o) => DATA.chess[o])) {
      const got = pool.placeableTokens(owner).find((x) => x.tokenId === tid);
      if (got) assert.equal(got.count, Math.min(9, t.variants[owner].stats.deployLimit), `${t.name} @${owner}`);
    }
  }
  // 凯瑟琳: 2 of her 3 devices (unchanged)
  assert.equal(pool.placeableTokens('chess_char_4_11_a').find((x) => x.tokenId === 'token_10041_cathy_catsld')?.count, 2);
});
