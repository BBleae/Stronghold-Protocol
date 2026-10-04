// The replay log of a client-simulated battle (public/js/battle/runner.js, account mode) as the server archives it
// (server/match/checkpoint.js RecordedMatch, server/match/recorder.js): it stays complete — and re-simulates
// (battle/replay-runner.js) to the battle that was played — across a short offline window the server never notices, a
// dead socket that swallowed reports, a battle that ends while offline, and a boss handover whose replica kept more
// inputs than one report carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattleRunner, REPORT_INPUTS } from '../../public/js/battle/runner.js';
import { createReplayRunner } from '../../public/js/battle/replay-runner.js';
import { createStore, initialState } from '../../public/js/store.js';
import * as specMod from '../../server/sim/spec.js';
import { DataSource } from '../../server/sim/simdata.js';
import { RecordedMatch } from '../../server/match/checkpoint.js';
import { appendReplayReport } from '../../server/match/recorder.js';
import { validateC2S } from '../../shared/protocol.js';
import { PHASE } from '../../shared/constants.js';
import { DATA, makeMatch } from './harness.js';

const DS = new DataSource(DATA, null);
const QUIET = { error() {}, warn() {}, info() {}, debug() {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function runnerFor(net, now) {
  const frames = [];
  const runner = createBattleRunner({
    net, store: createStore(initialState), doc: { hidden: false, addEventListener() {} }, now,
    raf: (fn) => { frames.push(fn); return frames.length; }, caf() {}, setInterval: () => 1, clearInterval() {},
    loadSim: async () => ({ spec: specMod, ds: DS }), logger: QUIET,
  });
  return { runner, frame: (t) => { for (const fn of frames.splice(0)) fn(t); } };
}

/** Re-simulate an archived client battle; its last snapshot and result must be the live battle's. */
function assertReplays(record, live) {
  let battle = null;
  const replay = createReplayRunner({ engine: { createBattle: (spec) => (battle = specMod.createBattleFromSpec(spec, DS)) } });
  replay.select(record);
  replay.play();
  for (let i = 0; i < 2000 && replay.state().playing; i++) replay.advance(0.5);
  assert.equal(battle.tickCount, live.tickCount, 'the replay runs to the last tick');
  assert.deepEqual(battle.snapshot(), live.snapshot());
  assert.deepEqual(specMod.compactResult(battle.result()), specMod.compactResult(live.result()));
  replay.dispose();
}

/**
 * A real client-combat match (one human, one bot) and the human's battle runner, wired through a socket that behaves
 * like public/js/net.js: while the link is 'down' send() returns false and requests wait in a queue that the reconnect
 * flushes before 'welcome'; a 'lossy' link (dead, not yet noticed by the heartbeat) takes frames that never arrive, and
 * its requests fail DISCONNECTED when it is dropped. The server never sees the old socket close (the resumed hello
 * replaces the session) unless `serverSees`; it resyncs on the hello (match.onReconnect).
 */
async function liveMatch() {
  let clock = 1000;
  let link = 'up';
  const inbox = [];
  const queued = [];
  const lost = [];
  const log = { requestsWhileDown: 0 };
  const m = new RecordedMatch({
    mode: 'coop', difficulty: 'NORMAL', roomCode: 'ABCD', seed: 17, matchNo: 1, data: DATA, botRehearsal: 0, clientCombat: true,
    seats: [{ seat: 0, playerId: 'p0', name: 'Alice', isBot: false, connected: true },
      { seat: 1, playerId: 'ai0', name: 'Bot', isBot: true, connected: true }],
    now: () => clock, log: QUIET, onEnd() {},
    send: (pid, msg) => { if (pid === 'p0' && link === 'up') inbox.push(msg); return true; },
    broadcast: (msg) => { if (link === 'up') inbox.push(msg); },
  });
  m.start();
  m.handle('p0', { t: 'g.autoplay', on: true });
  m.handle('p0', { t: 'g.infoReady' });
  const handlers = new Map();
  const answer = (msg) => {
    const res = m.handle('p0', msg);
    return res && res.error ? Promise.reject(Object.assign(new Error(res.error), { code: res.error })) : Promise.resolve({ t: 'ok' });
  };
  const net = {
    accountMode: true,
    on(t, fn) { if (!handlers.has(t)) handlers.set(t, new Set()); handlers.get(t).add(fn); return () => handlers.get(t).delete(fn); },
    emit(t, msg) { for (const fn of handlers.get(t) || []) fn({ t, ...msg }); },
    send(t, fields) {
      const msg = { ...fields, t };
      assert.equal(validateC2S(msg), null, `invalid ${t}`);
      if (link === 'down') return false;
      if (link === 'up') m.handle('p0', msg);
      return true;
    },
    request(t, fields) {
      const msg = { ...fields, t, rid: 1 };
      assert.equal(validateC2S(msg), null, `invalid ${t}`);
      if (link === 'up') return answer(msg);
      return new Promise((resolve, reject) => {
        if (link === 'down') { log.requestsWhileDown++; queued.push(() => answer(msg).then(resolve, reject)); } else lost.push(reject);
      });
    },
  };
  const { runner, frame } = runnerFor(net, () => clock);
  const deliver = () => { for (const msg of inbox.splice(0)) if (['b.start', 'b.end', 'b.pool'].includes(msg.t)) net.emit(msg.t, msg); };
  const settle = async () => { for (let i = 0; i < 30; i++) { await tick(); frame(clock); } };
  // to the first authoritative b.start of round 2 (a real board)
  let start = null;
  for (let i = 0; i < 100000 && !start; i++) {
    clock = Math.max(clock, m.sched.nextAt());
    m.pump(clock, 1);
    for (const msg of inbox.splice(0)) if (msg.t === 'b.start' && msg.authoritative && m.round >= 2) start = msg;
  }
  assert.ok(start, 'an authoritative b.start');
  net.emit('b.start', start);
  await settle();
  const x = {
    m, runner, start, log,
    get link() { return link; },
    set link(v) { link = v; },
    /** real time passes in animation frames; the server runs its timers and pushes to the runner */
    async advance(ms) {
      const end = clock + ms;
      while (clock < end) {
        clock = Math.min(end, clock + 1000 / 60);
        frame(clock);
        m.pump(clock, 1000);
        deliver();
      }
      await settle();
    },
    /** the socket comes back: the old one's pending requests fail, the new hello is welcomed, the queue goes out */
    async reconnect({ serverSees = false } = {}) {
      for (const reject of lost.splice(0)) reject(Object.assign(new Error('DISCONNECTED'), { code: 'DISCONNECTED' }));
      await settle();
      if (serverSees) m.onDisconnect('p0');
      link = 'up';
      m.onReconnect('p0');
      for (const go of queued.splice(0)) go();
      net.emit('welcome', { playerId: 'p0' });
      deliver();
      await settle();
    },
    record: () => m.replayBattles.find((b) => b.battleId === start.battleId),
    async toRecord() {
      for (let i = 0; i < 600 && !x.record(); i++) await x.advance(500);
      assert.ok(x.record(), 'the battle is archived');
      return x.record();
    },
    live: () => runner._entries.get(start.battleId).battle,
    dispose() { runner.dispose(); m.dispose(); },
  };
  return x;
}

test('an offline window the server never notices (the resumed hello replaces the session) keeps the battle\'s replay complete', { timeout: 120000 }, async () => {
  const x = await liveMatch();
  await x.advance(2500);
  x.link = 'down';
  await x.advance(1500);
  await x.reconnect();
  const record = await x.toRecord();
  assert.equal(record.source, 'client');
  assert.equal(record.complete, true, `trace tick ${record.tick} reaches the result`);
  assertReplays(record, x.live());
  x.dispose();
});

test('reports a dead socket swallowed (sent, never arrived) go out again after the heartbeat reconnects', { timeout: 120000 }, async () => {
  const x = await liveMatch();
  await x.advance(2500);
  x.link = 'lossy';
  await x.advance(3000);
  await x.reconnect();
  const record = await x.toRecord();
  assert.equal(record.source, 'client');
  assert.equal(record.complete, true);
  assertReplays(record, x.live());
  x.dispose();
});

test('a battle that ends while offline: the result waits for the next session and arrives behind the whole replay log', { timeout: 120000 }, async () => {
  const x = await liveMatch();
  // the battle's natural end (no inputs: a normal field nobody forces)
  const ref = specMod.createBattleFromSpec(x.start.spec, DS);
  while (!ref.finished) ref.step();
  const endMs = (ref.tickCount / 30 / x.start.speed) * 1000;
  await x.advance(endMs - 400);
  x.link = 'down';
  await x.advance(1500);
  assert.ok(x.live().finished, 'ended while offline');
  assert.equal(x.record(), undefined, 'the server still waits for the result');
  await x.reconnect();
  assert.equal(x.log.requestsWhileDown, 0, 'no result request is queued behind the replay log while offline');
  const record = await x.toRecord();
  assert.equal(record.source, 'client');
  assert.equal(record.complete, true);
  assertReplays(record, x.live());
  x.dispose();
});

test('the server noticed the disconnect: it took the field over and archives its own run', { timeout: 120000 }, async () => {
  const x = await liveMatch();
  await x.advance(2500);
  x.link = 'down';
  await x.advance(1500);
  await x.reconnect({ serverSees: true });
  const record = await x.toRecord();
  assert.equal(record.source, 'server');
  assert.equal(record.complete, true);
  x.dispose();
});

let bossStart = null;
/** A real b.start of a Final Assault boss field (client-side combat). */
function realBossStart() {
  if (bossStart) return bossStart;
  const h = makeMatch({ mode: 'solo', difficulty: 'FUNNY', humans: 1, seed: 7304, captureFrames: false, clientCombat: true, clients: false });
  h.autoHumans();
  h.m.start();
  h.run(() => h.ended != null || h.m.phase === PHASE.FINAL_ASSAULT, { maxSteps: 5e6 });
  assert.equal(h.m.phase, PHASE.FINAL_ASSAULT, 'the fixture reaches the boss round');
  bossStart = h.lastTo('p_0', 'b.start');
  h.m.dispose();
  assert.equal(bossStart.kind, 'boss');
  return bossStart;
}

test(`boss handover: the replica's whole replay log (more than ${REPORT_INPUTS} pool syncs) reaches the server in several reports and replaces the old authority's`, { timeout: 120000 }, async () => {
  const start = realBossStart();
  let t = 1000;
  const sent = [];
  const handlers = new Map();
  const net = {
    accountMode: true,
    on(k, fn) { if (!handlers.has(k)) handlers.set(k, new Set()); handlers.get(k).add(fn); return () => handlers.get(k).delete(fn); },
    emit(k, msg) { for (const fn of handlers.get(k) || []) fn({ t: k, ...msg }); },
    send(k, fields) { const msg = { ...fields, t: k }; assert.equal(validateC2S(msg), null, `invalid ${k}`); sent.push(msg); return true; },
    request(k, fields) { const msg = { ...fields, t: k, rid: 1 }; assert.equal(validateC2S(msg), null, `invalid ${k}`); sent.push(msg); return Promise.resolve({ t: 'ok' }); },
  };
  const { runner, frame } = runnerFor(net, () => t);
  const advance = (ms) => { const end = t + ms; while (t < end) { t = Math.min(end, t + 1000 / 60); frame(t); } };
  const settle = async () => { for (let i = 0; i < 50; i++) { await tick(); frame(t); } };
  // the partner's display replica of the pair's field follows the shared pool for 40 s (4 Hz)
  net.emit('b.start', { ...start, authoritative: false, elapsed: 0 });
  await settle();
  const live = runner._entries.get(start.battleId).battle;
  const max = live.sharedBoss.maxHp;
  let hp = max;
  for (let i = 0; i < 160; i++) {
    advance(250);
    hp = Math.max(1, hp - max * 0.001);
    net.emit('b.pool', { hp, max, teamLp: 20, acked: { [start.fieldId]: 0 } });
  }
  assert.equal(sent.length, 0, 'a replica never reports');
  // the partner left: this replica is the authority from now on; the server holds the old authority's segment
  net.emit('b.start', { ...start, authoritative: true, elapsed: 40 * start.speed });
  await settle();
  advance(2000);
  net.emit('b.end', { battleId: start.battleId, fieldId: start.fieldId, reason: 'forced' });
  await settle();
  const field = { authority: 'p_0', replayTrace: { segment: 'old-authority', seq: 40, tick: 300, inputs: [], last: null } };
  const reports = sent.filter((x) => x.replay);
  assert.ok(reports.length >= 2 && sent.filter((x) => x.t === 'b.progress').length === reports.length, 'every progress report carries its part');
  assert.ok(reports.some((x) => x.replay.inputs.length === REPORT_INPUTS), 'the backlog is split into full reports');
  for (const x of reports) assert.equal(appendReplayReport(field, 'p_0', x.replay), true, `report ${x.replay.seq} accepted`);
  assert.notEqual(field.replayTrace.segment, 'old-authority');
  assert.ok(field.replayTrace.inputs.length > REPORT_INPUTS);
  assert.equal(field.replayTrace.tick, live.tickCount, 'complete to the last tick');
  assert.equal(sent.at(-1).t, 'b.result', 'the result follows the log');
  assertReplays({ source: 'client', spec: start.spec, ...field.replayTrace }, live);
  runner.dispose();
});
