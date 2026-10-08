// server/sim/content/kits/ops/op-ela.js — 艾拉 (char_4123_ela) 自选 operator kit: 6★ 陷阱师 (特种), an owned-6★ pick of the
// tier-5 and tier-6 自选 slots — a collab pick of this fork (tools/build-data.mjs FORK_INCLUDE_COLLAB_PICKS, the fork owner's
// decision of 2026-10-08: the 7 collab 6★ upstream leaves out of 自选 come back in full). Every skill, both talents, the
// trait, the module TRP-D 社会期望背包 at every form, and the kit of her trap 雷鸣地雷 (token_10033_ela_grzmot). Kit contract
// and the 自选 rules: ../README.md ("How to add an operator (自选)"); the closest worked example: op-doroth.js (多萝西).
//
// Forms (data/backups.json units.char_4123_ela, the DIY slot statuses): normal = E2 Lv1, skills at rank 4, no module; elite =
// E2 Lv60, rank 7, TRP-D at stage 1 (tier 5) or 3 (tier 6). Full potential (the owner's decision of 2026-10-07: 雷鸣地雷 cnt 4,
// 正中靶心 160 %, cost 10). Sources: character_table / skill_table / battle_equip_table / token_table (zh_CN, as built into
// backups.json; the mine's owner-form / skill variants sktok_ela_1–3), PRTS 艾拉 (第一天赋备注 "※陷阱部署上限与最多拥有数量相同。
// ※雷鸣地雷触发半径1.35，效果影响半径1.7；以任何方式离场均可触发本天赋（死亡等触发死亡动作时跟随动画，无撤退动画时在离场瞬间立刻触发）";
// S1 备注 "※陷阱持有库存达到上限的情况下具有阻回"; S2 备注 "※普通攻击溅射半径1.1"; 模组 "※携带进入战斗后，将自身部署类型改为<全部位>"),
// PRTS 雷鸣地雷 (特性 "不会受到攻击，无法放置于敌人已在的格子中"; 再部署策略 默认 "部署后，待部署区卡片进入再部署冷却且不可部署，直到冷却结束";
// "※最终乘算，同名效果不叠加"), PRTS 分支特性信息 陷阱师 ("可对空" / "“敌人已在”…所有的地面行动敌人类单位" / "触发效果时不会对空中单位
// 生效" / "干员离场后，附属的陷阱随之消失"), PRTS 命中率 (one roll per attack, a miss misses as a whole), PRTS 卫戍协议/帮助
// §作战阶段 (placed summons deploy with the board "无视所属干员的持有状态，不消耗持有数量"; "若召唤物在战斗期间退场，将在满足条件后立即
// 原地再部署1个").
// - Trait (陷阱师) "可以使用陷阱来协助作战，但陷阱无法放置于敌人已在的格子中": ranged physical arrows, 3-3, hits air units (分支特性信息
//   "可对空"; the data's canHitFly over the profession table), blocks 1, ground enemies target her. Her mines never (re)deploy on
//   a tile a ground enemy stands on, and leave when she leaves the field.
// - The mines in this mode: hand pieces the player places (data `placeable`, deploy limit 4 — the prep hands out one stack;
//   server/match/player/diy.js). Placed pieces deploy with the board, free and ignoring her stock (PRTS 卫戍协议/帮助, as
//   多萝西's 共振装置 — [ASSUMED] not 望's model of 2026-10-06, whose stall reason does not arise here: a returning mine spends
//   one of her stock, so the stock keeps moving); a spent one stays its tile's piece and comes back there once the deployment
//   conditions hold: she is on the field, her stock holds a mine, the card's redeploy time (data respawnTime 5 s) has run
//   since the last mine deployment (再部署策略 默认), its player has its cost in DP (5), fewer of her mines than the deploy limit
//   stand and no ground enemy is on the tile; one piece per check (uid order), paying the cost and spending one mine.
// - T1 雷鸣地雷 "可以使用4（+1）个雷鸣地雷（最多拥有4个），经过周围的第一个敌人会触发其效果，撤退时以自身为中心触发一次雷鸣地雷效果" (bb cnt):
//   her stock is cnt at each deployment [ASSUMED: the trapper charge_token[refresh] of 多萝西's client data] and holds at most
//   the deploy limit (备注 "陷阱部署上限与最多拥有数量相同": the token's deployLimit 4, else the text's 最多拥有N个). A mine goes off
//   when a selectable ground enemy comes within TRIGGER_RADIUS (1.35, 备注; no blackboard key) of it [ASSUMED: air units
//   never set it off — the token data's canHitFly false — and radii reach a huge enemy's body, PRTS 作战机制 collider tests]:
//   the effect of the token skill of her pick (bySkill) on every selectable ground enemy within projectile_range (1.7) — air
//   units never ("触发效果时不会对空中单位生效") —, then it withdraws (spent). When she leaves the field in any way (killed,
//   withdrawn; [ASSUMED] not the 联防 forced exit of an operator that never stood there, nor the battle's end) the same effect
//   goes off once centred on her ("撤退时以自身为中心触发一次雷鸣地雷效果"), then her mines leave.
//   An enemy hit by a mine effect is "受到雷鸣地雷效果影响" for the longest duration of that effect (key ELA_MARK, any 艾拉's
//   mine [ASSUMED]; whether or not an immunity refused the status [ASSUMED]): T2 and S3 read it.
// - T2 “正中靶心” "攻击有30%几率造成相当于攻击力160%（+10%）的物理伤害，对受到雷鸣地雷效果影响的目标必定触发" (bb prob, atk_scale; TRP-D
//   stage 3: 50 % / 180 %): one roll per attack (attackId) — its damage instances ×atk_scale before mitigation (as 普罗旺斯's
//   狩猎箭头) —, always on a marked victim; S2's splash shares the attack's roll, each marked victim always gets it [ASSUMED].
// - S1 眩目阻滞 (AUTO, the data's DEFAULT): 被动 = the mine's sktok_ela_1 — 停顿 `sluggish` s and 物理 / 法术命中率 −|damage_hitrate_*|
//   for `duration` s (PRTS 命中率: each attack of such an enemy of that damage type misses whole with that chance, one roll per
//   attack; 同名效果不叠加 — the strongest of 艾拉's; another source's hit-rate cut rolls on its own [ASSUMED, as the 娜仁图亚 /
//   Raidian kits]). The rate is the one the enemy holds when it starts the attack (PRTS 命中率 "其会在开始攻击时会进行一次命中
//   判定"): taken at its `beforeAttack`, so a cut that reaches it while its shot flies spares that shot and one that lapses
//   meanwhile still makes it miss (the roll itself comes with the attack's first damage instance; an attack made outside the
//   engine's enemy attack — content damage with an attackId but no attack start — reads the rate it holds then [ASSUMED]).
//   The 娜仁图亚 / Raidian kits read their cut at the first damage instance instead (their own [ASSUMED]). 主动 "立即获得一个陷阱" (no blackboard key: GAIN_S1): +1 to her stock; it acts on herself only, so it fires
//   as soon as its SP is full (`trigger: 'SP_FULL'` — the owner's AUTO rule, kits/README.md checklist 5). 阻回 while her stock
//   is full (S1 备注 only: with S2 / S3 a gain over the cap is lost).
// - S2 震荡坚守 (MANUAL, attack SP, 20 s, the data's DEFAULT — its 3-6 is smaller than her 3-3): 被动 = sktok_ela_2 — 晕眩 `stun` s.
//   主动: DEF +def (直接乘算), range 3-6, attacks splash physical damage within attack@projectile_range (1.1, 备注) around the
//   target and ignore def_penetrate_fixed DEF (the main hit and the splash [ASSUMED]); "技能结束时获得一个陷阱" (GAIN_S2).
// - S3 “博萨克风暴” (MANUAL, ammo, the data's DEFAULT): 被动 = sktok_ela_3 — 停顿 `sluggish` s and 脆弱 damage_scale − 1 for
//   weak[limit] s (the catalogue fragile: "同名效果不叠加" — the strongest). 主动: base attack time base_attack_time s (a flat
//   change, batMod), ATK +atk, attack@trigger_time bullets, "优先攻击受到雷鸣地雷效果影响的敌人" (the enemy she blocks first, then
//   the marked ones, then the usual order [ASSUMED]); at its end (not her death) +cnt mines.
// - TRP-D 社会期望背包: ATK / DEF in the stats; stage 3: T2 50 % / 180 % (the composed talents). Its trait addition "自身可以
//   额外部署在近战位，陷阱可以额外部署在远程位" (hidden talent buildable_type 3) is a 部署效果, which 卫戍协议 switches off (PRTS
//   卫戍协议/帮助 §战斗部署; server/match/board.js, shared/highGround.js: the loadout never changes a placement class — the owner's
//   decision of 2026-10-05): she, a RANGED chess, stands on melee tiles in this mode anyway; her mines keep the melee tiles.

