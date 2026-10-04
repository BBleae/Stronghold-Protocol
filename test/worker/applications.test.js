import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ApplicationQueue } from '../../worker/rooms/applications.js';
import { RoomRuntime } from '../../worker/room-runtime.js';
test('approval cannot overbook, bypass the host, survive starting, or be reused by another account', () => {
  let now=1000;
  const q=new ApplicationQueue({now:()=>now});
  const room={hostId:'host',inMatch:false,freeSeats:1};
  const a=q.apply({accountId:'alice',name:'Alice'}), b=q.apply({accountId:'bob',name:'Bob'});
  assert.equal(q.apply({accountId:'alice',name:'Alice'}).id,a.id);
  assert.throws(()=>q.decide('stranger',a.id,'approved',room),/NOT_HOST/);
  const approved=q.decide('host',a.id,'approved',room);
  assert.throws(()=>q.decide('host',b.id,'approved',room),/ROOM_FULL/);
  assert.equal(q.consume('bob',approved.ticket),false);
  assert.equal(q.consume('alice',approved.ticket),true);
  assert.equal(q.consume('alice',approved.ticket),false);
  assert.throws(()=>q.decide('host',b.id,'approved',{...room,inMatch:true}),/ROOM_STARTED/);
  now+=120001;
  assert.equal(q.list().find(x=>x.id===b.id).status,'expired');
});
test('pending approvals and expiry persist; cancellation and invalidation release reservations', () => {
  let now=1000;
  const q=new ApplicationQueue({now:()=>now}), room={hostId:'host',inMatch:false,freeSeats:1};
  const a=q.apply({accountId:'alice',name:'Alice'});
  q.decide('host',a.id,'approved',room);
  const restored=new ApplicationQueue({snapshot:JSON.parse(JSON.stringify(q.snapshot())),now:()=>now});
  assert.equal(restored.reservedCount(),1);
  now+=30001;
  assert.equal(restored.reservedCount(),0);
  const b=restored.apply({accountId:'bob',name:'Bob'});restored.cancel('bob',b.id);
  assert.equal(restored.list().find(x=>x.id===b.id).status,'cancelled');
  const c=restored.apply({accountId:'charlie',name:'C'});restored.invalidate();
  assert.equal(restored.list().find(x=>x.id===c.id).status,'expired');
});

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; frames = [];
  send(s) { this.frames.push(JSON.parse(s)); }
  close(code) { this.closed = code; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(1008); }
}

test('applications end with their room, and the next generation of the code starts without them', (t) => {
  let now = 1000;
  const rt = new RoomRuntime({ accounts: true, now: () => now });
  t.after(() => rt.lobby.shutdown());
  const ws = new Socket();
  rt.connect(ws, { accountId: 'host', ticket: rt.reserve('ABCD', 'host') });
  for (const msg of [{ t: 'hello', name: 'Host' }, { t: 'room.create', mode: 'coop', difficulty: 'FUNNY' }]) rt.message(ws, JSON.stringify(msg));
  const item = rt.applications.apply({ accountId: 'guest', name: 'Guest' });
  rt.applications.decide('host', item.id, 'approved', { hostId: 'host', inMatch: false, freeSeats: 3 });
  assert.equal(rt.hasAccount('guest'), true);

  rt.message(ws, JSON.stringify({ t: 'room.leave' }));
  rt.sweep();
  assert.equal(rt.hasAccount('guest'), false, 'an approval for a room that is gone holds no seat');
  assert.equal(rt.applications.list()[0].status, 'expired');

  rt.disconnect(ws);
  now += 600_001;
  rt.sweep();
  assert.equal(rt.isEmpty(), true);
  const generation = rt.generation;
  assert.ok(rt.reserve('ABCD', 'next'));
  assert.notEqual(rt.generation, generation);
  assert.deepEqual(rt.applications.list(), []);
});

test('stored applications load without the former release flag', () => {
  const q = new ApplicationQueue({ snapshot: [{ id: 'x', accountId: 'a', name: 'A', status: 'expired', createdAt: 1, expiresAt: Date.now(), released: false }] });
  assert.deepEqual(Object.keys(q.list()[0]).sort(), ['accountId', 'createdAt', 'expiresAt', 'id', 'name', 'status']);
});
