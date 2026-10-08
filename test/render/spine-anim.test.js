// test/render/spine-anim.test.js — render/spine.js SpineActor plays attacks and skills like the original (user report:
// skill clips cut, sluggish and jerky attacks, models bobbing at their targets; the original's battle animation is the
// authority). On the REAL Spine 3.8 AnimationState (test/helpers/realSpine.js: queue / delay / mix / events / pooled
// TrackEntries exactly as in the game; skeletons built from the manifest, so no game assets are needed). Review of the
// upstream PR (2026-10): the earlier hand-written fake had none of that, and the attack / base hand-over bugs it hid are
// pinned here. Real manifest entries: 星熊 (char_136_hsguma: Attack / Attack_Down strike at 0.333 s; Skill_Begin strikes
// at the same frame, Skill holds the shield, Skill_End), 德克萨斯 (Attack_Start → Attack_Loop → Attack_End), 耀骑士临光
// (Attack_Begin / Loop / End, Skill_3 one swing per attack with Skill_3_Idle), a blocked / walking enemy (Attack, Move).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MANIFEST, installRealSpine, skeletonData } from '../helpers/realSpine.js';

const HSGUMA = MANIFEST.chars.char_136_hsguma.spine.front;
const TEXAS = MANIFEST.chars.char_102_texas.spine.front;
const NEARL2 = MANIFEST.chars.char_1014_nearl2.spine.front;
const LRSLDR = MANIFEST.enemies.enemy_1422_lrsldr.spine;

let SpineActor, ATTACK_STRETCH, attackTimeScale, nextInterval, restore;
before(async () => {
  restore = installRealSpine();
  ({ SpineActor, ATTACK_STRETCH, attackTimeScale } = await import('../../public/js/render/spine.js'));
  ({ nextInterval } = await import('../../public/js/render/units.js'));
});
after(() => restore());

const FRAME = 1 / 30; // game seconds per frame (60 fps × the 2× battle speed)
const actor = (entry = HSGUMA) => new SpineActor(skeletonData(entry), entry);
const clip = (a) => a.spine.state.tracks[0]?.animation?.name;
const tt = (a) => a.spine.state.tracks[0]?.trackTime;
/** Advance `sec` game seconds frame by frame; returns the clip names seen. */
function run(a, sec, onFrame) {
  const seen = [];
  for (let t = 0; t < sec - 1e-9; t += FRAME) { onFrame?.(a); a.update(FRAME); if (seen.at(-1) !== clip(a)) seen.push(clip(a)); }
  return seen;
}
/** Record every clip the actor starts: { name, at: its start track time, ts } (read on the next frame: pooled entries). */
function recordStarts(a, clock = () => a.clock) {
  const starts = [], pend = [];
  const st = a.spine.state, set = st.setAnimation.bind(st);
  st.setAnimation = (tr, name, loop) => { const e = set(tr, name, loop); const x = { t: clock(), name, e }; starts.push(x); pend.push(x); return e; };
  const settle = () => { for (const x of pend) { x.at = x.e.trackTime; x.ts = x.e.timeScale; delete x.e; } pend.length = 0; };
  return { starts, settle };
}
/** Record the OnAttack events (strike frames) the actor's skeleton fires: { t: actor clock, clip }. */
function recordStrikes(a) {
  const strikes = [];
  a.spine.state.addListener({ event: (entry, ev) => { if (ev?.data?.name === 'OnAttack') strikes.push({ t: a.clock, clip: entry.animation?.name }); } });
  return strikes;
}

const LOOKAHEAD = 1.0; // game s (render/app.js LOOK_AHEAD: the render clock trails the newest snapshot by 1 game s)

/**
 * Drive an actor the way render/app.js and units.js do: an attack at `times[k]` (game s; its time is its identity) is
 * known `look` game s ahead — windUp every frame until a swing is started for it (then never asked again: app.js
 * `woundUp`), setUpcoming with the next one, attack() when it is due; the interval is units.js' estimate (nextInterval)
 * unless `iv` is fixed. `every`: the skeleton is updated every n-th frame with the time of the skipped ones (units.js
 * impostor LOD). `at(t)` runs before each frame (setBase, setSkill…). Returns the clip starts, the strikes (OnAttack, on
 * the actor's clock), and per attack the clip and its track time when it was due.
 */
