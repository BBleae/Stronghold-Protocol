// server/sim/content/kits/ops/op-oblvns.js — 丰川祥子 (char_4182_oblvns) 自选 operator kit: 6★ 领主 (近卫), a collab pick of
// this fork (tools/build-data.mjs FORK_INCLUDE_COLLAB_PICKS — the fork owner's decision of 2026-10-08: the 7 collab 6★ that
// upstream leaves out of 自选 come back in full) for the tier-5 and tier-6 自选 slots; every skill, both talents, the trait
// and the module LOR-Y at every form. Kit contract and the 自选 rules: ../README.md ("How to add an operator (自选)").
//
// Forms (data/backups.json units.char_4182_oblvns, the DIY slot statuses): normal = E2 Lv1, skills at rank 4, no module;
// elite = E2 Lv60, rank 7, the module at stage 1 (tier 5) or 3 (tier 6). Full potential (the owner's decision of
// 2026-10-07: 毋畏遗忘's ASPD +16 is the potential-5 candidate). Faction mujica ⇒ the 协防 bond (data), not the kit's business.
// Sources: character_table / skill_table / battle_equip_table (zh_CN, as built into backups.json); PRTS 丰川祥子 (天赋 / 技能 /
// 模组 备注: the note movement tables, "持续攻击", "未阻挡敌人时发射的音符视为远程攻击…", "阻挡敌人时发射的音符视为近战攻击，即使阻挡
// 目标死亡…也不会应用特性的80%倍率", "所有音符强制使用缓存攻击力与攻击倍率", "丰川祥子命中目标的当个音符可计入音符数量", "攻击范围
// 内不存在敌人时，若自身朝向的前方一格地块的通行类型为无，持续攻击无法发射音符", "因充能到达上限自动释放时，不会触发Fever", "携带此技能时，
// <Y模组>强化后的第一天赋始终将自身视为技能期间", the 毋畏遗忘 range-extension notes, 残月的余响 "效果需要处于技能期间生效，优先级-3000"
// / "若效果的持有者存在不死，免死通常不触发" / "…结束时/自身退场时退场", LOR-Y "仅未开启技能时的攻击范围可享受该特性加成"); PRTS 术语释义
// ba.fever (450 points shared by every member for the whole battle, 20 s, "耗尽且不累积Fever值", "无视技力限制地持续尝试开启技能
// （切换类技能除外）…不消耗技力", "通过Fever状态开启的持续类技能将在Fever状态结束时强制结束；进入Fever状态前正在释放的持续类技能暂停计
// 时，直至Fever状态结束"), ba.mujica (the five members), ba.permanentatk ("无论攻击范围内是否有攻击目标，都会持续进行攻击"); PRTS
// 卫戍协议/帮助 §技能操作 ("携带状态切换类技能的干员…每次部署后仅开启一次技能").
//
// - Trait (领主) "可以进行远程攻击，但此时攻击力降低至80%" (trait bb atk_scale): range 3-12, hits air units (data canHitFly),
//   blocks 2. Every attack plays notes (T1) and the 80 % is decided per note AT ITS LAUNCH (PRTS): launched while she blocks
//   an enemy ⇒ a melee note at 100 % (whatever it hits later), else ×atk_scale — not the branch's target-tile rule
//   (professions.js lord dmgMul, unused here). The engine's own shot of each attack lands nothing (trait hitsFn 0): it stays
//   the attack shell — targeting, the attack interval, attack SP, the `attack` hook, the client's 'atk' event — and the notes
//   are this kit's.
// - Module LOR-Y 无言的约定 (stage 1 / 3: HP / ATK / ASPD from the record): trait "攻击范围内存在2名及以上敌人时攻击速度+12"
//   (trait bb attack_speed): ASPD +attack_speed while two or more enemies she can target stand on her skill-off range
//   (baseRangeKeys — PRTS "仅未开启技能时的攻击范围可享受该特性加成": S3's 3-21 does not count [ASSUMED reading]). Stage 2+
//   (oblvns_equip_1_2_p1 / _p2, the hidden talent part): 颂乐音符 5 % / 2.5 % up to 12 notes (the record's talent bb) and
//   "技能期间远程攻击不再降低攻击力": no ×atk_scale on notes launched during a skill — the S1 fan, S3, and with S2 always (PRTS
//   "携带此技能时…始终将自身视为技能期间").
// - T1 颂乐音符 "可以持续攻击且攻击会演奏追踪敌人的音符，音符飘出攻击范围一段时间后消失。每存在一个音符，Ave Mujica成员无视敌人3%的
//   防御力和2%法术抗性（最多叠加至10层）":
//   · 持续攻击: an attack check that finds no target still attacks (trait `storeEnergy`, the attack loop's no-target path):
//     a target-less note, attack SP as for any attack [ASSUMED: the 持续攻击 is her attack ability firing — S1's "充能至最大层数时
//     自动释放" exists for charges filled this way], no `attack` hook (nothing was attacked); none at all — no attack — when the
//     tile in front of her is impassable (`pass` NONE) or off the battle's rect [ASSUMED: no tile there].
//   · Notes (PRTS note tables, NOTE below; the logic frame is the engine's TICK, 1/30 s): each starts on her, heading her
//     facing turned by a random angle within ±attack@angle (20°) (S1: its fixed fan); it moves freely at its free speed (the
//     "扩张正弦" sway is not modelled [ASSUMED: its x speed is the drift]); every `update` s it re-evaluates (PRTS: "不存在追踪
//     目标时：选择自身一定范围内距离音符自身最近的可选目标并设置为追踪目标；随后若存在有效追踪目标且已经过最短自由移动时间：切换至【追踪移动】
//     状态"): with no valid tracking target (its launch target is its first) it takes the nearest enemy she can target within
//     its search radius of the note — at every update, its minimum free time or not —, and once that time has passed and it
//     holds a valid one it starts tracking it; tracking turns its heading by `turn` of the way per frame (dir × (1 − w) +
//     toTarget × w) at its tracking speed and
//     hits on reaching the target (within NOTE_HIT_RADIUS [ASSUMED: about an enemy collider]); a target that becomes invalid
//     sends it back to free movement at its next update. A note with no tracking target outside her current attack range for
//     more than `delay` (1) s disappears; when she leaves the field every note not tracking is cleared, a tracking one still
//     lands (credited to her) and goes once it loses its target; NOTE_MAX_AGE caps a chase [ASSUMED]. Damage = the ATK cached at
//     launch × the note's scale × the launch's 80 % rule, one damage instance per hit, `isAttack` (a normal attack's),
//     physical (her damage type) unless a skill says otherwise. The client shows the attack (her 'atk' event, no shot: the
//     trait's projectile 'none'; a 持续攻击 with no target sends one with no target — her swing and its sound, PRTS
//     ba.permanentatk "无论攻击范围内是否有攻击目标，都会持续进行攻击") and each note where it strikes (fx NOTE_FX) — no flight
//     of its own.
//   · Penetration: on every damage instance an Ave Mujica member on the field deals an enemy (the `hit` step), DEF ignored
//     n × def_penetrate_ratio and RES n × magic_resist_penetrate_ratio, n = her notes existing (the one hitting included), at
//     most max_cnt; several 丰川祥子 on one field: the strongest one counts [ASSUMED: 同名效果]; only while she is on the field.
// - T2 毋畏遗忘 "对敌人造成伤害时使Fever+3；其他Ave Mujica成员的攻击范围若与自身原本攻击范围重合，则将其视作攻击范围的延伸；攻击范围内
//   干员攻击速度+16" (bb cnt, enable, attack_speed):
//   · Fever: one gauge per battle field shared by every member (FIELD), +cnt for each damage instance she deals an enemy while
//     on the field (the `hit` step: a dodged one counts — PRTS), up to FEVER_MAX (450). Full, a member's MANUAL skill started
//     by the 技能策略 (standing for the player's 开启 [ASSUMED]; never S1's full-charge auto-release — PRTS —, nor a Fever cast)
//     starts the Fever for FEVER_DURATION (20) s: the gauge empties and gains nothing meanwhile; every member on the field
//     keeps (re)starting its skill for free, SP untouched — S1: every attack is its fan; a timed skill starts and is ended with
//     the Fever ("强制结束"); a 切换类 skill (S2) never, and it cannot be switched by hand meanwhile (its operation cooldown
//     held to the Fever's end); a timed skill already running — the S3 cast that started it included [ASSUMED: it runs as the
//     Fever begins, "进入Fever状态前正在释放"] — is paused until the Fever ends, then runs its remaining time. The BGM switch
//     is the client's (not modelled).
//   · Range extension: every RANGE_IV s, the regular range (liveRangeGrid: no extension) of each other Ave Mujica member on the
//     field that overlaps hers is added to her range (Battle.setExtraRange) — only with another 丰川祥子 in this mode.
//   · ASPD +attack_speed to every operator (kind 'op' — 干员, not summons [ASSUMED]) standing on her current attack range,
//     herself included (her tile is in it) [ASSUMED], refreshed every AURA_IV s; several sources: the strongest.
// - S1 新月的苏醒 (MANUAL, attack SP, 2 charges, data DEFAULT): the attack it is cast with plays 8 notes in a fan of ±angle
//   (8 equal sectors: ±13.125° every 3.75°, PRTS), from her left to her right, the i-th dealing atk_scale_i (65 % … 4 %) ×
//   ATK arts, all tracking the attack's target (none: free); "充能至最大层数时自动释放一次": with both charges stored she casts
//   once by herself (no operation cooldown — not a 技能策略 operation —, no Fever start).
// - S2 满月的舞会 (MANUAL, attack SP, data DEFAULT): a 切换类 skill (PRTS ba.fever "切换类技能"), switched once per deployment
//   (the official rule above: kind `toggle`). 钢琴 (the initial timbre, from every deployment [ASSUMED: its numbers apply before
//   any switch]): ATK +attack@atk, physical notes with the 钢琴 table — on hitting its target a note collides (radius 0.8) with
//   every enemy it passes for attack@passby_delay s at 3.0 tiles/s, each once ("命中目标后穿过敌人造成物理伤害"; the target too);
//   after the switch, 风琴: ASPD +attack@attack_speed, arts notes with the 风琴 table. Fever: "当前音色的二连击" — two notes per
//   target each attack [ASSUMED]. PRTS 备注 "可以触发Fever时，触发技能将仅触发Fever，不进行技能形态切换": a cast that starts the
//   Fever (a full gauge) leaves her on her timbre — the cast ends at once, her 钢琴 stays —, so the 钢琴 二连击 plays through
//   that Fever [ASSUMED: the cast spends its SP as any trigger, and the deployment's one switch stays for a later cast].
// - S3 残月的余响 (MANUAL, attack SP, 25 s, data ACTIVE_RANGE on its 3-21): range 3-21; each attack plays 2 钢琴 notes,
//   physical, tracking the enemy of highest RES, and 2 风琴 notes, arts, tracking the one of highest DEF ("分别追踪" read with
//   S2's timbres [ASSUMED]) — among her targets (range + blocked), ties in the usual target order — each attack@atk_scale ×
//   ATK, the S3 note table. "Fever期间Ave Mujica成员受到致命伤害时不撤退，Fever结束后退场": during a Fever, while a 丰川祥子's S3
//   runs, a member's lethal damage is prevented (priority −3000, after every saver; not when it already holds 不死) and it
//   holds 不撤退 (flag undying) until the Fever ends, that S3 ends or she leaves the field — then it 退场 (a retreat with the
//   death animation, as 史尔特尔's 余烬 [ASSUMED]); once per member and Fever.
// Statuses applied: none. Summons: none.

