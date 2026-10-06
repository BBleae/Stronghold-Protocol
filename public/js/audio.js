// Audio manager (Web Audio): BGM per phase, UI SFX, per-unit battle SFX. Never throws.
//
// Sources: data/assets.json → audio (docs/ASSETS.md):
//   bgm { lobby, prep, combat, combatAlts?: [ {intro?, loop}, … ], boss: { intro?, loop } },
//   bossBgm { [bossId]: { intro?, loop } },
//   sfx.ui { click, buy, sell, refresh, freeze, levelup, merge, equip, ready, timer, yourTurn, … },
//   sfx.battle { deploy, tokenDeploy, charDie, tokenDie?, enemyDie, enemyHit, heal, killCoin, … },
//   sfx.units { [charId|tokenId|enemyId]: { attack?, hit?, skill?, die?, born?, mix?: { [role]: { p?, vol? } } } }.
//
// - The AudioContext is created on the first user gesture (pointerdown/keydown/touchend), so browsers
//   never block or warn; everything requested before that is remembered (BGM) or dropped (SFX). Before it is created,
//   navigator.audioSession.type becomes 'playback' (iOS 16.4+): the silent switch no longer mutes the whole game.
// - Channels: master → { bgm, sfx } gains; volumes from settings (0..1) + mute. Tab hidden ⇒ suspend.
// - BGM: `intro` then `loop` (1 s crossfade); switching tracks fades out/in (0.8 s). The same loop URL
//   keeps playing across phases (prep and combat share a track).
// - 开战 BGM: `bgm.combatAlts` are the mode's own battle tracks (塞壬唱片 骑士之日 / 无畏者). The track is fixed per
//   round, not drawn: 无畏者 through rounds 1–7 and 骑士之日 from round 8 on (`combatTrackFor`, the official
//   schedule), so every client of a match hears the same one, a fight never switches track halfway through and the
//   联防 that follows a 作战 keeps its round's track.
// - Battle SFX from `b.ev` tuples (`handleBattleEvents`): at most MAX_VOICES concurrent unit sounds, at most
//   MAX_PER_URL overlapping copies of one sound (the official banks' maxSoundAllowed 2), a per-unit cooldown and a
//   per-URL minimum gap (SfxLimiter), so a 60-unit fight stays listenable.
// - Impact sounds (user playtest #4 item 6): a 'dmg' plays the `hit` sound of the unit whose hostile attack ('atk' on a
//   unit of the other side) aimed at the target — once, within IMPACT_WINDOW_MS, and only for phys / arts / true damage.
//   A heal "attack" ('atk' of a healer on an ally, chain heals) never makes the healer the author of the next damage
//   on that ally (纯烬艾雅法拉's heals made every later hit on a healed ally ring her impact sound), element gauge fills
//   and DoTs play none, and a chain bounce ('chain' / 'chainHeal': its first id is the previous target) plays no attack
//   sound of that target. An operator's attack / hit sound that is a skill-mode file of its own (official names end in
//   `_n` for the normal attack, `_d` / `_h` / `_s` for its skill modes — the manifest picked 纯烬艾雅法拉's S3 impact
//   p_imp_gtshpbrnch_s as her `hit`) never plays for a normal attack (normalAttackSfx).
// - The official bank mix of a unit's own attack / hit / die / born sound (`mix`, tools/assets/audio.mjs bankMix; community
//   report #30): it plays with chance `p` — 猎狗pro / 深池侦察犬's attack bank is 80 % silence, so they bark on about one
//   attack in five (never replaced by the generic enemy sound) — at its base gain × `vol`, capped at 1: an official volume
//   below 1 is quieter (妖怪's 0.7), none is louder than before (unitGain).
// - Deaths/deployments follow the official per-class defaults (unitSoundClass): only operators play the
//   operator-knocked-down sound; summons use the token sounds; a summon used up by its own effect (fx `consumed`,
//   香槟炸弹) plays its impact sound instead of a death sound.
// - 漏怪 ('leak', not a 'die'): the original stage exit alarm `sfx.battle.leak` (battle.ON_ENEMY_REACHED_EXIT), at most
//   one per LEAK_SFX_GAP_MS. Like every battle sound it belongs to the field on screen — the events screens/game.js
//   feeds: the own field, a watched teammate's, the 联防 field shown (with several 联防 fields, only that one), a
//   spectator's or an eliminated player's watched field (with the render engine on its clock: it rings as drawn; a
//   field entered mid-battle replays the leaks before its entry silently — render/app.js heardEvents).
// - Buffers are fetched once and cached (LRU). A failed fetch/decode is logged once, plays nothing and is remembered
//   for RETRY_MS (a missing file is not requested on every use); the next request after that fetches it again.
// - Operator voice (audio.voice.<lang>.<charId>, tools/assets/voice.mjs) on its own channel and volume, one line at a
//   time, by the official battle voice rules (audio_data.json `battleVoice` → data/assets.json audio.voiceRules): every
//   line has a voice type with a priority, a cooldown (from the start of a line that plays) and whether a line of the
//   same priority replaces the one playing (`overlap`); a lower priority never cuts in; a line still loading counts as
//   playing; lines cross-fade (0.1 s). The moments are upstream #73's (DESIGN §21.30), on this engine:
//   · 行动出发 (depart, BATTLE_START) — the first operator of a battle's first deployment (the sim emits 'spawn' right
//     before 'deploy' only for a unit's first deployment: the pair in one batch), once per battle on the field on screen
//     and within its opening; a voiceless operator is skipped by the next one. The initial deployment usually comes in
//     the field's early buffer (the runner's first frames race the render that enters the field): replayEarly says it
//     from there, and nothing else of that buffer;
//   · 部署 (deploy, PLACE_CHAR) — an operator deployed later in a battle (redeploy, 突袭 jump, 不屈 / 阿戈尔 revive);
//     the 整备期 says nothing (buying, dragging or placing a bench operator);
//   · 行动开始 (start, ENCOUNTER_ENEMY) — an operator's first engage (the sim's ['engage', id], once per unit), with
//     minTimeDeltaForEnemyEncounter (3 s) between two such lines and one never cutting another: a wave says one;
//   · 作战中N (combat, SKILL_PASSIVE_IMP) — an operator's skill N starts (the positional `combat` array, combatSlot);
//     it waits for the battle's first 行动开始 (or the end of its OPENING_MS opening; a solo pause holds that clock), has
//     a 10 s cooldown start to start and never cuts another;
//   · 选中干员 (select, FOCUS_CHAR) — a tap on an operator in a battle phase, or its detail card opening: the two share a
//     key (unit), and one key within SELECT_SAME_MS is one line;
//   · 结算 (win4 / win3 / win / fail, RESULT: ours) — after every own battle (settle, once per battleId), said by an
//     operator of THAT battle (settlementVoice: its unitsEnd, survivors first, one that has the line) whatever field is
//     on screen (upstream's speaker): 3星 when perfect (完成高难行动 on 绝境 / 终极), 非3星 after a leak, 行动失败
//     when nothing was killed or a boss survived.
// - Which field speaks: every line but the settlement comes from the battle events this manager is given — the field on
//   screen, like every battle sound (render/app.js heardEvents, screens/game.js) — so a watched teammate's, a 联防 or a
//   spectated field's operators speak; enemies, summons and devices never do. A field switch (setFieldUnits: another
//   field or battle) drops the line still loading — never a settlement — and the opening's pending 行动开始; the line
//   playing finishes, like any sound in flight.
// - The battle voice follows the match in the store (followMatch), like the BGM: each battle (voiceBattleKey: phase +
//   round; 联防 is a battle of its own) has its own opening. A hidden page, a re-mounted battle screen or a reconnect
//   that takes the match off the screen for a moment changes nothing of that (the opening's first 行动开始 that came on
//   a hidden page is said on return, within the opening). A new battle drops the lines still loading for the one before
//   — a settlement only by the rules (the next 行动出发 cuts it); leaving the match drops everything. The match end
//   (m.result) says nothing. All voice timing is real time (battles run at 2x).
// - Nothing is said on a hidden page (the context is suspended): the line playing stops and the one loading is
//   dropped; voice off, at 0 or muted does the same.
//
// `bgmKeyFor(route, pub)` picks the track for the current screen/phase (main.js calls `audio.install()`,
// which follows the store).

import { PHASE } from '../../shared/constants.js';
import { mediaUrl } from './media.js';

const MAX_VOICES = 8;
const UNIT_COOLDOWN_MS = 160;
const URL_GAP_MS = 45;
const MAX_PER_URL = 2;
/**
 * 漏怪: the original Arknights exit alarm (`sfx.battle.leak`, `battle/b_ui/b_ui_alarmenter`) runs **1.44 s**, and the
 * official bank is a one-shot: `battle.ON_ENEMY_REACHED_EXIT` carries `maxSoundAllowed: 1` with `popOldest: true` on the
 * `Battle_UI_Important` mixer, i.e. **never two at once** (a new escape replaces the one still ringing). We keep the
 * "never two at once" half and leave the rest of the cue alone: leaks closer together than the cue is long are the same
 * disaster and share one alarm, so a line that breaks costs one clear ring per 1.5 s instead of a stutter of restarts.
 * (The SFX limiter still applies on top.)
 */
