// test/sim/generic-talents.test.js — generic talents (server/sim/content/genericTalents.js) of chess without a hand kit.
//
// 1. Derivation: every rule is checked on real talents from data/waiguan.json (外援) and — where the pool has one —
//    data/chess.json (the pool's hand kits never run it: those cases are the shadow test of the text rules), with the
//    numbers the text names taken from the blackboards; negative cases: unknown conditions, stacking texts, hidden
//    module parts and mode-scoped module texts apply nothing.
// 2. Battles (harness, 外援 records injected): the effect shows in the unit's stats / on its hits / on allies and enemies
//    / in the player's DP; loadouts (elite talents, module talent changes, module trait additions) follow the selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, chessRec, checkInvariants, hashOf } from '../helpers/battleHarness.js';
import { getDefaultSource, hasGeneratedData } from '../../server/sim/simdata.js';
import { genericKit } from '../../server/sim/content/generic.js';
import { genericTalentSpecs, genericTalent, talentCoverage, valueIndex } from '../../server/sim/content/genericTalents.js';
import { resultDigest } from '../../server/sim/spec.js';
import { WG, wgId, wgSource, noWaiguan } from '../helpers/waiguan.js';

const skip = (!hasGeneratedData() && 'no generated data') || noWaiguan;
const pool = getDefaultSource();
const wg = wgSource();
const def = (id, lo = null) => (/_diy_/.test(id) ? wg : pool).getChess(id, lo);
const W = (charId, o) => wgId(charId, o);
const approx = (a, b, msg = '', tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg} ${a} ≈ ${b}`);
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e8, speed: 0, ...o });
const HOOKS = ['damaged', 'heal', 'skillStart', 'skillEnd', 'statusApplied', 'attack', 'death', 'deploy', 'kill', 'spGain'];
/** A battle: 外援 records injected, no auto-finish. */
function run(o) {
  const { chess = {}, enemies = {}, tokens = {} } = o.defs || {};
  return makeBattle({ seed: 7, autoFinish: false, timeLimit: 600, hooks: HOOKS, captureNoisy: true, ...o, defs: { chess: { ...WG, ...chess }, enemies, tokens } });
}
const done = (h) => { checkInvariants(h.b); assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0])); };
const gt = (u) => u.buffs.filter((b) => b.key.startsWith('gt:'));
/** Force the generic kit on pool chess `ids` (shadow battles). */
const genericKits = (...ids) => Object.fromEntries(ids.map((id) => [id.replace(/_[ab]$/, '_a'), (bb, c, d) => genericKit(bb, c, d)]));
const tb = (id, i, lo = null) => def(id, lo).talents[i].bb;

// =================================================================================================================
// 1. derivation on real talents

/** [chess id, loadout, source, pattern, label regex] — one or more rows per rule; 外援 and pool. */
const ROWS = [
  // F1 unconditional self stats
  [W('char_010_chen'), null, 'talent1', 'F1.stat', /atkPct":0\.05[\s\S]*defPct":0\.05[\s\S]*dodgePhys":0\.1/],
  [W('char_617_sharp2'), null, 'talent0', 'F1.stat', /dodgeArts":0\.25/],
  [W('char_225_haak'), null, 'talent1', 'F1.stat', /healingTakenMul":1\.2/],
  [W('char_4212_nasti'), null, 'talent1', 'F1.stat', /physTakenMul":0\.9,"artsTakenMul":0\.9/],
  [W('char_4235_thumpy'), null, 'talent0', 'F1.stat', /elemTakenMul":0\.85/],
  [W('char_377_gdglow'), null, 'talent1', 'F1.stat', /resIgnoreFlat":15/],
  [W('char_4009_irene', { elite: true }), null, 'module', 'F1.stat', /defIgnoreFlat":70/],
  ['chess_char_1_02_a', null, 'talent0', 'F1.stat', /resFlat":7/],
  ['chess_char_2_07_a', null, 'talent0', 'F1.stat', /hpPct":0\.1/],
  // F2 conditions
  [W('char_610_acfend'), null, 'talent0', 'F2.cond', /生命<0\.5 \{"defPct":0\.1\}/],
  [W('char_188_helage'), null, 'talent1', 'F2.cond', /未阻挡 \{"hpRegen":60\}/],
  [W('char_609_acguad'), null, 'talent1', 'F2.cond', /停留30s \{"aspd":10\}/],
  [W('char_017_huang'), null, 'talent1', 'F2.cond', /停留15s \{\} 抵抗/],
  [W('char_1029_yato2'), null, 'talent1', 'F2.cond', /技能中\+10s \{"atkPct":0\.13\}/],
  [W('char_608_acpion'), null, 'talent0', 'F2.cond', /第2次技能前 \{"spRecoveryFlat":0\.6\}/],
  [W('char_617_sharp2'), null, 'talent1', 'F2.cond', /范围内≥2敌 \{"aspd":12\}/],
  [W('char_2013_cerber'), null, 'talent1', 'F2.cond', /周围4格无友方/],
  [W('char_615_acspec'), null, 'talent1', 'F2.cond', /周围仅一敌 \{"atkPct":0\.1\}/],
  [W('char_293_thorns'), null, 'talent1', 'F2.cond', /2s未攻击 \{"hpRegenRatio":0\.035\}/],
  [W('char_300_phenxi'), null, 'talent1', 'F2.cond', /技能外 \{"aspd":27\}/],
  [W('char_416_zumama'), null, 'talent1', 'F2.cond', /阻挡 \{"spRecoveryFlat":0\.2\}/],
  ['chess_char_2_03_a', null, 'talent0', 'F2.cond', /未阻挡 \{"atkPct":0\.06,"defPct":0\.06\}/],
  ['chess_char_4_20_a', null, 'talent0', 'F2.cond', /10s未受伤 \{"atkPct":0\.15\}/],
  ['chess_char_2_15_a', null, 'talent0', 'F2.cond', /范围内≥1友方 \{"atkPct":0\.08\}/],
  ['chess_char_5_21_a', null, 'talent0', 'F2.cond', /停留20s \{"atkPct":0\.15\} 抵抗/],
  [W('char_362_saga'), null, 'talent1', 'F2.once', /生命<0\.4 仅一次 \{"dodgePhys":0\.7,"hpRegenRatio":0\.05\} 15s/],
  [W('char_4011_lessng'), null, 'talent1', 'F2.event', /受伤后 \{"atkPct":0\.12\} 15s/],
  [W('char_4037_demetr'), null, 'talent1', 'F2.decay', /闪避 0\.8→0\.4 \/ 20s/],
  ['chess_char_2_10_a', null, 'talent0', 'F2.stayStack', /每停留15s \{"atkPct":0\.02\} ≤3层/],
  ['chess_char_5_11_a', null, 'talent0', 'F2.stayStack', /每停留20s \{"atkPct":0\.05,"defPct":0\.04\} ≤5层/],
  // F3
  [W('char_188_helage'), null, 'talent0', 'F3.tenacity', /aspd≤100 @0\.3/],
  [W('char_1044_hsgma2'), null, 'talent1', 'F3.tenacity', /atkPct≤0\.35 resFlat≤50/],
  ['chess_char_1_18_a', null, 'talent0', 'F3.tenacity', /aspd≤75 @0\.4/],
  [W('char_300_phenxi'), null, 'talent0', 'F3.peak', /精力充沛 >0\.8\/>0\.5/],
  [W('char_300_phenxi'), null, 'talent0', 'F3.drain', /每0\.1s流失0\.005/],
  [W('char_485_pallas'), null, 'talent0', 'F3.peak', /【米诺斯】 >0\.8/],
  // F4 on-hit multipliers
  [W('char_611_acnipe'), null, 'talent0', 'F4.crit', /暴击 0\.25×1\.8/],
  [W('char_340_shwaz'), null, 'talent0', 'F4.crit', /暴击 0\.2×1\.6 \+ debuff 防御力/],
  ['chess_char_1_10_a', null, 'talent0', 'F4.crit', /暴击 0\.1×1\.5 \+ 晕眩0\.5s/],
  [W('char_4027_heyak'), null, 'talent0', 'F4.scale', /攻击空中×1\.2 \+ 特殊能力失效3s/],
  [W('char_4088_hodrer'), null, 'talent0', 'F4.scale', /攻击×1\.1 \/ 晕眩\/束缚×1\.4/],
  [W('char_450_necras'), null, 'talent1', 'F4.scale', /攻击生命<0\.5×1\.4/],
  [W('char_4011_lessng', { elite: true }), null, 'module', 'F4.scale', /攻击被阻挡×1\.15/],
  ['chess_char_3_17_a', null, 'talent0', 'F4.scale', /攻击空中×1\.35/],
  [W('char_197_poca'), null, 'talent0', 'F4.defIgnore', /无视防御0\.6 \(重量≥3\)/],
  [W('char_4009_irene'), null, 'talent0', 'F4.defIgnore', /无视防御0\.5 p0\.5/],
  ['chess_char_6_17_a', null, 'talent1', 'F4.defIgnore', /无视防御0\.2/],
  [W('char_2012_typhon'), null, 'talent0', 'F4.defIgnoreStack', /\+0\.1\/次 ≤0\.5/],
  [W('char_416_zumama'), null, 'talent0', 'F4.dmgMul', /攻击伤害×1\.15/],
  [W('char_2024_chyue'), null, 'talent0', 'F4.mark', /p0\.23 2\.5s 伤害\+0\.6/],
  ['chess_char_6_05_a', null, 'talent0', 'F4.mark', /p1 3s 伤害\+0\.(?:2|19)/],
  [W('char_1502_crosly'), null, 'talent1', 'F4.untouched', /×1\.2/],
  [W('char_2012_typhon'), null, 'talent1', 'F4.firstHit', /首次×1\.6 sluggish3s \(技能中\)/],
  ['chess_char_4_10_a', null, 'talent0', 'F4.firstHit', /首次×1\.1 levitate2\.5s/],
  [W('char_1048_orchd2'), null, 'talent0', 'F4.window', /50次攻击×1\.15/],
  [W('char_4037_demetr'), null, 'talent0', 'F4.execute', /×1→1\.28/],
  [W('char_1051_headb2'), null, 'talent0', 'F4.splashDmg', /溅射伤害×1\.24/],
  [W('char_010_chen', { elite: true }), null, 'module', 'F4.skillDmg', /技能伤害×1\.1/],
  [W('char_1042_phatm2', { elite: true }), null, 'module', 'F4.elementDealt', /元素损伤×1\.18 \(精英\)/],
  [W('char_4204_mantra', { elite: true }), null, 'module', 'F4.vsBurst', /×1\.1/],
  [W('char_4088_hodrer', { elite: true }), { moduleId: 'uniequip_003_hodrer' }, 'module', 'F4.dmgVs', /对被阻挡伤害×1\.1/],
  // F5 extra damage / procs
  [W('char_1029_yato2'), null, 'talent0', 'F5.extra', /额外0\.2攻击力arts/],
  [W('char_4046_ebnhlz'), null, 'talent1', 'F5.extra', /额外0\.15攻击力arts \(周围无他敌\)/],
  [W('char_1015_aglna2'), null, 'talent0', 'F5.extra', /额外0\.25\/0\.35\(重量≤3\)/],
  ['chess_char_6_15_a', null, 'talent0', 'F5.extra', /额外0\.4攻击力arts \(停顿\/束缚\)/],
  [W('char_2013_cerber'), null, 'talent0', 'F5.extraDef', /额外目标防御×0\.4/],
  [W('char_4133_logos'), null, 'talent0', 'F5.extraRandom', /p0\.4 随机目标0\.6攻击力/],
  [W('char_615_acspec'), null, 'talent0', 'F5.double', /p0\.1 二连击/],
  [W('char_1042_phatm2'), null, 'talent0', 'F5.element', /神经损伤 0\.3×攻击力 \+周围0\.2/],
  [W('char_4133_logos', { elite: true }), null, 'module', 'F5.element', /凋亡损伤 0\.08×伤害/],
  [W('char_485_pallas'), null, 'talent1', 'F5.attackHeal', /攻击回复40 \(\+身前\)/],
  [W('char_4117_ray'), null, 'talent1', 'F5.sameTarget', /同目标攻击力\+0\.08×≤3/],
  [W('char_4098_vvana', { elite: true }), null, 'module', 'F5.extraBurst', /灼燃爆发中额外0\.15/],
  // F6 on-hit afflictions
  ['chess_char_1_14_a', null, 'talent0', 'F6.status', /停顿0\.4s/],
  ['chess_char_2_16_a', null, 'talent0', 'F6.status', /特殊能力失效1s/],
  ['chess_char_1_17_a', null, 'talent0', 'F6.status', /束缚4s p0\.12/],
  [W('char_4037_demetr'), null, 'talent0', 'F6.debuff', /防御力-7% 10s ×5/],
  [W('char_4133_logos'), null, 'talent1', 'F6.debuff', /法术抗性-10 5s/],
  [W('char_293_thorns'), null, 'talent0', 'F6.dot', /DoT 125\/s 3s/],
  [W('char_4132_ascln'), null, 'talent0', 'F6.dot', /DoT 0\.1×攻击力\/s 25s ×3 减速0\.18/],
  ['chess_char_1_04_a', null, 'talent0', 'F6.dot', /DoT 40\/s 3s/],
  // F7 ally auras
  [W('char_147_shining'), null, 'talent0', 'F7.auraAlly', /范围内友方 {2}\{"defFlat":60\}/],
  [W('char_147_shining', { elite: true }), null, 'talent0', 'F7.auraAlly', /地面单位[\s\S]*defFlat":40/],
  [W('char_179_cgbird'), null, 'talent0', 'F7.auraAlly', /resFlat":15/],
  [W('char_4229_aphris'), null, 'talent1', 'F7.auraAlly', /resIgnoreFlat":10/],
  [W('char_4088_hodrer'), null, 'talent1', 'F7.auraAlly', /自身\+身后一格/],
  [W('char_614_acsupo'), null, 'talent0', 'F7.auraAlly', /相邻干员 {2}\{"aspd":10\}/],
  [W('char_612_accast'), null, 'talent1', 'F7.auraAlly', /自身\+相邻术师 {2}\{"atkPct":0\.1\}/],
  [W('char_180_amgoat'), null, 'talent0', 'F7.auraAlly', /所有术师 {2}\{"atkPct":0\.14\}/],
  [W('char_112_siege'), null, 'talent0', 'F7.auraAlly', /所有先锋/],
  [W('char_340_shwaz'), null, 'talent1', 'F7.auraAlly', /所有狙击 另有狙击/],
  [W('char_1051_headb2'), null, 'talent1', 'F7.auraAlly', /所有干员 技能中/],
  [W('char_1031_slent2'), null, 'talent0', 'F7.auraAlly', /范围内庇护 0\.1→0\.24/],
  [W('char_1031_slent2'), null, 'talent1', 'F7.auraAlly', /范围内生命<0\.5每秒\+攻击力×0\.05/],
  [W('char_479_sleach'), null, 'talent0', 'F7.auraAlly', /周围8格 {2}\{"aspd":10\}/],
  [W('char_4228_closur'), null, 'talent1', 'F7.team', /罗德岛 {2}\{"atkPct":0\.04\}/],
  [W('char_2014_nian'), null, 'talent0', 'F7.team', /所有重装 {2}\{"hpPct":0\.16\}/],
  [W('char_180_amgoat', { elite: true }), null, 'talent0', 'F7.team', /所有术师/],
  ['chess_char_3_02_a', null, 'talent0', 'F7.auraAlly', /自身\+周围8格 {2}\{"aspd":8\}/],
  ['chess_char_3_03_a', null, 'talent0', 'F7.auraAlly', /周围8格 {2}\{"atkPct":0\.1\}/],
  ['chess_char_1_13_a', null, 'talent0', 'F7.auraAlly', /所有辅助 {2}\{"atkPct":0\.05\}/],
  ['chess_char_2_14_a', null, 'talent0', 'F7.auraAlly', /全体每秒\+攻击力×0\.03/],
  [W('char_4179_monstr'), null, 'talent1', 'F7.onHeal', /\{"aspd":20\} 10s/],
  [W('char_003_kalts', { elite: true }), null, 'module', 'F7.healAmp', /治疗<0\.5×1\.15/],
  [W('char_147_shining', { elite: true }), null, 'module', 'F7.healAmp', /治疗地面×1\.15/],
  // F8 enemy auras
  [W('char_134_ifrit'), null, 'talent0', 'F8.auraEnemy', /范围内敌人 {2}\{"resMul":0\.6\}/],
  [W('char_610_acfend'), null, 'talent1', 'F8.auraEnemy', /阻挡的敌人 {2}\{"aspd":-7\}/],
  [W('char_479_sleach'), null, 'talent0', 'F8.auraEnemy', /周围敌人 {2}\{"aspd":-10\}/],
  [W('char_113_cqbw'), null, 'talent1', 'F8.auraEnemy', /晕眩中受到物理伤害×1\.18/],
  [W('char_4027_heyak'), null, 'talent1', 'F8.auraEnemy', /生命>0\.8的敌人失重/],
  [W('char_1042_phatm2'), null, 'talent1', 'F8.auraEnemy', /神经爆发中的敌人攻击速度-12/],
  [W('char_1042_phatm2'), null, 'talent1', 'F8.attackElement', /受到70神经损伤/],
  [W('char_4132_ascln', { elite: true }), null, 'module', 'F8.auraEnemy', /moveMul":0\.8/],
  ['chess_char_4_02_a', null, 'talent1', 'F8.auraEnemy', /moveMul":0\.85/],
  [W('char_1034_jesca2', { elite: true }), null, 'module', 'F8.reveal', /反隐/],
  ['chess_char_4_22_a', null, 'talent1', 'F8.reveal', /反隐/],
  // F9 SP / DP
  [W('char_134_ifrit'), null, 'talent1', 'F9.periodic', /每6s \+2SP/],
  [W('char_134_ifrit', { elite: true }), null, 'talent1', 'F9.periodic', /\(p0\.3 \+5\)/],
  [W('char_010_chen'), null, 'talent0', 'F9.team', /每4s 全场攻击\/受击技力\+1/],
  [W('char_180_amgoat'), null, 'talent1', 'F9.deploy', /部署 \+7~15SP/],
  [W('char_456_ash'), null, 'talent1', 'F9.event', /部署时 \+17SP/],
  [W('char_112_siege'), null, 'talent1', 'F9.event', /周围敌人倒下 \+1SP/],
  [W('char_613_acmedc'), null, 'talent1', 'F9.event', /范围内友方被击倒 \+5SP/],
  [W('char_113_cqbw', { elite: true }), null, 'talent1', 'F9.event', /击杀时 \+1SP/],
  [W('char_4080_lin'), null, 'talent1', 'F9.hurt', /受击 p0\.5 \+1SP/],
  [W('char_4121_zuole'), null, 'talent1', 'F9.attack', /攻击 p0\.2\/0\.7 \+1SP/],
  [W('char_2024_chyue'), null, 'talent1', 'F9.skillKill', /技能击倒 \+3SP/],
  [W('char_613_acmedc'), null, 'talent0', 'F9.healSp', /治疗时 目标\+3SP/],
  [W('char_180_amgoat', { elite: true }), { moduleId: 'uniequip_003_amgoat' }, 'module', 'F9.hitElite', /普攻命中精英 \+1SP/],
  [W('char_608_acpion'), null, 'talent1', 'F9.dp', /击杀时 \+1DP/],
  [W('char_479_sleach'), null, 'talent1', 'F9.nextDeployCost', /费用-2/],
  [W('char_322_lmlee'), null, 'talent1', 'F9.merchant', /行商付费改为5DP/],
  [W('char_322_lmlee', { elite: true }), { moduleId: 'uniequip_003_lmlee' }, 'module', 'F9.merchantStack', /atkPct":0\.04\} ≤5/],
  [W('char_1029_yato2', { elite: true }), null, 'module', 'F9.retreatRefund', /撤退返还0\.8/],
  // F10 survival
  [W('char_4065_judge'), null, 'talent0', 'F10.shield', /部署时 屏障 0\.5×生命上限[\s\S]*击杀时 屏障 0\.1×生命上限 ≤3/],
  [W('char_4230_mcnist'), null, 'talent1', 'F10.shield', /部署时 屏障 0\.3×生命上限/],
  [W('char_4065_judge'), null, 'talent1', 'F10.shieldCounter', /0\.5攻击力/],
  [W('char_2014_nian'), null, 'talent1', 'F10.layers', /3层护盾/],
  ['chess_char_3_21_a', null, 'talent1', 'F10.layers', /1层护盾/],
  [W('char_2014_nian', { elite: true }), null, 'talent1', 'F10.layerBreak', /护盾破裂时 \{"atkPct":0\.07\}/],
  [W('char_4011_lessng'), null, 'talent0', 'F10.blockGuard', /非阻挡来源伤害×0\.65/],
  [W('char_4065_judge', { elite: true }), null, 'module', 'F10.blockGuard', /阻挡来源伤害×0\.85/],
  [W('char_1048_orchd2'), null, 'talent1', 'F10.redeploy', /再部署时间-15s/],
  ['chess_char_3_05_a', null, 'talent1', 'F10.redeploy', /再部署时间-10s/],
  [W('char_4098_vvana'), null, 'talent1', 'F10.meleeShield', /p0\.18 近战护盾/],
  [W('char_456_ash'), null, 'talent0', 'F10.deployStun', /晕眩 4s/],
  [W('char_1043_leizi2'), null, 'talent1', 'F10.skillStartBurst', /范围内1攻击力 \+tremble2s/],
  [W('char_017_huang'), null, 'talent0', 'F10.onceHeal', /生命<0\.25 仅一次 回复0\.5 \+ 6s生命≥0\.5/],
  [W('char_188_helage', { elite: true }), { moduleId: 'uniequip_003_helage' }, 'module', 'F10.undying', /不屈 回复0\.3/],
  ['chess_char_5_08_a', null, 'talent1', 'F10.undying', /hpPct":-0\.5,"aspd":18,"defPct":0\.18/],
  // no battle effect / module data
  [W('char_456_ash'), null, 'talent1', 'X.firstDeployCost', /无战斗效果/],
  [W('char_179_cgbird', { elite: true }), null, 'module', 'X.moduleRange', /模组攻击范围/],
  [W('char_340_shwaz', { elite: true }), null, 'module', 'X.moduleAttr', /模组属性/],
];

test('derivation: every rule on real talents (外援 + pool), numbers from the blackboards', { skip }, () => {
  for (const [id, lo, src, pattern, re] of ROWS) {
    const d = def(id, lo);
    assert.ok(d, `def ${id}`);
    const c = talentCoverage(d).find((x) => x.source === src);
    assert.ok(c, `${d.name} ${src} has text`);
    const i = c.patterns.indexOf(pattern);
    assert.ok(i >= 0, `${d.name}${d.golden ? '_b' : ''} ${src}: ${pattern} in [${c.patterns}] (${c.text})`);
    assert.match(c.labels.join(' | '), re, `${d.name} ${src} ${pattern}`);
  }
});

test('derivation: the rule list is covered by the table', { skip }, () => {
  const seen = new Set(ROWS.map((r) => r[3]));
  for (const p of ['F1.stat', 'F2.cond', 'F2.once', 'F2.event', 'F2.decay', 'F2.stayStack', 'F3.tenacity', 'F3.peak', 'F3.drain', 'F4.crit', 'F4.scale',
    'F4.defIgnore', 'F4.defIgnoreStack', 'F4.dmgMul', 'F4.mark', 'F4.untouched', 'F4.firstHit', 'F4.window', 'F4.execute', 'F4.splashDmg', 'F4.skillDmg',
    'F4.elementDealt', 'F4.vsBurst', 'F4.dmgVs', 'F5.extra', 'F5.extraDef', 'F5.extraRandom', 'F5.double', 'F5.element', 'F5.attackHeal', 'F5.sameTarget',
    'F5.extraBurst', 'F6.status', 'F6.debuff', 'F6.dot', 'F7.auraAlly', 'F7.team', 'F7.onHeal', 'F7.healAmp', 'F8.auraEnemy', 'F8.attackElement',
    'F8.reveal', 'F9.periodic', 'F9.team', 'F9.deploy', 'F9.event', 'F9.hurt', 'F9.attack', 'F9.skillKill', 'F9.healSp', 'F9.hitElite', 'F9.dp',
    'F9.nextDeployCost', 'F9.merchant', 'F9.merchantStack', 'F9.retreatRefund', 'F10.shield', 'F10.shieldCounter', 'F10.layers', 'F10.layerBreak',
    'F10.blockGuard', 'F10.redeploy', 'F10.meleeShield', 'F10.deployStun', 'F10.skillStartBurst', 'F10.onceHeal', 'F10.undying', 'X.firstDeployCost',
    'X.moduleRange', 'X.moduleAttr']) assert.ok(seen.has(p), p);
});

test('derivation: unknown conditions, stacking texts, unmodelled resources and summon subjects apply nothing', { skip }, () => {
  const none = (id, src, lo = null, why = null) => {
    const c = talentCoverage(def(id, lo)).find((x) => x.source === src);
    assert.ok(c, `${id} ${src}`);
    assert.deepEqual(c.patterns, [], `${def(id).name} ${src}: ${c.labels} (${c.text})`);
    if (why) assert.ok(c.dropped.some((d) => why.test(d.reason)), `${def(id).name}: ${JSON.stringify(c.dropped)}`);
  };
  none('chess_char_4_01_a', 'talent0', null, /stacked/);              // 信仰搅拌机 每次造成伤害…最多可叠加3层
  none('chess_char_4_14_a', 'talent0');                               // 莱恩哈特 攻击范围内每有一个敌人…
  none('chess_char_5_22_a', 'talent1', null, /stacked/);              // 妮芙 每当…最多可叠加10层
  none('chess_char_4_16_a', 'talent1', null, /unknown condition/);    // 缄默德克萨斯 每次部署后击倒一名敌人之前
  none(W('char_4141_marcil'), 'talent0', null, /unknown condition|not modelled/); // 玛露西尔 有魔力时，攻击力+20%
  none(W('char_4046_ebnhlz', { elite: true }), 'module', { moduleId: 'uniequip_003_ebnhlz' }, /not modelled|unknown/); // 拥有已储存的攻击能量时
  none(W('char_4009_irene', { elite: true }), 'module', { moduleId: 'uniequip_004_irene' }, /unknown condition/); // 在集成战略中 (owner rule 7)
  none(W('char_003_kalts'), 'talent1', null, /summon subject/);       // Mon3tr 被击倒后… (content/tokens.js)
  none(W('char_179_cgbird'), 'talent1', null, /summon subject/);       // 幻影…更容易吸引敌人的攻击 is the phantom's, not 夜莺's
  // the condition-free part of a sentence still applies, the governed part not (阿斯卡纶: 高台)
  const asc = talentCoverage(def(W('char_4132_ascln'))).find((x) => x.source === 'talent1');
  assert.deepEqual(asc.patterns, ['F1.stat']);
  assert.match(asc.labels[0], /"aspd":8\}/);
});

test('derivation: hidden module parts are never applied on their own (焰狐龙梓兰 −15 s once, 重岳 sp 1 not added)', { skip }, () => {
  const z = def(W('char_1048_orchd2'));
  assert.ok(z.talents.some((t) => !t.description && t.bb.respawn_time === -15), 'the data has the hidden −15 part');
  const specs = genericTalentSpecs(z).filter((s) => s.pattern === 'F10.redeploy');
  assert.equal(specs.length, 1);
  const zb = def(W('char_2024_chyue', { elite: true }));
  assert.ok(zb.talents.some((t) => !t.description && t.bb.sp === 1));
  const sk = talentCoverage(zb).find((c) => c.source === 'talent1');
  assert.match(sk.labels.join(), /\+4SP \/ 否则\+1/);
  assert.equal(talentCoverage(zb).length, 2, 'no source for the text-less part');
});

test('derivation: magnitudes come from the blackboard (rounded text: 嵯峨 elite 6 % = 0.065)', { skip }, () => {
  const V = valueIndex([{ hp_recovery_per_sec_by_max_hp_ratio: 0.065, prob: 0.7 }]);
  assert.equal(V.pct(6), 0.065);
  assert.equal(V.pct(70), 0.7);
  assert.equal(V.pct(42), undefined);
  assert.equal(valueIndex([{ heal_scale: 1.2 }]).pct(20), 0.2, 'a multiplier key (|v − 1|, no float noise)');
  const c = talentCoverage(def(W('char_362_saga', { elite: true }))).find((x) => x.source === 'talent1');
  assert.match(c.labels[0], /hpRegenRatio":0\.065/);
});

test('loadout: elite talents, module talent changes and module trait additions follow the selection', { skip }, () => {
  const id = W('char_010_chen', { elite: true });
  const lab = (lo, src) => talentCoverage(def(id, lo)).find((c) => c.source === src)?.labels.join(' | ') ?? '';
  assert.match(lab(null, 'talent0'), /每3s .* 自身\+1/, 'elite talent');
  assert.match(lab(null, 'module'), /技能伤害×1\.1/, 'default module trait');
  assert.match(lab({ moduleId: 'uniequip_003_chen' }, 'talent1'), /atkPct":0\.15/, 'module talent change');
  assert.match(lab({ moduleId: 'uniequip_003_chen' }, 'module'), /defIgnoreFlat":70/, 'other module trait');
  assert.equal(lab({ moduleId: 'none' }, 'module'), '', 'no module: no trait addition');
  assert.match(lab({ moduleId: 'none' }, 'talent0'), /每4s/, 'no module: base talent');
  // genericTalent(def, i) = one talent's specs (for hand kits)
  assert.deepEqual(genericTalent(def(id), 1).map((s) => s.pattern), ['F1.stat', 'F1.stat', 'F1.stat']);
});

// =================================================================================================================
// 2. battles

test('F1 battle: 陈 ATK/DEF +5 %, 10 % physical dodge in the stats; pool 角峰 with the generic kit = its hand kit RES', { skip }, () => {
  const id = W('char_010_chen');
  const h = run({ units: [{ chessId: id, row: 10, col: 4, uid: 1 }] });
  h.step(2);
  const u = h.unit(1), t = tb(id, 1);
  approx(u.s.atk, u.base.atk * (1 + t.atk), 'ATK');
  approx(u.s.def, u.base.def * (1 + t.def), 'DEF');
  approx(u.s.dodgePhys, t.prob, 'dodge');
  done(h);
  const jf = 'chess_char_1_02_a';
  const a = run({ units: [{ chessId: jf, row: 10, col: 4, uid: 1 }] }).step(2);
  const b = run({ units: [{ chessId: jf, row: 10, col: 4, uid: 1 }], kits: genericKits(jf) }).step(2);
  approx(b.unit(1).s.res, a.unit(1).s.res, 'generic 角峰 RES = hand kit RES');
  assert.ok(gt(b.unit(1)).length === 1 && gt(a.unit(1)).length === 0, 'the hand kit never runs the generic talent');
});

test('F2 battle: Mechanist DEF +10 % extra below 50 % HP (toggles back); Sharp ASPD +10 only after 30 s on the field', { skip }, () => {
  const id = W('char_610_acfend');
  const h = run({ units: [{ chessId: id, row: 10, col: 4, uid: 1 }] });
  h.step(2);
  const u = h.unit(1), t = tb(id, 0);
  approx(u.s.def, u.base.def * (1 + t.def), 'healthy');
  u.hp = u.s.maxHp * 0.4;
  h.step(2);
  approx(u.s.def, u.base.def * (1 + t.def + t['acfend_t_1[extra].def']), 'below 50 %');
  u.hp = u.s.maxHp * 0.9;
  h.step(2);
  approx(u.s.def, u.base.def * (1 + t.def), 'healthy again');
  done(h);
  const s = W('char_609_acguad'), ts = tb(s, 1);
  const h2 = run({ units: [{ chessId: s, row: 10, col: 4, uid: 1 }] });
  h2.run(ts.interval - 1);
  assert.equal(h2.unit(1).s.aspd, h2.unit(1).base.aspd);
  h2.run(2);
  assert.equal(h2.unit(1).s.aspd, h2.unit(1).base.aspd + ts.attack_speed);
  done(h2);
});

test('F2 battle: 麒麟R夜刀 ATK +13 % during a skill and 10 s after; 郁金香 SP regen +0.6/s until its 2nd skill', { skip }, () => {
  // 麒麟R夜刀's own skills are all passive (always "in skill" for the generic spec): her real talent on a carrier with a
  // 10 s duration skill (SP 8, none at the start) shows the window
  const id = W('char_1029_yato2'), t = tb(id, 1);
  const carrier = chessRec({ id: 'gt_window_a', stats: { atk: 500 }, talents: [{ index: 1, name: 'x', desc: def(id).talents[1].description, bb: t }],
    skill: { skillId: 'sk_w', duration: 10, spCost: 8, initSp: 0, spType: 'INCREASE_WITH_TIME', bb: {} } });
  const h = run({ defs: { chess: { gt_window_a: carrier }, enemies: { e: dummy('e') } }, units: [{ chessId: 'gt_window_a', row: 10, col: 4, uid: 1 }], enemies: [{ key: 'e', pos: [10, 5] }] });
  const u = h.unit(1);
  const on = () => gt(u).length > 0;
  h.step(1);
  assert.ok(!on(), 'not before the skill');
  assert.ok(h.runUntil(() => u.skill.active, 30), 'skill');
  h.step(1);
  assert.ok(on(), 'during the skill');
  approx(u.s.atk, u.base.atk * (1 + t.atk), 'ATK +13 %');
  assert.ok(h.runUntil(() => !u.skill.active, 30));
  h.run(t.duration - 1);
  assert.ok(on(), 'within 10 s after');
  h.run(2);
  assert.ok(!on() || u.skill.active, 'gone 10 s after (unless the skill came back)');
  done(h);
  const tu = W('char_608_acpion'), tt = tb(tu, 0);
  const h2 = run({ defs: { enemies: { e: dummy('e') } }, units: [{ chessId: tu, row: 10, col: 4, uid: 1 }], enemies: [{ key: 'e', pos: [10, 5] }] });
  const v = h2.unit(1);
  h2.step(2);
  approx(v.s.spRecovery, v.base.spRecovery + tt.sp_recovery_per_sec, 'bonus before any skill');
  assert.ok(h2.runUntil(() => v.skill.activations >= tt.cnt, 120), 'second activation');
  h2.step(2);
  approx(v.s.spRecovery, v.base.spRecovery, 'no bonus after the 2nd activation');
  done(h2);
});

test('F2 battle: 嵯峨 below 40 % HP once per deployment: 70 % dodge + 5 %/s for 15 s; 止颂 ATK +12 % for 15 s after a hit', { skip }, () => {
  const id = W('char_362_saga'), t = tb(id, 1);
  const h = run({ units: [{ chessId: id, row: 10, col: 4, uid: 1 }] });
  h.step(2);
  const u = h.unit(1);
  h.b.loseHp(u, u.s.maxHp * 0.65, { source: null });
  h.step(1);
  approx(u.s.dodgePhys, t.prob, 'dodge');
  approx(u.s.hpRegen, u.base.hpRecoveryPerSec + t.hp_recovery_per_sec_by_max_hp_ratio * u.s.maxHp, 'regen');
  h.run(t.duration + 0.5);
  approx(u.s.dodgePhys, 0, 'expired');
  h.b.loseHp(u, u.hp * 0.9, { source: null });
  h.step(2);
  approx(u.s.dodgePhys, 0, 'only once per deployment');
  done(h);
  const z = W('char_4011_lessng'), tz = tb(z, 1);
  const h2 = run({ defs: { enemies: { e: dummy('e', { atk: 300, bat: 1 }) } }, units: [{ chessId: z, row: 10, col: 4, uid: 1 }], enemies: [{ key: 'e', pos: [10, 4] }] });
  const v = h2.unit(1);
  assert.ok(h2.runUntil(() => gt(v).some((b) => b.key.includes(':t1:')), 20), 'buff after a hit');
  approx(v.s.atk, v.base.atk * (1 + tz.atk), 'ATK');
  done(h2);
});

test('F2 battle: 贝洛内 dodge 80 % at deployment decaying to 40 % in 20 s; pool 洛洛 (generic) +2 % ATK per 15 s, ≤3', { skip }, () => {
  const id = W('char_4037_demetr'), t = tb(id, 1);
  const h = run({ units: [{ chessId: id, row: 10, col: 4, uid: 1 }] });
  h.step(1);
  const u = h.unit(1);
  approx(u.s.dodgePhys, t.init_prob, 'start', 0.01);
  h.run(10);
  approx(u.s.dodgePhys, t.init_prob - 10 * t.dec_prob, 'half way', 0.02);
  h.run(15);
  approx(u.s.dodgeArts, t.init_prob - t.trig_cnt * t.dec_prob, 'rest', 1e-6);
  done(h);
  const ll = 'chess_char_2_10_a', tl = tb(ll, 0);
  const h2 = run({ units: [{ chessId: ll, row: 10, col: 4, uid: 1 }], kits: genericKits(ll) });
  const v = h2.unit(1);
  h2.run(tl.interval + 0.2);
  approx(v.s.atk, v.base.atk * (1 + tl.atk), '1 stack');
  h2.run(tl.interval * 5);
  approx(v.s.atk, v.base.atk * (1 + tl.atk * tl.max_stack_cnt), 'capped');
  done(h2);
});

test('F3 battle: 赫拉格 坚忍 ASPD 0 / half / full at 100 / 65 / 30 % HP; 菲亚梅塔 drains (non-lethal) and peaks', { skip }, () => {
  const id = W('char_188_helage'), t = tb(id, 0);
  const h = run({ units: [{ chessId: id, row: 10, col: 4, uid: 1 }] });
  h.step(2);
  const u = h.unit(1);
  approx(u.s.aspd, u.base.aspd, 'full HP');
  u.hp = u.s.maxHp * (1 - (1 - t.min_hp_ratio) / 2);
  h.step(1);
  approx(u.s.aspd, u.base.aspd + t.min_attack_speed / 2, 'half way', 1e-3);
  u.hp = u.s.maxHp * t.min_hp_ratio;
  h.step(1);
  approx(u.s.aspd, u.base.aspd + t.min_attack_speed, 'max', 1e-3);
  done(h);
  const f = W('char_300_phenxi'), tf = tb(f, 0);
  const h2 = run({ units: [{ chessId: f, row: 10, col: 4, uid: 1 }] });
  h2.step(2);
  const v = h2.unit(1);
  approx(v.s.atk, v.base.atk * (1 + tf['phenxi_t_1[peak_2].peak_performance.atk']), 'top tier above 80 %');
  const r0 = v.hpRatio;
  h2.run(2);
  approx(r0 - v.hpRatio, 2 * tf.hp_ratio / tf.interval, 'drain 5 %/s', 0.02);
  v.hp = v.s.maxHp * 0.6;
  h2.step(1);
  approx(v.s.atk, v.base.atk * (1 + tf['phenxi_t_1[peak_1].peak_performance.atk']), 'lower tier');
  v.hp = v.s.maxHp * 0.4;
  h2.step(1);
  approx(v.s.atk, v.base.atk, 'no 精力充沛 below 50 %');
  h2.run(60);
  assert.ok(v.alive && v.hp >= 1, 'the drain never kills');
  done(h2);
});

test('F4 battle: Stormeye crits ×1.8 at its rate; one roll per attack; 黑 crits lower DEF −20 % for 5 s only on crits', { skip }, () => {
  const id = W('char_611_acnipe'), t = tb(id, 0);
  const h = run({ defs: { enemies: { e: dummy('e', { motion: 'WALK' }) } }, units: [{ chessId: id, row: 10, col: 4, uid: 1 }], enemies: [{ key: 'e', pos: [10, 6] }], content: 'full' });
  const u = h.unit(1);
  h.run(120);
  const hits = h.hooksOf('damaged').filter((c) => c.source === u && c.dmg.isAttack && !c.dmg.isSkill);
  const atk = u.s.atk;
  const crit = hits.filter((c) => c.amount > atk * 1.5).length;
  assert.ok(hits.length > 50, `${hits.length} hits`);
  assert.ok(Math.abs(crit / hits.length - t.prob) < 0.12, `crit rate ${crit}/${hits.length}`);
  done(h);
  // a splash carrier of the real 黑 talent: every victim of one attack crits together, riders only on crits
  const black = W('char_340_shwaz'), tbk = tb(black, 0);
  const carrier = chessRec({ id: 'gt_splash_a', profession: 'CASTER', subProfessionId: 'splashcaster', dmgType: 'MAGIC', stats: { atk: 400 }, rangeGrid: [[0, 0], [0, 1], [0, 2], [0, 3]],
    talents: [{ index: 0, name: 'x', desc: def(black).talents[0].description, bb: tbk }], skill: null });
  const h2 = run({ defs: { chess: { gt_splash_a: carrier }, enemies: { e: dummy('e') } }, units: [{ chessId: 'gt_splash_a', row: 10, col: 4, uid: 1 }], enemies: [{ key: 'e', pos: [10, 6] }, { key: 'e', pos: [10, 6] }, { key: 'e', pos: [10, 6] }] });
  const c = h2.unit(1);
  h2.run(60);
  const byAtk = new Map();
  for (const x of h2.hooksOf('damaged').filter((d) => d.source === c && d.dmg.isAttack)) {
    const l = byAtk.get(x.dmg.attackId) ?? [];
    l.push(x.amount > 400 * 1.3 ? 1 : 0);
    byAtk.set(x.dmg.attackId, l);
  }
  const mixed = [...byAtk.values()].filter((l) => l.length > 1 && new Set(l).size > 1);
  assert.equal(mixed.length, 0, 'an attack crits on all its victims or on none');
  assert.ok([...byAtk.values()].some((l) => l[0] === 1), 'some crits');
  const debuffs = h2.b.enemies.map((e) => e.buffs.find((b) => b.key.startsWith('gt:') && b.mods?.defPct)).filter(Boolean);
  for (const b of debuffs) approx(b.mods.defPct, tbk.def, 'DEF −20 %');
  done(h2);
});

test('F4 battle: 霍尔海雅 ATK ×1.2 + 3 s silence vs flyers only; 早露 ignores 60 % DEF of weight ≥ 3 only', { skip }, () => {
  const id = W('char_4027_heyak'), t = tb(id, 0);
  const h = run({
    defs: { enemies: { air: dummy('air', { motion: 'FLY', res: 0 }), gnd: dummy('gnd', { res: 0 }) } },
    units: [{ chessId: id, row: 10, col: 4, uid: 1 }], enemies: [{ key: 'air', pos: [10, 6], route: 2 }],
  });
  const u = h.unit(1);
  h.run(15);
  const air = h.hooksOf('damaged').filter((c) => c.source === u && c.dmg.isAttack && !c.dmg.isSkill && c.target.isFlying);
  assert.ok(air.length > 0, 'hits on the flyer');
  approx(air[0].amount, u.s.atk * t.atk_scale, 'ATK ×1.2 (RES 0)', 1e-3);
  assert.ok(h.hooksOf('statusApplied').some((c) => c.source === u && c.status === 'silence' && Math.abs(c.duration - t.silence) < 1e-6), 'silence 3 s');
  done(h);
  const p = W('char_197_poca'), tp = tb(p, 0);
  const h2 = run({
    defs: { enemies: { hv: dummy('hv', { def: 500, mass: 3 }), lt: dummy('lt', { def: 500, mass: 1 }) } },
    units: [{ chessId: p, row: 10, col: 3, uid: 1 }], enemies: [{ key: 'hv', pos: [10, 6] }],
  });
  const v = h2.unit(1);
  h2.run(20);
  const hv = h2.hooksOf('damaged').find((c) => c.source === v && c.dmg.isAttack && !c.dmg.isSkill && c.dmg.defIgnorePct > 0);
  assert.ok(hv, 'DEF ignored on the heavy target');
  approx(hv.dmg.defIgnorePct, tp.def_penetrate, 'ignore 60 %');
  done(h2);
});

test('F5 battle: 麒麟R夜刀 +20 % ATK arts per hit; 刻俄柏 +40 % of the target DEF; Misery double attack never recurses', { skip }, () => {
  const id = W('char_1029_yato2'), t = tb(id, 0);
  const h = run({ defs: { enemies: { e: dummy('e', { res: 0, def: 0 }) } }, units: [{ chessId: id, row: 10, col: 4, uid: 1 }], enemies: [{ key: 'e', pos: [10, 5] }] });
  const u = h.unit(1);
  h.run(10);
  const ex = h.hooksOf('damaged').filter((c) => c.source === u && (c.dmg.tags || []).includes('extra'));
  assert.ok(ex.length > 0 && ex.every((c) => c.type === 'arts'), 'extra arts damage');
  approx(ex[0].amount, u.s.atk * t['attack@atk_scale_1'], 'amount', 1e-3);
  done(h);
  const c = W('char_2013_cerber'), tc = tb(c, 0);
  const h2 = run({ defs: { enemies: { e: dummy('e', { res: 0, def: 400 }) } }, units: [{ chessId: c, row: 10, col: 3, uid: 1 }], enemies: [{ key: 'e', pos: [10, 5] }] });
  const v = h2.unit(1);
  h2.run(10);
  const ex2 = h2.hooksOf('damaged').filter((x) => x.source === v && (x.dmg.tags || []).includes('extra'));
  assert.ok(ex2.length > 0);
  approx(ex2[0].amount, 400 * tc.atk_scale, 'DEF × 40 %', 1e-3);
  done(h2);
  const m = W('char_615_acspec'), tm = tb(m, 0);
  const h3 = run({ defs: { enemies: { e: dummy('e') } }, units: [{ chessId: m, row: 10, col: 4, uid: 1 }], enemies: [{ key: 'e', pos: [10, 5] }], seed: 3 });
  const w = h3.unit(1);
  h3.run(200);
  const atks = h3.hooksOf('attack').filter((x) => x.attacker === w && !x.isSkill).length;
  const ids = new Set(h3.hooksOf('damaged').filter((x) => x.source === w && x.dmg.isAttack).map((x) => x.dmg.attackId));
  assert.ok(atks > 100, `${atks} attacks`);
  // without the talent there would be ~atks / (1 + p) attacks of its own; the extra ones are ≈ p of those
  const extra = atks - Math.round(atks / (1 + tm['attack@prob']));
  assert.ok(extra > 0 && ids.size === atks, `attacks ${atks}, distinct ids ${ids.size}`);
  done(h3);
});

test('F5/F6 battle: 酒神 neural on the target + splash; 棘刺 poison 125/s, doubled vs ranged; 贝洛内 DEF −7 % stacks to 5', { skip }, () => {
  const id = W('char_1042_phatm2'), t = tb(id, 0);
  const h = run({ defs: { enemies: { e: dummy('e') } }, units: [{ chessId: id, row: 10, col: 4, uid: 1 }], enemies: [{ key: 'e', pos: [10, 6] }, { key: 'e', pos: [11, 6] }] });
  h.run(6);
  const [a, b] = h.b.enemies;
  assert.ok(a.elem.neural > 0 && b.elem.neural > 0, `neural ${a.elem.neural} / ${b.elem.neural}`);
  done(h);
  const th = W('char_293_thorns'), tt = tb(th, 0);
  const h2 = run({ defs: { enemies: { m: dummy('m', { res: 0 }), r: dummy('r', { res: 0, range: 2 }) } }, units: [{ chessId: th, row: 10, col: 4, uid: 1 }], enemies: [{ key: 'm', pos: [10, 5] }] });
  const v = h2.unit(1);
  h2.run(8);
  const dots = h2.hooksOf('damaged').filter((c) => c.source === v && (c.dmg.tags || []).includes('dot'));
  assert.ok(dots.length > 0 && dots.every((c) => c.type === 'arts'));
  approx(dots[0].amount, tt['damage[normal]'], 'melee target');
  done(h2);
  const h3 = run({ defs: { enemies: { r: dummy('r', { res: 0, range: 2 }) } }, units: [{ chessId: th, row: 10, col: 4, uid: 1 }], enemies: [{ key: 'r', pos: [10, 5] }] });
  h3.run(8);
  const d3 = h3.hooksOf('damaged').filter((c) => c.source === h3.unit(1) && (c.dmg.tags || []).includes('dot'));
  approx(d3[0].amount, tt['damage[ranged]'], 'ranged target');
  const be = W('char_4037_demetr'), tbb = tb(be, 0);
  const h4 = run({ defs: { enemies: { e: dummy('e', { def: 1000 }) } }, units: [{ chessId: be, row: 10, col: 4, uid: 1 }], enemies: [{ key: 'e', pos: [10, 5] }] });
  h4.run(20);
  const e = h4.b.enemies[0], db = e.buffs.find((x) => x.key.startsWith('gt:') && x.mods?.defPct);
  assert.ok(db, 'DEF debuff');
  assert.equal(db.stacks, tbb['attack@limited_stack_cnt']);
  approx(e.s.def, 1000 * (1 + tbb['attack@def'] * tbb['attack@limited_stack_cnt']), 'DEF');
  done(h4);
});

test('F7 battle: 闪灵 DEF +60 to allies in range only, gone ≤ 0.6 s after she leaves; 年 HP +16 % to every 重装 of the team', { skip }, () => {
  const id = W('char_147_shining'), t = tb(id, 0);
  const tank = 'chess_char_3_16_a', guard = 'chess_char_2_03_a', plain = 'chess_char_1_02_a';
  const h = run({ units: [{ chessId: id, row: 10, col: 4, uid: 1 }, { chessId: plain, row: 10, col: 5, uid: 2 }, { chessId: guard, row: 12, col: 9, uid: 3 }] });
  h.step(3);
  const [s, a, far] = [h.unit(1), h.unit(2), h.unit(3)];
  assert.ok(a.findBuff(gt(a)[0]?.key), 'in range');
  assert.equal(gt(far).length, 0, 'out of range');
  const defIn = a.s.def;
  h.b.retreat(s, { reason: 'retreat' });
  h.run(0.7);
  assert.equal(gt(a).length, 0, 'aura gone');
  approx(defIn - a.s.def, t.def, 'DEF +60 (flat)', 1e-6);
  done(h);
  const n = W('char_2014_nian'), tn = tb(n, 0);
  const h2 = run({ units: [{ chessId: n, row: 10, col: 4, uid: 1 }, { chessId: tank, row: 12, col: 9, uid: 2 }, { chessId: guard, row: 11, col: 9, uid: 3 }] });
  h2.step(2);
  approx(h2.unit(2).s.maxHp, h2.unit(2).base.maxHp * (1 + tn.max_hp), 'another 重装');
  approx(h2.unit(1).s.maxHp, h2.unit(1).base.maxHp * (1 + tn.max_hp), '年 herself');
  approx(h2.unit(3).s.maxHp, h2.unit(3).base.maxHp, 'not a 重装');
  h2.b.loseHp(h2.unit(1), 1e9, { source: null });
  h2.step(2);
  approx(h2.unit(2).s.maxHp, h2.unit(2).base.maxHp * (1 + tn.max_hp), 'stays while 年 is down (编入队伍时)');
  done(h2);
});

test('F8 battle: 伊芙利特 RES −40 % on enemies in range (gone after leaving); Mechanist ASPD −7 on the enemies it blocks', { skip }, () => {
  const id = W('char_134_ifrit'), t = tb(id, 0);
  const h = run({ defs: { enemies: { e: dummy('e', { res: 50 }) } }, units: [{ chessId: id, row: 10, col: 3, uid: 1 }], enemies: [{ key: 'e', pos: [10, 5] }, { key: 'e', pos: [12, 9] }] });
  h.step(20);
  const [near, far] = h.b.enemies;
  approx(near.s.res, 50 * (1 + t.magic_resistance), 'in range', 1e-6);
  approx(far.s.res, 50, 'out of range');
  near.x = 9; near.y = 12; h.b._buildEnemyIndex();
  h.run(0.7);
  approx(near.s.res, 50, 'left the range');
  done(h);
  const m = W('char_610_acfend'), tm = tb(m, 1);
  const h2 = run({ defs: { enemies: { e: enemyRec({ key: 'e', hp: 1e8, speed: 1, atk: 100 }) } }, units: [{ chessId: m, row: 9, col: 5, uid: 1 }], enemies: [{ key: 'e', route: 0 }] });
  assert.ok(h2.runUntil(() => h2.b.enemies[0]?.blockedBy, 40), 'blocked');
  h2.run(0.6);
  approx(h2.b.enemies[0].s.aspd, 100 + tm.attack_speed, 'ASPD −7');
  done(h2);
});

test('F9 battle: 伊芙利特 +2 SP every 6 s; 郁金香 +1 DP per kill (battle.addDp); 灰烬 +17 SP at deployment', { skip }, () => {
  const id = W('char_134_ifrit'), t = tb(id, 1);
  const h = run({ units: [{ chessId: id, row: 10, col: 4, uid: 1 }] });
  h.run(t.interval * 3 + 0.1);
  const g = h.hooksOf('spGain').filter((c) => c.unit === h.unit(1) && c.reason === 'talent');
  assert.equal(g.length, 3);
  approx(g[0].amount, t.sp, 'SP');
  done(h);
  const tu = W('char_608_acpion'), tt = tb(tu, 1);
  const h2 = run({ defs: { enemies: { e: enemyRec({ key: 'e', hp: 50, speed: 0, def: 0 }) } }, units: [{ chessId: tu, row: 10, col: 4, uid: 1 }], enemies: [{ key: 'e', pos: [10, 5], count: 3, interval: 2 }] });
  const calls = [];
  const orig = h2.b.addDp.bind(h2.b);
  h2.b.addDp = (pid, n) => { calls.push(n); return orig(pid, n); };
  h2.run(10);
  const kills = h2.hooksOf('kill').filter((c) => c.killer === h2.unit(1)).length;
  assert.ok(kills >= 1);
  assert.equal(calls.filter((n) => n === tt.cost).length, kills, 'one DP per kill');
  done(h2);
  const ash = W('char_456_ash'), ta = tb(ash, 1);
  const h3 = run({ units: [{ chessId: ash, row: 10, col: 4, uid: 1 }] });
  h3.step(1);
  approx(h3.unit(1).skill.sp, Math.min(h3.unit(1).skill.spCost, h3.unit(1).skill.initSp + ta.sp), 'SP after deploy (+ one tick of time SP)', 0.01);
  done(h3);
});

test('F9 battle (DP): 琴柳 — the next operator deployed after her pays 2 DP less, once; others keep their cost', { skip }, () => {
  const q = W('char_479_sleach'), tq = tb(q, 1);
  const a = 'chess_char_1_02_a', b = 'chess_char_2_03_a';
  const h = run({ units: [{ chessId: a, row: 10, col: 2, uid: 2 }, { chessId: b, row: 11, col: 2, uid: 3 }, { chessId: q, row: 10, col: 9, uid: 1 }] });
  h.step(2); // 琴柳 deploys last (rightmost column): her cut waits for the first paid redeploy
  const [ua, ub, uq] = [h.unit(2), h.unit(3), h.unit(1)];
  const costA = ua.base.cost, costB = ub.base.cost;
  h.b.kill(ua); h.b.kill(ub);
  assert.equal(ua.base.cost, costA + tq.value, 'cut while waiting');
  assert.equal(ub.base.cost, costB + tq.value);
  const ps = h.b.getPlayer('p1');
  ps.dp = 99;
  assert.ok(h.runUntil(() => ua.alive || ub.alive, 200), 'one redeploys');
  const first = ua.alive ? ua : ub, other = first === ua ? ub : ua;
  assert.equal(other.base.cost, other === ua ? costA : costB, 'the other one pays the full cost again');
  assert.equal(first.base.cost, first === ua ? costA : costB, 'restored after use');
  assert.ok(uq.alive);
  done(h);
});

test('F9 battle (DP): 老鲤 pays 5 DP per trait payment when it can; the next stun is cancelled and its source stunned 3 s', { skip }, () => {
  const id = W('char_322_lmlee'), t = tb(id, 1);
  const h = run({ defs: { enemies: { e: dummy('e') } }, units: [{ chessId: id, row: 10, col: 4, uid: 1 }], enemies: [{ key: 'e', pos: [10, 6] }] });
  const ps = h.b.getPlayer('p1');
  const u = h.unit(1);
  h.step(1);
  ps.dp = 50;
  const calls = [];
  const orig = h.b.addDp.bind(h.b);
  h.b.addDp = (pid, n) => { calls.push(n); return orig(pid, n); };
  h.run(3.1);
  assert.ok(calls.includes(t.extra_cost), `payments ${calls}`);
  const e = h.b.enemies[0];
  const ok = h.b.applyStatus(u, 'stun', { duration: 5, source: e });
  assert.equal(ok, false, 'stun cancelled');
  assert.ok(e.s.flags.stun, 'attacker stunned');
  done(h);
});

test('F10 battle: 斥罪 barrier 50 % at deployment +10 % per kill (≤300 %), counters while it holds; 年 3 hit layers', { skip }, () => {
  const id = W('char_4065_judge'), t = tb(id, 0), t1 = tb(id, 1);
  const h = run({ defs: { enemies: { e: enemyRec({ key: 'e', hp: 30, speed: 0, def: 0, atk: 50, bat: 1 }), big: dummy('big', { atk: 10, bat: 1, res: 0 }) } }, units: [{ chessId: id, row: 10, col: 4, uid: 1 }], enemies: [{ key: 'e', pos: [10, 5], time: 2, count: 2, interval: 3 }, { key: 'big', pos: [10, 4], time: 9 }] });
  h.step(1);
  const u = h.unit(1);
  const sh = () => u.buffs.find((b) => b.key.startsWith('gt:shield'))?.shield ?? 0;
  approx(sh(), u.s.maxHp * t.born_hp_ratio, 'deploy barrier');
  h.run(8);
  const kills = h.hooksOf('kill').filter((c) => c.killer === u).length;
  assert.ok(kills >= 1);
  assert.ok(sh() > u.s.maxHp * t.born_hp_ratio - 1e-6, 'grew with kills');
  h.run(6);
  const counters = h.hooksOf('damaged').filter((c) => c.source === u && (c.dmg.tags || []).includes('counter'));
  if (sh() > 0) assert.ok(counters.length > 0, 'counter while the own barrier holds');
  if (counters.length) approx(counters[0].amount, u.s.atk * t1.atk_scale, 'counter amount (RES 0)', 1e-3);
  done(h);
  const n = W('char_2014_nian'), tn = tb(n, 1);
  const h2 = run({ units: [{ chessId: n, row: 10, col: 4, uid: 1 }] });
  h2.step(1);
  assert.equal(h2.unit(1).buffs.find((b) => b.shieldHits > 0)?.shieldHits, tn.times);
  done(h2);
});

test('F10 battle: 焰狐龙梓兰 redeploys 15 s sooner (the hidden −15 s part is not added again); 煌 once-heal + 50 % floor', { skip }, () => {
  const id = W('char_1048_orchd2'), t = tb(id, 1);
  const h = run({ units: [{ chessId: id, row: 10, col: 4, uid: 1 }] });
  h.step(1);
  const u = h.unit(1);
  assert.equal(u.base.respawnTime, def(id).stats.respawnTime - 15);
  assert.ok(def(id).talents.some((x) => x.bb.respawn_time === -15), 'hidden part present in the data');
  void t;
  done(h);
  const hg = W('char_017_huang'), th = tb(hg, 0);
  const h2 = run({ units: [{ chessId: hg, row: 10, col: 4, uid: 1 }] });
  h2.step(1);
  const v = h2.unit(1);
  h2.b.dealDamage(null, v, { amount: v.s.maxHp * 0.8, type: 'true' });
  h2.step(1);
  approx(v.hpRatio, 0.2 + th['huang_t_1[heal].hp_ratio'], 'healed 50 %', 1e-3);
  h2.b.dealDamage(null, v, { amount: v.s.maxHp * 0.6, type: 'true' });
  h2.step(1);
  assert.ok(v.alive && v.hpRatio >= th['huang_t_1[lock].min_hp_ratio'] - 1e-6, `floor ${v.hpRatio}`);
  done(h2);
});

test('F7/X battle: 夜莺 elite default module range (攻击范围扩大) = its module grid; a 外援 lineup is deterministic', { skip }, () => {
  const id = W('char_179_cgbird', { elite: true });
  const d = def(id);
  const mod = d.raw.modules.find((m) => m.uniEquipId === d.raw.module.id);
  const g = mod.talentChanges.find((x) => x.talentIndex === -1 && x.rangeGrid?.length).rangeGrid;
  const h = run({ units: [{ chessId: id, row: 10, col: 4, uid: 1 }] });
  h.step(1);
  assert.deepEqual(h.unit(1).rangeGrid.map(String).sort(), g.map(String).sort());
  const none = run({ units: [{ chessId: id, row: 10, col: 4, uid: 1, moduleId: 'none' }] }).step(1);
  assert.deepEqual(none.unit(1).rangeGrid.map(String).sort(), d.rangeGrid.map(String).sort(), 'no module: own range');
  done(h);
  const lineup = [W('char_147_shining'), W('char_134_ifrit'), W('char_4065_judge'), W('char_611_acnipe'), W('char_2013_cerber'), W('char_608_acpion')]
    .map((c, i) => ({ chessId: c, row: 9 + (i % 4), col: 3 + i, uid: i + 1 }));
  const go = () => {
    const x = makeBattle({ seed: 11, defs: { chess: WG }, units: lineup, waveTemplate: 'act1autochess_05' });
    return resultDigest(x.runToEnd(400));
  };
  assert.equal(hashOf(go()), hashOf(go()));
});