import { num, talentBb, traitBb, skillRec, up, installAura, toggleBuff } from '../shared/tier1.js';
import { COLS, ROWS } from '../../../constants.js';
import { absoluteRangeKeys, canTargetEnemy, sortEnemyTargets } from '../../../targeting.js';
import { frontOf } from '../../../dir.js';
import { bodyDist } from '../../../body.js';
import { hasHp } from '../../../damage.js';
import { holdsUndying, PRIO_UNDYING_HELD } from '../../items/battle.js';

export const OBLVNS = 'char_4182_oblvns';
const S1 = 'skchr_oblvns_1';
const S2 = 'skchr_oblvns_2';
const S3 = 'skchr_oblvns_3';
/** PRTS 术语释义 ba.mujica "包括丰川祥子、八幡海铃、三角初华、祐天寺若麦、若叶睦" (character_table teamId mujica). */
export const AVE_MUJICA = Object.freeze(new Set(['char_4182_oblvns', 'char_4183_mortis', 'char_4184_dolris', 'char_4185_amoris', 'char_4186_tmoris']));
/** PRTS 术语释义 ba.fever: "Fever累计至450点时…在场所有Ave Mujica成员20秒内会持续释放当前技能". */
export const FEVER_MAX = 450;
export const FEVER_DURATION = 20;
/**
 * The note movement tables (PRTS 丰川祥子 备注): `update` 更新间隔 (s), `minFree` 最短自由移动时间 (s), `freeSpeed` the free
 * movement's (x) speed and `radius` its 追踪范围半径 (tiles), `speed` / `turn` the tracking speed and 转向权重 per frame; `pass`
 * the 命中状态 of the 钢琴 notes (collision radius, fixed speed; its time is S2's attack@passby_delay). `free` / `aimed` = the
 * talent's notes launched without / with a target.
 */
