// server/sim/content/kits/waiguan/char_479_sleach.js — 琴柳 (先锋 · 执旗手 bearer) 外援 kit (DESIGN §27, KIT_GUIDE.md).
//
// Chess ids: chess_char_diy_5_char_479_sleach_a/_b, chess_char_diy_6_char_479_sleach_a/_b (registered by ./index.js).
// Numbers: normal = skill Lv4, elite = Lv7 + its module at the tier's level (tier V 1, tier VI 3; data/waiguan.json);
//   every number below comes from a blackboard of the loadout-resolved record.
// Trait (bearer) "技能发动期间阻挡数变为0": professions.js SUB.bearer (block −99 from skillStart to skillEnd) — kept.
// DP (REQUIREMENTS §1): real DP only — Battle.addDp(her player) for every gain, `unit.base.cost` (the redeploy cost the
//   engine pays in _checkRedeploys / redeploy) for 精神感召.
// Triggers: every skill is MANUAL and the official 执旗手 class row is ALWAYS (= SP_FULL: "as soon as SP is full"), which
//   the record carries — kept for all three, none corrected. S3 needs no target to be cast (official sleach_s_3:
//   TriggerAbility "DamageFlag" with _castDirectly and no _checkCanUseAblityFlag): with no ground enemy on its range the
//   flag stays with her.
// S1 支援号令·γ型 (duration): no attack; +cost DP every `interval` s, `value` DP in all (the rest at a natural end).
// S2 信仰传承 (duration): no attack; +sleach_s_2[cost].cost DP every sleach_s_2[cost].interval s, `value` in all; the
//   flag lands on the operator of her skill range (x-1) with the lowest HP ratio: that operator gets DEF +def and,
//   every second, a heal of atk_to_hp_recovery_ratio × her ATK; the flag comes back at the end.
// S3 光辉旗帜 (duration): no attack; +cost DP at once; the flag lands on a ground enemy of her 2-1 range: every enemy on
//   the 3×3 around it takes atk_scale × ATK physical and `stun` s 晕眩; while it runs every enemy on the 3×3 around the
//   flag is 停顿 and 脆弱 +debuff.damage_scale; the flag comes back at the end. No ground enemy on the range: no throw and
//   no impact — the flag stays with her, and the 停顿 / 脆弱 field and T1 centre on her for the skill.
// T1 不退之旗: the flag (on her, or where S2 / S3 threw it) — every operator on the 3×3 around it ASPD
//   +sleach_t_1[ally].attack_speed, every enemy there ASPD +sleach_t_1[enemy].attack_speed (negative); with two 琴柳 the
//   stronger flag holds (allies: kept holder on a tie; enemies: Battle.applyStrongest).
// T2 精神感召: once she has been deployed, the next operator of her player to be deployed costs −value (value < 0) DP:
//   from her deployment on, every waiting operator of her player (knocked out / not deployed yet) has its base cost cut,
//   the first one deployed pays the cut cost and the cut ends for all; it also ends when she leaves the field (official
//   sleach_t_2: card buff "UNTIL_NEXT_SPAWN_SYNC_WITH_BUFF", ended with her talent). The battle-start deployments run
//   one after another in the official order (Battle.start), so the operator deployed right after her consumes it (free
//   anyway). BEA-Y upgrade (hidden part `cost`, sleach_e_003): if that operator is a ground (MELEE) one, her player gets
//   +cost DP once it is deployed.
// Module BEA-X (uniequip_002_sleach) trait: while a skill runs, the operator on the tile in front of her block
//   +block_cnt (sleach_trait_e: rangeId 1-1 without herself, refreshed every 0.2 s, gone at the skill's end).
// Module BEA-Y (uniequip_003_sleach) trait: 迷彩 while a skill runs (sleach_e_003[tr]).
// Module dispatch: `chess.module.type` of the active module ('BEA-X' / 'BEA-Y'), numbers from the record.
// fx: 'dp', 'buff' (S2 flag), 'aoe' (S3 impact), 'camouflage' (BEA-Y).
// [ASSUMED] (PRTS unreachable from the authoring container):
//   * "军旗周围8格" = the 3×3 square centred on the flag, its own tile included (she holds it ⇒ she is buffed too); the
//     S3 impact "对周围" uses the same 3×3; flyers are hit / slowed there (the text restricts only the landing target).
//   * DP drips (S1 / S2): the first grant one interval after the cast (no grant at the cast); a knock-out ends the skill
//     and the drip (no rest); a natural end grants whatever float timing left out.
//   * S2: "范围内…干员" counts every allied operator (her teammate's too on a shared field) incl. herself; ties of HP ratio
//     go to the nearest (herself first), then the earliest deployed; heals from 1 s after the throw, once per second,
//     with her ATK of the moment; the DEF / heal follow that operator (not the tile); two 琴柳 on one operator: the
//     stronger DEF holds and only its holder heals.
//   * S3: the target is the first ground enemy of the engine's attack order; damage and stun land before the 停顿 / 脆弱
//     field starts; cast with no ground enemy on its range, the flag stays with her (no impact) and the field and T1
//     centre on her tile.
//   * T1 / BEA-X: positional effects reach any allied operator on those tiles (no summons), whatever its player.
//   * T2: the cut and the BEA-Y DP count operators only (summons neither consume nor get it); a move-deployment
//     (Battle.moveRedeploy, "可以通过移动行为多次触发部署时触发的效果") counts as a deployment; with two 琴柳 one cut at a
//     time (the later deployment arms it after consuming the earlier one).
//   * BEA-X: two 琴柳 in front of one operator give +block_cnt once (KIT_CONVENTIONS 4; the official buff is
//     independentCharacterSource).

