// A match a retained 外援-era engine (7a47e943 / 0e7397b2, the deployed fork before the merge of upstream 0.2.0) runs
// keeps restoring after the merged Worker saved it again: those engines checkpoint their 外援 picks (`picks`) and refuse
// a restore whose picks differ, so the Worker's own checkpoint of such a match (RoomRuntime.checkpoint,
// LobbyRuntime.checkpoint → worker/match-checkpoint.js) must carry them. Until the fix the first wake after a deploy
// restored the match, re-saved it without `picks`, and the next wake ended it as interrupted (CHECKPOINT_STATE_DIVERGED).
// The archived bytes of the engines are used, as test/worker/deployed-recovery.test.js does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { ROOT } from '../../tools/build-worker.mjs';
import { RoomRuntime } from '../../worker/room-runtime.js';
import { LobbyRuntime } from '../../worker/lobby-gateway.js';
import { checkpointMatch } from '../../worker/match-checkpoint.js';
import { RecordedMatch } from '../../server/match/checkpoint.js';
import { DATA } from '../match/harness.js';

const RNG_NAMES = ['Setup', 'Shop', 'Waves', 'Draft', 'Bots', 'Meta'];
const copy = (value) => JSON.parse(JSON.stringify(value));
/** What the deployed Worker stored: that engine's own exportMatch (view, RNG and the 外援 picks). */
const deployedCheckpoint = (match) => copy({
  ...match.recording,
  view: match.publicView(),
  rng: RNG_NAMES.map((name) => match['rng' + name].state()),
  picks: match.waiguanPicks || {},
});

for (const id of ['7a47e943ce8a7f42967f', '0e7397b20d708b7cf898']) {
  test(`a ${id.slice(0, 8)} match with 外援 picks restores again after the merged Worker re-saved it`, { timeout: 60000 }, async (t) => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'sp-retained-picks-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const archive = JSON.parse(gunzipSync(await fs.readFile(path.join(ROOT, 'replay-versions', id + '.json.gz'))));
    const file = path.join(dir, 'recovery.mjs');
    await fs.writeFile(file, archive['recovery.mjs']);
    const engine = await import(pathToFileURL(file));
    let now = 1000;
    // two humans (a timed band draft) and an AI teammate: the engine gives the bot its own 外援 picks (no human pick needed)
    const deps = {
      mode: 'coop', difficulty: 'FUNNY', roomCode: 'ABCD', seed: 17, matchNo: 1,
      clientCombat: true, botRehearsal: 0, now: () => now,
      seats: [
        { seat: 0, playerId: 'a', name: 'a', isBot: false, connected: true },
        { seat: 1, playerId: 'b', name: 'b', isBot: false, connected: true },
        { seat: 2, playerId: 'ai_0', name: 'AI', isBot: true, connected: true },
      ],
      send() { return true; }, broadcast() {}, onEnd() {},
    };
    const original = engine.create(deps);
    t.after(() => original.dispose());
    original.start();
    for (const playerId of ['a', 'b']) original.handle(playerId, { t: 'g.infoReady' });
    for (let i = 0; i < 100 && original.phase !== 'PREP'; i++) {
      now = original.sched.nextAt();
      assert.notEqual(now, null);
      original.pump(now, 1);
    }
    assert.equal(original.phase, 'PREP');
    assert.ok(Object.keys(original.waiguanPicks || {}).length > 0, 'the engine recorded 外援 picks');

    // wake 1 after the deploy: the retained engine restores the stored checkpoint
    const woken = engine.restore(deployedCheckpoint(original), deps);
    t.after(() => woken.dispose());
    // … and the merged Worker saves it again with its own checkpoint code (both runtimes)
    const resaved = [
      copy(RoomRuntime.prototype.checkpoint.call({ saved: null }, woken)),
      copy(LobbyRuntime.prototype.checkpoint.call({ savedCps: new Map() }, { code: 'ABCD' }, woken)),
    ];
    for (const checkpoint of resaved) {
      assert.deepEqual(checkpoint.picks, copy(original.waiguanPicks));
      assert.deepEqual(checkpoint, deployedCheckpoint(original), 'what the engine itself would have stored');
      // wake 2: restores again
      const again = engine.restore(checkpoint, deps);
      assert.deepEqual(again.publicView(), original.publicView());
      again.dispose();
    }
  });
}

test('a current match\'s checkpoint carries no 外援 picks (the current engine has none)', () => {
  const match = new RecordedMatch({
    mode: 'coop', difficulty: 'FUNNY', roomCode: 'ABCD', seed: 17, matchNo: 1, data: DATA, botRehearsal: 0,
    seats: [{ seat: 0, playerId: 'a', name: 'a', isBot: false, connected: true }, { seat: 1, playerId: 'ai_0', name: 'AI', isBot: true, connected: true }],
    now: () => 1000, send() { return true; }, broadcast() {}, onEnd() {},
  });
  try {
    assert.equal(match.waiguanPicks, undefined);
    assert.equal('picks' in checkpointMatch(match), false);
  } finally {
    match.dispose();
  }
});
