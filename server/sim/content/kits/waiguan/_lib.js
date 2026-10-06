// server/sim/content/kits/waiguan/_lib.js — shared helpers of the 外援 / 甄选 (DIY) kits (DESIGN §27, KIT_GUIDE).
//
// One place for the helpers every waiguan/<charId>.js file uses, so 87 kits read their data the same way. Re-exports the
// tier-1 helpers (kits/tier1.js named exports) and adds the tier-5 / tier-6 conventions that were file-local there.

import { COLS } from '../../../constants.js';
import { hasHp } from '../../../damage.js';
import { aggregateMods } from '../../../buffs.js';

export {
  num, talentGrid, moduleBb, traitBb, moduleOn, up, posKey, cheb, isMainHit, byEnemyAttack, hurtSpDamage, skillBusy, giveSp,
  onHitBy, onHitOn, onDamagedOn, enemiesInGrid, alliesInGridOf, enemyInRange, once, statBuff, toggleBuff, installAura,
  spTimeBonus, installReveal, makeZone, summonTileFree, freeTileAround, instantKind, skillRec, skillBbOf, batMod, RING1,
} from '../tier1.js';
export { hasHp };

const n0 = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Talent record of DATA index `i` (0, 1, 2 … ; hidden module parts are −1 / −2 / 2 / 3: check the record). */
export const talRec = (chess, i) => (chess?.talents ?? []).find((t) => t && t.index === i) ?? null;
/** Blackboard of the talent of DATA index `i` ({} when absent — a normal chess, or module 'none'). */
export const tal = (chess, i) => talRec(chess, i)?.bb ?? {};
/** Merged blackboard of every hidden (name-less) module part of the loadout-resolved record. */
export function hiddenBb(chess) {
  const o = {};
  for (const t of chess?.talents ?? []) if (t && t.hidden && !t.name && t.bb) for (const [k, v] of Object.entries(t.bb)) if (!(k in o)) o[k] = v;
  return o;
}
/** The equipped module record (`chess.modules[]` entry) of an elite with an active module, else null. */
export function moduleRec(chess) {
  const m = chess?.module;
  return m && m.active && m.id ? (chess.modules ?? []).find((x) => x && x.uniEquipId === m.id) ?? null : null;
}
/** Id of the equipped module ('uniequip_00X_<char>') or null (normal chess, module 'none', operator without modules). */
export const moduleId = (chess) => moduleRec(chess)?.uniEquipId ?? null;

/** Id of the SELECTED skill (loadout-resolved record, else the def). */
export const selectedId = (chess, def) => chess?.skill?.skillId ?? def?.skill?.id ?? null;
/** True when the selected skill is the chess's default one. */
export function onDefaultSkill(chess) {
  const d = (chess?.skills ?? []).find((s) => s && s.isDefault);
  return !d || !chess?.skill || d.skillId === chess.skill.skillId;
}
/** `skills` map whose entries are built only when read (each builder receives its OWN SkillRecord). */
export function lazySkills(chess, builders) {
  const o = {};
  for (const [id, build] of Object.entries(builders)) {
    Object.defineProperty(o, id, { enumerable: true, get: () => build((chess?.skills ?? []).find((s) => s && s.skillId === id) ?? chess?.skill ?? {}) });
  }
  return o;
}
/** Spec kind of an instant skill record (charges when it can charge). */
export const instantKindOf = (rec) => (n0(rec?.maxChargeTime, 1) > 1 ? 'charges' : 'instant');
/** The skill record's own range grid (null: the unit's range). */
export const gridOf = (rec) => (Array.isArray(rec?.rangeGrid) && rec.rangeGrid.length ? rec.rangeGrid : null);
/** Drop zero / non-finite entries of a mods object (a zero mod is noise in the buff list). */
export function mods(m) {
  const o = {};
  for (const [k, v] of Object.entries(m)) if (typeof v === 'number' && Number.isFinite(v) && v !== 0 && !(k.endsWith('Mul') && v === 1)) o[k] = v;
  return o;
}
/**
 * Blackboard value by exact key, else the first key ending with `.key` / `]key` (prefixed official keys such as
 * 'haak_s_2[x].atk' or 'attack@sluggish') — copy of tier6.js bv. Prefer the exact key when you know it.
 */
