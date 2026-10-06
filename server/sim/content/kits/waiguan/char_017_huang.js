// server/sim/content/kits/waiguan/char_017_huang.js — 煌 (近卫 · 强攻手 centurion) 外援 kit (DESIGN §27, KIT_GUIDE.md).
//
// Chess ids: chess_char_diy_5_char_017_huang_a/_b, chess_char_diy_6_char_017_huang_a/_b (registered by ./index.js).
// Sources: the records (data/waiguan.json; normal = skill Lv4, elite = Lv7 + module) and the official buff templates
// (ArknightsGameData zh_CN battle/buff_template_data.json: huang_s_3, huang_t_1[heal]/[lock], huang_t_2[…],
// huang_e_003[lock]/[heal]) for what the texts leave open.
//
// Trait (强攻手 "同时攻击阻挡的所有敌人"): professions.js SUB.centurion hitAllBlocked — not re-implemented.
// S1 强力击·γ型 (AUTO, attack SP, instant): the next attack ×atk_scale — on every enemy she blocks (the trait). 技能策略:
//   AUTO "下次攻击" ⇒ the data rule DEFAULT (cast at that attack), kept.
// S2 链锯延伸模块 (AUTO, toggle "持续时间无限"): ATK +atk, DEF +def, the skill's own range 2-2 (攻击距离加长). An AUTO skill has
//   no 技能策略 row: the data rule DEFAULT is kept (pool precedent for AUTO 持续时间无限 attack skills: 铃兰 S2, 耀骑士临光 S1,
//   乌尔比安 S2 — cast at her first attack once SP is full).
// S3 沸腾爆裂 (MANUAL, DEFAULT kept, duration 10 s): ATK and DEF grow from +0 to +atk / +def over the skill (huang_s_3
//   RemainingRatioToAttributeModifier on ATK/DEF, MULTIPLIER = the additive atkPct/defPct bucket) in RAMP_STEP (1 s)
//   steps: +atk × ⌊elapsed⌋ / duration [ASSUMED: the pool's reading of the same template node — 卡涅利安 S3, kits/tier4.js,
//   PRTS 备注 "从+0%开始在20秒内线性增加，攻击力每1秒更新1次"; the node's _endTime 1.05 is not modelled]; her attacks cut every
//   enemy of her range (切割 "前方一格内的敌方单位": her 1-1 range = her tile + the tile in front; unblocked enemies there
//   too [ASSUMED]). At the end (not on a knock-out / retreat), in the template's order: she loses hp_ratio × max HP
//   (DamageViaMaxHpRatio PURE, _isUndeadable — never lethal, _skipModifierEvent — no damage event: a 流失 here, the
//   紧急除颤 lock does not stop it), then every enemy of the blast area (blastArea) takes damage_by_atk_scale × her ATK at
//   that moment (the last ramp step) as physical skill damage, flyers too (targetMotion ALL). [ASSUMED: "附近所有敌人" =
//   her attack range + the enemies she blocks — the template's AOEDamage has neither range id nor radius, which reads as
//   the owner's attack range (THRM-EX's talent AOE, same settings, is "周围8格" on its x-4 range); PRTS is not reachable
//   from here to confirm. The owner decides between this and a 3×3: blastArea is the one place to switch.]
// T1 紧急除颤: once per deployment, when her HP falls to ≤ hp_ratio: heal huang_t_1[heal].hp_ratio × max HP, then for
//   huang_t_1[lock].duration s damage cannot take her HP below huang_t_1[lock].min_hp_ratio × max HP (HpNoLessThan…
//   on ON_TAKE_DAMAGE: a 流失 is no damage event and passes). Until it fires, a lethal hit leaves her at 1 HP and fires it
//   [ASSUMED: the prefab buff huang_t_1[undead] — finished by the heal — read as 不死 (UNDEADABLE), the meaning of every
//   official "[undead]" buff template, e.g. monstr_s_3[undead]; the prefab itself is not in the data]. Module CEN-Y: the
//   first stage fires at ≤ 50 % (talent hp_ratio 0.5, 8 s lock); a second stage (hidden part huang_e_003[lock].*:
//   check_hp_ratio 0.25, hp_ratio heal, min_hp_ratio, duration, with its own 不死) is armed once the first is spent. A
//   stage never fires during a lock; it fires at the first hit after the lock [ASSUMED: approximates huang_e_003[heal],
//   which skips its heal while huang_t_1[lock] runs, and a trigger whose polling period is not in data].
//   Re-armed by every deployment, a 【移动】 included (the engine's convention for once-per-deployment effects).
// T2 严酷训练: 15 s (interval) after each deployment 抵抗 (engine `resist` status, value −one_minus_status_resistance =
//   0.5: status durations halved — huang_t_2 → status_resistance[inf]). Module CEN-X: + ATK +atk after 30 s and ASPD
//   +attack_speed after 45 s (huang_t_2[e_002_atk] / [e_002_atk_speed], INFINITY while deployed). A knock-out drops them;
//   the next deployment counts again.
// Module CEN-X (uniequip_002_huang): trait atk_scale — ATK ×1.1 on attacks against blocked enemies, blocked by anyone (the
//   pool's reading of "攻击被阻挡的敌人": 幽灵鲨 CEN-X, 斯卡蒂 DRE-X, 百炼嘉维尔), on the pre-mitigation amount (an ATK scale). CEN-Y (uniequip_003_huang): trait — physical damage taken
//   ×(1 − damage_resistance) while HP > hp_ratio (艾丝黛尔 / 百炼嘉维尔 precedent); hidden part — while HP > hp_ratio her
//   damage ignores def_penetrate_fixed DEF (a stat on her: every damage instance, the S3 blast included).
// fx: 'overload' (S2 / S3 start), 'explode' (S3 end: `tiles` = the blast area's tiles), 'emergency' (T1), 'talent' (T2
// steps). No RNG.