import { num, tal, hiddenBb, traitBb, lazySkills, gridOf, isOp, live, whileOn, bstate, ANY, alliesInGridOf } from './_lib.js';
import { absoluteRangeKeys, sortEnemyTargets } from '../../../targeting.js';
import { COLS, ROWS } from '../../../constants.js';
import { keyTiles } from '../../fxtiles.js';

const S1 = 'skcom_assist_cost[3]';
const S2 = 'skchr_sleach_2';
const S3 = 'skchr_sleach_3';
/** Refresh period of every area effect (official sleach_trait_e[trigger] triggerInterval 0.2 s) and its buff length. */
const AURA_IV = 0.2;
const AURA_DUR = 0.35;
/** S2 "每秒恢复…": one heal per second. */
const HEAL_IV = 1;
/** BEA-X "身前一名干员": the official rangeId 1-1 without her own tile. */
const FRONT = Object.freeze([[0, 1]]);
const GROUND = Object.freeze({ canHitFly: false, groundOnly: true });
const K_FLAG = 'sleach:flag';
const K_FLAG_FOE = 'sleach:flagFoe';
const K_FAITH = 'sleach:faith';
const K_FRONT = 'sleach:frontBlock';
const K_CAMOU = 'sleach:camou';

/** Absolute tile keys of the 3×3 square centred on (r, c) ("周围8格"). */
function around(r, c) {
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS) out.push(rr * COLS + cc);
    }
  }
  return out;
}
/** The flag's tile: where a skill threw it, else hers. */
const flagTile = (u) => u.mem.sleachFlag ?? [u.tileR, u.tileC];
/** Allied operators an ability of `src` may select on tile keys `set`. */
const opsOn = (battle, src, set) => battle.allyUnits.filter((a) => isOp(a) && a.alive && a.deployed && !a.hidden && set.has(a.tileR * COLS + a.tileC) && battle.allySelectable(a, src));
/**
 * Short buff `key` of strength `v` from `src` on ally `a`, refreshed by the caller: another copy's equal or stronger one
 * that still runs keeps the target (no doubling, no flicker — KIT_CONVENTIONS 4). True when `src` holds it now.
 */
function hold(battle, a, src, key, v, extra) {
  const cur = a.findBuff(key);
  if (cur && cur.source !== src && num(cur.data?.v) >= v && cur.timeLeft > 0.05) return false;
  battle.addBuff(a, { key, duration: AURA_DUR, source: src, data: { v }, ...extra });
  return true;
}
/** Remove `key` from every ally where `src` put it. */
function dropFrom(battle, src, key) {
  for (const a of battle.allyUnits) {
    const b = a.findBuff(key);
    if (b && b.source === src) battle.removeBuff(a, b);
  }
}
/** +n DP for `unit`'s player (Battle.addDp: capped at dpMax). */
function giveDp(battle, unit, n) {
  if (!(n > 0)) return;
  battle.addDp(unit.ownerId, n);
  battle.fx('dp', { x: unit.x, y: unit.y, id: unit.id, n });
}
/**
 * "持续时间内回复总共`total`点部署费用": +`per` DP every `iv` s from the cast until `total` was given; a natural end
 * ('duration') grants what is left, any other end stops it. State in unit.mem[memKey].
 */
