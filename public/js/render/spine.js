// render/spine.js — Spine battle chibi wrapper + animation state machine (research 07 §5.4–5.5, ASSETS.md Roles).
//
// SpineActor owns one PIXI.spine.Spine built from cached skeleton data (assets.spine LRU; the instance never
// owns the atlas, so destroying it never frees shared textures). Animation roles come from the manifest
// (`anims`: idle, deploy, attack{begin,loop,end}, attackDown, skill{begin,loop,end,idle}, die, move, stun).
//
// Driving (units.js calls these; the sim is authoritative, the actor only visualises):
//   setBase('idle'|'move'|'stun')        the resting state from the snapshot anim code
//   windUp(interval, lead, down)          an attack is `lead` game s ahead: start its swing so the strike lands on it
//   attack(interval, down)                one attack happened now (b.ev 'atk')
//   setUpcoming(lead, horizon)            game s to this unit's next attack in the look-ahead (Infinity: none), and
//                                         how far the look-ahead reaches
//   setRate(rate)                         game seconds per real second (blend times are given in real seconds)
//   setSkill(on)                          the skill's begin clip, played out, then its stance / idle; end on stop
//   deploy()                              'Start' once, then base
//   die()                                 die clip once (callers fade out afterwards)
//   stunned (setBase('stun'))             stun clip, or the current track frozen at timeScale 0
//   setForm(roles, change)                another clip set of the skeleton (an enemy's mode), after a change clip
//   update(dt)                            advances the skeleton (autoUpdate is off: one clock for everything)
//
// As the original (Arknights' battle animation is the authority; user reports: skill clips cut, sluggish and jerky
// attacks, Texas sliding, swings at nothing, fast and stiff):
//   - the renderer draws the battle ~1 game s behind the sim (app.js RENDER_DELAY), so every attack is known before
//     it is shown: a swing starts only for a real attack, from its first frame, timed so that its strike frame
//     (OnAttack, manifest `hits`) lands on the attack. Nothing starts a swing on a guess;
//   - a one-shot clip (`Attack`) plays once per attack at its natural speed — sped up when the attack interval is
//     shorter, stretched at most ATTACK_STRETCH when longer (attackTimeScale) — then the operator idles until the next
//     swing; a begin / loop / end set (Texas: Attack_Start → Attack_Loop → Attack_End) plays its begin clip when the
//     unit engages, cycles the loop once per attack and, when no attack follows, ends at the cycle's last frame (the
//     end clip's first: the three are authored as one continuous motion) with the end clip;
//   - blends are given in real seconds (MIX: the battle runs at 2×) and never start before the strike frame;
//   - a target below the operator (more below than beside) takes the `_Down` clips (Attack_Down, Skill_Down_Begin, …);
//   - a skill's begin clip always plays out (attacks wait), an instant skill (on and off at once) still plays its
//     skill clip once, and the end clip plays out too;
//   - during a skill an attack swings the skill clip that has the strike frame: its loop, or — a stance skill whose
//     loop has none (星熊: Skill_Begin strikes at the same frame as her Attack, Skill holds the shield) — its begin
//     clip, the stance held between attacks; a skill mode (begin / loop / end) stays in its loop for the whole skill
//     and a skill clip without a strike frame (Texas' Skill, a sustained skill animation) is held, never swung.

const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Longest stretch of a one-shot attack clip when the attack interval is longer than the clip (×1 / 0.8 = 1.25). */
export const ATTACK_STRETCH = 0.8;

/** Blend times in REAL seconds (× the battle rate in game seconds). */
export const MIX = Object.freeze({ swingIn: 0.1, swingOut: 0.18, strike: 0.08, loopOut: 0.15, skill: 0.12, base: 0.12 });

/**
 * Playback speed of an attack clip (pure): a one-shot clip at its natural speed, sped up when the attack interval is
 * shorter than the clip (`clipDur / interval`, at most 4) and stretched at most to ATTACK_STRETCH when longer; a
 * looping clip one cycle per attack (0.5–4). `clipDur` clip seconds, `interval` game seconds.
 */
export function attackTimeScale(clipDur, interval, loop = false) {
  const r = clipDur / Math.max(0.08, interval);
  return loop ? clampN(r, 0.5, 4) : clampN(r, ATTACK_STRETCH, 4);
}