import { num, tal, hiddenBb, lazySkills, mods, gridOf, instantKindOf, live, ANY, hasHp, onHitBy, onHitOn, keyOf } from './_lib.js';
import { isHpLoss } from '../../../damage.js';
import { keyTiles } from '../../fxtiles.js';

const S1 = 'skchr_huang_1', S2 = 'skchr_huang_2', S3 = 'skchr_huang_3';
/** Damage tag of S3's end-of-skill self loss (the 紧急除颤 lock skips it as a 流失 anyway; tests read it). */
const SELF_TAG = 'huangS3Self';
/** Damage tag of S3's end-of-skill blast. */
const BLAST_TAG = 'huangS3Blast';
/** S3 ramp: the ATK / DEF bonus is updated every RAMP_STEP s (header: the pool's 卡涅利安 S3 reading of the same node). */
const RAMP_STEP = 1;

/**
 * S3 end-of-skill blast area [ASSUMED, header]: her current attack range plus the enemies she blocks, flyers included.
 * Returns the tile keys it covers (the fx draws exactly these) and the enemies on them. Switch the area here.
 */
function blastArea(battle, unit) {
  const keys = [...(unit.rangeKeys || [])];
  const hit = battle.enemiesInKeys(keys, unit, ANY);
  for (const e of battle.blockedTargets(unit, ANY)) {
    if (hit.includes(e)) continue;
    hit.push(e);
    if (!keys.includes(keyOf(e))) keys.push(keyOf(e));
  }
  return { keys, hit };
}

/** 紧急除颤 stages of the loadout-resolved record: [{ thr, heal, floor, dur }] in firing order (CEN-Y adds the second). */
function defibStages(chess) {
  const t0 = tal(chess, 0), hb = hiddenBb(chess);
  const out = [];
  if (num(t0.hp_ratio) > 0) {
    out.push({ thr: num(t0.hp_ratio), heal: num(t0['huang_t_1[heal].hp_ratio']), floor: num(t0['huang_t_1[lock].min_hp_ratio']), dur: num(t0['huang_t_1[lock].duration']) });
  }
  const p = 'huang_e_003[lock].';
  if (num(hb[`${p}check_hp_ratio`]) > 0) {
    out.push({ thr: num(hb[`${p}check_hp_ratio`]), heal: num(hb[`${p}hp_ratio`]), floor: num(hb[`${p}min_hp_ratio`]), dur: num(hb[`${p}duration`]) });
  }
  return out;
}

