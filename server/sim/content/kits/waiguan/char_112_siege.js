// server/sim/content/kits/waiguan/char_112_siege.js — 推进之王 (先锋 · 尖兵 pioneer) 外援 kit (DESIGN §27, KIT_GUIDE.md).
//
// Chess ids: chess_char_diy_5_char_112_siege_a/_b, chess_char_diy_6_char_112_siege_a/_b (registered by ./index.js).
// Sources: the records (data/waiguan.json; normal = skill Lv4, elite = Lv7 + its module at the tier's level), the
// official module data behind them (battle_equip_table: which blackboard belongs to which part) and the buff templates
// (ArknightsGameData zh_CN battle/buff_template_data.json: charge_cost, siege_t_2, siege_e_003[sp] / [modify_sp]).
// Every number comes from a blackboard.
//
// DP (部署费用, REQUIREMENTS §1) is the engine's: battle.addDp(ownerId, n) — the player's DP, capped at flags.dpMax.
// Trait (尖兵 "能够阻挡两个敌人"): the data block count (professions.js SUB.pioneer has no trait to model).
// S1 冲锋号令·γ型 (AUTO, instant): +cost DP at once. 技能策略: an AUTO skill takes no strategy row and its DP gain has no
//   target ⇒ trigger SP_FULL (cast as soon as it is ready) — the pool's rule for the same common skill (德克萨斯
//   kits/tier1.js, 焰尾 S1 kits/tier4.js); the record's DEFAULT is changed.
// S2 跃空锤 (AUTO, charges — 2 at Lv4, 3 at Lv7): the next attack strikes every enemy of the skill's cross range (x-5,
//   the record's grid: her tile and the four around it) — and those she blocks — for atk_scale × ATK physical, and that
//   attack gains +cost DP. 技能策略: AUTO "下次攻击" ⇒ the record's DEFAULT (cast at the attack once a charge is ready),
//   kept; an AUTO skill has no operation cooldown, so stored charges go on consecutive attacks.
// S3 碎颅击 (MANUAL, DEFAULT kept, duration): 攻击间隔 +base_attack_time s (batMod: a flat change, "增大"), attacks at
//   attack@atk_scale × ATK, each attack hit stuns its target attack@stun s with chance attack@buff_prob.
// T1 万兽之王: an aura while she is on the field (the text has no "编入队伍时 / 携带…时 / 上阵时", the only team-scope
//   wordings — the repo's reading of this very text: genericTalents.js "所有【先锋】…" scope, test/sim/generic-talents
//   'F7.auraAlly'; no siege_t_1 template exists): every 【先锋】 operator of her player on the field (herself included)
//   ATK +atk, DEF +def, from the talent's no-module blackboard (talentsBase) — installAura (kits/tier1.js): refreshed every
//   0.5 s, it lapses ≤ 0.6 s after she leaves; two copies never stack (the stronger holds). Module SOL-X
//   (uniequip_002_siege) from level 2 (tier VI level 3) adds "自身攻击力和防御力额外+8%": the module's talent part for
//   index 0 — its blackboard is that extra (official data: level 2 reads "额外+6%" with atk/def 0.06 while the 先锋 part
//   stays 8 %), on herself while she is on the field.
// T2 粉碎 (siege_t_2: ON_OWNER_KILLED → ModifySp on the source): an enemy that falls (killed by anyone, or a 重伤 that
//   expires) on the talent's range grid (her tile and the four around it) gives her `sp` SP (lost while her timed skill
//   runs — the engine's rule). Module SOL-Y (uniequip_003_siege) raises `sp` (talent 1 of the record) and, from level 2,
//   adds a hidden part (siege_e_003[sp] → [modify_sp]): one random other 【先锋】 operator of her player on the field
//   that can gain SP gains that part's `sp` (battle RNG, drawn only with two or more candidates). Candidates as the
//   pool's 华法琳 血液样本回收 random ally (kits/tier4.js bldsk_t_1[rand]): selectable (not 孤立), with a skill that is
//   neither passive nor running a timed activation.
// Module SOL-X trait: ATK and DEF +atk / +def while she blocks an enemy (the pool's 焰尾 SOL-X).
// Module SOL-Y "首次部署时部署费用-4" (hidden runtime_cost): the initial deployment is free in battle and a redeploy is not a
//   首次部署 ⇒ no in-battle effect (pool: 德克萨斯 kits/tier1.js, 忍冬 kits/tier3.js).
// Modules are dispatched by `chess.module.type` (KIT_CONVENTIONS 15); their numbers come from the loadout record.
// fx: 'dp' (every DP gain), 'shockBlast' (S2 attack: `tiles` = the cross it covers), 'spGain' (粉碎), 'spGift' (SOL-Y).
// [ASSUMED] (PRTS unreachable from the authoring container):
//   * T1: summons are no 干员 (operators only).
//   * S2 hits ground enemies only (a melee pioneer's attack; no "可对空" note in the data).
//   * T2 counts every enemy that falls on those tiles (flyers too) while she stands on the field. siege_t_2's ModifySp
//     carries `_forceFlag`; its meaning is not in the data, so the engine's rule stands (no SP while S3 runs).
//   * SOL-Y "场上随机另一名【先锋】职业干员": her player's other 先锋 operators on the field (a teammate's on a shared field are
//     not counted, KIT_CONVENTIONS 5).

