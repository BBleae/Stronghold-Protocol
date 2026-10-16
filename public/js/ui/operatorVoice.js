// Local listening preference, shared by roster and DIY details; deliberately absent from room.loadout. FORK: the choices
// are the dubs this site's voice tree has for this operator (js/audio.js VOICE_LANGS — 中文 / 日文 / 英文 / 韩文, as the
// global 语音语言 setting offers them — and its own-language dub, upstream 0.3.0), plus 跟随全局; a saved choice the site
// lacks stays in the list, marked unavailable. 试听 plays one line (audio.previewVoice).
import { html } from './components.js';
import { useSettings, updateSettings } from './settings.js';
import { audio, voiceLangsIn, VOICE_LANGS } from '../audio.js';
import { data } from '../data.js';
import { t, N_ } from '../../../shared/i18n.js';
import { VOICE_PICKS } from '../voicePrefs.js';

/** Official voiceLangType of a CUSTOM dub (audio.voiceNativeLangType) → the name the dropdown shows. */
const NATIVE_NAMES = {
  ITA: N_('意大利语'),
  GER: N_('德文'),
  RUS: N_('俄文'),
  FRE: N_('法语'),
  SPA: N_('西班牙语'),
  CN_TOPOLECT: N_('中文-方言'),
};

/** This site's manifest has at least one line of `charId` in `lang` (audio.voice.<lang>.<charId>). */
function hasTree(audioManifest, charId, lang) {
  const slots = audioManifest?.voice?.[lang]?.[charId];
  return !!slots && typeof slots === 'object' && !Array.isArray(slots) && Object.keys(slots).length > 0;
}

function nativeLabel(audioManifest, charId) {
  const type = audioManifest?.voiceNativeLangType?.[charId];
  return NATIVE_NAMES[type] ? t(NATIVE_NAMES[type]) : t('本土语言');
}

/**
 * Dropdown rows for one operator: 跟随全局, the dubs this site has for it (VOICE_LANGS order), its own-language dub, and
 * a saved choice the site does not have, marked unavailable (playback falls back: audio.js _voiceUrl).
 * @param {any} audioManifest the manifest's `audio` (null when assets have not loaded)
 * @param {string} charId
 * @param {string} [saved] the stored override (`''` / absent = follow the global dub)
 * @returns {{ value: string, label: string, unavailable: boolean }[]}
 */
export function operatorVoiceOptions(audioManifest, charId, saved) {
  const options = [{ value: '', label: t('跟随全局'), unavailable: false }];
  for (const [lang, name] of VOICE_LANGS) {
    if (hasTree(audioManifest, charId, lang)) options.push({ value: lang, label: t(name), unavailable: false });
  }
  if (hasTree(audioManifest, charId, 'native')) {
    options.push({ value: 'native', label: nativeLabel(audioManifest, charId), unavailable: false });
  }
  if (saved && VOICE_PICKS.includes(saved) && !options.some((o) => o.value === saved)) {
    const name = saved === 'native' ? t('本土语言') : t(VOICE_LANGS.find(([k]) => k === saved)?.[1] || saved);
    options.push({ value: saved, label: `${name}${t('（此服务器没有）')}`, unavailable: true });
  }
  return options;
}

export function OperatorVoice({ charId }) {
  const settings = useSettings();
  const langs = voiceLangsIn(data.get('assets'));
  if (!charId || !langs.length) return null;
  const value = settings.voiceOverrides[charId] || '';
  const options = operatorVoiceOptions(data.get('assets')?.audio, charId, value);
  const change = (lang) => {
    const voiceOverrides = { ...settings.voiceOverrides };
    if (lang) voiceOverrides[charId] = lang;
    else delete voiceOverrides[charId];
    updateSettings({ voiceOverrides });
  };
  const preview = () => {
    const chosen = options.find((o) => o.value === value);
    if (chosen && chosen.value && !chosen.unavailable) audio.previewVoice(charId, chosen.value);
    else audio.previewVoice(charId);
  };
  return html`<label class="lo-voice" data-voice-char=${charId}>
    <span>${t('此干员语音')}</span>
    <span class="lo-select"><select aria-label=${t('此干员语音')} value=${value} onChange=${(e) => change(e.currentTarget.value)}>
      ${options.map((o) => html`<option key=${o.value} value=${o.value}>${o.label}</option>`)}
    </select></span>
    <button type="button" class="lo-voice__preview" onClick=${preview}>${t('试听')}</button>
    <small>${t('仅保存在此浏览器，此干员缺少的语音会使用全局语音语言。')}</small>
  </label>`;
}
