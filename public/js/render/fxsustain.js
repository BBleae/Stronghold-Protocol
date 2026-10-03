// public/js/render/fxsustain.js — sim fx that LAST (FxSystem, render/fx.js, hands them over from simFx).
//
// The sim emits most lasting effects ONCE (at a skill's start, when a buff lands, when a drone samples its position),
// and the renderer used to draw every one as a 0.5–4 s flash: 余's S3 fire wall vanished after 2 s of a 41 s skill,
// 银灰's 真银斩 stance, 刺玫's taunt, 焰影苇草's fireballs … flashed once, links and channelled beams lasted 0.4 s,
// 荒芜拉普兰德's drones were three 'summon' pillars a second. Each such fx now becomes ONE record keyed by kind and unit,
// drawn until its end signal (FX audit, 2026-10):
//   'skill'  — the caster's skill ends (['skill', id, 0], also sent on death / retreat), or its snapshot flag drops;
//   'status' — every status the unit gained in the same batch of events as the fx went off again (['status', id, k, 0]);
//   'time'   — the event's `duration` / `dur` (game s) ran out;
//   'life'   — the anchor unit dies (or the battle view clears);
//   'manual' — a later event ends it (影哨: its recall).
// Every record also ends when its anchor dies or the view clears (FxSystem.clear), and fades in / out.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d) => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : d; };
const TAU = Math.PI * 2;
const FADE_IN = 0.35, FADE_OUT = 0.4;
/** Safety caps (real s) for records whose end event could be lost. */
const MAX_SKILL = 600, MAX_STATUS = 900;
/** Real s a 'skill' record survives its caster's snapshot SKILL flag being off (units.js reconciles after 0.3 s). */
const FLAG_GRACE = 0.45;
const MAX_SUSTAINS = 160;

/** A unit-state look ('aura'): `until` 'auto' = status → duration → skill (Sustains._policy). */
const AURA = (o) => Object.freeze({ look: 'aura', until: 'auto', ...o });

/**
 * Lasting sim fx kinds → look. 'wall': a burning line across the field 0.5 tile in front of the caster (余 S3 灶里乾坤);
 * 'field': a ground field of radius `r` centred on the caster (`centred`: only when the event is on the caster);
 * 'aura': a state on a unit — `ring` ground decal (`spin` rad/s, `pulse` Hz), `glow` chest glow, `bubble` shield
 * bubble, `orbit` sprites circling it, `head` mark above it, `rise` particles (`rate` /s), `ripple` rings every n s,
 * `mid` also when emitted in the middle of the unit's skill (else only at its start), `cap` at most that many game s
 * (a match-long passive — 能天使's talent blessing, 临光's stand — is announced, not looped forever); 'link': lines between units;
 * 'beam': a channelled beam (`dur`); 'drones' / 'motes': virtual drones / orbiting motes; 'sentry': 伊内丝's 影哨;
 * 'tiles': 圣聆初雪's snow; 'vortex': a turning wind (歌蕾蒂娅 S3, 异客 S3); 'enemyAura': an enemy's aura ring.
 */
export const SUSTAINED = Object.freeze({
  firewall: { look: 'wall', until: 'skill' },
  tide: { look: 'field', until: 'skill', r: 2.2, centred: true },
  healField: { look: 'field', until: 'skill', r: 1.6, centred: true },
  coldWind: { look: 'field', until: 'skill', r: 2.5, centred: true },
  snow: { look: 'field', until: 'skill', r: 2.2, centred: true },
  // unit states
  truesilver: AURA({ ring: 'hex', spin: 0.8, glow: 0.28, rise: 'spark', rate: 3 }),
  overclock: AURA({ ring: 'ring', pulse: 1.4, glow: 0.26, rise: 'chevron', rate: 2.5 }),
  overload: AURA({ ring: 'soft', pulse: 2.6, glow: 0.4, rise: 'spark', rate: 5, mid: true }),
  jungleSoul: AURA({ ring: 'soft', glow: 0.24, rise: 'dot', rate: 4 }),
  devour: AURA({ ring: 'hex', spin: -0.6, glow: 0.34, rise: 'dot', rate: 3 }),
  shell: AURA({ bubble: 0.22 }),
  sandChains: AURA({ ring: 'ring', orbit: { n: 3, tex: 'shard', r: 0.5, spd: 1.6, size: 0.2 } }),
  sandChainsCharged: AURA({ ring: 'hex', glow: 0.26, orbit: { n: 4, tex: 'shard', r: 0.55, spd: 2, size: 0.22 } }),
  bloodBattle: AURA({ ring: 'soft', pulse: 1, glow: 0.3, rise: 'dot', rate: 2 }),
  ember: AURA({ glow: 0.16, orbit: { n: 3, tex: 'orb', r: 0.42, spd: 2.4, size: 0.2, glow: true } }),
  mote: AURA({ orbit: { n: 1, tex: 'orb', r: 0.36, spd: 1.8, size: 0.14, glow: true } }),
  reweave: AURA({ ring: 'hex', spin: 0.5 }),
  stealth: AURA({ ring: 'soft', rise: 'smoke', rate: 2.5 }),
  camouflage: AURA({ ring: 'soft', rise: 'smoke', rate: 2.5 }),
  saltWard: AURA({ ring: 'ring', bubble: 0.2 }),
  sleepGuard: AURA({ bubble: 0.2 }),
  takeoff: AURA({ ring: 'ring', rise: 'streak', rate: 3 }),
  weightless: AURA({ ring: 'ring', rise: 'streak', rate: 3 }),
  slippery: AURA({ ring: 'ring', rise: 'dot', rate: 3 }),
  taunt: AURA({ ring: 'ring', pulse: 2, head: 'glow' }),
  knack: AURA({ ring: 'soft', rise: 'chevron', rate: 2 }),
  featherArrow: AURA({ glow: 0.2, rise: 'streak', rate: 2.5 }),
  flame: AURA({ glow: 0.3, rise: 'flame', rate: 7 }),
  dilemma: AURA({ ring: 'hex', spin: 1.2, orbit: { n: 2, tex: 'shard', r: 0.45, spd: 2.2, size: 0.2 } }),
  wake: AURA({ ring: 'ring', ripple: 1.2 }),
  sword: AURA({ orbit: { n: 3, tex: 'slash', r: 0.5, spd: 3, size: 0.32 } }),
  shield: AURA({ bubble: 0.2 }),
  catShield: AURA({ bubble: 0.2 }),
  undying: AURA({ bubble: 0.26, glow: 0.2, cap: 10 }),
  buff: AURA({ rise: 'chevron', rate: 1.6, cap: 20 }),
  bondShare: AURA({ ring: 'soft', ripple: 2 }),
  wanted: AURA({ head: 'reticle' }),
  expose: AURA({ head: 'reticle' }),
  reveal: AURA({ head: 'reticle' }),
  // links, channels, virtual entities, ground state, winds
  link: { look: 'link' },
  beam: { look: 'beam' },
  drones: { look: 'drones', until: 'skill' },
  drone: { look: 'drones', until: 'skill' },
  motes: { look: 'motes', until: 'life' },
  sentry: { look: 'sentry', until: 'manual' },
  snowTiles: { look: 'tiles', until: 'life' },
  tornado: { look: 'vortex', until: 'time' },
  storm: { look: 'vortex', until: 'time' },
});

