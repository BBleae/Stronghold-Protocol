// server/sim/content/genericTalents.js — generic talents for every chess (and summon) WITHOUT a hand-authored kit.
//
// Pure ESM shared with browsers (served at /sim/): it imports only engine modules, never server/data.js or content/support.
// Used by generic.js genericKit (operators without a kit — today the 外援 / 甄选 operators) and by content/index.js for
// summons without a token kit; a hand-authored kit authors its own talents and never runs this (it may reuse one talent
// with genericTalent(def, i)).
//
// Text decides the effect, the blackboard gives the numbers (the rule of generic.js for skills):
//   * Text sources: every talent of the def with a description — the def is resolved for the unit's loadout
//     (simdata getChess), so an elite's talents, its module's talent changes and its selected skill are the ones the
//     battle uses — plus the module's trait addition (`raw.trait.moduleDesc`, present while that module is equipped).
//     A talent entry without text (a hidden module part) is never applied on its own: its numbers serve the texts.
//   * Every number of an effect must be found in a blackboard (the talent's own, then the other talents', hidden module
//     parts', the trait's): |v| = N, |v| = N/100, a multiplier |v − 1| = N/100, else the closest within the text's
//     rounding (±0.5) — 嵯峨 "6%" = 0.065. No value ⇒ the effect is dropped (reported). Thresholds, timings and counts
//     of conditions may come from the text.
//   * Grammar: sentences (。；) → clauses (，). At each clause a specific rule (on-hit, SP, DP, shields …) is tried on
//     the rest of the sentence, else a condition prefix is read (state: HP / blocking / skill / enemies in range /
//     time on the field …; event: deploy / kill / hurt / skill start / heal …), then a scoped stat phrase (自身,
//     攻击范围内的友方单位, 相邻四格, 周围8格, 所有【职业】干员, 编入队伍时 …; enemies in range / blocked / around).
//     An UNRECOGNISED condition drops every clause it governs (never applied unconditionally); a clause that matches
//     nothing is dropped. talentCoverage(def) lists what was applied and what was dropped, and why.
//   * A clause whose subject is a summon (召唤物, 无人机, Mon3tr, a token name …) is not applied to the operator: the
//     summon side is content/tokens.js (generic summons) and the token's own talents.
//   * DP (owner requirement: real 部署费用 mechanics): "击杀敌人时额外获得N点部署费用" = battle.addDp; "下一名部署的干员费用-N"
//     lowers the next paid redeploy (base.cost, restored after it); "首次部署时部署费用-N" has no battle effect (the
//     initial deployment is free — as the pool kits, kits/tier1.js 嵯峨); a 行商 talent "特性消耗费用时…改为消耗N费用"
//     changes the trait payment (professions.js `merchantPay`).
// Every buff key starts with `gt:`; buffs are tagged 'talent'; hooks are owned by the unit; randomness only via
// battle.rng (determinism). [ASSUMED] choices are marked where they are made.
//
// Exports: genericTalentSpecs(def, { token }) → TalentSpec[] ({ id, pattern, source, install }), genericTalent(def, i),
// talentCoverage(def) → [{ source, text, patterns, dropped: [{ clause, reason }] }], parseTalentText (tests).

import { COLS } from '../constants.js';
import { absoluteRangeKeys } from '../targeting.js';
import { hasHp, isHpLoss } from '../damage.js';

/** A float without binary noise (0.19999999999999996 → 0.2): blackboard arithmetic is shown and compared. */
const clean = (v) => (Number.isFinite(v) ? Math.round(v * 1e9) / 1e9 : v);
const toNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : undefined));
const EPS = 1e-9;

// =================================================================================================================
// text

const N = '(\\d+(?:\\.\\d+)?)';
const CN_DIGITS = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
/** '3' / '三' → 3. */
export const cnNum = (s) => (s == null ? NaN : /^\d/.test(s) ? +s : CN_DIGITS[s] ?? NaN);

/** Normalised talent text: half-width signs and percent, no spaces, 攻速 → 攻击速度, ASCII brackets → full-width. */
export function normText(s) {
  return String(s ?? '')
    .replace(/％/g, '%').replace(/＋/g, '+').replace(/[－−]/g, '-').replace(/[～〜]/g, '~').replace(/\s+/g, '')
    .replace(/\(/g, '（').replace(/\)/g, '）').replace(/,/g, '，').replace(/;/g, '；').replace(/攻速/g, '攻击速度')
    .replace(/[“”"]/g, '');
}

/** Sentences of a text (。；), without empty ones. */
function sentences(text) {
  return normText(text).split(/[。；]/).map((s) => s.trim()).filter(Boolean);
}

// =================================================================================================================
// blackboard values

/**
 * Value lookup over blackboards in search order. `pct(n)` → the fraction of "n%" (|v| = n/100, a multiplier |v − 1| =
 * n/100, else the closest |v| within the text's rounding), `flat(n)` → |v| = n (else within ±0.5 for n ≥ 2), `key(k)`.
 * Undefined when nothing matches (the caller drops the effect).
 */
export function valueIndex(bbs) {
  const vals = [];
  for (const bb of bbs) if (bb && typeof bb === 'object') for (const [k, v] of Object.entries(bb)) { const n = toNum(v); if (n !== undefined) vals.push({ k, v: n }); }
  const exact = (pred) => vals.find(pred);
  return {
    vals,
    pct(n) {
      if (!Number.isFinite(n)) return undefined;
      const t = n / 100;
      let e = exact(({ v }) => Math.abs(Math.abs(v) - t) < 1e-7);
      if (e) return Math.abs(e.v);
      e = exact(({ v }) => v > 0 && Math.abs(Math.abs(v - 1) - t) < 1e-7);
      if (e) return clean(Math.abs(e.v - 1));
      let best = null;
      for (const x of vals) {
        const d = Math.abs(Math.abs(x.v) * 100 - n);
        if (d <= 0.5 + EPS && (!best || d < best.d)) best = { d, v: Math.abs(x.v) };
      }
      return best ? best.v : undefined;
    },
    flat(n) {
      if (!Number.isFinite(n)) return undefined;
      const e = exact(({ v }) => Math.abs(Math.abs(v) - n) < 1e-7);
      if (e) return Math.abs(e.v);
      if (n < 2) return undefined;
      let best = null;
      for (const x of vals) { const d = Math.abs(Math.abs(x.v) - n); if (d <= 0.5 + EPS && (!best || d < best.d)) best = { d, v: Math.abs(x.v) }; }
      return best ? best.v : undefined;
    },
    key(k) { const e = vals.find((x) => x.k === k); return e ? e.v : undefined; },
    /** First value whose key matches `re`. */
    keyLike(re) { const e = vals.find((x) => re.test(x.k)); return e ? e.v : undefined; },
  };
}

// =================================================================================================================
// small engine helpers (local copies: generic must not depend on a kit file)

const up = (u) => !!u && u.alive && u.deployed;
const isOp = (a) => !!a && a.kind === 'op';
const tileKey = (u) => u.tileR * COLS + u.tileC;
const cheb = (a, b) => Math.max(Math.abs(Math.round(a.y) - Math.round(b.y)), Math.abs(Math.round(a.x) - Math.round(b.x)));
const manh = (a, b) => Math.abs(Math.round(a.y) - Math.round(b.y)) + Math.abs(Math.round(a.x) - Math.round(b.x));
const isMainHit = (dmg) => !!dmg && dmg.isAttack && !dmg.isSplash && !(dmg.tags && dmg.tags.includes('chain'));
const skillBusy = (u) => !!(u.skill && u.skill.active && u.skill.isTimed);
/** Give SP (no gain while a timed skill runs — the engine rule kits follow). */
function giveSp(u, n, reason = 'talent') {
  if (!u || !u.skill || u.skill.noSkill || skillBusy(u) || !(n > 0)) return 0;
  return u.skill.gainSp(n, reason);
}
const N4 = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]]);
const RING8 = Object.freeze([[1, -1], [1, 0], [1, 1], [0, -1], [0, 1], [-1, -1], [-1, 0], [-1, 1]]);
const BEHIND = Object.freeze([[0, -1]]);
const FRONT = Object.freeze([[0, 1]]);
const keysAround = (u, grid) => new Set(absoluteRangeKeys(grid, u.tileR, u.tileC, u.dir, 0));
const rangeSet = (u) => u.rangeKeySet || new Set(u.rangeKeys || []);
const enemiesInRange = (battle, u, opts = {}) => battle.enemiesInKeys(u.rangeKeys, u, { canHitFly: true, ...opts });
const isElite = (e) => !!e && (e.isBoss || e.def?.rank === 'ELITE' || e.def?.rank === 'BOSS');
const isRangedEnemy = (e) => !!e && (e.def?.applyWay === 'RANGED' || (e.def?.rangeRadius ?? 0) > 0.8);
const burstOn = (e, el = null) => !!e && e.buffs.some((b) => b.flags && b.flags.burstLock && (!el || b.key === `${el}Burst`));
const PROF = Object.freeze({ 先锋: 'PIONEER', 近卫: 'WARRIOR', 重装: 'TANK', 狙击: 'SNIPER', 术师: 'CASTER', 医疗: 'MEDIC', 辅助: 'SUPPORT', 特种: 'SPECIAL' });
/**
 * Nation-level factions a talent may name (【罗德岛】 …) → chess `nationId`. Group / team factions (莱茵生命, 乌萨斯学生自治团,
 * 深海猎人, 莱欧斯小队, 岁, Ave Mujica …) have no id in the chess data: an effect scoped to one is dropped (reported).
 * [ASSUMED] a unit belongs to a nation through its own nationId only (sub-powers ignored), as the pool kits' nationOf.
 */
const NATIONS = Object.freeze({
  罗德岛: 'rhodes', 米诺斯: 'minos', 卡西米尔: 'kazimierz', 拉特兰: 'laterano', 叙拉古: 'siracusa', 谢拉格: 'kjerag', 萨尔贡: 'sargon',
  维多利亚: 'victoria', 炎: 'yan', 乌萨斯: 'ursus', 莱塔尼亚: 'leithanien', 哥伦比亚: 'columbia', 伊比利亚: 'iberia', 东: 'higashi',
  龙门: 'lungmen', 萨米: 'sami', 雷姆必拓: 'rim', 阿戈尔: 'egir', 玻利瓦尔: 'bolivar', 莱塔: 'leithanien',
});
const ELEMENTS = Object.freeze({ 神经: 'neural', 灼燃: 'burn', 凋亡: 'apoptosis', 侵蚀: 'erosion' });
const STATUS_WORDS = Object.freeze({ 晕眩: 'stun', 停顿: 'sluggish', 束缚: 'bind', 特殊能力失效: 'silence', 沉默: 'silence', 冻结: 'freeze', 寒冷: 'cold', 战栗: 'tremble', 浮空: 'levitate' });
const dmgTypeOf = (w) => (w === '法术' ? 'arts' : w === '真实' ? 'true' : 'phys');

/** Strongest-wins value of a mods object (aura de-duplication). */
function modsValue(m) {
  let v = 0;
  for (const [k, x] of Object.entries(m || {})) v += k.endsWith('Mul') ? Math.abs(x - 1) : Math.abs(x);
  return v;
}

/** Scale the bonus of `mods` by k (doubling): additive × k, multiplicative bonus (v − 1) × k. */
function scaleMods(mods, k) {
  const out = {};
  for (const [key, v] of Object.entries(mods)) out[key] = clean(key.endsWith('Mul') ? 1 + (v - 1) * k : v * k);
  return out;
}

// =================================================================================================================
// installers

/** A buff key unique to the talent effect (shared by copies of the same chess for auras: strongest wins). */
const effKey = (P, j) => `gt:${P.keyBase}:${P.srcTag}:${j}`;

/** Permanent self buff (survives death and redeploy). */
function selfStat(battle, unit, key, mods, extra = {}) {
  if (!Object.keys(mods).length && !extra.status) return;
  battle.addBuff(unit, { key, mods, persist: true, allowDead: true, tags: ['talent'], ...extra });
}

/** Keep buff `key` on `unit` while `test()` holds (checked every tick, at the start and on its deployment). */
function toggle(battle, unit, key, test, mods, extra = {}) {
  const check = () => {
    const want = up(unit) && !!test();
    const has = unit.findBuff(key);
    if (want && !has) battle.addBuff(unit, { key, mods: typeof mods === 'function' ? mods() : mods, tags: ['talent'], ...extra });
    else if (!want && has) battle.removeBuff(unit, key);
    else if (want && has && typeof mods === 'function') { has.mods = mods(); unit.markDirty(); }
  };
  battle.on('tick', check, { owner: unit });
  battle.on('battleStart', check, { owner: unit });
  battle.on('deploy', (ctx) => { if (ctx.unit === unit && battle.started) check(); }, { owner: unit });
}

/**
 * Buff aura while `src` is deployed (and `test()` holds): every 0.5 s the allies `select(a)` accepts get `key` for 0.6 s.
 * Several sources of the same aura never stack: the strongest wins (installAura semantics, kits/tier1.js).
 */
function allyAura(battle, src, { key, select, mods, test = null, extra = {} }) {
  const iv = 0.5;
  battle.every(iv, () => {
    if (!up(src) || (test && !test())) return;
    for (const a of battle.alliesFor(src)) {
      if (!select(a)) continue;
      const m = typeof mods === 'function' ? mods(a) : mods;
      if (!m) continue;
      const value = modsValue(m) + (extra.data?.v ?? 0);
      const cur = a.findBuff(key);
      if (cur && cur.source !== src && (cur.data?.v ?? 0) > value + EPS && cur.timeLeft > 0.05) continue;
      battle.addBuff(a, { key, duration: iv + 0.1, mods: m, source: src, tags: ['talent', 'aura'], ...extra, data: { ...(extra.data || {}), v: value } });
    }
  }, { owner: src, immediate: true });
}

/** Debuff aura on enemies while `src` is deployed: every 0.5 s, `pick()` enemies get `key` for 0.6 s. */
function enemyAura(battle, src, { key, pick, mods, test = null, filter = null }) {
  battle.every(0.5, () => {
    if (!up(src) || (test && !test())) return;
    for (const e of pick()) {
      if (!e.alive || (filter && !filter(e))) continue;
      battle.addBuff(e, { key, duration: 0.6, mods: typeof mods === 'function' ? mods(e) : mods, refresh: 'extend', source: src, tags: ['talent', 'aura'] });
    }
  }, { owner: src, immediate: true });
}

// =================================================================================================================
// conditions (state: (battle, unit) => bool; event: { event, … })

const STATE = (label, test, extra = {}) => ({ kind: 'state', label, test, ...extra });
const EVENT = (event, label, opts = {}) => ({ kind: 'event', event, label, ...opts });

/**
 * Read a condition prefix of clause `c`. Returns { cond, rest } (rest = the clause after the prefix), { unknown, rest }
 * for a condition-like prefix this file does not know, or null when the clause starts with no condition.
 */
function parseCond(c, P) {
  const V = P.values;
  const pctOrHalf = (s) => (s === '一半' ? 0.5 : (V.pct(+s) ?? +s / 100));
  const R = [
    // ---- state
    [/^(?:当|在)?(?:自身)?生命(?:值)?(高于|大于|不低于|在)(\d+(?:\.\d+)?%|一半)(?:以上)?(?:时)?，?/, (m) => {
      const r = pctOrHalf(m[2].replace('%', ''));
      return STATE(`生命>${r}`, (b, u) => (m[1] === '不低于' ? u.hpRatio >= r - EPS : u.hpRatio > r + EPS));
    }],
    [/^(?:当|在)?(?:自身)?生命(?:值)?(低于|不高于|小于|少于)(\d+(?:\.\d+)?%|一半)(?:时)?，?/, (m) => {
      const r = pctOrHalf(m[2].replace('%', ''));
      return STATE(`生命<${r}`, (b, u) => (m[1] === '不高于' ? u.hpRatio <= r + EPS : u.hpRatio < r - EPS));
    }],
    [/^(?:当)?(?:自身)?(?:未|没有)阻挡(?:敌人)?时，?/, () => STATE('未阻挡', (b, u) => u.blocking.length === 0)],
    [/^(?:当)?(?:自身|[^\s，]{1,6}?)?阻挡(?:敌人|目标)?时，?/, () => STATE('阻挡', (b, u) => u.blocking.length > 0, { blockedScope: true })],
    [/^(?:技能(?:持续)?期间外|技能未开启时)，?/, () => STATE('技能外', (b, u) => !u.skill?.active)],
    [/^技能(?:持续)?期间及技能结束后的(\d+(?:\.\d+)?)秒内，?/, (m) => {
      const t = V.flat(+m[1]) ?? +m[1];
      return STATE(`技能中+${t}s`, (b, u) => !!u.skill?.active || b.time - (u.mem.gtSkillEndAt ?? -Infinity) <= t + EPS, {
        install(b, u) { b.on('skillEnd', (c) => { if (c.unit === u && c.reason !== 'death') u.mem.gtSkillEndAt = b.time; }, { owner: u }); },
      });
    }],
    [/^技能(?:持续)?期间，?/, () => STATE('技能中', (b, u) => !!u.skill?.active)],
    [/^(?:在(?:战场|场上)?停留)?(\d+(?:\.\d+)?)秒后，?/, (m) => { const t = +m[1]; return STATE(`停留${t}s`, (b, u) => b.time - u.deployedAt >= t - EPS); }],
    [/^部署后第(\d+|[一二三四五])次开启技能之前，?/, (m) => {
      const n = cnNum(m[1]);
      return STATE(`第${n}次技能前`, (b, u) => (u.skill?.activations ?? 0) - (u.mem.gtAct0 ?? 0) < n, {
        install(b, u) { b.on('deploy', (c) => { if (c.unit === u) u.mem.gtAct0 = u.skill?.activations ?? 0; }, { owner: u, priority: 50 }); },
      });
    }],
    [/^(?:当)?(?:攻击)?范围内存在(地面)?敌人时，?/, (m) => STATE('范围内有敌人', (b, u) => enemiesInRange(b, u, m[1] ? { canHitFly: false } : {}).some((e) => !m[1] || !e.isFlying))],
    [/^(?:当)?攻击范围内存在(\d+|[一二三四五])名及以上敌人时，?/, (m) => { const n = cnNum(m[1]); return STATE(`范围内≥${n}敌`, (b, u) => enemiesInRange(b, u).length >= n); }],
    [/^(?:当)?攻击范围内存在精英或领袖敌人时，?/, () => STATE('范围内精英', (b, u) => enemiesInRange(b, u).some(isElite))],
    [new RegExp(`^(?:当)?攻击范围内存在${TGT}时，?`), (m) => {
      const tc = targetCond(m[1], V);
      return tc ? STATE(`范围内有${tc.label}`, (b, u) => enemiesInRange(b, u).some((e) => tc.test(b, u, e))) : null;
    }],
    [/^(?:当)?攻击范围内(?:至少)?(?:有|存在)(\d+|[一二三四五])名(?:及以上)?(?:其他)?友方干员时，?/, (m) => {
      const n = cnNum(m[1]);
      return STATE(`范围内≥${n}友方`, (b, u) => b.allies(null).filter((a) => a !== u && isOp(a) && rangeSet(u).has(tileKey(a))).length >= n);
    }],
    [/^(?:当)?周围(四|4|八|8)格(?:内)?没有(?:其他)?友方(单位|干员)时，?/, (m) => {
      const ring = m[1] === '八' || m[1] === '8', ops = m[2] === '干员';
      return STATE(`周围${ring ? 8 : 4}格无友方`, (b, u) => !b.allies(null).some((a) => a !== u && a.kind !== 'device' && (!ops || isOp(a)) && (ring ? cheb(a, u) <= 1 : manh(a, u) === 1)));
    }],
    [/^(?:当)?周围(四|4|八|8)格内仅存在一(?:名|个)敌人时，?/, (m) => {
      const ring = m[1] === '八' || m[1] === '8';
      return STATE('周围仅一敌', (b, u) => b.foesInRadius(u.x, u.y, ring ? 1.5 : 1.01).length === 1);
    }],
    [/^(?:如果)?(\d+(?:\.\d+)?)秒内没有主动攻击过，?/, (m) => { const t = +m[1]; return STATE(`${t}s未攻击`, (b, u) => b.time - u.lastAttackAt >= t - EPS); }],
    [/^(?:自身)?未进行攻击时，?/, () => { const t = V.key('delay') ?? 0; return STATE(`${t}s未攻击`, (b, u) => b.time - u.lastAttackAt >= t - EPS); }],
    [/^(?:最近(\d+(?:\.\d+)?)秒内)?未受(?:到)?(?:伤害|攻击)时，?/, (m) => { const t = m[1] ? +m[1] : (V.key('delay') ?? 0); return STATE(`${t}s未受伤`, (b, u) => b.time - u.lastHitAt >= Math.max(t, TICK_MIN) - EPS); }],
    [/^场上有【海怪】敌人时，?/, () => STATE('场上有海怪', (b) => b.enemies.some((e) => e.alive && (e.def?.tags || []).includes('seamonster')))],
    [/^达到最大加成时，?/, () => { const r = V.key('min_hp_ratio') ?? 0.3; return STATE('坚忍满', (b, u) => u.hpRatio <= r + EPS); }],
    [/^(场上存在|携带)[^，]+?和另外至少一名【(先锋|近卫|重装|狙击|术师|医疗|辅助|特种)】干员时，?/, (m) => {
      const prof = PROF[m[2]];
      const team = m[1] === '携带';
      return STATE(`另有${m[2]}`, (b, u) => (team ? b.allyUnits.filter((a) => isOp(a) && a.ownerId === u.ownerId) : b.allies(u.ownerId)).some((a) => a !== u && isOp(a) && a.def?.profession === prof), { team });
    }],
    // ---- events
    [/^受到伤害后，?/, () => EVENT('hurt', '受伤后')],
    [/^(?:每次)?受到(?:敌人的)?攻击时，?/, () => EVENT('attacked', '受击时')],
    [/^(?:每)?(?:击杀|击倒)(?:一名)?敌人时，?/, () => EVENT('kill', '击杀时')],
    [/^首次部署(?:时|后)，?/, () => EVENT('deploy', '首次部署', { first: true })],
    [/^(?:自身(?:和|与|及)[^，]{1,8}?)?(?:部署后(?:立即)?|部署时|置入战场后)，?/, () => EVENT('deploy', '部署时')],
    [/^(?:开启技能时|技能开启时)，?/, () => EVENT('skillStart', '开启技能时')],
    [/^(?:每次)?(?:治疗|回复)(?:目标|干员|友方单位)(?:生命值)?时，?/, () => EVENT('heal', '治疗时')],
    [/^每层护盾破裂时，?/, () => EVENT('shieldBreak', '护盾破裂时')],
    [/^周围(?:四|4)格内有敌人倒下时，?/, () => EVENT('enemyDownN4', '周围敌人倒下')],
    [/^周围(?:八|8)格内有敌人倒下时，?/, () => EVENT('enemyDownRing', '周围敌人倒下')],
    [/^攻击范围内的友方干员被击倒时，?/, () => EVENT('allyDownInRange', '范围内友方被击倒')],
    [/^(?:在场时)?每(\d+(?:\.\d+)?)秒，?/, (m) => EVENT('periodic', `每${m[1]}s`, { interval: V.flat(+m[1]) ?? +m[1] })],
    // ---- scope markers (whole battle / while deployed) — not conditions
    [/^(?:编入队伍时|携带[^，]{0,8}?时|上阵时)，?/, () => ({ kind: 'team', label: '编入队伍' })],
    [/^(?:在场时|在战场时)，?/, () => ({ kind: 'onField', label: '在场时' })],
  ];
  for (const [re, f] of R) {
    const m = c.match(re);
    if (!m) continue;
    const cond = f(m);
    if (cond) return { cond, rest: c.slice(m[0].length) };
  }
  // a condition-like prefix this file does not know: "…时，" / "…后，" / 若… / 当… / 如果…
  const unk = c.match(/^在(?:【[^】]+】|集成战略|生息演算|保全派驻|引航者试炼)中/) || c.match(/^(?:若|当|如果)[^，]*?(?:时|则|，|$)|^[^，]{2,30}?(?:时|后|期间|之前)(?=，|$)/);
  if (unk && !/^(?:攻击|每次攻击)时$/.test(unk[0])) return { unknown: true, label: unk[0], rest: c.slice(unk[0].length).replace(/^，|^则/, '') };
  return null;
}
const TICK_MIN = 1 / 30;