export function bv(bb, key, d = 0) {
  if (!bb) return d;
  const v = bb[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  for (const k of Object.keys(bb)) {
    if (k.endsWith('.' + key) || k.endsWith(']' + key) || k.endsWith('@' + key)) {
      const x = bb[k];
      if (typeof x === 'number' && Number.isFinite(x)) return x;
    }
  }
  return d;
}
/** First number in `text` matching `re` (group 1), else `d` — for numbers that exist only in the official text. */
export const parseN = (text, re, d) => { const m = String(text ?? '').match(re); return m ? +m[1] : d; };

export const live = (u) => !!u && u.alive && u.deployed && !u.removed && !u.hidden;
export const isOp = (u) => !!u && u.kind === 'op';
export const isEliteEnemy = (e) => !!e && (e.isBoss || e.def?.rank === 'ELITE' || e.def?.rank === 'BOSS');
export const ANY = Object.freeze({ canHitFly: true });
export const keyOf = (u) => Math.round(u.y) * COLS + Math.round(u.x);

/** Periodic check while `unit` is on the field (`battle.every`, owned by the unit). */
export function whileOn(battle, unit, sec, fn) {
  return battle.every(sec, () => { if (live(unit)) fn(); }, { owner: unit });
}
/** Deal `amount` 元素损伤 of `el` — nothing on a target without HP left (a lethal hit's `damaged` hook). */
export const elementDmg = (battle, src, tgt, el, amount, tags = ['skill']) =>
  (amount > 0 && hasHp(tgt) ? battle.dealDamage(src, tgt, { type: 'element', element: el, amount, tags }) : 0);
/** 元素伤害 (HP damage of an element: no DEF/RES/dodge, × 元素脆弱). */
export const elementalDmg = (battle, src, tgt, amount, element = null, tags = ['skill']) =>
  (amount > 0 && tgt && tgt.alive ? battle.dealDamage(src, tgt, { amount, type: 'elemental', element, canDodge: false, tags }) : 0);
/** Barrier of `total` HP decaying linearly to 0 over `dur` s (dur 0 ⇒ lasting). */
export function decayingShield(battle, u, key, total, dur) {
  if (!(total > 0)) return null;
  const decays = dur > 0;
  return battle.addBuff(u, {
    key, shield: total, duration: decays ? dur : Infinity, visible: true, interval: decays ? 0.5 : 0,
    onTick: decays ? ({ unit, buff }) => { buff.shield = Math.max(0, buff.shield - (total * 0.5) / dur); unit.markDirty(); } : null,
  });
}
/**
 * 鼓舞 (ba.inspire): +`val` ATK (or DEF) after the target's own multipliers, strongest source wins (copy of tier6.js).
 */
export function inspire(battle, target, val, src, stat = 'atk') {
  if (!(val > 0) || !live(target) || target.mem.noInspire) return;
  const key = stat === 'def' ? 'inspire:def' : 'inspire';
  const cur = target.findBuff(key);
  if (cur && cur.data && cur.data.src !== src.id && cur.data.val > val && cur.timeLeft > 0.1) return;
  const { add, mul } = aggregateMods(target.buffs.filter((b) => b.key !== key));
  const f = stat === 'def' ? Math.max(0, 1 + (add.defPct ?? 0)) * (mul.defMul ?? 1) : Math.max(0, 1 + (add.atkPct ?? 0)) * (mul.atkMul ?? 1);
  const flat = f > 1e-6 ? val / f : val;
  battle.addBuff(target, { key, mods: stat === 'def' ? { defFlat: flat } : { atkFlat: flat }, duration: 0.75, refresh: 'replace', source: src, visible: true, data: { src: src.id, val } });
}
/** Per-battle state shared by every copy of a kit (trackers registered once per battle). */
const STATE = new WeakMap();
export function bstate(battle, key) {
  let s = STATE.get(battle);
  if (!s) STATE.set(battle, (s = {}));
  return (s[key] ??= {});
}