/**
 * Attack wind-up timing (pure): the swing — `begin` clip seconds of a begin clip (0 when there is none or the unit is
 * already attacking) and the clip up to its strike frame `hit` — plays at `ts` and starts `lead` game seconds before
 * the attack, so the strike lands on it: `start` clip seconds into [begin + clip] (0 = the whole wind-up). Never
 * faster than `ts`: with less look-ahead than the wind-up, its first part is skipped. `early`: still too early to
 * start (the swing would strike before the attack).
 * @returns {{ ts: number, start: number, early: boolean }}
 */
export function windUpPlan(clipDur, hit, interval, lead, loop = false, begin = 0) {
  const ts = attackTimeScale(clipDur, interval, loop);
  const wind = begin + hit, L = Math.max(0, lead) * ts;
  return { ts, start: Math.max(0, wind - L), early: L > wind + 1e-6 };
}

/** Whether any skin of the skeleton data has a clipping attachment (pixi-spine AttachmentType.Clipping = 6). */
export function hasClipping(data) {
  try {
    for (const skin of data?.skins || []) {
      const list = typeof skin.getAttachments === 'function' ? skin.getAttachments() : [];
      for (const e of list) {
        const a = e && e.attachment;
        if (a && (a.type === 6 || a.constructor?.name === 'ClippingAttachment' || ('endSlot' in a && 'vertices' in a && !('uvs' in a)))) return true;
      }
    }
  } catch { /* unknown runtime shape: assume none */ }
  return false;
}

export class SpineActor {
  /**
   * @param {any} spineData PIXI.spine skeleton data
   * @param {object} entry manifest Spine entry (anims, animations, hits, bounds, pma)
   */
  constructor(spineData, entry) {
    const P = globalThis.PIXI;
    this.entry = entry;
    this.roles = entry.anims || {};
    this.durations = entry.animations || {};
    this.spine = new P.spine.Spine(spineData);
    this.spine.autoUpdate = false;
    this.names = new Set((spineData.animations || []).map((a) => a.name));
    /**
     * Clipping attachments render as stencil masks (≈1.5 ms of GPU each per frame on tiled GPUs): such skeletons
     * are drawn through the impostor atlas while clipping is on, and clipping is switched off (unclipped slots,
     * visually negligible on battle chibis) when too many of them share a field (app.js budget).
     */
    this.clipped = hasClipping(spineData);
    this.clipOn = true;
    if (this.clipped) {
      const sp = this.spine;
      const orig = typeof sp.createGraphics === 'function' ? sp.createGraphics.bind(sp) : null;
      if (orig) sp.createGraphics = (slot, att) => { const g = orig(slot, att); if (!this.clipOn && slot.clippingContainer) { slot.clippingContainer.mask = null; g.renderable = false; } return g; };
    }
    this.rate = 2;                // game seconds per real second (setRate): blends are real-time
    try { this.spine.stateData.defaultMix = MIX.base * this.rate; } catch { /* ignore */ }
    this.base = 'idle';
    this.mode = 'base';           // base | attack | skillBegin | skillCast | skillEnd | deploy | die | stun | change
    this.skillOn = false;
    this.skillOnAt = -1;
    this.attackUntil = 0;
    this.upcoming = Infinity;     // game s to this unit's next attack in the look-ahead (setUpcoming)
    this.horizon = 0;             // how far ahead the look-ahead reaches (game s)
    this.lastStrikeAt = -Infinity;
    this.changedAt = 0;           // clock of the last clip change (units.js: impostors refresh every frame after one)
    this.down = false;            // the last target was below: `_Down` clips
    this.clock = 0;
    this.current = '';
    this.frozen = false;
    this.dead = false;
    this.interval = 1;
    // strike frames known for this skeleton (manifest `hits`; two skeletons have none: their clips keep the old rule)
    this.hitData = !!entry.hits && Object.keys(entry.hits).length > 0;
    this._play(this._idleName(), true);
    this.changedAt = -Infinity; // the first clip is no change to blend
  }

