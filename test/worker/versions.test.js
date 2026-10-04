import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { bundleWorker,ROOT } from '../../tools/build-worker.mjs';
import { exportMatch } from '../../server/match/checkpoint.js';
import { buildReplayVersions, retainedRecovery, PLACEHOLDER } from '../../tools/build-replay.mjs';

test('rules versions are the engines\' content, minted only by a release and refused unarchived in CI', async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'sp-versions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of ['worker', 'data']) await fs.mkdir(path.join(root, dir));
  const write = (name, text) => fs.writeFile(path.join(root, name), text);
  // stub bundler: an engine is its entry's source plus its rules version, embedded like a real bundle embeds it
  const bundle = async ({ root: from, outfile, entry, rulesVersion }) =>
    fs.writeFile(outfile, `${await fs.readFile(path.join(from, entry), 'utf8')}\nexport const rulesVersion = ${JSON.stringify(rulesVersion)};`);
  await write('worker/replay-engine.js', 'replay 1');
  await write('worker/recovery-engine.js', 'recovery 1');

  const dev = await buildReplayVersions({ root, bundle, ci: false });
  assert.equal(dev.archived, false);
  await assert.rejects(fs.access(path.join(root, 'replay-versions.json')), 'a development build never writes the committed manifest');
  await assert.rejects(buildReplayVersions({ root, bundle, ci: true }), /not archived/);

  const first = await buildReplayVersions({ root, bundle, mint: true, ci: false });
  assert.equal(first.current, dev.current, 'the same sources give the same id');
  assert.equal(first.minted, true);
  const engine = await fs.readFile(path.join(root, '.replay-engines', first.current, 'engine.js'), 'utf8');
  assert.ok(engine.includes(first.current) && !engine.includes(PLACEHOLDER), 'the archived engine carries its own id');

  // what the engines do not contain never mints: docs, git-ignored per-machine files, build plumbing
  await write('README.md', 'docs');
  await write('data/local-assets.json', '{"count":1475}');
  const again = await buildReplayVersions({ root, bundle, ci: true });
  assert.deepEqual([again.current, again.archived, again.minted], [first.current, true, false]);

  await write('worker/recovery-engine.js', 'recovery 2');
  const second = await buildReplayVersions({ root, bundle, mint: true, ci: false });
  assert.notEqual(second.current, first.current);
  assert.deepEqual(second.entries.map((e) => e.id), [first.current, second.current]);
  assert.deepEqual(retainedRecovery(second.entries, second.current).map((e) => e.id), [first.current]);

  await fs.writeFile(path.join(root, 'replay-versions', first.current + '.json.gz'), 'broken');
  await assert.rejects(buildReplayVersions({ root, bundle, ci: false }), 'archives are immutable');
});

test('a Worker keeps the recovery engines of the newest older versions only', () => {
  const entries = ['v1', 'v2', 'v3', 'v4', 'v5'].map((id) => ({ id }));
  assert.deepEqual(retainedRecovery(entries, 'v5', 3).map((e) => e.id), ['v2', 'v3', 'v4']);
  // a revert to older sources is that older version again, and still restores the newer versions' matches
  assert.deepEqual(retainedRecovery(entries, 'v2', 3).map((e) => e.id), ['v3', 'v4', 'v5']);
});
test('a new release retains executable old recovery and isolated old replay data', {timeout:60000},async t=>{
  const dir=await fs.mkdtemp(path.join(tmpdir(),'sp-versions-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const old='11111111111111111111',current='22222222222222222222',file=path.join(dir,'old.mjs');
  await bundleWorker({entry:'worker/recovery-engine.js',outfile:file,rulesVersion:old});
  const oldEngine=await import(pathToFileURL(file));
  const deps={mode:'solo',difficulty:'FUNNY',roomCode:'ABCD',seed:5,matchNo:1,now:()=>1000,
    seats:[{seat:0,playerId:'a',name:'Alice',isBot:false,connected:true}],send(){},broadcast(){},onEnd(){}};
  const match=oldEngine.create(deps);match.start();const checkpoint=exportMatch(match);assert.equal(checkpoint.rulesVersion,old);
  const entry=path.join(dir,'fixture.js');
  await fs.writeFile(entry,`export {retainedMatchVersions,prepareMatchVersion} from ${JSON.stringify(path.join(ROOT,'worker/match-versions.js'))}; export {restoreMatch} from ${JSON.stringify(path.join(ROOT,'server/match/checkpoint.js'))};`);
  const newer=path.join(dir,'new.mjs');
  await bundleWorker({entry:path.relative(ROOT,entry),outfile:newer,rulesVersion:current,versionModules:[{id:old,file}]});
  const release=await import(pathToFileURL(newer));
  assert.throws(()=>release.restoreMatch(checkpoint,deps),/CHECKPOINT_VERSION/);
  assert.throws(()=>release.retainedMatchVersions[old](checkpoint,deps),/not prepared/);
  await release.prepareMatchVersion(old);
  const recovered=release.retainedMatchVersions[old](checkpoint,{...deps,data:{config:{},chess:{}}});
  assert.deepEqual(recovered.publicView(),match.publicView(),'old recovery ignores changed current data');
  const replayFile=path.join(dir,'replay.mjs');await bundleWorker({entry:'worker/replay-engine.js',outfile:replayFile,rulesVersion:old});
  const replay=await import(pathToFileURL(replayFile));await replay.ready();assert.equal(replay.rulesVersion,old);
  // the engine also runs live battles of its version (battle/runner.js loadEngineSim)
  for(const name of ['createBattleFromSpec','battleProgress','compactResult','fitResult','uniteLeft','attachLpMeter'])assert.equal(typeof replay.spec[name],'function',name);
  assert.ok(replay.dataSource());
  const stageId=Object.keys(match.data.stages)[0];assert.deepEqual(replay.stage(stageId),match.data.stages[stageId]);
  recovered.dispose();match.dispose();
});