export const NOTE = Object.freeze({
  free: Object.freeze({ update: 0.4, minFree: 0.1, freeSpeed: 1.3, radius: 1.0, speed: 2.0, turn: 7 / 30 }),
  aimed: Object.freeze({ update: 0.4, minFree: 0.1, freeSpeed: 2.0, radius: 1.0, speed: 2.0, turn: 1 / 6 }),
  s1: Object.freeze({ update: 0.2, minFree: 0.6, freeSpeed: 1.7, radius: 1.0, speed: 2.2, turn: 1 / 6 }),
  piano: Object.freeze({ update: 0.2, minFree: 0.4, freeSpeed: 1.9, radius: 0.8, speed: 3.5, turn: 1 / 2, pass: Object.freeze({ radius: 0.8, speed: 3.0 }) }),
  organ: Object.freeze({ update: 0.4, minFree: 0.4, freeSpeed: 0.7, radius: 1.0, speed: 1.0, turn: 1 / 12 }),
  s3: Object.freeze({ update: 0.4, minFree: 0.8, freeSpeed: 0.8, radius: 1.0, speed: 1.3, turn: 1 / 4 }),
});
/** A tracking note hits within this distance of its target (+ its step) [ASSUMED: about an enemy collider]. */
export const NOTE_HIT_RADIUS = 0.25;
/** The fx of a note striking an enemy (public/js/render/fx/kinds.js: a spark on the struck enemy as its damage shows). */
export const NOTE_FX = 'oblvnsNote';
/** No note outlives this (a chase after a fast target) [ASSUMED: a safety cap no source names]. */
const NOTE_MAX_AGE = 20;
/** Refresh period of 毋畏遗忘's ASPD aura and of its range extension [ASSUMED]. */
const AURA_IV = 0.25;
const RANGE_IV = 0.25;
/** 残月的余响's 不撤退 in the `fatal` step: PRTS "优先级-3000" — after every saver of the engine (10 … −100.5). */
const PRIO_SAVE = -3000;
export const PIANO_KEY = 'skill:oblvns:piano';
export const ASPD_KEY = 'talent:oblvns:aspd';
export const LORY_KEY = 'trait:oblvns:lory';
export const SAVE_KEY = 'skill:oblvns:save';
/** Skill starts that are no manual 开启: a Fever cast, S1's full-charge release, deployment and passive starts. */
const NOT_MANUAL = Object.freeze(new Set(['oblvnsFever', 'oblvnsAutoRelease', 'deploy', 'passive']));
/** Whether a skill start of `u` (`reason`) starts the Fever: a member's manual 开启 on a full gauge, no Fever running. */
function startsFever(battle, u, sk, reason) {
  if (!isMember(u) || !sk || !sk.manual || NOT_MANUAL.has(reason) || !up(u)) return false;
  const f = FIELD.get(battle)?.fever;
  return !!f && !f.active && f.value >= FEVER_MAX - 1e-9;
}
/** S3's 3-21 when a record carries none. */
const R3_21 = Object.freeze([[2, 0], [2, 1], [1, 0], [1, 1], [1, 2], [1, 3], [0, 0], [0, 1], [0, 2], [0, 3], [-1, 0], [-1, 1], [-1, 2], [-1, 3], [-2, 0], [-2, 1]]);
const AIR = Object.freeze({ canHitFly: true });