  /** Enable / disable the skeleton's clipping masks. */
  setClipping(on) {
    on = !!on;
    if (!this.clipped || on === this.clipOn) return;
    this.clipOn = on;
    for (const slot of this.spine?.skeleton?.slots || []) {
      if (!slot.clippingContainer) continue;
      slot.clippingContainer.mask = on ? slot.currentGraphics || null : null;
      // PIXI makes a released mask renderable again: the clip polygon must never draw as a white shape
      if (slot.currentGraphics) slot.currentGraphics.renderable = false;
    }
  }

  /**
   * The equipped skill (DESIGN §16 loadout, UnitInfo.skillIndex): its own Spine clip when the model has one per skill
   * index (`anims.skills`), else the primary skill's clip.
   * @param {number|undefined} index 0-based skill index
   */
  setSkillIndex(index) {
    const anims = this.entry?.anims || {};
    const clip = Number.isInteger(index) && anims.skills ? anims.skills[String(index)] : null;
    this.roles = clip ? { ...anims, skill: clip } : anims;
  }

  /**
   * Another clip set of the same skeleton — an enemy's mode (render/units.js FORMS: 掠海漂移体's 爬行模式 plays its *_02
   * clips): `roles` override the manifest roles (null = back to them); `change` = a transition clip played once first
   * (also while stunned: the pose it ends in is the one a stun then holds).
   */
  setForm(roles, change = null) {
    const anims = this.entry?.anims || {};
    this.roles = roles ? { ...anims, ...roles } : anims;
    if (this.dead) return;
    if (change && this.has(change)) {
      this.stunWanted = this.mode === 'stun';
      this.frozen = false;
      this.mode = 'change';
      this._play(change, false, { mix: 0.08 });
      this.changeUntil = this.clock + this.dur(change);
    } else if (this.mode === 'base') this._play(this._baseName(), true);
    else if (this.mode === 'stun' && this.has(this.roles.stun?.loop)) this._play(this.roles.stun.loop, true);
  }

  has(name) { return !!name && this.names.has(name); }
  dur(name) { const d = this.durations[name]; return typeof d === 'number' && d > 0 ? d : this._durFromData(name); }

  _durFromData(name) {
    try { const a = this.spine.spineData.findAnimation(name); return a && a.duration > 0 ? a.duration : 1; } catch { return 1; }
  }

  _idleName() {
    const sk = this.roles.skill;
    if (this.skillOn && sk && this.has(sk.idle)) return sk.idle;
    if (this.skillOn && this._skillPose()) return this._down(sk.loop, this.down);
    return this.has(this.roles.idle) ? this.roles.idle : (this.has('Idle') ? 'Idle' : [...this.names][0]);
  }

  /** Whether a clip has a strike frame (an OnAttack event: manifest `hits`). */
  _hits(name) {
    const h = this.entry.hits && this.entry.hits[name];
    return Array.isArray(h) && h.length > 0 && Number.isFinite(h[0]);
  }

  /** The `_Down` variant of a clip (the original swings at a target below with it) when asked for and present. */
  _down(name, down) {
    if (!down || !name) return name;
    const ad = this.roles.attackDown;
    if (ad && name === this.roles.attack?.loop && this.has(ad.loop)) return ad.loop;
    const v = name.replace(/^(Attack|Skill)(?=_|$)/, '$1_Down');
    return v !== name && this.has(v) ? v : name;
  }

  /**
   * During a skill its loop is the base clip: a skill mode (begin / loop / end: the original stays in the loop for the
   * whole skill) or a loop without a strike frame (a stance or a sustained skill animation). A lone skill clip with a
   * strike (`Skill_2`, `Attack`) is a swing like `Attack`: idle between swings.
   */
  _skillPose() {
    const sk = this.roles.skill;
    if (!sk || sk.via === 'attack' || this._skillIsBuffOnly() || !this.has(sk.loop)) return false;
    return this.has(sk.begin) || this.has(sk.end) || (this.hitData && !this._hits(sk.loop));
  }

  /** A stance skill: its begin clip strikes, its loop (no strike frame) is a pose held between attacks. */
  _stance() {
    const sk = this.roles.skill;
    return !!sk && this.hitData && sk.via !== 'attack' && !this._skillIsBuffOnly() && this.has(sk.begin) && this.has(sk.loop)
      && this._hits(sk.begin) && !this._hits(sk.loop);
  }

