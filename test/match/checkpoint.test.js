import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordedMatch, exportMatch, restoreMatch, CHECKPOINT_EVENT_LIMIT } from '../../server/match/checkpoint.js';
import { DATA } from './harness.js';
import { decodeReplayFrame } from '../../shared/replay-frames.js';
import { encodeReplayChunks } from '../../shared/replay-codec.js';
import { createBattleFromSpec, resultDigest } from '../../server/sim/spec.js';
const opts = (extra = {}) => ({
  mode: 'coop',
  difficulty: 'FUNNY',
  roomCode: 'ABCD',
  seed: 17,
  matchNo: 1,
  data: DATA,
  seats: [
    { seat: 0, playerId: 'p0', name: 'Alice', isBot: false, connected: true },
    { seat: 1, playerId: 'p1', name: 'Bob', isBot: false, connected: true },
  ],
  now: () => 1000,
  send() {
    return true;
  },
  broadcast() {},
  onEnd() {},
  botRehearsal: 0,
  ...extra,
});

test(
  'server battles replay exactly: shared-pool fields as frames, every other one from its spec',
  { timeout: 120000 },
  async () => {
    const data = structuredClone(DATA);
    for (const band of Object.values(data.bands || {})) band.totalHp = 10000;
    for (const boss of Object.values(data.bosses || {}))
      for (const key of Object.keys(boss.bloodPoint || {})) boss.bloodPoint[key] = 1;
    data.config.hiddenCore = { single: -1, multi: -1, minTeamLpExclusive: -1, difficulties: ['NORMAL'] };
    let clock = 1000;
    const deps = opts({ data, difficulty: 'NORMAL', now: () => clock, clientCombat: true });
    const rawFrames = new Map();
    const m = new RecordedMatch({
      ...deps,
      observeReplayFrame: ({ battleId, ...frame }) => {
        if (!rawFrames.has(battleId)) rawFrames.set(battleId, []);
        rawFrames.get(battleId).push(frame);
      },
    });
    m.start();
    for (const id of ['p0', 'p1']) {
      m.handle(id, { t: 'g.autoplay', on: true });
      m.handle(id, { t: 'g.infoReady' });
      m.onDisconnect(id);
    }
    for (let i = 0; i < 100000 && !m.ended; i++) {
      clock = m.sched.nextAt();
      assert.notEqual(clock, null);
      m.pump(clock, 10);
    }
    assert.ok(m.ended);
    assert.equal(m.errorCount, 0);
    assert.ok(m.hiddenReached, 'fixture must reach hidden core');
    for (const round of [m.gd.bossRound, m.gd.hiddenRound]) {
      const fields = m.replayBattles.filter((b) => b.round === round);
      assert.ok(fields.length > 0, `round ${round} must be recorded`);
      for (const b of fields) {
        assert.equal(b.source, 'server');
        assert.equal(b.complete, true);
        assert.ok(b.frames.length > 1);
        assert.ok(b.result);
      }
    }
    // a battle without frames is deterministic from its spec: the replay engine re-simulates it to the same end
    const specBattles = m.replayBattles.filter((b) => !b.frames);
    assert.ok(specBattles.length > 0, 'normal and unite fields run on the server here');
    for (const b of specBattles) {
      assert.equal(b.source, 'server');
      const battle = createBattleFromSpec(b.spec, m.ds);
      let cursor = 0;
      const apply = () => {
        while (cursor < b.inputs.length && b.inputs[cursor].tick <= battle.tickCount) {
          const x = b.inputs[cursor++];
          if (x.kind === 'end') battle.forceEnd(x.reason);
        }
      };
      while (battle.tickCount < b.tick && !battle.finished) {
        apply();
        battle.step();
      }
      apply();
      assert.equal(battle.tickCount, b.tick);
      assert.equal(!!battle.finished, b.complete);
      assert.equal(
        resultDigest(battle.result()).hash,
        resultDigest(b.result).hash,
        b.battleId + ' re-simulates to the live result',
      );
    }
    let totalFrames = 0;
    const uncompressedBattles = m.replayBattles.map((b) => {
      if (!b.frames) return b;
      let prior = null;
      const originals = rawFrames.get(b.battleId);
      assert.equal(b.frames.length, originals.length);
      for (let i = 0; i < b.frames.length; i++) {
        const f = b.frames[i];
        prior = decodeReplayFrame(prior, f);
        assert.deepEqual({ tick: f.tick, snapshot: prior, events: f.events }, originals[i]);
        totalFrames++;
      }
      const { frameEncoding, ...old } = b;
      return { ...old, frames: originals };
    });
    const wrap = (battles) => JSON.stringify({ schemaVersion: 1, rulesVersion: m.recording.rulesVersion, battles });
    const raw = wrap(uncompressedBattles),
      delta = wrap(m.replayBattles);
    const gzip = await encodeReplayChunks(raw),
      both = await encodeReplayChunks(delta);
    const size = (x) => Buffer.byteLength(x),
      stored = (x) => x.chunks.reduce((n, c) => n + c.text.length, 0);
    const metrics = {
      battles: m.replayBattles.length,
      frames: totalFrames,
      rawBytes: size(raw),
      gzipBase64Bytes: stored(gzip),
      deltaBytes: size(delta),
      deltaGzipBase64Bytes: stored(both),
    };
    console.log('replay compression full match', JSON.stringify(metrics));
    // a whole match's replay is small: specs plus the shared-pool fields' frames (it was megabytes of frames per match)
    assert.ok(metrics.rawBytes < 1024 * 1024, 'replay of a full match stays under 1 MB');
    const start = performance.now();
    const restored = restoreMatch(exportMatch(m), deps);
    console.log(
      'full final/hidden recovery ms',
      Math.round(performance.now() - start),
      'events',
      m.recording.events.length,
    );
    assert.deepEqual(restored.replayBattles, m.replayBattles);
    m.dispose();
    restored.dispose();
  },
);
test('executable checkpoints reconstruct timers, RNG, players and subsequent actions without emitting old frames', () => {
  let now = 1000;
  const m = new RecordedMatch(opts({ now: () => now }));
  m.start();
  m.handle('p0', { t: 'g.infoReady' });
  m.handle('p1', { t: 'g.infoReady' });
  m.pump(1000);
  const checkpoint = JSON.parse(JSON.stringify(exportMatch(m)));
  const emitted = [];
  const restored = restoreMatch(
    checkpoint,
    opts({ now: () => now, send: (...x) => emitted.push(x), broadcast: (x) => emitted.push(x) }),
  );
  assert.equal(emitted.length, 0);
  assert.deepEqual(restored.publicView(), m.publicView());
  assert.equal(restored.rngDraft.state(), m.rngDraft.state());
  now += 20000;
  m.pump(now);
  restored.pump(now);
  assert.deepEqual(restored.publicView(), m.publicView());
  m.onDisconnect('p0');
  restored.onDisconnect('p0');
  m.onReconnect('p0');
  restored.onReconnect('p0');
  assert.deepEqual(exportMatch(restored), exportMatch(m));
  m.dispose();
  restored.dispose();
});
test('checkpoints reject corrupted input and unknown versions without modifying the record', () => {
  const m = new RecordedMatch(opts());
  m.start();
  const c = exportMatch(m),
    bad = structuredClone(c);
  bad.schemaVersion = 999;
  assert.throws(() => restoreMatch(bad, opts()), /VERSION/);
  assert.equal(bad.schemaVersion, 999);
  const divergent = structuredClone(c);
  divergent.events[0].kind = 'unknown';
  assert.throws(() => restoreMatch(divergent, opts()), /EVENT/);
  // a log past the limit is refused before any replay (its events would not even parse); worker/index.js warns
  // (match_log_large) while a running match's log is still well short of it
  assert.equal(CHECKPOINT_EVENT_LIMIT, 200000);
  const long = { ...c, events: new Array(CHECKPOINT_EVENT_LIMIT + 1).fill(null) };
  assert.throws(() => restoreMatch(long, opts()), /^Error: CHECKPOINT_EVENT_LIMIT$/);
  m.dispose();
});
test('a recorded full cooperative match reconstructs combat and final result', { timeout: 120000 }, () => {
  const data = structuredClone(DATA);
  for (const band of Object.values(data.bands || {})) band.totalHp = 1000;
  let clock = 1000;
  const deps = opts({ data, now: () => clock, clientCombat: false, botRehearsal: 0 });
  const m = new RecordedMatch(deps);
  m.start();
  for (const id of ['p0', 'p1']) {
    m.handle(id, { t: 'g.autoplay', on: true });
    m.handle(id, { t: 'g.infoReady' });
  }
  const seen = new Set();
  for (let n = 0; n < 100000 && !m.ended; n++) {
    const at = m.sched.nextAt();
    assert.notEqual(at, null, 'game must keep progressing');
    clock = Math.max(clock, at);
    m.pump(clock, 10);
    if (!seen.has(m.phase)) {
      seen.add(m.phase);
      const restored = restoreMatch(exportMatch(m), deps);
      assert.deepEqual(restored.publicView(), m.publicView(), m.phase);
      restored.dispose();
    }
  }
  assert.ok(m.ended);
  assert.ok(seen.has('COMBAT'));
  const restored = restoreMatch(exportMatch(m), deps);
  assert.deepEqual(restored.lastResultMsg, m.lastResultMsg);
  assert.equal(m.errorCount, 0);
  console.log('checkpoint phases', [...seen].join(','), 'events', m.recording.events.length);
  m.dispose();
  restored.dispose();
});

test('server-taken client battles keep an exact spec replay through recovery', { timeout: 120000 }, () => {
  let clock = 1000;
  const deps = opts({ now: () => clock, clientCombat: true });
  const m = new RecordedMatch(deps);
  m.start();
  for (const id of ['p0', 'p1']) {
    m.handle(id, { t: 'g.autoplay', on: true });
    m.handle(id, { t: 'g.infoReady' });
  }
  for (let i = 0; i < 30000 && m.replayBattles.length === 0; i++) {
    clock = m.sched.nextAt();
    assert.notEqual(clock, null);
    m.pump(clock, 10);
  }
  assert.ok(m.replayBattles.length > 0);
  const replay = m.replayBattles[0];
  assert.equal(replay.source, 'server');
  assert.equal(replay.complete, true);
  assert.equal(replay.frames, undefined, 'a normal field replays from its spec');
  assert.ok(replay.tick > 0);
  assert.ok(replay.spec);
  const restored = restoreMatch(exportMatch(m), deps);
  assert.deepEqual(restored.replayBattles, m.replayBattles);
  assert.ok(Object.values(m.usedOperators).some((ids) => ids.length));
  m.dispose();
  restored.dispose();
});
