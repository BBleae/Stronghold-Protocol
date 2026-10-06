// server/sim/content/kits/waiguan/char_362_saga.js — 嵯峨 (先锋 · 尖兵 pioneer) 外援 kit (DESIGN §27, docs/WAIGUAN-KITS.md).
//
// Chess ids: chess_char_diy_5_char_362_saga_a/_b, chess_char_diy_6_char_362_saga_a/_b (registered by ./index.js).
// Sources: the records (data/waiguan.json; normal = skill Lv4, elite = Lv7 + its module at the tier's level) and the
// official buff templates (ArknightsGameData zh_CN battle/buff_template_data.json: saga_t_1, cripple, saga_s_2,
// saga_s_3[hit], saga_e_003[damage_scale], charge_cost) for what the texts leave open. Every number comes from a
// blackboard except S2's "最多6名" (text only: read from the record's skill text; no number there ⇒ no cap).
//
// DP (部署费用, REQUIREMENTS §1) is the engine's: battle.addDp(ownerId, n) — the player's DP, capped at flags.dpMax.
// Trait (尖兵 "能够阻挡两个敌人"): the data block count (professions.js SUB.pioneer has no trait to model).
// S1 冲锋号令·γ型 (AUTO, instant): +cost DP at once (charge_cost: ModifyCost by `cost`). 技能策略: an AUTO skill takes no
//   strategy row and its DP gain has no target ⇒ trigger SP_FULL (cast as soon as it is ready) — the pool's rule for the
//   same common skill (德克萨斯 kits/tier1.js, 焰尾 S1 kits/tier4.js); the record's DEFAULT is changed.
// S2 除恶 (MANUAL, charges): +cost DP at once; then up to the text's 6 ground enemies on its cross range (x-6, the
//   record's grid) take atk_scale × ATK physical skill damage (her 劝善 holds every lethal one at 1 HP and 重伤s it), and
//   every 重伤 enemy among them is killed by her (saga_s_2: CheckContainsBuff cripple → InstantKill, source = her ⇒ she
//   is the 击杀者 of the 重伤 rule below and gains its SP). 技能策略: the record's SKILL_RANGE (MANUAL with a 技能范围 of
//   its own: an enemy on that grid) — kept; the charges are cast 3 s apart (AUTO_OP_COOLDOWN).
// S3 怒目 (MANUAL, DEFAULT kept, duration): ATK +atk, 攻击间隔 +base_attack_time s (batMod: a flat change, "稍微增大"),
//   攻击距离 +ability_range_forward_extend, every blocked enemy at once (hitAllBlocked); after each attack hit, a target
//   whose HP ratio is below attack@hp_ratio takes one more physical hit of 1 × ATK (saga_s_3[hit]: FilterByTargetHpRatio
//   LT, AdvancedApplyDamage PHYSICAL _defaultAtkScale 1, _attackType NORMAL ⇒ an attack damage). DP: +cost every
//   `interval` s of the skill, `value` in all (the first after one interval — the pool's 焰尾 S3 pacing); a natural end
//   grants what float drift left out, a knock-out ends it with no remainder.
// T1 劝善 (saga_t_1 + the cripple template): every damage she deals is never lethal (DAMAGE_IS_UNDEADABLE_THIS_TIME: the
//   enemy keeps 1 HP); an enemy so saved that is not yet 重伤 becomes 重伤 (buff CRIPPLE_KEY, one per enemy whoever applied
//   it — overrideType UNIQUE): 禁疗 (HEAL_FREE → engine healFree), no attacks (DISABLE_COMBAT → engine disarm), move speed
//   ×(1 + move_speed) (FINAL_SCALER of the blackboard's −0.8 — the official FINAL_SCALER reads as ×(1 + v): 气球 −0.9);
//   after `interval` s it dies with no killer (cripple ON_BUFF_TRIGGER InstantKill _noSource; a record without a positive
//   `interval` holds nobody at 1 HP — no 重伤 may last for ever); whoever kills it first — an operator, a summon, her own
//   S2 — gains `sp` SP (ON_OWNER_KILLED_BY_MAIN_TARGET ModifySp on the killer alone, not on her; lost while that unit's
//   timed skill runs, the engine's rule). She never attacks a 重伤 enemy (any 重伤, another 嵯峨's too): with
//   only such enemies in reach she holds her attack (trait canAttack) and her attacks re-pick their targets without them.
//   SOL-X (uniequip_003_saga) adds, from level 2 (hidden part, tier VI level 3): her damage on an enemy at or below
//   hp_ratio of its HP ×damage_scale (saga_e_003[damage_scale]: FilterByTargetHpRatio LE → DamageScale, every damage).
// T2 清明: once per deployment, when a damage leaves her below hp_ratio of her HP: `prob` physical dodge and
//   hp_recovery_per_sec_by_max_hp_ratio × max HP per second for `duration` s (SOL-Y raises them: talent 1 of the record).
// Module SOL-X (uniequip_003_saga) trait: ATK and DEF +atk / +def while she blocks an enemy (the pool's 焰尾 SOL-X).
// Module SOL-Y (uniequip_002_saga) "首次部署时部署费用-4" (hidden runtime_cost): the initial deployment is free in battle and a
//   redeploy is not a 首次部署 ⇒ no in-battle effect (pool: 德克萨斯 kits/tier1.js, 忍冬 kits/tier3.js).
// Modules are dispatched by `chess.module.type` (KIT_CONVENTIONS 15); their numbers come from the loadout record.
// fx: 'dp' (every DP gain), 'swordStorm' (S2: `tiles` = the cross it hits), 'slash' (S2 kill), 'overload' (S3 start),
//   'extraAttack' (S3 follow-up hit), 'wanted' (重伤 mark), 'talent' (清明). RNG: none of hers (dodges are the engine's).
// [ASSUMED] (PRTS unreachable from the authoring container):
//   * S2 hits no flyer ("地面敌人"); its pick is the engine's order (taunt → least remaining path →
//     earliest spawn), without the blocked-first rule of normal attacks (KIT_CONVENTIONS 10), and it may pick an enemy
//     that is already 重伤 ("之后消灭其中重伤的敌方单位": the hit ones are executed, whoever crippled them).
//   * The 重伤 template's other parts are not modelled: BLOCK_CNT / HP_RECOVERY FINAL_SCALER 0 (×(1 + 0): no change) and
//     ON_BEFORE_APPEAR (an enemy that disappears while 重伤 dies when it re-appears) — the timer kills it anyway.
//   * The 击杀者 SP goes to whichever ally unit kills it (the template has no side / owner filter), a teammate's included.
//   * S3 DP pacing: the first `cost` after one `interval` (焰尾 S3 precedent); S2's kill happens in the same step as its
//     damage (saga_s_2 finishes on ON_BUFF_FINISH; its delay is not in the data).
//   * 清明 "仅一次" = once per deployment (the engine's convention for once-per-deployment effects, 煌 紧急除颤).
//   * A leader whose HP is a shared boss pool (boss / hidden fields) has no `fatal` step in the engine (damage.js
//     applyHpLoss): 劝善 cannot hold it at 1 HP, her damage kills it as anyone's.