// =================================================================================================================
// scopes and stat phrases

const STAT_WORDS_RE = '攻击力|防御力|生命上限|最大生命值|最大生命|生命值|攻击速度|法术抗性|阻挡数|技力(?:自然)?(?:回复|恢复)速度|移动速度';
const STAT_RE = `(${STAT_WORDS_RE})`;
const STAT_NC = `(?:${STAT_WORDS_RE})`;
const statKind = (w) => (w === '攻击力' ? 'atk' : w === '防御力' ? 'def' : /生命/.test(w) ? 'hp' : w === '攻击速度' ? 'aspd'
  : w === '法术抗性' ? 'res' : w === '阻挡数' ? 'block' : /技力/.test(w) ? 'sp' : w === '移动速度' ? 'move' : null);

/** Mods of one stat change: `sign` ±1, `n` the text number, `pct` whether it reads "%". Undefined = no blackboard value. */
function statMods(kind, sign, n, pct, V) {
  const v = pct ? V.pct(n) : V.flat(n);
  if (v === undefined) return undefined;
  const s = sign * v;
  switch (kind) {
    case 'atk': return pct ? { atkPct: s } : { atkFlat: s };
    case 'def': return pct ? { defPct: s } : { defFlat: s };
    case 'hp': return pct ? { hpPct: s } : { hpFlat: s };
    case 'aspd': return pct ? undefined : { aspd: s };
    case 'res': return pct ? { resMul: clean(Math.max(0, 1 + s)) } : { resFlat: s };
    case 'block': return pct ? undefined : { blockCnt: s };
    case 'sp': return pct ? undefined : { spRecoveryFlat: s };
    case 'move': return pct ? { moveMul: clean(Math.max(0, 1 + s)) } : undefined;
    default: return undefined;
  }
}
const addMods = (a, b) => { for (const [k, v] of Object.entries(b)) a[k] = k.endsWith('Mul') ? (a[k] ?? 1) * v : (a[k] ?? 0) + v; return a; };

/**
 * One stat phrase → { mods, extra } (extra: buff fields such as the 抵抗 status) or undefined. Recognised:
 * "STAT(和STAT)*(各)?(额外)?±N(%)?(/秒)?", "STAT提升/降低N%", "获得N%的(物理|法术)?(和法术)?闪避", "(物理|法术)闪避+N%",
 * "获得N%的庇护", "无视…N点法术抗性/防御力", "受到的治疗量/效果+N%", "受到的(物理和法术)?伤害-N%", "造成的(物理|法术)?伤害
 * +N%", "受到的元素损伤降低N%", "每秒回复N生命 / N%的最大生命", "不容易成为敌人的攻击目标", "更容易受到攻击", "获得抵抗", "失重".
 */
function statPhrase(p, V, ST = null) {
  let m = p.match(new RegExp(`^(?:自身(?:的)?)?${STAT_RE}((?:(?:和|与|、|及)${STAT_NC})*)(?:各)?(?:额外)?(?:([+-])${N}(%)?(?:\\/秒)?|(提升|提高|增加|下降|降低|减少)${N}(%)?(?:\\/秒)?)$`));
  if (m) {
    const words = [m[1], ...[...(m[2] || '').matchAll(new RegExp(STAT_RE, 'g'))].map((x) => x[1])];
    const sign = m[3] ? (m[3] === '-' ? -1 : 1) : (/下降|降低|减少/.test(m[6]) ? -1 : 1);
    const n = +(m[4] ?? m[7]);
    const pct = !!(m[5] ?? m[8]);
    const mods = {};
    for (const w of words) {
      const x = statMods(statKind(w), sign, n, pct, V);
      if (!x) return undefined;
      addMods(mods, x);
    }
    return { mods };
  }
  if ((m = p.match(new RegExp(`^获得${N}%的?(物理|法术)?(?:(?:和|与)(法术))?闪避$`)))) {
    const v = V.pct(+m[1]);
    if (v === undefined) return undefined;
    const both = !m[2] || m[3];
    return { mods: m[2] === '法术' && !m[3] ? { dodgeArts: v } : both ? { dodgePhys: v, dodgeArts: v } : { dodgePhys: v } };
  }
  if ((m = p.match(new RegExp(`^(物理|法术)闪避\\+${N}%$`)))) {
    const v = V.pct(+m[2]);
    return v === undefined ? undefined : { mods: m[1] === '物理' ? { dodgePhys: v } : { dodgeArts: v } };
  }
  if ((m = p.match(new RegExp(`^(?:获得)?${N}%的?庇护$`)))) {
    const v = V.pct(+m[1]);
    return v === undefined ? undefined : { mods: { physTakenMul: 1 - v, artsTakenMul: 1 - v } };
  }
  if ((m = p.match(new RegExp(`^(?:攻击(?:时)?)?无视(?:敌人|目标|敌方)?(?:的)?${N}(?:点)?(?:的)?法术抗性$`)))) {
    const v = V.flat(+m[1]);
    return v === undefined ? undefined : { mods: { resIgnoreFlat: v } };
  }
  if ((m = p.match(new RegExp(`^(?:攻击(?:时)?)?无视(?:敌人|目标|敌方)?(?:的)?${N}(?:点)?(?:的)?防御力$`)))) {
    const v = V.flat(+m[1]);
    return v === undefined ? undefined : { mods: { defIgnoreFlat: v } };
  }
  if ((m = p.match(new RegExp(`^(?:自身)?受到的治疗(?:量|效果)(?:\\+|提升|提高)${N}%$`)))) {
    const v = V.pct(+m[1]);
    return v === undefined ? undefined : { mods: { healingTakenMul: 1 + v } };
  }
  if ((m = p.match(new RegExp(`^(?:自身)?受到的(物理和法术|物理与法术|物理|法术|所有)?伤害(?:-|降低|减少)${N}%$`)))) {
    const v = V.pct(+m[2]);
    if (v === undefined) return undefined;
    const w = m[1] || '';
    return { mods: /物理/.test(w) && /法术/.test(w) ? { physTakenMul: 1 - v, artsTakenMul: 1 - v } : w === '物理' ? { physTakenMul: 1 - v } : w === '法术' ? { artsTakenMul: 1 - v } : { dmgTakenMul: 1 - v } };
  }
  if ((m = p.match(new RegExp(`^(?:自身)?造成的(物理|法术)?伤害(?:\\+|提升|提高)${N}%$`)))) {
    const v = V.pct(+m[2]);
    if (v === undefined) return undefined;
    return { mods: m[1] === '物理' ? { physDealtMul: 1 + v } : m[1] === '法术' ? { artsDealtMul: 1 + v } : { dmgDealtMul: 1 + v } };
  }
  if ((m = p.match(new RegExp(`^(?:[^，]{0,6}?)受到的元素损伤(?:降低|-)${N}%$`)))) {
    const v = V.pct(+m[1]);
    return v === undefined ? undefined : { mods: { elemTakenMul: 1 - v } };
  }
  if ((m = p.match(new RegExp(`^每秒(?:回复|恢复)${N}(?:点)?生命(?:值)?$`)))) {
    const v = V.flat(+m[1]);
    return v === undefined ? undefined : { mods: { hpRegen: v } };
  }
  if ((m = p.match(new RegExp(`^每秒(?:回复|恢复)(?:(?:最大生命(?:值)?|生命上限)${N}%的?(?:生命(?:值)?)?|${N}%的?(?:最大生命(?:值)?|生命上限))$`)))) {
    const v = V.pct(+(m[1] ?? m[2]));
    return v === undefined ? undefined : { mods: { hpRegenRatio: v } };
  }
  if (/^(?:且)?不容易(?:成为敌人的(?:攻击)?目标|受到(?:敌人)?攻击)$/.test(p)) {
    const v = V.key('taunt_level');
    return { mods: { taunt: v !== undefined && v < 0 ? v : -1 } };
  }
  if (/^(?:且|并且)?更容易(?:受到(?:敌人的)?(?:攻击|伤害)|吸引敌人的攻击)$/.test(p)) {
    // a summon whose data already holds the higher 嘲讽等级 (夜莺's 幻影 tauntLevel 1) restates it
    if (ST && ST.tauntLevel > 0) return { mods: {} };
    const v = V.key('taunt_level');
    return { mods: { taunt: v !== undefined && v > 0 ? v : 1 } };
  }
  // "拥有75法术抗性" (a summon's text restating its own data RES): only what the data lacks
  if ((m = p.match(new RegExp(`^拥有${N}(?:点)?法术抗性$`)))) {
    const n = +m[1];
    return { mods: ST && ST.res >= n - EPS ? {} : { resFlat: n - (ST?.res ?? 0) } };
  }
  if ((m = p.match(new RegExp(`^(?:拥有)?${N}%的(物理|法术)闪避$`)))) {
    const v = V.pct(+m[1]);
    return v === undefined ? undefined : { mods: m[2] === '物理' ? { dodgePhys: v } : { dodgeArts: v } };
  }
  if (/^获得抵抗$/.test(p)) {
    const r = V.keyLike(/one_minus_status_resistance$/);
    const value = r !== undefined ? Math.min(0.95, Math.abs(r)) : 0.5;
    return { mods: {}, extra: { status: 'resist', visible: true, data: { value } } };
  }
  if ((m = p.match(new RegExp(`^(?:受到|获得)${N}%的(法术|物理)?脆弱(?:效果)?$`)))) {
    const v = V.pct(+m[1]);
    return v === undefined ? undefined : { mods: m[2] === '法术' ? { artsTakenMul: 1 + v } : m[2] === '物理' ? { physTakenMul: 1 + v } : { dmgTakenMul: 1 + v } };
  }
  if ((m = p.match(new RegExp(`^攻击距离\\+${N}(?:（[^）]*）)?$`)))) {
    const v = V.flat(+m[1]);
    return v === undefined ? undefined : { mods: { rangeExtend: v } };
  }
  if (/^失重$/.test(p)) return { mods: { massFlat: -1 } };
  return undefined;
}

/** A phrase list joined by 且 / 并 / 和 / ， → merged { mods, extra } (every part must parse), else undefined. */
function statPhrases(p, V, ST = null) {
  const one = statPhrase(p, V, ST);
  if (one) return one;
  for (const sep of ['且', '并且', '并', '以及', '和', '，']) {
    let at = p.indexOf(sep);
    while (at > 0) {
      const a = statPhrases(p.slice(0, at), V, ST), b = a && statPhrases(p.slice(at + sep.length), V, ST);
      if (a && b) return { mods: addMods({ ...a.mods }, b.mods), extra: { ...(a.extra || {}), ...(b.extra || {}) } };
      at = p.indexOf(sep, at + 1);
    }
  }
  return undefined;
}

/**
 * Scope prefix of a clause → { scope, rest }. Scopes: { kind: 'self' } · { kind: 'allies', self, select(battle, src,
 * a), team } (team = 编入队伍 / 携带: every operator of the player, the whole battle) · { kind: 'enemies', pick(battle,
 * src) }. Null: no scope prefix (the inherited one applies).
 */
function parseScope(c) {
  const R = [
    [/^(?:使)?自身(?:与|和|及)身后一格的友(?:军|方(?:单位|干员)?)/, () => ({ kind: 'allies', self: true, label: '自身+身后一格', select: (b, s, a) => keysAround(s, BEHIND).has(tileKey(a)) })],
    [/^(?:使)?自身(?:与|和|及)周围(?:8|八)格(?:内)?(?:的)?友方(?:干员|单位)/, () => ({ kind: 'allies', self: true, label: '自身+周围8格', select: (b, s, a) => keysAround(s, RING8).has(tileKey(a)) })],
    [/^(?:使)?自身(?:及|与|和)相邻(?:四|4)格的【(\S+?)】(?:职业)?干员/, (m) => ({ kind: 'allies', self: true, label: `自身+相邻${m[1]}`, select: (b, s, a) => isOp(a) && keysAround(s, N4).has(tileKey(a)) && classOk(a, m[1]) })],
    [/^(?:使)?(?:前方|身前一格)(?:的)?(?:友方)?干员(?:的)?/, () => ({ kind: 'allies', self: false, label: '前方干员', select: (b, s, a) => isOp(a) && keysAround(s, FRONT).has(tileKey(a)) })],
    [/^(?:使)?身后一格(?:的)?友方(?:干员|单位)(?:的)?/, () => ({ kind: 'allies', self: false, label: '身后一格', select: (b, s, a) => keysAround(s, BEHIND).has(tileKey(a)) })],
    [/^(?:使)?(?:相邻|周围(?:四|4)格)(?:四格)?的?(?:友方)?干员/, () => ({ kind: 'allies', self: false, label: '相邻干员', select: (b, s, a) => isOp(a) && keysAround(s, N4).has(tileKey(a)) })],
    [/^(?:使)?(?:相邻|周围(?:四|4)格)(?:四格)?的?友方单位/, () => ({ kind: 'allies', self: false, label: '相邻单位', select: (b, s, a) => keysAround(s, N4).has(tileKey(a)) })],
    [/^(?:\S{0,3}?)周围(?:8|八)格(?:内)?的(近战)?(?:友方)?(干员|单位)/, (m) => ({ kind: 'allies', self: false, geom: 'ring', label: '周围8格', select: (b, s, a) => (m[2] === '单位' || isOp(a)) && keysAround(s, RING8).has(tileKey(a)) && (!m[1] || a.def?.position === 'MELEE') })],
    [/^(?:使)?攻击范围内(?:的)?(?:所有)?(友方单位|友方干员|友军|干员|友方角色|友方)(?:的)?/, (m) => ({ kind: 'allies', self: true, geom: 'range', label: '范围内友方', select: (b, s, a) => (!/干员/.test(m[1]) || isOp(a)) && rangeSet(s).has(tileKey(a)) })],
    [/^所有(?:友方)?【(先锋|近卫|重装|狙击|术师|医疗|辅助|特种)】(?:职业)?干员(?:的)?/, (m) => ({ kind: 'allies', self: true, label: `所有${m[1]}`, select: (b, s, a) => isOp(a) && a.def?.profession === PROF[m[1]] })],
    [/^所有(先锋|近卫|重装|狙击|术师|医疗|辅助|特种)干员(?:的)?/, (m) => ({ kind: 'allies', self: true, label: `所有${m[1]}`, select: (b, s, a) => isOp(a) && a.def?.profession === PROF[m[1]] })],
    [/^所有【([^】]+)】干员(?:的)?/, (m) => {
      const nat = NATIONS[m[1]];
      if (!nat) return { unknownFaction: m[1] };
      return { kind: 'allies', self: true, label: `所有${m[1]}`, select: (b, s, a) => isOp(a) && a.def?.raw?.nationId === nat };
    }],
    [/^【([^】]+)】(?:职业)?干员(?:的)?/, (m) => {
      if (PROF[m[1]]) return { kind: 'allies', self: true, label: m[1], select: (b, s, a) => isOp(a) && a.def?.profession === PROF[m[1]] };
      const nat = NATIONS[m[1]];
      if (!nat) return { unknownFaction: m[1] };
      return { kind: 'allies', self: true, label: m[1], select: (b, s, a) => isOp(a) && a.def?.raw?.nationId === nat };
    }],
    [/^(?:所有)?敌方单位(?:的)?/, () => ({ kind: 'enemies', label: '所有敌人', pick: (b) => b.enemies.filter((e) => e.alive && !e.hidden) })],
    [/^(?:所有(?:场上)?干员|所有友方干员|全场(?:友方)?干员)(?:的)?/, () => ({ kind: 'allies', self: true, label: '所有干员', select: (b, s, a) => isOp(a) })],
    [/^(?:所有友方单位|全场友方单位|全体友方单位)(?:的)?/, () => ({ kind: 'allies', self: true, label: '所有单位', select: () => true })],
    [/^攻击范围内(?:的|所有)?(?:的)?敌(?:人|军)(?:的)?/, () => ({ kind: 'enemies', label: '范围内敌人', pick: (b, s) => enemiesInRange(b, s) })],
    [/^(?:自身)?阻挡的敌人(?:的)?/, () => ({ kind: 'enemies', label: '阻挡的敌人', pick: (b, s) => s.blocking.filter((e) => e.alive) })],
    [/^(?:使)?其/, () => ({ kind: 'enemies', label: '阻挡的敌人', pick: (b, s) => s.blocking.filter((e) => e.alive), ref: true })],
    [/^周围(?:8|八)格(?:内)?(?:的)?敌人(?:的)?/, () => ({ kind: 'enemies', label: '周围敌人', pick: (b, s) => b.foesInRadius(s.x, s.y, 1.5) })],
    // "敌人的X" after an ally area ("军旗周围8格的干员…，敌人的…"): the enemies of the same area (parseTalentText)
    [/^(?:且)?敌人的/, () => ({ kind: 'enemies', inherit: true, label: '同区域敌人', pick: () => [] })],
    [/^(?:使)?自身(?:与|和|及)浮游单元(?:的)?/, () => ({ kind: 'self', label: '自身(+浮游单元)' })],
    // "地面单位X" after an ally area ("攻击范围内的友方单位防御力+100，地面单位防御力额外+40"): the ground ones of that area
    [/^地面单位(?:的)?/, () => ({ kind: 'allies', inheritAlly: true, filter: (a) => a.ground !== false && !a.isFlying, label: '地面单位' })],
    [/^(?:且)?(?:自身|自己)(?:的)?/, () => ({ kind: 'self', label: '自身' })],
  ];
  for (const [re, f] of R) {
    const m = c.match(re);
    if (m) return { scope: f(m), rest: c.slice(m[0].length).replace(/^(?:获得|的)/, (x) => (x === '获得' ? '获得' : '')) };
  }
  return null;
}
const classOk = (a, w) => (PROF[w] ? a.def?.profession === PROF[w] : (NATIONS[w] ? a.def?.raw?.nationId === NATIONS[w] : false));

