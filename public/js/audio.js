// Audio manager (Web Audio): BGM per phase, UI SFX, per-unit battle SFX. Never throws.
//
// Sources: data/assets.json → audio (docs/ASSETS.md):
//   bgm { lobby, prep, combat, boss: { intro?, loop } }, bossBgm { [bossId]: { intro?, loop } },
//   sfx.ui { click, buy, sell, refresh, freeze, levelup, merge, equip, ready, timer, yourTurn, … },
//   sfx.battle { deploy, tokenDeploy, charDie, tokenDie?, enemyDie, enemyHit, heal, killCoin, … },
//   sfx.units { [charId|tokenId|enemyId]: { attack?, hit?, skill?, die?, born? } }.
//
// - The AudioContext is created on the first user gesture (pointerdown/keydown/touchend), so browsers
//   never block or warn; everything requested before that is remembered (BGM) or dropped (SFX).
// - Channels: master → { bgm, sfx } gains; volumes from settings (0..1) + mute. Tab hidden ⇒ suspend.
// - BGM: `intro` then `loop` (1 s crossfade); switching tracks fades out/in (0.8 s). The same loop URL
//   keeps playing across phases (prep and combat share a track).
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
// - Deaths/deployments follow the official per-class defaults (unitSoundClass): only operators play the
//   operator-knocked-down sound; summons use the token sounds; a summon used up by its own effect (fx `consumed`,
//   香槟炸弹) plays its impact sound instead of a death sound.
// - Buffers are fetched once and cached (LRU). A failed fetch/decode is logged once, plays nothing and is remembered
//   for RETRY_MS (a missing file is not requested on every use); the next request after that fetches it again.
// - Operator voice (audio.voice.<lang>.<charId>, tools/assets/voice.mjs) on its own channel and volume, one line at a
//   time, by the official battle voice rules (audio_data.json `battleVoice` → data/assets.json audio.voiceRules): every
//   line has a voice type with a priority, a cooldown (from the start of a line that plays) and whether a line of the
//   same priority replaces the one playing (`overlap`); a lower priority never cuts in; lines cross-fade (0.1 s).
//   The moments follow the official mode (a recording of 卫戍协议): buying or dragging a bench operator says nothing;
//   部署 (PLACE_CHAR) — an operator successfully deployed from the bench (prep); 选中干员 (FOCUS_CHAR) — tapping an own
//   operator during a battle phase; 作战中 (SKILL_PASSIVE_IMP) — an own operator's skill starts (every skill of this
//   mode is cast automatically), now and then: its 10 s cooldown runs start to start and one never cuts another.
// - The battle voice follows the match in the store (followMatch), like the BGM. Each own battle (voiceBattleKey: phase
//   + round) opens with the squad leader's 行动开始 (ENCOUNTER_ENEMY) at its first enemy, not before
//   minTimeDeltaForEnemyEncounter and only within its first OPENING_MS (a solo pause holds that clock); 作战中 waits for
//   it meanwhile. A hidden page, a re-mounted battle screen or a reconnect that takes the match off the screen for a
//   moment changes nothing of that (行动开始 that came due on a hidden page is said on return). Leaving the battle
//   drops its pending lines: none reaches the result screen or the next battle. The end line
//   (3星结束行动 without LP lost in the match / 非3星结束行动 / 行动失败), said by the latest battle's leader, plays once
//   per match when m.result arrives. All voice timing is real time (battles run at 2x).
// - Nothing is said on a hidden page (the context is suspended); voice off, at 0 or muted stops the line playing and
//   drops the one loading. Teammates' operators (a shared or watched field) never speak on this client.
//
// `bgmKeyFor(route, pub)` picks the track for the current screen/phase (main.js calls `audio.install()`,
// which follows the store).

import { PHASE } from '../../shared/constants.js';
import { mediaUrl } from './media.js';
import { voiceLeader } from './ui/gameLogic.js';

const MAX_VOICES = 8;
const UNIT_COOLDOWN_MS = 160;
const URL_GAP_MS = 45;
const MAX_PER_URL = 2;
const BUFFER_CACHE = 180;
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
/** The end-of-operation lines (played when the match result arrives): not a battle voice type of the official rules. */
const RESULT_VOICE = Object.freeze({ priority: 100, overlap: true, cooldown: 0 });
/**
 * The voice type of each role. 作战中 is SKILL_PASSIVE_IMP: every skill of this mode is cast automatically, and the
 * official rules' other passive type (SKILL_PASSIVE_NOR) would differ only in a priority that never decides anything
 * between two 作战中 lines (one never cuts another).
 */
