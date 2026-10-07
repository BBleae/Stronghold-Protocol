// Boss settlement on a fixed-work host (RecordedMatch, workSlice): a takeover catch-up spreads over many Room DO
// events, so the end order of the shared pool and the team LP must not depend on how long each event takes. The
// RoomDO model below is deterministic: one event = pump({ remaining: 1 }) → input → pump(same budget), and each
// event occupies the host for `costMs + ticks × tickMs` of virtual wall time (no wall clock is read).
import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordedMatch, exportMatch, restoreMatch } from '../../server/match/checkpoint.js';
import { HeadlessPacer, INTERVAL_MS } from '../../server/match/fields.js';
import { SharedBossPool } from '../../server/match/finalAssault.js';
import { FakeBattle } from './fakeBattle.js';
import { DATA } from './harness.js';

const PACED_WORK_TICKS = 128;

/** A client-combat boss round at FINAL_ASSAULT with `fields` boss fields on clients (FakeBattle once on the server). */
function bossRound({ fields = 2, teamLp = 1, pool = 1000, lead = 10000, overtimeAfter, wall }) {
  const data = structuredClone(DATA);
  if (overtimeAfter != null) data.config.bossOvertimeAfter = overtimeAfter;
  const m = new RecordedMatch({ data, roomCode: 'ORDER', seed: 17, mode: 'coop', difficulty: 'NORMAL',
    seats: Array.from({ length: 4 }, (_, seat) => ({ seat, playerId: `p${seat}`, name: `P${seat}`, isBot: false, connected: true })),
    clientCombat: true, verify: 'off', botRehearsal: 0, now: () => wall.now, send: () => true, broadcast() {}, onEnd() {} });
  m.start();
  for (const h of [...m._timers]) m.cancel(h);
  const t0 = m.sched.now();
  // the boss phase (and every field clock) began `lead` ms ago
  const startAt = t0 - lead;
  m.phase = 'FINAL_ASSAULT'; m.teamLp = teamLp; m.bossAlive = 4; m.overtimeApplied = 0; m._finalEnding = null;
  m.bossPool = new SharedBossPool(pool);
  m._specBattle = (spec, { sharedBoss }) => new FakeBattle({ ...spec, sharedBoss });
  m.fields = Array.from({ length: fields }, (_, i) => ({ cc: true, fieldId: `b${i}`, battleId: `order.b${i}`, kind: 'boss',
    players: [`p${i}`], mode: 'client', authority: `p${i}`, done: false, heldResult: null, demoted: new Set(), startAt,
    lastProgressAt: t0, bossAcked: 0, bossBy: {}, lpAcked: 0, lpReported: 0, progress: { gt: 0, total: 0, killed: 0 },
    spec: { fieldId: `b${i}`, kind: 'boss', players: [{ playerId: `p${i}` }], spawns: [] } }));
  m._bossStartAt = startAt;
  m._bossClockOn = true;
  m._bossClock = m.later(250, () => m._bossClockTick());
  return { m, t0 };
}

/** Serialized Room DO events until `done()`; inputs run in the event at or after their time. Returns the event count. */
function drive(m, wall, { inputs = [], costMs = 0, tickMs = 0.02, done = () => m._finalEnding, maxEvents = 5000, onEvent } = {}) {
  const ticks = () => FakeBattle.instances.reduce((sum, b) => sum + b.tickCount, 0);
  let busy = wall.now;
  let events = 0;
  while (!done() && events < maxEvents) {
    const next = m.sched.nextAt();
    const timerAt = next == null ? Infinity : Math.max(next, busy);
    const inputAt = inputs.length ? Math.max(inputs[0].at, busy) : Infinity;
    if (timerAt === Infinity && inputAt === Infinity) break;
    wall.now = Math.min(timerAt, inputAt);
    const before = ticks();
    const budget = { remaining: 1 };
    m.pump(wall.now, 100, budget);
    if (inputAt <= timerAt) inputs.shift().run();
    m.pump(wall.now, 100, budget);
    events++;
    onEvent?.(ticks() - before);
    busy = wall.now + costMs + (ticks() - before) * tickMs;
  }
  return events;
}

const outcome = (m) => ({ ending: m._finalEnding, teamLp: m.teamLp, overtime: m.overtimeApplied, pool: m.bossPool.hp,
  fields: m.fields.map((f) => ({ ticks: f.battle?.tickCount, mode: f.mode, result: f.result })) });

