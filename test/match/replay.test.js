import test from 'node:test';
import assert from 'node:assert/strict';
import { appendReplayReport } from '../../server/match/recorder.js';
import { verifyReplayChunks, createReplayRunner } from '../../public/js/battle/replay-runner.js';
import {createFrameEncoder} from '../../shared/replay-frames.js';

test('server delta replay emits the initial event once and preserves renderer-independent state',()=>{
  const encoder=createFrameEncoder(),events=[];
  const frames=[0,6,12].map(tick=>encoder.encode(tick,{t:tick/30,units:[[1,tick,0,1,1,0,0,0,0]],dp:0},[['event',tick]]));
  const r=createReplayRunner({engine:{},onFrame:frame=>{
    events.push(...frame.events.ev);if(frame.snapshot.units[0]){assert.equal(frame.snapshot.units[0][3],1);frame.snapshot.units[0][3]=999;}
  }});
  r.select({source:'server',frameEncoding:'delta-v1',frames,meta:{units:[]},spec:{},tick:12});
  r.play();r.advance(0.4);assert.deepEqual(events,[['event',0],['event',6],['event',12]]);
  r.select({source:'server',frames:[{tick:0,snapshot:{t:0,units:[]},events:[]}],meta:{units:[]},spec:{},tick:0});r.dispose();
});
test('recording rejects gaps, backwards ticks and foreign authorities',()=>{
  const f={authority:'alice',spec:{battleId:'b'},battleId:'b'};
  const r={segment:'one',seq:0,tick:30,inputs:[{tick:20,kind:'pool',hp:100,acked:4}]};
  assert.equal(appendReplayReport(f,'other',r),false);
  assert.equal(appendReplayReport(f,'alice',r),true);
  assert.equal(appendReplayReport(f,'alice',r),true);
  assert.equal(appendReplayReport(f,'alice',{...r,seq:2}),false);
  assert.equal(appendReplayReport(f,'alice',{...r,seq:1,tick:29}),false);
  assert.equal(appendReplayReport(f,'alice',{segment:'one',seq:1,tick:60,inputs:[]}),true);
});
test('replay verifies every chunk before decoding',async()=>{
  const text=JSON.stringify({battles:[]});
  const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))).toString('hex');
  const manifest={chunks:[{index:0,hash}]};
  assert.deepEqual(await verifyReplayChunks(manifest,async()=>({text,hash})),{battles:[]});
  await assert.rejects(verifyReplayChunks(manifest,async()=>({text:text+' ',hash})),/REPLAY_INCOMPLETE/);
});
test('independent replay applies tick inputs, pauses and disposes without network',()=>{
  let hp=0,steps=0,frames=0;
  const battle={tickCount:0,finished:false,sharedBoss:{sync:v=>{hp=v;}},step(){this.tickCount++;steps++;},
    snapshot(){return {t:this.tickCount/30,units:[]};},drainEvents(){return [];},fieldMeta(){return {};},forceEnd(){this.finished=true;}};
  const runner=createReplayRunner({engine:{createBattle:()=>battle},onFrame:()=>frames++});
  runner.select({kind:'normal',spec:{},tick:60,inputs:[{tick:5,kind:'pool',hp:123}]});
  runner.advance(1);assert.equal(steps,0);
  runner.play();runner.advance(0.5);assert.equal(steps,15);assert.equal(hp,123);
  runner.pause();runner.advance(1);assert.equal(steps,15);
  runner.setSpeed(2);runner.play();runner.advance(0.5);assert.equal(steps,45);
  runner.dispose();runner.advance(1);assert.equal(steps,45);assert.ok(frames>0);
});

test('the replay clock reaches subscribers on a player action and once per whole replay second, never per frame or while paused', () => {
  const battle = {
    tickCount: 0, finished: false, sharedBoss: null,
    step() { this.tickCount++; },
    snapshot() { return { t: this.tickCount / 30, units: [] }; },
    drainEvents() { return []; },
    fieldMeta() { return {}; },
    forceEnd() { this.finished = true; },
  };
  const runner = createReplayRunner({ engine: { createBattle: () => battle } });
  const heard = [];
  const off = runner.subscribe((s) => heard.push(s));
  const frames = (n) => { for (let i = 0; i < n; i++) runner.advance(1 / 60); };
  assert.deepEqual(heard, [{ playing: false, speed: 1, seconds: 0, duration: 0 }], 'the current clock at once');
  runner.select({ kind: 'normal', spec: {}, tick: 100, inputs: [] });
  assert.deepEqual(heard.at(-1), { playing: false, speed: 1, seconds: 0, duration: 4 });
  frames(120);
  assert.equal(heard.length, 2, 'nothing while paused');
  runner.play();
  assert.deepEqual(heard.at(-1), { playing: true, speed: 1, seconds: 0, duration: 4 });
  frames(150);
  assert.deepEqual(heard.slice(3).map((s) => s.seconds), [1, 2], 'one update per whole second of 150 frames');
  runner.setSpeed(2);
  frames(60);
  assert.deepEqual(heard.slice(5).map((s) => [s.speed, s.seconds, s.playing]), [[2, 2, true], [2, 3, true], [2, 3, false]],
    'the speed, the next second, the end');
  frames(60);
  runner.pause();
  assert.equal(heard.length, 8, 'a finished replay is silent; pausing it changes nothing');
  off();
  runner.select({ kind: 'normal', spec: {}, tick: 100, inputs: [] });
  assert.equal(heard.length, 8, 'unsubscribed');
  runner.dispose();
});
