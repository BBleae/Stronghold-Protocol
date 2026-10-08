// server/sim/content/kits/ops/op-marcil.js — 玛露西尔 (char_4141_marcil) 自选 operator kit: 6★ 扩散术师 (术师), a collab pick of
// this fork (tools/build-data.mjs FORK_INCLUDE_COLLAB_PICKS, the fork owner's decision of 2026-10-08: the 7 collab 6★ upstream
// leaves out of 自选 come back in full); every skill, both talents, the trait and her module at every form.
// Kit contract and the 自选 rules: ../README.md ("How to add an operator (自选)").
//
// Forms (data/backups.json units.char_4141_marcil, the DIY slot statuses): normal = E2 Lv1, skills at rank 4, no module;
// elite = E2 Lv60, rank 7, SPC-Y “才女的藏书” at stage 1 (tier 5) or 3 (tier 6). Full potential (the owner's decision of
// 2026-10-07). Sources: character_table / skill_table / battle_equip_table / range_table / activity_table (zh_CN, as built
// into backups.json; .cache/gamedata/excel); PRTS 玛露西尔 (天赋 / 技能 备注), PRTS 术语释义 (吟唱, 魔力, 停顿, 晕眩), PRTS
// 卫戍协议/帮助 (技能操作: 基础策略, 特殊策略 玛露希尔【召唤使魔】); Arknights Terra Wiki "Marcille".
//
// 魔力 (PRTS 术语释义: "特殊技力，整场战斗继承", "具有指定上限，持有魔力的干员在入场时将魔力转换为技能技力，退场时将剩余技力转换为魔力"):
// her skill's SP bar IS her mana. Its cap is the carried skill's mana_max (80 = the skill's spCost; PRTS 备注: the skill's SP
// requirement is "携带技能时对应的魔力上限" and SP-requirement modifiers do not change it — so her skill ignores the 盟约
// that scales spCostMul (绝技) and any flat cost change, from before the battle-start deployment fills her bar [ASSUMED:
// the talent's own mana_max 100 is not her cap while she carries a skill]). A battle starts with the
// skill's mana_init + every talent's mana_init (S1 25 / S2 10 / S3 40, + 可靠的同伴 25, SPC-Y stage 3: 40) — the SkillSpec
// `initSp`, so 联防 carries it as any SP [ASSUMED: every battle a fresh deployment, as every operator's initSp]. The skills
// are cast by this kit (`trigger: 'NEVER'`, the data's rules re-stated below): the engine's skill is ready only on a full
// bar, while hers opens on skill_cost_min_sp and spends per use; every opening is a free `activate` and the kit writes the
// bar (setMana). While one of her skills runs no SP is gained (the engine's rule for a running toggle skill; PRTS only
// says her SP is lost by nothing but her own spending meanwhile) [ASSUMED]. A 【移动】 (moveRedeploy, "不退场") is no new
// deployment for her (depOf): the mana, a running 吟唱 and S2's uses stay.
// - Trait (扩散术师) "攻击造成群体法术伤害": the profession default (ranged arts, splash 1.1 around the struck target — PRTS
//   溅射半径一览 —, hits air, block 1). Module SPC-Y "部署费用减少": its attributes only (cost −8, ATK +51 / +82, ASPD +5 / +7:
//   the composed record), stage 3 also 可靠的同伴's mana_init 40 (talentChanges).
// - T1 建校以来第一才女 (bb interval / mana_add / mana_max / mana_init / sp / atk; full potential 25 %): "技能消耗魔力且可随时开启"
//   (the casts below); "魔力不自然回复": the time SP gain loses the unit's base SP recovery (what a buff adds above it still
//   counts [ASSUMED]; SP gifts count — Terra Wiki: she benefits from SP-granting effects); "不在场时每秒回复1点": while she is
//   off the field after leaving it (knocked out, retreated) +mana_add per whole `interval` since she left, credited when she
//   comes back (PRTS: a devoured operator recovers none — no such state here); "有魔力时，攻击力+25%，攻击溅射范围扩大": while
//   her mana ≥ `sp` (PRTS 备注 "技力不小于1时第一天赋生效，此时溅射半径扩大至1.5") ATK +atk (直接乘算) and every attack she
//   makes splashes TALENT_SPLASH.
// - T2 可靠的同伴 (bb mana_init / attack_speed / def): the initial mana above; "编队中有4名【莱欧斯小队】干员时，所有【莱欧斯小队】
//   干员攻击速度+25，防御力+35%": four different 莱欧斯小队 operators (character_table teamId 'laios': 玛露西尔, 莱欧斯, 森西,
//   齐尔查克 — LAIOS_PARTY; the 4 is parsed from the text) among her player's operators of the battle ⇒ each of them ASPD
//   +attack_speed, DEF +def for the battle. None of the other three is an operator of this mode's data, so it never holds
//   in a match (its test fields synthetic records with their charIds).
// - 吟唱 (PRTS 术语释义: "停止攻击一段时间后尝试开启技能，期间被打断则中止"; "终止条件包括但不限于受到任意可导致干员无法行动的异常效果
//   （例如晕眩、冻结）影响、受到沉默/静默影响、陷入濒死状态等"; "吟唱期间不属于技能期间，吟唱开始时仅被视为触发了技能，吟唱结束后才被视为
//   技能开启"): the cast replaces the attack about to be made, then `chant_duration` s of no attack (a disarm buff; she
//   still blocks); stunned / frozen / levitated / asleep / silenced meanwhile, knocked out, or below skill_cost_min_sp at a
//   check (PRTS 备注 "吟唱期间每0.5秒检测一次，若当前技力低于最低技力需求则立即中断技能" — MANA_CHECK), it aborts: nothing is
//   spent, the skill did not open. Its end opens the skill (skillStart). A MANUAL cast is an automatic operation: it waits
//   for AUTO_OP_COOLDOWN after the battle-start deployment and after the previous cast (skills.js `opCooling`).
// - S1 才女的实力 (MANUAL; data DEFAULT): the basic strategy — about to attack an enemy of her range with ≥ skill_cost_min_sp
//   mana — opens it after a chant_duration chant; a 状态切换 skill, so once per deployment (PRTS 卫戍协议/帮助, 基础策略: a
//   toggle skill is opened once per deployment); never closed by hand. While on: ATK +atk; every attack spends sp_cost
//   mana; with no enemy to attack in her range (blocked ones included) her attack heals the most injured healable allied
//   unit of her range instead (PRTS 备注 "进行治疗时，消耗2点魔力", "对可被我方治疗的单位进行单体治疗") for ATK [ASSUMED: no source
//   gives the amount — 100 % of her ATK, the skill's ATK bonus included]; below skill_cost_min_sp the skill closes (PRTS
//   备注: it turns off by itself once the SP is under the minimum).
// - S2 召唤使魔 (AUTO; data MARCILS2, the special strategy of PRTS 卫戍协议/帮助 "首次开启技能后，若剩余魔力不少于35，则自动关闭技能
//   （即再次开启技能）"): the AUTO rule (an enemy about to be attacked, ≥ skill_cost_min_sp mana) chants chant_duration s,
//   then spends sp_cost and the familiar attacks for her: ATK +atk, every victim of an attack (the struck target and the
//   splash, "所有命中目标" [ASSUMED: the familiar keeps her 群体法术伤害]) 停顿 attack@sluggish s. Duration unlimited. The
//   strategy: while that first use runs and her mana ≥ skill_cost_min_sp, it closes the skill — which is its second
//   opening: a new chant_duration chant and sp_cost (the text's every use) [ASSUMED: the first use's familiar is off
//   meanwhile — "关闭技能"], then the upgraded familiar (PRTS 备注 "升级效果与原效果叠加"): + ASPD +attack_speed, attack range
//   +1 (parsed from the text "攻击距离+1"), the struck target 晕眩 attack@stun s. The close waits for AUTO_OP_COOLDOWN after the
//   first use opened [ASSUMED: an automatic operation; the opening counts as the last one]. The second use is never closed;
//   the uses are counted per deployment (PRTS 备注). An aborted second chant leaves the skill off: the AUTO rule opens it
//   again, as its second use.
// - S3 爆破魔法 (MANUAL; data DEFAULT): the basic strategy chants chant_duration s; the skill opens into the 追加吟唱 of
//   extra_chant_duration s (no attack), which the strategy never stops. PRTS 备注: "追加吟唱时停止技能，则触发技能效果：消耗8技力，
//   造成1次爆炸" (an interruption of it counts as that stop [ASSUMED]); after a completed 追加吟唱 "每0.45s造成一次爆炸并消耗8技力"
//   "直至剩余的技力小于最低技力需求" — explosions every `interval` s, sp_cost_extra each, at most trig_cnt [ASSUMED: its meaning],
//   then the rest under 8 goes too (the text's "完成后消耗剩余所有魔力") and the skill ends; she does not attack while they go
//   off [ASSUMED]. Leaving the field after the 追加吟唱 completed loses every mana left (PRTS 备注). Each explosion: centred on
//   the tile BLAST_AHEAD in front of her (PRTS 备注 "自身正前方2格", moved in near the map's edge: clamped into the field),
//   atk_scale × ATK arts damage to every targetable enemy, air ones too [ASSUMED], on the range x-1 around it (PRTS 备注
//   {{popup/range|x-1}}); every 高台 (a HIGH tile of the field — in this mode the '#' blocks) on that x-1 "崩开碎片" and stuns
//   the enemies on its x-4 (PRTS 备注 "受影响的高台地形及其周围8格", {{popup/range|x-4}}) for `stun` s — at every explosion,
//   air ones too [ASSUMED].