/**
 * One boss round driven to its decision: the humans of `leave` disconnect `lead` ms into the round (server takeovers
 * with a catch-up of 60 ticks per second each), the field of `reporter` (if any) keeps sending b.progress every 250 ms
 * with `human` pool damage per game second. Every server field deals 100 per game second; the first overtime point
 * (overtimeAfter 10) is at 11 s and costs the team's last LP.
 */
function settle({ lead, pool, leave, reporter = null, human = 0, costMs }) {
  FakeBattle.reset();
  FakeBattle.script = () => ({ bossDps: 100 });
  const wall = { now: 1_000_000 };
  const { m, t0 } = bossRound({ wall, teamLp: 1, pool, lead, overtimeAfter: 10 });
  const inputs = [{ at: t0, run: () => { for (const pid of leave) m.onDisconnect(pid); } }];
  for (let k = 1; reporter && k <= 12; k++) {
    const gt = ((lead + 250 * k) / 1000) * 2;
    inputs.push({ at: t0 + 250 * k, run: () => m.handle(reporter, { t: 'b.progress', battleId: `order.b${reporter.slice(1)}`,
      gt, total: 0, killed: 0, bossDmg: human * gt, by: { [reporter]: human * gt }, leaks: 0 }) });
  }
  let maxTicks = 0;
  try {
    drive(m, wall, { costMs, inputs, onEvent: (n) => { maxTicks = Math.max(maxTicks, n); } });
    assert.ok(maxTicks <= PACED_WORK_TICKS, `one event simulates at most ${PACED_WORK_TICKS} field ticks`);
    assert.equal(m.errorCount, 0, JSON.stringify(m.errors));
    // the same credits summed in another order differ by float dust (1e-11 HP)
    return JSON.parse(JSON.stringify(outcome(m), (k, v) => (typeof v === 'number' ? +v.toFixed(6) : v)));
  } finally { m.dispose(); }
}

test('the end order of a takeover catch-up, the clients\' reports and the overtime drain is the ordered baseline\'s at any per-event cost', () => {
  // Expected: bef482f, which runs a takeover catch-up synchronously and so keeps every event in time order (same
  // fixture; its result does not change with the cost). The boss clock ticks every 250 ms from 250 ms after `lead`.
  const cases = [
    // both humans leave 10.6 s in (636 ticks each); the server fields empty the pool at 10.8 s (6d36edc, whose drain
    // ran on the wall clock during the catch-up: forced from 50 ms per event)
    { label: 'takeover, the pool first', lead: 10600, pool: 2 * 100 * 21.6, leave: ['p0', 'p1'], want: ['cleared', 1, 0] },
    // the boss clock ticks on the 11 s overtime point, 50 ms before the pool would empty
    { label: 'takeover, the overtime point first', lead: 10500, pool: 2 * 100 * 22.1, leave: ['p0', 'p1'], want: ['forced', 0, 33.333] },
    // off the grid (ticks at 10.85 s, 11.1 s): the point is charged at 11.1 s, after the pool empties at 11.02 s — the
    // drain follows the boss clock, never a pacing round on its own
    { label: 'takeover, the boss clock off the overtime grid', lead: 10600, pool: 2 * 100 * 22.04, leave: ['p0', 'p1'], want: ['cleared', 1, 0] },
    // b0 is taken over 10.5 s in, b1's client reports 1000 per game s throughout: its reports wait for the catch-up
    // like the boss clock does, so the overtime point at 11 s comes first (credited on arrival instead: cleared from
    // 50 ms per event)
    { label: 'a client reporting through the catch-up, the overtime point first', lead: 10500, pool: 23900, leave: ['p0'], reporter: 'p1', human: 1000, want: ['forced', 0, 206.667] },
    { label: 'a client reporting through the catch-up, the pool first', lead: 10600, pool: 23900, leave: ['p0'], reporter: 'p1', human: 1000, want: ['cleared', 1, 0] },
  ];
  for (const { label, want, ...c } of cases) {
    const ideal = settle({ ...c, costMs: 0 });
    assert.deepEqual([ideal.ending, ideal.teamLp, +ideal.pool.toFixed(3)], want, `${label}: the ordered baseline's end`);
    for (const costMs of [10, 20, 50, 100]) assert.deepEqual(settle({ ...c, costMs }), ideal, `${label}: per-event cost ${costMs} ms`);
  }
});

