// server/sim/content/kits/waiguan/char_134_ifrit.js — 伊芙利特 (术师 · 轰击术师 blastcaster) 外援 kit (DESIGN §27, docs/WAIGUAN-KITS.md).
//
// Chess ids: chess_char_diy_5_char_134_ifrit_a/_b, chess_char_diy_6_char_134_ifrit_a/_b (registered by ./index.js).
// Numbers: normal = skill Lv4, elite = Lv7 + its module (data/waiguan.json); every number below comes from a blackboard.
// Trait (blastcaster) "攻击造成超远距离的群体法术伤害": professions.js SUB.blastcaster `rangeAoe` (every selectable enemy on
//   her range at once, instant 'beam' hits) — nothing here.
// S1 狂热 (duration, MANUAL, trigger DEFAULT): ATK +atk, ASPD +attack_speed.
// S2 炎爆 (charges ×maxChargeTime, AUTO, DEFAULT — "下次攻击": an AUTO skill keeps its own rule): the next attack deals
//   atk_scale × ATK arts to every enemy it strikes; each one struck gets DEF `def` (flat, 同名效果取最高) for `duration` s
//   and burns for that time: burn.atk_scale × her ATK arts once per second (3.01 s ⇒ ticks at 1, 2, 3 s).
// S3 灼地 (duration, MANUAL, DEFAULT): she makes no normal attack; once per second (the first at the cast) every ground
//   enemy on her range takes atk_scale × ATK arts and RES `magic_resistance` (flat, 同名效果取最高, while it keeps being hit),
//   and she loses hp_ratio of her max HP (流失).
// T1 精神融解: enemies on her range RES ×(1 + magic_resistance) (−40 %, 同名效果取最高; _lib enemyAura).
// T2 莱茵回路: +sp SP every `interval` s on the field (counted from each deployment); elite BLA-X upgrade: every
//   ifrit_e_002[dice_sp].interval s a ifrit_e_002[dice_sp].prob chance of ifrit_e_002[dice_sp].sp SP more.
// Module BLA-X (uniequip_002_ifrit) trait: her attack damage ×(1 + damage_scale × clamp((d − min_dist) / (max_dist −
//   min_dist))), d = tiles to the target ("距离越远伤害越高，最高达到110%"; pool: 协律 kits/tier2.js, kits/tier4.js).
// Module BLA-D (uniequip_003_ifrit) trait: every arts damage she deals adds ep_damage_ratio × that damage as 灼燃损伤
//   (docs/SIM.md §7.2 "伤害N%的…损伤" = the HP damage just dealt); T1 upgrade (hidden part element_atk_scale): her attack
//   on a target in a 灼燃损伤 burst (`burnBurst`) adds element_atk_scale × ATK 元素伤害.
// Damage tags: S2 灼烧 and S3 ticks are DoT ('dot', canDodge false — the pool convention); the BLA-D fill 'ifritBlaD'.
// Triggers: the record's — S1 / S3 DEFAULT (no 术师 class row), S2 DEFAULT (AUTO) — all kept; none corrected.
// fx: 'ignite' (S2 burn), 'flame' / 'scorchBurst' (S3).
// [ASSUMED] (PRTS unreachable from the authoring container; to confirm against PRTS 伊芙利特 备注):
//   * S2 灼烧: one tick per second (the 3.01 s blackboard duration reads as ticks at 1/2/3 s), her ATK at the hit, the
//     burn of a re-hit target continues its cadence and runs 3.01 s again (refresh 'extend'); one burn per Ifrit.
//   * S3: no normal attacks while it runs (a continuous flame; the text grants no attack bonus); damage, RES cut and HP
//     loss in one-second ticks starting at the cast (20 ticks over 20 s = "每秒" × duration); the RES cut does not stack
//     and lasts one tick + AURA_DUR after the last hit; the 流失 may knock her out (the text sets no floor).
//   * T1: like every Buff selector, it skips 隐匿 / untargetable enemies (PRTS 隐匿); refreshed every AURA_IV s.

