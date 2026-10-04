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
  close(){this.readyState=3;this.emit('close');}
  take(t){return this.frames.filter(x=>x.t===t).at(-1);}
}
const send=(rt,ws,t,fields={})=>rt.message(ws,JSON.stringify({t,rid:ws.frames.length+1,...fields}));
function connect(rt,accountId,ticket,token,ip='8.8.8.8'){
  const ws=new Socket();rt.connect(ws,{accountId,ticket,ip});
  send(rt,ws,'hello',{name:accountId,token});return ws;
}
// What the Durable Object does on wake: the room from its snapshot, then its running match.
function restore(t,snapshot){
  const rt=new RoomRuntime({accounts:true,snapshot});t.after(()=>rt.lobby.shutdown());
  rt.restoreMatch(snapshot.matchCheckpoint);return rt;
}
function setup(t){
  const rt=new RoomRuntime({accounts:true});
  const host=connect(rt,'host',rt.reserve('ABCD','host'));
  send(rt,host,'room.create',{mode:'coop',difficulty:'FUNNY'});
  t.after(()=>rt.lobby.shutdown());return {rt,host};
}
test('public live spectators are seatless, read-only, counted and reconnectable',t=>{
  const {rt,host}=setup(t);send(rt,host,'room.start');
  const match=rt.lobby.getRoom('ABCD').match, before=match.order.length;
  const a=connect(rt,'viewer');send(rt,a,'room.spectate');
  assert.equal(a.take('room.state')?.spectating,true);
  assert.equal(a.take('m.public').phase,'INFO_CHECK');
  assert.equal(a.take('m.private'),undefined);
  assert.equal(host.take('room.state').spectatorCount,1);
  assert.equal(match.order.length,before);
  send(rt,a,'g.infoReady');assert.equal(a.take('error').code,'NOT_IN_ROOM');
  send(rt,a,'room.start');assert.equal(a.take('error').code,'NOT_IN_ROOM');
  const b=connect(rt,'viewer2');send(rt,b,'room.spectate');
  assert.equal(a.take('room.state').spectatorCount,2);
  const token=a.take('welcome').token;a.close();
  assert.equal(host.take('room.state').spectatorCount,1);
  const again=connect(rt,'viewer',undefined,token);
  assert.equal(again.take('room.state').spectatorCount,2);
  send(rt,again,'g.leave');assert.equal(host.take('room.state').spectatorCount,1);
  again.close();
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
  const before=match.recording.events.length;
  send(rt,viewer,'b.progress',{battleId:battle.battleId,tick:1,killed:0,total:1});
  assert.equal(match.recording.events.length,before,'spectator reports cannot enter the match log');
  send(rt,viewer,'g.watch',{fieldId:battle.fieldId});
  assert.equal(viewer.take('b.start').fieldId,battle.fieldId);
  send(rt,host,'g.leave');
  assert.equal(viewer.take('room.closed')?.reason,'ended');
});
test('waiting, private and solo rooms cannot be spectated',t=>{
  const {rt,host}=setup(t), a=connect(rt,'viewer');
  send(rt,a,'room.spectate');assert.ok(a.take('error'));
  send(rt,host,'room.start');rt.publicRoom=false;
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
  assert.equal(player.take('room.state').spectatorCount,1);
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
  const rt=new RoomRuntime({accounts:true});t.after(()=>rt.lobby.shutdown());
  const avatarUrl='https://avatars.githubusercontent.com/u/123?v=4';
  const host=new Socket();rt.connect(host,{accountId:'host',ticket:rt.reserve('ABCD','host'),avatarUrl});
  send(rt,host,'hello',{name:'Host',avatarUrl:'https://example.com/spoof.png'});
  send(rt,host,'room.create',{mode:'coop',difficulty:'FUNNY'});
  assert.equal(host.take('room.state').seats[0].avatarUrl,avatarUrl);
  const restored=new RoomRuntime({accounts:true,snapshot:rt.snapshot()});t.after(()=>restored.lobby.shutdown());
  const resumed=connect(restored,'host',undefined,host.take('welcome').token);
  assert.equal(resumed.take('room.state').seats[0].avatarUrl,avatarUrl);
  send(restored,resumed,'room.addBot');
  assert.equal(resumed.take('room.state').seats[1].avatarUrl,null);
});
