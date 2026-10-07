import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordedMatch, exportMatch, restoreMatch } from '../../server/match/checkpoint.js';
import { HeadlessPacer, FieldRunner } from '../../server/match/fields.js';
import { SharedBossPool } from '../../server/match/finalAssault.js';
import { FakeBattle } from './fakeBattle.js';
import { DATA } from './harness.js';

function fixture(ticks = 7, mode = 'coop') {
  FakeBattle.reset();
  return new RecordedMatch({ data: DATA, roomCode: 'BUDGET', seed: 17, mode, difficulty: 'NORMAL',
    seats: Array.from({ length: mode === 'solo' ? 1 : 4 }, (_, seat) => ({ seat, playerId: `p${seat}`, name: `P${seat}`, isBot: false, connected: true })),
    workSlice: { simulationTicks: ticks }, clientCombat: true, verify: 'off', now: () => 100000,
    send: () => true, broadcast() {}, onEnd() {} });
}
for (const runner of ['pacer', 'fields']) test(`${runner} shares event work across overdue pumps and cancels suspended work`, () => {
  const m = fixture();
  const battles = Array.from({ length: 4 }, (_, i) => new FakeBattle({ kind: 'boss', fieldId: `b${i}` }));
  const r = runner === 'pacer' ? m.pacer = new HeadlessPacer(m)
    : m.runner = new FieldRunner(m, battles.map(battle => ({ battle, fieldId: battle.fieldId, players: [] })), { emit: false, onDone() {} });
  if (runner === 'pacer') for (const battle of battles) r.add({ battle, onDone() {} }); else r.start();
  const ticks = () => battles.reduce((sum, b) => sum + b.tickCount, 0);
  try {
    const until = m.sched.now() + 10000;
    const empty = { remaining: 0 };
    m.pump(until, 100, empty); m.pump(until, 100, empty);
    assert.equal(ticks(), 0, 'no work may bypass an exhausted event budget');
    const one = { remaining: 1 };
    m.pump(until + 1, 100, one); m.pump(until + 1, 100, one);
    assert.ok(ticks() > 0 && ticks() <= 7, 'one allowance is shared across fields and both pumps');
    const before = ticks();
    r.stop();
    m.pump(until + 10000, 100, { remaining: 100 });
    assert.equal(ticks(), before, 'stopping cancels the suspended continuation');
  } finally { m.dispose(); }
});

test('Boss takeover queues catch-up without stepping synchronously, then bounds the whole group', () => {
  const m = fixture();
  m.phase = 'FINAL_ASSAULT'; m.teamLp = 100; m.bossPool = new SharedBossPool(1e9);
  m._specBattle = (spec, { sharedBoss }) => new FakeBattle({ ...spec, sharedBoss });
  m.fields = Array.from({ length: 4 }, (_, i) => ({ cc: true, fieldId: `b${i}`, battleId: `count.b${i}`, kind: 'boss',
    players: [`p${i}`], mode: 'client', authority: `p${i}`, done: false, heldResult: null, demoted: new Set(), startAt: 10000,
    bossAcked: 0, bossBy: {}, lpAcked: 0, spec: { fieldId: `b${i}`, kind: 'boss', players: [{ playerId: `p${i}` }] } }));
  try {
    for (const p of m.players.values()) p.connected = false;
    for (const f of m.fields) m._bossHandover(f, 'disconnect');
    const ticks = () => m.fields.reduce((sum, f) => sum + f.battle.tickCount, 0);
    assert.equal(ticks(), 0, 'takeover must yield even with a VirtualScheduler');
    m.pump(m.sched.now() + 10000, 100, { remaining: 1 });
    assert.ok(ticks() > 0 && ticks() <= 7);
  } finally { m.dispose(); }
});