function drive(a, times, { iv = null, iv0 = 1, until, look = LOOKAHEAD, every = 1, down = () => false, at = null, onFrame = null } = {}) {
  let clockT = 0, k = 0, acc = 0, est = iv ?? iv0, prevGap = null, last = null, frame = 0;
  const { starts, settle } = recordStarts(a, () => clockT);
  const strikes = recordStrikes(a);
  const due = [], wound = new Set();
  for (; clockT < until - 1e-9; clockT += FRAME, frame++) {
    at?.(clockT, a);
    while (k < times.length && times[k] <= clockT + 1e-9) {
      if (iv == null && last != null) { const d = times[k] - last; est = nextInterval(est, d, prevGap); if (d > 0.05) prevGap = d; }
      last = times[k];
      due.push({ t: times[k], clip: clip(a), at: tt(a) });
      a.attack(est, down(k));
      k++;
    }
    for (let j = k; j < times.length && times[j] - clockT <= look; j++) {
      if (!wound.has(j) && a.windUp(est, times[j] - clockT, down(j), times[j])) wound.add(j);
    }
    a.setUpcoming(k < times.length && times[k] - clockT <= look ? times[k] - clockT : Infinity, look);
    settle();
    acc += FRAME;
    if (frame % every === 0) { a.update(acc); acc = 0; }
    onFrame?.(clockT, a);
  }
  settle();
  return { starts, strikes, due };
}
/** The strikes matched to attacks: for each attack the strikes within `tol` game s of it (the drawn strike frame). */
function strikesPerAttack(times, strikes, tol) {
  return times.map((t) => strikes.filter((s) => Math.abs(s.t - t) <= tol).length);
}

