// server/sim/content/genericSummons.js — summons of operators WITHOUT a hand-authored kit (today the 外援 / 甄选 ones).
//
// Pure ESM shared with browsers (/sim/). content/tokens.js `install` runs installGenericSummoner for every operator whose
// kit is the generic one (`owner.kit.generic`) and resolves the summon kits through genericTokenKit; a hand-authored
// owner kit takes over everything owner-coupled (it may also hand its summons a kit of their own, `kit.tokenKits`, and
// switch generic summon talents off, `kit.managedTokenTalents` — see genericTokenKit).
//
// Rules (texts = the owner's loadout-resolved talents and selected skill, numbers = data; DESIGN_BC §C.5):
//   * Talent summons the player placed (Mon3tr, 虚影, 蓄水炮 …) deploy with the board, then COME BACK on their tile after
//     their redeploy time (token `respawnTime`, after their own talents — 虚影 "再部署时间-10秒"; 可露希尔 "其被击败后会在15秒后
//     自动刷新" gives its own) while the owner stands — PRTS 卫戍协议/帮助 "若召唤物在战斗期间退场，将在满足条件后立即原地再部署
//     1个". A return pays the summon's deploy cost (battle.redeploy free:false; the battle-start deployment is free).
//   * Consumables (owner rule, REQUIREMENTS §5): a talent "可以使用N个X" / "可以使用5个召唤物（最多同时部署3个）" with N > 1
//     (艾拉 3 雷鸣地雷, 多萝西 8 共振装置, 望 6 棋子, 夜莺 2 幻影, 令 / 麦哲伦 / 电弧 5, 白铁 / 娜斯提 3) is the battle's STOCK:
//     every deployment of such a summon (the start included) uses one; with none left no more come in that battle (the
//     next round starts with the full stock again — a new battle). Skills add to it ("立即获得一个陷阱", "技能开启时获得1个
//     召唤物", "技能结束时获得两个陷阱"), never above "最多拥有M个" when the text names it. Pieces placed beyond the stock
//     wait off the field until the stock allows them.
//   * Lifetimes: "可以使用一个持续50秒的机动盾牌" / a summon talent "部署后持续20秒" / a skill "（持续120秒）"; a skill may
//     lengthen it ("机动盾牌持续时间+20秒") or lift it ("“中继器”持续时间变为无限").
//   * Skill summons: the owner's SELECTED skill makes the summon (data `sources`); it comes when the text says (start /
//     end: "技能开启时获得1个召唤物", "技能结束时获得一个装置", "下次攻击变为…埋下地雷"; default: skill start). A hand piece
//     takes the field on its tile (tokens.js releaseSkillSummon); a summon with no hand piece (HIDDEN) is spawned on a tile
//     of the owner's range (W's 地雷 / 黑键's 残影 on the enemy path, the others by their deploy position). "期间可以使用一个X"
//     binds it to the skill; "技能结束时回收所有无人机" / "…回收生命值低于一半的召唤物" recall them (stock back), "技能结束时
//     所有场上的装置被销毁" removes them.
//   * Summons no hand holds (HIDDEN): "部署后立刻在攻击范围内召唤一个X" (维什戴尔) at the owner's deployment; "攻击范围内敌人
//     被击倒时生成一个X，最多召唤N个" (死芒) where the enemy fell; "神经损伤爆发时在其地面位置生成一个X" (酒神 S3) during the skill.
//   * Owner → summon links: the generic skill spec's `summonMods` ("自身和召唤物攻击力+35%", "Mon3tr的攻击力+35%") hold on
//     the owner's summons while the skill runs; owner talents about its summons: "X在场时，自身攻击力+N%", "X受到伤害时，有
//     N%的概率使Y获得M点技力", "召唤物获得相当于其自身N%攻击力、防御力、生命值的鼓舞效果", "陷阱触发后，Y获得N%的攻击力，最多叠加
//     M层", "召唤物被击倒/吸收/回收时Y额外获得N点技力、攻击力+M%", "X周围友方单位的攻击力+N%".
//   * Traps (trapKit): a summon whose text reads as a trap ("无法放置于敌人已在的格子中", "敌人经过/接近时", "触发时", a 陷阱师's
//     summon) never attacks; the first ground enemy on its tile (on a neighbouring tile when the owner text says "经过周围")
//     triggers it once: the owner's selected skill "被动效果：陷阱/棋子触发时…" (else the summon's skill text) gives the
//     effect — owner ATK × atk_scale damage, 停顿 / 晕眩 / 束缚, DEF −N %, 脆弱, slow, a DoT, a pull — to the trigger enemy
//     or, for "周围/范围内所有", to every enemy within `projectile_range` (1.5 [ASSUMED] when the data has none); then it is
//     used up ('expired', fx `consumed`) and comes back from the stock (above).
// [ASSUMED] choices are marked in the code. Every hook is owned by the owner or the summon; randomness only via battle.rng.

import { normText, genericTalentSpecs } from './genericTalents.js';
import { COLS } from '../constants.js';

const num = (v, d = undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : d));
const CN = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const cnt = (s) => (s == null ? NaN : /^\d/.test(s) ? +s : CN[s] ?? NaN);
const up = (u) => !!u && u.alive && u.deployed;
const EPS = 1e-9;
const N = '(\\d+(?:\\.\\d+)?)';
const descOf = (t) => normText(t?.description ?? t?.desc ?? '');
/** A ground enemy stands on tile (r, c). */
const enemyOn = (battle, r, c) => battle.enemies.some((e) => e.alive && !e.isFlying && Math.round(e.y) === r && Math.round(e.x) === c);
/** SP for `u` unless a timed skill runs (AK: no SP during a skill). */
function giveSp(u, n) {
  if (!u || !u.skill || u.skill.noSkill || (u.skill.active && u.skill.isTimed) || !(n > 0)) return 0;
  return u.skill.gainSp(n, 'talent');
}

