// server/sim/content/kits/waiguan/char_4228_closur.js — 可露希尔 (先锋 · 战术家 tactician) 外援 kit (DESIGN §27, docs/WAIGUAN-KITS.md).
//
// Chess ids: chess_char_diy_5_char_4228_closur_a/_b, chess_char_diy_6_char_4228_closur_a/_b (registered by ./index.js).
// Sources: the records (data/waiguan.json; normal = skill Lv4, elite = Lv7 + module; tier V elite = module level 1) and
// the official buff templates (ArknightsGameData zh_CN buff_template_data: closur_tr, closur_e_002_tr, closur_s_1[cost],
// closur_s_1[trigger_modify_cost], closur_s_1[shield], closur_s_2[switch]/[friend], closur_s_3[data]/[attack_trigger],
// closur_ourbase_aura, closur_ourbase_t_1[listener]/[switch], closur_passive, slow_down) where the texts leave it open.
//
// 援军 (her reinforcements) — closur_tr / closur_ourbase_aura: her 指挥中心 (talent 1 token, tokenKey of talent index 0)
//   and every friendly unit standing in its 效果范围 = the token skill's range of her loadout ("战术点效果范围随携带技能变化":
//   S1 x-5 plus, S2 x-4 3×3, S3 x-6 cross of radius 2 — the token variant's skill rangeGrid). [ASSUMED: on a shared field
//   (联防 / boss) only her own player's units count — KIT_CONVENTIONS 5; the official mode has one player.] [ASSUMED: she
//   counts as her own 援军 when she stands in that range — closur_ourbase_aura gives closur_friend to every friendly unit
//   of the range and nothing in the templates leaves her out.]
// Trait (战术家, data profile WRONG for her: the engine's tactician install summons a generic 援军): replaced — her 援军
//   are the above; "自身攻击援军阻挡的敌人时攻击力提升至150%" = dmgMul trait atk_scale on a target blocked by a 援军 (closur_tr
//   AtkScaleUp: blocked by her token, or by a unit holding her closur_friend). TAC-X (uniequip_002_closur, dispatched by
//   module type): "援军受到来自自身阻挡单位的伤害降低15%" — closur_e_002_tr DamageScale (hidden damage_scale) on any damage a
//   援军 takes from an enemy it blocks; two 可露希尔 never compound it (strongest).
// T1 精准投放 + the 指挥中心: the player's board piece (talent summon, GameData.placeableTokens) deploys with the board; with
//   no piece one is summoned on her tactical point (Battle.findTacticalPoint, the pool's tactician rule) at her
//   deployment. It never attacks ("不攻击": data ATK 0 — professions.js resolveProfile's no-attack rule; this kit owns it
//   entirely, no generic summon rule applies), blocks 2 (data). Knocked out ⇒
//   back on its tile after the token's hidden talent `interval` (15 s, "被击败后会在15秒后自动刷新"; closur_ourbase_t_1),
//   paying its deploy cost (0 — a 外援 summon's return pays). She leaves the field ⇒ it is withdrawn ('retreat': no
//   destruction) [ASSUMED: no closur template withdraws it (there is no ON_OWNER_FINISH / WithdrawTokens node); this
//   follows the pool's tactician rule — a 援军 leaves with its tactician (tokens.js, the 伺夜 kit)], and her
//   (re)deployment brings it back at once (closur_passive RallyPointReborn at her start).
// T2 极限调度 ("携带可露希尔时"): for the whole battle, her player's 【罗德岛】 operators (nationId rhodes, herself included)
//   ATK +atk (persist; two copies: the stronger holds) and her player's 部署费用下限 −|cost| (two copies: the larger): the
//   DP pool may go down to −|cost| when DP is spent — her player's knocked-out operators redeploy (on their rest tile,
//   paying their cost) as soon as DP − cost ≥ −|cost|, and 老鲤's trait may pay into it (char_322_lmlee.js reads the same
//   ledger). [ASSUMED: 部署费用下限 (ba.costlowerbound, no glossary text in the data here) read as the lowest value the
//   player's DP may reach by spending it — 0 by default; lmlee_tr's CheckCost `_considerNegativeCost` supports it. The
//   engine clamps DP at 0: the negative part is kept as a per-player debt (_lib dpLedger) that the DP gained afterwards
//   pays first; the DP shown is 0 meanwhile. Other content's own DP payments (a summon's paid return) do not see it.]
// S1 递归策略 (AUTO, duration): her 援军 get 1 layer of 护盾 (shieldHits shield_cnt, "不叠加": replaced, never added; lasts
//   until broken or the unit leaves the field [ASSUMED: no duration in the text / template]); DP over the skill:
//   min(cost_add_max, cost + cost_per_add × casts so far this deployment), 1 DP per trigger, evenly spaced (closur_s_1[cost]:
//   interval = duration / total, the first at interval / 2). Trigger: AUTO with no target ⇒ SP_FULL (record DEFAULT
//   changed; pool precedent 德克萨斯 冲锋号令·γ型, 焰尾 S1).
// S2 模型扩展 (MANUAL, SP_FULL kept): +cost DP at once, then [add_cost_period].cost DP every [add_cost_period].interval s up
//   to cost_period (the rest at a natural end); her ATK +atk, 2 targets, and the enemies her 援军 block join her range;
//   援军 DEF +def, block +block_cnt (aura, strongest copy); an operator of her player deployed (not the battle-start one)
//   on a tile of the 效果范围 while it runs refunds ⌈cost × cost_return⌉ DP (closur_s_2[friend]: COST × cost_return, Ceil;
//   one refund per deployment whatever the number of copies).
// S3 Q.E.D. (MANUAL, SP_FULL kept): DP as S2 (cost_period, no immediate DP: cost 0); attack interval base_attack_time (flat,
//   batMod); targets = enemies of her range ∪ her 援军's original ranges (and the enemies they block); each attack hits
//   attack@atk_scale × ATK physical and 迟钝 (slow_down template: ASPD and move speed −slow_down per stack, ≤ max_stack_cnt,
//   ≤ slow_down_max, slow_down_time s refreshed by each stack; two copies share the stacks, the stronger value holds)
//   [ASSUMED: the engine has no ASPD multiplier — the ASPD part is −v·n × the enemy's base ASPD, pool precedent
//   items/battle.js]; one target at first, +1 after every attack_trigger_cnt attacks, at most max_trigger_cnt times —
//   1 → 1 + max_trigger_cnt (7) targets (closur_s_3[data]) [ASSUMED: the selector starts at her single target; read
//   literally, the template's max_target starts from a blackboard value that is absent (0), which would give 0 → 6];
//   cost_attack_add DP per attack (0 in the records).
// fx: 'dp', 'shield', 'summon'.

