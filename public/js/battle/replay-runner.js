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
/**
 * Plays one archived battle at a time on its own clock (30 ticks per game second): a client battle re-simulated from
 * its spec and tick `inputs`, a server battle from its `meta` and `frames` (the first one captured at its start) — the
 * records server/match/checkpoint.js archives. onField(meta) when a battle is selected, onFrame(frame) as it plays.
 * state() is its clock in whole seconds — { playing, speed, seconds, duration }; subscribers hear it change on a
 * player's action or when the replay passes a whole second, never per animation frame.
 */
export function createReplayRunner({ engine, onFrame = () => {}, onField = () => {} }) {
  let battle = null;
  let record = null;
  let playing = false;
  let speed = 1;
  let position = 0;     // ticks played
  let cursor = 0;       // next tick input
  let frameCursor = 0;  // next server frame
  let snapshot = null;  // last decoded server frame
  let dead = false;
  let shown = null;     // the state the subscribers heard last
  const listeners = new Set();
  const emit = (snap, events = []) => {
    const { t: gt, ...rest } = structuredClone(snap);
    onFrame({ snapshot: { ...rest, t: 'b.snap', gt, fieldId: record.fieldId }, events: { t: 'b.ev', gt, fieldId: record.fieldId, ev: events } });
  };
  const apply = () => {
    while (cursor < record.inputs.length && record.inputs[cursor].tick <= battle.tickCount) {
      const input = record.inputs[cursor++];
      if (input.kind === 'pool') battle.sharedBoss.sync(input.hp, input.acked ?? undefined);
      else if (input.kind === 'end') battle.forceEnd(input.reason);
    }
  };
  const state = () => ({ playing, speed, seconds: Math.floor(position / 30), duration: Math.ceil((record?.tick || 0) / 30) });
  const changed = () => {
    const s = state();
    if (dead || (shown && s.playing === shown.playing && s.speed === shown.speed && s.seconds === shown.seconds && s.duration === shown.duration)) return;
    shown = s;
    for (const fn of listeners) fn(s);
  };
  return {
    select(value) {
      if (dead) return;
      if (value.frameEncoding && value.frameEncoding !== 'delta-v1') throw new Error('REPLAY_INCOMPLETE');
      record = value;
      playing = false;
      position = 0;
      cursor = 0;
      frameCursor = 0;
      snapshot = null;
      battle = value.source === 'server' ? null : engine.createBattle(value.spec);
      onField({ ...value.meta || battle.fieldMeta(), fieldId: value.fieldId, kind: value.kind, stageId: value.spec.stageId, rect: value.spec.rect });
      if (battle) {
        apply();
        emit(battle.snapshot(), battle.drainEvents());
      } else {
        snapshot = decodeReplayFrame(null, value.frames[0]);
        emit(snapshot, value.frames[0].events);
        frameCursor = 1;
      }
      changed();
    },
    advance(seconds) {
      if (dead || !playing || !record) return;
      position = Math.min(record.tick, position + Math.max(0, Math.min(seconds, 0.5)) * 30 * speed);
      if (battle) {
        let budget = 240;
        while (battle.tickCount < Math.floor(position) && !battle.finished && budget-- > 0) {
          apply();
          battle.step();
        }
        apply();
        emit(battle.snapshot(), battle.drainEvents());
      } else {
        while (frameCursor < record.frames.length && record.frames[frameCursor].tick <= position) {
          const frame = record.frames[frameCursor++];
          snapshot = decodeReplayFrame(snapshot, frame);
          emit(snapshot, frame.events);
        }
      }
      if (position >= record.tick) playing = false;
      changed();
    },
    state,
    /** fn(state()) now and whenever it changes; → unsubscribe. */
    subscribe(fn) {
      listeners.add(fn);
      fn(state());
      return () => listeners.delete(fn);
    },
    play() {
      if (dead || !record) return;
      playing = true;
      changed();
    },
    pause() {
      playing = false;
      changed();
    },
    setSpeed(value) {
      if (![0.5, 1, 2, 4].includes(value)) return;
      speed = value;
      changed();
    },
    dispose() {
      dead = true;
      playing = false;
      battle = null;
      record = null;
    },
  };
}
