// ui/gameLogic/format.js — HUD numbers, status glyphs, range boxes, unit flags. Re-exported from ../gameLogic.js.

import { UF } from '../../../../shared/constants.js';
import { clamp, isObj, tileKey } from './shared.js';
import { N_, langInfo } from '../../../../shared/i18n.js';


// ---- players, statuses, fields ------------------------------------------------------------------------

/** Status → glyph + text (research 06 §11.1). */
export const STATUS_META = Object.freeze({
  acting: { glyph: 'dots', text: N_('行动中'), tone: 'lo' },
  ready: { glyph: 'check', text: N_('已就绪'), tone: 'mint' },
  deciding: { glyph: 'hourglass', text: N_('决策中'), tone: 'gold' },
  combat: { glyph: 'sword', text: N_('作战中'), tone: 'orange' },
  done: { glyph: 'check', text: N_('作战结束'), tone: 'mint' },
  helping: { glyph: 'shield', text: N_('联防中'), tone: 'orange' },
  left: { glyph: 'exit', text: N_('已离开'), tone: 'red' },
  dead: { glyph: 'close', text: N_('已淘汰'), tone: 'red' },
});

// ---- snapshots / battle HUD ---------------------------------------------------------------------------------

/**
 * The own-field values of the battle HUD, shown when the render engine draws the frames they belong to (render/app.js
 * renderLag(): the field is drawn 0.5 s behind its frames). `push(field, hud, lagMs, extra)` queues one frame's values:
 * `hud` → `onHud` (killed / total / dp / boss), `extra.battle` → `onBattle` (a slice of the runner's state(): leaks,
 * 联防 ×N, bond layers, done — see pickDrawn), `extra.units` → `onUnits` (the snapshot's unit tuples: the unit card's
 * HP). Everything due is released together, in order: per channel the later value overrides the earlier one (hud and
 * battle merge field by field), so a value is never held back behind a newer frame that was already drawn. Values of
 * another field than the one on screen (`field()`, a watch switch) are dropped. At most one timer runs (each push used to
 * arm another one: the timers multiplied for the whole battle). `setPaused(true)` (solo pause) holds every release and
 * stops the queue's clock like the frozen picture: on resume the pending values wait out the rest of their lag.
 * What the original relays on the server clock (teammates' rows, team LP, boss pool, settlement) is not queued here.
 */
export function createHudDelay({ onHud, onBattle = null, onUnits = null, field = () => null, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout, cap = 400 }) {
  const q = [];
  let timer = null;
  let pausedAt = null; // real time the pause began; `held` = real ms spent paused so far (the queue's clock skips them)
  let held = 0;
  const clock = () => (pausedAt != null ? pausedAt : now()) - held;
  const drain = () => {
    clearTimer(timer);
    timer = null;
    if (pausedAt != null) return;
    const t = clock(), cur = field();
    let h = null, b = null, u = null;
    while (q.length && q[0].at <= t) {
      const e = q.shift();
      if (e.f !== cur) continue;
      if (e.h) h = h ? { ...h, ...e.h } : e.h;
      if (e.b) b = b ? { ...b, ...e.b } : e.b;
      if (e.u) u = e.u;
    }
    if (u && onUnits) onUnits(u);
    if (h) onHud(h);
    if (b && onBattle) onBattle(b);
    if (q.length) timer = setTimer(drain, Math.max(0, q[0].at - t));
  };
  const clear = () => { clearTimer(timer); timer = null; q.length = 0; };
  const push = (f, h, lagMs = 0, extra = null) => {
    const b = extra && extra.battle, u = extra && extra.units;
    if (!h && !b && !u) return;
    q.push({ at: clock() + Math.max(0, Number(lagMs) || 0), f, h: h || null, b: b || null, u: u || null });
    if (q.length > cap) q.shift();
    drain();
  };
  return {
    push,
    pushBattle: (f, b, lagMs = 0) => push(f, null, lagMs, { battle: b }),
    setPaused(on) {
      if ((pausedAt != null) === !!on) return;
      if (on) { pausedAt = now(); clearTimer(timer); timer = null; }
      else { held += now() - pausedAt; pausedAt = null; drain(); }
    },
    /** Drop what is queued (the field was entered again: its picture restarts at once). */
    clear,
    get size() { return q.length; },
    dispose: clear,
  };
}

