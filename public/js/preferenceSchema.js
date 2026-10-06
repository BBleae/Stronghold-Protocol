// Account-synced preferences. Audio, graphics and resource settings remain device-local.
// Reused by Workers; account preferences do not version the battle/replay engine.
import { DIFFICULTIES, EMOTE_THEMES } from '../../shared/constants.js';
import { isLoadoutEntries, isWaiguanPicks } from '../../shared/protocol.js';
import { AccountError } from '../../shared/account-protocol.js';
import { WAIGUAN_SLOTS } from '../../shared/waiguan.js';

// `waiguan` = the 外援 / 甄选 picks (DESIGN §27, ui/loadoutModel.js PICKS_PREF): they follow the account like the loadout.
export const PREFERENCE_KEYS = Object.freeze(['loadout', 'waiguan', 'lobby.mode', 'lobby.difficulty', 'recentRooms', 'emoteTheme']);
const plain = value => !!value && Object.getPrototypeOf(value) === Object.prototype;
const UNSAFE = ['__proto__', 'constructor', 'prototype'];
const SLOT_TIER = new Map(WAIGUAN_SLOTS.map(s => [s.slot, s.tier]));
/**
 * A stored 甄选 selection (`{ [slotId]: charId }`, at most the four slots): known slot ids, operator ids shaped like
 * `char_…`, never one operator in both slots of a tier. Structure only — whether an id is a candidate of the current
 * data/waiguan.json is the room's check (shared/protocol.js checkWaiguanPicks) when the selection is sent.
 */
export function validWaiguanSelection(picks) {
  if (!isWaiguanPicks(picks)) return false;
  const seen = new Set();
  for (const [slot, charId] of Object.entries(picks)) {
    if (!SLOT_TIER.has(slot) || typeof charId !== 'string' || !/^char_[A-Za-z0-9_]+$/.test(charId)) return false;
    const key = `${SLOT_TIER.get(slot)}:${charId}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}
export function validPreference(key, value) {
  switch (key) {
    case 'loadout': return plain(value) && value.v === 1 && Object.keys(value).every(k => k === 'v' || k === 'entries')
      && isLoadoutEntries(value.entries) && !Object.keys(value.entries).some(k => ['__proto__','constructor','prototype'].includes(k));
    case 'waiguan': return plain(value) && value.v === 1 && Object.keys(value).every(k => k === 'v' || k === 'picks')
      && validWaiguanSelection(value.picks) && !Object.keys(value.picks).some(k => UNSAFE.includes(k));
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