const ROLE_VOICE_TYPE = Object.freeze({
  select: 'FOCUS_CHAR', deploy: 'PLACE_CHAR', combat: 'SKILL_PASSIVE_IMP', start: 'ENCOUNTER_ENEMY',
  win3: 'RESULT', win: 'RESULT', fail: 'RESULT',
});
/** The phases of a battle that opens with 行动开始 (联防 goes on with the round's battle). */
const OPENING_PHASES = new Set([PHASE.COMBAT, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]);
/** 行动开始 belongs to a battle's opening: never said later; 作战中 waits for it that long at most. */
const OPENING_MS = 15000;
/** Voice languages the settings offer, in order (tools/assets/voice.mjs VOICE_LANGS). */
export const VOICE_LANGS = Object.freeze([['cn', '中文'], ['jp', '日文']]);

// ---- pure helpers (unit-tested) -----------------------------------------------------------------------

/**
 * URL of an operator voice line (audio.voice.<lang>.<charId>.<role>; array roles pick at random).
 * @param {any} manifest data/assets.json
 * @param {string} lang 'cn' | 'jp' | 'off'
 * @param {string} charId
 * @param {string} role select | deploy | combat | start | win3 | win | fail
 * @param {() => number} [rand]
 * @returns {string|null}
 */
export function voiceUrl(manifest, lang, charId, role, rand = Math.random) {
  const v = manifest?.audio?.voice?.[lang]?.[charId]?.[role];
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return null;
  const list = v.filter((x) => typeof x === 'string');
  return list.length ? list[Math.min(list.length - 1, Math.floor(rand() * list.length))] : null;
}

/**
 * The battle voice rules of the manifest (audio.voiceRules: the official audio_data battleVoice, written next to the
 * voice lines by tools/fetch-assets.mjs) as { crossfade (s), encounterDelay (s), types: { [voiceType]: { priority,
 * overlap, cooldown (s) } } } plus RESULT; null when the manifest has none.
 */