describe('attacks', () => {
  test('星熊: every swing from its first frame, the strike on its attack, idle between, none after the last', () => {
    const a = actor();
    const iv = 1.2, times = [1, 2.2, 3.4, 4.6, 5.8];
    const { starts, strikes, due } = drive(a, times, { iv, until: 9 });
    const swings = starts.filter((x) => x.name === 'Attack');
    assert.equal(swings.length, times.length, 'one swing per attack, no swing at nothing');
    for (const x of swings) {
      assert.ok(Math.abs(x.ts - 1 / 1.2) < 1e-9, 'fills the interval (stretched ≤ 1.25)');
      assert.ok(x.at < FRAME * x.ts + 1e-6, `from its first frame (within the frame it was wound up in): ${x.at}`);
    }
    for (const d of due) {
      assert.equal(d.clip, 'Attack');
      assert.ok(Math.abs(d.at - 0.333) < FRAME + 1e-6, `strike frame on the attack: ${d.at}`);
    }
    assert.deepEqual(strikesPerAttack(times, strikes, 0.05), times.map(() => 1), 'the strike frame fires once, on the attack');
    assert.equal(strikes.length, times.length);
    assert.equal(clip(a), 'Idle', 'idle after the last swing');
  });

  test('德克萨斯: Attack_Start once, the loop once per attack, then Attack_End from its first frame — no slide', () => {
    const a = actor(TEXAS);
    const iv = 1.05, times = [2, 3.05, 4.1, 5.15];
    const { starts, strikes, due } = drive(a, times, { iv, until: 9 });
    const names = starts.map((x) => x.name);
    assert.deepEqual(names.filter((n) => n.startsWith('Attack')), ['Attack_Start', 'Attack_End'], `engage and leave once: ${names}`);
    const start = starts.find((x) => x.name === 'Attack_Start');
    assert.ok(start.at < FRAME, `Attack_Start from its first frame (the look-ahead covers start + strike): ${start.at}`);
    for (const d of due) {
      assert.equal(d.clip, 'Attack_Loop');
      assert.ok(Math.abs(d.at % 1 - 0.467) < 2 * FRAME, `strike frame on the attack: ${d.at}`);
    }
    assert.deepEqual(strikesPerAttack(times, strikes, 0.07), times.map(() => 1));
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
    const { starts } = recordStarts(a);
    const t0 = tt(a);
    a.attack(1.05);
    run(a, 0.1);
    assert.deepEqual(starts.map((x) => x.name), [], 'nothing restarted');
    assert.ok(tt(a) > t0, 'the same Skill runs on');
  });

  test('a looping base clip already playing is not restarted (Idle@x → Idle@0 was a pop)', () => {
    // a skill whose clip is the attack clip plays nothing of its own when it starts (a lone skill clip of its own plays
    // once since upstream #160, DESIGN §24.1), so the idle simply runs on
    const entry = { anims: { idle: 'Idle', attack: { begin: null, loop: 'Attack', end: null }, skill: { begin: null, loop: 'Attack', end: null } },
      animations: { Idle: 2, Attack: 1 }, hits: { Attack: [0.4] } };
    const a = actor(entry);
    run(a, 0.5);
    const { starts } = recordStarts(a);
    a.setSkill(true);
    run(a, 1);
    a.setSkill(false);
    assert.deepEqual(starts.map((x) => x.name), [], 'nothing restarted');
    assert.equal(clip(a), 'Idle');
    assert.ok(tt(a) > 1.4, `Idle keeps running: ${tt(a)}`);
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

describe('the resting state after a swing (review of the upstream PR, point 3)', () => {
  test('an enemy blocked while it winds up idles after the swing — not the walk queued behind it at wind-up', () => {
    const a = actor(LRSLDR);
    a.setBase('move');
    let next = null;
    // the strike is stamped where the sim stops it: the swing starts while the snapshot still says it walks
    drive(a, [2], { iv: 2, until: 6, at: (t, x) => { if (Math.abs(t - 1.5) < 1e-6) { x.setBase('idle'); next = x.spine.state.tracks[0]?.next?.animation?.name; } } });
    assert.equal(next, 'Idle', 'the clip queued behind the swing follows the new resting state at once');
    assert.equal(clip(a), 'Idle');
  });

  test('a unit whose blocker died during its swing walks on after it, and keeps walking', () => {
    const a = actor(LRSLDR);
    const seen = [];
    drive(a, [2], { iv: 2, until: 12, at: (t, x) => { if (Math.abs(t - 2.2) < 1e-6) x.setBase('move'); }, onFrame: (t, x) => { if (t > 3.2 && seen.at(-1) !== clip(x)) seen.push(clip(x)); } });
    assert.deepEqual(seen, ['Move'], `walks from the end of the swing on: ${seen}`);
  });

  test('a resting state that changed before the swing ended is played even without a queued clip to replace', () => {
    const a = actor(LRSLDR);
    a.setBase('move');
    drive(a, [2], { iv: 2, until: 6, at: (t, x) => {
      // as if the runtime had no disposeNext: the base after the swing must still be the current one
      if (Math.abs(t - 1.5) < 1e-6) { const st = x.spine.state; const dn = st.disposeNext; st.disposeNext = undefined; x.setBase('idle'); st.disposeNext = dn; }
    } });
    assert.equal(clip(a), 'Idle');
  });

  test('耀骑士临光: a single-clip skill that begins mid attack loop leaves the loop at once for its stance', () => {
    const a = actor(NEARL2);
    const seen = [];
    drive(a, [2, 3.5, 5], { iv: 1.5, until: 12, at: (t, x) => { if (Math.abs(t - 5.6) < 1e-6) x.setSkill(true); },
      onFrame: (t, x) => { if (t > 5.7 && seen.at(-1) !== clip(x)) seen.push(clip(x)); } });
    assert.deepEqual(seen, ['Skill_3_Idle'], `never back to Attack_Loop: ${seen}`);
  });

  test('a skill that begins during a one-shot swing does not cut it: the strike frame still fires on the attack', () => {
    const entry = { anims: { idle: 'Idle', attack: { begin: null, loop: 'Attack', end: null }, skill: { begin: null, loop: 'Skill_2', end: null } },
      animations: { Idle: 2, Attack: 1, Skill_2: 1.5 }, hits: { Attack: [0.4], Skill_2: [0.6] } };
    const a = actor(entry);
    let swingAt = null;
    const { strikes } = drive(a, [2], { iv: 1, until: 4, at: (t, x) => {
      if (swingAt == null && clip(x) === 'Attack') swingAt = t;
      if (swingAt != null && Math.abs(t - swingAt - 0.1) < FRAME / 2) x.setSkill(true);
    } });
    assert.ok(swingAt != null && swingAt < 2);
    assert.deepEqual(strikes.map((x) => x.clip), ['Attack']);
    assert.ok(Math.abs(strikes[0].t - 2) < 0.05, `on the attack: ${strikes[0].t}`);
  });

  test('the actor never reads state.queue as a list (the runtime\'s queue is its event queue)', () => {
    const reads = [];
    for (const entry of [HSGUMA, TEXAS, LRSLDR]) {
      const a = actor(entry);
      Object.defineProperty(a.spine.state.queue, 'length', { get() { reads.push(entry.skel); return undefined; }, configurable: true });
      a.setBase('move');
      drive(a, [1.5, 2.6, 3.7], { iv: 1.1, until: 6, at: (t, x) => { if (Math.abs(t - 2) < 1e-6) x.setBase('idle'); } });
    }
    assert.deepEqual(reads, []);
  });
});

describe('fast attackers (review of the upstream PR, point 4)', () => {
  test('every attack gets its own swing from the first frame, whatever the interval and look-ahead — no strike-frame entry', () => {
    for (const iv of [0.6, 0.8, 1.0, 1.2]) {
      for (const look of [1.0, 2.0]) {
        const a = actor();
        const times = Array.from({ length: 20 }, (_, i) => 2 + i * iv);
        const { starts, strikes } = drive(a, times, { iv, look, until: times.at(-1) + 2 });
        const swings = starts.filter((x) => x.name === 'Attack');
        const label = `iv ${iv}, look-ahead ${look}`;
        assert.equal(swings.length, times.length, `${label}: one swing per attack`);
        for (const x of swings) assert.ok(x.at < 0.333 - 1e-3, `${label}: swing entered at ${x.at}, its strike frame is at 0.333`);
        assert.deepEqual(strikesPerAttack(times, strikes, 0.1), times.map(() => 1), `${label}: one strike on each attack`);
        assert.equal(strikes.length, times.length, `${label}: no extra strikes`);
      }
    }
  });

  test('a swing is reported only for the attack it was wound up for (and that attack\'s other targets)', () => {
    const a = actor();
    assert.equal(a.windUp(0.6, 0.15, false, 2), true, 'started for the attack at 2');
    const { starts } = recordStarts(a);
    assert.equal(a.windUp(0.6, 0.15, false, 2), true, 'a second target of the same attack: no restart');
    assert.equal(a.windUp(0.6, 0.8, false, 2.6), false, 'the next attack is asked again later');
    assert.deepEqual(starts.map((x) => x.name), []);
  });

  test('an interval estimate that is too long (two long gaps, then a burst) never cuts an earlier swing before its strike', () => {
    // 古米-like late strike frame: Attack 1.533 s, OnAttack at 0.733 — the estimate (2.7 s after two ~2.8 s gaps) opens the
    // next wind-up before the previous swing struck
    const a = actor(MANIFEST.chars.char_4207_branch.spine.back);
    const times = [2.0, 4.9, 7.6, 8.43, 9.26, 10.09, 10.92];
    const { starts, strikes } = drive(a, times, { iv0: 0.83, until: 13 });
    assert.deepEqual(strikesPerAttack(times, strikes, 0.1), times.map(() => 1), `strikes ${strikes.map((x) => x.t.toFixed(2))}`);
    for (const x of starts.filter((y) => y.name === 'Attack')) assert.ok(x.at < 0.733 - 1e-3, `no swing entered at its strike frame: ${x.t.toFixed(2)}@${x.at.toFixed(2)}`);
  });

  test('with the skeleton updated only every 3rd frame (impostor LOD), still one swing and one strike per attack', () => {
    for (const iv of [0.6, 1.0]) {
      for (const look of [1.0, 2.0]) {
        const a = actor();
        const times = Array.from({ length: 20 }, (_, i) => 2 + i * iv);
        const { starts, strikes } = drive(a, times, { iv, look, every: 3, until: times.at(-1) + 2 });
        const label = `iv ${iv}, look-ahead ${look}`;
        assert.equal(starts.filter((x) => x.name === 'Attack').length, times.length, `${label}: one swing per attack`);
        assert.equal(strikes.length, times.length, `${label}: one strike per attack`);
        assert.deepEqual(strikesPerAttack(times, strikes, 0.15), times.map(() => 1), label);
      }
    }
  });
});

describe('loop attacks keep the original constant speed (review of the upstream PR, point 5)', () => {
  test('nextInterval: a pause is no interval; a new rhythm is taken at once; jitter is smoothed', () => {
    assert.equal(nextInterval(1.05, 5.5, 1.05), 1.05, 'a 5.5 s pause');
    assert.equal(nextInterval(1.05, 3, 1.05), 1.05, 'a 3 s pause');
    assert.ok(Math.abs(nextInterval(1.05, 1.1, 1.05) - 1.075) < 1e-9, 'jitter: averaged');
    assert.equal(nextInterval(1.05, 0.63, 1.05), 0.63, 'attack speed up: at once');
    // and back: the first long gap could be a pause, the second like it is the rhythm (never frozen at the fast one)
    let iv = 0.63, prev = 0.63;
    for (const d of [1.07, 1.07]) { iv = nextInterval(iv, d, prev); prev = d; }
    assert.equal(iv, 1.07);
    assert.equal(nextInterval(1, 0.01, 1), 1, 'the same attack (another target)');
  });

  for (const pause of [1.5, 3, 5.5]) {
    test(`德克萨斯 after a ${pause} s pause: every strike on its attack, the loop at its constant speed`, () => {
      const a = actor(TEXAS);
      const iv = 1.05, before = Array.from({ length: 6 }, (_, i) => 2 + i * iv);
      const resume = before.at(-1) + iv + pause;
      const times = [...before, ...Array.from({ length: 6 }, (_, i) => resume + i * iv)];
      const bad = [];
      const { starts, strikes } = drive(a, times, { iv0: iv, until: times.at(-1) + 3, onFrame: (t, x) => {
        const e = x.spine.state.tracks[0];
        if (e?.animation?.name === 'Attack_Loop' && Math.abs(e.timeScale - attackTimeScale(1, x.interval, true)) > 1e-9) bad.push([t, e.timeScale, x.interval]);
      } });
      assert.deepEqual(bad, [], 'never sped up or slowed down to catch an attack');
      assert.deepEqual(strikesPerAttack(times, strikes, 0.1), times.map(() => 1), `strikes ${strikes.map((x) => x.t.toFixed(2))}`);
      assert.equal(strikes.length, times.length);
      assert.ok(starts.filter((x) => x.name === 'Attack_Start').length <= 2, 'engaged again once after the pause at most');
      assert.ok(Math.abs(a.interval - iv) < 1e-9, `the pause is no interval: ${a.interval}`);
    });
  }

  // a loop whose strike frame is at (or just after) the start of its cycle: the strike right at the wrap belongs to the
  // attack shown just before it, not to the next one (review of the review fixes: such loops ended at their own strike)
  for (const [id, name] of [['char_4194_rmixer', 'rmixer'], ['char_498_inside', 'inside'], ['char_4211_snhunt', 'snhunt']]) {
    test(`${name} (strike frame at the start of its loop): engaged once, every strike on its attack — also with the LOD and the interval estimate`, () => {
      const entry = MANIFEST.chars[id].spine.front;
      for (const iv of [1.0, 1.3]) {
        for (const every of [1, 3]) {
          const a = actor(entry);
          const times = Array.from({ length: 16 }, (_, i) => 2 + i * iv);
          const { starts, strikes } = drive(a, times, { iv0: iv, every, until: times.at(-1) + 3 });
          const label = `${name} iv ${iv} every ${every}`;
          assert.equal(starts.filter((x) => x.name === 'Attack_Begin').length, 1, `${label}: engaged once (${starts.map((x) => x.name)})`);
          assert.equal(starts.filter((x) => x.name === 'Attack_End').length, 1, `${label}: ended once`);
          assert.deepEqual(strikesPerAttack(times, strikes, every === 1 ? 0.1 : 0.17), times.map(() => 1), `${label}: strikes ${strikes.map((x) => x.t.toFixed(2))}`);
        }
      }
    });
  }

  test('snhunt: a rhythm change of 15 % (an attack-speed skill) keeps every strike on its attack', () => {
    const a = actor(MANIFEST.chars.char_4211_snhunt.spine.front);
    const first = Array.from({ length: 6 }, (_, i) => 2 + i * 1.2);
    const times = [...first, ...Array.from({ length: 6 }, (_, i) => first.at(-1) + 1.02 * (i + 1))];
    const { strikes } = drive(a, times, { iv0: 1.2, until: times.at(-1) + 3 });
    assert.deepEqual(strikesPerAttack(times, strikes, 0.1), times.map(() => 1), `strikes ${strikes.map((x) => x.t.toFixed(2))}`);
  });

  test('德克萨斯 stunned mid loop: engaged again after the stun, strikes on the attacks', () => {
    const a = actor(TEXAS);
    const iv = 1.05, before = [2, 3.05, 4.1], after2 = [7.2, 8.25, 9.3, 10.35];
    const times = [...before, ...after2];
    const { strikes } = drive(a, times, { iv0: iv, until: 13, at: (t, x) => {
      if (Math.abs(t - 4.4) < 1e-6) x.setBase('stun');
      if (Math.abs(t - 6.9) < 1e-6) x.setBase('idle');
    } });
    assert.deepEqual(strikesPerAttack(times, strikes, 0.1), times.map(() => 1), `strikes ${strikes.map((x) => x.t.toFixed(2))}`);
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