const LEAK_SFX_GAP_MS = 1500;
const BUFFER_CACHE = 180;
/** Decoded-PCM budget of the buffer cache beside its entry count: a voice line decodes to 0.4–1.3 MB (see _buffer). */
const BUFFER_BYTES = 64 * 1024 * 1024;
const XFADE_S = 1;
const FADE_S = 0.8;
/** 'atk' projectile kinds whose first id is the previous bounce target (sim ai.js), not the attacker. */
const CHAIN_KINDS = new Set(['chain', 'chainHeal']);
/** 'dmg' types that are an attack's impact (element gauge fills / 元素伤害 carry the element's name instead). */
const IMPACT_TYPES = new Set(['phys', 'arts', 'true']);
/** A 'dmg' later than this (real ms) after the attack aimed at the target is not that attack's impact. */
const IMPACT_WINDOW_MS = 2500;
/** Official operator sound files of a skill mode: `…_d` / `…_h` / `…_s` (+ digits) — the normal attack's end in `_n`. */
const SKILL_MODE_FILE = /_(d|h|s)\d*\.mp3$/i;
/** A failed fetch / decode is remembered this long; the next request after that fetches the file again. */
const RETRY_MS = 10000;
/**
 * The settlement lines (结算, after every own battle — settle): not a battle voice type of the official rules. Above
 * everything but the next battle's 行动出发 (BATTLE_START 100, which overlaps), so a battle's last word is cut only by
 * the next battle's first one.
 */
const RESULT_VOICE = Object.freeze({ priority: 100, overlap: true, cooldown: 0 });
/**
 * The voice type of each role. 作战中 is SKILL_PASSIVE_IMP: every skill of this mode is cast automatically, and the
 * official rules' other passive type (SKILL_PASSIVE_NOR) would differ only in a priority that never decides anything
 * between two 作战中 lines (one never cuts another).
 */
const ROLE_VOICE_TYPE = Object.freeze({
  select: 'FOCUS_CHAR', deploy: 'PLACE_CHAR', combat: 'SKILL_PASSIVE_IMP', start: 'ENCOUNTER_ENEMY', depart: 'BATTLE_START',
  win4: 'RESULT', win3: 'RESULT', win: 'RESULT', fail: 'RESULT',
});
/** The phases of a battle with an opening of its own (行动出发, the first 行动开始); 联防 is a battle of its own. */
const OPENING_PHASES = new Set([PHASE.COMBAT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]);
/**
 * A battle's opening: 行动出发 belongs to it (a first deployment later is a plain 部署), and 作战中 waits for the battle's
 * first 行动开始 that long at most.
 */
const OPENING_MS = 15000;
/** 选中干员: the same key (a unit of a field) within this long is one line — the tap and the detail card it opens. */
const SELECT_SAME_MS = 1000;
/** Settled battles remembered (settle: one settlement line per battle across re-mounts and replays). */
const SETTLED_CAP = 64;
/** Voice languages the settings offer, in order (tools/assets/voice.mjs VOICE_LANGS). */
export const VOICE_LANGS = Object.freeze([['cn', '中文'], ['jp', '日文'], ['en', '英文'], ['kr', '韩文']]);

// ---- pure helpers (unit-tested) -----------------------------------------------------------------------

/**
 * URL of an operator voice line (audio.voice.<lang>.<charId>.<role>; array roles pick at random). `combat` is
 * positional (tools/assets/voice.mjs: entry k-1 is 作战中k): with an integer `index` and an array of exactly 4 lines,
 * that entry is the line; any other array (an older manifest) is drawn at random.
 * @param {any} manifest data/assets.json
 * @param {string} lang 'cn' | 'jp' | 'en' | 'kr' | 'off'
 * @param {string} charId
 * @param {string} role select | deploy | combat | start | depart | win4 | win3 | win | fail
 * @param {() => number} [rand]
 * @param {number|null} [index] 0-based line of a positional role (作战中N: N - 1)
 * @returns {string|null}
 */
export function voiceUrl(manifest, lang, charId, role, rand = Math.random, index = null) {
  const v = manifest?.audio?.voice?.[lang]?.[charId]?.[role];
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return null;
  if (Number.isInteger(index) && index >= 0 && index < 4 && v.length === 4 && v.every((x) => typeof x === 'string')) return v[index];
  const list = v.filter((x) => typeof x === 'string');
  return list.length ? list[Math.min(list.length - 1, Math.floor(rand() * list.length))] : null;
}

/**
 * The 作战中 line of a skill: UnitInfo.skillIndex is the official 0-based index of the operator's equipped skill
 * (sim/snapshot.js, def.skill.index), so S1 → 作战中1, S2 → 作战中2, S3 → 作战中3; unknown → 作战中1.
 * @param {number|null|undefined} skillIndex
 * @returns {1|2|3|4}
 */
export function combatSlot(skillIndex) {
  return Number.isInteger(skillIndex) && skillIndex >= 0 ? Math.min(4, skillIndex + 1) : 1;
}

/**
 * The battle voice rules of the manifest (audio.voiceRules: the official audio_data battleVoice, written next to the
 * voice lines by tools/fetch-assets.mjs) as { crossfade (s), types: { [voiceType]: { priority, overlap, cooldown (s) } } }
 * plus RESULT; null when the manifest has none. minTimeDeltaForEnemyEncounter (3 s) is read as the least time between
 * two 行动开始 lines, start to start: ENCOUNTER_ENEMY's cooldown.
 */
export function voiceRulesOf(manifest) {
  const raw = manifest?.audio?.voiceRules;
  if (!Array.isArray(raw?.voiceTypeOptions)) return null;
  const types = { RESULT: RESULT_VOICE };
  for (const o of raw.voiceTypeOptions) {
    types[o.voiceType] = { priority: o.priority, overlap: o.overlapIfSamePriority, cooldown: o.cooldown };
  }
  const enc = types.ENCOUNTER_ENEMY;
  const gap = Number(raw.minTimeDeltaForEnemyEncounter);
  if (enc && Number.isFinite(gap)) types.ENCOUNTER_ENEMY = { ...enc, cooldown: Math.max(Number(enc.cooldown) || 0, gap) };
  return { crossfade: raw.crossfade, types };
}

/**
 * May a line of this voice type start now? Not within its cooldown since the last one of its type; over the line
 * playing (or loading) only with a higher priority, or the same priority when the type overlaps.
 * @param {{ priority: number, overlap: boolean, cooldown: number }} opt
 * @param {{ priority: number }|null} current
 * @param {number|undefined} lastAt when the last line of this type started (ms) @param {number} now (ms)
 */
export function voiceMayStart(opt, current, lastAt, now) {
  if (opt.cooldown > 0 && Number.isFinite(lastAt) && now - lastAt < opt.cooldown * 1000) return false;
  if (!current) return true;
  return opt.priority > current.priority || (opt.priority === current.priority && opt.overlap);
}

/**
 * The settlement line (结算) of a finished own battle — upstream #73's mapping (resultVoiceSlot) with this fork's role
 * names: a 完美作战 says 3星结束行动 (完成高难行动 on 绝境 / 终极), a battle that killed nothing at all 行动失败, a leak
 * 非3星结束行动, anything else the 3星 line. [ASSUMED] beside upstream: a boss battle whose boss survived says 行动失败.
 * @param {{ perfect?: boolean, leaked?: number, killed?: number, total?: number, hard?: boolean, boss?: boolean,
 *   bossDown?: boolean|null }} [o] leaked: the counted leaks; hard: 绝境 / 终极
 * @returns {'win4'|'win3'|'win'|'fail'}
 */
export function resultVoiceRole(o = {}) {
  const { perfect = false, leaked = 0, killed = 0, total = 0, hard = false, boss = false, bossDown = true } = o || {};
  const n = (x) => (Number.isFinite(x) ? x : 0);
  if (boss && !bossDown) return 'fail';
  if (perfect) return hard ? 'win4' : 'win3';
  if (n(total) > 0 && n(killed) <= 0) return 'fail';
  if (n(leaked) > 0) return 'win';
  return hard ? 'win4' : 'win3';
}

/**
 * Who says a battle's settlement line: an operator of THAT battle (upstream #73 + 9d56342), never one of the field on
 * screen — the line is the player's own battle's, also while a teammate's field is watched.
 * `pp` is that battle's own perPlayer entry (BattleResult, sim/Battle.js; battle/runner.js settlement): `unitsEnd`
 * lists what stood on its field when it ended, `defId` naming the CHESS (`chess_char_*`) or a summon piece (`token_*`,
 * which does not talk); `charOf` maps a chess id to the operator whose voice bank speaks (the chess record's charId) —
 * without it only ids that already are a charId count, and a real result has no speaker (upstream's 0.1.4 bug).
 * `canSpeak` skips an operator without the line (预备干员, 盟约·辅助干员) instead of drawing silence.
 * Survivors speak first: only a wiped-out squad is spoken for by a fallen operator. Ties are drawn.
 * @param {{ unitsEnd?: Array<{ defId?: string|null, alive?: boolean }> } | null | undefined} pp
 * @param {() => number} [random]
 * @param {((defId: string) => string|null|undefined) | null} [charOf] chess id → charId
 * @param {((charId: string) => boolean) | null} [canSpeak]
 * @returns {string|null} charId, or null when that battle fielded no operator that can say it
 */