import { num, talentBb, skillRec, up, toggleBuff, batMod, onHitBy } from '../shared/tier1.js';
import { sortEnemyTargets } from '../../../targeting.js';
import { bodyOnTile } from '../../../body.js';

const S1 = 'skchr_ela_1';
const S2 = 'skchr_ela_2';
const S3 = 'skchr_ela_3';
/** 雷鸣地雷, her trap. */
export const MINE = 'token_10033_ela_grzmot';
const TS1 = 'sktok_ela_1';
const TS2 = 'sktok_ela_2';
const TS3 = 'sktok_ela_3';
/** 雷鸣地雷 触发半径 (PRTS 艾拉 第一天赋备注 "雷鸣地雷触发半径1.35"; no blackboard key). */
export const TRIGGER_RADIUS = 1.35;
/** 效果影响半径 when the blackboard carries none (备注 "效果影响半径1.7" = bb projectile_range). */
const EFFECT_RADIUS = 1.7;
/** S2 splash radius when the blackboard carries none (S2 备注 "普通攻击溅射半径1.1" = bb attack@projectile_range). */
const SPLASH_RADIUS = 1.1;
/** S1 "立即获得一个陷阱", S2 "技能结束时获得一个陷阱" (no blackboard key); S3's "两个" is bb cnt. */
const GAIN_S1 = 1;
const GAIN_S2 = 1;
const GAIN_S3_FALLBACK = 2;
/** How often a spent piece checks its redeploy conditions. */
const WATCH = 0.25;
/** "受到雷鸣地雷效果影响" (any 艾拉's mine). */
export const ELA_MARK = 'ela:mine';
/** 眩目阻滞's hit-rate cuts (applyStrongest: 同名效果不叠加). */
export const HIT_PHYS = 'ela:hitratePhys';
export const HIT_ARTS = 'ela:hitrateArts';
/** The hit-rate roll runs before the enemy content's own hit riders (200), with the other hit-rate kits (娜仁图亚 300). */
const MISS_PRIORITY = 300;
const FULL_KEY = 'talent:ela:full';

