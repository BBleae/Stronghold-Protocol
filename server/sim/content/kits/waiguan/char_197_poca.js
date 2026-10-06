// server/sim/content/kits/waiguan/char_197_poca.js — 早露 (狙击 · 攻城手 siegesniper) 外援 kit (DESIGN §27, KIT_GUIDE.md).
//
// Chess ids: chess_char_diy_5_char_197_poca_a/_b, chess_char_diy_6_char_197_poca_a/_b (registered by ./index.js).
// Sources: the records (data/waiguan.json; normal = skill Lv4, elite = Lv7 + module) and the official buff templates
// (ArknightsGameData zh_CN battle/buff_template_data.json: poca_t_1, poca_e_002[atk] / [add_hit], poca_e_003_t / _tr).
//
// Trait (攻城手 "优先攻击重量最重的敌人"): professions.js has no siegesniper profile, so `trait.install` = _lib heaviestFirst:
//   every attack (normal and skill attacks) picks the enemies she blocks first, then the highest 重量等级 (massLevel), then
//   the engine's order (taunt, least remaining path, earliest spawn), keeping the engine's target count.
// S1 攻击力强化·γ型 (MANUAL, DEFAULT kept): ATK +atk for its duration.
// S2 分裂射击 (MANUAL, DEFAULT kept): ATK +atk and attack@max_target targets (the trait picks the heaviest) for 60 s.
// S3 雪崩击 (MANUAL, DEFAULT kept — cast at the attack it replaces): ATK +atk for its duration; at the cast up to max_target
//   of the enemies she can target (range + blocked) are harpooned, the heaviest — "至多3个重量最重的敌人": by weight only, no
//   blocked-first step (that belongs to her attack selection); equal weights in the engine's order without that step
//   (taunt, least remaining path, earliest spawn) — 束缚 (bind) until the skill ends,
//   and an attack (her ATK, physical, a skill attack) on each of them every hit_interval s, the first at the cast:
//   round(duration / hit_interval) hits (6 / 7). [ASSUMED: the skill prefab holds this logic and has no buff template —
//   the harpooned set is fixed at the cast (a dead target is not replaced), she makes no normal attack meanwhile, the
//   first hit lands with the harpoon (in the cast's tick, after the skillStart handlers — so SIE-Y's 学生楷模 counter
//   already counts her skill for every hit), and a hit due while she cannot act (stun…) is skipped.]
// T1 深入骨髓 (poca_t_1, ON_CALCULATE_DAMAGE): her damage to an enemy of 重量等级 ≥ value ignores def_penetrate of its DEF.
//   Module SIE-X: its trait part (poca_e_002[atk], merged into this talent's bb as atk_scale): ATK ×atk_scale against
//   such an enemy (on the pre-mitigation amount: an ATK scale); its talent upgrade (poca_e_002[add_hit]): after each of
//   her attack hits on such an enemy (S3's harpoon hits included), extra_atk_scale × ATK more physical damage — the
//   template deals it with _emitSourceOnCalculateDamage: false, so neither the DEF ignore nor the ×atk_scale (both
//   ON_CALCULATE_DAMAGE) apply to it [ASSUMED: read from that flag; PRTS not reachable to confirm].
// T2 学生楷模: "编入队伍时" (pool precedent 深海掠食者, kits/tier3.js): every 【乌萨斯学生自治团】 operator of her player (_lib
//   FACTION_MEMBERS.student: 古米, 怒潮凛冬, 早露 in this mode — herself included) ATK +atk for the whole battle (persist; two
//   copies of her do not stack: the strongest value stays). Module SIE-Y: +atk becomes 0.12, and (poca_e_003_t, hidden
//   part init_atk / max_atk) every such operator gets ATK +init_atk per such operator of her player whose skill is running
//   (counted on skillStart / skillEnd like the official counter; at most max_atk).
// Module SIE-Y trait (poca_e_003_tr DamageScaleBaseOnDistance, ON_OUTPUT_DAMAGE): her damage ×(1 + damage_scale × t),
//   t = clamp((distance − min_dist) / (max_dist − min_dist), 0, 1), distance in tiles from her to the target [ASSUMED
//   linear: the node's curve is not in data; its ends are min_dist / max_dist / "最高提升12%"].
// fx: 'link' (S3 harpoon hits). No RNG.

