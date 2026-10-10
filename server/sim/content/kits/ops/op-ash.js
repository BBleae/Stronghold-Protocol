// server/sim/content/kits/ops/op-ash.js — 灰烬 (char_456_ash) 自选 operator kit: 6★ 速射手 (狙击), a collab pick of this fork
// (tools/build-data.mjs FORK_INCLUDE_COLLAB_PICKS, the fork owner's decision of 2026-10-08: the 7 collab 6★ upstream leaves
// out of 自选 come back in full) of the tier-5 and tier-6 自选 slots; every skill, both talents, the trait and both modules
// at every form. Kit contract and the 自选 rules: ../README.md ("How to add an operator (自选)"). The fork's 外援 kit of
// 0.1.x (b8c80254 server/sim/content/kits/waiguan/char_456_ash.js) was its first version; this one replaces it.
//
// Forms (data/backups.json units.char_456_ash, the DIY slot statuses): normal = E2 Lv1, skills at rank 4, no module; elite =
// E2 Lv60, rank 7, the picked module at stage 1 (tier 5) or 3 (tier 6). Full potential (the owner's decision of 2026-10-07).
// Sources: character_table / skill_table / battle_equip_table (zh_CN, as built into backups.json); the official buff
// templates (ArknightsGameData zh_CN battle/buff_template_data.json: ash_t_2, ash_s_2[trigger_ability] / [atk_scale] /
// [interrupt], ash_e_t_10, ash_e_003_t[damage_scale], ash_e_003_trait); PRTS 灰烬 (备注 of 辅助装备 "攻击范围内无可选目标时，
// 无法触发本天赋" / "闪光弹影响半径为1", 突击手 "费用减少效果于战斗开始后生效至待部署区的灰烬自己，于灰烬首次部署后失效", 突击战术
// "因弹药数打完而导致当次技能自动结束后，下次开启技能时装有的弹药数将少1发（变为30/31发弹药）", 攻坚榴弹 "破墙弹推动半径1.2（碰撞箱
// 判定），爆炸半径1.5（中点判定）" / "破墙弹由地面地形飞向高台或者地图边界时，在地块边界中点上爆炸；没有任何阻挡的情况下，将在自身面前
// 第4格的中心处爆炸").
//
// - Trait (速射手) "优先攻击空中单位": the fastshot profile (professions.js: ranged physical arrows, hits air, priority 'fly').
//   Module MAR-X 刺针式合金爆破弹 adds "攻击空中单位时攻击力提升至110%" (trait bb atk_scale): the profile's flyScale on her
//   attacks; ash_e_003_trait is an AtkScaleUp against FLY targets with no apply-way filter, so the kit puts the same ×flyScale
//   on the damage it deals itself (S3) — profileMul. Its stage 3 talent change is under T1 below.
// - Module MAR-Y 破墙榴弹战术收纳包: "范围内存在地面敌人时攻击速度+8" (the hidden module talent's attack_speed, ash_e_t_10 — an
//   ATTACK_SPEED ADDITION): ASPD +attack_speed exactly while a selectable ground enemy stands in her current range (checked
//   every tick, toggleBuff). Its stage 3 talent change (突击手 runtime_cost −5) comes with the composed record.
// - T1 辅助装备 "部署后立即对攻击范围内一个敌人投掷闪光弹，使其和周围敌人晕眩4秒": at every deployment, the first enemy of her
//   attack selection (her range + the enemies she blocks, flyers first — targeting.js sortEnemyTargets with her profile) is
//   the target; none ⇒ nothing (PRTS 备注). That enemy and every selectable enemy within FLASH_RADIUS of it (中点判定) are
//   stunned `stun` s. MAR-X stage 2+ (talent change scale_duration / damage_scale, ash_e_003_t[damage_scale]: ON_TAKE_DAMAGE,
//   only damage whose source is her, PHYSICAL — a 伤害倍率): for scale_duration s her physical damage to each of them
//   ×damage_scale — a mark per copy of her (`dmg.mul`).
// - T2 突击手 "首次部署时部署费用-3，部署后立即获得20技力" (full potential): the deploy cost (`unit.base.cost`, what Battle.redeploy
//   and the automatic redeploy charge) is runtime_cost lower from the battle start until her first deployment, the full cost
//   from then on (PRTS 备注); the battle-start deployment is free in this mode (DESIGN §5.5), so it shows only on a first
//   deployment that is paid. `sp` SP at her first deployment only (ash_t_2: CheckBuildCnt ≤ 1 before ModifySp); 联防's
//   carried SP replaces it (Battle._deploy).
// - S1 支援射击 (AUTO, 持续时间无限): ATK +atk, every attack hits attack@times times ("2连击"); a toggle until she leaves the
//   field. An AUTO skill acting on herself fires as soon as its SP is full (`trigger: 'SP_FULL'`, the owner's AUTO rule,
//   kits/README.md checklist 5; the data's DEFAULT would wait for an attack).
// - S2 突击战术 (MANUAL, ammo, data DEFAULT: it changes no range): "攻击装有31发子弹" (the number exists in the text only:
//   AMMO_RE, fallback AMMO_DEFAULT). At the cast "立即触发第一天赋" (ash_s_2[trigger_ability]: T1's flashbang, with its MAR-X
//   mark; no target ⇒ nothing). Attack interval +base_attack_time s (flat, batMod). ash_s_2[atk_scale] (ON_CALCULATE_DAMAGE,
//   CheckAbnormalFlag STUNNED on the target, AtkScaleUp with no apply-way filter): while it runs, her damage to a 晕眩 enemy
//   (the catalogue stun — not 冻结 / 沉睡 / 浮空) ×atk_scale before DEF — the 晕眩 checked as the bullet lands, the skill at
//   its launch (every bullet of the magazine carries it, the last ones that land after the 31st shot ended it included). "期间可随时停止技能" is a manual stop: none in this
//   mode. A cast that ran out of bullets leaves the next cast of the same deployment one bullet short (PRTS 备注 "变为30/31发
//   弹药": the bar shows 30 of 31) — every cast here ends that way, so from the second cast of a deployment on she holds 30.
// - S3 攻坚榴弹 (MANUAL, data SKILL_RANGE on its 技能范围 4-1: her tile and the 4 ahead): the grenade flies along her facing to
//   the centre of the 4th tile ahead (the reach of the skill grid); leaving a LOW tile for a non-LOW one (高台) it bursts at
//   once on that tile edge's midpoint for hitwall_scale × ATK ("从低地撞到高台直接爆炸") — the tiles are the whole stage's, so
//   the 高台 rows just outside the field rect (rows 8 / 13 of the normal field, row 6 above the boss field: HIGH in the stage
//   data and in the official levels alike) are such a 高台 too; leaving the stage (地图边界) it bursts on that edge for
//   not_hitwall_scale × ATK, else at the line's end for not_hitwall_scale × ATK. Every enemy whose collider comes within
//   PATH_RADIUS of its flight (碰撞箱判定: a point unit by its position, a huge one by its rectangle) and is not behind her
//   takes atk_scale × ATK physical, in the order the grenade reaches them; the burst hits every enemy within range_radius
//   (中点判定) of its point — both sets taken where the enemies stand at the cast (the flight takes no time, so the burst
//   comes in the same instant as the contacts; a push is a slide over many frames, PRTS 推与拉) — then each path victim
//   still alive is pushed with 力度 `force` (中等 1 / 较大 2) along her facing ("向后").
//   "每次部署只能释放2次" (CASTS_RE, fallback CASTS_DEFAULT): after that many casts in one deployment she gains no SP for it
//   until she is deployed again.
// fx: 'sunBurst' (flashbang), 'explode' (S3 burst). RNG: none.
//
// [ASSUMED] (no source settles it):
// - the flashbang's radius of 1 (PRTS) is a 中点判定 around the struck enemy, as a splash around a target (body.js); it needs
//   an enemy at the deployment (no throw later — in this mode the battle-start deployment comes before any enemy, so it
//   shows on redeploys and S2 only); the MAR-X mark goes on every enemy the flash reaches, a stun-immune one too;
// - the grenade's flight takes no time (so every push comes after the burst: an enemy on the burst tile takes the burst
//   although the push then carries it out, one 2 tiles short is not pushed into it); an enemy it touches is hit once;
//   enemies behind her (projection on her facing < 0) are not "沿途"; its push keeps her facing whatever the angle (fixed);
//   its path and burst reach flyers too (static bodies: no push); leaving the field rect onto a tile it does not crash on
//   (LOW ground beyond the rect — the partner's half of the normal field — or a step from a 高台) ends its flight on that
//   edge for not_hitwall_scale, as the 地图边界 (no enemy of this battle stands beyond the rect);
// - S2's 30-bullet reload holds within one deployment (a redeployment starts at 31 again).

