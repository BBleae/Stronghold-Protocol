// server/sim/content/kits/ops/op-orchd2.js — 焰狐龙梓兰 (char_1048_orchd2) 自选 operator kit: 6★ 重射手 (狙击), a collab pick
// of this fork's tier-5 and tier-6 自选 slots (tools/build-data.mjs FORK_INCLUDE_COLLAB_PICKS — the fork owner's decision of
// 2026-10-08: the 7 collab 6★ upstream leaves out of 自选 come back in full); every skill, both talents and their hidden
// parts, the trait and the module (ARC-X 梓兰特制箭靶) at every form. Kit contract and the 自选 rules: ../README.md ("How to
// add an operator (自选)"). Ported from the fork's 外援 kit (b8c80254 kits/waiguan/char_1048_orchd2.js) onto the 自选 record
// and corrected against PRTS.
//
// Forms (data/backups.json units.char_1048_orchd2): normal = E2 Lv1, skills at rank 4, no module; elite = E2 Lv60, rank 7,
// ARC-X at stage 1 (tier 5) or 3 (tier 6) when picked — the owner's decision of 2026-10-05. Full potential (the owner's
// decision of 2026-10-07: 强击瓶专家 ×1.2). Sources: character_table / skill_table / battle_equip_table / range_table (zh_CN,
// .cache/gamedata/excel, as built into backups.json) and PRTS 焰狐龙梓兰 (特性备注, 天赋备注, the three skills' 备注).
// - Her attack (hidden talent part 2: attack@atk_scale, attack@damage_scale): PRTS 特性备注 "普通攻击为三连击，每击造成攻击力
//   100%的物理伤害" and "若为普通攻击的伤害，则使该伤害降低至33.3%" (after DEF / RES): a normal attack is NORMAL_HITS physical
//   hits on its target, each attack@atk_scale × ATK, each at a 伤害倍率 of damage_scale (professions.js `hitDmgMul`).
//   Trait (重射手) "高精度的近距离射击": ranged physical arrows, 3-6, can hit air units (PRTS 分支特性信息 重射手 "可对空"),
//   blocks 1, ground enemies target her.
//   [ASSUMED] damage_scale also on the arrows of her skill rounds — S1's 4 arrows, 刚连射's 5, the S2 volleys — as arrows of
//   that attack ability (S2's blackboard is attack@…; the fork's 外援 kit read the client's buff template
//   orchd2_s_1[damage_scale] so), not on the S2 landing nor on 龙之箭 (both "造成攻击力N%的…伤害"). PRTS names only
//   "普通攻击的伤害"; the other reading (whole N% per skill arrow, ×3) is an open owner decision.
// - S1 刚射 (MANUAL, data DEFAULT; charges from the record): her next attack is the skill's: the desc's first "发射N支" arrows
//   at atk_scale_1 on her target. "若还有充能则额外消耗1层施展刚连射" is settled at the cast (PRTS 备注 "若在已有2次充能所需技力
//   的情况下触发技能，焰狐龙梓兰会消耗2次充能所需的技力来释放技能"): when she still holds a charge once the cast took its own, the
//   cast takes that one too, and 刚连射 leaves COMBO_DELAY s after the first arrows (her skeleton's Skill_1_End_2: OnAttack at
//   0.667 and 1.833 s) — whatever became of those arrows meanwhile — at their target while it is still in her attack
//   selection, else at the first enemy of it; none (PRTS "如果自身发动刚连射时找不到目标，将立刻终止技能并返还与1次充能等额的
//   技力") ⇒ no 刚连射 and the charge comes back. 刚连射: the second "发射N支" arrows at atk_scale_2, each with stun_prob of 晕眩
//   `stun` s (one roll per arrow that leaves the target with HP; battle RNG). "充能至最大层数时自动释放一次": at full charges she casts
//   it even while the 3 s automatic-operation cooldown runs (an enemy in her attack selection, no cast pending, able to act,
//   not silenced) — PRTS "自动释放不会改变技能为手动触发技能的本质": that cast does not restart the cooldown.
// - S2 飞翔瞪射 (MANUAL, data SKILL_RANGE on its own 4-4): 起飞 for the skill's duration (蒂比's flags: no ground enemy is
//   blocked by her or selects her; she blocks flyers; the ground enemies she blocked walk on) and no normal attack (PRTS
//   "技能持续期间，自身丢失全部视野"); the desc's "分别射出a、b、c支" volleys at every selectable enemy of the skill range (flyers
//   too), each arrow attack@atk_scale_loop × ATK physical; when the duration runs out the landing: attack@atk_scale_end × ATK
//   physical to every selectable enemy of LANDING_GRID (PRTS 备注 "技能结束降落时伤害范围为1-3"); from it she stands on the
//   ground again (the flyers she held are let go; she blocks and is targeted) while the rest of the skill plays out. The
//   timing follows her clips (PRTS 备注 "技能期间发动的三轮攻击的时间模式均为跟随动画，因此三者的动画长度即是三轮攻击分别的攻击间隔
//   （不受攻击速度影响）"; her skeleton: Skill_2_Begin 0.667 s — Skill_2_Begin_First 1.5 s at the first opening of a
//   deployment, PRTS 天赋备注 "首次开启会用Skill_X_Begin_First动画代替" —, three Skill_2_Loop_k of 0.833 s with the volley at
//   0.167 s, Skill_2_End 1 s with the landing at 0.233 s): volleys at Begin + k × Loop + 0.167, the landing at Begin + 3 × Loop
//   + 0.233 — 0.833 / 1.667 / 2.5 and 3.4 s, the first opening 1.667 / 2.5 / 3.333 and 4.233 s; the skill runs its data
//   duration (4.2 s, the clips' 4.167 s) or to the end of Skill_2_End when the first opening's clips run longer (5.0 s).
//   A knock-out or a stop ends it at once: no further volley, no landing. "部署后立即释放一次" (PRTS "部署后的“立即释放”可以
//   无视技力开启技能；每次部署后首次开启此技能时…不会消耗技力"): a free cast at every deployment.
// - S3 龙之箭 (MANUAL, data DEFAULT; charges from the record; no duration in the data — an instant cast whose SP recovers
//   from the cast on): the desc's "蓄力N秒" (PRTS: the opening animation + the 1.5 s wait_duration; the first opening of a
//   deployment ≈110 frames instead of ≈90: FIRST_OPEN_EXTRA) with no attack and no other cast (CHARGE_KEY: disarm; the
//   attack the DEFAULT cast was made for is dropped); then Skill_3_End plays (her skeleton: 1.233 s, its OnAttack at 0.1 s —
//   PRTS "随后约3帧（0.1秒）后产生弹道"): the arrow appears END3_HIT s into it, and she acts again when it is over (the
//   disarm lasts to its end). The piercing arrow flies from her 弹道受击点 (PRTS "始终具有向北方向约0.2323格的偏移":
//   ARROW_NORTH tiles towards +row) along her facing at ARROW_SPEED until it leaves the field (max_dist, ARROW_LIFE): every
//   dist_interval tiles of its flight every selectable enemy within ARROW_RADIUS of it (PRTS 碰撞半径 0.5) takes
//   atk_scale × ATK physical, then atk_scale_magic × ATK arts (PRTS "先造成物理伤害，后造成法术伤害"); an enemy it touches is
//   pushed along her facing with 力度 `force` (中等力度; KnockBackWithCharacterDirection: a fixed direction), at most once per
//   knockback_duration s per enemy (PRTS "推动效果对每个敌人具有1秒的冷却"). The arrow keeps the ATK of its launch and flies on
//   if she is knocked out; a knock-out during the charge fires nothing (a 【移动】 keeps it).
// - T1 强击瓶专家: at her first skill opening of each deployment (S2's free cast counts) the next power_attack_count attack
//   rounds get ATK-scale ×power_attack_scale (PRTS: "每轮普通攻击三连击、每轮技能三/四/五连击、每次二技能的降落攻击、每次三技能
//   的龙之箭都会消耗一层"; "于弹道脱手前对当次连击的所有弹道/龙之箭弹道的攻击力倍率生效") — the buff POWER_KEY (atkScaleMul) while
//   rounds are left; a round is taken when it leaves (a normal attack / S1's cast at its `attack`, 刚连射, an S2 volley that
//   has a target, the landing that hits someone, the dragon arrow). The arrows of a normal attack / S1's cast keep the
//   multiplier of their launch ("于弹道脱手前…生效"): the round is settled by the `attack` hook's `attackId`, and its hits
//   (the `hit` step, before DEF / RES) are corrected when the window opened or closed while they flew. A redeploy closes it
//   until the next opening; a 【移动】 (no exit) keeps it.
// - T2 翔虫机动: "再部署时间-N秒" = the hidden part 3 respawn_time on her redeploy time (unit.base.respawnTime, once); "且不提高
//   部署费用" holds (the engine never raises a redeploy cost); "部署至上次部署位置周围时，30秒内攻击力+N%": a deployment on a tile
//   of the range-table grid `ignore_build_type_target_range` (x-1, ARC-X stage 3 x-2; dir 0: unrotated) around the tile she
//   last left the field from (PRTS "离场后将在原地留下一个静止弹道…直到下次…部署") — ATK +atk for atk_duration s. In this mode a
//   knocked-out or retreated operator comes back where it lies, so every redeploy gets it unless it lands elsewhere (突袭);
//   the battle-start deployment has no marker; a 【移动】 is no exit. "并且可以部署在近战位" is the placement of a non-first
//   deployment, which no player chooses here (the prep placement is the first one) — not modelled.
// - Module ARC-X “梓兰特制箭靶”: "再部署时间减少" = the attribute respawn_time −25 (in the stats); its stage-3 talent changes
//   (翔虫机动 x-2 / +20 %, hidden respawn_time −18) come through the composed record.
//
// [ASSUMED] (no source settles it): damage_scale on the skill arrows (above); S1's 4 arrows as her next attack (the
//   engine's instant skill), 刚连射's 5 arrows land at once (no flight) and its retarget; a knock-out between the two
//   loses 刚连射 (its charge was spent at the cast), a stun does not; a volley / landing with nobody to hit takes no 强击瓶
//   round; the landing hits flyers too; she lands (ground again) at the landing's hit; S2's end at its data duration when
//   the clips fit in it; ARROW_RADIUS also for the damage ("周围所有敌人"), the damage before the push at a step, the
//   0.2323 offset measured against each enemy's own position; Skill_3_End holds her actions like the rest of the skill;
//   a stun or a silence during the charge (or between S1's two volleys) does not break it.

