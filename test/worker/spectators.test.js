import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RoomRuntime } from '../../worker/room-runtime.js';
import { retainedMatchVersions } from '../../worker/match-versions.js';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

class Socket extends EventEmitter {
  readyState=1; bufferedAmount=0; frames=[];
  send(data){this.frames.push(JSON.parse(data));}
  close(code,reason){this.closed={code,reason};this.readyState=3;this.emit('close');}
  take(t){return this.frames.filter(x=>x.t===t).at(-1);}
  count(t){return this.frames.filter(x=>x.t===t).length;}
}
// One message as the Durable Object handles it: one event, with the room's timed steps before and after it.
const send=(rt,ws,t,fields={})=>{rt.pump();rt.message(ws,JSON.stringify({t,rid:ws.frames.length+1,...fields}));rt.pump();};
function connect(rt,accountId,ticket,token,ip='8.8.8.8'){
  const ws=new Socket();rt.connect(ws,{accountId,ticket,ip});
  send(rt,ws,'hello',{name:accountId,token});return ws;
}
// A socket's close, as an event.
const drop=(rt,ws)=>{ws.close(1000);rt.pump();};
// What the Durable Object does on wake: the room from its snapshot, then its running match.
function restore(t,snapshot){
  const rt=new RoomRuntime({snapshot});t.after(()=>rt.lobby.shutdown());
  rt.restoreMatch(snapshot.matchCheckpoint);return rt;
}
// clock.tick(ms): time passes, then the room's due steps run (a spectator count update is due a second after the last).
function setup(t){
  const clock={offset:0,tick(ms=1000){clock.offset+=ms;rt.pump();}};
  const rt=new RoomRuntime({now:()=>Date.now()+clock.offset});
  const host=connect(rt,'host',rt.reserve('ABCD','host'));
  send(rt,host,'room.create',{mode:'coop',difficulty:'FUNNY'});
  t.after(()=>rt.lobby.shutdown());return {rt,host,clock};
}
test('public live spectators are seatless, read-only, counted and reconnectable',t=>{
  const {rt,host,clock}=setup(t);send(rt,host,'room.start');
  const match=rt.lobby.getRoom('ABCD').match, before=match.order.length;
  const a=connect(rt,'viewer');send(rt,a,'room.spectate');
  assert.equal(a.take('room.state')?.spectating,true);
  assert.equal(a.take('m.public').phase,'INFO_CHECK');
  assert.equal(a.take('m.private'),undefined);
  clock.tick();
  assert.equal(host.take('room.state').spectatorCount,1);
  assert.equal(match.order.length,before);
  send(rt,a,'g.infoReady');assert.equal(a.take('error').code,'NOT_IN_ROOM');
  send(rt,a,'room.start');assert.equal(a.take('error').code,'NOT_IN_ROOM');
  const b=connect(rt,'viewer2');send(rt,b,'room.spectate');
  clock.tick();
  assert.equal(a.take('room.state').spectatorCount,2);
  const token=a.take('welcome').token;drop(rt,a);
  clock.tick();
  assert.equal(host.take('room.state').spectatorCount,1);
  const again=connect(rt,'viewer',undefined,token);
  assert.equal(again.take('room.state').spectatorCount,2);
  send(rt,again,'g.leave');clock.tick();assert.equal(host.take('room.state').spectatorCount,1);
  drop(rt,again);
  const revisit=connect(rt,'viewer');send(rt,revisit,'room.spectate');
  assert.equal(revisit.take('room.state').spectating,true);
  assert.equal(rt.lobby.getRoom('ABCD').match,match);
  assert.equal(rt.hasAccount('viewer'),false);
});

