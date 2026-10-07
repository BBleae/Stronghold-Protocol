// A bot's arrangement is indivisible in fixed-step slicing (review 2026-10-07 item 6): from withdrawing the pieces it
// does not deploy until the plan is placed, and from lifting the summons until they are placed again, the step
// generators yield TRANSIENT, and Match's drive goes on to the next plain yield in the same callback. So at every
// scheduler callback boundary — where a prep deadline, the seat leaving autoplay or a teammate's scouting may cut in —
// the board is one a whole prep step leaves, never a half-built one (5/8 or 7/8 of a lineup that was 8/8).
//
// The checks do not trust those markers: a half-built board is read off the seat's own actions (withdrawals), and the
// fixtures include summons, so a lift → place step that lost its marker fails too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordedMatch, exportMatch, restoreMatch } from '../../server/match/checkpoint.js';
import { arrange, arrangeSteps, botPrepBeginSteps, botPrepEndSteps, TRANSIENT } from '../../server/match/bot.js';
import { PHASE } from '../../shared/constants.js';
import { DATA, makeMatch, give } from './harness.js';
import { roomEvents } from './roomEvents.js';

const SILENCE = 'chess_char_2_02_a'; // 赫默: her 医疗探机 is a hand summon
const boardOf = (ps) => JSON.stringify([...ps.board].map(([k, p]) => [k, p.uid, p.dir ?? null]).sort());
const summonsOn = (ps) => [...ps.board.values()].filter((p) => p.kind === 'token').length;

/**
 * A timed 2-human room with ONE bot chain — h1 on autoplay (connected); h0 connected, never ready — so the bot's
 * decisions do not depend on how its slices interleave with another bot's (the hand-stepped oracle sees the same).
 */
function fixture(seed = 17) {
  const clock = { now: 1000 };
  const options = {
    data: DATA, roomCode: 'ATOM', mode: 'coop', difficulty: 'NORMAL', seed, matchNo: 1, clientCombat: true, verify: 'off',
    seats: [0, 1].map((seat) => ({ seat, playerId: `h${seat}`, name: `H${seat}`, isBot: false, connected: true })),
    now: () => clock.now, send: () => true, broadcast() {}, onEnd() {},
  };
  const match = new RecordedMatch(options);
  match.start();
  match.handle('h1', { t: 'g.autoplay', on: true });
  const room = roomEvents(match, clock, { readyAfterMs: 1e9, humans: ['h0'] });
  return { match, clock, options, room };
}

/**
 * An oracle from the seat's own actions, not from bot.js's markers: taking an operator or a summon off the board (to
 * the hand or the temp slots, or selling it) opens a withdrawal, which closes once as many operators and summons stand
 * on the board as before it. A board with a withdrawal open is half-built. (A buy that merges a deployed copy into an
 * elite in the hand is a whole action, not a withdrawal.) Returns `open()`: the open withdrawal or null, and counts.
 */
function withdrawals(ps) {
  const counts = () => ({ deploy: ps.deployCount, summons: summonsOn(ps) });
  const seen = { withdrawals: 0, summons: 0 };
  let open = null;
  const close = () => {
    const c = counts();
    if (open && c.deploy >= open.deploy && c.summons >= open.summons) open = null;
  };
  for (const name of ['move', 'sell']) {
    const own = ps[name];
    ps[name] = function (uid, to, ...rest) {
      const before = counts();
      const loc = this.find(uid);
      const r = own.call(this, uid, to, ...rest);
      if (loc?.area === 'board' && this.find(uid)?.area !== 'board') {
        seen.withdrawals++;
        if (loc.piece.kind === 'token') seen.summons++;
        open ??= before;
      }
      close();
      return r;
    };
  }
  return { open: () => { close(); return open; }, seen };
}

/**
 * The boards the seat may show between two whole steps of its prep from here: the generators stepped by hand on a
 * restored copy, sampled at every plain (non-TRANSIENT) yield, then the rehearsal and the end steps.
 */
function stableBoards(match, options, playerId) {
  const copy = restoreMatch(exportMatch(match), options);
  try {
    const ps = copy.players.get(playerId);
    const boards = new Set([boardOf(ps)]);
    let transient = 0;
    const walk = (gen) => {
      let r;
      while (!(r = gen.next()).done) { if (r.value === TRANSIENT) transient++; else boards.add(boardOf(ps)); }
      boards.add(boardOf(ps));
      return r.value;
    };
    const job = walk(botPrepBeginSteps(copy, ps));
    if (job) while (!job.runTicks(128)) { /* the rehearsal restores the board exactly */ }
    walk(botPrepEndSteps(copy, ps, job));
    return { boards, transient, final: boardOf(ps) };
  } finally { copy.dispose(); }
}

/** Run the room one scheduler callback at a time while `go()`; `check()` after every callback. */
function callbacks(match, clock, go, check) {
  for (let n = 0; n < 100000 && go(); n++) {
    clock.now = Math.max(clock.now, match.sched.nextAt());
    const budget = { remaining: 1 };
    while (go() && match.pump(clock.now, 1, budget)) check();
  }
}