const bbOf = (chess, id) => skillRec(chess, id)?.bb ?? {};
const charOf = (u) => u?.def?.charId ?? u?.def?.raw?.charId ?? null;
const isMember = (u) => !!u && u.side === 'ally' && AVE_MUJICA.has(charOf(u));
const profOf = (u) => u.profile ?? AIR;

/** Per battle field: the notes in flight (+ a count per owner), the 丰川祥子 units, the Fever, the members S3 holds. */
const FIELD = new WeakMap();
/** Per 丰川祥子 unit: the numbers of her record. */
const CFG = new WeakMap();

/** The field state of a battle (null before any 丰川祥子 was set up) — for tests and debugging. */
export function oblvnsField(battle) { return FIELD.get(battle) ?? null; }
/** Her notes existing now. */
export const notesOf = (battle, unit) => FIELD.get(battle)?.count.get(unit) ?? 0;

function fieldOf(battle) {
  let st = FIELD.get(battle);
  if (st) return st;
  st = { notes: [], count: new Map(), providers: [], saved: [], fever: { value: 0, active: false, until: 0, id: 0 } };
  FIELD.set(battle, st);
  // battle-wide handlers, no owner: the notes land and the Fever runs on after a 丰川祥子 left for good
  battle.on('hit', (c) => onHit(st, c));
  battle.on('skillStart', (c) => onSkillStart(battle, st, c));
  battle.on('fatal', (c) => { if (!c.prevented && c.unit && c.unit.findBuff(SAVE_KEY)) c.prevented = true; }, { priority: PRIO_UNDYING_HELD });
  battle.on('fatal', (c) => trySave(battle, st, c), { priority: PRIO_SAVE });
  battle.on('tick', () => fieldTick(battle, st));
  return st;
}

// ---------------------------------------------------------------------------------------------------------------
// 颂乐音符's penetration and 毋畏遗忘's gauge (the `hit` step: before mitigation and the dodge roll)

function onHit(st, c) {
  const src = c.source, tgt = c.target;
  if (!src || !tgt || tgt.side !== 'enemy' || !c.dmg || !isMember(src) || !up(src)) return;
  const own = CFG.get(src);
  if (own && own.cnt > 0 && !st.fever.active) st.fever.value = Math.min(FEVER_MAX, st.fever.value + own.cnt);
  let best = null, bestN = 0, bestPen = 0;
  for (const p of st.providers) {
    const cfg = CFG.get(p);
    if (!cfg || !up(p)) continue;
    const n = Math.min(st.count.get(p) ?? 0, cfg.maxCnt);
    const pen = n * (cfg.defRatio + cfg.resRatio * 1e-6);
    if (n > 0 && pen > bestPen) { best = cfg; bestN = n; bestPen = pen; }
  }
  if (!best) return;
  c.dmg.defIgnorePct = num(c.dmg.defIgnorePct) + bestN * best.defRatio;
  c.dmg.resIgnorePct = num(c.dmg.resIgnorePct) + bestN * best.resRatio;
}

// ---------------------------------------------------------------------------------------------------------------
// Fever

function onSkillStart(battle, st, c) {
  const u = c.unit, sk = c.skill;
  if (!startsFever(battle, u, sk, c.reason)) return;
  const f = st.fever;
  f.active = true;
  f.value = 0;
  f.id++;
  f.until = battle.time + FEVER_DURATION;
  // "可以触发Fever时，触发技能将仅触发Fever，不进行技能形态切换": a 切换类 skill's cast only starts it (its onStart kept the timbre)
  if (sk.kind === 'toggle' && sk.active) sk.end('fever');
  for (const m of battle.allyUnits) {
    if (!isMember(m) || !up(m)) continue;
    const s = m.skill;
    // a timed skill running as the Fever begins (the cast that started it included) pauses until it ends
    if (s && s.active && s.kind === 'duration' && Number.isFinite(s.timeLeft)) m.mem.oblvnsPause = { fever: f.id, act: s.activations, left: s.timeLeft };
    battle.fx('buff', { x: m.x, y: m.y, id: m.id, kind: 'fever', dur: FEVER_DURATION });
  }
}

