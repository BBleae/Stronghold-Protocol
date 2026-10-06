// server/match/unite.js — 联防 (Unite) planning and LP attribution (DESIGN §6.1, research 06 §5, research 08 §5).
//
// Trigger (co-op only): after the normal combats, ≥ 1 alive player leaked (a counted leak ⇒ not perfect) and
// ≥ 1 alive player was perfect. Helpers (PRTS 卫戍协议/帮助 §联防阶段): up to config.unite.maxHelpers (2) perfect (per
// 联防 field; one field up to 4 alive — more above, see the end of this header)
// players chosen by most units on the field (downed included) > has an active bond (存疑) > most undowned units, then
// seat; with 2 helpers the one ranked first by most units > active bond > Σ active bond layers (存疑) > most undowned
// units "率先迎敌" on the RIGHT-hand field (colOffset +8, where the escaped_multi routes enter), the other keeps the
// left half (colOffset 0); a lone helper plays escaped_single on its own field. Their operators keep the HP ratio and
// the SP (技力, stored charges included) from the end of their own combat, nothing else — a skill still running then
// enters switched off (BattleResult.unitsEnd → PlayerBattleInput.units[].carryState `{ hpPct, sp }`, "阵地以其当前状态";
// community report #34 / GitHub #82: it used to restart for free). An operator knocked out at the end of its own combat (alive false) is fielded with
// `carryState: { down: true }`: PRTS "部署完成后，将对应单位的生命比例、技力修改至与上一阶段结束时相同（召唤物仅修改技力，
// 上一阶段为退场状态的干员强制退场）" — the sim deploys it with everyone and forces it out at once (constants.js
// FORCED_EXIT), so it lies on its own tile with the redeploy ring and comes back like after any knock-out (user
// playtest #5 item 2: it used to be left out and vanished). Its timer is its full redeploy time (the official 联防
// setup carries only hp / tech per operator, research 09 §3 HelpBattleInfo; the user confirmed it restarts). The board's summon
// pieces are fielded as the board has them and keep only their SP ("召唤物仅修改技力": carryState `{ sp }`, unitsEnd lists
// them beside the operators; one off the field at the end enters fresh [ASSUMED]). Enemies = the union of every leaker's
// counted leaks (same stats: the SpawnSpec mods travel with the leak), routed on the escaped template (`escaped_single`
// for 1 helper, `escaped_multi` for 2): walkers on its `lrsldr` action, flyers on `yokai`, tokens on `gopro_2` /
// `lazerd` (waves.js buildUniteWave); kill bounties keep paying the killer (a helper). No IN_BATTLE layer gains ("该阶段
// 不能叠加层数"); the helpers' bonds carry the layers their own combat reached (PlayerState.battleInput `reached`: the
// round's pending gains, capped like settle() — the strip's count; "以其阵地当前的状态" [ASSUMED] includes them; until 0.1.3
// the round-start layers), and settle() still adds those gains once. Time limit = the round's combat limit.
// LP: an enemy still alive at the end (leaked in the unite battle, or never spawned before the limit) costs its
// SOURCE player 1 LP; each player's round loss = min(lpCap, survivors attributed to them + leaks that could not
// re-enter) — the same 10 cap as a normal round.
//
// More than 4 alive (remake extension, gamedata.js largeRoom; DESIGN §24.4, docs/META.md §4): 1–4 alive keep exactly
// the rules above — one field 'u', ≤ maxHelpers (2) helpers, every leaker's enemies on it. Above 4 alive, with
// k = ⌈alive / 4⌉ (uniteFieldBudget): helpers = the top maxHelpers·k perfect players by the selection ranking above,
// assigned maxHelpers per field in that order (uniteHelperGroups; within a field the pair order, sides, template and
// colOffsets work as above), with k first capped by the number of leakers (uniteFieldCount), so the field count =
// min(k, leakers, ⌈helpers / 2⌉) — never a field without a helper or without a leaker. Field ids
// 'u', then 'u2', 'u3', … (uniteFieldId; seeds `u:<round>`, `u2:<round>`, …). The leakers are spread over the fields
// balancing their counted leaks (largest leaker first, to the field with the fewest so far — the lowest field on a tie —
// leakers of equal leaks by seat; every leaker has ≥ 1 counted leak, so each field gets one). Each field is a normal
// 联防 battle with only its own leakers' enemies; settlement bills each leaker from its own field's result (uniteBills: a
// field that could not run charges its leakers' own leaks, as without a 联防).
// A plan: `{ helpers, leakers, leaked, notReentered, groups }` — the union over every field (helpers in field order,
// leakers and leaks in seat order, as with one field) plus `groups: [{ fieldId, helpers, leakers, leaked, notReentered }]`
// in field order (one field: its group shares the plan's own arrays).