/**
 * b0's human leaves `lead` ms into the round (a takeover catch-up of ~10 events of 128 ticks); p1's client empties the
 * pool with one b.progress at t0+300 (credited up to the plausibility budget of b1's own field clock, `b1Lead` ms in);
 * the boss clock's overtime point costs the team's last LP 11 s into the round; at t0+`handAt` b1 is handed to the
 * server (`how`) while the pacer may still owe b0's catch-up — b1's report and the boss clock's budget credits for it
 * that wait in the pacer's queue must keep their place there (33fdbb8 dropped them: a defeat from 150 ms per event).
 */
function handover({ how, lead = 10500, b1Lead = lead, handAt = 600, teamLp = 1, costMs }) {
  FakeBattle.reset();
  // the server's runs deal nothing: only b1's client report can empty the pool
  FakeBattle.script = () => ({ bossDps: 0 });
  const wall = { now: 1_000_000 };
  const gtAt = (dt) => ((b1Lead + dt) / 1000) * 2;
  const pool = 1000 * gtAt(300);
  const { m, t0 } = bossRound({ wall, teamLp, pool, lead, overtimeAfter: 10 });
  m.fields[1].startAt = t0 - b1Lead;
  const inputs = [
    { at: t0, run: () => m.onDisconnect('p0') },
    { at: t0 + 300, run: () => m.handle('p1', { t: 'b.progress', battleId: 'order.b1', gt: gtAt(300), total: 0, killed: 0,
      bossDmg: pool, by: { p1: pool }, leaks: 0 }) },
    { at: t0 + handAt, run: () => {
      if (how === 'disconnect') m.onDisconnect('p1');
      else if (how === 'leave') m.onLeave('p1');
      // rejected by validateClientResult: demoted, handed to the server
      else m.handle('p1', { t: 'b.result', battleId: 'order.b1', result: { time: -1, reason: 'bogus', perPlayer: {} } });
    } },
  ];
  try {
    drive(m, wall, { costMs, inputs });
    assert.equal(m.errorCount, 0, JSON.stringify(m.errors));
    const handed = m.fields[1].mode === 'server';
    return { outcome: JSON.parse(JSON.stringify({ ending: m._finalEnding, teamLp: m.teamLp, overtime: m.overtimeApplied, pool: m.bossPool.hp },
      (k, v) => (typeof v === 'number' ? +v.toFixed(6) : v))), handed };
  } finally { m.dispose(); }
}

test('a client field handed to the server during another field\'s catch-up keeps its waiting reports in time order', () => {
  const cases = [
    // the report (t0+300) empties the pool before the overtime point (t0+500) takes the last LP: a clear
    { label: 'report, then the overtime point', want: { ending: 'cleared', teamLp: 1, overtime: 0, pool: 0 } },
    // five LP: no flip, but no overtime point may be drained before the pool is empty (hiddenEligible reads the team LP)
    { label: 'report, then the overtime point (5 LP)', teamLp: 5, want: { ending: 'cleared', teamLp: 5, overtime: 0, pool: 0 } },
    // b1's field clock is 2 s in: its report is credited up to the budget at t0+300 (92 %), the boss clock's budget
    // credit at t0+500 empties the pool, the overtime point follows at t0+750 (11 s on the boss clock)
    { label: 'budget credit on the boss clock, then the overtime point', lead: 10250, b1Lead: 2000, handAt: 800, want: { ending: 'cleared', teamLp: 1, overtime: 0, pool: 0 } },
  ];
  for (const how of ['disconnect', 'leave', 'invalid result']) {
    for (const { label, want, ...c } of cases) {
      let handed = 0;
      for (const costMs of [0, 20, 50, 100, 150, 300]) {
        const r = handover({ ...c, how, costMs });
        assert.deepEqual(r.outcome, want, `${label}, ${how}: per-event cost ${costMs} ms`);
        if (r.handed) handed++;
      }
      assert.ok(handed > 0, `${label}, ${how}: the handover came before the decision at some cost`);
    }
  }
});

