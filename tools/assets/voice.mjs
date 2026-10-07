// Operator voice lines from the official excel/charword_table.json (Kengxxiao/ArknightsGameData, zh_CN).
//
// - `voiceLangDict[charId].dict[langType]` names the word key (the voice folder) of each voice language an operator
//   has; `charWords` lists its lines (`voiceAsset` 'char_002_amiya/CN_021', `voiceTitle` '选中干员1', and `placeType`,
//   the moment the official client plays it).
// - Files live on the ArknightsAssets2 `voice` branch under sound_beta_2/<lang dir>/<voiceAsset lower-cased>.mp3:
//   voice_cn/ (中文-普通话), voice/ (日文 and the linkage operators' own voices), voice_en/, voice_kr/.
// - Only the battle lines are taken (VOICE_ROLES, by official placeType) — 14 per operator: BATTLE_SELECT 选中干员 ×2,
//   BATTLE_PLACE 部署 ×2, BATTLE_SKILL_1..4 作战中1–4, BATTLE_FACE_ENEMY 行动开始, BATTLE_START 行动出发, FOUR_STAR
//   完成高难行动, THREE_STAR / TWO_STAR / LOSE 3星结束行动 / 非3星结束行动 / 行动失败 — about 0.34 MiB (中文) /
//   0.44 MiB (日文) per operator. The client (public/js/audio.js, DESIGN §21.30) plays upstream #73's moments: 行动出发
//   for a battle's first deployed operator, 部署 for later in-battle deploys, 行动开始 at each operator's first engage,
//   作战中N for skill N, 选中干员 on a tap or its detail card, and one settlement line after every own battle
//   (完成高难行动 for a perfect 绝境 / 终极 battle). Not taken: 编入队伍, 任命队长, 干员报到, 精英化晋升, the home and
//   base lines.
// - Every operator a player can field is planned (tools/assets/plan.mjs charIds): the pool's (research 07) and the 外援 /
//   甄选 roster's (tools/assets/waiguan-operators.json, DESIGN §27) — 198 voiced operators, 120 of the pool's 138 and
//   all 78 外援-only ones, each with the 14 lines. Operators without voice (the reserve operators 预备干员, also the 9
//   char_6xx entries of the 外援 roster) have no voiceLangDict entry and get no voice.

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

/**
 * Client role → official placeType(s) (charWords[].placeType). A string role is one line. An array role of ONE place is
 * that place's lines, played at random (select, deploy). An array role of several places is POSITIONAL (POSITIONAL_ROLES):
 * entry k-1 is the first line of the k-th place, in order, so `combat`[k-1] is 作战中k and the client plays 作战中N
 * for skill N (public/js/audio.js voiceUrl with an index, combatSlot). A missing place is left out, which shortens the
 * array (the client then draws at random); all 198 voiced operators (pool and 外援) have the four.
 * The key stays `combat` (not renamed to a slot name) on purpose: tools/assets/manifest.mjs droppedEntries treats an
 * array as one leaf, so a renamed key would read as audio.voice.*.*.combat dropped and trip the shrink guard.
 */
export const VOICE_ROLES = Object.freeze({
  select: ['BATTLE_SELECT'],                                                       // 选中干员1 / 2 (random)
  deploy: ['BATTLE_PLACE'],                                                        // 部署1 / 2 (random)
  combat: ['BATTLE_SKILL_1', 'BATTLE_SKILL_2', 'BATTLE_SKILL_3', 'BATTLE_SKILL_4'], // 作战中1–4, in this order
  start: 'BATTLE_FACE_ENEMY',                                                      // 行动开始 (each operator's first engage)
  depart: 'BATTLE_START',                                                          // 行动出发 (a battle's first deployment)
  win4: 'FOUR_STAR',                                                               // 完成高难行动
  win3: 'THREE_STAR',                                                              // 3星结束行动
  win: 'TWO_STAR',                                                                 // 非3星结束行动
  fail: 'LOSE',                                                                    // 行动失败
});

/** Array roles whose entries are positional (one line per place, in place order) rather than drawn at random. */
export const POSITIONAL_ROLES = new Set(['combat']);

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
    if (Array.isArray(places)) {
      // positional: the first line of each place, in place order (combat[k-1] = 作战中k); else every line, at random
      const list = POSITIONAL_ROLES.has(role) ? places.map((p) => paths(p)[0]).filter(Boolean) : places.flatMap(paths);
      if (list.length) out[role] = list;
    }
    else { const p = paths(places)[0]; if (p) out[role] = p; }
  }
  return Object.keys(out).length ? out : null;
}