import { num, talentBb, moduleBb, skillRec, toggleBuff, batMod, giveSp, up } from '../shared/tier1.js';
import { sortEnemyTargets } from '../../../targeting.js';
import { bodyDist } from '../../../body.js';
import { hypot } from '../../../detmath.js';

const S1 = 'skchr_ash_1';
const S2 = 'skchr_ash_2';
const S3 = 'skchr_ash_3';
/** PRTS 辅助装备 备注 "闪光弹影响半径为1" (tiles, 中点判定 [ASSUMED]). */
export const FLASH_RADIUS = 1;
/** PRTS 攻坚榴弹 备注 "破墙弹推动半径1.2（碰撞箱判定）" (tiles). */
export const PATH_RADIUS = 1.2;
/** "自身面前第4格" — the reach when the skill record carries no grid. */
const REACH_DEFAULT = 4;
/** "攻击装有31发子弹" / "每次部署只能释放2次": numbers that exist only in the skill text (parsed, these are the fallbacks). */
const AMMO_RE = /攻击装有(\d+)发子弹/, AMMO_DEFAULT = 31;
const CASTS_RE = /每次部署只能释放(\d+)次/, CASTS_DEFAULT = 2;
/** S2: the launches whose bullets may still be in flight (whether S2 ran at each one, by attackId). */
const S2_ROUNDS_KEPT = 16;
/** Damage tags: S3 grenade on its path; S3 burst. */
export const PATH_TAG = 'ash:grenadePath';
export const BLAST_TAG = 'ash:grenadeBlast';
/** Key of the MAR-X flashbang mark of one copy of her (her own damage only). */
export const markKey = (unit) => `ash:flash:${unit.id}`;

