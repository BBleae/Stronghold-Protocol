import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../../worker/accounts/auth.js';
import { sealBackup,validateBackup,handleBackupRoutes } from '../../worker/storage/backup.js';
import { createAccountHarness } from './helpers/account-harness.js';
test('backup validates independent content and refuses unknown versions and player credentials',async()=>{
  const text='{"battles":[]}',chunk={index:0,text,hash:await hash(text)};
  const facts={matchId:'m',participants:['a'],personal:[{accountId:'a',matchId:'m'}],manifest:{rulesVersion:'v1',chunks:[{index:0,hash:chunk.hash}]}};
  const backup=await sealBackup(facts,[chunk]);assert.equal((await validateBackup(backup,['v1'])).ok,true);
  await assert.rejects(validateBackup(backup,['v2']),/BACKUP_VERSION/);
  const changed=structuredClone(backup);changed.chunks[0].text+=' ';await assert.rejects(validateBackup(changed,['v1']),/BACKUP_HASH/);
  const response=await handleBackupRoutes(new Request('https://game.example/api/admin/backup/catalog',{headers:{cookie:'__Host-sp_session='+'a'.repeat(64)}}),{});
  assert.equal(response.status,403);
});
test('export, default dry-run and restore rebuild history without exporting sessions', {timeout:60000},async t=>{
  const create=()=>createAccountHarness(`
    export {SiteDirectory as TestObject} from './worker/accounts/directory.js';
    export {AccountDurableObject} from './worker/accounts/account.js';
    export {MatchArchive} from './worker/archive/archive.js';
    import {handleBackupRoutes} from './worker/storage/backup.js';
    import {publishArchive} from './worker/archive/outbox.js';
    import {hash} from './worker/accounts/auth.js';
    export default {async fetch(req,env){const i=await req.json();
      const d=env.SITES.get(env.SITES.idFromName('directory'));
      if(i.seed){const p=await d.resolveGithubUser({id:'42',login:'Alice',avatarUrl:null});
        await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(p.accountId)).setProfile(p);
        await d.saveSession(await hash('a'.repeat(64)),{accountId:p.accountId,expiresAt:Date.now()+60000});
        await publishArchive(env,{archiveEncoding:2,facts:{matchId:'m',participants:[p.accountId],result:{victory:true}},
          personal:[{matchId:'m',accountId:p.accountId,endedAt:1,mode:'solo',difficulty:'FUNNY',status:'completed',victory:true}],
          replay:{rulesVersion:'development-v1',battles:[]}});return Response.json(p);}
      if(i.session)return Response.json(await d.getSession(await hash('a'.repeat(64))));
      if(i.injectSession){await d.saveSession(await hash('a'.repeat(64)),{accountId:i.injectSession,expiresAt:Date.now()+60000});return Response.json({ok:true});}
      if(i.profile)return Response.json(await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(i.profile)).getProfile());
      if(i.stats)return Response.json(await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(i.stats)).getStats());
      return handleBackupRoutes(new Request('https://game.example/api/admin/backup/'+i.path,{method:i.body?'POST':'GET',
        headers:{Authorization:'Bearer '+(i.body?'i':'e').repeat(40)},body:i.body?JSON.stringify(i.body):undefined}),env);
    }};`,{durableObjects:{SITES:{className:'TestObject',useSQLite:true},ACCOUNTS:{className:'AccountDurableObject',useSQLite:true},MATCH_ARCHIVES:{className:'MatchArchive',useSQLite:true}},
      bindings:{ARCHIVE_EXPORT_TOKEN:'e'.repeat(40),ARCHIVE_IMPORT_TOKEN:'i'.repeat(40)}});
  const h=await create();t.after(()=>h.dispose());
  const p=await (await h.fetch({seed:true})).json();
  const backup=await (await h.fetch({path:'archive?id=m'})).json();
  assert.equal(backup.facts.manifest.codec,'gzip-base64');
  assert.ok(backup.hash);assert.ok(!JSON.stringify(backup).includes('session'));
  assert.equal((await (await h.fetch({path:'archive',body:{backup}})).json()).written,0);
  const destination=await create();t.after(()=>destination.dispose());
  assert.equal((await (await destination.fetch({stats:p.accountId})).json()).completed,0);
  assert.equal((await (await destination.fetch({path:'archive',body:{backup}})).json()).written,0);
  assert.equal(await (await destination.fetch({profile:p.accountId})).json(),null);
  await destination.fetch({injectSession:p.accountId});
  assert.equal((await (await destination.fetch({path:'profile',body:{profile:p,dryRun:false}})).json()).written,1);
  assert.equal(await (await destination.fetch({session:true})).json(),null,'restore revokes previous sessions');
  for(let i=0;i<2;i++)assert.equal((await (await destination.fetch({path:'archive',body:{backup,dryRun:false}})).json()).written,1);
  await destination.restart();
  assert.equal((await (await destination.fetch({stats:p.accountId})).json()).completed,1);
  assert.deepEqual((await (await destination.fetch({path:'archive?id=m'})).json()),backup);
  await h.restart();
  for(let i=0;i<2;i++)assert.equal((await (await h.fetch({path:'archive',body:{backup,dryRun:false}})).json()).written,1);
  assert.equal((await (await h.fetch({stats:p.accountId})).json()).completed,1);
});