const bbOf = (chess, id) => skillRec(chess, id)?.bb ?? {};
const mineOf = (t) => !!t && t.kind === 'token' && t.defId === MINE;
/** Enemies a mine selects within `r` of (x, y): selectable (foesInRadius), ground only. */
const groundFoes = (battle, x, y, r) => battle.foesInRadius(x, y, r).filter((e) => !e.isFlying);
/** A ground enemy stands on tile (r, c) — a huge one on any tile of its body; air units never count (分支特性信息). */
function groundEnemyOn(battle, r, c) {
  for (const e of battle.enemies) if (e.alive && !e.hidden && !e.isFlying && bodyOnTile(e, r, c)) return true;
  return false;
}
/** Under a 雷鸣地雷 effect. */
export const marked = (e) => !!e && e.alive && !!e.findBuff(ELA_MARK);

// ---- 眩目阻滞's hit rate: one battle-wide `hit` handler, whichever 艾拉 put the cut on the attacker ----------------------
/** battle → { last: WeakMap(enemy → { id, miss }), start: WeakMap(enemy → its attack start's cuts), byId: Map(attackId → cuts) }. */
const MISS = new WeakMap();
/** The attacks whose shots may still be in flight (their attack start's cuts, by attackId). */
const STARTS_KEPT = 256;
const cutOf = (e, key) => Math.min(1, Math.abs(num(e.findBuff(key)?.data?.value)));
/** The cut of attack `d` of enemy `e`: the one of its attack start when the engine made it, else the one it holds now. */
function cutAt(battle, st, e, d) {
  const key = d.type === 'arts' ? 'arts' : 'phys';
  const snap = (d.attackId && st.byId.get(d.attackId)) || st.start.get(e);
  if (snap && snap.e === e && (snap.id === d.attackId || (snap.id == null && snap.t === battle.time))) return snap[key];
  return cutOf(e, key === 'arts' ? HIT_ARTS : HIT_PHYS);
}
function missHit(battle, st, ctx) {
  const e = ctx.source, d = ctx.dmg;
  if (!e || e.side !== 'enemy' || !d || !d.isAttack || d.cancel || (d.type !== 'phys' && d.type !== 'arts')) return;
  const cut = cutAt(battle, st, e, d);
  if (!(cut > 0)) return;
  // one roll per attack: every damage instance of it (each target, a multi-hit) shares the first instance's result
  const prev = d.attackId ? st.last.get(e) : null;
  let miss;
  if (prev && prev.id === d.attackId) miss = prev.miss;
  else {
    miss = battle.rng() < cut;
    if (d.attackId) st.last.set(e, { id: d.attackId, miss });
  }
  if (!miss) return;
  d.cancel = true;
  ctx.stopPropagation = true;
  if (ctx.target) battle.fx('dodge', { x: ctx.target.x, y: ctx.target.y, id: ctx.target.id });
}
function installMiss(battle) {
  if (MISS.has(battle)) return;
  const st = { last: new WeakMap(), start: new WeakMap(), byId: new Map() };
  MISS.set(battle, st);
  // no owner: it serves every enemy any 艾拉's mine reached, whether she is still on the field or not
  battle.on('hit', (ctx) => missHit(battle, st, ctx), { priority: MISS_PRIORITY });
  // the attack start (PRTS 命中率): the cuts the enemy holds as it attacks — a melee hit lands before the `attack` hook (the
  // start's entry serves it, same instant), a shot carries them by its attackId from the `attack` hook on
  battle.on('beforeAttack', (ctx) => {
    const e = ctx.attacker;
    if (!e || e.side !== 'enemy') return;
    st.start.set(e, { e, id: null, t: battle.time, phys: cutOf(e, HIT_PHYS), arts: cutOf(e, HIT_ARTS) });
  }, { priority: -1000 });
  battle.on('attack', (ctx) => {
    const e = ctx.attacker;
    const snap = e && e.side === 'enemy' ? st.start.get(e) : null;
    if (!snap || snap.t !== battle.time || snap.id != null || !ctx.attackId) return;
    snap.id = ctx.attackId;
    st.byId.set(ctx.attackId, snap);
    if (st.byId.size > STARTS_KEPT) st.byId.delete(st.byId.keys().next().value);
  }, { priority: 1000 });
}

