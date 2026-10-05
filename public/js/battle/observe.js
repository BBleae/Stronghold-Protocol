// Observing rules and labels of client-side combat (research 09 §3.1 / §6.3, DESIGN §14 "Spectating") — pure helpers
// for the game screen, the team panel and the combat HUD (mirror of server/match/Match.js _watchClient):
//   * prep (休整期): tap a teammate → 前往查看 → their board (read-only);
//   * own normal battle running: no observing ("当前无法查看");
//   * own battle over: "⌛ 作战结束，等待队友完成作战" + the teammates' progress; tap a teammate → 前往查看 → a local
//     replica of their battle; 返回战场 goes back;
//   * 联防 / 最终攻势: the ‹ › pill switches the camera LEFT half / 全景 / RIGHT half of the own field; the other pair's
//     boss field is never shown to a fighting player;
//   * eliminated: anything.
// 联防 with more than 4 alive players (a remake extension, server/match/unite.js): several 联防 fields 'u', 'u2', … (2
// helpers each, each holding its own leakers' enemies; m.public.unite.fields). A helper plays its own field and cannot
// look at another one while it runs (Match._watchClient 'own battle running'); a leaker is shown the field holding its
// enemies — its row leads there, and 返回战场 goes back to it; anyone else starts on the first field and may switch
// (uniteSwitchFields). With one 联防 field (1–4 alive) nothing of this applies: everything works as before.

import { PHASE } from '../../../shared/constants.js';

const isObj = (v) => !!v && typeof v === 'object';
const COMBAT = new Set([PHASE.COMBAT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]);

/** The server runs client-side combat (m.public.combatMode). */
export const isClientCombat = (pub) => !!pub && pub.combatMode === 'client';

const players = (pub) => (Array.isArray(pub?.players) ? pub.players.filter(isObj) : []);
const fields = (pub) => (Array.isArray(pub?.fields) ? pub.fields.filter(isObj) : []);
const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);

/** The field listing a player, or null. */
export function fieldOf(pub, playerId) {
  return fields(pub).find((f) => Array.isArray(f.players) && f.players.includes(playerId)) || null;
}

// ---- 联防 fields ------------------------------------------------------------------------------------------------

/** Whether the view has several 联防 fields (m.public.unite.fields — sent only then: more than 4 alive). */
export const multiUnite = (pub) => isObj(pub?.unite) && Array.isArray(pub.unite.fields) && pub.unite.fields.filter(isObj).length > 1;

/**
 * The 联防 fields of the view in field order: [{ fieldId, helpers, leakers }] — m.public.unite.fields when there are
 * several, else the one field (the 'unite' entry of m.public.fields, 'u' when none is listed) with m.public.unite's
 * helpers and leakers. [] without m.public.unite (outside 联防).
 * @param {any} pub @returns {Array<{ fieldId: string, helpers: string[], leakers: string[] }>}
 */
export function uniteFields(pub) {
  const u = isObj(pub?.unite) ? pub.unite : null;
  if (!u) return [];
  if (multiUnite(pub)) {
    return u.fields.filter((f) => isObj(f) && typeof f.fieldId === 'string' && f.fieldId)
      .map((f) => ({ fieldId: f.fieldId, helpers: ids(f.helpers), leakers: ids(f.leakers) }));
  }
  const listed = fields(pub).find((f) => f.kind === 'unite' && typeof f.fieldId === 'string' && f.fieldId);
  return [{ fieldId: listed ? listed.fieldId : 'u', helpers: ids(u.helpers), leakers: ids(u.leakers) }];
}

/** The 联防 field holding a player: a helper's own field, the field with a leaker's enemies; null for anyone else. */
export function uniteFieldOf(pub, playerId) {
  const f = uniteFields(pub).find((x) => x.helpers.includes(playerId) || x.leakers.includes(playerId));
  return f ? f.fieldId : null;
}

