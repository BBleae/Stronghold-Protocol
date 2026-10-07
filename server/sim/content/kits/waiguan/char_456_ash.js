// server/sim/content/kits/waiguan/char_456_ash.js — 灰烬 (狙击 · 速射手 fastshot) 外援 kit (DESIGN §27, docs/WAIGUAN-KITS.md).
//
// Chess ids: chess_char_diy_5_char_456_ash_a/_b, chess_char_diy_6_char_456_ash_a/_b (registered by ./index.js).
// Sources: the records (data/waiguan.json; normal = skill Lv4, elite = Lv7 + module, tier V elite module level 1, tier VI
// level 3) and the official buff templates (ArknightsGameData zh_CN battle/buff_template_data.json: ash_t_2,
// ash_s_2[trigger_ability] / [atk_scale] / [interrupt], ash_e_t_10, ash_e_003_t[damage_scale], ash_e_003_trait).
//
// Trait (速射手 "优先攻击空中单位"): the fastshot profile (professions.js: priority 'fly'; MAR-X's trait atk_scale is its
//   flyScale ×1.1 on her attack hits — ash_e_003_trait AtkScaleUp vs FLY, no apply-way filter, so this kit puts the same
//   ×flyScale on the damage of S3 that it deals itself, as the pool's 空弦 does — kits/tier3.js profileMul).
// S1 支援射击 (AUTO, DEFAULT kept: it fires when SP is full and she is about to attack — an AUTO skill takes no 技能策略):
//   ATK +atk, every attack hits attack@times times ("2连击"), "持续时间无限" ⇒ kind 'toggle' (until she leaves the field).
// S2 突击战术 (MANUAL, DEFAULT kept): an ammo skill of the desc's "攻击装有N发子弹" bullets ("期间可随时停止技能" is a manual
//   stop: none in this mode); at the cast "立即触发第一天赋" (ash_s_2[trigger_ability]: the 辅助装备 flashbang below, with
//   its module upgrade); base_attack_time (flat seconds, kits/tier1.js batMod); her damage to a 晕眩 (STUNNED — the stun
//   status, not 冻结 / 沉睡 / 浮空) enemy: ATK ×ash_s_2[atk_scale].atk_scale (ON_CALCULATE_DAMAGE AtkScaleUp: on the
//   pre-mitigation amount) while the skill runs.
// S3 攻坚榴弹 (MANUAL, SKILL_RANGE + the record's customRangeGrid kept: an enemy on her row up to the grid's reach): the
//   grenade runs along her facing over the skill grid's line (rangeId 4-1: her tile, then 4 tiles ahead); every enemy on a
//   tile it passes takes atk_scale × ATK physical and is pushed forward with 力度 `force` (较大力度 2 / 中等力度 1:
//   Battle.push, fixed direction — "向后…推动" = away from her); moving from a LOW tile into a non-LOW one (高台) it bursts
//   there at once for hitwall_scale × ATK ("从低地撞到高台直接爆炸"), else it bursts at the end of the line (or at the field
//   rect's edge) for not_hitwall_scale × ATK; the burst hits every enemy within range_radius (中点判定) of the last tile it
//   reached, after the pushes. "每次部署只能释放N次" (N from the desc): after N casts in one deployment she gains no SP
//   for it until she is deployed again (the casts restart at every deployment).
// T1 辅助装备: at every deployment ("部署后立即") she throws a flashbang at the first enemy of her attack selection (range
//   + blocked, flyers first) — none ⇒ nothing; that enemy and every selectable one within FLASH_RADIUS of it (中点判定)
//   are stunned `stun` s. Module MAR-X level 3 (talent change scale_duration / damage_scale): for scale_duration s her
//   physical damage to each of them ×damage_scale (ash_e_003_t[damage_scale]: ON_TAKE_DAMAGE, only damage whose source
//   is her — a mark per copy of her, after mitigation: dmg.mul).
// T2 突击手 (DP, REQUIREMENTS §1): "首次部署时部署费用−N" (runtime_cost) — her deploy cost (`unit.base.cost`, what
//   Battle.redeploy / the automatic redeploy charge her player) is N lower until her first deployment of the battle and
//   back to the full cost from then on (the discount is that deployment's; the initial deployment of a battle is free in
//   this mode — DESIGN §5.5 — so it only shows when her first deployment is a paid one). "部署后立即获得N技力": `sp` SP
//   at her first deployment only (ash_t_2: CheckBuildCnt ≤ 1 before ModifySp); 联防's carried SP replaces it (Battle._deploy).
// Module MAR-Y (chess.module.type, its hidden part attack_speed — ash_e_t_10): ASPD +attack_speed while a ground enemy
//   she may select stands in her current range (checked every tick, as the pool's toggleBuff). Its level 3 talent change
//   (runtime_cost −5) comes through the record.
// fx: 'sunBurst' (flashbang), 'explode' (S3 burst). RNG: none.
//
// [ASSUMED] (no data / PRTS unreachable): FLASH_RADIUS (the flashbang's "周围" is in no blackboard: the pool's radius for
//   "周围" around a target, 空弦 AROUND_R / RING1); the flashbang needs an enemy at the deployment (no throw later — in
//   this mode the battle-start deployment comes before any enemy, so it shows on redeploys and S2 only); the S3 burst is
//   centred on the last tile the grenade reached (the crash point's own tile, not the wall edge); S3 hits flyers too.

