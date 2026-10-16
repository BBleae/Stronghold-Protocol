// shared/plugins/forkVoice.js — FORK (docs/design/fork.md §F10): the cosmetic plugins' voice, in upstream's shape, on
// the fork's voice tree. A plugin writes and references voices as upstream documents them (shared/plugins/visual.js:
// audio.voice / voiceJp / voiceEn / voiceKr / voiceNative [charId][slot]); this installation's manifest keeps them as
// audio.voice.<lang>.<charId>.<role> (tools/assets/voice.mjs) with other role names. Two halves, one table:
//   · withUpstreamVoice(manifest) — the manifest with the upstream-shape trees added, so a plugin's reference
//     (`{ "ref": "<charId>" }`) and its override / add permission are judged against the lines the installation has;
//   · pluginVoiceLine(audio, lang, charId, role, index) — the line a plugin wrote for a fork role (public/js/audio.js
//     voiceUrl reads it before the installation's).
// A charId never names a dub, so the Chinese plugin tree shares `audio.voice` with the dubs without a clash.

/** The plugin tree of each fork dub. */
export const PLUGIN_VOICE_TREES = Object.freeze({ cn: 'voice', jp: 'voiceJp', en: 'voiceEn', kr: 'voiceKr', native: 'voiceNative' });

/** The upstream slot of each fork role; `combat` is positional (entry k-1 is 作战中k = upstream skillk). */
const ROLE_SLOTS = Object.freeze({
  select: 'select', deploy: 'place', start: 'faceEnemy', depart: 'start',
  win4: 'resultFour', win3: 'resultThree', win: 'resultTwo', fail: 'resultLose',
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isLine = (v) => typeof v === 'string' || Array.isArray(v);

/**
 * The value a plugin wrote for a fork role (a URL or a list), or null. `combat` without an index is skill1.
 * @param {any} audio the manifest's `audio`
 * @param {string} lang @param {string} charId @param {string} role @param {number|null} [index]
 */
export function pluginVoiceLine(audio, lang, charId, role, index = null) {
  const tree = PLUGIN_VOICE_TREES[lang];
  if (!tree || Object.hasOwn(PLUGIN_VOICE_TREES, charId)) return null;
  const slot = role === 'combat' ? `skill${Number.isInteger(index) && index >= 0 && index < 4 ? index + 1 : 1}` : ROLE_SLOTS[role];
  const v = slot ? audio?.[tree]?.[charId]?.[slot] : null;
  return isLine(v) ? v : null;
}

/** One operator's fork roles as upstream slots. */
function slotsOf(roles) {
  const out = {};
  for (const [role, v] of Object.entries(roles)) {
    if (role === 'combat' && Array.isArray(v) && v.length === 4) v.forEach((line, i) => { if (typeof line === 'string') out[`skill${i + 1}`] = line; });
    else if (role === 'combat' && isLine(v)) out.skill1 = v;
    else if (Object.hasOwn(ROLE_SLOTS, role) && isLine(v)) out[ROLE_SLOTS[role]] = v;
  }
  return out;
}

const views = new WeakMap();

/**
 * The manifest with each fork dub's lines also under its upstream-shape tree (a key already there is kept); the manifest
 * itself when it has no fork voice tree. Never changes `manifest`; the same object again for the same manifest.
 * @param {any} manifest
 */
export function withUpstreamVoice(manifest) {
  const voice = manifest?.audio?.voice;
  if (!isObj(voice) || !Object.keys(PLUGIN_VOICE_TREES).some((lang) => isObj(voice[lang]))) return manifest;
  const hit = views.get(manifest);
  if (hit) return hit;
  const audio = { ...manifest.audio };
  for (const [lang, tree] of Object.entries(PLUGIN_VOICE_TREES)) {
    if (!isObj(voice[lang])) continue;
    const into = isObj(audio[tree]) ? { ...audio[tree] } : {};
    for (const [charId, roles] of Object.entries(voice[lang])) {
      if (Object.hasOwn(into, charId) || !isObj(roles)) continue;
      const slots = slotsOf(roles);
      if (Object.keys(slots).length) into[charId] = slots;
    }
    audio[tree] = into;
  }
  const view = { ...manifest, audio };
  views.set(manifest, view);
  return view;
}