// =================================================================================================================
// effect builders

const E = (pattern, label, install, extra = {}) => ({ pattern, label, install, ...extra });

/** Install a stat effect with scope + state condition (+ team marker). */
function statEffect(P, j, { mods, extra = {}, scope, cond, label, dur = 0 }) {
  const key = effKey(P, j);
  const sc = scope || { kind: 'self' };
  const test = cond && cond.kind === 'state' ? cond.test : null;
  const pattern = sc.kind === 'enemies' ? 'F8.auraEnemy' : sc.kind === 'allies' ? (sc.team ? 'F7.team' : 'F7.auraAlly') : test ? 'F2.cond' : 'F1.stat';
  return E(pattern, label, (battle, unit) => {
    if (cond && typeof cond.install === 'function') cond.install(battle, unit);
    if (sc.kind === 'self') {
      if (!test) return selfStat(battle, unit, key, mods, extra);
      return toggle(battle, unit, key, () => test(battle, unit), mods, extra);
    }
    if (sc.kind === 'enemies') {
      const filter = sc.filter ?? null;
      return enemyAura(battle, unit, { key, pick: () => sc.pick(battle, unit), mods, test: test ? () => test(battle, unit) : null, filter });
    }
    // allies
    if (sc.team) {
      // 编入队伍 / 携带: every operator of the player for the whole battle (deployed or not), from the start
      battle.on('battleStart', () => {
        if (test && !test(battle, unit)) return;
        for (const a of battle.allyUnits) {
          if (!isOp(a) || a.ownerId !== unit.ownerId || !sc.select(battle, unit, a)) continue;
          const cur = a.findBuff(key);
          if (cur && (cur.data?.v ?? 0) >= modsValue(mods) - EPS) continue;
          battle.addBuff(a, { key, mods, persist: true, allowDead: true, source: unit, tags: ['talent'], ...extra, data: { ...(extra.data || {}), v: modsValue(mods) } });
        }
      }, { owner: unit });
      return;
    }
    const sel = (a) => (sc.self || a !== unit) && sc.select(battle, unit, a);
    allyAura(battle, unit, { key, select: sel, mods, test: test ? () => test(battle, unit) : null, extra });
  });
}

// =================================================================================================================
// specific rules (tried on the rest of the sentence; each consumes whole clauses)

/** Target condition of "攻击X的敌人时" / "若目标处于…": (battle, unit, target) => bool, or null when unknown. */
function targetCond(t, V) {
  if (!t || /^(?:敌人|目标)$/.test(t)) return { label: '', test: () => true };
  let m;
  if (/^空中(?:目标|单位|敌人)$/.test(t)) return { label: '空中', test: (b, u, e) => e.isFlying };
  if ((m = t.match(new RegExp(`^生命(?:值)?(?:低于|少于)${N}%的(?:敌人|目标)$`)))) { const r = V.pct(+m[1]) ?? +m[1] / 100; return { label: `生命<${r}`, test: (b, u, e) => e.hpRatio < r - EPS }; }
  if ((m = t.match(new RegExp(`^生命(?:值)?(?:在|高于)${N}%以上的(?:敌人|目标)$`)))) { const r = +m[1] / 100; return { label: `生命>${r}`, test: (b, u, e) => e.hpRatio > r + EPS }; }
  if (/^被阻挡的(?:敌人|目标)$/.test(t)) return { label: '被阻挡', test: (b, u, e) => !!e.blockedBy };
  if (/^未被阻挡的(?:敌人|目标)$/.test(t)) return { label: '未被阻挡', test: (b, u, e) => !e.blockedBy };
  if ((m = t.match(new RegExp(`^重量(?:较重（重量等级)?(?:大于等于|≥)${N}(?:）)?的(?:敌人|目标)$`)))) { const w = +m[1]; return { label: `重量≥${w}`, test: (b, u, e) => e.weight >= w - EPS }; }
  if ((m = t.match(new RegExp(`^重量(?:较轻（)?(?:小于等于|≤)${N}(?:）)?的(?:敌人|目标)$`)))) { const w = +m[1]; return { label: `重量≤${w}`, test: (b, u, e) => e.weight <= w + EPS }; }
  if (/^周围(?:8|八)格的(?:敌人|目标)$/.test(t)) return { label: '周围8格', test: (b, u, e) => cheb(u, e) <= 1 };
  if (/^正前方的(?:敌人|目标)$/.test(t)) return { label: '正前方', test: (b, u, e) => keysAround(u, FRONT).has(Math.round(e.y) * COLS + Math.round(e.x)) };
  if (/^(?:目标)?处于(?:晕眩、束缚|晕眩或束缚)(?:的(?:敌人|目标))?$/.test(t)) return { label: '晕眩/束缚', test: (b, u, e) => !!(e.s.flags.stun || e.s.flags.bind) };
  if (/^(?:处于)?(?:停顿、束缚|停顿或束缚)的(?:敌人|目标)$/.test(t)) return { label: '停顿/束缚', test: (b, u, e) => !!(e.s.flags.bind || e.findBuff('sluggish')) };
  if (/^精英或领袖(?:敌人|目标)$/.test(t)) return { label: '精英', test: (b, u, e) => isElite(e) };
  if ((m = t.match(/^(?:被|处于)(战栗|晕眩|束缚|冻结|寒冷|沉睡)(?:状态)?的(?:敌人|目标)$/))) {
    const f = { 战栗: 'tremble', 晕眩: 'stun', 束缚: 'bind', 冻结: 'freeze', 寒冷: 'cold', 沉睡: 'sleep' }[m[1]];
    return { label: m[1], test: (b, u, e) => !!e.s.flags[f] };
  }
  return null;
}
const TGT = '((?:空中(?:目标|单位|敌人))|(?:生命(?:值)?(?:低于|少于)\\d+(?:\\.\\d+)?%的(?:敌人|目标))|(?:生命(?:值)?(?:在|高于)\\d+(?:\\.\\d+)?%以上的(?:敌人|目标))|(?:被阻挡的(?:敌人|目标))|(?:未被阻挡的(?:敌人|目标))|(?:重量(?:较重（重量等级)?(?:大于等于|≥)\\d+(?:）)?的(?:敌人|目标))|(?:重量(?:较轻（)?(?:小于等于|≤)\\d+(?:）)?的(?:敌人|目标))|(?:周围(?:8|八)格的(?:敌人|目标))|(?:正前方的(?:敌人|目标))|(?:精英或领袖(?:敌人|目标))|(?:处于(?:停顿、束缚|停顿或束缚)的(?:敌人|目标))|(?:(?:被|处于)(?:战栗|晕眩|束缚|冻结|寒冷|沉睡)(?:状态)?的(?:敌人|目标))|敌人|目标)';

/**
 * On-hit riders "并使命中目标的防御力下降20%，持续5秒" / "并晕眩敌人0.5秒" / "并使其特殊能力失效3秒" / "并在3秒内使目标攻击力降低
 * 15%（不可叠加）" / "并使目标战栗5秒" / "且无视其物理闪避" → { apply(battle, unit, target), dodge } or null (unparsed).
 */
function parseRider(r, P, key) {
  const V = P.values;
  let s = r.replace(/^[，、]?(?:并且|并|且)?/, '').replace(/（不可叠加）/g, '');
  if (!s) return { apply: null };
  if (/^无视其物理闪避$/.test(s)) return { noDodge: true, apply: null };
  let m = s.match(new RegExp(`^(?:使(?:命中)?(?:目标|敌人|其))?(晕眩|停顿|束缚|特殊能力失效|冻结|寒冷|战栗|浮空)(?:敌人)?${N}秒$`))
    || s.match(new RegExp(`^(?:使)?(?:命中)?(?:目标|敌人|其)(?:的)?(晕眩|停顿|束缚|特殊能力失效|冻结|寒冷|战栗|浮空)，?(?:持续)?${N}秒$`))
    || s.match(new RegExp(`^(晕眩|停顿|束缚|冻结|寒冷|战栗)(?:敌人|目标)${N}秒$`));
  if (m) {
    const st = STATUS_WORDS[m[1]], d = V.flat(+m[2]) ?? +m[2];
    return { label: `${m[1]}${d}s`, apply: (b, u, t) => b.applyStatus(t, st, { duration: d, source: u }) };
  }
  m = s.match(new RegExp(`^(?:在${N}秒内)?使(?:命中)?(?:目标|敌人|其)(?:在${N}秒内)?(?:的)?${STAT_RE}(?:下降|降低|-)${N}(%)?(?:，?持续${N}秒)?$`));
  if (m) {
    const kind = statKind(m[3]);
    const mods = statMods(kind, -1, +m[4], !!m[5], V);
    const d = +(m[1] ?? m[2] ?? m[6] ?? 0);
    if (!mods || !(d > 0)) return null;
    return { label: `debuff ${m[3]}`, apply: (b, u, t) => b.addBuff(t, { key, duration: d, mods, refresh: 'extend', source: u, tags: ['talent'] }) };
  }
  return null;
}

/** Rider list → parts. */
function splitRiders(s) {
  return String(s || '').split(/(?=，)|(?=并且|并(?!且)|且)/).map((x) => x.replace(/^，/, '').trim()).filter(Boolean)
    .reduce((acc, x) => { if (/^持续/.test(x) && acc.length) acc[acc.length - 1] += '，' + x; else acc.push(x); return acc; }, []);
}

/** The list of specific rules. `m` = the match, `P` = parse context, `ctx` = { cond, j() }. Return effects or null. */
const RULES = [];
/**
 * Register a rule. Its regex is anchored at the clause start; a final `$` becomes "end of a clause" (`(?=，|$)`) so a
 * rule may be followed by more clauses — except a final `(.*)$`, which consumes the rest of the sentence on purpose.
 */
const rule = (id, re, build) => {
  let src = re.source.startsWith('^') ? re.source : '^' + re.source;
  if (src.endsWith('$') && !src.endsWith('(.*)$') && !src.endsWith('\\$')) src = src.slice(0, -1) + '(?=，|$)';
  RULES.push({ id, re: new RegExp(src, re.flags), build });
};
/** On-hit riders after a crit / scale: "，并…" / "并…" / "且…" / "，持续N秒(（…）)" / "，对…必定触发". */
const RIDERS = '((?:，?(?:并且|并|且)[^，]+|，持续\\d+(?:\\.\\d+)?秒(?:（[^）]*）)?|，对[^，]+必定触发)*)';

// ---- F4 crit: "攻击时，N%几率当次攻击的攻击力提升至M%(，并…)" / "攻击有N%几率造成相当于攻击力M%的物理伤害"
rule('F4.crit', new RegExp(`^(?:每次)?(?:攻击|造成伤害)(?:时)?，?(?:有)?${N}%(?:的)?(?:几率|概率)(?:当次攻击的)?(?:攻击力提升至${N}%|造成相当于攻击力${N}%的(?:物理|法术)伤害)${RIDERS}$`), (m, P, ctx) => {
  const V = P.values;
  const prob = V.pct(+m[1]), scale = V.pct(+(m[2] ?? m[3]));
  if (prob === undefined || scale === undefined) return null;
  const key = effKey(P, ctx.j());
  const riders = [], rlabels = [];
  const dropped = [];
  for (const part of splitRiders(m[4])) {
    const rd = parseRider(part, P, key);
    if (rd && rd.apply) { riders.push(rd.apply); rlabels.push(rd.label); } else if (!rd) dropped.push(part);
  }
  return { effects: [E('F4.crit', `暴击 ${prob}×${scale}${rlabels.length ? ' + ' + rlabels.join(' + ') : ''}`, (battle, unit) => {
    let lastId = -1, lastCrit = false;
    const crits = new WeakSet();
    const done = new Set();
    battle.on('hit', (c) => {
      if (c.source !== unit || !c.dmg.isAttack || !c.target || c.target.side !== 'enemy') return;
      const id = c.dmg.attackId;
      // one roll per attack: every instance (targets, splash, chain) of an attack crits together ("当次攻击")
      if (!id || id !== lastId) { lastId = id; lastCrit = battle.rng.chance(prob); done.clear(); }
      if (!lastCrit) return;
      c.dmg.amount *= scale;
      crits.add(c.dmg);
    }, { owner: unit });
    if (riders.length) {
      battle.on('damaged', (c) => {
        if (c.source !== unit || !c.dmg || !crits.has(c.dmg) || !hasHp(c.target)) return;
        if (done.has(c.target.id)) return;
        done.add(c.target.id);
        for (const f of riders) f(battle, unit, c.target);
        battle.fx('crit', { x: c.target.x, y: c.target.y, id: c.target.id });
      }, { owner: unit });
    }
  })], dropped };
});

// ---- F4 scale vs a target: "(自身和召唤物)?攻击X时攻击力提升至M%(，若Y则改为提升至M2%)(，并使其…)"
rule('F4.scale', new RegExp(`^(自身和召唤物)?(?:攻击|对)${TGT}?(?:时)?，?(?:对主目标的)?攻击力提升至${N}%(?:，?(?:若|当)(?:目标)?(处于[^，则]+?|[^，则]+?)(?:时)?(?:则)?改为提升至${N}%)?${RIDERS}$`), (m, P, ctx) => {
  const V = P.values;
  const tc = targetCond(m[2], V);
  const scale = V.pct(+m[3]);
  if (!tc || scale === undefined) return null;
  let tc2 = null, scale2;
  if (m[4]) { tc2 = targetCond(/^处于/.test(m[4]) ? m[4] : m[4], V); scale2 = V.pct(+m[5]); if (!tc2 || scale2 === undefined) return null; }
  const key = effKey(P, ctx.j());
  const riders = [], dropped = [], rlabels = [];
  let noDodge = false;
  for (const part of splitRiders(m[6])) {
    const rd = parseRider(part, P, key);
    if (rd && rd.noDodge) { noDodge = true; rlabels.push('无视闪避'); } else if (rd && rd.apply) { riders.push(rd.apply); rlabels.push(rd.label); } else dropped.push(part);
  }
  const condTest = ctx.cond && ctx.cond.kind === 'state' ? ctx.cond.test : null;
  const withSummons = !!m[1];
  return { effects: [E('F4.scale', `攻击${tc.label}×${scale}${tc2 ? ` / ${tc2.label}×${scale2}` : ''}${rlabels.length ? ' + ' + rlabels.join(' + ') : ''}`, (battle, unit) => {
    const mine = (s) => s === unit || (withSummons && s && s.kind === 'token' && s.ownerUnit === unit);
    const hitOnce = new Set();
    let lastId = -1;
    battle.on('hit', (c) => {
      const t = c.target;
      if (!mine(c.source) || !c.dmg.isAttack || !t || t.side !== 'enemy') return;
      if (condTest && !condTest(battle, unit)) return;
      if (tc2 && tc2.test(battle, c.source, t)) c.dmg.amount *= scale2;
      else if (tc.test(battle, c.source, t)) c.dmg.amount *= scale;
      else return;
      if (noDodge) c.dmg.canDodge = false;
      if (riders.length) { if (c.dmg.attackId !== lastId) { lastId = c.dmg.attackId; hitOnce.clear(); } c.dmg.gtRider = true; }
    }, { owner: unit });
    if (riders.length) {
      battle.on('damaged', (c) => {
        if (!mine(c.source) || !c.dmg || !c.dmg.gtRider || !hasHp(c.target) || hitOnce.has(c.target.id)) return;
        hitOnce.add(c.target.id);
        for (const f of riders) f(battle, unit, c.target);
      }, { owner: unit });
    }
  })], dropped };
});

// ---- F2/F4 "攻击造成N%伤害" (森蚺: a damage multiplier on the unit's attacks, under the clause's condition)
rule('F4.dmgMul', new RegExp(`^攻击造成${N}%(?:的)?伤害$`), (m, P, ctx) => {
  const v = P.values.pct(+m[1]);
  if (v === undefined) return null;
  const test = ctx.cond && ctx.cond.kind === 'state' ? ctx.cond.test : null;
  return { effects: [E('F4.dmgMul', `攻击伤害×${v}`, (battle, unit) => {
    battle.on('hit', (c) => { if (c.source === unit && c.dmg.isAttack && c.target?.side === 'enemy' && (!test || test(battle, unit))) c.dmg.mul *= v; }, { owner: unit });
  })] };
});

// ---- F4 DEF ignore (%): "(对敌人造成物理伤害时|攻击X(的敌人)?时，)?(有N%概率)?无视(其|目标)?(防御力的N%|N%的防御力)(，对空中单位概率提升至N%)?(，并额外造成N%攻击力的物理伤害)?"
rule('F4.defIgnore', new RegExp(`^(?:对敌人造成(物理|法术)?伤害时|攻击${TGT}?(?:时)?)?，?(?:有${N}%(?:的)?(?:几率|概率))?无视(?:其|目标|敌人)?(?:的)?(?:防御力的${N}%|${N}%的?防御力)(?:，对空中(?:单位|目标)概率提升至${N}%)?(?:，?并额外造成${N}%攻击力的(物理|法术)伤害)?$`), (m, P, ctx) => {
  const V = P.values;
  const tc = targetCond(m[2], V);
  if (!tc) return null;
  const prob = m[3] ? V.pct(+m[3]) : 1;
  const pen = V.pct(+(m[4] ?? m[5]));
  const airProb = m[6] ? (+m[6] === 100 ? 1 : V.pct(+m[6])) : undefined;
  const extra = m[7] ? V.pct(+m[7]) : 0;
  if (prob === undefined || pen === undefined || (m[6] && airProb === undefined) || extra === undefined) return null;
  const onlyType = m[1] ? dmgTypeOf(m[1]) : null;
  const out = [E('F4.defIgnore', `无视防御${pen}${prob < 1 ? ` p${prob}` : ''}${tc.label ? ` (${tc.label})` : ''}`, (battle, unit) => {
    battle.on('hit', (c) => {
      const t = c.target;
      if (c.source !== unit || !t || t.side !== 'enemy' || (onlyType ? c.dmg.type !== onlyType : !c.dmg.isAttack)) return;
      if (!tc.test(battle, unit, t)) return;
      const p = t.isFlying && airProb !== undefined ? airProb : prob;
      if (p < 1 && !battle.rng.chance(p)) return;
      c.dmg.defIgnorePct += pen;
    }, { owner: unit });
  })];
  if (extra > 0) {
    const type = dmgTypeOf(m[8]);
    out.push(E('F5.extra', `额外${extra}攻击力 (${tc.label})`, (battle, unit) => {
      battle.on('damaged', (c) => {
        if (c.source !== unit || !isMainHit(c.dmg) || !hasHp(c.target) || !tc.test(battle, unit, c.target)) return;
        battle.dealDamage(unit, c.target, { amount: unit.s.atk * extra, type, canDodge: false, tags: ['talent', 'extra'] });
      }, { owner: unit });
    }));
  }
  return { effects: out };
});

// ---- F4 stacking DEF ignore (提丰): "连续攻击时逐渐无视敌人的防御力，最高无视其防御力的N%（每次攻击提升M%的无视防御比例），T秒内未攻击则失去加成"
rule('F4.defIgnoreStack', new RegExp(`^连续攻击时逐渐无视敌人的防御力，最高无视其防御力的${N}%（每次攻击提升${N}%的无视防御比例），${N}秒内未攻击则失去加成$`), (m, P) => {
  const V = P.values;
  const per = V.pct(+m[2]), idle = V.flat(+m[3]) ?? +m[3];
  // the cap is max_stack_cnt × the step (no key of its own)
  const cnt = V.key('max_stack_cnt');
  const max = cnt > 0 && per !== undefined && Math.abs(cnt * per * 100 - +m[1]) < 0.5 + EPS ? cnt * per : V.pct(+m[1]);
  if (per === undefined || max === undefined) return null;
  return { effects: [E('F4.defIgnoreStack', `连续攻击无视防御 +${per}/次 ≤${max}`, (battle, unit) => {
    let n = 0, last = -Infinity, lastId = -1;
    battle.on('hit', (c) => {
      if (c.source !== unit || !c.dmg.isAttack || c.target?.side !== 'enemy') return;
      if (c.dmg.attackId !== lastId) {
        lastId = c.dmg.attackId;
        if (battle.time - last > idle + EPS) n = 0;
        n = Math.min(n + 1, Math.round(max / per));
        last = battle.time;
      }
      c.dmg.defIgnorePct += Math.min(max, n * per);
    }, { owner: unit });
    battle.on('deploy', (c) => { if (c.unit === unit) n = 0; }, { owner: unit });
  })] };
});