/**
 * The 联防 field a viewer is shown by default (server/match/Match.js _uniteHomeField): a helper's own field, the field
 * holding a leaker's enemies, else the first one. null outside 联防.
 */
export function uniteHomeField(pub, playerId) {
  return uniteFieldOf(pub, playerId) || uniteFields(pub)[0]?.fieldId || null;
}

/**
 * The number of a 联防 field among several (1 for 'u', 2 for 'u2' … in field order) — 0 with a single 联防 field (its
 * labels stay as they were) or for a field that is not one of them.
 */
export function uniteFieldNo(pub, fieldId) {
  if (!multiUnite(pub)) return 0;
  return uniteFields(pub).findIndex((f) => f.fieldId === fieldId) + 1;
}

/**
 * The local 联防 replica's per-leaker counts (battle runner state().uniteLeft of the drawn battle, field `fieldId`) as
 * far as they speak for `playerId`: with one 联防 field the whole map (absent = none left — as before); with several,
 * only for a leaker whose enemies fight on that field — a leaker of another field is not in that battle at all (null:
 * its m.public players[].uniteLeft / pendingLp then).
 * @param {any} pub @param {Record<string, number>|null} local @param {string|null} fieldId @param {string} playerId
 * @returns {Record<string, number>|null}
 */
export function uniteLocalFor(pub, local, fieldId, playerId) {
  if (!isObj(local)) return null;
  if (!multiUnite(pub)) return local;
  return typeof fieldId === 'string' && fieldId && uniteFieldOf(pub, playerId) === fieldId ? local : null;
}

/**
 * The 联防 fields a viewer may switch between (‹ 联防阵地 N ›, g.watch), in field order — only with several 联防 fields
 * during 联防: a leaker, a player without a part in it, an eliminated player or a spectator; a helper once its own field
 * ended (while it runs the server refuses: 'own battle running'). [] otherwise (one field: nothing to switch).
 * @param {any} pub @param {string} myId @param {{ alive?: boolean }} [o]
 * @returns {string[]}
 */
export function uniteSwitchFields(pub, myId, { alive = true } = {}) {
  if (pub?.phase !== PHASE.UNITE || !multiUnite(pub)) return [];
  const listed = new Set(fields(pub).filter((f) => f.kind === 'unite').map((f) => f.fieldId));
  const list = uniteFields(pub).map((f) => f.fieldId).filter((fid) => listed.has(fid));
  if (list.length < 2) return [];
  const own = fieldOf(pub, myId);
  if (alive && own && own.kind === 'unite' && own.live !== false) return [];
  return list;
}

/**
 * The field 返回战场 (or the own team row) asks the server for: the viewer's home field in battle (gameLogic homeFieldId),
 * its own board otherwise — and, with several 联防 fields, a viewer without a field of its own (a leaker …) goes back to
 * the 联防 field it is shown by default (uniteHomeField). null when there is nothing to ask for: client-side combat in
 * battle with no such field (a 联防 leaker with one field, an eliminated player — the screen keeps the field it shows),
 * or the field already watched.
 * @param {any} pub @param {string} myId @param {string|null} home gameLogic homeFieldId @param {string|null} [watching]
 * @returns {string|null}
 */
export function backTarget(pub, myId, home, watching = null) {
  const combat = COMBAT.has(pub?.phase);
  let target = combat ? home : `n:${myId}`;
  const listed = (fid) => fields(pub).some((f) => f.fieldId === fid);
  if (combat && pub?.phase === PHASE.UNITE && multiUnite(pub) && !listed(target)) {
    const u = uniteHomeField(pub, myId);
    if (u && listed(u)) {
      target = u;
      if (target === watching) return null;
    }
  }
  const exists = !isClientCombat(pub) || !combat || listed(target);
  return exists && typeof target === 'string' && target ? target : null;
}

/** Display name of a player id ('队友' when unknown). */
export function nameOf(pub, playerId) {
  return players(pub).find((p) => p.playerId === playerId)?.name || '队友';
}