  /** Name of the clip on track 0 now (a queued clip may have taken over from the one `_play` started). */
  _nowClip() { return this.spine.state.tracks[0]?.animation?.name || this.current; }

  _baseName() {
    if (this.base === 'move') {
      const mv = this.roles.move;
      if (mv && this.has(mv.loop)) return mv.loop;
    }
    return this._idleName();
  }

  /** Real seconds → game seconds (the actor's clock). */
  _m(real) { return real * this.rate; }

  /** Game seconds per real second (units.js, every frame): blend times follow it. */
  setRate(rate) {
    const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
    if (r === this.rate) return;
    this.rate = r;
    try { this.spine.stateData.defaultMix = MIX.base * r; } catch { /* ignore */ }
  }

  /** The next attack of this unit in the look-ahead (game s; Infinity: none) and how far the look-ahead reaches. */
  setUpcoming(lead, horizon) {
    this.upcoming = Number.isFinite(lead) && lead >= 0 ? lead : Infinity;
    this.horizon = Number.isFinite(horizon) && horizon > 0 ? horizon : 0;
  }

  _play(name, loop, { timeScale = 1, mix, track = 0, start = 0, restart = false } = {}) {
    if (!this.has(name)) return false;
    const st = this.spine.state;
    const cur = st.tracks?.[track];
    // a looping clip already on the track (idle, a stance) keeps running: restarting it is a visible pop
    if (!restart && loop && !start && cur && cur.loop && cur.animation?.name === name && !(st.queue?.length)) {
      cur.timeScale = timeScale;
      this.current = name;
      return true;
    }
    const e = st.setAnimation(track, name, loop);
    if (e) {
      e.timeScale = timeScale;
      e.mixDuration = mix != null ? mix : this._m(MIX.base);
      if (start) e.trackTime = start;
    }
    this.current = name;
    this.changedAt = this.clock;
    return true;
  }

  /**
   * Queue a clip after the one playing: it blends in over `mix` game seconds that END with the previous clip (but
   * never before `notBefore`, clip seconds of the previous one: its strike frame).
   */
  _queue(name, loop, timeScale = 1, mix = null, notBefore = 0) {
    if (!this.has(name)) return false;
    const st = this.spine.state;
    const prev = st.tracks?.[0];
    let blend = mix != null ? mix : this._m(MIX.base);
    let delay = 0;
    if (prev && prev.animation && !prev.loop) {
      // a positive delay is the previous clip's track time (clip seconds) at which this one takes over; the blend (game
      // seconds) covers blend × its time scale of the previous clip, so it ends with it
      const dur = prev.animation.duration, pts = Math.max(0.05, prev.timeScale || 1);
      blend = Math.max(0, Math.min(blend, ((dur - notBefore) * 0.9) / pts));
      delay = Math.max(1e-6, dur - blend * pts);
    }
    const e = st.addAnimation(0, name, loop, delay);
    if (e) { e.timeScale = timeScale; e.mixDuration = blend; }
    return true;
  }

  /** Resting state from the snapshot. */
  setBase(base) {
    if (this.dead) return;
    const b = base === 'move' || base === 'stun' ? base : 'idle';
    // a mode change clip plays out first; the resting state it lands in is remembered
    if (this.mode === 'change') { this.stunWanted = b === 'stun'; if (b !== 'stun') this.base = b; return; }
    if (b === 'stun') { this._enterStun(); return; }
    if (this.mode === 'stun') this._leaveStun();
    if (b === this.base && this.mode !== 'stun') return;
    this.base = b;
    if (this.mode === 'base') this._play(this._baseName(), true);
  }

  _enterStun() {
    if (this.mode === 'stun') return;
    this.mode = 'stun';
    const s = this.roles.stun;
    if (s && this.has(s.loop)) {
      if (this.has(s.begin)) { this._play(s.begin, false); this._queue(s.loop, true); }
      else this._play(s.loop, true);
    } else {
      this.frozen = true;
    }
  }

  _leaveStun() {
    this.frozen = false;
    this.mode = 'base';
    this._play(this._baseName(), true);
  }

