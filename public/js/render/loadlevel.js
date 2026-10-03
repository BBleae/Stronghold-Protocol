// render/loadlevel.js — adaptive load level of the field view (render/app.js; pure logic, no PIXI / DOM).
//
// Level 0–3: a device that cannot hold the frame rate with the current work switches crowds to impostors earlier and
// animates small / far units at a lower rate (units.js); it steps back after a calm spell. "Cannot hold" is measured
// against the display's own frame period or a frame's own CPU time: a capped display (30 fps where the browser or a
// power-saving mode caps it) is not a struggling device (user report: 30-fps phones ended up at level 3, operators
// animating every 2nd–6th frame, i.e. 5–15 times a second).

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * The display's frame period (ms) from the frame intervals of the last ~2 s: the shortest interval that RECURS — the
 * median of the lowest cluster holding at least 3 samples (and 2 % of them) within +10 % — not the raw minimum: one
 * callback that starts early after a late one pulled the minimum down, a healthy 60 Hz screen was read as ~72 Hz and
 * its ordinary 16.7 ms frames as too slow, stepping it to level 3 (review of the upstream PR, 2026-10).
 * @param {number[]} samples frame intervals (ms)
 * @param {number} [fallback]
 */
export function estimatePeriod(samples, fallback = 1000 / 60) {
  const s = (samples || []).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!s.length) return fallback;
  const need = Math.max(3, Math.ceil(s.length * 0.02));
  if (s.length < need) return clamp(s[s.length >> 1], 1000 / 240, 50);
  let j = 0;
  for (let i = 0; i < s.length; i++) {
    if (j < i) j = i;
    while (j < s.length && s[j] <= s[i] * 1.1) j++;
    if (j - i >= need) return clamp(s[(i + j - 1) >> 1], 1000 / 240, 50);
  }
  return clamp(s[s.length >> 1], 1000 / 240, 50);
}

/**
 * The level governor. step(dt, sampleMs, frameMs, cpuMs, busy) once per frame: `dt` real s since the last frame,
 * `sampleMs` this frame's interval for the period estimate (the animation-frame timestamps' delta — vsync aligned —
 * when available), `frameMs` / `cpuMs` the smoothed frame interval / CPU time, `busy` a crowded field. Returns the level;
 * `onChange(level)` fires on every change.
 */
export function createLoadGovernor({ onChange = null } = {}) {
  let level = 0, slowFor = 0, fastFor = 0, periodMs = 1000 / 60, age = 0, estimated = false;
  const samples = [];
  return {
    get level() { return level; },
    get periodMs() { return periodMs; },
    step(dt, sampleMs, frameMs, cpuMs, busy) {
      if (!(dt > 0) || dt > 0.25) return level;
      if (sampleMs > 0 && sampleMs < 250) { samples.push(sampleMs); if (samples.length > 1024) samples.shift(); }
      age += dt;
      // the first estimate after 0.5 s, then every 2 s; nothing counts as slow before the first one (a 30 fps screen
      // measured against the 60 Hz default looked slow for its first seconds)
      if (age >= (estimated ? 2 : 0.5)) { periodMs = estimatePeriod(samples, periodMs); samples.length = 0; age = 0; estimated = true; }
      if (!estimated) return level;
      if (busy && (frameMs > periodMs * 1.2 || cpuMs > periodMs * 0.75)) { slowFor += dt; fastFor = 0; }
      else if (frameMs < periodMs * 1.08 && cpuMs < periodMs * 0.5) { fastFor += dt; slowFor = 0; }
      if (slowFor > 1 && level < 3) { level++; slowFor = 0; fastFor = 0; onChange?.(level); }
      else if (level > 0 && (fastFor > 6 * level || !busy && fastFor > 2)) { level--; fastFor = 0; onChange?.(level); }
      return level;
    },
  };
}