const parseN = (text, re, d) => { const m = String(text ?? '').match(re); return m ? +m[1] : d; };
/** The fastshot profile's damage multiplier on `target` (MAR-X ×flyScale vs flyers) for damage the kit deals itself. */
function profileMul(battle, unit, target) {
  const f = unit.profile?.dmgMul;
  const m = typeof f === 'function' ? f(battle, unit, target) : f;
  return typeof m === 'number' && Number.isFinite(m) ? m : 1;
}

/** Her attack selection right now: her current range plus the enemies she blocks, in the engine's order (flyers first). */
function flashTarget(battle, unit) {
  const prof = unit.profile;
  const list = battle.enemiesInKeys(unit.rangeKeys, unit, prof);
  for (const e of battle.blockedTargets(unit, prof)) if (!list.includes(e)) list.push(e);
  return sortEnemyTargets(battle, unit, list, prof?.priority ?? null)[0] ?? null;
}

/** T1 辅助装备 (also S2's "立即触发第一天赋"): returns the struck enemy, or null when none was selectable. */
function flashbang(battle, unit, t0) {
  const dur = num(t0.stun);
  if (!up(unit) || !(dur > 0)) return null;
  const tgt = flashTarget(battle, unit);
  if (!tgt) return null;
  const markDur = num(t0.scale_duration), markMul = num(t0.damage_scale, 1);
  battle.fx('sunBurst', { x: tgt.x, y: tgt.y, id: unit.id, r: FLASH_RADIUS });
  for (const e of battle.foesInRadius(tgt.x, tgt.y, FLASH_RADIUS, true)) {
    battle.applyStatus(e, 'stun', { duration: dur, source: unit });
    if (markDur > 0 && markMul !== 1 && e.alive) battle.addBuff(e, { key: markKey(unit), duration: markDur, source: unit, data: { mul: markMul } });
  }
  return tgt;
}

/** The tiles ahead the grenade may fly (the skill grid's furthest tile on her own row, facing RIGHT frame). */
function reachOf(rec) {
  const g = Array.isArray(rec?.rangeGrid) ? rec.rangeGrid : null;
  const ahead = g ? g.filter((p) => p[0] === 0 && p[1] > 0).map((p) => p[1]) : [];
  return ahead.length ? Math.max(...ahead) : REACH_DEFAULT;
}

/**
 * S3: where the grenade bursts — `{ x, y, crash }` — tracing the stage's tiles ahead of her: a LOW → non-LOW step bursts on
 * that edge (crash: hitwall_scale), inside the field rect or just beyond it (the 高台 rows around the field); a step off the
 * stage, or out of the rect onto a tile it does not crash on, bursts on that edge; else the centre of the `reach`-th tile.
 */