  /**
   * An attack is due in `lead` game seconds (the renderer sees it ahead in the snapshot buffer): start its swing — the
   * begin clip when the unit engages, then the clip — so the strike frame lands when the attack event is rendered.
   * Returns true once started (or already swinging towards it); false while it is still too early (call again next
   * frame) or there is nothing to swing.
   */
  windUp(interval, lead, down = false) {
    if (this.dead || !(lead >= 0) || this._busy()) return false;
    const iv = clampN(Number.isFinite(interval) && interval > 0 ? interval : this.interval, 0.08, 8);
    const set = this._attackSet(!!down);
    if (!set) return false;
    const dur = this.dur(set.clip), hit = this._hitTime(set.clip, dur), ts = this._attackTs(set, dur, iv);
    const now = this._nowClip(), e = this.spine.state.tracks[0];
    // already swinging towards it: a loop in rhythm or its begin clip leading into it, a one-shot before its strike
    if (set.loop && (now === set.clip || (set.begin && now === set.begin))) return true;
    if (!set.loop && now === set.clip && e && e.trackTime < hit) return true;
    const begin = set.begin && this.mode !== 'attack' ? this.dur(set.begin) : 0;
    const plan = windUpPlan(dur, hit, iv, lead, set.loop, begin);
    if (plan.early) return false;
    this.interval = iv;
    this.down = !!down;
    this.mode = 'attack';
    this.attackUntil = this.clock + lead + iv + 0.5;
    this._engage(set, ts, plan.start, begin, Math.min(this._m(MIX.swingIn), lead), hit);
    return true;
  }

  /** An attack happened now. `interval` = game seconds between attacks; `down` = its target is below. */
  attack(interval, down = false) {
    if (this.dead) return;
    this.interval = clampN(Number.isFinite(interval) && interval > 0 ? interval : this.interval, 0.08, 8);
    this.down = !!down;
    this.lastStrikeAt = this.clock;
    if (this._busy()) return;
    const set = this._attackSet();
    if (!set) return;
    const dur = this.dur(set.clip), hit = this._hitTime(set.clip, dur), ts = this._attackTs(set, dur);
    this.mode = 'attack';
    this.attackUntil = this.clock + this.interval + 0.5; // a safety net: the loop ends at its cycle (update)
    const now = this._nowClip(), e = this.spine.state.tracks[0];
    const swinging = e && ((now === set.clip && (set.loop || e.trackTime <= hit + 0.12 * ts)) || (set.begin && now === set.begin));
    if (swinging) { if (now === set.clip) e.timeScale = ts; return; }
    // no swing under way (a batch that arrived late, or right after a skill clip): the sim already resolved the hit,
    // so the strike frame shows now
    this._engage(set, ts, hit, 0, this._m(MIX.strike), hit);
  }

  /**
   * Play an attack swing from `start` clip seconds into [begin clip (`begin` s, 0: none) + the clip]; a one-shot clip
   * then hands over to the base clip after its strike frame.
   */
  _engage(set, ts, start, begin, mix, hit) {
    if (begin > 0 && start < begin) {
      this._play(set.begin, false, { timeScale: ts, start, mix, restart: true });
      this._queue(set.clip, set.loop, ts, 0); // the begin clip's last frame is the loop's first
      if (!set.loop) this._queue(this._baseName(), true, 1, this._m(MIX.swingOut), hit);
      return;
    }
    this._play(set.clip, set.loop, { timeScale: ts, start: start - begin, mix, restart: true });
    if (!set.loop) this._queue(this._baseName(), true, 1, this._m(MIX.swingOut), hit);
  }

  /** Begin / cast / end clips of a skill and the stun / death / mode change play out: no swing over them. */
  _busy() {
    const m = this.mode;
    return m === 'stun' || m === 'die' || m === 'change' || m === 'skillBegin' || m === 'skillCast' || m === 'skillEnd';
  }

  _attackTs(set, dur, iv = this.interval) {
    // a skill loop without any strike frame is a sustained skill animation: its own pace, not one cycle per attack
    if (set.loop && this.hitData && !this._hits(set.clip)) return 1;
    return attackTimeScale(dur, iv, set.loop);
  }