import {
  num, tal, talRec, traitBb, hiddenBb, selectedId, lazySkills, mods, live, summonsOf, whileOn, inFaction, batMod, keyOf,
  dpLedger, spendDp,
} from './_lib.js';
import { absoluteRangeKeys } from '../../../targeting.js';
import { bodyKeys } from '../../../body.js';
import { COLS } from '../../../constants.js';

const S1 = 'skchr_closur_1', S2 = 'skchr_closur_2', S3 = 'skchr_closur_3';
/** closur_s_1[cost]: the first DP trigger comes after interval / "two". */
const S1_FIRST_SHARE = 0.5;
/** closur_s_1[cost]: DP per trigger (template default cost_per_add_trigger). */
const S1_DP_PER_TRIGGER = 1;
/** closur_s_3[data]: the attack selector starts at one target (no max_target in the blackboard) [ASSUMED, header]. */
const S3_BASE_TARGETS = 1;
/** Period of the S2 援军 aura (DEF / block) and of the 指挥中心 return check (s). */
const AURA_IV = 0.1;
const CC_POLL = 0.25;
const EPS = 1e-6;

/**
 * Once per battle: every tick, the DP gained pays the debts first, then each knocked-out operator of a player with a
 * lowered floor whose timer is done redeploys as soon as (DP − debt) − cost ≥ −floor (the engine itself redeploys those
 * the plain DP pays for).
 */
function installLedger(battle) {
  const L = dpLedger(battle);
  if (L.installed) return;
  L.installed = true;
  battle.on('tick', () => {
    if (battle.finished) return;
    for (const [pid, floor] of L.floor) {
      const ps = battle.getPlayer(pid);
      if (!ps) continue;
      const debt = L.debt.get(pid) ?? 0;
      if (debt > 0 && ps.dp > 0) {
        const pay = Math.min(ps.dp, debt);
        battle.addDp(pid, -pay);
        L.debt.set(pid, debt - pay);
      }
      if (!(floor > 0)) continue;
      for (const u of battle.allyUnits) {
        if (u.kind !== 'op' || u.ownerId !== pid || u.alive || u.removed || !Number.isFinite(u.respawnAt)) continue;
        if (battle.time + 1e-9 < u.respawnAt) continue;
        const cost = num(u.base.cost);
        const avail = ps.dp - (L.debt.get(pid) ?? 0);
        if (avail + 1e-9 >= cost) continue; // the engine's own redeploy (its tile is busy)
        if (avail - cost < -floor - 1e-9) continue; // beyond the lowered floor: it waits for DP
        const paid = spendDp(battle, pid, cost); // paid before `deploy` fires, as Battle.redeploy does
        if (battle.redeploy(u, { free: true })) continue;
        if (paid.fromDp > 0) battle.addDp(pid, paid.fromDp);
        if (paid.owed > 0) L.debt.set(pid, (L.debt.get(pid) ?? 0) - paid.owed);
      }
    }
  });
}