for (const takeover of [false, true]) test(`real Boss ${takeover ? 'takeover' : 'all-server'} partial work reconstructs from checkpoint`, () => {
  const data = structuredClone(DATA);
  const mode = data.config.modes.mode_multi_normal;
  mode.rounds['1'] = structuredClone(mode.rounds[mode.bossRound]);
  mode.bossRound = mode.lastRound = 1; mode.hiddenRound = null;
  let now = 1000;
  const options = { data, roomCode: 'RESTORE', mode: 'coop', difficulty: 'NORMAL', seed: 17,
    seats: Array.from({ length: 4 }, (_, seat) => ({ seat, playerId: `p${seat}`, name: `P${seat}`, isBot: false, connected: true })),
    workSlice: { simulationTicks: 7 }, clientCombat: true, verify: 'off', botRehearsal: 0,
    now: () => now, send: () => true, broadcast() {}, onEnd() {} };
  const m = new RecordedMatch(options);
  let restored;
  try {
    m.start();
    for (const p of m.order) {
      m.handle(p.playerId, { t: 'g.autoplay', on: true });
      m.handle(p.playerId, { t: 'g.infoReady' });
      if (!takeover) m.onDisconnect(p.playerId);
    }
    for (let i = 0; i < 5000 && m.phase !== 'FINAL_ASSAULT'; i++) {
      now = m.sched.nextAt(); assert.notEqual(now, null);
      m.pump(now, 1);
    }
    assert.equal(m.phase, 'FINAL_ASSAULT');
    if (takeover) {
      now += 10000;
      for (const p of m.order) m.onDisconnect(p.playerId);
      assert.ok(m.pacer);
      assert.ok(m.fields.every(f => f.battle.tickCount === 0));
    } else assert.ok(m.runner);
    now += 100;
    m.pump(now, 100, { remaining: 1 });
    assert.ok(m.fields.some(f => f.battle.tickCount > 0));
    const state = match => ({ checkpoint: exportMatch(match), lp: match.teamLp,
      fields: match.fields.map(f => ({ ticks: f.battle.tickCount, result: f.battle.finished ? f.battle.result() : null,
        credit: f.credit && { cum: f.credit.cum, acked: f.credit.acked }, snapshot: f.battle.snapshot() })),
      pool: { hp: match.bossPool.hp, by: match.bossPool.by },
      timers: match.sched._q.filter(t => !t.cancelled).map(({ id, at, seq, every }) => ({ id, at, seq, every })) });
    restored = restoreMatch(exportMatch(m), options);
    assert.deepEqual(state(restored), state(m));
    for (let i = 0; i < 4; i++) {
      now += 100;
      m.pump(now, 100, { remaining: 1 }); restored.pump(now, 100, { remaining: 1 });
      assert.deepEqual(state(restored), state(m), 'the same input/timer log resumes identical partial rounds');
    }
    assert.equal(m.errorCount, 0); assert.equal(restored.errorCount, 0);
  } finally { m.dispose(); restored?.dispose(); }
});
for (const runner of ['pacer', 'fields']) test(`${runner} retains field order across several admissions of one late pacing round`, () => {
  const m = fixture();
  const trace = [];
  const battles = Array.from({ length: 4 }, (_, i) => {
    const b = new FakeBattle({ kind: 'boss', fieldId: `b${i}` });
    const step = b.step.bind(b); b.step = () => { trace.push(i); return step(); };
    return b;
  });
  const r = runner === 'pacer' ? m.pacer = new HeadlessPacer(m)
    : m.runner = new FieldRunner(m, battles.map(battle => ({ battle, fieldId: battle.fieldId, players: [] })), { emit: false, onDone() {} });
  if (runner === 'pacer') for (const battle of battles) r.add({ battle, onDone() {} }); else r.start();
  try {
    let now = m.sched.now() + 10000;
    m.pump(now, 100, { remaining: 0 });
    for (let i = 0; trace.length < 32 && i < 10; i++) m.pump(++now, 100, { remaining: 1 });
    assert.deepEqual(trace, runner === 'pacer' ? Array.from({ length: 4 }, () => [0, 0, 1, 1, 2, 2, 3, 3]).flat()
      : Array.from({ length: 8 }, () => [0, 1, 2, 3]).flat());
    assert.ok(battles.every(b => b.tickCount === 8), 'all overdue virtual rounds retain their ticks and every field progresses');
  } finally { m.dispose(); }
});

test('queued takeover targets retain FIFO shared-pool credit without round-robin slice rotation', () => {
  const m = fixture(3);
  const pool = new SharedBossPool(1000);
  const trace = [];
  FakeBattle.script = () => ({ bossDps: 30 });
  const pacer = m.pacer = new HeadlessPacer(m);
  const battles = Array.from({ length: 2 }, (_, i) => {
    const b = new FakeBattle({ kind: 'boss', fieldId: `b${i}`, sharedBoss: pool, players: [{ playerId: `p${i}` }] });
    const step = b.step.bind(b); b.step = () => { trace.push(i); return step(); };
    const entry = pacer.add({ battle: b, onDone() {} });
    pacer.skipTo(entry, 1 / 3);
    return b;
  });
  try {
    let now = m.sched.now();
    while (trace.length < 20) { now += 34; m.pump(now, 100, { remaining: 1 }); }
    assert.deepEqual(trace.slice(0, 20), [...Array(10).fill(0), ...Array(10).fill(1)]);
    assert.ok(battles.every(b => b.tickCount >= 10), 'the second queued target completes after the first');
    assert.equal(pool.hp, 1000 - trace.length, 'every simulated damage tick is credited once');
  } finally { m.dispose(); }
});