/**
 * The slice of the battle runner's state() the HUD shows with the drawn picture — leaks per field, 联防 uniteLeft per
 * leaker, bond layers and `done` — plus the identity fields the gates read (battleId, fieldId, kind, own, watch). null
 * for no battle on screen (nothing, or one still loading). The values are the runner's own copies (state() builds fresh
 * objects per call) and are kept as they are.
 * @param {any} s battleRunner.state()
 */
export function pickDrawn(s) {
  if (!isObj(s) || typeof s.fieldId !== 'string' || !s.fieldId || typeof s.own !== 'boolean') return null;
  return {
    battleId: s.battleId ?? null, fieldId: s.fieldId, kind: s.kind ?? null, own: s.own, watch: !!s.watch, done: !!s.done,
    leaks: isObj(s.leaks) ? s.leaks : {}, uniteLeft: isObj(s.uniteLeft) ? s.uniteLeft : null, bondLayers: isObj(s.bondLayers) ? s.bondLayers : null,
  };
}

/** Whether two drawn slices differ in anything the HUD shows (leaks, 联防 counts, layers, done, which battle). */
export function drawnChanged(a, b) {
  if (a === b) return false;
  if (!a || !b) return true;
  return JSON.stringify(a) !== JSON.stringify(b);
}

/** Whether the capsule's numbers (killed / total) differ: a drawn kill goes out at once, DP alone keeps the HUD throttle. */
export const hudChanged = (a, b) => !a || !b || a.killed !== b.killed || a.total !== b.total;

/**
 * The battle values the HUD shows: the released (drawn) slice of the battle `sim` is running, else the live state — a
 * battle whose entry frame is drawn at once (the game screen seeds the slice then), or one the screen has not entered yet.
 * @param {any} sim battleRunner.state() @param {any} drawn the last released pickDrawn slice
 */
export function drawnOf(sim, drawn) {
  return drawn && isObj(sim) && drawn.battleId === (sim.battleId ?? null) && drawn.fieldId === sim.fieldId ? drawn : sim || null;
}

/**
 * What the own battle on screen lets the HUD read. `sim` = battleRunner.state() (null without client-side combat), `ownFid`
 * = the player's own field id. `onScreen`: the own normal battle is the one in view; `simDone`: the sim finished (gates the
 * pause button: the server refuses a pause once the field ended); `drawnDone`: the drawn picture finished (the 作战结束
 * pill, 前往查看); `serverOk`: the server's relayed numbers (pendingLp, status done, uniteLeft) may join in — not while the
 * own picture still runs, they arrive up to 0.5 s ahead of it (the authority reports from the sim clock); afterwards they
 * can only confirm or correct (a result the server replaced).
 * @param {any} sim @param {any} drawn @param {string} ownFid
 */
export function ownFieldGate(sim, drawn, ownFid) {
  const onScreen = isObj(sim) && sim.own === true && !sim.watch && sim.fieldId === ownFid;
  const simDone = onScreen && !!sim.done;
  const drawnDone = onScreen && !!drawnOf(sim, drawn)?.done;
  return { onScreen, simDone, drawnDone, serverOk: !onScreen || drawnDone };
}

/** The units of a b.snap by id (tuples [id, x, y, hp, maxHp, …]): the unit card's drawn HP. */
export function snapUnits(snap) {
  const mp = new Map();
  if (isObj(snap) && Array.isArray(snap.units)) for (const t of snap.units) if (Array.isArray(t)) mp.set(t[0], t);
  return mp;
}

/**
 * HUD numbers from a b.snap: { killed, total, dp, boss } (boss: { hp, max } when present).
 * @param {any} snap
 */