export function resultSpeaker(pp, random = Math.random, charOf = null, canSpeak = null) {
  const ops = [];
  for (const u of Array.isArray(pp?.unitsEnd) ? pp.unitsEnd : []) {
    if (!u || typeof u.defId !== 'string') continue;
    const id = u.defId.startsWith('char_') ? u.defId : typeof charOf === 'function' ? charOf(u.defId) : null;
    if (typeof id !== 'string' || !id.startsWith('char_')) continue;
    if (typeof canSpeak === 'function' && !canSpeak(id)) continue;
    ops.push({ id, alive: !!u.alive });
  }
  const standing = ops.filter((o) => o.alive);
  const pool = standing.length ? standing : ops;
  if (!pool.length) return null;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))].id;
}

/**
 * The settlement line of a finished own battle: { charId, role } or null (no settlement, or nobody who can say it).
 * @param {{ perfect?: boolean, leaked?: number, killed?: number, total?: number, boss?: boolean, bossDown?: boolean|null,
 *   unitsEnd?: Array<{ defId?: string|null, alive?: boolean }> } | null | undefined} st battle/runner.js settlement()
 * @param {{ hard?: boolean, charOf?: ((defId: string) => string|null|undefined) | null,
 *   canSpeak?: ((charId: string, role: string) => boolean) | null, random?: () => number }} [o]
 * @returns {{ charId: string, role: 'win4'|'win3'|'win'|'fail' } | null}
 */
export function settlementVoice(st, { hard = false, charOf = null, canSpeak = null, random = Math.random } = {}) {
  if (!st) return null;
  const role = resultVoiceRole({ ...st, hard });
  const charId = resultSpeaker(st, random, charOf, typeof canSpeak === 'function' ? (id) => canSpeak(id, role) : null);
  return charId ? { charId, role } : null;
}

/**
 * The battle the voice follows: `${phase}:${round}` in a battle phase (OPENING_PHASES; 联防 is a battle of its own),
 * else null. Everyone in the match has it — an eliminated player or a spectator hears the field they watch.
 * @param {any} s store state
 * @returns {string|null}
 */
export function voiceBattleKey(s) {
  const pub = s?.match?.public;
  if (!pub || !OPENING_PHASES.has(pub.phase)) return null;
  return `${pub.phase}:${pub.round}`;
}

/**
 * The voice languages the manifest has, in VOICE_LANGS order.
 * @param {any} manifest
 * @returns {[string, string][]} [key, label]
 */
export function voiceLangsIn(manifest) {
  const v = manifest?.audio?.voice;
  return VOICE_LANGS.filter(([k]) => v && typeof v[k] === 'object' && v[k] && Object.keys(v[k]).length);
}

/**
 * BGM key for a route + match phase.
 * @param {'title'|'lobby'|'room'|'game'|string} route
 * @param {any} pub m.public (may be null)
 * @param {0|1|null} [combatTrack] the round's own 开战 track index into `bgm.combatAlts` (combatTrackFor; omitted ⇒
 *   plain 'combat', i.e. the manifest's default combat track)
 * @returns {string|null} 'lobby' | 'prep' | 'combat' | 'combat:<i>' | 'unite' | 'boss' | 'boss:<bossId>' | null
 */
export function bgmKeyFor(route, pub, combatTrack = null) {
  if (route !== 'game') return route === 'title' || route === 'lobby' || route === 'room' ? 'lobby' : null;
  const phase = pub?.phase;
  if (!phase) return 'lobby';
  switch (phase) {
    case PHASE.INFO_CHECK: case PHASE.BAND_DRAFT: case PHASE.BATTLE_CHECK: case PHASE.RESULT: case PHASE.LOBBY:
      return 'lobby';
    case PHASE.UNITE:
      // 联防 has its own track: the official `escaped_single` / `escaped_multi` levels declare
      // `bgmEvent = corrosion` (level_act1autochess_escaped_*.json), so the rescue phase is not the 作战's track.
      // resolveBgm falls back to `bgm.combat` when a manifest predates it.
      return 'unite';
    case PHASE.COMBAT:
      // 开战 BGM: the round's own track — 骑士之日 / 无畏者 are fixed per round, not drawn (combatTrackFor)
      return combatTrack == null ? 'combat' : `combat:${combatTrack ? 1 : 0}`;
    case PHASE.FINAL_ASSAULT:
      return pub.bossId ? `boss:${pub.bossId}` : 'boss';
    case PHASE.HIDDEN_CORE:
      return pub.hiddenBossId ? `boss:${pub.hiddenBossId}` : pub.bossId ? `boss:${pub.bossId}` : 'boss';
    default:
      return 'prep';
  }
}

/**
 * Resolve a BGM key to { intro?, loop } URLs from the manifest: `boss:<id>` falls back to the generic boss track,
 * `combat:<i>` to the i-th `bgm.combatAlts` entry (and to `bgm.combat` when the manifest has none), and `unite`
 * (联防's own track) to `bgm.combat` when the manifest predates it.
 * @param {any} manifest
 * @param {string|null} key
 * @returns {{ intro: string|null, loop: string }|null}
 */
export function resolveBgm(manifest, key) {
  const a = manifest?.audio;
  if (!a || !key) return null;
  let t = null;
  if (key.startsWith('boss:')) t = a.bossBgm?.[key.slice(5)] || a.bgm?.boss;
  else if (key.startsWith('combat:')) t = a.bgm?.combatAlts?.[Number(key.slice('combat:'.length))] || a.bgm?.combat;
  else if (key === 'unite') t = a.bgm?.unite || a.bgm?.combat;
  else t = a.bgm?.[key];
  if (!t || typeof t.loop !== 'string') return null;
  return { intro: typeof t.intro === 'string' ? t.intro : null, loop: t.loop };
}

/**
 * The last round that plays 无畏者 (1–7); from the next round on it is 骑士之日 (8–13) — the official schedule
 * (docs/ASSETS.md "BGM"; the two tracks are the 塞壬唱片 act13side battle themes).
 */
export const COMBAT_TRACK_SWITCH_ROUND = 7;

/**
 * The round's own 开战 track index into `bgm.combatAlts` (plan.mjs order: 0 = `m_bat_kazimierz2_1` 骑士之日,
 * 1 = `m_bat_kazimierz2_2` 无畏者). The mode does not draw these: the official schedule plays one per round, 无畏者
 * through the early rounds (1–7) and 骑士之日 from round 8 to the last normal round (8–13). Everything after that is
 * the boss rounds (最终攻势 / 隐秘核心), which have their own tracks and never ask for `combat:<i>`.
 * @param {number|null|undefined} round m.public.round
 * @returns {0|1|null} null when the round is unknown ⇒ the manifest's plain `combat` track
 */
export function combatTrackFor(round) {
  const r = Number(round);
  if (!Number.isFinite(r) || r < 1) return null;
  return r <= COMBAT_TRACK_SWITCH_ROUND ? 1 : 0;
}

/**
 * Official sound class of a battle unit (audio_data `battle.ON_UNIT_DEAD|BORN.<class>` defaults):
 * 'enemy' | 'char' (operators: b_char_dead “干员被击倒” / b_char_set) | 'token' (summons: b_char_tokendead /
 * b_char_tokenset) | 'device' (stage devices: the act crate trap_1105 dies with b_char_tokendead, no born sound).
 * Band map characters (预备干员-医疗 / Touch, `char_*` ids) are characters although the sim runs them as tokens.
 * @param {{ side?: string, kind?: string, defId?: string, def?: string }|null} info tracked unit (UnitInfo subset)
 */
export function unitSoundClass(info) {
  if (!info) return 'char';
  if (info.side === 'enemy') return 'enemy';
  const id = String(info.defId ?? info.def ?? '');
  if (info.kind === 'device') return 'device';
  if (info.kind === 'token') return /^char_/.test(id) ? 'char' : 'token';
  return 'char';
}

/** URL of the generic token death sound (b_char_tokendead): sfx.battle.tokenDie, else next to charDie. */
function tokenDieUrl(manifest) {
  const b = manifest?.audio?.sfx?.battle;
  if (typeof b?.tokenDie === 'string') return b.tokenDie;
  return typeof b?.charDie === 'string' && /b_char_dead\.mp3$/.test(b.charDie) ? b.charDie.replace(/b_char_dead\.mp3$/, 'b_char_tokendead.mp3') : null;
}

/**
 * Death sound of a battle unit ('die' event): the unit's own ON_UNIT_DEAD sound, else its class default — only
 * operators play the operator-knocked-down sound (charDie). A summon that fired and was used up (香槟炸弹: its
 * explosion is the sound) is silent, and so is an operator leaving without being knocked out, when the event says so
 * (`reason` ≠ 'killed').
 * @param {any} manifest data/assets.json
 * @param {{ side?: string, kind?: string, defId?: string, def?: string, boss?: boolean }|null} info
 * @param {{ consumed?: boolean, reason?: string|null }} [o]
 * @returns {string|null} sound URL
 */
export function deathSfxUrl(manifest, info, { consumed = false, reason = null } = {}) {
  if (!info || consumed) return null;
  const cls = unitSoundClass(info);
  if (cls === 'char' && reason && reason !== 'killed') return null;
  const own = manifest?.audio?.sfx?.units?.[info.def]?.die;
  if (typeof own === 'string') return own;
  const b = manifest?.audio?.sfx?.battle ?? {};
  if (cls === 'enemy') return (info.boss ? b.enemyDieHeavy : null) ?? b.enemyDie ?? null;
  if (cls === 'char') return typeof b.charDie === 'string' ? b.charDie : null;
  return tokenDieUrl(manifest);
}

/**
 * Deployment sound of an allied unit ('deploy' event): its own ON_UNIT_BORN sound, else operators b_char_set
 * (sfx.battle.deploy), summons b_char_tokenset (tokenDeploy); stage devices have none.
 * @returns {string|null}
 */