export function voiceRulesOf(manifest) {
  const raw = manifest?.audio?.voiceRules;
  if (!Array.isArray(raw?.voiceTypeOptions)) return null;
  const types = { RESULT: RESULT_VOICE };
  for (const o of raw.voiceTypeOptions) {
    types[o.voiceType] = { priority: o.priority, overlap: o.overlapIfSamePriority, cooldown: o.cooldown };
  }
  return { crossfade: raw.crossfade, encounterDelay: raw.minTimeDeltaForEnemyEncounter, types };
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
 * The end-of-operation line of a match result (m.result): 行动失败 when lost, else 3星结束行动 only when the player lost
 * no LP over the match.
 * @param {any} result m.result @param {string|null} playerId
 * @returns {'fail'|'win'|'win3'}
 */
export function endVoiceRole(result, playerId) {
  if (!result.victory) return 'fail';
  const me = result.players.find((p) => p.playerId === playerId);
  return me?.stats.lpLost > 0 ? 'win' : 'win3';
}

/**
 * The own battle the voice follows: `${phase}:${round}` while this player fights a battle that opens with 行动开始
 * (OPENING_PHASES; not eliminated, not a spectator), else null.
 * @param {any} s store state
 * @returns {string|null}
 */
export function voiceBattleKey(s) {
  const pub = s.match.public;
  if (!pub || !OPENING_PHASES.has(pub.phase)) return null;
  const me = pub.players.find((p) => p.playerId === s.me.playerId);
  return me?.alive ? `${pub.phase}:${pub.round}` : null;
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
 * @returns {string|null} 'lobby' | 'prep' | 'combat' | 'boss' | 'boss:<bossId>' | null
 */
export function bgmKeyFor(route, pub) {
  if (route !== 'game') return route === 'title' || route === 'lobby' || route === 'room' ? 'lobby' : null;
  const phase = pub?.phase;
  if (!phase) return 'lobby';
  switch (phase) {
    case PHASE.INFO_CHECK: case PHASE.BAND_DRAFT: case PHASE.BATTLE_CHECK: case PHASE.RESULT: case PHASE.LOBBY:
      return 'lobby';
    case PHASE.COMBAT: case PHASE.UNITE:
      return 'combat';
    case PHASE.FINAL_ASSAULT:
      return pub.bossId ? `boss:${pub.bossId}` : 'boss';
    case PHASE.HIDDEN_CORE:
      return pub.hiddenBossId ? `boss:${pub.hiddenBossId}` : pub.bossId ? `boss:${pub.bossId}` : 'boss';
    default:
      return 'prep';
  }
}

/**
 * Resolve a BGM key to { intro?, loop } URLs from the manifest (boss:<id> falls back to the generic boss track).
 * @param {any} manifest
 * @param {string|null} key
 * @returns {{ intro: string|null, loop: string }|null}
 */
export function resolveBgm(manifest, key) {
  const a = manifest?.audio;
  if (!a || !key) return null;
  let t = null;
  if (key.startsWith('boss:')) t = a.bossBgm?.[key.slice(5)] || a.bgm?.boss;
  else t = a.bgm?.[key];
  if (!t || typeof t.loop !== 'string') return null;
  return { intro: typeof t.intro === 'string' ? t.intro : null, loop: t.loop };
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
   * @param {{ getManifest?: () => any, getPlayerId?: () => string|null, getLeader?: () => string|null, win?: any }} [opts]
   *   getPlayerId: the own player (only own operators speak); getLeader: the charId of the squad leader now (the
   *   rarest operator on the own board, gameLogic voiceLeader) — both from the store (installAudio)
   */
  constructor(opts = {}) {
    this.getManifest = typeof opts.getManifest === 'function' ? opts.getManifest : () => null;
    this.getPlayerId = typeof opts.getPlayerId === 'function' ? opts.getPlayerId : () => null;
    this.getLeader = typeof opts.getLeader === 'function' ? opts.getLeader : () => null;
    this.win = opts.win ?? (typeof window !== 'undefined' ? window : null);
    this.ctx = null;
    this.master = null;
    this.bgmGain = null;
    this.sfxGain = null;
    this.voiceGain = null;
    this.volumes = { bgm: 0.6, sfx: 0.8, voice: 0.8, voiceLang: 'cn', muted: false };
    this.voiceNow = null;     // { src, gain, priority } of the line playing
    this.voiceWant = null;    // { token, priority } of the line loading (it replaces the one playing)
    this.voiceToken = 0;      // the newest line requested: bumping it drops the line loading
    this.voiceLast = new Map(); // voice type → when its last line started (cooldowns)
    // the own battle the voice follows (followMatch): { key, at: when it opened (moved on by its pauses), pausedAt,
    // faced: its first enemy appeared, said: its 行动开始 is done }
    this.voiceBattle = null;
    this.encounterTimer = null; // 行动开始 coming due (_encounter)
    this.squadLeader = null;  // charId of the leader who opened the latest battle: says the match's end line
    this.voiceLog = [];       // the lines started: { role, charId, type } (latest 200; the browser E2E reads it)
    this.buffers = new Map(); // url → Promise<AudioBuffer|null> (insertion order = LRU)
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
      // Running again (the page shown again): 行动开始 that came due meanwhile is said now.
      try {
        this.ctx.addEventListener?.('statechange', () => {
          const s = this.ctx?.state;
          if (s === 'running') this._encounter();
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
      // _encounter)
      if (this.win?.document?.hidden) { this._silenceVoice(0); this.ctx.suspend().catch(() => {}); }
      else if (this.ctx.state !== 'running') {
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
    while (this.buffers.size > BUFFER_CACHE) {
      const first = this.buffers.keys().next().value;
      // never evict the playing BGM
      if (this.bgm && first === this.bgm.loopUrl) { const v = this.buffers.get(first); this.buffers.delete(first); this.buffers.set(first, v); break; }
      this.buffers.delete(first);
    }
    return p;
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
      this._play(url, { volume: kind === 'attack' || kind === 'hit' ? 0.55 : 0.8, limited: true, unitKey: `${unitId}:${kind}` });
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

  /**
   * Play an operator voice line by the battle voice rules (see the header).
   * @param {string} charId
   * @param {string} role see voiceUrl
   * @returns {boolean} whether the line was requested (it starts once loaded, unless dropped meanwhile)
   */
  voice(charId, role) {
    try {
      if (!this._voiceOn() || !this._heard()) return false;
      const m = this.getManifest();
      // a saved language this site lacks (voice downloaded with --voice=jp only): the first one it has
      const lang = m?.audio?.voice?.[this.volumes.voiceLang] ? this.volumes.voiceLang : voiceLangsIn(m)[0]?.[0];
      const url = lang ? voiceUrl(m, lang, charId, role) : null;
      if (!url) return false;
      const rules = voiceRulesOf(m);
      if (!rules) {
        this._warn('voiceRules', new Error('data/assets.json has audio.voice but no audio.voiceRules'));
        return false;
      }
      const type = ROLE_VOICE_TYPE[role];
      const opt = rules.types[type];
      if (!voiceMayStart(opt, this.voiceWant ?? this.voiceNow, this.voiceLast.get(type), performance.now())) return false;
      const token = ++this.voiceToken;
      this.voiceWant = { token, priority: opt.priority };
      this._buffer(url).then((buf) => {
        // dropped meanwhile: a newer line, a hidden page, voice turned off, the battle over
        if (token !== this.voiceToken) return;
        this.voiceWant = null;
        if (!buf || this.ctx.state !== 'running' || !this._startVoice(buf, opt.priority, rules.crossfade)) return;
        // the cooldown runs from the start of a line that plays: a failed load starts none
        this.voiceLast.set(type, performance.now());
        this.voiceLog.push({ role, charId, type });
        if (this.voiceLog.length > 200) this.voiceLog.shift();
      });
      return true;
    } catch (err) {
      this._warn('voice', err);
      return false;
    }
  }

  /** Start a decoded line, cross-fading out the one playing. @returns {boolean} whether it started */
  _startVoice(buf, priority, crossfade) {
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
      const cur = { src, gain, priority };
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

  /** The line loading never starts: the moment it belongs to is over. */
  _dropLoading() {
    this.voiceToken += 1;
    this.voiceWant = null;
  }

  /** Nothing is said for now: the line loading never starts, the one playing stops. @param {number} [fade] seconds */
  _silenceVoice(fade) {
    this._dropLoading();
    this.stopVoice(fade);
  }

  /** The moment changed: a pending 行动开始 and a line still loading belong to the one before. */
  _dropPending() {
    clearTimeout(this.encounterTimer);
    this.encounterTimer = null;
    this._dropLoading();
  }

  /**
   * Follow the match in the store (installAudio): another own battle (voiceBattleKey) drops the lines of the moment
   * before and opens with 行动开始; a paused battle (solo pause) holds its opening; m.result arriving says the end
   * line, once per match.
   * @param {any} s store state @param {any} prev the state before (null at first)
   */
  followMatch(s, prev) {
    if (!s.match.public) {
      // no match on screen (the lobby, or a reconnect that went past the restore grace): its battle is kept for the
      // match's return, so 行动开始 is still said once — after its first enemy is seen again
      if (prev?.match.public) {
        this._dropPending();
        if (this.voiceBattle) this.voiceBattle.faced = false;
      }
      return;
    }
    const key = voiceBattleKey(s);
    if (key !== (this.voiceBattle?.key ?? null)) {
      this._dropPending();
      this.voiceBattle = key ? { key, at: performance.now(), pausedAt: null, faced: false, said: false } : null;
    }
    const b = this.voiceBattle;
    if (b && !!s.match.public.paused !== (b.pausedAt != null)) {
      if (b.pausedAt == null) b.pausedAt = performance.now();
      else {
        // the opening goes on from where the pause held it
        b.at += performance.now() - b.pausedAt;
        b.pausedAt = null;
        this._encounter();
      }
    }
    if (s.match.result && !prev?.match.result) this._matchEnd(s.match.result, s.me.playerId);
  }

  /** The own battle is opening: its 行动开始 is still to come, and 作战中 waits for it. */
  _opening(now) {
    const b = this.voiceBattle;
    return !!b && !b.said && now < b.at + OPENING_MS;
  }

  /**
   * 行动开始, once it is due: the own battle has faced its first enemy and encounterDelay has passed since it opened,
   * still within its opening and not paused, and the line can be heard — one that comes due on a hidden page waits
   * for the return (the context's statechange calls this again).
   */
  _encounter() {
    const b = this.voiceBattle;
    const rules = voiceRulesOf(this.getManifest());
    if (!b || b.said || !b.faced || b.pausedAt != null || !rules) return;
    const now = performance.now();
    if (now >= b.at + OPENING_MS) return;
    const wait = b.at + rules.encounterDelay * 1000 - now;
    if (wait > 0) {
      clearTimeout(this.encounterTimer);
      this.encounterTimer = setTimeout(() => this._encounter(), wait);
      return;
    }
    if (!this._heard()) return;
    b.said = true;
    this.squadLeader = this.getLeader();
    if (this.squadLeader) this.voice(this.squadLeader, 'start');
  }

  /** The match is over (m.result): the leader who opened its latest battle says the end line, once per match. */
  _matchEnd(result, playerId) {
    const leader = this.squadLeader;
    this.squadLeader = null;
    if (leader) this.voice(leader, endVoiceRole(result, playerId));
  }

  // ---- battle events ------------------------------------------------------------------------------------------

  /** Reset the unit map for a new field (m.field.units = UnitInfo[]). */
  setFieldUnits(units) {
    this.units.clear();
    this.lastAttacker.clear();
    this.consumed.clear();
    for (const u of Array.isArray(units) ? units : []) this._track(u);
  }

  _track(u) {
    if (!u || typeof u !== 'object' || u.id == null) return;
    // UnitInfo.spine is the model id (charId / tokenId / enemyId) — the key of sfx.units; kind/defId pick the
    // official class sounds (operator vs summon vs device)
    this.units.set(u.id, { def: u.spine || u.defId, defId: u.defId ?? null, kind: u.kind ?? null, side: u.side, boss: !!u.boss,
      ownerId: u.ownerId ?? null,
      skillIndex: Number.isInteger(u.skillIndex) ? u.skillIndex : null });
  }

  /** An own unit (its owner is this player; units without an owner count as own: single-player tools, tests). */
  _own(u) {
    const me = this.getPlayerId();
    return !me || u.ownerId == null || u.ownerId === me;
  }

  /** Play a resolved battle sound for a unit event, limited like unit sounds. */
  _playUnitUrl(url, unitKey, volume = 0.8) {
    if (typeof url === 'string') this._play(url, { volume, limited: true, unitKey });
  }

  /**
   * React to `b.ev` tuples (DESIGN §8.2).
   * @param {any[]} ev
   */
  handleBattleEvents(ev) {
    if (!this.ctx || !Array.isArray(ev)) return;
    try {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      for (const e of ev) {
        if (!Array.isArray(e)) continue;
        const kind = e[0];
        if (kind === 'spawn') {
          this._track(e[1]);
          // the own battle faces its first enemy: 行动开始 comes due
          const b = this.voiceBattle;
          if (b && !b.faced && e[1]?.side === 'enemy') {
            b.faced = true;
            this._encounter();
          }
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
          // 作战中: an own operator (not a summon, an enemy or a teammate's) starting a skill, once the battle's
          // 行动开始 is said (or its opening is over)
          if (u && u.side !== 'enemy' && unitSoundClass(u) === 'char' && this._own(u) && !this._opening(now)) this.voice(u.def, 'combat');
        } else if (kind === 'die') {
          const u = this.units.get(e[1]);
          if (!u) continue;
          const consumed = this.consumed.delete(e[1]);
          const m = this.getManifest();
          const url = deathSfxUrl(m, u, { consumed, reason: typeof e[2] === 'string' ? e[2] : null });
          if (!url) continue;
          const own = url === m?.audio?.sfx?.units?.[u.def]?.die;
          this._playUnitUrl(url, own ? `${e[1]}:die` : `die:${e[1]}`, own ? 0.8 : 0.7);
        } else if (kind === 'deploy') {
          const u = this.units.get(e[1]);
          if (!u || u.side === 'enemy') continue;
          const m = this.getManifest();
          const url = deploySfxUrl(m, u);
          if (!url) continue;
          const own = url === m?.audio?.sfx?.units?.[u.def]?.born;
          this._playUnitUrl(url, own ? `${e[1]}:born` : 'deploy', own ? 0.8 : 0.5);
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
 * battle voice (followMatch; the squad leader is gameLogic voiceLeader of the own board).
 * @param {{ getManifest: () => any, getChess: (id: string) => any, subscribe: (fn: (s:any, prev:any) => void) => () => void,
 *   getState: () => any, selectRoute: (s:any) => string,
 *   settings?: { bgm:number, sfx:number, voice?:number, voiceLang?:string, muted:boolean } }} deps
 */
export function installAudio(deps) {
  try {
    manifestGetter = typeof deps?.getManifest === 'function' ? deps.getManifest : manifestGetter;
    if (typeof deps?.getState === 'function') {
      audio.getPlayerId = () => deps.getState()?.me?.playerId ?? null;
      audio.getLeader = () => voiceLeader(deps.getState().match.private, deps.getChess);
    }
    audio.install();
    if (deps?.settings) audio.setVolumes(deps.settings);
    if (typeof deps?.subscribe === 'function' && typeof deps?.getState === 'function') {
      const sync = (s) => {
        try { audio.playBgm(bgmKeyFor(deps.selectRoute(s), s.match?.public)); } catch { /* ignore */ }
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
