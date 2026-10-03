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
// - Buffers are fetched once and cached (LRU); failed fetch/decode ⇒ silent (logged once as a warning).
// - Operator voice (audio.voice.<lang>.<charId>, tools/assets/voice.mjs) on its own channel and volume, one line at a
//   time, by the official battle voice rules (audio_data.json `battleVoice` → data/assets.json audio.voiceRules,
//   BATTLE_VOICE when absent): every line has a voice type with a priority, a cooldown and whether a line of the same
//   priority replaces the one playing (`overlap`); a lower priority never cuts in; lines cross-fade (0.1 s).
//   The moments follow the official mode (a recording of 卫戍协议): buying or dragging a bench operator says nothing;
//   部署 (PLACE_CHAR) — an operator successfully deployed from the bench (prep); 行动开始 (ENCOUNTER_ENEMY) — every
//   battle, the squad leader, at its first enemy and not before minTimeDeltaForEnemyEncounter after its start, and no
//   作战中 before it in that battle (operators may cast from 3 s on: the two never collide); 作战中 — an own operator's
//   skill starts: every skill of this mode is cast automatically (技能策略), so it is SKILL_PASSIVE_IMP (SP cost ≥ 10) /
//   SKILL_PASSIVE_NOR, at most once per 10 s each; 选中干员 (FOCUS_CHAR) — tapping an own operator in battle; the end
//   line once, on the result screen (3星结束行动 without LP lost in the match / 非3星结束行动 / 行动失败; matchEnd).
//   Teammates' operators (a shared or watched field) never speak on this client.
//
// `bgmKeyFor(route, pub)` picks the track for the current screen/phase (main.js calls `audio.install()`,
// which follows the store).

import { PHASE } from '../../shared/constants.js';

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
/**
 * The official battle voice rules (audio_data.json battleVoice, 2026-10): data/assets.json audio.voiceRules overrides.
 * RESULT (the end-of-operation lines, played on the result screen — not a battle voice type) is ours.
 */
export const BATTLE_VOICE = Object.freeze({
  crossfade: 0.1, minTimeDeltaForEnemyEncounter: 3, minSpCostForImportantPassiveSkill: 10,
  voiceTypeOptions: Object.freeze([
    { voiceType: 'BATTLE_START', priority: 100, overlapIfSamePriority: true, cooldown: 0 },
    { voiceType: 'ENCOUNTER_ENEMY', priority: 90, overlapIfSamePriority: false, cooldown: 0 },
    { voiceType: 'PLACE_CHAR', priority: 20, overlapIfSamePriority: true, cooldown: 0 },
    { voiceType: 'FOCUS_CHAR', priority: 10, overlapIfSamePriority: true, cooldown: 0 },
    { voiceType: 'SKILL_ACTIVE', priority: 70, overlapIfSamePriority: true, cooldown: 0 },
    { voiceType: 'SKILL_PASSIVE_IMP', priority: 60, overlapIfSamePriority: false, cooldown: 10 },
    { voiceType: 'SKILL_PASSIVE_NOR', priority: 50, overlapIfSamePriority: false, cooldown: 10 },
    { voiceType: 'NORMAL_ATTACK', priority: 5, overlapIfSamePriority: false, cooldown: 36000 },
  ]),
});
const RESULT_VOICE = Object.freeze({ priority: 100, overlap: true, cooldown: 0 });
/** 作战中 waits for the battle's 行动开始 at most this long (a battle whose first enemy never shows up). */
const HOLD_SKILLS_MS = 15000;
/** The voice type of each role (作战中 is picked by SP cost: skillVoiceType). */
const ROLE_VOICE_TYPE = Object.freeze({ select: 'FOCUS_CHAR', deploy: 'PLACE_CHAR', start: 'ENCOUNTER_ENEMY', win3: 'RESULT', win: 'RESULT', fail: 'RESULT' });
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
 * The battle voice rules as { crossfade (s), encounterDelay (s), importantSp, types: { [voiceType]: { priority, overlap,
 * cooldown (s) } } } — the manifest's (audio.voiceRules, the official battleVoice) or BATTLE_VOICE, plus RESULT.
 */
export function voiceRulesOf(manifest) {
  const raw = manifest?.audio?.voiceRules && Array.isArray(manifest.audio.voiceRules.voiceTypeOptions) ? manifest.audio.voiceRules : BATTLE_VOICE;
  const num = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);
  const types = { RESULT: RESULT_VOICE };
  for (const o of raw.voiceTypeOptions) {
    if (o && typeof o.voiceType === 'string') types[o.voiceType] = { priority: num(o.priority, 0), overlap: !!o.overlapIfSamePriority, cooldown: num(o.cooldown, 0) };
  }
  return { crossfade: num(raw.crossfade, 0.1), encounterDelay: num(raw.minTimeDeltaForEnemyEncounter, 3), importantSp: num(raw.minSpCostForImportantPassiveSkill, 10), types };
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