// ---- F5 two-tier extra (予愿安洁莉娜): "攻击额外造成相当于攻击力A%的X伤害，攻击重量较轻（小于等于W）的敌人时则额外造成相当于攻击力B%的X伤害"
rule('F5.extraTier', new RegExp(`^(?:[^，]{1,8}?)?攻击额外造成相当于攻击力${N}%的(物理|法术)伤害，攻击${TGT}时则额外造成相当于攻击力${N}%的(?:物理|法术)伤害$`), (m, P) => {
  const V = P.values;
  const lo = V.pct(+m[1]), hi = V.pct(+m[4]);
  const tc = targetCond(m[3], V);
  if (lo === undefined || hi === undefined || !tc) return null;
  const type = dmgTypeOf(m[2]);
  return { effects: [E('F5.extra', `额外${lo}/${hi}(${tc.label})攻击力${type}`, (battle, unit) => {
    battle.on('damaged', (c) => {
      const t = c.target;
      if (c.source !== unit || !isMainHit(c.dmg) || !hasHp(t) || t.side !== 'enemy') return;
      battle.dealDamage(unit, t, { amount: unit.s.atk * (tc.test(battle, unit, t) ? hi : lo), type, canDodge: false, tags: ['talent', 'extra'] });
    }, { owner: unit });
  })] };
});

// ---- F5 extra damage per attack: "(若攻击目标周围没有其他敌人，)?攻击(对其)?额外造成(相当于)?攻击力N%的X伤害" / "攻击附带N%攻击力的X伤害" /
//      "攻击X的敌人时(，)?额外造成相当于攻击力N%的X伤害"
rule('F5.extra', new RegExp(`^(若攻击目标周围没有其他敌人，)?(?:(?:[^，]{1,8}?)?攻击(?:${TGT}时，?)?(?:时)?(?:对(?:其|目标))?额外造成(?:相当于)?攻击力${N}%的(物理|法术|真实)伤害|攻击(?:同时)?附带${N}%攻击力的(物理|法术|真实)伤害)$`), (m, P) => {
  const V = P.values;
  const tc = targetCond(m[2], V);
  const ratio = V.pct(+(m[3] ?? m[5]));
  if (!tc || ratio === undefined) return null;
  const type = dmgTypeOf(m[4] ?? m[6]);
  const alone = !!m[1];
  const rr = V.key('range_radius') ?? 1.1;
  return { effects: [E('F5.extra', `额外${ratio}攻击力${type}${alone ? ' (周围无他敌)' : ''}${tc.label ? ` (${tc.label})` : ''}`, (battle, unit) => {
    battle.on('damaged', (c) => {
      const t = c.target;
      if (c.source !== unit || !isMainHit(c.dmg) || !hasHp(t) || t.side !== 'enemy' || !tc.test(battle, unit, t)) return;
      if (alone && battle.foesInRadius(t.x, t.y, rr, true).some((e) => e !== t)) return;
      battle.dealDamage(unit, t, { amount: unit.s.atk * ratio, type, canDodge: false, tags: ['talent', 'extra'] });
    }, { owner: unit });
  })] };
});

// ---- F5 extra vs target DEF (刻俄柏): "攻击时对目标额外造成相当于其防御力N%的法术伤害(，连续攻击同一目标时该比例逐次提升，最多提升至M%)"
rule('F5.extraDef', new RegExp(`^攻击时对目标额外造成相当于其防御力${N}%的(物理|法术|真实)伤害(?:，连续攻击同一目标时该比例逐次提升，最多提升至${N}%)?$`), (m, P) => {
  const V = P.values;
  const base = V.pct(+m[1]);
  const max = m[3] ? V.pct(+m[3]) : base;
  const step = V.key('delta_atk_scale') ?? 0;
  if (base === undefined || max === undefined) return null;
  const type = dmgTypeOf(m[2]);
  return { effects: [E('F5.extraDef', `额外目标防御×${base}${max > base ? `→${max}` : ''}`, (battle, unit) => {
    let lastT = null, cur = base;
    battle.on('damaged', (c) => {
      const t = c.target;
      if (c.source !== unit || !isMainHit(c.dmg) || !hasHp(t) || t.side !== 'enemy') return;
      cur = t === lastT && step > 0 ? Math.min(max, cur + step) : base;
      lastT = t;
      battle.dealDamage(unit, t, { amount: t.s.def * cur, type, canDodge: false, tags: ['talent', 'extra'] });
    }, { owner: unit });
  })] };
});

// ---- F5 random extra target (逻各斯): "对一个目标发起攻击时，有N%几率额外对攻击范围内一个随机目标造成相当于攻击力M%的X伤害并使其停顿T秒(，若该随机目标处于凋亡损伤爆发期间则同时造成相当于攻击力K%的元素伤害)"
rule('F5.extraRandom', new RegExp(`^对一个目标发起攻击时，有${N}%(?:的)?(?:几率|概率)额外对攻击范围内一个随机目标造成相当于攻击力${N}%的(物理|法术|真实)伤害(?:并使其(停顿|晕眩|束缚)${N}秒)?(?:，若该随机目标处于(神经|灼燃|凋亡|侵蚀)损伤爆发期间则同时造成相当于攻击力${N}%的元素伤害)?$`), (m, P) => {
  const V = P.values;
  const prob = V.pct(+m[1]), ratio = V.pct(+m[2]);
  const st = m[4] ? STATUS_WORDS[m[4]] : null, sd = m[5] ? (V.flat(+m[5]) ?? +m[5]) : 0;
  const el = m[6] ? ELEMENTS[m[6]] : null, er = m[7] ? V.pct(+m[7]) : 0;
  if (prob === undefined || ratio === undefined || er === undefined) return null;
  const type = dmgTypeOf(m[3]);
  return { effects: [E('F5.extraRandom', `p${prob} 随机目标${ratio}攻击力`, (battle, unit) => {
    battle.on('attack', (c) => {
      if (c.attacker !== unit || !(c.targets || []).some((t) => t && t.side === 'enemy') || !battle.rng.chance(prob)) return;
      const t = battle.rng.pick(enemiesInRange(battle, unit));
      if (!t) return;
      battle.dealDamage(unit, t, { amount: unit.s.atk * ratio, type, canDodge: false, tags: ['talent', 'extra'] });
      if (st && hasHp(t)) battle.applyStatus(t, st, { duration: sd, source: unit });
      if (el && er > 0 && hasHp(t) && burstOn(t, el)) battle.dealDamage(unit, t, { amount: unit.s.atk * er, type: 'elemental', element: el, canDodge: false, tags: ['talent', 'extra'] });
    }, { owner: unit });
  })] };
});

// ---- F5 double attack (Misery): "攻击时有N%概率造成二连击"
rule('F5.double', new RegExp(`^攻击时有${N}%(?:的)?(?:几率|概率)造成二连击$`), (m, P) => {
  const prob = P.values.pct(+m[1]);
  if (prob === undefined) return null;
  return { effects: [E('F5.double', `p${prob} 二连击`, (battle, unit) => {
    let inside = false;
    battle.on('attack', (c) => {
      if (inside || c.attacker !== unit || c.isSkill || !battle.rng.chance(prob)) return;
      const ts = (c.targets || []).filter((t) => t && t.alive && t.side === 'enemy');
      if (!ts.length) return;
      inside = true;
      try { battle.forceAttack(unit, ts, { noAmmo: true }); } finally { inside = false; }
    }, { owner: unit });
  })] };
});

// ---- F5 element on hit: "攻击附带相当于攻击力N%的X损伤(，并对目标周围其他敌人造成一次相当于攻击力M%的X损伤)" /
//      "造成(物理|法术)伤害时，附带(相当于)?(攻击力N%|N%伤害)的X损伤" / "攻击附带相当于N%伤害的X损伤"
rule('F5.element', new RegExp(`^(?:[^，]{0,6}?)(?:攻击|造成(物理|法术)?伤害时，?)(?:同时)?附带(?:相当于)?(?:攻击力${N}%|${N}%攻击力|${N}%伤害)的(神经|灼燃|凋亡|侵蚀)损伤(?:，并对目标周围其他敌人造成一次相当于攻击力${N}%的(?:神经|灼燃|凋亡|侵蚀)损伤)?$`), (m, P) => {
  const V = P.values;
  const ofDamage = m[4] !== undefined;
  const ratio = V.pct(+(m[2] ?? m[3] ?? m[4]));
  const splash = m[6] ? V.pct(+m[6]) : 0;
  if (ratio === undefined || splash === undefined) return null;
  const el = ELEMENTS[m[5]];
  const onlyType = m[1] ? dmgTypeOf(m[1]) : null;
  const onDamage = /造成[^，]*?伤害时/.test(m[0]);
  const rr = V.key('range_radius') ?? 1.3;
  return { effects: [E('F5.element', `${m[5]}损伤 ${ratio}${ofDamage ? '×伤害' : '×攻击力'}${splash ? ` +周围${splash}` : ''}`, (battle, unit) => {
    battle.on('damaged', (c) => {
      const t = c.target;
      if (c.source !== unit || !c.dmg || !hasHp(t) || t.side !== 'enemy' || c.type === 'element') return;
      if (onDamage ? (onlyType && c.dmg.type !== onlyType) || (c.dmg.tags || []).includes('extra') || c.dmg.type === 'element' : !isMainHit(c.dmg)) return;
      const amount = ofDamage ? c.amount * ratio : unit.s.atk * ratio;
      if (amount > 0) battle.dealDamage(unit, t, { type: 'element', element: el, amount, tags: ['talent'] });
      if (splash > 0) for (const e of battle.foesInRadius(t.x, t.y, rr, true)) if (e !== t && hasHp(e)) battle.dealDamage(unit, e, { type: 'element', element: el, amount: unit.s.atk * splash, tags: ['talent'] });
    }, { owner: unit });
  })] };
});

// ---- F5 self heal per attack (帕拉斯): "每攻击一名敌人时为自身(与身前一格的我方干员)?恢复N点生命值"
rule('F5.attackHeal', new RegExp(`^每攻击一名敌人时为自身(与身前一格的我方干员)?恢复${N}点生命(?:值)?$`), (m, P) => {
  const v = P.values.flat(+m[2]);
  if (v === undefined) return null;
  const front = !!m[1];
  return { effects: [E('F5.attackHeal', `攻击回复${v}${front ? ' (+身前)' : ''}`, (battle, unit) => {
    battle.on('attack', (c) => {
      if (c.attacker !== unit) return;
      const n = (c.targets || []).filter((t) => t && t.side === 'enemy').length;
      if (!n) return;
      battle.heal(unit, unit, v * n, { self: true });
      if (front) {
        const k = keysAround(unit, FRONT);
        for (const a of battle.alliesFor(unit, unit.ownerId)) if (isOp(a) && a !== unit && k.has(tileKey(a))) battle.heal(unit, a, v * n);
      }
    }, { owner: unit });
  })] };
});

// ---- F5 ATK stacks on the same target (莱伊): "攻击相同目标时每次攻击提高自身攻击力N%，最多M层"
rule('F5.sameTarget', new RegExp(`^攻击相同目标时每次攻击提高自身攻击力${N}%，最多(\\d+|[一二三四五六七八九十])层$`), (m, P, ctx) => {
  const v = P.values.pct(+m[1]);
  const max = cnNum(m[2]);
  if (v === undefined) return null;
  const key = effKey(P, ctx.j());
  return { effects: [E('F5.sameTarget', `同目标攻击力+${v}×≤${max}`, (battle, unit) => {
    let last = null;
    battle.on('attack', (c) => {
      if (c.attacker !== unit) return;
      const t = (c.targets || []).find((x) => x && x.side === 'enemy');
      if (!t) return;
      if (t !== last) { battle.removeBuff(unit, key); last = t; }
      battle.addBuff(unit, { key, mods: { atkPct: v }, refresh: 'stack', stacks: 1, maxStacks: max, tags: ['talent'] });
    }, { owner: unit });
  })] };
});

// ---- F4 target mark (重岳): "对目标普通攻击时，有N%的概率使X T秒内对其造成的伤害提升M%"
rule('F4.mark', new RegExp(`^(?:对目标普通攻击时|攻击命中${TGT}时)，(?:有${N}%的?(?:几率|概率)使)?[^，]{0,8}?${N}秒内(?:[^，]{0,8}?)对其造成的伤害提升${N}%$`), (m, P) => {
  const V = P.values;
  const tc = targetCond(m[1], V);
  const prob = m[2] ? V.pct(+m[2]) : 1;
  const dur = V.flat(+m[3]) ?? +m[3];
  const v = V.pct(+m[4]);
  if (!tc || prob === undefined || v === undefined) return null;
  return { effects: [E('F4.mark', `标记 p${prob} ${dur}s 伤害+${v}`, (battle, unit) => {
    const mark = `gt:mark:${unit.id}`;
    battle.on('hit', (c) => {
      const t = c.target;
      if (c.source !== unit || !t || t.side !== 'enemy') return;
      if (t.findBuff(mark)) c.dmg.mul *= 1 + v;
    }, { owner: unit, priority: 5 });
    battle.on('damaged', (c) => {
      const t = c.target;
      if (c.source !== unit || !isMainHit(c.dmg) || !hasHp(t) || t.side !== 'enemy' || !tc.test(battle, unit, t)) return;
      if (prob < 1 && !battle.rng.chance(prob)) return;
      battle.addBuff(t, { key: mark, duration: dur, refresh: 'extend', source: unit, tags: ['talent'] });
    }, { owner: unit });
  })] };
});

// ---- F4 damage vs enemies that never hurt the unit (弑君者): "对未伤害过自身的(地面)?敌人造成的(物理)?伤害提升N%"
rule('F4.untouched', new RegExp(`^对未伤害过自身的(地面)?敌人造成的(物理|法术)?伤害提升${N}%$`), (m, P) => {
  const v = P.values.pct(+m[3]);
  if (v === undefined) return null;
  const ground = !!m[1], type = m[2] ? dmgTypeOf(m[2]) : null;
  return { effects: [E('F4.untouched', `对未伤害过自身的敌人×${1 + v}`, (battle, unit) => {
    const hurtMe = new Set();
    battle.on('damaged', (c) => { if (c.target === unit && c.source && c.source.side === 'enemy' && c.amount > 0) hurtMe.add(c.source.id); }, { owner: unit });
    battle.on('hit', (c) => {
      const t = c.target;
      if (c.source !== unit || !t || t.side !== 'enemy' || (type && c.dmg.type !== type) || (ground && t.isFlying) || hurtMe.has(t.id)) return;
      c.dmg.mul *= 1 + v;
    }, { owner: unit });
  })] };
});

// ---- F4 first damage on each enemy: "(技能期间)?对每个敌人首次(造成伤害|进行攻击)时，(攻击力提升至M%)?(并)?(使(其|目标)STATUS T秒)?"
rule('F4.firstHit', new RegExp(`^(技能期间)?对每个敌人首次(?:造成伤害|进行攻击)时，?(?:攻击力提升至${N}%)?(?:，?并)?(?:使(?:其|目标)(停顿|战栗|浮空|晕眩|束缚)${N}秒)?$`), (m, P) => {
  const V = P.values;
  const scale = m[2] ? V.pct(+m[2]) : 1;
  const st = m[3] ? STATUS_WORDS[m[3]] : null;
  const sd = m[4] ? (V.flat(+m[4]) ?? +m[4]) : 0;
  if (scale === undefined || (!m[2] && !st)) return null;
  const inSkill = !!m[1];
  return { effects: [E('F4.firstHit', `首次${scale !== 1 ? `×${scale}` : ''}${st ? ` ${st}${sd}s` : ''}${inSkill ? ' (技能中)' : ''}`, (battle, unit) => {
    let seen = new Set(), act = -1;
    const first = new WeakSet();
    battle.on('hit', (c) => {
      const t = c.target;
      if (c.source !== unit || !t || t.side !== 'enemy') return;
      if (inSkill) {
        if (!unit.skill?.active) return;
        if (unit.skill.activations !== act) { act = unit.skill.activations; seen = new Set(); }
      }
      if (seen.has(t.id)) return;
      seen.add(t.id);
      if (scale !== 1) c.dmg.amount *= scale;
      first.add(c.dmg);
    }, { owner: unit });
    if (st) battle.on('damaged', (c) => { if (c.source === unit && c.dmg && first.has(c.dmg) && hasHp(c.target)) battle.applyStatus(c.target, st, { duration: sd, source: unit }); }, { owner: unit });
  })] };
});

// ---- F4 counted window (焰狐龙梓兰): "部署后首次开启技能时，接下来N次攻击的攻击力提升至M%"
rule('F4.window', new RegExp(`^部署后首次开启技能时，接下来${N}次攻击的攻击力提升至${N}%$`), (m, P) => {
  const V = P.values;
  const n = V.flat(+m[1]) ?? +m[1], scale = V.pct(+m[2]);
  if (scale === undefined) return null;
  return { effects: [E('F4.window', `首次技能后${n}次攻击×${scale}`, (battle, unit) => {
    let left = 0, armed = false, lastId = -1;
    battle.on('deploy', (c) => { if (c.unit === unit) { armed = true; left = 0; } }, { owner: unit });
    battle.on('skillStart', (c) => { if (c.unit === unit && armed) { armed = false; left = n; } }, { owner: unit });
    battle.on('hit', (c) => {
      if (c.source !== unit || !c.dmg.isAttack || c.target?.side !== 'enemy' || !(left > 0 || c.dmg.attackId === lastId)) return;
      if (c.dmg.attackId !== lastId) { lastId = c.dmg.attackId; left--; }
      c.dmg.amount *= scale;
    }, { owner: unit });
  })] };
});

// ---- F6 status on hit: "攻击时对攻击目标造成N秒的停顿" / "攻击使目标的特殊能力失效，持续N秒" / "攻击时有N%的几率使目标束缚N秒" / "攻击造成N秒寒冷"
rule('F6.status', new RegExp(`^攻击(?:时)?(?:有${N}%(?:的)?(?:几率|概率))?(?:对攻击目标造成${N}秒的(停顿|晕眩|寒冷|束缚)|使目标(?:的)?(特殊能力失效|束缚|晕眩|停顿|战栗)，?(?:持续)?${N}秒|造成${N}秒(寒冷|停顿|晕眩))$`), (m, P) => {
  const V = P.values;
  const prob = m[1] ? V.pct(+m[1]) : 1;
  const word = m[3] ?? m[4] ?? m[7];
  const d0 = +(m[2] ?? m[5] ?? m[6]);
  const d = V.flat(d0) ?? d0;
  if (prob === undefined) return null;
  const st = STATUS_WORDS[word];
  return { effects: [E('F6.status', `${word}${d}s${prob < 1 ? ` p${prob}` : ''}`, (battle, unit) => {
    battle.on('damaged', (c) => {
      if (c.source !== unit || !isMainHit(c.dmg) || !hasHp(c.target) || c.target.side !== 'enemy') return;
      if (prob < 1 && !battle.rng.chance(prob)) return;
      battle.applyStatus(c.target, st, { duration: d, source: unit });
    }, { owner: unit });
  })] };
});

// ---- F6 debuff on hit: "攻击使目标在N秒内STAT降低X%(（最多叠加M次）)(，并且…)" / "攻击使目标在N秒内法术抗性-X且受到的法术伤害提高Y点"
rule('F6.debuff', new RegExp(`^(?:攻击|“?[^，]{1,6}?”?的攻击会)(?:使|令)(?:命中)?目标(?:在${N}秒内)?(?:的)?${STAT_RE}(?:下降|降低|-)${N}(%)?(?:，持续${N}秒)?(?:（最多叠加(\\d+|[一二三四五六七八九十])次）)?(?:且受到的(法术|物理)伤害提高${N}点)?$`), (m, P, ctx) => {
  const V = P.values;
  const mods = statMods(statKind(m[2]), -1, +m[3], !!m[4], V);
  const d = +(m[1] ?? m[5] ?? ctx.dur ?? 0);
  const stacks = m[6] ? cnNum(m[6]) : 1;
  const addTaken = m[8] ? V.flat(+m[8]) : 0;
  if (!mods || !(d > 0) || addTaken === undefined) return null;
  const key = effKey(P, ctx.j());
  const dropped = [];
  const out = [E('F6.debuff', `${m[2]}-${m[3]}${m[4] || ''} ${d}s${stacks > 1 ? ` ×${stacks}` : ''}`, (battle, unit) => {
    battle.on('damaged', (c) => {
      if (c.source !== unit || !isMainHit(c.dmg) || !hasHp(c.target) || c.target.side !== 'enemy') return;
      battle.addBuff(c.target, { key: `${key}:${unit.id}`, duration: d, mods, refresh: stacks > 1 ? 'stack' : 'extend', stacks: 1, maxStacks: stacks, source: unit, tags: ['talent'] });
    }, { owner: unit });
    if (addTaken > 0) {
      const type = dmgTypeOf(m[7]);
      battle.on('hit', (c) => { if (c.dmg.type === type && c.target && c.target.findBuff(`${key}:${unit.id}`) && !c.dmg.sourceless) c.dmg.amount += addTaken; }, { owner: unit });
    }
  })];
  return { effects: out, dropped };
});