export function grenadeEnd(battle, unit, reach) {
  const [fr, fc] = unit.fwd;
  const g = battle.grid;
  let wasLow = g.isLow(unit.tileR, unit.tileC);
  let k = reach, crash = false;
  for (let i = 1; i <= reach; i++) {
    const r = unit.tileR + fr * i, c = unit.tileC + fc * i;
    if (!g.inBounds(r, c)) { k = i - 0.5; break; }                 // 地图边界
    const low = g.isLow(r, c);
    if (wasLow && !low) { k = i - 0.5; crash = true; break; }      // 从低地撞到高台
    if (!g.inRect(r, c)) { k = i - 0.5; break; }                   // the end of this battle's field [ASSUMED]
    wasLow = low;
  }
  return { x: unit.tileC + fc * k, y: unit.tileR + fr * k, crash };
}

/** S3: the grenade's flight, pushes and burst (header). */
function grenade(battle, unit, bb, reach) {
  const [fr, fc] = unit.fwd;
  const end = grenadeEnd(battle, unit, reach);
  const x0 = unit.tileC, y0 = unit.tileR;
  const len = hypot(end.x - x0, end.y - y0);
  const atk = unit.s.atk;
  // 沿途: enemies within PATH_RADIUS (collider) of the flight segment, ahead of or beside her, by when the grenade reaches them
  const cand = battle.foesInRadius((x0 + end.x) / 2, (y0 + end.y) / 2, len / 2 + PATH_RADIUS, false);
  const along = [];
  for (const e of cand) {
    const t = (e.x - x0) * fc + (e.y - y0) * fr;
    if (t < -1e-9) continue;
    const tc = Math.min(len, t);
    if (bodyDist(e, x0 + fc * tc, y0 + fr * tc) > PATH_RADIUS + 1e-9) continue;
    along.push({ e, t: tc });
  }
  along.sort((a, b) => a.t - b.t || a.e.spawnSeq - b.e.spawnSeq);
  const scale = num(bb.atk_scale), force = num(bb.force);
  const burst = num(end.crash ? bb.hitwall_scale : bb.not_hitwall_scale), radius = num(bb.range_radius);
  // the burst's victims where they stand now: the flight takes no time, so no push has moved anyone yet (header)
  const blast = battle.foesInRadius(end.x, end.y, radius, true);
  const struck = [];
  for (const { e } of along) {
    if (!e.alive || !up(unit)) continue;
    battle.dealDamage(unit, e, { amount: atk * scale * profileMul(battle, unit, e), type: 'phys', isSkill: true, tags: ['skill', PATH_TAG] });
    struck.push(e);
  }
  battle.fx('explode', { x: end.x, y: end.y, id: unit.id, r: radius });
  for (const e of blast) {
    if (!e.alive) continue;
    battle.dealDamage(unit, e, { amount: atk * burst * profileMul(battle, unit, e), type: 'phys', isSkill: true, tags: ['skill', BLAST_TAG] });
  }
  const dir = { x: fc, y: fr };
  for (const e of struck) if (e.alive) battle.push(e, force, { from: unit, dir, fixed: true });
}

