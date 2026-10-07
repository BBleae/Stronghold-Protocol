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
import { arrange, arrangeSteps, botPrepBeginSteps, botPrepEndSteps, runSteps, TRANSIENT } from '../../server/match/bot.js';
import { DEADLINE_REHEARSAL_TICKS } from '../../server/match/Match.js';
import { PHASE } from '../../shared/constants.js';
import { DATA, makeMatch, give } from './harness.js';
import { roomEvents } from './roomEvents.js';

const SILENCE = 'chess_char_2_02_a'; // 赫默: her 医疗探机 is a hand summon
const boardOf = (ps) => JSON.stringify([...ps.board].map(([k, p]) => [k, p.uid, p.dir ?? null]).sort());
/** What a seat takes into the fight from its prep: the board, the hand, the funds. */
const seatOf = (ps) => JSON.stringify({ board: boardOf(ps), hand: ps.hand.map((p) => p?.uid ?? null), funds: ps.funds });
const summonsOn = (ps) => [...ps.board.values()].filter((p) => p.kind === 'token').length;

/**
 * A timed 2-human room with ONE bot chain — h1 on autoplay (connected); h0 connected, never ready — so the bot's
 * decisions do not depend on how its slices interleave with another bot's (the hand-stepped oracle sees the same).
 * `humans` > 2 puts h2 … on autoplay too; `workSlice` overrides recorded work counts (deadlineRehearsalTicks).
 */
function fixture(seed = 17, { humans = 2, workSlice } = {}) {
  const clock = { now: 1000 };
  const options = {
    data: DATA, roomCode: 'ATOM', mode: 'coop', difficulty: 'NORMAL', seed, matchNo: 1, clientCombat: true, verify: 'off',
    seats: Array.from({ length: humans }, (_, seat) => ({ seat, playerId: `h${seat}`, name: `H${seat}`, isBot: false, connected: true })),
    now: () => clock.now, send: () => true, broadcast() {}, onEnd() {}, ...(workSlice ? { workSlice } : {}),
  };
  const match = new RecordedMatch(options);
  match.start();
  for (let i = 1; i < humans; i++) match.handle(`h${i}`, { t: 'g.autoplay', on: true });
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
    return { boards, transient, final: boardOf(ps), seat: seatOf(ps), rehearsed: !!job };
  } finally { copy.dispose(); }
}

/**
 * The seat as the fight gets it when the prep deadline leaves its rehearsal after `ticks` ticks in all (Match
 * _finishBotPrep): finished, when that covers it, or cut there — the best of the candidates finished by then (job.cut).
 * The generators stepped by hand on a restored copy, the rehearsal in one go: a candidate's result does not depend on
 * how its ticks were sliced. Memoized per tick count in `cache`.
 */
function seatAfter(match, options, playerId, ticks, cache) {
  if (cache?.has(ticks)) return cache.get(ticks);
  const copy = restoreMatch(exportMatch(match), options);
  try {
    const ps = copy.players.get(playerId);
    const job = runSteps(botPrepBeginSteps(copy, ps));
    if (job && ticks > 0) job.runTicks(ticks);
    if (job && !job.done) job.cut = true;
    runSteps(botPrepEndSteps(copy, ps, job));
    const out = { seat: seatOf(ps), board: boardOf(ps), done: !job || job.done };
    cache?.set(ticks, out);
    return out;
  } finally { copy.dispose(); }
}

/** Whether every operator of `plan` (uid → tile) stands on its tile. */
const onPlan = (ps, plan) => [...plan].every(([uid, k]) => ps.board.get(k)?.uid === uid);

/**
 * The seat as it goes into the fight (read when the prep ends: the deadline has resolved it), its prep job as the
 * deadline left it, and the rehearsal ticks the deadline ran for it (`ran`). `open`: withdrawals(ps).open.
 */
function atPrepEnd(match, ps, open = null) {
  const seen = { seat: null, board: null, deploy: null, job: null, ran: 0, withdrawn: null, onBest: null, readyBefore: null };
  let run = null, before = 0;
  const prepDeadline = match.prepDeadline.bind(match);
  match.prepDeadline = () => {
    run = ps._botPrep;
    before = run?.job?.ticks ?? 0;
    seen.readyBefore = ps.ready;
    return prepDeadline();
  };
  const endPrep = match.endPrep.bind(match);
  match.endPrep = () => {
    seen.seat = seatOf(ps); seen.board = boardOf(ps); seen.deploy = ps.deployCount; seen.withdrawn = open?.() ?? null;
    const job = (run ?? ps._botPrep)?.job ?? null;
    if (job) {
      seen.job = { ticks: job.ticks, done: job.done, cut: job.cut, best: job.plans.indexOf(job.best) };
      seen.ran = job.ticks - before;
      seen.onBest = (job.done || job.cut) ? onPlan(ps, job.best) : null;
    }
    return endPrep();
  };
  return seen;
}