/** Enemy auras sent as a 'telegraph' with `kind` (sim/content/enemies.js): held on the enemy, not a warning flash. */
export const ENEMY_AURAS = Object.freeze({
  chimera: { tint: 0xb36bff, until: 'life' },        // 嵌合体: its aura is on for the rest of its life
  invisShield: { tint: 0x8fa0b0, until: 'time' },    // 隐形庇护: the veil lasts `duration`
  regenShield: { tint: 0x9fd4ff, until: 'time' },    // 再生护盾: while the husk waits to revive
});

/** The line of a sustained wall: `axis` 'col' → x = const, 'row' → y = const, 0.5 tile towards `dir` from (x, y). */
export function wallLine(x, y, axis, dir) {
  const D = { UP: [0, 1], RIGHT: [1, 0], DOWN: [0, -1], LEFT: [-1, 0] }[String(dir || '').toUpperCase()] || [0, 0];
  const R = Math.round(Number(y)), C = Math.round(Number(x));
  return axis === 'row' ? { axis: 'row', at: R + 0.5 * D[1], fixed: R } : { axis: 'col', at: C + 0.5 * D[0], fixed: C };
}

const live = (v) => !!v && !v.destroyed && v.alive !== false;
const skillOn = (v) => !!(v && (v.statuses?.has?.('skill') || v.actor?.skillOn));

/** The lasting effects of one FxSystem (`fx`): `map` key → record. */
export class Sustains {
  constructor(fx) {
    this.fx = fx;
    this.map = new Map();
    // what happened to each unit in the current batch of events (reset after every FxSystem.update)
    this.bOn = new Map();       // id → Set of statuses switched on
    this.bOff = new Map();      // id → Set of statuses switched off
    this.bSkill = new Set();    // ids whose skill started
    const P = fx.P;
    this.gfx = new P.Graphics();
    this.gfx.blendMode = P.BLEND_MODES.ADD;
    fx.ctx.layers.groundFx.addChild(this.gfx);
    this._a = { x: 0, y: 0, s: 0, depth: 0 };
    this._b = { x: 0, y: 0, s: 0, depth: 0 };
  }

  get size() { return this.map.size; }
  _ts() { return this.fx._ts(); }
  _view(id) { return this.fx._viewOf(id); }

  // ---- signals ------------------------------------------------------------------------------------------------

  /** ['skill', id, on] — `on`: remember the start for this batch; off: end the records of that skill. */
  skill(view, on) {
    if (!view) return;
    if (on) { this.bSkill.add(view.id); return; }
    for (const S of this.map.values()) {
      if (S.src !== view.id) continue;
      if (S.until === 'skill') S.end = true;
      if (S.look === 'motes' && S.baseN != null) this._setOrbitN(S, S.baseN);
    }
  }

  /** ['status', id, key, on]: records bound to that status end once all their statuses are off. */
  status(view, key, on) {
    if (!view || typeof key !== 'string') return;
    const m = on ? this.bOn : this.bOff;
    let set = m.get(view.id);
    if (!set) m.set(view.id, (set = new Set()));
    set.add(key);
    if (on) return;
    for (const S of this.map.values()) {
      if (S.until !== 'status' || S.anchor !== view.id || !S.bind?.has(key)) continue;
      S.bind.delete(key);
      if (!S.bind.size) S.end = true;
    }
  }

  /** The unit died (or left): everything it holds or anchors fades, its links drop. */
  died(id) {
    for (const S of this.map.values()) {
      if (S.look === 'sentry') continue;
      if (S.src === id || S.anchor === id) S.end = true;
      else if (S.pairs) S.pairs = S.pairs.filter(([a, b]) => a !== id && b !== id);
    }
  }

  /** End every record (battle view cleared). */
  clear() {
    for (const S of this.map.values()) this._free(S);
    this.map.clear();
    this.gfx.clear();
    this.endBatch();
  }

  endBatch() {
    if (this.bOn.size) this.bOn.clear();
    if (this.bOff.size) this.bOff.clear();
    if (this.bSkill.size) this.bSkill.clear();
  }

  destroy() { this.clear(); this.gfx.destroy(); }

  // ---- registration -----------------------------------------------------------------------------------------

  /**
   * A sim fx of a SUSTAINED kind (or an enemy-aura telegraph): register / refresh / end its record. Returns true when
   * the one-shot look must be skipped (a sample of state the record already shows: 'drone', 'snowTiles', 'motes', an
   * enemy aura …).
   */
  fromFx(kind, x, y, ex, tint) {
    if (kind === 'telegraph') return this._enemyAura(ex, x, y);
    if (kind === 'sentryRecall') { const S = this.map.get(`sentry:${ex.id}`); if (S) S.end = true; return false; }
    if (kind === 'mote' && ex.src != null) this._takeMote(ex, x, y);
    if (kind === 'reweave') { const M = this.map.get(`motes:${ex.id}`); if (M && ex.n > 0) this._setOrbitN(M, Math.round(ex.n)); }
    const spec = SUSTAINED[kind];
    if (!spec) return false;
    switch (spec.look) {
      case 'wall': case 'field': this._field(kind, spec, x, y, ex, tint); return false;
      case 'aura': this._aura(kind, spec, ex, tint); return false;
      case 'link': this._link(ex, tint); return true;
      case 'beam': return this._beam(ex, tint);
      case 'drones': return this._drones(kind, ex, tint);
      case 'motes': this._motes(ex, tint); return true;
      case 'sentry': this._sentry(x, y, ex, tint); return false;
      case 'tiles': this._tiles(ex, tint); return true;
      case 'vortex': this._vortex(kind, x, y, ex, tint); return false;
      default: return false;
    }
  }

