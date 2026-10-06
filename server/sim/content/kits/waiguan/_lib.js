// server/sim/content/kits/waiguan/_lib.js — shared helpers of the 外援 / 甄选 (DIY) kits (DESIGN §27, docs/WAIGUAN-KITS.md).
//
// One place for the helpers every waiguan/<charId>.js file uses, so 87 kits read their data the same way. Re-exports the
// tier-1 helpers (kits/tier1.js named exports) and adds the tier-5 / tier-6 conventions that were file-local there.

import { COLS } from '../../../constants.js';
import { hasHp } from '../../../damage.js';
import { aggregateMods } from '../../../buffs.js';
import { sortEnemyTargets } from '../../../targeting.js';

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

// ---- 部署费用下限 (DP floor) ledger: 可露希尔's 极限调度 lowers it, 老鲤's trait pays into it ------------------------------

/**
 * The battle's 部署费用下限 ledger (one per battle, bstate): `floor` = player id → how far below 0 that player's DP may go
 * when it is spent (0 when absent), `debt` = player id → the part below 0 that player owes. The engine clamps DP at 0
 * (Battle.addDp), so a pool below 0 is kept as debt: the player's real DP is `dp − debt`; the DP gained afterwards pays
 * the debt first (char_4228_closur.js installs that repayment). Kits that spend DP into the floor read it here.
 */
export function dpLedger(battle) {
  const L = bstate(battle, 'waiguan:costLowerBound');
  if (!L.floor) { L.floor = new Map(); L.debt = new Map(); }
  return L;
}

/**
 * Spend `n` DP of player `pid`: from the pool first, the rest as debt in the ledger (the caller has checked that the
 * floor allows it). Returns `{ fromDp, owed }` (both 0 for an unknown player or n ≤ 0).
 */
export function spendDp(battle, pid, n) {
  const ps = battle.getPlayer(pid);
  if (!ps || !(n > 0)) return { fromDp: 0, owed: 0 };
  const fromDp = Math.min(ps.dp, n);
  if (fromDp > 0) battle.addDp(pid, -fromDp);
  const owed = n - fromDp;
  if (owed > 1e-9) {
    const L = dpLedger(battle);
    L.debt.set(pid, (L.debt.get(pid) ?? 0) + owed);
  }
  return { fromDp, owed: owed > 1e-9 ? owed : 0 };
}

/**
 * "每N秒…" counted from each deployment (伊芙利特 莱茵回路 "每6秒额外回复2点技力"): `fn()` every `sec` s while `unit` stands on
 * the field. The count restarts at every (re)deployment and stops when the unit leaves (knock-out, retreat); a hidden
 * moment skips the call. (`whileOn` runs on the battle clock from the start instead, whatever the deployments.)
 */
export function everyDeployed(battle, unit, sec, fn) {
  if (!(sec > 0) || typeof fn !== 'function') return;
  battle.on('deploy', (c) => {
    if (c.unit !== unit) return;
    const seq = unit.deploySeq;
    const h = battle.every(sec, () => {
      if (!unit.alive || !unit.deployed || unit.removed || unit.deploySeq !== seq) { h.cancel(); return; }
      if (!unit.hidden) fn();
    }, { owner: unit });
  }, { owner: unit });
}

/**
 * "攻击范围内的敌人…" aura (伊芙利特 精神融解 "攻击范围内的敌军法术抗性-40%"): every `interval` s while `unit` is on the field,
 * each enemy a selector of `unit` may pick (Battle.enemiesInKeys: no 隐匿 / untargetable one — PRTS 隐匿 "无法被敌方的…Buff
 * 选择器选中"; flyers unless `groundOnly`) on `keys()` — default the unit's current range — gets the non-catalogue effect
 * `key` for `dur` s through Battle.applyStrongest (同名效果取最高: one instance per enemy whatever the number of sources;
 * `value` is its strength, `modsOf(value)` its mods). It lapses `dur` s after the enemy leaves those tiles or the unit
 * leaves the field. Returns the timer (null when there is nothing to apply).
 */
export function enemyAura(battle, unit, { key, value, modsOf, interval = 0.2, dur = 2 * interval + 0.05, keys = null, groundOnly = false }) {
  if (!key || !Number.isFinite(value) || !value || typeof modsOf !== 'function' || !(interval > 0)) return null;
  const prof = groundOnly ? { canHitFly: false, groundOnly: true } : ANY;
  return whileOn(battle, unit, interval, () => {
    for (const e of battle.enemiesInKeys(keys ? keys() : unit.rangeKeys, unit, prof)) {
      battle.applyStrongest(e, key, { duration: dur, value, mods: modsOf, source: unit });
    }
  });
}

/** 重量等级 of a unit (units.js `s.massLevel`: data massLevel + `massFlat` buffs, never below 0). */
export const massOf = (u) => n0(u?.s?.massLevel, 0);