import { num, up } from '../shared/tier1.js';
import { absoluteRangeKeys, sortEnemyTargets } from '../../../targeting.js';
import { hasHp } from '../../../damage.js';
import { COLS, TICK } from '../../../constants.js';

const CHAR = 'char_1048_orchd2';
const S1 = 'skchr_orchd2_1', S2 = 'skchr_orchd2_2', S3 = 'skchr_orchd2_3';
/** PRTS 特性备注 "普通攻击为三连击": damage instances per normal attack. */
const NORMAL_HITS = 3;
/** excel/range_table.json grids (facing RIGHT) of 翔虫机动's `ignore_build_type_target_range` (direction 1, symmetric). */
const RANGE_TABLE = Object.freeze({
  'x-1': Object.freeze([[2, 0], [1, -1], [1, 0], [1, 1], [0, -2], [0, -1], [0, 0], [0, 1], [0, 2], [-1, -1], [-1, 0], [-1, 1], [-2, 0]]),
  'x-2': Object.freeze([[2, -1], [2, 0], [2, 1], [1, -2], [1, -1], [1, 0], [1, 1], [1, 2], [0, -2], [0, -1], [0, 0], [0, 1], [0, 2],
    [-1, -2], [-1, -1], [-1, 0], [-1, 1], [-1, 2], [-2, -1], [-2, 0], [-2, 1]]),
});
/** S2 landing: PRTS 备注 "技能结束降落时伤害范围为1-3" (excel/range_table.json 1-3). */
const LANDING_GRID = Object.freeze([[1, 1], [0, 0], [0, 1], [-1, 1]]);
/** 起飞 (蒂比's flags, kits/ops/chess_char_2_13-tippi.js): blocks flyers only; no ground enemy selects her. */
const LIFTOFF = Object.freeze({ blockFly: true, liftoff: true });
/** 龙之箭: PRTS 备注 "10格/秒（≈0.333格/帧）的飞行速度与0.5的碰撞半径", "持续存在30秒". */
const ARROW_SPEED = 10, ARROW_RADIUS = 0.5, ARROW_LIFE = 30;
/** 龙之箭: PRTS 天赋备注 — the first opening of a deployment ≈110 frames before the arrow starts, later ones ≈90 (30 frames / s). */
const FIRST_OPEN_EXTRA = (110 - 90) / 30;
/** 龙之箭: Skill_3_End (her skeleton, frames of 1/30 s): 37 frames, its OnAttack — the arrow (PRTS "随后约3帧") — at 3. */
const END3 = 37 / 30, END3_HIT = 3 / 30;
/** 龙之箭: PRTS "从自身的弹道受击点（始终具有向北方向约0.2323格的偏移）" — tiles towards +row (north, dir.js). */
const ARROW_NORTH = 0.2323;
/** S1 刚连射: Skill_1_End_2's two OnAttack (her skeleton: frames 20 and 55, 0.667 and 1.833 s) — the second volley after the first. */
const COMBO_DELAY = (55 - 20) / 30;
/**
 * S2 (her skeleton, frames of 1/30 s): Skill_2_Begin 20 (Skill_2_Begin_First 45), Skill_2_Loop_k 25 with the volley at 5,
 * Skill_2_End 30 with the landing at 7.
 */
