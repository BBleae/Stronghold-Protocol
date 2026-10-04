// test/render/feedback3-skill-idle.test.js — what an operator does between the attacks of its skill (community
// report #23, 0.1.3: "折娅开了技能就会不停做跳起来打人的动作，哪怕没有接敌"; owner's decision 2026-10-05, merging 0.1.3).
// On the REAL Spine 3.8 AnimationState (test/helpers/realSpine.js: skeletons from the manifest's clip lengths and
// strike frames), driven as render/app.js and units.js drive it (look-ahead windUp, setUpcoming, attack):
//   - a skill with an idle clip of its own (折桠 S2: Skill_2_Idle beside the Skill_2_Loop jump attack; 史尔特尔 S3;
//     耀骑士临光 S3, no begin clip: in its idle at once, a Skill_3 swing per attack) stands in that idle, plays its
//     loop only on attacks and its End clip only when the skill ends;
//   - any other skill (宴 S2: Skill_Loop without a strike frame; 星熊 S2: Skill_Begin strikes, Skill holds the
//     shield; 初雪 S2: a striking Skill_Loop; 蕾缪安 S2, whose loop is its idle clip) holds its stance while its
//     attacks go on, SPELL_GAP attack intervals after the last one plays its End clip and the plain Idle while the
//     skill runs on (a skill whose loop is its idle: that loop again, as 0.1.3 does), goes straight back into the
//     stance on the next attack (no begin clip), and plays End at the skill's real end only when it is not back in
//     the Idle already.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MANIFEST, installRealSpine, skeletonData } from '../helpers/realSpine.js';

let SpineActor, SPELL_GAP, restore;
before(async () => {
  restore = installRealSpine();
  ({ SpineActor, SPELL_GAP } = await import('../../public/js/render/spine.js'));
});
after(() => restore());

const FRAME = 1 / 30;   // game s per frame (60 fps × the 2× battle speed)
const LOOKAHEAD = 1;    // game s (render/app.js LOOK_AHEAD)
const on = (a) => a.setSkill(true);
const off = (a) => a.setSkill(false);

/** A real operator's Front model with its equipped skill (0-based index). */
function actor(charId, skillIndex) {
  const entry = MANIFEST.chars[charId].spine.front;
  const a = new SpineActor(skeletonData(entry), entry);
  a.setSkillIndex(skillIndex);
  return a;
}
const clip = (a) => a.spine.state.tracks[0]?.animation?.name;
const skillRoles = (a) => ['begin', 'loop', 'end', 'idle'].map((k) => a.roles.skill[k]);

/**
 * Drive an actor for `until` game s: every attack (its game time is its identity) is wound up from LOOKAHEAD ahead
 * (windUp each frame until a swing starts for it), setUpcoming names the next one, attack() runs when it is due — at
 * the fixed interval `iv`; `at` [[t, fn]] run at their time (setSkill). Returns, on the actor's clock, the clips shown
 * in order (`shown`, each with the time it took over), the clips started (`sets`) and the strike frames (`strikes`).
 */
function drive(a, attacks, { iv, until, at = [] }) {
  const shown = [], sets = [], strikes = [], wound = new Set();
  const st = a.spine.state, set = st.setAnimation.bind(st);
  st.setAnimation = (track, name, loop) => { sets.push({ t: a.clock, clip: name }); return set(track, name, loop); };
  st.addListener({
    event: (entry, ev) => {
      if (ev?.data?.name === 'OnAttack') strikes.push({ t: a.clock, clip: entry.animation?.name });
    },
  });
  let k = 0;
  for (let t = 0; t < until - 1e-9; t += FRAME) {
    for (const [when, fn] of at) if (Math.abs(when - t) < FRAME / 2) fn(a);
    while (k < attacks.length && attacks[k] <= t + 1e-9) { a.attack(iv); k++; }
    for (let j = k; j < attacks.length && attacks[j] - t <= LOOKAHEAD; j++) {
      if (!wound.has(j) && a.windUp(iv, attacks[j] - t, false, attacks[j])) wound.add(j);
    }
    a.setUpcoming(k < attacks.length && attacks[k] - t <= LOOKAHEAD ? attacks[k] - t : Infinity, LOOKAHEAD);
    a.update(FRAME);
    if (shown.at(-1)?.clip !== clip(a)) shown.push({ t: a.clock, clip: clip(a) });
  }
  return { shown, sets, strikes };
}
const names = (list) => list.map((x) => x.clip);
/** Times at which `name` took over / was started. */
const timesOf = (list, name) => list.filter((x) => x.clip === name).map((x) => x.t);
const near = (t, want, tol, msg) =>
  assert.ok(Math.abs(t - want) <= tol, `${msg}: ${t.toFixed(3)} (want ${want.toFixed(3)})`);
/** Every attack struck once by `name`'s strike frame, on time. */
function struckOnAttacks(strikes, attacks, name) {
  const hits = strikes.filter((s) => s.clip === name);
  const per = attacks.map((t) => hits.filter((s) => Math.abs(s.t - t) <= 0.1).length);
  assert.deepEqual(per, attacks.map(() => 1), `${name} strikes ${hits.map((s) => s.t.toFixed(2))}`);
}