// ---- F4 execute curve (贝洛内): "(并且)?目标剩余生命值比例越低自身对其造成的伤害越高，在剩余N%以下生命值时伤害提高到最高M%"
rule('F4.execute', new RegExp(`^(?:并且)?目标剩余生命值比例越低自身对其造成的伤害越高，在剩余${N}%以下生命值时伤害提高到最高${N}%$`), (m, P) => {
  const V = P.values;
  const lo = V.key('max_hp_ratio') ?? +m[1] / 100, hi = V.key('min_hp_ratio') ?? 1;
  const top = V.key('max_add_on_scale') ?? (V.pct(+m[2]) !== undefined ? V.pct(+m[2]) - 1 : undefined);
  const bottom = V.key('min_add_on_scale') ?? 0;
  if (top === undefined || Math.abs((1 + top) * 100 - +m[2]) > 0.5 + EPS) return null;
  return { effects: [E('F4.execute', `斩杀 ×1→${1 + top} (生命${hi}→${lo})`, (battle, unit) => {
    battle.on('hit', (c) => {
      const t = c.target;
      if (c.source !== unit || !t || t.side !== 'enemy') return;
      const f = Math.max(0, Math.min(1, (hi - t.hpRatio) / Math.max(1e-6, hi - lo)));
      c.dmg.mul *= 1 + bottom + (top - bottom) * f;
    }, { owner: unit });
  })] };
});

// ---- F4 trait splash damage (怒潮凛冬): "特性溅射造成的(物理)?伤害提升N%"
rule('F4.splashDmg', new RegExp(`^特性溅射造成的(物理|法术)?伤害提升${N}%$`), (m, P) => {
  const v = P.values.pct(+m[2]);
  if (v === undefined) return null;
  const type = m[1] ? dmgTypeOf(m[1]) : null;
  return { effects: [E('F4.splashDmg', `溅射伤害×${1 + v}`, (battle, unit) => {
    battle.on('hit', (c) => { if (c.source === unit && c.dmg.isAttack && c.dmg.isSplash && (!type || c.dmg.type === type)) c.dmg.mul *= 1 + v; }, { owner: unit });
  })] };
});

// ---- F6 DoT on hit: "攻击使目标中毒，在N秒内每秒受到M点X伤害(，可叠加K次)?(（对会远程攻击的目标伤害加倍）)?" /
//      "攻击对敌人施加效果：移动速度降低A%，每秒受到B%X当前攻击力的Y伤害，持续T秒，效果最多叠加K层" /
//      "攻击(和…)?使目标在T秒内每秒受到M点X伤害（至多叠加K次…）(，…)"
rule('F6.dot', new RegExp(`^攻击(?:和储存的能量)?(?:使目标中毒，|对敌人施加效果：|使目标)(?:在${N}秒内)?(?:移动速度降低${N}%，)?每秒受到(?:${N}点|${N}%[^，]{0,6}?当前攻击力的|相当于攻击力${N}%的)(物理|法术|真实)伤害(?:，持续${N}秒)?(?:，(?:可叠加|效果最多叠加)(\\d+|[一二三四五六七八九十])(?:次|层))?(?:（(?:至多叠加(\\d+|[一二三四五六七八九十])次[^）]*|对会远程攻击的目标伤害加倍|对【海怪】敌人伤害加倍)）)?(.*)$`), (m, P, ctx) => {
  const V = P.values;
  const dur = V.flat(+(m[1] ?? m[7])) ?? +(m[1] ?? m[7]);
  const slow = m[2] ? V.pct(+m[2]) : 0;
  const flat = m[3] ? V.flat(+m[3]) : undefined;
  const ratio = m[4] || m[5] ? V.pct(+(m[4] ?? m[5])) : undefined;
  const stacks = m[8] || m[9] ? cnNum(m[8] ?? m[9]) : 1;
  if (!(dur > 0) || slow === undefined || (flat === undefined && ratio === undefined)) return null;
  const type = dmgTypeOf(m[6]);
  const vsRanged = /对会远程攻击的目标伤害加倍/.test(m[0]);
  const vsSea = /对【海怪】敌人伤害加倍/.test(m[0]);
  const ranged = vsRanged ? (V.key('damage[ranged]') ?? flat * 2) : flat;
  const key = effKey(P, ctx.j());
  const dropped = m[10] ? [m[10].replace(/^，/, '')] : [];
  return { effects: [E('F6.dot', `DoT ${flat ?? ratio + '×攻击力'}/s ${dur}s${stacks > 1 ? ` ×${stacks}` : ''}${slow ? ` 减速${slow}` : ''}`, (battle, unit) => {
    battle.on('damaged', (c) => {
      const t = c.target;
      if (c.source !== unit || !isMainHit(c.dmg) || !hasHp(t) || t.side !== 'enemy') return;
      const per = flat !== undefined ? (vsRanged && isRangedEnemy(t) ? ranged : vsSea && (t.def?.tags || []).includes('seamonster') ? flat * 2 : flat) : null;
      battle.addBuff(t, {
        key: `${key}:${unit.id}`, duration: dur, refresh: stacks > 1 ? 'stack' : 'extend', stacks: 1, maxStacks: stacks, source: unit, tags: ['talent', 'dot'],
        mods: slow ? { moveMul: 1 - slow } : null, interval: 1,
        onTick: ({ unit: e, buff }) => {
          const amt = (per ?? unit.s.atk * ratio) * (buff.stacks || 1);
          if (amt > 0 && e.alive) battle.dealDamage(unit, e, { amount: amt, type, canDodge: false, tags: ['talent', 'dot'] });
        },
      });
    }, { owner: unit });
  })], dropped };
});

// ---- F7 Mon3tr-like on-heal buff: "(自身或X)?造成治疗时，使目标及自身的STAT，持续N秒（无法叠加）"
rule('F7.onHeal', new RegExp(`^(?:自身或[^，]{1,6}?)?(?:造成治疗|治疗)时，使目标及自身的([^，]+?)，持续${N}秒(?:（(?:无法|不可)叠加）)?$`), (m, P, ctx) => {
  const sp = statPhrases(m[1], P.values);
  const d = P.values.flat(+m[2]) ?? +m[2];
  if (!sp) return null;
  const key = effKey(P, ctx.j());
  return { effects: [E('F7.onHeal', `治疗时 目标+自身 ${JSON.stringify(sp.mods)} ${d}s`, (battle, unit) => {
    battle.on('heal', (c) => {
      if (c.source !== unit || !c.target || !(c.amount > 0)) return;
      for (const a of c.target === unit ? [unit] : [c.target, unit]) battle.addBuff(a, { key, duration: d, mods: sp.mods, refresh: 'replace', source: unit, tags: ['talent'] });
    }, { owner: unit });
  })] };
});

// ---- heal amplifiers (modules): "治疗生命值低于N%的友方单位时治疗量提升M%" / "治疗地面单位时治疗量提升M%"
rule('F7.healAmp', new RegExp(`^治疗(生命值低于${N}%的友方单位|地面单位)时治疗量提升${N}%$`), (m, P) => {
  const V = P.values;
  const v = V.pct(+m[3]);
  const r = m[2] ? (V.pct(+m[2]) ?? +m[2] / 100) : 0;
  if (v === undefined) return null;
  return { effects: [E('F7.healAmp', `治疗${m[2] ? `<${r}` : '地面'}×${1 + v}`, (battle, unit) => {
    battle.on('heal', (c) => {
      const t = c.target;
      if (c.source !== unit || !t) return;
      if (m[2] ? t.hpRatio < r - EPS : (t.ground !== false && !t.isFlying)) c.amount *= 1 + v;
    }, { owner: unit });
  })] };
});

// ---- 淬羽赫默#0: "使攻击范围内的友军获得N%的庇护，友军的生命越低该效果越强（低于H%生命时获得最大M%的庇护）"
rule('F7.scaledShelter', new RegExp(`^(?:使)?攻击范围内的友(?:军|方单位)获得${N}%的庇护，友(?:军|方单位)的生命越低该效果越强（低于${N}%生命时获得最大${N}%的庇护）$`), (m, P, ctx) => {
  const V = P.values;
  const base = V.pct(+m[1]), min = V.pct(+m[2]) ?? +m[2] / 100;
  // the maximum is base + resistance_scale per hp_ratio×10 of HP lost down to min_hp_ratio (0.1 + 0.02 × 7 = 24 %)
  const sc = V.key('resistance_scale'), step = V.key('hp_ratio');
  const derived = base !== undefined && sc > 0 && step > 0 ? base + sc * (1 - min) / (step * 10) : undefined;
  const max = derived !== undefined && Math.abs(derived * 100 - +m[3]) < 0.5 + EPS ? derived : V.pct(+m[3]);
  if (base === undefined || max === undefined) return null;
  const key = effKey(P, ctx.j());
  return { effects: [E('F7.auraAlly', `范围内庇护 ${base}→${max}`, (battle, unit) => {
    allyAura(battle, unit, {
      key, select: (a) => rangeSet(unit).has(tileKey(a)),
      mods: (a) => { const v = base + (max - base) * Math.max(0, Math.min(1, (1 - a.hpRatio) / Math.max(1e-6, 1 - min))); return { physTakenMul: 1 - v, artsTakenMul: 1 - v }; },
    });
  })] };
});

// ---- 淬羽赫默#1 / 调香师-like regen auras: "攻击范围内(友军的最大生命值+X%且)?生命低于N%(时|的友军)每秒恢复相当于S攻击力M%的生命(，【X】干员的(恢复)?效果翻倍)?" /
//      "(在战场时)?全体友方单位每秒恢复相当于S攻击力M%的生命"
rule('F7.regenAura', new RegExp(`^(?:在战场时|在场时)?(?:攻击范围内(?:友军的最大生命值\\+${N}%且)?(?:生命低于${N}%(?:时|的友军))|全体友方单位)每秒恢复相当于[^，]{0,8}?攻击力${N}%的生命(?:，【([^】]+)】干员的(?:恢复)?效果翻倍)?$`), (m, P, ctx) => {
  const V = P.values;
  const hp = m[1] ? V.pct(+m[1]) : 0;
  const below = m[2] ? (V.pct(+m[2]) ?? +m[2] / 100) : null;
  const ratio = V.pct(+m[3]);
  if (ratio === undefined || hp === undefined) return null;
  const inRange = /^(?:在战场时|在场时)?攻击范围内/.test(m[0]);
  const key = effKey(P, ctx.j()), key2 = effKey(P, ctx.j());
  const fac = m[4] ? NATIONS[m[4]] : null;
  const dropped = m[4] && !fac ? [`【${m[4]}】干员的效果翻倍 (no faction id in the chess data)`] : [];
  const out = [E('F7.auraAlly', `${inRange ? '范围内' : '全体'}${below ? `生命<${below}` : ''}每秒+攻击力×${ratio}`, (battle, unit) => {
    const sel = (a) => (!inRange || rangeSet(unit).has(tileKey(a)));
    allyAura(battle, unit, {
      key, select: sel,
      mods: (a) => (below == null || a.hpRatio < below - EPS ? { hpRegen: unit.s.atk * ratio * (fac && a.def?.raw?.nationId === fac ? 2 : 1) } : null),
    });
  })];
  if (hp > 0) out.push(E('F7.auraAlly', `范围内生命上限+${hp}`, (battle, unit) => allyAura(battle, unit, { key: key2, select: (a) => rangeSet(unit).has(tileKey(a)), mods: { hpPct: hp } })));
  return { effects: out, dropped };
});

// ---- F8 enemy auras that need more than a stat phrase
rule('F8.stunTaken', new RegExp(`^攻击范围内的敌人在被晕眩时受到的(物理|法术)伤害\\+${N}%$`), (m, P, ctx) => {
  const v = P.values.pct(+m[2]);
  if (v === undefined) return null;
  const key = effKey(P, ctx.j());
  const mk = m[1] === '物理' ? 'physTakenMul' : 'artsTakenMul';
  return { effects: [E('F8.auraEnemy', `晕眩中受到${m[1]}伤害×${1 + v}`, (battle, unit) => {
    enemyAura(battle, unit, { key, pick: () => enemiesInRange(battle, unit), mods: { [mk]: 1 + v }, filter: (e) => !!e.s.flags.stun || !!e.findBuff('stun') });
  })] };
});
rule('F8.burstAspd', new RegExp(`^(?:在场时，)?全场处于(神经|灼燃|凋亡|侵蚀)损伤爆发期间的敌人攻击速度-${N}$`), (m, P, ctx) => {
  const v = P.values.flat(+m[2]);
  if (v === undefined) return null;
  const el = ELEMENTS[m[1]], key = effKey(P, ctx.j());
  return { effects: [E('F8.auraEnemy', `${m[1]}爆发中的敌人攻击速度-${v}`, (battle, unit) => {
    enemyAura(battle, unit, { key, pick: () => battle.enemies, mods: { aspd: -v }, filter: (e) => burstOn(e, el) });
  })] };
});
rule('F8.attackElement', new RegExp(`^攻击范围内的敌人普通攻击时受到${N}点(神经|灼燃|凋亡|侵蚀)损伤$`), (m, P) => {
  const v = P.values.flat(+m[1]);
  if (v === undefined) return null;
  const el = ELEMENTS[m[2]];
  return { effects: [E('F8.attackElement', `范围内敌人攻击时受到${v}${m[2]}损伤`, (battle, unit) => {
    battle.on('attack', (c) => {
      const e = c.attacker;
      if (!up(unit) || !e || e.side !== 'enemy' || c.isSkill || !hasHp(e) || !rangeSet(unit).has(Math.round(e.y) * COLS + Math.round(e.x))) return;
      battle.dealDamage(unit, e, { type: 'element', element: el, amount: v, tags: ['talent'] });
    }, { owner: unit });
  })] };
});
rule('F8.weightless', new RegExp(`^攻击范围内(?:所有)?生命值高于${N}%的敌人失重$`), (m, P, ctx) => {
  const r = P.values.pct(+m[1]) ?? +m[1] / 100;
  const key = effKey(P, ctx.j());
  return { effects: [E('F8.auraEnemy', `范围内生命>${r}的敌人失重`, (battle, unit) => {
    enemyAura(battle, unit, { key, pick: () => enemiesInRange(battle, unit), mods: { massFlat: -1 }, filter: (e) => e.hpRatio > r + EPS });
  })] };
});

// ---- reveal (modules): "攻击范围内敌人的隐匿效果失效"
rule('F8.reveal', /^攻击范围内(?:的)?敌人的隐匿效果失效$/, () => ({ effects: [E('F8.reveal', '范围内反隐', (battle, unit) => {
  battle.every(0.2, () => {
    if (!up(unit)) return;
    const set = rangeSet(unit);
    for (const e of battle.enemies) {
      if (!e.alive || e.hidden || !e.s.flags.stealth || !set.has(Math.round(e.y) * COLS + Math.round(e.x))) continue;
      battle.applyStatus(e, 'reveal', { duration: 0.3, source: unit });
    }
  }, { owner: unit });
})] }));

// ---- damage dealt modifiers (modules)
rule('F4.skillDmg', new RegExp(`^技能造成的伤害提升${N}%$`), (m, P) => {
  const v = P.values.pct(+m[1]);
  if (v === undefined) return null;
  return { effects: [E('F4.skillDmg', `技能伤害×${1 + v}`, (battle, unit) => {
    battle.on('hit', (c) => { if (c.source === unit && c.dmg.isSkill && c.target?.side === 'enemy') c.dmg.mul *= 1 + v; }, { owner: unit });
  })] };
});
rule('F4.elementDealt', new RegExp(`^(?:对(精英和领袖|精英或领袖)敌人)?(?:自身)?造成的元素损伤提升${N}%$`), (m, P, ctx) => {
  const v = P.values.pct(+m[2]);
  if (v === undefined) return null;
  const elite = !!m[1];
  const test = ctx.cond && ctx.cond.kind === 'state' ? ctx.cond.test : null;
  return { effects: [E('F4.elementDealt', `元素损伤×${1 + v}${elite ? ' (精英)' : ''}`, (battle, unit) => {
    battle.on('elementHit', (c) => {
      if (c.source !== unit || !c.target || (elite && !isElite(c.target)) || (test && !test(battle, unit))) return;
      c.dmg.mul *= 1 + v;
    }, { owner: unit });
  })] };
});
rule('F4.vsBurst', new RegExp(`^对处于元素爆发期间的敌人造成的伤害提升至${N}%$`), (m, P) => {
  const v = P.values.pct(+m[1]);
  if (v === undefined) return null;
  return { effects: [E('F4.vsBurst', `对爆发中的敌人×${v}`, (battle, unit) => {
    battle.on('hit', (c) => { if (c.source === unit && c.target?.side === 'enemy' && burstOn(c.target)) c.dmg.mul *= v; }, { owner: unit });
  })] };
});

// ---- F3 坚忍: "(在场时，)?自身获得最高+A STAT(和…)?的坚忍（损失N%生命值时达到最大加成）" — numbers from the min_*/max_* keys
rule('F3.tenacity', /^(?:在场时，)?自身获得最高[^，]*?的坚忍（损失\d+(?:\.\d+)?%生命值时达到最大加成）$/, (m, P, ctx) => {
  const V = P.values;
  const minHp = V.key('min_hp_ratio');
  const maxHp = V.key('max_hp_ratio') ?? 1;
  const parts = [['min_attack_speed', 'aspd', 1], ['min_atk', 'atkPct', 1], ['min_magic_resistance', 'resFlat', 1], ['min_sp_recovery_per_sec', 'spRecoveryFlat', 1], ['min_def', 'defPct', 1]]
    .map(([k, mk]) => [mk, V.key(k), V.key(k.replace('min_', 'max_')) ?? 0]).filter(([, v]) => v);
  if (minHp === undefined || !parts.length) return null;
  const key = effKey(P, ctx.j());
  return { effects: [E('F3.tenacity', `坚忍 ${parts.map(([k, v]) => `${k}≤${v}`).join(' ')} @${minHp}`, (battle, unit) => {
    toggle(battle, unit, key, () => true, () => {
      const f = Math.max(0, Math.min(1, (maxHp - unit.hpRatio) / Math.max(1e-6, maxHp - minHp)));
      const mods = {};
      for (const [k, vmax, vmin] of parts) mods[k] = vmin + (vmax - vmin) * f;
      return mods;
    });
  })] };
});

// ---- F3 精力充沛: "(所有【X】干员)?生命值高于N%时获得+M%攻击力的精力充沛(；高于K%效果翻倍)" — tiers from the peak_performance keys
rule('F3.peak', /^(?:在场时，)?(?:所有【([^】]+)】干员)?(?:生命值)?高于\d+(?:\.\d+)?%时获得[^，]*?的精力充沛$/, (m, P, ctx) => {
  const V = P.values;
  const tiers = [];
  const hpK = V.vals.filter((x) => /peak_performance\.hp_ratio$/.test(x.k));
  for (const h of hpK) {
    const pre = h.k.replace(/hp_ratio$/, '');
    const atk = V.key(pre + 'atk');
    const aspd = V.key(pre + 'attack_speed');
    if (atk || aspd) tiers.push({ hp: h.v, mods: atk ? { atkPct: atk } : { aspd } });
  }
  if (!tiers.length) return null;
  tiers.sort((a, b) => b.hp - a.hp);
  const key = effKey(P, ctx.j());
  const best = (a) => tiers.find((t) => a.hpRatio > t.hp + EPS)?.mods ?? null;
  if (m[1]) {
    const nat = NATIONS[m[1]];
    if (!nat) return { effects: [], dropped: [`所有【${m[1]}】干员 … 精力充沛 (no faction id in the chess data)`], peak: true };
    return { peak: true, effects: [E('F3.peak', `精力充沛 【${m[1]}】 ${tiers.map((t) => `>${t.hp}`).join('/')}`, (battle, unit) => {
      allyAura(battle, unit, { key, select: (a) => isOp(a) && a.def?.raw?.nationId === nat, mods: (a) => best(a) });
    })] };
  }
  return { peak: true, effects: [E('F3.peak', `精力充沛 ${tiers.map((t) => `>${t.hp}`).join('/')}`, (battle, unit) => {
    toggle(battle, unit, key, () => !!best(unit), () => best(unit) ?? {});
  })] };
});
rule('F3.peakDouble', /^(?:生命值)?高于\d+(?:\.\d+)?%(?:时)?效果翻倍$/, (m, P) => (P.peakSeen ? { effects: [] } : null));

