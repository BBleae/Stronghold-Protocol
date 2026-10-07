// server/sim/content/kits/waiguan/char_322_lmlee.js — 老鲤 (特种 · 行商 merchant) 外援 kit (DESIGN §27, docs/WAIGUAN-KITS.md).
//
// Chess ids: chess_char_diy_5_char_322_lmlee_a/_b, chess_char_diy_6_char_322_lmlee_a/_b (registered by ./index.js).
// Sources: the records (data/waiguan.json; normal = skill Lv4, elite = Lv7 + module; tier V elite = module level 1) and
// the official buff templates (ArknightsGameData zh_CN buff_template_data: lmlee_tr, lmlee_t_1, lmlee_t_2[bounce],
// lmlee_s_2 / [paper] / [end], lmlee_s_3[knockback] / [evade], lmlee_e_003_t) where the texts leave it open.
//
// Trait (行商 "在场时每3秒消耗3点部署费用（不足时自动撤退）") + T2 有备无患 — lmlee_tr, replacing professions.js
//   installMerchant (it has no talent branch): every trait `interval` s counted from each deployment (the template's
//   trigger buff starts with him; the engine profile counts on the battle clock), his player's DP is spent:
//   * holding no 有备无患 charge and DP ≥ |extra_cost| (the plain DP — CheckCost without the negative floor): pay
//     |extra_cost| instead and gain the charge (lmlee_t_2[bounce], one at most);
//   * else DP − |cost| ≥ the player's 部署费用下限 (0, or −N with 可露希尔's 极限调度 — CheckCost _considerNegativeCost,
//     _lib dpLedger, lowered by char_4228_closur.js): pay |cost| (into a debt below 0, _lib spendDp);
//   * else he is withdrawn ('merchant': down, back after his redeploy time when the DP allows).
//   `merchantPay` { unit, cost, cancel } is emitted before each payment, as the engine's merchant does.
//   The charge (lmlee_t_2[bounce]: CheckAndBlockBuffByAbnormalFlags STUNNED / FROZEN) cancels the next 晕眩 / 冻结 put on
//   him and, when its source is an enemy, stuns that enemy `stun` s; it is used up either way and lost when he leaves.
// MER-X (uniequip_002_lmlee): the trait cost from the record (−2) and the 有备无患 upgrade at its level (data). MER-Y
//   (uniequip_003_lmlee, by module type): "每次特性消耗费用时攻击力+4%，最多可以叠加5次" — lmlee_e_003_t: ATK +atk per trait
//   payment, max_stack_cnt stacks, lost when he leaves; its talent-1 upgrade (±20) comes with the record.
// T1 和气生财 (lmlee_t_1): while he blocks, ASPD +[self].attack_speed and every enemy he blocks [enemy].attack_speed; ×2
//   while exactly `cnt` enemies stand on his 3×3 (x-4: "周围八格" and his tile).
// S1 小惩大诫 (AUTO, toggle "持续时间无限"): ATK +atk, 法术闪避 +prob. AUTO ⇒ the data rule DEFAULT kept (pool precedent for
//   AUTO 持续时间无限 attack skills: 铃兰 S2, 耀骑士临光 S1; 煌 S2).
// S2 驱凶辟邪 (MANUAL, instant, DEFAULT kept): 被动效果 ASPD +attack_speed while it is equipped; cast at an attack, it marks
//   that attack's target for paper_duration s (lmlee_s_2[paper]): the target's taunt +taunt_level ("更易受我方攻击" — the
//   enemy-side 嘲讽等级 our units target first, pool precedent 伺夜 TAC-Y); every damage instance our side deals to it adds
//   one stack (≤ max_stack_cnt); when the mark ends — its time, the stack cap, or the target knocked out ("提前爆炸") —
//   it blasts (default_atk_scale + factor_atk_scale × stacks) × his ATK as arts damage on the enemies around the target.
//   [ASSUMED: radius BLAST_RADIUS — not in the data (the pool's "周围 (around a target)", 空弦); the projectile's flight
//   (EmitProjectile) is not modelled — the blast lands at once; flyers are hit; when he leaves the field first the mark
//   is removed without a blast (the projectile has no source left).]
// S3 贵客盈门 (AUTO, toggle, DEFAULT kept): range = the skill grid (3×3), ATK / DEF +atk / +def, taunt +taunt_level; every
//   attack pushes (力度 attack@force, radial — knockback[relative]) the ground enemies of his range other than its targets
//   (lmlee_s_3[knockback] WALK_ONLY, _excludeCurAtkTarget) with probability attack@prob_knockback; damage (physical or arts,
//   dodgeable) from a source outside his range is evaded with probability prob (lmlee_s_3[evade], its own roll).
// fx: 'dodge', 'aoe', 'talent', 'push'.