import { num, tal, lazySkills, mods, bv, parseN, batMod, instantKindOf, gridOf, giveSp, toggleBuff, attackCandidates, RING1, ANY } from './_lib.js';
import { COLS } from '../../../constants.js';

const S1 = 'skchr_ash_1', S2 = 'skchr_ash_2', S3 = 'skchr_ash_3';
/** The flashbang's "使其和周围敌人" radius (tiles, 中点判定) [ASSUMED: no blackboard key — RING1, the pool's "周围"]. */
const FLASH_RADIUS = RING1;
/** Module type of 破墙榴弹战术收纳包 (ASPD with a ground enemy in range). */
const MAR_Y = 'MAR-Y';
/** Damage tags: S3 grenade on its path; S3 burst. */
const PATH_TAG = 'ashGrenadePath', BLAST_TAG = 'ashGrenadeBlast';
/** "攻击装有N发子弹" / "每次部署只能释放N次" — numbers that exist only in the skill text. */
const AMMO_RE = /攻击装有(\d+)发子弹/, CASTS_RE = /每次部署只能释放(\d+)次/;

/** 晕眩 (the STUNNED flag of the stun status; 冻结 / 沉睡 / 浮空 are other states). */
const stunned = (e) => !!e && e.buffs.some((b) => b.status === 'stun');
/** The fastshot profile's damage multiplier on `target` (MAR-X ×flyScale vs flyers) for damage the kit deals itself. */
function profileMul(battle, unit, target) {
  const f = unit.profile?.dmgMul;
  const m = typeof f === 'function' ? f(battle, unit, target) : f;
  return typeof m === 'number' && Number.isFinite(m) ? m : 1;
}
/** Key of the MAR-X flashbang mark of one copy of her (her own damage only). */
const markKey = (unit) => `ash:flash:${unit.id}`;

/** T1 辅助装备 (also S2's "立即触发第一天赋"): returns the struck enemy, or null when none was in range. */
function flashbang(battle, unit, t0) {
  const dur = num(t0.stun);
  const tgt = attackCandidates(battle, unit)[0];
  if (!tgt || !(dur > 0)) return null;
  const markDur = num(t0.scale_duration), markMul = num(t0.damage_scale);
  battle.fx('sunBurst', { x: tgt.x, y: tgt.y, id: unit.id, r: FLASH_RADIUS });
  for (const e of battle.foesInRadius(tgt.x, tgt.y, FLASH_RADIUS, true)) {
    battle.applyStatus(e, 'stun', { duration: dur, source: unit });
    if (markDur > 0 && markMul > 0 && e.alive) battle.addBuff(e, { key: markKey(unit), duration: markDur, source: unit, data: { mul: markMul } });
  }
  return tgt;
}

/** S3: the grenade's run and burst (header). `reach` = tiles ahead on the skill grid's line. */
function grenade(battle, unit, bb, reach) {
  const [fr, fc] = unit.fwd;
  const dir = { x: fc, y: fr };
  const atk = unit.s.atk * unit.s.atkScaleMul;
  const force = num(bb.force);
  const hit = new Set();
  let last = null, crashed = false, wasLow = false;
  for (let k = 0; k <= reach; k++) {
    const r = unit.tileR + fr * k, c = unit.tileC + fc * k;
    if (!battle.grid.inRect(r, c)) break;
    const low = battle.grid.isLow(r, c);
    if (wasLow && !low) { crashed = true; break; }
    wasLow = low;
    last = [r, c];
    for (const e of battle.enemiesInKeys([r * COLS + c], unit, ANY)) {
      if (hit.has(e)) continue;
      hit.add(e);
      battle.dealDamage(unit, e, { amount: atk * num(bb.atk_scale) * profileMul(battle, unit, e), type: 'phys', isSkill: true, tags: ['skill', PATH_TAG] });
      if (e.alive) battle.push(e, force, { from: unit, dir, fixed: true });
    }
  }
  if (!last) return;
  const scale = num(crashed ? bb.hitwall_scale : bb.not_hitwall_scale), radius = num(bb.range_radius);
  battle.fx('explode', { x: last[1], y: last[0], id: unit.id, r: radius });
  for (const e of battle.foesInRadius(last[1], last[0], radius, true)) {
    battle.dealDamage(unit, e, { amount: atk * scale * profileMul(battle, unit, e), type: 'phys', isSkill: true, tags: ['skill', BLAST_TAG] });
  }
}