// ---- self drain: "自身生命会不断流失（该效果不会使生命降至0）" (interval + hp_ratio keys; non-lethal)
rule('F3.drain', /^自身生命会不断流失（该效果不会使生命降至0）$/, (m, P) => {
  const iv = P.values.key('interval'), r = P.values.key('hp_ratio');
  if (!(iv > 0) || !(r > 0)) return null;
  return { effects: [E('F3.drain', `每${iv}s流失${r}最大生命 (非致命)`, (battle, unit) => {
    battle.every(iv, () => {
      if (!up(unit)) return;
      const loss = unit.s.maxHp * r;
      if (unit.hp - loss >= 1) battle.loseHp(unit, loss, { source: unit, silent: true });
      else if (unit.hp > 1) unit.hp = 1;
    }, { owner: unit });
  })] };
});

// ---- F2 stacks over time on the field (洛洛, 塞雷娅): "每在场上停留N秒，STATS，最多(可以)?叠加M(次|层)"
rule('F2.stayStack', new RegExp(`^每在(?:场上|战场)?停留${N}秒，((?:[^，]+，)*?[^，]+)，最多(?:可以?)?叠加(\\d+|[一二三四五六七八九十])(?:次|层)$`), (m, P, ctx) => {
  const V = P.values;
  const t = V.flat(+m[1]) ?? +m[1], max = cnNum(m[3]);
  const sp = statPhrases(m[2], V);
  if (!sp || !(t > 0) || !(max > 0)) return null;
  const key = effKey(P, ctx.j());
  return { effects: [E('F2.stayStack', `每停留${t}s ${JSON.stringify(sp.mods)} ≤${max}层`, (battle, unit) => {
    battle.every(t, () => {
      if (!up(unit)) return;
      const n = Math.min(max, Math.floor((battle.time - unit.deployedAt + EPS) / t));
      const b = unit.findBuff(key);
      if (n > 0 && (!b || b.stacks !== n)) battle.addBuff(unit, { key, mods: sp.mods, refresh: 'stack', stacks: b ? n - b.stacks : n, maxStacks: max, tags: ['talent'] });
    }, { owner: unit });
  })] };
});

// ---- F2 deploy window decay (贝洛内): "获得A%的物理和法术闪避，部署后提高到B%并在T秒内逐渐衰减"
rule('F2.decay', new RegExp(`^获得${N}%的(物理和法术|物理|法术)闪避，部署后提高到${N}%并在${N}秒内逐渐衰减$`), (m, P, ctx) => {
  const V = P.values;
  const peak = V.pct(+m[3]), t = V.flat(+m[4]) ?? +m[4];
  // the resting value is init_prob − trig_cnt × dec_prob (贝洛内: 0.8 − 20 × 0.02 = 40 %), else a value of its own
  const ip = V.key('init_prob'), tc = V.key('trig_cnt'), dp = V.key('dec_prob');
  const derived = ip !== undefined && tc !== undefined && dp !== undefined ? ip - tc * dp : undefined;
  const rest = derived !== undefined && Math.abs(derived * 100 - +m[1]) < 0.5 + EPS ? derived : V.pct(+m[1]);
  if (rest === undefined || peak === undefined) return null;
  const key = effKey(P, ctx.j());
  const ks = m[2] === '物理' ? ['dodgePhys'] : m[2] === '法术' ? ['dodgeArts'] : ['dodgePhys', 'dodgeArts'];
  const mk = (v) => Object.fromEntries(ks.map((k) => [k, v]));
  return { effects: [E('F2.decay', `闪避 ${peak}→${rest} / ${t}s`, (battle, unit) => {
    toggle(battle, unit, key, () => true, () => mk(rest + (peak - rest) * Math.max(0, Math.min(1, 1 - (battle.time - unit.deployedAt) / t))));
  })] };
});

// ---- F9 SP rules
rule('F9.periodic', new RegExp(`^(?:在场时)?每${N}秒(?:额外)?(?:回复|获得)${N}点技力(?:，有${N}%(?:的)?(?:几率|概率)额外回复${N}点技力)?$`), (m, P) => {
  const V = P.values;
  const iv = V.flat(+m[1]) ?? +m[1], sp = V.flat(+m[2]);
  const p = m[3] ? V.pct(+m[3]) : 0, sp2 = m[4] ? V.flat(+m[4]) : 0;
  if (sp === undefined || p === undefined || sp2 === undefined) return null;
  return { effects: [E('F9.periodic', `每${iv}s +${sp}SP${p ? ` (p${p} +${sp2})` : ''}`, (battle, unit) => {
    battle.every(iv, () => {
      if (!up(unit)) return;
      giveSp(unit, sp);
      if (p > 0 && battle.rng.chance(p)) giveSp(unit, sp2);
    }, { owner: unit });
  })] };
});
rule('F9.team', new RegExp(`^在场时每${N}秒回复全场友方角色${N}点攻击\\/受击技力(?:，自身额外回复${N}点技力)?$`), (m, P) => {
  const V = P.values;
  const iv = V.flat(+m[1]) ?? +m[1], sp = V.flat(+m[2]), self = m[3] ? V.flat(+m[3]) : 0;
  if (sp === undefined || self === undefined) return null;
  return { effects: [E('F9.team', `每${iv}s 全场攻击/受击技力+${sp}${self ? ` 自身+${self}` : ''}`, (battle, unit) => {
    battle.every(iv, () => {
      if (!up(unit)) return;
      for (const a of battle.alliesFor(unit)) if (a.skill && (a.skill.spType === 'attack' || a.skill.spType === 'hurt')) giveSp(a, sp);
      if (self > 0) giveSp(unit, self);
    }, { owner: unit });
  })] };
});
rule('F9.deployRandom', new RegExp(`^部署后立即随机获得${N}~${N}点技力$`), (m, P) => {
  const V = P.values;
  const lo = V.key('sp_min') ?? +m[1], hiK = V.key('sp_max');
  // the official sp_max is exclusive when it is one above the text's upper bound (艾雅法拉: 7~15, sp_max 16)
  const hi = hiK !== undefined ? (hiK === +m[2] + 1 ? hiK - 1 : hiK) : +m[2];
  return { effects: [E('F9.deploy', `部署 +${lo}~${hi}SP`, (battle, unit) => {
    battle.on('deploy', (c) => { if (c.unit === unit) giveSp(unit, lo + battle.rng.int(Math.max(1, Math.floor(hi - lo) + 1)), 'deploy'); }, { owner: unit });
  })] };
});
rule('F9.hurtProb', new RegExp(`^受到攻击时，有${N}%(?:的)?(?:几率|概率)回复${N}点技力$`), (m, P) => {
  const V = P.values;
  const p = V.pct(+m[1]), sp = V.flat(+m[2]);
  if (p === undefined || sp === undefined) return null;
  return { effects: [E('F9.hurt', `受击 p${p} +${sp}SP`, (battle, unit) => {
    battle.on('damaged', (c) => {
      if (c.target !== unit || !c.source || c.source.side !== 'enemy' || !c.dmg || !c.dmg.isAttack) return;
      if (battle.rng.chance(p)) giveSp(unit, sp);
    }, { owner: unit });
  })] };
});
rule('F9.attackProb', new RegExp(`^攻击时有${N}%的?(?:几率|概率)获得${N}点技力(?:，生命低于${N}%时概率变为${N}%)?$`), (m, P) => {
  const V = P.values;
  const p = V.pct(+m[1]), sp = V.flat(+m[2]);
  const hp = m[3] ? (V.pct(+m[3]) ?? +m[3] / 100) : null, p2 = m[4] ? V.pct(+m[4]) : null;
  if (p === undefined || sp === undefined || (m[4] && p2 === undefined)) return null;
  return { effects: [E('F9.attack', `攻击 p${p}${p2 != null ? `/${p2}` : ''} +${sp}SP`, (battle, unit) => {
    battle.on('attack', (c) => {
      if (c.attacker !== unit || !(c.targets || []).some((t) => t && t.side === 'enemy')) return;
      if (battle.rng.chance(hp != null && unit.hpRatio < hp - EPS ? p2 : p)) giveSp(unit, sp);
    }, { owner: unit });
  })] };
});
rule('F9.skillKill', new RegExp(`^若[^，]{0,8}?释放一次技能击倒不少于一个敌人，则回复${N}点技力(?:，未击倒敌人时变为回复${N}点技力)?$`), (m, P) => {
  const V = P.values;
  const sp = V.flat(+m[1]), miss = m[2] ? V.flat(+m[2]) : 0;
  if (sp === undefined || miss === undefined) return null;
  return { effects: [E('F9.skillKill', `技能击倒 +${sp}SP${miss ? ` / 否则+${miss}` : ''}`, (battle, unit) => {
    let kills = 0, on = false, act = -1;
    battle.on('skillStart', (c) => { if (c.unit === unit) { kills = 0; on = true; act = unit.skill.activations; } }, { owner: unit });
    battle.on('kill', (c) => { if (on && c.killer === unit) kills++; }, { owner: unit });
    const decide = (a) => {
      if (!on || a !== act) return;
      on = false;
      const n = kills > 0 ? sp : miss;
      if (n > 0 && up(unit)) giveSp(unit, n);
    };
    // a timed skill decides at its end; an instant one (its skill attack) 0.5 s later, when its shots have landed
    battle.on('skillEnd', (c) => {
      if (c.unit !== unit || c.reason === 'death') { if (c.unit === unit) on = false; return; }
      const a = act;
      if (unit.skill && !unit.skill.isTimed) battle.after(0.5, () => decide(a), { owner: unit }); else decide(a);
    }, { owner: unit });
  })] };
});

// ---- F10 counter while holding the own shield (斥罪): "拥有来源于自身的屏障时，每次受到攻击对目标造成相当于X攻击力N%的Y伤害"
rule('F10.shieldCounter', new RegExp(`^拥有来源于自身的屏障时，每次受到攻击对目标造成相当于[^，]{0,8}?攻击力${N}%的(物理|法术|真实)伤害$`), (m, P) => {
  const v = P.values.pct(+m[1]);
  if (v === undefined) return null;
  const type = dmgTypeOf(m[2]);
  return { effects: [E('F10.shieldCounter', `有自身屏障时反击 ${v}攻击力`, (battle, unit) => {
    battle.on('hit', (c) => {
      if (c.target !== unit || !c.source || c.source.side !== 'enemy' || !c.dmg.isAttack || !up(unit)) return;
      if (!unit.buffs.some((b) => b.shield > 0 && (b.source === unit || b.data?.selfShield))) return;
      const src = c.source;
      battle.after(0, () => { if (hasHp(src)) battle.dealDamage(unit, src, { amount: unit.s.atk * v, type, canDodge: false, tags: ['talent', 'counter'] }); }, { owner: unit });
    }, { owner: unit });
  })] };
});

// ---- F10 damage from non-blocked / blocked sources: "阻挡时，受到来自非自身阻挡敌人的(物理和法术)?伤害降低N%" / "受到来自自身阻挡单位的伤害降低N%"
rule('F10.blockGuard', new RegExp(`^(?:阻挡时，)?受到来自(非)?自身阻挡(?:敌人|单位)的(物理和法术|物理|法术)?伤害降低${N}%$`), (m, P) => {
  const v = P.values.pct(+m[3]);
  if (v === undefined) return null;
  const non = !!m[1], w = m[2] || '';
  const types = /物理/.test(w) && /法术/.test(w) ? ['phys', 'arts'] : w === '物理' ? ['phys'] : w === '法术' ? ['arts'] : null;
  return { effects: [E('F10.blockGuard', `${non ? '非' : ''}阻挡来源伤害×${1 - v}`, (battle, unit) => {
    battle.on('hit', (c) => {
      const s = c.source;
      if (c.target !== unit || !s || s.side !== 'enemy' || (types && !types.includes(c.dmg.type))) return;
      if (non ? !(unit.blocking.length > 0 && s.blockedBy !== unit) : s.blockedBy !== unit) return;
      c.dmg.mul *= 1 - v;
    }, { owner: unit });
  })] };
});

// ---- F10 redeploy time: "(自身)?再部署时间-N秒(且不提高部署费用)?" (the engine never raises a redeploy's cost)
rule('F10.redeploy', new RegExp(`^(?:自身)?再部署时间-${N}秒(?:且不提高部署费用)?$`), (m, P) => {
  const v = P.values.flat(+m[1]);
  if (v === undefined) return null;
  return { effects: [E('F10.redeploy', `再部署时间-${v}s`, (battle, unit) => {
    if (unit.mem.gtRespawnCut) return;
    unit.mem.gtRespawnCut = true;
    unit.base.respawnTime = Math.max(0, unit.base.respawnTime - v);
  })] };
});

// ---- F10 melee-only layer (薇薇安娜#1): "攻击精英或领袖敌人时，有N%概率获得一层仅抵挡近战攻击的护盾（最多1层）"
rule('F10.meleeShield', new RegExp(`^攻击${TGT}时，有${N}%(?:的)?(?:几率|概率)获得一层仅抵挡近战攻击的护盾（最多1层）$`), (m, P, ctx) => {
  const V = P.values;
  const tc = targetCond(m[1], V), p = V.pct(+m[2]);
  if (!tc || p === undefined) return null;
  const key = effKey(P, ctx.j());
  return { effects: [E('F10.meleeShield', `攻击${tc.label} p${p} 近战护盾`, (battle, unit) => {
    battle.on('damaged', (c) => {
      if (c.source !== unit || !isMainHit(c.dmg) || !c.target || c.target.side !== 'enemy' || !tc.test(battle, unit, c.target)) return;
      if (!unit.findBuff(key) && battle.rng.chance(p)) battle.addBuff(unit, { key, visible: true, tags: ['talent'] });
    }, { owner: unit });
    battle.on('hit', (c) => {
      if (c.target !== unit || !c.source || c.source.side !== 'enemy' || !c.dmg.isAttack || c.source.def?.applyWay === 'RANGED') return;
      if (!unit.findBuff(key)) return;
      battle.removeBuff(unit, key);
      c.dmg.cancel = true;
    }, { owner: unit, priority: 10 });
  })] };
});

// ---- deploy / skill-start bursts
rule('F10.deployStun', new RegExp(`^部署后立即对攻击范围内一个敌人[^，]{0,8}?，使其和周围敌人晕眩${N}秒$`), (m, P) => {
  const d = P.values.flat(+m[1]);
  if (d === undefined) return null;
  return { effects: [E('F10.deployStun', `部署时晕眩 ${d}s (目标+周围)`, (battle, unit) => {
    const fire = () => {
      const t = enemiesInRange(battle, unit)[0];
      if (!t) return false;
      // [ASSUMED] 周围 = within 1 tile of the target (the flash's radius is not in the data)
      for (const e of battle.foesInRadius(t.x, t.y, 1.2, true)) battle.applyStatus(e, 'stun', { duration: d, source: unit });
      battle.fx('aoe', { x: t.x, y: t.y, radius: 1.2, id: unit.id });
      return true;
    };
    // "部署后立即": at the deployment, or the first moment an enemy is in range during this deployment [ASSUMED]
    battle.on('deploy', (c) => {
      if (c.unit !== unit) return;
      const seq = unit.deploySeq;
      if (fire()) return;
      battle.every(0.1, (b, sc) => { if (!up(unit) || unit.deploySeq !== seq || fire()) sc.cancel(); }, { owner: unit });
    }, { owner: unit });
  })] };
});
rule('F10.skillStartBurst', new RegExp(`^开启技能时，(?:使攻击范围内所有(地面)?地块落雷，)?对(?:攻击范围内)?所有敌人造成相当于攻击力${N}%的(物理|法术|真实)伤害(?:和${N}秒(战栗|晕眩|停顿|寒冷))?$`), (m, P) => {
  const V = P.values;
  const r = V.pct(+m[2]);
  const d = m[4] ? (V.flat(+m[4]) ?? +m[4]) : 0;
  if (r === undefined) return null;
  const ground = !!m[1], type = dmgTypeOf(m[3]), st = m[5] ? STATUS_WORDS[m[5]] : null;
  return { effects: [E('F10.skillStartBurst', `开启技能 范围内${r}攻击力${st ? ` +${st}${d}s` : ''}`, (battle, unit) => {
    battle.on('skillStart', (c) => {
      if (c.unit !== unit) return;
      for (const e of enemiesInRange(battle, unit, ground ? { canHitFly: false } : {})) {
        if (ground && e.isFlying) continue;
        battle.dealDamage(unit, e, { amount: unit.s.atk * r, type, isSkill: false, canDodge: false, tags: ['talent', 'burst'] });
        if (st && hasHp(e)) battle.applyStatus(e, st, { duration: d, source: unit });
      }
    }, { owner: unit });
  })] };
});

// ---- DP: 行商 trait payment (老鲤#1): "特性消耗费用时，若费用足够则改为消耗N费用，抵消自身受到的下一次晕眩/冻结，并使攻击来源晕眩T秒"
rule('F9.merchant', new RegExp(`^特性消耗费用时，若费用足够则改为消耗${N}费用，抵消自身受到的下一次晕眩\\/冻结，并使攻击来源晕眩${N}秒$`), (m, P, ctx) => {
  const V = P.values;
  const cost = V.flat(+m[1]), stun = V.flat(+m[2]);
  if (cost === undefined || stun === undefined) return null;
  const key = effKey(P, ctx.j());
  return { effects: [E('F9.merchant', `行商付费改为${cost}DP + 抵消晕眩/冻结 + 反晕${stun}s`, (battle, unit) => {
    battle.on('merchantPay', (c) => {
      if (c.unit !== unit || c.cancel) return;
      const pl = battle.getPlayer(unit.ownerId);
      if (!pl || pl.dp + EPS < cost) return; // "若费用足够": else the trait's own payment
      c.cost = cost;
      battle.addBuff(unit, { key, visible: true, tags: ['talent'] });
    }, { owner: unit });
    battle.on('beforeStatus', (c) => {
      if (c.target !== unit || (c.status !== 'stun' && c.status !== 'freeze') || !unit.findBuff(key)) return;
      battle.removeBuff(unit, key);
      c.cancel = true;
      const s = c.source;
      if (s && s.side === 'enemy' && s.alive) battle.applyStatus(s, 'stun', { duration: stun, source: unit });
    }, { owner: unit });
  })] };
});

// ---- DP: "部署后，下一名部署的干员费用-N" (琴柳#1): the next operator of the player deployed after the unit pays N less
rule('F9.nextDeployCost', new RegExp(`^部署后，下一名部署的干员(?:部署)?费用-${N}$`), (m, P) => {
  const v = P.values.flat(+m[1]);
  if (v === undefined) return null;
  return { effects: [E('F9.nextDeployCost', `下一名部署干员费用-${v}`, (battle, unit) => {
    // after each deployment of the unit, every other operator of the player waiting to (re)deploy carries the cut (its
    // base.cost — Battle._checkRedeploys pays it) until one of them deploys; then the others get their cost back.
    // [ASSUMED] the initial deployment counts as a deployment: when the next operator comes in with it (free anyway), the
    // cut is used up — the unit deployed last at the start gives it to the first paid redeploy.
    let pending = false;
    const waiting = (a) => a !== unit && isOp(a) && a.ownerId === unit.ownerId && !a.alive && !a.removed;
    const cut = (a) => {
      if (!waiting(a) || a.mem.gtNextCut != null) return;
      const d = Math.min(v, a.base.cost);
      a.mem.gtNextCut = d;
      a.base.cost -= d;
    };
    const restore = () => {
      for (const a of battle.allyUnits) if (a.mem.gtNextCut != null) { a.base.cost += a.mem.gtNextCut; a.mem.gtNextCut = null; }
    };
    battle.on('deploy', (c) => {
      const u = c.unit;
      if (u === unit) {
        pending = true;
        restore();
        for (const a of battle.allyUnits) cut(a);
        return;
      }
      if (!pending || !isOp(u) || u.ownerId !== unit.ownerId) return;
      pending = false; // used by this deployment (the payment happened before the deploy hook)
      restore();
    }, { owner: unit, priority: 20 });
    battle.on('death', (c) => { if (pending) cut(c.unit); }, { owner: unit });
  })] };
});