const S2_BEGIN = 20 / 30, S2_BEGIN_FIRST = 45 / 30, S2_LOOP = 25 / 30, S2_LOOP_HIT = 5 / 30, S2_END = 30 / 30, S2_END_HIT = 7 / 30;
/** Text-only numbers: S1 "发射N支攻击力…" (twice), S2 "分别射出a、b、c支", S3 "蓄力N秒". */
const S1_ARROWS_RE = /发射(\d+)支攻击力/g, S2_VOLLEYS_RE = /分别射出([\d、]+)支/, S3_CHARGE_RE = /蓄力(\d+(?:\.\d+)?)秒/;
/** 强击瓶专家: the launches whose arrows may still be in flight (their round's multiplier, settled at the launch). */
const ROUNDS_KEPT = 16;
/** Buffs: 强击瓶专家's window, 翔虫机动's ATK, 龙之箭's charge (to the end of Skill_3_End), S2's flight (to the landing). */
export const POWER_KEY = 'orchd2:powerShot', WIREBUG_KEY = 'orchd2:wirebug', CHARGE_KEY = 'orchd2:dragonCharge', FLIGHT_KEY = 'orchd2:flight';
/** Damage tags: 刚连射 arrows, S2 volley arrows, S2 landing, 龙之箭. */
export const COMBO_TAG = 'orchd2Combo', VOLLEY_TAG = 'orchd2Volley', LAND_TAG = 'orchd2Landing', ARROW_TAG = 'orchd2DragonArrow';