export function snapHud(snap) {
  if (!isObj(snap)) return null;
  const n = (v) => (Number.isFinite(v) ? v : null);
  let boss = null;
  if (isObj(snap.boss) && Number.isFinite(snap.boss.hp)) boss = { hp: snap.boss.hp, max: n(snap.boss.max) ?? n(snap.boss.maxHp) };
  return { killed: n(snap.killed), total: n(snap.total), dp: n(snap.dp), boss };
}

/** Boss HP fraction 0..1 (null when unknown). */
export function bossFrac(bossHp) {
  if (!isObj(bossHp)) return null;
  const hp = Number(bossHp.hp);
  const max = Number(bossHp.max ?? bossHp.maxHp);
  if (!Number.isFinite(hp) || !Number.isFinite(max) || max <= 0) return null;
  return clamp(hp / max, 0, 1);
}

/**
 * The boss bar's percentage text for a fraction (bossFrac): whole percents from 10 %, one decimal below, and never
 * "0.0%" while the leader still has HP — a sliver reads "<0.1%" (user playtest #6 item 5: a bar at 0.0 % with the
 * leader still fighting read as a leader that could not die). null for an unknown fraction.
 * @param {number|null} frac
 */
export function bossPctText(frac) {
  if (frac == null || !Number.isFinite(frac)) return null;
  const pct = clamp(frac, 0, 1) * 100;
  if (pct >= 10) return `${pct.toFixed(0)}%`;
  if (pct > 0 && pct < 0.05) return '<0.1%';
  return `${pct.toFixed(1)}%`;
}

/** Whether a snapshot unit tuple has a flag. */
export const hasFlag = (flags, bit) => (Number(flags) & bit) !== 0;
export { UF };

// ---- stats & range --------------------------------------------------------------------------------------------

/** Attack interval in seconds (bat × 100 / aspd). */
export function attackInterval(bat, aspd = 100) {
  const b = Number(bat);
  const a = Number(aspd) > 0 ? Number(aspd) : 100;
  if (!Number.isFinite(b) || b <= 0) return null;
  return b * 100 / a;
}

/**
 * Compact number: 12345 → '12,345'; 1.5e6 → '150万' in Chinese, whose units count in 10⁴ / 10⁸ steps (万 / 亿; a language
 * pack names its own pair in `_meta.numberUnits`, shared/i18nPacks.js — no template can move the decimal point); a
 * language without them uses the thousands-based units: 1.5e6 → '1.5M', 2.5e5 → '250K', 3e9 → '3B' (English).
 */
export function fmtNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const units = langInfo()?.numberUnits;
  if (!units) {
    if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(Math.abs(n) >= 1e10 ? 0 : 1)}B`;
    if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(Math.abs(n) >= 1e7 ? 0 : 1)}M`;
    if (Math.abs(n) >= 1e5) return `${Math.round(n / 1e3)}K`;
    return Math.round(n).toLocaleString('en-US');
  }
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(n >= 1e9 ? 0 : 1)}${units[1]}`;
  if (Math.abs(n) >= 1e5) return `${(n / 1e4).toFixed(n >= 1e6 ? 0 : 1)}${units[0]}`;
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Bounding box + cell set of a range grid (always including the own tile [0,0]); `mirror` flips columns.
 * @param {Array<[number, number]>} grid [[dRow, dCol], …]
 * @param {boolean} [mirror]
 * @returns {{ rows: number, cols: number, r0: number, c0: number, cells: Set<string>, self: [number, number] }}
 */
export function rangeGridBox(grid, mirror = false) {
  const cells = new Set();
  let minR = 0; let maxR = 0; let minC = 0; let maxC = 0;
  for (const g of Array.isArray(grid) ? grid : []) {
    if (!Array.isArray(g) || !Number.isFinite(g[0]) || !Number.isFinite(g[1])) continue;
    const r = g[0];
    const c = mirror ? -g[1] : g[1];
    cells.add(tileKey(r, c));
    minR = Math.min(minR, r); maxR = Math.max(maxR, r); minC = Math.min(minC, c); maxC = Math.max(maxC, c);
  }
  return { rows: maxR - minR + 1, cols: maxC - minC + 1, r0: maxR, c0: minC, cells, self: [0, 0] };
}
