// test/render/loadlevel.test.js — adaptive load level (render/loadlevel.js). Review of the upstream PR: the display
// period was the raw minimum frame interval of 2 s, so one early callback after a late one read a healthy 60 Hz screen
// as ~72 Hz and its ordinary 16.7 ms frames as too slow — level 3 (operators animating every 2nd frame) on good devices.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { estimatePeriod, createLoadGovernor } from '../../public/js/render/loadlevel.js';

/** Deterministic pseudo-random [0, 1). */
const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

/**
 * Run the governor `secs` real s: `period` the display's (ms), `late(i)` how late frame i's callback starts (ms), `skip(i)`
 * vsync periods frame i misses, `cpu` CPU ms per frame, `stamps` true when the animation-frame timestamps are used.
 */
function run({ secs = 60, period = 1000 / 60, late = () => 0, skip = () => 0, cpu = 5, busy = true, stamps = true }) {
  const g = createLoadGovernor();
  let vsync = 0, prevStart = 0, prevStamp = 0, frameMs = period;
  const levels = [];
  for (let i = 1; vsync < secs * 1000; i++) {
    vsync += period * (1 + skip(i));
    const start = vsync + late(i);
    const dt = (start - prevStart) / 1000, stampMs = vsync - prevStamp;
    prevStart = start; prevStamp = vsync;
    frameMs = frameMs * 0.9 + dt * 1000 * 0.1;
    levels.push(g.step(dt, stamps ? stampMs : dt * 1000, frameMs, cpu, busy));
  }
  const atTop = levels.filter((l) => l === 3).length / levels.length;
  return { g, levels, atTop, last: levels.at(-1) };
}

describe('estimatePeriod', () => {
  test('the recurring shortest interval, not one early outlier', () => {
    const s = Array.from({ length: 120 }, () => 16.67);
    s[40] = 11.7;                                  // an early callback after a late one
    assert.ok(Math.abs(estimatePeriod(s) - 16.67) < 0.01);
    assert.ok(Math.abs(estimatePeriod(Array.from({ length: 60 }, () => 33.3)) - 33.3) < 0.01, '30 fps cap');
    assert.ok(Math.abs(estimatePeriod(Array.from({ length: 240 }, () => 8.33)) - 8.33) < 0.01, '120 Hz');
    // a struggling 60 Hz device: most frames miss a vsync, some still make it — its period stays 16.7 ms
    const mix = Array.from({ length: 80 }, (_, i) => (i % 10 === 0 ? 16.67 : 33.3));
    assert.ok(Math.abs(estimatePeriod(mix) - 16.67) < 0.01);
    assert.equal(estimatePeriod([], 20), 20);
  });
});

describe('load governor', () => {
  test('a healthy busy 60 Hz device with ordinary callback jitter stays at level 0', () => {
    const r = rng(7);
    // callback starts 0–3 ms late, 1 % of frames 5–8 ms late
    const late = () => r() * 3 + (r() < 0.01 ? 5 + r() * 3 : 0);
    const withStamps = run({ late });
    assert.equal(withStamps.atTop, 0);
    assert.equal(Math.max(...withStamps.levels), 0, 'never steps up');
    // even with only the jittery callback times (no ticker timestamps)
    const noStamps = run({ late, stamps: false });
    assert.equal(Math.max(...noStamps.levels), 0);
  });

  test('a 30 fps capped display is not a struggling device; 144 Hz with jitter neither', () => {
    assert.equal(Math.max(...run({ period: 1000 / 30 }).levels), 0);
    const r = rng(3);
    assert.equal(Math.max(...run({ period: 1000 / 144, late: () => r() * 2 }).levels), 0);
  });

  test('a device that misses most vsyncs, or burns the frame on the CPU, steps up — and back after a calm spell', () => {
    const r = rng(11);
    const slow = run({ secs: 20, skip: () => (r() < 0.8 ? 1 : 0) });
    assert.equal(slow.last, 3, 'frames mostly 33 ms on a 60 Hz screen');
    assert.equal(Math.max(...run({ secs: 20, cpu: 14 }).levels), 3, 'CPU 14 ms of a 16.7 ms frame');
    const g = slow.g;
    let level = g.level;
    for (let i = 0; i < 60 * 60 && level > 0; i++) level = g.step(1 / 60, 1000 / 60, 1000 / 60, 4, true);
    assert.equal(level, 0, 'calm again: back to level 0');
  });
});
