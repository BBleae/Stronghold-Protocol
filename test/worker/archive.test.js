import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountHarness } from './helpers/account-harness.js';
import { aggregateStats } from '../../shared/history.js';
import {prepareArchive,publishArchive} from '../../worker/archive/outbox.js';

test('old partial raw outboxes retain byte boundaries; new outboxes freeze compressed bytes before retries',async()=>{
  const entry={facts:{matchId:'m'},personal:[],replay:{rulesVersion:'v1',text:'博士🪄'.repeat(20000)}};
  const raw=JSON.stringify(entry.replay),parts=[];
  for(let offset=0;offset<raw.length;offset+=16000)parts.push(raw.slice(offset,offset+16000));
  const writes=new Map([[0,parts[0]]]);let finalized;
  const archive={async appendChunk({index,text}){if(writes.has(index))assert.equal(text,writes.get(index));writes.set(index,text);},async finalize(facts){finalized=facts;}};
  const env={MATCH_ARCHIVES:{idFromName:x=>x,get:()=>archive},SITES:{idFromName:x=>x,get:()=>({registerArchive(){}})}};
  await publishArchive(env,entry);assert.equal(finalized.manifest.schemaVersion,1);assert.equal([...writes.values()].join(''),raw);
  const compressed={...entry,archiveEncoding:2};compressed.encodedReplay=await prepareArchive(compressed);delete compressed.replay;
  const first=JSON.stringify(compressed.encodedReplay);const restored=JSON.parse(JSON.stringify(compressed));
  assert.equal(JSON.stringify(await prepareArchive(restored)),first,'retry uses frozen bytes without needing the current encoder');
  writes.clear();await publishArchive(env,restored);assert.equal(finalized.manifest.codec,'gzip-base64');
});
test('stats distinguish completed games, early departure and repeated operator appearances',()=>{
  const facts=[{matchId:'m1',status:'completed',victory:true,round:14,stats:{dmgDealt:50,gold:5},operators:['a','a','b']},
    {matchId:'m2',status:'left',victory:true,round:3,stats:{dmgDealt:10},operators:['a']}];
  const stats=aggregateStats(facts);
  assert.equal(stats.completed,1);assert.equal(stats.winRate,1);assert.equal(stats.left,1);
  assert.equal(stats.totals.dmgDealt,60);assert.equal(stats.operators[0].matches,2);
  assert.equal(aggregateStats([]).winRate,null);
});
test('archive chunks survive restart, reject mutation and enforce participant reads', {timeout:60000},async t=>{
  const h=await createAccountHarness(`
    export {MatchArchive as TestObject} from './worker/archive/archive.js';
    export default {async fetch(req,env) {const {op,args}=await req.json();try {
      return Response.json((await env.TEST.get(env.TEST.idFromName('m1'))[op](...args)) ?? null);
    }catch(e){return Response.json({error:e.message},{status:403});}}};`);
  t.after(()=>h.dispose());
  const call=async(op,...args)=>(await h.fetch({op,args})).json();
  const chunk=await call('appendChunk',{index:0,text:'{"events":[]}'});
  assert.ok(chunk.hash);
  assert.equal((await call('appendChunk',{index:0,text:'changed'})).error,'ARCHIVE_CONFLICT');
  const facts={matchId:'m1',participants:['alice'],result:{victory:true},endedAt:1000,
    manifest:{chunks:[chunk],schemaVersion:1,rulesVersion:'test',dataVersion:'test'}};
  await call('finalize',facts);await call('finalize',facts);
  await h.restart();
  assert.equal((await call('read','alice')).matchId,'m1');
  assert.equal((await call('read','bob')).error,'FORBIDDEN');
  assert.equal((await call('readChunk','alice',0)).text,'{"events":[]}');
});

test('publication retries after finalize and a partial personal-index failure without double counting', {timeout:60000},async t=>{
  const h=await createAccountHarness(`
    import {DurableObject} from 'cloudflare:workers';
    import {publishArchive} from './worker/archive/outbox.js';
    import {AccountDurableObject} from './worker/accounts/account.js';
    export {MatchArchive} from './worker/archive/archive.js';
    export {SiteDirectory} from './worker/accounts/directory.js';
    export class Account extends AccountDurableObject {
      async applyMatch(fact){if(fact.accountId==='bob' && !await this.ctx.storage.get('injected')){
        await this.ctx.storage.put('injected',true);throw new Error('INJECTED_INDEX_FAILURE');}
        return super.applyMatch(fact);}
    }
    export class TestObject extends DurableObject {
      async seed(entry){await this.ctx.storage.put('pending',entry);}
      async flush(){const entry=await this.ctx.storage.get('pending');if(!entry)return {done:true};
        await publishArchive(this.env,entry);await this.ctx.storage.delete('pending');return {done:true};}
    }
    export default {async fetch(req,env){const i=await req.json();try{
      const coordinator=env.TEST.get(env.TEST.idFromName('pending'));
      if(i.stats)return Response.json(await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(i.stats)).getStats());
      if(i.archive)return Response.json(await env.MATCH_ARCHIVES.get(env.MATCH_ARCHIVES.idFromName('m')).read('alice'));
      return Response.json((await coordinator[i.op](i.entry)) ?? null);
    }catch(e){return Response.json({error:e.message},{status:503});}}};`,{durableObjects:{ACCOUNTS:{className:'Account',useSQLite:true},MATCH_ARCHIVES:{className:'MatchArchive',useSQLite:true},
      SITES:{className:'SiteDirectory',useSQLite:true}}});
  t.after(()=>h.dispose());
  const entry={facts:{matchId:'m',participants:['alice','bob'],result:{victory:true}},personal:['alice','bob'].map(accountId=>({accountId,matchId:'m',endedAt:1,mode:'coop',difficulty:'FUNNY',status:'completed',victory:true})),replay:{rulesVersion:'test',battles:[]}};
  await h.fetch({op:'seed',entry});assert.equal((await h.fetch({op:'flush'})).status,503);
  assert.equal((await (await h.fetch({archive:true})).json()).matchId,'m');
  assert.equal((await (await h.fetch({stats:'alice'})).json()).completed,1);
  assert.equal((await (await h.fetch({stats:'bob'})).json()).completed,0);
  await h.restart();assert.equal((await h.fetch({op:'flush'})).status,200);
  for(const stats of ['alice','bob'])assert.equal((await (await h.fetch({stats})).json()).completed,1);
});
