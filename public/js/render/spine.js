// render/spine.js — Spine battle chibi wrapper + animation state machine (research 07 §5.4–5.5, ASSETS.md Roles).
//
// SpineActor owns one PIXI.spine.Spine built from cached skeleton data (assets.spine LRU; the instance never
// owns the atlas, so destroying it never frees shared textures). Animation roles come from the manifest
// (`anims`: idle, deploy, attack{begin,loop,end}, attackDown, skill{begin,loop,end,idle}, die, move, stun).
//
// Driving (units.js calls these; the sim is authoritative, the actor only visualises):
//   setBase('idle'|'move'|'stun')        the resting state from the snapshot anim code
//   windUp(interval, lead, down, at, once) the attack `at` (its event time) is `lead` game s ahead: start its swing so
//                                         the strike lands on it
//   attack(interval, down, once)          one attack happened now (b.ev 'atk'); `once` (a one-off cast, style.js
//                                         PROJ[kind].once — 暴鸰's bomb drop): its clip plays once at its own speed and
//                                         is no attack rhythm
//   clipPerAttack                         (enemies, GitHub #58) every attack plays the attack clip once — at its own
//                                         speed, faster only when the attacks come quicker than the clip, never
//                                         stretched — then the resting state: the sim stands the enemy for exactly that
//                                         clip (server/sim/ai.js attackStand) and walks it on
//   setUpcoming(lead, horizon)            game s to this unit's next attack in the look-ahead (Infinity: none), and
//                                         how far the look-ahead reaches
//   setRate(rate)                         game seconds per real second (blend times are given in real seconds)
//   setSkill(on)                          the skill's begin clip, played out, then its own idle clip or its stance
//                                         between attacks (see the skill rules below); its end clip on stop
//   deploy()                              'Start' once, then base
//   die()                                 die clip once (callers fade out afterwards); a skeleton without one holds its
//                                         idle clip's first frame (GitHub issue #25: the attack loop went on)
//   stunned (setBase('stun'))             stun clip, or the current track frozen at timeScale 0
//   setForm(roles, change, end)           another clip set of the skeleton (an enemy's mode, a 傀儡师's 替身), after a change clip
//                                         (no attack cuts the change clip short); `end` = { clip, in, roles? }: a
//                                         closing clip timed to end `in` s from now (a 重生's last clip ends with the
//                                         重生), landing in `roles`
//   update(dt)                            advances the skeleton (autoUpdate is off: one clock for everything)
//
// As the original (Arknights' battle animation is the authority; user reports: skill clips cut, sluggish and jerky
// attacks, Texas sliding, swings at nothing, fast and stiff):
//   - the renderer draws the battle ~1 game s behind the sim (app.js LOOK_AHEAD), so every attack is known before
//     it is shown: a swing starts only for a real attack, from its first frame, timed so that its strike frame
//     (OnAttack, manifest `hits`) lands on the attack. Nothing starts a swing on a guess;
//   - a one-shot clip (`Attack`) plays once per attack at its natural speed — sped up when the attack interval is
//     shorter, stretched at most ATTACK_STRETCH when longer (attackTimeScale) — then the operator idles until the next
//     swing; a begin / loop / end set (Texas: Attack_Start → Attack_Loop → Attack_End) plays its begin clip when the
//     unit engages, cycles the loop once per attack at a constant speed (clip / interval: never re-phased or sped up
//     to catch an attack) and, when no attack follows where its next strike falls, ends at the cycle's last frame
//     (the end clip's first: the three are authored as one continuous motion) with the end clip;
//   - a swing returns to the resting state of the moment it ends (an enemy blocked mid-walk idles, a unit whose
//     blocker died walks on), not the one it was wound up in;
//   - blends are given in real seconds (MIX: the battle runs at 2×) and never start before the strike frame;
//   - a target below the operator (more below than beside) takes the `_Down` clips (Attack_Down, Skill_Down_Begin, …);
//   - a skill's begin clip always plays out (attacks wait), an instant skill (on and off at once) still plays its
//     skill clip once, and the end clip plays out too — except a skill that ends while the unit plays its deploy clip
//     (乌尔比安's 【返回】 is a 【移动】 redeploy): that clip plays out, then the plain idle;
//   - during a skill an attack swings the skill clip that has the strike frame: its loop, or — a stance skill whose
//     loop has none (星熊: Skill_Begin strikes at the same frame as her Attack, Skill holds the shield) — its begin
//     clip; a skill clip without a strike frame (Texas' Skill, a sustained skill animation) is held, never swung;
//   - between attacks a skill with an idle clip of its own (anims skill.idle, not its loop: 折桠's Skill_2_Idle beside
//     the Skill_2_Loop jump attack, 史尔特尔's Skill_3_Idle; community report #23) stands in that idle (_ownIdle), and
//     its end clip plays only when the skill ends. Any other skill holds its stance — its loop: a skill mode (begin /
//     loop / end), a loop without a strike frame — while its attacks go on; SPELL_GAP attack intervals after the last
//     one the spell is over (_spellOver): its end clip, then the plain idle while the skill runs on (_rest; an attack
//     may cut that end clip), and the next attack goes straight back into the stance. The skill's real end plays its
//     end clip unless the unit already stands in the plain idle (owner's decision 2026-10-05, merging 0.1.3: 星熊, 宴,
//     塞雷娅 … end a spell of attacks as 0.1.3 does).