/**
 * Room events that each occupy the host for `costMs` and admit `allowance` work slices, from `busy` until the prep
 * ends; `atEvent(next, busy)` before each event (next: the event's time, busy: when the host got free).
 */
function hostEvents(copy, clock, { costMs, allowance, busy, atEvent = null }) {
  for (let n = 0; n < 100000 && copy.phase === PHASE.PREP; n++) {
    const next = Math.max(busy, copy.sched.nextAt());
    atEvent?.(next, busy);
    clock.now = next;
    const budget = { remaining: allowance };
    copy.pump(clock.now, 100, budget);
    copy.pump(clock.now, 100, budget);
    busy = clock.now + costMs;
  }
  return busy;
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
    const budget = match.workSlice.deadlineRehearsalTicks;
    const h1Before = match.players.get('h1');
    const deployed = h1Before.deployCount, startBoard = boardOf(h1Before);
    // nothing changes h1's prep until autoplay comes back on: one oracle serves every cut
    const { boards } = stableBoards(match, options, 'h1');
    const after = new Map();
    let rehearsalCut = 0;
    // the bot starts 900 ms after autoplay (DELAYS.BOT_ACTION); in the last 5 s of a prep its slices come 1 ms apart, so
    // the cuts that matter fall in the next ~100 ms (6d36edc gave the fight 5/8 of the board at 915 ms here). A job
    // whose start was due before the deadline is finished by it (Match._finishBotPrep), its rehearsal only within the
    // deadline's tick budget; a later one never starts.
    for (const x of [1400, 1000, ...Array.from({ length: 20 }, (_, i) => 995 - 5 * i)]) {
      const copy = restoreMatch(start, options);
      try {
        const h1 = copy.players.get('h1');
        const { open } = withdrawals(h1);
        const fight = atPrepEnd(copy, h1, open);
        clock.now = deadline - x;
        copy.pump(clock.now, 100, { remaining: 1 });
        copy.handle('h1', { t: 'g.autoplay', on: true });
        // the board the deadline callback finds
        let cut = boardOf(h1), deploy = h1.deployCount, ready = false, withdrawn = null;
        callbacks(copy, clock, () => copy.phase === PHASE.PREP, () => {
          if (copy.phase !== PHASE.PREP) return;
          cut = boardOf(h1); deploy = h1.deployCount; ready = h1.ready; withdrawn = open();
        });
        assert.ok(copy.phase !== PHASE.PREP && copy.round === 4, 'the deadline ended the prep');
        assert.equal(withdrawn, null, `cut ${x} ms after autoplay: a withdrawal was still open (${deploy}/${h1.deployCap})`);
        // this prep buys nothing that merges a deployed copy: the lineup only grows
        assert.ok(deploy >= deployed, `cut ${x} ms after autoplay: ${deploy}/${h1.deployCap} deployed when the deadline came (${deployed} before)`);
        assert.ok(boards.has(cut), `cut ${x} ms after autoplay: not a board of a whole step (${deploy}/${h1.deployCap})`);
        assert.equal(fight.withdrawn, null, `cut ${x} ms after autoplay: the fight gets a half-built board`);
        assert.ok(fight.deploy >= deployed, `cut ${x} ms after autoplay: ${fight.deploy}/${h1.deployCap} deployed went to the fight`);
        if (x > 900) {
          assert.ok(fight.job, `cut ${x} ms after autoplay: the deadline finished the prep up to its rehearsal`);
          assert.ok(fight.ran <= budget, `cut ${x} ms after autoplay: the deadline ran ${fight.ran} rehearsal ticks (budget ${budget})`);
          const want = seatAfter(match, options, 'h1', fight.job.ticks, after);
          assert.equal(fight.job.cut, !want.done);
          assert.equal(fight.board, want.board, `cut ${x} ms after autoplay: the fight gets the prep ${want.done ? 'finished' : `cut after ${fight.job.ticks} rehearsal ticks`}`);
          if (fight.job.cut) { rehearsalCut++; assert.equal(fight.onBest, true, `cut ${x} ms after autoplay: the best plan rehearsed so far`); }
          cuts.push(ready);
        } else assert.equal(fight.board, startBoard, `cut ${x} ms after autoplay: the fight gets the board before autoplay`);
      } finally { copy.dispose(); }
    }
    assert.ok(cuts.includes(true) && cuts.includes(false), 'the sweep has preps the deadline found finished and preps it finished');
    assert.ok(rehearsalCut > 0, 'the deadline cuts a rehearsal its budget does not cover');
    assert.equal(match.errorCount, 0);
  } finally { match.dispose(); }
});