function drip(total, per, iv, memKey) {
  const step = per > 0 ? per : total;
  return {
    start(battle, unit) {
      unit.mem[memKey] = { acc: 0, given: 0 };
      if (!(iv > 0) && total > 0) { unit.mem[memKey].given = total; giveDp(battle, unit, total); }
    },
    tick(battle, unit, dt) {
      const m = unit.mem[memKey];
      if (!m || !(iv > 0)) return;
      m.acc += dt;
      while (m.acc + 1e-9 >= iv && m.given < total - 1e-9) {
        m.acc -= iv;
        const n = Math.min(step, total - m.given);
        m.given += n;
        giveDp(battle, unit, n);
      }
    },
    end(battle, unit, reason) {
      const m = unit.mem[memKey];
      unit.mem[memKey] = null;
      if (m && reason === 'duration' && m.given < total - 1e-9) giveDp(battle, unit, total - m.given);
    },
  };
}
/** Absolute keys of `grid` around `unit` (its facing). */
const gridKeys = (unit, grid) => absoluteRangeKeys(grid ?? [[0, 0]], unit.tileR, unit.tileC, unit.dir, 0);
/** S3's target: the first selectable ground enemy of the skill range in the engine's attack order, or null. */
function bannerTarget(battle, unit, grid) {
  const list = battle.enemiesInKeys(gridKeys(unit, grid), unit, GROUND);
  if (!list.length) return null;
  sortEnemyTargets(battle, unit, list, null);
  return list[0];
}
/** S2's target: the operator of the skill range with the lowest HP ratio (then the nearest, then the earliest deployed). */
function faithTarget(battle, unit, grid) {
  let best = null, bk = null;
  for (const a of opsOn(battle, unit, new Set(gridKeys(unit, grid)))) {
    const k = [a.hpRatio, Math.abs(a.tileR - unit.tileR) + Math.abs(a.tileC - unit.tileC), a.deploySeq];
    if (!bk || k[0] < bk[0] - 1e-12 || (Math.abs(k[0] - bk[0]) <= 1e-12 && (k[1] < bk[1] || (k[1] === bk[1] && k[2] < bk[2])))) { best = a; bk = k; }
  }
  return best;
}

