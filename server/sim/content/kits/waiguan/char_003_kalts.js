// server/sim/content/kits/waiguan/char_003_kalts.js — 凯尔希 (医疗 · 医师 physician) 外援 kit (DESIGN §27, KIT_GUIDE.md).
//
// Chess ids: chess_char_diy_5_char_003_kalts_a/_b, chess_char_diy_6_char_003_kalts_a/_b (registered by ./index.js).
// Summon: Mon3tr (token_10002_kalts_mon3tr) — a talent summon the player places on the board (tokens.json `placeable`,
//   owner sources 'talent'): it deploys with the board after the operators (Battle.start). Its token has no kit of its own
//   (no skill in data): its stats, 3-block melee profile and the 不毁重构 numbers come from the owner-level token variant
//   (normal / elite, per module), everything owner-coupled is done here (tokens.js `managed`). Official templates (gamedata
//   buff_template_data) are followed where the text is silent (KIT_CONVENTIONS 8, 11, 14).
// Trait (医师): single heal — the engine profile; nothing to add.
// S1 指令：结构加固 (duration): herself DEF +def and 物理闪避 +prob ("物理格挡", EN "Physical Dodge"); Mon3tr DEF +attack@def
//   while it runs (also a Mon3tr deployed meanwhile).
// S2 指令：战术协同 (duration): her ASPD +attack_speed; Mon3tr ATK +attack@atk and it strikes every enemy it blocks.
// S3 指令：熔毁 (duration): Mon3tr DEF +attack@def, ATK +attack@atk falling to +0 % — template kalts_s_3[ratio_atk]
//   RemainingRatioToAttributeModifier, stepped once per second (KIT_CONVENTIONS 11) —, its attacks deal true damage; no kill
//   by Mon3tr during the skill ⇒ when the skill runs out Mon3tr loses attack@hp_ratio of its max HP (流失; it may knock it
//   out, which sets off 不毁重构). No loss when the skill ends otherwise (Mon3tr gone, or she left — then it is withdrawn).
// Triggers: all three keep the record's DEFAULT (a heal-type skill: cast when she is about to heal an injured ally of her
//   range — the official basic strategy).
// S2 / S3 "该技能与Mon3tr绑定" — template kalts_s_2_3[sp_cond]: while no Mon3tr of hers stands, the running skill is finished,
//   her SP is cleared and SP_RECOVER_STOPPED holds it at 0; once Mon3tr is back the skill charges from 0. Here: an owner
//   spGain hook zeroes every gain while no Mon3tr stands, Mon3tr's departure ends the skill ('summonLeft') and clears the
//   SP / charges, and a 0.1 s guard clears what a (re)deployment or a carry put in meanwhile.
// T1 Mon3tr: "拥有25秒再部署时间" — Mon3tr that left the field comes back on its tile after its data redeploy time (25 s)
//   while she stands, paying its DP cost (_lib returningSummons). Template kalts_t_withdraw_token (ON_OWNER_FINISH →
//   WithdrawTokens, force, no dead state): when she leaves the field for any reason her Mon3tr are withdrawn (a retreat —
//   no 不毁重构) and come back once she stands again. "优先治疗自身和Mon3tr": her heal picks the most injured of herself /
//   Mon3tr in her range before anyone else. "Mon3tr不在凯尔希攻击范围内时防御力降至0" (kalts_t_1[token_def_down]: DEF
//   FINAL_SCALER 0): DEF ×0 while its tile is off her current range. Elite PHY-Y talent change: in her range Mon3tr ASPD
//   +attack_speed, DEF +def (record numbers; 0 where the module level carries none).
// T2 不毁重构: Mon3tr knocked out (kalts_token_death_rattle_projectile ON_OWNER_KILLED: not a retreat / withdrawal) ⇒ every
//   enemy on the 3×3 around it is stunned `stun` s and takes `value` true damage; elite PHY-X (when its level carries it):
//   also the first time per deployment its HP falls below hp_ratio. Numbers: the Mon3tr token talent of the owner-level
//   variant (stun / value / hp_ratio + its 3×3 grid); the owner talent text is the fallback.
// Modules (elite), dispatched by `chess.module.type` (KIT_CONVENTIONS 15), numbers from the trait record: PHY-X Mon2tr
//   "治疗生命值低于50%的友方单位时治疗量提升15%" (heal_scale / hp_ratio, the HP before the heal) + the 不毁重构 upgrade above;
//   PHY-Y 医者 "治疗地面单位时治疗量提升15%" (heal_scale) + the talent-1 in-range bonus above; ISW-A: its trait ("在集成战略中，
//   同时治疗两个目标" — its bb repeats heal_scale / hp_ratio) and talent parts ("在集成战略中，Mon3tr不占用部署位，生命上限和攻击力
//   +50%且受到的治疗效果提升50%" — merged into the talent-1 bb as atk / max_hp / heal_scale) are mode-scoped [ASSUMED: no
//   battle effect in this mode, pool precedent and REQUIREMENTS §7] — only its stats apply. Module stats come with the data.
// fx: 'buff' (S2/S3 on Mon3tr), 'shockBlast' (不毁重构), 'summon' (Mon3tr back).