test('折桠 S2, an idle clip of its own: Skill_2_Idle between attacks, Skill_2_Loop only on them, End only at the end', () => {
  const a = actor('char_4207_branch', 1);
  assert.deepEqual(skillRoles(a), ['Skill_2_Begin', 'Skill_2_Loop', 'Skill_2_End', 'Skill_2_Idle']);
  const attacks = [4, 5.5, 7];
  const { shown, strikes } = drive(a, attacks, { iv: 1.5, until: 19, at: [[0.5, on], [18, off]] });
  assert.deepEqual(names(shown),
    ['Idle', 'Skill_2_Begin', 'Skill_2_Idle', 'Skill_2_Loop', 'Skill_2_Idle', 'Skill_2_End', 'Idle'],
    'no Skill_2_Loop before the first attack nor after the last, no Skill_2_End between attacks');
  const [loopAt] = timesOf(shown, 'Skill_2_Loop');
  assert.ok(loopAt > 3 && loopAt < attacks[0], `the jump attack is wound up for the first attack: ${loopAt}`);
  struckOnAttacks(strikes, attacks, 'Skill_2_Loop');
  assert.equal(strikes.filter((s) => s.clip === 'Skill_2_Loop').length, attacks.length, 'no jump attack at nothing');
  near(timesOf(shown, 'Skill_2_End')[0], 18, 2 * FRAME, 'Skill_2_End when the skill ends');
});

test('史尔特尔 S3 and 耀骑士临光 S3 (no begin clip), idle clips of their own: the same rule as 折桠', () => {
  // 史尔特尔 S3: Skill_3_Begin, then Skill_3_Idle; Skill_3_Loop (a strike each cycle) only for the attacks; no End clip
  const s = actor('char_350_surtr', 2), sa = [4, 5.25, 6.5];
  assert.deepEqual(skillRoles(s), ['Skill_3_Begin', 'Skill_3_Loop', null, 'Skill_3_Idle']);
  const S = drive(s, sa, { iv: 1.25, until: 15, at: [[0.5, on], [14, off]] });
  assert.deepEqual(names(S.shown),
    ['Idle', 'Skill_3_Begin', 'Skill_3_Idle', 'Skill_3_Loop', 'Skill_3_Idle', 'Idle'],
    'Skill_3_Loop only for the attacks, Skill_3_Idle around them; no End clip: the plain Idle at the end');
  struckOnAttacks(S.strikes, sa, 'Skill_3_Loop');
  assert.equal(S.strikes.length, sa.length, 'no strike at nothing');
  // 耀骑士临光 S3: no begin clip — Skill_3_Idle at once; Skill_3 (a lone striking clip) one swing per attack
  const n = actor('char_1014_nearl2', 2), na = [2, 3.2, 4.4];
  assert.deepEqual(skillRoles(n), [null, 'Skill_3', null, 'Skill_3_Idle']);
  const N = drive(n, na, { iv: 1.2, until: 10, at: [[0.5, on], [9, off]] });
  assert.deepEqual(names(N.shown),
    ['Idle', 'Skill_3_Idle', 'Skill_3', 'Skill_3_Idle', 'Skill_3', 'Skill_3_Idle', 'Skill_3', 'Skill_3_Idle', 'Idle'],
    'no begin clip: Skill_3_Idle at once, a Skill_3 swing per attack, Skill_3_Idle between them');
  near(timesOf(N.sets, 'Skill_3_Idle')[0], 0.5, FRAME, 'Skill_3_Idle as the skill starts');
  struckOnAttacks(N.strikes, na, 'Skill_3');
  assert.equal(N.strikes.length, na.length, 'no strike at nothing');
});

test('宴 S2, no idle clip of its own: Skill_End and Idle after a spell of attacks, the next attack straight into Skill_Loop', () => {
  const a = actor('char_337_utage', 1);
  assert.deepEqual(skillRoles(a), ['Skill_Start', 'Skill_Loop', 'Skill_End', null]);
  const iv = 1.2, attacks = [2, 3.2, 4.4, 10, 11.2];
  let resting = null;
  const look = (x) => { resting = [x.skillOn, clip(x)]; };
  const { shown, sets } = drive(a, attacks, { iv, until: 17, at: [[0.5, on], [8, look], [16, off]] });
  assert.deepEqual(names(shown),
    ['Idle', 'Skill_Start', 'Skill_Loop', 'Skill_End', 'Idle', 'Skill_Loop', 'Skill_End', 'Idle'],
    'Skill_Loop (no strike frame) held through each spell');
  assert.deepEqual(resting, [true, 'Idle'], 'the plain Idle while the skill runs on');
  assert.equal(SPELL_GAP, 1.4, "0.1.3's attack mode length");
  const ends = timesOf(sets, 'Skill_End');
  near(ends[0], 4.4 + SPELL_GAP * iv, 2 * FRAME, 'End: SPELL_GAP intervals after the last attack of the spell');
  near(ends[1], 11.2 + SPELL_GAP * iv, 2 * FRAME, 'End after the second spell');
  near(timesOf(sets, 'Skill_Loop')[1], 10, FRAME, 'the next attack: straight into Skill_Loop');
  assert.equal(timesOf(sets, 'Skill_Start').length, 1, 'no begin clip when the stance comes back');
  assert.deepEqual(sets.filter((x) => x.t >= 16 - 1e-9), [], 'the skill ends back in the Idle: no second End');
});

