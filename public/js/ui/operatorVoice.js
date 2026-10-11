// Local listening preference, shared by roster and DIY details; deliberately absent from room.loadout. FORK: the choices
// are the dubs this site's voice tree has (js/audio.js VOICE_LANGS / voiceLangsIn — 中文 / 日文 / 英文 / 韩文, as the global
// 语音语言 setting offers them), not upstream 0.2.3's fixed 中文 / 日本語 pair.
import { html } from './components.js';
import { useSettings, updateSettings } from './settings.js';
import { voiceLangsIn } from '../audio.js';
import { data } from '../data.js';
import { t } from '../../../shared/i18n.js';

export function OperatorVoice({ charId }) {
  const settings = useSettings();
  const langs = voiceLangsIn(data.get('assets'));
  if (!charId || !langs.length) return null;
  const value = settings.voiceOverrides[charId] || '';
  const change = (lang) => {
    const voiceOverrides = { ...settings.voiceOverrides };
    if (lang) voiceOverrides[charId] = lang;
    else delete voiceOverrides[charId];
    updateSettings({ voiceOverrides });
  };
  return html`<label class="lo-voice" data-voice-char=${charId}>
    <span>${t('此干员语音')}</span>
    <span class="lo-select"><select aria-label=${t('此干员语音')} value=${value} onChange=${(e) => change(e.currentTarget.value)}>
      <option value="">${t('跟随全局')}</option>
      ${langs.map(([id, name]) => html`<option key=${id} value=${id}>${t(name)}</option>`)}
    </select></span>
    <small>${t('仅保存在此浏览器，此干员缺少的语音会使用全局语音语言。')}</small>
  </label>`;
}
