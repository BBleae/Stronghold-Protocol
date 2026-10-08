// Account-synced preferences. Audio, graphics and resource settings remain device-local.
// Reused by Workers; account preferences do not version the battle/replay engine.
import { DIFFICULTIES, EMOTE_THEMES } from '../../shared/constants.js';
import { isLoadoutEntries, isDiyPicks, isNotOwnedList } from '../../shared/protocol.js';
import { AccountError } from '../../shared/account-protocol.js';

// The out-of-match setup of the 干员调配 overlay follows the account (the stored forms of ui/loadoutModel.js,
// ui/diyModel.js and ui/ownershipModel.js, `{ v: 1, … }`): `loadout` = the skill / module choices (干员调配), `diy` = the
// 自选编队 picks (0.2.0 DIY), `ownership` = the operators marked 未持有 (干员持有, 0.2.0 补位).
export const PREFERENCE_KEYS = Object.freeze(['loadout', 'diy', 'ownership', 'lobby.mode', 'lobby.difficulty', 'recentRooms', 'emoteTheme']);
const plain = value => !!value && Object.getPrototypeOf(value) === Object.prototype;
const UNSAFE = ['__proto__', 'constructor', 'prototype'];
const safeKeys = value => !Object.keys(value).some(k => UNSAFE.includes(k));
/** `{ v: 1, <field> }` and nothing else. */
const envelope = (value, field) => plain(value) && value.v === 1 && Object.keys(value).every(k => k === 'v' || k === field);
/**
 * A stored 自选编队 (`{ [slotBaseId]: { charId, skillIndex?, uniEquipId? } }`, ui/diyModel.js toStoredDiy): the shape
 * room.diy accepts (shared/protocol.js isDiyPicks: at most DIY_LIMITS.slots slots), no other key on a pick, no unsafe
 * slot id. Structure only — whether a pick is legal for the current data and kits is the room's check (shared/protocol.js
 * checkDiyPicks, lenient) when the roster is sent.
 */
export function validDiySelection(picks) {
  return isDiyPicks(picks) && safeKeys(picks) && Object.values(picks).every(p => p === null
    || Object.keys(p).every(k => k === 'charId' || k === 'skillIndex' || k === 'uniEquipId'));
}
/**
 * A stored 干员持有 list (ui/ownershipModel.js toStoredOwnership: the base chess ids marked 未持有): the shape
 * room.ownership accepts (shared/protocol.js isNotOwnedList: at most OWNERSHIP_LIMITS.notOwned ids), each id once.
 * Structure only — the room keeps the droppable chess (checkNotOwned, lenient).
 */
export function validNotOwned(list) {
  return isNotOwnedList(list) && new Set(list).size === list.length && !list.some(id => UNSAFE.includes(id));
}
export function validPreference(key, value) {
  switch (key) {
    case 'loadout': return envelope(value, 'entries') && isLoadoutEntries(value.entries) && safeKeys(value.entries);
    case 'diy': return envelope(value, 'picks') && validDiySelection(value.picks);
    case 'ownership': return envelope(value, 'notOwned') && validNotOwned(value.notOwned);
    case 'lobby.mode': return value === 'solo' || value === 'coop';
    case 'lobby.difficulty': return DIFFICULTIES.includes(value);
    case 'recentRooms': return Array.isArray(value) && value.length <= 4 && new Set(value).size === value.length
      && value.every(code => typeof code === 'string' && /^[A-Z0-9]{4}$/.test(code));
    case 'emoteTheme': return EMOTE_THEMES.some(theme => theme.themeId === value);
    default: return false;
  }
}
export function validatePreferencePatch(value) {
  if (!plain(value) || !Object.entries(value).every(([key, entry]) => validPreference(key, entry))) {
    throw new AccountError('INVALID_PREFERENCES');
  }
  return value;
}
export function cleanPreferences(value) {
  return Object.fromEntries(Object.entries(plain(value) ? value : {}).filter(([key, entry]) => validPreference(key, entry)));
}