test('a pacing backlog catches up at the slice rate, not one logical round per event', () => {
  FakeBattle.reset();
  const wall = { now: 1_000_000 };
  const m = new RecordedMatch({ data: DATA, roomCode: 'BACKLOG', seed: 17, mode: 'coop', difficulty: 'NORMAL',
    seats: Array.from({ length: 4 }, (_, seat) => ({ seat, playerId: `p${seat}`, name: `P${seat}`, isBot: false, connected: true })),
    clientCombat: true, verify: 'off', now: () => wall.now, send: () => true, broadcast() {}, onEnd() {} });
  const pacer = m.pacer = new HeadlessPacer(m);
  const old = new FakeBattle({ kind: 'boss', fieldId: 'old' });
  const t0 = m.sched.now();
  pacer.add({ battle: old, onDone() {} });
  const lagging = () => pacer.catchups.length > 0 || m.sched.now() - pacer.last > INTERVAL_MS + 1;
  try {
    // 1 s in real time, then the host stalls for 2 s (no event at all), then a field is taken over 3 s into the round
    for (wall.now = t0 + 20; wall.now <= t0 + 1000; wall.now += 20) m.pump(wall.now, 100, { remaining: 1 });
    assert.equal(lagging(), false);
    wall.now = m.sched.t = t0 + 3000;
    const fresh = new FakeBattle({ kind: 'boss', fieldId: 'fresh' });
    pacer.skipTo(pacer.add({ battle: fresh, onDone() {} }), 6);
    const before = old.tickCount + fresh.tickCount;
    let events = 0;
    for (; events < 400 && (events === 0 || lagging()); events++) { wall.now += 20; m.pump(wall.now, 100, { remaining: 1 }); }
    // events every 20 ms meanwhile owe about one more round each; every round end counts toward an admission's cap
    const backlog = old.tickCount + fresh.tickCount - before;
    assert.ok(backlog >= 180 + 2 * 60, `the takeover target and the stalled rounds are simulated (${backlog} ticks)`);
    assert.ok(events <= Math.ceil(backlog / PACED_WORK_TICKS) + 3, `${backlog} backlog ticks took ${events} events`);
    const due = Math.floor(((pacer.last - t0) / 1000) * 60 + 1e-6);
    assert.ok(Math.abs(old.tickCount - due) <= 2, `no stalled round is dropped (${old.tickCount} of ${due} ticks)`);
    assert.equal(m.errorCount, 0);
  } finally { m.dispose(); }
});

test('a leak inside a takeover catch-up that empties the team LP ends the run before the catch-up empties the pool', () => {
  FakeBattle.reset();
  // tick 30: the leak costs the last LP; tick 100: the field's damage would empty the pool (same 128-tick slice)
  FakeBattle.script = () => ({ bossDps: 300, leakEvents: [{ at: 1, lpr: 1 }] });
  const wall = { now: 1_000_000 };
  const { m, t0 } = bossRound({ wall, fields: 1, teamLp: 1, pool: 300 * (100 / 30) });
  try {
    drive(m, wall, { inputs: [{ at: t0, run: () => m.onDisconnect('p0') }] });
    assert.equal(m._finalEnding, 'forced', 'team LP 0 first is a defeat');
    assert.equal(m.fields[0].battle.tickCount, 30, 'judged at the tick of the leak');
    assert.ok(m.bossPool.hp > 0);
    assert.equal(m.teamLp, 0);
    assert.equal(m.errorCount, 0, JSON.stringify(m.errors));
  } finally { m.dispose(); }
});

test('the overtime drain stops once the run is decided, during the clients\' result grace period', () => {
  FakeBattle.reset();
  const wall = { now: 1_000_000 };
  // the overtime drain starts 0.5 s from now; the client of b0 empties the pool right away
  const { m, t0 } = bossRound({ wall, fields: 2, teamLp: 10, pool: 1000, lead: 10500, overtimeAfter: 10 });
  try {
    drive(m, wall, { done: () => wall.now >= t0 + 3000, inputs: [{ at: t0, run: () => m.handle('p0',
      { t: 'b.progress', battleId: 'order.b0', gt: 21, total: 0, killed: 0, bossDmg: 1000, by: { p0: 1000 }, leaks: 0 }) }] });
    assert.equal(m._finalEnding, 'cleared');
    assert.ok(m.fields.some((f) => !f.done), 'the other client still has its grace period: the boss clock runs on');
    assert.equal(m.overtimeApplied, 0);
    assert.equal(m.teamLp, 10, 'no overtime LP after the victory (hiddenEligible reads the team LP)');
  } finally { m.dispose(); }
});