export default function ash(bb, chess, def) {
  const t0 = tal(chess, 0), t1 = tal(chess, 1);
  const sid = chess?.skill?.skillId ?? def?.skill?.id ?? null;
  const mod = chess?.module?.active ? chess.module : null;
  const s2Rec = (chess?.skills ?? []).find((s) => s && s.skillId === S2);
  const s3Rec = (chess?.skills ?? []).find((s) => s && s.skillId === S3);

  return {
    skills: lazySkills(chess, {
      [S1]: (rec) => ({
        kind: 'toggle',
        mods: mods({ atkPct: num(rec.bb?.atk) }),
        attack: { hits: Math.max(1, Math.floor(num(rec.bb?.['attack@times']))) },
      }),
      [S2]: (rec) => ({
        kind: 'ammo',
        ammo: parseN(rec.desc, AMMO_RE, 0),
        mods: mods({ batPct: batMod(rec.bb?.base_attack_time, chess, rec.desc ?? '') }),
        onStart({ battle, unit }) { flashbang(battle, unit, t0); },
      }),
      [S3]: (rec) => {
        const cells = (gridOf(rec) ?? []).filter((p) => p[0] === 0 && p[1] >= 0);
        const reach = cells.reduce((m, p) => Math.max(m, p[1]), 0);
        return {
          kind: instantKindOf(rec),
          onStart({ battle, unit }) {
            unit.mem.ashS3Casts = num(unit.mem.ashS3Casts) + 1;
            grenade(battle, unit, rec.bb ?? {}, reach);
          },
        };
      },
    }),
    talents: [
      { install(battle, unit) { // 辅助装备: the flashbang at every deployment
        battle.on('deploy', (c) => { if (c.unit === unit) flashbang(battle, unit, t0); }, { owner: unit });
      } },
      { install(battle, unit) { // 突击手: the first deployment's cost and SP
        const cut = Math.min(Math.max(0, -num(t1.runtime_cost)), Math.max(0, unit.base.cost));
        if (cut > 0) { unit.base.cost -= cut; unit.mem.ashCostCut = cut; }
        const sp = num(t1.sp);
        battle.on('deploy', (c) => {
          if (c.unit !== unit || unit.mem.ashDeployed) return;
          unit.mem.ashDeployed = true;
          if (unit.mem.ashCostCut > 0) { unit.base.cost += unit.mem.ashCostCut; unit.mem.ashCostCut = 0; }
          if (sp > 0) giveSp(unit, sp, 'talent');
        }, { owner: unit, priority: 10 });
      } },
    ],
    install(battle, unit) {
      // MAR-Y: ASPD while a ground enemy stands in her range
      const aspd = mod && mod.type === MAR_Y ? num(tal(chess, -1).attack_speed) : 0;
      if (aspd > 0) {
        toggleBuff(battle, unit, 'ash:groundAspd',
          () => battle.enemiesInKeys(unit.rangeKeys, unit, { canHitFly: false, groundOnly: true }).length > 0, { aspd });
      }
      // S2 ×atk_scale vs 晕眩; MAR-X flashbang mark ×damage_scale on her physical damage
      const s2Scale = sid === S2 ? bv(s2Rec?.bb, 'atk_scale') : 0;
      const markMul = num(t0.damage_scale);
      if (s2Scale > 0 || markMul > 0) {
        battle.on('hit', (c) => {
          const t = c.target, d = c.dmg;
          if (c.source !== unit || !t || t.side !== 'enemy') return;
          if (s2Scale > 0 && d.isAttack && unit.skill?.active && unit.skill.id === S2 && stunned(t)) d.amount *= s2Scale;
          if (markMul > 0 && d.type === 'phys') {
            const m = t.findBuff(markKey(unit));
            if (m && m.source === unit) d.mul *= markMul;
          }
        }, { owner: unit });
      }
      // S3: "每次部署只能释放N次" — the count restarts at every deployment; spent ⇒ no SP until the next one
      if (sid === S3) {
        const max = parseN(s3Rec?.desc, CASTS_RE, Infinity);
        battle.on('deploy', (c) => { if (c.unit === unit) unit.mem.ashS3Casts = 0; }, { owner: unit, priority: 10 });
        battle.on('spGain', (c) => { if (c.unit === unit && num(unit.mem.ashS3Casts) >= max) c.amount = 0; }, { owner: unit, priority: -100 });
      }
    },
  };
}