/** Talent record of DATA index `i` of the composed record (0 强击瓶专家, 1 翔虫机动, 2 / 3 their hidden parts). */
const talRec = (chess, i) => (chess?.talents ?? []).find((t) => t && t.index === i) ?? null;
const tal = (chess, i) => talRec(chess, i)?.bb ?? {};
/** Skill record `id` of the composed record (all three at the slot's rank). */
const skillOf = (chess, id) => (chess?.skills ?? []).find((s) => s && s.skillId === id) ?? null;
/**
 * Per-unit state (one per copy of her): 强击瓶专家's rounds left, `opened` (a skill opened in this deployment: the next one
 * is no first opening), 翔虫机动's exit tile, S1's 刚连射 settled at the cast, S2's flight, S3's charge.
 */
const stateOf = (unit) => (unit.mem.orchd2 ??= { left: 0, opened: false, exit: null, combo: null, s2: null, charge: null });

/**
 * 强击瓶专家: a round leaves now — while rounds are left it takes one (the window's ATK-scale buff stays on for it), once
 * they are spent the buff is taken off first (this round is plain). Call it before the round's damage is computed.
 */
function takeRound(battle, unit) {
  const st = stateOf(unit);
  if (st.left > 0) { st.left--; return; }
  if (unit.findBuff(POWER_KEY)) battle.removeBuff(unit, POWER_KEY);
}
/** ATK × the ATK-scale multipliers of the unit right now (强击瓶专家 included). */
const scaledAtk = (unit) => unit.s.atk * unit.s.atkScaleMul;
/** Every enemy `unit` could attack now (its range + the ones it blocks), in the engine's order. */
function attackTargets(battle, unit) {
  const prof = unit.profile;
  const list = battle.enemiesInKeys(unit.rangeKeys, unit, prof);
  if (unit.blocking.length) for (const e of battle.blockedTargets(unit, prof)) if (!list.includes(e)) list.push(e);
  return sortEnemyTargets(battle, unit, list, prof?.priority ?? null);
}