import {
  num, tal, talRec, traitBb, selectedId, lazySkills, mods, parseN, live, ANY,
  summonsOf, linkSummonBuff, hitAllBlocked, returningSummons, whileOn,
} from './_lib.js';
import { absoluteRangeKeys } from '../../../targeting.js';
import { COLS } from '../../../constants.js';

/** Mon3tr's token id (data: the talent's tokenKey / the chess `tokens`; this is the fallback). */
const MON3TR = 'token_10002_kalts_mon3tr';
/** "周围8格" — the 3×3 around Mon3tr (data: the token talent's own rangeGrid; this is its fallback). */
const GRID_3X3 = Object.freeze([[1, -1], [1, 0], [1, 1], [0, -1], [0, 0], [0, 1], [-1, -1], [-1, 0], [-1, 1]]);
/** Period of the "Mon3tr在凯尔希攻击范围内" check (s); the resulting buff lasts a little longer. */
const RANGE_CHECK = 0.1;
/** Period of the S2/S3 SP guard (kalts_s_2_3[sp_cond]) while no Mon3tr stands (s). */
const SP_GUARD = 0.1;
/** RemainingRatioToAttributeModifier step (s) — KIT_CONVENTIONS 11. */
const RATIO_STEP = 1;
const S1 = 'skchr_kalts_1', S2 = 'skchr_kalts_2', S3 = 'skchr_kalts_3';
/** Skills "该技能与Mon3tr绑定". */
const BOUND = new Set([S2, S3]);

