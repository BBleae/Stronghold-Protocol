// test/render/spine-anim.test.js — render/spine.js SpineActor plays attacks and skills like the original (user report:
// skill clips cut, sluggish and jerky attacks, models bobbing at their targets; the original's battle animation is the
// authority). A fake pixi-spine whose AnimationState advances track time and plays queued clips, and the real manifest
// entry of 星熊 (char_136_hsguma: Attack / Attack_Down strike at 0.333 s; Skill_Begin strikes at the same frame, Skill
// holds the shield, Skill_End).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const assets = JSON.parse(readFileSync(path.join(ROOT, 'data/assets.json'), 'utf8'));
const HSGUMA = assets.chars.char_136_hsguma.spine.front;

class Entry { constructor(a, loop) { this.animation = a; this.loop = loop; this.trackTime = 0; this.timeScale = 1; this.mixDuration = 0.12; } }
class State {
  constructor(data) { this.data = data; this.tracks = []; this.queue = []; this.sets = []; }
  setAnimation(t, name, loop) { const e = new Entry(this.data.findAnimation(name), loop); this.tracks[t] = e; this.queue = []; this.sets.push(name); return e; }
  addAnimation(t, name, loop) { const e = new Entry(this.data.findAnimation(name), loop); if (!this.tracks[t]) this.tracks[t] = e; else this.queue.push(e); return e; }
  update(dt) {
    const e = this.tracks[0];
    if (!e) return;
    e.trackTime += dt * e.timeScale;
    if (!e.loop && e.trackTime >= e.animation.duration && this.queue.length) {
      const n = this.queue.shift(); n.trackTime = (e.trackTime - e.animation.duration) * n.timeScale / e.timeScale; this.tracks[0] = n;
    }
  }
}
function spineData(entry) {
  const anims = Object.entries(entry.animations || {}).map(([name, duration]) => ({ name, duration: duration > 0 ? duration : 1 }));
  return { animations: anims, skins: [], findAnimation: (n) => anims.find((a) => a.name === n) || null };
}

let SpineActor, ATTACK_STRETCH, prevPixi;
before(async () => {
  prevPixi = globalThis.PIXI;
  globalThis.PIXI = { spine: { Spine: class { constructor(d) { this.spineData = d; this.state = new State(d); this.stateData = {}; this.skeleton = { slots: [] }; } update(dt) { this.state.update(dt); } destroy() {} } } };
  ({ SpineActor, ATTACK_STRETCH } = await import('../../public/js/render/spine.js'));
});
after(() => { globalThis.PIXI = prevPixi; });

const FRAME = 1 / 30; // game seconds per frame (60 fps × the 2× battle speed)
const actor = (entry = HSGUMA) => new SpineActor(spineData(entry), entry);
const clip = (a) => a.spine.state.tracks[0]?.animation?.name;
const tt = (a) => a.spine.state.tracks[0]?.trackTime;
/** Advance `sec` game seconds frame by frame; returns the clip names seen. */
function run(a, sec, onFrame) {
  const seen = [];
  for (let t = 0; t < sec - 1e-9; t += FRAME) { onFrame?.(a); a.update(FRAME); if (seen.at(-1) !== clip(a)) seen.push(clip(a)); }
  return seen;
}

const TEXAS = assets.chars.char_102_texas.spine.front;
const LOOKAHEAD = 1.0; // game s (render/app.js RENDER_DELAY 0.5 real s × 2)

/**
 * Drive an actor the way render/app.js does: attacks at `times` (game s) are known LOOKAHEAD ahead — windUp each frame
 * until it starts the swing, setUpcoming with the next one, attack() when it is due. Records every clip start
 * { t, name, at: track time, ts } and, at each attack, the clip and its track time.
 */
