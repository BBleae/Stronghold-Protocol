// server/sim/content/kits/ops/op-makoto.js — 结城理 (char_4217_makoto) 自选 operator kit: 6★ 傀儡师 (特种), a collab pick
// of this fork's tier-5 and tier-6 自选 slots (tools/build-data.mjs FORK_INCLUDE_COLLAB_PICKS, the fork owner's decision
// of 2026-10-08); every skill, both talents, the trait and the module at every form.
// Kit contract and the 自选 rules: ../README.md ("How to add an operator (自选)").
//
// Forms (data/backups.json units.char_4217_makoto, the DIY slot statuses): normal = E2 Lv1, skills at rank 4, no module;
// elite = E2 Lv60, rank 7, PUM-Y “彼此的声音” at stage 1 (tier 5) or 3 (tier 6). Full potential (the owner's decision of
// 2026-10-07): T1 ATK +85 % (+5 %), T2 450 % (+20 %).
// Sources: character_table / skill_table / battle_equip_table (zh_CN, as built into backups.json); PRTS 结城理 (特性备注,
// the talent and skill 备注, the 修正 of S1 / S2 "低于" → "不高于"), PRTS 分支特性信息 傀儡师, PRTS 术语释义 (弱点伤害, 停顿,
// 恐惧), PRTS 卫戍协议/帮助 (基础策略); his skeleton's clips (data/assets.json chars.char_4217_makoto.spine) for two timings.
// - Trait (傀儡师) "受到致命伤时不撤退，切换成<替身>作战（替身阻挡数为0），持续20秒后自身再次替换<替身>": the engine's dollkeeper
//   branch (professions.js installDollkeeper: the switch animations, 不死 / 无敌 while switching, 阻回, block 0, the
//   `dollSwitch` / `dollSwap` hooks). His <替身> is a persona that depends on the picked skill (below) and attacks from the
//   <替身>'s own range x-1 (PRTS "<替身>的攻击范围 x-1"; the record's trait grid): the kit turns the unit's profile and range
//   into the persona's on the switch to the <替身>, and back on the switch back or a knock-out; a persona's hit lands at
//   once (no projectile [ASSUMED]: PRTS names none). PRTS 特性备注 "切换期间额外持有静默": a silence for each switch
//   animation (the engine's switch window carries none). PUM-Y overrides the trait with
//   "替身…生命值提升" (trait bb max_hp +20 %): the <替身>'s max HP, added to T1's (both 直接乘算 [ASSUMED: summed]).
// - T1 不羁之力 (bb atk / base_attack_time / sluggish / max_hp_t1; PUM-Y stage 3 → +100 % / 10 s / +40 %): as the <替身>,
//   ATK +atk, max HP +max_hp_t1, attack interval +base_attack_time s (a flat change: batMod); on the switch from the <本体>
//   to a <替身> (never between two <替身> forms — PRTS 备注), every enemy of the <替身>'s range x-1 (PRTS 备注 "停顿效果范围与
//   <替身>的攻击范围相同"; flyers too) takes 停顿 for `sluggish` s — at the start of the switch [ASSUMED].
// - T2 S.E.E.S.队长 (bb atk_scale): when the <替身>'s time is up (not when it is knocked out: PRTS "<替身>持续时间结束后"), the
//   <总攻击>: every enemy within x-1 of a S.E.E.S. member (PRTS 备注 "伤害范围 x-1", "均可对空") takes atk_scale × 结城理's ATK
//   true damage — his ATK without the <替身>'s bonuses (PRTS "不享受<替身>形态的天赋/技能加成"). The only member this mode can
//   field is 结城理 himself (埃癸斯 / 岳羽由加莉 / 虎狼丸 are in no pool) and he answers no other 结城理's command (PRTS 备注),
//   so it strikes around him once. It lands ALL_OUT_HIT s into the switch back (his clips) [ASSUMED]. PRTS "先切换为<总攻击>
//   形态…随后再切换回<本体>形态" and "<总攻击>期间…无敌、静默": that switch back is the <总攻击> form — his
//   Skill_AllOutAttack_Loop + Skill_AllOutAttack_End, ALL_OUT_TIME (1.6 s) —, so the engine's switch window (无敌, 不死,
//   阻回 …) and the kit's 静默 last that long there instead of the engine's DOLL_SWITCH (1 s, the other 傀儡师' Start_B /
//   Start_2 clips) [ASSUMED: the form lasts its clips; PRTS's 1.6 s for the other members' repeated commands agrees].
// - S1 / S2 / S3 (MANUAL, time SP, the data's SKILL_RANGE on the 技能范围 x-1) "主动：立即切换为<替身>状态作战": an instant
//   cast that ends in the frame it starts (PRTS 备注 "技能开启后会立刻在同一帧内结束") and switches him to the <替身> at once
//   (`dollSwitch`, as 归溟幽灵鲨 S2's end: no lethal HP loss). As the <替身> his skill does not charge (阻回); the personas of
//   S1 / S2 and <俄耳甫斯·改> also hold 静默 (PRTS 备注).
// - S1 俄耳甫斯的竖琴 — <俄耳甫斯>: normal attacks of attack@atk_scale × ATK arts on one ground enemy (PRTS 备注 "法术普通伤害，
//   不可对空"); while an ally of its range (any healable unit — PRTS 备注 "不止干员" —, himself included) has at most HEAL_AT
//   of its HP (the text's 50 %, PRTS 修正 "不高于"), the attack heals the lowest-ratio one for attack@heal_scale × ATK instead.
// - S2 塔纳托斯的囚锁 — <塔纳托斯>: normal attacks on up to attack@max_target ground enemies, attack@atk_scale × ATK arts each,
//   each hit rolling attack@prob for 恐惧 attack@fear s; its 恐惧斩杀 aura (PRTS 备注: checked every KILL_IV s, flyers too)
//   deals attack@kill_damage 无来源 true damage (no dodge) to a feared enemy of its range whose HP is at most
//   attack@kill_atk_scale × ATK; an enemy that survives it (限伤 on a leader, a barrier) is never tried again (PRTS 备注) —
//   which also keeps it to one try per entry into the range.
// - S3 开辟明日的剑刃 — <塔纳托斯·改> first: ASPD +talent@attack_speed, normal attacks on up to attack@max_target enemies,
//   flyers too (PRTS 备注 "普通攻击可对空"), attack@atk_scale × ATK 弱点伤害 (default arts; PRTS 术语释义: the type of the
//   higher theoretical damage from ATK × scale, the penetrations and the target's DEF / RES — items/battle.js
//   weaknessRetype). A lethal hit on it, or a cast of the skill while it is out, calls <俄耳甫斯·改> (PRTS 备注 "此形态下依旧
//   可以触发特性"): a switch animation of CHANGE_TIME s with the branch's rules (statuses cleared, HP reset to the max at its
//   start and end, 不死 / 无敌 / 阻回 / 禁疗 / 孤立 / 缴械 / 静默, no 晕眩 / 冻结 / 睡眠 — PRTS 分支特性信息 傀儡师), no 停顿
//   (PRTS 备注), then <俄耳甫斯·改> until the <替身>'s time is up: no normal attack, 静默, blocks attack@block_cnt (PRTS 备注
//   "阻挡不再归零（即恢复正常的2阻挡数）": the <替身>'s ×0 lifted), every operator of its range (the text's 友方干员; himself
//   included [ASSUMED]: his tile is in it) holds attack@prob physical and arts dodge, and when the switch ends and every
//   attack@interval s after, up to attack@max_target_heal injured allies of its range (the lowest ratio first; any healable
//   unit — PRTS "若干友方单位") get a delayed heal of attack@heal_scale × his ATK at that moment, HEAL_DELAY s later (PRTS
//   备注; a 治疗: 禁疗 stops it) — none once he is off the field meanwhile [ASSUMED]. A lethal hit on <俄耳甫斯·改> knocks
//   him out.
//   [ASSUMED]: the <替身>'s time runs on through the change (the text's "直到<替身>状态结束"; no source restarts the 20 s);
//   the automation presses the skill in <塔纳托斯·改> only when the skill is charged (阻回 keeps it from charging as the
//   <替身>, so only a lethal hit taken with a full skill brings that about) — the official automation casts charged manual
//   skills (PRTS 卫戍协议/帮助 基础策略) and turns a 状态切换 skill on only once per deployment; the free blue-icon press
//   (PRTS 备注 "可再次点按开启技能键") is not automated; such a cast spends its charge like any other.
// - Model: the engine puts every <替身> in the model form 'doll'; his skeleton draws each persona on its own clips, so the kit
//   sets the unit's form to the persona's (MODEL: public/js/render/units.js FORMS char_4217_makoto) with an fx 'persona'
//   { form, dur } — `dur` the time left to the switch back (the persona's SwitchOut plays over its last second), or the
//   change window (ChangeBegin → ChangeEnd, landing in <俄耳甫斯·改>). The switch back and a knock-out reset it as for any
//   <替身> (professions.js: fx 'swap' / 'dollEnd' { form: null }).