test('a solo pause parks the server-run boss pacer without logging a timer per interval, also across a restore', () => {
  // A real solo match: the human stays connected but silent, so the server takes the boss field over; then pauses.
  const data = structuredClone(DATA);
  const mode = data.config.modes.mode_single_normal;
  mode.rounds['1'] = structuredClone(mode.rounds[mode.bossRound]);
  mode.bossRound = mode.lastRound = 1; mode.hiddenRound = null;
  let now = 1000;
  const options = { data, roomCode: 'PAUSE', mode: 'solo', difficulty: 'NORMAL', seed: 17,
    seats: [{ seat: 0, playerId: 'p0', name: 'P0', isBot: false, connected: true }],
    clientCombat: true, verify: 'off', botRehearsal: 0, now: () => now, send: () => true, broadcast() {}, onEnd() {} };
  const m = new RecordedMatch(options);
  let restored;
  const event = (match) => match.pump(now, 100, { remaining: 1 });
  const state = (match) => ({ checkpoint: exportMatch(match), lp: match.teamLp, paused: match.paused,
    fields: match.fields.map((f) => ({ mode: f.mode, ticks: f.battle?.tickCount, snapshot: f.battle?.snapshot?.() })),
    pool: match.bossPool?.hp, timers: match.sched._q.filter((t) => !t.cancelled).map(({ id, at, seq, every }) => ({ id, at, seq, every })) });
  try {
    m.start();
    m.handle('p0', { t: 'g.autoplay', on: true });
    m.handle('p0', { t: 'g.infoReady' });
    for (let i = 0; i < 20000 && m.phase !== 'FINAL_ASSAULT'; i++) { now = m.sched.nextAt(); m.pump(now, 1); }
    assert.equal(m.phase, 'FINAL_ASSAULT');
    m.handle('p0', { t: 'g.autoplay', on: false });
    for (let i = 0; i < 1000 && !m.pacer?.entries.size; i++) { now += 33; event(m); }
    for (let i = 0; i < 30; i++) { now += 33; event(m); }
    assert.equal(m.fields[0].mode, 'server');
    assert.equal(m.pacer.catchups.length, 0);
    const ticks = m.fields[0].battle.tickCount;
    assert.deepEqual(m.handle('p0', { t: 'g.pause', on: true }), { ok: true });
    const rows = m.recording.events.length;
    for (let i = 0; i < 300; i++) { now += 33; event(m); }
    assert.ok(m.recording.events.length - rows <= 1, `10 s of pause logged ${m.recording.events.length - rows} timer rows`);
    assert.equal(m.fields[0].battle.tickCount, ticks, 'the field clock stands still');
    restored = restoreMatch(exportMatch(m), options);
    assert.deepEqual(state(restored), state(m), 'a paused prefix restores the parked pacer');
    now += 10;
    for (const match of [m, restored]) match.handle('p0', { t: 'g.pause', on: false });
    for (let i = 0; i < 30; i++) {
      now += 33;
      event(m); event(restored);
      assert.deepEqual(state(restored), state(m));
    }
    // 30 events of 33 ms after the resume: about 59 ticks at 2 per round, none for the 10 s pause
    assert.ok(Math.abs(m.fields[0].battle.tickCount - ticks - 60) <= 2, `${m.fields[0].battle.tickCount - ticks} ticks after the resume`);
    assert.equal(m.errorCount, 0, JSON.stringify(m.errors));
    assert.equal(restored.errorCount, 0);
  } finally { m.dispose(); restored?.dispose(); }
});