/** 严酷训练 steps of the loadout-resolved record: [{ at, apply(battle, unit) }] (CEN-X adds ATK and ASPD). */
function trainingSteps(chess) {
  const t1 = tal(chess, 1);
  const out = [];
  const resist = Math.min(1, -num(t1.one_minus_status_resistance, num(t1['huang_t_2.one_minus_status_resistance'])));
  const at = num(t1.interval, num(t1['huang_t_2.interval']));
  if (resist > 0 && at > 0) out.push({ at, apply: (battle, unit) => battle.applyStatus(unit, 'resist', { value: resist, source: unit }) });
  const atk = num(t1['huang_t_2[e_002_atk].atk']), atkAt = num(t1['huang_t_2[e_002_atk].interval']);
  if (atk && atkAt > 0) out.push({ at: atkAt, apply: (battle, unit) => battle.addBuff(unit, { key: 'huang:t2atk', mods: { atkPct: atk }, visible: true, tags: ['talent'] }) });
  const as = num(t1['huang_t_2[e_002_atk_speed].attack_speed']), asAt = num(t1['huang_t_2[e_002_atk_speed].interval']);
  if (as && asAt > 0) out.push({ at: asAt, apply: (battle, unit) => battle.addBuff(unit, { key: 'huang:t2aspd', mods: { aspd: as }, visible: true, tags: ['talent'] }) });
  return out;
}