export default {
  char_456_ash: (bb, chess, def) => {
    const t0 = talentBb(chess, 0);       // 辅助装备 (MAR-X stage 2+: scale_duration / damage_scale)
    const t1 = talentBb(chess, 1);       // 突击手 (MAR-Y stage 2+: runtime_cost −5)
    const hidden = moduleBb(chess);      // MAR-Y: attack_speed with a ground enemy in range
    const picked = chess?.skill?.skillId ?? def?.skill?.id ?? null;
    const r1 = skillRec(chess, S1), r2 = skillRec(chess, S2), r3 = skillRec(chess, S3);
    const b1 = r1?.bb ?? {}, b2 = r2?.bb ?? {}, b3 = r3?.bb ?? {};
    const ammo = parseN(r2?.desc, AMMO_RE, AMMO_DEFAULT);
    const casts = parseN(r3?.desc, CASTS_RE, CASTS_DEFAULT);
    const reach = reachOf(r3);
    return {
      skills: {
        [S1]: {
          kind: 'toggle', trigger: 'SP_FULL',
          mods: { atkPct: num(b1.atk) },
          attack: { hits: Math.max(1, Math.floor(num(b1['attack@times'], 1))) },
        },
        [S2]: {
          kind: 'ammo', ammo,
          mods: { batPct: batMod(b2.base_attack_time, chess, r2?.desc ?? '') },
          onStart({ battle, unit, skill }) {
            // the reload after a magazine that ran dry: one bullet short (PRTS "变为30/31发弹药")
            if (unit.mem.ashDrySeq === unit.deploySeq && skill.ammoLeft > 1) skill.addAmmo(-1);
            flashbang(battle, unit, t0);
          },
          onEnd({ unit, reason }) { if (reason === 'ammo') unit.mem.ashDrySeq = unit.deploySeq; },
        },
        [S3]: {
          kind: num(r3?.maxChargeTime, 1) > 1 ? 'charges' : 'instant',
          onStart({ battle, unit }) {
            const m = unit.mem;
            m.ashS3 = m.ashS3?.seq === unit.deploySeq ? { seq: unit.deploySeq, n: m.ashS3.n + 1 } : { seq: unit.deploySeq, n: 1 };
            grenade(battle, unit, b3, reach);
          },
        },
      },
      talents: [
        { install(battle, unit) { // 辅助装备: the flashbang at every deployment
          battle.on('deploy', (c) => { if (c.unit === unit) flashbang(battle, unit, t0); }, { owner: unit });
        } },
        { install(battle, unit) { // 突击手: the cost until her first deployment, the SP at it
          const cut = Math.min(Math.max(0, -num(t1.runtime_cost)), Math.max(0, unit.base.cost));
          if (cut > 0) { unit.base.cost -= cut; unit.mem.ashCostCut = cut; }
          const sp = num(t1.sp);
          battle.on('deploy', (c) => {
            if (c.unit !== unit) return;
            unit.mem.ashBuilds = num(unit.mem.ashBuilds) + 1;
            if (unit.mem.ashBuilds > 1) return;
            if (unit.mem.ashCostCut > 0) { unit.base.cost += unit.mem.ashCostCut; unit.mem.ashCostCut = 0; }
            if (sp > 0) giveSp(unit, sp, 'talent');
          }, { owner: unit, priority: 10 });
        } },
      ],
      install(battle, unit) {
        // MAR-Y: ASPD +attack_speed while a selectable ground enemy stands in her range
        const aspd = num(hidden.attack_speed);
        if (aspd) {
          toggleBuff(battle, unit, 'module:ash:groundAspd',
            () => battle.enemiesInKeys(unit.rangeKeys, unit, { canHitFly: false, groundOnly: true }).length > 0, { aspd });
        }
        // S2 ×atk_scale on a 晕眩 enemy while it runs; MAR-X flashbang mark ×damage_scale on her physical damage
        const s2Scale = picked === S2 ? num(b2['ash_s_2[atk_scale].atk_scale'], 1) : 1;
        const marks = num(t0.damage_scale, 1) !== 1 && num(t0.scale_duration) > 0;
        // a bullet of the magazine keeps the skill's bonus when it lands after the skill ended (the 31st shot ends it in
        // the engine; PRTS 突击战术 备注: the skill still runs at 0 ammo): settled at the launch by its attackId, the
        // last S2_ROUNDS_KEPT launches (as 烛煌 S3 / 号角 S2 / 焰狐龙梓兰's 强击瓶专家)
        const s2Shots = new Map();
        if (s2Scale !== 1) {
          battle.on('attack', (c) => {
            if (c.attacker !== unit || !c.attackId) return;
            s2Shots.set(c.attackId, !!(unit.skill?.active && unit.skill.id === S2));
            if (s2Shots.size > S2_ROUNDS_KEPT) s2Shots.delete(s2Shots.keys().next().value);
          }, { owner: unit });
        }
        const s2On = (d) => (d.attackId && s2Shots.has(d.attackId) ? s2Shots.get(d.attackId) : !!(unit.skill?.active && unit.skill.id === S2));
        if (s2Scale !== 1 || marks) {
          battle.on('hit', (c) => {
            const t = c.target, d = c.dmg;
            if (c.source !== unit || !t || t.side !== 'enemy') return;
            if (s2Scale !== 1 && t.hasBuff('stun') && s2On(d)) d.amount *= s2Scale;
            if (marks && d.type === 'phys') {
              const m = t.findBuff(markKey(unit));
              if (m && m.source === unit) d.mul *= num(m.data?.mul, 1);
            }
          }, { owner: unit });
        }
        // S3: "每次部署只能释放N次" — the count restarts at every deployment; spent ⇒ no SP until the next one
        if (picked === S3) {
          battle.on('spGain', (c) => {
            if (c.unit !== unit) return;
            const m = unit.mem.ashS3;
            if (m && m.seq === unit.deploySeq && m.n >= casts) c.amount = 0;
          }, { owner: unit, priority: -100 });
        }
      },
    };
  },
};