/** The trap reading of a summon (see header). */
export function isTrapToken(def, owner = null) {
  if (!def || def.type !== 'token') return false;
  const t = normText(def.trait) + '|' + normText(def.skill?.description);
  if (/无法放置于敌人已在的格子中|敌人(?:经过|接近)时|踩上去|^触发时|\|触发时/.test(t)) return true;
  return owner?.def?.subProf === 'traper';
}

// =================================================================================================================
// trap kit

/** The trigger effect text of a trap: the owner's selected skill "被动效果：(陷阱|棋子|地雷)触发时…", else the summon's own skill. */
function trapText(def, owner) {
  const own = normText(owner?.def?.skill?.description);
  const m = own.match(/(?:被动效果：)?(?:陷阱|棋子|地雷)(?:在敌人经过时会爆炸，爆炸后|触发时)([^主]*?)(?=主动效果|$)/);
  if (m) return { text: m[1], bb: owner.def.skill.bb || {} };
  return { text: normText(def.skill?.description), bb: def.skill?.bb || {} };
}

/** Parse a trap effect text into a function (battle, trap, trigger enemy) → victims. */
function trapEffect(text, bb) {
  const g = (...keys) => { for (const k of keys) { const v = num(bb[k]) ?? num(bb['attack@' + k]); if (v !== undefined) return v; } return undefined; };
  const area = /周围所有(?:目标|敌人)|范围内所有(?:目标|敌人)|周围的敌人|范围内的敌人|两侧\d+格范围内的敌人/.test(text);
  const radius = g('projectile_range') ?? 1.5;
  const dm = text.match(/造成相当于(?:\S{0,6}?)攻击力(?:的)?(\d+(?:\.\d+)?)%的(物理|法术|真实)伤害|造成(物理|法术)伤害/);
  const scale = dm ? (g('atk_scale') ?? (dm[1] ? +dm[1] / 100 : 1)) : 0;
  const type = dm ? ((dm[2] ?? dm[3]) === '法术' ? 'arts' : (dm[2] ?? dm[3]) === '真实' ? 'true' : 'phys') : 'phys';
  const dot = text.match(/每秒受到相当于\S{0,6}?攻击力的?(\d+(?:\.\d+)?)%的(法术|物理)伤害，持续(\d+(?:\.\d+)?)秒/);
  const statuses = [];
  const dur = (k, fallback) => g(k) ?? fallback;
  const tm = text.match(/持续(\d+(?:\.\d+)?)秒/);
  const tdur = tm ? +tm[1] : undefined;
  if (/停顿/.test(text)) statuses.push(['sluggish', dur('sluggish', g('duration') ?? tdur ?? 1)]);
  if (/晕眩/.test(text)) statuses.push(['stun', dur('stun', tdur ?? 1)]);
  if (/束缚/.test(text)) statuses.push(['bind', g('duration', 'unmove', 'unmove_duration') ?? tdur ?? 1]);
  const defDown = text.match(/防御力-(\d+(?:\.\d+)?)%/);
  const fragile = text.match(/(\d+(?:\.\d+)?)%的脆弱/);
  const slow = text.match(/移动速度降低(\d+(?:\.\d+)?)%/);
  const pull = /拖拽/.test(text) ? (g('force') ?? 1) : null;
  const known = scale > 0 || dot || statuses.length || defDown || fragile || slow || pull != null;
  return (battle, trap, hit) => {
    const owner = trap.ownerUnit && trap.ownerUnit.s ? trap.ownerUnit : trap;
    const atk = owner.s.atk;
    const victims = area ? battle.foesInRadius(trap.x, trap.y, radius).filter((e) => !e.isFlying || e === hit) : [hit];
    if (!victims.includes(hit) && hit.alive) victims.unshift(hit);
    for (const e of victims) {
      if (!e.alive) continue;
      if (!known) { battle.dealDamage(trap, e, { amount: atk, type: 'phys', isSkill: true, tags: ['summon', 'trap'] }); continue; } // [ASSUMED] fallback
      if (scale > 0) battle.dealDamage(trap, e, { amount: atk * scale, type, isSkill: true, tags: ['summon', 'trap'] });
      if (!e.alive) continue;
      for (const [st, d] of statuses) battle.applyStatus(e, st, { duration: d, source: trap });
      const d = g('duration') ?? tdur ?? 5;
      if (defDown) battle.addBuff(e, { key: `gs:trapDef:${owner.id}`, duration: d, mods: { defPct: -(Math.abs(g('def') ?? +defDown[1] / 100)) }, refresh: 'extend', source: trap });
      if (fragile) battle.applyStatus(e, 'fragile', { duration: d, value: Math.abs((g('damage_scale') ?? 1 + +fragile[1] / 100) - 1), source: trap });
      if (slow) battle.addBuff(e, { key: `gs:trapSlow:${owner.id}`, duration: d, mods: { moveMul: 1 - Math.abs(g('move_speed') ?? +slow[1] / 100) }, refresh: 'extend', source: trap });
      if (dot) {
        const r = g('atk_scale') ?? +dot[1] / 100, t = +dot[3];
        battle.addBuff(e, {
          key: `gs:trapDot:${owner.id}`, duration: t, interval: 1, refresh: 'extend', source: trap, tags: ['dot'],
          onTick: ({ unit: x }) => { if (x.alive) battle.dealDamage(trap, x, { amount: owner.s.atk * r, type: dot[2] === '物理' ? 'phys' : 'arts', canDodge: false, tags: ['summon', 'dot'] }); },
        });
      }
      if (pull != null && e.alive) battle.pull(e, pull, { to: { x: trap.x, y: trap.y } });
    }
    return victims;
  };
}

/**
 * Generic trap kit (see header). `owner` = the summoning unit (its selected skill gives the trigger effect).
 */
