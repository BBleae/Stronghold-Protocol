// server/sim/content/kits/waiguan/char_1048_orchd2.js — 焰狐龙梓兰 (狙击 · 重射手 closerange) 外援 kit (DESIGN §27,
// KIT_GUIDE.md).
//
// Chess ids: chess_char_diy_5_char_1048_orchd2_a/_b, chess_char_diy_6_char_1048_orchd2_a/_b (registered by ./index.js).
// Sources: the records (data/waiguan.json; normal = skill Lv4, elite = Lv7 + module ARC-X, tier V level 1, tier VI level 3)
// and the official buff templates (ArknightsGameData zh_CN battle/buff_template_data.json: orchd2_s_1[auto] /
// [damage_scale] / [reduce_sp] / [recover_sp_checker] / [stun_creator], orchd2_s_2[auto_once] / [duration] / [fly_mode],
// orchd2_s_3[knockback] / [magic_damage], orchd2_t_1[respawn_cost], orchd2_t_1_2[born] / [projectile], orchd2_t_2[…],
// orchd2_trait_1[respawn]; excel/range_table.json for the x-1 / x-2 grids).
//
// Her attack (hidden talent part 2, the attack ability: attack@atk_scale / attack@damage_scale; orchd2_s_1[damage_scale]
//   scales her ranged normal-attack damage by damage_scale): every arrow her attack ability shoots deals damage_scale of its
//   hit (after mitigation: dmg.mul), and a normal attack shoots round(1 / damage_scale) arrows (3 × 0.333) at its target.
//   The skills' arrows (S1 and 刚连射, the S2 volleys) are arrows of that ability too and take the same damage_scale; the
//   S2 landing blast and S3 ("造成攻击力N%的…伤害") are not arrows and do not. (Owner decision pending — the other
//   reading: a skill arrow "攻击力N%的箭矢" deals N% of ATK whole, i.e. no damage_scale on the S1 / 刚连射 arrows.)
// Trait (重射手 "高精度的近距离射击"): the closerange profile (nothing to add).
// S1 刚射 (MANUAL, DEFAULT kept; charges from the record): the next attack shoots the desc's first "发射N支" arrows at
//   atk_scale_1; then, while she still holds a charge, one more is spent on 刚连射 against the same target (when it is
//   still alive: a target already dead ends the skill — orchd2_s_1[recover_sp_checker] gives back the charge spent then, so
//   none is spent): the second "发射N支" arrows at atk_scale_2, each with stun_prob of 晕眩 `stun` s (rolled after its hit
//   while the target lives; battle RNG). "充能至最大层数时自动释放一次" (orchd2_s_1[auto], the skill's own trigger, not an
//   operation): at full charges she casts it even while the 3 s automatic-operation cooldown runs, as soon as an enemy is
//   in her attack selection — and that cast does not restart the cooldown (no pending cast, not silenced, able to act).
// S2 飞翔瞪射 (MANUAL, SKILL_RANGE + the record's customRangeGrid kept; duration and charges from the record): 起飞 for the
//   skill's duration (蒂比's flags: blocks flyers only, no ground enemy selects her; the ground enemies she blocked walk on;
//   no normal attack), the desc's "分别射出a、b、c支" volleys at every selectable enemy on the skill grid, each arrow
//   attack@atk_scale_loop × ATK physical, then, when the duration runs out, the landing blast: attack@atk_scale_end × ATK
//   physical to every selectable enemy on her own attack grid (the record's rangeGrid). "部署后立即释放一次"
//   (orchd2_s_2[auto_once]: cast with no SP): a free cast at every deployment.
// S3 龙之箭 (MANUAL, DEFAULT kept; charges from the record): she charges for the desc's "蓄力N秒" (no attack meanwhile; a
//   knock-out loses it), then the piercing arrow flies from her along her facing to the field rect's edge (max_dist): every
//   dist_interval tiles of its flight, every selectable enemy within ARROW_RADIUS of it (中点判定) takes atk_scale × ATK
//   physical and atk_scale_magic × ATK arts (orchd2_s_3[magic_damage]); every enemy it passed is then pushed along her
//   facing with 力度 `force` (orchd2_s_3[knockback] KnockBackWithCharacterDirection: a fixed direction).
// T1 强击瓶专家 (orchd2_t_2): at her first skill activation of each deployment (S2's free cast counts), her next
//   power_attack_count attacks get ATK ×power_attack_scale (pre-mitigation: an atk scale on every arrow of the attack,
//   刚连射 included). An attack = one engine attack (S1's cast and its 刚连射 are one: they share dmg.attackId; it is
//   counted at its first arrow that lands) or one S2 volley that has a target. The window is the INFINITY buff
//   orchd2_t_2[power_atk]: a 【移动】 (no exit, the buffs stay) keeps it; a deployment after an exit restarts it.
// T2 翔虫机动 (DP, REQUIREMENTS §1): "再部署时间−N秒" = the hidden part 3 respawn_time on her redeploy time
//   (`unit.base.respawnTime`, read by Battle._remove with the redeploy multipliers on top) — applied once; "且不提高部署费用"
//   (not_add_respawn_cost_cnt): the engine never raises an operator's redeploy cost — every redeploy charges her player
//   `unit.base.cost` (Battle._checkRedeploys / redeploy) — so it already holds (locked by the tests). "部署至上次部署位置周围
//   时，30秒内攻击力+N%": when she is deployed on a tile of the range-table grid `ignore_build_type_target_range` (x-1 / x-2;
//   ignore_build_type_target_dir 0: unrotated) around the tile she stood on when she last left the field (orchd2_t_1_2:
//   the marker projectile is emitted where she exits, ON_OWNER_FINISH, and finished at every deployment — so a 【移动】,
//   which is no exit, finds none), ATK +atk (MULTIPLIER) for atk_duration s. "并且可以部署在近战位": placement — no kit
//   changes placement in this mode (REQUIREMENTS §6), not modelled.
// Module ARC-X (梓兰特制箭靶): its trait "再部署时间减少" is the module's respawnTime attribute (already in the elite's stats)
//   and its talent changes (talent 1, hidden part 3) come through the record — nothing module-specific in the code.
// fx: 'volley' (S1 刚连射, S2 volleys: `targets`), 'takeoff' (S2), 'aoe' (S2 landing, its tiles), 'beam' (S3 arrow: one per
//   enemy it passed, from / to; 'strike' at its end when it passed none), 'buff' (翔虫机动).
//
// [ASSUMED] (no data / PRTS unreachable): the normal attack's arrow count (round(1 / damage_scale)); damage_scale on the
//   skills' arrows (above); the S2 volleys at k × duration / (volleys + 1) of the flight and the landing at its end; the
//   landing's "前方小范围" = her own attack grid; S3's "周围" radius ARROW_RADIUS and its pushes after the flight (the arrow
//   outruns the knock-back), the "蓄力N秒" of the desc rather than wait_duration (1.5: a part of it), the charge not broken
//   by a stun; T1 counts S2 volleys as attacks and powers the skills' arrows.