import { num, tal, talRec, hiddenBb, moduleRec, lazySkills, mods, gridOf, instantKindOf, live, batMod, toggleBuff, installAura } from './_lib.js';
import { absoluteRangeKeys } from '../../../targeting.js';
import { bodyInKeys } from '../../../body.js';
import { gridTiles } from '../../fxtiles.js';

const S1 = 'skcom_charge_cost[3]', S2 = 'skchr_siege_2', S3 = 'skchr_siege_3';
/** 万兽之王 on the 先锋 operators on the field (one per unit: the strongest copy holds) and the SOL-X extra on herself. */
export const LORD_KEY = 'siege:lord';
export const LORD_SELF_KEY = 'siege:lordSelf';

const isVanguard = (a) => !!a && a.kind === 'op' && a.def?.profession === 'PIONEER';

/** DP gain of `unit`'s player (the engine's DP, capped at dpMax) with its fx. */
function gainDp(battle, unit, n) {
  if (!(n > 0)) return;
  battle.addDp(unit.ownerId, n);
  battle.fx('dp', { x: unit.x, y: unit.y, id: unit.id, n });
}

/** Can `u` gain SP now: a skill that is neither passive nor running a timed activation (pool bldsk_t_1[rand] filter). */
const canGainSp = (u) => !!u?.skill && !u.skill.noSkill && u.skill.kind !== 'passive' && !(u.skill.active && u.skill.isTimed);

/** SP gift to `u` unless its timed skill runs (the engine's rule). */
function giftSp(u, n) {
  return canGainSp(u) && n > 0 ? u.skill.gainSp(n, 'talent') : 0;
}

/** S1 冲锋号令·γ型: +cost DP, cast as soon as it is ready (header). */
const chargeCost = (rec) => ({
  kind: 'instant',
  trigger: 'SP_FULL',
  onStart({ battle, unit }) { gainDp(battle, unit, num(rec.bb?.cost)); },
});

/** S2 跃空锤 (header). */
function leapHammer(rec) {
  const b = rec.bb ?? {};
  const grid = gridOf(rec);
  return {
    kind: instantKindOf(rec),
    targeting: grid ? { rangeGrid: grid.map((p) => [p[0], p[1]]), allInRange: true } : { allInRange: true },
    attack: { atkScale: num(b.atk_scale) },
    onAttack({ battle, unit }) {
      battle.fx('shockBlast', { x: unit.x, y: unit.y, id: unit.id, tiles: gridTiles(unit, grid) });
      gainDp(battle, unit, num(b.cost));
    },
  };
}