import { num, tal, lazySkills, mods, gridOf, instantKindOf, live, batMod, toggleBuff, attackCandidates, parseN } from './_lib.js';
import { absoluteRangeKeys, sortEnemyTargets } from '../../../targeting.js';
import { gridTiles } from '../../fxtiles.js';

const S1 = 'skcom_charge_cost[3]', S2 = 'skchr_saga_2', S3 = 'skchr_saga_3';
/** 重伤 (the official buff key 'cripple'): one per enemy, shared by every copy of her. */
export const CRIPPLE_KEY = 'saga:cripple';
/** S2 "对十字范围内最多6名地面敌人": the cap is text only (no blackboard key; Lv4 and Lv7 alike) — read from the record's text. */
const S2_CAP_RE = /最多(\d+)名/;
/** saga_s_3[hit] AdvancedApplyDamage `_defaultAtkScale` (S3's blackboard has no atk_scale). */
const S3_EXTRA_SCALE = 1;
/** Damage tags (unique per effect, KIT_CONVENTIONS 3). */
const S2_TAG = 'sagaS2', S3_EXTRA_TAG = 'sagaS3Extra';
const GROUND = Object.freeze({ canHitFly: false, groundOnly: true });

export const isCrippled = (e) => !!e && !!e.findBuff(CRIPPLE_KEY);

/** DP gain of `unit`'s player (the engine's DP, capped at dpMax) with its fx. */
function gainDp(battle, unit, n) {
  if (!(n > 0)) return;
  battle.addDp(unit.ownerId, n);
  battle.fx('dp', { x: unit.x, y: unit.y, id: unit.id, n });
}