  /**
   * What an attack swings now: during a skill the skill clip that has the strike frame — its loop, or a stance skill's
   * begin clip — (a skill clip without any strike frame is held, never swung: null); a skill loop with no strike data
   * at all (no `hits` for the skeleton) keeps the old rule; otherwise the normal attack (its begin / end clips when it
   * has them). `down`: the `_Down` variant. Returns { begin, clip, loop, end } or null.
   */
  _attackSet(down = this.down) {
    const sk = this.roles.skill;
    if (this.skillOn && sk && sk.via !== 'attack' && !this._skillIsBuffOnly() && this.has(sk.loop)) {
      if (this._stance()) return { begin: null, clip: this._down(sk.begin, down), loop: false, end: null };
      if (this.hitData && !this._hits(sk.loop)) return null;
      // `Skill_2` (no begin / end, no `Loop`): one swing per attack like `Attack`; `…_Loop`: cycles
      const loop = this.has(sk.begin) || this.has(sk.end) || /loop/i.test(sk.loop);
      return { begin: null, clip: this._down(sk.loop, down), loop, end: null };
    }
    const ad = this.roles.attackDown;
    const a = down && ad && this.has(ad.loop) ? ad : this.roles.attack;
    if (!a || !this.has(a.loop)) return null;
    const loop = !!(this.has(a.begin) || this.has(a.end)) || /loop/i.test(a.loop);
    return { begin: this.has(a.begin) ? a.begin : null, clip: a.loop, loop, end: this.has(a.end) ? a.end : null };
  }

  // Skill loops that are pure stances (no OnAttack in the loop) are still valid attack visuals during a skill;
  // only an idle-typed skill loop is treated as buff-only.
  _skillIsBuffOnly() {
    const sk = this.roles.skill;
    return !!sk && sk.loop === this.roles.idle;
  }

  _hitTime(anim, dur) {
    const hits = this.entry.hits && this.entry.hits[anim];
    if (Array.isArray(hits) && hits.length && Number.isFinite(hits[0])) return clampN(hits[0], 0, dur);
    return dur * 0.5;
  }

  /** Skill active flag changed. */
  setSkill(on) {
    on = !!on;
    if (on === this.skillOn || this.dead) return;
    this.skillOn = on;
    if (on) this.skillOnAt = this.clock;
    const sk = this.roles.skill;
    if (!sk || this.mode === 'stun' || this.mode === 'die' || this.mode === 'change') return;
    if (on) {
      if (this.has(sk.begin)) {
        const b = this._down(sk.begin, this.down);
        this.mode = 'skillBegin';
        this._play(b, false, { mix: this._m(MIX.skill), restart: true });
        this.skillBeginUntil = this.clock + this.dur(b);
      } else if (this.mode === 'base') this._play(this._baseName(), true);
      return;
    }
    if (this.mode === 'skillBegin') return; // the begin clip plays out, then the end (update)
    if (this.clock - this.skillOnAt < 0.05 && this.has(sk.loop) && !this._skillIsBuffOnly()) {
      // an instant skill (on and off at once): the original still plays its skill clip once
      const c = this._down(sk.loop, this.down);
      this.mode = 'skillCast';
      this._play(c, false, { mix: this._m(MIX.skill), restart: true });
      this.skillCastUntil = this.clock + Math.min(this.dur(c), 3.5);
      return;
    }
    this._skillOff();
  }

  _skillOff() {
    const sk = this.roles.skill;
    if (sk && this.has(sk.end)) {
      const c = this._down(sk.end, this.down);
      this.mode = 'skillEnd';
      this._play(c, false, { mix: this._m(MIX.skill), restart: true });
      this.skillEndUntil = this.clock + this.dur(c);
    } else {
      this.mode = 'base';
      this._play(this._baseName(), true, { mix: this._m(MIX.skill) });
    }
  }

  /**
   * End an attack loop at the end of its cycle (`left` clip seconds before it): the end clip from its first frame
   * (= the loop's last), then the base; no end clip: blend to the base (a skill loop that is the base runs on).
   */
  _endLoop(set) {
    this.mode = 'base';
    const base = this._baseName();
    if (set.end) {
      this._play(set.end, false, { mix: 0, restart: true });
      this._queue(base, true, 1, this._m(MIX.loopOut));
    } else if (this._nowClip() !== base) this._play(base, true, { mix: this._m(MIX.loopOut) });
    else { const e = this.spine.state.tracks[0]; if (e) e.timeScale = 1; }
  }

