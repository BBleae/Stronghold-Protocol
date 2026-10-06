// server/sim/content/kits/waiguan/char_608_acpion.js — 郁金香 (先锋 · 尖兵 pioneer) 外援 kit (DESIGN §27, KIT_GUIDE.md).
//
// Chess ids: chess_char_diy_5_char_608_acpion_a/_b, chess_char_diy_6_char_608_acpion_a/_b (registered by ./index.js).
// Numbers: normal = skill Lv4, elite = Lv7 + its module at the tier's level (tier V 1, tier VI 3; data/waiguan.json);
//   every number below comes from a blackboard of the loadout-resolved record.
// Trait (pioneer) "能够阻挡两个敌人": the data block count (professions.js SUB.pioneer) — nothing here.
// DP (REQUIREMENTS §1): every gain is Battle.addDp(her player) — real DP, capped at dpMax.
// Triggers: the record's, all kept — S1 / S2 MANUAL DEFAULT (尖兵 has no class row: the basic strategy, cast right
//   before an attack on an enemy of her initial range or one she blocks), S3 MANUAL SKILL_RANGE (a 技能范围 of its own,
//   x-1: "技能范围内存在敌人" every tick, no attack needed).
// S1 钻心 (instant): +cost DP at the cast (official acpion_s_1[cost]: once per cast); the attack it replaces strikes up to
//   max_target enemies (blocked first, then her range) for atk_scale × ATK physical.
// S2 迅瞬 (duration): ASPD +attack_speed, ignores def_penetrate of the target's DEF; +cost DP every `interval` s,
//   trig_cnt times (official acpion_s_2: ModifyCost per buff trigger), the rest at a natural end.
// S3 只余芬芳 (instant): +cost DP at the cast; `times` slashes on every ground enemy of the skill range (x-1), each
//   atk_scale × ATK physical ignoring def_penetrate of its DEF.
// T1 无垠之心: from each deployment until her cnt-th skill cast (official acpion_t_1: cnt −1 per ON_SKILL_START, the buff
//   ends at 0), natural SP recovery +sp_recovery_per_sec.
// T2 浪潮之心: ATK +atk (permanent); every enemy she kills: +cost DP for her player.
// Module SOL-X (uniequip_002_acpion) trait: ATK / DEF +atk / +def while she blocks an enemy (pool: 焰尾 / 精锐 SOL-X).
//   Module dispatch: `chess.module.type` of the active module, numbers from its trait part.
// fx: 'dp', 'swordStorm' (S3).
// [ASSUMED] (PRTS unreachable from the authoring container):
//   * S2: the first DP one interval after the cast (no grant at the cast); a knock-out ends the skill and the drip.
//   * S3: the record has no slash interval: the `times` slashes land at the cast, one after another (each re-selects the
//     living enemies of the range); melee slashes hit ground enemies only (no template says otherwise); 隐匿 /
//     untargetable enemies are not hit (they still satisfy the SKILL_RANGE trigger, the official strategy's wording).
//   * T2: "击杀敌人" = she is the killer (her attacks and skills), any enemy.

import { num, tal, traitBb, lazySkills, mods, gridOf, instantKindOf, statBuff, toggleBuff } from './_lib.js';
import { absoluteRangeKeys } from '../../../targeting.js';
import { keyTiles } from '../../fxtiles.js';

const S1 = 'skchr_acpion_1';
const S2 = 'skchr_acpion_2';
const S3 = 'skchr_acpion_3';
const GROUND = Object.freeze({ canHitFly: false, groundOnly: true });
const K_HEART = 'acpion:heart';
const K_TIDE = 'acpion:tide';
const K_SOLX = 'acpion:solx';

/** +n DP for `unit`'s player (Battle.addDp: capped at dpMax). */
function giveDp(battle, unit, n) {
  if (!(n > 0)) return;
  battle.addDp(unit.ownerId, n);
  battle.fx('dp', { x: unit.x, y: unit.y, id: unit.id, n });
}