import { num, tal, hiddenBb, traitBb, lazySkills, mods, instantKindOf, giveSp, skillBusy, elementDmg, elementalDmg, hasHp, everyDeployed, enemyAura } from './_lib.js';

/** S3 灼地 "每秒…": one damage / RES / HP-loss tick per second, the first at the cast [ASSUMED]. */
const S3_TICK = 1;
/** T1 aura refresh period and the margin a refreshed RES cut outlives its last refresh by (s). */
const AURA_IV = 0.2;
const AURA_DUR = 0.45;
/** S3 hits ground enemies only ("地面敌人"). */
const GROUND = Object.freeze({ canHitFly: false, groundOnly: true });

/** RES ×(1 + v) (v < 0): 精神融解. */
const resMulOf = (v) => ({ resMul: Math.max(0, 1 + v) });
/** RES +v flat (v < 0): S3. */
const resFlatOf = (v) => ({ resFlat: v });
/** DEF +v flat (v < 0): S2. */
const defFlatOf = (v) => ({ defFlat: v });

/** S2 灼烧 on `e`: `amount` arts per second for `dur` s (one burn per Ifrit; a re-hit keeps the cadence, runs `dur` again). */
function burn(battle, unit, e, amount, dur) {
  if (!(amount > 0) || !(dur > 0) || !e.alive) return;
  const b = battle.addBuff(e, {
    key: `ifrit:burn:${unit.id}`, duration: dur, interval: 1, refresh: 'extend', source: unit, data: { amount },
    // a DoT tick (pool convention, e.g. 伊内丝 S1 kits/tier4.js): 'dot' (持续伤害 effects read it), never dodged
    onTick: ({ unit: x, buff }) => { battle.dealDamage(unit, x, { amount: buff.data.amount, type: 'arts', isSkill: true, canDodge: false, tags: ['skill', 'dot', 'ifritBurn'] }); },
  });
  if (b) b.data.amount = amount;
}

/** S2 炎爆: next attack ×atk_scale; every enemy it strikes: DEF cut + 灼烧 for `duration` s. */
function blast(rec) {
  const b = rec.bb ?? {};
  const dur = num(b.duration), defCut = num(b.def), burnScale = num(b['burn.atk_scale']);
  return {
    kind: instantKindOf(rec),
    attack: {
      atkScale: num(b.atk_scale, 1),
      onHit({ battle, unit, target }) {
        if (!target || !target.alive || target.side !== 'enemy' || !(dur > 0)) return;
        if (defCut) battle.applyStrongest(target, 'ifrit:s2def', { duration: dur, value: defCut, mods: defFlatOf, source: unit });
        burn(battle, unit, target, unit.s.atk * burnScale, dur);
        battle.fx('ignite', { x: target.x, y: target.y, id: target.id, src: unit.id });
      },
    },
  };
}

/** S3 灼地: no attacks; per second every ground enemy on her range: atk_scale × ATK arts + RES cut; she loses hp_ratio. */
function scorch(rec) {
  const b = rec.bb ?? {};
  const scale = num(b.atk_scale), loss = num(b.hp_ratio), res = num(b.magic_resistance);
  const total = Math.max(1, Math.round(num(rec.duration, S3_TICK) / S3_TICK));
  const pulse = (battle, unit) => {
    for (const e of battle.enemiesInKeys(unit.rangeKeys, unit, GROUND)) {
      battle.dealDamage(unit, e, { amount: unit.s.atk * scale * S3_TICK, type: 'arts', isSkill: true, canDodge: false, tags: ['skill', 'dot', 'ifritScorch'] });
      if (res && e.alive) battle.applyStrongest(e, 'ifrit:s3res', { duration: S3_TICK + AURA_DUR, value: res, mods: resFlatOf, source: unit });
      battle.fx('scorchBurst', { x: e.x, y: e.y, id: e.id, src: unit.id });
    }
    if (loss > 0 && unit.alive) battle.loseHp(unit, unit.s.maxHp * loss * S3_TICK, { source: unit, tags: ['skill', 'ifritScorch'] });
  };
  return {
    kind: 'duration',
    attack: { noAttack: true },
    onStart({ battle, unit }) {
      unit.mem.ifritScorch = { t: 0, n: 1 };
      battle.fx('flame', { x: unit.x, y: unit.y, id: unit.id });
      pulse(battle, unit);
    },
    onTick({ battle, unit, dt }) {
      const st = unit.mem.ifritScorch;
      if (!st) return;
      st.t += dt;
      while (st.n < total && st.t + 1e-6 >= st.n * S3_TICK && unit.alive) { st.n++; pulse(battle, unit); }
    },
    onEnd({ unit }) { unit.mem.ifritScorch = null; },
  };
}

