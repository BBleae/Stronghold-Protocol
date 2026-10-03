import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { bundleWorker,ROOT } from '../../tools/build-worker.mjs';
import { exportMatch } from '../../server/match/checkpoint.js';
import {buildReplayVersions} from '../../tools/build-replay.mjs';

test('rules versions survive CRLF checkout normalization and retain older artifacts',async t=>{
  const root=await fs.mkdtemp(path.join(tmpdir(),'sp-version-lines-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const dir of ['server','shared','data','worker','tools'])await fs.mkdir(path.join(root,dir));
  const names=['server/game.js','shared/example.js','data/example.json','worker/replay-engine.js','worker/recovery-engine.js','worker/data-loader.js','worker/sim-data-loader.js','tools/build-worker.mjs','tools/build-replay.mjs'];
  for(const name of names)await fs.writeFile(path.join(root,name),'first\r\nsecond\r\n');
  const bundle=async({outfile,rulesVersion})=>fs.writeFile(outfile,'export const version='+JSON.stringify(rulesVersion));
  const a=await buildReplayVersions({root,bundle});
  for(const name of names)await fs.writeFile(path.join(root,name),'first\nsecond\n');
  const b=await buildReplayVersions({root,bundle});assert.equal(a.current,b.current);assert.equal(b.entries.length,1);
  await fs.writeFile(path.join(root,'server/game.js'),'changed\n');
  const c=await buildReplayVersions({root,bundle});assert.notEqual(c.current,b.current);assert.equal(c.entries.length,2);
  await fs.writeFile(path.join(root,'replay-versions',a.current+'.json.gz'),'broken');
  await assert.rejects(buildReplayVersions({root,bundle}));
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
  await fs.writeFile(entry,`export {retainedMatchVersions} from ${JSON.stringify(path.join(ROOT,'worker/match-versions.js'))}; export {restoreMatch} from ${JSON.stringify(path.join(ROOT,'server/match/checkpoint.js'))};`);
  const newer=path.join(dir,'new.mjs');
  await bundleWorker({entry:path.relative(ROOT,entry),outfile:newer,rulesVersion:current,versionModules:[{id:old,file}]});
  const release=await import(pathToFileURL(newer));
  assert.throws(()=>release.restoreMatch(checkpoint,deps),/CHECKPOINT_VERSION/);
  const recovered=release.retainedMatchVersions[old](checkpoint,{...deps,data:{config:{},chess:{}}});
  assert.deepEqual(recovered.publicView(),match.publicView(),'old recovery ignores changed current data');
  const replayFile=path.join(dir,'replay.mjs');await bundleWorker({entry:'worker/replay-engine.js',outfile:replayFile,rulesVersion:old});
  const replay=await import(pathToFileURL(replayFile));await replay.ready();assert.equal(replay.rulesVersion,old);
  const stageId=Object.keys(match.data.stages)[0];assert.deepEqual(replay.stage(stageId),match.data.stages[stageId]);
  recovered.dispose();match.dispose();
});