test('sliced takeover retains acknowledged damage and LP while completing its original target', () => {
  const m = fixture(3);
  m.phase = 'FINAL_ASSAULT'; m.teamLp = 98; m.bossPool = new SharedBossPool(1000);
  m.bossPool.damage('p0', 6);
  FakeBattle.script = () => ({ bossDps: 30, leakEvents: [{ at: 0.2, lpr: 2 }] });
  m._specBattle = (spec, { sharedBoss }) => new FakeBattle({ ...spec, sharedBoss });
  const f = { cc: true, fieldId: 'b0', battleId: 'credit.b0', kind: 'boss', players: ['p0'],
    mode: 'client', authority: 'p0', done: false, heldResult: null, demoted: new Set(), startAt: m.sched.now() - 250,
    bossAcked: 6, bossBy: { p0: 6 }, lpAcked: 2, spec: { fieldId: 'b0', kind: 'boss', players: [{ playerId: 'p0' }] } };
  m.fields = [f];
  try {
    m.players.get('p0').connected = false;
    m._bossHandover(f, 'disconnect');
    let now = m.sched.now() + 34;
    for (let i = 0; i < 5; i++) m.pump(now++, 100, { remaining: 1 });
    assert.equal(f.battle.tickCount, 15);
    assert.equal(f.credit.cum, 15);
    assert.equal(m.bossPool.hp, 985, 'the first six damage were already credited by the client');
    assert.equal(m.teamLp, 98, 'the acknowledged leak is not charged a second time');
    assert.equal(f.lpCum, 2);
    assert.equal(f.lpAcked, 2);
    m.dispose();
    assert.equal(m.sched.nextAt(), null, 'disposing clears work and ordinary timers');
  } finally { m.dispose(); }
});
for (const runner of ['pacer', 'fields']) test(`${runner} budget deferral preserves virtual pacing backlog`, () => {
  const run = fixed => {
    const m = fixture(7);
    if (!fixed) m.workSlice = null;
    const b = new FakeBattle({ kind: 'boss', fieldId: 'backlog' });
    const r = runner === 'pacer' ? m.pacer = new HeadlessPacer(m)
      : m.runner = new FieldRunner(m, [{ battle: b, fieldId: b.fieldId, players: [] }], { emit: false, onDone() {} });
    if (runner === 'pacer') r.add({ battle: b, onDone() {} }); else r.start();
    try {
      const until = m.sched.now() + 1000;
      m.pump(until, 100, { remaining: fixed ? 1 : 100 });
      if (fixed) m.pump(until + 1, 1000, { remaining: 1000 });
      return b.tickCount;
    } finally { m.dispose(); }
  };
  assert.equal(run(true), run(false), 'admission waiting must not be reclassified as dropped host-stall time');
});


for (const runner of ['pacer', 'fields']) test(`${runner} pause spanning denied admissions excludes paused time from retained backlog`, () => {
  const m = fixture(7, 'solo');
  const b = new FakeBattle({ kind: 'boss', fieldId: 'pause' });
  m.phase = 'COMBAT';
  m.fields = [{ battle: b, fieldId: b.fieldId, players: ['p0'], live: true, done: false }];
  const r = runner === 'pacer' ? m.pacer = new HeadlessPacer(m)
    : m.runner = new FieldRunner(m, m.fields, { emit: false, onDone() {} });
  if (runner === 'pacer') r.add({ battle: b, onDone() {} }); else r.start();
  try {
    const start = m.sched.now();
    m.pump(start + 100, 100, { remaining: 0 });
    m.sched.t = start + 100.5;
    m.setPause(m.order[0], true);
    assert.equal(m.paused, true);
    m.pump(start + 1100, 100, { remaining: 0 });
    m.sched.t = start + 1100.5;
    m.setPause(m.order[0], false);
    assert.equal(m.pausedMs, 1000);
    m.pump(start + 1201, 1000, { remaining: 1000 });
    assert.equal(b.tickCount, 12, '201ms active time is six virtual intervals; the 1000ms pause adds none');
  } finally { m.dispose(); }
});

test('a new takeover does not replay the old fields pacing backlog twice', () => {
  const m = fixture(7);
  const pacer = m.pacer = new HeadlessPacer(m);
  const old = new FakeBattle({ kind: 'boss', fieldId: 'old' });
  pacer.add({ battle: old, onDone() {} });
  try {
    const until = m.sched.now() + 1000;
    m.pump(until, 100, { remaining: 0 });
    m.sched.t = until;
    const fresh = new FakeBattle({ kind: 'boss', fieldId: 'fresh' });
    const entry = pacer.add({ battle: fresh, onDone() {} });
    pacer.skipTo(entry, 2);
    m.pump(until + 1, 1000, { remaining: 1000 });
    assert.equal(old.tickCount, 60, 'the existing field keeps its queued intervals');
    assert.equal(fresh.tickCount, 60, 'takeover target already covers the historical time');
  } finally { m.dispose(); }
});