test('spectator connections reserve capacity for player reconnects',t=>{
  const {rt,host}=setup(t);send(rt,host,'room.start');
  for(let i=0;i<11;i++){
    const viewer=connect(rt,'viewer'+i,undefined,undefined,'9.1.1.'+(i+1));
    send(rt,viewer,'room.spectate');assert.equal(viewer.take('room.state')?.spectating,true);
  }
  const extra=connect(rt,'extra',undefined,undefined,'9.2.1.1');
  assert.equal(extra.readyState,3,'spectators cannot consume player/replacement slots');
  const token=host.take('welcome').token;host.close();
  const flood=connect(rt,'flood',undefined,undefined,'9.2.1.2');assert.equal(flood.readyState,3);
  const resumed=connect(rt,'host',undefined,token);
  assert.equal(resumed.take('welcome').playerId,host.take('welcome').playerId);
  assert.equal(resumed.take('room.state').spectatorCount,11);
});

test('a spectator\'s hello and room.spectate are answered to it alone; count changes reach the room once a second',t=>{
  const {rt,host,clock}=setup(t);send(rt,host,'room.start');
  const viewer=connect(rt,'viewer');send(rt,viewer,'room.spectate');
  clock.tick();
  const states=host.count('room.state'), own=viewer.count('room.state'), pub=viewer.count('m.public');
  // Within the spectator's message limit (2 a second).
  for(let i=0;i<5;i++){clock.tick(500);send(rt,viewer,'hello',{name:'viewer'});clock.tick(500);send(rt,viewer,'room.spectate');}
  assert.equal(host.count('room.state'),states,'no room-wide state for a repeated hello or room.spectate');
  assert.equal(viewer.count('room.state'),own+10,'each is answered to the spectator');
  assert.equal(viewer.count('m.public'),pub,'without resending the match');
  // Leaving and watching again changes the count every time: the room hears of it at once, then once a second.
  for(let i=0;i<4;i++){clock.tick(100);send(rt,viewer,'room.leave');clock.tick(100);send(rt,viewer,'room.spectate');}
  assert.equal(host.count('room.state'),states+1);
  clock.tick();
  assert.equal(host.count('room.state'),states+2,'8 changes, 2 updates');
  assert.equal(host.take('room.state').spectatorCount,1);
  assert.equal(rt.timerDue(),rt.lobby.getRoom('ABCD').match.sched.nextAt(),'no update is pending');
  // A burst past the spectator's limit is refused.
  for(let i=0;i<15;i++)send(rt,viewer,'hello',{name:'viewer'});
  assert.ok(viewer.frames.slice(-15).some(f=>f.t==='error' && f.code==='RATE'));
});

test('an event reads the match once for its spectators, however many watch',t=>{
  const {rt,host}=setup(t);send(rt,host,'room.start');
  for(let i=0;i<5;i++)send(rt,connect(rt,'viewer'+i,undefined,undefined,'9.1.1.'+(i+1)),'room.spectate');
  const match=rt.lobby.getRoom('ABCD').match, publicView=match.publicView.bind(match), prepFieldMeta=match.prepFieldMeta.bind(match);
  let views=0,fields=0;match.publicView=()=>{views++;return publicView();};match.prepFieldMeta=(p)=>{fields++;return prepFieldMeta(p);};
  rt.spectators.pump();
  assert.equal(views,0,"the public view reaches spectators with the match's own broadcasts");
  assert.equal(fields,1,"the watched player's prep field, read once");
});

