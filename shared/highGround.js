// shared/highGround.js — which MELEE chess may stand on a 高台 (a ranged deploy tile).
//
// Owner's decision 2026-10-04, reversing DESIGN §22.6. The branch trait 「可以放置于远程位」 is written on
// every 钩索师 / 推击手 variant (歌蕾蒂娅, 崖心, 见行者, normal and elite) and is not trusted. Only elite
// 歌蕾蒂娅 carrying module HOK-Y 淡金坠饰 may use a ranged tile. 崖心 (HOK-X only), 见行者, a normal
// record, any other module, and no module are ground-only. The golden record is the elite (`isGolden`);
// the same module test applies to it. A missing module id is ground-only.
//
// Module-granted exceptions (owner's decision 2026-10-06, 外援 requirements §6). Unlike the branch trait above, these
// are MODULE texts that grant the ranged tile explicitly, so they are trusted the way HOK-Y is — on the elite record
// carrying that module, never on a normal record, another module or no module:
//   * 帕拉斯 (外援, char_485_pallas, MELEE 教官) with INS-Y (uniequip_003_pallas, not her default): "可以额外部署在远程位".
//   * 艾拉 (外援, char_4123_ela) with TRP-D 社会期望背包 (uniequip_002_ela, her default): "自身可以额外部署在近战位，陷阱
//     可以额外部署在远程位". 艾拉 herself is a RANGED operator, and in this mode every ranged operator may already stand on
//     a melee tile (server/match/board.js canPlace), so the first half needs nothing; the second half widens her TRAPS
//     (token_10033_ela_grzmot, a MELEE summon placed by hand) to the ranged tiles — `summonOnHighGround`.

/** char_474_glady — 歌蕾蒂娅. */
export const GLADIIA_CHAR_ID = 'char_474_glady';
/** HOK-Y 淡金坠饰 (data/chess.json chess_char_4_12_b.modules, typeName HOK-Y). */
export const GLADIIA_HOK_Y = 'uniequip_003_glady';
/** char_485_pallas — 帕拉斯 (外援 / 甄选). */
export const PALLAS_CHAR_ID = 'char_485_pallas';
/** INS-Y (data/waiguan.json chess_char_diy_6_char_485_pallas_b.modules, typeName INS-Y): "可以额外部署在远程位". */
export const PALLAS_INS_Y = 'uniequip_003_pallas';
/** char_4123_ela — 艾拉 (外援 / 甄选). */
export const ELA_CHAR_ID = 'char_4123_ela';
/** TRP-D 社会期望背包 (her default module): "自身可以额外部署在近战位，陷阱可以额外部署在远程位". */
export const ELA_TRP_D = 'uniequip_002_ela';
/** 艾拉's trap (tokens.json, position MELEE, a hand piece). */
export const ELA_TRAP_TOKEN_ID = 'token_10033_ela_grzmot';

/** The elite + module pairs whose own MELEE record may stand on a ranged tile (see the header). */
const MELEE_HIGH_GROUND = Object.freeze([
  [GLADIIA_CHAR_ID, GLADIIA_HOK_Y],
  [PALLAS_CHAR_ID, PALLAS_INS_Y],
]);

/**
 * @param {object|null} rec a chess record (normal or golden)
 * @param {string|null|undefined} moduleId the equipped module (`resolveLoadout().moduleId`)
 * @returns {boolean}
 */
export function meleeOnHighGround(rec, moduleId) {
  if (!rec || rec.isGolden !== true || typeof moduleId !== 'string') return false;
  return MELEE_HIGH_GROUND.some(([charId, mod]) => rec.charId === charId && moduleId === mod);
}

/**
 * Whether a summon may stand on a ranged tile because its owner's equipped module says so: 艾拉's trap when its owner is
 * elite 艾拉 carrying TRP-D (see the header). Every other summon follows its own `position`.
 * @param {object|null} tokenRec tokens.json record of the summon
 * @param {object|null} ownerRec chess record of the summon's owner
 * @param {string|null|undefined} ownerModuleId the owner's equipped module (`resolveLoadout().moduleId`)
 * @returns {boolean}
 */
export function summonOnHighGround(tokenRec, ownerRec, ownerModuleId) {
  return !!(tokenRec && tokenRec.tokenId === ELA_TRAP_TOKEN_ID && ownerRec && ownerRec.isGolden === true
    && ownerRec.charId === ELA_CHAR_ID && ownerModuleId === ELA_TRP_D);
}