  _add(S) {
    const old = this.map.get(S.key);
    if (old) { this._free(old); this.map.delete(S.key); }
    if (this.map.size >= MAX_SUSTAINS) {
      const first = this.map.keys().next().value;
      this._free(this.map.get(first)); this.map.delete(first);
    }
    S.t = 0; S.a = 0; S.end = false; S.emit = 0; S.pulseT = 0; S.flagOff = 0;
    this.map.set(S.key, S);
    return S;
  }

  /**
   * How a unit-state fx on `v` ends: bound to the statuses `v` gained in this batch; a status lost in this batch
   * (and none gained) = the fx marks something used up → nothing lasts; else its `duration`; else its skill — when
   * the skill started in this batch (an onStart effect) or the kind is `mid`; else nothing lasts (a one-off).
   */
  _policy(spec, v, ex) {
    const on = this.bOn.get(v.id), off = this.bOff.get(v.id);
    const cap = spec.cap > 0 ? spec.cap / this._ts() : Infinity;
    if (on && on.size) return { until: 'status', bind: new Set(on), max: Math.min(cap, MAX_STATUS) };
    if (off && off.size) return { until: 'consumed' };
    const dur = num(ex.duration ?? ex.dur, 0);
    if (dur > 0) return { until: 'time', max: Math.min(cap, dur / this._ts()) };
    if (skillOn(v) && (this.bSkill.has(v.id) || spec.mid)) return { until: 'skill', src: v.id, max: Math.min(cap, MAX_SKILL) };
    return null;
  }

  _field(kind, spec, x, y, ex, tint) {
    const v = this._view(ex.id);
    if (!live(v) || !skillOn(v)) return;
    // 圣聆初雪's snow carries its tiles ('snowTiles' draws them): never a disc on her
    if (kind === 'snow' && ex.tiles != null) return;
    if (spec.centred && Number.isFinite(x) && Number.isFinite(y) && Math.hypot(v.x - x, v.y - y) > 0.75) return;
    const key = `${kind}:${ex.id}`;
    let S = this.map.get(key);
    if (!S || S.view !== v) {
      S = this._add({ key, kind, look: spec.look, until: 'skill', src: v.id, anchor: v.id, view: v, tint, max: MAX_SKILL });
      if (spec.look === 'field') this._mkDisc(S, tint);
    }
    S.end = false;
    if (spec.look === 'wall') {
      const rect = this.fx.ctx.fieldRect ? this.fx.ctx.fieldRect() : null;
      const axis = ex.axis === 'row' ? 'row' : 'col';
      S.line = wallLine(Number.isFinite(x) ? x : v.x, Number.isFinite(y) ? y : v.y, axis, ex.dir || v.dir || v.info?.dir);
      const ok = rect && [rect.r0, rect.r1, rect.c0, rect.c1].every(Number.isFinite);
      const f = S.line.fixed;
      S.span = axis === 'col' ? (ok ? [rect.r0, rect.r1] : [f - 4, f + 4]) : (ok ? [rect.c0, rect.c1] : [f - 4, f + 4]);
    } else S.r = clamp(num(ex.r ?? ex.radius, spec.r), 0.5, 8);
  }

  _enemyAura(ex, x, y) {
    const A = ENEMY_AURAS[ex.kind];
    if (!A) return false;
    const v = this._view(ex.id);
    if (!live(v)) return false;
    const dur = num(ex.duration ?? ex.dur, 0);
    if (A.until === 'time' && !(dur > 0)) return false;
    const key = `enemyAura:${ex.kind}:${ex.id}`;
    let S = this.map.get(key);
    if (!S) {
      S = this._add({ key, kind: ex.kind, look: 'field', until: A.until, src: v.id, anchor: v.id, view: v, tint: A.tint, rise: true });
      this._mkDisc(S, A.tint);
    }
    S.end = false; S.t = Math.min(S.t, FADE_IN);
    S.r = clamp(num(ex.r ?? ex.radius, 1), 0.5, 8);
    S.max = A.until === 'time' ? dur / this._ts() : Infinity;
    this.fx.ring(v.x, v.y, (v.z || 0), 0.2, S.r, A.tint, 0.5);
    return true;
  }

  _aura(kind, spec, ex, tint) {
    const v = this._view(ex.id);
    if (!live(v)) return;
    const key = `${kind}:${v.id}`;
    const cur = this.map.get(key);
    const pol = this._policy(spec, v, ex);
    if (!pol) return;                           // a one-off (a refresh keeps a running record as it is)
    if (pol.until === 'consumed') { if (cur) cur.end = true; return; }
    if (cur && !cur.end && cur.until === pol.until) {
      if (pol.bind) for (const k of pol.bind) cur.bind.add(k);
      if (pol.max > cur.max - cur.t) cur.max = cur.t + pol.max;
      if (ex.n > 0 && cur.orb) this._setOrbitN(cur, Math.round(ex.n));
      return;
    }
    const S = this._add({ key, kind, look: 'aura', spec, tint, view: v, anchor: v.id, src: pol.src ?? v.id, until: pol.until, bind: pol.bind || null, max: pol.max });
    this._mkAura(S, spec, ex);
  }

  /**
   * 'link': `ids` + `chain` = ids[0]–ids[1]–… (溯光星源: the linked targets); `ids` alone = from `id` to each (远牙 S2:
   * to the allies whose blocked enemies she reaches); `src` + `id` = that pair (迷迭香's talent, for the battle).
   * Held while the caster's skill runs (a talent pair: while both live); otherwise drawn as short beams.
   */
  _link(ex, tint) {
    const ids = Array.isArray(ex.ids) ? ex.ids.filter((i) => i != null).slice(0, 12) : null;
    let pairs = [], src = ex.id, until = 'skill';
    if (ids && ex.chain) for (let i = 1; i < ids.length; i++) pairs.push([ids[i - 1], ids[i]]);
    else if (ids) for (const i of ids) { if (i !== ex.id) pairs.push([ex.id, i]); }
    else if (ex.src != null && ex.id != null) { pairs = [[ex.src, ex.id]]; src = ex.src; until = 'life'; }
    const caster = this._view(src);
    const held = live(caster) && (until === 'life' || skillOn(caster));
    if (!held) {
      for (const [a, b] of pairs) { const va = this._view(a), vb = this._view(b); if (va && vb && va !== vb) this.fx._beam(va, vb, tint, 0.45, 0.3); }
      return;
    }
    const key = `link:${src}`;
    let S = this.map.get(key);
    if (!S || S.end) S = this._add({ key, kind: 'link', look: 'link', until, src, anchor: src, view: caster, tint, max: until === 'life' ? Infinity : MAX_SKILL, chain: !!ex.chain });
    S.pairs = pairs;
    for (const [a, b] of pairs) { const va = this._view(a), vb = this._view(b); if (va && vb) this.fx._beam(va, vb, tint, 0.3, 0.6); }
  }