import { num, talentBb, traitBb, skillRec, batMod, up, alliesInGridOf } from '../shared/tier1.js';
import { absoluteRangeKeys, canTargetEnemy } from '../../../targeting.js';
import { bodyInKeys } from '../../../body.js';
import { DOLL_SWITCH } from '../../../professions.js';
import { weaknessRetype, PRIO_UNDYING_HELD } from '../../items/battle.js';

const S1 = 'skchr_makoto_1';
const S2 = 'skchr_makoto_2';
const S3 = 'skchr_makoto_3';
/** x-1 (range_table): the <替身>'s range, T1's 停顿 and T2's 总攻击 area, when the record carries no grid. */
const X1 = Object.freeze([[2, 0], [1, -1], [1, 0], [1, 1], [0, -2], [0, -1], [0, 0], [0, 1], [0, 2], [-1, -1], [-1, 0], [-1, 1], [-2, 0]]);
/** S1's heal threshold when the text gives none ("生命值低于50%", PRTS 修正 "不高于"; no blackboard key). */
const HEAL_AT = 0.5;
/** S2 恐惧斩杀: "每0.1秒检测一次" (PRTS 备注). */
const KILL_IV = 0.1;
/** S3 <俄耳甫斯·改>: "0.5秒后对其治疗" (PRTS 备注). */
const HEAL_DELAY = 0.5;
/** S3 <塔纳托斯·改> → <俄耳甫斯·改>: Doll_Skill_3_P1toP2_ChangeBegin 0.5 s + ChangeEnd 1 s (his skeleton) [ASSUMED]. */
const CHANGE_TIME = 0.5 + 1;
/** T2 <总攻击>: Skill_AllOutAttack_Loop 0.167 s, then Skill_AllOutAttack_End's hit at 0.133 s (his skeleton) [ASSUMED]. */
const ALL_OUT_HIT = 0.167 + 0.133;
/** T2 <总攻击> form: Skill_AllOutAttack_Loop 5 frames + Skill_AllOutAttack_End 43 frames (his skeleton) — the switch back. */
export const ALL_OUT_TIME = (5 + 43) / 30;
/** S3 <俄耳甫斯·改>'s dodge aura: refreshed every AURA_IV s, held AURA_HOLD s. */
const AURA_IV = 0.2;
const AURA_HOLD = AURA_IV + 0.1;
/** A lethal hit on <塔纳托斯·改>: after a running 不死 window (items/battle.js −99), before the <替身> knock-out (−100). */
const PRIO_CHANGE = PRIO_UNDYING_HELD - 0.5;
/** 弱点伤害 decided after the default-priority hit modifiers (as the 特质 _chaos, garrisons/battle.js WEAKNESS_PRIORITY). */
const WEAKNESS_PRIORITY = -10;