import { num, tal, lazySkills, mods, live, hasHp, onHitBy, massOf, attackCandidates, sortTargetsBy, heaviestFirst, inFaction, bstate } from './_lib.js';
import { canTargetEnemy } from '../../../targeting.js';

const S1 = 'skcom_atk_up[3]', S2 = 'skchr_poca_2', S3 = 'skchr_poca_3';
/** Damage tags: S3 harpoon hits; T1 SIE-X extra hit. */
const S3_TAG = 'pocaS3', EXTRA_TAG = 'pocaExtra';
/** S3's pick is no attack selection: no "blocked by me first" step (header). */
const NO_BLOCK = Object.freeze({ blockedFirst: false });
/** Faction of 学生楷模: 【乌萨斯学生自治团】 (character_table teamId 'student'). */
const STUDENT = 'student';

/** S3: one harpoon attack on every still selectable target (an attack for "攻击时" content: the `attack` hook). */
function harpoon(battle, unit, targets) {
  const hit = [];
  for (const t of targets) {
    if (!hasHp(t) || !t.deployed || t.hidden || !canTargetEnemy(unit, t, unit.profile)) continue;
    battle.fx('link', { x: t.x, y: t.y, id: unit.id, src: unit.id, target: t.id });
    battle.dealDamage(unit, t, { amount: unit.s.atk * unit.s.atkScaleMul, type: 'phys', isAttack: true, isSkill: true, tags: ['skill', S3_TAG] });
    hit.push(t);
  }
  if (hit.length && battle.hasHook('attack')) battle.emit('attack', { attacker: unit, targets: hit, isSkill: true });
}