import { num, talentBb, skillRec, up, toggleBuff, statBuff } from '../shared/tier1.js';
import { AUTO_OP_COOLDOWN, COLS } from '../../../constants.js';
import { absoluteRangeKeys } from '../../../targeting.js';
import { frontOf } from '../../../dir.js';
import { effectiveProfile, acquireTargets, performAttack } from '../../../ai.js';
import { keyTiles } from '../../fxtiles.js';

const S1 = 'skchr_marcil_1';
const S2 = 'skchr_marcil_2';
const S3 = 'skchr_marcil_3';
const EPS = 1e-9;
/** T1 "攻击溅射范围扩大": PRTS 备注 "此时溅射半径扩大至1.5" (no blackboard key). */
const TALENT_SPLASH = 1.5;
/** 吟唱: PRTS 技能备注 "吟唱期间每0.5秒检测一次，若当前技力低于最低技力需求则立即中断技能". */
const MANA_CHECK = 0.5;
/** S3: the explosion's centre, PRTS 备注 "自身正前方2格". */
const BLAST_AHEAD = 2;
/** S3 explosion area (PRTS 备注 {{popup/range|x-1}}; range_table x-1). */
const X1 = Object.freeze([[2, 0], [1, -1], [1, 0], [1, 1], [0, -2], [0, -1], [0, 0], [0, 1], [0, 2], [-1, -1], [-1, 0], [-1, 1], [-2, 0]]);
/** S3 debris stun around a 高台 tile (PRTS 备注 {{popup/range|x-4}}: "受影响的高台地形及其周围8格"; range_table x-4). */
const X4 = Object.freeze([[1, -1], [1, 0], [1, 1], [0, -1], [0, 0], [0, 1], [-1, -1], [-1, 0], [-1, 1]]);
/** 【莱欧斯小队】: character_table teamId 'laios'. */
const LAIOS_PARTY = Object.freeze(new Set(['char_4141_marcil', 'char_4142_laios', 'char_4143_sensi', 'char_4144_chilc']));
const CHANT_KEY = 'marcil:chant';
const CHAIN_KEY = 'marcil:s3:chain';
const FAMILIAR_KEY = 'marcil:familiar';
const MANA_ATK_KEY = 'talent:marcil:mana';
const LAIOS_KEY = 'talent:marcil:laios';
const TAG_S3 = 'marcil:s3';