/**
 * One 雷鸣地雷 effect at (x, y) — `sk` = the token skill of the pick (bySkill): its statuses on every selectable ground enemy
 * within projectile_range, and the "受到雷鸣地雷效果影响" mark for the longest of them. Returns the enemies reached.
 */
function mineEffect(battle, src, x, y, sk) {
  const tb = sk?.bb ?? {};
  const id = sk?.id ?? sk?.skillId ?? TS1;
  const victims = groundFoes(battle, x, y, num(tb.projectile_range, EFFECT_RADIUS));
  let mark = 0;
  for (const e of victims) {
    if (!e.alive) continue;
    if (id === TS2) {
      const st = num(tb.stun);
      if (st > 0) battle.applyStatus(e, 'stun', { duration: st, source: src });
      mark = Math.max(mark, st);
    } else if (id === TS3) {
      const sl = num(tb.sluggish), fr = num(tb.damage_scale, 1) - 1, fd = num(tb['weak[limit]'], sl);
      if (sl > 0) battle.applyStatus(e, 'sluggish', { duration: sl, source: src });
      if (fr > 0 && fd > 0 && e.alive) battle.applyStatus(e, 'fragile', { duration: fd, value: fr, source: src });
      mark = Math.max(mark, sl, fr > 0 ? fd : 0);
    } else {
      const sl = num(tb.sluggish), dur = num(tb.duration);
      const p = Math.abs(num(tb.damage_hitrate_physical)), a = Math.abs(num(tb.damage_hitrate_magical));
      if (sl > 0) battle.applyStatus(e, 'sluggish', { duration: sl, source: src });
      if (dur > 0 && e.alive) {
        if (p > 0) battle.applyStrongest(e, HIT_PHYS, { duration: dur, value: p, mods: () => null, source: src });
        if (a > 0) battle.applyStrongest(e, HIT_ARTS, { duration: dur, value: a, mods: () => null, source: src });
        if (p > 0 || a > 0) installMiss(battle);
      }
      mark = Math.max(mark, sl, p > 0 || a > 0 ? dur : 0);
    }
  }
  if (mark > 0) for (const e of victims) if (e.alive) battle.addBuff(e, { key: ELA_MARK, duration: mark, refresh: 'extend', source: src, tags: ['skill'] });
  battle.fx('explode', { x, y, r: num(tb.projectile_range, EFFECT_RADIUS), id: src.id, kind: `ela:${id}`, n: victims.length });
  return victims;
}

