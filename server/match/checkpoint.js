import { Match } from './Match.js';
import { VirtualScheduler } from './scheduler.js';

export const RULES_VERSION = typeof __SP_RULES_VERSION__ === 'string' ? __SP_RULES_VERSION__ : 'development-v1';
const METHODS = new Set(['start','handle','onDisconnect','onReconnect','onLeave','setLoadout']);
const copy = value => JSON.parse(JSON.stringify(value));
const OPTION_KEYS = ['roomCode','mode','difficulty','modeId','seats','seed','matchNo','timerScale','combatSpeed','botRehearsal','clientCombat','verify','battleContent'];

/** A manually pumped clock makes timer ordering reproducible, including callbacks with closures.
 * Checkpoints store the complete input/timer log; never treat render snapshots as executable state.
 */
export class RecordedMatch extends Match {
  constructor(options) {
    const startedAt=options._startAt ?? (options.now || Date.now)();
    const scheduler=new VirtualScheduler({start:startedAt,instantCombat:false});
    const output={muted:!!options._restoring};
    super({...options,scheduler,
      send:(...args)=>output.muted ? true : options.send(...args),
      broadcast:(...args)=>{if(!output.muted) options.broadcast(...args);},
      onEnd:(...args)=>{if(!output.muted) options.onEnd(...args);}});
    this.recording={schemaVersion:1,rulesVersion:RULES_VERSION,startedAt,
      options:copy(Object.fromEntries(OPTION_KEYS.filter(k=>options[k]!==undefined).map(k=>[k,options[k]]))),events:[]};
    this._wallNow=options.now || Date.now;
    this._recordDepth=0;
    this._recordOutput=output;
    this._restored=false;
  }
  _input(kind,args) {
    if(this._recordDepth) return Match.prototype[kind].apply(this,args);
    const at=Math.max(this.sched.now(),this._wallNow());
    return this._apply({kind,at,args:copy(args)});
  }
  _apply(event) {
    if (!Number.isFinite(event.at) || event.at<this.sched.now()) throw new Error('CHECKPOINT_EVENT_TIME');
    this.recording.events.push(copy(event)); this._recordDepth++;
    try {
      if(event.kind==='timer') {
        this.sched.nextAt(); const next=this.sched._q[0];
        if(!next || next.id!==event.id || Math.max(this.sched.now(),next.at)!==event.at) throw new Error('CHECKPOINT_TIMER_DIVERGED');
        this.sched.runNext();
      } else {
        if(!METHODS.has(event.kind) || !Array.isArray(event.args)) throw new Error('CHECKPOINT_EVENT');
        this.sched.t=event.at;
        return Match.prototype[event.kind].apply(this,event.args);
      }
    } finally {this._recordDepth--;}
  }
  start() {if(this._restored) {this._restored=false;return;} return this._input('start',[]);}
  handle(...args) {return this._input('handle',args);}
  onDisconnect(...args) {return this._input('onDisconnect',args);}
  onReconnect(...args) {return this._input('onReconnect',args);}
  onLeave(...args) {return this._input('onLeave',args);}
  setLoadout(...args) {return this._input('setLoadout',args);}
  pump(until=this._wallNow(),limit=100) {
    let n=0;
    while(n<limit && !this.disposed) {
      const at=this.sched.nextAt();
      if(at==null || at>until) break;
      this._apply({kind:'timer',at:Math.max(at,this.sched.now()),id:this.sched._q[0].id}); n++;
    }
    return n;
  }
  dispose() {super.dispose(); this.sched.dispose();}
}
export function exportMatch(match) {
  return {...copy(match.recording),view:copy(match.publicView()),rng:
    ['Setup','Shop','Waves','Draft','Bots','Meta'].map(n=>match['rng'+n].state())};
}
export function restoreMatch(checkpoint,deps) {
  if(checkpoint?.schemaVersion!==1 || checkpoint.rulesVersion!==RULES_VERSION) throw new Error('CHECKPOINT_VERSION');
  if(!Array.isArray(checkpoint.events) || checkpoint.events.length>200000) throw new Error('CHECKPOINT_EVENT_LIMIT');
  const match=new RecordedMatch({...deps,...checkpoint.options,_startAt:checkpoint.startedAt,_restoring:true});
  try {
    for(const event of checkpoint.events) match._apply(event);
    const current=exportMatch(match);
    if(JSON.stringify(current.view)!==JSON.stringify(checkpoint.view) || JSON.stringify(current.rng)!==JSON.stringify(checkpoint.rng))
      throw new Error('CHECKPOINT_STATE_DIVERGED');
    match._recordOutput.muted=false;
    match._restored=true;
    return match;
  } catch(error) {match.dispose(); throw error;}
}