test("spectators get each public view once, as the players do, and a battle's early end",t=>{
  const {rt,host}=setup(t);send(rt,host,'room.addBot');send(rt,host,'room.start');
  const viewer=connect(rt,'viewer');send(rt,viewer,'room.spectate');
  const joined=host.count('m.public');
  const match=rt.lobby.getRoom('ABCD').match;
  send(rt,host,'g.autoplay',{on:true});
  for(let i=0;i<500 && match.round<3;i++){const at=match.sched.nextAt();if(at!=null)rt.pump(at);}
  assert.ok(match.round>=3);
  const pubs=viewer.frames.filter(f=>f.t==='m.public');
  assert.equal(pubs.length,1+host.count('m.public')-joined,"the view at the join, then the match's broadcasts");
  const key=({serverNow,...view})=>JSON.stringify(view);
  for(let i=1;i<pubs.length;i++)assert.notEqual(key(pubs[i]),key(pubs[i-1]),'no view twice');
  // a battle is sent once (not again when it is done); its early end reaches the spectators shown it, once
  for(let i=0;i<100 && !match.fields.some(f=>f.cc);i++){const at=match.sched.nextAt();if(at!=null)rt.pump(at);}
  const starts=viewer.frames.filter(f=>f.t==='b.start');
  assert.equal(new Set(starts.map(f=>f.battleId)).size,starts.length);
  const battle=starts.at(-1), playerId=host.take('welcome').playerId;
  match.sendTo(playerId,{t:'b.end',battleId:battle.battleId,fieldId:battle.fieldId,reason:'takeover'});rt.pump();
  assert.equal(viewer.count('b.end'),0,'a takeover only stops the former authority');
  for(let i=0;i<2;i++){match.sendTo(playerId,{t:'b.end',battleId:battle.battleId,fieldId:battle.fieldId,reason:'forced'});rt.pump();}
  assert.deepEqual(viewer.frames.filter(f=>f.t==='b.end').map(f=>[f.battleId,f.reason]),[[battle.battleId,'forced']]);
});

test('same-address spectators leave capacity for all player seats and a replacement',t=>{
  const {rt,host}=setup(t);send(rt,host,'room.start');
  for(let i=0;i<3;i++)send(rt,connect(rt,'viewer'+i),'room.spectate');
  assert.equal(connect(rt,'extra').readyState,3);
  const token=host.take('welcome').token;host.close();
  assert.equal(connect(rt,'host',undefined,token).take('room.state').inMatch,true);
});

test('spectators follow prep and combat without authority, and leave when the match ends',t=>{
  const {rt,host}=setup(t);send(rt,host,'room.start');
  const viewer=connect(rt,'viewer');send(rt,viewer,'room.spectate');
  const match=rt.lobby.getRoom('ABCD').match;
  send(rt,host,'g.infoReady');
  // Advance scheduled briefing/draft work; all choices still belong to players.
  for(let i=0;i<30 && match.phase!=='PREP';i++){
    if(match.phase==='BAND_DRAFT')send(rt,host,'g.band',{bandId:'band_sarkazb'});
    const at=match.sched.nextAt();if(at!=null)rt.pump(at);
  }
  assert.equal(match.phase,'PREP');rt.spectators.pump();
  assert.ok(viewer.take('m.field')?.fieldId.startsWith('n:'));
  send(rt,host,'g.ready',{ready:true});
  for(let i=0;i<30 && !match.fields.length;i++){const at=match.sched.nextAt();if(at!=null)rt.pump(at);}
  rt.spectators.pump();
  const battle=viewer.take('b.start');assert.ok(battle);
  assert.equal(battle.authoritative,false);assert.equal(battle.watch,true);
  // the browser simulates a battle with its match's rules (battle/runner.js): every b.start names them
  assert.equal(battle.rulesVersion,match.recording.rulesVersion);
  assert.equal(host.take('b.start')?.rulesVersion,match.recording.rulesVersion);
  const before=match.recording.events.length;
  send(rt,viewer,'b.progress',{battleId:battle.battleId,tick:1,killed:0,total:1});
  assert.equal(match.recording.events.length,before,'spectator reports cannot enter the match log');
  send(rt,viewer,'g.watch',{fieldId:battle.fieldId});
  assert.equal(viewer.take('b.start').fieldId,battle.fieldId);
  send(rt,host,'g.leave');
  assert.equal(viewer.take('room.closed')?.reason,'ended');
  assert.deepEqual(viewer.closed,{code:4004,reason:'match ended'},'its socket closes: nothing left to watch');
});