export function deploySfxUrl(manifest, info) {
  if (!info || info.side === 'enemy') return null;
  const own = manifest?.audio?.sfx?.units?.[info.def]?.born;
  if (typeof own === 'string') return own;
  const b = manifest?.audio?.sfx?.battle ?? {};
  const cls = unitSoundClass(info);
  if (cls === 'device') return null;
  const url = cls === 'token' ? (b.tokenDeploy ?? b.deploy) : b.deploy;
  return typeof url === 'string' ? url : null;
}

/**
 * Whether a unit's manifest `attack` / `hit` sound may play for its normal attacks: an operator's (`char_*`) sound file
 * of one of its skill modes (`_d` / `_h` / `_s`, see header) may not. Enemy files use `_h` for heavy weapons (always
 * allowed), and so may summons.
 * @param {string} defId the unit's model id (sfx.units key)
 * @param {string} url
 */
export function normalAttackSfx(defId, url) {
  return typeof url === 'string' && !(typeof defId === 'string' && defId.startsWith('char_') && SKILL_MODE_FILE.test(url));
}

/**
 * Gain of a unit's own sound with its manifest mix (sfx.units[id].mix[role]: the official bank's volume): `base` × `vol`,
 * never above `base` (a bank louder than 1 plays as before — community report #30 asked for quieter, not louder).
 * @param {number} base the role's base gain (attack / hit 0.55, die / born / skill 0.8)
 * @param {{ vol?: number }|null|undefined} mix
 */
export function unitGain(base, mix) {
  const v = mix && Number(mix.vol);
  return Number.isFinite(v) && v >= 0 ? base * Math.min(1, v) : base;
}

/**
 * Whether a unit's own sound plays this time: its official bank's chance `mix.p` (sounds with a file over all the weights;
 * 猎狗pro's attack bank 20 of 100). `roll` ∈ [0, 1).
 */
export function unitSoundPlays(mix, roll) {
  const p = mix && Number(mix.p);
  return !(Number.isFinite(p) && p >= 0 && p < 1) || roll < p;
}

/** Concurrency + cooldown gate for battle SFX. Pure (time is passed in). */
/** Gestures that may unlock audio: iOS Safari only accepts touchend / click / keydown; pointerdown covers the rest. */
const UNLOCK_EVENTS = ['pointerdown', 'touchend', 'click', 'keydown'];

export class SfxLimiter {
  /** @param {{ maxVoices?: number, unitCooldownMs?: number, urlGapMs?: number, maxPerUrl?: number }} [o] */
  constructor(o = {}) {
    this.maxVoices = o.maxVoices ?? MAX_VOICES;
    this.unitCooldownMs = o.unitCooldownMs ?? UNIT_COOLDOWN_MS;
    this.urlGapMs = o.urlGapMs ?? URL_GAP_MS;
    // the official battle banks (attack, impact, heal, born, dead…) allow at most 2 overlapping copies of a sound
    // (audio_data maxSoundAllowed 2): a heal / impact heard on every tick of a crowd never piles up
    this.maxPerUrl = o.maxPerUrl ?? MAX_PER_URL;
    this.active = 0;
    this.lastByUnit = new Map();
    this.lastByUrl = new Map();
    this.activeByUrl = new Map();
  }

  /**
   * Whether a sound may start now; records it when allowed (call `release(url)` when it ends).
   * @param {number} now ms
   * @param {string|number|null} unitKey e.g. `${unitId}:atk`
   * @param {string} url
   */
  tryAcquire(now, unitKey, url) {
    if (this.active >= this.maxVoices) return false;
    if ((this.activeByUrl.get(url) || 0) >= this.maxPerUrl) return false;
    if (unitKey != null) {
      const t = this.lastByUnit.get(unitKey);
      if (t != null && now - t < this.unitCooldownMs) return false;
    }
    const u = this.lastByUrl.get(url);
    if (u != null && now - u < this.urlGapMs) return false;
    if (unitKey != null) this.lastByUnit.set(unitKey, now);
    this.lastByUrl.set(url, now);
    if (this.lastByUnit.size > 600) this.lastByUnit.clear();
    if (this.lastByUrl.size > 400) this.lastByUrl.clear();
    this.active += 1;
    this.activeByUrl.set(url, (this.activeByUrl.get(url) || 0) + 1);
    return true;
  }

  /** A sound started by tryAcquire ended. */
  release(url) {
    this.active = Math.max(0, this.active - 1);
    const n = this.activeByUrl.get(url) || 0;
    if (n <= 1) this.activeByUrl.delete(url); else this.activeByUrl.set(url, n - 1);
  }
}

// ---- manager -----------------------------------------------------------------------------------------------

/**
 * Could Web Audio decode this response? A host without the `/media/` route answers 404; some static hosts answer a
 * missing path with 200 + the SPA's index.html instead, and fetching *that* would fail to decode as silently as a
 * 404 would — so the fallback looks at the declared type too.
 *
 * A response that declares no type at all is not treated as wrong: absence of a header is not evidence of an HTML
 * page, and fetch stubs / minimal hosts legitimately omit it.
 * @param {{ ok?: boolean, headers?: { get?: (n: string) => string | null } }} res
 */
function isAudioResponse(res) {
  if (!res || !res.ok) return false;
  const type = res.headers?.get?.('content-type');
  return !type || /^\s*audio\//i.test(type);
}
export class AudioManager {
  /**
   * @param {{ getManifest?: () => any, random?: () => number, win?: any }} [opts]
   */
  constructor(opts = {}) {
    this.getManifest = typeof opts.getManifest === 'function' ? opts.getManifest : () => null;
    this.random = typeof opts.random === 'function' ? opts.random : Math.random;   // a unit sound's chance (mix.p)
    this.win = opts.win ?? (typeof window !== 'undefined' ? window : null);
    this.ctx = null;
    this.master = null;
    this.bgmGain = null;
    this.sfxGain = null;
    this.voiceGain = null;
    this.volumes = { bgm: 0.6, sfx: 0.8, voice: 0.8, voiceLang: 'cn', muted: false };
    this.voiceNow = null;     // { src, gain, priority, type } of the line playing
    this.voiceWant = null;    // { token, priority, type } of the line loading (it replaces the one playing)
    this.voiceToken = 0;      // the newest line requested: bumping it drops the line loading
    this.voiceLast = new Map(); // voice type → when its last line started (cooldowns)
    // the battle the voice follows (followMatch): { key, at: when it opened (moved on by its pauses), pausedAt,
    // said: its first 行动开始 was requested, pending: the charId of an opening 行动开始 that came while unheard }
    this.voiceBattle = null;
    // the field on screen (setFieldUnits): { key: `${fieldId}:${battleId}`, departed: its 行动出发 was requested,
    // at: when it was entered }
    this.voiceField = { key: null, departed: false, at: -Infinity };
    this.lastSelect = null;   // { key, at } of the latest 选中干员 requested (SELECT_SAME_MS)
    this.settled = new Set(); // battleIds whose settlement line was requested (settle; SETTLED_CAP)
    // the lines started: { role, charId, type, slot (combat only), battle: the voiceBattle key, t: ms into it }
    // (latest 200; the browser E2E reads it)
    this.voiceLog = [];
    this.buffers = new Map(); // url → Promise<AudioBuffer|null> (insertion order = LRU)
    this.bufBytes = new Map(); // url → decoded PCM bytes (the byte budget of the LRU, see _buffer)
    this.warned = new Set();
    this.limiter = new SfxLimiter();
    this.uiVoices = 0;
    this.wantBgm = null;      // desired key (kept while locked)
    this.bgm = null;          // { key, loopUrl, nodes: [{src, gain}], gain }
    this.bgmToken = 0;
    this.units = new Map();   // battle unit id → defId
    this.lastAttacker = new Map(); // target id → { def, at } of the hostile attack last aimed at it (its impact sound)
    this.consumed = new Set();     // summons used up by their own effect (香槟炸弹 exploded): no death sound
    this.installed = false;
    this._unlock = this._unlock.bind(this);
    this._onVis = this._onVis.bind(this);
  }

  /** Attach gesture unlock + visibility handling. Idempotent. */
  install() {
    if (this.installed || !this.win) return;
    this.installed = true;
    try {
      for (const ev of UNLOCK_EVENTS) this.win.addEventListener(ev, this._unlock, { capture: true, passive: true });
      this.win.document?.addEventListener?.('visibilitychange', this._onVis);
      // iOS / iPadOS: a phone call, Siri or another app puts the context into 'interrupted'; coming back to the page
      // (pageshow / focus) resumes it (plus the next gesture, below)
      this.win.addEventListener?.('pageshow', this._onVis);
      this.win.addEventListener?.('focus', this._onVis);
    } catch { /* ignore */ }
  }

  get unlocked() { return !!this.ctx; }