import { buildUniteWave } from './waves.js';
import { layerGainRoom } from '../../shared/constants.js';

/** Field id of the i-th 联防 field (0-based): 'u', then 'u2', 'u3', … */
export function uniteFieldId(i) {
  return i > 0 ? `u${i + 1}` : 'u';
}

/**
 * How many 联防 fields `alive` players may get: 1 up to largeRoom.players (4) alive — the official rule — else
 * ⌈alive / 4⌉ (remake extension: 2 for 5–8 alive).
 * @param {import('./gamedata.js').GameData} gd
 */
export function uniteFieldBudget(gd, alive) {
  if (!gd || typeof gd.isLargeRoom !== 'function' || !gd.isLargeRoom(alive)) return 1;
  return Math.max(1, Math.ceil(Math.floor(Number(alive)) / gd.largeRoom.players));
}

/**
 * How many 联防 fields a round asks for: uniteFieldBudget capped by the number of leakers, so every field fights some
 * leaker's enemies (1 leaker → one field, the official layout). Always 1 up to 4 alive.
 * @param {import('./gamedata.js').GameData} gd
 */
export function uniteFieldCount(gd, alive, leakers) {
  return Math.max(1, Math.min(uniteFieldBudget(gd, alive), Math.floor(Number(leakers)) || 0));
}

/**
 * The 联防 fields of a plan in field order: `plan.groups`, or — a plan built without them (tests) — the plan itself as
 * the one field 'u'.
 * @returns {Array<{ fieldId: string, helpers: any[], leakers: any[], leaked: object[], notReentered: Map<string, number> }>}
 */
export function uniteGroups(plan) {
  if (!plan) return [];
  if (Array.isArray(plan.groups) && plan.groups.length) return plan.groups;
  return [{ fieldId: uniteFieldId(0), helpers: plan.helpers || [], leakers: plan.leakers || [], leaked: plan.leaked || [], notReentered: plan.notReentered || new Map() }];
}

/** The 联防 field (group) a player is on: as a helper, else as a leaker; null for anyone else. */
export function uniteGroupOf(plan, playerId) {
  const groups = uniteGroups(plan);
  const has = (list) => (list || []).some((p) => p && p.playerId === playerId);
  return groups.find((g) => has(g.helpers)) || groups.find((g) => has(g.leakers)) || null;
}

/**
 * Each 联防 field with its result. `uniteResult`: the field's BattleResult with one field (as ever), an array of the
 * fields' results in field order with several (Match settle(plan, results)).
 * @returns {Array<{ group: object, result: object|null }>}
 */
export function uniteFieldResults(plan, uniteResult) {
  const groups = uniteGroups(plan);
  const list = Array.isArray(uniteResult) ? uniteResult : null;
  if (groups.length <= 1) return groups.map((group) => ({ group, result: (list ? list[0] : uniteResult) || null }));
  return groups.map((group, i) => ({ group, result: (list && list[i]) || null }));
}

/**
 * What settlement bills each leaker after the 联防: playerId → its enemies that survived on its own field (uncapped:
 * uniteSurvivors of that field's result), or null when its field's battle could not run (no result / a synthetic one —
 * settle() then charges the leaker's own counted leaks, as without a 联防).
 * @returns {Map<string, number|null>}
 */