/** DP over a skill: `total` DP in steps of `step`, the first at `first` s, then every `interval` s. */
function dpPlan(total, step, interval, first) {
  return { total: Math.max(0, total), step, interval, first, t: 0, given: 0, k: 0 };
}
function grantDp(battle, unit, n) {
  if (!(n > 0)) return;
  battle.addDp(unit.ownerId, n);
  battle.fx('dp', { x: unit.x, y: unit.y, id: unit.id, n });
}
function dpTick(battle, unit, dt) {
  const d = unit.mem.closurDp;
  if (!d || !(d.step > 0) || !(d.interval > 0)) return;
  d.t += dt;
  while (d.given + 1e-9 < d.total && d.t + EPS >= d.first + d.k * d.interval) {
    const n = Math.min(d.step, d.total - d.given);
    d.given += n;
    d.k++;
    grantDp(battle, unit, n);
  }
}
/** A natural end grants what the plan still owes (a knock-out loses it: the template buff leaves with her). */
function dpEnd(battle, unit, reason) {
  const d = unit.mem.closurDp;
  unit.mem.closurDp = null;
  if (d && reason === 'duration' && d.total - d.given > 1e-9) grantDp(battle, unit, d.total - d.given);
}
/** [add_cost_period].cost / .interval of a skill blackboard (the key carries the skill's template prefix). */
function periodKey(bb, tail) {
  for (const k of Object.keys(bb ?? {})) if (k.endsWith(`[add_cost_period].${tail}`)) return num(bb[k]);
  return 0;
}

/** 迟钝 (slow_down template) on enemy `e`: one more stack (shared by every source), the stronger value holds. */
const SLOW_KEY = 'closur:slowdown';
function slowDown(battle, src, e, v, maxN, cap, dur) {
  if (!e || !e.alive || e.side !== 'enemy' || !(v > 0) || !(maxN >= 1) || !(dur > 0)) return;
  const cur = e.findBuff(SLOW_KEY);
  const d = cur?.data ?? {};
  const max = Math.max(maxN, num(d.max));
  const n = Math.min(max, num(d.n) + 1);
  const vv = Math.max(v, num(d.v)), cc = Math.max(cap, num(d.cap));
  const total = cc > 0 ? Math.min(cc, vv * n) : vv * n;
  battle.addBuff(e, {
    key: SLOW_KEY, duration: dur, refresh: 'replace', source: src, visible: true, data: { n, v: vv, cap: cc, max },
    mods: mods({ aspd: -total * num(e.base.aspd, 100), moveMul: 1 - total }),
  });
}