export function trapKit(def, owner = null) {
  const { text, bb } = trapText(def, owner);
  const effect = trapEffect(text, bb);
  const ownerText = (owner?.def?.talents || []).map(descOf).join('|');
  // "经过周围的第一个敌人会触发其效果" (艾拉) / "敌人接近时" (黑键's 残影): a neighbouring tile triggers it too [ASSUMED: 1 tile]
  const reach = /经过周围|敌人接近时/.test(ownerText + '|' + normText(def.skill?.description)) ? 1 : 0;
  return {
    skill: {
      kind: 'passive',
      onTick({ battle, unit }) {
        if (!unit.alive || !unit.deployed) return;
        let hit = null;
        for (const e of battle.enemies) {
          if (!e.alive || e.hidden || e.isFlying) continue;
          const dr = Math.abs(Math.round(e.y) - unit.tileR), dc = Math.abs(Math.round(e.x) - unit.tileC);
          const on = reach ? Math.max(dr, dc) <= reach : Math.abs(e.x - unit.tileC) <= 0.5 && Math.abs(e.y - unit.tileR) <= 0.5;
          if (on && (!hit || e.spawnSeq < hit.spawnSeq)) hit = e;
        }
        if (!hit) return;
        const victims = effect(battle, unit, hit);
        battle.fx('trapTrigger', { x: unit.x, y: unit.y, id: unit.id, token: unit.defId, target: hit.id, n: victims.length, consumed: true });
        if (battle.hasHook('summonTrap')) battle.emit('summonTrap', { token: unit, owner: unit.ownerUnit ?? null, target: hit, victims });
        battle.retreat(unit, { reason: 'expired', permanent: true });
      },
    },
    trait: { noAttack: true },
    talents: [],
    generic: true,
    trap: true,
    install(battle, unit) { battle.addBuff(unit, { key: 'trait:untargetable', flags: { untargetable: true }, persist: true, allowDead: true }); },
  };
}

// =================================================================================================================
// summon kits (content/index.js → tokens.js genericTokenKit)

/** The data's placeholder attack of a summon that never attacks (ATK 100, BAT 1). */
function isPlaceholderAttack(def) {
  const st = def?.stats || {};
  return st.atk === 100 && st.bat === 1;
}

/**
 * The kit of a summon without a token kit of content/tokens.js: the owner kit's `tokenKits[tokenId]` (a hand-authored
 * owner hands its summon a kit — owner-managed), else the trap kit, else the generic kit (its skill + generic talents).
 * The owner kit's `managedTokenTalents` (`{ [tokenId]: true | [talent name | pattern id, …] }`) switches generic summon
 * talents off (凯尔希's kit runs Mon3tr's 不毁重构 itself). `genericKit` is passed in (generic.js imports this file's
 * helpers indirectly: no import cycle).
 */
export function genericTokenKit(battle, unit, bb, raw, def, genericKit) {
  const owner = unit.ownerUnit && unit.ownerUnit.kind === 'op' ? unit.ownerUnit : null;
  // the owner's kit first (board summons may be set up before their owner)
  if (owner && !owner.kit && typeof battle._setupUnit === 'function') {
    try { battle._setupUnit(owner); } catch (e) { battle._handlerError?.('setupOwner', owner, e); }
  }
  const ok = owner?.kit ?? null;
  const own = ok && ok.tokenKits && typeof ok.tokenKits[def.id] === 'function' ? ok.tokenKits[def.id] : null;
  if (own) {
    try { const k = own(bb, raw, def); if (k) return { ...k, ownerManaged: true }; } catch (e) { battle._handlerError?.(`ownerTokenKit:${def.id}`, unit, e); }
  }
  // a hand-authored owner kit (not generic) owns its summons unless it opts into the generic summoner (`genericSummons:
  // true`): the summon keeps what it had before the generic summoner existed — its own skill's generic spec, no generic
  // talents (凯尔希 authors 不毁重构), no trap / no-attack readings, not policed by the per-owner deploy limit (令's holding)
  if (ok && !ok.generic && ok.genericSummons !== true) {
    return { ...(def.skill ? genericKit(bb, raw, def, { talents: false }) : { skill: null, talents: [] }), ownerManaged: true };
  }
  const trap = isTrapToken(def, owner);
  let kit = trap ? trapKit(def, owner) : genericKit(bb, raw, def, { talents: false });
  // a summon that does not attack: "不攻击" (指挥中心), or the data's placeholder combat stats (ATK 100 at a 1 s interval —
  // markers and devices whose effect is their owner's: 牵绊, “一会儿见！”, 沙地兽, 本能的召唤, 迷狂牢笼, 铁钳号) [ASSUMED]
  if (!trap && (/不攻击/.test(normText(def.trait)) || isPlaceholderAttack(def))) kit = { ...kit, trait: { ...(kit.trait || {}), noAttack: true } };
  kit = { ...kit, talents: [...(kit.talents || []), ...genericTalentSpecs(def, { token: true })] };
  const managedSpec = ok && ok.managedTokenTalents ? ok.managedTokenTalents[def.id] : null;
  if (managedSpec === true) kit.talents = kit.talents.filter((t) => !String(t.id || '').startsWith('gt:'));
  else if (Array.isArray(managedSpec)) {
    kit.talents = kit.talents.filter((t) => {
      if (!String(t.id || '').startsWith('gt:')) return true;
      const name = def.talents?.[t.source?.talent]?.name;
      return !managedSpec.includes(name) && !managedSpec.includes(t.pattern);
    });
  }
  return kit;
}

// =================================================================================================================
// the summoner

/**
 * Tile of a trap the owner lays itself (W "在攻击范围内的一个可放置地块埋下地雷", 多萝西's two extra 共振装置): a free ground
 * tile of the owner's range with no enemy on it ("无法放置于敌人已在的格子中"): the first one on the leading ground enemy's path
 * ahead, else the one nearest to that enemy
 * [ASSUMED] (else to the owner); ties by row, column.
 */
