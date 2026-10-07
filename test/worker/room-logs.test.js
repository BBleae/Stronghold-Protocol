import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomDurableObject } from '../../worker/index.js';
import { RULES_VERSION } from '../../shared/rules-version.js';

// The room's operator log lines about its match: how long a restore took, and a match log nearing the restore limit.
// The Durable Object's methods run on a stand-in object, its storage reduced to what they touch.

// The Workers clock (Date.now) as the platform runs it: it stands still while code runs and catches up with the time
// spent at I/O (a storage sync, a timer).
function platformClock(t) {
  const clock = { cpu: 1_000_000, io: 1_000_000, work(ms) { clock.cpu += ms; }, catchUp() { clock.io = clock.cpu; } };
  t.mock.method(Date, 'now', () => clock.io);
  const setTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => setTimeout(() => { clock.catchUp(); fn(...args); }, ms));
  return clock;
}
function logged(t) {
  const lines = [];
  for (const level of ['log', 'warn', 'error']) t.mock.method(console, level, (line) => lines.push({ level, ...line }));
  return lines;
}

test('a restore logs how long its replay took, read after the replay yields to I/O', async (t) => {
  const clock = platformClock(t);
  const lines = logged(t);
  const restore = (replay) => RoomDurableObject.prototype.restoreMatch.call({
    ctx: { storage: { get: async () => undefined, put: async () => clock.work(2), sync: async () => clock.catchUp() } },
    runtime: { code: 'ABCD', restoreMatch: replay, interruptMatch() {} },
    matchLog: () => [],
    interruptMatch: RoomDurableObject.prototype.interruptMatch,
  }, { rulesVersion: RULES_VERSION, eventCount: 3 });
  await restore(() => clock.work(1234));
  assert.deepEqual(lines, [{ level: 'log', event: 'match_restored', room: 'ABCD', rulesVersion: RULES_VERSION, events: 3,
    attempts: 1, ms: 1234 }]);
  // A replay that throws is timed as well.
  lines.length = 0;
  await restore(() => {
    clock.work(4321);
    throw new Error('CHECKPOINT_STATE_DIVERGED');
  });
  assert.deepEqual(lines.map(({ level, event, ms, error }) => ({ level, event, ms, error: error.message })),
    [{ level: 'error', event: 'match_restore_failed', ms: 4321, error: 'CHECKPOINT_STATE_DIVERGED' }]);
});

test('a match log passing 150 000 events warns once per match, before the 200 000 limit', async (t) => {
  const lines = logged(t);
  const log = { matchNo: 1, events: [] };
  const room = {
    runtime: { code: 'ABCD', generation: 'generation-a',
      snapshot: () => ({ matchCheckpoint: { rulesVersion: RULES_VERSION, options: { matchNo: log.matchNo }, events: log.events } }) },
    savedLog: null, savedState: null, parts: 0, storedAttempts: 0, loading: false, outboxSize: 0,
    ctx: { storage: { sql: { exec() {} }, transaction: async (fn) => fn({ put: async () => {}, delete: async () => {} }) } },
  };
  const warnings = () => lines.filter((x) => x.event === 'match_log_large');
  // The log grows by n events, and the room saves: the warnings so far.
  const grow = async (n, on = room) => {
    for (let i = 0; i < n; i++) log.events.push({ t: 'timer' });
    await RoomDurableObject.prototype.save.call(on, []);
    return warnings().length;
  };
  assert.equal(await grow(150_000), 0, 'at the mark');
  assert.equal(await grow(1), 1, 'past it');
  assert.deepEqual(warnings()[0], { level: 'warn', event: 'match_log_large', room: 'ABCD', log: 'generation-a:1',
    rulesVersion: RULES_VERSION, events: 150_001, limit: 200_000 });
  assert.equal(await grow(10_000), 1, 'once per match');
  // A room restored from storage goes on from its stored log (RoomDurableObject.load): it warned before.
  const restored = { ...room, savedLog: { id: 'generation-a:1', count: log.events.length }, savedState: null };
  assert.equal(await grow(10, restored), 1);
  // The next match warns again, here in the save that stores its whole log past the mark.
  log.matchNo = 2;
  assert.equal(await grow(0), 2);
  assert.equal(warnings()[1].log, 'generation-a:2');
});