/** The client's model form of each persona (the kit's st.form → public/js/render/units.js FORMS char_4217_makoto). */
export const MODEL = Object.freeze({ orpheus: 'orpheus', thanatos: 'thanatos', thanatosR: 'thanatosR', change: 'orpheusRChange', orpheusR: 'orpheusR' });

const PERSONA = 'talent:makoto:persona';     // T1 (+ PUM-Y's 替身 HP): the <替身>'s stats
const FORM = 'makoto:form';                  // the persona of the picked skill: ASPD, block, 静默
const SWITCHING = 'makoto:switching';        // 特性备注 "切换期间额外持有静默"
const DODGE = 'makoto:orpheusDodge';         // <俄耳甫斯·改>'s dodge (one per target whoever gives it)
/** The profile fields a persona sets (the <本体>'s come back on the switch back). */
const FIELDS = Object.freeze(['dmgType', 'projectile', 'canHitFly', 'groundOnly', 'maxTargets', 'heal', 'atkScale', 'healScale', 'noAttack', 'onEachHit']);
/** Area effects and the 恐惧斩杀 aura reach flyers. */
const FLY = Object.freeze({ canHitFly: true });

const bbOf = (chess, id) => skillRec(chess, id)?.bb ?? {};
/** The kit's per-unit state (unit.mem survives a knock-out and a redeploy). */
const stateOf = (unit) => (unit.mem.makoto ??= { form: null, base: null, healMode: false, pulseAt: null, spared: new Set() });
/** S1's threshold from its text ("生命值低于N%"), else HEAL_AT. */
function healThreshold(rec) {
  const m = /生命值(?:低于|不高于)(\d+(?:\.\d+)?)%/.exec(String(rec?.desc ?? rec?.description ?? ''));
  return m ? +m[1] / 100 : HEAL_AT;
}