test('a completed last takeover clears its work chain and a later takeover can start another', () => {
  const m = fixture();
  FakeBattle.script = () => ({ duration: 1 / 30 });
  m.phase = 'FINAL_ASSAULT'; m.teamLp = 100; m.bossPool = new SharedBossPool(1000);
  m._specBattle = (spec, { sharedBoss }) => new FakeBattle({ ...spec, sharedBoss });
  m.fields = [0, 1, 2].map(i => ({ cc: true, fieldId: `b${i}`, battleId: `completion.b${i}`, kind: 'boss',
    players: [`p${i}`], mode: 'client', authority: `p${i}`, done: false, heldResult: null,
    demoted: new Set(), startAt: m.sched.now() - 250, bossAcked: 0, bossBy: {}, lpAcked: 0, progress: {},
    spec: { fieldId: `b${i}`, kind: 'boss', players: [{ playerId: `p${i}` }] } }));
  try {
    m.players.get('p0').connected = false;
    m._bossHandover(m.fields[0], 'disconnect');
    m.pump(m.sched.now() + 34, 100, { remaining: 1 });
    assert.equal(m.fields[0].done, true);
    assert.equal(m.fields[1].done, false);
    assert.equal(m.pacer.stopped, false);
    assert.equal(m.errorCount, 0, JSON.stringify(m.errors));
    m.players.get('p1').connected = false;
    m._bossHandover(m.fields[1], 'disconnect');
    m.pump(m.sched.now() + 34, 100, { remaining: 1 });
    assert.equal(m.fields[1].done, true, 'the retained pacer schedules a new work chain');
    assert.equal(m.fields[2].done, false);
    assert.equal(m.errorCount, 0, JSON.stringify(m.errors));
    assert.equal(m.pacer.workTimer, null);
    assert.equal(m.pacer.workIterator, null);
  } finally { m.dispose(); }
});

test('a pause in a suspended pacing round does not exclude its later fields', () => {
  const m = fixture(1, 'solo');
  const pacer = m.pacer = new HeadlessPacer(m);
  const battles = [0, 1].map(i => new FakeBattle({ kind: 'boss', fieldId: `pause${i}` }));
  m.phase = 'COMBAT';
  m.fields = battles.map(battle => ({ battle, fieldId: battle.fieldId, players: ['p0'], live: true, done: false }));
  for (const battle of battles) pacer.add({ battle, onDone() {} });
  try {
    const start = m.sched.now();
    m.pump(start + 34, 100, { remaining: 1 });
    assert.deepEqual(battles.map(b => b.tickCount), [1, 0]);
    m.sched.t = start + 34;
    m.setPause(m.order[0], true);
    m.sched.t = start + 1034;
    m.setPause(m.order[0], false);
    m.pump(start + 1035, 100, { remaining: 20 });
    assert.deepEqual(battles.map(b => b.tickCount), [2, 2], 'both fields finish the already-started virtual interval');
    assert.equal(m.errorCount, 0);
  } finally { m.dispose(); }
});
for (const runner of ['pacer', 'fields']) test(`${runner} limits a paced work slice to 128 ticks under the default 512 simulation budget`, () => {
  const m = fixture(512);
  const battles = [0, 1].map(i => new FakeBattle({ kind: 'boss', fieldId: `cap${i}` }));
  if (runner === 'pacer') {
    const pacer = m.pacer = new HeadlessPacer(m);
    for (const battle of battles) {
      const entry = pacer.add({ battle, onDone() {} });
      pacer.skipTo(entry, 20);
    }
  } else {
    // Accelerated virtual pacing makes a single logical round larger than the CPU slice.
    m.gameSpeed = 256;
    m.runner = new FieldRunner(m, battles.map(battle => ({ battle, fieldId: battle.fieldId, players: [] })), { emit: false, onDone() {} });
    m.runner.start();
  }
  try {
    m.pump(m.sched.now() + 100, 100, { remaining: 1 });
    assert.equal(battles.reduce((sum, b) => sum + b.tickCount, 0), 128);
    assert.equal(m.workSlice.simulationTicks, 512, 'ordinary headless jobs retain their configured budget');
    assert.equal(m.errorCount, 0);
  } finally { m.dispose(); }
});