  /**
   * First user gesture: create the context. The gesture listeners stay until the context actually runs — iOS Safari
   * only counts touchend / click (not pointerdown / touchstart) as activation, so a context created on pointerdown can
   * stay 'suspended' until the finger lifts. A 1-sample silent buffer is played inside the gesture (older WebKit only
   * unlocks output after something was started in a gesture).
   */
  _unlock() {
    this._playbackSession();
    if (this.ctx) {
      const st = this.ctx.state;
      if (st === 'running') { this._dropUnlock(); return; }
      if (!this.win?.document?.hidden) {
        this._primeOutput();
        const p = this.ctx.resume?.();
        if (p && typeof p.then === 'function') p.then(() => { if (this.ctx?.state === 'running') this._dropUnlock(); }, () => {});
      }
      return;
    }
    try {
      const AC = this.win?.AudioContext || this.win?.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.bgmGain = this.ctx.createGain();
      this.sfxGain = this.ctx.createGain();
      this.voiceGain = this.ctx.createGain();
      this.bgmGain.connect(this.master);
      this.sfxGain.connect(this.master);
      this.voiceGain.connect(this.master);
      this.master.connect(this.ctx.destination);
      // iOS / iPadOS: a call, Siri or another app's audio moves a running context to 'interrupted' (or 'suspended');
      // a resume without a gesture may then be refused — listen for the next gesture again (dropped once it runs).
      // Running again (the page shown again): the opening's first 行动开始 that came meanwhile is said now.
      try {
        this.ctx.addEventListener?.('statechange', () => {
          const s = this.ctx?.state;
          if (s === 'running') this._engageOnReturn();
          else if (s && s !== 'closed' && !this.win?.document?.hidden) this._armUnlock();
        });
      } catch { /* ignore */ }
      this._applyVolumes();
      this._primeOutput();
      if (this.ctx.state === 'running') this._dropUnlock();
      else {
        const p = this.ctx.resume?.();
        if (p && typeof p.then === 'function') p.then(() => { if (this.ctx?.state === 'running') this._dropUnlock(); }, () => {});
      }
      if (this.wantBgm) { const k = this.wantBgm; this.wantBgm = null; this.playBgm(k); }
    } catch (err) {
      this._warn('ctx', err);
      this.ctx = null;
    }
  }

  /**
   * iOS 16.4+ Safari: Web Audio is "ambient" by default, so the ring / silent switch mutes the whole game (no sound at all
   * for a player whose phone sits on silent). A game is media: 'playback' plays through the switch. Set before the context
   * is created / resumed; browsers without navigator.audioSession ignore it.
   */
  _playbackSession() {
    try {
      const s = this.win?.navigator?.audioSession;
      if (s && s.type !== 'playback') s.type = 'playback';
    } catch { /* ignore */ }
  }

  /** (Re-)attach the gesture listeners after the context stopped running while visible (see _unlock / _onVis). */
  _armUnlock() {
    if (!this._unlockDropped || !this.win) return;
    this._unlockDropped = false;
    try { for (const ev of UNLOCK_EVENTS) this.win.addEventListener(ev, this._unlock, { capture: true, passive: true }); } catch { /* ignore */ }
  }

  /** Remove the first-gesture listeners (the context runs). */
  _dropUnlock() {
    if (this._unlockDropped || !this.win) return;
    this._unlockDropped = true;
    try { for (const ev of UNLOCK_EVENTS) this.win.removeEventListener(ev, this._unlock, { capture: true }); } catch { /* ignore */ }
  }

  /** Start a silent 1-sample buffer (inside a user gesture: unlocks output on older WebKit). */
  _primeOutput() {
    try {
      const c = this.ctx;
      if (!c || typeof c.createBuffer !== 'function') return;
      const src = c.createBufferSource();
      src.buffer = c.createBuffer(1, 1, c.sampleRate || 44100);
      src.connect(c.destination);
      src.start ? src.start(0) : src.noteOn?.(0);
    } catch { /* ignore */ }
  }

  _onVis() {
    try {
      if (!this.ctx) return;
      // hidden: the voice stops — no line plays on a page the player does not see (the battle voice goes on: see
      // _engageOnReturn)
      if (this.win?.document?.hidden) {
        this._silenceVoice(0);
        this.ctx.suspend().catch(() => {});
      } else if (this.ctx.state !== 'running') {
        // back on the page: resume, and keep a gesture ready in case the browser wants one first (iOS after a call)
        this._armUnlock();
        this.ctx.resume().then(() => { if (this.ctx?.state === 'running') this._dropUnlock(); }, () => {});
      }
    } catch { /* ignore */ }
  }