/**
 * Every enemy `unit` could attack with profile `prof` right now, before the engine's target count: its current range
 * (`rangeKeys`) plus the enemies it blocks (ai.js acquireTargets), in the engine's order (targeting.js sortEnemyTargets:
 * blocked by `unit` → profile priority → taunt → least remaining path → earliest spawn). `blockedFirst: false` drops the
 * first step (a skill pick that is no attack selection, e.g. "向至多3个重量最重的敌人"). A new array.
 */
export function attackCandidates(battle, unit, prof = unit?.profile, { blockedFirst = true } = {}) {
  const list = battle.enemiesInKeys(unit.rangeKeys, unit, prof);
  if (unit.blocking && unit.blocking.length) for (const e of battle.blockedTargets(unit, prof)) if (!list.includes(e)) list.push(e);
  // (a stand-in attacker at its position blocks nobody: the engine's order without "blocked by me first")
  return sortEnemyTargets(battle, blockedFirst ? unit : { x: unit.x, y: unit.y }, list, prof?.priority ?? null);
}

/**
 * Stable re-sort (in place) of `list` (already in the engine's order, e.g. attackCandidates): the enemies `unit` blocks
 * first (unless `blockedFirst: false`), then ascending `key(e)`; ties keep the list's order. Returns `list`.
 */
export function sortTargetsBy(unit, list, key, { blockedFirst = true } = {}) {
  const k = new Map(list.map((e) => [e, [blockedFirst && e.blockedBy === unit ? 0 : 1, n0(key(e), 0)]]));
  return list.sort((a, b) => k.get(a)[0] - k.get(b)[0] || k.get(a)[1] - k.get(b)[1]);
}

/**
 * A target priority the engine has no key for (targeting.js PRIORITY_FNS — e.g. 攻城手 "优先攻击重量最重的敌人"): every
 * attack of `unit` (normal and skill attacks, `beforeAttack`) re-picks its targets from attackCandidates by ascending
 * `key(e)` after the blocked-first rule (sortTargetsBy), keeping the number of targets the engine chose. Left alone: heal
 * attacks, all-in-range / hit-all-blocked attacks, and targets a content forced from outside the candidates
 * (Battle.forceAttack with an explicit list). Returns the hook handle.
 */
export function preferTargets(battle, unit, key, { priority = 0 } = {}) {
  return battle.on('beforeAttack', (ctx) => {
    if (ctx.attacker !== unit || !ctx.targets.length || ctx.targets[0].side !== 'enemy') return;
    const prof = ctx.profile || unit.profile;
    if (!prof || prof.allInRange || (prof.hitAllBlocked && unit.blocking.length)) return;
    const cands = attackCandidates(battle, unit, prof);
    if (cands.length <= 1 || !ctx.targets.every((t) => cands.includes(t))) return;
    ctx.targets = sortTargetsBy(unit, cands, key).slice(0, ctx.targets.length);
  }, { owner: unit, priority });
}

/** 攻城手 trait "优先攻击重量最重的敌人": the heaviest (massOf) first — a `trait.install` (professions.js has no profile). */
export const heaviestFirst = (battle, unit) => preferTargets(battle, unit, (e) => -massOf(e));

/**
 * Members (charId) of the official factions that are a team or group (character_table `teamId` / `groupId`) — the chess
 * records carry only `nationId`. Source: ArknightsGameData zh_CN character_table.json. Add a faction when a kit needs it,
 * with every charId of it (pool and 外援), so the effect reaches all of them.
 */
export const FACTION_MEMBERS = Object.freeze({
  // 【乌萨斯学生自治团】 teamId 'student': 古米 (pool), 怒潮凛冬 / 早露 (外援); 凛冬, 烈夏, 苦艾, 真理 are not in this mode
  student: Object.freeze(['char_196_sunbr', 'char_115_headbr', 'char_194_leto', 'char_405_absin', 'char_195_glassb',
    'char_197_poca', 'char_1051_headb2']),
});
/** Is unit `u` of faction `id`: a FACTION_MEMBERS team / group, else a nationId ('ursus', 'rhodes', …)? */
export function inFaction(u, id) {
  const list = Object.hasOwn(FACTION_MEMBERS, id) ? FACTION_MEMBERS[id] : null;
  if (list) {
    const cid = u?.def?.charId ?? u?.def?.raw?.charId ?? null;
    return !!cid && list.includes(cid);
  }
  return (u?.def?.raw?.nationId ?? null) === id;
}

// ---- summons (summoner kits: 凯尔希's Mon3tr, 令's souls …) ------------------------------------------------------------

/** Token units of `owner` (only the ids of `tokenIds` — an id or a list — when given): live ones unless `all`. Board order. */
export function summonsOf(battle, owner, tokenIds = null, { all = false } = {}) {
  const ids = tokenIds == null ? null : new Set(Array.isArray(tokenIds) ? tokenIds : [tokenIds]);
  return battle.allyUnits.filter((t) => t.kind === 'token' && t.ownerUnit === owner && (!ids || ids.has(t.defId)) && (all || live(t)));
}

