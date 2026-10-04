import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountHarness } from './helpers/account-harness.js';
// Use production build substitutions for filesystem data loaders.
import { bundleWorker } from '../../tools/build-worker.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('real account-mode Worker resumes the same active match after full process restart', {timeout:60000},async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'sp-account-build-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await bundleWorker({outfile:path.join(dir,'worker.mjs')});
  // The fixture seeds a session via DO RPC; no testing endpoint exists in the production Worker.
  const code=await readFile(path.join(dir,'worker.mjs'),'utf8');
  const source=`
    import worker,{SiteDirectory,AccountDurableObject,RoomDurableObject as ProductionRoom,AdmissionDurableObject,MatchArchive} from ${JSON.stringify(path.join(dir,'worker.mjs').replaceAll('\\','/'))};
    export class RoomDurableObject extends ProductionRoom {
      async fetch(req){if(new URL(req.url).pathname==='/__test/fail'){await this.ready;this.failNext=true;return Response.json({ok:true});}return super.fetch(req);}
      async persist(){
        if(!this.failNext)return super.persist();this.failNext=false;
        const original=this.ctx;
        const storage=new Proxy(original.storage,{get(target,key){if(key==='transaction')return fn=>target.transaction(async tx=>{await fn(tx);throw new Error('INJECTED_COMMIT_FAILURE');});const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
        this.ctx=new Proxy(original,{get(target,key){if(key==='storage')return storage;const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
        try{return await super.persist();}finally{this.ctx=original;}
      }
    }
    export {SiteDirectory as TestObject,AccountDurableObject,AdmissionDurableObject,MatchArchive};
    import {hash} from './worker/accounts/auth.js';
    export default {async fetch(req,env){
      if(req.headers.get('Upgrade')==='websocket') {
        const u=new URL(req.url);
        const actor=u.searchParams.get('actor') || 'a';
        return worker.fetch(new Request('https://game.example'+u.pathname+u.search,{headers:{
          Upgrade:'websocket',Origin:'https://game.example',cookie:'__Host-sp_session='+actor.repeat(64)}}),env);
      }
      const input=await req.json();
      const actor=input.actor || 'a';
      if(input.failRoom)return env.ROOMS.get(env.ROOMS.idFromName(input.failRoom)).fetch(new Request('https://room.internal/__test/fail'));
      if(input.seed){
        const site=env.SITES.get(env.SITES.idFromName('directory'));
        const user=await site.resolveGithubUser({id:String(actor.charCodeAt(0)),login:'Player '+actor,avatarUrl:'https://avatars.githubusercontent.com/u/'+actor.charCodeAt(0)});
        await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(user.accountId)).setProfile(user);
        await site.saveSession(await hash(actor.repeat(64)),{accountId:user.accountId,expiresAt:Date.now()+600000});
        return Response.json(user);
      }
      return worker.fetch(new Request('https://game.example'+input.path,{method:input.method||'GET',
        headers:{Origin:'https://game.example',cookie:'__Host-sp_session='+ actor.repeat(64),...input.headers},
        body:input.body?JSON.stringify(input.body):undefined}),env);
    }};
  `;
  assert.ok(code.length>1000);
  const durableObjects=Object.fromEntries([['SITES','TestObject'],['ACCOUNTS','AccountDurableObject'],['ROOMS','RoomDurableObject'],['ADMISSION','AdmissionDurableObject'],['MATCH_ARCHIVES','MatchArchive']]
    .map(([key,className])=>[key,{className,useSQLite:true}]));
  const h=await createAccountHarness(source,{durableObjects});t.after(()=>h.dispose());
  await h.fetch({seed:true});
  const reserve=await h.fetch({path:'/api/rooms',method:'POST'}); assert.equal(reserve.status,201);
  const route=await reserve.json();
  const connect=async (route,actor='a')=>{
    const response=await h.request('https://test.example/ws?room='+route.code+'&ticket='+route.ticket+'&actor='+actor,{headers:{Upgrade:'websocket'}});
    assert.equal(response.status,101,response.status===101?'':await response.text());
    const ws=response.webSocket,frames=[];ws.addEventListener('message',e=>frames.push(JSON.parse(e.data)));ws.accept();
    const wait=async (type,rid)=>{
      for(let i=0;i<150;i++){const frame=frames.find(f=>f.t===type && (rid===undefined || f.rid===rid));if(frame)return frame;await new Promise(r=>setTimeout(r,20));}
      assert.fail('missing '+type+JSON.stringify(frames));
    };
    ws.send(JSON.stringify({t:'hello',name:'Alice'}));const welcome=await wait('welcome');
    return {ws,frames,wait,welcome};
  };
  const first=await connect(route);
  first.ws.send(JSON.stringify({t:'room.create',mode:'solo',difficulty:'FUNNY',rid:1}));
  assert.equal((await first.wait('room.state')).seats[0].avatarUrl,'https://avatars.githubusercontent.com/u/97');
  first.ws.send(JSON.stringify({t:'room.start',rid:2}));
  const state=await first.wait('m.public');assert.equal(state.phase,'INFO_CHECK');
  await h.restart();
  const resume=await h.fetch({path:'/api/me/resume',method:'POST'});
  assert.equal(resume.status,200);
  const next=await connect(await resume.json());
  assert.equal(next.welcome.playerId,first.welcome.playerId);
  assert.equal((await next.wait('room.state')).seats[0].avatarUrl,'https://avatars.githubusercontent.com/u/97');
  assert.equal((await next.wait('m.public')).phase,'INFO_CHECK');
  next.ws.send(JSON.stringify({t:'g.leave',rid:3,commandId:'leave-1'}));await next.wait('ok',3);
  next.ws.close();
  await h.fetch({path:'/api/me/active-match'});
  const secondRoute=await (await h.fetch({path:'/api/rooms',method:'POST'})).json();
  const host=await connect(secondRoute);
  const send=async(t,fields={},rid=10)=>{host.ws.send(JSON.stringify({t,...fields,rid,commandId:'command-'+rid}));return host.wait('ok',rid);};
  await send('room.create',{mode:'coop',difficulty:'FUNNY'});
  await send('room.addBot',{},11);await send('room.addBot',{},12);
  assert.equal(host.frames.filter(f=>f.t==='room.state').at(-1).seats.filter(Boolean).length,3);
  const applications=[];
  for(const actor of ['b','c']) {
    await h.fetch({seed:true,actor});
    const r=await h.fetch({actor,path:'/api/rooms/'+secondRoute.code+'/applications',method:'POST',body:{action:'apply'}});
    assert.equal(r.status,201,await r.clone().text());applications.push(await r.json());
  }
  const foreign=await h.fetch({actor:'b',path:'/api/rooms/'+secondRoute.code+'/applications',method:'POST',body:{action:'approve',id:applications[1].id}});
  assert.equal(foreign.status,403);
  const approvals=await Promise.all(applications.map(item=>h.fetch({path:'/api/rooms/'+secondRoute.code+'/applications',method:'POST',body:{action:'approve',id:item.id}})));
  assert.equal(approvals.filter(r=>r.status===200).length,1);
  const index=approvals.findIndex(r=>r.status===200),approved=await approvals[index].json(),actor=['b','c'][index];
  const guest=await connect({code:secondRoute.code,ticket:approved.ticket},actor);
  guest.ws.send(JSON.stringify({t:'room.join',code:secondRoute.code,rid:1}));await guest.wait('ok',1);
  const guestState=await guest.wait('room.state');
  assert.equal(guestState.seats[0].avatarUrl,'https://avatars.githubusercontent.com/u/97');
  assert.equal(guestState.seats.find(s=>s?.playerId===guest.welcome.playerId).avatarUrl,'https://avatars.githubusercontent.com/u/'+actor.charCodeAt(0));
  assert.equal((await (await h.fetch({actor,path:'/api/me/active-match'})).json()).activeSeat.roomId,secondRoute.code);
  const cancelJoined=await h.fetch({actor,path:'/api/rooms/'+secondRoute.code+'/applications',method:'POST',body:{action:'cancel',id:approved.id}});
  assert.equal(cancelJoined.status,409);
  assert.equal((await h.fetch({actor,path:'/api/rooms',method:'POST'})).status,409,'cancelling a joined application cannot free a seated account');
  const history=await (await h.fetch({path:'/api/me/matches'})).json();
  assert.ok(history.items.length);
  const forbidden=await h.fetch({actor,path:'/api/matches/'+history.items[0].matchId});
  assert.equal(forbidden.status,403,'nonparticipants must receive a forbidden response');
  // Invalidated pending requests can move to another room without a page reload.
  const waitingActor=['b','c'][1-index];
  await h.fetch({path:'/api/rooms/'+secondRoute.code+'/visibility',method:'POST',body:{public:false}});
  await h.fetch({seed:true,actor:'d'});
  const thirdRoute=await (await h.fetch({actor:'d',path:'/api/rooms',method:'POST'})).json();
  const third=await connect(thirdRoute,'d');
  third.ws.send(JSON.stringify({t:'room.create',mode:'coop',difficulty:'FUNNY',rid:1}));await third.wait('ok',1);
  const reapplied=await h.fetch({actor:waitingActor,path:'/api/rooms/'+thirdRoute.code+'/applications',method:'POST',body:{action:'apply'}});
  assert.equal(reapplied.status,201,await reapplied.clone().text());
  third.ws.close();
  // Fail the actual RoomDO transaction after SQL/KV writes but before commit.
  await h.fetch({failRoom:secondRoute.code});
  host.ws.send(JSON.stringify({t:'room.setDifficulty',difficulty:'NORMAL',rid:99,commandId:'failed-difficulty'}));
  await new Promise(r=>setTimeout(r,200));
  assert.equal(host.frames.some(f=>f.rid===99 && f.t==='ok'),false,'no acknowledgment before durable commit');
  assert.equal(host.frames.some(f=>f.t==='room.state' && f.difficulty==='NORMAL'),false,'no uncommitted state broadcast');
  const recoveredRoute=await (await h.fetch({path:'/api/me/resume',method:'POST'})).json();
  const recovered=await connect(recoveredRoute);
  assert.equal((await recovered.wait('room.state')).difficulty,'FUNNY','failed command must not survive restart');
  recovered.ws.send(JSON.stringify({t:'room.setDifficulty',difficulty:'NORMAL',rid:100,commandId:'failed-difficulty'}));
  await recovered.wait('ok',100);assert.equal(recovered.frames.filter(f=>f.t==='room.state').at(-1).difficulty,'NORMAL');
  guest.ws.close();host.ws.close();recovered.ws.close();
});
