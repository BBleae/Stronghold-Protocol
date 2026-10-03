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

let SpineActor, prevPixi;
before(async () => {
  prevPixi = globalThis.PIXI;
  globalThis.PIXI = { spine: { Spine: class { constructor(d) { this.spineData = d; this.state = new State(d); this.stateData = {}; this.skeleton = { slots: [] }; } update(dt) { this.state.update(dt); } destroy() {} } } };
  ({ SpineActor } = await import('../../public/js/render/spine.js'));
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

describe('attacks', () => {
  test('星熊: Attack at its natural speed, idle until the next swing, every strike on its attack, no jumps', () => {
    const a = actor();
    const iv = 1.2; // her base attack interval (game s)
    a.windUp(iv, 0.2);
    assert.equal(clip(a), 'Attack');
    assert.equal(a.spine.state.tracks[0].timeScale, 1, 'not slowed to fit the interval');
    assert.ok(Math.abs(tt(a) - (0.333 - 0.2)) < 1e-6, 'started so the strike lands on the attack');
    run(a, 0.2);
    let strikes = 0;
    for (let k = 0; k < 6; k++) {
      // the attack event: the strike frame is showing (no re-phase needed)
      assert.equal(clip(a), 'Attack', `swing ${k}`);
      assert.ok(Math.abs(tt(a) - 0.333) < FRAME + 1e-6, `strike frame on attack ${k}: ${tt(a)}`);
      const before = tt(a);
      a.attack(iv);
      assert.equal(tt(a), before, 'the attack never moves the clip');
      strikes++;
      const seen = run(a, iv);
      assert.deepEqual(seen.filter((n, i) => i === 0 || n !== seen[i - 1]), ['Attack', 'Idle', 'Attack'], 'swing, idle, next swing');
    }
    assert.equal(strikes, 6);
  });

  test('fast attacks speed the clip up just enough; slow ones never slow it down', () => {
    const a = actor();
    a.attack(0.5);
    assert.ok(Math.abs(a.spine.state.tracks[0].timeScale - 2) < 1e-9);
    const b = actor();
    b.attack(3);
    assert.equal(b.spine.state.tracks[0].timeScale, 1);
  });

  test('a target below takes Attack_Down', () => {
    const a = actor();
    a.attack(1.2, true);
    assert.equal(clip(a), 'Attack_Down');
    a.attack(1.2, false);
    run(a, 1.2);
    assert.equal(a.down, false);
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
    assert.equal(a.spine.state.tracks[0].timeScale, 1, 'not stretched');
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
