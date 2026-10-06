// server/sim/content/kits/waiguan/char_2023_ling.js — 令 (辅助 · 召唤师 summoner) 外援 kit (DESIGN §27, KIT_GUIDE.md).
//
// Chess ids: chess_char_diy_5_char_2023_ling_a/_b, chess_char_diy_6_char_2023_ling_a/_b (registered by ./index.js).
// Summons: one per skill (the skill record's overrideTokenKey) — S1 “清平” soul1 (melee, blocks 1), S2 “逍遥” soul2 (ranged,
//   arts), S3 “弦惊” soul3 (melee, blocks 2, "攻击阻挡的所有敌人"). The player places the selected skill's pieces on the board
//   (tokens.json `placeable`, owner sources 'skill' ⇒ content/tokens.js docks them; SKILL_SUMMON_START_DEPLOY: they deploy
//   with the board, free, "无视持有状态"); a piece of another skill never deploys (dockSkillSummons `deferDeploy`). Their
//   stats / costs / redeploy times are the owner-level token variants (normal, elite per module). Owner-coupled behaviour
//   is done here (tokens.js `managed`); the kit never calls releaseSkillSummon (that path redeploys for free).
// Trait (召唤师): arts attacker — the engine profile; "可以使用召唤物协助作战" = the summons below.
// T1 挑灯问梦 "可以使用5个召唤物（最多同时部署3个）": she holds `cnt` (5) summons. A piece that left the field comes back on its
//   tile from that holding (one used per return) once its data redeploy time is over, while fewer than the deploy limit
//   stand — data: the token's base deployLimit + its hidden talent max_deploy_count (3, elite SUM-Y 4; text fallback) —
//   and she stands on the field, paying its DP cost (_lib returningSummons). The holding is per battle (REQUIREMENTS §5:
//   the official count, used up ⇒ no more this battle; a new battle starts full). The battle-start deployment of her
//   pieces draws on it too, one each, and still deploys a piece when it is empty [ASSUMED: "可以使用5个召唤物" counts every
//   summon she uses; "作战开始时无视持有状态自动部署", PRTS 赫默 note]. Elite SUM-Y talent change: stronger summons (data).
// T2 随付笺咏醉屠苏: one of her summons knocked out / absorbed (S3 merge) / recalled (S2) ⇒ she gains `sp` SP and ATK +atk
//   (stacking, max_stack_cnt), the stacks kept until she leaves the field [ASSUMED: an ordinary buff].
// S1 重进酒 (duration): she and her summons ATK +atk, ASPD +attack_speed, the summons' attacks deal arts damage; at the
//   start she gains `cnt` summon(s). Passive "召唤物可部署在近战位": a placement rule (prep), nothing in battle.
// S2 笑鸣瑟 (instant, 2 charges): she and each of her summons strike up to `value` (2) enemies of their own attack range
//   (the engine's candidates: range + blocked, its target order) for atk_scale × their own ATK arts (a summon: its token
//   skill's 2.atk_scale — the same number per level) and 束缚 (bind) ling_s2_unmovable.duration s (a summon: 2.duration);
//   then ("技能结束时") every summon below hp_ratio of its max HP is recalled — off the field, back into her holding
//   (`cnt` [ASSUMED: the summons a recall gives back]), returning by T1. Passive "召唤物可部署在远程位，攻击造成法术伤害":
//   placement + the soul2 data (arts).
// S3 宁作吾 (duration): she and her summons ATK +atk, DEF +def; every `interval` s each summon deals atk_scale × HER ATK arts
//   to the GROUND enemies (template ling_s3_aoe[token] targetMotion WALK_ONLY) on the 4 tiles around it (and its own tile
//   [ASSUMED]); at the natural end she gains `cnt` summon(s).
//   Passive merge: a soul3 that deploys with another basic soul3 of hers in its attack range merges with it — the
//   newcomer is absorbed (leaves the field, T2 fires; its piece returns by T1 later) and the standing one becomes the
//   高级形态 [ASSUMED which one stays: the text names no side]: its token skill's 2.* numbers — max HP +2.max_hp, ATK +2.atk,
//   DEF +2.def (fractions), RES ×(1 + 2.magic_resistance), attack interval +2.base_attack_time s (flat, KIT_GUIDE batMod
//   convention), block +2.block_cnt [ASSUMED: the reading of these keys], arts attacks; "占据2个部署位" is a prep rule. An
//   advanced one never merges again.
// Summon traits the token data does not give the engine: soul3 "攻击阻挡的所有敌人" (token trait text) ⇒ _lib hitAllBlocked.
// Module SUM-Y 诗短梦长 (uniequip_002_ling): "召唤物持有上限+3" (trait bb cnt) — the holding cannot exceed talent cnt (+ trait
//   cnt) [ASSUMED: base cap = the talent's 5]; "召唤物部署费用减少" — the lower token costs of the data (soul1 9 vs 12 …) are
//   what each return pays. Module stats (attr) come with the data.
// fx: 'lightning' (S2 strikes), 'disappear' (recall / absorption), 'grow' (高级形态), 'pulse' (S3), 'summon' (returns).