// A real match: four connected humans (two pair fields) stay silent into the overtime drain, then `leave` of them leave —
// the server takes their fields over and queues a long catch-up while the boss clock keeps ticking (its drain waits in
// the pacer's queue: Match._bossInOrder), and the other pair's client keeps reporting b.progress every ~250 ms (those
// credits wait there too).
for (const leave of [['p0', 'p1', 'p2', 'p3'], ['p0', 'p1']]) test(`the boss-round work queued behind a takeover catch-up restores identically from prefixes inside it (${leave.length} of 4 leave)`, () => {
  const data = structuredClone(DATA);
  const mode = data.config.modes.mode_multi_normal;
  mode.rounds['1'] = structuredClone(mode.rounds[mode.bossRound]);
  mode.bossRound = mode.lastRound = 1; mode.hiddenRound = null;
  data.config.bossOvertimeAfter = 4;
  let now = 1000;
  const options = { data, roomCode: 'RESTOT', mode: 'coop', difficulty: 'NORMAL', seed: 17,
    seats: Array.from({ length: 4 }, (_, seat) => ({ seat, playerId: `p${seat}`, name: `P${seat}`, isBot: false, connected: true })),
    clientCombat: true, verify: 'off', botRehearsal: 0, now: () => now, send: () => true, broadcast() {}, onEnd() {} };
  const m = new RecordedMatch(options);
  const restored = [];
  const state = (match) => ({ checkpoint: exportMatch(match), lp: match.teamLp, overtime: match.overtimeApplied,
    ending: match._finalEnding, fields: match.fields.map((f) => ({ mode: f.mode, ticks: f.battle?.tickCount, snapshot: f.battle?.snapshot?.() })),
    pool: match.bossPool?.hp, timers: match.sched._q.filter((t) => !t.cancelled).map(({ id, at, seq, every }) => ({ id, at, seq, every })),
    queue: match.pacer && { catchups: match.pacer.catchups.map((c) => [c.at, c.seq]), late: match.pacer.late.map((d) => [d.at, d.seq]) } });
  try {
    m.start();
    for (const p of m.order) { m.handle(p.playerId, { t: 'g.autoplay', on: true }); m.handle(p.playerId, { t: 'g.infoReady' }); }
    for (let i = 0; i < 20000 && m.phase !== 'FINAL_ASSAULT'; i++) { now = m.sched.nextAt(); m.pump(now, 1); }
    assert.equal(m.phase, 'FINAL_ASSAULT');
    for (let t = 0; t < 11000; t += 33) { now += 33; m.pump(now, 100, { remaining: 1 }); }
    const overtime = m.overtimeApplied;
    assert.ok(overtime > 0, 'the drain has started');
    for (const pid of leave) m.onDisconnect(pid);
    assert.equal(m.pacer.catchups.length, leave.length / 2, 'one takeover per pair that left');
    const reporters = m.fields.filter((f) => f.mode === 'client').map((f) => ({ pid: f.authority, battleId: f.battleId, startAt: f.startAt }));
    assert.equal(reporters.length, (4 - leave.length) / 2);
    let lagged = 0, queued = 0, reportsQueued = 0;
    for (let i = 0; i < 40 && !m._finalEnding; i++) {
      now += 40;
      for (const match of [m, ...restored]) {
        match.pump(now, 100, { remaining: 1 });
        // the staying clients: 400 pool damage per game second each
        if (i % 6 === 0) for (const r of reporters) {
          const gt = ((now - r.startAt) / 1000) * match.gameSpeed;
          const waiting = match.pacer?.late.length ?? 0;
          match.handle(r.pid, { t: 'b.progress', battleId: r.battleId, gt, total: 0, killed: 0, bossDmg: 400 * gt, by: { [r.pid]: 400 * gt }, leaks: 0 });
          if (match === m && (match.pacer?.late.length ?? 0) > waiting) reportsQueued++;
        }
        match.pump(now, 100, { remaining: 0 });
      }
      if (m.pacer?.behind(m._clockNow() - m.pausedMs)) lagged++;
      if (m.pacer?.late.length) queued++;
      for (const r of restored) assert.deepEqual(state(r), state(m), `restored copy, event ${i}`);
      if ([0, 1, 2, 4, 8, 16].includes(i)) {
        const r = restoreMatch(exportMatch(m), options);
        assert.deepEqual(state(r), state(m), `prefix after event ${i}`);
        restored.push(r);
      }
    }
    assert.ok(lagged > 0, 'the catch-up kept the pacer behind the wall clock');
    assert.ok(queued > 0, 'boss-round work waited in the pacer\'s queue (prefixes cut inside it)');
    if (reporters.length) {
      assert.ok(reportsQueued > 0, 'the client\'s reports waited in the queue');
      assert.ok(m.fields.some((f) => f.mode === 'client' && f.bossAcked > 0), 'the reports were credited after the catch-up');
    }
    assert.ok(m.overtimeApplied > overtime, 'the drain went on after the catch-up');
    assert.equal(m.errorCount, 0, JSON.stringify(m.errors));
    for (const r of restored) assert.equal(r.errorCount, 0);
  } finally { m.dispose(); for (const r of restored) r.dispose(); }
});
