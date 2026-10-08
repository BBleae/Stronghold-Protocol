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
 * What the detail card says when it opens on an operator of the battle on screen (选中干员): { charId, key } — the
 * operator on the field and selectVoiceKey(fieldId, unitId) — or null. The speaker is the record the card shows: a chess
 * fielded as its 补位 stand-in speaks as the stand-in (`resolved.standIn`, the operator whose model, name and battle
 * lines the card and audio.js show — never the operator it replaces; a 预备干员 has no line, audio.js canSpeak), a 自选
 * record is already its pick's (`resolved.chess.charId`), else the chess record's charId (an elite `_b` record shares it).
 * Only in a battle phase (never in the 整备期, nor in 结算), only for a battle unit's card (`target.kind === 'unit'`: an
 * own operator, a teammate's, a 联防 / spectated field's) that resolved to a chess record; a bench / shop / bond-member
 * card never speaks.
 * The card speaks because it was opened (or retargeted) in a battle, never because the phase changed under it: a target
 * opened outside a battle phase (`target.inBattle` not true — screens/game.js pieceClick sets it from the phase of the
 * tap) stays silent, so a unit card left open on a scouted prep board says nothing when the battle starts; and a prep
 * scouting board's piece (`target.unit.area` set — 'board' / 'hand' / 'temp', match/views.js prepFieldMeta: a teammate's or a
 * spectated board in the 整备期, its bench included) is no battle unit in any phase.
 * @param {{ phase?: string|null, fieldId?: string|null, target?: any, resolved?: any }} o
 *   target: the screen's detail target ({ kind: 'unit', unit, inBattle, … }); resolved: ui/detailPanel.js resolveDetail(target)
 * @returns {{ charId: string, key: string }|null}
 */
export function detailSelectVoice({ phase, fieldId, target, resolved } = {}) {
  if (!isCombatPhase(phase) || target?.kind !== 'unit' || target.inBattle !== true || target.unit?.area != null) return null;
  if (resolved?.type !== 'chess' || resolved.unitId == null) return null;
  const stand = resolved.standIn?.charId;
  const charId = typeof stand === 'string' && stand ? stand : resolved.chess?.charId;
  return typeof charId === 'string' && charId ? { charId, key: selectVoiceKey(fieldId, resolved.unitId) } : null;
}
