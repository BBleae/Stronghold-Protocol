import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RoomRuntime } from '../../worker/room-runtime.js';
class Socket extends EventEmitter {
  readyState=1;bufferedAmount=0;frames=[];
  send(s){this.frames.push(JSON.parse(s));}
  close(){this.readyState=3;this.emit('close');}
  terminate(){this.close();}
}
// What the Durable Object does on wake: the room from its snapshot, then its running match.
function restore(snapshot,now){
  const rt=new RoomRuntime({snapshot,accounts:true,now});
  rt.restoreMatch(snapshot.matchCheckpoint);
  return rt;
}
test('account room snapshot restores an active match and accepts the original seat again', () => {
  const rt=new RoomRuntime({accounts:true,now:()=>1000});
  const ws=new Socket();rt.connect(ws,{accountId:'alice',ticket:rt.reserve('ABCD','alice')});
  const send=(r,s,t,extra={})=>r.message(s,JSON.stringify({t,...extra}));
  send(rt,ws,'hello',{name:'Alice'});
  send(rt,ws,'room.create',{mode:'solo',difficulty:'FUNNY'});
  send(rt,ws,'room.start');
  const before=rt.lobby.getRoom('ABCD').match.publicView();
  const snapshot=JSON.parse(JSON.stringify(rt.snapshot()));
  const recovered=restore(snapshot,()=>1000);
  assert.ok(recovered.lobby.getRoom('ABCD')?.match,'active match must not be discarded');
  assert.deepEqual(recovered.lobby.getRoom('ABCD').match.publicView(),before);
  const next=new Socket();recovered.connect(next,{accountId:'alice',takeover:true});
  send(recovered,next,'hello',{name:'Alice'});
  send(recovered,next,'g.infoReady');
  recovered.pump(1000);
  assert.notEqual(recovered.lobby.getRoom('ABCD').match.phase,'INFO_CHECK');
  rt.lobby.getRoom('ABCD').match.dispose();
  recovered.lobby.getRoom('ABCD').match.dispose();
  rt.network.close();recovered.network.close();
});

test('a cold restart reconciles missing sockets and resumes paused solo combat under server authority',()=>{
  const rt=new RoomRuntime({accounts:true,now:()=>1000}),ws=new Socket();
  rt.connect(ws,{accountId:'alice',ticket:rt.reserve('ABCD','alice')});
  const send=(t,extra={})=>rt.message(ws,JSON.stringify({t,...extra}));
  send('hello',{name:'Alice'});send('room.create',{mode:'solo',difficulty:'FUNNY'});send('room.start');
  const match=rt.lobby.getRoom('ABCD').match,pid=[...rt.registry.all()][0].playerId;
  match.handle(pid,{t:'g.infoReady'});match.pump(1000);
  match.handle(pid,{t:'g.band',bandId:'band_sarkazb'});
  for(let i=0;i<100 && match.phase!=='PREP';i++)match.pump(match.sched.nextAt(),1);
  match.handle(pid,{t:'g.ready',ready:true});
  for(let i=0;i<100 && match.phase!=='COMBAT';i++)match.pump(match.sched.nextAt(),1);
  assert.equal(match.phase,'COMBAT');match.handle(pid,{t:'g.pause',on:true});assert.equal(match.paused,true);
  const recovered=restore(JSON.parse(JSON.stringify(rt.snapshot())),()=>2000);
  recovered.reconcileSockets();const restored=recovered.lobby.getRoom('ABCD').match;
  assert.equal(restored.players.get(pid).connected,false);assert.equal(restored.paused,false);
  assert.ok(restored.fields.every(f=>f.mode==='server'));
  match.dispose();restored.dispose();rt.network.close();recovered.network.close();
});

test('reusing an empty room code creates a new archive generation',()=>{
  let now=1000;const rt=new RoomRuntime({accounts:true,now:()=>now});rt.reserve('ABCD','alice');
  const first=rt.generation;now+=120001;rt.sweep();assert.equal(rt.isEmpty(),true);
  assert.ok(rt.reserve('ABCD','bob'));assert.notEqual(rt.generation,first);
});