function feverCasts(battle, st) {
  const f = st.fever;
  for (const m of battle.allyUnits) {
    if (!isMember(m)) continue;
    const sk = m.skill;
    if (!sk || sk.noSkill || sk.kind === 'passive') continue;
    // 切换类技能: no Fever cast, and no switch by hand meanwhile ("期间，此技能无法手动开启")
    if (sk.kind === 'toggle') { if (!(sk.opReadyAt >= f.until)) sk.opReadyAt = f.until; continue; }
    const p = m.mem.oblvnsPause;
    if (p && p.fever === f.id) {
      if (sk.active && sk.activations === p.act) { sk.timeLeft = p.left; continue; }
      m.mem.oblvnsPause = null;
    }
    if (!up(m) || !m.canAct || m.s.flags.silence) continue;
    if (sk.active && (sk.isTimed || sk.pending)) continue;
    // an instant skill without a "next attack": once per attack of the member
    if (!sk.isTimed && !sk.spec.attack && m.mem.oblvnsFeverAtk === m.stats.attacks) continue;
    const prev = sk.opReadyAt;
    if (!sk.activate('oblvnsFever', { free: true })) continue;
    sk.opReadyAt = prev;   // no 技能策略 operation
    m.mem.oblvnsFeverAtk = m.stats.attacks;
    if (sk.active) {
      m.mem.oblvnsFeverCast = { fever: f.id, act: sk.activations };
      // a timed skill the Fever started ends with it: its bar runs out at the Fever's end (forced there by endFever)
      if (sk.kind === 'duration') sk.timeLeft = Math.max(battle.dt, f.until - battle.time + battle.dt);
    }
  }
}

