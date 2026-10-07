// A human who readied must not wait on the AI seats' pacing (review 2026-10-07 item 1): once every connected human who
// still chooses for themself is ready, the AI prep work is urgent — no voluntary 25 ms gap, several slices an event —
// and the prep ends about when the last AI seat's staggered start would have finished it. Room events as on Cloudflare
// (roomEvents.js: one `{ remaining: 1 }` allowance per event), virtual time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordedMatch, exportMatch, restoreMatch } from '../../server/match/checkpoint.js';
import { DELAYS } from '../../server/match/Match.js';
import { DATA } from './harness.js';
import { roomEvents } from './roomEvents.js';

function fixture({ humans, bots, seed = 17, workSlice } = {}) {
  const clock = { now: 1000 };
  const seats = [];
  for (let i = 0; i < humans; i++) seats.push({ seat: seats.length, playerId: `h${i}`, name: `H${i}`, isBot: false, connected: true });
  for (let i = 0; i < bots; i++) seats.push({ seat: seats.length, playerId: `a${i}`, name: `A${i}`, isBot: true, connected: true });
  const options = {
    data: DATA, roomCode: 'WAIT', mode: 'coop', difficulty: 'NORMAL', seed, matchNo: 1, clientCombat: true, verify: 'off',
    seats, workSlice, now: () => clock.now, send: () => true, broadcast() {}, onEnd() {},
  };
  const match = new RecordedMatch(options);
  match.start();
  return { match, clock, options };
}

/** The staggered start of the last AI seat's prep (Match.scheduleBotPrep): the wait a human has without any pacing. */
const lastBotStart = (bots) => DELAYS.BOT_ACTION + (bots - 1) * DELAYS.BOT_STAGGER;

for (const [label, humans, bots, readyAfterMs] of [
  ['1 human + 7 AI (untimed), ready after 1.2 s', 1, 7, 1200],
  ['1 human + 7 AI (untimed), ready at once', 1, 7, 0],
  ['4 humans + 4 AI (timed), ready after 1.2 s', 4, 4, 1200],
  ['4 humans + 4 AI (timed), ready at once', 4, 4, 0],
]) {
  test(`the prep ends about when the last AI seat's staggered start allows: ${label}`, () => {
    const { match, clock } = fixture({ humans, bots });
    try {
      if (humans === 1) assert.equal(match.soloUntimed, true);
      const room = roomEvents(match, clock, { readyAfterMs });
      assert.ok(room.runUntil(() => match.round > 3), 'three rounds are played');
      // the human waits on the AI alone, so the room ends the prep within a second of the AI seats' own start
      const bound = Math.max(0, lastBotStart(bots) - readyAfterMs) + 1000;
      for (const round of [1, 2, 3]) {
        const r = room.rounds[round];
        assert.ok(r.readyAt != null, `round ${round}: the humans readied`);
        assert.ok(r.waitAfterReady <= bound, `round ${round}: waited ${r.waitAfterReady} ms after the last human readied (≤ ${bound})`);
      }
      assert.equal(match.errorCount, 0);
    } finally { match.dispose(); }
  });
}

/** Count the prep slices deferWork admits (the match's own admission callback, wrapped). */
function countPrepAdmissions(match) {
  const counter = { n: 0 };
  const defer = match.deferWork;
  match.deferWork = (...args) => {
    const delay = defer(...args);
    if (delay === 0 && args[0] === 'prep') counter.n++;
    return delay;
  };
  return counter;
}

test('urgent prep admits up to prepBurst AI slices per event, recorded with the match and replayed by a restore', () => {
  const { match, clock, options } = fixture({ humans: 1, bots: 7, workSlice: { prepBurst: 2 } });
  let restored;
  try {
    assert.equal(match.recording.options.workSlice.prepBurst, 2, 'the burst is part of the recorded options');
    const counter = countPrepAdmissions(match);
    const urgent = [];
    const room = roomEvents(match, clock, {
      readyAfterMs: 0,
      onEvent: () => { if (match._prepUrgent()) urgent.push(counter.n); counter.n = 0; },
    });
    assert.ok(room.runUntil(() => urgent.length >= 40), 'the human readied at once: the AI prep is urgent');
    assert.equal(match.phase, 'PREP');
    assert.ok(urgent.every((n) => n <= 2), 'never more than prepBurst slices in one event');
    assert.ok(urgent.filter((n) => n === 2).length >= 10, 'queued AI work fills the burst');
    // a checkpoint mid-burst: same admissions, same state
    restored = restoreMatch(exportMatch(match), options);
    for (let n = 0; n < 200 && match.phase === 'PREP'; n++) {
      clock.now = match.sched.nextAt() ?? clock.now;
      const live = { remaining: 1 }, again = { remaining: 1 };
      match.pump(clock.now, 100, live);
      restored.pump(clock.now, 100, again);
      assert.deepEqual(again, live, 'a restore admits the same slices from the same allowance');
    }
    assert.deepEqual(exportMatch(restored), exportMatch(match));
  } finally { match.dispose(); restored?.dispose(); }
});