  /** A channelled beam (`dur` > 0: 死亡之眼, 自然涌动): from `from` to `to` for `dur`, following both. */
  _beam(ex, tint) {
    const dur = num(ex.dur ?? ex.duration, 0);
    if (!(dur > 0) || ex.from == null || ex.to == null) return false;
    const a = this._view(ex.from), b = this._view(ex.to);
    if (!live(a) || !live(b)) return false;
    this._add({ key: `beam:${ex.from}:${ex.to}`, kind: 'beam', look: 'beam', until: 'time', src: ex.from, anchor: ex.from, view: a, tint, max: dur / this._ts(), pairs: [[ex.from, ex.to]], seed: Math.random() * 100 });
    return true;
  }

  /**
   * Virtual drones of a skill: 'drones' n at the start (荒芜拉普兰德 S3, 耶拉 S2), then 'drone' samples `i` (x, y) with
   * the target it chases (`to`) at `v` tiles/s (荒芜拉普兰德: once a game second). Without samples they hover over the
   * caster (耶拉). The sample itself draws nothing (it used to be a 'summon' pillar per drone per second).
   */
  _drones(kind, ex, tint) {
    const v = this._view(ex.id);
    if (!live(v)) return kind === 'drone';
    const key = `drones:${v.id}`;
    let S = this.map.get(key);
    if (kind === 'drones') {
      if (!skillOn(v)) return false;
      S = this._add({ key, kind: 'drones', look: 'drones', until: 'skill', src: v.id, anchor: v.id, view: v, tint, max: MAX_SKILL, list: [] });
      const n = clamp(Math.round(num(ex.n, 1)), 1, 8);
      for (let i = 0; i < n; i++) this._mkDrone(S, v.x, v.y, i, n);
      S.speed = num(ex.v, 0);
      return false;
    }
    if (!S || S.end) {
      if (!skillOn(v)) return true;
      S = this._add({ key, kind: 'drones', look: 'drones', until: 'skill', src: v.id, anchor: v.id, view: v, tint, max: MAX_SKILL, list: [] });
    }
    const x = Number(ex.x), y = Number(ex.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
    let i = Number.isInteger(ex.i) ? ex.i : -1;
    if (i < 0) {   // (an old replay without the index: the nearest drone)
      let bd = Infinity;
      S.list.forEach((d, k) => { const dd = Math.hypot(d.x - x, d.y - y); if (dd < bd) { bd = dd; i = k; } });
      if (i < 0) i = 0;
    }
    while (S.list.length <= i && S.list.length < 8) this._mkDrone(S, v.x, v.y, S.list.length, i + 1);
    const d = S.list[Math.min(i, S.list.length - 1)];
    d.sx = x; d.sy = y; d.to = ex.to ?? null; d.sampled = true;
    if (num(ex.v, 0) > 0) S.speed = num(ex.v, 0);
    return true;
  }

  /** 魔王's motes: `n` orbiting at `r` tiles, `spd` °/s; a 'mote' touch (src = her) hides slot `k` for `cd` game s. */
  _motes(ex, tint) {
    const v = this._view(ex.id);
    if (!live(v)) return;
    const n = clamp(Math.round(num(ex.n, 3)), 0, 12);
    const key = `motes:${v.id}`;
    const S = this._add({ key, kind: 'motes', look: 'motes', until: 'life', src: v.id, anchor: v.id, view: v, tint: 0xfff0a8, max: Infinity,
      r: clamp(num(ex.r, 1.15), 0.3, 3), spd: (num(ex.spd, 30) * Math.PI) / 180, baseN: n, hide: [] });
    S.orb = [];
    this._setOrbitN(S, n);
  }

  _takeMote(ex, x, y) {
    const S = this.map.get(`motes:${ex.src}`);
    if (!S || !S.orb?.length) return;
    const cd = num(ex.cd, 6);
    if (!(cd > 0)) return;
    let k = Number.isInteger(ex.k) ? ex.k : -1;
    if (k < 0 || k >= S.orb.length) {
      // (no slot index: the visible mote nearest to the touched unit)
      let bd = Infinity;
      const v = S.view;
      for (let j = 0; j < S.orb.length; j++) {
        if ((S.hide[j] ?? 0) > S.t) continue;
        const th = this._orbAngle(S, j);
        const d = Math.hypot(v.x + Math.cos(th) * S.r - x, v.y + Math.sin(th) * S.r - y);
        if (d < bd) { bd = d; k = j; }
      }
    }
    if (k >= 0) S.hide[k] = S.t + cd / this._ts();
  }

  /** 伊内丝's 影哨, left where she stood until it is recalled ('sentryRecall') or a new one replaces it. */
  _sentry(x, y, ex, tint) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const S = this._add({ key: `sentry:${ex.id}`, kind: 'sentry', look: 'sentry', until: 'manual', src: ex.id, anchor: null, view: null, tint, max: Infinity, x, y, z: this.fx._groundZ(x, y) });
    this._mkDisc(S, tint);
    S.eye = this._sprite('glow', tint, this.fx.ctx.layers.fxAdd);
  }

  /** 圣聆初雪's snow: every snowy tile [r, c, layers] (replaced by each event); gone when she dies. */
  _tiles(ex, tint) {
    const v = this._view(ex.id);
    const tiles = Array.isArray(ex.tiles) ? ex.tiles.filter((t) => Array.isArray(t) && Number.isInteger(t[0]) && Number.isInteger(t[1])).slice(0, 80) : [];
    const key = `snowTiles:${ex.id}`;
    let S = this.map.get(key);
    if (!tiles.length || !live(v)) { if (S) S.end = true; return; }
    if (!S || S.end) S = this._add({ key, kind: 'snowTiles', look: 'tiles', until: 'life', src: v.id, anchor: v.id, view: v, tint, max: Infinity });
    S.tiles = tiles;
  }

