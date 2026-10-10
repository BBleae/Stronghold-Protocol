// ui/gameLogic/voice.js — the 选中干员 line's speaker and de-dup key (js/audio.js AudioManager.voice, DESIGN §21.30).
// Re-exported from ../gameLogic.js.

import { isCombatPhase } from './phases.js';


// ---- operator voice (js/audio.js AudioManager.voice, DESIGN §21.30) ------------------------------------------------

/**
 * The 选中干员 de-dup key of a battle unit: the field on screen and the unit's id there. A tap on a unit (screens/game.js
 * pieceClick) and the detail card it opens (detailSelectVoice → ui/detailPanel.js `voice`) ask for the line with the same
 * key, and audio.voice drops a repeat select of one key within a second (SELECT_SAME_MS) — so one tap says one line.
 * @param {string|null|undefined} fieldId @param {number|string} unitId
 */
export const selectVoiceKey = (fieldId, unitId) => `${fieldId ?? ''}:${unitId}`;

/**
 * The 选中干员 key of a card the player opened outside a battle unit (upstream 0.2.2's detailPanel selectVoiceKey): the
 * chess record, the piece / unit, and the card tap (`tap`, screens/game.js numbers every shop / reward card it opens) — two
 * shop / reward cards of one operator (the pool deals duplicates) carry the same chess id and no piece, so without it the
 * second card's tap said nothing. null: no chess record.
 * @param {any} resolved ui/detailPanel.js resolveDetail(target)
 */
export const cardVoiceKey = (resolved) => (resolved?.type === 'chess'
  ? `card:${resolved.chess?.chessId || ''}:${resolved.unitId ?? resolved.piece?.uid ?? ''}:${resolved.tap ?? ''}` : null);

/**
 * What the detail card says when it opens on an operator the player tapped (选中干员): { charId, key } or null. The speaker
 * is the record the card shows: a chess fielded as its 补位 stand-in speaks as the stand-in (`resolved.standIn`, the
 * operator whose model, name and battle lines the card and audio.js show — never the operator it replaces; a 预备干员 has
 * no line, audio.js hasVoice), a 自选 record is already its pick's (`resolved.chess.charId`), else the chess record's
 * charId (an elite `_b` record shares it).
 * - A battle unit's card (`target.kind === 'unit'` without `area`: an own operator, a teammate's, a 联防 / spectated
 *   field's): only in a battle phase, keyed selectVoiceKey(fieldId, unitId) like the tap on it. It speaks because it was
 *   opened (or retargeted) in a battle, never because the phase changed under it: a target opened outside a battle phase
 *   (`target.inBattle` not true — screens/game.js pieceClick sets it from the phase of the tap) stays silent, so a unit
 *   card left open on a scouted prep board says nothing when the battle starts (DESIGN §21.30).
 * - Anything else that resolved to a chess record — a piece on the board or in the hand, a scouted board's piece (its
 *   unit has `area`), a shop / reward card, a bond member: in every phase, keyed cardVoiceKey (upstream 0.2.2, the
 *   owner's request of 2026-10-08 「添加一下干员点击上去的语气一样的语音」, which lifted 2026-10-03's 「整备阶段不需要干员语音」
 *   for this line only).
 * @param {{ phase?: string|null, fieldId?: string|null, target?: any, resolved?: any }} o
 *   target: the screen's detail target ({ kind: 'unit', unit, inBattle, … }); resolved: ui/detailPanel.js resolveDetail(target)
 * @returns {{ charId: string, key: string }|null}
 */
export function detailSelectVoice({ phase, fieldId, target, resolved } = {}) {
  if (!target || resolved?.type !== 'chess') return null;
  const stand = resolved.standIn?.charId;
  const charId = typeof stand === 'string' && stand ? stand : resolved.chess?.charId;
  if (typeof charId !== 'string' || !charId) return null;
  if (target.kind === 'unit' && target.unit?.area == null) {
    if (!isCombatPhase(phase) || target.inBattle !== true || resolved.unitId == null) return null;
    return { charId, key: selectVoiceKey(fieldId, resolved.unitId) };
  }
  return { charId, key: cardVoiceKey(resolved) };
}