export default {
  char_4217_makoto: (bb, chess, def) => {
    const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1), tb = traitBb(chess);
    const b1 = bbOf(chess, S1), b2 = bbOf(chess, S2), b3 = bbOf(chess, S3);
    const grid = Array.isArray(chess?.trait?.rangeGrid) && chess.trait.rangeGrid.length ? chess.trait.rangeGrid : X1;
    const healAt = healThreshold(skillRec(chess, S1));
    const keysAround = (unit) => absoluteRangeKeys(grid, unit.tileR, unit.tileC, unit.dir, 0);

    // ---- the personas ------------------------------------------------------------------------------------------------
    /** S2: each hit rolls 恐惧. */
    const fearOnHit = (battle, unit, victim) => {
      const p = num(b2['attack@prob']);
      if (!victim || !victim.alive || victim.side !== 'enemy' || !(p > 0)) return;
      if (battle.rng.chance(p)) battle.applyStatus(victim, 'fear', { duration: num(b2['attack@fear']), source: unit });
    };
    const ARTS = { dmgType: 'arts', projectile: 'none', groundOnly: false, heal: null, healScale: 1, noAttack: false, onEachHit: null };
    const profileOf = (form) => {
      if (form === 'orpheus') return { ...ARTS, canHitFly: false, maxTargets: 1, atkScale: num(b1['attack@atk_scale'], 1) };
      if (form === 'thanatos') {
        return { ...ARTS, canHitFly: false, maxTargets: Math.max(1, Math.floor(num(b2['attack@max_target'], 1))), atkScale: num(b2['attack@atk_scale'], 1), onEachHit: fearOnHit };
      }
      if (form === 'thanatosR') return { ...ARTS, canHitFly: true, maxTargets: Math.max(1, Math.floor(num(b3['attack@max_target'], 1))), atkScale: num(b3['attack@atk_scale'], 1) };
      return { ...ARTS, canHitFly: false, maxTargets: 1, atkScale: 1, noAttack: true };   // 'change', 'orpheusR'
    };
    const formBuff = (form, unit) => {
      const mods = {};
      if (form === 'thanatosR' || form === 'change' || form === 'orpheusR') {
        const a = num(b3['talent@attack_speed']);
        if (a) mods.aspd = a;
      }
      if (form === 'orpheusR') {
        // "阻挡不再归零": lift the <替身>'s block cut (professions.js 'trait:substitute') and block attack@block_cnt
        const cut = num(unit.findBuff('trait:substitute')?.mods?.blockCnt);
        const want = num(b3['attack@block_cnt']);
        if (want > 0) mods.blockCnt = -cut + want - num(unit.base.blockCnt);
      }
      return { key: FORM, mods, flags: form === 'thanatosR' ? null : { silence: true }, tags: ['skill'] };
    };
    const setForm = (battle, unit, form) => {
      const st = stateOf(unit);
      if (!st.base) {
        const p = unit.profile;
        st.base = { grid: unit.rangeGrid, prof: FIELDS.map((k) => [k, Object.prototype.hasOwnProperty.call(p, k), p[k]]) };
      }
      st.form = form;
      st.healMode = false;
      st.pulseAt = null;
      Object.assign(unit.profile, profileOf(form));
      if (unit.rangeGrid !== grid) { unit.rangeGrid = grid; battle.refreshRange(unit); }
      battle.addBuff(unit, formBuff(form, unit));
      // the persona's model (header "Model"): until the switch back, or through the change window
      const model = MODEL[form] ?? null;
      if (model && unit.form !== model) {
        unit.form = model;
        unit.markDirty();
        const left = form === 'change' ? CHANGE_TIME : unit.findBuff('trait:substitute')?.timeLeft;
        battle.fx('persona', { x: unit.x, y: unit.y, id: unit.id, form: model, ...(left > 0 && Number.isFinite(left) ? { dur: left } : null) });
      }
    };
    const clearForm = (battle, unit) => {
      const st = stateOf(unit);
      st.form = null;
      st.healMode = false;
      st.pulseAt = null;
      battle.removeBuff(unit, FORM);
      if (!st.base) return;
      for (const [k, has, v] of st.base.prof) { if (has) unit.profile[k] = v; else delete unit.profile[k]; }
      if (unit.rangeGrid !== st.base.grid) { unit.rangeGrid = st.base.grid; battle.refreshRange(unit); }
    };

    // ---- S3: <塔纳托斯·改> → <俄耳甫斯·改> (a switch animation with the branch's rules — see the header) -----------------
    const change = (battle, unit) => {
      const st = stateOf(unit);
      const seq = unit.deploySeq;
      for (const b of unit.buffs.slice()) if (b.status) battle.removeBuff(unit, b);
      unit.trait.dollSwitching = true;
      const done = () => { unit.trait.dollSwitching = false; };
      setForm(battle, unit, 'change');
      // (the engine's own key: its fatal / beforeStatus rules read unit.trait.dollSwitching; a switch back that starts
      // meanwhile replaces this window with its own)
      battle.addBuff(unit, {
        key: 'trait:dollSwitching', duration: CHANGE_TIME, onRemove: done,
        flags: { invulnerable: true, noSp: true, noHeal: true, healFree: true, isolated: true, disarm: true, silence: true },
        onExpire: () => {
          done();
          if (!up(unit) || unit.deploySeq !== seq || !unit.trait.doll || st.form !== 'change') return;
          setForm(battle, unit, 'orpheusR');
          unit.markDirty();
          unit.hp = unit.s.maxHp;
          st.pulseAt = battle.time;   // "切换完毕的瞬间及后续每隔1秒"
        },
      });
      unit.markDirty();
      unit.hp = unit.s.maxHp;
      battle.fx('buff', { x: unit.x, y: unit.y, id: unit.id, kind: 'makoto:orpheus' });
    };
    /** The skill's cast: the <替身> now — or, from <塔纳托斯·改>, <俄耳甫斯·改>. */
    const press = (battle, unit) => {
      if (!up(unit)) return;
      if (unit.trait.doll) {
        if (stateOf(unit).form === 'thanatosR' && !unit.trait.dollSwitching) change(battle, unit);
        return;
      }
      battle.emit('dollSwitch', { unit, reason: 'skill', done: false });
    };
    const cast = { kind: 'instant', onEnd({ battle, unit, reason }) { if (reason === 'instant') press(battle, unit); } };

    return {
      skills: { [S1]: cast, [S2]: cast, [S3]: cast },
      talents: [
        { install(battle, unit) { // 不羁之力: the <替身>'s stats; 停顿 on the switch from the <本体>
          const mods = {};
          const atk = num(t0.atk), hp = num(t0.max_hp_t1) + num(tb.max_hp), bat = batMod(t0.base_attack_time, chess);
          if (atk) mods.atkPct = atk;
          if (hp) mods.hpPct = hp;
          if (bat) mods.batPct = bat;
          battle.on('dollSwap', ({ unit: u, form }) => {
            if (u !== unit) return;
            if (form !== 'doll') { battle.removeBuff(unit, PERSONA); return; }
            battle.addBuff(unit, { key: PERSONA, mods, tags: ['talent'] });
            const dur = num(t0.sluggish);
            if (!(dur > 0)) return;
            battle.fx('aoe', { x: unit.x, y: unit.y, radius: 2, id: unit.id, skill: 'makoto:pause' });
            for (const e of battle.enemiesInKeys(keysAround(unit), unit, FLY)) battle.applyStatus(e, 'sluggish', { duration: dur, source: unit });
          }, { owner: unit });
        } },
        { install(battle, unit) { // S.E.E.S.队长: the <总攻击> when the <替身>'s time is up
          const scale = num(t1.atk_scale);
          if (!(scale > 0)) return;
          battle.on('dollSwap', ({ unit: u, form }) => {
            if (u !== unit || form !== null) return;
            const seq = unit.deploySeq;
            battle.after(ALL_OUT_HIT, () => {
              if (!up(unit) || unit.deploySeq !== seq) return;
              const amount = unit.s.atk * scale;
              battle.fx('aoe', { x: unit.x, y: unit.y, radius: 2, id: unit.id, skill: 'makoto:allOut' });
              for (const e of battle.enemiesInKeys(keysAround(unit), unit, FLY)) {
                if (e.alive) battle.dealDamage(unit, e, { amount, type: 'true', canDodge: false, tags: ['talent', 'makoto:allOut'] });
              }
            }, { owner: unit });
          }, { owner: unit });
        } },
      ],
      install(battle, unit) {
        const sid = unit.skill?.id ?? def?.skill?.id ?? null;
        const first = sid === S1 ? 'orpheus' : sid === S2 ? 'thanatos' : sid === S3 ? 'thanatosR' : null;
        if (!first) return;
        const st = stateOf(unit);
        const allOut = num(t1.atk_scale) > 0;
        battle.on('dollSwap', ({ unit: u, form }) => {
          if (u !== unit) return;
          // the switch back is the <总攻击> form (T2): the engine's switch window (无敌 …) and the 静默 last ALL_OUT_TIME
          const w = form === null && allOut ? ALL_OUT_TIME : DOLL_SWITCH;
          const sw = w > DOLL_SWITCH ? unit.findBuff('trait:dollSwitching') : null;
          if (sw && sw.timeLeft < w) sw.timeLeft = w;
          battle.addBuff(unit, { key: SWITCHING, duration: w, flags: { silence: true } });
          if (form === 'doll') setForm(battle, unit, first);
          else clearForm(battle, unit);
        }, { owner: unit });
        // knocked out (as the <替身> too) or withdrawn: the <本体>'s profile and range for the next deployment (the
        // buffs went with the knock-out)
        battle.on('death', ({ unit: u }) => { if (u === unit && st.form) clearForm(battle, unit); }, { owner: unit });

        if (first === 'orpheus') {
          // S1: the attack heals instead while an ally of the range is at or below healAt
          const scale = num(b1['attack@atk_scale'], 1), heal = num(b1['attack@heal_scale']);
          battle.on('tick', () => {
            if (st.form !== 'orpheus' || !up(unit)) return;
            const low = battle.injuredAlliesInKeys(unit.rangeKeys, unit)[0];
            const want = !!low && low.hpRatio <= healAt + 1e-9 && heal > 0;
            if (want === st.healMode) return;
            st.healMode = want;
            Object.assign(unit.profile, want
              ? { dmgType: 'heal', heal: { mode: 'single', hpAtMost: healAt }, atkScale: heal }
              : { dmgType: 'arts', heal: null, atkScale: scale });
          }, { owner: unit });
        }

        if (first === 'thanatos') {
          // S2: the 恐惧斩杀 aura over its range
          const lim = num(b2['attack@kill_atk_scale']), dmg = num(b2['attack@kill_damage']);
          if (lim > 0 && dmg > 0) {
            battle.every(KILL_IV, () => {
              if (st.form !== 'thanatos' || unit.trait.dollSwitching || !up(unit) || !unit.rangeKeySet) return;
              const cap = lim * unit.s.atk + 1e-9;
              for (const e of battle.enemies) {
                if (!e.alive || !e.s.flags.fear || st.spared.has(e.id) || !((e.bossPool ? e.bossPool.hp : e.hp) <= cap)) continue;
                if (!bodyInKeys(e, unit.rangeKeySet) || !canTargetEnemy(unit, e, FLY)) continue;
                battle.dealDamage(unit, e, { amount: dmg, type: 'true', canDodge: false, sourceless: true, ignoreSelect: true, tags: ['makoto:execute'] });
                if (e.alive) st.spared.add(e.id);
              }
            }, { owner: unit });
          }
        }

        if (first === 'thanatosR') {
          // <塔纳托斯·改>'s 弱点伤害
          battle.on('hit', ({ source, target, dmg }) => {
            if (source !== unit || st.form !== 'thanatosR' || !dmg || !dmg.isAttack || !target || target.side !== 'enemy') return;
            weaknessRetype(dmg, unit, target);
          }, { owner: unit, priority: WEAKNESS_PRIORITY });
          // a lethal hit on <塔纳托斯·改> calls <俄耳甫斯·改>
          battle.on('fatal', (ctx) => {
            if (ctx.unit !== unit || ctx.prevented || st.form !== 'thanatosR' || !unit.trait.doll || unit.trait.dollSwitching) return;
            ctx.prevented = true;
            change(battle, unit);
          }, { owner: unit, priority: PRIO_CHANGE });
          // <俄耳甫斯·改>: the dodge of the operators of its range
          const prob = num(b3['attack@prob']);
          if (prob > 0) {
            const dodge = (v) => ({ dodgePhys: v, dodgeArts: v });
            battle.every(AURA_IV, () => {
              if (st.form !== 'orpheusR' || unit.trait.dollSwitching || !up(unit)) return;
              for (const a of alliesInGridOf(battle, unit, null)) {
                if (a.kind === 'op') battle.applyStrongest(a, DODGE, { duration: AURA_HOLD, value: prob, mods: dodge, source: unit });
              }
            }, { owner: unit });
          }
          // <俄耳甫斯·改>: the delayed heals
          const iv = Math.max(0.1, num(b3['attack@interval'], 1));
          const n = Math.max(1, Math.floor(num(b3['attack@max_target_heal'], 1)));
          const heal = num(b3['attack@heal_scale']);
          const pulse = () => {
            const seq = unit.deploySeq;
            for (const a of battle.injuredAlliesInKeys(unit.rangeKeys, unit).slice(0, n)) {
              battle.after(HEAL_DELAY, () => {
                if (!up(unit) || unit.deploySeq !== seq || !a.alive || !a.deployed) return;
                battle.heal(unit, a, unit.s.atk * heal);
              }, { owner: unit });
            }
          };
          if (heal > 0) {
            battle.on('tick', () => {
              if (st.form !== 'orpheusR' || st.pulseAt == null || unit.trait.dollSwitching || !up(unit)) return;
              while (battle.time + 1e-9 >= st.pulseAt) { pulse(); st.pulseAt += iv; }
            }, { owner: unit });
          }
        }
      },
    };
  },
};