  /** 歌蕾蒂娅 S3 tornado / 异客 S3 storm: wind turning over (x, y), radius r, for `duration`. */
  _vortex(kind, x, y, ex, tint) {
    const dur = num(ex.duration ?? ex.dur, 0);
    if (!(dur > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const S = this._add({ key: `${kind}:${ex.id ?? `${x},${y}`}`, kind, look: 'vortex', until: 'time', src: null, anchor: null, view: null, tint, max: dur / this._ts(),
      x, y, z: this.fx._groundZ(x, y), r: clamp(num(ex.r ?? ex.radius, 1.5), 0.5, 4) });
    S.root = new this.fx.P.Container();
    S.dec = this._sprite('ring', tint, S.root);
    S.dec2 = this._sprite('hex', tint, S.root);
  }

  // ---- sprites ----------------------------------------------------------------------------------------------

  _sprite(tex, tint, parent) {
    const P = this.fx.P;
    const sp = new P.Sprite(this.fx.tex[tex] || this.fx.tex.glow);
    sp.anchor.set(0.5); sp.blendMode = P.BLEND_MODES.ADD; sp.tint = tint; sp.alpha = 0;
    if (parent) parent.addChild(sp);
    return sp;
  }

  _mkDisc(S, tint) {
    S.disc = this._sprite('soft', tint, null);
    S.edge = this._sprite('ring', tint, null);
  }

  _mkAura(S, spec, ex) {
    const L = this.fx.ctx.layers;
    if (spec.ring) {
      S.root = new this.fx.P.Container();
      S.dec = this._sprite(spec.ring, S.tint, S.root);
    }
    if (spec.glow) S.glow = this._sprite('glow', S.tint, L.fxAdd);
    if (spec.bubble) { S.bub = this._sprite('hex', S.tint, L.fxAdd); S.bub2 = this._sprite('soft', S.tint, L.fxAdd); }
    if (spec.head) S.head = this._sprite(spec.head === 'reticle' ? 'reticle' : 'glow', S.tint, L.fxAdd);
    if (spec.orbit) {
      S.orb = [];
      S.r = spec.orbit.r; S.spd = spec.orbit.spd;
      this._setOrbitN(S, ex.n > 0 ? clamp(Math.round(ex.n), 1, 8) : spec.orbit.n);
    }
  }

  _setOrbitN(S, n) {
    const L = this.fx.ctx.layers;
    const tex = S.spec?.orbit?.tex || 'orb';
    while (S.orb.length > n) { const o = S.orb.pop(); o.sp.destroy(); o.gl?.destroy(); }
    while (S.orb.length < n) {
      const gl = (S.spec?.orbit?.glow ?? S.look === 'motes') ? this._sprite('glow', S.tint, L.fxAdd) : null;
      S.orb.push({ sp: this._sprite(tex, S.look === 'motes' ? 0xffffff : S.tint, L.fxAdd), gl });
    }
    S.n = n;
  }

  _mkDrone(S, x, y, i, n) {
    const L = this.fx.ctx.layers;
    const a = (i / Math.max(1, n)) * TAU;
    S.list.push({ x: x + Math.cos(a) * 0.3, y: y + Math.sin(a) * 0.3, sx: null, sy: null, to: null, sampled: false, ph: a,
      gl: this._sprite('glow', S.tint, L.fxAdd), core: this._sprite('orb', 0xffffff, L.fxAdd), rot: this._sprite('ring', S.tint, L.fxAdd) });
  }

  _free(S) {
    for (const k of ['disc', 'edge', 'glow', 'bub', 'bub2', 'head', 'eye']) S[k]?.destroy();
    S.root?.destroy({ children: true });
    if (S.orb) for (const o of S.orb) { o.sp.destroy(); o.gl?.destroy(); }
    if (S.list) for (const d of S.list) { d.gl.destroy(); d.core.destroy(); d.rot.destroy(); }
  }

  // ---- per frame --------------------------------------------------------------------------------------------

  update(dt) {
    const g = this.gfx;
    g.clear();
    if (!this.map.size) return;
    const cam = this.fx.ctx.cam();
    for (const [key, S] of this.map) {
      S.t += dt;
      const v = S.view;
      if (S.view && !live(v)) S.end = true;
      if (S.until === 'skill' && S.src != null) {
        const sv = S.src === v?.id ? v : this._view(S.src);
        if (!live(sv)) S.end = true;
        else if (!skillOn(sv)) { if ((S.flagOff += dt) > FLAG_GRACE) S.end = true; } else S.flagOff = 0;
      }
      if (S.pairs) {
        S.pairs = S.pairs.filter(([a, b]) => live(this._view(a)) && live(this._view(b)));
        if (!S.pairs.length && (S.until === 'life' || S.look === 'beam')) S.end = true;
      }
      if (S.t > S.max) S.end = true;
      S.a = S.end ? S.a - dt / FADE_OUT : Math.min(1, S.a + dt / FADE_IN);
      if (S.end && S.a <= 0) { this._free(S); this.map.delete(key); continue; }
      switch (S.look) {
        case 'wall': this._drawWall(S, g, cam, dt); break;
        case 'field': this._drawField(S, cam, dt); break;
        case 'aura': this._drawAura(S, cam, dt); break;
        case 'link': case 'beam': this._drawLinks(S, dt); break;
        case 'drones': this._drawDrones(S, cam, dt); break;
        case 'motes': this._drawMotes(S, cam, dt); break;
        case 'sentry': this._drawSentry(S, cam, dt); break;
        case 'tiles': this._drawTiles(S, g, cam, dt); break;
        case 'vortex': this._drawVortex(S, cam, dt); break;
      }
    }
  }

  /** A burning line across the field: an orange band with a hot core, flickering per tile, with rising flames. */
  _drawWall(S, g, cam, dt) {
    const L = S.line, [a, b] = S.span, p = this._a, fx = this.fx;
    const quad = (u0, u1, w0, w1, z) => {
      // u: along the line (tile index), w: across it (world offset from the line)
      const pts = [];
      for (const [u, w] of [[u0, w0], [u1, w0], [u1, w1], [u0, w1]]) {
        if (L.axis === 'col') cam.project(L.at + w, u, z, p); else cam.project(u, L.at + w, z, p);
        pts.push(p.x, p.y);
      }
      return pts;
    };
    for (let u = a; u <= b; u++) {
      const r = L.axis === 'col' ? u : L.fixed, c = L.axis === 'col' ? L.fixed : u;
      const z = (fx.ctx.heightAt ? fx.ctx.heightAt(r, c) : 0) + 0.02;
      const fl = 0.78 + 0.22 * Math.sin(S.t * 9 + u * 1.7) * Math.sin(S.t * 5.3 + u * 0.9);
      g.beginFill(0xff5a1a, 0.24 * S.a * fl); g.drawPolygon(quad(u - 0.5, u + 0.5, -0.26, 0.26, z)); g.endFill();
      g.beginFill(0xffc04a, 0.32 * S.a * fl); g.drawPolygon(quad(u - 0.5, u + 0.5, -0.09, 0.09, z)); g.endFill();
    }
    if (S.end) return;
    // rising flames along the line
    S.emit += dt * (fx.rich ? 26 : 9) * (b - a + 1) / 9;
    while (S.emit >= 1) {
      S.emit -= 1;
      const u = a - 0.45 + Math.random() * (b - a + 0.9), w = (Math.random() - 0.5) * 0.36;
      const r = Math.round(L.axis === 'col' ? u : L.fixed), c = Math.round(L.axis === 'col' ? L.fixed : u);
      const z = (fx.ctx.heightAt ? fx.ctx.heightAt(r, c) : 0) + 0.05;
      if (L.axis === 'col') cam.project(L.at + w, u, z, p); else cam.project(u, L.at + w, z, p);
      const s = p.s, hot = Math.random() < 0.35;
      fx.particle(hot ? 'spark' : 'glow', p.x, p.y, {
        tint: hot ? 0xffd27a : 0xff7a2a, vx: (Math.random() - 0.5) * s * 0.12, vy: -s * (0.7 + Math.random() * 0.6), drag: 0.6,
        life: 0.45 + Math.random() * 0.4, s0: (s / 128) * (hot ? 0.35 : 0.55), s1: (s / 128) * 0.12, a0: 0.85, a1: 0, fadeIn: 0.08,
      });
    }
  }

  /** A ground field around its unit (soft disc + edge), pulsing, with a few motes of its kind. */
  _drawField(S, cam, dt) {
    const fx = this.fx, p = this._a, q = this._b;
    const v = S.view;
    const x = v ? v.x : S.x, y = v ? v.y : S.y, z = ((v ? v.z : S.z) || 0) + 0.02;
    fx._onGround(S.disc, y, z); fx._onGround(S.edge, y, z);
    cam.project(x, y, z, p);
    cam.project(x, y + S.r, z, q);
    const rx = p.s * S.r, ry = Math.max(1, p.y - q.y);
    const pulse = 0.85 + 0.15 * Math.sin(S.t * 2.4);
    S.disc.position.set(p.x, p.y); S.disc.scale.set((rx * 2) / 128, (ry * 2) / 128); S.disc.alpha = 0.2 * S.a * pulse;
    S.edge.position.set(p.x, p.y); S.edge.scale.set((rx * 2.08) / 128, (ry * 2.08) / 128); S.edge.alpha = 0.55 * S.a * pulse;
    if (S.end || !v) return;
    S.pulseT -= dt;
    if (S.kind === 'tide' && S.pulseT <= 0) { S.pulseT = 1.4; fx.ring(x, y, z, S.r * 0.25, S.r, S.tint, 0.9); return; }
    S.emit += dt * (fx.rich ? 6 : 2);
    while (S.emit >= 1) {
      S.emit -= 1;
      const ang = Math.random() * TAU, d = Math.sqrt(Math.random()) * S.r * 0.9;
      const up = S.kind === 'healField' || S.rise;
      const w = fx._proj(x + Math.cos(ang) * d, y + Math.sin(ang) * d, z + (up ? 0.1 : 0.9), q);
      const s = w.s;
      if (S.kind === 'healField') fx.particle('plus', w.x, w.y, { tint: S.tint, vy: -s * 0.6, life: 0.9, s0: (s / 64) * 0.22, s1: (s / 64) * 0.12, a0: 0.8, a1: 0, fadeIn: 0.15 });
      else if (up) fx.particle('dot', w.x, w.y, { tint: S.tint, vy: -s * 0.5, life: 1, s0: (s / 32) * 0.14, s1: 0, a0: 0.8, a1: 0, fadeIn: 0.15 });
      else fx.particle('dot', w.x, w.y, { tint: 0xffffff, vx: (Math.random() - 0.5) * s * 0.15, vy: s * 0.45, life: 1.2, s0: (s / 32) * 0.14, s1: (s / 32) * 0.08, a0: 0.85, a1: 0, fadeIn: 0.2 });
    }
  }

  /** Ground decal under a unit (squashed onto the ground, turning in the ground plane) of radius R tiles. */
  _decal(S, cam, x, y, z, R, alpha, spin) {
    const p = this._a, q = this._b;
    this.fx._onGround(S.root, y, z);
    cam.project(x, y, z + 0.01, p);
    cam.project(x, y + R, z + 0.01, q);
    S.root.position.set(p.x, p.y);
    S.root.scale.set((p.s * R * 2) / 128, (Math.max(1, p.y - q.y) * 2) / 128);
    S.dec.alpha = alpha;
    S.dec.rotation = S.t * spin;
  }

  _orbAngle(S, k) { return S.t * S.spd * (S.look === 'motes' ? this._ts() : 1) + (TAU * k) / Math.max(1, S.orb.length); }

  /** Sprites circling a unit at `r` tiles, at chest height (dimmer on the far side). */
  _drawOrbit(S, cam, v, zc, size, hideFn) {
    const p = this._a;
    for (let k = 0; k < S.orb.length; k++) {
      const o = S.orb[k];
      const th = this._orbAngle(S, k);
      const wx = v.x + Math.cos(th) * S.r, wy = v.y + Math.sin(th) * S.r;
      cam.project(wx, wy, zc + Math.sin(th * 2 + S.t) * 0.04, p);
      const near = 0.65 + 0.35 * -Math.sin(th);
      const hidden = hideFn ? hideFn(k) : 1;
      o.sp.position.set(p.x, p.y);
      o.sp.scale.set((p.s / 64) * size);
      o.sp.rotation = th + Math.PI / 2;
      o.sp.alpha = S.a * near * hidden;
      if (o.gl) { o.gl.position.set(p.x, p.y); o.gl.scale.set((p.s / 128) * size * 2.6); o.gl.alpha = 0.55 * S.a * near * hidden; }
    }
  }

  _drawAura(S, cam, dt) {
    const v = S.view;
    if (!v || v.destroyed) return;
    const fx = this.fx, sp = S.spec, p = this._a, a = S.a;
    const z = v.z || 0, hz = z + (v.hover || 0);
    const pulse = sp.pulse ? 0.7 + 0.3 * Math.sin(S.t * sp.pulse * TAU) : 0.88 + 0.12 * Math.sin(S.t * 3);
    if (S.root) this._decal(S, cam, v.x, v.y, z, sp.ring === 'soft' ? 0.6 : 0.5, a * (sp.ring === 'soft' ? 0.4 : 0.7) * pulse, sp.spin || 0.4);
    const c = fx._chest(v, p);
    const cx = c.x, cy = c.y, s = c.s;
    if (S.glow) { S.glow.position.set(cx, cy); S.glow.scale.set((s / 128) * 1.2); S.glow.alpha = sp.glow * a * pulse; }
    if (S.bub) {
      const k = 0.85 + 0.15 * Math.sin(S.t * 2.2);
      S.bub.position.set(cx, cy); S.bub.scale.set((s / 128) * 1.15, (s / 128) * 1.3); S.bub.rotation = S.t * 0.25; S.bub.alpha = sp.bubble * 1.6 * a * k;
      S.bub2.position.set(cx, cy); S.bub2.scale.set((s / 128) * 1.3, (s / 128) * 1.45); S.bub2.alpha = sp.bubble * a * k;
    }
    if (S.orb) this._drawOrbit(S, cam, v, hz + (v._headTiles || 1.2) * 0.5, sp.orbit.size || 0.18, null);
    if (S.head) {
      cam.project(v.x, v.y, hz + (v._headTiles || 1.2) + 0.32, p);
      S.head.position.set(p.x, p.y);
      S.head.scale.set((p.s / 128) * (sp.head === 'reticle' ? 0.55 : 0.5));
      S.head.rotation = sp.head === 'reticle' ? S.t * 1.6 : 0;
      S.head.alpha = a * (sp.head === 'reticle' ? 0.85 : 0.6 * pulse);
    }
    if (S.end) return;
    if (sp.ripple && (S.pulseT -= dt) <= 0) { S.pulseT = sp.ripple; fx.ring(v.x, v.y, z, 0.2, 0.9, S.tint, 0.7); }
    if (!sp.rise) return;
    S.emit += dt * sp.rate * (fx.rich ? 1 : 0.4);
    while (S.emit >= 1) {
      S.emit -= 1;
      if (!fx._room()) continue;
      const ang = Math.random() * TAU, d = 0.12 + Math.random() * 0.3;
      const w = fx._proj(v.x + Math.cos(ang) * d, v.y + Math.sin(ang) * d * 0.8, hz + 0.05 + Math.random() * 0.2, this._b);
      const ws = w.s, o = fx._o();
      o.tint = S.tint; o.fadeIn = 0.1;
      switch (sp.rise) {
        case 'chevron': o.vy = -ws * 0.9; o.life = 0.7; o.s0 = (ws / 64) * 0.2; o.s1 = (ws / 64) * 0.1; o.a0 = 0.85; o.rot = -Math.PI / 2; break;
        case 'streak': o.vy = -ws * 1.6; o.life = 0.45; o.s0 = (ws / 128) * 0.36; o.s1 = (ws / 128) * 0.16; o.a0 = 0.7; o.rot = -Math.PI / 2; break;
        case 'smoke': o.add = false; o.tint = 0x3a3f48; o.vy = -ws * 0.35; o.life = 1; o.s0 = (ws / 128) * 0.35; o.s1 = (ws / 128) * 0.7; o.a0 = 0.32; break;
        case 'flame': o.tint = Math.random() < 0.4 ? 0xffd27a : S.tint; o.vy = -ws * (0.7 + Math.random() * 0.5); o.drag = 0.6; o.life = 0.5; o.s0 = (ws / 128) * 0.5; o.s1 = (ws / 128) * 0.12; o.a0 = 0.8; break;
        case 'spark': o.vy = -ws * 0.8; o.vx = (Math.random() - 0.5) * ws * 0.2; o.life = 0.55; o.s0 = (ws / 64) * 0.18; o.s1 = 0; o.a0 = 0.9; o.rot = Math.random() * TAU; break;
        default: o.vy = -ws * 0.6; o.life = 0.8; o.s0 = (ws / 32) * 0.12; o.s1 = 0; o.a0 = 0.85;
      }
      const tex = sp.rise === 'flame' ? 'glow' : sp.rise;
      fx.particle(tex, w.x, w.y, o);
    }
  }

  /** Lines between unit pairs: a steady glowing line with light running along it (links), or a jagged beam (beam). */
  _drawLinks(S, dt) {
    const fx = this.fx, g = fx.beams, p = this._a, q = this._b;
    const beam = S.look === 'beam';
    for (const [ia, ib] of S.pairs || []) {
      const va = this._view(ia), vb = this._view(ib);
      if (!va || !vb) continue;
      fx._chest(va, p); const px = p.x, py = p.y, s = p.s;
      fx._chest(vb, q);
      const segs = beam ? 7 : 2;
      for (let pass = 0; pass < 3; pass++) {
        const wd = pass === 0 ? s * (beam ? 0.16 : 0.1) : pass === 1 ? s * (beam ? 0.065 : 0.04) : s * 0.018;
        const k = beam ? 0.85 + 0.15 * Math.sin(S.t * 30) : 0.75 + 0.25 * Math.sin(S.t * 4);
        g.lineStyle(Math.max(1, wd), pass === 2 ? 0xffffff : S.tint, (pass === 0 ? 0.18 : pass === 1 ? 0.5 : 0.8) * S.a * k);
        g.moveTo(px, py);
        for (let i = 1; i < segs; i++) {
          const f = i / segs;
          const j = beam ? Math.sin(S.seed + i * 12.9 + S.t * 40) * s * 0.08 : 0;
          g.lineTo(px + (q.x - px) * f + j, py + (q.y - py) * f - j * 0.5);
        }
        g.lineTo(q.x, q.y);
      }
      if (S.end || !fx.rich) continue;
      // light running from the first unit to the second
      if ((S.emit += dt * (beam ? 10 : 3)) >= 1 && fx._room()) {
        S.emit = 0;
        const f = Math.random();
        fx.particle('dot', px + (q.x - px) * f, py + (q.y - py) * f, { tint: S.tint, vx: (q.x - px) * 0.8, vy: (q.y - py) * 0.8, life: 0.3, s0: (s / 32) * 0.16, s1: 0, a0: 0.9, a1: 0 });
      }
    }
  }

  _drawDrones(S, cam, dt) {
    const fx = this.fx, v = S.view, p = this._a, ts = this._ts();
    if (!v) return;
    const n = S.list.length;
    for (let i = 0; i < n; i++) {
      const d = S.list[i];
      if (d.sampled) {
        // chase its target (as the sim does between two samples), pulled back to the latest sample
        const t = d.to != null ? this._view(d.to) : null;
        const gx = live(t) ? t.x : d.sx, gy = live(t) ? t.y : d.sy;
        const sp = Math.max(0.5, S.speed || 1) * ts;
        const dx = gx - d.x, dy = gy - d.y, dist = Math.hypot(dx, dy), step = sp * dt;
        if (dist <= step) { d.x = gx; d.y = gy; } else if (dist > 1e-6) { d.x += (dx / dist) * step; d.y += (dy / dist) * step; }
        const ex = d.sx - d.x, ey = d.sy - d.y;
        if (!live(t) || Math.hypot(ex, ey) > 1.2) { const k = Math.min(1, dt * 3); d.x += ex * k; d.y += ey * k; }
      } else {
        // no samples (耶拉): hovering over the caster
        const th = S.t * 1.2 + d.ph;
        d.x += (v.x + Math.cos(th) * 0.45 - d.x) * Math.min(1, dt * 4);
        d.y += (v.y + Math.sin(th) * 0.45 - d.y) * Math.min(1, dt * 4);
      }
      const z = fx._groundZ(d.x, d.y) + 0.95 + Math.sin(S.t * 3 + i) * 0.06;
      cam.project(d.x, d.y, z, p);
      const s = p.s;
      d.gl.position.set(p.x, p.y); d.gl.scale.set((s / 128) * 0.7); d.gl.alpha = 0.6 * S.a;
      d.core.position.set(p.x, p.y); d.core.scale.set((s / 64) * 0.16); d.core.alpha = S.a;
      d.rot.position.set(p.x, p.y); d.rot.scale.set((s / 128) * 0.42, (s / 128) * 0.16); d.rot.rotation = 0; d.rot.alpha = (0.6 + 0.4 * Math.sin(S.t * 25 + i)) * S.a;
    }
  }

  _drawMotes(S, cam, dt) {
    const v = S.view;
    if (!v || !S.orb.length) return;
    this._drawOrbit(S, cam, v, (v.z || 0) + (v.hover || 0) + (v._headTiles || 1.2) * 0.45, 0.13, (k) => {
      const h = S.hide[k] ?? 0;
      return h > S.t ? 0 : clamp((S.t - h) / 0.3, 0, 1);
    });
  }

  _drawSentry(S, cam, dt) {
    const p = this._a, q = this._b, fx = this.fx;
    fx._onGround(S.disc, S.y, S.z); fx._onGround(S.edge, S.y, S.z);
    cam.project(S.x, S.y, S.z + 0.02, p);
    cam.project(S.x, S.y + 0.45, S.z + 0.02, q);
    const rx = p.s * 0.45, ry = Math.max(1, p.y - q.y);
    const k = 0.8 + 0.2 * Math.sin(S.t * 2);
    S.disc.position.set(p.x, p.y); S.disc.scale.set((rx * 2) / 128, (ry * 2) / 128); S.disc.alpha = 0.25 * S.a * k;
    S.edge.position.set(p.x, p.y); S.edge.scale.set((rx * 2) / 128, (ry * 2) / 128); S.edge.alpha = 0.6 * S.a * k;
    cam.project(S.x, S.y, S.z + 0.55 + Math.sin(S.t * 1.5) * 0.05, q);
    S.eye.position.set(q.x, q.y); S.eye.scale.set((q.s / 128) * 0.5); S.eye.alpha = 0.7 * S.a * k;
  }

  /** Snow on tiles: a pale cover, thicker with more layers, a glint now and then. */
  _drawTiles(S, g, cam, dt) {
    const fx = this.fx, p = this._a;
    for (const t of S.tiles) {
      const [r, c] = t, L = clamp(num(t[2], 1), 1, 5);
      const z = (fx.ctx.heightAt ? fx.ctx.heightAt(r, c) : 0) + 0.02;
      const pts = [];
      for (const [dx, dy] of [[-0.47, 0.47], [0.47, 0.47], [0.47, -0.47], [-0.47, -0.47]]) { cam.project(c + dx, r + dy, z, p); pts.push(p.x, p.y); }
      g.lineStyle(Math.max(1, p.s * 0.02), 0xffffff, 0.35 * S.a);
      g.beginFill(0xe8f6ff, (0.1 + 0.05 * L) * S.a);
      g.drawPolygon(pts);
      g.endFill();
    }
    g.lineStyle(0);
    if (S.end || !fx.rich || !S.tiles.length) return;
    S.emit += dt * Math.min(6, S.tiles.length * 0.5);
    while (S.emit >= 1) {
      S.emit -= 1;
      if (!fx._room()) continue;
      const [r, c] = S.tiles[(Math.random() * S.tiles.length) | 0];
      const z = (fx.ctx.heightAt ? fx.ctx.heightAt(r, c) : 0) + 0.05;
      const w = fx._proj(c + (Math.random() - 0.5) * 0.8, r + (Math.random() - 0.5) * 0.8, z, this._b);
      fx.particle('spark', w.x, w.y, { tint: 0xffffff, life: 0.5, s0: (w.s / 64) * 0.14, s1: 0, a0: 0.9, a1: 0, rot: Math.random() * TAU, fadeIn: 0.15 });
    }
  }

  /** A turning wind: two turning decals and particles spiralling in. */
  _drawVortex(S, cam, dt) {
    const fx = this.fx;
    this._decal(S, cam, S.x, S.y, S.z, S.r, 0.55 * S.a, -2.2);
    S.dec2.alpha = 0.35 * S.a; S.dec2.rotation = S.t * 3.1; S.dec2.scale.set(0.7);
    if (S.end) return;
    S.emit += dt * (fx.rich ? 22 : 8);
    while (S.emit >= 1) {
      S.emit -= 1;
      if (!fx._room()) continue;
      const th = Math.random() * TAU, d = S.r * (0.4 + Math.random() * 0.6), h = Math.random() * 1.2;
      const w = fx._proj(S.x + Math.cos(th) * d, S.y + Math.sin(th) * d, S.z + h, this._a);
      const tx = fx._proj(S.x + Math.cos(th + 0.9) * d * 0.55, S.y + Math.sin(th + 0.9) * d * 0.55, S.z + h + 0.25, this._b);
      fx.particle(Math.random() < 0.5 ? 'streak' : 'dot', w.x, w.y, {
        tint: S.tint, vx: (tx.x - w.x) * 2.2, vy: (tx.y - w.y) * 2.2, life: 0.45, s0: (w.s / 128) * 0.3, s1: (w.s / 128) * 0.08, a0: 0.7, a1: 0,
        rot: Math.atan2(tx.y - w.y, tx.x - w.x), fadeIn: 0.08,
      });
    }
  }
}