export default function huang(bb, chess) {
  const tb = chess?.trait?.bb ?? {};
  const hb = hiddenBb(chess);

  /** S3: the ramp buff after `elapsed` s of a `dur` s skill — +bonus × ⌊elapsed / RAMP_STEP⌋ steps (set when it changes). */
  const ramp = (battle, unit, rec, elapsed, dur) => {
    const n = Math.max(1, Math.round(dur / RAMP_STEP));
    const k = Math.min(n, Math.floor(elapsed / RAMP_STEP + 1e-6));
    if (unit.mem.huangRamp === k) return;
    unit.mem.huangRamp = k;
    const m = mods({ atkPct: (num(rec.bb?.atk) * k) / n, defPct: (num(rec.bb?.def) * k) / n });
    if (Object.keys(m).length) battle.addBuff(unit, { key: 'huang:s3', mods: m, visible: true, tags: ['skill'] });
    else battle.removeBuff(unit, 'huang:s3');
  };

  return {
    skills: lazySkills(chess, {
      [S1]: (rec) => ({ kind: instantKindOf(rec), attack: { atkScale: num(rec.bb?.atk_scale, 1) } }),
      [S2]: (rec) => ({
        kind: 'toggle',
        mods: mods({ atkPct: num(rec.bb?.atk), defPct: num(rec.bb?.def) }),
        ...(gridOf(rec) ? { targeting: { rangeGrid: gridOf(rec) } } : {}),
        onStart({ battle, unit }) { battle.fx('overload', { x: unit.x, y: unit.y, id: unit.id }); },
      }),
      [S3]: (rec) => ({
        kind: 'duration',
        attack: { hitAllBlocked: false, allInRange: true },
        onStart({ battle, unit }) {
          unit.mem.huangElapsed = 0;
          unit.mem.huangRamp = 0;
          battle.fx('overload', { x: unit.x, y: unit.y, id: unit.id });
        },
        onTick({ battle, unit, skill, dt }) {
          unit.mem.huangElapsed = (unit.mem.huangElapsed ?? 0) + dt;
          ramp(battle, unit, rec, unit.mem.huangElapsed, skill.duration > 0 ? skill.duration : RAMP_STEP);
        },
        onEnd({ battle, unit, reason }) {
          if (reason !== 'death' && unit.alive && unit.deployed) {
            // the self loss first (huang_s_3 ON_SKILL_FINISH order): 流失 of hp_ratio × max HP, never lethal
            const loss = Math.min(unit.s.maxHp * num(rec.bb?.hp_ratio), unit.hp - 1);
            if (loss > 0) battle.loseHp(unit, loss, { source: unit, tags: ['skill', SELF_TAG] });
            if (unit.alive) {
              const atk = unit.s.atk * unit.s.atkScaleMul * num(rec.bb?.damage_by_atk_scale); // the ATK at that moment
              const { keys, hit } = blastArea(battle, unit);
              battle.fx('explode', { x: unit.x, y: unit.y, id: unit.id, tiles: keyTiles(keys) });
              for (const e of hit) if (hasHp(e)) battle.dealDamage(unit, e, { amount: atk, type: 'phys', isSkill: true, tags: ['skill', BLAST_TAG] });
            }
          }
          unit.mem.huangRamp = null;
          battle.removeBuff(unit, 'huang:s3');
        },
      }),
    }),
    talents: [
      { install(battle, unit) { // 紧急除颤 (+ CEN-Y second stage)
        const stages = defibStages(chess);
        if (!stages.length) return;
        const fresh = () => ({ next: 0, lockUntil: -Infinity, floor: 0, hpBefore: 0 });
        unit.mem.huangDefib = fresh();
        battle.on('deploy', (c) => { if (c.unit === unit) unit.mem.huangDefib = fresh(); }, { owner: unit });
        const st = () => unit.mem.huangDefib;
        const locked = () => battle.time < st().lockUntil - 1e-9;
        // the HP she had before this damage instance (dealDamage emits `hit` first; a 流失 has no lock to apply)
        battle.on('hit', (c) => { if (c.target === unit) st().hpBefore = unit.hp; }, { owner: unit, priority: -1000 });
        // 不死 while a stage is still armed (huang_t_1[undead] / huang_e_003[undead]), and the lock of a running stage
        battle.on('fatal', (c) => {
          if (c.unit !== unit || c.prevented) return;
          if ((locked() && !isHpLoss(c.dmg)) || st().next < stages.length) c.prevented = true;
        }, { owner: unit, priority: 0 });
        battle.on('damaged', (c) => {
          if (c.target !== unit || !unit.alive) return;
          const s = st();
          if (locked()) {
            // HpNoLessThanCertainPercentModifier: this damage cannot take her below the floor (nor below where she was)
            if (!isHpLoss(c.dmg)) {
              const f = Math.min(unit.s.maxHp * s.floor, Math.max(unit.hp, s.hpBefore));
              if (unit.hp < f) unit.hp = f;
            }
            return;
          }
          const g = stages[s.next];
          if (!g || !(unit.hpRatio <= g.thr + 1e-9)) return;
          s.next++;
          battle.heal(unit, unit, unit.s.maxHp * g.heal, { self: true });
          if (g.dur > 0) { s.lockUntil = battle.time + g.dur; s.floor = g.floor; }
          battle.fx('emergency', { x: unit.x, y: unit.y, id: unit.id });
        }, { owner: unit, priority: 100 });
      } },
      { install(battle, unit) { // 严酷训练 (+ CEN-X ATK / ASPD steps): counted from each deployment
        const steps = trainingSteps(chess);
        if (!steps.length) return;
        battle.on('deploy', (c) => {
          if (c.unit !== unit) return;
          const seq = unit.deploySeq;
          for (const s of steps) {
            battle.after(s.at, () => {
              if (!live(unit) || unit.deploySeq !== seq) return;
              s.apply(battle, unit);
              battle.fx('talent', { x: unit.x, y: unit.y, id: unit.id });
            }, { owner: unit });
          }
        }, { owner: unit });
      } },
    ],
    install(battle, unit) {
      // CEN-X trait: "攻击被阻挡的敌人攻击力提升至110%" — her attacks on blocked enemies (blocked by anyone, pool reading)
      const sc = num(tb.atk_scale, 1);
      if (sc !== 1) onHitBy(battle, unit, ({ target, dmg }) => { if (dmg.isAttack && target.blockedBy) dmg.amount *= sc; });
      // CEN-Y trait: "生命值高于50%时受到的物理伤害降低20%"
      const yr = num(tb.hp_ratio), yd = num(tb.damage_resistance);
      if (yr > 0 && yd > 0) onHitOn(battle, unit, ({ dmg }) => { if (dmg.type === 'phys' && unit.hpRatio > yr) dmg.mul *= 1 - yd; });
      // CEN-Y hidden part: "生命值高于50%时攻击无视目标150点防御力"
      const pen = num(hb.def_penetrate_fixed), pr = num(hb.hp_ratio);
      if (pen > 0) onHitBy(battle, unit, ({ dmg }) => { if (unit.hpRatio > pr) dmg.defIgnoreFlat += pen; });
    },
  };
}