/** Mana now: the bar while she is on the field, the stored mana while she is off it. */
function manaOf(unit) {
  const sk = unit.skill;
  if (!sk || sk.noSkill) return 0;
  return unit.deployed ? sk.sp : num(unit.mem.marcilMana, sk.sp);
}

/** Write her mana (clamped to the bar) on the field: the bar and its charge (full bar = the one charge). */
function setMana(unit, v) {
  const sk = unit.skill;
  if (!sk || sk.noSkill) return;
  const cost = sk.spCost;
  const m = Math.max(0, Math.min(cost, num(v)));
  if (cost > 0 && m >= cost - EPS) { sk.charges = sk.maxCharges; sk.sp = cost; } else { sk.charges = 0; sk.sp = m; }
}

/** What stops a 吟唱 (PRTS 术语释义): 无法行动 (晕眩 / 冻结 / 浮空: canAct), 沉睡, 沉默 / 静默. */
const chantBroken = (unit) => !unit.canAct || !!unit.s.flags.sleep || !!unit.s.flags.silence;

/**
 * Her deployment count — what "每次部署" counts (S1 once, S2's uses): a 【移动】 (moveRedeploy: "不退场", the running skill
 * kept) is not a new one, unlike `deploySeq`.
 */
const depOf = (unit) => num(unit.mem.marcilDep);