  _warn(key, err) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    try { console.warn(`[audio] ${key} unavailable`, err?.message || err || ''); } catch { /* ignore */ }
  }

  /**
   * Set channel volumes (0..1), mute and the voice language ('off' silences voice).
   * @param {{ bgm?: number, sfx?: number, voice?: number, voiceLang?: string, muted?: boolean }} v
   */
  setVolumes(v) {
    const n = (x, d) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : d);
    this.volumes = { bgm: n(v?.bgm, this.volumes.bgm), sfx: n(v?.sfx, this.volumes.sfx), voice: n(v?.voice, this.volumes.voice),
      voiceLang: typeof v?.voiceLang === 'string' ? v.voiceLang : this.volumes.voiceLang,
      muted: typeof v?.muted === 'boolean' ? v.muted : this.volumes.muted };
    // voice off, at 0 or muted: the line playing stops and the one loading never starts
    if (!this._voiceOn()) this._silenceVoice();
    this._applyVolumes();
  }

  _applyVolumes() {
    if (!this.ctx) return;
    try {
      const t = this.ctx.currentTime;
      this.master.gain.setTargetAtTime(this.volumes.muted ? 0 : 1, t, 0.03);
      // perceptual curve
      this.bgmGain.gain.setTargetAtTime(this.volumes.bgm ** 2 * 0.55, t, 0.05);
      this.sfxGain.gain.setTargetAtTime(this.volumes.sfx ** 2 * 0.9, t, 0.03);
      this.voiceGain.gain.setTargetAtTime(this.volumes.voice ** 2, t, 0.03);
    } catch { /* ignore */ }
  }

  /**
   * Fetch + decode (cached, LRU). Resolves null on failure: a failure is logged and remembered for RETRY_MS (a missing
   * file is not fetched again on every use), then the next request fetches the file again.
   */
  _buffer(url) {
    if (!this.ctx || typeof url !== 'string' || !url) return Promise.resolve(null);
    const hit = this.buffers.get(url);
    if (hit) {
      this.buffers.delete(url);
      this.buffers.set(url, hit);
      return hit;
    }
    const p = (async () => {
      try {
        // Extension-less URL first so download managers leave the BGM alone; a host without /media/ still works.
        const media = mediaUrl(url);
        let res = await fetch(media);
        if (media !== url && !isAudioResponse(res)) {
          // Drop the unusable response (404, or a 200 that is really index.html) before trying the original URL.
          try { await res.body?.cancel?.(); } catch { /* the fallback request matters more than draining this one */ }
          res = await fetch(url);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ab = await res.arrayBuffer();
        // callback form for old WebKit (its error callback gets no error), promise form everywhere else
        return await new Promise((resolve, reject) => {
          const r = this.ctx.decodeAudioData(ab, resolve, (err) => reject(err ?? new Error('decode failed')));
          if (r && typeof r.then === 'function') r.then(resolve, reject);
        });
      } catch (err) {
        this._warn(url, err);
        setTimeout(() => { if (this.buffers.get(url) === p) this.buffers.delete(url); }, RETRY_MS);
        return null;
      }
    })();
    this.buffers.set(url, p);
    p.then((buf) => {
      // still the cached entry (not evicted or retried meanwhile): count its decoded PCM against the byte budget
      if (!buf || this.buffers.get(url) !== p) return;
      try {
        this.bufBytes.set(url, (buf.length || 0) * (buf.numberOfChannels || 1) * 4);
        this._trimBuffers();
      } catch { /* ignore */ }
    }, () => {});
    this._trimBuffers();
    return p;
  }

  /**
   * Evict least-recently-used buffers until both the entry count and the decoded-PCM budget hold. The count alone is
   * not enough once voice lines are in the cache: 180 of them are ~100 MB of PCM (a voice decodes to 0.4–1.3 MB).
   */
  _trimBuffers() {
    let bytes = 0;
    for (const n of this.bufBytes.values()) bytes += n;
    if (this.buffers.size <= BUFFER_CACHE && bytes <= BUFFER_BYTES) return;
    for (const url of [...this.buffers.keys()]) {
      if (this.buffers.size <= BUFFER_CACHE && bytes <= BUFFER_BYTES) break;
      // never evict the playing BGM (a voice keeps its own reference to its buffer)
      if (this.bgm && url === this.bgm.loopUrl) continue;
      bytes -= this.bufBytes.get(url) || 0;
      this.buffers.delete(url);
      this.bufBytes.delete(url);
    }
  }

  /** Preload a list of URLs (e.g. UI SFX) once unlocked. */
  preload(urls) {
    if (!this.ctx) return;
    for (const u of Array.isArray(urls) ? urls : []) this._buffer(u);
  }

  // ---- BGM ------------------------------------------------------------------------------------------------

  /**
   * Switch BGM (null stops). Same loop URL ⇒ no restart.
   * @param {string|null} key see bgmKeyFor
   */
  playBgm(key) {
    try {
      if (!this.ctx) { this.wantBgm = key; return; }
      const track = resolveBgm(this.getManifest(), key);
      if (this.bgm && track && this.bgm.loopUrl === track.loop) { this.bgm.key = key; return; }
      if (!track && !this.bgm) return;
      const token = ++this.bgmToken;
      this._fadeOutBgm();
      if (!track) return;
      this._startBgm(key, track, token);
    } catch (err) { this._warn('bgm', err); }
  }

  async _startBgm(key, track, token) {
    const [intro, loop] = await Promise.all([track.intro ? this._buffer(track.intro) : null, this._buffer(track.loop)]);
    if (token !== this.bgmToken || !this.ctx || !loop) return;
    try {
      const ctx = this.ctx;
      const gain = ctx.createGain();
      gain.connect(this.bgmGain);
      const t0 = ctx.currentTime + 0.05;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(1, t0 + FADE_S);
      const nodes = [];
      let loopAt = t0;
      if (intro) {
        const s = ctx.createBufferSource();
        s.buffer = intro;
        const g = ctx.createGain();
        s.connect(g); g.connect(gain);
        s.start(t0);
        const end = t0 + intro.duration;
        const xf = Math.min(XFADE_S, intro.duration / 2);
        g.gain.setValueAtTime(1, Math.max(t0, end - xf));
        g.gain.linearRampToValueAtTime(0, end);
        nodes.push({ src: s, gain: g });
        loopAt = end - xf;
      }
      const s = ctx.createBufferSource();
      s.buffer = loop;
      s.loop = true;
      const g = ctx.createGain();
      s.connect(g); g.connect(gain);
      if (intro) {
        g.gain.setValueAtTime(0, loopAt);
        g.gain.linearRampToValueAtTime(1, loopAt + Math.min(XFADE_S, intro.duration / 2));
      }
      s.start(loopAt);
      nodes.push({ src: s, gain: g });
      this.bgm = { key, loopUrl: track.loop, nodes, gain };
    } catch (err) { this._warn('bgm-start', err); }
  }

  _fadeOutBgm() {
    const cur = this.bgm;
    this.bgm = null;
    if (!cur || !this.ctx) return;
    try {
      const t = this.ctx.currentTime;
      cur.gain.gain.cancelScheduledValues(t);
      cur.gain.gain.setValueAtTime(cur.gain.gain.value, t);
      cur.gain.gain.linearRampToValueAtTime(0, t + FADE_S);
      for (const n of cur.nodes) { try { n.src.stop(t + FADE_S + 0.05); } catch { /* ignore */ } }
      setTimeout(() => { try { cur.gain.disconnect(); } catch { /* ignore */ } }, (FADE_S + 0.3) * 1000);
    } catch { /* ignore */ }
  }

  // ---- SFX ------------------------------------------------------------------------------------------------

  _play(url, { volume = 1, rate = 1, limited = false, unitKey = null } = {}) {
    if (!this.ctx || !url || this.volumes.muted || this.volumes.sfx <= 0) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (limited) { if (!this.limiter.tryAcquire(now, unitKey, url)) return; }
    else if (this.uiVoices >= 12) return;
    else this.uiVoices += 1;
    const release = () => { if (limited) this.limiter.release(url); else this.uiVoices = Math.max(0, this.uiVoices - 1); };
    this._buffer(url).then((buf) => {
      if (!buf || !this.ctx) { release(); return; }
      try {
        const s = this.ctx.createBufferSource();
        s.buffer = buf;
        s.playbackRate.value = rate;
        const g = this.ctx.createGain();
        g.gain.value = Math.max(0, Math.min(1.5, volume));
        s.connect(g); g.connect(this.sfxGain);
        let done = false;
        const end = () => { if (!done) { done = true; release(); try { g.disconnect(); } catch { /* ignore */ } } };
        s.onended = end;
        setTimeout(end, (buf.duration / rate) * 1000 + 250); // safety if onended never fires
        s.start();
      } catch { release(); }
    }, release);
  }

  /**
   * UI sound by name (sfx.ui keys). Unknown names are ignored.
   * @param {string} name
   * @param {{ volume?: number }} [o]
   */
  sfx(name, o = {}) {
    try {
      const url = this.getManifest()?.audio?.sfx?.ui?.[name];
      if (typeof url === 'string') this._play(url, { volume: o.volume ?? 0.9 });
    } catch { /* ignore */ }
  }

  /** Battle sound by name (sfx.battle keys), limited like unit sounds. */
  battle(name, o = {}) {
    try {
      const url = this.getManifest()?.audio?.sfx?.battle?.[name];
      if (typeof url === 'string') this._play(url, { volume: o.volume ?? 0.7, limited: true, unitKey: o.unitKey ?? `b:${name}` });
    } catch { /* ignore */ }
  }

  /**
   * Per-unit sound (attack/hit/skill/die/born), throttled.
   * @param {string} defId charId/tokenId/enemyId (or chess id — mapped via its spine/char id by the caller)
   * @param {'attack'|'hit'|'skill'|'die'|'born'} kind
   * @param {number|string} unitId battle unit id (cooldown key)
   * @returns {boolean} whether a unit-specific sound exists
   */
  unit(defId, kind, unitId, skillIndex) {
    try {
      const u = this.getManifest()?.audio?.sfx?.units?.[defId];
      // DESIGN §16: the equipped skill's own ON_SKILL_START sound (`skills[index]`) when the manifest has it
      const own = kind === 'skill' && Number.isInteger(skillIndex) && u?.skills ? u.skills[skillIndex] : null;
      const url = typeof own === 'string' ? own : u?.[kind];
      if (typeof url !== 'string') return false;
      if ((kind === 'attack' || kind === 'hit') && !normalAttackSfx(defId, url)) return false;
      // the official bank's mix (header): a silent roll still counts as the unit's own sound (no generic fallback)
      const mix = kind === 'skill' ? null : u?.mix?.[kind];
      if (!unitSoundPlays(mix, this.random())) return true;
      this._play(url, { volume: unitGain(kind === 'attack' || kind === 'hit' ? 0.55 : 0.8, mix), limited: true, unitKey: `${unitId}:${kind}` });
      return true;
    } catch { return false; }
  }

  // ---- operator voice -----------------------------------------------------------------------------------------

  /** Voice is on: a language, a volume above 0, not muted. */
  _voiceOn() {
    const v = this.volumes;
    return !v.muted && v.voice > 0 && v.voiceLang !== 'off';
  }

  /** A line started now is heard: the page is shown and the context runs. */
  _heard() {
    return !!this.ctx && this.ctx.state === 'running' && !this.win?.document?.hidden;
  }

  /** The voice language to play: the setting, or the first language the site has when it lacks that one. */
  _lang(m) {
    // a saved language this site lacks (voice downloaded with --voice=jp only): the first one it has
    return m?.audio?.voice?.[this.volumes.voiceLang] ? this.volumes.voiceLang : (voiceLangsIn(m)[0]?.[0] ?? null);
  }

  /**
   * Whether an operator has a line of this role in the language played (a voiceless operator — 预备干员, 盟约·辅助干员 —
   * has none): the settlement speaker and the opening's pending 行动开始 skip those.
   * @param {string} charId @param {string} role see voiceUrl
   */
  hasVoice(charId, role) {
    try {
      const m = this.getManifest();
      const lang = this._lang(m);
      return !!lang && voiceUrl(m, lang, charId, role) != null;
    } catch { return false; }
  }

  /**
   * Play an operator voice line by the battle voice rules (see the header).
   * @param {string} charId
   * @param {string} role see voiceUrl
   * @param {{ slot?: number|null, key?: string|null }} [o] slot: 作战中N (combat; combatSlot); key: the unit a 选中干员
   *   is for (gameLogic selectVoiceKey) — the same key within SELECT_SAME_MS is one line (the tap and the detail card)
   * @returns {boolean} whether the line was requested (it starts once loaded, unless dropped meanwhile)
   */
  voice(charId, role, { slot = null, key = null } = {}) {
    try {
      if (!this._voiceOn() || !this._heard()) return false;
      const now = performance.now();
      const sel = role === 'select' && key != null;
      if (sel && this.lastSelect?.key === key && now - this.lastSelect.at < SELECT_SAME_MS) return false;
      const m = this.getManifest();
      const lang = this._lang(m);
      const index = role === 'combat' && Number.isInteger(slot) && slot >= 1 ? slot - 1 : null;
      const url = lang ? voiceUrl(m, lang, charId, role, Math.random, index) : null;
      if (!url) return false;
      const rules = voiceRulesOf(m);
      if (!rules) {
        this._warn('voiceRules', new Error('data/assets.json has audio.voice but no audio.voiceRules'));
        return false;
      }
      const type = ROLE_VOICE_TYPE[role];
      const opt = type ? rules.types[type] : null;
      if (!opt || !voiceMayStart(opt, this.voiceWant ?? this.voiceNow, this.voiceLast.get(type), now)) return false;
      if (sel) this.lastSelect = { key, at: now };
      const token = ++this.voiceToken;
      this.voiceWant = { token, priority: opt.priority, type };
      this._buffer(url).then((buf) => {
        // dropped meanwhile: a newer line, a hidden page, voice turned off, another field or battle, the match left
        if (token !== this.voiceToken) return;
        this.voiceWant = null;
        if (!buf || this.ctx.state !== 'running' || !this._startVoice(buf, opt.priority, type, rules.crossfade)) return;
        // the cooldown runs from the start of a line that plays: a failed load starts none
        const at = performance.now();
        this.voiceLast.set(type, at);
        const b = this.voiceBattle;
        const entry = { role, charId, type };
        if (role === 'combat') entry.slot = index == null ? null : index + 1;
        entry.battle = b?.key ?? null;
        entry.t = b ? Math.round(at - b.at) : null;
        this.voiceLog.push(entry);
        if (this.voiceLog.length > 200) this.voiceLog.shift();
      });
      return true;
    } catch (err) {
      this._warn('voice', err);
      return false;
    }
  }

  /**
   * The settlement line (结算) of an own battle, once per battleId — across re-mounts, replays and the two moments that
   * may ask (its drawn end on screen, or its end in the runner while another field is on screen). The battle counts as
   * settled even when nothing can be heard now (a hidden page): its line is never said late.
   * @param {string} battleId @param {string} charId (settlementVoice) @param {string} role win4 | win3 | win | fail
   * @returns {boolean} whether the line was requested
   */
  settle(battleId, charId, role) {
    if (typeof battleId !== 'string' || this.settled.has(battleId)) return false;
    this.settled.add(battleId);
    if (this.settled.size > SETTLED_CAP) this.settled.delete(this.settled.values().next().value);
    return this.voice(charId, role);
  }

  /** Start a decoded line, cross-fading out the one playing. @returns {boolean} whether it started */
  _startVoice(buf, priority, type, crossfade) {
    const fade = this.voiceNow ? crossfade : 0;
    this.stopVoice(fade);
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const gain = this.ctx.createGain();
      if (fade > 0) {
        const t = this.ctx.currentTime;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(1, t + fade);
      }
      src.connect(gain);
      gain.connect(this.voiceGain);
      const cur = { src, gain, priority, type };
      // the line ended, or stopVoice stopped it
      src.onended = () => {
        if (this.voiceNow === cur) this.voiceNow = null;
        gain.disconnect();
      };
      this.voiceNow = cur;
      src.start();
      return true;
    } catch (err) {
      this.voiceNow = null;
      this._warn('voice-start', err);
      return false;
    }
  }

  /** Fade out and stop the line playing. @param {number} [fade] seconds */
  stopVoice(fade = 0.05) {
    const cur = this.voiceNow;
    if (!cur) return;
    this.voiceNow = null;
    const t = this.ctx.currentTime;
    cur.gain.gain.cancelScheduledValues(t);
    cur.gain.gain.setValueAtTime(cur.gain.gain.value, t);
    cur.gain.gain.linearRampToValueAtTime(0, t + fade);
    cur.src.stop(t + fade + 0.02);
  }

  /**
   * The line loading never starts: the moment it belongs to is over. `keepResult`: a settlement line still loading is
   * kept (another field on screen, the next phase or battle) — only the rules cut it. `keepDepart`: a 行动出发 still
   * loading is kept (a battle starting: its first deployment may come before m.public names the battle).
   * @param {{ keepResult?: boolean, keepDepart?: boolean }} [o]
   */
  _dropLoading({ keepResult = false, keepDepart = false } = {}) {
    const type = this.voiceWant?.type;
    if ((keepResult && type === 'RESULT') || (keepDepart && type === 'BATTLE_START')) return;
    this.voiceToken += 1;
    this.voiceWant = null;
  }

  /** Nothing is said for now: the line loading never starts, the one playing stops. @param {number} [fade] seconds */
  _silenceVoice(fade) {
    this._dropLoading();
    this.stopVoice(fade);
  }

  /**
   * Follow the match in the store (installAudio): another battle (voiceBattleKey) opens with its own opening and drops
   * the lines still loading for the moment before (a settlement only by the rules; the new battle's 行动出发 is its
   * own); a paused battle (solo pause) holds its opening; leaving the match drops everything loading. m.result says
   * nothing.
   * @param {any} s store state @param {any} prev the state before (null at first)
   */
  followMatch(s, prev) {
    if (!s?.match?.public) {
      // no match on screen (the lobby, the room, or a reconnect that went past the restore grace): nothing loading
      // reaches it. The battle is kept for the match's return (its opening, whether its 行动开始 was said)
      if (prev?.match?.public) {
        this._dropLoading();
        if (this.voiceBattle) this.voiceBattle.pending = null;
      }
      return;
    }
    const key = voiceBattleKey(s);
    if (key !== (this.voiceBattle?.key ?? null)) {
      // the battle's start message (its field, its first deployment) may come before the throttled m.public: a
      // 行动出发 already asked for belongs to the battle starting now
      this._dropLoading({ keepResult: true, keepDepart: key != null });
      const now = performance.now();
      this.voiceBattle = key ? { key, at: now, pausedAt: null, said: false, pending: null } : null;
      // a battle has one 行动出发: a field without a battleId (server-run combat) keeps its key across battles, so a new
      // battle opens it again — unless the field was entered for this battle (within OPENING_MS): its 行动出发 may have
      // come before m.public named the battle, and is not said twice
      if (key && !(now - this.voiceField.at < OPENING_MS)) this.voiceField.departed = false;
    }
    const b = this.voiceBattle;
    if (b && !!s.match.public.paused !== (b.pausedAt != null)) {
      if (b.pausedAt == null) b.pausedAt = performance.now();
      else {
        // the opening goes on from where the pause held it
        b.at += performance.now() - b.pausedAt;
        b.pausedAt = null;
        this._engageOnReturn();
      }
    }
  }

  /** The battle's opening is still on (a solo pause holds it); outside a battle there is none to be over. */
  _withinOpening(now) {
    const b = this.voiceBattle;
    return !b || (b.pausedAt == null ? now : b.pausedAt) < b.at + OPENING_MS;
  }

  /** The battle is opening: its first 行动开始 is still to come, and 作战中 waits for it. */
  _opening(now) {
    const b = this.voiceBattle;
    return !!b && !b.said && this._withinOpening(now);
  }

  /**
   * 行动出发 may still come: within the battle's opening, or the field on screen was entered within OPENING_MS (a 联防
   * field's first deployment may be drawn before m.public names the 联防 — the 作战's opening is long over by then).
   */
  _departOpen(now) {
    return this._withinOpening(now) || now - this.voiceField.at < OPENING_MS;
  }

  /**
   * The opening's first 行动开始 that came while the page was hidden (voiceBattle.pending), said once the page is heard
   * again — still within the opening and not paused (the context's statechange, a solo pause ending). Later engages on
   * a hidden page are simply not heard, like every sound.
   */
  _engageOnReturn() {
    const b = this.voiceBattle;
    if (!b || b.said || !b.pending || b.pausedAt != null) return;
    if (!this._withinOpening(performance.now()) || !this._heard()) return;
    const def = b.pending;
    b.pending = null;
    if (this.voice(def, 'start')) b.said = true;
  }

  // ---- battle events ------------------------------------------------------------------------------------------

  /**
   * Reset the unit map for the field entered (m.field.units = UnitInfo[]). Another field or battle on screen
   * (`${fieldId}:${battleId}`) is another voice field: the line still loading for the one before never starts (a
   * settlement does: it is the player's own battle's, whatever is on screen), the opening's pending 行动开始 is
   * forgotten, and the new field has its own 行动出发 and 选中 de-dup. The same field entered again (a re-mount, a
   * resync) changes nothing of that; a call without opts is the field ':'.
   * @param {any[]} units @param {{ fieldId?: string|null, battleId?: string|null }} [opts]
   */
  setFieldUnits(units, opts = {}) {
    this.units.clear();
    this.lastAttacker.clear();
    this.consumed.clear();
    for (const u of Array.isArray(units) ? units : []) this._track(u);
    const key = `${opts?.fieldId ?? ''}:${opts?.battleId ?? ''}`;
    if (key === this.voiceField.key) return;
    this._dropLoading({ keepResult: true });
    this.voiceField = { key, departed: false, at: typeof performance !== 'undefined' ? performance.now() : Date.now() };
    this.lastSelect = null;
    if (this.voiceBattle) this.voiceBattle.pending = null;
  }

  _track(u) {
    if (!u || typeof u !== 'object' || u.id == null) return;
    // UnitInfo.spine is the model id (charId / tokenId / enemyId) — the key of sfx.units; kind/defId pick the
    // official class sounds (operator vs summon vs device)
    this.units.set(u.id, { def: u.spine || u.defId, defId: u.defId ?? null, kind: u.kind ?? null, side: u.side, boss: !!u.boss,
      skillIndex: Number.isInteger(u.skillIndex) ? u.skillIndex : null });
  }

  /** Play a resolved battle sound for a unit event, limited like unit sounds. */
  _playUnitUrl(url, unitKey, volume = 0.8) {
    if (typeof url === 'string') this._play(url, { volume, limited: true, unitKey });
  }

  /**
   * The voice of an operator's deployment. 行动出发: the first operator of the battle's first deployment on this field
   * (`first`: its 'spawn' + 'deploy' pair), within its opening (_departOpen) — a voiceless or refused one leaves it to
   * the next; every other deployment says 部署 (a redeploy, a 突袭 jump, a 不屈 / 阿戈尔 revive; inside the opening burst
   * the 部署 lines lose to 行动出发 by the rules) unless `replay` (replayEarly: what came before the field was entered
   * is not said late).
   */
  _deployVoice(u, first, now, replay = false) {
    if (first && !this.voiceField.departed && this._departOpen(now)) {
      if (this.voice(u.def, 'depart')) this.voiceField.departed = true;
    } else if (!replay) this.voice(u.def, 'deploy');
  }

  /**
   * The early buffer of the field just entered (screens/game.js: the state-bearing tuples of its frames that came before
   * the UI entered it, which the view replays quietly — a field shown again after a catch-up must not replay the deaths,
   * deploys and 漏怪 alarm it skipped). Its spawns fill the unit map, and nothing is heard but one thing: a battle's
   * initial deployment usually comes in that buffer (the runner's first frames race the render that enters the field),
   * so its first operator's 行动出发 is said from it, as handleBattleEvents would (a 'spawn' + 'deploy' pair, within the
   * opening, once per field). No sound effect, no 部署.
   * @param {any[]} ev
   */
  replayEarly(ev) {
    if (!Array.isArray(ev)) return;
    try {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const fresh = new Set();
      for (const e of ev) {
        if (!Array.isArray(e)) continue;
        if (e[0] === 'spawn') {
          this._track(e[1]);
          if (e[1] && typeof e[1] === 'object' && e[1].id != null && e[1].side !== 'enemy') fresh.add(e[1].id);
        } else if (e[0] === 'deploy' && fresh.has(e[1]) && this.ctx) {
          const u = this.units.get(e[1]);
          if (u && u.side !== 'enemy' && unitSoundClass(u) === 'char') this._deployVoice(u, true, now, true);
        }
      }
    } catch (err) { this._warn('events', err); }
  }

  /**
   * React to `b.ev` tuples (DESIGN §8.2).
   * @param {any[]} ev
   */
  handleBattleEvents(ev) {
    if (!this.ctx || !Array.isArray(ev)) return;
    try {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      // allies whose 'spawn' came in this batch: the sim emits it right before 'deploy' only for a unit's FIRST
      // deployment (Battle._deploy), so the pair marks a first deployment (行动出发); a replayed spawn has no deploy
      const fresh = new Set();
      for (const e of ev) {
        if (!Array.isArray(e)) continue;
        const kind = e[0];
        if (kind === 'spawn') {
          this._track(e[1]);
          if (e[1] && typeof e[1] === 'object' && e[1].id != null && e[1].side !== 'enemy') fresh.add(e[1].id);
          continue;
        }
        if (kind === 'engage') {
          // 行动开始: an operator's first engage (sim ai.js performAttack, once per unit) — summons, devices and enemies
          // never speak. The rules keep it to one per wave (ENCOUNTER_ENEMY: the same priority never cuts in, 3 s
          // between two). The battle's first one ends the wait of 作战中; one that came on a hidden page within the
          // opening is said on return (_engageOnReturn)
          const u = this.units.get(e[1]);
          if (!u || u.side === 'enemy' || unitSoundClass(u) !== 'char') continue;
          const b = this.voiceBattle;
          if (b && !b.said) {
            if (!this._heard()) {
              if (this._withinOpening(now) && !b.pending && this.hasVoice(u.def, 'start')) b.pending = u.def;
            } else if (this.voice(u.def, 'start')) {
              b.said = true;
              b.pending = null;
            }
          } else this.voice(u.def, 'start');
          continue;
        }
        if (kind === 'atk') {
          // a chain bounce: its first id is the previous target, whose attack sound this is not (see header)
          if (CHAIN_KINDS.has(e[3])) { this.lastAttacker.delete(e[2]); continue; }
          const src = this.units.get(e[1]);
          if (!src) continue;
          // only a hostile attack authors the target's next impact (a heal — an ally aiming at an ally — never does)
          const tgt = this.units.get(e[2]);
          if (tgt && tgt.side !== src.side) this.lastAttacker.set(e[2], { def: src.def, at: now });
          if (!this.unit(src.def, 'attack', e[1]) && src.side === 'enemy') this.battle('enemyHit', { unitKey: `${e[1]}:atk`, volume: 0.35 });
        } else if (kind === 'dmg') {
          const by = this.lastAttacker.get(e[1]);
          if (!by || !IMPACT_TYPES.has(e[3])) continue;
          this.lastAttacker.delete(e[1]); // one impact per attack
          if (now - by.at <= IMPACT_WINDOW_MS) this.unit(by.def, 'hit', `h${e[1]}`);
        } else if (kind === 'heal') {
          this.battle('heal', { unitKey: `heal:${e[1]}`, volume: 0.35 });
        } else if (kind === 'skill' && e[2]) {
          const u = this.units.get(e[1]);
          if (u) this.unit(u.def, 'skill', e[1], u.skillIndex ?? undefined);
          // 作战中N: an operator of the field on screen (not a summon or an enemy) starting its skill N, once the
          // battle's first 行动开始 was asked for (or its opening is over)
          if (u && u.side !== 'enemy' && unitSoundClass(u) === 'char' && !this._opening(now)) {
            this.voice(u.def, 'combat', { slot: combatSlot(u.skillIndex) });
          }
        } else if (kind === 'die') {
          const u = this.units.get(e[1]);
          if (!u) continue;
          const consumed = this.consumed.delete(e[1]);
          const m = this.getManifest();
          const url = deathSfxUrl(m, u, { consumed, reason: typeof e[2] === 'string' ? e[2] : null });
          if (!url) continue;
          const own = url === m?.audio?.sfx?.units?.[u.def]?.die;
          const mix = own ? m.audio.sfx.units[u.def].mix?.die : null;
          if (!unitSoundPlays(mix, this.random())) continue;
          this._playUnitUrl(url, own ? `${e[1]}:die` : `die:${e[1]}`, own ? unitGain(0.8, mix) : 0.7);
        } else if (kind === 'leak') {
          // 漏怪: an enemy reached its goal (Battle.leak emits the sim's own EV.LEAK — it is NOT a `die`, so until now a
          // leak was completely silent, for the player's own field and for a 联防 the helpers could not hold alike).
          // The cue is the ORIGINAL Arknights stage alarm — the one an enemy entering the exit plays in any normal
          // stage (manifest `sfx.battle.leak`, bank battle.ON_ENEMY_REACHED_EXIT, file b_ui_alarmenter).
          // `LEAK_SFX_GAP_MS` keeps it to one alarm at a time (the official bank's own maxSoundAllowed 1).
          if (now - (this.lastLeakSfxAt ?? -Infinity) < LEAK_SFX_GAP_MS) continue;
          if (typeof this.getManifest()?.audio?.sfx?.battle?.leak !== 'string') continue;
          this.lastLeakSfxAt = now;
          this.battle('leak', { unitKey: 'leak', volume: 0.85 });
        } else if (kind === 'deploy') {
          const u = this.units.get(e[1]);
          if (!u || u.side === 'enemy') continue;
          // 行动出发 for the battle's first deployed operator, else 部署 (_deployVoice)
          if (unitSoundClass(u) === 'char') this._deployVoice(u, fresh.has(e[1]), now);
          const m = this.getManifest();
          const url = deploySfxUrl(m, u);
          if (!url) continue;
          const own = url === m?.audio?.sfx?.units?.[u.def]?.born;
          const mix = own ? m.audio.sfx.units[u.def].mix?.born : null;
          if (!unitSoundPlays(mix, this.random())) continue;
          this._playUnitUrl(url, own ? `${e[1]}:born` : 'deploy', own ? unitGain(0.8, mix) : 0.5);
        } else if (kind === 'fx') {
          // a summon used up by its own effect (香槟炸弹 exploding: `consumed`): its impact sound now, no death sound
          const ex = e[4];
          if (!ex || typeof ex !== 'object' || !ex.consumed || ex.id == null) continue;
          const u = this.units.get(ex.id);
          if (!u || u.side === 'enemy') continue;
          this.consumed.add(ex.id);
          if (this.consumed.size > 200) this.consumed.delete(this.consumed.values().next().value);
          this.unit(u.def, 'hit', `${ex.id}:boom`);
        } else if (kind === 'bounty') {
          this.battle('killCoin', { unitKey: 'coin' });
        }
      }
    } catch (err) { this._warn('events', err); }
  }
}

