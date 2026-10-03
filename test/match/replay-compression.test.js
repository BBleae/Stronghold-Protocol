import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeReplayChunks,decodeReplayChunk} from '../../shared/replay-codec.js';
import {createFrameEncoder,decodeReplayFrame} from '../../shared/replay-frames.js';
import {verifyReplayChunks} from '../../public/js/battle/replay-runner.js';
import {hash} from '../../worker/accounts/auth.js';
import {randomBytes} from 'node:crypto';

test('gzip chunks preserve UTF-8 boundaries and reject corruption and excessive inflation',async()=>{
  const source=JSON.stringify({name:'博士🪄'.repeat(15000),n:1.123456789});
  const encoded=await encodeReplayChunks(source);
  const chunks=await Promise.all(encoded.chunks.map(async(c,index)=>({...c,index,hash:await hash(c.text)})));
  const manifest={...encoded,chunks:chunks.map(({text,...c})=>c)};
  assert.deepEqual(await verifyReplayChunks(manifest,i=>chunks[i]),JSON.parse(source));
  assert.ok(chunks.every(c=>c.text.length<64000));
  await assert.rejects(decodeReplayChunk(chunks[0].text,1),/REPLAY_INCOMPLETE/);
  await assert.rejects(verifyReplayChunks(manifest,i=>({...chunks[i],text:chunks[i].text.slice(1)})),/REPLAY_INCOMPLETE/);
});

test('incompressible payload is split below storage limits and valid hashes do not bypass gzip validation',async()=>{
  const source=JSON.stringify({random:randomBytes(220000).toString('base64')});
  const encoded=await encodeReplayChunks(source);assert.ok(encoded.chunks.length>2);
  const chunks=await Promise.all(encoded.chunks.map(async(c,index)=>({...c,index,hash:await hash(c.text)})));
  assert.ok(chunks.every(c=>c.text.length<=60000));
  const manifest={...encoded,chunks:chunks.map(({text,...c})=>c)};
  assert.deepEqual(await verifyReplayChunks(manifest,i=>chunks[i]),JSON.parse(source));
  const broken=structuredClone(chunks);broken[0].text='not gzip';broken[0].hash=await hash(broken[0].text);
  const badManifest={...manifest,chunks:broken.map(({text,...c})=>c)};
  await assert.rejects(verifyReplayChunks(badManifest,i=>broken[i]),/REPLAY_INCOMPLETE/);
});

test('delta frames preserve every numeric value, unit order, spawn, removal, and optional attributes',()=>{
  const encoder=createFrameEncoder({keyframeTicks:150});let previous=null;
  const snapshots=[
    {t:0,fieldId:'n',units:[[1,1,2,100,100,0,10,0,0]],dp:0},
    {t:0.2,fieldId:'n',units:[[2,4,5,10,10,1.123456789,9,0,1],[1,1,2,99,100,0,10,0,0]],dp:0,boss:{hp:9,max:10}},
    {t:0.4,fieldId:'n',units:[[2,4,5,10,10,1.123456789,9,0,1]],dp:0,down:[[1,9,2,1]]},
    {t:5,fieldId:'n',units:[[1,1,2,100,100,0,10,0,0],[2,4,5,9,10,1,9,0,0]],dp:7},
  ];
  const frames=snapshots.map((s,i)=>encoder.encode(i===3?150:i*6,s,[['test',i]]));
  assert.ok(frames[0].snapshot);assert.ok(frames[1].delta);assert.ok(frames[3].snapshot);
  for(let i=0;i<frames.length;i++){const old=previous&&structuredClone(previous);const next=decodeReplayFrame(previous,frames[i]);assert.deepEqual(next,snapshots[i]);if(old)assert.deepEqual(previous,old);previous=next;assert.deepEqual(frames[i].events,[['test',i]]);}
  assert.deepEqual(decodeReplayFrame(null,frames[3]),snapshots[3],'keyframe can be decoded independently');
  assert.throws(()=>decodeReplayFrame(null,frames[1]),/REPLAY_INCOMPLETE/);
});