const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Longest stretch of a one-shot attack clip when the attack interval is longer than the clip (×1 / 0.8 = 1.25). */
export const ATTACK_STRETCH = 0.8;

/** Blend times in REAL seconds (× the battle rate in game seconds). */
export const MIX = Object.freeze({ swingIn: 0.1, swingOut: 0.18, strike: 0.08, loopOut: 0.15, skill: 0.12, base: 0.12 });

/**
 * Attack intervals without an attack after which a skill without an idle clip of its own ends its spell of attacks
 * (_spellOver; 0.1.3's attack mode length).
 */
export const SPELL_GAP = 1.4;

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
    this.endClip = null;          // setForm's closing clip, played as a change clip once the clock reaches endAt,
    this.endAt = 0;               // landing in endRoles (the next form's) when given
    this.endRoles = null;
    this.skillOn = false;
    this.skillOnAt = -1;
    this.skillRest = false;       // the skill runs on in the plain idle: its spell of attacks is over (_rest)
    this.attackUntil = 0;
    this.upcoming = Infinity;     // game s to this unit's next attack in the look-ahead (setUpcoming)
    this.horizon = 0;             // how far ahead the look-ahead reaches (game s)
    this.swingClip = null;        // the one-shot swing under way: its clip (by name — the runtime pools TrackEntries) …
    this.swingHit = 0;            // … its strike frame (clip s)
    this.swingAt = null;          // … and the attack it was wound up for (the attack event's time; windUp)
    this.lastAtkClock = null;     // clock of the last attack() (update: a loop strike right at the wrap is that attack's)
    this.down = false;            // the last target was below: `_Down` clips
    this.clock = 0;
    this.current = '';
    this.frozen = false;
    this.dead = false;
    this.interval = 1;
    /**
     * Enemies (render/units.js, GitHub #58): each attack plays the attack clip once — at its own speed, faster only when
     * the attacks come quicker than the clip — and then the resting state; the sim stands the enemy for exactly that
     * clip (server/sim/ai.js attackStand). Off (operators): ATTACK_STRETCH / a loop set's rhythm.
     */
    this.clipPerAttack = false;
    // strike frames known for this skeleton (manifest `hits`); a skeleton without any keeps the old rule
    this.hitData = !!entry.hits && Object.keys(entry.hits).length > 0;
    this._play(this._idleName(), true);
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
    this.roles = this.baseRoles = clip ? { ...anims, skill: clip } : anims;
  }

  /** The unit's own roles: the manifest's with its equipped skill's clip (setSkillIndex) — what a form ends in. */
  _baseRoles() { return this.baseRoles || this.entry?.anims || {}; }

  /**
   * Another clip set of the same skeleton — an enemy's mode (render/units.js FORMS: 掠海漂移体's 爬行模式 plays its *_02
   * clips), a 傀儡师's 替身: `roles` override the unit's own roles (null = back to them — the equipped skill's clip
   * included); `change` = a transition clip played once first (also while stunned: the pose it ends in is the one a stun
   * then holds). `end` = { clip, in, roles? } (game s): a closing clip played the same way so that it ends `in` s from
   * now, landing in `roles` — a leader's 重生 ends on its last clip while the sim still holds it, and the next form
   * starts on its own clips.
   */
  setForm(roles, change = null, end = null) {
    const anims = this._baseRoles();
    this.roles = roles ? { ...anims, ...roles } : anims;
    this.endClip = null;
    if (this.dead) return;
    if (end && this.has(end.clip) && end.in > 0) {
      this.endClip = end.clip;
      this.endAt = this.clock + Math.max(0, end.in - this.dur(end.clip));
      this.endRoles = end.roles || null;
    }
    if (change && this.has(change)) this._change(change);
    else if (this.mode === 'base') this._play(this._baseName(), true);
    else if (this.mode === 'stun' && this.has(this.roles.stun?.loop)) this._play(this.roles.stun.loop, true);
  }

  /** Play a form's transition clip once; attacks and the resting state wait for it (mode 'change'). */
  _change(clip) {
    if (this.mode !== 'change') this.stunWanted = this.mode === 'stun';
    this.frozen = false;
    this.mode = 'change';
    this.swingClip = null;
    this._play(clip, false, { mix: 0.08 });
    this.changeUntil = this.clock + this.dur(clip);
  }

  has(name) { return !!name && this.names.has(name); }
  dur(name) { const d = this.durations[name]; return typeof d === 'number' && d > 0 ? d : this._durFromData(name); }

  _durFromData(name) {
    try { const a = this.spine.spineData.findAnimation(name); return a && a.duration > 0 ? a.duration : 1; } catch { return 1; }
  }

  _idleName() {
    const sk = this.roles.skill;
    if (this.skillOn && this._ownIdle()) return sk.idle;
    if (this.skillOn && !this.skillRest && this._skillPose()) return this._down(sk.loop, this.down);
    if (this.skillOn && this._loopIsIdle()) return sk.idle;
    return this.has(this.roles.idle) ? this.roles.idle : (this.has('Idle') ? 'Idle' : [...this.names][0]);
  }

  /** The skill has an idle clip of its own (anims skill.idle, not its loop: 折桠's Skill_2_Idle) to stand in. */
  _ownIdle() {
    const sk = this.roles.skill;
    return !!sk && sk.idle !== sk.loop && this.has(sk.idle);
  }

  /**
   * The skill's loop is its idle clip (蕾缪安 S2 / S3, 缇缇 S2, 信仰搅拌机 S3): after a spell of attacks it rests in that
   * loop, not the plain idle, as 0.1.3 does (_rest).
   */
  _loopIsIdle() {
    const sk = this.roles.skill;
    return !!sk && sk.idle === sk.loop && this.has(sk.idle);
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
   * During a skill its loop is the base clip — the stance, held while its attacks go on (_spellOver) unless the skill
   * has an idle clip of its own (_ownIdle): a skill mode (begin / loop / end) or a loop without a strike frame (a stance
   * or a sustained skill animation). A lone skill clip with a strike (`Skill_2`, `Attack`) is a swing like `Attack`:
   * idle between swings.
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

  /** Two clips are blending on the track (units.js: an impostor is refreshed more often then). */
  blending() { return !!this.spine?.state?.tracks?.[0]?.mixingFrom; }

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
    if (!restart && loop && !start && cur && cur.loop && cur.animation?.name === name && !cur.next) {
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
    else if (this.mode === 'attack') this._requeueBase();
  }

  /**
   * The resting state changed under a one-shot swing: the base clip queued behind it at wind-up (a blocked enemy still
   * walking, a blocker that died meanwhile) is replaced by the current one — not latched until the next change.
   */
  _requeueBase() {
    const st = this.spine.state, cur = st.tracks?.[0];
    if (!this.swingClip || !cur || cur.loop || cur.animation?.name !== this.swingClip || !cur.next || typeof st.disposeNext !== 'function') return;
    st.disposeNext(cur);
    this._queue(this._baseName(), true, 1, this._m(MIX.swingOut), this.swingHit);
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

  /** Game s until the running loop's next strike frame (its begin clip leading into it counts); null: none under way. */
  _strikeIn(set, e, now, dur, hit, ts) {
    const ets = Math.max(0.05, e.timeScale || ts);
    if (now === set.clip) return (hit - (e.trackTime % dur)) / ets;   // a little negative: the strike frame just passed
    if (set.begin && now === set.begin) return (this.dur(set.begin) - e.trackTime + hit) / ets;
    return null;
  }

  /**
   * An attack is due in `lead` game seconds (the renderer sees it ahead in the snapshot buffer): start its swing — the
   * begin clip when the unit engages, then the clip — so the strike frame lands when the attack event is rendered.
   * `at`: the attack's identity (its event time). Returns true once a swing is started for THIS attack (another target
   * of the same attack too: the caller may stop asking); false while it is too early, while an earlier attack's swing
   * runs, while a loop in rhythm will strike it anyway, or when there is nothing to swing (ask again next frame).
   * `once`: a one-off cast (no rhythm) — its clip once at its own speed.
   */
  windUp(interval, lead, down = false, at = null, once = false) {
    if (this.dead || !(lead >= 0) || this._busy()) return false;
    const set = this._swingSet(!!down, once);
    if (!set) return false;
    const dur = this.dur(set.clip), hit = this._hitTime(set.clip, dur);
    const iv = once ? dur : clampN(Number.isFinite(interval) && interval > 0 ? interval : this.interval, 0.08, 8);
    const ts = this._attackTs(set, dur, iv);
    const now = this._nowClip(), e = this.spine.state.tracks[0];
    if (set.loop && e && this.mode === 'attack') {
      // a loop whose next strike frame (or the one after) is where this attack is strikes it anyway: no restart. The
      // same tolerance as the loop's own wrap test (update): an attack the loop would not keep is wound up anew now, not
      // left to a wrap that may come after it was shown (a loop whose strike frame is early in its cycle)
      const si = this._strikeIn(set, e, now, dur, hit, ts);
      const tol = Math.max(0.1, 0.12 * iv), period = now === set.clip ? dur / Math.max(0.05, e.timeScale || ts) : Infinity;
      if (si != null && (Math.abs(si - lead) <= tol || Math.abs(si + period - lead) <= tol)) return false;
    }
    if (!set.loop && this.mode === 'attack') {
      // a one-shot swing is for the attack it was wound up for (by identity: independent of how often the actor is
      // updated), not for a later one: that one is asked again — reported as swung, it would be left to the strike-frame
      // fallback in attack(), a hard cut
      if (at != null && this.swingAt != null && Math.abs(at - this.swingAt) < 1e-3) return true;
      if (at == null && now === set.clip && e && e.trackTime < hit) return true;
      // an earlier attack's swing has not struck yet: restarting the clip would cut its strike (an interval estimate
      // that is too long opens the wind-up early) — ask again once it struck
      if (now === this.swingClip && e && !e.loop && e.trackTime < this.swingHit - 1e-6) return false;
    }
    const begin = set.begin && this.mode !== 'attack' ? this.dur(set.begin) : 0;
    const plan = windUpPlan(dur, hit, this._planInterval(set, dur, iv), lead, set.loop, begin);
    if (plan.early) return false;
    if (!once) this.interval = iv;
    this.down = !!down;
    this.mode = 'attack';
    this.skillRest = false;   // a skill resting after a spell of attacks (_rest): straight back into its stance / loop
    // a one-shot swing is over with its clip (its queued base clip takes over; update() plays the base then at the
    // latest), a loop at its cycle — this is the safety net for both
    this.attackUntil = this.clock + lead + (set.loop ? iv + 0.5 : Math.max(0, dur - hit) / Math.max(0.05, ts));
    this._engage(set, ts, plan.start, begin, Math.min(this._m(MIX.swingIn), lead), hit);
    this.swingAt = at;
    return true;
  }

  /**
   * An attack happened now. `interval` = game seconds between attacks; `down` = its target is below; `once` = a one-off
   * cast (no rhythm: the interval stays, its clip plays once at its own speed).
   */
  attack(interval, down = false, once = false) {
    if (this.dead) return;
    if (!once) this.interval = clampN(Number.isFinite(interval) && interval > 0 ? interval : this.interval, 0.08, 8);
    this.down = !!down;
    this.lastAtkClock = this.clock;
    const rested = this.skillRest;
    this.skillRest = false;     // the spell of attacks goes on: the skill's stance again (_rest)
    if (this._busy()) return;   // a skill / form change clip plays out
    const set = this._swingSet(this.down, once);
    if (!set) {
      // nothing to swing (a skill loop without a strike frame: 宴's Skill_Loop): straight back into the stance
      if (rested && this.mode === 'base') this._play(this._baseName(), true, { mix: this._m(MIX.skill) });
      return;
    }
    const dur = this.dur(set.clip), hit = this._hitTime(set.clip, dur), ts = this._attackTs(set, dur, once ? dur : this.interval);
    this.mode = 'attack';
    // a safety net: the loop ends at its cycle, a one-shot with its clip (update)
    this.attackUntil = this.clock + (set.loop ? this.interval + 0.5 : Math.max(0, dur - hit) / Math.max(0.05, ts));
    const now = this._nowClip(), e = this.spine.state.tracks[0];
    // a swing under way towards this attack: the set's clip before its strike frame, its loop or begin clip — or the
    // one-shot wound up before the set changed (a skill without a begin clip began meanwhile: it strikes this attack)
    const swinging = e && ((now === set.clip && (set.loop || e.trackTime <= hit + 0.12 * ts)) || (set.begin && now === set.begin)
      || (this.swingClip && now === this.swingClip && !e.loop && e.trackTime <= this.swingHit + 0.12 * Math.max(0.05, e.timeScale || 1)));
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
    this.swingClip = set.loop ? null : set.clip;
    this.swingHit = hit;
    this.swingAt = null;
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
    return attackTimeScale(dur, this._planInterval(set, dur, iv), set.loop);
  }

  /**
   * The interval a swing is timed for: an enemy's clip (clipPerAttack, GitHub #58) is never stretched over a longer
   * interval — its own speed, sped up only when the attacks come quicker (the sim stands it for exactly that clip).
   */
  _planInterval(set, dur, iv) {
    return this.clipPerAttack && !set.loop ? Math.min(iv, dur) : iv;
  }

  /**
   * What a swing plays: the attack set (_attackSet); a one-off cast (`once`) and an enemy's attack (clipPerAttack) play
   * the clip once per attack — a begin / loop / end set as its clip alone.
   */
  _swingSet(down, once = false) {
    const set = this._attackSet(down);
    if (set && set.loop && (once || this.clipPerAttack)) return { begin: null, clip: set.clip, loop: false, end: null };
    return set;
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

  // A skill whose loop is just the idle clip shows nothing (no pose, no swing). Pure-stance loops with no strike frame
  // are held only for skeletons with hit data; hit-less skeletons keep the old rule.
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
    const rested = this.skillRest;
    this.skillRest = false;
    const sk = this.roles.skill;
    if (!sk || this.mode === 'stun' || this.mode === 'die' || this.mode === 'change') return;
    // a skill that ends as the unit (re)deploys — 乌尔比安's 【返回】 is a 【移动】 (sim Battle.moveRedeploy) right before
    // his S3's 'skill' off event — lets the deploy clip play out (then the plain idle) instead of cutting it with the End
    if (!on && this.mode === 'deploy') return;
    if (on) {
      if (this.has(sk.begin)) {
        const b = this._down(sk.begin, this.down);
        this.mode = 'skillBegin';
        this._play(b, false, { mix: this._m(MIX.skill), restart: true });
        this.skillBeginUntil = this.clock + this.dur(b);
        // nothing queued behind it: update() then plays the base of that moment (_baseName) — the skill's own idle
        // clip (community report #23: no jump attack without an attack) or its stance
      } else if (this.mode === 'base') this._play(this._baseName(), true);
      return;
    }
    // the begin clip plays out, then the end (update); a unit back in the plain idle after its last spell of attacks
    // (_rest) played the end clip then: no second one (a skill whose loop is its idle rests in that loop: it ends again)
    if (this.mode === 'skillBegin' || (rested && !this._loopIsIdle())) return;
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
   * The spell of attacks of a running skill without an idle clip of its own is over: it holds its stance and its last
   * attack (one since the skill began) is SPELL_GAP attack intervals ago.
   */
  _spellOver() {
    return this.skillOn && !this.skillRest && this.lastAtkClock != null && this.lastAtkClock >= this.skillOnAt
      && this.clock - this.lastAtkClock > SPELL_GAP * this.interval && !this._ownIdle() && this._skillPose();
  }

  /**
   * After a spell of attacks (_spellOver): the skill's end clip, then the plain idle while the skill runs on — the end
   * clip in mode 'base', so the next attack's swing may cut it (attack / windUp go back into the stance).
   */
  _rest() {
    this.skillRest = true;
    const sk = this.roles.skill, base = this._baseName();
    if (this.has(sk.end)) {
      this._play(this._down(sk.end, this.down), false, { mix: this._m(MIX.skill), restart: true });
      this._queue(base, true, 1, this._m(MIX.skill));
    } else this._play(base, true, { mix: this._m(MIX.loopOut) });
  }

  /**
   * End an attack loop at the end of its cycle: the end clip from its first frame
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
      this.deployAt = this.clock;
      this.deployUntil = this.clock + this.dur(d);
    }
  }

  /** Seconds into the deploy clip while it plays, else null (a model swapped mid-deploy carries it over: units.js). */
  deployElapsed() {
    return this.mode === 'deploy' ? Math.max(0, this.clock - (this.deployAt || 0)) : null;
  }

  /** The skeleton's death clip, or null. */
  dieClip() {
    const d = this.roles.die || (this.has('Die') ? 'Die' : null);
    return d && this.has(d) ? d : null;
  }

  /**
   * Play the death clip; returns its duration (0 when there is none). A skeleton without one (131 of the 135 Back
   * models, GitHub issue #25; a few idle-only summons and enemies) stops whatever looped — an attack, a skill or the idle —
   * and holds the first frame of its idle clip (frozen when it has none either) [ASSUMED look]: a dead unit never goes on attacking. A
   * knocked-out operator shows its fall with the Front model instead (render/units.js _wantsBack).
   */
  die() {
    if (this.dead) return 0;
    this.dead = true;
    this.frozen = false;
    this.mode = 'die';
    this.swingClip = null;
    const d = this.dieClip();
    if (d) { this._play(d, false, { mix: 0.05 }); return this.dur(d); }
    const idle = this.has(this.roles.idle) ? this.roles.idle : this.has('Idle') ? 'Idle' : null;
    if (idle) this._play(idle, false, { mix: 0.1, timeScale: 0, restart: true });
    else this.frozen = true;
    return 0;
  }

  /** Revive (redeploy after death). */
  revive() {
    this.dead = false;
    this.frozen = false;
    this.mode = 'base';
    this.skillOn = false;
    this._play(this._baseName(), true);
  }

  update(dt) {
    this.clock += dt;
    if (this.endClip && this.clock >= this.endAt) {
      const clip = this.endClip;
      this.endClip = null;
      if (this.endRoles) this.roles = { ...this._baseRoles(), ...this.endRoles };
      if (!this.dead) this._change(clip);
    }
    switch (this.mode) {
      case 'attack': {
        const set = this._swingSet(this.down);
        const e = this.spine.state.tracks[0], now = this._nowClip();
        if (set && set.loop && e && now === set.clip) {
          // the original ends the loop when no attack follows — at the end of a cycle (its last frame is the end clip's
          // first), decided as the cycle wraps: no attack in the look-ahead where the next strike would be. The loop
          // plays at its constant speed (clip / interval) and is never re-phased: an attack that is not where the next
          // strike falls (after a stun, a pause without target, a slower rhythm) ends it, and windUp engages that
          // attack anew through the begin clip — as the original does after a stun
          const dur = this.dur(set.clip), ts = Math.max(0.05, e.timeScale || 1);
          const t0 = e.trackTime % dur;
          if (t0 + dt * ts >= dur - 1e-6) {
            const nextStrike = (dur - t0 + this._hitTime(set.clip, dur)) / ts;
            const known = nextStrike <= this.horizon;
            // the next attack is where the next strike falls — or that strike is right at the wrap (a strike frame at the
            // start of the cycle) and belongs to the attack shown just before it
            const tol = Math.max(0.1, 0.12 * this.interval);
            const coming = (this.upcoming <= this.horizon && Math.abs(this.upcoming - nextStrike) <= tol)
              || (this.lastAtkClock != null && nextStrike + Math.max(0, this.clock - dt - this.lastAtkClock) <= tol + dt);
            if ((known && !coming) || this.clock > this.attackUntil) this._endLoop(set);
          }
        } else if (set && set.loop && set.begin && now === set.begin) {
          // the begin clip leads into the loop
        } else if (this.swingClip && e && !e.loop && now === this.swingClip && this.clock <= this.attackUntil) {
          // a one-shot swing under way (also when the attack set changed meanwhile: a skill began)
        } else if (this.clock > this.attackUntil || this.swingClip || (set && !set.loop)) {
          // the swing is over, or what plays is no attack clip of the current set (a loop left running when a
          // single-clip skill began): the base clip of NOW, whatever was queued at wind-up
          this.mode = 'base';
          this.swingClip = null;
          this.swingAt = null;
          const base = this._baseName();
          if (now !== base) this._play(base, true, { mix: this._m(MIX.loopOut) });
        }
        break;
      }
      case 'base':
        if (this._spellOver()) this._rest();
        break;
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
    // the clip on screen: a queued clip (the base after a swing, a loop after its begin clip) takes over by itself
    const shown = this.spine.state.tracks?.[0]?.animation?.name;
    if (shown) this.current = shown;
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
