// server/sim/content/kits/ops/op-yato2.js — 麒麟R夜刀 (char_1029_yato2) 自选 operator kit: 6★ 处决者 (特种), a collab pick of
// this fork (tools/build-data.mjs FORK_INCLUDE_COLLAB_PICKS — the fork owner's decision of 2026-10-08: the 7 collab 6★
// upstream leaves out of 自选 come back in full) for the tier-5 and tier-6 自选 slots; every skill, both talents, the trait
// and both modules (EXE-X 训练用木桩, EXE-Y 罗德岛制式双刀) at every form. Kit contract and the 自选 rules: ../README.md
// ("How to add an operator (自选)").
//
// Forms (data/backups.json units.char_1029_yato2, the DIY slot statuses): normal = E2 Lv1, skills at rank 4, no module;
// elite = E2 Lv60, rank 7, the picked module at stage 1 (tier 5) or 3 (tier 6) — the owner's decision of 2026-10-05. Full
// potential (the owner's decision of 2026-10-07: T2 +16 %). Sources: character_table / skill_table / battle_equip_table
// (zh_CN, as built into backups.json); PRTS 麒麟R夜刀 (鬼人化 备注 "技能期间对每个目标的每第三次攻击变为六连击；六连击占用2个攻击间隔
// （前4连击+后2连击）"; 乱舞 备注 "固定攻击动画不受攻击速度影响" / "攻击力提升效果实际为攻击倍率提升，同时应用于普通攻击与第一天赋" /
// "技能结束前，持有效果：晕眩免疫，冻结免疫，沉睡免疫"; 空中回旋乱舞 备注 "部署瞬间即进入技能状态；技能期间获得效果：无敌，不可阻挡，晕眩免疫，
// 冻结免疫，沉睡免疫，一减状态抵抗率-100%（此类状态持续时间将变为1/1000）" / "触发技能时从自身所在格中心释放一个弹道，其拥有0.51的碰撞
// 半径，8格/秒（≈0.267格/帧）的移动速度，每帧判定一次攻击，每造成一次技能伤害使弹道突进距离+0.3格（最大突进距离受视野影响，不会超出地图
// 边界）" / "攻击倍率同时应用于第一天赋"; 双雷剑麒麟 备注 "本天赋的伤害不触发敌人的受击回复"; EXE-X "撤退时返还大量(80%)该次部署费用");
// PRTS 术语释义 术法充盈 (ba.magicarcane) "造成的法术伤害提升（同名效果取最高）※于输出伤害时提升本次伤害的伤害倍率"; the Terra Wiki
// (arknights.wiki.gg) Kirin R Yato notes ("performs one slash every frame", "Each slash hits enemies in a radius of 0.51
// tiles"); the client's skeleton char_1029_yato2 (data/assets.json spine `animations` / `hits`: Skill_2 3.433 s with 16
// OnAttack events — S2_SLASHES below).
// - Trait (处决者) "再部署时间大幅度减少": the data's respawnTime (16 s at full potential: the engine's automatic redeploy,
//   DESIGN §5.5); melee physical, 1-1, blocks 1, ground-only (data canHitFly false), attacks the enemies it blocks first
//   (the engine's blocked-first rule); ground enemies target her.
// - Module EXE-X: "撤退时返还大量该次部署费用" (trait bb withdraw_cost_recover_ratio) — no manual retreat in battle in this
//   mode ⇒ no effect (as 砾's / 傀影's EXE-X); stats; stage 2+ changes T2 (below). EXE-Y: "周围四格没有友方干员时攻击力+10%"
//   (trait bb atk): ATK +atk while no allied operator — summons and devices do not count — stands on the 4 tiles beside her
//   (op-phatom.js noOperatorBeside); stats; stage 2+ changes T1 (below).
// - T1 双雷剑麒麟 "攻击额外造成攻击力20%的法术伤害" (attack@atk_scale_1): every damage instance of her attacks that lands on an
//   enemy — each hit of a double / six-hit, each 乱舞 slash, each 空中回旋乱舞 slash (PRTS: the skill's 攻击倍率 applies to
//   the talent) — is followed by attack@atk_scale_1 × ATK arts damage × the 攻击倍率 of that hit: 乱舞 talent_scale (2.088 /
//   2.73 = the text's 1.8 / 2.1 × the skill's atk_scale 1.16 / 1.3, which the blackboard already multiplies in), 空中回旋乱舞
//   atk_scale, else 1 (× her atkScaleMul); `noSp` (no 受击回复). [ASSUMED] it rides a landed hit — a dodged / cancelled hit
//   brings none, and it is not dodged on its own (canDodge false) —, it is no skill damage, and it does not lengthen the
//   空中回旋乱舞 dash (only the skill's own damage does: "每造成一次技能伤害").
//   EXE-Y stage 2+ (stage 3: 25 %) adds the hidden module talent: 术法充盈 — after every arts damage instance she deals to an
//   enemy one stack of damage_up (5 %), up to max_stack_cnt (10: 50 %), raising the 伤害倍率 of every arts damage she deals
//   (DamageInfo `mul`, at the output — PRTS 术语释义) [ASSUMED: a state of her deployment, lost when she leaves the field];
//   and "首次撤退再部署时间为0" (respawn_time 0): her first leave of the field in a battle (a knock-out too, as 伊内丝's
//   module reads 撤退) redeploys with no timer (redeployMul 0 until she is back; the DP cost stays).
// - T2 鬼人强化状态 "技能期间及技能结束后的10秒内攻击力+16%" (full potential): ATK +atk from each skill start until `duration` s
//   after its end (a knock-out ends it). EXE-X stage 2+ (stage 3: +18 %, "技能期间攻击力额外+5%"): the extra
//   yato2_e_002[atk].atk while the skill runs only.
// - S1 鬼人化 (被动, at each deployment, the skill's duration 20 s): ASPD +attack_speed; her attacks become double hits and,
//   per target, every third attack on it is the six-hit — 4 hits in that attack, then the 2 left in her next attack (the
//   second interval; PRTS 备注), which counts for no target [ASSUMED: it lands on whatever that next attack targets, and a
//   tail still due when the skill ends is dropped]. The hits are normal attacks (not skill damage).
// - S2 乱舞 (被动, at each deployment): a fixed 3.433 s animation (the skeleton's Skill_2 clip; no attack speed changes it) with
//   16 slashes at its OnAttack events, each an attack at atk_scale × ATK (攻击倍率: 116 % / 130 %) on every ground enemy of
//   her 1-1 and those she blocks ("对前方一格的所有敌人" — as 黄's "前方一格内", op-huang.js; ground-only like her normal
//   attack [ASSUMED: the text names no air]); no normal attacks meanwhile; taunt level +taunt_level ("期间更容易受到敌人的攻
//   击"); immune to 晕眩 / 冻结 / 沉睡 until it ends. [ASSUMED] a slash due while she cannot act (浮空 …) or is 缴械 is lost; at
//   the battle-start deployment no enemy is on the field yet, so its slashes hit nothing (as 傀影's 夜幕突袭).
// - S3 空中回旋乱舞 (被动, at each deployment): a dash released from her tile centre forward (her facing) at DASH_SPEED tiles/s;
//   every frame (one sim tick = the client's 1/30 s) one slash of atk_scale × ATK physical skill damage hits every
//   selectable enemy within DASH_RADIUS of the dash point, air units included ("可以攻击空中单位"); every slash that lands on
//   an enemy (each enemy of it) lengthens the dash by dist_unit (0.3) from min_dist (2) up to max_dist (5), never past the
//   field's edge (the last tile centre of the battle rect in that direction [ASSUMED: PRTS "受视野影响，不会超出地图边界"]);
//   she stays on her tile (the dash is a projectile); the skill — 无敌, no normal attacks, immune to 晕眩 / 冻结 / 沉睡, every
//   other resistible status (buffs.js RESIST_STATUSES) on her at 1/1000 of its duration — ends with the last slash, at the
//   dash's end [ASSUMED: the 0.667 s Skill_3_End clip is not modelled]. 不可阻挡 does nothing for an operator here. The
//   blackboard's dist_interval (0.2 tile) is below the 0.267 tile a frame covers, so one slash per frame (PRTS 备注 "每帧判定
//   一次攻击"). At the battle-start deployment no enemy is on the field yet: the dash runs its 2 tiles through nothing.
// Triggers: the three skills are 被动 ON_DEPLOY — timed deployment skills (activateOnDeploy, trigger NEVER), as 弑君者's.