export default {
  char_4123_ela: (bb, chess) => {
    const t0 = talentBb(chess, 0);   // 雷鸣地雷: cnt
    const t1 = talentBb(chess, 1);   // 正中靶心: prob, atk_scale (TRP-D stage 3: its change)
    const t0desc = String((chess?.talents ?? []).find((t) => t && t.index === 0)?.desc ?? '');
    const b2 = bbOf(chess, S2), b3 = bbOf(chess, S3);
    const s2 = skillRec(chess, S2);
    const stockRefill = Math.max(0, Math.floor(num(t0.cnt, 0)));
    const crit = { prob: num(t1.prob), scale: num(t1.atk_scale, 1) };
    // her stock, the card's ready time, the deploy limit (per unit: the factory runs per unit; also `unit.trait.ela` for
    // diagnostics and tests)
    const E = { stock: 0, readyAt: -Infinity, limit: Infinity };

    const mines = (battle, unit) => battle.allyUnits.filter((t) => mineOf(t) && t.ownerUnit === unit);
    const standing = (battle, unit) => mines(battle, unit).filter((t) => t.alive).length;
    const gain = (n) => { E.stock = Math.min(E.limit, E.stock + Math.max(0, Math.floor(n))); };

    /** The token's deploy limit for her loadout (variant stats, the module's when it carries one); her max stock too. */
    function limitOf(battle, unit) {
      const raw = battle.data.rawToken?.(MINE);
      const v = raw?.variants?.[unit.def?.tokenOwner];
      const mod = unit.def?.loadout?.moduleId;
      const n = num(v?.byModule?.[mod]?.stats?.deployLimit, num(v?.stats?.deployLimit, num(raw?.deployLimit, 0)));
      if (n > 0) return n;
      const m = /最多拥有(\d+)个/.exec(t0desc);
      return m ? +m[1] : Infinity;
    }

    /** The mine `t` goes off: its effect (the token skill of her pick), then it withdraws. */
    function fire(battle, t) {
      if (!t.alive || t.mem.elaFired) return;
      t.mem.elaFired = true;
      mineEffect(battle, t, t.x, t.y, t.def?.skill ?? null);
      battle.fx('explode', { x: t.x, y: t.y, r: 0.5, id: t.id, consumed: true, kind: 'ela:mine' });
      battle.retreat(t, { reason: 'expired', permanent: true });
    }

    /** 雷鸣地雷's kit (`unit` = 艾拉): untargetable (data), no block, no attack; its trigger; a placed piece kept for its returns. */
    function mineKit() {
      return {
        skill: null,
        trait: { noAttack: true },
        install(battle, t) {
          battle.on('deploy', (ctx) => {
            if (ctx.unit !== t) return;
            t.mem.elaFired = false;
            E.readyAt = battle.time + Math.max(0, num(t.base.respawnTime, 0));   // 再部署策略 默认: the card's cooldown
          }, { owner: t });
          battle.on('tick', () => {
            if (!t.alive || t.mem.elaFired) return;
            if (groundFoes(battle, t.x, t.y, TRIGGER_RADIUS).length) fire(battle, t);
          }, { owner: t });
          // a placed piece stays its tile's piece (redeployed by her kit's watch), whatever took it off the field
          if (t.uid != null) battle.on('death', (ctx) => { if (ctx.unit === t && !battle.finished) t.removed = false; }, { owner: t, priority: -10 });
        },
      };
    }

    const s3On = (u) => !!(u.skill && u.skill.active && u.skill.id === S3);

    return {
      skills: {
        [S1]: {
          kind: 'instant', trigger: 'SP_FULL',
          onStart() { gain(GAIN_S1); },   // 主动效果：立即获得一个陷阱
        },
        [S2]: {
          kind: 'duration',
          mods: { defPct: num(b2.def), defIgnoreFlat: num(b2.def_penetrate_fixed) },
          targeting: { rangeGrid: s2?.rangeGrid ?? null },
          attack: { splashRadius: num(b2['attack@projectile_range'], SPLASH_RADIUS) },
          onEnd({ reason }) { if (reason !== 'death') gain(GAIN_S2); },   // 技能结束时获得一个陷阱
        },
        [S3]: {
          kind: 'ammo',
          ammo: Math.max(1, Math.floor(num(b3['attack@trigger_time'], 40))),
          mods: { atkPct: num(b3.atk), batPct: batMod(b3.base_attack_time, chess) },
          onEnd({ reason }) { if (reason !== 'death') gain(num(b3.cnt, GAIN_S3_FALLBACK)); },   // 技能结束时获得两个陷阱
        },
      },
      talents: [
        { install(battle, unit) { // 雷鸣地雷: the pieces' kit, the stock, the returns, the exit blast
          E.limit = limitOf(battle, unit);
          unit.trait.ela = E;
          for (const t of mines(battle, unit)) {
            if (t.alive || t.deployed) continue;
            if (t.kit) battle.offOwner(t);   // a piece set up before her: drop its generic kit's hooks
            battle._setupUnit(t, mineKit());
          }
          battle.on('deploy', (ctx) => {
            if (ctx.unit !== unit || ctx.move) return;
            E.stock = Math.min(E.limit, stockRefill);
          }, { owner: unit });
          // "撤退时以自身为中心触发一次雷鸣地雷效果" (any exit); then her mines leave with her (分支特性信息), the pieces wait
          battle.on('death', (ctx) => {
            if (ctx.unit !== unit || battle.finished) return;
            if (ctx.reason !== 'forcedExit') mineEffect(battle, unit, unit.x, unit.y, battle.tokenDef(MINE, unit)?.skill ?? null);
            for (const t of mines(battle, unit)) if (t.alive) battle.retreat(t, { reason: 'expired', permanent: true });
          }, { owner: unit });
          // a spent piece comes back on its tile once the deployment conditions hold (see the header)
          battle.every(WATCH, () => {
            if (!up(unit) || E.stock < 1 || battle.time + 1e-9 < E.readyAt || standing(battle, unit) >= E.limit) return;
            const pieces = mines(battle, unit).filter((t) => t.uid != null && !t.alive && !t.removed).sort((a, b) => a.uid - b.uid);
            for (const p of pieces) {
              if (groundEnemyOn(battle, p.homeR, p.homeC)) continue;   // "无法放置于敌人已在的格子中"
              if (battle.redeploy(p, { free: false })) { E.stock--; break; }
            }
          }, { owner: unit });
        } },
        { install(battle, unit) { // 正中靶心: one roll per attack, sure on a marked victim
          if (!(crit.scale > 0) || crit.scale === 1) return;
          const st = { id: -1, proc: false };
          onHitBy(battle, unit, ({ target, dmg }) => {
            if (!dmg.isAttack || dmg.cancel) return;
            if (dmg.attackId !== st.id) { st.id = dmg.attackId; st.proc = crit.prob > 0 && battle.rng.chance(crit.prob); }
            if (!st.proc && !marked(target)) return;
            dmg.amount *= crit.scale;
            battle.fx('crit', { x: target.x, y: target.y, id: unit.id });
          });
        } },
      ],
      install(battle, unit) {
        // 阻回 while her stock is full (S1 备注)
        if (unit.skill?.id === S1) toggleBuff(battle, unit, FULL_KEY, () => E.stock >= E.limit, {}, { flags: { noSp: true } });
        // 眩目阻滞 (S1's mines) cuts hit rates: the attack starts are watched from the battle's start, so a shot already
        // flying when the first cut lands is judged by the rate of its own start (none)
        if (unit.skill?.id === S1) installMiss(battle);
        // S3 "优先攻击受到雷鸣地雷效果影响的敌人": the enemy she blocks, then the marked ones, then the usual order
        if (unit.skill?.id === S3) {
          battle.on('beforeAttack', (ctx) => {
            if (ctx.attacker !== unit || !s3On(unit) || !ctx.targets.length) return;
            if (ctx.targets.every((e) => marked(e) || e.blockedBy === unit)) return;
            const prof = ctx.profile || unit.profile;
            const cands = battle.enemiesInKeys(unit.rangeKeys, unit, prof);
            for (const e of battle.blockedTargets(unit, prof)) if (!cands.includes(e)) cands.push(e);
            if (!cands.some(marked)) return;
            sortEnemyTargets(battle, unit, cands, prof.priority ?? null);
            const rank = (e) => (e.blockedBy === unit ? 0 : marked(e) ? 1 : 2);
            const order = cands.map((e, i) => ({ e, i, k: rank(e) })).sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.e);
            ctx.targets = order.slice(0, Math.max(1, ctx.targets.length));
          }, { owner: unit });
        }
      },
    };
  },
};