  deploy() {
    if (this.dead) return;
    const d = this.roles.deploy;
    if (this.has(d) && d !== this.roles.idle) {
      this.mode = 'deploy';
      this._play(d, false, { mix: 0 });
      this.deployUntil = this.clock + this.dur(d);
    }
  }

  /** Play the death clip; returns its duration (0 when there is none). */
  die() {
    if (this.dead) return 0;
    this.dead = true;
    this.frozen = false;
    this.mode = 'die';
    const d = this.roles.die || (this.has('Die') ? 'Die' : null);
    if (d && this.has(d)) { this._play(d, false, { mix: 0.05 }); return this.dur(d); }
    return 0;
  }

  /** Revive (redeploy after death). */
  revive() {
    this.dead = false;
    this.mode = 'base';
    this.skillOn = false;
    this._play(this._baseName(), true);
  }

  update(dt) {
    this.clock += dt;
    switch (this.mode) {
      case 'attack': {
        const set = this._attackSet();
        const e = this.spine.state.tracks[0], now = this._nowClip();
        if (set && set.loop && e && now === set.clip) {
          // the original ends the loop when no attack follows — at the end of a cycle (its last frame is the end clip's
          // first), decided as the cycle wraps: no attack in the look-ahead where the next strike would be
          const dur = this.dur(set.clip), ts = Math.max(0.05, e.timeScale || 1);
          const t0 = e.trackTime % dur;
          if (t0 + dt * ts >= dur - 1e-6) {
            const nextStrike = (dur - t0 + this._hitTime(set.clip, dur)) / ts;
            const known = nextStrike <= this.horizon;
            const coming = this.upcoming <= nextStrike + Math.max(0.2, 0.25 * this.interval);
            if ((known && !coming) || this.clock > this.attackUntil) this._endLoop(set);
          }
        } else if (set && set.loop && set.begin && now === set.begin) {
          // the begin clip leads into the loop
        } else if (set && !set.loop && now === set.clip) {
          // a one-shot swing under way
        } else if (this.clock > this.attackUntil || (set && !set.loop)) {
          // a one-shot swing is over (the base clip queued after it plays), or nothing swings any more
          this.mode = 'base';
          const base = this._baseName();
          if (now !== base && !(this.spine.state.queue?.length) && !(set && !set.loop)) this._play(base, true, { mix: this._m(MIX.loopOut) });
        }
        break;
      }
      case 'skillBegin':
        if (this.clock >= this.skillBeginUntil) {
          if (!this.skillOn) this._skillOff(); // an instant skill: begin, then end
          else { this.mode = 'base'; this._play(this._baseName(), true, { mix: this._m(MIX.skill) }); }
        }
        break;
      case 'skillCast':
        if (this.clock >= this.skillCastUntil) this._skillOff();
        break;
      case 'skillEnd':
        if (this.clock >= this.skillEndUntil) { this.mode = 'base'; this._play(this._baseName(), true, { mix: this._m(MIX.skill) }); }
        break;
      case 'deploy':
        if (this.clock >= this.deployUntil) { this.mode = 'base'; this._play(this._baseName(), true); }
        break;
      case 'change':
        if (this.clock >= this.changeUntil) {
          this.mode = 'base';
          if (this.stunWanted) { this.stunWanted = false; this._enterStun(); } else this._play(this._baseName(), true);
        }
        break;
      default: break;
    }
    if (!this.frozen) {
      try { this.spine.update(dt); } catch { /* a broken skeleton must not stop the frame */ }
    }
  }

  /** Model height in skeleton units (setup-pose bounds, else a chibi default). */
  get height() {
    const b = this.entry.bounds;
    if (b && Number.isFinite(b.height) && b.height > 20) return Math.min(b.height, 900);
    return 380;
  }

  destroy() {
    try { this.spine.destroy({ children: true, texture: false, baseTexture: false }); } catch { /* ignore */ }
    this.spine = null;
  }
}
