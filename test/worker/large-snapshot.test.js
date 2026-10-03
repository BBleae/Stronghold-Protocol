import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {bundleWorker} from '../../tools/build-worker.mjs';
import {createAccountHarness} from './helpers/account-harness.js';

test('real RoomDO batches large outbox snapshots, restarts, and removes excess keys atomically',{timeout:60000},async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'sp-large-room-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'worker.mjs');await bundleWorker({outfile:file});
  const h=await createAccountHarness(`
    import {RoomDurableObject} from ${JSON.stringify(file.replaceAll('\\','/'))};
    export class TestObject extends RoomDurableObject {
      async fetch(req){await this.ready;const i=await req.json();
        if(i.size!==undefined){this.runtime.archiveOutbox=[{facts:{matchId:'fixture'},replay:{text:'数据'.repeat(i.size)}}];await this.persist();}
        return Response.json({size:this.runtime.archiveOutbox[0]?.replay.text.length,
          parts:this.parts,keys:(await this.ctx.storage.list({prefix:'snapshot-'})).size});
      }
    }
    export default {fetch(req,env){return env.TEST.get(env.TEST.idFromName('large')).fetch(req);}};
  `);t.after(()=>h.dispose());
  const large=await h.fetch({size:4500000});assert.equal(large.status,200,await large.clone().text());
  const before=await large.json();assert.ok(before.parts>128);assert.equal(before.size,9000000);
  await h.restart();assert.deepEqual(await (await h.fetch({})).json(),before);
  const small=await (await h.fetch({size:10})).json();assert.equal(small.parts,1);assert.equal(small.keys,2);
  await h.restart();assert.deepEqual(await (await h.fetch({})).json(),small);
});