/** S3 碎颅击 (header). */
function skullBreaker(rec, chess) {
  const b = rec.bb ?? {};
  const prob = num(b['attack@buff_prob']), stun = num(b['attack@stun']);
  const attack = {
    onHit({ battle, unit, target }) {
      if (!target || !target.alive || target.side !== 'enemy' || !(prob > 0) || !(stun > 0)) return;
      if (battle.rng.chance(prob)) battle.applyStatus(target, 'stun', { duration: stun, source: unit });
    },
  };
  if (b['attack@atk_scale'] != null) attack.atkScale = num(b['attack@atk_scale']);
  return { kind: 'duration', mods: mods({ batPct: batMod(b.base_attack_time, chess, rec.desc ?? '') }), attack };
}

export default function siege(bb, chess) {
  const moduleType = chess?.module?.active ? chess.module.type ?? null : null;
  // 万兽之王: the 先锋 part is the talent's no-module blackboard; SOL-X's talent part for index 0 is the extra on herself
  const lordBb = ((chess?.talentsBase ?? chess?.talents ?? []).find((t) => t && t.index === 0) ?? {}).bb ?? {};
  const selfBb = moduleType === 'SOL-X' ? (moduleRec(chess)?.talentChanges ?? []).find((c) => c && c.talentIndex === 0)?.bb ?? {} : {};
  const crush = talRec(chess, 1);
  const crushSp = num(tal(chess, 1).sp);
  const crushGrid = Array.isArray(crush?.rangeGrid) && crush.rangeGrid.length ? crush.rangeGrid : null;
  const giftN = moduleType === 'SOL-Y' ? num(hiddenBb(chess).sp) : 0;
  const tb = moduleType === 'SOL-X' ? chess?.trait?.bb ?? {} : {};
  return {
    skills: lazySkills(chess, {
      [S1]: chargeCost,
      [S2]: leapHammer,
      [S3]: (rec) => skullBreaker(rec, chess),
    }),
    talents: [
      { install(battle, unit) { // 万兽之王 (+ SOL-X extra on herself), while she is on the field
        const v = num(lordBb.atk);
        const m = mods({ atkPct: v, defPct: num(lordBb.def) });
        if (Object.keys(m).length) installAura(battle, unit, { key: LORD_KEY, value: v, mods: m, select: (a) => isVanguard(a) && a.ownerId === unit.ownerId });
        const self = mods({ atkPct: num(selfBb.atk), defPct: num(selfBb.def) });
        if (Object.keys(self).length) toggleBuff(battle, unit, LORD_SELF_KEY, () => true, self);
      } },
      { install(battle, unit) { // 粉碎 (+ SOL-Y: a random other 先锋 of her player)
        if (!crushGrid || !(crushSp > 0 || giftN > 0)) return;
        battle.on('death', (c) => {
          const v = c.unit;
          if (c.reason !== 'killed' || !v || v.side !== 'enemy' || !live(unit)) return;
          if (!bodyInKeys(v, new Set(absoluteRangeKeys(crushGrid, unit.tileR, unit.tileC, unit.dir, 0)))) return;
          if (crushSp > 0 && giftSp(unit, crushSp) > 0) battle.fx('spGain', { x: unit.x, y: unit.y, id: unit.id, n: crushSp });
          if (!(giftN > 0)) return;
          const others = battle.allies(unit.ownerId).filter((a) => a !== unit && isVanguard(a) && battle.allySelectable(a, unit) && canGainSp(a));
          const pick = others.length > 1 ? battle.rng.pick(others) : others[0];
          if (pick && giftSp(pick, giftN) > 0) battle.fx('spGift', { x: pick.x, y: pick.y, id: pick.id, src: unit.id, n: giftN });
        }, { owner: unit });
      } },
    ],
    install(battle, unit) {
      // SOL-X trait: ATK / DEF + while she blocks
      const m = mods({ atkPct: num(tb.atk), defPct: num(tb.def) });
      if (Object.keys(m).length) toggleBuff(battle, unit, 'siege:solX', () => unit.blocking.length > 0, m);
    },
  };
}