/** Uses of S2 in this deployment. */
const usesOf = (unit) => (unit.mem.marcilUsesDep === depOf(unit) ? num(unit.mem.marcilUses) : 0);

/** Start a 吟唱: `{ dur, min, onDone(battle, unit), onBreak?(battle, unit) }`. */
function startChant(battle, unit, ch) {
  unit.mem.marcilChant = { ...ch, until: battle.time + Math.max(0, num(ch.dur)), nextCheck: battle.time + MANA_CHECK };
  battle.addBuff(unit, { key: CHANT_KEY, flags: { disarm: true }, tags: ['skill'] });
  battle.fx('buff', { x: unit.x, y: unit.y, id: unit.id, kind: 'chant' });
}

function stopChant(battle, unit) {
  unit.mem.marcilChant = null;
  battle.removeBuff(unit, CHANT_KEY);
}

/** The x-1 blast around the tile BLAST_AHEAD in front of her, clamped into the field: [centre row, col, tile keys]. */
function blastArea(battle, unit) {
  const [r0, c0] = frontOf(unit.tileR, unit.tileC, unit.dir, BLAST_AHEAD);
  const R = battle.rect;
  const r = Math.max(R.r0, Math.min(R.r1, r0)), c = Math.max(R.c0, Math.min(R.c1, c0));
  return [r, c, absoluteRangeKeys(X1, r, c, unit.dir, 0)];
}

/** One S3 explosion (no mana spent here). */
function explode(battle, unit, b3) {
  const [r, c, keys] = blastArea(battle, unit);
  battle.fx('explosion', { x: c, y: r, id: unit.id, tiles: keyTiles(keys), dmgType: 'arts', skill: TAG_S3 });
  const amount = unit.s.atk * num(b3.atk_scale, 1) * unit.s.atkScaleMul;
  for (const e of battle.enemiesInKeys(keys, unit, { canHitFly: true })) {
    if (e.alive) battle.dealDamage(unit, e, { amount, type: 'arts', isSkill: true, tags: ['skill', TAG_S3] });
  }
  // 高台 on the blast "崩开碎片": the enemies on its x-4 are stunned (once per explosion however many tiles break)
  const stun = num(b3.stun);
  if (!(stun > 0)) return;
  const hit = new Set();
  for (const k of keys) {
    const tr = (k / COLS) | 0, tc = k % COLS;
    if (!battle.grid.inRect(tr, tc) || battle.grid.tile(tr, tc).height !== 'HIGH') continue;
    battle.fx('rockslide', { x: tc, y: tr, id: unit.id, r: 1.5 });
    for (const e of battle.enemiesInKeys(absoluteRangeKeys(X4, tr, tc, unit.dir, 0), unit, { canHitFly: true })) hit.add(e);
  }
  for (const e of hit) if (e.alive) battle.applyStatus(e, 'stun', { duration: stun, source: unit });
}