test('spectators get the players\' result when the match ends, then their socket closes',t=>{
  const {rt,host}=setup(t);
  const guest=connect(rt,'guest');
  send(rt,host,'room.addBot');send(rt,host,'room.start');
  const viewer=connect(rt,'viewer');send(rt,viewer,'room.spectate');
  const match=rt.lobby.getRoom('ABCD').match;
  rt.pump();match.finish({victory:true,reason:'victory'});rt.pump();
  const end=viewer.frames.slice(viewer.frames.findIndex(f=>f.t==='room.closed'));
  assert.deepEqual(end.map(f=>f.t),['room.closed','m.public','m.result']);
  assert.equal(end[0].reason,'ended');
  assert.equal(end[0].result,true,'says a result follows, so the page keeps the match on screen');
  assert.equal(end[1].phase,'RESULT');
  assert.equal(end[2].victory,true);
  assert.equal(end[2].playerId,undefined,'the shared result, nobody\'s own');
  assert.equal(end[2].errors,undefined);
  assert.deepEqual(end[2].players.map(p=>p.playerId),host.take('m.result').players.map(p=>p.playerId));
  assert.deepEqual(viewer.closed,{code:4004,reason:'match ended'});
  assert.equal(host.closed,undefined,'the players stay in their room');
  assert.equal(guest.closed,undefined);
});

test('offline spectators of an ended match learn it on their next hello and never join the next match',t=>{
  for(const restart of [false,true]) {
    let {rt,host}=setup(t);
    send(rt,host,'room.start');
    const viewer=connect(rt,'viewer');send(rt,viewer,'room.spectate');
    const token=viewer.take('welcome').token, hostToken=host.take('welcome').token;
    drop(rt,viewer);
    rt.pump();rt.lobby.getRoom('ABCD').match.finish({victory:false,reason:'defeat'});rt.pump();
    if(restart) {
      rt=new RoomRuntime({now:rt.now,snapshot:JSON.parse(JSON.stringify(rt.snapshot()))});
      const restored=rt;t.after(()=>restored.lobby.shutdown());
      host=connect(rt,'host',undefined,hostToken);
    }
    send(rt,host,'room.start');
    assert.equal(rt.lobby.getRoom('ABCD').matchCount,2);
    const back=connect(rt,'viewer',undefined,token);
    assert.equal(back.take('welcome').resumed,true);
    assert.deepEqual(back.frames.slice(1).map(f=>f.t),['room.closed','m.public','m.result'],restart?'restarted':'live');
    assert.equal(back.take('room.closed').reason,'ended');
    assert.equal(back.take('m.public').phase,'RESULT','the old match\'s end, not the new match');
    assert.equal(rt.spectators.count,0);
    send(rt,back,'room.spectate');
    assert.equal(back.take('room.state')?.spectating,true,'watching the next match is a choice');
    assert.equal(rt.spectators.count,1);
  }
});
test('waiting, private and solo rooms cannot be spectated, and their players see no spectator count',t=>{
  const {rt,host}=setup(t), a=connect(rt,'viewer');
  send(rt,a,'room.spectate');assert.ok(a.take('error'));
  assert.equal(host.take('room.state').spectatorCount,undefined);
  send(rt,host,'room.start');assert.equal(host.take('room.state').spectatorCount,0);
  rt.publicRoom=false;rt.spectators.broadcastState();assert.equal(host.take('room.state').spectatorCount,undefined);
  send(rt,a,'room.spectate');assert.equal(a.take('room.state'),undefined);
  rt.publicRoom=true;rt.lobby.getRoom('ABCD').mode='solo';
  send(rt,a,'room.spectate');assert.equal(a.take('room.state'),undefined);
});
test('persisted match restores players and observers separately without changing match rules',t=>{
  const {rt,host}=setup(t);send(rt,host,'room.start');
  const a=connect(rt,'viewer');send(rt,a,'room.spectate');
  assert.equal(a.take('room.state')?.spectating,true);
  const snapshot=rt.snapshot();
  const restored=restore(t,snapshot);
  const player=connect(restored,'host',undefined,host.take('welcome').token);
  assert.equal(player.take('welcome').playerId,host.take('welcome').playerId);
  assert.equal(player.take('m.public').phase,'INFO_CHECK');
  const viewer=connect(restored,'viewer',undefined,a.take('welcome').token);
  assert.equal(viewer.take('room.state').spectating,true);
  assert.equal(viewer.take('room.state').spectatorCount,1);
  assert.equal(viewer.take('m.private'),undefined);
  assert.equal(restored.lobby.getRoom('ABCD').match.recording.rulesVersion,snapshot.matchCheckpoint.rulesVersion);
});