import {
  num, bv, tal, talRec, traitBb, selectedId, lazySkills, mods, parseN, live, giveSp, instantKindOf,
  summonsOf, linkSummonBuff, hitAllBlocked, returningSummons, attackCandidates,
} from './_lib.js';
import { absoluteRangeKeys } from '../../../targeting.js';
import { COLS } from '../../../constants.js';

const S1 = 'skchr_ling_1', S2 = 'skchr_ling_2', S3 = 'skchr_ling_3';
/** Token of each skill (data: the skill record's overrideTokenKey; this is the fallback). */
const SOUL = Object.freeze({ [S1]: 'token_10020_ling_soul1', [S2]: 'token_10020_ling_soul2', [S3]: 'token_10020_ling_soul3' });
/** "周围四格" — the 4 tiles around a summon, and its own tile [ASSUMED: an enemy it blocks may stand on it]. */
const GRID_PLUS = Object.freeze([[1, 0], [0, -1], [0, 0], [0, 1], [-1, 0]]);
/** S3 pulse targets: ling_s3_aoe[token] AOEDamage targetMotion WALK_ONLY — ground enemies only (KIT_CONVENTIONS 13). */
const GROUND = Object.freeze({ canHitFly: false, groundOnly: true });
/** Buff key of the merged 高级形态 (S3). */
const ADV = 'ling:advanced';

/** Add `n` summons to her holding (capped). */
function gainSummons(unit, n) {
  const cap = num(unit.mem.lingHoldCap, Infinity);
  unit.mem.lingHold = Math.min(cap, num(unit.mem.lingHold, 0) + Math.max(0, num(n, 0)));
}

