// server/sim/content/kits/waiguan/char_2014_nian.js — 年 (重装 · 铁卫 protector) 外援 kit (DESIGN §27, docs/WAIGUAN-KITS.md).
//
// Chess ids: chess_char_diy_5_char_2014_nian_a/_b, chess_char_diy_6_char_2014_nian_a/_b (registered by ./index.js).
// Numbers: normal = skill Lv4, elite = Lv7 + its module (data/waiguan.json); every number below comes from a blackboard.
// Trait (protector) "能够阻挡三个敌人": the data block count (profile default, professions.js SUB.protector); PRO-Y "能够阻挡
//   四个敌人" is its attr block_cnt +1, already in the elite's stats.
// Every skill is MANUAL with the official 重装 class row TAKE_DAMAGE ("不受技能范围影响，受到伤害时释放技能"): kept. The
//   owner's deliberate DEFAULT deviation (tools/build-data.mjs TRIGGER_DEVIATIONS, DESIGN §21.29) names six pool skills
//   only; none corrected here.
// S1 锡灼 (duration): DEF +def, ATK +atk, normal attacks deal arts damage.
// S2 铜印 (duration): no normal attack; DEF +def, block +block_cnt; every enemy attack that hits her while it runs: the
//   attacker takes atk_scale × her ATK arts and loses its special abilities (沉默, the enemy-side 'silence') `silence` s.
// S3 铁御 (duration): ATK +nian_s_3[self].atk (block +nian_s_3[self].block_cnt = 0); the OTHER allied operators on the
//   skill range (x-2, "周围") DEF +nian_s_3[ally].def, block +nian_s_3[ally].block_cnt and 抵抗 (−one_minus_status_resistance:
//   the resisted statuses last half as long) while it runs (refreshed every AURA_IV s, dropped at its end); with two 年
//   the stronger ally part holds (pool installAura rule, kits/tier1.js).
// T1 积甲成山 "编入队伍时": every 重装 operator of her player on the board (herself included) max HP +max_hp for the whole
//   battle (persist; 同名效果取最高 between two copies). PRO-Y upgrade (its numbers sit in the module's trait part): per 重装
//   operator of her player on the field (≤ max_stack_cnt) her own max HP +max_hp and healing taken heal_scale + heal_scale_addition
//   each (≤ heal_scale_max_value).
// T2 干明可鉴: `times` layers of 护盾 at every deployment (each negates one damage instance: buff `shieldHits`, the pool's
//   护盾 — 空弦 铁弦 kits/tier3.js, 泥岩 沃土予身 kits/tier4.js). PRO-X upgrade: each broken layer ATK +atk, DEF +def
//   (stacking, ≤ max_stack_cnt, until she leaves the field) and +sp SP.
// Module PRO-X (uniequip_002_nian) trait: DEF +def while she blocks an enemy (pool: 星熊 PRO-X, kits/tier4.js).
// fx: 'shield' / 'shieldBreak' (T2), 'thorns' (S2 counter), 'buff' (S3).
// [ASSUMED] (PRTS unreachable from the authoring container):
//   * S2: the counter (tagged 'counter', not dodgeable — the pool convention) answers every enemy attack instance that
//     reaches her, ranged ones included, also one a 护盾 layer absorbs ("每次受到攻击时"); not a hit dodged or cancelled
//     before it lands, not a non-attack damage.
//   * S3: "友方干员" = operators (no summons / devices); the aura follows her skill range around her tile.
//   * T1 PRO-Y: "场上每有一名重装干员" counts her player's 重装 operators on the field, herself included (not a teammate's
//     on a shared field, like the "编入队伍时" part); "编入队伍时" = her player's 重装 operators of this battle (deployed or
//     not, persist).

import { num, tal, traitBb, lazySkills, mods, gridOf, isOp, whileOn, alliesInGridOf, toggleBuff } from './_lib.js';

/** S3 aura refresh period and buff length (s): the ally buffs outlive one refresh. */
const AURA_IV = 0.25;
const AURA_DUR = 0.4;
/** The x-2 skill range of S3 (fallback only: the record carries it). */
const X2 = Object.freeze([[2, -1], [2, 0], [2, 1], [1, -2], [1, -1], [1, 0], [1, 1], [1, 2], [0, -2], [0, -1], [0, 0], [0, 1], [0, 2],
  [-1, -2], [-1, -1], [-1, 0], [-1, 1], [-1, 2], [-2, -1], [-2, 0], [-2, 1]]);