test('星熊 S2, a stance skill (Skill_Begin strikes, Skill holds the shield): the same spell rule, a swing per attack', () => {
  const a = actor('char_136_hsguma', 1);
  assert.deepEqual(skillRoles(a), ['Skill_Begin', 'Skill', 'Skill_End', null]);
  const iv = 1.2, attacks = [2, 3.2, 4.4, 10, 11.2];
  const { shown, sets, strikes } = drive(a, attacks, { iv, until: 17, at: [[0.5, on], [16, off]] });
  const spell = (n) => Array.from({ length: n }, () => ['Skill_Begin', 'Skill']).flat();
  assert.deepEqual(names(shown),
    ['Idle', 'Skill_Begin', 'Skill', ...spell(3), 'Skill_End', 'Idle', ...spell(2), 'Skill_End', 'Idle'],
    'Skill_Begin, the shield stance; a swing per attack back into the stance; End and Idle after each spell');
  struckOnAttacks(strikes, attacks, 'Skill_Begin');
  const ends = timesOf(sets, 'Skill_End');
  near(ends[0], 4.4 + SPELL_GAP * iv, 2 * FRAME, 'End after the first spell');
  near(ends[1], 11.2 + SPELL_GAP * iv, 2 * FRAME, 'End after the second spell');
  assert.deepEqual(sets.filter((x) => x.t >= 16 - 1e-9), [], 'no second End at the real end');
});

test('the real end plays End while the stance holds: mid-spell (星熊), or no attack during the skill (宴)', () => {
  const h = actor('char_136_hsguma', 1);
  const mid = drive(h, [2, 3.2], { iv: 1.2, until: 6, at: [[0.5, on], [3.6, off]] });
  assert.deepEqual(names(mid.shown).slice(-3), ['Skill', 'Skill_End', 'Idle']);
  near(timesOf(mid.sets, 'Skill_End')[0], 3.6, FRAME, 'End when the skill ends');
  // an attack just before the skill, none during it: no spell of the skill to end — the stance until the skill ends
  const u = actor('char_337_utage', 1);
  const none = drive(u, [0.3], { iv: 1.2, until: 8, at: [[0.5, on], [5, off]] });
  assert.deepEqual(names(none.shown).slice(-4), ['Skill_Start', 'Skill_Loop', 'Skill_End', 'Idle']);
  near(timesOf(none.sets, 'Skill_End')[0], 5, FRAME, 'End when the skill ends');
});

test('初雪 S2, a striking Skill_Loop: a strike per attack, End and Idle after the spell, then straight into the loop', () => {
  const a = actor('char_174_slbell', 1);
  assert.deepEqual(skillRoles(a), ['Skill_Start', 'Skill_Loop', 'Skill_End', null]);
  const iv = 1, attacks = [2, 3, 4, 10, 11];
  const { shown, sets, strikes } = drive(a, attacks, { iv, until: 17, at: [[0.5, on], [16, off]] });
  assert.deepEqual(names(shown),
    ['Idle', 'Skill_Start', 'Skill_Loop', 'Skill_End', 'Idle', 'Skill_Loop', 'Skill_End', 'Idle']);
  struckOnAttacks(strikes, attacks, 'Skill_Loop');
  near(timesOf(sets, 'Skill_End')[0], 4 + SPELL_GAP * iv, 2 * FRAME, 'End after the spell');
  const back = timesOf(sets, 'Skill_Loop').find((t) => t > 9);
  assert.ok(back > 9.5 && back < 10, `wound up for the attack at 10 (its strike frame on it), no Skill_Start: ${back}`);
  assert.equal(timesOf(sets, 'Skill_Start').length, 1);
});

test('蕾缪安 S2, whose loop is its idle clip: Skill_2_End after a spell, then that loop again while the skill runs on', () => {
  const a = actor('char_4193_lemuen', 1);
  assert.deepEqual(skillRoles(a), ['Skill_2_Begin', 'Skill_2_Idle', 'Skill_2_End', 'Skill_2_Idle']);
  const { shown } = drive(a, [2, 3, 4], { iv: 1, until: 11, at: [[0.5, on], [9, off]] });
  assert.deepEqual(names(shown), ['Idle', 'Skill_2_Begin', 'Skill_2_Idle', 'Skill_2_End', 'Skill_2_Idle', 'Skill_2_End', 'Idle']);
  near(timesOf(shown, 'Skill_2_End')[0], 4 + SPELL_GAP, 2 * FRAME, 'End after the spell');
  near(timesOf(shown, 'Skill_2_End')[1], 9, 2 * FRAME, 'End again when the skill ends: it stood in its loop');
});