/**
 * What tapping a team row does: `{ back: true }` (own row while observing), `{ fieldId }` to observe, or `{ reason }`.
 * @param {any} p m.public player row
 * @param {any} pub
 * @param {string} myId
 * @param {{ observing?: boolean, ownDone?: boolean, ownHeld?: boolean }} [o] ownDone: the own battle's picture on screen
 *   already ended (the 作战结束 pill shows; its result is on the way to the server or already in). ownHeld: the own battle
 *   is still on screen — the server may already list the field as over (the sim runs 0.5 s ahead of the picture), but the
 *   last frames are still to be drawn: no looking away before the pill
 */
export function observeTarget(p, pub, myId, { observing = false, ownDone = false, ownHeld = false } = {}) {
  if (!isObj(p)) return { reason: '无效的目标' };
  if (p.playerId === myId) return observing ? { back: true } : { reason: null };
  if (p.alive === false || p.status === 'left') return { reason: '该队友已被淘汰，无法查看' };
  const phase = pub?.phase;
  const me = players(pub).find((x) => x.playerId === myId) || null;
  const meAlive = me ? me.alive !== false : true;
  if (!COMBAT.has(phase)) return { fieldId: `n:${p.playerId}` };
  let target = fieldOf(pub, p.playerId);
  // several 联防 fields: a leaker's row leads to the field holding its enemies (one field: it has no field, as before)
  const leakerField = !target && phase === PHASE.UNITE && multiUnite(pub) ? uniteFieldOf(pub, p.playerId) : null;
  if (leakerField) target = fields(pub).find((f) => f.fieldId === leakerField && f.kind === 'unite') || null;
  if (!target) return { reason: '该队友当前没有战场' };
  const own = fieldOf(pub, myId);
  if (!meAlive || !own) return { fieldId: target.fieldId };
  if (own.fieldId === target.fieldId) return { reason: leakerField ? '该队友漏过的敌人就在你的联防阵地上' : '队友与你在同一战场，使用 ‹ › 切换视角' };
  if (target.kind === 'boss' || target.kind === 'hidden') return { reason: '无法查看另一组队友的战场' };
  if (own.kind === 'normal' && (ownHeld || (own.live !== false && !ownDone))) return { reason: '作战中无法查看队友，作战结束后可前往查看' };
  // several 联防 fields: a helper stays on its own field while it runs (Match._watchClient 'own battle running')
  if (own.kind === 'unite' && target.kind === 'unite' && own.live !== false) return { reason: '联防作战中无法查看其他联防阵地，作战结束后可前往查看' };
  return { fieldId: target.fieldId };
}

/**
 * A screen reloaded (or a socket reconnected) while it watched a teammate's battle after the own one: the server
 * resends the watched field (Match._resendBattle, b.start `watch: true`), but a fresh screen starts at home — so the
 * observing pill, 返回战场 and the own row would be missing. Decided once per battle, at the first sight of its
 * battleId (`seen` = the battleId already decided): adopt `fieldId` as the watched field when it is a teammate's normal
 * battle in 各自行动 shown to a living player who watches nothing. Never for a battle first seen while watching (a
 * 前往查看 under way — and its 返回战场 must not bring it back while the own b.start is on its way), the own field, a
 * 联防 leaker's field or an eliminated player's auto-observed one (those keep their own rules). A loading battle (its
 * state carries no `watch` yet) is decided once it runs, unless the screen already watches (then it is marked seen).
 * Several 联防 fields (more than 4 alive): likewise a living viewer's 联防 field other than the one it is shown by default
 * (uniteHomeField: a helper's own field — it watches another only once its own ended —, the one holding a leaker's
 * enemies, else the first) is adopted, so 返回战场 brings the default one back. One 联防 field: never (as before).
 * @param {any} b battleRunner.state() @param {{ pub?: any, myId?: string, alive?: boolean, watching?: string|null,
 *   seen?: string|null }} [o]
 * @returns {{ seen: string|null, fieldId: string|null }} seen: the new value to remember
 */