import { num, tal, talRec, lazySkills, live, hasHp, parseN, instantKindOf, gridOf, attackCandidates, ANY } from './_lib.js';
import { absoluteRangeKeys } from '../../../targeting.js';
import { COLS } from '../../../constants.js';

const S1 = 'skchr_orchd2_1', S2 = 'skchr_orchd2_2', S3 = 'skchr_orchd2_3';
/** excel/range_table.json grids of 翔虫机动's `ignore_build_type_target_range` (direction 1, symmetric: no rotation). */
const RANGE_TABLE = Object.freeze({
  'x-1': Object.freeze([[2, 0], [1, -1], [1, 0], [1, 1], [0, -2], [0, -1], [0, 0], [0, 1], [0, 2], [-1, -1], [-1, 0], [-1, 1], [-2, 0]]),
  'x-2': Object.freeze([[2, -1], [2, 0], [2, 1], [1, -2], [1, -1], [1, 0], [1, 1], [1, 2], [0, -2], [0, -1], [0, 0], [0, 1], [0, 2],
    [-1, -2], [-1, -1], [-1, 0], [-1, 1], [-1, 2], [-2, -1], [-2, 0], [-2, 1]]),
});
/** S3 龙之箭: "对周围所有敌人" radius around the arrow (tiles, 中点判定) [ASSUMED: no blackboard key — the arrow's lane]. */
const ARROW_RADIUS = 0.5;
/** 起飞 (蒂比's flags, kits/tier2.js LIFTOFF_FLAGS): blocks flyers only; ground enemies cannot select her. */
const LIFTOFF = Object.freeze({ blockFly: true, liftoff: true });
/** Damage tags: S1 刚连射 arrows; S2 volley arrows; S2 landing; S3 arrow (its physical and arts parts). */
const COMBO_TAG = 'orchd2Combo', VOLLEY_TAG = 'orchd2Volley', LAND_TAG = 'orchd2Landing', ARROW_TAG = 'orchd2DragonArrow';
/** Powered attack ids kept (T1): enough for the arrows of the attacks still in flight. */
const POWERED_KEEP = 16;
/** Text-only numbers: S1 "发射N支攻击力…" (twice), S2 "分别射出a、b、c支", S3 "蓄力N秒". */
const S1_ARROWS_RE = /发射(\d+)支攻击力/g, S2_VOLLEYS_RE = /分别射出([\d、]+)支/, S3_CHARGE_RE = /蓄力(\d+(?:\.\d+)?)秒/;