export function uniteBills(plan, uniteResult) {
  const out = new Map();
  if (!plan) return out;
  for (const { group, result } of uniteFieldResults(plan, uniteResult)) {
    const ran = !!(result && !result.synthetic);
    const survivors = ran ? uniteSurvivors(group, result) : null;
    for (const ps of group.leakers || []) out.set(ps.playerId, ran ? survivors.get(ps.playerId) || 0 : null);
  }
  return out;
}

/**
 * The 联防 result a player's settlement reads (bounty coins, kills and damage of a helper; onBattleResult `unite`): one
 * field → that field's result; several → the player's own field's (helper or leaker), else the first field's.
 */
export function uniteResultFor(plan, uniteResult, playerId) {
  if (!Array.isArray(uniteResult)) return uniteResult || null;
  const fr = uniteFieldResults(plan, uniteResult);
  const g = uniteGroupOf(plan, playerId);
  const own = g ? fr.find((x) => x.group.fieldId === g.fieldId) : null;
  return (own ? own.result : fr.length ? fr[0].result : null) || null;
}

/**
 * @param {import('./Match.js').Match} m
 * @param {Map<string, object>} results playerId → BattleResult.perPlayer entry of the player's own combat
 * @returns {null | { helpers: any[], leakers: any[], leaked: object[], notReentered: Map<string, number>, groups: object[] }}
 */
export function planUnite(m, results) {
  if (m.isSolo) return null;
  const alive = m.alivePlayers();
  const leakers = [];
  const perfects = [];
  /** leaker → its counted leaks (the field balance) */
  const countedOf = new Map();
  for (const ps of alive) {
    const r = results.get(ps.playerId);
    if (!r) continue;
    const counted = (r.leaked || []).filter((l) => l && l.counted !== false);
    if (counted.length > 0) { leakers.push(ps); countedOf.set(ps, counted.length); }
    else if (r.perfect !== false) perfects.push(ps);
  }
  if (!leakers.length || !perfects.length) return null;
  const helperGroups = uniteHelperGroups(m, perfects, results, uniteFieldCount(m.gd, alive.length, leakers.length));
  const helpers = helperGroups.length === 1 ? helperGroups[0] : helperGroups.flat();
  const leaked = [];
  const notReentered = new Map();
  /** leaker → its re-entering leaks and how many of its counted leaks cannot re-enter */
  const own = new Map();
  for (const ps of leakers) {
    const r = results.get(ps.playerId);
    const mine = { leaked: [], skipped: 0 };
    own.set(ps, mine);
    for (const l of r.leaked || []) {
      if (!l || l.counted === false) continue;
      if (!m.gd.enemy(l.enemyKey)) { notReentered.set(ps.playerId, (notReentered.get(ps.playerId) || 0) + 1); mine.skipped++; continue; }
      // kill bounties keep paying in 联防, and only on the card's own enemy. A split or summoned child
      // never carries bountyId / bountyCoins (spawnChildren). A leak that still has the card's id but is
      // some other enemy — a copy that did not go through spawnChildren — does not collect the card either
      // (GitHub #67, #89-2; owner 2026-10-04: the main body only). A bounty set on the SpawnSpec by content
      // is copied into mods.bountyCoins by the match and has no card to match.
      const bountyId = l.mods && l.mods.bountyId;
      const b = bountyId ? ps.bounties.find((x) => x.id === bountyId) : null;
      const card = b && b.card;
      let bounty = card && card.payout !== 'perfect' && Number(card.coin) > 0 && l.enemyKey === card.enemyKey
        ? { coins: Math.trunc(card.coin), ownerPlayerId: ps.playerId } : null;
      const extra = !bountyId && l.mods ? Math.trunc(Number(l.mods.bountyCoins) || 0) : 0;
      if (!bounty && extra > 0) bounty = { coins: extra, ownerPlayerId: ps.playerId };
      const entry = { enemyKey: l.enemyKey, mods: l.mods ? { ...l.mods } : null, lpr: l.lpr ?? 1, sourcePlayerId: ps.playerId, tag: l.tag ?? null, bounty };
      leaked.push(entry);
      mine.leaked.push(entry);
    }
  }
  if (helperGroups.length === 1) return { helpers, leakers, leaked, notReentered, groups: [{ fieldId: uniteFieldId(0), helpers, leakers, leaked, notReentered }] };
  const slot = assignLeakers(helperGroups.length, leakers, (ps) => countedOf.get(ps) || 0);
  const groups = helperGroups.map((hs, i) => {
    const ls = leakers.filter((ps) => slot.get(ps) === i);
    const gl = [];
    const gn = new Map();
    for (const ps of ls) {
      const mine = own.get(ps);
      for (const e of mine.leaked) gl.push(e);
      if (mine.skipped > 0) gn.set(ps.playerId, mine.skipped);
    }
    return { fieldId: uniteFieldId(i), helpers: hs, leakers: ls, leaked: gl, notReentered: gn };
  });
  return { helpers, leakers, leaked, notReentered, groups };
}