export default function ifrit(bb, chess) {
  const t0 = tal(chess, 0), t1 = tal(chess, 1), tb = traitBb(chess), hb = hiddenBb(chess);
  return {
    skills: lazySkills(chess, {
      skchr_ifrit_1: (rec) => ({ kind: 'duration', mods: mods({ atkPct: num(rec.bb?.atk), aspd: num(rec.bb?.attack_speed) }) }),
      skchr_ifrit_2: blast,
      skchr_ifrit_3: scorch,
    }),
    talents: [
      { install(battle, unit) { // 精神融解 (+ BLA-D: 元素伤害 on an attacked target in a 灼燃损伤 burst)
        enemyAura(battle, unit, { key: 'ifrit:meltdown', value: num(t0.magic_resistance), modsOf: resMulOf, interval: AURA_IV, dur: AURA_DUR });
        const el = num(hb.element_atk_scale);
        if (!(el > 0)) return;
        // priority 10: decided before the BLA-D 灼燃损伤 rider below (0) may burst the target with this very hit
        battle.on('damaged', (c) => {
          const t = c.target;
          if (c.source !== unit || !t || t.side !== 'enemy' || !c.dmg?.isAttack || c.type === 'element' || c.type === 'elemental') return;
          if (t.findBuff('burnBurst') && hasHp(t)) elementalDmg(battle, unit, t, unit.s.atk * el, 'burn', ['talent', 'ifritMelt']);
        }, { owner: unit, priority: 10 });
      } },
      { install(battle, unit) { // 莱茵回路 (+ BLA-X: the dice)
        everyDeployed(battle, unit, num(t1.interval), () => giveSp(unit, num(t1.sp)));
        const p = num(t1['ifrit_e_002[dice_sp].prob']), sp = num(t1['ifrit_e_002[dice_sp].sp']);
        if (!(p > 0 && sp > 0)) return;
        everyDeployed(battle, unit, num(t1['ifrit_e_002[dice_sp].interval'], num(t1.interval)), () => {
          if (!skillBusy(unit) && battle.rng.chance(Math.min(1, p))) giveSp(unit, sp); // no roll while no SP can be gained
        });
      } },
    ],
    install(battle, unit) {
      // BLA-X: farther targets take more attack damage (the trait bb exists only with that module)
      const ds = num(tb.damage_scale), lo = num(tb.min_dist), hi = num(tb.max_dist);
      if (ds > 0 && hi > lo) {
        battle.on('hit', (c) => {
          const t = c.target;
          if (c.source !== unit || !c.dmg.isAttack || !t || t.side !== 'enemy') return;
          const d = Math.hypot(t.x - unit.x, t.y - unit.y);
          c.dmg.mul *= 1 + ds * Math.max(0, Math.min(1, (d - lo) / (hi - lo)));
        }, { owner: unit });
      }
      // BLA-D: every arts damage she deals adds ep_damage_ratio × that damage as 灼燃损伤
      const ep = num(tb.ep_damage_ratio);
      if (ep > 0) {
        battle.on('damaged', (c) => {
          const t = c.target;
          if (c.source !== unit || c.type !== 'arts' || !(c.amount > 0) || !t || t.side !== 'enemy') return;
          elementDmg(battle, unit, t, 'burn', c.amount * ep, ['module', 'ifritBlaD']);
        }, { owner: unit });
      }
    },
  };
}
