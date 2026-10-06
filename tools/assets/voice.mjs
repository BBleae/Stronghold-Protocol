// Operator voice lines from the official excel/charword_table.json (Kengxxiao/ArknightsGameData, zh_CN).
//
// - `voiceLangDict[charId].dict[langType]` names the word key (the voice folder) of each voice language an operator
//   has; `charWords` lists its lines (`voiceAsset` 'char_002_amiya/CN_021', `voiceTitle` '选中干员1', and `placeType`,
//   the moment the official client plays it).
// - Files live on the ArknightsAssets2 `voice` branch under sound_beta_2/<lang dir>/<voiceAsset lower-cased>.mp3:
//   voice_cn/ (中文-普通话), voice/ (日文 and the linkage operators' own voices), voice_en/, voice_kr/.
// - Only the in-battle lines are taken (VOICE_ROLES, by official placeType): BATTLE_SELECT 选中干员, BATTLE_PLACE 部署,
//   BATTLE_SKILL_1..4 作战中, BATTLE_FACE_ENEMY 行动开始, THREE_STAR / TWO_STAR / LOSE 3星结束行动 / 非3星结束行动 /
//   行动失败 — 12 lines, about 0.26 MB (中文) / 0.34 MB (日文) per operator. Lines outside a battle (编入队伍, 任命队长,
//   行动出发 on the squad screen, 精英化晋升, …) and 完成高难行动 (突袭 clears, which this mode has not) are not used.
// - Operators without voice (the reserve operators 预备干员) have no voiceLangDict entry and get no voice.

/** Voice languages offered by the client: key → official voiceLangType preference (first present wins) + folder. */
export const VOICE_LANGS = Object.freeze({
  cn: { types: ['CN_MANDARIN', 'LINKAGE', 'JP'], label: '中文' },
  jp: { types: ['JP', 'LINKAGE'], label: '日文' },
  // the EN / KR dubs (upstream #73's --voice-lang en | kr, DESIGN §21.30): opt-in, `--voice=cn,jp,en,kr`
  en: { types: ['EN', 'LINKAGE'], label: '英文' },
  kr: { types: ['KR', 'LINKAGE'], label: '韩文' },
});

/** Folder under sound_beta_2 of a voiceLangType (an entry's own voicePath wins). */
const LANG_DIRS = Object.freeze({ CN_MANDARIN: 'voice_cn', JP: 'voice', LINKAGE: 'voice', EN: 'voice_en', KR: 'voice_kr' });

/** Client role → official placeType(s) (charWords[].placeType). Array roles are played at random. */
export const VOICE_ROLES = Object.freeze({
  select: ['BATTLE_SELECT'],                                                       // 选中干员1 / 2
  deploy: ['BATTLE_PLACE'],                                                        // 部署1 / 2
  combat: ['BATTLE_SKILL_1', 'BATTLE_SKILL_2', 'BATTLE_SKILL_3', 'BATTLE_SKILL_4'], // 作战中1–4
  start: 'BATTLE_FACE_ENEMY',                                                      // 行动开始
  win3: 'THREE_STAR',                                                              // 3星结束行动
  win: 'TWO_STAR',                                                                 // 非3星结束行动
  fail: 'LOSE',                                                                    // 行动失败
});

/** Languages downloaded by default (`--voice` absent); en / kr only when asked for. */
export const DEFAULT_VOICE_LANGS = Object.freeze(['cn', 'jp']);

/**
 * Parse the --voice option: 'cn,jp' (default) | any comma list of cn, jp, en, kr | 'none'.
 * @param {string|undefined} value
 * @returns {string[]} language keys of VOICE_LANGS
 */
export function parseVoiceLangs(value) {
  if (value == null) return [...DEFAULT_VOICE_LANGS];
  const v = String(value).trim().toLowerCase();
  if (!v || v === 'none' || v === 'off' || v === '0') return [];
  const out = [];
  for (const k of v.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!VOICE_LANGS[k]) throw new Error(`unknown voice language "${k}" (use ${Object.keys(VOICE_LANGS).join(', ')} or none)`);
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * Index charword_table.json: word key → { placeType → voiceAsset[] (by voiceIndex) }.
 * @param {any} charword parsed charword_table.json
 */
export function indexCharWords(charword) {
  const byKey = new Map();
  const words = Object.values(charword?.charWords || {})
    .filter((w) => w && typeof w.wordKey === 'string' && typeof w.voiceAsset === 'string' && typeof w.placeType === 'string')
    .sort((a, b) => (a.voiceIndex ?? 0) - (b.voiceIndex ?? 0));
  for (const w of words) {
    if (!byKey.has(w.wordKey)) byKey.set(w.wordKey, new Map());
    const m = byKey.get(w.wordKey);
    if (!m.has(w.placeType)) m.set(w.placeType, []);
    if (!m.get(w.placeType).includes(w.voiceAsset)) m.get(w.placeType).push(w.voiceAsset);
  }
  return { langs: charword?.voiceLangDict || {}, byKey };
}

/**
 * The voice files of one operator in one client language.
 * @param {ReturnType<typeof indexCharWords>} index
 * @param {string} charId
 * @param {keyof typeof VOICE_LANGS} lang
 * @returns {Record<string, string|string[]>|null} role → path(s) under sound_beta_2 ('voice_cn/char_002_amiya/cn_021.mp3')
 */
export function voiceLines(index, charId, lang) {
  const dict = index?.langs?.[charId]?.dict;
  const spec = VOICE_LANGS[lang];
  if (!dict || !spec) return null;
  const type = spec.types.find((t) => dict[t]);
  if (!type) return null;
  const entry = dict[type];
  const words = index.byKey.get(entry.wordkey || charId);
  if (!words) return null;
  const dir = typeof entry.voicePath === 'string' && entry.voicePath
    ? entry.voicePath.replace(/^audio\/sound_beta_2\//i, '').replace(/\/+$/, '').toLowerCase()
    : LANG_DIRS[type];
  if (!dir || dir.includes('..')) return null;
  const paths = (place) => (words.get(place) || []).filter((a) => !a.includes('..')).map((a) => `${dir}/${a.toLowerCase()}.mp3`);
  const out = {};
  for (const [role, places] of Object.entries(VOICE_ROLES)) {
    if (Array.isArray(places)) { const list = places.flatMap(paths); if (list.length) out[role] = list; }
    else { const p = paths(places)[0]; if (p) out[role] = p; }
  }
  return Object.keys(out).length ? out : null;
}
