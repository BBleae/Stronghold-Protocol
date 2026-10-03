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
//   setSkill(on)                          the skill's begin clip, played out, then its stance / idle; end on stop
//   deploy()                              'Start' once, then base
//   die()                                 die clip once (callers fade out afterwards)
//   stunned (setBase('stun'))             stun clip, or the current track frozen at timeScale 0
//   setForm(roles, change)                another clip set of the skeleton (an enemy's mode), after a change clip
//   update(dt)                            advances the skeleton (autoUpdate is off: one clock for everything)
//
// As the original (Arknights' battle animation is the authority; user report: skill clips cut, sluggish and jerky
// attacks):
//   - an attack swing is its clip's strike (OnAttack, manifest `hits`) frame: a one-shot clip (`Attack`) plays at its
//     natural speed, sped up only when the attack interval is shorter than the clip (attackTimeScale), then the
//     operator is idle until the next swing; a looping clip (`…Loop`, begin / loop / end sets) runs one cycle per
//     attack. The clip is never slowed down, fast-forwarded or re-phased: in rhythm the next swing starts so that its
//     strike lands one interval after the last attack; the first one starts from the look-ahead (windUp), skipping
//     the part of its wind-up the look-ahead cannot cover;
//   - a target below the operator (more below than beside) takes the `_Down` clips (Attack_Down, Skill_Down_Begin, …);
//   - a skill's begin clip always plays out (attacks wait), an instant skill (on and off at once) still plays its
//     skill clip once, and the end clip plays out too;
//   - during a skill an attack swings the skill clip that has the strike frame: its loop, or — a stance skill whose
//     loop has none (星熊: Skill_Begin strikes at the same frame as her Attack, Skill holds the shield) — its begin
//     clip, the stance held between attacks; a skill mode (begin / loop / end) stays in its loop for the whole skill
//     and a skill loop without a strike frame (a sustained skill animation) is held at its own pace.
// Attack mode lasts until ~1.4 attack intervals without a new attack, then the end clip (if any) and base.

const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Playback speed of an attack clip (pure), as the original: a one-shot clip at its natural speed, sped up only when the
 * attack interval is shorter than the clip (`clipDur / interval`, 1–4); a looping clip one cycle per attack (0.5–4).
 * `clipDur` clip seconds, `interval` game seconds.
 */
export function attackTimeScale(clipDur, interval, loop = false) {
  const r = clipDur / Math.max(0.08, interval);
  return loop ? clampN(r, 0.5, 4) : clampN(r, 1, 4);
}

/**
 * Attack wind-up timing (pure). The clip plays at `ts` (attackTimeScale) and is started `lead` game seconds before the
 * attack, so its strike frame (`hit`, clip seconds) lands on it: from `start = hit − lead·ts`. Never faster than `ts`
 * (the original never fast-forwards a swing): with less look-ahead than the wind-up, its first part is skipped.
 * @returns {{ ts: number, start: number }}
 */