/**
 * A skill effect on the summoner's summons ("自身与召唤物攻击力+…", "Mon3tr的防御力+…"): while `owner`'s timed skill runs,
 * every live summon of it that `pick(t)` accepts carries buff `key` (`make(t)` → addBuff options: mods, flags, visible …);
 * one deployed while the skill runs gets it at once; all lose it when the skill ends, whatever the reason. Not persist:
 * a summon that leaves the field drops it. Install it only under the skill it belongs to. Hooks owned by `owner`.
 */
export function linkSummonBuff(battle, owner, key, pick, make) {
  const give = (t) => battle.addBuff(t, { ...make(t), key, source: owner });
  battle.on('skillStart', (c) => {
    if (c.unit !== owner || !c.skill.isTimed) return;
    for (const t of summonsOf(battle, owner)) if (pick(t)) give(t);
  }, { owner });
  battle.on('deploy', (c) => {
    const t = c.unit;
    if (!t || t.kind !== 'token' || t.ownerUnit !== owner || !pick(t)) return;
    const sk = owner.skill;
    if (sk && sk.active && sk.isTimed && live(owner)) give(t);
  }, { owner });
  battle.on('skillEnd', (c) => {
    if (c.unit !== owner) return;
    for (const t of summonsOf(battle, owner, null, { all: true })) battle.removeBuff(t, key);
  }, { owner });
}

/**
 * "攻击阻挡的所有敌人" for a unit whose profile lacks it (a summon's own trait, an owner skill's effect on its summon): while
 * `test(attacker)` holds, an attack of a unit that blocks enemies strikes every enemy it blocks — the engine's
 * hitAllBlocked rule (ai.js acquireTargets). Heal attacks are left alone. Hook owned by `owner`.
 */
export function hitAllBlocked(battle, owner, test) {
  return battle.on('beforeAttack', (c) => {
    const u = c.attacker;
    if (!u || !u.blocking || !u.blocking.length || !c.targets.length || c.targets[0].side !== 'enemy' || !test(u)) return;
    const prof = c.profile || u.profile;
    if (!prof || prof.dmgType === 'heal') return;
    const all = battle.blockedTargets(u, prof);
    if (all.length) c.targets = all;
  }, { owner, priority: 10 });
}

/**
 * Summon pieces that come back (PRTS 卫戍协议/帮助 §作战阶段 "若战场区初始部署有召唤物，若召唤物在战斗期间退场，将在满足条件后
 * 立即原地再部署1个"). Every token of `owner` that `pick(t)` accepts stays a board piece when it leaves the field for one of
 * `reasons` (its `removed` flag is reset, so its hooks survive), and redeploys on its own tile once `delay(t)` s have passed
 * (default: its data redeploy time × the redeploy multipliers) and `ready(t)` holds, only while `owner` stands on the field
 * [ASSUMED: a summon is deployed only while its summoner is, as in the base game] — paying its DP cost (`t.base.cost`, as
 * every redeploy in this mode does; Battle.redeploy refuses it while the player lacks the DP) unless `free`.
 * `onLeave(t, reason)` runs at each departure for one of `reasons` (return false: it stays off for good); `onBack(t)` after
 * each return. Polls every 0.25 s (owned by `owner`). The talent summons of tokens.js (enableRespawn) pay too; its docked
 * skill summons (releaseSkillSummon) come back free [ASSUMED there].
 */
export function returningSummons(battle, owner, { pick, reasons = ['killed'], delay = null, ready = null, free = false, onLeave = null, onBack = null }) {
  const why = new Set(reasons);
  const mine = (t) => !!t && t.kind === 'token' && t.ownerUnit === owner && pick(t);
  battle.on('death', (c) => {
    const t = c.unit;
    if (!mine(t) || battle.finished) return;
    t.mem.backAt = Infinity;
    if (!why.has(c.reason) || (onLeave && onLeave(t, c.reason) === false)) return;
    t.removed = false;
    const d = delay ? delay(t) : t.base.respawnTime * t.persist.redeployMul * t.s.redeployMul;
    t.mem.backAt = battle.time + Math.max(0, n0(d, 0));
  }, { owner, priority: -10 });
  whileOn(battle, owner, 0.25, () => {
    for (const t of battle.allyUnits) {
      if (!mine(t) || t.alive || t.removed || !(battle.time + 1e-9 >= (t.mem.backAt ?? Infinity))) continue;
      if (ready && !ready(t)) continue;
      if (!battle.redeploy(t, { free })) continue;
      battle.fx('summon', { x: t.x, y: t.y, id: t.id, token: t.defId });
      if (onBack) onBack(t);
    }
  });
}