/** S2: one volley — `n` arrows at every selectable enemy on the skill range (one 强击瓶 round when it has a target). */
function volley(battle, unit, keys, n, scale, ds) {
  if (!(n > 0)) return;
  const foes = battle.enemiesInKeys(keys, unit, { canHitFly: true });
  if (!foes.length) return;
  takeRound(battle, unit);
  const amount = scaledAtk(unit) * scale;
  battle.fx('volley', { x: unit.x, y: unit.y, id: unit.id, targets: foes.map((e) => e.id), n });
  for (const e of foes) {
    for (let i = 0; i < n && hasHp(e); i++) {
      battle.dealDamage(unit, e, { amount, type: 'phys', mul: ds, isAttack: true, isSkill: true, tags: ['skill', VOLLEY_TAG] });
    }
  }
}

/** S2: the landing on LANDING_GRID (one 强击瓶 round when it hits someone). */
function landing(battle, unit, scale) {
  if (!(scale > 0)) return;
  const keys = absoluteRangeKeys(LANDING_GRID, unit.tileR, unit.tileC, unit.dir, 0);
  battle.fx('aoe', { x: unit.x, y: unit.y, id: unit.id, tiles: keys.map((k) => [(k / COLS) | 0, k % COLS]) });
  const foes = battle.enemiesInKeys(keys, unit, { canHitFly: true });
  if (!foes.length) return;
  takeRound(battle, unit);
  const amount = scaledAtk(unit) * scale;
  for (const e of foes) battle.dealDamage(unit, e, { amount, type: 'phys', isSkill: true, tags: ['skill', LAND_TAG] });
}

/** S3: launch the dragon arrow (header) — one 强击瓶 round; its ATK is the launch's. */
function launchArrow(battle, unit, bb) {
  const step = num(bb.dist_interval), maxD = num(bb.max_dist, 99);
  if (!(step > 0) || !(maxD > 0)) return;
  takeRound(battle, unit);
  const atk = scaledAtk(unit);
  const phys = atk * num(bb.atk_scale), arts = atk * num(bb.atk_scale_magic);
  const force = num(bb.force), cool = num(bb.knockback_duration, 1);
  const [fr, fc] = unit.fwd;
  const x0 = unit.x, y0 = unit.y + ARROW_NORTH, R = battle.rect; // her 弹道受击点 (header)
  const dir = { x: fc, y: fr };
  const pushedAt = new Map(), passed = new Set();
  let travelled = 0, mark = 0, age = 0;
  battle.fx('strike', { x: unit.x, y: unit.y, id: unit.id, kind: 'dragonArrow' });
  const flight = battle.every(TICK, () => {
    age += TICK;
    travelled = Math.min(maxD, travelled + ARROW_SPEED * TICK);
    while ((mark + 1) * step <= travelled + 1e-9) {
      mark++;
      const d = mark * step, x = x0 + fc * d, y = y0 + fr * d;
      if (x < R.c0 - 0.5 || x > R.c1 + 0.5 || y < R.r0 - 0.5 || y > R.r1 + 0.5) { flight.cancel(); return; }
      for (const e of battle.foesInRadius(x, y, ARROW_RADIUS)) {
        if (!passed.has(e)) { passed.add(e); battle.fx('beam', { x: unit.x, y: unit.y, from: unit.id, to: e.id, kind: 'dragonArrow' }); }
        if (phys > 0) battle.dealDamage(unit, e, { amount: phys, type: 'phys', isSkill: true, tags: ['skill', ARROW_TAG] });
        if (arts > 0 && hasHp(e)) battle.dealDamage(unit, e, { amount: arts, type: 'arts', isSkill: true, tags: ['skill', ARROW_TAG] });
        if (force && e.alive && !(battle.time < (pushedAt.get(e) ?? -Infinity) + cool - 1e-9)) {
          pushedAt.set(e, battle.time);
          battle.push(e, force, { from: { x, y }, dir, fixed: true });
        }
      }
    }
    if (travelled >= maxD - 1e-9 || age >= ARROW_LIFE - 1e-9) flight.cancel();
  }, { owner: unit });
}

