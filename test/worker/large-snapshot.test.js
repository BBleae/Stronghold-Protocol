import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {bundleWorker} from '../../tools/build-worker.mjs';
import {createAccountHarness} from './helpers/account-harness.js';

test('real RoomDO stores a large snapshot in parts and a finished match archive outside the snapshot',{timeout:60000},async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'sp-large-room-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'worker.mjs');await bundleWorker({outfile:file});
  const h=await createAccountHarness(`
    import {RoomDurableObject} from ${JSON.stringify(file.replaceAll('\\','/'))};
    export class TestObject extends RoomDurableObject {
      async fetch(req){
        await this.ready;const i=await req.json(),rt=this.runtime;
        // Any part of the room state may be large; a resume ticket carries the payload here.
        if(i.size!==undefined)await this.event(()=>{
          if(!rt.code)rt.reserve('ABCD','alice');
          rt.resumeTickets.set('pad',{accountId:'alice',expiresAt:Date.now()+3600000,pad:'数据'.repeat(i.size)});
        });
        if(i.archive!==undefined)await this.event(()=>{rt.archiveOutbox.push({archiveEncoding:2,facts:{matchId:'fixture'},personal:[],
          replay:{schemaVersion:1,rulesVersion:'v1',battles:[{text:'回放'.repeat(i.archive)}]}});});
        const sql=this.ctx.storage.sql;
        const outbox=sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='archive_outbox'").one().n
          ?{entries:sql.exec('SELECT COUNT(*) AS n FROM archive_outbox').one().n,chunks:sql.exec('SELECT COUNT(*) AS n FROM archive_chunks').one().n}:null;
        return Response.json({size:rt.resumeTickets.get('pad')?.pad.length,parts:this.parts,
          keys:(await this.ctx.storage.list({prefix:'snapshot-'})).size,outbox});
      }
    }
    export default {fetch(req,env){return env.TEST.get(env.TEST.idFromName('large')).fetch(req);}};
  `);t.after(()=>h.dispose());
  const large=await h.fetch({size:4500000});assert.equal(large.status,200,await large.clone().text());
  const before=await large.json();assert.ok(before.parts>128);assert.equal(before.size,9000000);assert.equal(before.keys,before.parts+1);
  await h.restart();assert.deepEqual(await (await h.fetch({})).json(),before);
  const small=await (await h.fetch({size:10})).json();assert.equal(small.parts,1);assert.equal(small.keys,2);
  await h.restart();assert.deepEqual(await (await h.fetch({})).json(),small);
  // A 4 MB replay is encoded once into its own rows; the room snapshot stays one part.
  const archived=await (await h.fetch({archive:2000000})).json();
  assert.equal(archived.parts,1);assert.equal(archived.outbox.entries,1);assert.ok(archived.outbox.chunks>=1);
  await h.restart();assert.deepEqual(await (await h.fetch({})).json(),archived);
});