// Each event costs the host its commit besides its slices (a few ms on a Room DO), so a wait of N events is N commits:
// urgent events fill the burst with the cheap slices (economy steps, 128-tick rehearsals), while an arrangement's slice
// (bot.js HEAVY → 'prepArrange', 10–20 ms late in a match) takes an event of its own instead of stacking on others.
test('urgent events fill the burst, and an arrangement\'s slice takes an event of its own', () => {
  const { match, clock } = fixture({ humans: 1, bots: 7 });
  try {
    const burst = match.recording.options.workSlice.prepBurst;
    let kinds = [];
    const defer = match.deferWork;
    match.deferWork = (...args) => {
      const delay = defer(...args);
      if (delay === 0) kinds.push(args[0]);
      return delay;
    };
    const waits = [];
    let wait = null;
    const room = roomEvents(match, clock, {
      readyAfterMs: 0,
      onEvent: () => {
        if (match.phase === 'PREP' && match._prepUrgent()) {
          wait ??= { events: 0, prep: 0, arrange: 0 };
          wait.events++;
          const arrange = kinds.filter((k) => k === 'prepArrange').length;
          assert.ok(!arrange || kinds.length === 1, `an arrangement shares no event: ${kinds.join(' ')}`);
          assert.ok(kinds.length <= burst, `${kinds.length} slices in one event (prepBurst ${burst})`);
          wait.prep += kinds.length - arrange;
          wait.arrange += arrange;
        } else if (wait) { waits.push(wait); wait = null; }
        kinds = [];
      },
    });
    assert.ok(room.runUntil(() => match.round > 3), 'three rounds are played');
    assert.equal(waits.length, 3);
    for (const w of waits) {
      assert.ok(w.arrange >= 7, `every AI seat arranges in its own event (${w.arrange})`);
      // short of the burst only when no cheap slice is due: before a seat's staggered start, and before each of its two
      // arrangements while it is the only seat with work (seed 17: ~16 such events a round)
      assert.ok(w.events <= Math.ceil(w.prep / burst) + w.arrange + 3 * 7, `${w.events} events for ${w.prep} slices + ${w.arrange} arrangements`);
    }
    assert.equal(match.errorCount, 0);
  } finally { match.dispose(); }
});

test('AI prep is urgent only while a connected human waits on the AI seats alone', () => {
  const { match, clock } = fixture({ humans: 3, bots: 2 });
  try {
    const room = roomEvents(match, clock, { readyAfterMs: 60000 });
    assert.ok(room.runUntil(() => match.phase === 'PREP'));
    const [h0, h1, h2] = ['h0', 'h1', 'h2'].map((id) => match.players.get(id));
    assert.equal(match._prepUrgent(), false, 'humans still choosing');
    h0.ready = true; h1.ready = true;
    assert.equal(match._prepUrgent(), false, 'one connected human still chooses');
    h2.autoplay = true;
    assert.equal(match._prepUrgent(), true, 'a human on autoplay waits on its bot like the others');
    h2.autoplay = false; h2.connected = false;
    assert.equal(match._prepUrgent(), true, 'a disconnected human holds nobody back');
    h0.alive = false; h0.ready = false; h1.connected = false;
    assert.equal(match._prepUrgent(), true, 'an eliminated human watching still waits');
    h0.connected = false;
    assert.equal(match._prepUrgent(), false, 'no human connected: nobody waits, the AI keeps its pace');
    h0.connected = true; h0.alive = true; h1.connected = true;
    match.phase = 'SP_DRAFT';
    assert.equal(match._prepUrgent(), false, 'PREP only');
  } finally { match.dispose(); }
});

test('a human still choosing keeps the AI paced; once the last one readies the AI works without the gap', () => {
  const { match, clock, options } = fixture({ humans: 2, bots: 6 });
  let restored;
  try {
    const room = roomEvents(match, clock, { readyAfterMs: 60000 });
    assert.ok(room.runUntil(() => match.phase === 'PREP'));
    match.handle('h0', { t: 'g.ready', ready: true });
    assert.equal(match._prepUrgent(), false, 'h1 has not readied');
    const counter = countPrepAdmissions(match);
    clock.now = match.sched.now() + 10000;
    const first = { remaining: 1 };
    match.pump(clock.now, 100, first);
    assert.equal(counter.n, 1, 'one AI slice in an event');
    const gap = match.scaled(25);
    for (const at of [clock.now + 1, clock.now + gap - 1]) {
      const next = { remaining: 1 };
      match.pump(at, 100, next);
      assert.equal(next.remaining, 1, 'none inside the 25 ms gap');
    }
    match.handle('h1', { t: 'g.ready', ready: true });
    assert.equal(match._prepUrgent(), true);
    // the slices already waiting for the gap come due with it; from then on every event takes a burst
    const burst = match.recording.options.workSlice.prepBurst;
    assert.ok(burst > 1, 'the default burst is several slices');
    counter.n = 0;
    clock.now += gap;
    match.pump(clock.now, 100, { remaining: 1 });
    assert.equal(counter.n, burst);
    restored = restoreMatch(exportMatch(match), options);
    for (const at of [clock.now + 1, clock.now + 2]) {
      counter.n = 0;
      const live = { remaining: 1 }, again = { remaining: 1 };
      match.pump(at, 100, live);
      restored.pump(at, 100, again);
      assert.equal(counter.n, burst, 'no gap: the next event takes the next burst');
      assert.deepEqual(again, live);
    }
    assert.deepEqual(exportMatch(restored), exportMatch(match));
  } finally { match.dispose(); restored?.dispose(); }
});