export default function closur(bb, chess, def) {
  const sid = selectedId(chess, def);
  const t1 = tal(chess, 1);
  const tb = traitBb(chess);
  const moduleType = chess?.module?.active ? chess.module.type ?? null : null;
  const cut = moduleType === 'TAC-X' ? num(hiddenBb(chess).damage_scale, 1) : 1;
  const ccId = talRec(chess, 0)?.tokenKey ?? (chess?.tokens ?? [])[0] ?? null;
  const recOf = (id) => (chess?.skills ?? []).find((s) => s && s.skillId === id) ?? {};
  const s2bb = recOf(S2).bb ?? {};

  /** Her live 指挥中心. */
  const ccs = (battle, unit) => (ccId ? summonsOf(battle, unit, ccId) : []);
  /** Absolute tiles of a 指挥中心's 效果范围 (its loadout's token skill range), cached per tile / direction. */
  const ccKeys = (t) => {
    const at = t.tileR * COLS + t.tileC;
    if (!t.mem.ccKeys || t.mem.ccKeysAt !== at || t.mem.ccKeysDir !== t.dir) {
      t.mem.ccKeys = new Set(absoluteRangeKeys(t.def?.skill?.rangeGrid ?? [[0, 0]], t.tileR, t.tileC, t.dir, 0));
      t.mem.ccKeysAt = at;
      t.mem.ccKeysDir = t.dir;
    }
    return t.mem.ccKeys;
  };
  /** On a tile of one of her live 指挥中心's 效果范围. */
  const inField = (battle, unit, a) => {
    const k = a.tileR * COLS + a.tileC;
    return ccs(battle, unit).some((t) => ccKeys(t).has(k));
  };
  /** Is `x` one of her 援军: her 指挥中心, or a unit of her player on its 效果范围 (no device, no 孤立 unit). */
  const isReinf = (battle, unit, x) => {
    if (!x || x.side !== 'ally' || !live(x)) return false;
    if (x.kind === 'token' && x.ownerUnit === unit && x.defId === ccId) return true;
    if (x.kind === 'device' || x.ownerId !== unit.ownerId || !battle.allySelectable(x, unit)) return false;
    return inField(battle, unit, x);
  };
  /** Every 援军 of hers (指挥中心 first, then the units of the 效果范围 in board order). */
  const reinforcements = (battle, unit) => {
    const list = ccs(battle, unit);
    if (!list.length) return list;
    for (const a of battle.allyUnits) if (!list.includes(a) && isReinf(battle, unit, a)) list.push(a);
    return list;
  };

  /** S2 / S3 DP plan from the skill record. */
  const periodPlan = (rec) => dpPlan(num(rec.bb?.cost_period), periodKey(rec.bb, 'cost'), periodKey(rec.bb, 'interval'), periodKey(rec.bb, 'interval'));

  return {
    skills: lazySkills(chess, {
      [S1]: (rec) => ({
        kind: 'duration',
        trigger: 'SP_FULL',
        onStart({ battle, unit, skill }) {
          const b = rec.bb ?? {};
          const n = num(unit.mem.closurS1Casts);
          unit.mem.closurS1Casts = n + 1;
          const total = Math.min(num(b.cost_add_max), num(b.cost) + num(b.cost_per_add) * n);
          const iv = total > 0 ? skill.duration / (total / S1_DP_PER_TRIGGER) : 0;
          unit.mem.closurDp = dpPlan(total, S1_DP_PER_TRIGGER, iv, iv * S1_FIRST_SHARE);
          const layers = Math.floor(num(b.shield_cnt));
          if (layers > 0) {
            for (const a of reinforcements(battle, unit)) {
              battle.addBuff(a, { key: 'closur:shield', shieldHits: layers, refresh: 'replace', visible: true, source: unit, tags: ['skill'] });
              battle.fx('shield', { x: a.x, y: a.y, id: a.id, src: unit.id });
            }
          }
        },
        onTick({ battle, unit, dt }) { dpTick(battle, unit, dt); },
        onEnd({ battle, unit, reason }) { dpEnd(battle, unit, reason); },
      }),
      [S2]: (rec) => ({
        kind: 'duration',
        mods: mods({ atkPct: num(rec.bb?.atk) }),
        targeting: { maxTargets: Math.max(1, Math.floor(num(rec.bb?.['attack@max_target'], 1))) },
        onStart({ battle, unit }) {
          grantDp(battle, unit, num(rec.bb?.cost));
          unit.mem.closurDp = periodPlan(rec);
        },
        onTick({ battle, unit, dt }) { dpTick(battle, unit, dt); },
        onEnd({ battle, unit, reason }) {
          dpEnd(battle, unit, reason);
          battle.setExtraRange(unit, null);
          unit.mem.closurRangeSig = '';
        },
      }),
      [S3]: (rec) => ({
        kind: 'duration',
        mods: mods({ batPct: batMod(rec.bb?.base_attack_time, chess, rec.desc ?? '') }),
        attack: {
          atkScale: num(rec.bb?.['attack@atk_scale'], 1),
          maxTargets: S3_BASE_TARGETS,
          onEachHit({ battle, unit, target }) {
            const b = rec.bb ?? {};
            slowDown(battle, unit, target, num(b['attack@slow_down']), Math.floor(num(b['attack@max_stack_cnt'])), num(b['attack@slow_down_max']), num(b['attack@slow_down_time']));
          },
        },
        onStart({ battle, unit, skill }) {
          grantDp(battle, unit, num(rec.bb?.cost));
          unit.mem.closurDp = periodPlan(rec);
          unit.mem.closurS3 = { attacks: 0, extra: 0 };
          skill.spec.attack.maxTargets = S3_BASE_TARGETS;
        },
        onTick({ battle, unit, dt }) { dpTick(battle, unit, dt); },
        onAttack({ battle, unit, skill }) {
          const m = unit.mem.closurS3;
          if (!m) return;
          grantDp(battle, unit, num(rec.bb?.cost_attack_add));
          m.attacks++;
          if (m.attacks >= num(rec.bb?.attack_trigger_cnt, Infinity) && m.extra < num(rec.bb?.max_trigger_cnt)) {
            m.extra++;
            m.attacks = 0;
            skill.spec.attack.maxTargets = S3_BASE_TARGETS + m.extra;
          }
        },
        onEnd({ battle, unit, skill, reason }) {
          dpEnd(battle, unit, reason);
          unit.mem.closurS3 = null;
          skill.spec.attack.maxTargets = S3_BASE_TARGETS;
          battle.setExtraRange(unit, null);
          unit.mem.closurRangeSig = '';
        },
      }),
    }),
    trait: {
      // replaces professions.js installTactician (no generic 援军: hers are the 指挥中心 and its 效果范围)
      install() {},
      dmgMul: (battle, unit, target) => (target && target.blockedBy && isReinf(battle, unit, target.blockedBy) ? num(tb.atk_scale, 1) : 1),
    },
    talents: [
      { install(battle, unit) { // 精准投放: the 指挥中心 (board piece, else on her tactical point), its refresh and withdrawal
        if (!ccId) return;
        const isCC = (t) => !!t && t.kind === 'token' && t.ownerUnit === unit && t.defId === ccId;
        const refreshOf = (t) => {
          const h = (t.def?.talents ?? []).find((x) => x && x.bb && num(x.bb.interval) > 0);
          return h ? num(h.bb.interval) : Math.max(0, num(t.base.respawnTime));
        };
        const tryBack = (t) => {
          if (t.alive || t.removed || !live(unit) || battle.finished) return false;
          if (battle.time + 1e-9 < (t.mem.closurBackAt ?? Infinity)) return false;
          if (!battle.redeploy(t, { free: false })) return false; // a 外援 summon's return pays its deploy cost (0 here)
          battle.fx('summon', { x: t.x, y: t.y, id: t.id, token: t.defId, src: unit.id });
          return true;
        };
        battle.on('death', (c) => {
          const t = c.unit;
          if (!isCC(t) || battle.finished) return;
          t.removed = false; // stays her piece: its hooks and its tile are kept
          if (unit.trait.reinforcement === t) unit.trait.reinforcement = null;
          if (c.reason === 'killed') {
            const d = refreshOf(t);
            t.mem.closurBackAt = battle.time + d;
            battle.after(d, () => tryBack(t), { owner: unit });
          } else t.mem.closurBackAt = -Infinity; // withdrawn with her: back with her
        }, { owner: unit, priority: -10 });
        whileOn(battle, unit, CC_POLL, () => { for (const t of summonsOf(battle, unit, ccId, { all: true })) tryBack(t); });
        battle.on('deploy', (c) => {
          if (isCC(c.unit)) { unit.trait.reinforcement = c.unit; return; }
          if (c.unit !== unit) return;
          const all = summonsOf(battle, unit, ccId, { all: true });
          // closur_passive (RallyPointReborn at her start): her redeployment brings her 指挥中心 back at once
          for (const t of all) {
            if (t.alive || t.removed || (c.initial && t.deploySeq === 0)) continue;
            t.mem.closurBackAt = -Infinity;
            tryBack(t);
          }
          if (all.length) return; // a board piece (deploys with the board after the operators) or her own
          const tile = battle.findTacticalPoint(unit);
          if (!tile) return;
          const t = battle.spawnToken(unit, ccId, tile[0], tile[1]);
          if (t) battle.fx('summon', { x: t.x, y: t.y, id: t.id, token: ccId, src: unit.id });
        }, { owner: unit, priority: 40 });
        // she leaves the field (any reason): her 指挥中心 is withdrawn — no destruction, no refresh timer
        battle.on('death', (c) => {
          if (c.unit !== unit || battle.finished) return;
          for (const t of summonsOf(battle, unit, ccId)) battle.retreat(t, { reason: 'retreat' });
        }, { owner: unit });
        // TAC-X: a 援军 takes damage_scale × the damage of an enemy it blocks (strongest of the copies)
        if (cut < 1) {
          battle.on('hit', (c) => {
            const t = c.target, s = c.source;
            if (!t || t.side !== 'ally' || !s || s.side !== 'enemy' || s.blockedBy !== t || !isReinf(battle, unit, t)) return;
            const prev = num(c.dmg.closurCut, 1);
            if (cut < prev) { c.dmg.mul *= cut / prev; c.dmg.closurCut = cut; }
          }, { owner: unit });
        }
      } },
      { install(battle, unit) { // 极限调度: 【罗德岛】 ATK (her player, whole battle) and the lowered 部署费用下限
        const atk = num(t1.atk);
        if (atk > 0) {
          for (const a of battle.allyUnits) {
            if (a.kind !== 'op' || a.ownerId !== unit.ownerId || !inFaction(a, 'rhodes')) continue;
            const cur = a.findBuff('closur:dispatch');
            if (cur && num(cur.data?.v) >= atk) continue; // another copy's equal or stronger 极限调度
            battle.addBuff(a, { key: 'closur:dispatch', mods: { atkPct: atk }, persist: true, allowDead: true, source: unit, data: { v: atk }, tags: ['talent'] });
          }
        }
        const floor = Math.abs(num(t1.cost));
        if (floor > 0) {
          const L = dpLedger(battle);
          L.floor.set(unit.ownerId, Math.max(L.floor.get(unit.ownerId) ?? 0, floor));
          installLedger(battle);
        }
      } },
    ],
    install(battle, unit) {
      // S1 "部署后每使用过一次技能": the count restarts at every deployment
      battle.on('deploy', (c) => { if (c.unit === unit) unit.mem.closurS1Casts = 0; }, { owner: unit });
      if (sid === S2) {
        const def2 = num(s2bb.def), block = num(s2bb.block_cnt), ret = num(s2bb.cost_return);
        const aura = mods({ defPct: def2, blockCnt: block });
        if (Object.keys(aura).length) {
          whileOn(battle, unit, AURA_IV, () => {
            if (!unit.skill?.active) return;
            for (const a of reinforcements(battle, unit)) {
              const cur = a.findBuff('closur:s2');
              if (cur && cur.source !== unit && num(cur.data?.v) > def2 && cur.timeLeft > 0.05) continue;
              battle.addBuff(a, { key: 'closur:s2', duration: AURA_IV * 1.5 + 0.02, mods: aura, source: unit, data: { v: def2 }, visible: true });
            }
          });
          battle.on('skillEnd', (c) => {
            if (c.unit !== unit) return;
            for (const a of battle.allyUnits) { const b = a.findBuff('closur:s2'); if (b && b.source === unit) battle.removeBuff(a, b); }
          }, { owner: unit });
        }
        // closur_s_2[friend]: an operator of her player deployed into the 效果范围 while S2 runs refunds ⌈cost × cost_return⌉
        if (ret > 0) {
          battle.on('deploy', (c) => {
            const a = c.unit;
            // (a battle-start deployment never meets a running S2: skills cast only once the battle steps)
            if (c.move || !a || a.kind !== 'op' || a.ownerId !== unit.ownerId || !unit.skill?.active || !live(unit)) return;
            if (!inField(battle, unit, a) || a.mem.closurRefund === a.deploySeq) return;
            a.mem.closurRefund = a.deploySeq;
            const n = Math.ceil(num(a.base.cost) * ret - 1e-9);
            if (n > 0) { battle.addDp(unit.ownerId, n); battle.fx('dp', { x: a.x, y: a.y, id: a.id, n }); }
          }, { owner: unit });
        }
      }
      if (sid !== S2 && sid !== S3) return;
      // S2: the enemies her 援军 block are in her range; S3: her 援军's original ranges (and the enemies they block) too
      battle.on('tick', () => {
        if (!live(unit) || !unit.skill?.active) return;
        const keys = [];
        for (const a of reinforcements(battle, unit)) {
          if (a === unit) continue;
          if (sid === S3) for (const k of a.baseRangeKeys ?? []) keys.push(k);
          for (const e of a.blocking) if (e.alive && e.blockedBy === a) { if (e.hitArea) keys.push(...bodyKeys(e)); else keys.push(keyOf(e)); }
        }
        const sig = keys.join(',');
        if (sig === (unit.mem.closurRangeSig ?? '')) return;
        unit.mem.closurRangeSig = sig;
        battle.setExtraRange(unit, keys);
      }, { owner: unit });
      battle.on('deploy', (c) => { if (c.unit === unit) unit.mem.closurRangeSig = ''; }, { owner: unit });
    },
  };
}