test('arrangeSteps yields only TRANSIENT and ends on the board arrange() makes, summons lifted and placed included', () => {
  const run = (stepped, summoner) => {
    const h = makeMatch({ mode: 'coop', humans: 0, bots: 2, seed: 41, fake: true }).start();
    try {
      h.run(() => h.m.phase === PHASE.PREP && h.m.round === 4);
      const ps = h.m.order[0];
      // 赫默 joins the lineup with her drone placed: the measured arrangement lifts the drone and places it again
      if (summoner) { give(h.m, ps, SILENCE); arrange(h.m, ps); }
      const summons = summonsOn(ps);
      if (!stepped) { arrange(h.m, ps); return { board: boardOf(ps), values: [], summons }; }
      const values = [];
      const gen = arrangeSteps(h.m, ps);
      for (let r = gen.next(); !r.done; r = gen.next()) values.push(r.value);
      return { board: boardOf(ps), values, summons, after: summonsOn(ps) };
    } finally { h.m.dispose(); }
  };
  for (const summoner of [false, true]) {
    const whole = run(false, summoner);
    const stepped = run(true, summoner);
    assert.ok(stepped.values.length > 0, 'the arrangement has steps');
    assert.ok(stepped.values.every((v) => v === TRANSIENT), 'every step of an arrangement is TRANSIENT');
    assert.equal(stepped.board, whole.board);
    if (summoner) assert.ok(stepped.summons > 0 && stepped.after > 0, `a placed summon is lifted and placed again (${stepped.summons} → ${stepped.after})`);
  }
});

// seed 17: the lineup grows round by round (no summons); seed 5: the seat owns a placed summon from round 3 on
for (const [seed, from, to] of [[17, 1, 5], [5, 3, 6]]) test(`an autoplay seat never shows a half-built board at a callback boundary of its prep (seed ${seed})`, () => {
  const { match, clock, options, room } = fixture(seed);
  try {
    const h1 = match.players.get('h1');
    const { open, seen } = withdrawals(h1);
    let transients = 0;
    for (let round = from; round <= to; round++) {
      assert.ok(room.runUntil(() => match.phase === 'PREP' && match.round === round), `round ${round}`);
      const { boards, transient, final } = stableBoards(match, options, 'h1');
      let boundaries = 0;
      callbacks(match, clock, () => match.phase === 'PREP' && !h1.ready, () => {
        boundaries++;
        const w = open();
        assert.equal(w, null, `round ${round}: callback ${boundaries} ends with ${h1.deployCount} operators and ${summonsOn(h1)} summons on the board, ${w && `${w.deploy} and ${w.summons}`} before the withdrawal`);
        assert.ok(boards.has(boardOf(h1)), `round ${round}: not a board of a whole step after callback ${boundaries}`);
      });
      assert.ok(h1.ready && boundaries > 10, `round ${round}: the bot readied over ${boundaries} callbacks`);
      assert.equal(boardOf(h1), final, 'the same decisions as the hand-stepped prep');
      transients += transient;
    }
    assert.ok(transients > 0, 'the arrangements step through TRANSIENT yields');
    assert.ok(seen.withdrawals > 0, 'the arrangements withdrew pieces');
    if (seed === 5) assert.ok(seen.summons > 0, 'the arrangements lifted summons');
    assert.equal(match.errorCount, 0);
  } finally { match.dispose(); }
});

test('autoplay switched on just before the prep deadline: the fight gets a whole board, whatever the cut', () => {
  const { match, clock, options, room } = fixture();
  const cuts = [];
  try {
    assert.ok(room.runUntil(() => match.phase === 'PREP' && match.round === 4));
    // h1 takes its seat back for this prep (its bot has not started yet); the board is its last arranged one
    match.handle('h1', { t: 'g.autoplay', on: false });
    const start = exportMatch(match);
    const deadline = match.deadline;
    const deployed = match.players.get('h1').deployCount;
    // nothing changes h1's prep until autoplay comes back on: one oracle serves every cut
    const { boards } = stableBoards(match, options, 'h1');
    // the bot starts 900 ms after autoplay (DELAYS.BOT_ACTION); in the last 5 s of a prep its slices come 1 ms apart, so
    // the cuts that matter fall in the next ~100 ms (6d36edc gave the fight 5/8 of the board at 915 ms here)
    for (const x of [1400, 1000, ...Array.from({ length: 20 }, (_, i) => 995 - 5 * i)]) {
      const copy = restoreMatch(start, options);
      try {
        const h1 = copy.players.get('h1');
        const { open } = withdrawals(h1);
        clock.now = deadline - x;
        copy.pump(clock.now, 100, { remaining: 1 });
        copy.handle('h1', { t: 'g.autoplay', on: true });
        // the board the deadline callback finds (it resolves the temp slots and starts the fight from it)
        let cut = boardOf(h1), deploy = h1.deployCount, ready = false, withdrawn = null;
        callbacks(copy, clock, () => copy.phase === PHASE.PREP, () => {
          if (copy.phase !== PHASE.PREP) return;
          cut = boardOf(h1); deploy = h1.deployCount; ready = h1.ready; withdrawn = open();
        });
        assert.ok(copy.phase !== PHASE.PREP && copy.round === 4, 'the deadline ended the prep');
        assert.equal(withdrawn, null, `cut ${x} ms after autoplay: a withdrawal was still open (${deploy}/${h1.deployCap})`);
        // this prep buys nothing that merges a deployed copy: the lineup only grows
        assert.ok(deploy >= deployed, `cut ${x} ms after autoplay: ${deploy}/${h1.deployCap} deployed went to the fight (${deployed} before)`);
        assert.ok(boards.has(cut), `cut ${x} ms after autoplay: not a board of a whole step (${deploy}/${h1.deployCap})`);
        cuts.push(ready);
      } finally { copy.dispose(); }
    }
    assert.ok(cuts.includes(true) && cuts.includes(false), 'the sweep cuts some preps and lets others finish');
  } finally { match.dispose(); }
});