function trapTile(battle, owner, tileFree) {
  let lead = null, ld = Infinity;
  for (const e of battle.enemies) {
    if (!e.alive || e.hidden || e.isFlying) continue;
    const d = battle.remainingDistance(e);
    if (d < ld - EPS || (Math.abs(d - ld) <= EPS && lead && e.spawnSeq < lead.spawnSeq)) { ld = d; lead = e; }
  }
  const focus = lead ?? owner;
  const ok = (r, c) => tileFree(battle, r, c) && battle.grid.canStand(r, c, { ranged: false }) && battle.grid.groundPassable(r, c, true) && !enemyOn(battle, r, c);
  const inRange = new Set(owner.rangeKeys || []);
  // first: the first tile of the leading enemy's path ahead inside the range (where it will walk)
  const R = lead?.route;
  if (R && Array.isArray(R.pts)) {
    for (let i = Math.max(0, R.ptIdx ?? 0); i < R.pts.length; i++) {
      const r = Math.round(R.pts[i].y), c = Math.round(R.pts[i].x);
      if (inRange.has(r * COLS + c) && ok(r, c)) return [r, c];
    }
  }
  let best = null, bs = null;
  for (const k of owner.rangeKeys || []) {
    const r = (k / COLS) | 0, c = k % COLS;
    if (!ok(r, c)) continue;
    const s = [Math.hypot(c - focus.x, r - focus.y), r, c];
    let less = !bs;
    if (!less) for (let i = 0; i < s.length; i++) { if (s[i] < bs[i] - EPS) { less = true; break; } if (s[i] > bs[i] + EPS) break; }
    if (less) { best = [r, c]; bs = s; }
  }
  return best;
}

/** Summon placement for a spawned summon with no hand piece (findSummonTile placements). */
export function inferPlacement(def, { trap = false } = {}) {
  if (trap) return 'path';
  const p = String(def?.position ?? 'MELEE').toUpperCase();
  return p === 'MELEE' ? 'melee' : 'enemy';
}

/**
 * Generic summons of `owner` (an operator running the generic kit). `toks` = its token ids; `H` = tokens.js helpers
 * { tokenSources, releaseSkillSummon, summonToken, scheduleLifetime, bindToOwnerSkill, deployLimitOf, tileFree }.
 */