/**
 * Leakers onto `fields` 联防 fields, balancing the counted leaks: the largest leaker first (equal leaks: lower seat
 * first) goes to the field with the fewest counted leaks so far (a tie: the lowest field index).
 * @returns {Map<any, number>} leaker → field index
 */
export function assignLeakers(fields, leakers, countOf) {
  const load = Array.from({ length: Math.max(1, fields) }, () => 0);
  const out = new Map();
  const order = leakers.slice().sort((a, b) => countOf(b) - countOf(a) || a.seat - b.seat);
  for (const ps of order) {
    let best = 0;
    for (let i = 1; i < load.length; i++) if (load[i] < load[best]) best = i;
    out.set(ps, best);
    load[best] += countOf(ps);
  }
  return out;
}

/**
 * Helper metrics of a perfect player: units on the field (board operators, downed included), whether a bond is
 * active, Σ layers of the active bonds as the 联防 battle will fight them (the persistent layers plus this round's
 * pending gains, capped like bondsView / settle — PRTS 以其阵地当前的状态; the official "层数最高" tie-break is marked 存疑),
 * operators still standing at the end of the player's own combat.
 */
export function helperStats(m, ps, results) {
  const units = ps.deployCount;
  let active = false;
  let layers = 0;
  const pending = ps.pendingLayerGains;
  for (const [id, b] of Object.entries(ps.bonds || {})) {
    if (!b || !b.active) continue;
    active = true;
    const stored = Number(ps.layers && ps.layers[id]) || Number(b.layers) || 0;
    const gain = pending && Number(pending[id]);
    const add = Number.isFinite(gain) && gain > 0 ? layerGainRoom(stored, Math.floor(gain)) : 0;
    layers += stored + add;
  }
  const r = results && typeof results.get === 'function' ? results.get(ps.playerId) : null;
  const opUids = new Set();
  for (const p of ps.board.values()) if (p && p.kind === 'chess') opUids.add(p.uid);
  let standing = units;
  if (r && Array.isArray(r.unitsEnd) && r.unitsEnd.length) {
    standing = 0;
    for (const u of r.unitsEnd) if (u && opUids.has(u.uid) && u.alive) standing++;
  }
  return { units, active, layers, standing };
}

/** The helper rankings of a set of perfect players: `select` (who helps) and `pair` (who meets the enemies first). */
function helperRankings(m, perfects, results) {
  const st = new Map(perfects.map((ps) => [ps.playerId, helperStats(m, ps, results)]));
  const S = (ps) => st.get(ps.playerId);
  return {
    select: (a, b) => S(b).units - S(a).units || (S(b).active - S(a).active) || S(b).standing - S(a).standing || a.seat - b.seat,
    pair: (a, b) => S(b).units - S(a).units || (S(b).active - S(a).active) || S(b).layers - S(a).layers || S(b).standing - S(a).standing || a.seat - b.seat,
  };
}

/**
 * The ≤ maxHelpers helpers, first = the one that meets the enemies first (right-hand field): selection by units >
 * active bond > standing units > seat, then the pair ordered by units > active bond > layers > standing > seat.
 */
export function helperOrder(m, perfects, results) {
  const rank = helperRankings(m, perfects, results);
  return perfects.slice().sort(rank.select).slice(0, m.gd.unite.maxHelpers).sort(rank.pair);
}