/**
 * Checkpoints of a prep for prefix restores: 300 ms before the deadline, and the last event before it. `atEvent` of
 * hostEvents (the state before the event at `next`, which starts the host at `busy`).
 */
function prefixesBefore(copy, clock, deadline, list) {
  return (next, busy) => {
    const take = (tag) => list.push({ tag, cp: exportMatch(copy), busy, now: clock.now });
    if (!list.some((p) => p.tag === 'pre300') && next >= deadline - 300 && next < deadline) take('pre300');
    if (!list.some((p) => p.tag === 'last') && next >= deadline) take('last');
  };
}

/** A prefix restored and driven by the same host events gives `seats` (pid → seatOf) and the log `log` at prep end. */
function replayPrefix(p, options, clock, host, pids, seats, log, label) {
  const r = restoreMatch(p.cp, options);
  try {
    clock.now = p.now;
    const fights = pids.map((pid) => atPrepEnd(r, r.players.get(pid)));
    hostEvents(r, clock, { ...host, busy: p.busy });
    pids.forEach((pid, i) => assert.equal(fights[i].seat, seats[i], `${label}: restored at ${p.tag}, ${pid} fights another prep`));
    assert.equal(JSON.stringify(r.recording.events), log, `${label}: restored at ${p.tag}, another log`);
    assert.equal(r.errorCount, 0);
  } finally { r.dispose(); }
}

// Room events that each occupy the host (its CPU and commit): the deadline is a timer and the bot's slices need many
// events, so a slower host leaves more of the job to the deadline (review 2026-10-08: from R8 on with three late
// toggles at desktop speed). The deadline finishes it within its tick budget: the fight gets the prep where the
// recorded slices and the budget leave it — finished, or cut with the best candidate finished — never a half-built
// board, and a restore from before or at the deadline replays the same prep (no wall-clock read decides it).
for (const budget of [null, 64]) test(`autoplay switched on 1.5 s before the deadline: the fight gets the prep the recorded work leaves at any per-event cost (deadline budget ${budget ?? 'default'})`, () => {
  const { match, clock, options, room } = fixture(17, budget == null ? {} : { workSlice: { deadlineRehearsalTicks: budget } });
  try {
    assert.ok(room.runUntil(() => match.phase === 'PREP' && match.round === 4));
    match.handle('h1', { t: 'g.autoplay', on: false });
    const start = exportMatch(match);
    const deadline = match.deadline;
    const ticks = match.workSlice.deadlineRehearsalTicks;
    assert.equal(match.recording.options.workSlice.deadlineRehearsalTicks, budget ?? DEADLINE_REHEARSAL_TICKS, 'the budget is a recorded option');
    assert.equal(ticks, budget ?? DEADLINE_REHEARSAL_TICKS);
    if (budget == null) {
      // a match recorded before the budget existed restores with the default one
      const legacy = JSON.parse(JSON.stringify(start));
      delete legacy.options.workSlice.deadlineRehearsalTicks;
      const old = restoreMatch(legacy, options);
      try { assert.equal(old.workSlice.deadlineRehearsalTicks, DEADLINE_REHEARSAL_TICKS); } finally { old.dispose(); }
    }
    const oracle = stableBoards(match, options, 'h1');
    assert.ok(oracle.rehearsed, 'the prep rehearses its layout');
    const after = new Map();
    let unfinished = 0, cut = 0;
    // allowance 0: a host that admits no work at all — the job's start is still queued when the deadline comes
    for (const [costMs, allowance] of [[0, 1], [5, 1], [20, 1], [50, 1], [100, 1], [0, 0]]) {
      const label = `per-event cost ${costMs} ms, allowance ${allowance}`;
      const copy = restoreMatch(start, options);
      try {
        const h1 = copy.players.get('h1');
        const { open } = withdrawals(h1);
        const fight = atPrepEnd(copy, h1, open);
        clock.now = deadline - 1500;
        copy.pump(clock.now, 100, { remaining: 1 });
        copy.handle('h1', { t: 'g.autoplay', on: true });
        const prefixes = [];
        const host = { costMs, allowance };
        hostEvents(copy, clock, { ...host, busy: clock.now + costMs, atEvent: prefixesBefore(copy, clock, deadline, prefixes) });
        assert.equal(copy.round, 4);
        assert.equal(copy.errorCount, 0, JSON.stringify(copy.errors));
        if (!fight.readyBefore) unfinished++;
        assert.equal(fight.withdrawn, null, `${label}: the fight gets a half-built board`);
        assert.ok(fight.job, `${label}: the prep reached its rehearsal`);
        assert.ok(fight.ran <= ticks, `${label}: the deadline ran ${fight.ran} rehearsal ticks (budget ${ticks})`);
        const want = seatAfter(match, options, 'h1', fight.job.ticks, after);
        assert.equal(fight.job.cut, !want.done);
        assert.equal(fight.seat, want.seat, `${label} (${fight.readyBefore ? 'finished in time' : 'finished by the deadline'}, rehearsal ${want.done ? 'done' : `cut after ${fight.job.ticks} ticks`})`);
        if (fight.job.cut) { cut++; assert.equal(fight.onBest, true, `${label}: the best plan rehearsed so far`); }
        assert.ok(prefixes.some((p) => p.tag === 'last'), 'a prefix just before the deadline event');
        // the log replays the same prep: from the log as the deadline left it, and from prefixes before the deadline
        const log = JSON.stringify(copy.recording.events);
        const again = restoreMatch(exportMatch(copy), options);
        try { assert.equal(seatOf(again.players.get('h1')), seatOf(h1), `${label}: the restore at the deadline`); } finally { again.dispose(); }
        for (const p of prefixes) replayPrefix(p, options, clock, host, ['h1'], [fight.seat], log, label);
      } finally { copy.dispose(); }
    }
    assert.ok(unfinished > 0, 'a costly host leaves the job to the deadline');
    if (budget != null) assert.ok(cut > 0, 'the budget cuts a rehearsal');
  } finally { match.dispose(); }
});