// ---- DP: "撤退时返还大量该次部署费用" (executor modules: withdraw_cost_recover_ratio of the deployment's cost back on a retreat)
rule('F9.retreatRefund', /^撤退时返还(?:大量|部分)?该次部署费用$/, (m, P) => {
  const r = P.values.key('withdraw_cost_recover_ratio');
  if (!(r > 0)) return null;
  return { effects: [E('F9.retreatRefund', `撤退返还${r}×部署费用`, (battle, unit) => {
    // only a retreat (no knock-out, no 'expired' / 'forcedExit'): nothing in the auto battle retreats an operator by choice,
    // but content may (battle.retreat default reason) — then the DP comes back
    battle.on('death', (c) => { if (c.unit === unit && c.reason === 'retreat') battle.addDp(unit.ownerId, unit.base.cost * r); }, { owner: unit });
  })] };
});
// ---- module "攻击范围扩大" (夜莺 / Pith): the selected module's own range (its data-only talent change, talentIndex −1)
//      replaces the unit's range from the start — as the pool kits (kits/tier4.js moduleRangeGrid)
rule('X.moduleRange', /^攻击范围扩大$/, (m, P) => {
  if (!P.module) return null;
  return { effects: [E('X.moduleRange', '模组攻击范围', (battle, unit) => {
    const mod = unit.def?.raw?.module;
    if (!mod || !mod.active || !mod.id) return;
    const rec = (unit.def.raw.modules || []).find((x) => x && x.uniEquipId === mod.id);
    const g = (rec?.talentChanges || []).map((t) => t && t.rangeGrid).find((x) => Array.isArray(x) && x.length);
    if (!g) return;
    unit.rangeGrid = g.map((p) => (Array.isArray(p) ? [p[0], p[1]] : [p.row, p.col]));
    if (unit.deployed) battle.refreshRange(unit);
  })] };
});
// ---- extra 元素伤害 vs a bursting target (薇薇安娜 module): "攻击X损伤爆发期间的目标时额外造成攻击力N%的元素伤害"
rule('F5.extraBurst', new RegExp(`^攻击(神经|灼燃|凋亡|侵蚀)损伤爆发期间的(?:目标|敌人)时额外造成攻击力${N}%的元素伤害$`), (m, P) => {
  const v = P.values.pct(+m[2]);
  if (v === undefined) return null;
  const el = ELEMENTS[m[1]];
  return { effects: [E('F5.extraBurst', `${m[1]}爆发中额外${v}攻击力元素伤害`, (battle, unit) => {
    battle.on('damaged', (c) => {
      const t = c.target;
      if (c.source !== unit || !isMainHit(c.dmg) || !hasHp(t) || t.side !== 'enemy' || !burstOn(t, el)) return;
      battle.dealDamage(unit, t, { amount: unit.s.atk * v, type: 'elemental', element: el, canDodge: false, tags: ['talent', 'extra'] });
    }, { owner: unit });
  })] };
});
// ---- SP on a normal attack hitting an elite / leader (modules): "普通攻击命中精英或领袖敌人时获得N点技力"
rule('F9.hitElite', new RegExp(`^普通攻击命中${TGT}时获得${N}点技力$`), (m, P) => {
  const tc = targetCond(m[1], P.values), sp = P.values.flat(+m[2]);
  if (!tc || sp === undefined) return null;
  return { effects: [E('F9.hitElite', `普攻命中${tc.label} +${sp}SP`, (battle, unit) => {
    let last = -1;
    battle.on('damaged', (c) => {
      if (c.source !== unit || !c.dmg || !c.dmg.isAttack || c.dmg.isSkill || !c.target || c.target.side !== 'enemy' || !tc.test(battle, unit, c.target)) return;
      if (c.dmg.attackId === last) return; // once per attack
      last = c.dmg.attackId;
      giveSp(unit, sp);
    }, { owner: unit });
  })] };
});
// ---- damage vs a target (modules): "对X(造成的)?伤害提升至N%"
rule('F4.dmgVs', new RegExp(`^对${TGT}(?:造成的)?伤害提升至${N}%$`), (m, P) => {
  const tc = targetCond(m[1], P.values), v = P.values.pct(+m[2]);
  if (!tc || v === undefined) return null;
  return { effects: [E('F4.dmgVs', `对${tc.label}伤害×${v}`, (battle, unit) => {
    battle.on('hit', (c) => { if (c.source === unit && c.target?.side === 'enemy' && tc.test(battle, unit, c.target)) c.dmg.mul *= v; }, { owner: unit });
  })] };
});
// ---- undying once per deployment: "被击倒时不撤退(且|，)(回复|恢复)(所有|N%)生命(但/且 STATS)?（单次部署只触发1次）"
rule('F10.undying', new RegExp(`^被击倒时不撤退(?:且|，)(?:回复|恢复)(所有|${N}%(?:的)?)生命(?:值)?((?:(?:但|且|，)[^（]+)*)（单次部署只触发(?:1|一)次）$`), (m, P, ctx) => {
  const V = P.values;
  const r = m[1] === '所有' ? 1 : V.pct(+m[2]);
  if (r === undefined) return null;
  let mods = null;
  if (m[3]) {
    const parts = m[3].split(/但|且|，|、/).map((x) => x.trim()).filter(Boolean);
    mods = {};
    for (const x of parts) { const sp = statPhrase(x, V); if (!sp) return null; addMods(mods, sp.mods); }
  }
  const key = effKey(P, ctx.j());
  return { effects: [E('F10.undying', `不屈 回复${r}${mods ? ' ' + JSON.stringify(mods) : ''}`, (battle, unit) => {
    battle.on('fatal', (c) => {
      if (c.unit !== unit || c.prevented || unit.mem[key] === unit.deploySeq) return;
      unit.mem[key] = unit.deploySeq;
      c.prevented = true;
      unit.hp = Math.max(1, unit.hp);
      if (mods) battle.addBuff(unit, { key, mods, visible: true, tags: ['talent'] });
      battle.heal(unit, unit, unit.s.maxHp * r, { self: true, ignoreHealFree: true });
      battle.fx('buff', { x: unit.x, y: unit.y, id: unit.id, kind: 'undying' });
    }, { owner: unit });
  })] };
});
// ---- 行商 stacks (老鲤 module): "每次特性消耗费用时攻击力+N%，最多可以叠加M次"
rule('F9.merchantStack', new RegExp(`^每次特性消耗费用时${STAT_RE}\\+${N}(%)?，最多(?:可以)?叠加(\\d+|[一二三四五六七八九十])次$`), (m, P, ctx) => {
  const mods = statMods(statKind(m[1]), 1, +m[2], !!m[3], P.values);
  const max = cnNum(m[4]);
  if (!mods) return null;
  const key = effKey(P, ctx.j());
  return { effects: [E('F9.merchantStack', `行商付费时 ${JSON.stringify(mods)} ≤${max}`, (battle, unit) => {
    // after the payment (merchantPay runs before it; a cancelled or unaffordable payment adds nothing)
    battle.on('merchantPay', (c) => {
      if (c.unit !== unit || c.cancel) return;
      const pl = battle.getPlayer(unit.ownerId);
      const cost = Number.isFinite(c.cost) ? c.cost : 0;
      if (!pl || pl.dp + EPS < cost) return;
      battle.addBuff(unit, { key, mods, refresh: 'stack', stacks: 1, maxStacks: max, tags: ['talent'] });
    }, { owner: unit, priority: -50 });
  })] };
});
// ---- module attributes already in the stats: "再部署时间减少" / "部署费用减少" (the module's attr: respawnTime / cost)
rule('X.moduleAttr', /^(?:再部署时间减少|部署费用减少)$/, () => ({ effects: [E('X.moduleAttr', '模组属性 (stats)', () => {})] }));

// ---- DP: first-deployment cost cuts — no battle effect (the initial deployment is free; kits/tier1.js 嵯峨, tier3.js 忍冬)
rule('X.firstDeployCost', new RegExp(`^首次部署时部署费用-${N}$`), () => ({ effects: [E('X.firstDeployCost', '首次部署费用- (初始部署免费：无战斗效果)', () => {})] }));
rule('X.costFloor', new RegExp(`^部署费用下限降低${N}$`), () => ({ effects: [], dropped: ['部署费用下限 (no deploy-cost floor in the battle engine)'] }));
rule('X.flag', /^部署时自身持有军旗$/, () => ({ effects: [] }));

// ---- summons (token mode) -----------------------------------------------------------------------------------------
// "被击倒后（不包括撤退）使周围8格内所有敌人晕眩N秒并对其造成M点真实伤害" (Mon3tr 不毁重构; elite "生命值首次低于50%和…")
rule('F10.deathBurst', new RegExp(`^(?:在?生命值首次低于${N}%和)?被击倒后（不包括撤退）使周围(?:8|八)格内所有敌人晕眩${N}秒并对其造成${N}点(真实|物理|法术)伤害$`), (m, P) => {
  const V = P.values;
  const firstBelow = m[1] ? (V.pct(+m[1]) ?? +m[1] / 100) : null;
  const st = V.flat(+m[2]) ?? +m[2], dmg = V.flat(+m[3]) ?? +m[3];
  const type = dmgTypeOf(m[4]);
  const burst = (battle, unit) => {
    for (const e of battle.foesInRadius(unit.x, unit.y, 1.5)) {
      battle.applyStatus(e, 'stun', { duration: st, source: unit });
      if (hasHp(e)) battle.dealDamage(unit, e, { amount: dmg, type, canDodge: false, tags: ['talent', 'burst'] });
    }
    battle.fx('aoe', { x: unit.x, y: unit.y, radius: 1.5, id: unit.id });
  };
  return { effects: [E('F10.deathBurst', `被击倒时周围晕眩${st}s + ${dmg}${type}${firstBelow ? ` (+首次<${firstBelow})` : ''}`, (battle, unit) => {
    battle.on('death', (c) => { if (c.unit === unit && c.reason === 'killed') burst(battle, unit); }, { owner: unit, priority: 20 });
    if (firstBelow) {
      battle.on('damaged', (c) => {
        if (c.target !== unit || !unit.alive || unit.mem.gtBurstSeq === unit.deploySeq || unit.hpRatio >= firstBelow) return;
        unit.mem.gtBurstSeq = unit.deploySeq;
        burst(battle, unit);
      }, { owner: unit });
    }
  })] };
});
// "不在X攻击范围内时防御力降至0" (Mon3tr): DEF ×0 while the summon stands outside its owner's range (or the owner is down)
rule('F2.outsideOwner', /^(?:[^，]{0,6}?)不在[^，]{1,8}?攻击范围内时防御力降至0$/, (m, P, ctx) => {
  if (!P.token) return null;
  const key = effKey(P, ctx.j());
  return { effects: [E('F2.outsideOwner', '召唤者攻击范围外防御力0', (battle, unit) => {
    toggle(battle, unit, key, () => { const o = unit.ownerUnit; return !(up(o) && rangeSet(o).has(tileKey(unit))); }, { defMul: 0 });
  })] };
});
rule('X.healedBy', /^可以被[^，]{1,8}?治疗$/, (m, P) => (P.token ? { effects: [] } : null));
// "(同时)?每秒流失N%的最大生命" (夜莺's 幻影): a lethal drain — the summon's lifetime
rule('F3.tokenDrain', new RegExp(`^(?:同时)?每秒流失${N}%的最大生命(?:值)?$`), (m, P) => {
  const r = P.values.pct(+m[1]);
  if (r === undefined) return null;
  return { effects: [E('F3.tokenDrain', `每秒流失${r}最大生命`, (battle, unit) => {
    battle.every(1, () => { if (up(unit)) battle.loseHp(unit, unit.s.maxHp * r, { source: unit, silent: true }); }, { owner: unit });
  })] };
});
// "攻击时会将目标(小|中等|大)力度地推开" (温蒂's 蓄水炮)
rule('F6.push', /^攻击时会将目标(微小|小|中等|较大|大)力度地推开$/, (m) => {
  const force = { 微小: -1, 小: 0, 中等: 1, 较大: 2, 大: 3 }[m[1]];
  return { effects: [E('F6.push', `攻击推开 力度${force}`, (battle, unit) => {
    battle.on('damaged', (c) => {
      if (c.source !== unit || !isMainHit(c.dmg) || !hasHp(c.target) || c.target.side !== 'enemy') return;
      battle.push(c.target, force, { from: unit });
    }, { owner: unit });
  })] };
});
// "部署后持续N秒" / "…，持续N秒" of a summon: its lifetime is content/tokens.js's (generic summons), marked here
rule('X.lifetime', new RegExp(`^(?:部署后)?持续${N}秒$`), (m, P) => (P.token ? { effects: [E('X.lifetime', `持续${m[1]}s (tokens.js)`, () => {})] } : null));
// "在X周围4格内时令其每N秒获得M点技力" (温蒂's 蓄水炮): the owner gains SP while its summon stands next to it
rule('F9.nearOwnerSp', new RegExp(`^(?:且)?在[^，]{1,8}?周围(?:4|四)格内时令其每${N}秒获得${N}点技力$`), (m, P) => {
  const V = P.values;
  const iv = V.flat(+m[1]) ?? +m[1], sp = V.flat(+m[2]) ?? +m[2];
  if (!P.token) return null;
  return { effects: [E('F9.nearOwnerSp', `召唤者在周围4格时每${iv}s +${sp}SP`, (battle, unit) => {
    battle.every(iv, () => {
      const o = unit.ownerUnit;
      if (up(unit) && up(o) && manh(unit, o) <= 1) giveSp(o, sp);
    }, { owner: unit });
  })] };
});
// "使攻击范围内一名友方干员的STAT(，持续时间无限)" (白铁's 平台): the operator in range with the highest ATK [ASSUMED]
rule('F7.oneAlly', /^使攻击范围内一名友方干员(?:的)?([^，]+?)(?:，持续时间无限)?$/, (m, P, ctx) => {
  const sp = statPhrases(m[1], P.values);
  if (!sp) return null;
  const key = effKey(P, ctx.j());
  return { effects: [E('F7.oneAlly', `范围内一名干员 ${JSON.stringify(sp.mods)}`, (battle, unit) => {
    battle.every(0.5, () => {
      if (!up(unit)) return;
      const set = rangeSet(unit);
      const best = battle.alliesFor(unit).filter((a) => isOp(a) && set.has(tileKey(a))).sort((a, b) => b.s.atk - a.s.atk || a.deploySeq - b.deploySeq)[0];
      if (best) battle.addBuff(best, { key, mods: sp.mods, duration: 0.6, source: unit, tags: ['talent', 'aura'] });
    }, { owner: unit, immediate: true });
  })] };
});

/** Try the specific rules at the start of `rest`. Returns { effects, dropped, consumed (clauses), more } or null. */
function trySpecific(rest, P, ctx) {
  for (const r of RULES) {
    const m = rest.match(r.re);
    if (!m) continue;
    // the match must end at a clause boundary
    const len = m[0].length;
    if (len < rest.length && rest[len] !== '，') continue;
    let out;
    try { out = r.build(m, P, ctx); } catch { out = null; }
    if (!out) continue;
    if (out.peak) P.peakSeen = true;
    const consumed = rest.slice(0, len).split('，').length;
    return { ...out, consumed, rule: r.id };
  }
  return null;
}

// =================================================================================================================
// event effects ("部署后立即获得17技力", "击杀敌人时额外获得1点部署费用", "受到伤害后，攻击力+12%，持续15秒" …)

/** Effects allowed under an event condition. Returns { effect } or null. */
function eventEffect(clause, P, cond, dur, j) {
  const V = P.values;
  const ev = cond.event;
  let m;
  const hook = (battle, unit, fn) => installEvent(battle, unit, cond, fn);
  if (ev === 'heal' && (m = clause.match(new RegExp(`^(?:使其|使目标|为其)(?:额外)?(?:回复|获得)${N}(?:点)?技力$`)))) {
    const sp = V.flat(+m[1]);
    if (sp === undefined) return null;
    return E('F9.healSp', `治疗时 目标+${sp}SP`, (battle, unit) => hook(battle, unit, (c) => { if (c.target && c.target.skill) c.target.skill.gainSp(sp, 'talent'); }));
  }
  if ((m = clause.match(new RegExp(`^(?:立即)?(?:额外)?(?:回复|获得)${N}(?:点)?技力$`)))) {
    const sp = V.flat(+m[1]);
    if (sp === undefined) return null;
    return E('F9.event', `${cond.label} +${sp}SP`, (battle, unit) => hook(battle, unit, () => giveSp(unit, sp, ev)));
  }
  if ((m = clause.match(new RegExp(`^(?:额外)?获得${N}点部署费用$`)))) {
    const dp = V.flat(+m[1]);
    if (dp === undefined) return null;
    return E('F9.dp', `${cond.label} +${dp}DP`, (battle, unit) => hook(battle, unit, () => { battle.addDp(unit.ownerId, dp); battle.fx('dp', { x: unit.x, y: unit.y, n: dp, id: unit.id }); }));
  }
  if ((m = clause.match(new RegExp(`^(?:立即)?获得(?:相当于)?(?:生命上限|最大生命(?:值)?)${N}%的屏障(?:（最多不超过生命上限${N}%）)?$`)))) {
    const r = V.pct(+m[1]);
    const cap = m[2] ? V.pct(+m[2]) : null;
    if (r === undefined || cap === undefined) return null;
    return E('F10.shield', `${cond.label} 屏障 ${r}×生命上限${cap ? ` ≤${cap}` : ''}`, (battle, unit) => hook(battle, unit, () => {
      const key = `gt:shield:${unit.id}`;
      const cur = unit.findBuff(key);
      const add = unit.s.maxHp * r;
      const total = Math.min(cap != null ? unit.s.maxHp * cap : Infinity, (cur ? cur.shield : 0) + add);
      if (cur) { cur.shield = Math.max(cur.shield, total); unit.markDirty(); } else battle.addBuff(unit, { key, shield: total, visible: true, source: unit, tags: ['talent', 'shield'], data: { selfShield: true } });
    }));
  }
  if ((m = clause.match(new RegExp(`^(?:进入)?隐匿(?:状态)?${N}秒$`)))) {
    const d = V.flat(+m[1]) ?? +m[1];
    return E('F10.stealth', `${cond.label} 隐匿${d}s`, (battle, unit) => hook(battle, unit, () => battle.applyStatus(unit, 'stealth', { duration: d, source: unit })));
  }
  if ((m = clause.match(/^(?:立即)?获得(\d+|[一二三四五])层护盾$/))) {
    const n = cnNum(m[1]);
    const v = V.key('times') ?? n;
    return E('F10.layers', `${cond.label} ${v}层护盾`, (battle, unit) => hook(battle, unit, () => {
      battle.addBuff(unit, { key: `gt:layers:${unit.id}`, shieldHits: v, visible: true, refresh: 'replace', tags: ['talent', 'shield'] });
      unit.mem.gtLayers = v;
    }));
  }
  if ((m = clause.match(new RegExp(`^(?:立即)?(?:回复|恢复)(?:自身)?${N}%(?:的)?(?:最大)?生命(?:值)?$`)))) {
    const r = V.pct(+m[1]);
    if (r === undefined) return null;
    return E('F10.heal', `${cond.label} 回复${r}生命`, (battle, unit) => hook(battle, unit, () => battle.heal(unit, unit, unit.s.maxHp * r, { self: true })));
  }
  // timed stat buffs ("受到伤害后，攻击力+12%，持续15秒")
  const sp = statPhrases(clause, V);
  if (sp && dur > 0) {
    const key = effKey(P, j);
    return E('F2.event', `${cond.label} ${JSON.stringify(sp.mods)} ${dur}s`, (battle, unit) => hook(battle, unit, () => {
      battle.addBuff(unit, { key, mods: sp.mods, duration: dur, refresh: 'replace', tags: ['talent'], ...(sp.extra || {}) });
    }));
  }
  if (sp && ev === 'shieldBreak') {
    const key = effKey(P, j);
    return E('F10.layerBreak', `${cond.label} ${JSON.stringify(sp.mods)} 叠加`, (battle, unit) => hook(battle, unit, () => {
      battle.addBuff(unit, { key, mods: sp.mods, refresh: 'stack', stacks: 1, maxStacks: Math.max(1, V.key('max_stack_cnt') ?? 3), tags: ['talent'] });
    }));
  }
  return null;
}

