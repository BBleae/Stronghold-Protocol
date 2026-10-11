// Browser-local dub preferences (settings 此干员语音, ui/operatorVoice.js; upstream 0.2.3's per-operator voice choice on the
// fork's voice engine, js/audio.js _voiceUrl). Every variant of an operator shares its charId; absent entries follow the
// global 语音语言. VOICE_LANGS: the dubs the fork's voice tree may have (js/audio.js VOICE_LANGS, tools/assets/voice.mjs).
export const VOICE_LANGS = Object.freeze(['cn', 'jp', 'en', 'kr']);
export function sanitizeVoiceOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, lang] of Object.entries(raw).slice(0, 512)) {
    if (/^char_[0-9]+_[a-z0-9]+$/.test(id) && id.length <= 80 && VOICE_LANGS.includes(lang)) out[id] = lang;
  }
  return out;
}
