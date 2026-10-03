/** A replay owns its simulation and clock. It has no imports from the live socket or store. */
import {decodeReplayChunk,REPLAY_MAX_BYTES} from '../../../shared/replay-codec.js';
import {decodeReplayFrame} from '../../../shared/replay-frames.js';
export async function verifyReplayChunks(manifest,loadChunk) {
  if(!Array.isArray(manifest?.chunks) || manifest.chunks.length>10001) throw new Error('REPLAY_INCOMPLETE');
  const compressed=manifest.codec==='gzip-base64';
  if(manifest.codec && !compressed || !compressed && manifest.schemaVersion && manifest.schemaVersion!==1 || compressed && (manifest.schemaVersion!==2 || !Number.isSafeInteger(manifest.decodedBytes) || manifest.decodedBytes>REPLAY_MAX_BYTES || manifest.decodedBytes<1))throw new Error('REPLAY_INCOMPLETE');
  const text=[],decoder=new TextDecoder('utf-8',{fatal:true});let decodedBytes=0;
  for(const [index,expected] of manifest.chunks.entries()) {
    if(expected.index!==index) throw new Error('REPLAY_INCOMPLETE');
    const chunk=await loadChunk(index);
    if(typeof chunk?.text!=='string') throw new Error('REPLAY_INCOMPLETE');
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(chunk.text));
    const digest=Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
    if(digest!==expected.hash) throw new Error('REPLAY_INCOMPLETE');
    if(compressed){const bytes=await decodeReplayChunk(chunk.text,expected.rawBytes);decodedBytes+=bytes.length;
      if(decodedBytes>manifest.decodedBytes)throw new Error('REPLAY_INCOMPLETE');
      try{text.push(decoder.decode(bytes,{stream:true}));}catch{throw new Error('REPLAY_INCOMPLETE');}
    }else text.push(chunk.text);
  }
  if(compressed){if(decodedBytes!==manifest.decodedBytes)throw new Error('REPLAY_INCOMPLETE');try{text.push(decoder.decode());}catch{throw new Error('REPLAY_INCOMPLETE');}}
  try{return JSON.parse(text.join(''));}catch{throw new Error('REPLAY_INCOMPLETE');}
}
export function createReplayRunner({engine,onFrame=()=>{},onField=()=>{}}) {
  let battle=null,record=null,playing=false,speed=1,position=0,cursor=0,frameCursor=0,dead=false,snapshot=null;
  const emit=(snapshot,events=[])=>{
    const {t:gt,...rest}=structuredClone(snapshot);
    onFrame({snapshot:{...rest,t:'b.snap',gt,fieldId:record.fieldId},events:{t:'b.ev',gt,fieldId:record.fieldId,ev:events}});
  };
  const apply=()=>{
    while(cursor<(record.inputs?.length || 0) && record.inputs[cursor].tick<=battle.tickCount) {
      const input=record.inputs[cursor++];
      if(input.kind==='pool') battle.sharedBoss?.sync(input.hp,input.acked ?? undefined);
      else if(input.kind==='end') battle.forceEnd(input.reason);
    }
  };
  return {
    select(value) {
      if(dead) return;
      if(value.frameEncoding && value.frameEncoding!=='delta-v1')throw new Error('REPLAY_INCOMPLETE');
      record=value;playing=false;position=0;cursor=0;frameCursor=0;snapshot=null;
      battle=value.source==='server'?null:engine.createBattle(value.spec);
      onField({...value.meta || battle?.fieldMeta(),fieldId:value.fieldId,kind:value.kind,stageId:value.spec.stageId,rect:value.spec.rect});
      if(battle){apply();emit(battle.snapshot(),battle.drainEvents());}
      else if(value.frames?.length){snapshot=decodeReplayFrame(null,value.frames[0]);emit(snapshot,value.frames[0].events);frameCursor=1;}
    },
    advance(seconds) {
      if(dead || !playing || !record)return;
      position=Math.min(record.tick,position+Math.max(0,Math.min(seconds,0.5))*30*speed);
      if(battle) {
        let budget=240;
        while(battle.tickCount<Math.floor(position) && !battle.finished && budget-->0){apply();battle.step();}
        apply();emit(battle.snapshot(),battle.drainEvents());
      }else{
        while(frameCursor<(record.frames?.length || 0) && record.frames[frameCursor].tick<=position) {
          const frame=record.frames[frameCursor++];snapshot=decodeReplayFrame(snapshot,frame);emit(snapshot,frame.events);
        }
      }
      if(position>=record.tick)playing=false;
    },
    state:()=>({playing,speed,seconds:position/30,duration:(record?.tick || 0)/30}),
    play(){if(!dead && record)playing=true;},pause(){playing=false;},setSpeed(value){if([0.5,1,2,4].includes(value))speed=value;},
    dispose(){dead=true;playing=false;battle=null;record=null;},
  };
}