export default function kalts(bb, chess, def) {
  const t0 = tal(chess, 0);
  const t1Text = talRec(chess, 1)?.desc ?? '';
  const tb = traitBb(chess);
  const moduleType = chess?.module?.active ? chess.module.type ?? null : null;
  const sid = selectedId(chess, def);
  const monId = talRec(chess, 0)?.tokenKey ?? (chess?.tokens ?? [])[0] ?? MON3TR;
  const recOf = (id) => (chess?.skills ?? []).find((s) => s && s.skillId === id) ?? {};
  const sbb = (id, key) => num(recOf(id).bb?.[key]);

  /** 不毁重构 numbers of a Mon3tr unit: its own talent (owner-level variant), else the owner talent text. */
  const rebuildOf = (m) => {
    const t = (m.def?.talents ?? []).find((x) => x && x.bb && num(x.bb.value) > 0);
    return {
      stun: num(t?.bb?.stun, parseN(t1Text, /晕眩([\d.]+)秒/, 0)),
      value: num(t?.bb?.value, parseN(t1Text, /(\d+)点真实伤害/, 0)),
      hpRatio: num(t?.bb?.hp_ratio, parseN(t1Text, /生命值首次低于(\d+)%/, 0) / 100),
      grid: t?.rangeGrid?.length ? t.rangeGrid : GRID_3X3,
    };
  };

  return {
    skills: lazySkills(chess, {
      [S1]: (rec) => ({ kind: 'duration', mods: mods({ defPct: num(rec.bb?.def), dodgePhys: num(rec.bb?.prob) }) }),
      [S2]: (rec) => ({ kind: 'duration', mods: mods({ aspd: num(rec.bb?.attack_speed) }) }),
      [S3]: (rec) => ({
        kind: 'duration',
        onStart({ unit }) { unit.mem.kaltsS3Kills = 0; unit.mem.kaltsS3Time = 0; },
        onTick({ battle, unit, skill, dt }) {
          // ATK +attack@atk × the remaining ratio, re-read once per second (kalts_s_3[ratio_atk])
          unit.mem.kaltsS3Time = num(unit.mem.kaltsS3Time) + dt;
          const steps = Math.floor(unit.mem.kaltsS3Time / RATIO_STEP + 1e-9);
          const f = skill.duration > 0 ? Math.max(0, Math.min(1, 1 - (steps * RATIO_STEP) / skill.duration)) : 0;
          const atk = num(rec.bb?.['attack@atk']) * f;
          for (const m of summonsOf(battle, unit, monId)) {
            const b = m.findBuff('kalts:s3');
            if (b && b.mods && b.mods.atkPct !== atk) { b.mods = { ...b.mods, atkPct: atk }; m.markDirty(); }
          }
        },
        onEnd({ battle, unit, reason }) {
          // "此期间如果未击杀任何敌人则技能结束后流失最大生命的50%": the template's buff on Mon3tr runs out with the skill; her own
          // departure withdraws Mon3tr (kalts_t_withdraw_token) and Mon3tr leaving ends the skill — no loss then
          if (reason !== 'duration' || unit.mem.kaltsS3Kills > 0) return;
          const ratio = num(rec.bb?.['attack@hp_ratio']);
          if (ratio > 0) for (const m of summonsOf(battle, unit, monId)) battle.loseHp(m, m.s.maxHp * ratio, { source: unit, tags: ['skill', 'kaltsMeltdown'] });
        },
      }),
    }),
    talents: [
      { install(battle, unit) { // Mon3tr: return, withdrawal with her, heal priority, DEF 0 out of her range (+ PHY-Y bonus)
        const isMon = (t) => !!t && t.kind === 'token' && t.ownerUnit === unit && t.defId === monId;
        returningSummons(battle, unit, { pick: (t) => t.defId === monId, reasons: ['killed', 'retreat'] });
        // kalts_t_withdraw_token: she leaves the field (any reason) ⇒ her Mon3tr are withdrawn (not knocked out)
        battle.on('death', (c) => {
          if (c.unit !== unit || battle.finished) return;
          for (const m of summonsOf(battle, unit, monId)) battle.retreat(m, { reason: 'retreat' });
        }, { owner: unit });
        // "优先治疗自身和Mon3tr": the most injured of herself / Mon3tr in her range goes first
        battle.on('beforeAttack', (c) => {
          if (c.attacker !== unit || c.profile?.dmgType !== 'heal' || !c.targets.length) return;
          const pri = battle.injuredAlliesInKeys(unit.rangeKeys, unit).filter((a) => a === unit || isMon(a));
          if (!pri.length) return;
          c.targets = [...pri, ...c.targets.filter((t) => !pri.includes(t))].slice(0, c.targets.length);
        }, { owner: unit });
        const linkMods = mods({ defPct: num(t0.def), aspd: num(t0.attack_speed) });
        const linked = Object.keys(linkMods).length > 0;
        whileOn(battle, unit, RANGE_CHECK, () => {
          for (const m of summonsOf(battle, unit, monId)) {
            if (!unit.rangeKeySet?.has(m.tileR * COLS + m.tileC)) battle.addBuff(m, { key: 'kalts:exposed', duration: RANGE_CHECK * 1.5, mods: { defMul: 0 }, source: unit });
            else if (linked) battle.addBuff(m, { key: 'kalts:link', duration: RANGE_CHECK * 1.5, mods: linkMods, source: unit });
          }
        });
      } },
      { install(battle, unit) { // 不毁重构 (+ PHY-X: the first fall below hp_ratio of each deployment)
        const isMon = (t) => !!t && t.kind === 'token' && t.ownerUnit === unit && t.defId === monId;
        const rebuild = (m) => {
          const n = rebuildOf(m);
          const foes = battle.enemiesInKeys(absoluteRangeKeys(n.grid, m.tileR, m.tileC, m.dir, 0), m, ANY);
          battle.fx('shockBlast', { x: m.x, y: m.y, id: m.id, r: 1.5 });
          for (const e of foes) {
            if (n.stun > 0) battle.applyStatus(e, 'stun', { duration: n.stun, source: m });
            if (n.value > 0 && e.alive) battle.dealDamage(m, e, { amount: n.value, type: 'true', tags: ['talent', 'kaltsRebuild'] });
          }
        };
        battle.on('death', (c) => {
          if (isMon(c.unit) && c.reason === 'killed' && !battle.finished) rebuild(c.unit);
        }, { owner: unit });
        battle.on('deploy', (c) => { if (isMon(c.unit)) c.unit.mem.kaltsHalf = false; }, { owner: unit });
        battle.on('damaged', (c) => {
          const m = c.target;
          // "生命值首次低于50%": once per deployment, by a hit it survives [ASSUMED: a lethal hit sets off the knock-out
          // burst only]
          if (!isMon(m) || m.mem.kaltsHalf || !(m.hp > 0) || !m.alive) return;
          const thr = rebuildOf(m).hpRatio;
          if (!(thr > 0) || !(m.hpRatio < thr)) return;
          m.mem.kaltsHalf = true;
          rebuild(m);
        }, { owner: unit });
      } },
    ],
    install(battle, unit) {
      const isMon = (t) => !!t && t.kind === 'token' && t.ownerUnit === unit && t.defId === monId;
      const monUp = () => summonsOf(battle, unit, monId).length > 0;
      // module trait (by module type): PHY-X low-HP heals, PHY-Y heals on ground units; ISW-A is 集成战略-only [ASSUMED]
      const healScale = num(tb.heal_scale, 1);
      const lowHp = moduleType === 'PHY-X' ? num(tb.hp_ratio) : 0;
      if (healScale > 1 && (lowHp > 0 || moduleType === 'PHY-Y')) {
        battle.on('heal', (c) => {
          if (c.source !== unit || c.opts?.regen || !c.target || c.target.side !== 'ally') return;
          if (lowHp > 0 ? c.target.hpRatio < lowHp : !c.target.isFlying) c.amount *= healScale;
        }, { owner: unit });
      }
      if (sid === S1) {
        const d = sbb(S1, 'attack@def');
        linkSummonBuff(battle, unit, 'kalts:s1', isMon, () => ({ mods: mods({ defPct: d }), visible: true }));
      }
      if (!BOUND.has(sid)) return;
      // "该技能与Mon3tr绑定" (kalts_s_2_3[sp_cond]): no Mon3tr ⇒ the skill ends, SP 0 and no SP recovery
      const lock = () => {
        const sk = unit.skill;
        if (!sk || sk.noSkill) return;
        if (sk.active) sk.end('summonLeft');
        sk.sp = 0;
        sk.charges = 0;
      };
      battle.on('spGain', (c) => { if (c.unit === unit && !monUp()) c.amount = 0; }, { owner: unit, priority: 100 });
      battle.on('death', (c) => { if (isMon(c.unit) && !monUp()) lock(); }, { owner: unit, priority: 10 });
      battle.every(SP_GUARD, () => { if (live(unit) && !monUp()) lock(); }, { owner: unit, immediate: true });
      battle.on('skillStart', (c) => {
        if (c.unit !== unit) return;
        for (const m of summonsOf(battle, unit, monId)) battle.fx('buff', { x: m.x, y: m.y, id: m.id, src: unit.id });
      }, { owner: unit });
      if (sid === S2) {
        const a = sbb(S2, 'attack@atk');
        linkSummonBuff(battle, unit, 'kalts:s2', isMon, () => ({ mods: mods({ atkPct: a }), visible: true }));
        // "Mon3tr可以攻击阻挡的所有敌人"
        hitAllBlocked(battle, unit, (u) => isMon(u) && !!unit.skill?.active);
      } else {
        const d = sbb(S3, 'attack@def'), a = sbb(S3, 'attack@atk');
        // (atkPct steps down in the spec's onTick)
        linkSummonBuff(battle, unit, 'kalts:s3', isMon, () => ({ mods: { defPct: d, atkPct: a }, visible: true }));
        // "伤害类型变为真实": Mon3tr's attacks while S3 runs
        battle.on('hit', (c) => {
          if (!isMon(c.source) || !c.dmg.isAttack || !unit.skill?.active) return;
          if (c.dmg.type === 'phys' || c.dmg.type === 'arts') c.dmg.type = 'true';
        }, { owner: unit, priority: 100 });
        battle.on('kill', (c) => {
          if (unit.skill?.active && c.victim?.side === 'enemy' && isMon(c.killer)) unit.mem.kaltsS3Kills = (unit.mem.kaltsS3Kills ?? 0) + 1;
        }, { owner: unit });
      }
    },
  };
}