const T1_KEY = 'nian:armor';
const S3_KEY = 'nian:ironGuard';
const isTank = (a) => isOp(a) && a.def?.profession === 'TANK';

/** S3 铁御: the ally part, refreshed while the skill runs. */
function ironGuard(rec) {
  const b = rec.bb ?? {};
  const grid = gridOf(rec) ?? X2;
  const allyDef = num(b['nian_s_3[ally].def']);
  const allyMods = mods({ defPct: allyDef, blockCnt: num(b['nian_s_3[ally].block_cnt']) });
  const resist = Math.min(0.95, Math.max(0, -num(b.one_minus_status_resistance)));
  const pulse = (battle, unit) => {
    for (const a of alliesInGridOf(battle, unit, grid)) {
      if (a === unit || !isOp(a)) continue;
      // two 年 never stack nor flicker: a stronger 铁御 of another 年 still running keeps the ally (pool installAura rule)
      const cur = a.findBuff(S3_KEY);
      const held = cur && cur.source !== unit && num(cur.data?.v) > allyDef && cur.timeLeft > 0.05;
      if (!held && Object.keys(allyMods).length) battle.addBuff(a, { key: S3_KEY, duration: AURA_DUR, mods: allyMods, source: unit, data: { v: allyDef }, visible: true, tags: ['skill'] });
      if (resist > 0) battle.applyStatus(a, 'resist', { duration: AURA_DUR, value: resist, source: unit });
    }
  };
  const drop = (battle, unit) => {
    for (const a of battle.allyUnits) {
      const s = a.findBuff(S3_KEY);
      if (s && s.source === unit) battle.removeBuff(a, s);
      const r = a.buffs.find((x) => x.status === 'resist' && x.source === unit);
      if (r) battle.removeBuff(a, r);
    }
  };
  return {
    kind: 'duration',
    mods: mods({ atkPct: num(b['nian_s_3[self].atk']), blockCnt: num(b['nian_s_3[self].block_cnt']) }),
    onStart({ battle, unit }) {
      unit.mem.nianGuardAcc = 0;
      battle.fx('buff', { x: unit.x, y: unit.y, id: unit.id });
      pulse(battle, unit);
    },
    onTick({ battle, unit, dt }) {
      unit.mem.nianGuardAcc = num(unit.mem.nianGuardAcc) + dt;
      if (unit.mem.nianGuardAcc + 1e-9 < AURA_IV) return;
      unit.mem.nianGuardAcc = 0;
      pulse(battle, unit);
    },
    onEnd({ battle, unit }) { drop(battle, unit); },
  };
}

