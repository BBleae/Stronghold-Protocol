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
test('account room snapshot restores an active match and accepts the original seat again', () => {
  const rt=new RoomRuntime({accounts:true,now:()=>1000});
  const ws=new Socket();rt.connect(ws,{accountId:'alice',ticket:rt.reserve('ABCD','alice')});
  const send=(r,s,t,extra={})=>r.message(s,JSON.stringify({t,...extra}));
  send(rt,ws,'hello',{name:'Alice'});
  send(rt,ws,'room.create',{mode:'solo',difficulty:'FUNNY'});
  send(rt,ws,'room.start');
  const before=rt.lobby.getRoom('ABCD').match.publicView();
  const snapshot=JSON.parse(JSON.stringify(rt.snapshot()));
  const recovered=new RoomRuntime({snapshot,accounts:true,now:()=>1000});
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