/** 作战中: an automatically cast skill is an important passive one from this SP cost on (official rule). */
export function skillVoiceType(spCost, rules) {
  return Number.isFinite(spCost) && spCost >= rules.importantSp ? 'SKILL_PASSIVE_IMP' : 'SKILL_PASSIVE_NOR';
}

/** The end-of-operation line of a match: 行动失败 when lost, else 3星结束行动 only without any LP lost. */
export function endVoiceRole({ victory, lpLost }) {
  if (!victory) return 'fail';
  return lpLost > 0 ? 'win' : 'win3';
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

export class AudioManager {
  /**
   * @param {{ getManifest?: () => any, win?: any }} [opts]
   */
  constructor(opts = {}) {
    this.getManifest = typeof opts.getManifest === 'function' ? opts.getManifest : () => null;
    // (chessId, skillIndex) → the equipped skill's record ({ spCost }), for 作战中's voice type (installAudio)
    this.getSkill = typeof opts.getSkill === 'function' ? opts.getSkill : () => null;
    // the own player id: only own operators speak in battle (installAudio)
    this.getPlayerId = typeof opts.getPlayerId === 'function' ? opts.getPlayerId : () => null;
    this.win = opts.win ?? (typeof window !== 'undefined' ? window : null);
    this.ctx = null;
    this.master = null;
    this.bgmGain = null;
    this.sfxGain = null;
    this.voiceGain = null;
    this.volumes = { bgm: 0.6, sfx: 0.8, voice: 0.8, voiceLang: 'cn', muted: false };
    this.voiceNow = null;     // { src, gain, priority } of the line playing
    this.voiceWant = null;    // { token, priority } of the line loading (it replaces the one playing)
    this.voiceToken = 0;      // newest requested line (a slower buffer load never plays over a newer line)
    this.voiceLast = new Map(); // voice type → when its last line started (cooldowns)
    this.squadLeader = null;  // charId of the latest battle's squad leader (行动开始, the end line)
    this.encounter = null;    // { at } a battle started: 行动开始 is due at its first enemy
    this.holdSkillsUntil = 0; // no 作战中 before the battle's 行动开始 (performance.now ms; a safety bound)
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
      // a resume without a gesture may then be refused — listen for the next gesture again (dropped once it runs)
      try {
        this.ctx.addEventListener?.('statechange', () => {
          const s = this.ctx?.state;
          if (s && s !== 'running' && s !== 'closed' && !this.win?.document?.hidden) this._armUnlock();
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
      if (this.win?.document?.hidden) this.ctx.suspend().catch(() => {});
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
    if (this.volumes.voiceLang === 'off' || this.volumes.voice <= 0) this.stopVoice();
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

  /** Fetch + decode (cached, LRU). Resolves null on failure. */
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
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ab = await res.arrayBuffer();
        return await new Promise((resolve) => {
          try {
            const r = this.ctx.decodeAudioData(ab, resolve, () => resolve(null));
            if (r && typeof r.then === 'function') r.then(resolve, () => resolve(null));
          } catch { resolve(null); }
        });
      } catch (err) {
        this._warn(url, err);
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

  /**
   * Play an operator voice line by the battle voice rules (see the header).
   * @param {string} charId
   * @param {string} role see voiceUrl
   * @param {string} [type] voice type (ROLE_VOICE_TYPE by default)
   * @returns {boolean} whether the line was started (requested)
   */
  voice(charId, role, type = ROLE_VOICE_TYPE[role]) {
    try {
      const v = this.volumes;
      if (!this.ctx || v.muted || v.voice <= 0 || v.voiceLang === 'off' || typeof charId !== 'string') return false;
      const m = this.getManifest();
      // a saved language this site lacks (voice downloaded with --voice=jp only): the first one it has
      const lang = m?.audio?.voice?.[v.voiceLang] ? v.voiceLang : voiceLangsIn(m)[0]?.[0];
      const url = lang ? voiceUrl(m, lang, charId, role) : null;
      if (!url) return false;
      const rules = voiceRulesOf(m);
      const opt = rules.types[type] ?? { priority: 0, overlap: true, cooldown: 0 };
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (!voiceMayStart(opt, this.voiceWant ?? this.voiceNow, this.voiceLast.get(type), now)) return false;
      this.voiceLast.set(type, now);
      this.voiceLog.push({ role, charId, type });
      if (this.voiceLog.length > 200) this.voiceLog.shift();
      const token = ++this.voiceToken;
      this.voiceWant = { token, priority: opt.priority };
      const loaded = () => { if (this.voiceWant?.token === token) this.voiceWant = null; };
      this._buffer(url).then((buf) => {
        loaded();
        if (!buf || !this.ctx || token !== this.voiceToken) return;
        this._startVoice(buf, opt.priority, rules.crossfade);
      }, loaded);
      return true;
    } catch { return false; }
  }

  /** Start a decoded line, cross-fading out the one playing. */
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
      src.connect(gain); gain.connect(this.voiceGain);
      const cur = { src, gain, priority };
      const end = () => {
        if (this.voiceNow !== cur) return;
        this.voiceNow = null;
        try { gain.disconnect(); } catch { /* ignore */ }
      };
      src.onended = end;
      setTimeout(end, buf.duration * 1000 + 250); // safety if onended never fires
      this.voiceNow = cur;
      src.start();
    } catch { /* ignore */ }
  }

  /** Fade out and stop the voice line that is playing. @param {number} [fade] seconds */
  stopVoice(fade = 0.05) {
    const cur = this.voiceNow;
    if (!cur) return;
    this.voiceNow = null;
    try {
      const t = this.ctx.currentTime;
      cur.gain.gain.cancelScheduledValues?.(t);
      cur.gain.gain.setValueAtTime(cur.gain.gain.value, t);
      cur.gain.gain.linearRampToValueAtTime(0, t + fade);
      cur.src.stop(t + fade + 0.02);
    } catch { /* ignore */ }
    setTimeout(() => { try { cur.gain.disconnect(); } catch { /* ignore */ } }, fade * 1000 + 200);
  }

  /**
   * A battle of the own field starts: its squad leader (gameLogic voiceLeader) says 行动开始 at its first enemy
   * (handleBattleEvents → _encounter); 作战中 waits for it (at most HOLD_SKILLS_MS).
   * @param {string|null} leader
   */
  battleStart(leader) {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.squadLeader = typeof leader === 'string' ? leader : null;
    this.encounter = this.squadLeader ? { at: now } : null;
    this.holdSkillsUntil = this.squadLeader ? now + HOLD_SKILLS_MS : 0;
  }

  /** The battle's first enemy appeared: the leader's 行动开始, not before minTimeDeltaForEnemyEncounter. */
  _encounter() {
    const e = this.encounter;
    if (!e) return;
    this.encounter = null;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const wait = Math.max(0, e.at + voiceRulesOf(this.getManifest()).encounterDelay * 1000 - now);
    const say = () => {
      this.holdSkillsUntil = 0;
      if (this.squadLeader) this.voice(this.squadLeader, 'start');
    };
    if (wait > 0) setTimeout(say, wait); else say();
  }

  /**
   * The match ended (the result screen): the squad leader's end-of-operation line, once.
   * @param {{ victory: boolean, lpLost?: number }} r own LP lost over the match (result stats.lpLost)
   */
  matchEnd(r) {
    this.encounter = null;
    this.holdSkillsUntil = 0;
    if (this.squadLeader) this.voice(this.squadLeader, endVoiceRole(r));
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
          if (this.encounter && e[1]?.side === 'enemy') this._encounter();
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
          // 作战中: an own operator (not a summon, an enemy or a teammate's) starting a skill — not before the battle's
          // 行动开始; important or normal by its SP cost
          if (u && u.side !== 'enemy' && unitSoundClass(u) === 'char' && this._own(u) && now >= this.holdSkillsUntil) {
            const sp = this.getSkill(u.defId, u.skillIndex)?.spCost;
            this.voice(u.def, 'combat', skillVoiceType(sp, voiceRulesOf(this.getManifest())));
          }
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
 * Wire the singleton to the app (called once by main.js): manifest source, settings and store-driven BGM.
 * @param {{ getManifest: () => any, subscribe: (fn: (s:any, prev:any) => void) => () => void, getState: () => any,
 *   selectRoute: (s:any) => string, settings?: { bgm:number, sfx:number, voice?:number, voiceLang?:string, muted:boolean },
 *   getSkill?: (chessId: string, skillIndex?: number) => any }} deps
 */
export function installAudio(deps) {
  try {
    manifestGetter = typeof deps?.getManifest === 'function' ? deps.getManifest : manifestGetter;
    if (typeof deps?.getSkill === 'function') audio.getSkill = deps.getSkill;
    if (typeof deps?.getState === 'function') audio.getPlayerId = () => deps.getState()?.me?.playerId ?? null;
    audio.install();
    if (deps?.settings) audio.setVolumes(deps.settings);
    if (typeof deps?.subscribe === 'function' && typeof deps?.getState === 'function') {
      const sync = (s) => {
        try { audio.playBgm(bgmKeyFor(deps.selectRoute(s), s.match?.public)); } catch { /* ignore */ }
      };
      sync(deps.getState());
      return deps.subscribe((s, prev) => {
        if (s.match?.public?.phase !== prev?.match?.public?.phase || s.room !== prev?.room || s.session !== prev?.session
          || s.match?.public?.bossId !== prev?.match?.public?.bossId) sync(s);
      });
    }
  } catch (err) { console.warn('[audio] install failed', err); }
  return () => {};
}