export default function ling(bb, chess, def) {
  const t0 = tal(chess, 0), t1 = tal(chess, 1);
  const t0Text = talRec(chess, 0)?.desc ?? '';
  const tb = traitBb(chess);
  const sid = selectedId(chess, def);
  const recOf = (id) => (chess?.skills ?? []).find((s) => s && s.skillId === id) ?? {};
  const tokId = recOf(sid).overrideTokenKey ?? SOUL[sid] ?? null;
  const sbb = (id) => recOf(id).bb ?? {};

  return {
    skills: lazySkills(chess, {
      [S1]: (rec) => ({
        kind: 'duration',
        mods: mods({ atkPct: num(rec.bb?.atk), aspd: num(rec.bb?.attack_speed) }),
        onStart({ unit }) { gainSummons(unit, num(rec.bb?.cnt)); },
      }),
      [S2]: (rec) => ({
        kind: instantKindOf(rec),
        onStart({ battle, unit }) {
          const n = Math.floor(num(rec.bb?.value));
          for (const s of [unit, ...summonsOf(battle, unit)]) {
            const own = s === unit ? {} : (s.def?.skill?.bb ?? {});
            const scale = s === unit ? num(rec.bb?.atk_scale) : bv(own, 'atk_scale', num(rec.bb?.atk_scale));
            const bind = s === unit ? num(rec.bb?.['ling_s2_unmovable.duration']) : bv(own, 'duration', num(rec.bb?.['ling_s2_unmovable.duration']));
            for (const e of attackCandidates(battle, s, s.profile).slice(0, n)) {
              battle.fx('lightning', { x: e.x, y: e.y, id: e.id, src: s.id, fromX: s.x, fromY: s.y });
              battle.dealDamage(s, e, { amount: s.s.atk * scale, type: 'arts', isSkill: true, tags: ['skill', 'lingS2'] });
              if (e.alive && bind > 0) battle.applyStatus(e, 'bind', { duration: bind, source: s });
            }
          }
        },
        onEnd({ battle, unit }) {
          // "技能结束时回收生命值低于一半的召唤物"
          const ratio = num(rec.bb?.hp_ratio);
          for (const s of summonsOf(battle, unit)) {
            if (!(s.hpRatio < ratio)) continue;
            s.mem.lingLeave = 'recall';
            s.mem.lingGive = num(rec.bb?.cnt);
            battle.fx('disappear', { x: s.x, y: s.y, id: s.id });
            battle.retreat(s, { reason: 'retreat' });
          }
        },
      }),
      [S3]: (rec) => ({
        kind: 'duration',
        mods: mods({ atkPct: num(rec.bb?.atk), defPct: num(rec.bb?.def) }),
        onStart({ unit }) { unit.mem.lingPulse = 0; },
        onTick({ battle, unit, dt }) {
          // "召唤物每0.5秒对周围四格敌人造成20%令攻击力的法术伤害" (first pulse one interval after the start)
          const iv = num(rec.bb?.interval);
          if (!(iv > 0)) return;
          unit.mem.lingPulse = num(unit.mem.lingPulse, 0) + dt;
          while (unit.mem.lingPulse >= iv - 1e-9) {
            unit.mem.lingPulse -= iv;
            const amount = unit.s.atk * num(rec.bb?.atk_scale);
            if (!(amount > 0)) continue;
            for (const s of summonsOf(battle, unit)) {
              const foes = battle.enemiesInKeys(absoluteRangeKeys(GRID_PLUS, s.tileR, s.tileC, s.dir, 0), s, GROUND);
              if (foes.length) battle.fx('pulse', { x: s.x, y: s.y, id: s.id, r: 1 });
              for (const e of foes) battle.dealDamage(s, e, { amount, type: 'arts', isSkill: true, tags: ['skill', 'lingS3'] });
            }
          }
        },
        onEnd({ unit, reason }) { if (reason === 'duration') gainSummons(unit, num(rec.bb?.cnt)); },
      }),
    }),
    talents: [
      { install(battle, unit) { // 挑灯问梦: the holding, the deploy limit, the returns
        unit.mem.lingHoldCap = num(t0.cnt) + num(tb.cnt);
        unit.mem.lingHold = Math.min(unit.mem.lingHoldCap, num(t0.cnt));
        if (!tokId) return;
        // the battle-start deployment of her pieces uses the holding (never below 0: they deploy regardless)
        battle.on('deploy', (c) => {
          const t = c.unit;
          if (c.initial && t && t.kind === 'token' && t.ownerUnit === unit && t.defId === tokId) unit.mem.lingHold = Math.max(0, num(unit.mem.lingHold, 0) - 1);
        }, { owner: unit });
        const tdef = battle.tokenDef(tokId, unit);
        const extra = (tdef?.talents ?? []).find((t) => t && t.bb && t.bb.max_deploy_count != null)?.bb?.max_deploy_count;
        // (no data and no text number ⇒ no cap of her own)
        const maxLive = extra != null ? num(tdef?.stats?.deployLimit, num(tdef?.raw?.deployLimit, 1)) + num(extra) : parseN(t0Text, /最多同时部署(\d+)个/, Infinity);
        returningSummons(battle, unit, {
          pick: (t) => t.defId === tokId,
          reasons: ['killed', 'retreat'],
          onLeave: (t) => {
            if (t.mem.lingLeave === 'recall') gainSummons(unit, num(t.mem.lingGive));
            t.mem.lingLeave = null;
            return true;
          },
          ready: () => num(unit.mem.lingHold, 0) >= 1 && summonsOf(battle, unit).length < maxLive,
          onBack: () => { unit.mem.lingHold = Math.max(0, num(unit.mem.lingHold, 0) - 1); },
        });
      } },
      { install(battle, unit) { // 随付笺咏醉屠苏: a summon knocked out / absorbed / recalled ⇒ SP + stacking ATK
        battle.on('death', (c) => {
          const t = c.unit;
          if (!t || t.kind !== 'token' || t.ownerUnit !== unit || battle.finished || !live(unit)) return;
          if (!(c.reason === 'killed' || t.mem.lingLeave === 'recall' || t.mem.lingLeave === 'absorb')) return;
          giveSp(unit, num(t1.sp));
          if (num(t1.atk) > 0) battle.addBuff(unit, { key: 'ling:t2', refresh: 'stack', maxStacks: Math.max(1, num(t1.max_stack_cnt)), mods: { atkPct: num(t1.atk) }, visible: true });
        }, { owner: unit });
      } },
    ],
    install(battle, unit) {
      const isMine = (t) => !!t && t.kind === 'token' && t.ownerUnit === unit;
      // soul3 "攻击阻挡的所有敌人" (its token trait; no engine profile has it)
      hitAllBlocked(battle, unit, (u) => isMine(u) && /攻击阻挡的所有敌人/.test(String(u.def?.trait ?? '')));
      // the 高级形态 attacks deal arts damage (S3 merge); S1 turns every summon's attacks to arts while it runs
      battle.on('hit', (c) => {
        const s = c.source;
        if (!isMine(s) || !c.dmg.isAttack || c.dmg.type !== 'phys') return;
        if (s.findBuff(ADV) || (sid === S1 && unit.skill?.active)) c.dmg.type = 'arts';
      }, { owner: unit, priority: 100 });
      if (sid === S1) {
        const b = sbb(S1);
        linkSummonBuff(battle, unit, 'ling:s1', () => true, () => ({ mods: mods({ atkPct: num(b.atk), aspd: num(b.attack_speed) }), visible: true }));
      } else if (sid === S3) {
        const b = sbb(S3);
        linkSummonBuff(battle, unit, 'ling:s3', () => true, () => ({ mods: mods({ atkPct: num(b.atk), defPct: num(b.def) }), visible: true }));
        // passive merge (checked once the newcomer stands: after this deployment's hooks)
        battle.on('deploy', (c) => {
          const nb = c.unit;
          if (!isMine(nb) || nb.defId !== tokId) return;
          const seq = nb.deploySeq;
          battle.after(0, () => {
            if (!live(nb) || nb.deploySeq !== seq || nb.findBuff(ADV)) return;
            // a host already standing when the newcomer deployed (this check runs after the whole deployment phase)
            const host = summonsOf(battle, unit, tokId).find((a) => a !== nb && a.deploySeq < seq && !a.findBuff(ADV) && nb.rangeKeySet?.has(a.tileR * COLS + a.tileC));
            if (!host) return;
            const sb = host.def?.skill?.bb ?? {};
            nb.mem.lingLeave = 'absorb';
            battle.fx('disappear', { x: nb.x, y: nb.y, id: nb.id });
            battle.retreat(nb, { reason: 'retreat' });
            battle.addBuff(host, {
              key: ADV, source: unit, visible: true,
              mods: mods({
                hpPct: bv(sb, 'max_hp'), atkPct: bv(sb, 'atk'), defPct: bv(sb, 'def'), resMul: 1 + bv(sb, 'magic_resistance'),
                batPct: bv(sb, 'base_attack_time') / (num(host.base.bat, 1) || 1), blockCnt: bv(sb, 'block_cnt'),
              }),
            });
            battle.fx('grow', { x: host.x, y: host.y, id: host.id });
          }, { owner: unit });
        }, { owner: unit });
      }
    },
  };
}
