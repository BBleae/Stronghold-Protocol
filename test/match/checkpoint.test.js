import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordedMatch, exportMatch, restoreMatch } from '../../server/match/checkpoint.js';
import { DATA } from './harness.js';
const opts = (extra={}) => ({mode:'coop',difficulty:'FUNNY',roomCode:'ABCD',seed:17,matchNo:1,data:DATA,
  seats:[{seat:0,playerId:'p0',name:'Alice',isBot:false,connected:true},
    {seat:1,playerId:'p1',name:'Bob',isBot:false,connected:true}],now:()=>1000,
  send(){return true;},broadcast(){},onEnd(){},botRehearsal:0,...extra});
test('executable checkpoints reconstruct timers, RNG, players and subsequent actions without emitting old frames', () => {
  let now=1000;
  const m=new RecordedMatch(opts({now:()=>now}));
  m.start();
  m.handle('p0',{t:'g.infoReady'}); m.handle('p1',{t:'g.infoReady'});
  m.pump(1000);
  const checkpoint=JSON.parse(JSON.stringify(exportMatch(m)));
  const emitted=[];
  const restored=restoreMatch(checkpoint,opts({now:()=>now,send:(...x)=>emitted.push(x),broadcast:x=>emitted.push(x)}));
  assert.equal(emitted.length,0);
  assert.deepEqual(restored.publicView(),m.publicView());
  assert.equal(restored.rngDraft.state(),m.rngDraft.state());
  now+=20000;
  m.pump(now); restored.pump(now);
  assert.deepEqual(restored.publicView(),m.publicView());
  m.onDisconnect('p0'); restored.onDisconnect('p0');
  m.onReconnect('p0'); restored.onReconnect('p0');
  assert.deepEqual(exportMatch(restored),exportMatch(m));
  m.dispose(); restored.dispose();
});
test('checkpoints reject corrupted input and unknown versions without modifying the record', () => {
  const m=new RecordedMatch(opts()); m.start();
  const c=exportMatch(m), bad=structuredClone(c); bad.schemaVersion=999;
  assert.throws(()=>restoreMatch(bad,opts()),/VERSION/);
  assert.equal(bad.schemaVersion,999);
  const divergent=structuredClone(c); divergent.events[0].kind='unknown';
  assert.throws(()=>restoreMatch(divergent,opts()),/EVENT/);
  m.dispose();
});
test('a recorded full cooperative match reconstructs combat and final result', {timeout:120000}, () => {
  const data=structuredClone(DATA);
  for(const band of Object.values(data.bands || {})) band.totalHp=1000;
  let clock=1000;
  const deps=opts({data,now:()=>clock,clientCombat:false,botRehearsal:0});
  const m=new RecordedMatch(deps); m.start();
  for(const id of ['p0','p1']) {m.handle(id,{t:'g.autoplay',on:true});m.handle(id,{t:'g.infoReady'});}
  const seen=new Set();
  for(let n=0;n<100000 && !m.ended;n++) {
    const at=m.sched.nextAt(); assert.notEqual(at,null,'game must keep progressing');
    clock=Math.max(clock,at); m.pump(clock,10);
    if(!seen.has(m.phase)) {
      seen.add(m.phase);
      const restored=restoreMatch(exportMatch(m),deps);
      assert.deepEqual(restored.publicView(),m.publicView(),m.phase);
      restored.dispose();
    }
  }
  assert.ok(m.ended); assert.ok(seen.has('COMBAT'));
  const restored=restoreMatch(exportMatch(m),deps);
  assert.deepEqual(restored.lastResultMsg,m.lastResultMsg);
  assert.equal(m.errorCount,0);
  console.log('checkpoint phases', [...seen].join(','), 'events', m.recording.events.length);
  m.dispose(); restored.dispose();
});