export function windUpPlan(clipDur, hit, interval, lead, loop = false) {
  const ts = attackTimeScale(clipDur, interval, loop);
  return { ts, start: Math.max(0, hit - Math.max(0, lead) * ts) };
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
    try { this.spine.stateData.defaultMix = 0.12; } catch { /* ignore */ }
    this.base = 'idle';
    this.mode = 'base';           // base | attack | skillBegin | skillCast | skillEnd | deploy | die | stun | change
    this.skillOn = false;
    this.skillOnAt = -1;
    this.attackUntil = 0;
    this.nextSwingAt = null;      // in rhythm: when the next one-shot swing starts (its strike on the next attack)
    this.down = false;            // the last target was below: `_Down` clips
    this.clock = 0;
    this.current = '';
    this.frozen = false;
    this.dead = false;
    this.interval = 1;
    // strike frames known for this skeleton (manifest `hits`; two skeletons have none: their clips keep the old rule)
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

  _play(name, loop, { timeScale = 1, mix, track = 0, start = 0 } = {}) {
    if (!this.has(name)) return false;
    const st = this.spine.state;
    const e = st.setAnimation(track, name, loop);
    if (e) {
      e.timeScale = timeScale;
      if (mix != null) e.mixDuration = mix;
      if (start) e.trackTime = start;
    }
    this.current = name;
    return true;
  }

  _queue(name, loop, timeScale = 1) {
    if (!this.has(name)) return false;
    const e = this.spine.state.addAnimation(0, name, loop, 0);
    if (e) e.timeScale = timeScale;
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
   * An attack is due in `lead` game seconds (the renderer sees it ahead in the snapshot buffer): start its swing so the
   * strike frame lands when the attack event is rendered. Returns true once started (or already swinging towards it);
   * false when it is still too early (call again next frame) or there is nothing to swing.
   */
  windUp(interval, lead, down = false) {
    if (this.dead || !(lead >= 0) || this._busy()) return false;
    const iv = clampN(Number.isFinite(interval) && interval > 0 ? interval : this.interval, 0.08, 8);
    const set = this._attackSet(!!down);
    if (!set) return false;
    const dur = this.dur(set.clip), hit = this._hitTime(set.clip, dur), ts = this._attackTs(set, dur, iv);
    const e = this.spine.state.tracks[0];
    if (this._nowClip() === set.clip && (set.loop || (e && e.trackTime < hit))) return true; // in rhythm already
    if (lead * ts > hit + 1e-6) return false;
    this.interval = iv;
    this.down = !!down;
    this.mode = 'attack';
    this.attackUntil = this.clock + lead + Math.max(0.45, iv * 1.4);
    this.nextSwingAt = null;
    this._swing(set, ts, windUpPlan(dur, hit, iv, lead, set.loop).start, 0.1);
    return true;
  }

  /** An attack happened now. `interval` = game seconds between attacks; `down` = its target is below. */
  attack(interval, down = false) {
    if (this.dead) return;
    this.interval = clampN(Number.isFinite(interval) && interval > 0 ? interval : this.interval, 0.08, 8);
    this.down = !!down;
    if (this._busy()) return;
    const set = this._attackSet();
    if (!set) return;
    const dur = this.dur(set.clip), hit = this._hitTime(set.clip, dur), ts = this._attackTs(set, dur);
    this.mode = 'attack';
    this.attackUntil = this.clock + Math.max(0.45, this.interval * 1.4);
    const e = this.spine.state.tracks[0];
    const swinging = e && this._nowClip() === set.clip && (set.loop || e.trackTime <= hit + 0.12 * ts);
    if (swinging) e.timeScale = ts;
    // not swinging (no look-ahead, e.g. a batch that arrived late): the sim already resolved the hit, so the strike
    // frame shows now
    else this._swing(set, ts, hit, 0.06);
    // in rhythm: the next swing starts so that its strike lands one interval from now
    this.nextSwingAt = set.loop ? null : this.clock + Math.max(0, this.interval - hit / ts);
  }

  /** Begin / cast / end clips of a skill and the stun / death / mode change play out: no swing over them. */
  _busy() {
    const m = this.mode;
    return m === 'stun' || m === 'die' || m === 'change' || m === 'skillBegin' || m === 'skillCast' || m === 'skillEnd';
  }

  _swing(set, ts, start, mix) {
    this._play(set.clip, set.loop, { timeScale: ts, start, mix });
    if (!set.loop) this._queue(this._baseName(), true); // the original: idle until the next swing
  }

  _attackTs(set, dur, iv = this.interval) {
    // a skill loop without any strike frame is a sustained skill animation: its own pace, not one cycle per attack
    if (set.loop && this.hitData && !this._hits(set.clip)) return 1;
    return attackTimeScale(dur, iv, set.loop);
  }

  /**
   * What an attack swings now: during a skill the skill clip that has the strike frame — its loop, or a stance skill's
   * begin clip — else (a skill loop with no strike data at all) its loop; otherwise the normal attack. `down`: the
   * `_Down` variant. Returns { clip, loop, end } or null.
   */
  _attackSet(down = this.down) {
    const sk = this.roles.skill;
    if (this.skillOn && sk && sk.via !== 'attack' && !this._skillIsBuffOnly() && this.has(sk.loop)) {
      if (this._stance()) return { clip: this._down(sk.begin, down), loop: false, end: null };
      // `Skill_2` (no begin / end, no `Loop`): one swing per attack like `Attack`; `…_Loop`: cycles
      const loop = this.has(sk.begin) || this.has(sk.end) || /loop/i.test(sk.loop);
      return { clip: this._down(sk.loop, down), loop, end: null };
    }
    const ad = this.roles.attackDown;
    const a = down && ad && this.has(ad.loop) ? ad : this.roles.attack;
    if (!a || !this.has(a.loop)) return null;
    const loop = !!(this.has(a.begin) || this.has(a.end)) || /loop/i.test(a.loop);
    return { clip: a.loop, loop, end: this.has(a.end) ? a.end : null };
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
      this.nextSwingAt = null;
      if (this.has(sk.begin)) {
        const b = this._down(sk.begin, this.down);
        this.mode = 'skillBegin';
        this._play(b, false, { mix: 0.08 });
        this.skillBeginUntil = this.clock + this.dur(b);
      } else if (this.mode === 'base') this._play(this._baseName(), true);
      return;
    }
    if (this.mode === 'skillBegin') return; // the begin clip plays out, then the end (update)
    if (this.clock - this.skillOnAt < 0.05 && this.has(sk.loop) && !this._skillIsBuffOnly()) {
      // an instant skill (on and off at once): the original still plays its skill clip once
      const c = this._down(sk.loop, this.down);
      this.mode = 'skillCast';
      this._play(c, false, { mix: 0.08 });
      this.skillCastUntil = this.clock + Math.min(this.dur(c), 3.5);
      return;
    }
    this._skillOff();
  }

  _skillOff() {
    const sk = this.roles.skill;
    this.nextSwingAt = null;
    if (sk && this.has(sk.end)) {
      const c = this._down(sk.end, this.down);
      this.mode = 'skillEnd';
      this._play(c, false, { mix: 0.08 });
      this.skillEndUntil = this.clock + this.dur(c);
    } else {
      this.mode = 'base';
      this._play(this._baseName(), true);
    }
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
      case 'attack':
        if (this.nextSwingAt != null && this.clock >= this.nextSwingAt) {
          this.nextSwingAt = null;
          const set = this.clock < this.attackUntil ? this._attackSet() : null;
          if (set && !set.loop) this._swing(set, this._attackTs(set, this.dur(set.clip)), 0, 0.06);
        }
        if (this.clock > this.attackUntil) {
          this.mode = 'base';
          this.nextSwingAt = null;
          const set = this._attackSet(), base = this._baseName();
          if (set && set.loop) {
            if (set.end) { this._play(set.end, false); this._queue(base, true); }
            else if (this._nowClip() === base) { const e = this.spine.state.tracks[0]; if (e) e.timeScale = 1; } // a skill loop: on, at its own pace
            else this._play(base, true, { mix: 0.15 });
          }
          // a one-shot swing ends in the base clip queued after it
        }
        break;
      case 'skillBegin':
        if (this.clock >= this.skillBeginUntil) {
          if (!this.skillOn) this._skillOff(); // an instant skill: begin, then end
          else { this.mode = 'base'; this._play(this._baseName(), true, { mix: 0.08 }); }
        }
        break;
      case 'skillCast':
        if (this.clock >= this.skillCastUntil) this._skillOff();
        break;
      case 'skillEnd':
        if (this.clock >= this.skillEndUntil) { this.mode = 'base'; this._play(this._baseName(), true); }
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