/** Every enemy `unit` may attack with profile `prof` that is not 重伤, in the engine's order (ai.js acquireTargets rules). */
function sagaTargets(battle, unit, prof) {
  if (prof.hitAllBlocked && unit.blocking.length) {
    const t = battle.blockedTargets(unit, prof).filter((e) => !isCrippled(e));
    if (t.length) return t;
  }
  const cands = attackCandidates(battle, unit, prof).filter((e) => !isCrippled(e));
  if (prof.allInRange) return cands;
  const n = Math.max(1, Math.floor((prof.maxTargets || 1) + unit.s.maxTargets));
  return cands.slice(0, n);
}

/** S1 冲锋号令·γ型: +cost DP, cast as soon as it is ready (header). */
const chargeCost = (rec) => ({
  kind: 'instant',
  trigger: 'SP_FULL',
  onStart({ battle, unit }) { gainDp(battle, unit, num(rec.bb?.cost)); },
});

/** S2 除恶 (header). */
function purge(rec) {
  const b = rec.bb ?? {};
  const grid = gridOf(rec);
  const cap = parseN(rec.desc, S2_CAP_RE, null);
  const maxT = cap > 0 ? Math.floor(cap) : Infinity;
  return {
    kind: instantKindOf(rec),
    onStart({ battle, unit }) {
      gainDp(battle, unit, num(b.cost));
      if (!grid) return;
      const list = battle.enemiesInKeys(absoluteRangeKeys(grid, unit.tileR, unit.tileC, unit.dir, 0), unit, GROUND);
      // the skill's own pick (KIT_CONVENTIONS 10): no "blocked by me first" — a stand-in at her position blocks nobody
      sortEnemyTargets(battle, { x: unit.x, y: unit.y }, list, null);
      const hit = list.slice(0, maxT);
      battle.fx('swordStorm', { x: unit.x, y: unit.y, id: unit.id, tiles: gridTiles(unit, grid) });
      const amount = unit.s.atk * num(b.atk_scale);
      for (const e of hit) if (e.alive) battle.dealDamage(unit, e, { amount, type: 'phys', isSkill: true, tags: ['skill', S2_TAG] });
      // "之后消灭其中重伤的敌方单位": she is the killer (saga_s_2 InstantKill with its source)
      for (const e of hit) {
        if (!e.alive || !isCrippled(e)) continue;
        battle.fx('slash', { x: e.x, y: e.y, id: unit.id, target: e.id });
        battle.kill(e, unit);
      }
    },
  };
}

/** S3 怒目 (header). */
function wrath(rec, chess) {
  const b = rec.bb ?? {};
  const iv = num(b.interval), per = num(b.cost), total = num(b.value);
  const hpLt = num(b['attack@hp_ratio']);
  return {
    kind: 'duration',
    mods: mods({ atkPct: num(b.atk), batPct: batMod(b.base_attack_time, chess, rec.desc ?? '') }),
    targeting: mods({ rangeExtend: Math.round(num(b.ability_range_forward_extend)) }),
    attack: {
      hitAllBlocked: true,
      onHit({ battle, unit, target }) {
        if (!target || !target.alive || target.side !== 'enemy' || !(target.hpRatio < hpLt)) return;
        battle.dealDamage(unit, target, { amount: unit.s.atk * S3_EXTRA_SCALE * unit.s.atkScaleMul, type: 'phys', isAttack: true, isSkill: true, tags: ['skill', S3_EXTRA_TAG] });
        battle.fx('extraAttack', { x: target.x, y: target.y, id: unit.id, target: target.id });
      },
    },
    onStart({ battle, unit }) {
      unit.mem.sagaDp = { acc: 0, given: 0 };
      battle.fx('overload', { x: unit.x, y: unit.y, id: unit.id });
    },
    onTick({ battle, unit, dt }) {
      const F = unit.mem.sagaDp;
      if (!F || !(iv > 0) || !(per > 0)) return;
      F.acc += dt;
      while (F.acc + 1e-9 >= iv && F.given + per <= total + 1e-9) {
        F.acc -= iv;
        F.given += per;
        gainDp(battle, unit, per);
      }
    },
    onEnd({ battle, unit, reason }) {
      const F = unit.mem.sagaDp;
      unit.mem.sagaDp = null;
      if (F && reason === 'duration' && F.given < total - 1e-9) gainDp(battle, unit, total - F.given);
    },
  };
}

