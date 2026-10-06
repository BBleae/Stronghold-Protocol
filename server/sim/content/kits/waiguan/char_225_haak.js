// server/sim/content/kits/waiguan/char_225_haak.js — 阿 (特种 · 怪杰 geek) 外援 kit (DESIGN §27, docs/WAIGUAN-KITS.md).
//
// Chess ids: chess_char_diy_5_char_225_haak_a/_b, chess_char_diy_6_char_225_haak_a/_b (registered by ./index.js).
// S1 快速射击 (duration): ASPD +attack_speed.
// S2 爆发剂·γ型 / S3 爆发剂·榴莲味 (duration): at the start, the nearest ally in front of him (the one straight ahead
//   first) takes `damage` (500 ATK) physical hits ×15 ("用500的攻击力攻击15次": friendly fire, the ally's DEF applies);
//   then for the skill's duration he and that ally get DEF / max HP +def / max_hp (S2) or ATK +atk / ASPD +attack_speed
//   (S3). No ally in front ⇒ only himself is buffed [ASSUMED].
// T1 混合药物射击: every attack hit rolls one of four: heal hp_ratio × his max HP · this hit's ATK ×atk_scale · target
//   停顿 sluggish s · target 晕眩 stun s; elite (module talent upgrade): with `prob` all four at once.
// T2 药剂扩散: healing he receives ×heal_scale. Module GEE-Y (uniequip_003_haak): on deploy, one ally of his range (the
//   tile straight ahead first) is healed healinrange.heal_scale × his ATK.
// Trait (geek): HP drain — professions.js installHpDrain (trait bb hp_ratio).
// Module GEE-X (uniequip_002_haak): SP +sp_recovery_per_sec while HP > 80 % (the 80 % is text-only: moduleDesc).
// fx: 'buff' (S2/S3 target), 'heal' (GEE-Y). Numbers: every one from the blackboards except the 80 % and the 15 hits.

import { num, tal, hiddenBb, moduleRec, lazySkills, mods, parseN, live, whileOn, statBuff } from './_lib.js';
import { toLocal } from '../../../dir.js';
import { COLS } from '../../../constants.js';

/** "攻击15次" — text-only. */
const HITS = 15;

/** The nearest ally in front of `unit` (facing frame), the one straight ahead first; null when none. */
function frontAlly(battle, unit, inRangeOnly = false) {
  let best = null, bk = null;
  const less = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
  for (const a of battle.alliesFor(unit)) {
    if (a === unit || !live(a)) continue;
    if (inRangeOnly && !unit.rangeKeySet?.has(a.tileR * COLS + a.tileC)) continue;
    const [lr, lc] = toLocal(a.tileR - unit.tileR, a.tileC - unit.tileC, unit.dir);   // facing-RIGHT frame
    if (!inRangeOnly && !(lc > 0)) continue;                                            // "前方"
    const k = [lr === 0 ? 0 : 1, Math.abs(lr) + Math.abs(lc), a.deploySeq];            // 正前方 first, nearest, oldest
    if (!bk || less(k, bk)) { best = a; bk = k; }
  }
  return best;
}

export default function haak(bb, chess, def) {
  const t0 = tal(chess, 0), t1 = tal(chess, 1), hb = hiddenBb(chess);
  const mod = moduleRec(chess);
  /** S2 / S3: the injection, then the shared buff on the ally for the skill's duration. */
  const injection = (rec, buffMods) => ({
    kind: 'duration',
    mods: buffMods,
    onStart({ battle, unit, skill }) {
      const a = frontAlly(battle, unit);
      unit.mem.haakTarget = a;
      if (!a) return;
      for (let i = 0; i < HITS && a.alive; i++) battle.dealDamage(unit, a, { amount: num(rec.bb?.damage, 500), type: 'phys', isSkill: true, tags: ['skill', 'haakInject'] });
      if (a.alive) {
        battle.addBuff(a, { key: `haak:inject:${unit.id}`, duration: skill.timeLeft, mods: buffMods, source: unit, visible: true });
        battle.fx('buff', { x: a.x, y: a.y, id: a.id, src: unit.id });
      }
    },
    onEnd({ battle, unit }) {
      if (unit.mem.haakTarget) battle.removeBuff(unit.mem.haakTarget, `haak:inject:${unit.id}`);
      unit.mem.haakTarget = null;
    },
  });
  return {
    skills: lazySkills(chess, {
      skchr_haak_1: (rec) => ({ kind: 'duration', mods: mods({ aspd: num(rec.bb?.attack_speed) }) }),
      skchr_haak_2: (rec) => injection(rec, mods({ defPct: num(rec.bb?.def), hpPct: num(rec.bb?.max_hp) })),
      skchr_haak_3: (rec) => injection(rec, mods({ atkPct: num(rec.bb?.atk), aspd: num(rec.bb?.attack_speed) })),
    }),
    talents: [
      { install(battle, unit) { // 混合药物射击: one roll per attack hit on its main target
        const all = num(t0.prob);
        battle.on('hit', (c) => {
          if (c.source !== unit || !c.dmg.isAttack || c.dmg.isSplash || !c.target || c.target.side !== 'enemy') return;
          const pick = all > 0 && battle.rng.chance(all) ? -1 : battle.rng.int(4);
          if (pick === -1 || pick === 0) battle.heal(unit, unit, unit.s.maxHp * num(t0.hp_ratio), { self: true });
          if (pick === -1 || pick === 1) c.dmg.amount *= num(t0.atk_scale, 1);
          if (pick === -1 || pick === 2) battle.applyStatus(c.target, 'sluggish', { duration: num(t0.sluggish), source: unit });
          if ((pick === -1 || pick === 3) && c.target.alive) battle.applyStatus(c.target, 'stun', { duration: num(t0.stun), source: unit });
        }, { owner: unit });
      } },
      { install(battle, unit) { // 药剂扩散 (+ GEE-Y deploy heal)
        statBuff(battle, unit, 'haak:t2', { healingTakenMul: num(t1.heal_scale, 1) });
        const hs = num(t1['healinrange.heal_scale']);
        if (hs > 0) battle.on('deploy', (c) => {
          if (c.unit !== unit) return;
          const a = frontAlly(battle, unit, true);
          if (a && battle.heal(unit, a, unit.s.atk * hs) > 0) battle.fx('heal', { x: a.x, y: a.y, id: a.id });
        }, { owner: unit });
      } },
    ],
    install(battle, unit) {
      // GEE-X: SP +0.25/s above 80 % HP (the module's hidden talent part; the threshold is in moduleDesc only)
      const sp = num(hb.sp_recovery_per_sec);
      if (mod && sp > 0) {
        const thr = parseN(chess?.trait?.moduleDesc, /生命值高于(\d+)%/, 80) / 100;
        whileOn(battle, unit, 0.25, () => { if (unit.hpRatio > thr) battle.addBuff(unit, { key: 'haak:geex', duration: 0.3, mods: { spRecoveryFlat: sp } }); });
      }
    },
  };
}