function drive(a, times, { iv, until, down = () => false } = {}) {
  const starts = [], strikes = [];
  const st = a.spine.state, set = st.setAnimation.bind(st);
  st.setAnimation = (tr, name, loop) => { const e = set(tr, name, loop); starts.push({ t: clockT, name, e }); return e; };
  let clockT = 0, k = 0;
  const wound = new Set();
  for (; clockT < until - 1e-9; clockT += FRAME) {
    while (k < times.length && times[k] <= clockT + 1e-9) {
      strikes.push({ t: times[k], clip: clip(a), at: tt(a) });
      a.attack(iv, down(k));
      k++;
    }
    for (let j = k; j < times.length && times[j] - clockT <= LOOKAHEAD; j++) {
      if (!wound.has(j) && a.windUp(iv, times[j] - clockT, down(j))) wound.add(j);
    }
    a.setUpcoming(k < times.length && times[k] - clockT <= LOOKAHEAD ? times[k] - clockT : Infinity, LOOKAHEAD);
    for (const x of starts) if (x.at == null) x.at = x.e.trackTime; // where the clip was started (set after setAnimation)
    a.update(FRAME);
  }
  for (const x of starts) delete x.e;
  return { starts, strikes };
}

describe('attacks', () => {
  test('星熊: every swing from its first frame, the strike on its attack, idle between, none after the last', () => {
    const a = actor();
    const iv = 1.2, times = [1, 2.2, 3.4, 4.6, 5.8];
    const swings = [];
    const st = a.spine.state, set = st.setAnimation.bind(st);
    st.setAnimation = (tr, name, loop) => { const e = set(tr, name, loop); if (name === 'Attack') swings.push(e); return e; };
    const { strikes } = drive(a, times, { iv, until: 9 });
    assert.equal(swings.length, times.length, 'one swing per attack, no swing at nothing');
    for (const e of swings) assert.ok(Math.abs(e.timeScale - 1 / 1.2) < 1e-9, 'fills the interval (stretched ≤ 1.25)');
    for (const s of strikes) {
      assert.equal(s.clip, 'Attack');
      assert.ok(Math.abs(s.at - 0.333) < FRAME + 1e-6, `strike frame on the attack: ${s.at}`);
    }
    assert.equal(clip(a), 'Idle', 'idle after the last swing');
  });

  test('德克萨斯: Attack_Start once, the loop once per attack, then Attack_End from its first frame — no slide', () => {
    const a = actor(TEXAS);
    const iv = 1.05, times = [2, 3.05, 4.1, 5.15];
    const { starts, strikes } = drive(a, times, { iv, until: 9 });
    const names = starts.map((x) => x.name);
    assert.deepEqual(names.filter((n) => n.startsWith('Attack')), ['Attack_Start', 'Attack_End'], `engage and leave once: ${names}`);
    const start = starts.find((x) => x.name === 'Attack_Start');
    assert.ok(start.at < FRAME, `Attack_Start from its first frame (the look-ahead covers start + strike): ${start.at}`);
    for (const s of strikes) {
      assert.equal(s.clip, 'Attack_Loop');
      assert.ok(Math.abs(s.at % 1 - 0.467) < 2 * FRAME, `strike frame on the attack: ${s.at}`);
    }
    const end = starts.find((x) => x.name === 'Attack_End');
    // started inside update(), then advanced by that frame: within one frame of its first
    assert.ok(end.at <= FRAME + 1e-6, `Attack_End from its first frame (the loop's last): ${end.at}`);
    assert.ok(end.t > times.at(-1) && end.t < times.at(-1) + iv, `ends within the cycle after the last attack: ${end.t}`);
    assert.equal(clip(a), 'Idle');
  });

  test('a late attack (no look-ahead) shows its strike frame at once; fast attacks speed the clip up', () => {
    const a = actor();
    a.attack(0.5);
    assert.equal(clip(a), 'Attack');
    assert.ok(Math.abs(tt(a) - 0.333) < 1e-9);
    assert.ok(Math.abs(a.spine.state.tracks[0].timeScale - 2) < 1e-9);
  });

  test('a target below takes Attack_Down', () => {
    const a = actor();
    a.attack(1.2, true);
    assert.equal(clip(a), 'Attack_Down');
  });
});