import {
  num, tal, traitBb, hiddenBb, selectedId, lazySkills, mods, live, ANY, everyDeployed, statBuff, attackCandidates, dpLedger, spendDp,
} from './_lib.js';
import { absoluteRangeKeys } from '../../../targeting.js';
import { bodyInKeys } from '../../../body.js';
import { COLS } from '../../../constants.js';

const S1 = 'skchr_lmlee_1', S2 = 'skchr_lmlee_2', S3 = 'skchr_lmlee_3';
/** lmlee_t_1 CheckHasEnemyInRange `x-4`: his tile and the eight around it. */
const GRID_X4 = Object.freeze([[1, -1], [1, 0], [1, 1], [0, -1], [0, 0], [0, 1], [-1, -1], [-1, 0], [-1, 1]]);
/** S2 blast radius around the marked target (tiles) [ASSUMED, see the header]. */
const BLAST_RADIUS = 1.5;
const BOUNCE = 'lmlee:bounce';

export default function lmlee(bb, chess, def) {
  const sid = selectedId(chess, def);
  const t0 = tal(chess, 0), t1 = tal(chess, 1), tb = traitBb(chess);
  const moduleType = chess?.module?.active ? chess.module.type ?? null : null;
  const merY = moduleType === 'MER-Y' ? hiddenBb(chess) : null;
  const recOf = (id) => (chess?.skills ?? []).find((s) => s && s.skillId === id) ?? {};

  /** The trait's payment (lmlee_tr, see the header). */
  const pay = (battle, unit) => {
    const pid = unit.ownerId;
    const ps = battle.getPlayer(pid);
    if (!ps || !live(unit)) return;
    const L = dpLedger(battle);
    const avail = ps.dp - (L.debt.get(pid) ?? 0);
    const floor = L.floor.get(pid) ?? 0;
    const base = Math.abs(num(tb.cost)), extra = Math.abs(num(t1.extra_cost));
    let cost = base, bounce = false;
    if (extra > 0 && !unit.findBuff(BOUNCE) && avail + 1e-9 >= extra) { cost = extra; bounce = true; }
    if (battle.hasHook('merchantPay')) {
      const c = battle.emit('merchantPay', { unit, cost, cancel: false });
      if (c.cancel || !live(unit)) return;
      if (Number.isFinite(c.cost)) cost = Math.max(0, c.cost);
    }
    if (bounce ? avail + 1e-9 < cost : avail - cost < -floor - 1e-9) { battle.retreat(unit, { reason: 'merchant' }); return; }
    spendDp(battle, pid, cost);
    if (bounce) {
      battle.addBuff(unit, { key: BOUNCE, visible: true, tags: ['talent'] });
      battle.fx('talent', { x: unit.x, y: unit.y, id: unit.id, name: 'lmleeBounce' });
    }
    if (merY && num(merY.atk) > 0) {
      battle.addBuff(unit, { key: 'lmlee:merY', refresh: 'stack', stacks: 1, maxStacks: Math.max(1, Math.floor(num(merY.max_stack_cnt, 1))), mods: { atkPct: num(merY.atk) }, tags: ['module'] });
    }
  };

  /** S2: blast of a mark (its target may be gone — `at` keeps its last position). */
  const blast = (battle, unit, m, rec) => {
    if (m.done) return;
    m.done = true;
    unit.mem.lmleeMarks = (unit.mem.lmleeMarks ?? []).filter((x) => x !== m);
    if (m.target.alive) battle.removeBuff(m.target, m.key);
    if (!live(unit)) return;
    const b = rec.bb ?? {};
    const at = m.target.alive ? { x: m.target.x, y: m.target.y } : m.at;
    const amount = unit.s.atk * (num(b.default_atk_scale) + num(b.factor_atk_scale) * m.stacks);
    battle.fx('aoe', { x: at.x, y: at.y, id: unit.id, r: BLAST_RADIUS, skill: 'lmleePaper' });
    if (!(amount > 0)) return;
    const foes = battle.foesInRadius(at.x, at.y, BLAST_RADIUS);
    if (m.target.alive && !foes.includes(m.target)) foes.unshift(m.target);
    for (const e of foes) if (e.alive) battle.dealDamage(unit, e, { amount, type: 'arts', isSkill: true, tags: ['skill', 'lmleePaper'] });
  };

  return {
    skills: lazySkills(chess, {
      [S1]: (rec) => ({ kind: 'toggle', mods: mods({ atkPct: num(rec.bb?.atk), dodgeArts: num(rec.bb?.prob) }) }),
      [S2]: (rec) => ({
        kind: 'instant',
        onStart({ battle, unit }) {
          const target = attackCandidates(battle, unit)[0];
          if (!target) return;
          const b = rec.bb ?? {};
          const m = { target, key: `lmlee:paper:${unit.id}`, stacks: 0, at: { x: target.x, y: target.y }, done: false, seq: unit.deploySeq };
          (unit.mem.lmleeMarks ??= []).push(m);
          battle.addBuff(target, { key: m.key, duration: num(b.paper_duration), mods: mods({ taunt: num(b.taunt_level) }), source: unit, visible: true, tags: ['skill'] });
          battle.after(num(b.paper_duration), () => blast(battle, unit, m, rec), { owner: unit });
        },
      }),
      [S3]: (rec) => ({
        kind: 'toggle',
        mods: mods({ atkPct: num(rec.bb?.atk), defPct: num(rec.bb?.def), taunt: num(rec.bb?.taunt_level) }),
        targeting: rec.rangeGrid?.length ? { rangeGrid: rec.rangeGrid } : undefined,
        onAttack({ battle, unit, targets }) {
          const b = rec.bb ?? {};
          const p = num(b['attack@prob_knockback']);
          if (!(p > 0) || (p < 1 && !battle.rng.chance(p))) return;
          const force = num(b['attack@force']);
          for (const e of battle.enemiesInKeys(unit.rangeKeys, unit, ANY)) {
            if (e.isFlying || targets.includes(e) || !e.alive) continue;
            if (battle.push(e, force, { from: unit }) > 0) battle.fx('push', { x: e.x, y: e.y, id: e.id, src: unit.id });
          }
        },
      }),
    }),
    trait: {
      // replaces professions.js installMerchant (lmlee_tr has the 有备无患 branch and the negative floor)
      install(battle, unit) {
        const iv = num(tb.interval);
        if (iv > 0) everyDeployed(battle, unit, iv, () => pay(battle, unit));
      },
    },
    talents: [
      { install(battle, unit) { // 和气生财
        const self = num(t0['lmlee_t_1[self].attack_speed']), foe = num(t0['lmlee_t_1[enemy].attack_speed']), cnt = num(t0.cnt);
        if (!self && !foe) return;
        const key = `lmlee:t1:${unit.id}`;
        const st = { k: 0, foes: new Set() };
        const clear = () => {
          for (const e of st.foes) if (e.alive) battle.removeBuff(e, key);
          st.foes = new Set();
          if (st.k) battle.removeBuff(unit, 'lmlee:t1');
          st.k = 0;
        };
        battle.on('tick', () => {
          if (!live(unit)) { if (st.k || st.foes.size) clear(); return; }
          const blocked = unit.blocking.filter((e) => e.alive && e.blockedBy === unit);
          let k = 0;
          if (blocked.length) {
            const around = battle.enemiesInKeys(absoluteRangeKeys(GRID_X4, unit.tileR, unit.tileC, unit.dir, 0), unit, ANY).length;
            k = around === cnt ? 2 : 1;
          }
          if (k !== st.k) {
            if (k && self) battle.addBuff(unit, { key: 'lmlee:t1', mods: { aspd: self * k }, tags: ['talent'] });
            else battle.removeBuff(unit, 'lmlee:t1');
          }
          const now = new Set(blocked);
          for (const e of st.foes) if (e.alive && (!now.has(e) || k !== st.k)) battle.removeBuff(e, key);
          if (foe) for (const e of now) if (!st.foes.has(e) || k !== st.k) battle.addBuff(e, { key, mods: { aspd: foe * k }, source: unit, tags: ['talent'] });
          st.k = k;
          st.foes = now;
        }, { owner: unit });
        battle.on('death', (c) => { if (c.unit === unit) clear(); }, { owner: unit });
      } },
      { install(battle, unit) { // 有备无患: the charge (the payment part is the trait's)
        const stun = num(t1.stun);
        battle.on('beforeStatus', (c) => {
          if (c.target !== unit || c.cancel || (c.status !== 'stun' && c.status !== 'freeze')) return;
          const b = unit.findBuff(BOUNCE);
          if (!b) return;
          c.cancel = true;
          battle.removeBuff(unit, b);
          battle.fx('talent', { x: unit.x, y: unit.y, id: unit.id, name: 'lmleeBounceUsed' });
          const s = c.source;
          if (stun > 0 && s && s.side === 'enemy' && s.alive) battle.applyStatus(s, 'stun', { duration: stun, source: unit });
        }, { owner: unit, priority: 50 });
      } },
    ],
    install(battle, unit) {
      if (sid === S2) {
        const rec = recOf(S2), b = rec.bb ?? {};
        statBuff(battle, unit, 'lmlee:s2passive', { aspd: num(b.attack_speed) });
        const max = Math.floor(num(b.max_stack_cnt));
        // "期间我方每对目标造成一次伤害": every damage instance of our side on a marked target (not the blast itself)
        battle.on('damaged', (c) => {
          const marks = unit.mem.lmleeMarks;
          if (!marks || !marks.length || !(c.amount > 0) || c.type === 'element') return;
          const src = c.credit ?? c.source;
          if (!src || src.side !== 'ally' || c.dmg?.tags?.includes('lmleePaper')) return;
          for (const m of marks) {
            if (m.done || m.target !== c.target || m.stacks >= max) continue;
            m.stacks++;
            if (m.stacks >= max) battle.after(0, () => blast(battle, unit, m, rec), { owner: unit });
          }
        }, { owner: unit });
        battle.on('death', (c) => {
          const marks = unit.mem.lmleeMarks;
          if (c.unit === unit) { // he leaves: the marks go without a blast
            for (const m of marks ?? []) { m.done = true; if (m.target.alive) battle.removeBuff(m.target, m.key); }
            unit.mem.lmleeMarks = [];
            return;
          }
          if (!marks || !marks.length || c.unit.side !== 'enemy') return;
          for (const m of marks) {
            if (m.done || m.target !== c.unit) continue;
            m.at = { x: c.unit.x, y: c.unit.y };
            battle.after(0, () => blast(battle, unit, m, rec), { owner: unit });
          }
        }, { owner: unit });
      }
      if (sid === S3) {
        const prob = num(recOf(S3).bb?.prob);
        if (prob > 0) {
          battle.on('hit', (c) => {
            const s = c.source, d = c.dmg;
            if (c.target !== unit || !unit.skill?.active || !s || !d || !d.canDodge || (d.type !== 'phys' && d.type !== 'arts')) return;
            const set = unit.rangeKeySet;
            const inside = set && (s.side === 'enemy' ? bodyInKeys(s, set) : set.has(s.tileR * COLS + s.tileC));
            if (inside || !(battle.rng() < prob)) return;
            d.cancel = true;
            battle.fx('dodge', { x: unit.x, y: unit.y, id: unit.id });
            if (battle.hasHook('dodge')) battle.emit('dodge', { source: s, target: unit, dmg: d });
          }, { owner: unit, priority: 20 });
        }
      }
    },
  };
}