/** Per-unit state (one per copy of her): T1's window, its powered attack ids and S2's flight. */
const stateOf = (unit) => (unit.mem.orchd2 ??= { left: 0, scale: 1, opened: false, powered: new Map(), exit: null, s2: null });
/** T1: the ATK scale of the attack she makes now (one of the window's attacks is spent). */
function takePower(unit) {
  const st = stateOf(unit);
  if (!(st.left > 0)) return 1;
  st.left--;
  return st.scale;
}
/** Absolute tiles [[r, c]…] of `keys` (fx). */
const tilesOf = (keys) => keys.map((k) => [(k / COLS) | 0, k % COLS]);

/** S2: one volley — `n` arrows at every selectable enemy on the skill grid (counts as one attack for T1). */
function volley(battle, unit, grid, n, scale) {
  if (!grid || !(n > 0)) return;
  const foes = battle.enemiesInKeys(absoluteRangeKeys(grid, unit.tileR, unit.tileC, unit.dir, 0), unit, ANY);
  if (!foes.length) return;
  const amount = unit.s.atk * unit.s.atkScaleMul * scale * takePower(unit);
  battle.fx('volley', { x: unit.x, y: unit.y, id: unit.id, targets: foes.map((e) => e.id), n });
  for (const e of foes) {
    for (let i = 0; i < n && hasHp(e); i++) battle.dealDamage(unit, e, { amount, type: 'phys', isAttack: true, isSkill: true, tags: ['skill', VOLLEY_TAG] });
  }
}

/** S2: the landing blast on her own attack grid. */
function landing(battle, unit, grid, scale) {
  if (!grid || !(scale > 0)) return;
  const keys = absoluteRangeKeys(grid, unit.tileR, unit.tileC, unit.dir, 0);
  battle.fx('aoe', { x: unit.x, y: unit.y, id: unit.id, tiles: tilesOf(keys) });
  const amount = unit.s.atk * unit.s.atkScaleMul * scale;
  for (const e of battle.enemiesInKeys(keys, unit, ANY)) battle.dealDamage(unit, e, { amount, type: 'phys', isSkill: true, tags: ['skill', LAND_TAG] });
}

/** S3: the dragon arrow's flight (header). */
function dragonArrow(battle, unit, bb) {
  const step = num(bb.dist_interval), maxD = num(bb.max_dist);
  if (!(step > 0) || !(maxD > 0)) return;
  const [fr, fc] = unit.fwd;
  const R = battle.rect;
  const atk = unit.s.atk * unit.s.atkScaleMul;
  const phys = atk * num(bb.atk_scale), arts = atk * num(bb.atk_scale_magic);
  const passed = [];
  let end = { x: unit.x, y: unit.y };
  for (let k = 1; k * step <= maxD + 1e-9; k++) {
    const x = unit.x + fc * k * step, y = unit.y + fr * k * step;
    if (x < R.c0 - 0.5 || x > R.c1 + 0.5 || y < R.r0 - 0.5 || y > R.r1 + 0.5) break;
    end = { x, y };
    for (const e of battle.foesInRadius(x, y, ARROW_RADIUS, true)) {
      if (!passed.includes(e)) passed.push(e);
      if (phys > 0) battle.dealDamage(unit, e, { amount: phys, type: 'phys', isSkill: true, tags: ['skill', ARROW_TAG] });
      if (arts > 0 && hasHp(e)) battle.dealDamage(unit, e, { amount: arts, type: 'arts', isSkill: true, tags: ['skill', ARROW_TAG] });
    }
  }
  // (a beam per enemy it passed, shooter → target, as the enemy beams do; render/fx.js 'beam' reads from / to)
  for (const e of passed) battle.fx('beam', { x: unit.x, y: unit.y, from: unit.id, to: e.id, kind: 'dragonArrow' });
  if (!passed.length) battle.fx('strike', { x: end.x, y: end.y, id: unit.id, kind: 'dragonArrow' });
  const force = num(bb.force), dir = { x: fc, y: fr };
  for (const e of passed) if (e.alive) battle.push(e, force, { from: unit, dir, fixed: true });
}