test('a published old-rules battle restores unchanged and accepts new spectators',async t=>{
  const version='4bc12d6414367669161b';
  const archive=JSON.parse(gunzipSync(await readFile(new URL('../../replay-versions/'+version+'.json.gz',import.meta.url))));
  const engine=await import('data:text/javascript;base64,'+Buffer.from(archive['recovery.mjs']).toString('base64'));
  retainedMatchVersions[version]=engine.restore;t.after(()=>delete retainedMatchVersions[version]);
  const {rt,host}=setup(t);
  rt.lobby.MatchClass=class{constructor(options){return engine.create(options);}};
  send(rt,host,'room.start');send(rt,host,'g.infoReady');
  const match=rt.lobby.getRoom('ABCD').match;
  for(let i=0;i<30 && match.phase!=='PREP';i++){
    if(match.phase==='BAND_DRAFT')send(rt,host,'g.band',{bandId:'band_sarkazb'});
    const at=match.sched.nextAt();if(at!=null)rt.pump(at);
  }
  send(rt,host,'g.ready',{ready:true});
  for(let i=0;i<30 && !match.fields.length;i++){const at=match.sched.nextAt();if(at!=null)rt.pump(at);}
  assert.ok(match.fields[0]?.battleId);
  const checkpoint=JSON.parse(JSON.stringify(rt.snapshot()));
  assert.equal(checkpoint.matchCheckpoint.rulesVersion,version);
  const restored=restore(t,checkpoint);
  const resumed=connect(restored,'host',undefined,host.take('welcome').token);
  assert.equal(resumed.take('welcome').playerId,host.take('welcome').playerId);
  assert.equal(resumed.take('b.start').battleId,match.fields[0].battleId);
  const viewer=connect(restored,'late-viewer');send(restored,viewer,'room.spectate');
  assert.equal(viewer.take('b.start').battleId,match.fields[0].battleId);
  assert.equal(viewer.take('b.start').authoritative,false);
  assert.equal(restored.lobby.getRoom('ABCD').match.recording.rulesVersion,version);
});

test('room avatars come from authenticated profiles and survive reconnect snapshots',t=>{
  const rt=new RoomRuntime();t.after(()=>rt.lobby.shutdown());
  const avatarUrl='https://avatars.githubusercontent.com/u/123?v=4';
  const host=new Socket();rt.connect(host,{accountId:'host',ticket:rt.reserve('ABCD','host'),avatarUrl});
  send(rt,host,'hello',{name:'Host',avatarUrl:'https://example.com/spoof.png'});
  send(rt,host,'room.create',{mode:'coop',difficulty:'FUNNY'});
  assert.equal(host.take('room.state').seats[0].avatarUrl,avatarUrl);
  const restored=new RoomRuntime({snapshot:rt.snapshot()});t.after(()=>restored.lobby.shutdown());
  const resumed=connect(restored,'host',undefined,host.take('welcome').token);
  assert.equal(resumed.take('room.state').seats[0].avatarUrl,avatarUrl);
  send(restored,resumed,'room.addBot');
  assert.equal(resumed.take('room.state').seats[1].avatarUrl,null);
});
