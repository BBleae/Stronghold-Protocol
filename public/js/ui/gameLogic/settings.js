// ui/gameLogic/settings.js — settings defaults and sanitising. Re-exported from ../gameLogic.js.

import { clamp, isObj } from './shared.js';
import { DEFAULT_HOTKEYS, sanitizeHotkeys } from './shortcuts.js';


// ---- settings ------------------------------------------------------------------------------------------------------

/**
 * voice: the operator voice volume and voiceLang: the language the operators speak (js/audio.js VOICE_LANGS) or 'off' —
 * together the one 干员语音 setting. keys: the in-match shortcuts' key map (ui/gameLogic/shortcuts.js; settings → 快捷键).
 */
export const DEFAULT_SETTINGS = Object.freeze({ bgm: 0.6, sfx: 0.8, voice: 0.8, voiceLang: 'cn', muted: false, damageNumbers: true, quality: 'high', keys: DEFAULT_HOTKEYS });
const QUALITIES = ['high', 'medium', 'low'];
/**
 * The quality of a player who never chose one: 中 on a phone (phone audit P6 — 高 renders two full-screen WebGL canvases
 * at resolution 2, hot and slow on a phone), 高 elsewhere. Only a default: a saved quality always wins (sanitizeSettings).
 * @param {boolean} phone ui/device.js isPhone()
 */
export const defaultQuality = (phone) => (phone ? 'medium' : DEFAULT_SETTINGS.quality);
/** Operator voice languages (js/audio.js VOICE_LANGS) + 'off'. */
const VOICE_LANG_KEYS = ['cn', 'jp', 'en', 'kr', 'off'];

/**
 * Sanitize persisted settings.
 * @param {any} raw
 * @param {'high'|'medium'|'low'} [fallbackQuality] the quality when none (or an unknown one) was saved: defaultQuality(phone)
 * @returns {{ bgm: number, sfx: number, voice: number, voiceLang: 'cn'|'jp'|'en'|'kr'|'off', muted: boolean, damageNumbers: boolean,
 *   quality: 'high'|'medium'|'low', keys: Record<'refresh'|'freeze'|'levelUp'|'retreat'|'sell'|'ready', string> }}
 */
export function sanitizeSettings(raw, fallbackQuality = DEFAULT_SETTINGS.quality) {
  const r = isObj(raw) ? raw : {};
  const vol = (v, d) => (Number.isFinite(v) ? clamp(Math.round(v * 100) / 100, 0, 1) : d);
  return {
    bgm: vol(r.bgm, DEFAULT_SETTINGS.bgm),
    sfx: vol(r.sfx, DEFAULT_SETTINGS.sfx),
    voice: vol(r.voice, DEFAULT_SETTINGS.voice),
    voiceLang: VOICE_LANG_KEYS.includes(r.voiceLang) ? r.voiceLang : DEFAULT_SETTINGS.voiceLang,
    muted: typeof r.muted === 'boolean' ? r.muted : DEFAULT_SETTINGS.muted,
    damageNumbers: typeof r.damageNumbers === 'boolean' ? r.damageNumbers : DEFAULT_SETTINGS.damageNumbers,
    quality: QUALITIES.includes(r.quality) ? r.quality : fallbackQuality,
    keys: sanitizeHotkeys(r.keys),
  };
}