export function resumedWatch(b, { pub = null, myId = '', alive = true, watching = null, seen = null } = {}) {
  const keep = { seen, fieldId: null };
  if (!isObj(pub) || !isObj(b) || typeof b.battleId !== 'string' || !b.battleId || b.battleId === seen) return keep;
  if (b.loading && !watching) return keep;
  const done = { seen: b.battleId, fieldId: null };
  if (!b.loading && !watching && alive && isClientCombat(pub) && pub.phase === PHASE.UNITE && multiUnite(pub)) {
    if (!b.watch || b.kind !== 'unite' || typeof b.fieldId !== 'string' || !b.fieldId) return done;
    const f = fields(pub).find((x) => x.fieldId === b.fieldId);
    if (!f || f.kind !== 'unite' || b.fieldId === uniteHomeField(pub, myId)) return done;
    return { seen: b.battleId, fieldId: b.fieldId };
  }
  if (b.loading || watching || !alive || !isClientCombat(pub) || pub.phase !== PHASE.COMBAT) return done;
  if (!b.watch || b.kind !== 'normal' || typeof b.fieldId !== 'string' || !b.fieldId) return done;
  const f = fields(pub).find((x) => x.fieldId === b.fieldId);
  if (!f || f.kind !== 'normal' || !Array.isArray(f.players) || f.players.includes(myId)) return done;
  return { seen: b.battleId, fieldId: b.fieldId };
}

/** Teammates' progress for the waiting pill: [{ playerId, name, killed, total, done, isBot }]. */
export function teammateProgress(pub, myId) {
  const out = [];
  for (const f of fields(pub)) {
    if (f.kind !== 'normal' || !Array.isArray(f.players)) continue;
    const pid = f.players[0];
    if (pid === myId) continue;
    const p = players(pub).find((x) => x.playerId === pid);
    const pr = isObj(f.progress) ? f.progress : null;
    out.push({
      playerId: pid, name: p?.name || '队友', isBot: !!p?.isBot,
      killed: Number.isFinite(pr?.killed) ? pr.killed : null, total: Number.isFinite(pr?.total) ? pr.total : null,
      done: f.live === false || !!pr?.done,
    });
  }
  return out;
}

/** Side of each player of a local field meta (`sides` from the runner, else seat order). */
export function sidesOf(field) {
  if (isObj(field?.sides)) return field.sides;
  const ps = Array.isArray(field?.players) ? field.players : [];
  return Object.fromEntries(ps.map((pid, i) => [pid, i === 1 ? 'R' : 'L']));
}

/**
 * The ‹ › camera layers of a 联防 / boss field: LEFT half, 全景, RIGHT half with captions "你自己" / "👁 name" /
 * "全景" / "无人在家". Empty for normal fields and single-player boss fields.
 */
export function cameraLayers(field, pub, myId) {
  if (!isObj(field) || (field.kind !== 'unite' && field.kind !== 'boss' && field.kind !== 'hidden')) return [];
  const sides = sidesOf(field);
  const at = (side) => Object.keys(sides).find((pid) => sides[pid] === side) || null;
  const label = (pid) => (!pid ? '无人在家' : pid === myId ? '你自己' : nameOf(pub, pid));
  const left = at('L');
  const right = at('R');
  if ((field.kind === 'boss' || field.kind === 'hidden') && (!left || !right)) return [];
  return [
    { key: 'L', label: label(left), self: left === myId, watch: !!left && left !== myId },
    { key: 'ALL', label: '全景', self: false, watch: false },
    { key: 'R', label: label(right), self: right === myId, watch: !!right && right !== myId },
  ];
}

/** Camera options of a layer for view.setCamera(kind, …). */
export function layerCamera(field, layer, mySide = 'L') {
  const rect = field?.rect;
  if (layer === 'L' || layer === 'R') return { rect, side: layer, half: true };
  return { rect, side: mySide };
}