// Several seats: the budget is shared in seat order (h1 first), so one deadline event runs at most that many rehearsal
// ticks however many seats it finishes; each seat still fights a whole board, on the best plan it rehearsed.
test('seats switched on late share the deadline budget in seat order, and a restore before or at the deadline replays it', () => {
  const budget = 256;
  const { match, clock, options, room } = fixture(17, { humans: 3, workSlice: { deadlineRehearsalTicks: budget } });
  const pids = ['h1', 'h2'];
  try {
    assert.ok(room.runUntil(() => match.phase === 'PREP' && match.round === 5));
    for (const pid of pids) match.handle(pid, { t: 'g.autoplay', on: false });
    const start = exportMatch(match);
    const deadline = match.deadline;
    let cuts = 0, starved = 0;
    for (const [lead, costMs] of [[1100, 2], [1200, 4], [1500, 10], [1500, 20]]) {
      const label = `autoplay ${lead} ms before the deadline, per-event cost ${costMs} ms`;
      const copy = restoreMatch(start, options);
      try {
        const seats = pids.map((pid) => copy.players.get(pid));
        const fights = seats.map((ps) => atPrepEnd(copy, ps, withdrawals(ps).open));
        clock.now = deadline - lead;
        copy.pump(clock.now, 100, { remaining: 1 });
        for (const pid of pids) copy.handle(pid, { t: 'g.autoplay', on: true });
        const prefixes = [];
        const host = { costMs, allowance: 1 };
        hostEvents(copy, clock, { ...host, busy: clock.now + costMs, atEvent: prefixesBefore(copy, clock, deadline, prefixes) });
        assert.equal(copy.round, 5);
        assert.equal(copy.errorCount, 0, JSON.stringify(copy.errors));
        const [a, b] = fights;
        assert.ok(a.ran + b.ran <= budget, `${label}: the deadline ran ${a.ran} + ${b.ran} rehearsal ticks (budget ${budget})`);
        if (a.job?.cut) { assert.equal(b.ran, 0, `${label}: h1's cut rehearsal used up the budget`); }
        for (const [i, f] of fights.entries()) {
          assert.equal(f.withdrawn, null, `${label}: ${pids[i]} fights a half-built board`);
          if (!f.job) continue;
          assert.ok(f.job.done || f.job.cut, `${label}: ${pids[i]}'s rehearsal is finished or cut`);
          assert.equal(f.onBest, true, `${label}: ${pids[i]} fights on the best plan it rehearsed`);
          if (f.job.cut) cuts++;
          if (f.job.cut && f.ran === 0) starved++;
        }
        const log = JSON.stringify(copy.recording.events);
        const again = restoreMatch(exportMatch(copy), options);
        try { for (const ps of seats) assert.equal(seatOf(again.players.get(ps.playerId)), seatOf(ps), `${label}: the restore at the deadline (${ps.playerId})`); } finally { again.dispose(); }
        assert.ok(prefixes.some((p) => p.tag === 'last'), 'a prefix just before the deadline event');
        for (const p of prefixes) replayPrefix(p, options, clock, host, pids, fights.map((f) => f.seat), log, label);
      } finally { copy.dispose(); }
    }
    assert.ok(cuts > 0 && starved > 0, `the budget cuts rehearsals (${cuts}) and leaves a later seat none (${starved})`);
    assert.equal(match.errorCount, 0);
  } finally { match.dispose(); }
});
