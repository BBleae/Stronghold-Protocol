// Account-synced preferences. Audio, graphics and resource settings remain device-local.
// Reused by Workers; account preferences do not version the battle/replay engine.
import { DIFFICULTIES, EMOTE_THEMES } from '../../shared/constants.js';
import { isLoadoutEntries } from '../../shared/protocol.js';
import { AccountError } from '../../shared/account-protocol.js';

export const PREFERENCE_KEYS = Object.freeze(['loadout', 'lobby.mode', 'lobby.difficulty', 'recentRooms', 'emoteTheme']);
const plain = value => !!value && Object.getPrototypeOf(value) === Object.prototype;
export function validPreference(key, value) {
  switch (key) {
    case 'loadout': return plain(value) && value.v === 1 && Object.keys(value).every(k => k === 'v' || k === 'entries')
      && isLoadoutEntries(value.entries) && !Object.keys(value.entries).some(k => ['__proto__','constructor','prototype'].includes(k));
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