export default function poca(bb, chess) {
  const t0 = tal(chess, 0), t1 = tal(chess, 1), tm = tal(chess, -1);
  const tb = chess?.trait?.bb ?? {};
  const heavy = num(t0.value, 3);
  const isHeavy = (e) => !!e && massOf(e) >= heavy;

  return {
    trait: { install: (battle, unit) => { heaviestFirst(battle, unit); } },
    skills: lazySkills(chess, {
      [S1]: (rec) => ({ kind: 'duration', mods: mods({ atkPct: num(rec.bb?.atk) }) }),
      [S2]: (rec) => ({
        kind: 'duration',
        mods: mods({ atkPct: num(rec.bb?.atk) }),
        targeting: { maxTargets: Math.max(1, Math.floor(num(rec.bb?.['attack@max_target'], 2))) },
      }),
      [S3]: (rec) => {
        const n = Math.max(1, Math.floor(num(rec.bb?.max_target, 3)));
        const iv = num(rec.bb?.hit_interval, 1) > 0 ? num(rec.bb?.hit_interval, 1) : 1;
        const dur = num(rec.bb?.hit_duration, num(rec.duration, 6));
        return {
          kind: 'duration',
          ...(dur > 0 ? { duration: dur } : {}),
          mods: mods({ atkPct: num(rec.bb?.atk) }),
          attack: { noAttack: true },
          onStart({ battle, unit, skill }) {
            const heaviest = sortTargetsBy(unit, attackCandidates(battle, unit, unit.profile, NO_BLOCK), (e) => -massOf(e), NO_BLOCK);
            const targets = heaviest.slice(0, n);
            // the first volley lands at the cast too, once the start events ran (install: skillStart, low priority)
            unit.mem.pocaS3 = { targets, acc: 0, left: Math.max(0, Math.round(skill.duration / iv) - 1), first: true };
            for (const t of targets) battle.applyStatus(t, 'bind', { duration: skill.timeLeft, source: unit });
          },
          onTick({ battle, unit, dt }) {
            const s = unit.mem.pocaS3;
            if (!s) return;
            s.acc += dt;
            while (s.left > 0 && s.acc >= iv - 1e-9) {
              s.acc -= iv;
              s.left--;
              if (unit.canAct) harpoon(battle, unit, s.targets);
            }
          },
          onEnd({ battle, unit }) {
            const s = unit.mem.pocaS3;
            unit.mem.pocaS3 = null;
            for (const t of s?.targets ?? []) {
              const b = t.alive ? t.findBuff('bind') : null;
              if (b && b.source === unit) battle.removeBuff(t, b);
            }
          },
        };
      },
    }),
    talents: [
      { install(battle, unit) { // 深入骨髓 (+ SIE-X: ATK ×atk_scale and the extra hit)
        const pen = num(t0.def_penetrate), sc = num(t0.atk_scale, 1), extra = num(t0.extra_atk_scale);
        if (pen > 0 || sc !== 1) {
          onHitBy(battle, unit, ({ target, dmg }) => {
            if (dmg.type === 'element' || dmg.tags.includes(EXTRA_TAG) || !isHeavy(target)) return;
            if (pen > 0) dmg.defIgnorePct += pen;
            if (sc !== 1) dmg.amount *= sc;
          });
        }
        if (extra > 0) {
          battle.on('damaged', (c) => {
            const d = c.dmg;
            if (c.source !== unit || !d || !d.isAttack || d.tags.includes(EXTRA_TAG) || !isHeavy(c.target) || !hasHp(c.target)) return;
            battle.dealDamage(unit, c.target, { amount: unit.s.atk * unit.s.atkScaleMul * extra, type: 'phys', tags: ['talent', EXTRA_TAG] });
          }, { owner: unit });
        }
      } },
      { install(battle, unit) { // 学生楷模 (+ SIE-Y: ATK per student operator in skill)
        const atk = num(t1.atk);
        const team = battle.allyUnits.filter((a) => a.kind === 'op' && a.ownerId === unit.ownerId && inFaction(a, STUDENT));
        if (atk > 0) {
          for (const a of team) {
            const cur = a.findBuff('poca:model');
            if (cur && num(cur.data?.v) >= atk) continue;
            battle.addBuff(a, { key: 'poca:model', mods: { atkPct: atk }, persist: true, allowDead: true, source: unit, data: { v: atk }, tags: ['talent'] });
          }
        }
        const per = num(tm.init_atk), max = num(tm.max_atk, Infinity);
        if (!(per > 0)) return;
        // one counter per player: two copies of her (tier V / VI, possibly of different module levels) share one set of
        // hooks and the strongest numbers (同名效果不叠加)
        const reg = bstate(battle, 'poca:studentSkill');
        const cur = reg[unit.ownerId];
        if (cur) { cur.per = Math.max(cur.per, per); cur.max = Math.max(cur.max, max); return; }
        const st = (reg[unit.ownerId] = { per, max, running: new Set() });
        const running = st.running;
        const update = () => {
          const v = Math.min(st.max, st.per * running.size);
          for (const a of team) {
            const cur = a.findBuff('poca:studentSkill');
            if (!(v > 0)) { if (cur) battle.removeBuff(a, cur); continue; }
            if (cur && cur.mods?.atkPct === v) continue;
            battle.addBuff(a, { key: 'poca:studentSkill', mods: { atkPct: v }, persist: true, allowDead: true, source: unit, visible: true, tags: ['talent'] });
          }
        };
        battle.on('skillStart', (c) => { if (team.includes(c.unit) && !running.has(c.unit)) { running.add(c.unit); update(); } }, { owner: unit });
        battle.on('skillEnd', (c) => { if (running.delete(c.unit)) update(); }, { owner: unit });
      } },
    ],
    install(battle, unit) {
      // S3: the cast's harpoon volley, after every other skillStart handler (SIE-Y's 学生楷模 counter has counted her own
      // skill, so all of its hits use one ATK); still in the cast's tick
      battle.on('skillStart', (c) => {
        const s = c.unit === unit ? unit.mem.pocaS3 : null;
        if (!s || !s.first) return;
        s.first = false;
        if (unit.canAct) harpoon(battle, unit, s.targets);
      }, { owner: unit, priority: -100 });
      // SIE-Y trait: "攻击越远的敌人造成的伤害越高（最高提升12%）"
      const ds = num(tb.damage_scale), lo = num(tb.min_dist), hi = num(tb.max_dist);
      if (ds > 0 && hi > lo) {
        onHitBy(battle, unit, ({ target, dmg }) => {
          if (dmg.type === 'element' || !live(unit)) return;
          const t = Math.max(0, Math.min(1, (Math.hypot(target.x - unit.x, target.y - unit.y) - lo) / (hi - lo)));
          if (t > 0) dmg.mul *= 1 + ds * t;
        });
      }
    },
  };
}
