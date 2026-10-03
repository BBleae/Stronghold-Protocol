import {createFrameEncoder} from '../../shared/replay-frames.js';
const copy=value=>JSON.parse(JSON.stringify(value));
/** Reports are auxiliary evidence, never settlement authority. A gap makes that segment unplayable. */
export function appendReplayReport(field,playerId,report) {
  if(!report || field.authority!==playerId) return false;
  let trace=field.replayTrace;
  if(!trace || trace.segment!==report.segment) {
    if(report.seq!==0) return false;
    trace={segment:report.segment,seq:-1,tick:0,inputs:[],last:null};
  }
  const encoded=JSON.stringify(report);
  if(report.seq===trace.seq) return trace.last===encoded;
  if(report.seq!==trace.seq+1 || report.tick<trace.tick || report.inputs.some(x=>x.tick<trace.tick || x.tick>report.tick)) return false;
  if(report.inputs.some((x,i)=>i && x.tick<report.inputs[i-1].tick) || trace.inputs.length+report.inputs.length>20000) return false;
  trace.inputs.push(...copy(report.inputs));trace.tick=report.tick;trace.seq=report.seq;trace.last=encoded;
  field.replayTrace=trace;return true;
}

/** Server takeovers may use crediting/shared pools. Capture their actual view rather than approximating those inputs. */
export function recordServerBattle(battle,spec,observeFrame=null) {
  const trace={spec:copy(spec),source:'server',frameEncoding:'delta-v1',frames:[],keyframes:[],unitInfo:[],meta:copy(battle.fieldMeta()),tick:0,complete:false};
  const encoder=createFrameEncoder(),infos=new Map(),infoVersions=new Map();
  const remember=info=>{const key=JSON.stringify(info);let index=infoVersions.get(key);
    if(index===undefined){index=trace.unitInfo.length;trace.unitInfo.push(copy(info));infoVersions.set(key,index);}infos.set(info.id,index);};
  for(const info of trace.meta.units || [])remember(info);
  const step=battle.step.bind(battle),force=battle.forceEnd.bind(battle);
  const pending=[];
  const capture=()=>{
    const snapshot=battle.snapshot(),events=[...pending.splice(0),...battle.drainEvents()];
    observeFrame?.({battleId:spec.battleId,tick:battle.tickCount,snapshot:copy(snapshot),events:copy(events)});
    for(const event of events)if(event[0]==='spawn')remember(event[1]);
    const frame=encoder.encode(battle.tickCount,snapshot,events);
    if(frame.snapshot) {
      const visible=new Set([...snapshot.units.map(u=>u[0]),...(snapshot.down || []).map(u=>u[0])]);
      frame.unitInfo=[...visible].map(id=>infos.get(id)).filter(index=>index!==undefined);
      trace.keyframes.push({tick:battle.tickCount,index:trace.frames.length});
    }
    trace.tick=battle.tickCount;trace.frames.push(frame);trace.complete=!!battle.finished;
  };
  battle.step=(...args)=>{const result=step(...args);pending.push(...battle.drainEvents());if(battle.tickCount%6===0 || battle.finished)capture();return result;};
  battle.forceEnd=(...args)=>{const result=force(...args);capture();return result;};
  capture();return trace;
}