/**
 * The helpers of each 联防 field, in field order: one field (`fields` ≤ 1) → [helperOrder]; more (above 4 alive) → the
 * top maxHelpers × fields perfect players by the selection ranking, maxHelpers per field in that order, each field's
 * helpers in the pair order (the first meets the enemies first). Never an empty field: fewer helpers give fewer fields.
 * @returns {any[][]}
 */
export function uniteHelperGroups(m, perfects, results, fields = 1) {
  if (!(fields > 1)) {
    const hs = helperOrder(m, perfects, results);
    return hs.length ? [hs] : [];
  }
  const per = m.gd.unite.maxHelpers;
  const rank = helperRankings(m, perfects, results);
  const select = perfects.slice().sort(rank.select).slice(0, per * fields);
  const out = [];
  for (let i = 0; i < select.length; i += per) out.push(select.slice(i, i + per).sort(rank.pair));
  return out;
}

/** Battle options for one 联防 field — a plan group (or a one-field plan) — without data/logger, added by the match. */
export function uniteBattleOpts(m, plan, timeLimit) {
  const wave = buildUniteWave(m.gd, plan.leaked, plan.helpers.length, timeLimit);
  const players = plan.helpers.map((ps, i) => {
    const carry = new Map();
    const r = m.lastResults.get(ps.playerId);
    const summonUids = new Set();
    for (const p of ps.board.values()) if (p && p.kind === 'token') summonUids.add(p.uid);
    for (const u of (r && r.unitsEnd) || []) {
      if (!u || u.uid == null) continue;
      const sp = Number.isFinite(u.sp) ? Math.max(0, u.sp) : 0;
      // a summon: its SP only ("召唤物仅修改技力"); one off the field at the end enters fresh [ASSUMED]
      if (summonUids.has(u.uid)) { if (u.alive) carry.set(u.uid, { sp }); continue; }
      // knocked out at the end of its own combat: 强制退场 right after the deployment (see header)
      if (!u.alive) { carry.set(u.uid, { down: true }); continue; }
      // HP ratio and SP only: a skill still running at the end is not carried (unitsEnd `skillActive` stays unused —
      // community report #34, GitHub #82)
      carry.set(u.uid, { hpPct: Number.isFinite(u.hpPct) ? Math.max(0.01, Math.min(1, u.hpPct)) : 1, sp });
    }
    // 2 helpers: the first one meets the enemies first on the right-hand field (escaped_multi enters at col 18)
    const colOffset = plan.helpers.length > 1 && i === 0 ? 8 : 0;
    // the layers its own combat reached (bondsView, the round's pending gains; PRTS "以其阵地当前的状态") — see header
    const input = ps.battleInput({ side: 'L', colOffset, carry, reached: true });
    const ev = { input, kind: 'unite', round: m.round, spawns: wave.spawns };
    m.dispatch(ps, 'onBattleStart', ev);
    return ev.input && typeof ev.input === 'object' ? ev.input : input;
  });
  return { wave, players };
}

/**
 * LP loss per leaker after the unite battle: survivors by source (+ unspawned re-entries + not re-entered leaks),
 * capped per round. `plan`: a one-field plan or one field's group (with several fields, each field's result bills only
 * its own leakers — uniteBills).
 * @returns {Map<string, number>} playerId → survivors (uncapped)
 */
export function uniteSurvivors(plan, uniteResult) {
  const out = new Map();
  for (const [pid, n] of plan.notReentered) out.set(pid, (out.get(pid) || 0) + n);
  const perPlayer = (uniteResult && uniteResult.perPlayer) || {};
  for (const pp of Object.values(perPlayer)) {
    for (const l of (pp && pp.leaked) || []) {
      if (!l || l.counted === false || !l.sourcePlayerId) continue;
      out.set(l.sourcePlayerId, (out.get(l.sourcePlayerId) || 0) + 1);
    }
  }
  for (const u of (uniteResult && uniteResult.unspawned) || []) {
    if (!u || !u.sourcePlayerId) continue;
    out.set(u.sourcePlayerId, (out.get(u.sourcePlayerId) || 0) + 1);
  }
  return out;
}