let manifestGetter = () => null;
/** App-wide audio manager. */
export const audio = new AudioManager({ getManifest: () => manifestGetter() });

/**
 * Wire the singleton to the app (called once by main.js): manifest source, settings, and the store-driven BGM and
 * battle voice (followMatch). A passed `getChess` is ignored: the settlement speaker's chess → charId step is the
 * caller's (settlementVoice charOf).
 * @param {{ getManifest: () => any, subscribe: (fn: (s:any, prev:any) => void) => () => void,
 *   getState: () => any, selectRoute: (s:any) => string,
 *   settings?: { bgm:number, sfx:number, voice?:number, voiceLang?:string, muted:boolean } }} deps
 */
export function installAudio(deps) {
  try {
    manifestGetter = typeof deps?.getManifest === 'function' ? deps.getManifest : manifestGetter;
    audio.install();
    if (deps?.settings) audio.setVolumes(deps.settings);
    if (typeof deps?.subscribe === 'function' && typeof deps?.getState === 'function') {
      const sync = (s) => {
        try {
          const pub = s.match?.public ?? null;
          // 开战 BGM: the round's own track out of bgm.combatAlts (骑士之日 / 无畏者 are fixed per round, not drawn),
          // so every client of a room hears the same one, a mid-fight re-render (or a teammate view) never switches,
          // and the next round moves on by the table. 联防 shares its round ⇒ same key ⇒ the loop keeps playing.
          audio.playBgm(bgmKeyFor(deps.selectRoute(s), pub, combatTrackFor(pub?.round)));
        } catch { /* ignore */ }
      };
      sync(deps.getState());
      audio.followMatch(deps.getState(), null);
      return deps.subscribe((s, prev) => {
        if (s.match?.public?.phase !== prev?.match?.public?.phase || s.room !== prev?.room || s.session !== prev?.session
          || s.match?.public?.bossId !== prev?.match?.public?.bossId) sync(s);
        audio.followMatch(s, prev);
      });
    }
  } catch (err) { console.warn('[audio] install failed', err); }
  return () => {};
}