export default function sleach(bb, chess) {
  const t0 = tal(chess, 0), t1 = tal(chess, 1), tb = traitBb(chess), hb = hiddenBb(chess);
  const mtype = chess?.module?.active ? chess.module.type ?? null : null;
  const vAlly = num(t0['sleach_t_1[ally].attack_speed']);
  const vFoe = num(t0['sleach_t_1[enemy].attack_speed']);

  /** T1 不退之旗: one pulse of the flag's aura (allies ASPD +, enemies ASPD −) on the 3×3 around the flag. */
  const flagAura = (battle, unit) => {
    if (!live(unit)) return;
    const keys = around(...flagTile(unit));
    if (vAlly > 0) for (const a of opsOn(battle, unit, new Set(keys))) hold(battle, a, unit, K_FLAG, vAlly, { mods: { aspd: vAlly }, tags: ['talent'] });
    if (vFoe) for (const e of battle.enemiesInKeys(keys, unit, ANY)) battle.applyStrongest(e, K_FLAG_FOE, { duration: AURA_DUR, value: vFoe, mods: (x) => ({ aspd: x }), source: unit });
  };

  return {
    skills: lazySkills(chess, {
      // S1 支援号令·γ型: DP over the duration, no attack
      [S1]: (rec) => {
        const b = rec.bb ?? {};
        const d = drip(num(b.value), num(b.cost), num(b.interval), 'sleachDrip');
        return {
          kind: 'duration',
          attack: { noAttack: true },
          onStart({ battle, unit }) { d.start(battle, unit); },
          onTick({ battle, unit, dt }) { d.tick(battle, unit, dt); },
          onEnd({ battle, unit, reason }) { d.end(battle, unit, reason); },
        };
      },
      // S2 信仰传承: DP over the duration; the flag on the weakest operator of the skill range (DEF + and a heal per second)
      [S2]: (rec) => {
        const b = rec.bb ?? {};
        const d = drip(num(b.value), num(b['sleach_s_2[cost].cost']), num(b['sleach_s_2[cost].interval']), 'sleachDrip');
        const def = num(b.def), ratio = num(b.atk_to_hp_recovery_ratio), grid = gridOf(rec);
        const faith = (battle, unit) => {
          const t = unit.mem.sleachFaith?.t;
          if (t && live(t) && def > 0) hold(battle, t, unit, K_FAITH, def, { mods: { defPct: def }, visible: true, tags: ['skill'] });
        };
        return {
          kind: 'duration',
          attack: { noAttack: true },
          onStart({ battle, unit }) {
            d.start(battle, unit);
            const t = faithTarget(battle, unit, grid);
            unit.mem.sleachFaith = { t, iv: 0, heal: 0 };
            if (t) {
              unit.mem.sleachFlag = [t.tileR, t.tileC];
              battle.fx('buff', { x: t.x, y: t.y, id: t.id, src: unit.id });
            }
            faith(battle, unit);
            flagAura(battle, unit);
          },
          onTick({ battle, unit, dt }) {
            d.tick(battle, unit, dt);
            const m = unit.mem.sleachFaith;
            if (!m) return;
            m.iv += dt;
            if (m.iv + 1e-9 >= AURA_IV) { m.iv = 0; faith(battle, unit); }
            m.heal += dt;
            while (m.heal + 1e-9 >= HEAL_IV) {
              m.heal -= HEAL_IV;
              const t = m.t;
              // only the holder of the flag's DEF heals (two 琴柳 on one operator never double)
              if (ratio > 0 && t && live(t) && t.findBuff(K_FAITH)?.source === unit) battle.heal(unit, t, unit.s.atk * ratio);
            }
          },
          onEnd({ battle, unit, reason }) {
            d.end(battle, unit, reason);
            unit.mem.sleachFaith = null;
            unit.mem.sleachFlag = null;
            dropFrom(battle, unit, K_FAITH);
            flagAura(battle, unit);
          },
        };
      },
      // S3 光辉旗帜: +DP; the flag on a ground enemy (if any): impact, then 停顿 + 脆弱 around the flag
      [S3]: (rec) => {
        const b = rec.bb ?? {};
        const cost = num(b.cost), scale = num(b.atk_scale), stun = num(b.stun), frag = num(b['debuff.damage_scale']);
        const grid = gridOf(rec);
        const field = (battle, unit) => {
          for (const e of battle.enemiesInKeys(around(...flagTile(unit)), unit, ANY)) {
            battle.applyStatus(e, 'sluggish', { duration: AURA_DUR, source: unit });
            if (frag > 0 && e.alive) battle.applyStatus(e, 'fragile', { duration: AURA_DUR, value: frag, source: unit });
          }
        };
        return {
          kind: 'duration',
          attack: { noAttack: true },
          onStart({ battle, unit }) {
            giveDp(battle, unit, cost);
            unit.mem.sleachField = 0;
            const t = bannerTarget(battle, unit, grid);
            if (t) {
              const tile = [Math.round(t.y), Math.round(t.x)];
              unit.mem.sleachFlag = tile;
              const keys = around(...tile);
              for (const e of battle.enemiesInKeys(keys, unit, ANY)) {
                if (scale > 0) battle.dealDamage(unit, e, { amount: unit.s.atk * scale, type: 'phys', isSkill: true, tags: ['skill', 'sleachBanner'] });
                if (stun > 0 && e.alive) battle.applyStatus(e, 'stun', { duration: stun, source: unit });
              }
              battle.fx('aoe', { x: tile[1], y: tile[0], id: unit.id, r: 1.5, tiles: keyTiles(keys), skill: 'sleach_3' });
            }
            field(battle, unit);
            flagAura(battle, unit);
          },
          onTick({ battle, unit, dt }) {
            unit.mem.sleachField = num(unit.mem.sleachField) + dt;
            if (unit.mem.sleachField + 1e-9 < AURA_IV) return;
            unit.mem.sleachField = 0;
            field(battle, unit);
          },
          onEnd({ battle, unit }) {
            unit.mem.sleachFlag = null;
            flagAura(battle, unit);
          },
        };
      },
    }),
    talents: [
      { install(battle, unit) { // 不退之旗 (the flag is hers again whenever a skill ends, a knock-out included)
        if (vAlly > 0 || vFoe) whileOn(battle, unit, AURA_IV, () => flagAura(battle, unit));
      } },
      { install(battle, unit) { // 精神感召 (+ BEA-Y: +cost DP when that operator is a ground one)
        const cut = -num(t1.value);
        const bonus = mtype === 'BEA-Y' ? num(hb.cost) : 0;
        if (!(cut > 0) && !(bonus > 0)) return;
        const P = unit.ownerId;
        const st = bstate(battle, 'sleach:spirit');
        const waiting = (a) => isOp(a) && a.ownerId === P && !a.alive && !a.removed;
        const lower = (a, c) => {
          if (!(c > 0) || num(a.mem.sleachCut) > 0) return;
          const before = a.base.cost;
          a.base.cost = Math.max(0, before - c);
          a.mem.sleachCut = before - a.base.cost;
        };
        const restore = () => {
          for (const a of battle.allyUnits) {
            if (isOp(a) && a.ownerId === P && num(a.mem.sleachCut) > 0) { a.base.cost += a.mem.sleachCut; a.mem.sleachCut = 0; }
          }
        };
        battle.on('deploy', (c) => {
          const a = c.unit;
          if (!isOp(a) || a.ownerId !== P) return;
          const p = st[P];
          // armed at an earlier deployment ⇒ `a` is the next operator of her player deployed (it paid the cut cost)
          if (p && p.seq !== a.deploySeq) {
            delete st[P];
            restore();
            if (p.dp > 0 && a.def?.position === 'MELEE') giveDp(battle, a, p.dp);
          }
          if (a === unit) {
            st[P] = { cut, dp: bonus, by: unit, seq: a.deploySeq };
            for (const w of battle.allyUnits) if (waiting(w)) lower(w, cut);
          }
        }, { owner: unit, priority: 100 });
        battle.on('death', (c) => {
          const x = c.unit, p = st[P];
          if (!p || p.by !== unit) return;
          if (x === unit) { delete st[P]; restore(); return; } // ends with her talent ("SYNC_WITH_BUFF")
          if (waiting(x)) lower(x, p.cut);
        }, { owner: unit });
      } },
    ],
    install(battle, unit) {
      // module BEA-X trait: the operator in front of her block + while a skill runs
      const bc = mtype === 'BEA-X' ? num(tb.block_cnt) : 0;
      if (bc > 0) {
        const pulse = () => {
          if (!unit.skill?.active || !unit.skill.isTimed) return;
          for (const a of alliesInGridOf(battle, unit, FRONT)) {
            if (a !== unit && isOp(a)) hold(battle, a, unit, K_FRONT, bc, { mods: { blockCnt: bc }, visible: true, tags: ['trait'] });
          }
        };
        whileOn(battle, unit, AURA_IV, pulse);
        battle.on('skillStart', (c) => { if (c.unit === unit) pulse(); }, { owner: unit });
        battle.on('skillEnd', (c) => { if (c.unit === unit) dropFrom(battle, unit, K_FRONT); }, { owner: unit });
      }
      // module BEA-Y trait: 迷彩 while a skill runs
      if (mtype === 'BEA-Y') {
        battle.on('skillStart', (c) => {
          if (c.unit !== unit) return;
          battle.addBuff(unit, { key: K_CAMOU, flags: { camou: true }, status: 'camou', source: unit, visible: true, tags: ['trait'] });
          battle.fx('camouflage', { x: unit.x, y: unit.y, id: unit.id });
        }, { owner: unit });
        battle.on('skillEnd', (c) => { if (c.unit === unit) battle.removeBuff(unit, K_CAMOU); }, { owner: unit });
      }
    },
  };
}
