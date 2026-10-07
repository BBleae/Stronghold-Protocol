import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { bundleWorker, ROOT } from '../../tools/build-worker.mjs';
import { retainedRecovery } from '../../tools/build-replay.mjs';

// Use the actual deployed bytes: rebuilding today's sources with an old id cannot detect a broken old-engine wrapper.
const DEPLOYED = '7a47e943ce8a7f42967f';
const NEXT = '22222222222222222222';
const RNG_NAMES = ['Setup', 'Shop', 'Waves', 'Draft', 'Bots', 'Meta'];
const copy = (value) => JSON.parse(JSON.stringify(value));
const checkpointOf = (match) => copy({
  ...match.recording,
  view: match.publicView(),
  rng: RNG_NAMES.map((name) => match['rng' + name].state()),
  picks: match.waiguanPicks || {},
});
const timersOf = (match) => match.sched._q.filter((timer) => !timer.cancelled)
  .map(({ id, at, seq, every }) => ({ id, at, seq, every }));

test('deployed 7a47 recovery retains its pending timers, RNG and private state across a newer Worker build',
  { timeout: 60000 }, async (t) => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'sp-deployed-recovery-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'replay-versions.json'), 'utf8'));
    const index = manifest.entries.findIndex((entry) => entry.id === DEPLOYED);
    assert.ok(index >= 0, 'the deployed rules remain archived');
    const deployed = manifest.entries[index];
    const archive = JSON.parse(gunzipSync(await fs.readFile(path.join(ROOT, 'replay-versions', DEPLOYED + '.json.gz'))));
    for (const name of ['engine.js', 'recovery.mjs']) {
      assert.equal(createHash('sha256').update(archive[name]).digest('hex'), deployed.hashes[name],
        `the committed ${name} has not changed`);
    }
    // The next release after this deployment must retain its engine; later releases may age it out normally.
    assert.ok(retainedRecovery([...manifest.entries.slice(0, index + 1), { id: NEXT }], NEXT)
      .some((entry) => entry.id === DEPLOYED));
    const oldFile = path.join(dir, 'deployed.mjs');
    await fs.writeFile(oldFile, archive['recovery.mjs']);
    const oldEngine = await import(pathToFileURL(oldFile));
    let now = 1000;
    const deps = {
      mode: 'coop', difficulty: 'FUNNY', roomCode: 'ABCD', seed: 17, matchNo: 1,
      clientCombat: true, botRehearsal: 0, now: () => now,
      seats: ['a', 'b'].map((playerId, seat) => ({ seat, playerId, name: playerId, isBot: false, connected: true })),
      send() { return true; }, broadcast() {}, onEnd() {},
    };
    const original = oldEngine.create(deps);
    t.after(() => original.dispose());
    original.start();
    for (const playerId of ['a', 'b']) original.handle(playerId, { t: 'g.infoReady' });
    // Let the recorded draft timers choose the bands and deal the first shops. No battles are simulated here.
    for (let i = 0; i < 100 && original.phase !== 'PREP'; i++) {
      now = original.sched.nextAt();
      assert.notEqual(now, null);
      original.pump(now, 1);
    }
    assert.equal(original.phase, 'PREP');
    const checkpoint = checkpointOf(original);
    const checkpointJson = JSON.stringify(checkpoint);
    assert.equal(checkpoint.rulesVersion, DEPLOYED);
    assert.ok(checkpoint.events.some((event) => event.kind === 'timer'));
    assert.ok(timersOf(original).length > 0);

    const entry = path.join(dir, 'fixture.js');
    await fs.writeFile(entry,
      `export {retainedMatchVersions,prepareMatchVersion} from ${JSON.stringify(path.join(ROOT, 'worker/match-versions.js'))};`
      + `export {knownRulesVersion} from ${JSON.stringify(path.join(ROOT, 'worker/do-storage.js'))};`
      + `export {restoreMatch} from ${JSON.stringify(path.join(ROOT, 'server/match/checkpoint.js'))};`);
    const outfile = path.join(dir, 'next.mjs');
    await bundleWorker({ entry: path.relative(ROOT, entry), outfile, rulesVersion: NEXT,
      versionModules: [{ id: DEPLOYED, file: oldFile }] });
    const release = await import(pathToFileURL(outfile));
    assert.equal(release.knownRulesVersion(DEPLOYED), true);
    assert.throws(() => release.restoreMatch(checkpoint, deps), /CHECKPOINT_VERSION/);
    assert.throws(() => release.retainedMatchVersions[DEPLOYED](checkpoint, deps), /not prepared/);
    await release.prepareMatchVersion(DEPLOYED);
    const emitted = [];
    const recovered = release.retainedMatchVersions[DEPLOYED](checkpoint, {
      ...deps, data: { config: {}, chess: {} },
      send: (...args) => { emitted.push(args); return true; }, broadcast: (msg) => emitted.push(msg),
    });
    t.after(() => recovered.dispose());
    assert.deepEqual(emitted, [], 'restoring does not repeat historical output');
    const compare = () => {
      assert.deepEqual(checkpointOf(recovered), checkpointOf(original));
      assert.deepEqual(timersOf(recovered), timersOf(original));
      for (const id of ['a', 'b']) assert.deepEqual(recovered.players.get(id).privateView(), original.players.get(id).privateView());
      assert.deepEqual(recovered.sched.errors, []);
    };
    compare();
    // Lobby.startMatch calls start after construction; a restored match must not start a second time.
    recovered.start();
    compare();
    const before = original.rngShop.state();
    now += 1;
    assert.deepEqual(recovered.handle('a', { t: 'g.refresh' }), original.handle('a', { t: 'g.refresh' }));
    assert.notEqual(original.rngShop.state(), before, 'continuation consumes the shop RNG');
    compare();
    now = original.sched.nextAt();
    assert.notEqual(now, null);
    assert.equal(recovered.pump(now, 1), original.pump(now, 1));
    compare();
    assert.equal(JSON.stringify(checkpoint), checkpointJson, 'restoration leaves its input intact');
  });