import { num, talentBb, moduleBb, traitBb, skillRec, toggleBuff, up } from '../shared/tier1.js';
import { RESIST_STATUSES } from '../../../buffs.js';
import { hasHp } from '../../../damage.js';
import { canTargetEnemy } from '../../../targeting.js';
import { noOperatorBeside } from './op-phatom.js';

const S1 = 'skchr_yato2_1';
const S2 = 'skchr_yato2_2';
const S3 = 'skchr_yato2_3';
/** 乱舞's fixed animation: the skeleton's Skill_2 clip (char_1029_yato2, 3.433 s). */
export const S2_CLIP = 3.433;
/**
 * 乱舞's 16 slashes: the OnAttack events of that clip, in s from its start — 30 fps keyframes (12/30, 32/30, 34/30 … 89/30
 * s) the asset tools round to the millisecond, hence the half-millisecond tolerance of SLASH_EPS.
 */
export const S2_SLASHES = Object.freeze([0.4, 1.067, 1.133, 1.4, 1.667, 1.933, 2, 2.2, 2.267, 2.633, 2.7, 2.767, 2.8, 2.867, 2.9, 2.967]);
const SLASH_EPS = 5e-4 + 1e-9;
/** 空中回旋乱舞's dash (PRTS 备注): speed in tiles/s and the collision radius of each slash. */
export const DASH_SPEED = 8;
export const DASH_RADIUS = 0.51;
/** 空中回旋乱舞 "一减状态抵抗率-100%": a resistible status on her lasts 1/1000 of its duration. */
const DASH_STATUS_SCALE = 0.001;
/** 乱舞 / 空中回旋乱舞: 晕眩免疫, 冻结免疫, 沉睡免疫 (PRTS 备注). */
const HARD_IMMUNE = Object.freeze(new Set(['stun', 'freeze', 'sleep']));
/** 鬼人化: "攻击变为二连击", "对同一目标的第三次攻击变为六连击" — 4 hits, then 2 in the next attack interval (PRTS 备注). */
const DOUBLE = 2;
const COMBO_EVERY = 3;
const COMBO_HEAD = 4;
const COMBO_TAIL = 2;
const TIMED = Object.freeze({ kind: 'duration', activateOnDeploy: true, spCost: 0, spType: 'none', trigger: 'NEVER' });
const AIR = Object.freeze({ canHitFly: true });
export const TAG_KIRIN = 'yato2:kirin';
export const TAG_DASH = 'yato2:dash';
const DEMON = 'talent:yato2:demon';
const DEMON_SKILL = 'talent:yato2:demonSkill';
const LONELY = 'trait:yato2:lonely';
const ARCANE = 'module:yato2:arcane';
const FIRST_OUT = 'module:yato2:firstRetreat';
const skillOn = (u, id) => !!(u.skill && u.skill.active && (id == null || u.skill.id === id));