export default function orchd2(bb, chess, def) {
  const t0 = tal(chess, 0), t1 = tal(chess, 1);
  const t1Str = talRec(chess, 1)?.bbStr ?? {};
  const atkPart = tal(chess, 2), respawnPart = tal(chess, 3);
  const sid = chess?.skill?.skillId ?? def?.skill?.id ?? null;
  const ownGrid = Array.isArray(chess?.rangeGrid) && chess.rangeGrid.length ? chess.rangeGrid : null;
  // her attack ability: damage_scale per arrow, round(1 / damage_scale) arrows per normal attack
  const ds = num(atkPart['attack@damage_scale']);
  const arrows = ds > 0 ? Math.max(1, Math.round(1 / ds)) : 1;
  const baseScale = num(atkPart['attack@atk_scale']);

  return {
    trait: { hits: arrows, ...(baseScale > 0 ? { atkScale: baseScale } : {}) },
    skills: lazySkills(chess, {
      [S1]: (rec) => {
        const b = rec.bb ?? {};
        const [n1, n2] = [...String(rec.desc ?? '').matchAll(S1_ARROWS_RE)].map((m) => +m[1]);
        const sc2 = num(b.atk_scale_2), p = num(b.stun_prob), stun = num(b.stun);
        return {
          kind: instantKindOf(rec),
          attack: {
            atkScale: num(b.atk_scale_1),
            hits: Math.max(1, num(n1)),
            onEachHit({ battle, unit, target, kind, attackId }) { // 刚连射
              if (kind !== 'main' || !(n2 > 0) || !hasHp(target) || !live(unit)) return;
              const sk = unit.skill;
              if (!sk || sk.id !== S1 || sk.charges < 1) return;
              if (sk.charges >= sk.maxCharges) sk.sp = 0;
              sk.charges -= 1;
              battle.fx('volley', { x: unit.x, y: unit.y, id: unit.id, targets: [target.id], n: n2 });
              const amount = unit.s.atk * unit.s.atkScaleMul * sc2;
              for (let i = 0; i < n2 && hasHp(target); i++) {
                battle.dealDamage(unit, target, { amount, type: 'phys', isAttack: true, isSkill: true, attackId, tags: ['skill', COMBO_TAG] });
                if (p > 0 && stun > 0 && hasHp(target) && battle.rng.chance(p)) battle.applyStatus(target, 'stun', { duration: stun, source: unit });
              }
            },
          },
        };
      },
      [S2]: (rec) => {
        const b = rec.bb ?? {};
        const counts = (String(rec.desc ?? '').match(S2_VOLLEYS_RE)?.[1] ?? '').split('、').map(Number).filter((n) => n > 0);
        const loop = num(b['attack@atk_scale_loop']), end = num(b['attack@atk_scale_end']);
        const grid = gridOf(rec);
        return {
          kind: 'duration',
          flags: LIFTOFF,
          attack: { noAttack: true },
          onStart({ battle, unit, skill }) {
            battle.releaseBlocked(unit);
            battle.fx('takeoff', { x: unit.x, y: unit.y, id: unit.id });
            stateOf(unit).s2 = { t: 0, next: 0, step: skill.duration / (counts.length + 1) };
          },
          onTick({ battle, unit, dt }) {
            const s = stateOf(unit).s2;
            if (!s) return;
            s.t += dt;
            while (s.next < counts.length && s.t + 1e-9 >= s.step * (s.next + 1)) {
              const n = counts[s.next++];
              if (unit.canAct) volley(battle, unit, grid, n, loop);
            }
          },
          onEnd({ battle, unit, reason }) {
            const st = stateOf(unit), s = st.s2;
            st.s2 = null;
            if (!s || reason !== 'duration' || !live(unit)) return;
            while (s.next < counts.length) {
              const n = counts[s.next++];
              if (unit.canAct) volley(battle, unit, grid, n, loop);
            }
            landing(battle, unit, ownGrid, end);
          },
        };
      },
      [S3]: (rec) => {
        const b = rec.bb ?? {};
        return {
          kind: 'duration',
          duration: parseN(rec.desc, S3_CHARGE_RE, num(b.wait_duration)),
          attack: { noAttack: true },
          onEnd({ battle, unit, reason }) { if (reason === 'duration' && live(unit)) dragonArrow(battle, unit, b); },
        };
      },
    }),
    talents: [
      { install(battle, unit) { // 强击瓶专家
        const count = Math.floor(num(t0.power_attack_count)), scale = num(t0.power_attack_scale);
        if (!(count > 0) || !(scale > 0) || scale === 1) return;
        const st = stateOf(unit);
        st.scale = scale;
        battle.on('deploy', (c) => {
          if (c.unit !== unit || c.move) return;
          st.opened = false;
          st.left = 0;
          st.powered.clear();
        }, { owner: unit, priority: 10 });
        battle.on('skillStart', (c) => {
          if (c.unit !== unit || st.opened) return;
          st.opened = true;
          st.left = count;
        }, { owner: unit, priority: 10 });
      } },
      { install(battle, unit) { // 翔虫机动
        const rt = num(respawnPart.respawn_time);
        if (rt && !unit.mem.orchd2Respawn) {
          unit.mem.orchd2Respawn = true;
          unit.base.respawnTime = Math.max(0, unit.base.respawnTime + rt);
        }
        const atk = num(t1.atk), dur = num(t1.atk_duration);
        const grid = Object.hasOwn(RANGE_TABLE, t1Str.ignore_build_type_target_range ?? '') ? RANGE_TABLE[t1Str.ignore_build_type_target_range] : null;
        if (!(atk > 0) || !(dur > 0) || !grid) return;
        const st = stateOf(unit);
        battle.on('death', (c) => { if (c.unit === unit) st.exit = [unit.tileR, unit.tileC]; }, { owner: unit });
        battle.on('deploy', (c) => {
          if (c.unit !== unit) return;
          const ex = st.exit;
          st.exit = null;
          if (!ex || !absoluteRangeKeys(grid, ex[0], ex[1], 'RIGHT', 0).includes(unit.tileR * COLS + unit.tileC)) return;
          battle.addBuff(unit, { key: 'orchd2:wirebug', duration: dur, mods: { atkPct: atk }, source: unit, visible: true, tags: ['talent'] });
          battle.fx('buff', { x: unit.x, y: unit.y, id: unit.id });
        }, { owner: unit });
      } },
    ],
    install(battle, unit) {
      // her attack ability: damage_scale on every arrow; T1's power on the arrows of a powered engine attack
      const st = stateOf(unit);
      battle.on('hit', (c) => {
        const d = c.dmg;
        if (c.source !== unit || !d.isAttack || !c.target || c.target.side !== 'enemy') return;
        if (ds > 0) d.mul *= ds;
        if (d.attackId) { // T1: the engine attack's first arrow that lands counts it (all its arrows share the id)
          if (!st.powered.has(d.attackId)) {
            st.powered.set(d.attackId, takePower(unit));
            if (st.powered.size > POWERED_KEEP) st.powered.delete(st.powered.keys().next().value);
          }
          const p = st.powered.get(d.attackId);
          if (p !== 1) d.amount *= p;
        }
      }, { owner: unit });
      // S1 "充能至最大层数时自动释放一次": at full charges, also during the operation cooldown
      if (sid === S1) {
        battle.on('tick', () => {
          const sk = unit.skill;
          if (!sk || sk.maxCharges < 2 || sk.charges < sk.maxCharges || sk.pending || !sk.opCooling || !unit.canAct || unit.s.flags.silence) return;
          if (!attackCandidates(battle, unit).length) return;
          const ready = sk.opReadyAt; // the skill's own cast is no automatic operation: the cooldown runs on unchanged
          if (sk.activate('auto')) sk.opReadyAt = ready;
        }, { owner: unit });
      }
      // S2 "部署后立即释放一次": a free cast at every deployment
      if (sid === S2) {
        battle.on('deploy', (c) => { if (c.unit === unit && unit.skill && !unit.skill.active) unit.skill.activate('deploy', { free: true }); }, { owner: unit });
      }
    },
  };
}