export function installGenericSummoner(battle, owner, toks, H) {
  const od = owner.def || {};
  const talents = Array.isArray(od.talents) ? od.talents : [];
  const skillText = normText(od.skill?.description);
  const skillBb = od.skill?.bb || {};
  const infos = [];
  for (const t of toks) {
    const raw = battle.data.rawToken?.(t);
    if (!raw || raw.kind !== 'summon') continue;
    const src = H.tokenSources(battle, t, owner);
    if (!src.includes('talent') && !src.includes('skill')) continue;
    const def = battle.data.getToken(t, owner.defId, od.loadout ?? null);
    if (!def) continue;
    const ownTalent = talents.find((x) => x && x.tokenKey === t) ?? null;
    infos.push({ id: t, raw, def, src, name: normText(def.name), placeable: raw.placeable === true, ownTalent, trap: isTrapToken(def, owner) });
  }
  if (!infos.length) return null;
  const byId = new Map(infos.map((i) => [i.id, i]));
  const mine = (u) => !!u && u.kind === 'token' && u.ownerUnit === owner && byId.has(u.defId);

  // ---- stock (consumables)
  const groups = new Map();
  const container = talents.find((x) => x && !x.tokenKey && num(x.bb?.cnt, 0) > 1 && /可以(?:使用|携带)\d+个/.test(descOf(x)));
  // the equipped module's trait addition raises it: "召唤物持有上限+3" (令 SUM-Y), "<支援装置>的持有上限+1" (白铁 / 娜斯提)
  const modText = normText(od.raw?.trait?.moduleDesc ?? '');
  const modUp = modText.match(/(?:召唤物|<[^>]{1,8}>|装置)的?持有上限\+(\d+)/);
  const holdUp = modUp ? +modUp[1] : 0;
  for (const info of infos) {
    const tx = info.ownTalent ? descOf(info.ownTalent) : '';
    const c = info.ownTalent ? num(info.ownTalent.bb?.cnt, 0) : 0;
    if (c > 1) {
      const mx = tx.match(/最多拥有(\d+)(?:个|枚)/);
      info.group = { key: info.id, left: c + holdUp, max: mx ? +mx[1] + holdUp : Infinity };
    } else if (container && info.src.includes('skill') && !info.ownTalent) {
      if (!groups.has('container')) groups.set('container', { key: 'container', left: num(container.bb.cnt) + holdUp, max: Infinity });
      info.group = groups.get('container');
    }
  }
  const canDeploy = (info) => !info.group || info.group.left > 0;
  let extra = false; // spawning a talent's extra summons (not from the stock)
  battle.on('deploy', (c) => {
    const u = c.unit;
    if (!mine(u)) return;
    const info = byId.get(u.defId);
    if (info.group && !extra) info.group.left = Math.max(0, info.group.left - 1);
    const life = lifetimeOf(info);
    if (life > 0) H.scheduleLifetime(battle, u, life);
  }, { owner, priority: 40 });
  // docked pieces (skill summons with a hand piece) ask before taking the field (tokens.js deployDocked)
  // "技能期间可以使用一个X" (淬羽赫默 夜灯, 酒神 本能的召唤): the skill's summon takes the field only while the skill runs
  const duringSkill = /期间可以使用一个/.test(skillText);
  for (const p of battle.allyUnits) {
    if (!mine(p) || !p.mem.docked) continue;
    const info = byId.get(p.defId);
    const onlyDuring = duringSkill && info.src.includes('skill');
    p.mem.gsCanDeploy = () => canDeploy(info) && (!onlyDuring || !!owner.skill?.active);
  }

  // ---- lifetimes
  const lifeMods = { add: 0, endless: false };
  const lm = skillText.match(new RegExp(`持续时间\\+${N}秒`));
  if (lm) lifeMods.add = num(skillBb.duration, +lm[1]);
  if (/持续时间变为无限/.test(skillText)) lifeMods.endless = true;
  function lifetimeOf(info) {
    if (lifeMods.endless && info.src.includes('talent')) return 0;
    let s = 0;
    const tx = info.ownTalent ? descOf(info.ownTalent) : '';
    const m = tx.match(new RegExp(`持续(?:时间)?${N}秒`));
    if (m) s = +m[1];
    if (!s) {
      for (const t of info.def.talents || []) {
        const d = descOf(t);
        const x = d.match(new RegExp(`(?:部署后)?持续${N}秒`)) ?? d.match(new RegExp(`于${N}秒内`));
        if (x) { s = num(t.bb?.duration) ?? num(t.bb?.['skill@duration']) ?? +x[1]; break; }
        if (d === '-' && num(t.bb?.duration) > 0) { s = num(t.bb.duration); break; }
      }
    }
    if (!s && info.src.includes('skill')) {
      const x = skillText.match(new RegExp(`（持续${N}秒）`));
      if (x) s = +x[1];
    }
    return s > 0 ? s + (info.src.includes('talent') ? lifeMods.add : 0) : 0;
  }

  // ---- placed talent pieces: come back (stock permitting), pay their cost
  const pieces = battle.allyUnits.filter((u) => mine(u) && u.uid != null && !u.mem.docked && byId.get(u.defId).src.includes('talent'));
  // pieces beyond the stock wait off the field (deployment order: the engine's, left column first, top first)
  for (const info of infos) {
    if (!info.group) continue;
    const mineOf = pieces.filter((p) => p.defId === info.id).sort((a, b) => a.homeC - b.homeC || b.homeR - a.homeR || a.id - b.id);
    let room = info.group.left;
    for (const p of mineOf) { if (room > 0) room--; else { p.deferDeploy = true; p.mem.gsReadyAt = -Infinity; } }
  }
  const textDelay = (info) => {
    const m = (info.ownTalent ? descOf(info.ownTalent) : '').match(new RegExp(`被击败后会在${N}秒后自动刷新`));
    return m ? +m[1] : null;
  };
  // the owner's selected skill: "“打字机”的再部署时间缩短至65%" (被动效果：携带此技能时 — always) / "沙地兽的再部署时间-20%"
  // (while the skill runs) — the blackboard respawn_time (0.65 / −0.2)
  const rsCut = skillText.match(/再部署时间缩短至(\d+(?:\.\d+)?)%/), rsPct = skillText.match(/再部署时间-(\d+(?:\.\d+)?)%/);
  const rsMul = rsCut ? num(skillBb.respawn_time, +rsCut[1] / 100) : rsPct ? 1 + num(skillBb.respawn_time, -rsPct[1] / 100) : 1;
  const rsAlways = /携带此技能时/.test(skillText);
  const respawnMul = () => (rsMul !== 1 && (rsAlways || owner.skill?.active) ? rsMul : 1);
  const delayOf = (p, info) => textDelay(info) ?? Math.max(0, p.base.respawnTime * respawnMul() * (p.persist?.redeployMul ?? 1) * (p.s?.redeployMul ?? 1));
  const wake = (p, info) => {
    if (p.mem.gsWaking) return;
    p.mem.gsWaking = true;
    battle.every(0.25, (b, sc) => {
      if (p.alive || p.removed || b.finished) { p.mem.gsWaking = false; sc.cancel(); return; }
      if (!canDeploy(info)) { p.removed = true; p.mem.gsWaking = false; sc.cancel(); return; }
      if (!up(owner)) return; // [ASSUMED] a summon comes back only while its owner stands (as the docked pieces)
      if (b.time + EPS < (p.mem.gsReadyAt ?? -Infinity)) return;
      if (info.trap && enemyOn(b, p.homeR, p.homeC)) return; // 无法放置于敌人已在的格子中
      if (b.redeploy(p, { free: false })) { p.mem.gsWaking = false; sc.cancel(); } // a return pays its deploy cost
    }, { owner: p, immediate: true });
  };
  for (const p of pieces) {
    const info = byId.get(p.defId);
    battle.on('death', (c) => {
      if (c.unit !== p || battle.finished) return;
      if (p.mem.replaced) { p.mem.replaced = false; return; }
      if (!(c.reason === 'killed' || c.reason === 'expired')) return;
      if (!canDeploy(info)) return; // used up: no more in this battle
      p.removed = false;
      p.mem.gsReadyAt = battle.time + delayOf(p, info);
      wake(p, info);
    }, { owner: p, priority: -10 });
  }
  // a container's docked pieces (令 / 麦哲伦 / 电弧 / 白铁 / 娜斯提): the talent's stock brings them back by their own
  // redeploy time too (tokens.js dockSkillSummons: readyAt, then deployDocked with stock)
  for (const p of battle.allyUnits) {
    if (!mine(p) || !p.mem.docked) continue;
    const info = byId.get(p.defId);
    if (!info.group) continue;
    battle.on('death', (c) => {
      if (c.unit !== p || battle.finished || p.mem.replaced) return;
      if (!canDeploy(info)) return;
      const stock = owner.mem.summonStock || (owner.mem.summonStock = {});
      stock[p.defId] = (stock[p.defId] || 0) + 1; // every piece that left may come back (gsCanDeploy gates the stock)
    }, { owner: p, priority: 5 });
  }

  // ---- skill gains / summons / recalls (the selected skill)
  const skillInfos = infos.filter((i) => i.src.includes('skill'));
  const gainInfos = skillInfos.length ? skillInfos : infos.filter((i) => i.group);
  const gain = (n) => {
    for (const info of gainInfos) {
      if (info.group) info.group.left = Math.min(info.group.max, info.group.left + n);
      if (info.placeable) {
        const docked = battle.allyUnits.some((p) => mine(p) && p.defId === info.id && p.mem.docked);
        if (docked) { H.releaseSkillSummon(battle, owner, info.id, { cap: n }); continue; }
        // a waiting placed piece (used up / deferred) takes the field now (it still pays its cost)
        let k = n;
        for (const p of pieces) {
          if (k <= 0) break;
          if (p.defId !== info.id || p.alive || (p.removed && !canDeploy(info))) continue;
          p.removed = false;
          p.mem.gsReadyAt = battle.time;
          wake(p, info);
          k--;
        }
      } else {
        spawnN(info, n);
      }
    }
  };
  const spawnN = (info, n, at = null, { free = false } = {}) => {
    const lim = H.deployLimitOf({ def: info.def, ownerUnit: owner });
    for (let i = 0; i < n; i++) {
      if (!free && !canDeploy(info)) break;
      const alive = battle.allyUnits.filter((u) => mine(u) && u.alive && u.defId === info.id).length;
      if (Number.isFinite(lim) && alive >= Math.max(1, lim) && !at) break;
      const placement = at ? 'near' : inferPlacement(info.def, { trap: info.trap });
      const opts = at ? { at, melee: info.def.position === 'MELEE' } : { melee: info.def.position === 'MELEE' };
      if (info.trap && !at) {
        const tile = trapTile(battle, owner, H.tileFree);
        if (!tile) break;
        opts.tile = tile;
      }
      extra = free;
      let t = null;
      try { t = H.summonToken(battle, owner, info.id, placement, opts); } finally { extra = false; }
      if (!t) break;
    }
  };
  const g = skillText;
  const amount = (s) => (s ? cnt(s) : 1);
  const makes = (text, list) => {
    const names = list.map((i) => i.name.replace(/[“”"]/g, '')).filter(Boolean).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`(?:获得|召唤|使用)(?:一个|一枚|\\d+个)?[“"]?(?:${[...names, '召唤物', '装置', '无人机', '陷阱', '地雷', '棋子'].join('|')})`);
    return re.test(text.replace(/[“”]/g, ''));
  };
  const startM = g.match(/(?:主动效果：|开启时|技能开启时)?立(?:即|刻)获得(一|两|二|三|\d+)?(?:个|枚)/) ?? g.match(/技能开启时获得(一|两|\d+)?个/) ?? g.match(/开启时立即获得(一|两|\d+)?个/);
  const endM = g.match(/技能结束时获得(一|两|二|三|\d+)?(?:个|枚)/);
  // a talent stock the selected skill adds to ("立即获得一个陷阱" — 艾拉 / 多萝西 / 望, whose summons are talent ones)
  const talentGain = !skillInfos.length && !!(startM || endM) && infos.some((i) => i.group);
  if (skillInfos.length || talentGain) {
    const during = /期间可以使用一个/.test(g);
    const summonM = g.match(/立刻在攻击范围内召唤(\d+|一|两)个[^（，]*?（最多存在(\d+)个/);
    const burstM = g.match(/(神经|灼燃|凋亡|侵蚀)损伤爆发时在其(?:地面)?位置生成(?:\/刷新)?一个/);
    const placeM = /埋下地雷|召唤消耗能量数\+1个/.test(g);
    // the blackboard count when the text and the data agree on a gain ("技能结束时获得两个陷阱", cnt 2)
    const bbCnt = num(skillBb.cnt);
    let starts = 0;
    if (startM) starts = amount(startM[1]);
    else if (summonM) starts = amount(summonM[1]);
    // a skill summon the text makes ("立刻获得战术锚点") without a count: one at the skill start; a skill that only names it
    // (莱伊 "沙地兽的再部署时间-20%", 贝洛内's 牵绊 marker) makes none
    else if (!endM && !burstM && !talentGain && makes(g, skillInfos)) starts = 1;
    if (startM && bbCnt > 0 && startM[1] == null) starts = bbCnt;
    if (during || placeM) starts = Math.max(starts, 1);
    const ends = endM ? (endM[1] == null && bbCnt > 0 ? bbCnt : amount(endM[1])) : 0;
    const cap = summonM ? +summonM[2] : null;
    battle.on('skillStart', (c) => {
      if (c.unit !== owner || !starts) return;
      if (cap) {
        for (const info of skillInfos) {
          const alive = battle.allyUnits.filter((u) => mine(u) && u.alive && u.defId === info.id).length;
          if (alive < cap) spawnN(info, Math.min(starts, cap - alive));
        }
        return;
      }
      gain(starts);
      if (during) for (const p of battle.allyUnits) if (mine(p) && p.alive && byId.get(p.defId).src.includes('skill')) p.mem.boundActivation = owner.skill?.activations ?? null;
    }, { owner });
    if (ends) battle.on('skillEnd', (c) => { if (c.unit === owner && c.reason !== 'death') gain(ends); }, { owner });
    if (during) {
      // "技能结束或X离场时销毁": the summon leaves with the skill / the owner
      const leave = () => {
        const stock = owner.mem.summonStock;
        for (const info of skillInfos) if (stock && stock[info.id]) stock[info.id] = 0; // none left over for later
        for (const p of battle.allyUnits) if (mine(p) && p.alive && byId.get(p.defId).src.includes('skill')) battle.retreat(p, { reason: 'expired', permanent: true });
      };
      battle.on('skillEnd', (c) => { if (c.unit === owner) leave(); }, { owner });
      battle.on('death', (c) => { if (c.unit === owner) leave(); }, { owner });
    }
    if (burstM) {
      const el = { 神经: 'neural', 灼燃: 'burn', 凋亡: 'apoptosis', 侵蚀: 'erosion' }[burstM[1]];
      battle.on('elementBurst', (c) => {
        if (!up(owner) || !owner.skill?.active || c.element !== el || !c.target || c.target.side !== 'enemy') return;
        for (const info of skillInfos) {
          // "生成/刷新": the one standing is replaced [ASSUMED: one at a time]
          for (const u of battle.allyUnits) if (mine(u) && u.alive && u.defId === info.id) { u.mem.replaced = true; battle.retreat(u, { reason: 'expired', permanent: true }); }
          spawnN(info, 1, { x: c.target.x, y: c.target.y });
        }
      }, { owner });
    }
    // recalls / removals at the skill's end
    const recallAll = /技能结束时回收所有(?:无人机|召唤物|装置)/.test(g);
    const recallLow = g.match(/技能结束时回收生命值低于一半的(?:召唤物|无人机|装置)/);
    const destroy = /技能结束时所有场上的(?:装置|召唤物|无人机)被销毁/.test(g);
    if (recallAll || recallLow || destroy) {
      const hpR = num(skillBb.hp_ratio, 0.5);
      battle.on('skillEnd', (c) => {
        if (c.unit !== owner) return;
        for (const u of battle.allyUnits) {
          if (!mine(u) || !u.alive) continue;
          if (recallLow && !(u.hpRatio < hpR - EPS)) continue;
          const info = byId.get(u.defId);
          // 回收 = back to the stock (the summon is not used up); 销毁 = gone
          if (!destroy && info.group) info.group.left = Math.min(info.group.max, info.group.left + 1);
          battle.retreat(u, { reason: 'expired', permanent: true });
        }
      }, { owner, priority: -5 });
    }
  }

  // ---- "立刻重新召唤所有X，若场上没有X存在则召唤1个" (死芒 S0): the standing ones come again at full health
  if (/立刻重新召唤所有[^，。]*?，若场上没有[^，。]*?存在则召唤(?:1|一)个/.test(g)) {
    const targets = infos.filter((i) => !i.placeable);
    battle.on('skillStart', (c) => {
      if (c.unit !== owner) return;
      for (const i of targets) {
        const alive = battle.allyUnits.filter((u) => mine(u) && u.alive && u.defId === i.id);
        if (!alive.length) { spawnN(i, 1); continue; }
        for (const u of alive) { u.hp = u.s.maxHp; battle.fx('summon', { x: u.x, y: u.y, id: u.id, token: u.defId }); } // [ASSUMED] 重新召唤 = back at full HP on its tile
      }
    }, { owner });
  }
  // ---- "周围8格的自身装置损毁时，有N%的几率回收使Y额外获得M个装置" (白铁; elite "当这些装置损毁时有90%的几率…"): a device
  // destroyed next to the owner may come back; elite "当白铁周围8格存在自身装置时技力回复速度+0.2/秒"
  const near = (u) => Math.max(Math.abs(u.tileR - owner.tileR), Math.abs(u.tileC - owner.tileC)) <= 1;
  for (const tal of talents) {
    const tx = descOf(tal);
    const sp = tx.match(/周围8格存在自身装置时技力回复速度\+(\d+(?:\.\d+)?)\/秒/);
    if (sp) {
      const v = num(tal.bb?.sp_recovery_per_sec) ?? +sp[1];
      const key = `gs:nearDevice:${owner.id}`;
      battle.on('tick', () => {
        const want = up(owner) && battle.allyUnits.some((u) => mine(u) && up(u) && near(u));
        const has = owner.findBuff(key);
        if (want && !has) battle.addBuff(owner, { key, mods: { spRecoveryFlat: v }, tags: ['talent'] });
        else if (!want && has) battle.removeBuff(owner, key);
      }, { owner });
    }
    const m = tx.match(/(?:周围8格的自身装置|这些装置)损毁时，?有(\d+)%的几率回收使[^，。]{1,6}?额外获得(\d+|一)个装置/);
    if (!m) continue;
    const p = num(tal.bb?.prob, +m[1] / 100), n = num(tal.bb?.cnt, cnt(m[2]));
    battle.on('death', (c) => {
      const u = c.unit;
      if (!mine(u) || !up(owner) || c.reason !== 'killed' && c.reason !== 'expired') return;
      if (!near(u)) return;
      const info = byId.get(u.defId);
      if (!info.group || !battle.rng.chance(p)) return;
      info.group.left = Math.min(info.group.max, info.group.left + n);
    }, { owner, priority: 10 }); // before the docked piece's own death hook (it reads the stock)
  }

  // ---- "技能期间目标被击倒时额外召唤N个X" (死芒 S1): an enemy the owner kills during its skill leaves N more
  const extraM = g.match(/技能期间(?:目标|敌人)被击倒时额外召唤(\d+|一|两)个/);
  if (extraM) {
    const n = num(skillBb.additional_token_cnt) ?? cnt(extraM[1]);
    const targets = infos.filter((i) => !i.placeable);
    battle.on('kill', (c) => {
      const v = c.victim;
      if (c.killer !== owner || !v || v.side !== 'enemy' || !owner.skill?.active) return;
      for (const i of targets) {
        const lim = H.deployLimitOf({ def: i.def, ownerUnit: owner });
        for (let k = 0; k < n; k++) {
          const alive = battle.allyUnits.filter((u) => mine(u) && u.alive && u.defId === i.id).length;
          if (Number.isFinite(lim) && alive >= Math.max(1, lim)) break;
          spawnN(i, 1, { x: v.x, y: v.y });
        }
      }
    }, { owner, priority: -5 });
  }

  // ---- summons no hand holds, by the owner's talents
  for (const tal of talents) {
    const tx = descOf(tal);
    if (!tx) continue;
    let m = tx.match(/部署后立刻在攻击范围内召唤(一|两|\d+)个/);
    if (m) {
      // 维什戴尔's 魂灵之影 (no hand piece) / 多萝西's two extra 共振装置 (beside the 8 of the stock [ASSUMED: not taken
      // from it]); the blackboard count first (attack@max_cnt 2)
      const n = num(tal.bb?.['attack@max_cnt']) ?? cnt(m[1]);
      const targets = infos.filter((i) => i.src.includes('talent') && (!i.placeable || i.group));
      if (targets.length) battle.on('deploy', (c) => { if (c.unit === owner) for (const i of targets) spawnN(i, n, null, { free: !!i.group }); }, { owner });
    }
    m = tx.match(/(自身和召唤物)?攻击范围内敌人被击倒时[^，。]*?生成一个[^，。]*?，最多召唤(\d+)个/);
    if (m) {
      const max = num(tal.bb?.max_token_cnt, +m[2]);
      const withSummons = !!m[1];
      const targets = infos.filter((i) => !i.placeable && i.src.includes('talent'));
      if (targets.length) {
        battle.on('kill', (c) => {
          const v = c.victim;
          if (!up(owner) || !v || v.side !== 'enemy') return;
          const key = Math.round(v.y) * 21 + Math.round(v.x);
          const inRange = (owner.rangeKeySet || new Set(owner.rangeKeys || [])).has(key)
            || (withSummons && battle.allyUnits.some((u) => mine(u) && u.alive && (u.rangeKeySet || new Set(u.rangeKeys || [])).has(key)));
          if (!inRange) return;
          for (const i of targets) {
            const alive = battle.allyUnits.filter((u) => mine(u) && u.alive && u.defId === i.id).length;
            if (alive < max) spawnN(i, 1, { x: v.x, y: v.y });
          }
        }, { owner });
      }
    }
  }

  // ---- owner skill → summons (generic spec `summonMods`)
  const linkMods = owner.kit?.skill?.summonMods ?? null;
  if (linkMods) {
    const key = `gs:link:${owner.id}`;
    const give = (u) => battle.addBuff(u, { key, mods: { ...linkMods }, source: owner, tags: ['skill', 'summonLink'] });
    battle.on('skillStart', (c) => { if (c.unit === owner) for (const u of battle.allyUnits) if (mine(u) && u.alive) give(u); }, { owner });
    battle.on('skillEnd', (c) => { if (c.unit === owner) for (const u of battle.allyUnits) if (mine(u)) battle.removeBuff(u, key); }, { owner });
    battle.on('deploy', (c) => { if (mine(c.unit) && owner.skill?.active && owner.skill.isTimed) give(c.unit); }, { owner, priority: 30 });
  }

  // ---- owner talents about its summons
  installOwnerLinks(battle, owner, talents, infos, mine, H);
  // read-only view for tests / tools: the summons and their battle stock (`infos[i].group.left`)
  const state = { infos };
  owner.mem.genericSummons = state;
  return state;
}

/** Owner talent clauses whose subject is a summon (see header). */
function installOwnerLinks(battle, owner, talents, infos, mine, H) {
  const clauses = [];
  for (const t of talents) for (const s of descOf(t).split(/[。；]/)) for (const c of s.split('，')) if (c) clauses.push({ c, bb: t.bb || {}, sent: s });
  const anyAlive = () => battle.allyUnits.some((u) => mine(u) && u.alive && u.deployed);
  for (const { c, bb, sent } of clauses) {
    let m = c.match(new RegExp(`^[^，]{1,8}?在场时，?自身攻击力\\+${N}%$`)) ?? (/在场时/.test(c) ? null : null);
    if (!m && /在场时$/.test(c)) {
      // "“中继器”在场时，自身攻击力+25%" split by the comma: the next clause of the sentence
      const nx = sent.match(new RegExp(`在场时，自身攻击力\\+${N}%`));
      if (nx) m = [null, nx[1]];
    }
    if (m && !/^可以/.test(c)) {
      const v = num(bb.atk, +m[1] / 100);
      const key = `gs:ownerWhile:${owner.id}`;
      battle.on('tick', () => {
        const want = up(owner) && anyAlive();
        const has = owner.findBuff(key);
        if (want && !has) battle.addBuff(owner, { key, mods: { atkPct: v }, tags: ['talent'] });
        else if (!want && has) battle.removeBuff(owner, key);
      }, { owner });
      continue;
    }
    m = c.match(new RegExp(`^[^，]{1,8}?受到伤害时$`)) && sent.match(new RegExp(`受到伤害时，有${N}%的概率使[^，]{1,8}?获得${N}点技力`));
    if (m) {
      const p = num(bb.prob, +m[1] / 100), sp = num(bb.sp, +m[2]);
      battle.on('damaged', (x) => {
        if (!mine(x.target) || !(x.amount > 0) || !x.source || x.source.side !== 'enemy') return;
        if (up(owner) && battle.rng.chance(p)) giveSp(owner, sp);
      }, { owner });
      continue;
    }
    m = c.match(new RegExp(`召唤物获得相当于其自身${N}[%％]攻击力、防御力、生命值的鼓舞效果`));
    if (m) {
      const v = num(bb.atk, +m[1] / 100);
      battle.on('deploy', (x) => {
        if (!mine(x.unit)) return;
        battle.addBuff(x.unit, { key: `gs:inspire:${owner.id}`, mods: { atkPct: num(bb.atk, v), defPct: num(bb.def, v), hpPct: num(bb.max_hp, v) }, persist: true, allowDead: true, tags: ['talent'] });
      }, { owner, priority: 35 });
      continue;
    }
    m = sent.match(new RegExp(`^陷阱触发后，[^，]{1,8}?获得${N}%的攻击力，最多叠加(\\d+)层$`));
    if (m && /^陷阱触发后$/.test(c)) {
      const v = num(bb.atk, +m[1] / 100), max = num(bb.max_stack_cnt, +m[2]);
      battle.on('summonTrap', (x) => { if (x.owner === owner) battle.addBuff(owner, { key: `gs:trapStack:${owner.id}`, mods: { atkPct: v }, refresh: 'stack', stacks: 1, maxStacks: max, persist: true, allowDead: true, tags: ['talent'] }); }, { owner });
      continue;
    }
    m = c.match(new RegExp(`^召唤物被击倒\\/吸收\\/回收时[^，]{1,8}?额外获得${N}点技力、攻击力\\+${N}%（攻击力加成最多叠加(\\d+)层）$`));
    if (m) {
      const sp = num(bb.sp, +m[1]), v = num(bb.atk, +m[2] / 100), max = num(bb.max_stack_cnt, +m[3]);
      battle.on('death', (x) => {
        if (!mine(x.unit) || !up(owner)) return;
        giveSp(owner, sp);
        battle.addBuff(owner, { key: `gs:summonDown:${owner.id}`, mods: { atkPct: v }, refresh: 'stack', stacks: 1, maxStacks: max, tags: ['talent'] });
      }, { owner });
      continue;
    }
    m = c.match(new RegExp(`^[^，]{1,8}?周围友方单位的攻击力\\+${N}%$`));
    if (m) {
      const v = num(bb.atk, +m[1] / 100);
      const key = `gs:aroundSummon:${owner.id}`;
      battle.every(0.5, () => {
        if (!up(owner)) return;
        for (const t of battle.allyUnits) {
          if (!mine(t) || !up(t)) continue;
          for (const a of battle.alliesInRadius(t.x, t.y, 1.5, null)) if (a !== t && battle.allySelectable(a, t)) battle.addBuff(a, { key, duration: 0.6, mods: { atkPct: v }, source: t, tags: ['talent', 'aura'] });
        }
      }, { owner, immediate: true });
    }
  }
}