export default function nian(bb, chess) {
  const t0 = tal(chess, 0), t1 = tal(chess, 1), tb = traitBb(chess);
  return {
    skills: lazySkills(chess, {
      skchr_nian_1: (rec) => ({
        kind: 'duration', mods: mods({ defPct: num(rec.bb?.def), atkPct: num(rec.bb?.atk) }), attack: { dmgType: 'arts' },
      }),
      skchr_nian_2: (rec) => ({
        kind: 'duration', mods: mods({ defPct: num(rec.bb?.def), blockCnt: num(rec.bb?.block_cnt) }), attack: { noAttack: true },
      }),
      skchr_nian_3: ironGuard,
    }),
    talents: [
      { install(battle, unit) { // 积甲成山 (+ PRO-Y: per 重装 operator of her player on the field)
        const hp = num(t0.max_hp);
        if (hp > 0) {
          for (const a of battle.allyUnits) {
            if (!isTank(a) || a.ownerId !== unit.ownerId) continue;
            const cur = a.findBuff(T1_KEY);
            if (cur && num(cur.data?.v) >= hp) continue; // another copy's equal or stronger 积甲成山
            battle.addBuff(a, { key: T1_KEY, mods: { hpPct: hp }, persist: true, allowDead: true, source: unit, data: { v: hp }, tags: ['talent'] });
          }
        }
        const per = num(tb.max_hp), add = num(tb.heal_scale_addition);
        if (!(per > 0 || add > 0)) return;
        const maxN = Math.max(0, Math.floor(num(tb.max_stack_cnt, 3))), base = num(tb.heal_scale, 1), cap = num(tb.heal_scale_max_value, Infinity);
        const update = () => {
          const n = Math.min(maxN, battle.allies(unit.ownerId).filter(isTank).length);
          if (n === unit.mem.nianTanks) return;
          unit.mem.nianTanks = n;
          if (n > 0) battle.addBuff(unit, { key: 'nian:tankCount', mods: mods({ hpPct: per * n, healingTakenMul: Math.min(cap, base + add * n) }), tags: ['talent'] });
          else battle.removeBuff(unit, 'nian:tankCount');
        };
        battle.on('deploy', (c) => { if (c.unit === unit) { unit.mem.nianTanks = -1; update(); } }, { owner: unit });
        whileOn(battle, unit, AURA_IV, update);
      } },
      { install(battle, unit) { // 干明可鉴 (+ PRO-X: each broken layer ATK / DEF + and SP)
        const layers = Math.floor(num(t1.times));
        if (!(layers > 0)) return;
        const step = mods({ atkPct: num(t1.atk), defPct: num(t1.def) }), sp = num(t1.sp);
        const maxStacks = Math.max(1, Math.floor(num(t1.max_stack_cnt, layers)));
        battle.on('deploy', (c) => {
          if (c.unit !== unit) return;
          unit.mem.nianLayers = layers;
          battle.addBuff(unit, { key: 'nian:shield', shieldHits: layers, visible: true, tags: ['talent'] });
          battle.fx('shield', { x: unit.x, y: unit.y, id: unit.id });
        }, { owner: unit });
        // a layer absorbs the whole instance; `damaged` still reports it (amount 0) — count the layers it took
        battle.on('damaged', (c) => {
          if (c.target !== unit || !unit.alive) return;
          const left = unit.findBuff('nian:shield')?.shieldHits ?? 0;
          const broken = num(unit.mem.nianLayers) - left;
          if (broken <= 0) return;
          unit.mem.nianLayers = left;
          battle.fx('shieldBreak', { x: unit.x, y: unit.y, id: unit.id });
          for (let i = 0; i < broken; i++) {
            if (Object.keys(step).length) battle.addBuff(unit, { key: 'nian:temper', refresh: 'stack', maxStacks, mods: step, visible: true, tags: ['talent'] });
            if (sp > 0) unit.skill?.gainSp(sp, 'talent'); // (lost while a skill runs, as any SP)
          }
        }, { owner: unit, priority: 10 });
      } },
    ],
    install(battle, unit) {
      // PRO-X trait: DEF + while blocking (the key exists only in that module's trait part)
      const bd = num(tb.def);
      if (bd) toggleBuff(battle, unit, 'nian:blockGuard', () => unit.blocking.length > 0, { defPct: bd });
      // S2 铜印: the counter of every enemy attack while it runs
      if (unit.skill?.id !== 'skchr_nian_2') return;
      const rec = (chess?.skills ?? []).find((s) => s && s.skillId === 'skchr_nian_2') ?? chess?.skill ?? {};
      const scale = num(rec.bb?.atk_scale), sil = num(rec.bb?.silence);
      battle.on('damaged', (c) => {
        const src = c.source;
        if (c.target !== unit || !unit.alive || !unit.skill.active || !src || src.side !== 'enemy' || !src.alive || !c.dmg?.isAttack) return;
        // a counter (pool convention: generic.js counter, 星熊 kits/tier4.js): tagged 'counter', never dodged
        if (scale > 0) battle.dealDamage(unit, src, { amount: unit.s.atk * scale, type: 'arts', isSkill: true, canDodge: false, tags: ['skill', 'nianCounter', 'counter'] });
        if (sil > 0 && src.alive) battle.applyStatus(src, 'silence', { duration: sil, source: unit });
        battle.fx('thorns', { x: unit.x, y: unit.y, id: unit.id, target: src.id });
      }, { owner: unit });
    },
  };
}