export default function saga(bb, chess) {
  const t0 = tal(chess, 0), t1 = tal(chess, 1);
  const moduleType = chess?.module?.active ? chess.module.type ?? null : null;
  // SOL-X hidden part (saga_e_003[damage_scale]): the module's talent part of data index −1 (absent at level 1)
  const solX = moduleType === 'SOL-X' ? tal(chess, -1) : {};
  const lowHp = num(solX.hp_ratio), lowHpScale = num(solX.damage_scale);
  const tb = moduleType === 'SOL-X' ? chess?.trait?.bb ?? {} : {};
  return {
    skills: lazySkills(chess, {
      [S1]: chargeCost,
      [S2]: purge,
      [S3]: (rec) => wrath(rec, chess),
    }),
    // 劝善 "嵯峨不攻击重伤单位": no attack while every enemy in reach is 重伤 (the DEFAULT trigger waits with it)
    trait: { canAttack: (battle, u) => attackCandidates(battle, u, u.profile).some((e) => !isCrippled(e)) },
    talents: [
      { install(battle, unit) { // 劝善 (+ SOL-X damage on enemies at low HP)
        const crippleSp = num(t0.sp), life = num(t0.interval), move = num(t0.move_speed);
        // her attacks re-pick their targets without the 重伤 ones (normal attacks and S3's)
        battle.on('beforeAttack', (c) => {
          if (c.attacker !== unit || !c.targets.length || c.targets[0].side !== 'enemy' || !c.targets.some(isCrippled)) return;
          c.targets = sagaTargets(battle, unit, c.profile || unit.profile);
        }, { owner: unit, priority: 100 });
        // DAMAGE_IS_UNDEADABLE_THIS_TIME: never lethal; the saved enemy becomes 重伤 unless it already is
        if (life > 0) battle.on('fatal', (c) => {
          const e = c.unit;
          if (c.source !== unit || c.prevented || !e || e.side !== 'enemy') return;
          c.prevented = true;
          if (isCrippled(e)) return;
          battle.addBuff(e, {
            key: CRIPPLE_KEY, source: unit, visible: true, tags: ['talent'],
            duration: life,
            flags: { healFree: true, disarm: true },
            mods: mods({ moveMul: Math.max(0, 1 + move) }),
            onExpire: ({ battle: b, unit: v }) => { if (v.alive) b.kill(v, null); },
          });
          battle.fx('wanted', { x: e.x, y: e.y, id: e.id, src: unit.id });
        }, { owner: unit, priority: 50 });
        // the 击杀者 of one of HER 重伤 enemies gains `sp` SP (one handler per crippler: two 嵯峨 never pay twice)
        if (crippleSp > 0) battle.on('kill', (c) => {
          const v = c.victim, k = c.killer;
          if (!v || v.side !== 'enemy' || !k || k.side !== 'ally' || v.findBuff(CRIPPLE_KEY)?.source !== unit) return;
          if (k.skill && !k.skill.noSkill) k.skill.gainSp(crippleSp, 'talent'); // (none while its timed skill runs: gainSp)
        }, { owner: unit });
        if (lowHp > 0 && lowHpScale > 0 && lowHpScale !== 1) battle.on('hit', (c) => {
          if (c.source !== unit || !c.target || c.target.side !== 'enemy' || !(c.target.hpRatio <= lowHp + 1e-9)) return;
          c.dmg.mul *= lowHpScale;
        }, { owner: unit });
      } },
      { install(battle, unit) { // 清明: once per deployment below hp_ratio
        const thr = num(t1.hp_ratio), dur = num(t1.duration);
        const m = mods({ dodgePhys: num(t1.prob), hpRegenRatio: num(t1.hp_recovery_per_sec_by_max_hp_ratio) });
        if (!(thr > 0) || !(dur > 0) || !Object.keys(m).length) return;
        battle.on('deploy', (c) => { if (c.unit === unit) unit.mem.sagaClarity = false; }, { owner: unit });
        battle.on('damaged', (c) => {
          if (c.target !== unit || !live(unit) || unit.mem.sagaClarity || !(unit.hpRatio < thr)) return;
          unit.mem.sagaClarity = true;
          battle.addBuff(unit, { key: 'saga:clarity', duration: dur, mods: m, visible: true, source: unit, tags: ['talent'] });
          battle.fx('talent', { x: unit.x, y: unit.y, id: unit.id });
        }, { owner: unit });
      } },
    ],
    install(battle, unit) {
      // SOL-X trait: ATK / DEF + while she blocks
      const m = mods({ atkPct: num(tb.atk), defPct: num(tb.def) });
      if (Object.keys(m).length) toggleBuff(battle, unit, 'saga:solX', () => unit.blocking.length > 0, m);
    },
  };
}