export default function acpion(bb, chess) {
  const t0 = tal(chess, 0), t1 = tal(chess, 1), tb = traitBb(chess);
  const mtype = chess?.module?.active ? chess.module.type ?? null : null;
  return {
    skills: lazySkills(chess, {
      // S1 钻心: +DP, the next attack strikes up to max_target enemies
      [S1]: (rec) => {
        const b = rec.bb ?? {};
        const scale = num(b.atk_scale), n = Math.floor(num(b.max_target)), cost = num(b.cost);
        return {
          kind: instantKindOf(rec),
          attack: { ...(scale > 0 ? { atkScale: scale } : {}), ...(n > 0 ? { maxTargets: n } : {}) },
          onStart({ battle, unit }) { giveDp(battle, unit, cost); },
        };
      },
      // S2 迅瞬: ASPD +, DEF ignore, DP every interval
      [S2]: (rec) => {
        const b = rec.bb ?? {};
        const per = num(b.cost), iv = num(b.interval), cnt = Math.floor(num(b.trig_cnt));
        return {
          kind: 'duration',
          mods: mods({ aspd: num(b.attack_speed), defIgnorePct: num(b.def_penetrate) }),
          onStart({ unit }) { unit.mem.acpionDrip = { acc: 0, n: 0 }; },
          onTick({ battle, unit, dt }) {
            const m = unit.mem.acpionDrip;
            if (!m || !(iv > 0)) return;
            m.acc += dt;
            while (m.acc + 1e-9 >= iv && m.n < cnt) { m.acc -= iv; m.n++; giveDp(battle, unit, per); }
          },
          onEnd({ battle, unit, reason }) {
            const m = unit.mem.acpionDrip;
            unit.mem.acpionDrip = null;
            if (m && reason === 'duration' && m.n < cnt) giveDp(battle, unit, per * (cnt - m.n));
          },
        };
      },
      // S3 只余芬芳: +DP, `times` slashes on every ground enemy of the skill range
      [S3]: (rec) => {
        const b = rec.bb ?? {};
        const cost = num(b.cost), scale = num(b.atk_scale), pen = num(b.def_penetrate), times = Math.floor(num(b.times));
        const grid = gridOf(rec);
        return {
          kind: instantKindOf(rec),
          onStart({ battle, unit }) {
            giveDp(battle, unit, cost);
            const keys = absoluteRangeKeys(grid ?? unit.rangeGrid, unit.tileR, unit.tileC, unit.dir, 0);
            battle.fx('swordStorm', { x: unit.x, y: unit.y, id: unit.id, tiles: keyTiles(keys), skill: 'acpion_3' });
            if (!(scale > 0)) return;
            for (let i = 0; i < times; i++) {
              for (const e of battle.enemiesInKeys(keys, unit, GROUND)) {
                battle.dealDamage(unit, e, { amount: unit.s.atk * scale, type: 'phys', isSkill: true, defIgnorePct: pen, tags: ['skill', 'acpionSlash'] });
              }
            }
          },
        };
      },
    }),
    talents: [
      { install(battle, unit) { // 无垠之心: SP recovery + until the cnt-th cast of each deployment
        const sp = num(t0.sp_recovery_per_sec), cnt = Math.floor(num(t0.cnt));
        if (!(sp > 0) || !(cnt > 0)) return;
        battle.on('deploy', (c) => {
          if (c.unit !== unit) return;
          unit.mem.acpionCasts = 0;
          battle.addBuff(unit, { key: K_HEART, mods: { spRecoveryFlat: sp }, visible: true, tags: ['talent'] });
        }, { owner: unit });
        battle.on('skillStart', (c) => {
          if (c.unit !== unit) return;
          unit.mem.acpionCasts = num(unit.mem.acpionCasts) + 1;
          if (unit.mem.acpionCasts >= cnt) battle.removeBuff(unit, K_HEART);
        }, { owner: unit });
      } },
      { install(battle, unit) { // 浪潮之心: ATK +, +DP per kill
        statBuff(battle, unit, K_TIDE, { atkPct: num(t1.atk) });
        const cost = num(t1.cost);
        if (cost > 0) {
          battle.on('kill', (c) => {
            if (c.killer === unit && c.victim && c.victim.side === 'enemy') giveDp(battle, unit, cost);
          }, { owner: unit });
        }
      } },
    ],
    install(battle, unit) {
      // module SOL-X trait: ATK / DEF + while blocking
      if (mtype !== 'SOL-X') return;
      const m = mods({ atkPct: num(tb.atk), defPct: num(tb.def) });
      if (Object.keys(m).length) toggleBuff(battle, unit, K_SOLX, () => unit.blocking.length > 0, m);
    },
  };
}