export default {
  char_4141_marcil: (bb, chess, def) => {
    const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1);
    const r1 = skillRec(chess, S1), r2 = skillRec(chess, S2), r3 = skillRec(chess, S3);
    const b1 = r1?.bb ?? {}, b2 = r2?.bb ?? {}, b3 = r3?.bb ?? {};
    const picked = def?.skill?.id ?? chess?.skill?.skillId ?? null;
    const bbOf = (id) => (id === S1 ? b1 : id === S2 ? b2 : id === S3 ? b3 : {});
    const minOf = (id) => num(bbOf(id).skill_cost_min_sp, 1);
    /** A battle's first mana: the skill's mana_init + every talent's (可靠的同伴; SPC-Y stage 3 — the composed talents). */
    const initMana = (b) => Math.min(num(b.mana_max, 80), num(b.mana_init) + num(t0.mana_init) + num(t1.mana_init));
    const manaOn = num(t0.sp, 1);
    const s2RangeUp = Number(/攻击距离\+(\d+)/.exec(r2?.desc ?? '')?.[1] ?? 1) || 1;
    const laiosNeeded = Number(/有(\d+)名/.exec((chess?.talents ?? []).find((t) => t && t.index === 1)?.desc ?? '')?.[1] ?? 4) || 4;

    /** Spend `n` mana on the field. */
    const spend = (unit, n) => setMana(unit, manaOf(unit) - num(n));

    /** S2's familiar of use `n` (1: the first; 2: upgraded — the first's effects too). */
    const familiarMods = (n) => (n >= 2
      ? { atkPct: num(b2.atk), aspd: num(b2.attack_speed), rangeExtend: s2RangeUp }
      : { atkPct: num(b2.atk) });

    /** S3: the explosions after a completed 追加吟唱 (`interval` s apart, sp_cost_extra each; then the rest of her mana). */
    const chain = (battle, unit) => {
      const st = unit.mem.marcilS3;
      if (!st) return;
      st.phase = 'chain';
      battle.addBuff(unit, { key: CHAIN_KEY, flags: { disarm: true }, tags: ['skill'] });
      const cost = num(b3.sp_cost_extra, 8), cap = Math.max(1, Math.floor(num(b3.trig_cnt, 49)));
      const dep = depOf(unit);
      const go = () => {
        const sk = unit.skill;
        if (!up(unit) || depOf(unit) !== dep || !sk?.active || sk.id !== S3 || unit.mem.marcilS3 !== st) { st.timer?.cancel(); return; }
        if (manaOf(unit) + EPS >= cost && st.n < cap) {
          explode(battle, unit, b3);
          spend(unit, cost);
          st.n++;
        }
        if (manaOf(unit) + EPS < cost || st.n >= cap) {
          st.timer?.cancel();
          setMana(unit, 0);   // "完成后消耗剩余所有魔力"
          sk.end('done');
        }
      };
      go();
      if (unit.mem.marcilS3 === st && st.phase === 'chain') st.timer = battle.every(Math.max(0.05, num(b3.interval, 0.45)), go, { owner: unit });
    };

    /** The cast of the picked skill (its 吟唱 first); true when it began. */
    const cast = (battle, unit) => {
      const sk = unit.skill;
      const id = sk.id;
      if (id === S1) {
        sk.opReadyAt = battle.time + AUTO_OP_COOLDOWN;
        startChant(battle, unit, { dur: num(b1.chant_duration), min: minOf(S1), onDone: (b, u) => {
          if (manaOf(u) + EPS < minOf(S1) || !u.skill.activate('DEFAULT', { free: true })) return;
          u.mem.marcilS1Dep = depOf(u);
        } });
        return true;
      }
      if (id === S2) {
        startChant(battle, unit, { dur: num(b2.chant_duration), min: minOf(S2), onDone: (b, u) => {
          const k = u.skill;
          if (k.active || manaOf(u) + EPS < num(b2.sp_cost, minOf(S2))) return;
          const n = usesOf(u) + 1;
          spend(u, num(b2.sp_cost, minOf(S2)));
          u.mem.marcilUses = n;
          u.mem.marcilUsesDep = depOf(u);
          if (!k.activate(n >= 2 ? 'MARCILS2' : 'DEFAULT', { free: true })) return;
          // the strategy's close is an automatic operation: none within AUTO_OP_COOLDOWN of this opening [ASSUMED]
          k.opReadyAt = Math.max(k.opReadyAt, b.time + AUTO_OP_COOLDOWN);
        } });
        return true;
      }
      if (id === S3) {
        sk.opReadyAt = battle.time + AUTO_OP_COOLDOWN;
        startChant(battle, unit, { dur: num(b3.chant_duration), min: minOf(S3), onDone: (b, u) => {
          if (manaOf(u) + EPS < minOf(S3)) return;
          u.skill.activate('DEFAULT', { free: true });
        } });
        return true;
      }
      return false;
    };

    /** The data's rule for the picked skill, minus the moment (about to attack an enemy): may it be cast now? */
    const castable = (battle, unit) => {
      const sk = unit.skill;
      if (!sk || sk.noSkill || sk.active || unit.mem.marcilChant || !up(unit) || chantBroken(unit)) return false;
      if (sk.manual && sk.opCooling) return false;
      if (sk.id === S1 && unit.mem.marcilS1Dep === depOf(unit)) return false;   // 状态切换: once per deployment
      if (sk.id === S2 && usesOf(unit) >= 2) return false;
      return manaOf(unit) + EPS >= minOf(sk.id);
    };

    return {
      skills: {
        // S1 才女的实力: a toggle opened after its chant (the casts above); her attacks spend mana, heal with no enemy
        [S1]: {
          kind: 'toggle', trigger: 'NEVER', initSp: initMana(b1),
          mods: { atkPct: num(b1.atk) },
          onAttack({ unit, skill }) {
            spend(unit, num(b1.sp_cost, 2));
            if (manaOf(unit) + EPS < minOf(S1)) skill.end('mana');
          },
          // no enemy to attack: her attack heals the most injured healable allied unit of her range (an attack in every
          // respect: the hooks, the mana it spends)
          onTick({ battle, unit }) {
            if (unit.atkCd > 0 || !unit.canAct || unit.s.flags.disarm || !unit.profile) return;
            const prof = effectiveProfile(unit);
            if (prof.noAttack || acquireTargets(battle, unit, prof).length) return;
            const ally = battle.injuredAlliesInKeys(unit.rangeKeys, unit)[0];
            if (!ally) return;
            performAttack(battle, unit, { ...prof, dmgType: 'heal', heal: { mode: 'single' }, atkScale: 1, healScale: 1,
              projectile: 'orb', splashRadius: 0, chain: null, hits: 1, hitsFn: null, onEachHit: null, skillOnEachHit: null, skillOnHit: null }, [ally]);
            unit.atkCd = Math.max(unit.atkCd, unit.s.interval);
          },
        },
        // S2 召唤使魔: the familiar of this opening (use 1, or the upgraded use 2)
        [S2]: {
          kind: 'toggle', trigger: 'NEVER', initSp: initMana(b2),
          attack: {
            onEachHit({ battle, unit, target, kind }) {
              if (!target || !target.alive || target.side !== 'enemy') return;
              const slug = num(b2['attack@sluggish']);
              if (slug > 0) battle.applyStatus(target, 'sluggish', { duration: slug, source: unit });
              const stun = num(b2['attack@stun']);
              if (kind === 'main' && stun > 0 && usesOf(unit) >= 2 && target.alive) battle.applyStatus(target, 'stun', { duration: stun, source: unit });
            },
          },
          onStart({ battle, unit }) {
            battle.addBuff(unit, { key: FAMILIAR_KEY, mods: familiarMods(usesOf(unit)), tags: ['skill'] });
            battle.refreshRange(unit);
            battle.fx('summon', { x: unit.x, y: unit.y, id: unit.id, token: FAMILIAR_KEY });
          },
          onEnd({ battle, unit }) {
            battle.removeBuff(unit, FAMILIAR_KEY);
            battle.refreshRange(unit);
          },
        },
        // S3 爆破魔法: opens into the 追加吟唱, then the explosions
        [S3]: {
          kind: 'toggle', trigger: 'NEVER', initSp: initMana(b3),
          onStart({ battle, unit }) {
            const st = { phase: 'extra', n: 0, timer: null };
            unit.mem.marcilS3 = st;
            startChant(battle, unit, { dur: num(b3.extra_chant_duration), min: minOf(S3),
              onDone: (b, u) => { if (u.mem.marcilS3 === st) chain(b, u); },
              // a stopped (interrupted) 追加吟唱: one explosion for sp_cost_extra
              onBreak: (b, u) => {
                if (u.mem.marcilS3 !== st || !u.skill?.active) return;
                const cost = num(b3.sp_cost_extra, 8);
                if (manaOf(u) + EPS >= cost) { explode(b, u, b3); spend(u, cost); st.n++; }
                u.skill.end('stopped');
              } });
          },
          onEnd({ battle, unit, reason }) {
            const st = unit.mem.marcilS3;
            if (st) {
              st.timer?.cancel();
              if (reason === 'death' && st.phase === 'chain') unit.mem.marcilLost = true;   // 追加吟唱完成后退场: every mana lost
            }
            unit.mem.marcilS3 = null;
            if (unit.mem.marcilChant) stopChant(battle, unit);
            battle.removeBuff(unit, CHAIN_KEY);
          },
        },
      },
      talents: [
        { install(battle, unit) { // 建校以来第一才女: the 魔力
          const iv = Math.max(0.05, num(t0.interval, 1)), add = num(t0.mana_add, 1);
          const base0 = unit.profile ? num(unit.profile.splashRadius, 0) : 0;
          // "魔力不自然回复": the time SP gain loses the unit's base recovery (a bonus above it still counts)
          battle.on('spGain', (ctx) => {
            if (ctx.unit !== unit || ctx.reason !== 'time') return;
            ctx.amount = Math.max(0, ctx.amount - num(unit.base.spRecovery, 1) * battle.dt);
          }, { owner: unit, priority: 100 });
          // the cap is the carried skill's: no SP-cost modifier changes it (PRTS 备注 "其不受技力需求变化的影响") — her skill
          // ignores every write of spCostMul (绝技's ×0.7 is written before the battle-start deployment fills her bar: undoing
          // it afterwards would leave the bar clipped to the scaled cost) and every spCostFlat of her buffs
          const sk0 = unit.skill;
          if (sk0 && !sk0.noSkill) {
            Object.defineProperty(sk0, 'spCostMul', { configurable: true, get: () => 1, set: () => {} });
            Object.defineProperty(sk0, 'spCost', { configurable: true, get: () => sk0.baseSpCost });
          }
          // leaving converts the bar back into mana (all lost after S3's 追加吟唱); off the field +mana_add per interval
          battle.on('death', (ctx) => {
            if (ctx.unit !== unit) return;
            unit.mem.marcilChant = null;
            unit.mem.marcilMana = unit.mem.marcilLost ? 0 : num(unit.skill?.sp);
            unit.mem.marcilLost = false;
            unit.mem.marcilLeftAt = battle.time;
            unit.mem.marcilLeft = true;
          }, { owner: unit, priority: 50 });
          battle.on('deploy', (ctx) => {
            if (ctx.unit !== unit) return;
            if (ctx.move) return;   // a 【移动】 keeps the deployment's state (a running 吟唱 too)
            unit.mem.marcilDep = depOf(unit) + 1;
            unit.mem.marcilChant = null;
            if (!unit.mem.marcilLeft) return;
            unit.mem.marcilLeft = false;
            const away = Math.max(0, battle.time - num(unit.mem.marcilLeftAt, battle.time));
            setMana(unit, num(unit.mem.marcilMana) + Math.floor(away / iv + EPS) * add);
            unit.mem.marcilMana = null;
          }, { owner: unit, priority: 50 });
          // "有魔力时，攻击力+25%，攻击溅射范围扩大"
          toggleBuff(battle, unit, MANA_ATK_KEY, () => manaOf(unit) + EPS >= manaOn, { atkPct: num(t0.atk) });
          battle.on('beforeAttack', (ctx) => {
            if (ctx.attacker !== unit || !ctx.profile || ctx.profile.dmgType === 'heal') return;
            ctx.profile.splashRadius = manaOf(unit) + EPS >= manaOn ? TALENT_SPLASH : base0;
          }, { owner: unit, priority: 90 });
        } },
        { install(battle, unit) { // 可靠的同伴: four 【莱欧斯小队】 operators of her squad
          battle.on('battleStart', () => {
            const party = battle.allyUnits.filter((a) => a.kind === 'op' && a.ownerId === unit.ownerId && LAIOS_PARTY.has(a.def?.charId));
            if (new Set(party.map((a) => a.def.charId)).size < laiosNeeded) return;
            for (const a of party) statBuff(battle, a, LAIOS_KEY, { aspd: num(t1.attack_speed), defPct: num(t1.def) });
          }, { owner: unit });
        } },
      ],
      install(battle, unit) {
        if (![S1, S2, S3].includes(picked)) return;
        // the casts: the basic strategy (S1 / S3) and the AUTO rule (S2) — about to attack an enemy; the cast replaces it
        battle.on('beforeAttack', (ctx) => {
          if (ctx.attacker !== unit || !ctx.targets?.some((t) => t && t.side === 'enemy')) return;
          if (!castable(battle, unit) || !cast(battle, unit)) return;
          ctx.targets = [];
        }, { owner: unit, priority: 100 });
        // the 吟唱 in progress
        battle.on('tick', () => {
          const ch = unit.mem.marcilChant;
          if (!ch) return;
          if (!up(unit)) { stopChant(battle, unit); return; }
          let broken = chantBroken(unit);
          if (!broken && battle.time + EPS >= ch.nextCheck) {
            ch.nextCheck += MANA_CHECK;
            broken = manaOf(unit) + EPS < ch.min;
          }
          if (broken) { stopChant(battle, unit); if (ch.onBreak) ch.onBreak(battle, unit); return; }
          if (battle.time + EPS >= ch.until) { stopChant(battle, unit); ch.onDone(battle, unit); }
        }, { owner: unit });
        // S2's special strategy: its first use running and ≥ skill_cost_min_sp mana ⇒ close it, which opens it again
        if (picked === S2) {
          battle.on('tick', () => {
            const sk = unit.skill;
            if (!sk?.active || sk.id !== S2 || usesOf(unit) !== 1 || unit.mem.marcilChant || !up(unit) || chantBroken(unit)) return;
            if (battle.time + EPS < sk.opReadyAt || manaOf(unit) + EPS < minOf(S2)) return;
            sk.opReadyAt = battle.time + AUTO_OP_COOLDOWN;
            sk.end('recast');
            cast(battle, unit);
          }, { owner: unit });
        }
      },
    };
  },
};
