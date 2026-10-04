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

/**
 * A server battle that runs from its spec alone (every normal / 联防 field the server simulates): it is deterministic, so
 * its replay is the spec — re-simulated by the replay engine of the match's rules version — plus how it ended. The only
 * input from outside is a forced end (a HeadlessJob hard cap or crash, fields.js), recorded as an 'end' input.
 */
export function recordServerSpec(battle, spec) {
  const trace = { source: 'server', spec: copy(spec), inputs: [], tick: 0, complete: false };
  const step = battle.step.bind(battle), forceEnd = battle.forceEnd.bind(battle);
  const sync = () => { trace.tick = battle.tickCount; trace.complete = !!battle.finished; };
  battle.step = (...args) => { const result = step(...args); sync(); return result; };
  battle.forceEnd = (...args) => {
    const result = forceEnd(...args);
    trace.inputs.push({ tick: battle.tickCount, kind: 'end', reason: args[0] });
    sync();
    return result;
  };
  return trace;
}

/**
 * A battle on a shared boss pool depends on the other fields while it runs (the pool's hits arrive from them), so its
 * replay is what it showed: a snapshot and its events every 6 ticks (0.2 s), delta-encoded (shared/replay-frames.js).
 */
export function recordServerBattle(battle, spec, observeFrame = null) {
  const trace = { spec: copy(spec), source: 'server', frameEncoding: 'delta-v1', frames: [], meta: copy(battle.fieldMeta()), tick: 0, complete: false };
  const encoder = createFrameEncoder();
  const step = battle.step.bind(battle), forceEnd = battle.forceEnd.bind(battle);
  const pending = [];
  const capture = () => {
    const snapshot = battle.snapshot(), events = [...pending.splice(0), ...battle.drainEvents()];
    observeFrame?.({ battleId: spec.battleId, tick: battle.tickCount, snapshot: copy(snapshot), events: copy(events) });
    trace.frames.push(encoder.encode(battle.tickCount, snapshot, events));
    trace.tick = battle.tickCount;
    trace.complete = !!battle.finished;
  };
  battle.step = (...args) => {
    const result = step(...args);
    pending.push(...battle.drainEvents());
    if (battle.tickCount % 6 === 0 || battle.finished) capture();
    return result;
  };
  battle.forceEnd = (...args) => { const result = forceEnd(...args); capture(); return result; };
  capture();
  return trace;
}