/** The dash's room from (x, y) along [dr, dc] to the last tile centre of the battle rect. */
function edgeRoom(battle, x, y, dr, dc) {
  const R = battle.rect;
  const room = dc > 0 ? R.c1 - x : dc < 0 ? x - R.c0 : dr > 0 ? R.r1 - y : dr < 0 ? y - R.r0 : 0;
  return Math.max(0, room);
}

export default {
  char_1029_yato2: (bb, chess) => {
    const t0 = talentBb(chess, 0);   // 双雷剑麒麟: attack@atk_scale_1 (EXE-Y stage 3: 0.25)
    const t1 = talentBb(chess, 1);   // 鬼人强化状态: atk, duration (EXE-X stage 3: 0.18 + yato2_e_002[atk].atk)
    const mb = moduleBb(chess);      // EXE-Y stage 2+: damage_up, max_stack_cnt, respawn_time
    const lonelyAtk = num(traitBb(chess).atk);   // EXE-Y trait (EXE-X: withdraw_cost_recover_ratio, no effect here)
    const r1 = skillRec(chess, S1), r2 = skillRec(chess, S2), r3 = skillRec(chess, S3);
    const b1 = r1?.bb ?? {}, b2 = r2?.bb ?? {}, b3 = r3?.bb ?? {};
    const kirin = num(t0['attack@atk_scale_1']);
    const danceScale = num(b2.atk_scale, 1), danceTalent = num(b2.talent_scale, 1);
    const dashScale = num(b3.atk_scale, 1);
    const dashMin = num(b3.min_dist, 2), dashMax = num(b3.max_dist, 5), dashUnit = num(b3.dist_unit, 0.3);
    const picked = chess?.skill?.skillId ?? null;

    /** 双雷剑麒麟 after a landed hit of hers on `e` with 攻击倍率 `k` (1, 乱舞 talent_scale, 空中回旋乱舞 atk_scale). */
    const kirinBolt = (battle, unit, e, k) => {
      if (!(kirin > 0) || !e || e.side !== 'enemy' || !hasHp(e)) return;
      battle.dealDamage(unit, e, { amount: unit.s.atk * kirin * k * unit.s.atkScaleMul, type: 'arts', canDodge: false, noSp: true, tags: ['talent', TAG_KIRIN] });
    };

    /** One 空中回旋乱舞 frame at the dash point: a slash on every selectable enemy within DASH_RADIUS; returns the landed hits. */
    const dashSlash = (battle, unit, d) => {
      const x = d.x0 + d.dc * d.pos, y = d.y0 + d.dr * d.pos;
      let landed = 0;
      for (const e of battle.foesInRadius(x, y, DASH_RADIUS)) {
        if (!canTargetEnemy(unit, e, AIR)) continue;
        const n0 = unit.mem.yatoDashLanded | 0;
        battle.dealDamage(unit, e, { amount: unit.s.atk * dashScale * unit.s.atkScaleMul, type: 'phys', isSkill: true, tags: ['skill', TAG_DASH] });
        if ((unit.mem.yatoDashLanded | 0) > n0) {
          landed++;
          battle.fx('slash', { x: e.x, y: e.y, id: unit.id, n: 1, skill: TAG_DASH });
        }
        if (!up(unit) || unit.mem.yatoDash !== d) break;
      }
      return landed;
    };

    return {
      skills: {
        [S1]: {
          ...TIMED, duration: num(r1?.duration, 20), mods: { aspd: num(b1.attack_speed) },
          onStart({ unit }) { unit.mem.yatoCombo = { count: new WeakMap(), tail: false, hits: DOUBLE }; },
          onEnd({ unit }) { unit.mem.yatoCombo = null; },
        },
        [S2]: {
          ...TIMED, duration: S2_CLIP, mods: { taunt: num(b2.taunt_level) },
          attack: { noAttack: true, atkScale: danceScale, allInRange: true },
          onStart({ unit }) { unit.mem.yatoDance = { t: 0, i: 0 }; },
          onTick({ battle, unit, dt }) {
            const m = unit.mem.yatoDance;
            if (!m) return;
            while (m.i < S2_SLASHES.length && m.t + SLASH_EPS >= S2_SLASHES[m.i]) {
              m.i++;
              if (up(unit) && unit.canAct && !unit.s.flags.disarm) battle.forceAttack(unit);
              if (!up(unit) || unit.mem.yatoDance !== m) return;
            }
            m.t += dt;
          },
          onEnd({ unit }) { unit.mem.yatoDance = null; },
        },
        [S3]: {
          // the duration only bounds the window: the skill ends with the dash's last slash (onTick)
          ...TIMED, duration: dashMax / DASH_SPEED + 1, flags: { invulnerable: true }, attack: { noAttack: true },
          onStart({ battle, unit }) {
            const [dr, dc] = unit.fwd;
            const top = Math.min(dashMax, edgeRoom(battle, unit.x, unit.y, dr, dc));
            const d = { x0: unit.x, y0: unit.y, dr, dc, pos: 0, top, dist: Math.min(dashMin, top) };
            unit.mem.yatoDash = d;
            battle.fx('dash', { x: unit.x, y: unit.y, id: unit.id, tx: unit.x + dc * d.dist, ty: unit.y + dr * d.dist, t: d.dist / DASH_SPEED, skill: TAG_DASH });
          },
          onTick({ battle, unit, skill, dt }) {
            const d = unit.mem.yatoDash;
            if (!d) return;
            const landed = dashSlash(battle, unit, d);
            if (!up(unit) || unit.mem.yatoDash !== d) return;
            if (landed > 0) d.dist = Math.min(d.top, d.dist + dashUnit * landed);
            if (d.pos >= d.dist - 1e-9) {   // the last slash at the dash's end: the skill ends this tick
              unit.mem.yatoDash = null;
              skill.timeLeft = 0;
              return;
            }
            d.pos = Math.min(d.dist, d.pos + DASH_SPEED * dt);
          },
          onEnd({ unit }) { unit.mem.yatoDash = null; },
        },
      },
      // 鬼人化: the hits of the attack its beforeAttack count (install) chose — 2, the six-hit's 4, then its 2
      trait: { hitsFn: (b, u) => (skillOn(u, S1) && u.mem.yatoCombo ? u.mem.yatoCombo.hits : 1) },
      talents: [
        { install(battle, unit) { // 双雷剑麒麟: arts after every landed hit of her attacks and of her 空中回旋乱舞 slashes
          if (!(kirin > 0)) return;
          battle.on('damaged', (c) => {
            const d = c.dmg, e = c.target;
            if (c.source !== unit || !d || c.type === 'element' || !e || e.side !== 'enemy') return;
            const dash = Array.isArray(d.tags) && d.tags.includes(TAG_DASH);
            if (!d.isAttack && !dash) return;
            kirinBolt(battle, unit, e, dash ? dashScale : skillOn(unit, S2) ? danceTalent : 1);
          }, { owner: unit });
        } },
        { install(battle, unit) { // 鬼人强化状态: ATK while a skill runs and `duration` s after (EXE-X stage 2+: + while it runs)
          const a = num(t1.atk), dur = num(t1.duration, 10), extra = num(t1['yato2_e_002[atk].atk']);
          if (!a && !extra) return;
          battle.on('skillStart', (c) => {
            if (c.unit !== unit) return;
            if (a) battle.addBuff(unit, { key: DEMON, mods: { atkPct: a }, tags: ['talent'] });
            if (extra) battle.addBuff(unit, { key: DEMON_SKILL, mods: { atkPct: extra }, tags: ['talent'] });
          }, { owner: unit });
          battle.on('skillEnd', (c) => {
            if (c.unit !== unit) return;
            battle.removeBuff(unit, DEMON_SKILL);
            if (a && c.reason !== 'death' && up(unit)) battle.addBuff(unit, { key: DEMON, duration: dur, mods: { atkPct: a }, tags: ['talent'] });
            else battle.removeBuff(unit, DEMON);
          }, { owner: unit });
        } },
      ],
      install(battle, unit) {
        // 鬼人化: count her attacks per target (the six-hit is every third one, its tail the next attack); last, after
        // every other beforeAttack handler, on the targets the attack keeps
        if (picked === S1) {
          battle.on('beforeAttack', (c) => {
            if (c.attacker !== unit) return;
            const m = unit.mem.yatoCombo;
            if (!m || !skillOn(unit, S1)) return;
            const t = (c.targets || []).find((e) => e && e.alive);
            if (!t) return;
            if (m.tail) { m.tail = false; m.hits = COMBO_TAIL; return; }
            const n = (m.count.get(t) ?? 0) + 1;
            m.count.set(t, n);
            if (n % COMBO_EVERY === 0) { m.hits = COMBO_HEAD; m.tail = true; } else m.hits = DOUBLE;
          }, { owner: unit, priority: -1000 });
        }
        // 空中回旋乱舞: the slashes that landed (a hit a 屏障 absorbs counts, a dodged / cancelled one does not)
        if (picked === S3) {
          battle.on('damaged', (c) => {
            if (c.source === unit && c.dmg && Array.isArray(c.dmg.tags) && c.dmg.tags.includes(TAG_DASH)) unit.mem.yatoDashLanded = (unit.mem.yatoDashLanded | 0) + 1;
          }, { owner: unit });
        }
        // 乱舞 / 空中回旋乱舞: 晕眩 / 冻结 / 沉睡 immunity; 空中回旋乱舞: the other resistible statuses at 1/1000
        if (picked === S2 || picked === S3) {
          battle.on('beforeStatus', (c) => {
            if (c.target !== unit || !skillOn(unit) || (unit.skill.id !== S2 && unit.skill.id !== S3)) return;
            if (HARD_IMMUNE.has(c.status)) { c.cancel = true; return; }
            if (unit.skill.id === S3 && RESIST_STATUSES.has(c.status)) c.duration *= DASH_STATUS_SCALE;
          }, { owner: unit });
        }
        // EXE-Y "周围四格没有友方干员时攻击力+10%"
        if (lonelyAtk > 0) toggleBuff(battle, unit, LONELY, () => noOperatorBeside(battle, unit), { atkPct: lonelyAtk });
        // EXE-Y stage 2+ 术法充盈: +damage_up per arts damage instance dealt (≤ max_stack_cnt), on every arts damage of hers
        const arcUp = num(mb.damage_up), arcCap = Math.floor(num(mb.max_stack_cnt));
        if (arcUp > 0 && arcCap > 0) {
          battle.on('hit', (c) => {
            if (c.source !== unit || !c.dmg || c.dmg.type !== 'arts' || !c.target || c.target.side !== 'enemy') return;
            const s = unit.findBuff(ARCANE);
            if (s) c.dmg.mul *= 1 + arcUp * Math.min(arcCap, s.stacks);
          }, { owner: unit });
          battle.on('damaged', (c) => {
            if (c.source !== unit || c.type !== 'arts' || !c.target || c.target.side !== 'enemy' || !up(unit)) return;
            battle.addBuff(unit, { key: ARCANE, refresh: 'stack', stacks: 1, maxStacks: arcCap, tags: ['module'] });
          }, { owner: unit });
        }
        // EXE-Y stage 2+ "首次撤退再部署时间为0": no redeploy timer for her first leave of the field (until she is back)
        if (mb.respawn_time != null && num(mb.respawn_time, -1) === 0) {
          battle.addBuff(unit, { key: FIRST_OUT, mods: { redeployMul: 0 }, persist: true, allowDead: true, tags: ['module'] });
          battle.on('death', (c) => { if (c.unit === unit) unit.mem.yatoLeft = true; }, { owner: unit });
          battle.on('deploy', (c) => { if (c.unit === unit && unit.mem.yatoLeft) battle.removeBuff(unit, FIRST_OUT); }, { owner: unit });
        }
      },
    };
  },
};