describe('skills', () => {
  test('the begin clip plays out even when attacks come during it; the stance is held between strikes', () => {
    const a = actor();
    a.setSkillIndex(2);
    a.attack(1.2);
    a.setSkill(true);
    assert.equal(clip(a), 'Skill_Begin');
    const seen = run(a, 0.733 - FRAME, (x) => x.attack(1.2)); // an attack every frame: none cuts the begin
    assert.deepEqual(seen, ['Skill_Begin'], 'begin played out');
    run(a, 0.1);
    assert.equal(clip(a), 'Skill', 'then the shield stance');
    // an attack during the skill: 星熊 strikes with Skill_Begin (it has the strike frame; Skill has none), then holds Skill
    a.attack(1.2);
    assert.equal(clip(a), 'Skill_Begin');
    assert.equal(a.spine.state.tracks[0].timeScale, ATTACK_STRETCH, 'stretched no more than the original allows');
    const after2 = run(a, 1.2);
    assert.ok(after2.includes('Skill'), `stance between strikes: ${after2}`);
    a.attack(1.2, true);
    assert.equal(clip(a), 'Skill_Down_Begin', 'below: the Down variant');
  });

  test('skill off: the end clip plays out, attacks wait for it', () => {
    const a = actor();
    a.setSkill(true);
    run(a, 1);
    a.setSkill(false);
    assert.equal(clip(a), 'Skill_End');
    a.attack(1.2);
    assert.equal(clip(a), 'Skill_End');
    run(a, 0.45);
    assert.equal(a.mode, 'base');
    a.attack(1.2);
    assert.equal(clip(a), 'Attack');
  });

  test('an instant skill (on and off at once) still shows its begin, then its end', () => {
    const a = actor();
    a.setSkill(true);
    a.setSkill(false);
    assert.equal(clip(a), 'Skill_Begin');
    const seen = run(a, 1.3);
    assert.deepEqual(seen, ['Skill_Begin', 'Skill_End', 'Idle']);
  });

  test('德克萨斯: a skill clip without a strike frame is held, not replayed at every attack', () => {
    const a = actor(TEXAS);
    a.setSkill(true);
    run(a, 0.3);
    assert.equal(clip(a), 'Skill');
    const e = a.spine.state.tracks[0];
    a.attack(1.05);
    run(a, 0.1);
    assert.equal(a.spine.state.tracks[0], e, 'the same Skill entry runs on');
  });

  test('a looping base clip already playing is not restarted (Idle@x → Idle@0 was a pop)', () => {
    const entry = { anims: { idle: 'Idle', attack: { begin: null, loop: 'Attack', end: null }, skill: { begin: null, loop: 'Skill_2', end: null } },
      animations: { Idle: 2, Attack: 1, Skill_2: 1.5 }, hits: { Attack: [0.4], Skill_2: [0.6] } };
    const a = actor(entry);
    run(a, 0.5);
    const e = a.spine.state.tracks[0];
    a.setSkill(true);
    run(a, 1);
    a.setSkill(false);
    assert.equal(a.spine.state.tracks[0], e, 'Idle keeps running');
  });

  test('an instant skill without a begin clip plays its skill clip once', () => {
    const entry = { anims: { idle: 'Idle', attack: { begin: null, loop: 'Attack', end: null }, skill: { begin: null, loop: 'Skill_2', end: null } },
      animations: { Idle: 2, Attack: 1, Skill_2: 1.5 }, hits: { Attack: [0.4], Skill_2: [0.6] } };
    const a = actor(entry);
    a.setSkill(true);
    a.setSkill(false);
    assert.equal(clip(a), 'Skill_2');
    a.attack(1);
    assert.equal(clip(a), 'Skill_2', 'not cut by an attack');
    const seen = run(a, 1.6);
    assert.deepEqual(seen, ['Skill_2', 'Idle']);
  });
});

describe('units.js', () => {
  test('targetBelow: more than half a tile towards the camera and more below than beside; enemies never', async () => {
    const { targetBelow } = await import('../../public/js/render/units.js');
    const me = { x: 5, y: 10, isEnemy: false };
    assert.equal(targetBelow(me, { x: 5, y: 9 }), true);
    assert.equal(targetBelow(me, { x: 5.6, y: 9.2 }), true, "星熊's blocked enemy down-right");
    assert.equal(targetBelow(me, { x: 6, y: 10 }), false);
    assert.equal(targetBelow(me, { x: 8, y: 8 }), false, 'more beside than below');
    assert.equal(targetBelow(me, { x: 5, y: 11 }), false, 'above');
    assert.equal(targetBelow({ ...me, isEnemy: true }, { x: 5, y: 9 }), false);
    assert.equal(targetBelow(me, null), false);
  });
});
