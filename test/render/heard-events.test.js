// What the battle sound hears of the drawn events (render/app.js heardEvents → the view's 'battleEvents' →
// screens/game.js → audio.handleBattleEvents). A field entered mid-battle replays its early buffer (screens/game.js
// keepEarly: spawns, deaths, deploys, statuses, skills, leaks, lasting fx) stamped with the entry snapshot's game time:
// the render clock starts at that snapshot, so the stamp alone made every replayed tuple look fresh and the sound played
// them — a teammate's field shown again after the runner's catch-up (battle/runner.js CATCHUP_TICKS) replayed the
// deaths, deploys and the 漏怪 alarm (audio.sfx.battle.leak, upstream #134) of the seconds it had skipped. The replay is
// now pushed `quiet`: drawn like any frame, heard only for its spawns (the sound's unit map) — upstream hands audio only
// that buffer's spawns as well.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnapshotBuffer } from '../../public/js/render/interp.js';
import { heardEvents, HEARD_LAG, LOOK_AHEAD } from '../../public/js/render/app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const code = (p) => readFileSync(path.join(ROOT, p), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const snap = (t, units) => ({ fieldId: 'n:1', t, units, dp: 10, killed: 0, total: 5 });
const U = (id, x, y) => [id, x, y, 100, 100, 5, 10, 0, 0];
const kinds = (evs) => evs.map((e) => e[0]);

test('heardEvents: a spawn always; anything else when drawn on time and not pushed quiet', () => {
  const spawn = ['spawn', { id: 1 }], die = ['die', 2, 'killed'], leak = ['leak', 3], deploy = ['deploy', 4];
  const evs = [spawn, die, leak, deploy];
  assert.equal(HEARD_LAG, 0.6);
  assert.deepEqual(kinds(heardEvents(evs, [10, 10, 10, 10], 10)), ['spawn', 'die', 'leak', 'deploy'], 'fresh: all heard');
  assert.deepEqual(kinds(heardEvents(evs, [8, 8, 9.4, 9.39], 10)), ['spawn', 'leak'], 'stale (> 0.6 game s behind): silent, the spawn passes');
  const quiet = new WeakSet([spawn, die, leak]);
  assert.deepEqual(kinds(heardEvents(evs, [10, 10, 10, 10], 10, quiet)), ['spawn', 'deploy'], 'quiet: silent however fresh, the spawn passes');
  const out = ['stale'];
  assert.equal(heardEvents(evs, [10, 10, 10, 10], 10, null, out), out, 'fills the given list');
  assert.deepEqual(kinds(out), ['spawn', 'die', 'leak', 'deploy']);
});

test('a field entered mid-battle: the replayed early buffer is drawn, but only its spawns are heard; the frames after it are', () => {
  // the order of screens/game.js's enter effect: view.pushEvents({ ev: early, gt: earlySnap.gt, quiet: true }), then
  // view.pushSnapshot(earlySnap) — the first snapshot starts the render clock at its own game time
  const early = [['spawn', { id: 1 }], ['die', 7, 'killed'], ['leak', 8], ['deploy', 2], ['status', 1, 'ab:exposed', 1]];
  const b = new SnapshotBuffer({ lookAhead: LOOK_AHEAD, rate: 2 });
  b.pushEvents(early, 0, 85.1);
  b.push(snap(85.1, [U(1, 5, 10)]), 0.01);
  const renderT = b.update(0.02);
  assert.ok(renderT >= 85.1, 'the clock starts at the entry snapshot');
  const EVS = [], EVT = [];
  b.takeEvents(renderT, EVS, renderT - 1.5, EVT, new Map());
  assert.deepEqual(kinds(EVS), ['spawn', 'die', 'leak', 'deploy', 'status'], 'every replayed tuple is drawn at once');
  assert.deepEqual(kinds(heardEvents(EVS, EVT, renderT)), ['spawn', 'die', 'leak', 'deploy', 'status'],
    'by the stamp alone they look fresh (the old behaviour: the 漏怪 alarm of a skipped span played on entry)');
  const quiet = new WeakSet(early);
  assert.deepEqual(kinds(heardEvents(EVS, EVT, renderT, quiet)), ['spawn'], 'pushed quiet: only the spawn reaches the sound');
  // a live frame after the entry is heard as usual
  const live = [['leak', 9], ['die', 10, 'killed']];
  b.pushEvents(live, 0.05, 85.2);
  b.push(snap(85.2, [U(1, 5, 10)]), 0.06);
  const EVS2 = [], EVT2 = [];
  b.takeEvents(85.3, EVS2, 85.3 - 1.5, EVT2, new Map());
  assert.deepEqual(kinds(heardEvents(EVS2, EVT2, 85.3, quiet)), ['leak', 'die']);
});

test('wiring: game.js pushes the early buffer quiet; app.js marks quiet tuples and hears through heardEvents', () => {
  const game = code('public/js/screens/game.js');
  // the sound takes the buffer through audio.replayEarly: its spawns, and the voice's 行动出发 of an initial deployment —
  // no sound effect (test/ui/audio.test.js)
  assert.match(game, /view\.pushEvents\(\{ ev: early, gt: earlySnap\?\.gt, quiet: true \}\);\s*audio\.replayEarly\(early\);/);
  assert.match(game, /view\.on\('battleEvents', \(evs\) => audio\.handleBattleEvents\(evs\)\)/, 'the sound hears the view');
  // the DOM fallback (no render clock) hears the frames as they come: a runner hand-over batch (a catch-up frame, the
  // hidden-tab backlog — test/match/runner-unseen.test.js) only for its spawns, so no late 作战中 / 部署 voice
  assert.match(game, /if \(!engine\) audio\.handleBattleEvents\(msg\.handOver \? msg\.ev\.filter\(\(x\) => Array\.isArray\(x\) && x\[0\] === 'spawn'\) : msg\.ev\);/);
  assert.doesNotMatch(game, /if \(!engine\) audio\.handleBattleEvents\(msg\.ev\);/);
  const app = code('public/js/render/app.js');
  assert.match(app, /const quietEv = new WeakSet\(\);/);
  assert.match(app, /if \(ev\.quiet === true && Array\.isArray\(list\)\) for \(const e of list\) if \(Array\.isArray\(e\)\) quietEv\.add\(e\);/);
  assert.match(app, /heardEvents\(EVS, EVT, renderT, quietEv, HEARD\);\s*if \(HEARD\.length\) emit\('battleEvents', HEARD\.slice\(\)\);/);
  assert.doesNotMatch(app, /EVT\[i\] >= renderT - 0\.6/, 'one rule, in heardEvents');
});