/** Subscribe `fn` to the event of `cond` for `unit`. */
function installEvent(battle, unit, cond, fn) {
  const o = { owner: unit };
  switch (cond.event) {
    case 'deploy': {
      let done = false;
      battle.on('deploy', (c) => { if (c.unit === unit && !(cond.first && done)) { done = true; fn(c); } }, o);
      break;
    }
    case 'kill': battle.on('kill', (c) => { if (c.killer === unit && c.victim && c.victim.side === 'enemy') fn(c); }, o); break;
    case 'hurt': battle.on('damaged', (c) => { if (c.target === unit && c.amount > 0 && c.type !== 'element' && !isHpLoss(c.dmg) && unit.alive) fn(c); }, o); break;
    case 'attacked': battle.on('damaged', (c) => { if (c.target === unit && c.source && c.source.side === 'enemy' && c.dmg && c.dmg.isAttack && unit.alive) fn(c); }, o); break;
    case 'skillStart': battle.on('skillStart', (c) => { if (c.unit === unit) fn(c); }, o); break;
    case 'heal': battle.on('heal', (c) => { if (c.source === unit && c.target && c.target !== unit && c.target.kind !== 'device' && c.amount > 0) fn(c); }, { owner: unit, priority: -200 }); break;
    case 'enemyDownN4': battle.on('kill', (c) => { const v = c.victim; if (up(unit) && v && v.side === 'enemy' && manh(v, unit) <= 1) fn(c); }, o); break;
    case 'enemyDownRing': battle.on('kill', (c) => { const v = c.victim; if (up(unit) && v && v.side === 'enemy' && cheb(v, unit) <= 1) fn(c); }, o); break;
    case 'allyDownInRange': battle.on('death', (c) => {
      const d = c.unit;
      if (c.reason !== 'killed' || !up(unit) || !d || d === unit || !isOp(d) || d.ownerId !== unit.ownerId) return;
      if (rangeSet(unit).has(d.tileR * COLS + d.tileC)) fn(c);
    }, o); break;
    case 'periodic': battle.every(cond.interval, () => { if (up(unit)) fn(); }, o); break;
    case 'shieldBreak': battle.on('tick', () => {
      const b = unit.findBuff(`gt:layers:${unit.id}`);
      const now = b ? b.shieldHits : 0;
      const before = unit.mem.gtLayersSeen ?? unit.mem.gtLayers ?? 0;
      if (now < before && unit.alive) for (let i = 0; i < before - now; i++) fn();
      unit.mem.gtLayersSeen = now;
      if (unit.mem.gtLayers != null && now > before) unit.mem.gtLayersSeen = now;
    }, o); break;
    default: break;
  }
}

/** "仅一次" effects under a state condition: applied the first time it holds in each deployment (for `dur` s, else the deployment). */
function onceEffect(clause, P, cond, dur, j) {
  const V = P.values;
  let m = clause.match(new RegExp(`^(?:回复|恢复)${N}%的生命(?:值)?(?:并在${N}秒内使生命值不低于${N}%)?$`));
  if (m) {
    const r = V.pct(+m[1]);
    const lockT = m[2] ? (V.keyLike(/lock\]\.duration$|^duration$/) ?? +m[2]) : 0;
    const floor = m[3] ? V.pct(+m[3]) : 0;
    if (r === undefined || floor === undefined) return null;
    return E('F10.onceHeal', `${cond.label} 仅一次 回复${r}${lockT ? ` + ${lockT}s生命≥${floor}` : ''}`, (battle, unit) => {
      const key = effKey(P, j);
      const trig = () => {
        if (!up(unit) || unit.mem[key] === unit.deploySeq || !cond.test(battle, unit)) return;
        unit.mem[key] = unit.deploySeq;
        battle.heal(unit, unit, unit.s.maxHp * r, { self: true });
        if (lockT > 0) battle.addBuff(unit, { key, duration: lockT, visible: true, tags: ['talent'], data: { floor } });
      };
      battle.on('damaged', (c) => { if (c.target === unit) trig(); }, { owner: unit, priority: -5 });
      battle.on('fatal', (c) => {
        if (c.unit !== unit) return;
        const b = unit.findBuff(key);
        if (b) { c.prevented = true; unit.hp = Math.max(unit.hp, 1); }
      }, { owner: unit });
      battle.on('tick', () => {
        const b = unit.findBuff(key);
        if (b && unit.alive && unit.hpRatio < b.data.floor) unit.hp = unit.s.maxHp * b.data.floor;
      }, { owner: unit });
    });
  }
  const sp = statPhrases(clause.replace(/^获得/, '获得'), V);
  if (!sp) return null;
  return E('F2.once', `${cond.label} 仅一次 ${JSON.stringify(sp.mods)}${dur ? ` ${dur}s` : ''}`, (battle, unit) => {
    const key = effKey(P, j);
    const trig = () => {
      if (!up(unit) || unit.mem[key] === unit.deploySeq || !cond.test(battle, unit)) return;
      unit.mem[key] = unit.deploySeq;
      battle.addBuff(unit, { key, mods: sp.mods, duration: dur > 0 ? dur : Infinity, visible: true, tags: ['talent'], ...(sp.extra || {}) });
    };
    battle.on('damaged', (c) => { if (c.target === unit) trig(); }, { owner: unit });
    battle.on('tick', trig, { owner: unit });
  });
}

// =================================================================================================================
// the parse driver

/** Summon subjects: a clause about the unit's summons is not the unit's (§ header). */
function summonSubject(c, P) {
  if (P.token || /^(?:使)?自身/.test(c)) return false;
  if (/召唤(?:一|两|\d)?个|召唤物|生成一个/.test(c)) return true;
  if (/^(?:可以|可)(?:在[^，]{0,12}?)?(?:使用|携带|召唤|部署)/.test(c)) return true;
  const names = P.tokenNames;
  const re = /^(?:[^，]{0,4}?)(?:召唤物|无人机|装置|<支援装置>|机动盾牌|浮游单元|Mon3tr|虚影|幻影|“?打字机”?|蓄水炮|结构性原理|中继器|重构体|沙地兽|雷鸣地雷|共振装置|棋子|魂灵之影|悲叹的仆役|仆役|指挥中心|战术点|夜灯|海嗣)/;
  if (re.test(c) && !/^自身(?:与|和|及)(?:浮游单元)/.test(c)) return true;
  return names.some((n) => n && c.startsWith(n));
}

/** Resources / mechanics the engine does not model: a clause naming one is dropped. */
const UNMODELLED = /魔力|转置能量|攻击能量|能量|Fever|音符|麻痹层数|命中率|弹药|高台|水地形|弱点伤害|起飞|升空|阻挡范围|替身|S\.E\.E\.S|残影|琉璃璧|播种|浮泡|重伤|落雷|部署在近战位|部署位置|手动部署|待部署区|攻击方向|攻击范围的延伸|合成/;

/**
 * Parse one talent text. `P` = { values, keyBase, srcTag, token, tokenNames }. Returns { effects, dropped }.
 */
export function parseTalentText(text, P) {
  const effects = [], dropped = [];
  let j = 0;
  const nextJ = () => j++;
  P.peakSeen = false;
  const sents = sentences(text);
  for (let si = 0; si < sents.length; si++) {
    let sent = sents[si];
    // "…，持续N秒(（不可叠加）)" at the end of a sentence: the duration of its timed effect
    let dur = 0;
    const dm = sent.match(new RegExp(`，持续${N}秒(?:（(?:不可|无法)叠加）)?$`));
    if (dm && !/^攻击/.test(sent) && !/每秒受到/.test(sent) && !/造成治疗时/.test(sent)) { dur = P.values.flat(+dm[1]) ?? +dm[1]; sent = sent.slice(0, -dm[0].length); }
    sent = sent.replace(/，持续时间无限$/, '');
    const clauses = sent.split('，').filter(Boolean);
    // a stacking / scaling sentence ("最多叠加3次", "每有…", "越低…越强") is never a plain stat: its stat clauses are
    // only applied through a rule that models the stacking
    const scaling = /最多(?:可以?)?叠加|每有|每再|每当|每在|每个|越(?:高|低|多|远|强)/.test(sent);
    let cond = null;
    let scope = null;
    let once = false;
    const sentStart = effects.length;
    for (let i = 0; i < clauses.length;) {
      let c = clauses[i];
      // an unknown condition (or a mode-scoped "在集成战略中 / 在【…】中" — no effect in this mode [ASSUMED], owner
      // requirement 7) governs the rest of its sentence
      if (cond && cond.kind === 'unknown') { dropped.push({ clause: c, reason: `governed by the unknown condition "${cond.label}"` }); i++; continue; }
      if (UNMODELLED.test(c) && !/^攻击变为弱点伤害$/.test(c)) {
        dropped.push({ clause: c, reason: 'mechanic not modelled by the engine' });
        // a clause about an unmodelled resource / state also conditions what follows it ("有魔力时，攻击力+20%")
        cond = { kind: 'unknown', label: c };
        i++;
        continue;
      }
      if (/^攻击变为弱点伤害$/.test(c)) { dropped.push({ clause: c, reason: '弱点伤害 not modelled' }); i++; continue; }
      if (summonSubject(c, P)) {
        dropped.push({ clause: c, reason: 'summon subject (content/tokens.js generic summons)' });
        // the summon stays the subject of the rest of the sentence ("幻影无法攻击…，并且更容易吸引敌人的攻击")
        for (let k = i + 1; k < clauses.length; k++) dropped.push({ clause: clauses[k], reason: 'summon subject (content/tokens.js generic summons)' });
        break;
      }
      const ctx = { cond, j: nextJ, dur };
      let r = trySpecific(clauses.slice(i).join('，'), P, ctx);
      if (r) {
        effects.push(...r.effects);
        for (const d of r.dropped || []) dropped.push({ clause: d, reason: `${r.rule}: unparsed part` });
        i += r.consumed;
        continue;
      }
      // condition prefix (a leading 且 / 并 joins it to the previous clause)
      c = c.replace(/^(?:且|并且|并|但)(?=[^，]{2})/, (x) => (/^(?:且|并且|并)(?:自身|自己)/.test(c) ? x : ''));
      const pc = parseCond(c, P);
      if (pc && pc.unknown) {
        cond = { kind: 'unknown', label: pc.label };
        c = pc.rest;
        if (!c) { dropped.push({ clause: clauses[i], reason: `unknown condition "${pc.label}"` }); i++; continue; }
      } else if (pc) {
        if (pc.cond.kind === 'team' || pc.cond.kind === 'onField') {
          if (pc.cond.kind === 'team') scope = { ...(scope || {}), team: true, pendingTeam: true };
        } else {
          cond = pc.cond.kind === 'state' && cond && cond.kind === 'state' ? andCond(cond, pc.cond) : pc.cond;
          if (pc.cond.team) scope = { ...(scope || {}), team: true, pendingTeam: true };
        }
        c = pc.rest;
        if (!c) { i++; continue; }
        r = trySpecific([c, ...clauses.slice(i + 1)].join('，'), P, { cond, j: nextJ, dur });
        if (r) {
          effects.push(...r.effects);
          for (const d of r.dropped || []) dropped.push({ clause: d, reason: `${r.rule}: unparsed part` });
          i += r.consumed;
          continue;
        }
      }
      if (cond && cond.kind === 'unknown') { dropped.push({ clause: clauses[i], reason: `governed by the unknown condition "${cond.label}"` }); i++; continue; }
      // 仅一次
      if (/^仅一次/.test(c)) { once = true; c = c.replace(/^仅一次/, ''); }
      // doubling: "(该)?效果翻倍" / "该效果提升至N倍" (the effects of this talent so far, under the condition)
      const dbl = c.match(/^(?:该)?效果(?:翻倍|提升至(\d+)倍)$/);
      if (dbl) {
        const k = (dbl[1] ? +dbl[1] : 2) - 1;
        const base = effects.filter((e) => e.statSpec);
        if (!cond || cond.kind !== 'state' || !base.length) { dropped.push({ clause: clauses[i], reason: cond && cond.kind !== 'state' ? 'doubling under an unsupported condition' : 'nothing to double' }); i++; continue; }
        for (const e of base) {
          const s = e.statSpec;
          const c2 = s.cond && s.cond.kind === 'state' ? andCond(s.cond, cond) : cond;
          const spec = { ...s, mods: scaleMods(s.mods, k), cond: c2, label: `${s.label} ×${k + 1} (${cond.label})` };
          const eff = statEffect(P, nextJ(), spec);
          effects.push(eff);
        }
        i++;
        continue;
      }
      // events
      if (cond && cond.kind === 'event') {
        const parts = splitEffects(c);
        let ok = parts.length > 0;
        const evs = [];
        for (const p of parts) { const e = eventEffect(p, P, cond, dur, nextJ()); if (!e) { ok = false; break; } evs.push(e); }
        if (ok) { effects.push(...evs); i++; continue; }
        dropped.push({ clause: clauses[i], reason: `no effect pattern under the event "${cond.label}"` });
        i++;
        continue;
      }
      if (once && cond && cond.kind === 'state') {
        const e = onceEffect(c, P, cond, dur, nextJ());
        if (e) { effects.push(e); i++; continue; }
        dropped.push({ clause: clauses[i], reason: 'no pattern for the once-only effect' });
        i++;
        continue;
      }
      const fac = c.match(/【([^】]+)】/);
      if (fac && !PROF[fac[1]] && !NATIONS[fac[1]]) { dropped.push({ clause: clauses[i], reason: `faction 【${fac[1]}】 has no id in the chess data` }); i++; continue; }
      // scope + stat phrases
      const ps = parseScope(c);
      if (ps && ps.scope.unknownFaction) { dropped.push({ clause: clauses[i], reason: `faction 【${ps.scope.unknownFaction}】 has no id in the chess data` }); i++; continue; }
      let sc = scope;
      if (ps) {
        sc = { ...ps.scope, team: !!(scope && scope.pendingTeam) || ps.scope.team };
        if (ps.scope.inheritAlly) {
          if (!scope || scope.kind !== 'allies') { dropped.push({ clause: clauses[i], reason: 'ally sub-area without a preceding area' }); i++; continue; }
          const base = scope, f = ps.scope.filter;
          sc = { ...base, label: `${base.label}/${ps.scope.label}`, select: (b, s, a) => base.select(b, s, a) && f(a) };
        } else if (ps.scope.inherit) {
          const g = scope && scope.geom;
          if (g === 'ring') sc = { kind: 'enemies', label: '周围敌人', pick: (b, s) => b.foesInRadius(s.x, s.y, 1.5) };
          else if (g === 'range') sc = { kind: 'enemies', label: '范围内敌人', pick: (b, s) => enemiesInRange(b, s) };
          else { dropped.push({ clause: clauses[i], reason: 'enemy area without a preceding area' }); i++; continue; }
        }
        c = ps.rest;
      }
      if (ps && ps.scope.kind !== 'self' && !ps.scope.inherit && !ps.scope.inheritAlly) scope = { ...sc };
      const sp = c ? statPhrases(c, P.values, P.stats) : null;
      if (sp && scaling) { dropped.push({ clause: clauses[i], reason: 'stacked / scaled effect (no rule models it)' }); i++; continue; }
      if (sp && dur > 0 && (!cond || cond.kind === 'state')) { dropped.push({ clause: clauses[i], reason: `timed effect (${dur}s) without a recognised trigger` }); i++; continue; }
      if (sp) {
        const finalScope = sc && sc.kind ? sc : { kind: 'self', team: false };
        if (finalScope.team && finalScope.kind === 'self') { dropped.push({ clause: clauses[i], reason: 'team-wide self effect' }); i++; continue; }
        const spec = { mods: sp.mods, extra: sp.extra, scope: finalScope, cond: cond && cond.kind === 'state' ? cond : null, label: `${finalScope.label ?? '自身'} ${cond?.label ?? ''} ${JSON.stringify(sp.mods)}${sp.extra?.status ? ' 抵抗' : ''}` };
        if (cond && cond.kind === 'event') { i++; continue; }
        const eff = statEffect(P, nextJ(), spec);
        eff.statSpec = spec;
        effects.push(eff);
        if (ps && ps.scope.kind !== 'self') scope = { ...ps.scope, team: finalScope.team, pendingTeam: scope?.pendingTeam };
        i++;
        continue;
      }
      dropped.push({ clause: clauses[i], reason: 'no pattern' });
      // an unparsed clause that reads as a condition / trigger governs what follows ("…开启技能时自身回复1点技力，且攻击速度+16")
      if (/时|后|之前/.test(clauses[i])) cond = { kind: 'unknown', label: clauses[i] };
      i++;
    }
    void sentStart;
  }
  return { effects, dropped };
}

/** Event effect list "获得A和B" → parts (每 part a phrase eventEffect knows), joined by 和 / 且 / 并 / ，. */
function splitEffects(c) {
  return c.split(/(?:并且|并|且|以及)/).map((x) => x.trim()).filter(Boolean);
}

/** Both state conditions. */
function andCond(a, b) {
  if (a.label === b.label) return a;
  const inst = [a.install, b.install].filter(Boolean);
  return STATE(`${a.label}&${b.label}`, (bt, u) => a.test(bt, u) && b.test(bt, u), {
    team: a.team || b.team, ...(inst.length ? { install(bt, u) { for (const f of inst) f(bt, u); } } : {}),
  });
}

// =================================================================================================================
// public API

/** Text sources of a def: [{ srcTag, text, bb, index }] (named talents with text, then the module trait addition). */
function textSources(def) {
  const out = [];
  const talents = Array.isArray(def?.talents) ? def.talents : [];
  talents.forEach((t, i) => {
    const text = String(t?.description ?? t?.desc ?? '').trim();
    if (!text || text === '-' || text === 'null' || /^在【[^】]+】中/.test(text)) return;
    // a module part that restates a named talent under another index (a summon's 转瞬即逝的幻影 twice): the later one wins
    if (t.name && talents.slice(i + 1).some((x) => x && x.name === t.name && String(x.description ?? x.desc ?? '').trim())) return;
    out.push({ srcTag: `t${i}`, index: i, text, bb: t.bb || {}, talent: t });
  });
  const raw = def?.raw;
  const md = raw && raw.trait && typeof raw.trait === 'object' ? raw.trait.moduleDesc : null;
  if (md && (!raw.module || raw.module.active !== false)) out.push({ srcTag: 'm', index: -1, text: String(md), bb: raw.trait.bb || {}, module: true });
  return out;
}

/** Blackboards in search order for source `s`. */
function searchBbs(def, s) {
  const talents = Array.isArray(def?.talents) ? def.talents : [];
  const hidden = talents.filter((t) => !String(t?.description ?? t?.desc ?? '').trim()).map((t) => t.bb || {});
  const named = talents.filter((t) => t !== s.talent && String(t?.description ?? t?.desc ?? '').trim()).map((t) => t.bb || {});
  const trait = def?.raw?.trait?.bb ?? def?.traitBb ?? {};
  return s.module ? [s.bb, ...hidden, ...named] : [s.bb, ...named, ...hidden, trait];
}

function tokenNamesOf(def) {
  const names = new Set();
  for (const t of def?.raw?.tokens ?? def?.tokens ?? []) {
    const id = typeof t === 'string' ? t : t?.tokenId;
    if (!id) continue;
    names.add(String(id));
  }
  return [...names];
}

function parseSource(def, s, token) {
  const P = {
    values: valueIndex(searchBbs(def, s)),
    keyBase: String(def?.baseId ?? def?.id ?? 'x').replace(/_[ab]$/, ''),
    srcTag: s.srcTag,
    token: !!token,
    tokenNames: tokenNamesOf(def),
    module: !!s.module,
    stats: token || def?.type === 'token' ? def?.stats ?? null : null,
  };
  return parseTalentText(s.text, P);
}

/**
 * Generic TalentSpecs of a def (operator, or summon with `token: true`). Each spec: { id, pattern, label, source:
 * { talent: i } | { trait: 'module' }, install(battle, unit) }.
 */
export function genericTalentSpecs(def, { token = false } = {}) {
  if (!def) return [];
  const out = [];
  for (const s of textSources(def)) {
    let r;
    try { r = parseSource(def, s, token || def.type === 'token'); } catch { continue; }
    r.effects.forEach((e, k) => out.push({
      id: `gt:${def.id}:${s.srcTag}:${k}:${e.pattern}`, pattern: e.pattern, label: e.label,
      source: s.module ? { trait: 'module' } : { talent: s.index }, install: e.install,
    }));
  }
  return out;
}

/** The generic specs of one talent (index into def.talents) — for hand kits that reuse a simple talent. */
export function genericTalent(def, i) {
  return genericTalentSpecs(def).filter((s) => s.source.talent === i);
}

/** Coverage report: per text source, the patterns applied and the clauses dropped (with the reason). */
export function talentCoverage(def, { token = false } = {}) {
  const out = [];
  for (const s of textSources(def)) {
    let r;
    try { r = parseSource(def, s, token || def?.type === 'token'); } catch (e) { r = { effects: [], dropped: [{ clause: s.text, reason: `parse error: ${e && e.message}` }] }; }
    out.push({ source: s.module ? 'module' : `talent${s.index}`, name: s.talent?.name ?? null, text: s.text, patterns: r.effects.map((e) => e.pattern), labels: r.effects.map((e) => e.label), dropped: r.dropped });
  }
  return out;
}

export default genericTalentSpecs;