export default {
  [CHAR]: (bb, chess) => {
    const hidden = tal(chess, 2);
    const ds = num(hidden['attack@damage_scale'], 1);
    const baseScale = num(hidden['attack@atk_scale'], 1);
    const s1 = skillOf(chess, S1), s2 = skillOf(chess, S2), s3 = skillOf(chess, S3);
    const t0 = tal(chess, 0), t1 = talRec(chess, 1), respawn = num(tal(chess, 3).respawn_time);
    const skills = {};
    if (s1) {
      const b = s1.bb ?? {};
      const [n1, n2] = [...String(s1.desc ?? '').matchAll(S1_ARROWS_RE)].map((m) => +m[1]);
      const sc2 = num(b.atk_scale_2), p = num(b.stun_prob), stun = num(b.stun);
      /** 刚连射 (header): at the first arrows' target while it is still in her attack selection, else the first of it. */
      const combo = (battle, unit, prev) => {
        const sk = unit.skill;
        const list = attackTargets(battle, unit);
        const tgt = prev && hasHp(prev) && list.includes(prev) ? prev : list[0] ?? null;
        if (!tgt) { if (sk && sk.id === S1) sk.addCharge(1); return; } // "返还与1次充能等额的技力"
        takeRound(battle, unit);
        battle.fx('volley', { x: unit.x, y: unit.y, id: unit.id, targets: [tgt.id], n: n2 });
        const amount = scaledAtk(unit) * sc2, attackId = battle.nextAttackId();
        for (let i = 0; i < n2 && hasHp(tgt); i++) {
          battle.dealDamage(unit, tgt, { amount, type: 'phys', mul: ds, isAttack: true, isSkill: true, attackId, tags: ['skill', COMBO_TAG] });
          if (p > 0 && stun > 0 && hasHp(tgt) && battle.rng.chance(p)) battle.applyStatus(tgt, 'stun', { duration: stun, source: unit });
        }
      };
      skills[S1] = {
        kind: num(s1.maxChargeTime, 1) > 1 ? 'charges' : 'instant',
        attack: {
          atkScale: num(b.atk_scale_1, 1),
          hits: Math.max(1, num(n1, 4)),
        },
        onStart({ unit, skill }) { // the cast takes 刚连射's charge too while she still holds one (PRTS 备注)
          const st = stateOf(unit);
          st.combo = null;
          if (!(n2 > 0) || skill.charges < 1) return;
          if (skill.charges >= skill.maxCharges) skill.sp = 0;
          skill.charges -= 1;
          st.combo = { seq: unit.deploySeq };
        },
        onAttack({ battle, unit, skill, targets }) { // the first arrows leave: 刚连射 COMBO_DELAY s later
          const st = stateOf(unit), c = st.combo;
          if (!skill.pending || !c) return;
          st.combo = null;
          const prev = targets?.[0] ?? null;
          battle.after(COMBO_DELAY, () => { if (up(unit) && unit.deploySeq === c.seq) combo(battle, unit, prev); }, { owner: unit });
        },
      };
    }
    if (s2) {
      const b = s2.bb ?? {};
      const counts = (String(s2.desc ?? '').match(S2_VOLLEYS_RE)?.[1] ?? '').split('、').map(Number).filter((n) => n > 0);
      const loop = num(b['attack@atk_scale_loop']), end = num(b['attack@atk_scale_end']);
      const grid = Array.isArray(s2.rangeGrid) && s2.rangeGrid.length ? s2.rangeGrid : null;
      const fire = (battle, unit, s) => {
        const n = counts[s.next++];
        if (grid && unit.canAct) volley(battle, unit, absoluteRangeKeys(grid, unit.tileR, unit.tileC, unit.dir, 0), n, loop, ds);
      };
      /** The landing: the hit on the 1-3, then she is on the ground again (the flyers she held are let go). */
      const land = (battle, unit, s) => {
        s.landed = true;
        if (up(unit)) landing(battle, unit, end);
        battle.removeBuff(unit, FLIGHT_KEY);
        battle.releaseBlocked(unit);
      };
      skills[S2] = {
        kind: 'duration',
        attack: { noAttack: true },
        onStart({ battle, unit, skill }) {
          battle.addBuff(unit, { key: FLIGHT_KEY, flags: LIFTOFF, tags: ['skill'] });
          battle.releaseBlocked(unit);
          battle.fx('takeoff', { x: unit.x, y: unit.y, id: unit.id });
          // the clips (header); (强击瓶专家 / `opened` are set at this cast's skillStart, after onStart)
          const begin = stateOf(unit).opened ? S2_BEGIN : S2_BEGIN_FIRST;
          const loopsEnd = begin + counts.length * S2_LOOP;
          stateOf(unit).s2 = { t0: battle.time, next: 0, begin, landAt: loopsEnd + S2_END_HIT, landed: false };
          const over = loopsEnd + S2_END - skill.duration;
          if (over > 1e-9) skill.extend(over);
        },
        onTick({ battle, unit }) {
          const s = stateOf(unit).s2;
          if (!s) return;
          const t = battle.time - s.t0 + 1e-9; // (from the cast, whichever phase of its tick the cast came in)
          while (s.next < counts.length && t >= s.begin + s.next * S2_LOOP + S2_LOOP_HIT) fire(battle, unit, s);
          if (!s.landed && s.next >= counts.length && t >= s.landAt) land(battle, unit, s);
        },
        onEnd({ battle, unit, reason }) {
          const st = stateOf(unit), s = st.s2;
          st.s2 = null;
          if (s && !s.landed && reason === 'duration' && up(unit)) {
            while (s.next < counts.length) fire(battle, unit, s);
            land(battle, unit, s);
          }
          battle.removeBuff(unit, FLIGHT_KEY);
          battle.releaseBlocked(unit); // the flyers she held while airborne
        },
      };
    }
    if (s3) {
      const b = s3.bb ?? {};
      const m = String(s3.desc ?? '').match(S3_CHARGE_RE);
      const wait = m ? +m[1] : 2 * num(b.wait_duration, 1.5);
      skills[S3] = {
        kind: num(s3.maxChargeTime, 1) > 1 ? 'charges' : 'instant',
        onStart({ battle, unit }) {
          const st = stateOf(unit);
          const w = wait + (st.opened ? 0 : FIRST_OPEN_EXTRA); // (`opened` is set at this cast's skillStart, after onStart)
          const token = {};
          st.charge = token;
          // the charge and Skill_3_End: no attack, no other cast (the end of Skill_3_End removes it)
          battle.addBuff(unit, { key: CHARGE_KEY, duration: w + END3 + TICK, flags: { disarm: true }, tags: ['skill'] });
          battle.after(w + END3_HIT, () => { if (st.charge === token && up(unit)) launchArrow(battle, unit, b); }, { owner: unit });
          battle.after(w + END3, () => {
            if (st.charge !== token) return;
            st.charge = null;
            battle.removeBuff(unit, CHARGE_KEY);
          }, { owner: unit });
        },
      };
    }
    return {
      trait: { hits: NORMAL_HITS, hitDmgMul: ds, atkScale: baseScale },
      skills,
      talents: [
        { install(battle, unit) { // 强击瓶专家
          const count = Math.floor(num(t0.power_attack_count)), scale = num(t0.power_attack_scale, 1);
          if (!(count > 0) || !(scale > 0) || scale === 1) return;
          const st = stateOf(unit);
          battle.on('deploy', (c) => {
            if (c.unit !== unit || c.move) return;
            st.left = 0;
            battle.removeBuff(unit, POWER_KEY);
          }, { owner: unit, priority: 10 });
          battle.on('skillStart', (c) => { // (`opened` turns true after this handler: kit install)
            if (c.unit !== unit || st.opened) return;
            st.left = count;
            battle.addBuff(unit, { key: POWER_KEY, mods: { atkScaleMul: scale }, source: unit, visible: true, tags: ['talent'] });
          }, { owner: unit, priority: 10 });
          // a normal attack / S1's cast: its round leaves with the attack; its arrows land later with the multiplier of the
          // launch — `rounds` (attackId → powered), the last ROUNDS_KEPT launches
          const rounds = new Map();
          battle.on('attack', (c) => {
            if (c.attacker !== unit || !c.targets.length) return;
            const powered = st.left > 0;
            takeRound(battle, unit);
            if (!c.attackId) return;
            rounds.set(c.attackId, powered);
            if (rounds.size > ROUNDS_KEPT) rounds.delete(rounds.keys().next().value);
          }, { owner: unit });
          battle.on('hit', (c) => {
            const d = c.dmg;
            if (c.source !== unit || !d.attackId || !rounds.has(d.attackId) || (Array.isArray(d.tags) && d.tags.includes(COMBO_TAG))) return;
            const want = rounds.get(d.attackId) ? scale : 1, have = unit.findBuff(POWER_KEY) ? scale : 1;
            if (want !== have) d.amount *= want / have;   // atkScaleMul is a product: the window's factor swapped exactly
          }, { owner: unit });
        } },
        { install(battle, unit) { // 翔虫机动
          if (respawn && !unit.mem.orchd2Respawn) {
            unit.mem.orchd2Respawn = true;
            unit.base.respawnTime = Math.max(0, unit.base.respawnTime + respawn);
          }
          const tb = t1?.bb ?? {};
          const atk = num(tb.atk), dur = num(tb.atk_duration);
          const name = t1?.bbStr?.ignore_build_type_target_range ?? '';
          const grid = Object.hasOwn(RANGE_TABLE, name) ? RANGE_TABLE[name] : null;
          if (!(atk > 0) || !(dur > 0) || !grid) return;
          const st = stateOf(unit);
          battle.on('death', (c) => { if (c.unit === unit) st.exit = [unit.tileR, unit.tileC]; }, { owner: unit });
          battle.on('deploy', (c) => {
            if (c.unit !== unit || c.move) return;
            const ex = st.exit;
            st.exit = null;
            if (!ex || !absoluteRangeKeys(grid, ex[0], ex[1], 'RIGHT', 0).includes(unit.tileR * COLS + unit.tileC)) return;
            battle.addBuff(unit, { key: WIREBUG_KEY, duration: dur, mods: { atkPct: atk }, source: unit, visible: true, tags: ['talent'] });
            battle.fx('buff', { x: unit.x, y: unit.y, id: unit.id });
          }, { owner: unit });
        } },
      ],
      install(battle, unit) {
        const sid = unit.skill?.id ?? null;
        // `opened`: a skill opened in this deployment (the first opening's Skill_X_Begin_First, 强击瓶专家); a 【移动】 keeps it.
        // The reset runs before S2's free deploy cast, the mark after 强击瓶专家's skillStart handler.
        const st = stateOf(unit);
        battle.on('deploy', (c) => { if (c.unit === unit && !c.move) st.opened = false; }, { owner: unit, priority: 20 });
        battle.on('skillStart', (c) => { if (c.unit === unit) st.opened = true; }, { owner: unit, priority: -10 });
        // S1 "充能至最大层数时自动释放一次": at full charges, also inside the operation cooldown (which it leaves unchanged)
        if (sid === S1) {
          battle.on('tick', () => {
            const sk = unit.skill;
            if (!sk || sk.maxCharges < 2 || sk.charges < sk.maxCharges || sk.pending || !sk.opCooling) return;
            if (!up(unit) || !unit.canAct || unit.s.flags.silence || !attackTargets(battle, unit).length) return;
            const ready = sk.opReadyAt;
            if (sk.activate('auto')) sk.opReadyAt = ready;
          }, { owner: unit });
        }
        // S3: the attack its DEFAULT cast was made for is dropped (the charge disarms her from the next tick on); a knock-out
        // loses the charge
        if (sid === S3) {
          battle.on('beforeAttack', (c) => { if (c.attacker === unit && stateOf(unit).charge) c.targets = []; }, { owner: unit, priority: 100 });
          battle.on('death', (c) => { if (c.unit === unit) stateOf(unit).charge = null; }, { owner: unit });
        }
        // S1: a knock-out loses the 刚连射 settled at the cast
        if (sid === S1) battle.on('death', (c) => { if (c.unit === unit) stateOf(unit).combo = null; }, { owner: unit });
        // S2 "部署后立即释放一次": a free cast at every deployment
        if (sid === S2) {
          battle.on('deploy', (c) => {
            const sk = unit.skill;
            if (c.unit === unit && sk && !sk.active) sk.activate('deploy', { free: true });
          }, { owner: unit });
        }
      },
    };
  },
};