function endFever(battle, st) {
  const f = st.fever;
  f.active = false;
  for (const m of battle.allyUnits) {
    if (!isMember(m)) continue;
    const sk = m.skill;
    const fc = m.mem.oblvnsFeverCast;
    m.mem.oblvnsFeverCast = null;
    if (sk && fc && fc.fever === f.id && sk.active && sk.activations === fc.act) sk.end('fever');
    const p = m.mem.oblvnsPause;
    if (p && p.fever === f.id) {
      if (sk && sk.active && sk.activations === p.act) sk.timeLeft = p.left;
      m.mem.oblvnsPause = null;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 残月的余响: 不撤退 during a Fever

/** A 丰川祥子 on the field whose S3 runs (the holder of the effect). */
const saverOf = (st) => st.providers.find((p) => up(p) && p.skill && p.skill.id === S3 && p.skill.active) ?? null;

function trySave(battle, st, c) {
  const a = c.unit;
  if (c.prevented || !st.fever.active || !isMember(a) || !up(a)) return;
  if (a.mem.oblvnsSaved === st.fever.id || holdsUndying(battle, a)) return;
  const holder = saverOf(st);
  if (!holder) return;
  c.prevented = true;
  a.mem.oblvnsSaved = st.fever.id;
  battle.addBuff(a, { key: SAVE_KEY, flags: { undying: true }, source: holder, visible: true, tags: ['skill'], data: { holder, fever: st.fever.id } });
  st.saved.push(a);
  battle.fx('undying', { x: a.x, y: a.y, id: a.id });
}

/** The held members leave once the Fever, their holder's S3 or the holder's stay on the field has ended. */
function releaseSaves(battle, st) {
  if (!st.saved.length) return;
  const keep = [];
  for (const a of st.saved) {
    const b = a.findBuff(SAVE_KEY);
    if (!b) continue;
    const h = b.data?.holder;
    const holds = st.fever.active && b.data?.fever === st.fever.id && up(h) && h.skill?.id === S3 && h.skill.active;
    if (holds && up(a)) { keep.push(a); continue; }
    battle.removeBuff(a, SAVE_KEY);
    if (up(a)) battle.retreat(a, { reason: 'retreat', dying: true });
  }
  st.saved = keep;
}

// ---------------------------------------------------------------------------------------------------------------
// notes

function fieldTick(battle, st) {
  const f = st.fever;
  if (f.active && battle.time >= f.until - 1e-9) endFever(battle, st);
  if (f.active) feverCasts(battle, st);
  releaseSaves(battle, st);
  if (st.notes.length) stepNotes(battle, st);
}

const inc = (st, u, n = 1) => st.count.set(u, (st.count.get(u) ?? 0) + n);

/** A valid target of her notes: alive, on the field, selectable by her (air units too). */
const validTarget = (o, e) => !!e && e.side === 'enemy' && e.alive && !e.hidden && canTargetEnemy(o, e, profOf(o));

/** The nearest enemy she can target within the note's search radius (ties: the earlier spawn). */
function search(battle, n) {
  let best = null, bd = Infinity;
  for (const e of battle.foesInRadius(n.x, n.y, n.P.radius)) {
    if (!validTarget(n.owner, e)) continue;
    const d = Math.hypot(e.x - n.x, e.y - n.y);
    if (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && best && e.spawnSeq < best.spawnSeq)) { bd = d; best = e; }
  }
  return best;
}

function strike(battle, n, e) {
  if (!e || !e.alive || !hasHp(e)) return;
  battle.fx(NOTE_FX, { x: e.x, y: e.y, id: e.id, src: n.owner.id, dmgType: n.type });
  battle.dealDamage(n.owner, e, { amount: n.amount, type: n.type, isAttack: true, isSkill: n.isSkill, attackId: n.attackId, tags: n.tags });
}

/** 钢琴's 命中状态: every enemy within its collision radius, each once. */
function collide(battle, n) {
  for (const e of battle.foesInRadius(n.x, n.y, n.P.pass.radius)) {
    if (n.hitSet.has(e) || !validTarget(n.owner, e)) continue;
    n.hitSet.add(e);
    strike(battle, n, e);
  }
}

/** Is the note's tile on her current attack range? */
function inRange(o, n) {
  if (!o.rangeKeySet) return false;
  const r = Math.round(n.y), c = Math.round(n.x);
  return r >= 0 && r < ROWS && c >= 0 && c < COLS && o.rangeKeySet.has(r * COLS + c);
}

/** Advance one note by a tick; false = it is gone. */
function stepNote(battle, n, dt) {
  const o = n.owner;
  const home = up(o) && o.deploySeq === n.seq;
  n.age += dt;
  if (n.age > NOTE_MAX_AGE) return false;
  if (!home && n.state !== 'track') return false;   // she left: every note not tracking is cleared
  if (n.state !== 'hit' && n.age >= n.nextUpdate - 1e-9) {
    n.nextUpdate += n.P.update;
    if (n.state === 'track' && !validTarget(o, n.target)) {
      if (!home) return false;
      n.state = 'free';
      n.target = null;
    }
    if (n.state === 'free') {
      // the target is chosen at every update; the minimum free time only holds back the tracking (PRTS, header)
      if (!validTarget(o, n.target)) n.target = home ? search(battle, n) : null;
      if (n.target && n.age >= n.P.minFree - 1e-9) n.state = 'track';
    }
  }
  if (n.state === 'track') {
    const e = n.target;
    const step = n.P.speed * dt;
    if (validTarget(o, e)) {
      const dx = e.x - n.x, dy = e.y - n.y, d = Math.hypot(dx, dy);
      const reach = e.hitArea ? bodyDist(e, n.x, n.y) : d;
      if (reach <= step + NOTE_HIT_RADIUS) {
        if (!n.P.pass) { strike(battle, n, e); return false; }
        n.state = 'hit';
        n.hitUntil = n.age + n.passDur;
        n.hitSet = new Set();
        collide(battle, n);
        return n.age < n.hitUntil - 1e-9;
      }
      if (d > 1e-9) {
        const w = n.P.turn;
        let vx = n.dx * (1 - w) + (dx / d) * w, vy = n.dy * (1 - w) + (dy / d) * w;
        const l = Math.hypot(vx, vy);
        if (l > 1e-9) { vx /= l; vy /= l; } else { vx = dx / d; vy = dy / d; }
        n.dx = vx;
        n.dy = vy;
      }
    }
    n.x += n.dx * step;
    n.y += n.dy * step;
    return true;
  }
  if (n.state === 'hit') {
    n.x += n.dx * n.P.pass.speed * dt;
    n.y += n.dy * n.P.pass.speed * dt;
    collide(battle, n);
    return n.age < n.hitUntil - 1e-9;
  }
  n.x += n.dx * n.P.freeSpeed * dt;
  n.y += n.dy * n.P.freeSpeed * dt;
  // "音符飘出攻击范围一段时间后消失": `delay` s outside her range with no tracking target
  if (inRange(o, n)) n.outFor = 0;
  else if ((n.outFor += dt) > n.delay + 1e-9) return false;
  return true;
}

function stepNotes(battle, st) {
  const dt = battle.dt;
  const keep = [];
  // (a hit may make her attack again — a note launched meanwhile is appended and stepped in this pass too)
  for (let i = 0; i < st.notes.length; i++) {
    const n = st.notes[i];
    if (battle._safe(() => stepNote(battle, n, dt), 'oblvns.note', n.owner) === true) keep.push(n);
    else inc(st, n.owner, -1);
  }
  st.notes = keep;
}

/** One note from her position: heading her facing turned `deg` (counter-clockwise = to her left). */
function addNote(st, unit, cfg, o) {
  const [fr, fc] = unit.fwd;
  const a = (o.deg * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
  st.notes.push({
    owner: unit, seq: unit.deploySeq, P: o.P, x: unit.x, y: unit.y, dx: fc * cs - fr * sn, dy: fc * sn + fr * cs,
    state: 'free', target: o.target ?? null, age: 0, nextUpdate: o.P.update, outFor: 0, delay: cfg.delay, passDur: cfg.passDur,
    amount: o.amount, type: o.type, isSkill: !!o.isSkill, attackId: o.attackId, tags: ['oblvns:note', `oblvns:${o.tag}`], hitUntil: 0, hitSet: null,
  });
  inc(st, unit);
}

/** Her targets for S3's tracking picks: her range and the enemies she blocks, in the usual order. */
function candidates(battle, unit) {
  const list = battle.enemiesInKeys(unit.rangeKeys || [], unit, profOf(unit));
  for (const e of battle.blockedTargets(unit, profOf(unit))) if (!list.includes(e)) list.push(e);
  sortEnemyTargets(battle, unit, list, profOf(unit).priority ?? null);
  return list;
}
const highest = (list, f) => list.reduce((b, e) => (b == null || f(e) > f(b) + 1e-9 ? e : b), null);

/**
 * The notes of one attack of hers (`targets` = the attack's targets, [] for a 持续攻击 with nothing in range; `fan` = the
 * attack S1 was cast with).
 */
function launch(battle, unit, targets, attackId, fan) {
  const cfg = CFG.get(unit);
  if (!cfg) return;
  const st = fieldOf(battle);
  const sk = unit.skill;
  const id = sk?.id ?? null;
  const s3 = id === S3 && sk.active;
  const organ = id === S2 && sk.active;
  const skillTime = fan || s3 || id === S2;
  const lord = unit.blocking.length > 0 || (cfg.noCutInSkill && skillTime) ? 1 : cfg.rangedScale;
  const atk = unit.s.atk * unit.s.atkScaleMul * lord;
  const aims = targets.filter((t) => t && t.side === 'enemy');
  const main = aims[0] ?? null;
  const rnd = () => battle.rng.range(-cfg.angle, cfg.angle);
  if (fan) {
    const k = cfg.fan.length, step = (2 * cfg.fanAngle) / k;
    for (let i = 0; i < k; i++) {
      addNote(st, unit, cfg, { P: NOTE.s1, target: main, deg: cfg.fanAngle - step / 2 - i * step, amount: atk * cfg.fan[i], type: 'arts', isSkill: true, attackId, tag: 's1' });
    }
    return;
  }
  if (s3) {
    const list = candidates(battle, unit);
    const byRes = highest(list, (e) => e.s.res) ?? main, byDef = highest(list, (e) => e.s.def) ?? main;
    for (let i = 0; i < 2; i++) addNote(st, unit, cfg, { P: NOTE.s3, target: byRes, deg: rnd(), amount: atk * cfg.s3Scale, type: 'phys', isSkill: true, attackId, tag: 'piano' });
    for (let i = 0; i < 2; i++) addNote(st, unit, cfg, { P: NOTE.s3, target: byDef, deg: rnd(), amount: atk * cfg.s3Scale, type: 'arts', isSkill: true, attackId, tag: 'organ' });
    return;
  }
  if (!aims.length) aims.push(null);
  if (id === S2) {
    const times = st.fever.active ? 2 : 1;   // Fever: 当前音色的二连击
    for (const t of aims) for (let i = 0; i < times; i++) {
      addNote(st, unit, cfg, { P: organ ? NOTE.organ : NOTE.piano, target: t, deg: rnd(), amount: atk, type: organ ? 'arts' : 'phys', isSkill: organ, attackId, tag: organ ? 'organ' : 'piano' });
    }
    return;
  }
  const type = profOf(unit).dmgType === 'arts' ? 'arts' : 'phys';
  for (const t of aims) addNote(st, unit, cfg, { P: t ? NOTE.aimed : NOTE.free, target: t, deg: rnd(), amount: atk, type, isSkill: false, attackId, tag: 'talent' });
}

/** 持续攻击 with no target (the attack loop's no-target path): false = no attack (the tile ahead is impassable). */
function freeAttack(battle, unit) {
  const [r, c] = frontOf(unit.tileR, unit.tileC, unit.dir);
  if (!battle.grid.inRect(r, c) || battle.grid.tile(r, c).pass === 'NONE') return false;
  const sk = unit.skill;
  const fan = !!(sk && sk.id === S1 && sk.active && sk.pending);
  unit.lastAttackAt = battle.time;
  unit.stats.attacks++;
  // the client's attack: her swing and its sound, with no target (render/app.js 'atk', audio.js)
  battle._ev(['atk', unit.id, null, 'none']);
  // an attack of its own: the id every damage instance of one attack shares (ai.js performAttack's counter)
  launch(battle, unit, [], battle.nextAttackId(), fan);
  if (sk) sk.onAttackPerformed([], fan);
  return true;
}

/** The record's numbers (one per kit build: form × module × skill). */
function configOf(chess) {
  const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1), tb = traitBb(chess);
  const b1 = bbOf(chess, S1), b2 = bbOf(chess, S2), b3 = bbOf(chess, S3);
  const fan = [num(b1.atk_scale)];
  for (let i = 2; b1[`atk_scale_${i}`] != null; i++) fan.push(num(b1[`atk_scale_${i}`]));
  // LOR-Y stage 2+: the module's hidden talent part (talent −1, oblvns_equip_1_2_p2 / 1_3_p2) — "技能期间远程攻击不再降低攻击力"
  const mod = chess?.module?.active ? (chess.modules ?? []).find((m) => m && m.uniEquipId === chess.module.id) : null;
  const changes = mod?.talentChanges ?? [];
  const noCutInSkill = changes.some((t) => t && t.talentIndex === -1)
    || /技能期间远程攻击不再降低攻击力/.test(String(changes.find((t) => t && t.talentIndex === 0)?.desc ?? ''));
  return {
    defRatio: num(t0.def_penetrate_ratio), resRatio: num(t0.magic_resist_penetrate_ratio), maxCnt: Math.max(0, Math.floor(num(t0.max_cnt, 10))),
    delay: num(t0.delay, 1), angle: num(t0['attack@angle'], 20),
    enable: num(t1.enable), cnt: num(t1.cnt), aura: num(t1.attack_speed),
    rangedScale: num(tb.atk_scale, 0.8), loryAspd: num(tb.attack_speed), noCutInSkill,
    fan, fanAngle: num(b1.angle, 15),
    pianoAtk: num(b2['attack@atk']), organAspd: num(b2['attack@attack_speed']), passDur: num(b2['attack@passby_delay'], 0.5),
    s3Scale: num(b3['attack@atk_scale'], 1),
  };
}

/**
 * 毋畏遗忘's range extension: the regular ranges of the other Ave Mujica members on the field that overlap hers. Only the
 * keys this kit set are ever replaced (another effect's extra range is left alone while no member is around).
 */
function extendRange(battle, unit) {
  if (!up(unit)) return;
  const regular = (u) => absoluteRangeKeys(u.liveRangeGrid || u.rangeGrid || [[0, 0]], u.tileR, u.tileC, u.dir, 0);
  const set = new Set(regular(unit));
  const extra = [];
  for (const m of battle.allyUnits) {
    if (m === unit || !up(m) || !isMember(m)) continue;
    const ks = regular(m);
    if (!ks.some((k) => set.has(k))) continue;
    for (const k of ks) if (!set.has(k)) { set.add(k); extra.push(k); }
  }
  const mine = unit.mem.oblvnsExtra ?? null;
  if (!mine && !extra.length) return;
  if (mine && mine.length === extra.length && mine.every((k, i) => k === extra[i])) return;
  unit.mem.oblvnsExtra = extra.length ? extra : null;
  battle.setExtraRange(unit, extra.length ? extra : null);
}

export default {
  char_4182_oblvns: (bb, chess) => {
    const cfg = configOf(chess);
    const grid3 = skillRec(chess, S3)?.rangeGrid ?? R3_21;
    /** Register her once on the field (the talents install before the kit's `install`). */
    const prepare = (battle, unit) => {
      const st = fieldOf(battle);
      if (!CFG.has(unit)) { CFG.set(unit, cfg); st.providers.push(unit); }
      return st;
    };
    return {
      trait: {
        // the engine's shot of each attack lands nothing: her notes (T1) deal the damage — and it draws nothing either (no
        // arrow ahead of the notes): the client shows each note where it strikes (fx NOTE_FX)
        hitsFn: () => 0,
        projectile: 'none',
        // 持续攻击: no target ⇒ a target-less note (none when the tile ahead is impassable)
        storeEnergy: (battle, unit) => freeAttack(battle, unit),
      },
      skills: {
        // the attack the cast makes is the fan (launched by the `attack` hook of 颂乐音符)
        [S1]: { kind: 'charges', attack: { oblvnsFan: true } },
        // 钢琴 → 风琴, once per deployment (切换类)
        [S2]: {
          kind: 'toggle',
          mods: { aspd: cfg.organAspd },
          onStart({ battle, unit, skill, reason }) {
            if (startsFever(battle, unit, skill, reason)) return;   // only the Fever: no switch, 钢琴 stays (onSkillStart ends it)
            battle.removeBuff(unit, PIANO_KEY);
          },
        },
        [S3]: { kind: 'duration', targeting: { rangeGrid: grid3 } },
      },
      talents: [
        { install(battle, unit) { // 颂乐音符: every attack plays its notes
          prepare(battle, unit);
          battle.on('attack', (c) => {
            if (c.attacker !== unit) return;
            const sk = unit.skill;
            const fan = !!(sk && sk.id === S1 && sk.active && sk.pending && c.isSkill);
            launch(battle, unit, c.targets || [], c.attackId ?? 0, fan);
          }, { owner: unit });
        } },
        { install(battle, unit) { // 毋畏遗忘: the gauge is the field's (onHit); the ASPD aura and the range extension
          prepare(battle, unit);
          if (!(cfg.enable > 0)) return;
          if (cfg.aura > 0) {
            installAura(battle, unit, {
              key: ASPD_KEY, value: cfg.aura, mods: { aspd: cfg.aura }, interval: AURA_IV,
              select: (a) => a.kind === 'op' && !!unit.rangeKeySet && unit.rangeKeySet.has(a.tileR * COLS + a.tileC),
            });
          }
          battle.every(RANGE_IV, () => extendRange(battle, unit), { owner: unit });
        } },
      ],
      install(battle, unit) {
        const st = prepare(battle, unit);
        // LOR-Y: ASPD + while 2+ enemies stand on her skill-off range
        if (cfg.loryAspd > 0) {
          toggleBuff(battle, unit, LORY_KEY, () => battle.enemiesInKeys(unit.baseRangeKeys || [], unit, profOf(unit)).length >= 2, { aspd: cfg.loryAspd });
        }
        if (unit.skill?.id === S2) {
          // 钢琴, the initial timbre, from every deployment
          battle.on('deploy', (c) => {
            if (c.unit !== unit || c.move || unit.skill.active || !(cfg.pianoAtk > 0)) return;
            battle.addBuff(unit, { key: PIANO_KEY, mods: { atkPct: cfg.pianoAtk }, tags: ['skill'] });
          }, { owner: unit });
        }
        if (unit.skill?.id === S1) {
          // "充能至最大层数时自动释放一次": not a 技能策略 operation (no cooldown), no Fever start
          battle.on('tick', () => {
            const sk = unit.skill;
            if (!up(unit) || !unit.canAct || unit.s.flags.silence || st.fever.active || sk.pending || sk.charges < sk.maxCharges) return;
            const prev = sk.opReadyAt;
            if (sk.activate('oblvnsAutoRelease')) sk.opReadyAt = prev;
          }, { owner: unit });
        }
      },
    };
  },
};
